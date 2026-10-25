import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../db';
import { encrypt, maskSecret } from '../crypto';
import { config } from '../config';
import { requireAuth, signToken, verifyToken, type AuthedRequest } from '../middleware/auth';
import { logEvent, recomputeCounters } from '../services/events';
import { broadcast } from '../services/socket';
import { exchangeInstagramCode as exchangeInstagramConnect, verifyWhatsAppNumber, registerWebhookSubscription } from '../services/meta';
import {
  loginInstagram,
  sendPrivateInstagramDm,
  instagramLoginErrorText,
  IG_PRIVATE_MARKER,
  normalizeProxyUrl,
  loginCooldown,
  recordLoginFailure,
  clearLoginBackoff,
  isInstagramRateLimited,
  isInstagramNetworkError,
  reuseSavedSession,
  type IgLoginOptions,
} from '../services/instagram';
import { scheduleTokenRefresh } from '../services/worker';
import {
  startPairing,
  getPairingStatus,
  requestNewCode,
  cancelPairing,
  stopSocketForNumber,
  PAIR_MARKER,
} from '../services/whatsappPair';

export const accountsRouter = Router();

/**
 * OAuth callback: code → long-lived token → Page → IG business account.
 * Registered BEFORE requireAuth on purpose — the browser lands here straight
 * from facebook.com with no Authorization header; the signed `state` JWT is
 * the only credential, and it is verified inside the handler.
 */
