import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, type AuthedRequest } from '../middleware/auth';
import { logEvent } from '../services/events';
import {
  getAiSettings,
  saveAiSettings,
  getBlocklist,
  getQuietHours,
  getUserTimezone,
  getRawSetting,
  setRawSetting,
} from '../services/settings';
import { encrypt, decrypt } from '../crypto';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

/** All operator settings. The AI key is never returned — only a masked hint. */
settingsRouter.get('/', async (req: AuthedRequest, res) => {
  const [ai, blocklist, quietHours, timezone, followerTrackingRaw] = await Promise.all([
    getAiSettings(req.userId!),
    getBlocklist(req.userId!),
    getQuietHours(req.userId!),
    getUserTimezone(req.userId!),
    getRawSetting(req.userId!, 'followerTracking'),
  ]);
  res.json({
    ai: {
      provider: ai.provider,
      model: ai.model,
      tone: ai.tone,
      memoryWindow: ai.memoryWindow,
      hasKey: Boolean(ai.apiKey),
      keyHint: ai.apiKey ? `${ai.apiKey.slice(0, 3)}…${ai.apiKey.slice(-4)}` : null,
    },
    blocklist,
    quietHours,
    timezone,
    followerTracking: followerTrackingRaw === 'true',
  });
});

const putSchema = z.object({
  ai: z
    .object({
      provider: z.enum(['openai', 'anthropic', 'ollama']).optional(),
      model: z.string().max(80).optional(),
      tone: z.enum(['friendly', 'professional', 'casual']).optional(),
      memoryWindow: z.number().int().min(2).max(40).optional(),
      apiKey: z.string().max(300).optional(),
    })
    .optional(),
  blocklist: z.array(z.string().max(60)).max(200).optional(),
  quietHours: z
    .object({
      enabled: z.boolean(),
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
    })
    .optional(),
  timezone: z.string().max(80).optional(),
  followerTracking: z.boolean().optional(),
});

settingsRouter.put('/', async (req: AuthedRequest, res) => {
  const parsed = putSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid settings' });
  const input = parsed.data;

  if (input.ai) await saveAiSettings(req.userId!, input.ai);
  if (input.blocklist) await setRawSetting(req.userId!, 'blocklist', JSON.stringify(input.blocklist));
  if (input.quietHours) await setRawSetting(req.userId!, 'quietHours', JSON.stringify(input.quietHours));
  if (input.timezone) await setRawSetting(req.userId!, 'timezone', input.timezone);
  if (input.followerTracking !== undefined) {
    await setRawSetting(req.userId!, 'followerTracking', input.followerTracking ? 'true' : 'false');
  }

  await logEvent({
    level: 'info',
    message: 'Settings updated',
    meta: { keys: Object.keys(input) },
    userId: req.userId!,
  });
  // never echo the stored key back
  const ai = await getAiSettings(req.userId!);
  res.json({
    ok: true,
    ai: { provider: ai.provider, model: ai.model, tone: ai.tone, memoryWindow: ai.memoryWindow, hasKey: Boolean(ai.apiKey) },
  });
});

/** GDPR-style data export: everything the operator owns (tokens excluded). */
settingsRouter.get('/export', async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const [user, accounts, messages, posts, events, metrics, media, tracks, settings] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, createdAt: true } }),
    prisma.account.findMany({ where: { userId } }),
    prisma.message.findMany({ where: { account: { userId } }, orderBy: { createdAt: 'asc' } }),
    prisma.post.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    prisma.event.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    prisma.metric.findMany({ where: { account: { userId } }, orderBy: { date: 'asc' } }),
    prisma.mediaAsset.findMany({ where: { userId } }),
    prisma.track.findMany({ where: { userId } }),
    prisma.setting.findMany({ where: { userId } }),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    user,
    accounts: accounts.map((a) => ({
      ...a,
      accessToken: undefined,
      tokenHint: a.accessToken ? `${decrypt(a.accessToken).slice(0, 3)}…` : null,
    })),
    messages,
    posts,
    events,
    metrics,
    media,
    tracks,
    settings: settings.map((s) => ({
      key: s.key,
      value: s.key === 'ai' ? redactAi(s.value, s.encrypted) : s.encrypted ? '[encrypted]' : s.value,
    })),
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="exotic-bot-export.json"');
  res.send(JSON.stringify(payload, null, 2));
});

function redactAi(value: string, encrypted: boolean): string {
  try {
    const parsed = JSON.parse(encrypted ? decrypt(value) : value);
    if (parsed.apiKey) parsed.apiKey = '[redacted]';
    return JSON.stringify(parsed);
  } catch {
    return '[unparseable]';
  }
}

/**
 * One-click data wipe (§7): removes every account, message, post, metric,
 * file record, track and setting. The operator login is kept so the instance
 * stays usable; full account deletion is done by deleting the deployment DB.
 */
settingsRouter.post('/wipe', async (req: AuthedRequest, res) => {
  if (req.body?.confirm !== 'WIPE') {
    return res.status(400).json({ error: 'Send { confirm: "WIPE" } to confirm permanent deletion' });
  }
  const userId = req.userId!;
  await prisma.$transaction([
    prisma.message.deleteMany({ where: { account: { userId } } }),
    prisma.metric.deleteMany({ where: { account: { userId } } }),
    prisma.unfollower.deleteMany({ where: { account: { userId } } }),
    prisma.followerList.deleteMany({ where: { account: { userId } } }),
    prisma.post.deleteMany({ where: { userId } }),
    prisma.mediaAsset.deleteMany({ where: { userId } }),
    prisma.track.deleteMany({ where: { userId } }),
    prisma.setting.deleteMany({ where: { userId } }),
    prisma.account.deleteMany({ where: { userId } }),
    prisma.event.deleteMany({ where: { userId } }),
  ]);
  await logEvent({ level: 'warn', message: 'Full data wipe executed — all accounts, messages, posts and metrics removed', userId });
  res.json({ ok: true });
});

/** Disconnect every account without wiping content. */
settingsRouter.post('/disconnect-all', async (req: AuthedRequest, res) => {
  const updated = await prisma.account.updateMany({
    where: { userId: req.userId!, status: { not: 'DISCONNECTED' } },
    data: { status: 'DISCONNECTED', autoReplyEnabled: false },
  });
  await logEvent({ level: 'warn', message: `All accounts disconnected (${updated.count})`, userId: req.userId! });
  res.json({ ok: true, count: updated.count });
});
