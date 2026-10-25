import { prisma } from '../db';
import { encrypt, decrypt } from '../crypto';
import { logEvent, recomputeCounters } from './events';
import { broadcast } from './socket';
import { registerHandler, enqueue, startQueue, type JobPayload } from './queue';
import { generateReply, type ReplyTurn } from './ai';
import {
  getAiSettings,
  getBlocklist,
  matchesBlocklist,
  getQuietHours,
  getUserTimezone,
  inQuietHours,
} from './settings';
import {
  publishInstagram,
  sendWhatsAppText,
  replyToInstagramComment,
  sendInstagramDm,
  refreshLongLivedToken,
  fetchDailyInsights,
  fetchFollowers,
  fetchPostInsights,
} from './meta';
import { config } from '../config';
import { PAIR_MARKER, sendPairedWhatsAppText } from './whatsappPair';
import { sendPrivateInstagramDm, sessionForAccount, IG_PRIVATE_MARKER, pollInstagramInbox, publishInstagramPrivate } from './instagram';

// ── helpers ────────────────────────────────────────────────────────────

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function nextDailyRun(hour: number, minute: number): Date {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

async function accountToken(accountId: string): Promise<{ token: string; phoneNumberId?: string; igUserId?: string; externalId: string; pageId?: string | null }> {
  const acc = await prisma.account.findUnique({ where: { id: accountId } });
  if (!acc) throw new Error('Account not found');
  if (acc.status === 'DISCONNECTED') throw new Error('Account is disconnected');
  return {
    token: decrypt(acc.accessToken),
    phoneNumberId: acc.phoneNumberId || (acc.platform === 'WHATSAPP' ? acc.externalId : undefined),
    igUserId: acc.platform === 'INSTAGRAM' ? acc.externalId : undefined,
    externalId: acc.externalId,
    pageId: acc.pageId,
  };
}

function absoluteMediaUrl(mediaUrl: string | null | undefined): string | null {
  if (!mediaUrl) return null;
  if (/^https?:\/\//i.test(mediaUrl)) return mediaUrl;
  return `${config.publicUrl}${mediaUrl.startsWith('/') ? '' : '/'}${mediaUrl}`;
}

// ── webhook parsing (§4.3) ─────────────────────────────────────────────

export interface InboundItem {
  platform: 'INSTAGRAM' | 'WHATSAPP';
  matchBy: string; // externalId value to match the connected account
  conversationKey: string;
  senderId: string;
  senderName: string;
  body: string;
  source: 'MESSAGE' | 'COMMENT';
  replyExternalId?: string; // comment_id / wa mid / ig mid
  externalId?: string;
}

export function parseWebhookPayload(payload: any): InboundItem[] {
  const items: InboundItem[] = [];

  if (payload?.object === 'whatsapp_business_account') {
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const value = change.value || {};
        const phoneId = value.metadata?.phone_number_id;
        const contacts = new Map<string, string>();
        for (const c of value.contacts || []) {
          contacts.set(c.wa_id || c?.profile?.wa_id, c.profile?.name || '');
        }
        for (const msg of value.messages || []) {
          const body = msg.text?.body ?? msg.image?.caption ?? msg.video?.caption ?? msg.interactive?.button?.text ?? '';
          if (!body) continue;
          const senderId = String(msg.from);
          items.push({
            platform: 'WHATSAPP',
            matchBy: String(phoneId || ''),
            conversationKey: `wa:${senderId}`,
            senderId,
            senderName: contacts.get(senderId) || senderId,
            body: String(body),
            source: 'MESSAGE',
            replyExternalId: msg.id ? String(msg.id) : undefined,
            externalId: msg.id ? String(msg.id) : undefined,
          });
        }
      }
    }
  }

  if (payload?.object === 'instagram') {
    for (const entry of payload.entry || []) {
      const igId = String(entry.id || '');
      for (const change of entry.changes || []) {
        const value = change.value || {};
        if (change.field === 'comments') {
          const senderId = String(value.from?.id || value.from?.username || 'unknown');
          const senderName = String(value.from?.username || senderId);
          const body = String(value.text || '');
          if (!body) continue;
          items.push({
            platform: 'INSTAGRAM',
            matchBy: igId,
            conversationKey: `ig:${senderId}`,
            senderId,
            senderName,
            body,
            source: 'COMMENT',
            replyExternalId: value.comment_id ? String(value.comment_id) : undefined,
            externalId: value.comment_id ? String(value.comment_id) : undefined,
          });
        } else if (change.field === 'messages') {
          for (const msg of value.messages || []) {
            const body = msg.text?.body || '';
            if (!body) continue;
            const senderId = String(msg.from);
            const profile = (value.contacts || []).find((c: any) => c?.wa_id === senderId || c?.profile);
            items.push({
              platform: 'INSTAGRAM',
              matchBy: igId,
              conversationKey: `ig:${senderId}`,
              senderId,
              senderName: String(profile?.profile?.username || senderId),
              body,
              source: 'MESSAGE',
              replyExternalId: msg.id ? String(msg.id) : undefined,
              externalId: msg.id ? String(msg.id) : undefined,
            });
          }
        }
      }
    }
  }

  return items;
}

