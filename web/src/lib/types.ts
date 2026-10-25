export type Platform = 'INSTAGRAM' | 'WHATSAPP';

export interface User {
  id: string;
  email: string;
  createdAt?: string;
}

export interface Account {
  id: string;
  platform: Platform;
  externalId: string;
  label: string;
  pageId: string | null;
  wabaId: string | null;
  phoneNumberId: string | null;
  status: 'CONNECTED' | 'TOKEN_EXPIRING' | 'DISCONNECTED';
  tokenExpiresAt: string | null;
  autoReplyEnabled: boolean;
  createdAt: string;
}

export interface Message {
  id: string;
  accountId: string;
  platform: Platform;
  externalId: string | null;
  conversationKey: string;
  sender: string;
  body: string;
  direction: 'INBOUND' | 'OUTBOUND';
  aiGenerated: boolean;
  aiModel: string | null;
  latencyMs: number | null;
  status:
    | 'RECEIVED'
    | 'REPLIED'
    | 'BLOCKED'
    | 'AWAITING_APPROVAL'
    | 'AUTO_SENT'
    | 'SENT'
    | 'FAILED'
    | 'DISMISSED'
    | 'HELD';
  source: string | null;
  replyToId: string | null;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
  account?: { id: string; label: string; platform: Platform; autoReplyEnabled: boolean };
}

export interface Conversation {
  conversationKey: string;
  sender: string;
  platform: Platform;
  accountId: string;
  accountLabel: string;
  lastBody: string;
  lastAt: string;
  unread: number;
  messageCount: number;
}

export interface PostInsight {
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  reached: number;
}

export interface Post {
  id: string;
  platform: Platform;
  accountId: string | null;
  caption: string;
  captionVariantB: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
  target: string | null;
  scheduledFor: string | null;
  publishedAt: string | null;
  status: 'DRAFT' | 'SCHEDULED' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED';
  externalId: string | null;
  error: string | null;
  attempts: number;
  cron: string | null;
  createdAt: string;
  account?: { id: string; label: string } | null;
}

export interface MediaAsset {
  id: string;
  filename: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  thumbnailPath: string | null;
  width: number | null;
  height: number | null;
  createdAt: string;
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  genre: string;
  coverPath: string | null;
  audioPath: string;
  durationMs: number | null;
  createdAt: string;
}

export interface EventItem {
  id: string;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
  createdAt: string;
}

export interface MetricPoint {
  date: string;
  followers: number;
  reach: number;
  impressions: number;
  engagement: number;
}

export interface HeatCell {
  day: number;
  hour: number;
  engagement: number;
  posts: number;
  avg: number;
}

export interface AppSettings {
  ai: {
    provider: 'openai' | 'anthropic' | 'ollama';
    model: string;
    tone: 'friendly' | 'professional' | 'casual';
    memoryWindow: number;
    hasKey: boolean;
    keyHint: string | null;
  };
  blocklist: string[];
  quietHours: { enabled: boolean; start: string; end: string };
  timezone: string;
  followerTracking: boolean;
}
