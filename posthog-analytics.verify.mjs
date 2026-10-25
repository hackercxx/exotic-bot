#!/usr/bin/env node
/**
 * Offline verification for the PostHog product-analytics integration.
 *
 *   1. reads the manifests and the original lock (read-only) to prove the
 *      browser SDK is pinned to posthog-js 1.438.13 in the importing package;
 *   2. runs the real handler tests with the repo's toolchain (tsx on Node),
 *      shell:false, in a bounded child process whose env starts empty except
 *      for OS/path/temp values and a fixed synthetic project token;
 *   3. fails on a missing runner, missing tests or zero executed assertions.
 *
 * No events are sent: the child denies network access and uses an in-memory
 * transport. Run with `node posthog-analytics.verify.mjs`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PINNED_VERSION = '1.438.13';
const SYNTHETIC_TOKEN = 'synthetic_project_token_offline_checks'; // never phc_/phx_
const SYNTHETIC_HOST = 'https://us.i.posthog.com';
const TEST_FILE = 'web/tests/posthog-analytics.test.ts';
const NETWORK_GUARD = 'web/tests/block-network.mjs';
const TIMEOUT_MS = 120_000;

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`  OK   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const abs = (rel) => path.join(ROOT, rel);
const exists = (rel) => fs.existsSync(abs(rel));
const readJson = (rel) => JSON.parse(fs.readFileSync(abs(rel), 'utf8'));

console.log('\n-- pinned browser SDK (read-only manifest + lock readers) --');
const webManifest = readJson('web/package.json');
const lock = readJson('package-lock.json');
const locked = lock.packages?.['node_modules/posthog-js'];

check('web/package.json (the SDK-importing app) pins posthog-js', webManifest.dependencies?.['posthog-js'] === PINNED_VERSION, String(webManifest.dependencies?.['posthog-js']));
check('original lock records the web workspace dependency', lock.packages?.web?.dependencies?.['posthog-js'] === PINNED_VERSION);
check('original lock resolves posthog-js', locked?.version === PINNED_VERSION, String(locked?.version));
check('original lock records the resolved tarball', /posthog-js\/-\/posthog-js-1\.438\.13\.tgz$/.test(locked?.resolved ?? ''), locked?.resolved);
check('original lock records the integrity hash', /^sha512-/.test(locked?.integrity ?? ''), locked?.integrity);
check('installed SDK matches the pin', readJson('node_modules/posthog-js/package.json').version === PINNED_VERSION);

for (const secondary of ['web/package-lock.json', 'yarn.lock', 'web/yarn.lock', 'pnpm-lock.yaml', 'web/pnpm-lock.yaml', 'bun.lockb', 'web/bun.lockb']) {
  check(`no secondary lock (${secondary})`, !exists(secondary));
}

const serverManifest = readJson('server/package.json');
check(
  'server package gained no browser SDK',
  !serverManifest.dependencies?.['posthog-js'] && !serverManifest.devDependencies?.['posthog-js'],
);

const envExample = fs.readFileSync(abs('web/.env.example'), 'utf8');
check('example env declares an empty project token placeholder', /^VITE_POSTHOG_PROJECT_TOKEN=\s*$/m.test(envExample));
check('example env declares the ingestion host', /^VITE_POSTHOG_HOST=/m.test(envExample));

const ignoreFile = fs.readFileSync(abs('.gitignore'), 'utf8');
check('local env files stay git-ignored', /^\.env$/m.test(ignoreFile) && /^\.env\.local$/m.test(ignoreFile));
check('example env is not ignored', !/^\.env\.example$/m.test(ignoreFile) && !/^\*\.env\*$/m.test(ignoreFile));

console.log('\n-- toolchain --');
const runnerPresent = exists('node_modules/tsx');
check('offline test runner (tsx) is installed', runnerPresent);
check('real handler test file exists', exists(TEST_FILE));
check('network guard exists', exists(NETWORK_GUARD));
if (!runnerPresent || !exists(TEST_FILE) || !exists(NETWORK_GUARD)) {
  console.log(`\n== RESULT: ${failures} failed — cannot run the handler tests ==`);
  process.exit(1);
}

console.log('\n-- real handler tests (synthetic token, in-memory transport, network denied) --');
const result = spawnSync(
  process.execPath,
  ['--import', `./${NETWORK_GUARD}`, '--import', 'tsx', '--test', TEST_FILE],
  {
    cwd: ROOT,
    shell: false,
    timeout: TIMEOUT_MS,
    encoding: 'utf8',
    // Child env starts empty: only OS/path/temp values + fixed synthetic config.
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      VITE_POSTHOG_PROJECT_TOKEN: SYNTHETIC_TOKEN,
      VITE_POSTHOG_HOST: SYNTHETIC_HOST,
    },
  },
);

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
process.stdout.write(output);

const num = (label) => {
  const match = output.match(new RegExp(`^# ${label} (\\d+)$`, 'm'));
  return match ? Number(match[1]) : null;
};
const executed = num('pass');
const failedTests = num('fail');
const total = num('tests');

if (result.error) check('test process completed within the bound', false, result.error.message);
check('test process exited cleanly', result.status === 0, `status ${result.status}`);
check('tests actually executed', typeof total === 'number' && total > 0, `tests=${total}`);
check('assertions actually ran (no zero-assertion pass)', typeof executed === 'number' && executed > 0, `pass=${executed}`);
check('no failing handler tests', failedTests === 0, `fail=${failedTests}`);

console.log(`\n== RESULT: ${failures === 0 ? 'all offline analytics checks passed' : `${failures} check(s) failed`} ==`);
process.exit(failures === 0 ? 0 : 1);
