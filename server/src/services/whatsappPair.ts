import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { prisma } from '../db';
import { encrypt } from '../crypto';
import { logEvent } from './events';
import { broadcast } from './socket';
import type { InboundItem } from './worker';

/**
 * WhatsApp connection via the *official device-linking pairing flow* — the same
 * "Link with phone number" code you get in WhatsApp → Linked devices. The user
 * enters their number here, we request a genuine 8-character pairing code from
 * WhatsApp's servers, and the user types it into their phone. No QR scraping,
 * no third-party bridge: this is the real multi-device protocol WhatsApp Web uses.
 *
 * Inbound messages arrive on the linked socket and are pushed through the exact
 * same durable pipeline as Cloud API webhooks (`process:inbound` job), including
 * signature-of-origin dedupe by platform message id and the reply pipeline.
 *
 * Baileys is ESM-only; load it with a runtime import that also works from the
 * CJS build output (tsc module: CommonJS).
 */
const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;

export const PAIR_MARKER = 'PAIR'; // stored in Account.phoneNumberId for linked-device accounts

const AUTH_ROOT = process.env.WA_AUTH_DIR || path.join(process.cwd(), '.wa-auth');
const CODE_TTL_MS = 3 * 60_000; // pairing codes are short-lived; UI shows a countdown
const SESSION_TTL_MS = 15 * 60_000; // abandoned (never completed) linking sessions
const CODE_TIMEOUT_MS = 45_000; // fail fast if WhatsApp is unreachable
const JID_SUFFIX = '@s.whatsapp.net';
const MAX_RESTORE_RETRIES = 5;

export type PairStatus = 'CONNECTING' | 'WAITING_FOR_CODE' | 'PAIRED' | 'EXPIRED' | 'ERROR';

export interface PublicPairSession {
  sessionId: string;
  phone: string;
  status: PairStatus;
  code: string | null;
  codeExpiresInSeconds: number | null;
  error: string | null;
  accountId: string | null;
}

interface PairSession {
  id: string;
  userId: string;
  phone: string; // digits only, with country code
  status: PairStatus;
  code: string | null;
  codeAt: number | null;
  jid: string | null;
  error: string | null;
  accountId: string | null;
  socket: any;
  socketAlive: boolean;
  createdAt: number;
}

const sessions = new Map<string, PairSession>();
/** linked-number digits → live socket (outbound sends) */
const liveSockets = new Map<string, any>();
const restoreRetries = new Map<string, number>();
/** linked-number digits → pending auto-reconnect timer (avoid double sockets) */
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** linked-number digits → in-flight on-demand reconnect for sends */
const ensureSockets = new Map<string, Promise<any>>();

let baileysModule: any = null;
async function loadBaileys() {
  if (!baileysModule) baileysModule = await dynamicImport('@whiskeysockets/baileys');
  return baileysModule;
}

/** Baileys wants a pino-compatible logger; a silent stub keeps WA noise out of logs. */
const silentLogger = (() => {
  const noop = () => undefined;
  const logger: any = {
    level: 'silent',
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
})();

export function normalizePhone(input: string): string {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) {
    throw new Error('Enter the full number with country code, e.g. +1 555 010 7788 (8–15 digits)');
  }
  return digits;
}

function authDirFor(digits: string): string {
  return path.join(AUTH_ROOT, digits);
}

function humanPairingError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lowered = raw.toLowerCase();
  if (lowered.includes('connection closed') || lowered.includes('connection failure')) {
    return 'WhatsApp rejected the linking request — wait a minute, then request a new code (IP-based rate limit is common on servers).';
  }
  if (lowered.includes('rate') || lowered.includes('too many')) {
    return 'WhatsApp is rate-limiting pairing requests for this number — wait a few minutes and try again.';
  }
  if (
    lowered.includes('enotfound') ||
    lowered.includes('econnrefused') ||
    lowered.includes('econnreset') ||
    lowered.includes('etimedout') ||
    lowered.includes('fetch failed') ||
    lowered.includes('network') ||
    lowered.includes('timeout')
  ) {
    return 'Could not reach WhatsApp servers from this instance — check outbound network access (HTTPS to web.whatsapp.com).';
  }
  return raw.length > 180 ? `${raw.slice(0, 177)}…` : raw;
}

