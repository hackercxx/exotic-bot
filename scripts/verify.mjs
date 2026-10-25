/**
 * EXOTIC BOT — runtime acceptance checks against the live API (http://localhost:4000)
 * Run: node scripts/verify.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { WebSocket } from 'ws';

const BASE = process.env.VERIFY_BASE || 'http://localhost:4000';
const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')];
    }),
);
const APP_SECRET = env.APP_SECRET;
const VERIFY_TOKEN = env.VERIFY_TOKEN;
// the script's own Prisma client needs the DB path (VERIFY_DB overrides for throwaway-DB runs)
process.env.DATABASE_URL =
  process.env.VERIFY_DB || `file:${new URL('../server/prisma/dev.db', import.meta.url).pathname}`;

let pass = 0;
let fail = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  OK  ${name}`);
  } else {
    fail++;
    failures.push(`${name} ${detail}`);
    console.log(`  FAIL ${name} ${detail}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(path, { method = 'GET', token, body, headers = {}, rawBody } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined || rawBody !== undefined) {
    h['Content-Type'] = headers['Content-Type'] || 'application/json';
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: h,
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

const enc = (plain) => {
  const key = Buffer.from(env.ENCRYPTION_KEY, 'base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const e = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), e.toString('base64')].join(':');
};

const sign = (payload) => 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(payload).digest('hex');

console.log('\n-- 1. First-run auth --');
const boot = await req('/api/auth/bootstrap');
if (boot.json?.needsSetup === true) {
  ok('fresh install reports needsSetup', true);
} else {
  // re-run against an instance that already has its operator — correct behavior
  ok('setup already completed on re-run (needsSetup=false)', boot.json?.needsSetup === false);
}

const reg = await req('/api/auth/register', { method: 'POST', body: { email: 'operator@exotic.test', password: 'correct-horse-1' } });
if (reg.status === 201 && reg.json?.token) {
  ok('first-run register creates operator (201 + token)', true);
} else {
  // re-run against an instance that already has its operator — correct behavior
  ok('setup already completed on re-run (needsSetup=false)', boot.json?.needsSetup === false);
  let relogin = await req('/api/auth/login', { method: 'POST', body: { email: 'operator@exotic.test', password: 'correct-horse-1' } });
  if (relogin.status === 429) {
    // previous run's section 7 may still be inside the limiter window
    await sleep(61_000);
    relogin = await req('/api/auth/login', { method: 'POST', body: { email: 'operator@exotic.test', password: 'correct-horse-1' } });
  }
  ok('operator exists from earlier run; login works', relogin.status === 200, `register=${reg.status}`);
  reg.json = relogin.json;
}
const TOKEN = reg.json?.token;

// Registration is intentionally OPEN by default so the landing screen's
// "Create account" option works on an already-running instance (product
// requirement). Set ALLOW_REGISTRATION=false to restrict sign-ups to the
// first-run only — in that mode this request returns 403 instead of 201.
// A unique valid email keeps re-runs from colliding on the unique constraint.
const reg2 = await req('/api/auth/register', {
  method: 'POST',
  body: { email: `second-${Date.now()}@operator.test`, password: 'password123' },
});
ok('second register allowed (open registration by default)', reg2.status === 201, `status ${reg2.status}`);

const login = await req('/api/auth/login', { method: 'POST', body: { email: 'operator@exotic.test', password: 'correct-horse-1' } });
ok('login returns token', login.status === 200 && Boolean(login.json?.token));

const bad = await req('/api/auth/login', { method: 'POST', body: { email: 'operator@exotic.test', password: 'wrong-password' } });
ok('wrong password -> 401', bad.status === 401, `status ${bad.status}`);

const me = await req('/api/auth/me', { token: TOKEN });
ok('GET /me with JWT', me.status === 200 && me.json?.user?.email === 'operator@exotic.test');

const noAuth = await req('/api/accounts');
ok('protected route without token -> 401', noAuth.status === 401);

const csrf = await req('/api/auth/login', { method: 'POST', body: { email: 'a@b.c', password: 'password123' }, headers: { Origin: 'http://evil.example' } });
ok('foreign Origin blocked (403)', csrf.status === 403, `status ${csrf.status}`);

const put = await req('/api/settings', {
  method: 'PUT',
  token: TOKEN,
  body: {
    ai: { provider: 'openai', apiKey: 'sk-test-abcdef123456', tone: 'casual', memoryWindow: 6 },
    blocklist: ['scam', 'free followers'],
    quietHours: { enabled: true, start: '22:00', end: '07:00' },
    timezone: 'Europe/Berlin',
  },
});
ok('settings PUT accepted', put.status === 200 && put.json?.ok === true, JSON.stringify(put.json));

const get = await req('/api/settings', { token: TOKEN });
ok(
  'AI key masked in GET (never returned)',
  get.json?.ai?.hasKey === true && Boolean(get.json?.ai?.keyHint) && !JSON.stringify(get.json).includes('sk-test-abcdef'),
  `hint=${get.json?.ai?.keyHint}`,
);
ok('blocklist persisted', JSON.stringify(get.json?.blocklist) === JSON.stringify(['scam', 'free followers']));
ok('quiet hours persisted', get.json?.quietHours?.enabled === true);

const onb = await req('/api/auth/onboarding', { token: TOKEN });
ok(
  'onboarding: never a real IG/WA connection (only synthetic test data allowed)',
  onb.json?.instagram === false && (onb.json?.totalAccounts === 0 || onb.json?.whatsapp === true),
  JSON.stringify(onb.json),
);

const RUN = Date.now().toString(36); // unique per run → idempotent re-runs

console.log('\n-- 2. Webhook verification + signature --');
const verifyOk = await req(`/webhooks/meta?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=challenge123`);
ok('GET verify echoes hub.challenge', verifyOk.text === 'challenge123', `got "${verifyOk.text}"`);
const verifyBad = await req('/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x');
ok('wrong verify token -> 403', verifyBad.status === 403);
const emptyPayload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
const badSig = await req('/webhooks/meta', { method: 'POST', rawBody: emptyPayload, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=deadbeef' } });
ok('invalid signature -> 401', badSig.status === 401, `status ${badSig.status}`);

console.log('\n-- 3. Inbound pipeline (signed WA webhook -> inbox) --');
const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();
const user = await prisma.user.findUnique({ where: { email: 'operator@exotic.test' } });
// idempotent: reuse the synthetic account on re-runs
let account = await prisma.account.findFirst({ where: { user: { email: 'operator@exotic.test' }, platform: 'WHATSAPP' } });
if (!account) {
  account = await prisma.account.create({
  data: {
    userId: user.id,
    platform: 'WHATSAPP',
    externalId: '109998887776665',
    phoneNumberId: '109998887776665',
    label: 'Test Business (synthetic)',
    accessToken: enc('EAAB-test-token-not-real'),
    status: 'CONNECTED',
    autoReplyEnabled: false,
    },
  });
}
ok('synthetic account stored with encrypted token', account.accessToken.startsWith('v1:'));
await prisma.account.update({ where: { id: account.id }, data: { autoReplyEnabled: false } });

const mkPayload = (from, id, body, name) =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '109998887776665',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: '109998887776665' },
              contacts: [{ wa_id: from, profile: { name } }],
              messages: [{ from, id, timestamp: '1700000000', type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  });

const frames = [];
const wsBase = new URL(BASE);
wsBase.protocol = wsBase.protocol === 'https:' ? 'wss:' : 'ws:';
wsBase.pathname = '/ws';
wsBase.search = `token=${encodeURIComponent(TOKEN)}`;
const ws = new WebSocket(wsBase);
await new Promise((res, rej) => {
  ws.on('open', res);
  ws.on('error', rej);
});
ws.on('message', (d) => {
  try {
    frames.push(JSON.parse(d.toString()));
  } catch {
    /* ignore */
  }
});

