import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth, type AuthedRequest } from '../middleware/auth';

export const eventsRouter = Router();
eventsRouter.use(requireAuth);

/** Terminal panel feed: last 120 audit events, newest first (§4.8). */
eventsRouter.get('/', async (req: AuthedRequest, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 120));
  const events = await prisma.event.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  res.json({
    events: events.map((e) => ({
      id: e.id,
      level: e.level,
      message: e.message,
      meta: safeParse(e.meta),
      createdAt: e.createdAt,
    })),
  });
});

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