function publicSession(s: PairSession): PublicPairSession {
  const codeExpiresInSeconds =
    s.status === 'WAITING_FOR_CODE' && s.codeAt
      ? Math.max(0, Math.ceil((s.codeAt + CODE_TTL_MS - Date.now()) / 1000))
      : null;
  return {
    sessionId: s.id,
    phone: `+${s.phone}`,
    status: s.status,
    code: s.status === 'WAITING_FOR_CODE' ? s.code : null,
    codeExpiresInSeconds,
    error: s.error,
    accountId: s.accountId,
  };
}

// ── socket lifecycle ───────────────────────────────────────────────────

async function createSocket(session: PairSession | null, digits: string, requestCode: boolean) {
  const baileys = await loadBaileys();
  const makeWASocket = baileys.makeWASocket || baileys.default;
  const { state, saveCreds } = await baileys.useMultiFileAuthState(authDirFor(digits));

  let version: [number, number, number] | undefined;
  try {
    version = (await baileys.fetchLatestBaileysVersion()).version;
  } catch {
    /* offline → Baileys falls back to its bundled version */
  }

  // A standard browser descriptor is a reported fix for codes the phone
  // rejects; non-standard strings ("EXOTIC BOT") have been implicated in
  // mismatched-code failures. Use Baileys' Ubuntu/Chrome preset when present.
  const browsers = baileys.Browsers;
  const browser =
    browsers?.ubuntu?.('Chrome') ||
    browsers?.macOS?.('Chrome') ||
    ['Ubuntu', 'Chrome', '1.0.0'];

  const sock = makeWASocket({
    auth: state,
    logger: silentLogger,
    version,
    browser,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    printQRInTerminal: false,
    connectTimeoutMs: 60_000,
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update: any) => {
    void handleConnectionUpdate(session, digits, sock, update);
  });
  sock.ev.on('messages.upsert', (upsert: any) => {
    void handleIncoming(digits, upsert);
  });

  if (requestCode) {
    if (!session) throw new Error('internal: pairing code requested without session');
    session.socket = sock;
    session.socketAlive = true;

    // Never request a code for an already-linked auth state — reconnect instead.
    if (state?.creds?.registered) {
      session.status = 'ERROR';
      session.error = 'This number is already linked on this instance — disconnect it first to re-link.';
      return sock;
    }

    // Request the genuine 8-char code only once Baileys signals readiness by
    // emitting `qr` (which fires in pairing mode too). Firing the request on a
    // fixed timer is what made phones reject the code (401 / "invalid code").
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onUpdate = (update: any) => void handleQr(update);
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        sock.ev.off('connection.update', onUpdate);
      };

      const handleQr = async (update: any) => {
        if (settled) return;
        if (!update?.qr) return; // wait for the readiness signal
        settled = true;
        cleanup();
        try {
          const code = await Promise.race([
            sock.requestPairingCode(digits),
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error('Timed out waiting for a pairing code from WhatsApp')), CODE_TIMEOUT_MS),
            ),
          ]);
          session.code = String(code);
          session.codeAt = Date.now();
          session.status = 'WAITING_FOR_CODE';
          session.socket = sock;
          // stop offering the code after WhatsApp's own window
          setTimeout(() => {
            if (session.status === 'WAITING_FOR_CODE') {
              session.status = 'EXPIRED';
              session.code = null;
            }
          }, CODE_TTL_MS).unref?.();
          resolve();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };

      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Timed out waiting for WhatsApp to be ready to issue a pairing code — try again in a minute.'));
      }, CODE_TIMEOUT_MS);

      sock.ev.on('connection.update', onUpdate);
    });
  }
  return sock;
}

