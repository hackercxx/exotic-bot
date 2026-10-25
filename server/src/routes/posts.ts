import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, type AuthedRequest } from '../middleware/auth';
import { enqueue } from '../services/queue';
import { logEvent, recomputeCounters } from '../services/events';
import { broadcast } from '../services/socket';

export const postsRouter = Router();
postsRouter.use(requireAuth);

function validateCron(expr: string): Date {
  const mod = require('cron-parser') as any;
  const parse = mod.CronExpressionParser?.parse || mod.parse || mod.parseExpression;
  const next: Date = parse(expr).next().toDate(); // throws when invalid
  return next;
}

const postSchema = z.object({
  platform: z.enum(['INSTAGRAM', 'WHATSAPP']),
  accountId: z.string().optional().nullable(),
  caption: z.string().min(1, 'Caption is required').max(5000),
  captionVariantB: z.string().max(5000).optional().nullable(),
  mediaUrl: z.string().max(600).optional().nullable(),
  mediaType: z.enum(['IMAGE', 'VIDEO', 'NONE']).optional(),
  target: z.string().max(32).optional().nullable(),
  scheduledFor: z.string().datetime().optional().nullable(),
  cron: z.string().max(120).optional().nullable(),
});

/** Calendar feed: posts within [from, to] (defaults: past 30d → next 60d). */
postsRouter.get('/', async (req: AuthedRequest, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30 * 86400000);
  const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 60 * 86400000);
  const posts = await prisma.post.findMany({
    where: { userId: req.userId, OR: [{ scheduledFor: { gte: from, lte: to } }, { createdAt: { gte: from, lte: to } }] },
    orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'desc' }],
    take: 500,
    include: { account: { select: { id: true, label: true } } },
  });
  res.json({ posts });
});

postsRouter.post('/', async (req: AuthedRequest, res) => {
  const parsed = postSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid post' });
  const input = parsed.data;

  if (input.platform === 'WHATSAPP' && !input.target && (input.scheduledFor || input.cron)) {
    return res.status(400).json({ error: 'WhatsApp posts need a recipient number (Target)' });
  }

  let scheduledFor: Date | null = null;
  let cron: string | null = null;
  try {
    if (input.cron) {
      cron = input.cron;
      scheduledFor = input.scheduledFor ? new Date(input.scheduledFor) : validateCron(cron);
      if (input.scheduledFor) validateCron(cron); // still validate the expression
    } else if (input.scheduledFor) {
      scheduledFor = new Date(input.scheduledFor);
    }
  } catch {
    return res.status(400).json({ error: 'Invalid recurring schedule (cron expression)' });
  }

  const isSchedule = Boolean(scheduledFor && scheduledFor.getTime() > Date.now());
  const post = await prisma.post.create({
    data: {
      userId: req.userId!,
      accountId: input.accountId || null,
      platform: input.platform,
      caption: input.caption,
      captionVariantB: input.captionVariantB || null,
      mediaUrl: input.mediaUrl || null,
      mediaType: input.mediaType || (input.mediaUrl ? 'IMAGE' : 'NONE'),
      target: input.target || null,
      scheduledFor: isSchedule ? scheduledFor : scheduledFor && scheduledFor.getTime() <= Date.now() ? scheduledFor : null,
      status: isSchedule ? 'SCHEDULED' : 'DRAFT',
      cron,
      nextRunAt: isSchedule ? scheduledFor : null,
    },
    include: { account: { select: { id: true, label: true } } },
  });

  if (isSchedule && scheduledFor) {
    await enqueue(
      'publish:post',
      { postId: post.id },
      { delayMs: scheduledFor.getTime() - Date.now(), key: `publish:${post.id}:${scheduledFor.toISOString()}` },
    );
    await logEvent({
      level: 'info',
      message: `Post scheduled for ${scheduledFor.toISOString().slice(0, 16).replace('T', ' ')} (${input.platform})`,
      meta: { postId: post.id },
    });
    await recomputeCounters();
  } else {
    await logEvent({ level: 'info', message: `Draft saved (${input.platform})`, meta: { postId: post.id } });
  }
  broadcast({ type: 'post:updated', data: { id: post.id, status: post.status } });
  res.status(201).json({ post });
});