// ── outbound send (shared by auto-reply + manual approval) ─────────────

export async function sendOutbound(opts: {
  account: { id: string; platform: string; externalId: string; phoneNumberId: string | null };
  recipientId: string;
  text: string;
  source: 'COMMENT' | 'MESSAGE';
  replyExternalId?: string;
}): Promise<{ messageId: string | null }> {
  const { token, phoneNumberId, igUserId, externalId, pageId } = await accountToken(opts.account.id);
  if (opts.account.platform === 'WHATSAPP') {
    if (phoneNumberId === PAIR_MARKER) {
      // linked-device account (pairing code): send over the live socket, not the Cloud API
      return sendPairedWhatsAppText(externalId, opts.recipientId, opts.text);
    }
    if (!phoneNumberId) throw new Error('WhatsApp account is missing phone_number_id');
    return sendWhatsAppText({ phoneNumberId, accessToken: token }, opts.recipientId, opts.text);
  }
  if (opts.source === 'COMMENT') {
    if (!opts.replyExternalId) throw new Error('Missing comment id for reply');
    // comment replies on a private-API account still go through the private client
    if (pageId === IG_PRIVATE_MARKER) {
      return sendPrivateInstagramDm(opts.account.id, opts.recipientId, opts.text);
    }
    return replyToInstagramComment(opts.replyExternalId, token, opts.text);
  }
  if (!igUserId) throw new Error('Missing Instagram account id');
  // private-API (instagrapi-style) account → send over the private client, no Meta app needed
  if (pageId === IG_PRIVATE_MARKER) {
    return sendPrivateInstagramDm(opts.account.id, opts.recipientId, opts.text);
  }
  return sendInstagramDm(igUserId, token, opts.recipientId, opts.text);
}

