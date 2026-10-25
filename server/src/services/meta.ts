import { config } from '../config';
import { logEvent } from './events';

const GRAPH = 'https://graph.facebook.com/v21.0';

export class MetaApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: number,
  ) {
    super(message);
  }
}

export interface MetaRequestOptions {
  token: string;
  method?: 'GET' | 'POST' | 'DELETE';
  body?: Record<string, unknown>;
  params?: Record<string, string | number | undefined>;
  /** Retry 429/5xx with exponential backoff (default true, §7) */
  retry?: boolean;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Official Graph API client with rate-limit handling:
 * 429/5xx → exponential backoff with jitter, honoring Retry-After (max 4 tries).
 * Never logs tokens.
 */
export async function metaFetch<T = any>(path: string, opts: MetaRequestOptions): Promise<T> {
  const { token, method = 'GET', body, params, retry = true } = opts;
  const maxAttempts = retry ? 4 : 1;
  let lastError: Error = new Error('Meta API request failed');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const url = new URL(`${GRAPH}/${path.replace(/^\//, '')}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    if (method === 'GET') url.searchParams.set('access_token', token);
    if (method !== 'GET' && !body?.access_token) {
      url.searchParams.set('access_token', token);
    }

    try {
      const res = await fetch(url.toString(), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      });

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const backoff = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1) + Math.random() * 300;
        lastError = new MetaApiError(`Meta ${res.status} (rate limited)`, res.status);
        if (attempt < maxAttempts) {
          await sleep(Math.min(backoff, 15000));
          continue;
        }
        throw lastError;
      }

      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new MetaApiError(`Meta returned non-JSON (${res.status})`, res.status);
      }
      if (!res.ok || json?.error) {
        const msg = json?.error?.message || `Meta API error ${res.status}`;
        throw new MetaApiError(msg, res.status, json?.error?.code);
      }
      return json as T;
    } catch (err) {
      if (err instanceof MetaApiError && err.status !== 429 && err.status < 500) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === maxAttempts) break;
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

// ── Instagram OAuth ────────────────────────────────────────────────────

export async function exchangeInstagramCode(code: string, wantedUsername?: string) {
  const { appId, appSecret, redirectUri } = config.meta;
  if (!appId || !appSecret) throw new Error('META_APP_ID / META_APP_SECRET are not configured');
  // Short-lived code → long-lived user token
  const short = await metaFetch<any>('/oauth/access_token', {
    token: appSecret,
    params: {
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code,
    },
    retry: false,
  });
  return finishInstagramConnect(short.access_token, wantedUsername);
}

/**
 * From the long-lived user token, resolve the Page + IG business account.
 * Every Page linked to the Facebook account is inspected so the account whose
 * @username the operator asked for is auto-selected (connect-by-username).
 */
export async function finishInstagramConnect(userToken: string, wantedUsername?: string) {
  const pages = await metaFetch<any>('/me/accounts', {
    token: userToken,
    params: { fields: 'id,name,access_token', limit: 100 },
  });
  if (!pages?.data?.length) {
    throw new Error(
      'No Facebook Page found. The Instagram account must be Business/Creator and linked to a Facebook Page.',
    );
  }

  const candidates: Array<{ pageId: string; pageName: string; igUserId: string; username: string }> = [];
  for (const page of pages.data) {
    const pageRes = await metaFetch<any>(`/${page.id}`, {
      token: userToken,
      params: { fields: 'id,name,instagram_business_account' },
    });
    const ig = pageRes?.instagram_business_account;
    if (!ig?.id) continue;
    const profile = await metaFetch<any>(`/${ig.id}`, {
      token: userToken,
      params: { fields: 'id,username,name' },
    });
    candidates.push({
      pageId: String(page.id),
      pageName: String(page.name || 'Facebook Page'),
      igUserId: String(ig.id),
      username: String(profile.username || profile.name || ig.id),
    });
  }
  if (candidates.length === 0) {
    throw new Error(
      'No linked Instagram Business/Creator account found on any Page of this Facebook account. Convert the Instagram profile first.',
    );
  }

  let chosen = candidates[0];
  if (wantedUsername) {
    const wanted = wantedUsername.toLowerCase();
    const hit = candidates.find((c) => c.username.toLowerCase() === wanted);
    if (!hit) {
      throw new Error(
        `@${wantedUsername} is not linked to any Facebook Page on this account. Linked accounts: ${candidates
          .map((c) => `@${c.username}`)
          .join(', ')}`,
      );
    }
    chosen = hit;
  }

  // The Page token also works for the IG account; store a long-lived token.
  const longLived = await refreshLongLivedToken(userToken);
  return {
    pageId: chosen.pageId,
    pageName: chosen.pageName,
    igUserId: chosen.igUserId,
    username: chosen.username,
    accessToken: longLived.token,
    expiresAt: longLived.expiresAt,
  };
}

/** 60-day token; returns absolute expiry. Refresh scheduled at day 50. */
export async function refreshLongLivedToken(token: string): Promise<{ token: string; expiresAt: Date }> {
  const { appSecret, appId } = config.meta;
  if (!appSecret || !appId) {
    // Local/dev without Meta app credentials: keep token, no expiry known.
    return { token, expiresAt: new Date(Date.now() + 60 * 24 * 3600 * 1000) };
  }
  const json = await metaFetch<any>('/oauth/access_token', {
    token,
    params: {
      grant_type: 'ig_exchange_token',
      client_secret: appSecret,
      access_token: token,
    },
    retry: false,
  });
  const expiresIn = Number(json?.expires_in || 60 * 24 * 3600);
  return { token: json.access_token || token, expiresAt: new Date(Date.now() + expiresIn * 1000) };
}

// ── WhatsApp Cloud API ─────────────────────────────────────────────────

export async function verifyWhatsAppNumber(phoneNumberId: string, token: string) {
  const json = await metaFetch<any>(`/${phoneNumberId}`, {
    token,
    params: { fields: 'id,display_phone_number,verified_name,status' },
    retry: false,
  });
  if (!json?.id) throw new Error('Phone number ID not found for this token');
  return {
    phoneNumberId: String(json.id),
    display: String(json.verified_name || json.display_phone_number || json.id),
    displayPhone: String(json.display_phone_number || ''),
  };
}

export async function registerWebhookSubscription(params: { callbackUrl: string; verifyToken: string }) {
  const { appId, appSecret } = config.meta;
  if (!appId || !appSecret) throw new Error('META_APP_ID / META_APP_SECRET are not configured');
  return metaFetch<any>(`/${appId}/subscriptions`, {
    token: appSecret,
    method: 'POST',
    body: {
      object: 'whatsapp',
      callback_url: params.callbackUrl,
      verify_token: params.verifyToken,
      access_token: appSecret,
    },
    retry: false,
  });
}

export async function sendWhatsAppText(account: { phoneNumberId: string; accessToken: string }, to: string, text: string) {
  const json = await metaFetch<any>(`/${account.phoneNumberId}/messages`, {
    token: account.accessToken,
    method: 'POST',
    body: {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { preview_url: false, body: text },
    },
    retry: false, // never double-send a message on retry
  });
  const id = json?.messages?.[0]?.id;
  return { messageId: id ? String(id) : null };
}

/** Reply to an Instagram comment via the official Graph API. */
export async function replyToInstagramComment(commentId: string, accessToken: string, message: string) {
  const json = await metaFetch<any>(`/${commentId}/replies`, {
    token: accessToken,
    method: 'POST',
    body: { message },
    retry: false,
  });
  return { messageId: json?.id ? String(json.id) : null };
}

/** Instagram Messaging API (DM) send. Requires the Instagram Messaging product. */
export async function sendInstagramDm(igUserId: string, accessToken: string, recipientId: string, text: string) {
  const json = await metaFetch<any>(`/${igUserId}/messages`, {
    token: accessToken,
    method: 'POST',
    body: { recipient: { id: recipientId }, message: { text } },
    retry: false,
  });
  const id = json?.message_id || json?.messages?.[0]?.id || json?.id;
  return { messageId: id ? String(id) : null };
}

// ── Instagram publishing (§4.5 official /media + /media_publish) ───────

export interface PublishInput {
  igUserId: string;
  accessToken: string;
  caption: string;
  mediaUrl?: string | null;
  mediaType?: 'IMAGE' | 'VIDEO' | 'NONE';
}

export async function publishInstagram(input: PublishInput): Promise<{ externalId: string }> {
  const { igUserId, accessToken, caption, mediaUrl, mediaType } = input;

  if (!mediaUrl || mediaType === 'NONE') {
    // Text-only posts are not supported by the Graph API for IG — publish
    // requires media. Surface a clear error instead of pretending success.
    throw new MetaApiError(
      'Instagram publishing requires media (the Graph API has no text-only endpoint). Attach an image or video with a publicly reachable URL.',
      400,
    );
  }

  const container: any = await metaFetch(`/${igUserId}/media`, {
    token: accessToken,
    method: 'POST',
    body:
      mediaType === 'VIDEO'
        ? { media_type: 'VIDEO', video_url: mediaUrl, caption, share_to_feed: true }
        : { image_url: mediaUrl, caption },
    retry: false,
  });
  const creationId = container?.id;
  if (!creationId) throw new MetaApiError('Media container was not created', 400);

  // Poll container until FINISHED (videos need transcode time)
  for (let i = 0; i < 30; i++) {
    const status = await metaFetch<any>(`/${creationId}`, {
      token: accessToken,
      params: { fields: 'status_code' },
      retry: false,
    });
    if (status.status_code === 'FINISHED') break;
    if (status.status_code === 'ERROR') {
      throw new MetaApiError('Instagram rejected the media container (unsupported media or URL unreachable)', 400);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  const published = await metaFetch<any>(`/${igUserId}/media_publish`, {
    token: accessToken,
    method: 'POST',
    body: { creation_id: creationId },
    retry: false,
  });
  return { externalId: String(published?.id || creationId) };
}

// ── Insights (§4.7) ────────────────────────────────────────────────────

export interface DailyMetric {
  date: string;
  followers: number;
  reach: number;
  impressions: number;
  engagement: number;
}

export async function fetchDailyInsights(igUserId: string, accessToken: string, since: Date, until: Date): Promise<DailyMetric[]> {
  const sinceTs = Math.floor(since.getTime() / 1000);
  const untilTs = Math.floor(until.getTime() / 1000);
  const json = await metaFetch<any>(`/${igUserId}/insights`, {
    token: accessToken,
    params: {
      metric: 'impressions,reach,engagement,follower_count',
      period: 'day',
      since: sinceTs,
      until: untilTs,
    },
  });
  const byDate = new Map<string, DailyMetric>();
  const put = (values: any[], key: keyof DailyMetric) => {
    for (const v of values || []) {
      const date = String(v.end_time || '').slice(0, 10);
      if (!date) continue;
      const row = byDate.get(date) || { date, followers: 0, reach: 0, impressions: 0, engagement: 0 };
      (row as any)[key] = Number(v.value || 0);
      byDate.set(date, row);
    }
  };
  for (const metric of json?.data || []) {
    if (metric.name === 'impressions') put(metric.values, 'impressions');
    if (metric.name === 'reach') put(metric.values, 'reach');
    if (metric.name === 'engagement') put(metric.values, 'engagement');
    if (metric.name === 'follower_count') put(metric.values, 'followers');
  }
  // Carry last known follower count forward for gaps
  const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  let lastFollowers = 0;
  for (const row of rows) {
    if (row.followers === 0) row.followers = lastFollowers;
    else lastFollowers = row.followers;
  }
  return rows;
}

export async function fetchFollowers(igUserId: string, accessToken: string): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < 40; page++) {
    const json: any = await metaFetch(`/${igUserId}/followers`, {
      token: accessToken,
      params: { fields: 'id', limit: 200, ...(after ? { after } : {}) },
      retry: true,
    });
    for (const d of json?.data || []) ids.push(String(d.id));
    after = json?.paging?.cursors?.after;
    if (!after || !json?.data?.length) break;
  }
  return ids;
}

export async function fetchPostInsights(externalId: string, accessToken: string) {
  const json = await metaFetch<any>(`/${externalId}/insights`, {
    token: accessToken,
    params: { metric: 'likes,comments,shares,saves,reach' },
    retry: false,
  });
  const out = { likes: 0, comments: 0, shares: 0, saves: 0, reached: 0 };
  for (const m of json?.data || []) {
    if (m.name in out) (out as any)[m.name] = Number(m.values?.[0]?.value || 0);
  }
  return out;
}

export async function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): Promise<boolean> {
  const secret = config.meta.appSecretForWebhooks;
  if (!secret) return false;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const crypto = await import('crypto');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signatureHeader.slice('sha256='.length);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
  } catch {
    return false;
  }
}

export async function noteMetaError(scope: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  await logEvent({ level: 'error', message: `${scope}: ${message}` });
}
