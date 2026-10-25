import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth, type AuthedRequest } from '../middleware/auth';
import { logEvent, recomputeCounters } from '../services/events';
import { broadcast } from '../services/socket';
import { getAiSettings, getBlocklist, matchesBlocklist, getQuietHours, getUserTimezone, inQuietHours } from '../services/settings';
import { generateReply, type ReplyTurn } from '../services/ai';
import { sendOutbound } from '../services/worker';

export const messagesRouter = Router();
messagesRouter.use(requireAuth);

/** Pending counters for the sidebar badge + bell. */
messagesRouter.get('/counts', async (_req: AuthedRequest, res) => {
  const [received, awaitingApproval, autoSentToday] = await Promise.all([
    prisma.message.count({ where: { direction: 'INBOUND', status: 'RECEIVED' } }),
    prisma.message.count({ where: { direction: 'OUTBOUND', status: 'AWAITING_APPROVAL' } }),
    prisma.message.count({
      where: {
        direction: 'OUTBOUND',
        status: { in: ['AUTO_SENT', 'SENT'] },
        sentAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      },
    }),
  ]);
  res.json({ received, awaitingApproval, pending: received + awaitingApproval, sentToday: autoSentToday });
});

/** Conversation list (Inbox left rail), newest activity first. */
messagesRouter.get('/conversations', async (_req: AuthedRequest, res) => {
  const messages = await prisma.message.findMany({
    orderBy: { createdAt: 'desc' },
    take: 1000,
    include: { account: { select: { id: true, label: true, platform: true, autoReplyEnabled: true } } },
  });
  const map = new Map<string, any>();
  for (const m of messages) {
    const existing = map.get(m.conversationKey);
    if (existing) {
      existing.messageCount += 1;
      if (m.direction === 'INBOUND' && m.status === 'RECEIVED') existing.unread += 1;
      continue;
    }
    map.set(m.conversationKey, {
      conversationKey: m.conversationKey,
      sender: m.sender,
      platform: m.platform,
      accountId: m.accountId,
      accountLabel: m.account.label,
      lastBody: m.body,
      lastAt: m.createdAt,
      unread: m.direction === 'INBOUND' && m.status === 'RECEIVED' ? 1 : 0,
      messageCount: 1,
    });
  }
  res.json({ conversations: [...map.values()] });
});

/** Messages of one conversation (thread view). */
messagesRouter.get('/thread/:conversationKey', async (req: AuthedRequest, res) => {
  const messages = await prisma.message.findMany({
    where: { conversationKey: req.params.conversationKey },
    orderBy: { createdAt: 'asc' },
    take: 200,
    include: { account: { select: { id: true, label: true, platform: true, autoReplyEnabled: true } } },
  });
  res.json({ messages });
});

/** Manual "draft reply" for an inbound message (auto-reply off → human-in-the-loop). */
messagesRouter.post('/:id/draft', async (req: AuthedRequest, res) => {
  const inbound = await prisma.message.findUnique({ where: { id: req.params.id }, include: { account: true } });
  if (!inbound || inbound.direction !== 'INBOUND') return res.status(404).json({ error: 'Inbound message not found' });

  const [settings, blocklist, quietHours, timezone] = await Promise.all([
    getAiSettings(inbound.account.userId),
    getBlocklist(inbound.account.userId),
    getQuietHours(inbound.account.userId),
    getUserTimezone(inbound.account.userId),
  ]);
  const blocked = matchesBlocklist(inbound.body, blocklist);
  if (blocked) return res.status(400).json({ error: `Message matches the blocklist word “${blocked}” — reply manually.` });

  try {
    const history: ReplyTurn[] = (
      await prisma.message.findMany({
        where: { conversationKey: inbound.conversationKey, accountId: inbound.accountId },
        orderBy: { createdAt: 'asc' },
        take: 40,
      })
    ).map((m) => ({ sender: m.sender, body: m.body, direction: m.direction as 'INBOUND' | 'OUTBOUND' }));

    const draft = await generateReply({
      settings,
      platform: inbound.account.platform as 'INSTAGRAM' | 'WHATSAPP',
      businessName: inbound.account.label,
      history: history.slice(0, -1),
      inboundBody: inbound.body,
    });
    const row = await prisma.message.create({
      data: {
        accountId: inbound.accountId,
        platform: inbound.platform,
        conversationKey: inbound.conversationKey,
        sender: inbound.account.label,
        body: draft.text,
        direction: 'OUTBOUND',
        aiGenerated: true,
        aiModel: draft.model,
        latencyMs: draft.latencyMs,
        status: 'AWAITING_APPROVAL',
        replyToId: inbound.id,
      },
    });
    const quiet = inQuietHours(quietHours, new Date(), timezone);
    await logEvent({
      level: 'info',
      message: `Draft generated for ${inbound.sender}${quiet ? ' (held for quiet hours)' : ''}`,
      meta: { messageId: row.id, model: draft.model, latencyMs: draft.latencyMs },
    });
    broadcast({ type: 'message:new', data: { id: row.id, status: row.status } });
    await recomputeCounters();
    res.status(201).json({ message: row });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'AI draft failed' });
  }
});

