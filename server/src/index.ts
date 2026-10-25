import http from 'http';
import fs from 'fs';
import { config } from './config';
import { createApp } from './app';
import { setupWebSocket } from './services/socket';
import { startWorkers } from './services/worker';
import { restorePairedSessions, shutdownPairingSockets } from './services/whatsappPair';
import { logEvent } from './services/events';
import { prisma } from './db';

async function main() {
  // Ensure upload directories exist before any route can hit them
  for (const dir of Object.values(config.paths)) fs.mkdirSync(dir, { recursive: true });

  const app = createApp();
  const server = http.createServer(app);

  setupWebSocket(server); // /ws — authenticated event stream
  if (config.workersEnabled) {
    await startWorkers(); // queue + scheduler + sync jobs
  } else {
    // eslint-disable-next-line no-console
    console.log('[workers] disabled on this container (WORKERS_ENABLED=0) — enqueue only');
  }
  // previously linked WhatsApp numbers reconnect from persisted auth state
  void restorePairedSessions().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[wa-pair] restore failed:', err instanceof Error ? err.message : err);
  });

  server.listen(config.port, '0.0.0.0', async () => {
    // eslint-disable-next-line no-console
    console.log(`\n  EXOTIC BOT API  →  http://localhost:${config.port}`);
    // eslint-disable-next-line no-console
    console.log(`  queue=${config.queue.driver}  db=${config.databaseUrl.includes('postgres') ? 'postgresql' : 'sqlite'}  uploads=${config.paths.uploads}\n`);
    await logEvent({ level: 'success', message: `API started on :${config.port} (queue: ${config.queue.driver})` });
  });

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`\n${signal} received — shutting down…`);
    server.close();
    shutdownPairingSockets();
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal boot error:', err);
  process.exit(1);
});