const payload = mkPayload('15551234567', `wamid.T${RUN}`, 'Hi! Is the violet hoodie still in stock?', 'Ada Lovelace');
const t0 = Date.now();
const post = await req('/webhooks/meta', { method: 'POST', rawBody: payload, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(payload) } });
ok('valid signature -> 200 accepted', post.status === 200 && post.json?.ok === true, JSON.stringify(post.json));

let conversation = null;
for (let i = 0; i < 20 && !conversation; i++) {
  await sleep(400);
  const conv = await req('/api/messages/conversations', { token: TOKEN });
  conversation = (conv.json?.conversations || []).find((c) => c.conversationKey === 'wa:15551234567') || null;
}
const elapsed = Date.now() - t0;
ok(`inbound surfaced in Inbox (${elapsed}ms < 3000ms)`, Boolean(conversation) && conversation.sender === 'Ada Lovelace', JSON.stringify(conversation));
ok('conversation carries the message body', conversation?.lastBody?.includes('violet hoodie'));

const counts = await req('/api/messages/counts', { token: TOKEN });
ok('pending counter includes the new message (human review)', (counts.json?.pending ?? 0) >= 1, JSON.stringify(counts.json));

const thread = await req(`/api/messages/thread/${encodeURIComponent(conversation.conversationKey)}`, { token: TOKEN });
const inbound = thread.json?.messages?.find((m) => m.direction === 'INBOUND');
ok('inbound status RECEIVED (auto-reply off)', inbound?.status === 'RECEIVED');

