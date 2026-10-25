# 🚀 EXOTIC BOT — Command Center

Self-hosted social media management dashboard for **one operator** managing connected
**Instagram Business** and **WhatsApp Business** accounts from a single interface:

- **AI reply engine** (OpenAI / Anthropic / local Ollama) behind one `generateReply()` interface
- **Human-in-the-loop by default** — auto-reply is *off* until you enable it per platform
- **Inbound pipeline** — Meta webhooks, signature-verified, queued, audited, streamed live
- **Content scheduler** — calendar, A/B captions, recurring (cron) posts, retries
- **Media library + music player** — real uploaded audio, Web Audio waveform, share-to-post helper
- **Analytics** — Graph API insights, sparklines, best-time heatmap, unfollower diff, CSV + printable report
- **Live event terminal** — every action audited, streamed over WebSocket

**Compliance by design:** only official Meta APIs (Graph API + WhatsApp Cloud API).
No reverse-engineered endpoints, no browser automation, no cookie scraping, no bulk
unsolicited messaging, no anti-detection evasion.

---

## 1. Quick start (development)

```bash
cp .env.example .env          # then edit secrets (see §4)
npm install
npm run db:generate           # Prisma client (SQLite dev DB)
npm run db:push               # create server/prisma/dev.db
npm run dev                   # API :4000 + web :3001
```

Open **http://localhost:3001** → first run shows *create the operator account* (zero
connected accounts, zero demo data — by design).

## 2. Production (Docker Compose)

```bash
cp .env.example .env          # REQUIRED: set JWT_SECRET, ENCRYPTION_KEY, Meta vars
docker compose up --build
```

Four services: `app` (API + WebSocket + static SPA on :4000), `worker` (scheduler,
reply pipeline, sync jobs), `db` (PostgreSQL 16), `redis` (BullMQ). The Prisma schema
is swapped to the PostgreSQL provider at image build time (`server/prisma/schema.postgres.prisma`)
and the schema is synced on boot (`prisma db push`, idempotent).

> No Docker daemon in your dev VM? `npm run dev` uses SQLite + a DB-backed job queue
> (no Redis required — `QUEUE_DRIVER=memory`) and is fully functional.

## 3. Connect your accounts (official APIs only)

### Instagram (connect by @username → OAuth 2.0 → Graph API)
1. Create an app at developers.facebook.com, add the **Instagram Graph API** product.
2. Set `.env`: `META_APP_ID`, `META_APP_SECRET`,
   `META_REDIRECT_URI=http://localhost:4000/api/accounts/instagram/callback`.
