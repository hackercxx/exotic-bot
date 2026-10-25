/**
 * Product analytics — PostHog browser capture for one operator journey:
 * setup wizard → channel connected → first approved reply.
 * See posthog-analytics.md for the question, event contract and the analysis.
 *
 * Privacy rules baked in here:
 *  - capture is OFF until the operator grants consent in Settings
 *    (`opt_out_capturing_by_default`), and no decision means off;
 *  - only allowlisted app properties leave the browser, and `before_send`
 *    strips automatic URL/referrer/person metadata wholesale;
 *  - identity is the opaque operator UUID from the API, never the email;
 *  - missing token/host, denied consent and transport errors are all silent
 *    no-ops, so an analytics outage can never break an operator action.
 */
import type { Platform } from './types';

export type ChannelPlatform = 'instagram' | 'whatsapp';

/** The event contract — 4 events for "does setup reach a first approved reply?". */
export const ANALYTICS_EVENTS = {
  setupWizardStarted: 'setup_wizard_started',
  channelConnectStarted: 'channel_connect_started',
  channelConnected: 'channel_connected',
  replyApproved: 'reply_approved',
} as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

/** Only these properties are ever sent, per event. Nothing else is allowlisted. */
const ALLOWED_PROPERTIES: Record<AnalyticsEvent, readonly string[]> = {
  [ANALYTICS_EVENTS.setupWizardStarted]: [],
  [ANALYTICS_EVENTS.channelConnectStarted]: ['platform'],
  [ANALYTICS_EVENTS.channelConnected]: ['platform'],
  [ANALYTICS_EVENTS.replyApproved]: ['platform', 'edited'],
};

/** Consent decision lives next to the JWT in localStorage; absent = off. */
const CONSENT_KEY = 'exotic.analytics-consent';

type PropertyBag = Record<string, unknown>;

/** The slice of a PostHog capture payload we touch when scrubbing. */
export interface CaptureEvent {
  event: string;
  properties?: PropertyBag;
  $set?: PropertyBag;
  $set_once?: PropertyBag;
  [key: string]: unknown;
}

export interface PosthogClient {
  capture(event: string, properties?: PropertyBag): void;
  identify(distinctId: string, userProperties?: PropertyBag): void;
  reset(): void;
  opt_in_capturing(): void;
  opt_out_capturing(): void;
}

export interface PosthogSdk {
  init(token: string, options: Record<string, unknown>): PosthogClient;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AnalyticsDeps {
  /** Config source (import.meta.env in Vite, process.env in offline checks). */
  env?: Record<string, string | undefined>;
  /** SDK loader — dynamic import in the browser, in-memory in checks. */
  load?: () => Promise<PosthogSdk | null>;
  storage?: StorageLike | null;
}

export interface PosthogConfig {
  token: string;
  host: string;
}

/**
 * Public project token + ingestion host, both from configuration. The token is
 * a public project token (never a personal/secret key) and the host is only
 * ever used as given — no region probing, no live inspection. Missing or
 * non-https config keeps capture off entirely.
 */
export function readPosthogConfig(env: Record<string, string | undefined>): PosthogConfig | null {
  const token = (env.VITE_POSTHOG_PROJECT_TOKEN ?? '').trim();
  const rawHost = (env.VITE_POSTHOG_HOST ?? '').trim().replace(/\/+$/, '');
  if (!token || !rawHost) return null;
  try {
    const url = new URL(rawHost);
    if (url.protocol !== 'https:') return null;
    return { token, host: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
  } catch {
    return null;
  }
}

/** Automatic properties we never forward (URL, referrer, person, device metadata). */
const SENSITIVE_KEYS = new Set([
  '$current_url',
  '$pathname',
  '$host',
  '$referrer',
  '$referring_domain',
  '$title',
  '$search_engine',
  '$gclid',
  '$fbclid',
  '$ip',
  '$device_id',
  '$session_id',
  '$window_id',
]);

const SENSITIVE_PREFIXES = ['$set', '$initial_', '$session_entry_', '$prev_pageview_', '$geoip_'];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key) || SENSITIVE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * `before_send` hook: drops person metadata and every automatic URL/referrer
 * property, then restricts our own events to their allowlisted properties.
 */
export function scrubEvent(event: CaptureEvent | null): CaptureEvent | null {
  if (!event || typeof event.event !== 'string') return null;
  const properties: PropertyBag = {};
  for (const [key, value] of Object.entries(event.properties ?? {})) {
    if (isSensitiveKey(key)) continue;
    properties[key] = value;
  }
  const allowed = ALLOWED_PROPERTIES[event.event as AnalyticsEvent];
  if (allowed) {
    for (const key of Object.keys(properties)) {
      if (!allowed.includes(key)) delete properties[key];
    }
  }
  const scrubbed: CaptureEvent = { ...event, properties };
  delete scrubbed.$set;
  delete scrubbed.$set_once;
  return scrubbed;
}

/** Client options: no autocapture, no pageviews, no replay, no surveys, no flags. */
export function buildPosthogOptions(host: string): Record<string, unknown> {
  return {
    api_host: host,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    capture_performance: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_external_dependency_loading: true,
    advanced_disable_flags: true,
    person_profiles: 'identified_only',
    persistence: 'localStorage',
    opt_out_capturing_by_default: true,
    before_send: scrubEvent,
  };
}

function defaultEnv(): Record<string, string | undefined> {
  const metaEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  if (metaEnv) return metaEnv;
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env ?? {};
}

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage blocked → no consent decision → capture stays off
  }
}

