import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import sharp from 'sharp';
import { prisma } from '../db';
import { config } from '../config';
import { encrypt, decrypt } from '../crypto';
import { logEvent } from './events';
import { broadcast } from './socket';
import type { InboundItem } from './worker';

/**
 * Instagram connection via the *private API* (username + password) — the same
 * approach as Python's `instagrapi`, implemented with the Node equivalent
 * (`instagram-private-api`). No Meta app / OAuth / Facebook Page is required,
 * so this works on instances where META_APP_ID/SECRET were never configured
 * (the official Graph API flow is what returns "Instagram OAuth is not
 * configured on this instance").
 *
 * The serialized session (cookies + device) is stored encrypted in
 * Account.accessToken and rehydrated on demand, so we log in once and reuse
 * the session (Instagram penalises repeated password logins).
 *
 * Risks: this is a reverse-engineered, unofficial API. Instagram can rate-limit,
 * checkpoint (checkpoint_required) or challenge (challenge_required) an account,
 * especially from datacenter IPs or on new logins. Session reuse + human delays
 * reduce (but do not eliminate) that risk.
 */

// instagram-private-api is CJS but built to ESM-friendly interop; import lazily
// exactly like Baileys so the server boots even if the package is missing.
const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;

let igModule: any = null;
async function loadIg() {
  if (!igModule) igModule = await dynamicImport('instagram-private-api');
  return igModule;
}

export const IG_PRIVATE_MARKER = 'PRIVATE_API'; // stored in Account.pageId for private-API accounts

// ── residential proxy (Instagram blocks datacenter logins) ─────────────

/**
 * Normalize a proxy the way operators actually paste it — either a URL
 * (`http://user:pass@host:port`) or the shorthand every provider prints
 * (`host:port:user:pass`, `host:port`, `user:pass@host:port`) — into a URI
 * the underlying `request` client accepts. Returns null for an empty value
 * and throws for a malformed one, so a typo can never silently fall back to
 * this server's datacenter IP (which is exactly what Instagram blocks).
 */
export function normalizeProxyUrl(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    // full URL form
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('Proxy must look like http://user:pass@host:port (or host:port:user:pass).');
    }
    if (!/^(https?|socks5h?):$/i.test(url.protocol)) {
      throw new Error('Proxy scheme must be http, https or socks5.');
    }
    const port = Number(url.port || (url.protocol === 'https:' ? '443' : '80'));
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Proxy must include a valid host and port.');
    }
    const auth = url.username
      ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
      : '';
    return `${url.protocol}//${auth ? `${auth}@` : ''}${url.hostname}:${port}`;
  }

  // shorthand forms
  let host: string;
  let portRaw: string;
  let user = '';
  let pass = '';
  const at = value.lastIndexOf('@');
  if (at >= 0) {
    // user:pass@host:port
    const creds = value.slice(0, at);
    const sep = creds.indexOf(':');
    if (sep < 0) throw new Error('Proxy credentials must be user:pass@host:port.');
    user = creds.slice(0, sep);
    pass = creds.slice(sep + 1);
    [host, portRaw] = value.slice(at + 1).split(':');
  } else {
    const parts = value.split(':');
    if (parts.length < 2) {
      throw new Error('Proxy must be host:port, host:port:user:pass or a full http://user:pass@host:port URL.');
    }
    host = parts[0];
    portRaw = parts[1];
    if (parts.length >= 3) {
      user = parts[2];
      pass = parts.slice(3).join(':'); // passwords may contain ':'
    }
  }
  const port = Number(portRaw);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Proxy must include a valid host and port.');
  }
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
  return `http://${auth}${host}:${port}`;
}

/** INSTAGRAM_PROXY_URL from .env — validated once, warned about if malformed. */
let envProxy: { raw: string; value: string | null } | null = null;
function defaultProxy(): string | null {
  const raw = config.instagram.proxyUrl;
  if (envProxy && envProxy.raw === raw) return envProxy.value;
  let value: string | null = null;
  if (raw.trim()) {
    try {
      value = normalizeProxyUrl(raw);
    } catch (err) {
      console.warn(`[instagram] INSTAGRAM_PROXY_URL ignored: ${err instanceof Error ? err.message : err}`);
    }
  }
  envProxy = { raw, value };
  return value;
}

