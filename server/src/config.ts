import 'dotenv/config';
import path from 'path';
import crypto from 'crypto';

// Also accept the monorepo root .env (docker compose / root npm run dev)
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

function warn(name: string, msg: string) {
  // eslint-disable-next-line no-console
  console.warn(`[config] ${name}: ${msg}`);
}

const isProd = process.env.NODE_ENV === 'production';

const jwtSecretRaw = process.env.JWT_SECRET || '';
let jwtSecret = jwtSecretRaw;
if (!jwtSecret) {
  if (isProd) throw new Error('JWT_SECRET is required in production');
  jwtSecret = 'dev-only-insecure-jwt-secret-not-for-production';
  warn('JWT_SECRET', 'missing — using an insecure development default');
} else if (isProd && jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}

const encKeyRaw = process.env.ENCRYPTION_KEY || '';
let encryptionKey: Buffer;
if (encKeyRaw) {
  encryptionKey = Buffer.from(encKeyRaw, 'base64');
  if (encryptionKey.length !== 32) {
    if (isProd) throw new Error('ENCRYPTION_KEY must be 32 bytes base64');
    warn('ENCRYPTION_KEY', 'not 32 bytes — deriving a dev key instead');
    encryptionKey = crypto.createHash('sha256').update(encKeyRaw).digest();
  }
} else {
  if (isProd) throw new Error('ENCRYPTION_KEY is required in production');
  encryptionKey = crypto.createHash('sha256').update('exotic-bot-dev-key').digest();
  warn('ENCRYPTION_KEY', 'missing — using an insecure development key (data will not be portable)');
}

export const config = {
  isProd,
  port: Number(process.env.PORT || 4000),
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, ''),
  webOrigin: (process.env.WEB_ORIGIN || 'http://localhost:3001').replace(/\/$/, ''),
  databaseUrl: process.env.DATABASE_URL || 'file:./dev.db',

  jwtSecret,
  jwtExpiresIn: '12h',
  encryptionKey,

  // Extra origins allowed for state-changing requests (reverse proxies):
  // TRUSTED_ORIGINS=https://app.example.com,https://www.example.com
  trustedOrigins: (process.env.TRUSTED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean),

  meta: {
    appId: process.env.META_APP_ID || '',
    appSecret: process.env.META_APP_SECRET || '',
    redirectUri: process.env.META_REDIRECT_URI || '',
    verifyToken: process.env.VERIFY_TOKEN || 'exotic-bot-verify',
    appSecretForWebhooks: process.env.APP_SECRET || process.env.META_APP_SECRET || '',
    publicWebhookUrl: (process.env.PUBLIC_WEBHOOK_URL || '').replace(/\/$/, ''),
  },

  instagram: {
    /**
     * Residential egress for private-API (username/password) Instagram
     * requests — `http://user:pass@host:port` or `host:port:user:pass`.
     * Instagram blocks password logins from cloud/datacenter ranges, so
     * without this every attempt comes from the server's own IP. Per-attempt
     * proxy from the connect card's Advanced settings overrides it.
     */
    proxyUrl: process.env.INSTAGRAM_PROXY_URL || '',
  },

  // Landing-screen "Create account" stays available while true (default).
  // Set ALLOW_REGISTRATION=false to lock sign-ups to the first-run only.
  allowRegistration: process.env.ALLOW_REGISTRATION !== 'false',

  queue: {
    driver: (process.env.QUEUE_DRIVER || 'memory') as 'memory' | 'bullmq',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  // Split app/worker containers: set WORKERS_ENABLED=0 on the API container.
  // Job claims are atomic, so multiple worker-enabled containers are safe.
  workersEnabled: process.env.WORKERS_ENABLED !== '0',

  ai: {
    ollamaBaseUrl: (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, ''),
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2',
  },

  paths: {
    uploads: path.resolve(__dirname, '..', 'uploads'),
    thumbs: path.resolve(__dirname, '..', 'uploads', 'thumbs'),
    audio: path.resolve(__dirname, '..', 'uploads', 'audio'),
  },
};

export type Config = typeof config;