/**
 * Approve & send a held draft (§4.3 human-in-the-loop).
 * Body may override the drafted text before sending.
 */
messagesRouter.post('/:id/approve', async (req: AuthedRequest, res) => {
  const draft = await prisma.message.findUnique({ where: { id: req.params.id }, include: { account: true } });
  if (!draft || draft.direction !== 'OUTBOUND') return res.status(404).json({ error: 'Draft not found' });
  if (!['AWAITING_APPROVAL', 'FAILED', 'HELD'].includes(draft.status)) {
    return res.status(409).json({ error: `Draft is already ${draft.status}` });
  }
  const body = typeof req.body?.body === 'string' && req.body.body.trim() ? req.body.body.trim() : draft.body;
  const inbound = draft.replyToId ? await prisma.message.findUnique({ where: { id: draft.replyToId } }) : null;

  try {
    const result = await sendOutbound({
      account: {
        id: draft.accountId,
        platform: draft.platform,
        externalId: draft.account.externalId,
        phoneNumberId: draft.account.phoneNumberId,
      },
      recipientId: draft.conversationKey.split(':').slice(1).join(':'),
      text: body,
      source: inbound?.source === 'COMMENT' ? 'COMMENT' : 'MESSAGE',
      replyExternalId: inbound?.replyToExternalId || undefined,
    });
    const sent = await prisma.message.update({
      where: { id: draft.id },
      data: { status: 'SENT', body, sentAt: new Date(), externalId: result.messageId, error: null },
    });
    if (inbound) {
      await prisma.message.update({ where: { id: inbound.id }, data: { status: 'REPLIED' } });
    }
    await logEvent({
      level: 'success',
      message: `Reply approved & sent to ${draft.conversationKey.split(':').slice(1).join(':') || 'recipient'}`,
      meta: { messageId: draft.id, edited: body !== draft.body },
    });
    broadcast({ type: 'message:updated', data: { id: draft.id, status: 'SENT' } });
    await recomputeCounters();
    res.json({ message: sent });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Send failed';
    await prisma.message.update({ where: { id: draft.id }, data: { status: 'FAILED', error: message } });
    await logEvent({ level: 'error', message: `Approved reply failed: ${message}` });
    broadcast({ type: 'message:updated', data: { id: draft.id, status: 'FAILED' } });
    res.status(502).json({ error: message });
  }
});

/** Dismiss a held draft or an inbound message that needs no reply. */
messagesRouter.post('/:id/dismiss', async (req: AuthedRequest, res) => {
  const msg = await prisma.message.findUnique({ where: { id: req.params.id } });
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  const next = msg.direction === 'INBOUND' ? 'DISMISSED' : 'DISMISSED';
  const updated = await prisma.message.update({ where: { id: msg.id }, data: { status: next } });
  await logEvent({ level: 'info', message: `Message dismissed (${msg.sender})`, meta: { messageId: msg.id } });
  broadcast({ type: 'message:updated', data: { id: updated.id, status: updated.status } });
  await recomputeCounters();
  res.json({ message: updated });
});