/**
 * Effective proxy for a client: an explicit per-attempt value (the Advanced
 * settings field, or the one stored on the session) wins over .env; no value
 * anywhere means a direct connection.
 */
export function resolveInstagramProxy(explicit?: string | null): string | null {
  if (explicit && explicit.trim()) {
    try {
      return normalizeProxyUrl(explicit);
    } catch (err) {
      // a stale/malformed stored proxy must not brick the account
      console.warn(`[instagram] stored proxy ignored: ${err instanceof Error ? err.message : err}`);
      return defaultProxy();
    }
  }
  return defaultProxy();
}

/**
 * Instagram's Android fallback password-encryption public key (key id 41).
 *
 * `ig.account.login()` only calls `qe.syncLoginExperiments()` (which Instagram
 * 401s from server/datacenter IPs) when `state.passwordEncryptionPubKey` is
 * absent — the key normally arrives via `ig-set-password-encryption-pub-key`
 * response headers. Seeding the published Android key here lets login skip
 * qe/sync entirely. This is not a secret: it ships in the official APK and is
 * documented in dilame/instagram-private-api#1010. Any Instagram response that
 * carries the real header still overwrites it automatically (request.updateState),
 * so the pinned value can never go stale.
 *
 * `encryptPassword` does Buffer.from(state.passwordEncryptionPubKey, 'base64')
 * and feeds the result to crypto.publicEncrypt, so the state value must be the
 * base64 of the PEM text itself.
 */
const FALLBACK_PW_PUBKEY = Buffer.from(
  `-----BEGIN PUBLIC KEY-----\n` +
    'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvcu1KMDR1vzuBr9iYKW8\n' +
    'KWmhT8CVUBRkchiO8861H7zIOYRwkQrkeHA+0mkBo3Ly1PiLXDkbKQZyeqZbspke\n' +
    '4e7WgFNwT23jHfRMV/cNPxjPEy4kxNEbzLET6GlWepGdXFhzHfnS1PinGQzj0ZOU\n' +
    'ZM3pQjgGRL9fAf8brt1ewhQ5XtpvKFdPyQq5BkeFEDKoInDsC/yKDWRAx2twgPFr\n' +
    'CYUzAB8/yXuL30ErTHT79bt3yTnv1fRtE19tROIlBuqruwSBk9gGq/LuvSECgsl5\n' +
    'z4VcpHXhgZt6MhrAj6y9vAAxO2RVrt0Mq4OY4HgyYz9Wlr1vAxXXGAAYIvrhAYLP\n' +
    '7QIDAQAB\n' +
    '-----END PUBLIC KEY-----',
).toString('base64');
const FALLBACK_PW_KEY_ID = 41;

export interface IgLoginOptions {
  /** 6-digit code from an authenticator app or SMS, when the account has 2FA. */
  twoFactorCode?: string;
  /** '0' = TOTP authenticator, '1' = SMS (Instagram's own codes). */
  twoFactorMethod?: '0' | '1';
  /** Second leg of a challenge: the id of the pending verification flow. */
  challengeId?: string;
  /** The security code Instagram emailed/texted during the challenge. */
  challengeCode?: string;
  /**
   * Residential proxy for this attempt (`http://user:pass@host:port`). When
   * absent, INSTAGRAM_PROXY_URL from .env applies; when both are absent the
   * request goes direct.
   */
  proxy?: string | null;
}

/** Thrown when Instagram demands a 2FA code; the route maps this to needsTwoFactor. */
class TwoFactorRequiredError extends Error {
  readonly needsTwoFactor = true as const;
  constructor(
    message: string,
    readonly method: '0' | '1',
  ) {
    super(message);
    this.name = 'TwoFactorRequiredError';
  }
}

function isTwoFactorRequired(err: unknown): boolean {
  const e = err as { name?: string; response?: { body?: { two_factor_required?: boolean; error_type?: string } } } | null;
  return Boolean(
    e &&
      (e.name === 'IgLoginTwoFactorRequiredError' ||
        e.response?.body?.two_factor_required === true ||
        e.response?.body?.error_type === 'two_factor_required'),
  );
}