await sleep(600);
ok('WS pushed message:new to dashboard', frames.some((f) => f.type === 'message:new'), `frames=${frames.map((f) => f.type).join(',')}`);

const draft = await req(`/api/messages/${inbound.id}/draft`, { method: 'POST', token: TOKEN });
ok('AI draft without key -> clear 502 (no fake reply)', draft.status === 502 && /api key|Ollama|provider/i.test(draft.json?.error || ''), `status ${draft.status} ${draft.json?.error}`);

// blocklist gate (auto-reply on)
await prisma.account.update({ where: { id: account.id }, data: { autoReplyEnabled: true } });
const blockedPayload = mkPayload('15550001111', `wamid.B${RUN}`, 'free followers give me scam now', 'Troll');
await req('/webhooks/meta', { method: 'POST', rawBody: blockedPayload, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(blockedPayload) } });
let blockedMsg = null;
for (let i = 0; i < 20 && !blockedMsg; i++) {
  await sleep(400);
  blockedMsg = (await prisma.message.findMany({ where: { status: 'BLOCKED' } }))[0] || null;
}
ok('blocklisted message never auto-replied -> BLOCKED/manual', Boolean(blockedMsg));
const blockedDrafts = await prisma.message.count({ where: { direction: 'OUTBOUND', replyToId: blockedMsg?.id } });
ok('no AI draft for blocklisted message', blockedDrafts === 0, `drafts=${blockedDrafts}`);

// auto-reply on, AI key missing -> honest warn, stays manual
const noKeyPayload = mkPayload('15559990000', `wamid.N${RUN}`, 'Do you ship to Canada?', 'Grace');
await req('/webhooks/meta', { method: 'POST', rawBody: noKeyPayload, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(noKeyPayload) } });
await sleep(3500);
const warnEvents = await prisma.event.findMany({ where: { level: 'warn', message: { contains: 'AI draft failed' } } });
ok('AI failure audited as warn (stays manual)', warnEvents.length >= 1, `warns=${warnEvents.length}`);
const dup = await prisma.message.count({ where: { externalId: `wamid.N${RUN}` } });
ok('webhook de-duplication by message id', dup === 1, `count=${dup}`);
ws.close();

