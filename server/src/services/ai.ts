import { config } from '../config';

export type AiProvider = 'openai' | 'anthropic' | 'ollama';
export type ReplyTone = 'friendly' | 'professional' | 'casual';

export interface AiSettings {
  provider: AiProvider;
  apiKey: string; // already decrypted
  model?: string;
  tone: ReplyTone;
  memoryWindow: number; // last N messages included as context
}

export interface ReplyTurn {
  sender: string;
  body: string;
  direction: 'INBOUND' | 'OUTBOUND';
}

export interface GenerateReplyInput {
  settings: AiSettings;
  platform: 'INSTAGRAM' | 'WHATSAPP';
  businessName?: string;
  history: ReplyTurn[]; // oldest → newest (excluding the turn being answered)
  inboundBody: string;
}

export interface GenerateReplyResult {
  text: string;
  model: string;
  latencyMs: number;
}

const TONE_INSTRUCTIONS: Record<ReplyTone, string> = {
  friendly: 'Warm, upbeat and conversational. Use light emoji sparingly when natural.',
  professional: 'Polite, clear and businesslike. No slang, minimal emoji.',
  casual: 'Relaxed and brief, like a real person typing on a phone.',
};

function systemPrompt(input: GenerateReplyInput): string {
  const { settings, platform, businessName } = input;
  const channel = platform === 'INSTAGRAM' ? 'Instagram' : 'WhatsApp Business';
  return [
    `You are the reply assistant for ${businessName || 'a small business'} answering messages on ${channel}.`,
    `Tone: ${TONE_INSTRUCTIONS[settings.tone]}`,
    'Rules:',
    '- Reply to the customer message only; never invent prices, stock or policies you were not told.',
    '- Keep it under 60 words unless the question needs more detail.',
    '- One clear question or next step at the end when a reply is needed.',
    '- Never reveal that you are an AI unless directly asked; then say you are the business reply assistant.',
    '- No hashtags, no promotional blasts, no unsolicited links.',
  ].join('\n');
}

function buildMessages(input: GenerateReplyInput): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const windowed = input.history.slice(-Math.max(0, input.settings.memoryWindow));
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: systemPrompt(input) },
  ];
  for (const turn of windowed) {
    if (turn.body.trim().length === 0) continue;
    messages.push({
      role: turn.direction === 'INBOUND' ? 'user' : 'assistant',
      content: turn.body,
    });
  }
  messages.push({ role: 'user', content: input.inboundBody });
  return messages;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms = 25000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractError(text: string): string {
  try {
    const json = JSON.parse(text);
    return json?.error?.message || json?.error || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

async function callOpenAI(messages: ReturnType<typeof buildMessages>, s: AiSettings) {
  const model = s.model?.trim() || 'gpt-4o-mini';
  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
    body: JSON.stringify({ model, messages, temperature: 0.6, max_tokens: 500 }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${extractError(await res.text())}`);
  const json = (await res.json()) as any;
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned an empty completion');
  return { text: String(text).trim(), model };
}

async function callAnthropic(messages: ReturnType<typeof buildMessages>, s: AiSettings) {
  const model = s.model?.trim() || 'claude-3-5-haiku-latest';
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const rest = messages.filter((m) => m.role !== 'system');
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': s.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 500, system, messages: rest, temperature: 0.6 }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${extractError(await res.text())}`);
  const json = (await res.json()) as any;
  const text = json?.content?.[0]?.text;
  if (!text) throw new Error('Anthropic returned an empty completion');
  return { text: String(text).trim(), model };
}

async function callOllama(messages: ReturnType<typeof buildMessages>, s: AiSettings) {
  const model = s.model?.trim() || config.ai.ollamaModel;
  const res = await fetchWithTimeout(`${config.ai.ollamaBaseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, options: { temperature: 0.6 } }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${extractError(await res.text())}`);
  const json = (await res.json()) as any;
  const text = json?.message?.content;
  if (!text) throw new Error('Ollama returned an empty completion');
  return { text: String(text).trim(), model };
}

/**
 * Single AI interface (§4.4): generateReply(context) → Promise<string>-ish.
 * Providers: OpenAI · Anthropic · local Ollama — selectable in Settings.
 */
export async function generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult> {
  const { settings } = input;
  if (!settings.apiKey && settings.provider !== 'ollama') {
    throw new Error(`No API key configured for ${settings.provider} — add one in Settings → AI`);
  }
  const messages = buildMessages(input);
  const started = Date.now();
  let out: { text: string; model: string };
  switch (settings.provider) {
    case 'openai':
      out = await callOpenAI(messages, settings);
      break;
    case 'anthropic':
      out = await callAnthropic(messages, settings);
      break;
    case 'ollama':
      out = await callOllama(messages, settings);
      break;
    default:
      throw new Error(`Unknown AI provider: ${settings.provider}`);
  }
  if (!out.text) throw new Error('AI returned an empty reply');
  return { text: out.text, model: out.model, latencyMs: Date.now() - started };
}