/** Thrown when Instagram demands a security code (challenge_required) — the
 * route maps it to a 409 needsChallenge so the UI can collect the code that
 * Instagram just emailed/texted and finish the connection directly. */
class ChallengeRequiredError extends Error {
  readonly needsChallenge = true as const;
  constructor(
    readonly challengeId: string,
    /** Where Instagram sent the code (masked contact point when known). */
    readonly sentTo: string,
  ) {
    super('Instagram sent a security code to verify this login.');
    this.name = 'ChallengeRequiredError';
  }
}

function isChallengeRequired(err: unknown): boolean {
  const e = err as { name?: string; response?: { body?: { message?: string } } } | null;
  return Boolean(e && (e.name === 'IgCheckpointError' || e.response?.body?.message === 'challenge_required'));
}

/**
 * Pending challenge flows, keyed by a one-shot id. The first login attempt
 * trips the challenge and dispatches the code; we park the client state
 * (checkpoint + challenge URL + cookies) here so the second request can
 * verify the code on the same device identity. State stays server-side — the
 * browser only ever sees the opaque id. 10-minute TTL, purged on read.
 */
interface ChallengeFlow {
  username: string;
  password: string;
  state: any;
  /** egress used by the leg that tripped the challenge — the verifying leg must match */
  proxy: string | null;
  dispatched: boolean; // code already sent by auto() in the first leg
  expires: number;
}
const CHALLENGE_TTL_MS = 10 * 60_000;
const challengeFlows = new Map<string, ChallengeFlow>();

function rememberChallenge(
  username: string,
  password: string,
  state: any,
  proxy: string | null,
  dispatched: boolean,
): string {
  for (const [id, flow] of challengeFlows) if (flow.expires <= Date.now()) challengeFlows.delete(id);
  const id = randomUUID();
  challengeFlows.set(id, {
    username,
    password,
    state,
    proxy,
    dispatched,
    expires: Date.now() + CHALLENGE_TTL_MS,
  });
  return id;
}

function getChallenge(id: string): ChallengeFlow | null {
  const flow = challengeFlows.get(id);
  if (!flow) return null;
  if (flow.expires <= Date.now()) {
    challengeFlows.delete(id);
    return null;
  }
  return flow;
}

/** Masked contact point Instagram sends the code to ("s***@e***.com", "***42"). */
function challengeSentHint(ig: any): string {
  const step = ig.state.challenge;
  const contact = String(step?.step_data?.contact_point || step?.step_data?.email || '').trim();
  return contact || 'your email or phone';
}

interface SessionBlob {
  username: string;
  password: string; // kept only to re-login when the session expires/challenges
  state: any; // ig.state.serialize() output
  /** proxy this session was opened through; null/absent = follow .env */
  proxy?: string | null;
}

function parseSession(token: string): SessionBlob | null {
  if (!token) return null;
  // Sessions are stored AES-256-GCM encrypted (v1:…); tolerate a plain-JSON
  // blob too (legacy rows / test fixtures). OAuth accounts hold a Graph token
  // here — decrypt yields a non-JSON string, so they fall through to null.
  let raw = token;
  if (raw.startsWith('v1:')) {
    try {
      raw = decrypt(raw);
    } catch {
      return null; // wrong key or corrupted row
    }
  }
  try {
    const blob = JSON.parse(raw);
    if (blob && typeof blob.username === 'string' && blob.state) return blob as SessionBlob;
    return null;
  } catch {
    return null;
  }
}

/**
 * Build a configured client with a stable device identity for the username.
 * `proxy` is applied to `ig.state.proxyUrl`, which the library's request layer
 * hands to `request` as its `proxy` option on **every** call — login, session
 * reuse, DMs and publishing all egress through the same IP.
 */
async function makeClient(username: string, proxy: string | null = null) {
  const { IgApiClient } = await loadIg();
  const ig = new IgApiClient();
  ig.state.generateDevice(username);
  if (proxy) ig.state.proxyUrl = proxy;
  return ig;
}

/**
 * Human-ish delay before the password request. Instagram fingerprints login
 * timing, so we wait a random 2–5s instead of firing the moment the button is
 * pressed (a fixed/zero delay looks exactly like a bot).
 */
