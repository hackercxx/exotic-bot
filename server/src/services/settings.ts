import { prisma } from '../db';
import { encrypt, decrypt } from '../crypto';
import type { AiSettings, ReplyTone } from './ai';

const AI_DEFAULTS: Omit<AiSettings, 'apiKey'> = {
  provider: 'openai',
  model: '',
  tone: 'friendly',
  memoryWindow: 8,
};

export interface QuietHours {
  enabled: boolean;
  start: string; // "22:00"
  end: string; // "07:00"
}

export async function getRawSetting(userId: string, key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { userId_key: { userId, key } } });
  if (!row) return null;
  return row.encrypted ? decrypt(row.value) : row.value;
}

export async function setRawSetting(userId: string, key: string, value: string, encrypted = false) {
  const stored = encrypted ? encrypt(value) : value;
  await prisma.setting.upsert({
    where: { userId_key: { userId, key } },
    create: { userId, key, value: stored, encrypted },
    update: { value: stored, encrypted },
  });
}

export async function getAiSettings(userId: string): Promise<AiSettings> {
  const raw = await getRawSetting(userId, 'ai');
  const parsed = raw ? JSON.parse(raw) : {};
  return {
    ...AI_DEFAULTS,
    ...parsed,
    apiKey: parsed.apiKey ? decryptIfNeeded(parsed.apiKey, parsed.apiKeyEncrypted) : '',
  } as AiSettings;
}

function decryptIfNeeded(value: string, wasEncrypted?: boolean): string {
  if (wasEncrypted === false) return value;
  if (value.startsWith('v1:')) {
    try {
      return decrypt(value);
    } catch {
      return '';
    }
  }
  return value;
}

export async function saveAiSettings(userId: string, incoming: Partial<AiSettings> & { rememberKey?: boolean }) {
  const current = await getAiSettings(userId);
  const next: AiSettings & { apiKeyEncrypted?: boolean } = {
    provider: incoming.provider ?? current.provider,
    model: incoming.model ?? current.model,
    tone: (incoming.tone ?? current.tone) as ReplyTone,
    memoryWindow: Number(incoming.memoryWindow ?? current.memoryWindow) || 8,
    apiKey: '',
  };
  if (typeof incoming.apiKey === 'string') {
    if (incoming.apiKey.trim() === '') {
      next.apiKey = current.apiKey; // blank field = keep existing key
    } else {
      next.apiKey = incoming.apiKey.trim();
    }
  } else {
    next.apiKey = current.apiKey;
  }
  const payload: Record<string, unknown> = {
    provider: next.provider,
    model: next.model,
    tone: next.tone,
    memoryWindow: next.memoryWindow,
    apiKey: next.apiKey ? encrypt(next.apiKey) : '',
    apiKeyEncrypted: true,
  };
  await setRawSetting(userId, 'ai', JSON.stringify(payload));
  return { ...next, apiKey: '' }; // never return the key to the client
}

export async function getBlocklist(userId: string): Promise<string[]> {
  const raw = await getRawSetting(userId, 'blocklist');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Returns the matching word when the inbound body hits the blocklist (§4.4). */
export function matchesBlocklist(body: string, words: string[]): string | null {
  const lower = body.toLowerCase();
  for (const w of words) {
    const needle = w.trim().toLowerCase();
    if (!needle) continue;
    if (lower.includes(needle)) return w;
  }
  return null;
}

export async function getQuietHours(userId: string): Promise<QuietHours> {
  const raw = await getRawSetting(userId, 'quietHours');
  if (!raw) return { enabled: false, start: '22:00', end: '07:00' };
  try {
    return { enabled: false, start: '22:00', end: '07:00', ...JSON.parse(raw) };
  } catch {
    return { enabled: false, start: '22:00', end: '07:00' };
  }
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return (h % 24) * 60 + (m % 60);
}

/** True when now falls inside the configured quiet window (handles wrap past midnight). */
export function inQuietHours(qh: QuietHours, now = new Date(), timezone = 'UTC'): boolean {
  if (!qh.enabled) return false;
  let minutes: number;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: undefined,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    minutes = hour * 60 + minute;
  } catch {
    minutes = now.getHours() * 60 + now.getMinutes();
  }
  const start = minutesOf(qh.start);
  const end = minutesOf(qh.end);
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export async function getUserTimezone(userId: string): Promise<string> {
  const raw = await getRawSetting(userId, 'timezone');
  return raw || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
