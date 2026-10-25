import { Router, raw } from 'express';
import { prisma } from '../db';
import { config } from '../config';
import { verifyWebhookSignature } from '../services/meta';
import { enqueue } from '../services/queue';
import { logEvent } from '../services/events';

export const webhooksRouter = Router();

/**
 * Meta webhook verification (GET). Meta calls this with hub.mode=subscribe
 * and our VERIFY_TOKEN; respond with hub.challenge.
 */
webhooksRouter.get('/meta', (req, res) => {
  const mode = String(req.query['hub.mode'] || '');
  const token = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  if (mode === 'subscribe' && token === config.meta.verifyToken) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Verification failed');
});

/**
 * Inbound webhook receiver (§4.3):
 * 1. verify X-Hub-Signature-256 against APP_SECRET (HMAC-SHA256 of raw body)
 * 2. persist the delivery (audit)
 * 3. enqueue processing → worker persists messages / comments
 * 4. answer 200 immediately (Meta expects fast acknowledgement)
 */
webhooksRouter.post(
  '/meta',
  raw({ type: '*/*', limit: '2mb' }),
  async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
    if (!config.meta.appSecretForWebhooks) {
      await logEvent({ level: 'error', message: 'Webhook rejected: APP_SECRET is not configured' });
      return res.status(503).json({ error: 'APP_SECRET is not configured on this instance' });
    }
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const valid = await verifyWebhookSignature(rawBody, signature);
    if (!valid) {
      await logEvent({ level: 'warn', message: 'Webhook rejected: invalid signature' });
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let payload: any = {};
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    const objectId = String(payload?.object || payload?.entry?.[0]?.id || 'unknown');
    const delivery = await prisma.webhookDelivery.create({
      data: {
        platform: String(payload?.object || 'unknown'),
        objectId,
        payload: rawBody.toString('utf8'),
        signatureValid: true,
      },
    });
    await enqueue('process:webhook', { deliveryId: delivery.id });
    res.status(200).json({ ok: true });
  },
);