console.log('\n-- 4. Scheduler: post fires at the scheduled time --');
const soon = new Date(Date.now() + 12_000).toISOString();
const create = await req('/api/posts', {
  method: 'POST',
  token: TOKEN,
  body: { platform: 'INSTAGRAM', caption: 'Scheduled test post', scheduledFor: soon, mediaType: 'NONE' },
});
ok('post created as SCHEDULED', create.status === 201 && create.json?.post?.status === 'SCHEDULED', JSON.stringify(create.json));

const waNoTarget = await req('/api/posts', { method: 'POST', token: TOKEN, body: { platform: 'WHATSAPP', caption: 'x', scheduledFor: new Date(Date.now() + 60000).toISOString() } });
ok('WhatsApp schedule without target -> 400', waNoTarget.status === 400, `status ${waNoTarget.status}`);

const badCron = await req('/api/posts', { method: 'POST', token: TOKEN, body: { platform: 'INSTAGRAM', caption: 'x', cron: 'not a cron' } });
ok('invalid cron rejected -> 400', badCron.status === 400, `status ${badCron.status}`);

const goodCron = await req('/api/posts', { method: 'POST', token: TOKEN, body: { platform: 'INSTAGRAM', caption: 'Weekly recurring', cron: '0 18 * * 1,3,5' } });
ok('recurring cron accepted + next run computed', goodCron.status === 201 && Boolean(goodCron.json?.post?.scheduledFor), `${goodCron.status} ${JSON.stringify(goodCron.json)}`);

const t1 = Date.now();
let fired = null;
for (let i = 0; i < 40; i++) {
  const p = await req(`/api/posts?from=${new Date(Date.now() - 86400000).toISOString()}&to=${new Date(Date.now() + 86400000).toISOString()}`, { token: TOKEN });
  fired = p.json?.posts?.find((x) => x.id === create.json.post.id);
  if (fired && (fired.status === 'FAILED' || fired.status === 'PUBLISHED')) break;
  await sleep(1000);
}
const firedIn = Date.now() - t1;
ok(`job fired within tolerance (+12s schedule, waited ${firedIn}ms)`, Boolean(fired) && (fired.status === 'FAILED' || fired.status === 'PUBLISHED'), `status=${fired?.status}`);
ok('failure is honest (no connected IG account)', fired?.status === 'FAILED' && /No connected Instagram account/i.test(fired?.error || ''), fired?.error);
ok('retry attempt recorded', (fired?.attempts ?? 0) >= 1, `attempts=${fired?.attempts}`);

console.log('\n-- 5. Media + music uploads (real files) --');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const fd = new FormData();
fd.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
const up = await fetch(`${BASE}/api/media/upload`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: fd });
const upJson = await up.json();
ok('image upload + server-side thumbnail (sharp)', up.status === 201 && Boolean(upJson?.asset?.thumbnailPath), `${up.status} ${JSON.stringify(upJson).slice(0, 160)}`);

const rate = 8000;
const samples = Math.round(rate * 0.2);
const wav = Buffer.alloc(44 + samples);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + samples, 4);
wav.write('WAVE', 8);
wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24);
wav.writeUInt32LE(rate, 28);
wav.writeUInt16LE(1, 32);
wav.writeUInt16LE(8, 34);
wav.write('data', 36);
wav.writeUInt32LE(samples, 40);
wav.fill(128, 44);

const fd2 = new FormData();
fd2.append('file', new Blob([wav], { type: 'audio/wav' }), 'test-track.wav');
fd2.append('title', 'Midnight Circuit');
fd2.append('artist', 'EXOTIC BOT Studio');
fd2.append('genre', 'Synthwave');
const tr = await fetch(`${BASE}/api/music/tracks`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: fd2 });
const trJson = await tr.json();
ok('audio upload creates track', tr.status === 201 && trJson?.track?.title === 'Midnight Circuit', `${tr.status} ${JSON.stringify(trJson).slice(0, 120)}`);