function humanDelay(ms = 2000 + Math.random() * 3000) {
  return new Promise((r) => setTimeout(r, ms));
}

function humanizeLoginError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lowered = raw.toLowerCase();
  if (lowered.includes('checkpoint')) {
    return 'Instagram flagged this login for verification (checkpoint). Open Instagram on your phone, complete the challenge, then try again — datacenter IPs are often challenged.';
  }
  if (lowered.includes('challenge_required') || lowered.includes('challenge')) {
    return 'Instagram wants a login challenge. Confirm the login from the official app (or email/SMS), then reconnect.';
  }
  if (lowered.includes('two_factor') || lowered.includes('2fa')) {
    return 'Two-factor authentication is enabled — temporarily disable 2FA or complete it manually in the Instagram app, then reconnect.';
  }
  if (lowered.includes('bad password') || lowered.includes('invalid') || lowered.includes('incorrect')) {
    return 'Instagram rejected the username or password.';
  }
  if (lowered.includes('user not found') || lowered.includes('no user found')) {
    return 'No Instagram account matches that username.';
  }
  if (lowered.includes('rate') || lowered.includes('too many') || lowered.includes('feedback_required')) {
    return 'Instagram is rate-limiting this account — wait a few minutes (or hours for datacenter IPs) before retrying.';
  }
  if (raw.includes('qe/sync')) {
    return 'Instagram blocked a preliminary login request from this server IP (401 on qe/sync). Wait a few minutes and retry — repeated blocks usually mean the IP is flagged, in which case connecting from a residential IP is more reliable.';
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
    return 'Could not reach Instagram servers from this instance — check outbound network access.';
  }
  return raw.length > 180 ? `${raw.slice(0, 177)}…` : raw;
}

/**
 * Log in with username + password, run the pre-login flow, and return the
 * serialized session plus the account identity. One call, one password use.
 */
export async function loginInstagram(
  username: string,
  password: string,
  options: IgLoginOptions = {},
): Promise<{ state: any; pk: string; username: string; fullName: string }> {
  const proxy = resolveInstagramProxy(options.proxy);
  let ig: any;

  if (options.challengeId) {
    // Second leg: verify the security code Instagram just sent, then log in
    // on the same device identity that tripped the challenge.
    const flow = getChallenge(options.challengeId);
    if (!flow) {
      throw new Error('That Instagram verification expired — sign in again with your username and password.');
    }
    username = flow.username;
    password = flow.password;
    // Instagram rejects a code submitted from a different egress IP — reuse
    // the proxy the first leg used, whatever the current default is.
    ig = await makeClient(username, flow.proxy ?? proxy);
    await ig.state.deserialize(flow.state);
    if (!ig.state.passwordEncryptionPubKey) {
      ig.state.passwordEncryptionPubKey = FALLBACK_PW_PUBKEY;
      ig.state.passwordEncryptionKeyId = FALLBACK_PW_KEY_ID;
    }
    if (!flow.dispatched) {
      // first leg could not dispatch the code — do it now
      await ig.challenge.auto().catch(() => undefined);
    }
    try {
      await ig.challenge.sendSecurityCode(String(options.challengeCode || ''));
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (/wrong|incorrect|invalid|expired/i.test(raw)) {
        throw new Error('Instagram rejected that code — check the latest email or SMS and enter it again.');
      }
      throw new Error(`Could not verify that code: ${raw.length > 140 ? `${raw.slice(0, 137)}…` : raw}`);
    }
    challengeFlows.delete(options.challengeId); // code verified — flow consumed
  } else {
    ig = await makeClient(username, proxy);
    await ig.simulate.preLoginFlow().catch(() => undefined);
    await humanDelay(); // random 2–5s: never fire the password request on a fixed beat
    // Skip qe/sync (401 from server IPs) by seeding the encryption key directly.
    if (!ig.state.passwordEncryptionPubKey) {
      ig.state.passwordEncryptionPubKey = FALLBACK_PW_PUBKEY;
      ig.state.passwordEncryptionKeyId = FALLBACK_PW_KEY_ID;
    }
  }

  let user: any;
  try {
    user = await ig.account.login(username, password);
  } catch (err) {
    if (!isTwoFactorRequired(err)) {
      if (isChallengeRequired(err)) {
        // Instagram emailed/texted a security code — dispatch it, park the
        // client state, and let the UI collect the code right here.
        let dispatched = false;
        try {
          await ig.challenge.auto();
          dispatched = true;
        } catch {
          /* dispatch failed — the second leg retries auto() before sending */
        }
        const id = rememberChallenge(username, password, await ig.state.serialize(), proxy, dispatched);
        throw new ChallengeRequiredError(id, challengeSentHint(ig));
      }
      throw err;
    }
    const info = (err as any)?.response?.body?.two_factor_info || {};
    const identifier = String(info.two_factor_identifier || '');
    if (!options.twoFactorCode) {
      const igMethod = String(info.method ?? '1') === '0' ? '0' : '1';
      throw new TwoFactorRequiredError(
        'Two-factor authentication is enabled for this account — enter the code to continue.',
        igMethod,
      );
    }
    if (!identifier) {
      throw new Error(
        'Instagram did not issue a two-factor token — wait a minute and retry, or confirm the login from the Instagram app first.',
      );
    }
    const method = options.twoFactorMethod ?? (String(info.method ?? '1') === '0' ? '0' : '1');
    const result = await ig.account.twoFactorLogin({
      username,
      verificationCode: options.twoFactorCode,
      twoFactorIdentifier: identifier,
      verificationMethod: method,
    });
    user = result?.logged_in_user || {
      pk: info.pk || info.user_id,
      username: info.username || username,
      full_name: '',
    };
  }

  // postLoginFlow is recommended but must not block the response
  setImmediate(() => {
    void ig.simulate.postLoginFlow().catch(() => undefined);
  });
  const state = await ig.state.serialize();
  const pk = String(user?.pk ?? user?.id ?? '');
  if (!pk) throw new Error('Instagram login did not return a user id');
  return { state, pk, username: String(user?.username || username), fullName: String(user?.full_name || '') };
}