async function loadPosthogSdk(): Promise<PosthogSdk | null> {
  const mod = (await import('posthog-js')) as unknown as {
    default?: { posthog?: PosthogSdk; default?: PosthogSdk } & PosthogSdk;
    posthog?: PosthogSdk;
  };
  const sdk = mod.default?.posthog ?? mod.posthog ?? mod.default?.default ?? mod.default;
  return sdk && typeof sdk.init === 'function' ? sdk : null;
}

function pickAllowed(event: AnalyticsEvent, props: PropertyBag): PropertyBag {
  const allowed = ALLOWED_PROPERTIES[event];
  const safe: PropertyBag = {};
  for (const key of allowed) {
    const value = props[key];
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') safe[key] = value;
  }
  return safe;
}

const asChannelPlatform = (platform: Platform | string): ChannelPlatform =>
  platform === 'WHATSAPP' || platform === 'whatsapp' ? 'whatsapp' : 'instagram';

/**
 * One analytics instance for the whole app — reuse this client, don't create a
 * second PostHog singleton. Components call the typed helpers below it.
 */
export function createAnalytics(deps: AnalyticsDeps = {}) {
  const env = deps.env ?? defaultEnv();
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const load = deps.load ?? loadPosthogSdk;
  const config = readPosthogConfig(env);

  let client: PosthogClient | null = null;
  let operatorId: string | null = null;
  let initializing = false;

  const consentGranted = (): boolean => {
    try {
      return storage?.getItem(CONSENT_KEY) === 'granted';
    } catch {
      return false;
    }
  };

  const capture = (event: AnalyticsEvent, props: PropertyBag = {}): void => {
    try {
      if (!client || !consentGranted()) return;
      client.capture(event, pickAllowed(event, props));
    } catch {
      /* analytics must never break an operator action */
    }
  };

  const identify = (): void => {
    try {
      if (!client || !operatorId || !consentGranted()) return;
      client.identify(operatorId);
    } catch {
      /* ignore */
    }
  };

  return {
    /** Initialise once at app start; missing config or no consent means no-op. */
    async init(): Promise<void> {
      if (!config || client || initializing) return;
      initializing = true;
      try {
        const sdk = await load();
        if (!sdk) return;
        const created = sdk.init(config.token, buildPosthogOptions(config.host));
        if (!created) return;
        client = created;
        if (consentGranted()) {
          created.opt_in_capturing();
          identify();
        } else {
          created.opt_out_capturing();
        }
      } catch {
        client = null;
      } finally {
        initializing = false;
      }
    },

    /** Operator opened the onboarding wizard — the funnel's start step. */
    trackSetupWizardStarted(): void {
      capture(ANALYTICS_EVENTS.setupWizardStarted);
    },

    /** Operator submitted a channel connection (Instagram OAuth / WhatsApp code). */
    trackChannelConnectStarted(platform: ChannelPlatform): void {
      capture(ANALYTICS_EVENTS.channelConnectStarted, { platform: asChannelPlatform(platform) });
    },

    /** Channel actually connected — the funnel's middle step. */
    trackChannelConnected(platform: ChannelPlatform): void {
      capture(ANALYTICS_EVENTS.channelConnected, { platform: asChannelPlatform(platform) });
    },

    /** Operator approved a drafted reply — the funnel's success step. */
    trackReplyApproved(platform: Platform | ChannelPlatform, edited: boolean): void {
      capture(ANALYTICS_EVENTS.replyApproved, { platform: asChannelPlatform(platform), edited: edited === true });
    },

    /** Opaque stable operator id from the API; anything email-shaped is refused. */
    identifyOperator(id: string | null | undefined): void {
      const clean = typeof id === 'string' ? id.trim() : '';
      if (!clean || clean.includes('@')) return;
      operatorId = clean;
      identify();
    },

    /** Logout: forget the operator. Consent is re-applied so capture stays opted in. */
    reset(): void {
      operatorId = null;
      try {
        if (!client) return;
        client.reset();
        if (consentGranted()) client.opt_in_capturing();
      } catch {
        /* ignore */
      }
    },

    /** Consent decision from the operator (Settings → Data control). */
    setConsent(granted: boolean): void {
      try {
        storage?.setItem(CONSENT_KEY, granted ? 'granted' : 'denied');
      } catch {
        /* storage blocked → capture stays off */
      }
      try {
        if (!client) return;
        if (granted) {
          client.opt_in_capturing();
          identify();
        } else {
          client.opt_out_capturing();
        }
      } catch {
        /* ignore */
      }
    },

    isConsentGranted(): boolean {
      return consentGranted();
    },
  };
}

export type Analytics = ReturnType<typeof createAnalytics>;

/** The app-wide client (single PostHog instance, initialised once in main.tsx). */
export const analytics = createAnalytics();