postsRouter.patch('/:id', async (req: AuthedRequest, res) => {
  const post = await prisma.post.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.status === 'PUBLISHING') return res.status(409).json({ error: 'Post is currently publishing' });

  const parsed = postSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid post' });
  const input = parsed.data;

  const update: Record<string, unknown> = {};
  if (input.caption !== undefined) update.caption = input.caption;
  if (input.captionVariantB !== undefined) update.captionVariantB = input.captionVariantB || null;
  if (input.mediaUrl !== undefined) update.mediaUrl = input.mediaUrl;
  if (input.mediaType !== undefined) update.mediaType = input.mediaType;
  if (input.target !== undefined) update.target = input.target || null;
  if (input.accountId !== undefined) update.accountId = input.accountId || null;

  if (input.scheduledFor !== undefined || input.cron !== undefined) {
    const cron = input.cron !== undefined ? input.cron || null : post.cron;
    let next: Date | null = null;
    try {
      if (input.scheduledFor) next = new Date(input.scheduledFor);
      else if (cron) next = validateCron(cron);
    } catch {
      return res.status(400).json({ error: 'Invalid recurring schedule (cron expression)' });
    }
    update.cron = cron;
    update.scheduledFor = next;
    update.nextRunAt = next;
    if (post.status !== 'PUBLISHED') {
      update.status = next && next.getTime() > Date.now() ? 'SCHEDULED' : post.status === 'SCHEDULED' ? 'DRAFT' : post.status;
    }
    if (next && next.getTime() > Date.now() && update.status === 'SCHEDULED') {
      await enqueue(
        'publish:post',
        { postId: post.id },
        { delayMs: next.getTime() - Date.now(), key: `publish:${post.id}:${next.toISOString()}` },
      );
    }
  }

  const updated = await prisma.post.update({
    where: { id: post.id },
    data: update,
    include: { account: { select: { id: true, label: true } } },
  });
  broadcast({ type: 'post:updated', data: { id: updated.id, status: updated.status } });
  res.json({ post: updated });
});

postsRouter.delete('/:id', async (req: AuthedRequest, res) => {
  const post = await prisma.post.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.status === 'PUBLISHING') return res.status(409).json({ error: 'Cannot delete while publishing' });
  await prisma.post.delete({ where: { id: post.id } });
  await logEvent({ level: 'info', message: `Post deleted (${post.platform})`, meta: { postId: post.id } });
  await recomputeCounters();
  res.json({ ok: true });
});

/** Publish immediately (still goes through the official API via the worker). */
postsRouter.post('/:id/publish-now', async (req: AuthedRequest, res) => {
  const post = await prisma.post.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.status === 'PUBLISHED') return res.status(409).json({ error: 'Already published' });
  await prisma.post.update({ where: { id: post.id }, data: { status: 'SCHEDULED', scheduledFor: new Date() } });
  await enqueue('publish:post', { postId: post.id }, { key: `manual:${post.id}:${Date.now()}` });
  await logEvent({ level: 'info', message: 'Publish requested now', meta: { postId: post.id } });
  broadcast({ type: 'post:updated', data: { id: post.id, status: 'SCHEDULED' } });
  res.json({ ok: true });
});

/** Manual retry for FAILED posts (auto-retry already runs up to 3 attempts). */
postsRouter.post('/:id/retry', async (req: AuthedRequest, res) => {
  const post = await prisma.post.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.status !== 'FAILED') return res.status(409).json({ error: 'Only failed posts can be retried' });
  await prisma.post.update({ where: { id: post.id }, data: { status: 'SCHEDULED', attempts: 0, error: null } });
  await enqueue('publish:post', { postId: post.id }, { key: `retry-manual:${post.id}:${Date.now()}` });
  await logEvent({ level: 'info', message: 'Publish retried manually', meta: { postId: post.id } });
  broadcast({ type: 'post:updated', data: { id: post.id, status: 'SCHEDULED' } });
  res.json({ ok: true });
});