/**
 * Rehydrate a client from the encrypted session stored on the account.
 * `proxy` overrides the one recorded on the blob (an explicit per-attempt
 * proxy wins); when absent, the blob's proxy — or .env — applies.
 */
async function clientFromState(blob: SessionBlob, proxy?: string | null) {
  const ig = await makeClient(blob.username, proxy ?? resolveInstagramProxy(blob.proxy));
  await ig.state.deserialize(blob.state);
  return ig;
}

/**
 * Log back in automatically when the saved session is no longer valid
 * (expired cookies, challenge, logout). Returns a fresh state or throws a
 * human-readable error.
 */
async function relogin(blob: SessionBlob): Promise<any> {
  const fresh = await loginInstagram(blob.username, blob.password, { proxy: blob.proxy });
  return fresh.state;
}

/** Persist a fresh session blob back onto the account row. */
async function saveState(accountId: string, blob: SessionBlob) {
  await prisma.account.update({
    where: { id: accountId },
    data: { accessToken: encrypt(JSON.stringify(blob)) },
  });
}

// ── login cooldown / backoff ──────────────────────────────────────────

/**
 * A failed sign-in starts a cooldown — 5 minutes, then 15, then an hour — so
 * the connect button cannot be spammed into a hard Instagram block. Kept in
 * the Setting table (per user + username) so it survives a server restart.
 */
const BACKOFF_MINUTES = [5, 15, 60];
const backoffKey = (username: string) => `ig:backoff:${username.toLowerCase()}`;

interface BackoffState {
  failures: number;
  lockedUntil: number; // epoch ms; 0 = no active lock
  rateLimited: boolean; // why the last failure happened (drives the UI copy)
}

async function readBackoff(userId: string, username: string): Promise<BackoffState | null> {
  try {
    const row = await prisma.setting.findUnique({
      where: { userId_key: { userId, key: backoffKey(username) } },
    });
    if (!row) return null;
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed.failures !== 'number') return null;
    return {
      failures: parsed.failures,
      lockedUntil: Number(parsed.lockedUntil) || 0,
      rateLimited: Boolean(parsed.rateLimited),
    };
  } catch {
    return null; // unreadable row → treat as no cooldown rather than blocking login
  }
}