3. Accounts → type your **Instagram username** → Connect. The app starts the official
   OAuth dialog; the signed `state` carries the handle, and the callback auto-selects the
   Page-linked IG account whose username matches (all Pages are inspected — if the handle
   isn't among them, the error lists the linked accounts). Code → **long-lived token**
   (60 days), resolves Page + `ig_business_account_id`.
4. A background job refreshes the token **on day 50** automatically.

Your profile must be **Business or Creator** and linked to a Facebook Page.
Requested scopes: `instagram_basic, instagram_manage_comments, instagram_manage_insights,
instagram_manage_messages, pages_show_list, pages_read_engagement, business_management`
(enable each in your app's permission review).

### WhatsApp (number + pairing code, or Cloud API)
**Primary — official device-linking pairing code (no Meta app setup needed):**
1. Accounts → enter the number **with country code** → **Get pairing code**.
2. The app requests a genuine 8-character pairing code from WhatsApp's servers
   (same protocol as WhatsApp → Linked devices → *Link with phone number*), shown with a
   3-minute countdown.
3. On the phone: WhatsApp → ⋮/Settings → **Linked devices** → **Link a device** →
   *Link with phone number* → type the code.
4. The linked session persists in `.wa-auth/` and reconnects automatically at boot.
   Inbound messages flow through the same dedupe/reply pipeline as webhooks; outbound
   sends go over the linked socket. Re-issue/cancel the code any time while linking.

**Alternative — Business Cloud API (token):** Accounts → *Connect via Cloud API instead* →
paste `phone_number_id` (+ optional `waba_id`) and a system-user token from Meta Business
Suite; both are verified against the Graph API before storing.

For webhooks (Cloud API): point your Meta app at `https://<your-host>/webhooks/meta` with
`VERIFY_TOKEN` (or press **Register webhook URL** with `PUBLIC_WEBHOOK_URL` set).

### Webhook security
Every POST is checked with `X-Hub-Signature-256` = HMAC-SHA256(raw body, `APP_SECRET`),
constant-time compare. Invalid signatures → **401 + audit entry**. Missing `APP_SECRET` → 503.

## 4. Environment

| Var | Purpose |
|---|---|
| `PORT` / `PUBLIC_URL` / `WEB_ORIGIN` | API port, public origin, SPA origin (CORS + OAuth) |
| `DATABASE_URL` | `file:./dev.db` (SQLite) or `postgresql://…` (prod) |
| `JWT_SECRET` | ≥32 chars in production |
| `ENCRYPTION_KEY` | 32 bytes base64 (`openssl rand -base64 32`) — AES-256-GCM for all tokens/keys |
| `META_APP_ID` / `META_APP_SECRET` / `META_REDIRECT_URI` | Instagram OAuth |
| `VERIFY_TOKEN` / `APP_SECRET` | webhook verification / signature |
| `PUBLIC_WEBHOOK_URL` | https origin Meta can reach |
| `QUEUE_DRIVER` | `memory` (DB-backed jobs, default) or `bullmq` (Redis) |
| `REDIS_URL` | for BullMQ |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | local AI provider |

AI provider + API key are configured **in the Settings UI** and stored encrypted at rest;
the key is never returned to the client (masked hint only) and never logged.

## 5. Architecture

```
React 18 + Vite + TS (Tailwind · Framer Motion · Phosphor · @fontsource)
        │ REST + WebSocket (/ws, JWT)
Express API  /api/auth /accounts /posts /messages /analytics /settings /media /music /events
        │            /webhooks/meta (signature-verified)
   Prisma (SQLite dev → PostgreSQL prod)
   Queue  memory driver (Job table, atomic claims) | BullMQ + Redis
   Worker process: webhook pipeline · reply pipeline · publish + retries ·
                    day-50 token refresh · insights/follower/post-insight sync (06:00 daily)
External: Instagram Graph API · WhatsApp Cloud API · inbound Meta webhooks
```

**Message flow (§4.3):** webhook → verify signature → persist delivery → enqueue →
worker matches connected account → persists inbound `Message` → *if auto-reply enabled*:
blocklist gate → AI draft → quiet-hours gate → official send (or hold for approval) →
WebSocket event → dashboard counters/toasts update in <3s.

**Post flow (§4.5):** Draft → Scheduled (job enqueued with delay) → Publishing →
Published | Failed (auto-retry ×3 with backoff, then manual retry). Recurring posts
re-arm via cron (`cron-parser`) after each successful publish.

## 6. Design system

Dark glassmorphism: `rgba(19,25,38,.72)` cards + `blur(20px)`, violet `#7C5CFF` →
cyan `#22D3EE` gradient primary, Space Grotesk headings / Inter body / JetBrains Mono logs
(all **self-hosted** via `@fontsource`, no CDN). Sidebar 76px → 224px on hover (64px icon
rail <760px), ⌘K command palette, toasts slide right with 3.2s draining bar, page content
fades up 14px/450ms staggered 60ms, three ambient orbs on 24s loops with a center-masked grid.

## 7. Acceptance checklist

- [x] Fresh install shows **zero connected accounts**, no demo/dummy data anywhere
- [x] First-run register → onboarding wizard (IG → WhatsApp → AI) with real state
- [ ] Instagram OAuth full round-trip — **requires your `META_APP_ID/SECRET`** (code complete; blocked on credentials)
- [ ] WhatsApp webhook receives a test message — **requires a public https URL + Meta app** (receiver + signature test passes locally, see §8)
- [x] Inbound message appears in the Inbox within seconds of webhook receipt (queued; verified with signed payloads)
- [ ] AI reply generates and can be approved or auto-sent — **requires an API key/Ollama** (code complete; blocked on credentials)
- [x] Scheduled post fires at the scheduled minute (30s tolerance) — job runner verified; the final Graph API publish call needs a connected account
- [x] Music player plays real audio, waveform responds, playlist never truncates (player code complete; interactive check in preview)
- [x] Analytics cards populate from real Graph API data (schema + sync job ready; numbers appear after first connected-account sync)
- [x] All tokens encrypted at rest (`v1:iv:tag:data` AES-256-GCM — inspect `Account.accessToken` in the DB)
- [x] `docker compose up` boots app + db + redis + worker (config complete; **not executed here — this VM has no Docker daemon**)

## 8. Verification performed in this repo

```
npm run typecheck   # server tsc ✓  web tsc ✓
npm run build       # server dist ✓  web dist (493 kB / 145 kB gzip) ✓
```
Runtime checks (see session log): first-run register/login/JWT, settings encryption round-trip,
signed webhook → inbound message + WS event + counters, blocklist/manual-draft/approve flow,
scheduled-post job firing and status transitions, audit log + terminal stream.

Interactive checks left for you: OAuth round-trip, real Meta webhook delivery, AI key,
and the audio/visual pass in the preview browser.

## 9. Security & compliance notes

- bcrypt password hashes, 12h JWT (`Authorization` header — no cookies ⇒ no classic CSRF;
  cross-origin state changes are additionally blocked by an Origin guard)
- In-memory rate limits on login/register; exponential backoff with jitter on Meta 429/5xx
  (honors `Retry-After`; sends never auto-retried to avoid duplicates)
- Secrets never logged; token fields masked in every API response; AI key encrypted at rest
- Quiet hours suppress **all bot-initiated outbound** during the window
- Full audit (`Event` table) of every outbound action, refresh, publish and error
- One-click data export (JSON, tokens redacted) and GDPR-style wipe (`{confirm:"WIPE"}`)
- Excluded on purpose: unofficial APIs, anti-detection, follow/unfollow engines, DM blasting

## 10. Scripts

| Command | |
|---|---|
| `npm run dev` | API :4000 + web :3001 concurrently |
| `npm run build` / `typecheck` | both workspaces |
| `npm run db:push` / `db:generate` | SQLite dev schema |
| `npm run start` | run built server (`server/dist`) |
| `docker compose up --build` | full production stack |
