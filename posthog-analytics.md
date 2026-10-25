# Product analytics — PostHog

One product question, four events, offline checks. Nothing is deployed and the
offline checks send no data.

## Repo facts (read before editing)

| | |
|---|---|
| packageManager | `npm` 10.9.9 (root `package.json` has `workspaces: ["server", "web"]`) |
| Original lock | `/package-lock.json` (lockfileVersion 3) — the only lock in the repo |
| Other locks | none: no `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, no `web/package-lock.json` |
| Owning package | `@exotic-bot/web` (`web/package.json`) — Vite 5.4 + React 18 + TypeScript 5.9 |
| Server | `@exotic-bot/server` — Express + Prisma; no browser SDK, unchanged |
| Toolchain | Node v22.23.3, npm 10.9.9, TypeScript 5.9.3, Vite 5.4.21 |
| Quality commands | `npm run typecheck` (root → `tsc --noEmit` for `server` + `web`); `npm run build`; `node scripts/verify.mjs` (runtime checks against a live local API) |
| Lint | no lint script/ESLint config in the repo — nothing to run |
| Tests | no test runner or test files existed before this change |

Baseline before edits: `npm run typecheck` passed for both workspaces. No lint
or test command exists, so none could be baselined.

## Question

**Of the operators who open the setup wizard, how many connect a channel and
then approve a first reply within 7 days — and where do they drop off?**

## Events

Four client events, emitted only by the real handlers listed below:

| Event | Meaning |
|---|---|
| `setup_wizard_started` | the onboarding wizard mounted (funnel start / denominator) |
| `channel_connect_started` | the operator submitted an Instagram connect or a WhatsApp pairing request |
| `channel_connected` | the channel actually connected (OAuth round-trip returned, or pairing reached PAIRED) |
| `reply_approved` | the operator approved a drafted reply in the Inbox (funnel success) |

## Triggers (real files / functions)

| Event | File → handler |
|---|---|
| `setup_wizard_started` | `web/src/pages/Onboarding.tsx` → mount effect (`refresh` effect, once per mount) |
| `channel_connect_started` (instagram) | `web/src/components/InstagramConnect.tsx` → `submit()` after `POST /api/accounts/instagram/connect` returns the OAuth URL |
| `channel_connect_started` (whatsapp) | `web/src/components/WhatsAppPairing.tsx` → `start()` after `POST /api/accounts/whatsapp/pair` creates a live session |
| `channel_connected` (instagram) | `web/src/pages/Accounts.tsx` → OAuth round-trip effect reading `?connected=instagram`, then strips the param so a reload cannot double count |
| `channel_connected` (whatsapp) | `web/src/components/WhatsAppPairing.tsx` → `applySession()` when the pairing session reports `PAIRED` (once per session) |
| `reply_approved` | `web/src/pages/Inbox.tsx` → `approve()` after `POST /api/messages/:id/approve` succeeds |

## Allowed properties

Allowlist enforced twice — in `pickAllowed()` on the way out and again in
`before_send`:

| Event | Allowed properties |
|---|---|
| `setup_wizard_started` | *(none)* |
| `channel_connect_started` | `platform` (`instagram` \| `whatsapp`) |
| `channel_connected` | `platform` |
| `reply_approved` | `platform`, `edited` (boolean) |

No message bodies, handles, phone numbers, emails, tokens, URLs or referrers are
ever sent. `before_send` (`scrubEvent`) drops `$set`/`$set_once` and all
automatic `$current_url`, `$pathname`, `$host`, `$referrer`,
`$referring_domain`, `$initial_*`, `$session_entry_*`, `$prev_pageview_*`,
`$geoip_*`, `$session_id`, `$ip` … properties on every event, ours or the SDK's.

## Identity

`distinct_id` is the opaque operator UUID from `GET /api/auth/me`
(`web/src/lib/auth.tsx` → `analytics.identifyOperator(user.id)`, no person
properties). Email-shaped ids are refused. `analytics.reset()` runs on logout
and re-applies the stored consent, because with
`opt_out_capturing_by_default` the SDK's `reset()` reverts to opted out.
Anonymous events stay anonymous — no fallback identity.

## Consent

- Client is created with `opt_out_capturing_by_default: true`; no decision
  means off.
- The decision lives in `localStorage['exotic.analytics-consent']`
  (`granted` / `denied`) and is set by the **Settings → Data control →
  Anonymous product analytics** toggle
  (`web/src/pages/Settings.tsx`), which calls
  `analytics.setConsent()` → `opt_in_capturing()` / `opt_out_capturing()`.
- There was no CMP in this repo before; this toggle is the existing decision
  point now. No cookieless fallback.
- No replay, surveys, error collection or feature flags:
  `autocapture`, `capture_pageview`, `capture_pageleave`, `capture_dead_clicks`
  and `capture_performance` are `false`, `disable_session_recording` and
  `disable_surveys` are `true`, `advanced_disable_flags` is `true`.

## Configuration

| Name | Where | Value |
|---|---|---|
| `VITE_POSTHOG_PROJECT_TOKEN` | `web/.env` (git-ignored) — placeholder in `web/.env.example` | public project token |
| `VITE_POSTHOG_HOST` | same | `https://us.i.posthog.com`, `https://eu.i.posthog.com`, or a self-hosted ingestion domain |

Hosts are only read from configuration — never probed. Missing token/host, a
non-https host, denied consent and transport errors are all silent no-ops. No
token is hardcoded anywhere; `web/.env.example` ships empty placeholders.

## Integration evidence

- Importer: `@exotic-bot/web`; manifest `web/package.json` →
  `"posthog-js": "1.438.13"`.
- Install: `npm install posthog-js@1.438.13` run in `web/` with npm 10.9.9;
  the root lock `package-lock.json` was updated in place (no second lock).
- Lock evidence (`package-lock.json`, lockfileVersion 3):
  - `packages.web.dependencies["posthog-js"] === "1.438.13"`
  - `packages["node_modules/posthog-js"]` → `version 1.438.13`,
    `resolved https://registry.npmjs.org/posthog-js/-/posthog-js-1.438.13.tgz`,
    `integrity sha512-fcRhMZ/TKvpDjmDGTlf4KCBqqTnpLWLplZ76NfeLNEE1P6N6qCGGZzqZ6gEzJoOfYLNLgjd0sRM5fC8F/Ky9fA==`
  - resolved tree: `node_modules/posthog-js@1.438.13` (hoisted; `npm ls posthog-js` → `@exotic-bot/web └── posthog-js@1.438.13`)
- `npm ci` from the root lock restores it (verified).
- Offline checks: `node posthog-analytics.verify.mjs` — real handler tests in
  `web/tests/posthog-analytics.test.ts`, synthetic token, in-memory transport,
  network denied.

## Live analysis (to run in PostHog once a project is configured)

- **Funnel**: `setup_wizard_started` → `channel_connect_started` →
  `channel_connected` → `reply_approved`, steps in that order.
- **Denominator**: unique operators (`distinct_id`) starting at
  `setup_wizard_started` — that is the setup-wizard cohort, not all visitors.
- **Window**: 7 days from the start step (funnel conversion window = 7 days).
- **Success measure**: share of the cohort that reaches `reply_approved`
  (at least one approved reply within the window); `channel_connected` shows
  where setup stalls.
- **Breakdown**: `platform` on `channel_connect_started` / `channel_connected`
  (Instagram vs WhatsApp), and `edited` on `reply_approved`.
- Event order is fixed by `timestamp`; PostHog's funnel builder enforces it.