async function handleConnectionUpdate(
  session: PairSession | null,
  digits: string,
  sock: any,
  update: any,
) {
  const baileys = await loadBaileys();
  const reasons = baileys.DisconnectReason || {};
  const { connection, lastDisconnect } = update;

  if (connection === 'open') {
    const pendingTimer = reconnectTimers.get(digits);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      reconnectTimers.delete(digits);
    }
    liveSockets.set(digits, sock);
    restoreRetries.delete(digits);
    const jid = sock.user?.id ? String(sock.user.id).split(':')[0] + JID_SUFFIX : digits + JID_SUFFIX;

    if (session) {
      session.status = 'PAIRED';
      session.jid = jid;
      session.error = null;
      await finalizePaired(session, sock);
    } else {
      // restored session at boot
      await prisma.account.updateMany({
        where: { platform: 'WHATSAPP', externalId: digits },
        data: { status: 'CONNECTED' },
      });
      await logEvent({ level: 'success', message: `WhatsApp session restored: +${digits}` });
      broadcast({ type: 'account:updated', data: { platform: 'WHATSAPP', externalId: digits, status: 'CONNECTED' } });
    }
    return;
  }

  if (connection !== 'close') return;

  const status = Number(lastDisconnect?.error?.output?.statusCode ?? 0);
  const loggedOut = status === reasons.loggedOut;
  const replaced = status === reasons.connectionReplaced;
  liveSockets.delete(digits);
  if (session) session.socketAlive = false;

  if (loggedOut || replaced) {
    if (loggedOut) {
      await fs.promises.rm(authDirFor(digits), { recursive: true, force: true }).catch(() => undefined);
    }
    if (session && session.status !== 'PAIRED') {
      // mid-linking failure → re-requestable via “Get a new code” (socket rebuilds)
      session.status = 'ERROR';
      session.error = loggedOut
        ? 'This number was unlinked from WhatsApp (logged out). Request a new code to relink.'
        : 'Connection replaced by another session on this number.';
    } else {
      // restored/live linked session actually logged out → reflect it in the account row
      await prisma.account
        .updateMany({ where: { platform: 'WHATSAPP', externalId: digits }, data: { status: 'DISCONNECTED' } })
        .catch(() => undefined);
      await logEvent({ level: 'warn', message: `WhatsApp session logged out: +${digits}` });
      broadcast({ type: 'account:updated', data: { platform: 'WHATSAPP', externalId: digits, status: 'DISCONNECTED' } });
      if (session) sessions.delete(session.id);
    }
    try {
      sock.end?.(undefined);
    } catch {
      /* already closed */
    }
    return;
  }

  // Pairing flow died before the user entered the code → mark expired (re-requestable)
  if (session && session.status !== 'PAIRED') {
    if (session.status === 'WAITING_FOR_CODE' || session.status === 'CONNECTING') {
      session.status = 'EXPIRED';
      session.code = null;
      session.error = 'Linking was interrupted before the code was entered — request a new code.';
    }
    return; // the route re-creates the socket when a new code is requested
  }

  // Live linked session (or restored one): transient drop → capped exponential reconnect
  if (session) session.socket = null;
  scheduleRestoreReconnect(digits);
}

function scheduleRestoreReconnect(digits: string) {
  const attempt = (restoreRetries.get(digits) || 0) + 1;
  if (attempt > MAX_RESTORE_RETRIES) {
    reconnectTimers.delete(digits);
    void prisma.account
      .updateMany({ where: { platform: 'WHATSAPP', externalId: digits }, data: { status: 'DISCONNECTED' } })
      .catch(() => undefined);
    void logEvent({ level: 'error', message: `WhatsApp session dropped (no reconnect): +${digits}` });
    return;
  }
  restoreRetries.set(digits, attempt);
  const delay = Math.min(60_000, 2000 * 2 ** (attempt - 1));
  const timer = setTimeout(() => {
    reconnectTimers.delete(digits);
    createSocket(null, digits, false).catch((err) => {
      void logEvent({ level: 'error', message: `WhatsApp reconnect failed: ${humanPairingError(err)}` });
    });
  }, delay);
  timer.unref?.();
  reconnectTimers.set(digits, timer);
}

async function finalizePaired(session: PairSession, sock: any) {
  const digits = session.phone;
  const name = String(sock.user?.name || '').trim();
  const label = (name ? `WhatsApp · ${name}` : 'WhatsApp') + ` (+${digits})`;
  const existing = await prisma.account.findFirst({
    where: { userId: session.userId, platform: 'WHATSAPP', externalId: digits },
  });
  const data = {
    label,
    phoneNumberId: PAIR_MARKER,
    accessToken: encrypt(`paired-device:${session.jid}`),
    status: 'CONNECTED',
    tokenExpiresAt: null,
  };
  const account = existing
    ? await prisma.account.update({ where: { id: existing.id }, data })
    : await prisma.account.create({
        data: { userId: session.userId, platform: 'WHATSAPP', externalId: digits, ...data },
      });
  session.accountId = account.id;
  await logEvent({
    level: 'success',
    message: `WhatsApp linked via pairing code: ${label}`,
    meta: { accountId: account.id },
  });
  broadcast({ type: 'account:updated', data: { id: account.id, status: 'CONNECTED' } });
}