/** Core §4.4 pipeline: draft → blocklist → quiet hours → send or hold. */
export async function runReplyPipeline(inboundId: string): Promise<void> {
  const inbound = await prisma.message.findUnique({ where: { id: inboundId }, include: { account: true } });
  if (!inbound || inbound.direction !== 'INBOUND') return;
  const account = inbound.account;
  if (!account.autoReplyEnabled) {
    await logEvent({
      level: 'info',
      message: `New ${account.platform === 'WHATSAPP' ? 'WhatsApp' : 'Instagram'} message from ${inbound.sender} awaiting review`,
      meta: { messageId: inbound.id },
    });
    await recomputeCounters(account.userId);
    broadcast({ type: 'message:new', data: { id: inbound.id, status: inbound.status } });
    return;
  }

  const [settings, blocklist, quietHours, timezone] = await Promise.all([
    getAiSettings(account.userId),
    getBlocklist(account.userId),
    getQuietHours(account.userId),
    getUserTimezone(account.userId),
  ]);

  const blockedWord = matchesBlocklist(inbound.body, blocklist);
  if (blockedWord) {
    await prisma.message.update({ where: { id: inbound.id }, data: { status: 'BLOCKED' } });
    await logEvent({
      level: 'info',
      message: `Auto-reply skipped for ${inbound.sender} — blocklist match`,
      meta: { messageId: inbound.id, word: blockedWord },
    });
    broadcast({ type: 'message:updated', data: { id: inbound.id, status: 'BLOCKED' } });
    return;
  }

  const history: ReplyTurn[] = (
    await prisma.message.findMany({
      where: { conversationKey: inbound.conversationKey, accountId: account.id },
      orderBy: { createdAt: 'asc' },
      take: 40,
    })
  ).map((m) => ({ sender: m.sender, body: m.body, direction: m.direction as 'INBOUND' | 'OUTBOUND' }));

  let draft: { text: string; model: string; latencyMs: number };
  try {
    draft = await generateReply({
      settings,
      platform: account.platform as 'INSTAGRAM' | 'WHATSAPP',
      businessName: account.label,
      history: history.slice(0, -1),
      inboundBody: inbound.body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logEvent({
      level: 'warn',
      message: `AI draft failed for ${inbound.sender}: ${message}`,
      meta: { messageId: inbound.id },
    });
    return; // inbound stays RECEIVED → operator handles it manually
  }

  const draftRow = await prisma.message.create({
    data: {
      accountId: account.id,
      platform: account.platform,
      conversationKey: inbound.conversationKey,
      sender: account.label,
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
  if (quiet) {
    await logEvent({
      level: 'info',
      message: `Reply to ${inbound.sender} held for quiet hours (${quietHours.start}–${quietHours.end})`,
      meta: { messageId: draftRow.id },
    });
    broadcast({ type: 'message:new', data: { id: draftRow.id, status: 'AWAITING_APPROVAL' } });
    await recomputeCounters(account.userId);
    return;
  }

  try {
    const result = await sendOutbound({
      account,
      recipientId: inbound.conversationKey.split(':').slice(1).join(':'),
      text: draft.text,
      source: inbound.source === 'COMMENT' ? 'COMMENT' : 'MESSAGE',
      replyExternalId: inbound.replyToExternalId || undefined,
    });
    await prisma.message.update({
      where: { id: draftRow.id },
      data: { status: 'AUTO_SENT', sentAt: new Date(), externalId: result.messageId },
    });
    await prisma.message.update({ where: { id: inbound.id }, data: { status: 'REPLIED' } });
    await logEvent({
      level: 'success',
      message: `Auto-reply sent to ${inbound.sender}`,
      meta: { messageId: draftRow.id, model: draft.model, latencyMs: draft.latencyMs },
    });
    broadcast({ type: 'message:updated', data: { id: draftRow.id, status: 'AUTO_SENT' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.message.update({
      where: { id: draftRow.id },
      data: { status: 'FAILED', error: message },
    });
    await logEvent({ level: 'error', message: `Auto-reply to ${inbound.sender} failed: ${message}` });
    broadcast({ type: 'message:updated', data: { id: draftRow.id, status: 'FAILED' } });
  }
  await recomputeCounters(account.userId);
}

/**
 * One parsed inbound item → matched account → dedupe → persist → reply pipeline.
 * Shared by Cloud API webhooks and linked-device (pairing code) sessions.
 */
export async function processInboundItem(item: InboundItem): Promise<'stored' | 'ignored' | 'duplicate'> {
  const account = await prisma.account.findFirst({
    where: { platform: item.platform, externalId: item.matchBy, status: { not: 'DISCONNECTED' } },
  });
  if (!account) {
    await logEvent({
      level: 'warn',
      message: `Inbound ${item.platform} message for unconnected account (${item.matchBy}) — ignored`,
    });
    return 'ignored';
  }

  // de-dupe by platform message id when present
  if (item.externalId) {
    const dup = await prisma.message.findFirst({
      where: { accountId: account.id, externalId: item.externalId },
    });
    if (dup) return 'duplicate';
  }

  const inbound = await prisma.message.create({
    data: {
      accountId: account.id,
      platform: item.platform,
      externalId: item.externalId,
      conversationKey: item.conversationKey,
      sender: item.senderName,
      body: item.body,
      direction: 'INBOUND',
      status: 'RECEIVED',
      source: item.source,
      replyToExternalId: item.replyExternalId,
    },
  });

  broadcast({ type: 'message:new', data: { id: inbound.id, status: inbound.status, sender: inbound.sender } });
  await runReplyPipeline(inbound.id);
  return 'stored';
}

// ── handler: process webhook delivery ──────────────────────────────────

async function handleWebhookDelivery(payload: JobPayload) {
  const deliveryId = String(payload.deliveryId || '');
  const delivery = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery || delivery.processed) return;
  const parsed = parseJson<any>(delivery.payload, {});
  const items = parseWebhookPayload(parsed);

  try {
    if (items.length === 0) {
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { processed: true, error: null },
      });
      return;
    }

    for (const item of items) {
      const outcome = await processInboundItem(item);
      if (outcome === 'ignored') {
        await logEvent({
          level: 'warn',
          message: `Webhook for unconnected ${item.platform} account (${item.matchBy}) — ignored`,
          meta: { deliveryId: delivery.id },
        });
      }
    }

    await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { processed: true } });
    await recomputeCounters('all');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { error: message } });
    throw err; // queue retries with backoff
  }
}

// ── handler: inbound item from a linked WhatsApp device (pairing flow) ──

async function handleInboundItem(payload: JobPayload) {
  const item = payload as unknown as InboundItem;
  if (!item?.platform || !item?.conversationKey || !item?.matchBy) return;
  await processInboundItem(item);
}

// ── handler: publish post (§4.5) ──────────────────────────────────────

async function handlePublishPost(payload: JobPayload) {
  const postId = String(payload.postId || '');
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) return;
  if (post.status === 'PUBLISHED') return;
  if (post.status === 'PUBLISHING' && Date.now() - post.updatedAt.getTime() < 120000) return; // in-flight

  await prisma.post.update({ where: { id: post.id }, data: { status: 'PUBLISHING' } });
  broadcast({ type: 'post:updated', data: { id: post.id, status: 'PUBLISHING' } });

  try {
    let account = post.accountId
      ? await prisma.account.findUnique({ where: { id: post.accountId } })
      : await prisma.account.findFirst({ where: { userId: post.userId, platform: post.platform, status: 'CONNECTED' } });
    if (!account || account.status === 'DISCONNECTED') {
      throw new Error(`No connected ${post.platform === 'INSTAGRAM' ? 'Instagram' : 'WhatsApp'} account — connect one in Accounts`);
    }

    let externalId: string | null = null;
    if (post.platform === 'INSTAGRAM') {
      const mediaType = (post.mediaType as 'IMAGE' | 'VIDEO' | 'NONE') || 'IMAGE';
      // username/password (private API) accounts publish through the private
      // client — the Graph publish endpoints only accept OAuth tokens and a
      // publicly reachable media URL, which these accounts have neither of.
      const res =
        account.pageId === IG_PRIVATE_MARKER
          ? await publishInstagramPrivate(account.id, {
              caption: post.caption,
              mediaUrl: post.mediaUrl,
              mediaType,
            })
          : await publishInstagram({
              igUserId: account.externalId,
              accessToken: decrypt(account.accessToken),
              caption: post.caption,
              mediaUrl: absoluteMediaUrl(post.mediaUrl),
              mediaType,
            });
      externalId = res.externalId;
    } else {
      if (!post.target) {
        throw new Error('WhatsApp publishing needs a recipient number (set it in the composer “Target” field)');
      }
      const res =
        account.phoneNumberId === PAIR_MARKER
          ? await sendPairedWhatsAppText(account.externalId, post.target, post.caption)
          : await sendWhatsAppText(
              { phoneNumberId: account.phoneNumberId || account.externalId, accessToken: decrypt(account.accessToken) },
              post.target,
              post.caption,
            );
      externalId = res.messageId;
    }

    const nextRun = post.cron ? computeNextRun(post.cron) : null;
    await prisma.post.update({
      where: { id: post.id },
      data: {
        status: post.cron && nextRun ? 'SCHEDULED' : 'PUBLISHED',
        publishedAt: new Date(),
        externalId,
        error: null,
        attempts: 0,
        ...(nextRun ? { scheduledFor: nextRun, nextRunAt: nextRun } : {}),
      },
    });
    if (post.cron && nextRun) {
      // recurring series: publish now, queue the next occurrence
      await enqueue(
        'publish:post',
        { postId: post.id },
        { delayMs: Math.max(1000, nextRun.getTime() - Date.now()), key: `publish:${post.id}:${nextRun.toISOString()}` },
      );
    }

    await logEvent({
      level: 'success',
      message: `Post published to ${post.platform === 'INSTAGRAM' ? 'Instagram' : 'WhatsApp'}${post.cron ? ' (recurring — next occurrence queued)' : ''}`,
      meta: { postId: post.id, externalId },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = post.attempts + 1;
    const canRetry = attempts < 3; // automatic retries: ~10s, ~20s then manual
    await prisma.post.update({
      where: { id: post.id },
      data: { status: 'FAILED', error: message, attempts },
    });
    await logEvent({
      level: 'error',
      message: `Publish failed (attempt ${attempts}${canRetry ? ', auto-retry queued' : ''}): ${message}`,
      meta: { postId: post.id },
    });
    if (canRetry) {
      await enqueue('publish:post', { postId: post.id }, { delayMs: 10000 * 2 ** (attempts - 1), key: `retry:${post.id}:${attempts}` });
    }
  }

  const updated = await prisma.post.findUnique({ where: { id: post.id } });
  broadcast({ type: 'post:updated', data: { id: post.id, status: updated?.status } });
}

function computeNextRun(cron: string): Date | null {
  try {
    // cron-parser v4: parseExpression(); other majors: CronExpressionParser.parse / parse
    const mod = require('cron-parser') as any;
    const parse = mod.CronExpressionParser?.parse || mod.parse || mod.parseExpression;
    const expr = parse(cron);
    return expr.next().toDate();
  } catch {
    return null;
  }
}

// ── handler: token refresh (day 50 of 60) ─────────────────────────────

async function handleRefreshToken(payload: JobPayload) {
  const accountId = String(payload.accountId || '');
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account || account.status === 'DISCONNECTED') return;
  if (account.platform !== 'INSTAGRAM') {
    // WhatsApp system-user tokens are managed in Business Suite (long-lived);
    // just re-check proximity to expiry and warn.
    warnIfExpiringSoon(account.id, account.tokenExpiresAt);
    return;
  }
  try {
    const res = await refreshLongLivedToken(decrypt(account.accessToken));
    const daysLeft = (res.expiresAt.getTime() - Date.now()) / 86400000;
    await prisma.account.update({
      where: { id: account.id },
      data: {
        accessToken: encrypt(res.token),
        tokenExpiresAt: res.expiresAt,
        status: daysLeft <= 7 ? 'TOKEN_EXPIRING' : 'CONNECTED',
      },
    });
    await logEvent({
      level: 'success',
      message: `Instagram token refreshed for ${account.label} (expires ${res.expiresAt.toISOString().slice(0, 10)})`,
      meta: { accountId: account.id },
    });
    broadcast({ type: 'account:updated', data: { id: account.id } });
    scheduleTokenRefresh(account.id, res.expiresAt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.account.update({ where: { id: account.id }, data: { status: 'TOKEN_EXPIRING' } });
    await logEvent({ level: 'error', message: `Token refresh failed for ${account.label}: ${message}` });
    broadcast({ type: 'account:updated', data: { id: account.id, status: 'TOKEN_EXPIRING' } });
    // retry in 6 hours
    scheduleTokenRefresh(account.id, new Date(Date.now() + 6 * 3600 * 1000));
  }
}

async function warnIfExpiringSoon(accountId: string, expiresAt: Date | null) {
  if (!expiresAt) return;
  const days = (expiresAt.getTime() - Date.now()) / 86400000;
  if (days <= 7 && days > -1) {
    const acc = await prisma.account.update({
      where: { id: accountId },
      data: { status: 'TOKEN_EXPIRING' },
    });
    await logEvent({
      level: 'warn',
      message: `Token for ${acc.label} expires in ${Math.ceil(days)} days — rotate it in Meta Business Suite`,
      meta: { accountId },
    });
  }
}

export function scheduleTokenRefresh(accountId: string, expiresAt: Date) {
  // refresh at day 50 of a 60-day token (10 days before expiry), min 1 minute out
  const target = expiresAt.getTime() - 10 * 86400000;
  const delayMs = Math.max(60_000, target - Date.now());
  const runAt = new Date(Date.now() + delayMs);
  void enqueue('refresh:token', { accountId }, { delayMs, key: `refresh:${accountId}:${runAt.toISOString()}` });
}

// ── handlers: analytics sync (§4.7) ────────────────────────────────────

async function handleSyncInsights(payload: JobPayload) {
  const only = payload.accountId ? String(payload.accountId) : null;
  const accounts = await prisma.account.findMany({
    where: { platform: 'INSTAGRAM', status: { not: 'DISCONNECTED' }, ...(only ? { id: only } : {}) },
  });
  for (const account of accounts) {
    try {
      const last = await prisma.metric.findFirst({
        where: { accountId: account.id },
        orderBy: { date: 'desc' },
      });
      const since = last ? new Date(last.date.getTime() - 3 * 86400000) : new Date(Date.now() - 30 * 86400000);
      const until = new Date();
      const rows = await fetchDailyInsights(account.externalId, decrypt(account.accessToken), since, until);
      for (const row of rows) {
        const date = new Date(`${row.date}T00:00:00.000Z`);
        const values = {
          followers: row.followers,
          reach: row.reach,
          impressions: row.impressions,
          engagement: row.engagement,
        };
        await prisma.metric.upsert({
          where: { accountId_date: { accountId: account.id, date } },
          create: { accountId: account.id, date, ...values },
          update: values,
        });
      }
      if (rows.length > 0) {
        await logEvent({
          level: 'info',
          message: `Insights synced for ${account.label}: ${rows.length} day(s)`,
          meta: { accountId: account.id },
        });
      }
      broadcast({ type: 'account:updated', data: { id: account.id, insights: true } });
    } catch (err) {
      await logEvent({
        level: 'warn',
        message: `Insights sync failed for ${account.label}: ${err instanceof Error ? err.message : 'err'}`,
        meta: { accountId: account.id },
      });
    }
  }
  scheduleDailyJobs(); // self-reschedule for tomorrow
}

async function handleSyncFollowers(payload: JobPayload) {
  const accounts = await prisma.account.findMany({
    where: { platform: 'INSTAGRAM', status: { not: 'DISCONNECTED' }, ...(payload.accountId ? { id: String(payload.accountId) } : {}) },
  });
  for (const account of accounts) {
    try {
      const ids = await fetchFollowers(account.externalId, decrypt(account.accessToken));
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const previous = await prisma.followerList.findFirst({
        where: { accountId: account.id },
        orderBy: { date: 'desc' },
      });
      await prisma.followerList.upsert({
        where: { accountId_date: { accountId: account.id, date: today } },
        create: { accountId: account.id, date: today, ids: JSON.stringify(ids) },
        update: { ids: JSON.stringify(ids) },
      });
      if (previous) {
        const prevIds = new Set(parseJson<string[]>(previous.ids, []));
        const current = new Set(ids);
        const lost = [...prevIds].filter((id) => !current.has(id));
        const gained = [...current].filter((id) => !prevIds.has(id));
        for (const id of lost.slice(0, 500)) {
          const exists = await prisma.unfollower.findFirst({ where: { accountId: account.id, externalId: id } });
          if (!exists) await prisma.unfollower.create({ data: { accountId: account.id, externalId: id } });
        }
        if (lost.length > 0) {
          await logEvent({
            level: 'warn',
            message: `${account.label}: ${lost.length} follower(s) left, ${gained.length} new`,
            meta: { accountId: account.id, lost: lost.length, gained: gained.length },
          });
        }
      }
    } catch (err) {
      await logEvent({
        level: 'warn',
        message: `Follower sync failed for ${account.label}: ${err instanceof Error ? err.message : 'err'}`,
      });
    }
  }
}

async function handleSyncPostInsights(payload: JobPayload) {
  const accounts = await prisma.account.findMany({
    where: { platform: 'INSTAGRAM', status: { not: 'DISCONNECTED' }, ...(payload.accountId ? { id: String(payload.accountId) } : {}) },
  });
  for (const account of accounts) {
    const posts = await prisma.post.findMany({
      where: {
        accountId: account.id,
        platform: 'INSTAGRAM',
        status: 'PUBLISHED',
        externalId: { not: null },
        publishedAt: { gte: new Date(Date.now() - 60 * 86400000) },
      },
      take: 100,
    });
    for (const post of posts) {
      if (!post.externalId) continue;
      try {
        const ins = await fetchPostInsights(post.externalId, decrypt(account.accessToken));
        await prisma.postInsight.upsert({
          where: { postId: post.id },
          create: { postId: post.id, ...ins },
          update: { ...ins },
        });
      } catch {
        // private/insufficient-permission posts: skip quietly
      }
    }
  }
}

// ── daily scheduling ───────────────────────────────────────────────────

export function scheduleDailyJobs() {
  void enqueue('sync:insights', {}, { delayMs: nextDailyRun(6, 0).getTime() - Date.now(), key: `daily-insights:${new Date().toDateString()}` });
  void enqueue('sync:post-insights', {}, { delayMs: nextDailyRun(6, 20).getTime() - Date.now(), key: `daily-postinsights:${new Date().toDateString()}` });
  void enqueue('sync:followers', {}, { delayMs: nextDailyRun(6, 10).getTime() - Date.now(), key: `daily-followers:${new Date().toDateString()}` });
}

export function ensureTokenRefreshJobs() {
  void prisma.account
    .findMany({ where: { status: { not: 'DISCONNECTED' }, platform: 'INSTAGRAM' } })
    .then((accounts) => {
      for (const a of accounts) {
        if (a.tokenExpiresAt) scheduleTokenRefresh(a.id, a.tokenExpiresAt);
      }
    });
}

export async function startWorkers() {
  registerHandler('process:webhook', handleWebhookDelivery);
  registerHandler('process:inbound', handleInboundItem);
  registerHandler('publish:post', handlePublishPost);
  registerHandler('refresh:token', handleRefreshToken);
  registerHandler('sync:insights', handleSyncInsights);
  registerHandler('sync:followers', handleSyncFollowers);
  registerHandler('sync:post-insights', handleSyncPostInsights);

  await startQueue();
  scheduleDailyJobs();
  ensureTokenRefreshJobs();
  startInstagramInboxPolling();

  // hourly housekeeping: keep daily jobs + token refreshes queued
  const housekeeper = setInterval(() => {
    scheduleDailyJobs();
    ensureTokenRefreshJobs();
  }, 3600_000);
  housekeeper.unref?.();
}

/**
 * Private-API Instagram accounts have no webhook — poll their DM inbox on an
 * interval and enqueue anything new through the same inbound pipeline.
 */
function startInstagramInboxPolling(intervalMs = 20_000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const accounts = await prisma.account.findMany({
        where: { platform: 'INSTAGRAM', pageId: IG_PRIVATE_MARKER, status: { not: 'DISCONNECTED' } },
        select: { id: true },
      });
      for (const a of accounts) {
        await pollInstagramInbox(a.id).catch(() => 0);
      }
    } catch {
      /* DB not ready — try again next tick */
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
}