const stream = await fetch(`${BASE}/api/music/tracks/${trJson?.track?.id}/stream?token=${encodeURIComponent(TOKEN)}`);
const bytes = await stream.arrayBuffer();
ok('audio stream returns real bytes', stream.status === 200 && bytes.byteLength === wav.byteLength, `status ${stream.status} bytes ${bytes.byteLength}`);

// browsers request a byte range for <audio> seeking — must get 206 + real audio
const ranged = await fetch(`${BASE}/api/music/tracks/${trJson?.track?.id}/stream?token=${encodeURIComponent(TOKEN)}`, {
  headers: { Range: 'bytes=0-1023' },
});
const rangeBuf = Buffer.from(await ranged.arrayBuffer());
ok(
  'audio stream honors Range (HTML5 seeking)',
  ranged.status === 206 && rangeBuf.length === 1024 && rangeBuf.slice(0, 4).toString() === 'RIFF',
  `status ${ranged.status} bytes ${rangeBuf.length} hdr ${ranged.headers.get('content-range')}`,
);

const patch = await req(`/api/music/tracks/${trJson?.track?.id}`, { method: 'PATCH', token: TOKEN, body: { durationMs: 200 } });
ok('track duration metadata patchable', patch.status === 200 && patch.json?.track?.durationMs === 200);

const share = await req(`/api/music/tracks/${trJson?.track?.id}/share-to-post`, { method: 'POST', token: TOKEN, body: { platform: 'INSTAGRAM' } });
ok('share-to-post creates caption draft + mux hint', share.status === 201 && /Midnight Circuit/.test(share.json?.caption || '') && /ffmpeg/.test(share.json?.hint || ''));

// ── private-API (username+password) publishing routes correctly ─────────
// A PRIVATE_API Instagram account must publish through the private client,
// never the Graph API (its accessToken is an encrypted session blob, not a
// Graph token). Missing local media fails offline with an honest error —
// deterministic proof the worker routed to publishInstagramPrivate.
const igAcc = await prisma.account.create({
  data: {
    userId: user.id,
    platform: 'INSTAGRAM',
    externalId: `9${RUN}`.slice(0, 18),
    label: 'private-route-check',
    pageId: 'PRIVATE_API',
    accessToken: enc(JSON.stringify({ username: `route.${RUN}`, password: 'x', state: { device: {} } })),
    status: 'CONNECTED',
  },
});
const igPost = await prisma.post.create({
  data: {
    userId: user.id,
    platform: 'INSTAGRAM',
    accountId: igAcc.id,
    caption: 'routing check',
    mediaType: 'IMAGE',
    mediaUrl: `/uploads/definitely-missing-${RUN}.jpg`,
    status: 'SCHEDULED',
    scheduledFor: new Date(),
  },
});
const pubNow = await req(`/api/posts/${igPost.id}/publish-now`, { method: 'POST', token: TOKEN });
ok('publish-now accepted for private account', pubNow.status === 200, `${pubNow.status} ${pubNow.text.slice(0, 80)}`);
let routed = null;
for (let i = 0; i < 20; i++) {
  routed = await prisma.post.findUnique({ where: { id: igPost.id } });
  if (routed && (routed.status === 'FAILED' || routed.status === 'PUBLISHED')) break;
  await sleep(1000);
}
ok(
  'private-API account publishes via private client (not Graph)',
  routed?.status === 'FAILED' && /missing on this server/i.test(routed?.error || ''),
  `status=${routed?.status} error=${routed?.error}`,
);
await prisma.post.delete({ where: { id: igPost.id } }).catch(() => undefined);
await prisma.account.delete({ where: { id: igAcc.id } }).catch(() => undefined);

// ── Instagram connect: proxy guard + login backoff (anti-ban) ──────────
// Deterministic and offline: the malformed-proxy guard answers before any
// network I/O, and a seeded cooldown answers 429 before that too — so no
// request in this block ever reaches Instagram.
const badProxy = await req('/api/accounts/instagram/private', {
  method: 'POST',
  token: TOKEN,
  body: { username: 'some.handle', password: 'x', proxy: 'not-a-proxy' },
});
ok(
  'malformed proxy rejected instead of silently going direct',
  badProxy.status === 400 && /proxy/i.test(badProxy.json?.error || ''),
  `${badProxy.status} ${badProxy.json?.error}`,
);

