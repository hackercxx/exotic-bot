/**
 * Offline checks for web/src/lib/analytics.ts — the real analytics client, the
 * real consent gate, the real before_send scrubber and the real typed action
 * handlers used by the app. Synthetic project token, in-memory transport,
 * network denied: nothing is delivered anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYTICS_EVENTS,
  buildPosthogOptions,
  createAnalytics,
  readPosthogConfig,
  scrubEvent,
} from '../src/lib/analytics.ts';

const SYNTHETIC_TOKEN = 'synthetic_project_token_offline_checks'; // never phc_/phx_
const SYNTHETIC_HOST = 'https://us.i.posthog.com';

type Captured = { event: string; properties?: Record<string, unknown> };

function memorySdk({ failCapture = false } = {}) {
  const calls = {
    init: [] as { token: string; options: Record<string, unknown> }[],
    capture: [] as Captured[],
    identify: [] as string[],
    reset: 0,
    optIn: 0,
    optOut: 0,
  };
  const client = {
    capture(event: string, properties?: Record<string, unknown>) {
      if (failCapture) throw new Error('transport down');
      calls.capture.push({ event, properties });
    },
    identify(id: string) {
      calls.identify.push(id);
    },
    reset() {
      calls.reset += 1;
    },
    opt_in_capturing() {
      calls.optIn += 1;
    },
    opt_out_capturing() {
      calls.optOut += 1;
    },
  };
  const sdk = {
    init(token: string, options: Record<string, unknown>) {
      calls.init.push({ token, options });
      return client;
    },
  };
  return { sdk, calls };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    snapshot: () => Object.fromEntries(map.entries()),
  };
}

const grantedEnv = { VITE_POSTHOG_PROJECT_TOKEN: SYNTHETIC_TOKEN, VITE_POSTHOG_HOST: SYNTHETIC_HOST };

test('missing token or host keeps capture off and never loads the SDK', async () => {
  let loads = 0;
  const { sdk, calls } = memorySdk();
  const analytics = createAnalytics({
    env: {},
    storage: memoryStorage(),
    load: async () => {
      loads += 1;
      return sdk;
    },
  });

  analytics.setConsent(true);
  await analytics.init();
  analytics.trackSetupWizardStarted();
  analytics.trackChannelConnectStarted('instagram');
  analytics.trackChannelConnected('whatsapp');
  analytics.trackReplyApproved('instagram', false);

  assert.equal(loads, 0);
  assert.equal(calls.init.length, 0);
  assert.equal(calls.capture.length, 0);

  // non-https / unparseable host is treated the same way: off
  assert.equal(readPosthogConfig({ VITE_POSTHOG_PROJECT_TOKEN: SYNTHETIC_TOKEN, VITE_POSTHOG_HOST: 'http://localhost:8000' }), null);
  assert.equal(readPosthogConfig({ VITE_POSTHOG_PROJECT_TOKEN: SYNTHETIC_TOKEN, VITE_POSTHOG_HOST: 'not a url' }), null);
});

test('initialises exactly one client with the privacy defaults, opted out until consent', async () => {
  const { sdk, calls } = memorySdk();
  const analytics = createAnalytics({ env: grantedEnv, storage: memoryStorage(), load: async () => sdk });

  await analytics.init();
  await analytics.init(); // second call must not create a second client

  assert.equal(calls.init.length, 1);
  assert.equal(calls.init[0].token, SYNTHETIC_TOKEN);
  const options = calls.init[0].options;
  assert.equal(options.api_host, SYNTHETIC_HOST);
  assert.equal(options.autocapture, false);
  assert.equal(options.capture_pageview, false);
  assert.equal(options.capture_pageleave, false);
  assert.equal(options.capture_dead_clicks, false);
  assert.equal(options.capture_performance, false);
  assert.equal(options.disable_session_recording, true);
  assert.equal(options.disable_surveys, true);
  assert.equal(options.advanced_disable_flags, true);
  assert.equal(options.opt_out_capturing_by_default, true);
  assert.equal(typeof options.before_send, 'function');
  assert.equal(options.before_send, scrubEvent); // the option uses the real scrubber

  // no consent decision yet → opted out, no identity, no events
  assert.equal(calls.optOut, 1);
  assert.equal(calls.optIn, 0);
  analytics.identifyOperator('operator_9f2c1d');
  analytics.trackSetupWizardStarted();
  assert.equal(calls.identify.length, 0);
  assert.equal(calls.capture.length, 0);
});

test('a stored denial sends nothing on init', async () => {
  const { sdk, calls } = memorySdk();
  const analytics = createAnalytics({
    env: grantedEnv,
    storage: memoryStorage({ 'exotic.analytics-consent': 'denied' }),
    load: async () => sdk,
  });

  await analytics.init();
  analytics.trackChannelConnected('instagram');

  assert.equal(calls.optOut, 1);
  assert.equal(calls.capture.length, 0);
  assert.equal(analytics.isConsentGranted(), false);
});

test('granted consent emits each real action once with only allowlisted properties', async () => {
  const { sdk, calls } = memorySdk();
  const storage = memoryStorage({ 'exotic.analytics-consent': 'granted' });
  const analytics = createAnalytics({ env: grantedEnv, storage, load: async () => sdk });
  await analytics.init();

  analytics.trackSetupWizardStarted();
  analytics.trackChannelConnectStarted('instagram');
  analytics.trackChannelConnected('whatsapp');
  analytics.trackReplyApproved('WHATSAPP', true);

  assert.deepEqual(
    calls.capture.map((c) => c.event),
    [ANALYTICS_EVENTS.setupWizardStarted, ANALYTICS_EVENTS.channelConnectStarted, ANALYTICS_EVENTS.channelConnected, ANALYTICS_EVENTS.replyApproved],
  );
  assert.deepEqual(calls.capture[0].properties, {});
  assert.deepEqual(calls.capture[1].properties, { platform: 'instagram' });
  assert.deepEqual(calls.capture[2].properties, { platform: 'whatsapp' });
  assert.deepEqual(calls.capture[3].properties, { platform: 'whatsapp', edited: true });
  assert.equal(calls.optIn, 1);
});

test('the Settings consent toggle drives opt_in/opt_out and is persisted', async () => {
  const { sdk, calls } = memorySdk();
  const storage = memoryStorage();
  const analytics = createAnalytics({ env: grantedEnv, storage, load: async () => sdk });
  await analytics.init();

  analytics.trackChannelConnectStarted('whatsapp');
  assert.equal(calls.capture.length, 0);

  analytics.setConsent(true);
  assert.equal(storage.snapshot()['exotic.analytics-consent'], 'granted');
  analytics.trackChannelConnectStarted('whatsapp');
  assert.equal(calls.capture.length, 1);
  assert.equal(calls.optIn, 1);

  analytics.setConsent(false);
  assert.equal(storage.snapshot()['exotic.analytics-consent'], 'denied');
  analytics.trackChannelConnectStarted('whatsapp');
  assert.equal(calls.capture.length, 1);
  assert.equal(calls.optOut, 2); // once at init, once on the denial
});

test('before_send (the option the client received) strips URL, referrer, person and non-allowlisted data', async () => {
  const { sdk, calls } = memorySdk();
  const storage = memoryStorage({ 'exotic.analytics-consent': 'granted' });
  const analytics = createAnalytics({ env: grantedEnv, storage, load: async () => sdk });
  await analytics.init();
  const beforeSend = calls.init[0].options.before_send as (event: Record<string, unknown> | null) => any;

  const sensitive = {
    event: ANALYTICS_EVENTS.replyApproved,
    distinct_id: 'operator_9f2c1d',
    properties: {
      platform: 'whatsapp',
      edited: true,
      body: 'card 4111 1111 1111 1111 password hunter2',
      email: 'ada@example.com',
      access_token: 'EAAB-synthetic-secret',
      $current_url: 'https://command.example/inbox?token=synthetic',
      $pathname: '/inbox',
      $referrer: 'https://mail.example/?email=ada@example.com',
      $set: { email: 'ada@example.com' },
    },
    $set: { email: 'ada@example.com' },
  };
  const scrubbed = beforeSend(sensitive);
  const serialized = JSON.stringify(scrubbed);

  assert.deepEqual(scrubbed.properties, { platform: 'whatsapp', edited: true });
  assert.equal(scrubbed.$set, undefined);
  for (const sentinel of [
    'ada@example.com',
    '4111 1111 1111 1111',
    'hunter2',
    'EAAB-synthetic-secret',
    'command.example',
    'mail.example',
    '/inbox',
  ]) {
    assert.equal(serialized.includes(sentinel), false, `leaked ${sentinel}`);
  }

  // SDK-internal events keep their shape but lose person/URL metadata too
  const identify = beforeSend({ event: '$identify', properties: { $set: { email: 'ada@example.com' }, $current_url: 'https://command.example/x' } });
  assert.deepEqual(identify.properties, {});
  assert.equal(beforeSend(null), null);
});

test('identity is the opaque operator id, email is refused, reset forgets it', async () => {
  const { sdk, calls } = memorySdk();
  const storage = memoryStorage({ 'exotic.analytics-consent': 'granted' });
  const analytics = createAnalytics({ env: grantedEnv, storage, load: async () => sdk });
  await analytics.init();

  analytics.identifyOperator('ada@example.com');
  assert.equal(calls.identify.length, 0);

  analytics.identifyOperator('cuid_operator_9f2c1d');
  assert.deepEqual(calls.identify, ['cuid_operator_9f2c1d']);

  analytics.reset();
  assert.equal(calls.reset, 1);
  assert.equal(calls.optIn, 2); // consent re-applied: reset() reverts to opted out otherwise
  assert.deepEqual(calls.identify, ['cuid_operator_9f2c1d']); // identity not resent

  analytics.trackChannelConnected('instagram'); // still allowed after reset (consent held)
  assert.equal(calls.capture.length, 1);
});

test('transport and loader failures are harmless and keep the action result', async () => {
  const { sdk, calls } = memorySdk({ failCapture: true });
  const analytics = createAnalytics({
    env: grantedEnv,
    storage: memoryStorage({ 'exotic.analytics-consent': 'granted' }),
    load: async () => sdk,
  });
  await analytics.init();

  // the real action continues even when delivery throws
  const approveReply = (result: string) => {
    analytics.trackReplyApproved('instagram', false);
    return result;
  };
  assert.equal(approveReply('sent'), 'sent');
  assert.equal(calls.capture.length, 0); // throwing transport recorded nothing

  // an SDK that refuses to load must not break app start
  const noSdk = createAnalytics({
    env: grantedEnv,
    storage: memoryStorage(),
    load: async () => {
      throw new Error('sdk unavailable');
    },
  });
  await noSdk.init();
  assert.doesNotThrow(() => noSdk.trackSetupWizardStarted());
  assert.equal(noSdk.isConsentGranted(), false);
});

test('host configuration is taken only from config and never probed', () => {
  assert.deepEqual(readPosthogConfig(grantedEnv), { token: SYNTHETIC_TOKEN, host: SYNTHETIC_HOST });
  assert.deepEqual(
    readPosthogConfig({ VITE_POSTHOG_PROJECT_TOKEN: SYNTHETIC_TOKEN, VITE_POSTHOG_HOST: 'https://eu.i.posthog.com/' }),
    { token: SYNTHETIC_TOKEN, host: 'https://eu.i.posthog.com' },
  );
  const selfHosted = readPosthogConfig({ VITE_POSTHOG_PROJECT_TOKEN: SYNTHETIC_TOKEN, VITE_POSTHOG_HOST: 'https://analytics.internal.example/ingest' });
  assert.deepEqual(selfHosted, { token: SYNTHETIC_TOKEN, host: 'https://analytics.internal.example/ingest' });
  assert.ok(buildPosthogOptions(selfHosted!.host).api_host === selfHosted!.host);
});
