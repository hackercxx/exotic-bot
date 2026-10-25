import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { originGuard, errorHandler } from './middleware/auth';
import { authRouter } from './routes/auth';
import { accountsRouter } from './routes/accounts';
import { messagesRouter } from './routes/messages';
import { postsRouter } from './routes/posts';
import { mediaRouter } from './routes/media';
import { musicRouter } from './routes/music';
import { analyticsRouter } from './routes/analytics';
import { settingsRouter } from './routes/settings';
import { eventsRouter } from './routes/events';
import { webhooksRouter } from './routes/webhooks';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false, // SPA + inline styles; strict CSP configured at reverse proxy
    }),
  );
  app.use(
    cors({
      origin: [config.webOrigin, config.publicUrl, 'http://localhost:3001', 'http://localhost:4000'],
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    }),
  );

  // Capture the raw body for webhook signature verification (§7)
  app.use(
    express.json({
      limit: '4mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: false }));
  app.use(originGuard);

  // Uploaded media/thumbnails (images, video, audio)
  app.use('/uploads', express.static(config.paths.uploads, { maxAge: '7d', fallthrough: true }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'exotic-bot', time: new Date().toISOString() });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/accounts', accountsRouter);
  app.use('/api/messages', messagesRouter);
  app.use('/api/posts', postsRouter);
  app.use('/api/media', mediaRouter);
  app.use('/api/music', musicRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/events', eventsRouter);
  app.use('/webhooks', webhooksRouter);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route' }));

  // Production single-service mode: serve the built SPA from the same process
  // (docker compose "app" container serves web/dist — no nginx required).
  const spaDir = path.resolve(__dirname, '..', '..', 'web', 'dist');
  if (fs.existsSync(path.join(spaDir, 'index.html'))) {
    app.use(express.static(spaDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/webhooks') || req.path.startsWith('/uploads')) {
        return next();
      }
      res.sendFile(path.join(spaDir, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
