/**
 * Network guard for the offline PostHog checks: delivery attempts fail loudly
 * instead of reaching any ingestion host. Loaded before the test file
 * (`node --import ./web/tests/block-network.mjs`).
 */
const deny = () => {
  throw new Error('network access is denied in offline analytics checks');
};

globalThis.fetch = deny;
globalThis.XMLHttpRequest = class {
  open() {
    deny();
  }
  send() {
    deny();
  }
};
globalThis.navigator?.sendBeacon && (globalThis.navigator.sendBeacon = deny);