async function writeBackoff(userId: string, username: string, state: BackoffState) {
  const key = backoffKey(username);
  const value = JSON.stringify(state);
  await prisma.setting.upsert({
    where: { userId_key: { userId, key } },
    create: { userId, key, value },
    update: { value },
  });
}

/** Milliseconds left on the cooldown for this username (0 = may log in). */
export async function loginCooldown(
  userId: string,
  username: string,
): Promise<{ retryAfterSec: number; rateLimited: boolean } | null> {
  const state = await readBackoff(userId, username);
  if (!state) return null;
  const ms = Math.max(0, state.lockedUntil - Date.now());
  if (ms <= 0) return null;
  return { retryAfterSec: Math.ceil(ms / 1000), rateLimited: state.rateLimited };
}

/** Record a failed login and return how long the next attempt must wait. */
export async function recordLoginFailure(
  userId: string,
  username: string,
  rateLimited: boolean,
): Promise<number> {
  const previous = await readBackoff(userId, username);
  const failures = (previous?.failures ?? 0) + 1;
  const stepMs = BACKOFF_MINUTES[Math.min(failures - 1, BACKOFF_MINUTES.length - 1)] * 60_000;
  // A real Instagram rate limit is never a 5-minute problem — the UI promises
  // 15 minutes, so honour at least that even on the first failure.
  const waitMs = rateLimited ? Math.max(stepMs, 15 * 60_000) : stepMs;
  await writeBackoff(userId, username, {
    failures,
    lockedUntil: Date.now() + waitMs,
    rateLimited,
  });
  return waitMs;
}

/** A successful sign-in resets the ladder. */
export async function clearLoginBackoff(userId: string, username: string): Promise<void> {
  await prisma.setting
    .deleteMany({ where: { userId, key: backoffKey(username) } })
    .catch(() => undefined);
}

/** True when Instagram itself throttled us (HTTP 429 / feedback_required / spam block). */
export function isInstagramRateLimited(err: unknown): boolean {
  const e = err as {
    statusCode?: number;
    name?: string;
    response?: { statusCode?: number; body?: { message?: string; spam?: boolean } };
  } | null;
  if (e?.statusCode === 429 || e?.response?.statusCode === 429) return true;
  if (e?.name === 'IgActionSpamError' || e?.response?.body?.spam) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /rate.?limit|too many requests|feedback_required|please wait a few minutes|\bspam\b/.test(msg);
}

/** True when the request never reached Instagram (proxy/network problem) — not a ban. */
export function isInstagramNetworkError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name || '';
  if (name === 'IgNetworkError') return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /enotfound|econnrefused|econnreset|etimedout|econnaborted|eai_again|econnexception|socket hang up|getaddrinfo|fetch failed|network|timeout|etimedout/.test(msg);
}

/**
 * Reuse the session we already hold for this @username instead of paying for
 * another password login — Instagram flags repeated password logins from one
 * IP, which is exactly the "re-authenticates from scratch every time" failure
 * mode. Returns null when there is no usable saved session (never connected,
 * expired, challenged, or a different account), so the caller can fall back to
 * a real username/password login.
 */
export async function reuseSavedSession(
  userId: string,
  username: string,
  proxy: string | null,
): Promise<
  | { accountId: string; state: any; pk: string; username: string; fullName: string; proxy: string | null }
  | null
> {
  const rows = await prisma.account.findMany({
    where: {
      userId,
      platform: 'INSTAGRAM',
      pageId: IG_PRIVATE_MARKER,
      status: { not: 'DISCONNECTED' },
    },
    orderBy: { createdAt: 'desc' },
  });
  for (const row of rows) {
    const blob = parseSession(row.accessToken);
    if (!blob || blob.username.toLowerCase() !== username.toLowerCase()) continue;
    try {
      const ig = await clientFromState(blob, proxy);
      // one cheap authenticated call — proves the cookies still work
      const self = await ig.account.currentUser();
      const state = await ig.state.serialize();
      if (JSON.stringify(state) !== JSON.stringify(blob.state)) {
        await saveState(row.id, { ...blob, state }); // cookies refresh on use
      }
      return {
        accountId: row.id,
        state,
        pk: String(self?.pk ?? self?.id ?? row.externalId),
        username: String(self?.username || blob.username),
        fullName: String(self?.full_name || ''),
        proxy: blob.proxy ?? null, // pin this account was opened with (null = follow .env)
      };
    } catch {
      // dead session / unreachable proxy → let the caller do a real login
    }
  }
  return null;
}