/** Inbound messages on the linked device → same pipeline as Cloud API webhooks. */
async function handleIncoming(digits: string, upsert: any) {
  if (!upsert || upsert.type !== 'notify') return;
  for (const msg of upsert.messages || []) {
    try {
      if (!msg?.message || msg.key?.fromMe) continue;
      const jid = String(msg.key?.remoteJid || '');
      if (!jid.endsWith(JID_SUFFIX)) continue; // skip groups, status@broadcast, newsletters
      const sender = jid.split('@')[0].split(':')[0];
      const m = msg.message;
      const body = String(
        m.conversation ||
          m.extendedTextMessage?.text ||
          m.imageMessage?.caption ||
          m.videoMessage?.caption ||
          m.documentMessage?.caption ||
          m.buttonsResponseMessage?.selectedDisplayText ||
          m.listResponseMessage?.title ||
          m.templateButtonReplyMessage?.selectedDisplayText ||
          '',
      ).trim();
      if (!body) continue;
      const item: InboundItem = {
        platform: 'WHATSAPP',
        matchBy: digits, // the linked account's externalId
        conversationKey: `wa:${sender}`,
        senderId: sender,
        senderName: String(msg.pushName || sender),
        body,
        source: 'MESSAGE',
        replyExternalId: msg.key?.id ? String(msg.key.id) : undefined,
        externalId: msg.key?.id ? String(msg.key.id) : undefined,
      };
      await enqueueInbound(item);
    } catch (err) {
      await logEvent({
        level: 'error',
        message: `WhatsApp inbound processing failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

/** Persist inbound items through the durable queue (worker container or inline). */
async function enqueueInbound(item: InboundItem) {
  const { enqueue } = await import('./queue');
  await enqueue('process:inbound', item as unknown as Record<string, unknown>);
}

// ── public API (routes) ────────────────────────────────────────────────

export async function startPairing(userId: string, phoneInput: string): Promise<PublicPairSession> {
  const phone = normalizePhone(phoneInput);

  // one linking flow per number per operator
  for (const [id, s] of sessions) {
    if (s.phone === phone && s.userId === userId && s.status !== 'PAIRED') await cancelPairing(id, userId);
  }
  // housekeeping: drop long-abandoned sessions
  for (const [id, s] of sessions) {
    if (s.status !== 'PAIRED' && Date.now() - s.createdAt > SESSION_TTL_MS) void cancelPairing(id, s.userId);
  }

  const session: PairSession = {
    id: crypto.randomUUID(),
    userId,
    phone,
    status: 'CONNECTING',
    code: null,
    codeAt: null,
    jid: null,
    error: null,
    accountId: null,
    socket: null,
    socketAlive: false,
    createdAt: Date.now(),
  };
  sessions.set(session.id, session);

  try {
    await createSocket(session, phone, true);
    await logEvent({ level: 'info', message: `WhatsApp pairing code requested for +${phone}` });
  } catch (err) {
    session.status = 'ERROR';
    session.error = humanPairingError(err);
    session.code = null;
    await logEvent({ level: 'error', message: `WhatsApp pairing failed: ${session.error}` });
  }
  return publicSession(session);
}

export function getPairingStatus(sessionId: string, userId: string): PublicPairSession | null {
  const session = sessions.get(sessionId);
  if (!session || session.userId !== userId) return null;
  return publicSession(session);
}

export async function requestNewCode(sessionId: string, userId: string): Promise<PublicPairSession> {
  const session = sessions.get(sessionId);
  if (!session || session.userId !== userId) {
    throw new Error('Linking session ended — enter the number again to start over.');
  }
  if (session.status === 'PAIRED') return publicSession(session);

  // Socket died (rejected request / WS close) → rebuild it and ask for a fresh code.
  if (!session.socket || !session.socketAlive) {
    session.status = 'CONNECTING';
    session.code = null;
    session.error = null;
    try {
      await createSocket(session, session.phone, true);
      await logEvent({ level: 'info', message: `WhatsApp pairing code re-requested for +${session.phone}` });
    } catch (err) {
      session.status = 'ERROR';
      session.error = humanPairingError(err);
    }
    return publicSession(session);
  }

  try {
    const code = await Promise.race([
      session.socket.requestPairingCode(session.phone),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for a pairing code from WhatsApp')), CODE_TIMEOUT_MS),
      ),
    ]);
    session.code = String(code);
    session.codeAt = Date.now();
    session.status = 'WAITING_FOR_CODE';
    session.error = null;
    setTimeout(() => {
      if (session.status === 'WAITING_FOR_CODE') {
        session.status = 'EXPIRED';
        session.code = null;
      }
    }, CODE_TTL_MS).unref?.();
    return publicSession(session);
  } catch (err) {
    session.status = 'ERROR';
    session.error = humanPairingError(err);
    return publicSession(session);
  }
}

export async function cancelPairing(sessionId: string, userId: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session || session.userId !== userId) return false;
  sessions.delete(sessionId);
  try {
    session.socket?.end?.(undefined);
  } catch {
    /* already closed */
  }
  if (session.status !== 'PAIRED') {
    await fs.promises.rm(authDirFor(session.phone), { recursive: true, force: true }).catch(() => undefined);
  }
  return true;
}

/** DELETE /accounts/:id for a linked-device account — kill the live socket too. */
export async function stopSocketForNumber(digits: string) {
  const sock = liveSockets.get(digits);
  liveSockets.delete(digits);
  if (sock) {
    try {
      sock.end?.(undefined);
    } catch {
      /* already closed */
    }
  }
  await fs.promises.rm(authDirFor(digits), { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Return the live socket for a linked number, reconnecting on demand from the
 * persisted auth state when none is registered (server restart, transient
 * drop mid-reconnect). Waits up to timeoutMs for the connection to open;
 * throws the caller-facing error when the auth state itself is gone.
 */
async function ensureLiveSocket(digits: string, timeoutMs = 30_000): Promise<any> {
  const existing = liveSockets.get(digits);
  if (existing) return existing;
  if (!fs.existsSync(authDirFor(digits))) {
    throw new Error('The linked WhatsApp session is gone — open Accounts and re-link the number.');
  }
  let pending = ensureSockets.get(digits);
  if (!pending) {
    pending = (async () => {
      // an auto-reconnect may already be scheduled — let it run instead of
      // opening a second competing socket on the same auth state
      if (!reconnectTimers.has(digits) && !liveSockets.get(digits)) {
        await createSocket(null, digits, false).catch(() => undefined);
      }
      const deadline = Date.now() + timeoutMs;
      while (!liveSockets.get(digits) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }
    })();
    ensureSockets.set(digits, pending);
    void pending.catch(() => undefined).finally(() => ensureSockets.delete(digits));
  }
  await pending;
  return liveSockets.get(digits) ?? null;
}

/** Outbound send over the linked device (same function shape as the Cloud API send). */
export async function sendPairedWhatsAppText(
  linkedNumber: string,
  recipient: string,
  text: string,
): Promise<{ messageId: string | null }> {
  const digits = normalizePhone(linkedNumber);
  const to = normalizePhone(recipient);
  let sock = liveSockets.get(digits) ?? (await ensureLiveSocket(digits));
  if (!sock) {
    throw new Error(
      'WhatsApp is still reconnecting — try again in a few seconds; if it persists, re-link the number in Accounts.',
    );
  }
  const send = async () => {
    const sent = await sock.sendMessage(to + JID_SUFFIX, { text });
    const id = sent?.key?.id;
    return { messageId: id ? String(id) : null };
  };
  try {
    return await send();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/connection|closed|restart|timed out/i.test(msg)) throw err;
    // socket went stale mid-send → one forced reconnect, then retry once
    liveSockets.delete(digits);
    sock = await ensureLiveSocket(digits, 15_000);
    if (!sock) {
      throw new Error('WhatsApp dropped mid-send and could not reconnect in time — try again shortly.');
    }
    return await send();
  }
}

/** Reconnect previously linked numbers at boot (auth state persists in .wa-auth/). */
export async function restorePairedSessions() {
  let accounts: Array<{ externalId: string }> = [];
  try {
    accounts = await prisma.account.findMany({
      where: { platform: 'WHATSAPP', phoneNumberId: PAIR_MARKER, status: { not: 'DISCONNECTED' } },
      select: { externalId: true },
      distinct: ['externalId'],
    });
  } catch {
    return; // DB not ready yet
  }
  for (const account of accounts) {
    const digits = account.externalId;
    if (!fs.existsSync(authDirFor(digits))) continue; // auth state gone → needs re-link
    try {
      restoreRetries.delete(digits);
      await createSocket(null, digits, false);
      await logEvent({ level: 'info', message: `Restoring WhatsApp session: +${digits}` });
    } catch (err) {
      await logEvent({ level: 'error', message: `WhatsApp restore failed: ${humanPairingError(err)}` });
    }
  }
}

export function shutdownPairingSockets() {
  for (const sock of liveSockets.values()) {
    try {
      sock.end?.(undefined);
    } catch {
      /* ignore */
    }
  }
  liveSockets.clear();
  for (const session of sessions.values()) {
    try {
      session.socket?.end?.(undefined);
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
}