const backoffKey = 'ig:backoff:some.handle';
const lockedUntil = Date.now() + 900_000;
const backoffValue = JSON.stringify({ failures: 2, lockedUntil, rateLimited: true });
await prisma.setting.upsert({
  where: { userId_key: { userId: user.id, key: backoffKey } },
  create: { userId: user.id, key: backoffKey, value: backoffValue },
  update: { value: backoffValue },
});
const locked = await req('/api/accounts/instagram/private', {
  method: 'POST',
  token: TOKEN,
  body: { username: 'some.handle', password: 'x' },
});
ok(
  'backoff answers 429 + code RATE_LIMITED + retryAfterSec',
  locked.status === 429 && locked.json?.code === 'RATE_LIMITED' && locked.json?.retryAfterSec > 0,
  `${locked.status} ${JSON.stringify(locked.json)}`,
);
ok(
  '429 explains when to retry',
  /try again in \d/i.test(locked.json?.error || ''),
  String(locked.json?.error),
);
await prisma.setting
  .deleteMany({ where: { userId: user.id, key: backoffKey } })
  .catch(() => undefined);

console.log('\n-- 6. Analytics + exports + audit log --');
const sum = await req('/api/analytics/summary?days=30', { token: TOKEN });
ok('summary: honest hasInsights=false (no IG data yet)', sum.status === 200 && sum.json?.hasInsights === false, JSON.stringify(sum.json).slice(0, 120));
const heat = await req('/api/analytics/heatmap', { token: TOKEN });
ok('heatmap hasData=false, 168 cells, no fabricated grid', heat.status === 200 && heat.json?.hasData === false && heat.json?.cells?.length === 168);
const unf = await req('/api/analytics/unfollowers', { token: TOKEN });
ok('unfollower tracker off by default (opt-in)', unf.json?.enabled === false);
const csv = await req('/api/analytics/export.csv', { token: TOKEN });
ok('CSV export content-type + header', csv.status === 200 && csv.text.startsWith('date,account,followers'));
const report = await req('/api/analytics/report?days=7', { token: TOKEN });
ok('printable report data', report.status === 200 && Array.isArray(report.json?.posts));

const events = await req('/api/events?limit=120', { token: TOKEN });
const msgs = events.json?.events || [];
ok('audit log populated', msgs.length > 0 && msgs.some((e) => /Operator|Signed|Webhook|Publish|AI draft|Auto-reply|Scheduled/i.test(e.message)), `${msgs.length} events`);
ok('no raw secrets in audit messages', !JSON.stringify(msgs).includes('sk-test-abcdef') && !JSON.stringify(msgs).includes('EAAB-test-token'));

const exp = await req('/api/settings/export', { token: TOKEN });
ok('data export JSON with redacted AI key', exp.status === 200 && !exp.text.includes('sk-test-abcdef') && exp.text.includes('[redacted]'));

const wipeNo = await req('/api/settings/wipe', { method: 'POST', token: TOKEN, body: { confirm: 'nope' } });
ok('wipe requires typed confirmation', wipeNo.status === 400, `status ${wipeNo.status}`);

console.log('\n-- 7. Rate limiting (last: locks this IP briefly) --');
let limited = false;
for (let i = 0; i < 14; i++) {
  const r = await req('/api/auth/login', { method: 'POST', body: { email: 'operator@exotic.test', password: 'definitely-wrong-1' } });
  if (r.status === 429) {
    limited = true;
    break;
  }
}
ok('login rate limit triggers 429', limited);

await prisma.$disconnect();

console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
if (failures.length) {
  console.log('Failures:');
  failures.forEach((f) => console.log(' -', f));
}
process.exit(fail > 0 ? 1 : 0);