/** Resolve the session blob for an account; throws if it isn't a private-API account. */
export function sessionForAccount(token: string): SessionBlob {
  const blob = parseSession(token);
  if (!blob) throw new Error('Instagram account is not connected via the private API — reconnect it');
  return blob;
}

/**
 * Send a DM over the private API. Falls back to a one-shot re-login when the
 * stored session has gone stale, then retries once.
 */
export async function sendPrivateInstagramDm(
  accountId: string,
  recipient: string,
  text: string,
): Promise<{ messageId: string | null }> {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) throw new Error('Account not found');
  if (account.status === 'DISCONNECTED') throw new Error('Instagram account is disconnected');
  const blob = sessionForAccount(account.accessToken);

  const attempt = async (useFreshSession: boolean) => {
    const active = useFreshSession ? ({ ...blob, state: await relogin(blob) } as SessionBlob) : blob;
    if (useFreshSession) await saveState(accountId, active);
    const ig = await clientFromState(active);
    // recipient can be a numeric pk or a @username
    const targetId = /^\d+$/.test(recipient) ? recipient : await ig.user.getIdByUsername(recipient.replace(/^@/, ''));
    const result = await ig.directThread.broadcast({
      item: 'text',
      userIds: [targetId],
      form: { text },
    });
    const first = Array.isArray(result) ? result[0] : result;
    const id = first?.item_id || first?.message_id || first?.thread_id || null;
    return { messageId: id ? String(id) : null };
  };

  try {
    return await attempt(false);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stale = /not|login|login_required|challenge|checkpoint|expired|401|403/i.test(msg);
    if (!stale) throw new Error(humanizeLoginError(err));
    // session went stale → one automatic re-login, then retry once
    return await attempt(true);
  }
}

// ── feed publishing over the private API ───────────────────────────────

/**
 * Resolve a composer media reference to raw bytes: an /uploads/… path from
 * the media library is read off disk, an http(s) URL is downloaded.
 */