accountsRouter.get('/instagram/callback', async (req, res) => {
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  const back = `${config.webOrigin}/accounts`;
  if (!code) return res.redirect(`${back}?error=missing_code`);
  const payload = state ? verifyToken(state) : null;
  if (!payload) return res.redirect(`${back}?error=invalid_state`);
  try {
    const result = await exchangeInstagramConnect(code, payload.igUsername);
    const existing = await prisma.account.findFirst({
      where: { userId: payload.sub, platform: 'INSTAGRAM', externalId: result.igUserId },
    });
    const data = {
      label: `${result.username} (${result.pageName})`,
      pageId: result.pageId,
      accessToken: encrypt(result.accessToken),
      tokenExpiresAt: result.expiresAt,
      status: 'CONNECTED',
    };
    const account = existing
      ? await prisma.account.update({ where: { id: existing.id }, data })
      : await prisma.account.create({
          data: {
            userId: payload.sub,
            platform: 'INSTAGRAM',
            externalId: result.igUserId,
            ...data,
          },
        });
    scheduleTokenRefresh(account.id, result.expiresAt); // day-50 refresh of the 60-day token
    await logEvent({
      level: 'success',
      message: `Instagram connected: ${result.username}`,
      meta: { accountId: account.id, igUserId: result.igUserId },
      userId: payload.sub,
    });
    broadcast({ type: 'account:updated', data: { id: account.id } });
    await recomputeCounters();
    res.redirect(`${back}?connected=instagram`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'OAuth exchange failed';
    await logEvent({ level: 'error', message: `Instagram connect failed: ${message}`, userId: payload.sub });
    res.redirect(`${back}?error=${encodeURIComponent(message)}`);
  }
});

/**
 * Instagram connect via the *private API* (username + password) — works with no
 * Meta app configured (instagrapi-style). On success the session is stored
 * encrypted on the account and inbound is handled by inbox polling.
 */
accountsRouter.use(requireAuth);

/** "14m 59s" / "42s" for cooldown copy. */
const waitLabel = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`);

/**
 * Instagram connect via the *private API* (username + password) — works with no
 * Meta app configured (instagrapi-style). On success the session is stored
 * encrypted on the account and inbound is handled by inbox polling.
 *
 * Anti-ban behaviour, in order:
 *  1. a previous failure's cooldown answers 429 + `retryAfterSec` (the UI
 *     turns that into a disabled button and a countdown),
 *  2. a saved session for this @username is reused — no password login at all,
 *  3. only then a real login, preceded by a random 2–5s delay and sent
 *     through the residential proxy (per-attempt, else INSTAGRAM_PROXY_URL).
 */
accountsRouter.post('/instagram/private', async (req: AuthedRequest, res) => {
  const parsed = z
    .object({
      username: z.string().min(1).max(40),
      password: z.string().min(1).max(200),
      /** 6-digit 2FA code — supplied on the second attempt after needsTwoFactor. */
      verificationCode: z.string().min(4).max(10).regex(/^\d+$/).optional(),
      verificationMethod: z.enum(['0', '1']).optional(),
      /** Second leg of a challenge (needsChallenge): opaque flow id + security code. */
      challengeId: z.string().min(8).max(64).optional(),
      challengeCode: z.string().min(4).max(10).regex(/^\d+$/).optional(),
      /** Optional residential proxy from the card's Advanced settings. */
      proxy: z.string().max(400).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Instagram username and password are required' });
  const username = parsed.data.username.trim().replace(/^@/, '');
  if (!IG_USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Invalid Instagram username — letters, numbers, dots and underscores.' });
  }
  const password = parsed.data.password;

  // Malformed proxy = 400 up front. We never silently drop to this server's
  // datacenter IP — that is precisely the login Instagram rejects.
  let proxy: string | null = null;
  if (parsed.data.proxy?.trim()) {
    try {
      proxy = normalizeProxyUrl(parsed.data.proxy);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid proxy' });
    }
  }

  const loginOptions: IgLoginOptions = {
    ...(parsed.data.verificationCode ? { twoFactorCode: parsed.data.verificationCode } : {}),
    ...(parsed.data.verificationMethod ? { twoFactorMethod: parsed.data.verificationMethod } : {}),
    ...(parsed.data.challengeId && parsed.data.challengeCode
      ? { challengeId: parsed.data.challengeId, challengeCode: parsed.data.challengeCode }
      : {}),
    proxy,
  };
  // Entering a 2FA/security code is not a fresh credential attempt.
  const codeStep = Boolean(loginOptions.twoFactorCode || loginOptions.challengeCode);

  // 1) backoff — refuse while a previous failure is still cooling down.
  const cooldown = await loginCooldown(req.userId!, username);
  if (cooldown) {
    return res.status(429).json({
      error: cooldown.rateLimited
        ? `Instagram is rate-limiting this account — try again in ${waitLabel(cooldown.retryAfterSec)}.`
        : `Too many failed sign-in attempts — try again in ${waitLabel(cooldown.retryAfterSec)}.`,
      code: 'RATE_LIMITED',
      retryAfterSec: cooldown.retryAfterSec,
    });
  }

  // 2) reuse a saved session when we have one; 3) otherwise log in for real.
  let result: Awaited<ReturnType<typeof loginInstagram>> & { proxy?: string | null } | null = null;
  let reusedSession = false;
  try {
    if (!codeStep) result = await reuseSavedSession(req.userId!, username, proxy);
    if (result) reusedSession = true;
    else result = await loginInstagram(username, password, loginOptions);
  } catch (err) {
    const anyErr = err as { needsTwoFactor?: true; method?: '0' | '1' } | null;
    if (anyErr?.needsTwoFactor) {
      // 409: the credentials were accepted far enough to demand a second factor
      return res.status(409).json({
        error: 'Two-factor code required — enter the 6-digit code from your authenticator app or SMS.',
        needsTwoFactor: true,
        method: anyErr.method === '0' ? 'totp' : 'sms',
      });
    }
    const chErr = err as { needsChallenge?: true; challengeId?: string; sentTo?: string } | null;
    if (chErr?.needsChallenge && chErr.challengeId) {
      // 409: Instagram emailed/texted a security code — the client sends it
      // back with challengeId to finish the connection directly.
      return res.status(409).json({
        error: `Instagram sent a security code to ${chErr.sentTo} — enter it to finish connecting.`,
        needsChallenge: true,
        challengeId: chErr.challengeId,
        sentTo: chErr.sentTo,
      });
    }

    const message = instagramLoginErrorText(err);
    const rateLimited = isInstagramRateLimited(err);
    const unreachable = isInstagramNetworkError(err);
    // Escalate: 5 min → 15 min → 1 h. A dead proxy/network is not a login
    // failure, so it never starts the ladder — that would lock the form for a
    // problem the operator fixes by editing the proxy, not by waiting.
    let retryAfterSec = 0;
    if (!unreachable && (!codeStep || rateLimited)) {
      const waitMs = await recordLoginFailure(req.userId!, username, rateLimited);
      retryAfterSec = Math.ceil(waitMs / 1000);
    }
    await logEvent({
      level: 'error',
      message: `Instagram private login failed: ${message}`,
      meta: rateLimited ? { rateLimited: true, retryAfterSec } : undefined,
      userId: req.userId,
    });
    if (rateLimited) {
      // 429 + this exact code is what the connect card turns into a countdown.
      return res.status(429).json({
        error: message,
        code: 'RATE_LIMITED',
        retryAfterSec,
      });
    }
    return res.status(400).json({
      error: message,
      code: 'LOGIN_FAILED',
      ...(retryAfterSec ? { retryAfterSec } : {}),
    });
  }

  if (!result) return res.status(500).json({ error: 'Instagram login returned no session' });

  const existing = await prisma.account.findFirst({
    where: { userId: req.userId, platform: 'INSTAGRAM', externalId: result.pk },
  });
  // Keep the proxy the session is already pinned to unless this attempt named
  // a new one; null means "follow INSTAGRAM_PROXY_URL from .env".
  const pinnedProxy = proxy ?? (reusedSession ? result.proxy ?? null : null);
  const session = JSON.stringify({
    username: result.username,
    password,
    state: result.state,
    proxy: pinnedProxy ?? null,
  });
  const data = {
    label: result.fullName ? `${result.username} (${result.fullName})` : result.username,
    pageId: IG_PRIVATE_MARKER, // marks this as a private-API (non-OAuth) account
    accessToken: encrypt(session),
    tokenExpiresAt: null,
    status: 'CONNECTED' as const,
  };
  const account = existing
    ? await prisma.account.update({ where: { id: existing.id }, data })
    : await prisma.account.create({
        data: { userId: req.userId!, platform: 'INSTAGRAM', externalId: result.pk, ...data },
      });
  await clearLoginBackoff(req.userId!, username); // clean slate after a success
  await logEvent({
    level: 'success',
    message: reusedSession
      ? `Instagram connected (reused saved session): ${result.username}`
      : `Instagram connected (private API): ${result.username}`,
    meta: { accountId: account.id, igUserId: result.pk, reusedSession },
    userId: req.userId,
  });
  broadcast({ type: 'account:updated', data: { id: account.id } });
  await recomputeCounters();
  res.status(201).json({ account: publicAccount(account) });
});

function publicAccount(a: {
  id: string;
  platform: string;
  externalId: string;
  label: string;
  pageId: string | null;
  wabaId: string | null;
  phoneNumberId: string | null;
  status: string;
  tokenExpiresAt: Date | null;
  autoReplyEnabled: boolean;
  createdAt: Date;
}) {
  return {
    id: a.id,
    platform: a.platform,
    externalId: a.externalId,
    label: a.label,
    pageId: a.pageId,
    wabaId: a.wabaId,
    phoneNumberId: a.phoneNumberId,
    status: a.status,
    tokenExpiresAt: a.tokenExpiresAt,
    autoReplyEnabled: a.autoReplyEnabled,
    createdAt: a.createdAt,
  };
}

accountsRouter.get('/', async (req: AuthedRequest, res) => {
  const accounts = await prisma.account.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ accounts: accounts.map(publicAccount), metaConfigured: Boolean(config.meta.appId && config.meta.appSecret) });
});

const IG_USERNAME_RE = /^[a-zA-Z0-9._]{1,30}$/;

/** Build the official OAuth URL; the requested @username travels in the state JWT. */
function instagramOAuthUrl(userId: string, email: string, wantedUsername?: string): string {
  const { appId, appSecret, redirectUri } = config.meta;
  if (!appId || !appSecret) {
    throw new Error('META_APP_ID / META_APP_SECRET are not configured');
  }
  const state = signToken(userId, email, wantedUsername ? { igUsername: wantedUsername } : {});
  const scopes = [
    'instagram_basic',
    'instagram_manage_comments',
    'instagram_manage_insights',
    'instagram_manage_messages',
    'pages_show_list',
    'pages_read_engagement',
    'business_management',
  ].join(',');
  const url = new URL('https://www.facebook.com/v21.0/dialog/oauth');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return url.toString();
}

function notConfigured(res: any) {
  return res.status(501).json({
    error: 'Instagram OAuth is not configured on this instance',
    hint: 'Set META_APP_ID and META_APP_SECRET in .env (from developers.facebook.com), then restart.',
  });
}

/** Step 1 of the Instagram OAuth 2.0 flow (official Graph API). */
accountsRouter.get('/instagram/start', (req: AuthedRequest, res) => {
  const raw = typeof req.query.username === 'string' ? req.query.username.trim().replace(/^@/, '') : '';
  if (raw && !IG_USERNAME_RE.test(raw)) return res.status(400).json({ error: 'Invalid Instagram username' });
  try {
    res.json({ url: instagramOAuthUrl(req.userId!, req.userEmail || '', raw || undefined) });
  } catch {
    notConfigured(res);
  }
});

/**
 * Connect-by-username: operator types their Instagram handle, we start the
 * same official OAuth flow, and the callback auto-selects the Page-linked IG
 * account whose username matches (see finishInstagramConnect).
 */
accountsRouter.post('/instagram/connect', (req: AuthedRequest, res) => {
  const parsed = z.object({ username: z.string().min(1).max(40) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'username is required (the Instagram handle, without @)' });
  const username = parsed.data.username.trim().replace(/^@/, '');
  if (!IG_USERNAME_RE.test(username)) {
    return res
      .status(400)
      .json({ error: 'Invalid Instagram username — letters, numbers, dots and underscores, max 30 characters.' });
  }
  try {
    res.json({ url: instagramOAuthUrl(req.userId!, req.userEmail || '', username), username });
  } catch {
    notConfigured(res);
  }
});

/**
 * WhatsApp linking by phone number + genuine pairing code — the same
 * "Link with phone number" flow as WhatsApp → Linked devices.
 */
accountsRouter.post('/whatsapp/pair', async (req: AuthedRequest, res) => {
  try {
    const session = await startPairing(req.userId!, String(req.body?.phoneNumber || ''));
    res.status(202).json({ session });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not start pairing' });
  }
});

/** Poll the linking session (code, countdown, paired/error state). */
accountsRouter.get('/whatsapp/pair/:sessionId', (req: AuthedRequest, res) => {
  const session = getPairingStatus(req.params.sessionId, req.userId!);
  if (!session) return res.status(404).json({ error: 'Linking session not found or expired' });
  res.json({ session });
});

/** The code expired or the flow dropped — request a fresh code on the same socket. */
accountsRouter.post('/whatsapp/pair/:sessionId/code', async (req: AuthedRequest, res) => {
  try {
    const session = await requestNewCode(req.params.sessionId, req.userId!);
    res.json({ session });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not request a code' });
  }
});

/** Abandon a linking attempt (closes the socket, deletes any half-written auth state). */
accountsRouter.delete('/whatsapp/pair/:sessionId', async (req: AuthedRequest, res) => {
  const ok = await cancelPairing(req.params.sessionId, req.userId!);
  res.json({ ok });
});

/** WhatsApp Cloud API: phone number ID + system user token from Business Suite. */
accountsRouter.post('/whatsapp', async (req: AuthedRequest, res) => {
  const schema = z.object({
    phoneNumberId: z.string().min(5),
    accessToken: z.string().min(10),
    wabaId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'phoneNumberId and accessToken are required' });
  const { phoneNumberId, accessToken, wabaId } = parsed.data;

  try {
    const verified = await verifyWhatsAppNumber(phoneNumberId, accessToken);
    const existing = await prisma.account.findFirst({
      where: { userId: req.userId, platform: 'WHATSAPP', externalId: phoneNumberId },
    });
    const account = existing
      ? await prisma.account.update({
          where: { id: existing.id },
          data: { accessToken: encrypt(accessToken), status: 'CONNECTED', label: verified.display },
        })
      : await prisma.account.create({
          data: {
            userId: req.userId!,
            platform: 'WHATSAPP',
            externalId: phoneNumberId,
            phoneNumberId,
            wabaId: wabaId || null,
            label: verified.displayPhone ? `${verified.display} (${verified.displayPhone})` : verified.display,
            accessToken: encrypt(accessToken),
            status: 'CONNECTED',
          },
        });
    await logEvent({
      level: 'success',
      message: `WhatsApp Business number connected: ${verified.displayPhone || phoneNumberId}`,
      meta: { accountId: account.id },
    });
    broadcast({ type: 'account:updated', data: { id: account.id } });
    await recomputeCounters();
    res.status(201).json({ account: publicAccount(account) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Verification failed';
    await logEvent({ level: 'error', message: `WhatsApp connect failed: ${message}` });
    res.status(400).json({ error: message });
  }
});

/** Register this instance's webhook URL with the Meta app (optional helper). */
accountsRouter.post('/webhooks/register', async (req: AuthedRequest, res) => {
  const base = config.meta.publicWebhookUrl || `${config.publicUrl}/webhooks/meta`;
  if (!base.startsWith('https://')) {
    return res.status(400).json({
      error: 'PUBLIC_WEBHOOK_URL must be an https URL Meta can reach (use a tunnel in development)',
    });
  }
  try {
    await registerWebhookSubscription({ callbackUrl: base, verifyToken: config.meta.verifyToken });
    await logEvent({ level: 'success', message: `Webhook subscription registered: ${base}` });
    res.json({ ok: true, callbackUrl: base });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to register webhook' });
  }
});

/** Per-platform auto-reply toggle (off by default — human-in-the-loop). */
accountsRouter.patch('/:id', async (req: AuthedRequest, res) => {
  const account = await prisma.account.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const next =
    typeof req.body?.autoReplyEnabled === 'boolean' ? req.body.autoReplyEnabled : account.autoReplyEnabled;
  const updated = await prisma.account.update({ where: { id: account.id }, data: { autoReplyEnabled: next } });
  await logEvent({
    level: next ? 'warn' : 'info',
    message: `Auto-reply ${next ? 'enabled' : 'disabled'} for ${account.platform} (${account.label})`,
    meta: { accountId: account.id },
  });
  broadcast({ type: 'account:updated', data: { id: account.id, autoReplyEnabled: next } });
  res.json({ account: publicAccount(updated) });
});

/** Disconnect: marks DISCONNECTED and stops all outbound actions for the account. */
accountsRouter.delete('/:id', async (req: AuthedRequest, res) => {
  const account = await prisma.account.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!account) return res.status(404).json({ error: 'Account not found' });
  await prisma.account.update({
    where: { id: account.id },
    data: { status: 'DISCONNECTED', autoReplyEnabled: false },
  });
  if (account.platform === 'WHATSAPP' && account.phoneNumberId === PAIR_MARKER) {
    await stopSocketForNumber(account.externalId); // unlink the paired device
  }
  await logEvent({ level: 'warn', message: `Account disconnected: ${account.label}`, meta: { accountId: account.id } });
  broadcast({ type: 'account:updated', data: { id: account.id, status: 'DISCONNECTED' } });
  await recomputeCounters();
  res.json({ ok: true });
});

/** Live status (incl. token expiry) for the connection badges. */
accountsRouter.get('/:id/status', async (req: AuthedRequest, res) => {
  const account = await prisma.account.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const daysLeft = account.tokenExpiresAt
    ? Math.ceil((account.tokenExpiresAt.getTime() - Date.now()) / 86400000)
    : null;
  res.json({
    id: account.id,
    status: account.status,
    tokenExpiresAt: account.tokenExpiresAt,
    tokenDaysLeft: daysLeft,
    autoReplyEnabled: account.autoReplyEnabled,
  });
});