async function resolveMediaBuffer(mediaUrl: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(mediaUrl)) {
    const res = await fetch(mediaUrl);
    if (!res.ok) {
      throw new Error(`Could not download the media (HTTP ${res.status}) — the URL must be reachable from this server.`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
  const name = path.basename(mediaUrl); // also strips any directory traversal
  const candidates = [path.join(config.paths.uploads, name), path.join(config.paths.thumbs, name)];
  for (const abs of candidates) {
    if (fs.existsSync(abs)) return fs.readFileSync(abs);
  }
  throw new Error(`Media file ${name} is missing on this server — re-upload it from the Content media picker, then retry.`);
}

let ffmpegProbe: Promise<boolean> | null = null;
function hasFfmpeg(): Promise<boolean> {
  if (!ffmpegProbe) {
    ffmpegProbe = new Promise<boolean>((resolve) => {
      const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    });
  }
  return ffmpegProbe;
}

/**
 * `ig.publish.video` requires a cover-frame JPEG. With ffmpeg on the host we
 * grab the real first frame; without it we send a neutral dark JPEG (the
 * cover only affects the feed-grid thumbnail).
 */
async function videoCoverJpeg(video: Buffer): Promise<Buffer> {
  if (await hasFfmpeg()) {
    const frame = await new Promise<Buffer | null>((resolve) => {
      const p = spawn(
        'ffmpeg',
        ['-ss', '0', '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2', '-vcodec', 'mjpeg', 'pipe:1'],
        { stdio: ['pipe', 'pipe', 'ignore'] },
      );
      const chunks: Buffer[] = [];
      p.stdout.on('data', (c: Buffer) => chunks.push(c));
      p.on('error', () => resolve(null));
      p.on('close', (code) => resolve(code === 0 && chunks.length > 0 ? Buffer.concat(chunks) : null));
      p.stdin.end(video);
    });
    if (frame && frame.length > 0) return frame;
  }
  return sharp({ create: { width: 720, height: 720, channels: 3, background: { r: 12, g: 14, b: 24 } } })
    .jpeg()
    .toBuffer();
}

/**
 * Publish an image/video to the Instagram feed over the *private API* — the
 * path accounts connected with username + password actually use. The Graph
 * publish endpoints only accept OAuth tokens and a publicly reachable media
 * URL; this uploads the file bytes directly through the logged-in session.
 * One stale-session re-login + retry, same as DM sends.
 */
export async function publishInstagramPrivate(
  accountId: string,
  opts: { caption: string; mediaUrl: string | null; mediaType: 'IMAGE' | 'VIDEO' | 'NONE' },
): Promise<{ externalId: string }> {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) throw new Error('Account not found');
  if (account.status === 'DISCONNECTED') throw new Error('Instagram account is disconnected');
  const blob = sessionForAccount(account.accessToken);

  if (!opts.mediaUrl || opts.mediaType === 'NONE') {
    throw new Error(
      'Instagram has no text-only feed post — attach an image or video (upload one in the Content media picker) first.',
    );
  }
  const media = await resolveMediaBuffer(opts.mediaUrl);

  const attempt = async (session: SessionBlob) => {
    const ig = await clientFromState(session);
    const result =
      opts.mediaType === 'VIDEO'
        ? await ig.publish.video({ video: media, coverImage: await videoCoverJpeg(media), caption: opts.caption })
        : await ig.publish.photo({ file: media, caption: opts.caption });
    // publishing refreshes cookies — persist the session the send succeeded on
    await saveState(accountId, { ...session, state: await ig.state.serialize() });
    const pk = String(result?.media?.pk ?? result?.pk ?? '');
    if (!pk) throw new Error('Instagram accepted the post but returned no media id');
    return { externalId: pk };
  };

  try {
    return await attempt(blob);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stale = /not|login|login_required|challenge|checkpoint|expired|401|403/i.test(msg);
    if (!stale) throw new Error(humanizeLoginError(err));
    // stale session → one fresh login, then retry the publish once
    const fresh = await loginInstagram(blob.username, blob.password, { proxy: blob.proxy });
    return await attempt({ ...blob, state: fresh.state });
  }
}

/**
 * Poll the direct inbox and enqueue any new inbound messages through the same
 * durable pipeline as webhooks (`process:inbound`). Called on an interval by
 * the worker for each connected private-API Instagram account.
 */
export async function pollInstagramInbox(accountId: string): Promise<number> {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account || account.status === 'DISCONNECTED') return 0;
  const blob = parseSession(account.accessToken);
  if (!blob) return 0; // official OAuth account → webhooks handle inbound, not polling

  let ig: any;
  try {
    ig = await clientFromState(blob);
  } catch {
    return 0;
  }

  try {
    const threads = await ig.feed.directInbox().items();
    const items: InboundItem[] = [];
    for (const thread of threads || []) {
      const threadId = String(thread?.thread_id || '');
      if (!threadId) continue;
      let messages: any[] = [];
      try {
        messages = await ig.feed.directThread(threadId).items();
      } catch {
        continue;
      }
      for (const m of messages || []) {
        if (m?.user_id && String(m.user_id) === account.externalId) continue; // our own sends
        const body = String(m?.text ?? m?.item ?? '').trim();
        if (!body) continue;
        const senderId = String(m?.user_id || m?.client_context || 'unknown');
        items.push({
          platform: 'INSTAGRAM',
          matchBy: account.externalId,
          conversationKey: `ig:${account.externalId}:${senderId}`,
          senderId,
          senderName: String(m?.username || senderId),
          body,
          source: 'MESSAGE',
          externalId: m?.item_id ? String(m.item_id) : undefined,
          replyExternalId: m?.item_id ? String(m.item_id) : undefined,
        });
      }
    }
    const { enqueue } = await import('./queue');
    for (const item of items) await enqueue('process:inbound', item as unknown as Record<string, unknown>);
    return items.length;
  } catch (err) {
    await logEvent({
      level: 'error',
      message: `Instagram inbox poll failed: ${humanizeLoginError(err)}`,
      meta: { accountId },
    });
    return 0;
  }
}

export function instagramLoginErrorText(err: unknown): string {
  return humanizeLoginError(err);
}
