import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChatCircleDots,
  MagnifyingGlass,
  InstagramLogo,
  WhatsappLogo,
  Sparkle,
  PaperPlaneTilt,
  X,
  ShieldWarning,
} from '@phosphor-icons/react';
import { api } from '../lib/api';
import { useStore, pushToast, bumpRev } from '../lib/store';
import { relTime } from '../lib/format';
import { analytics } from '../lib/analytics';
import {
  Page,
  GlassCard,
  Button,
  Badge,
  StatusBadge,
  Spinner,
  EmptyState,
  Textarea,
} from '../components/ui';
import type { Conversation, Message } from '../lib/types';

const PlatformIcon = ({ platform, size = 15 }: { platform: string; size?: number }) =>
  platform === 'WHATSAPP' ? (
    <WhatsappLogo size={size} className="text-emerald-300" />
  ) : (
    <InstagramLogo size={size} className="text-pink-300" />
  );

/**
 * Inbox (§4.3): inbound pipeline destination. Every outbound action requires
 * explicit approval unless auto-reply is enabled per account.
 */
export function Inbox() {
  const { rev } = useStore();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [thread, setThread] = useState<Message[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editText, setEditText] = useState<string | null>(null);

  const loadConversations = useCallback(async () => {
    try {
      const r = await api<{ conversations: Conversation[] }>('/messages/conversations');
      setConversations(r.conversations);
      if (!active && r.conversations.length > 0) setActive(r.conversations[0].conversationKey);
    } catch {
      /* surfaced via toast on action failures */
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadThread = useCallback(async (key: string) => {
    setThreadLoading(true);
    try {
      const r = await api<{ messages: Message[] }>(`/messages/thread/${encodeURIComponent(key)}`);
      setThread(r.messages);
    } finally {
      setThreadLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations, rev]);

  useEffect(() => {
    if (active) void loadThread(active);
  }, [active, loadThread, rev]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.sender.toLowerCase().includes(q) || c.lastBody.toLowerCase().includes(q));
  }, [conversations, query]);

  const generateDraft = async (msg: Message) => {
    setDrafting(msg.id);
    try {
      await api(`/messages/${msg.id}/draft`, { method: 'POST' });
      pushToast('success', 'Draft generated', 'Review and approve to send');
      bumpRev();
      if (active) void loadThread(active);
      void loadConversations();
    } catch (err) {
      pushToast('error', 'Draft failed', err instanceof Error ? err.message : '');
    } finally {
      setDrafting(null);
    }
  };

  const approve = async (draft: Message) => {
    setBusyId(draft.id);
    try {
      const body = editText && editText.trim() ? editText.trim() : undefined;
      await api(`/messages/${draft.id}/approve`, { method: 'POST', body: { body } });
      analytics.trackReplyApproved(draft.platform, Boolean(body));
      pushToast('success', 'Reply sent', 'Audit entry written');
      setEditText(null);
      bumpRev();
      if (active) void loadThread(active);
      void loadConversations();
    } catch (err) {
      pushToast('error', 'Send failed', err instanceof Error ? err.message : '');
    } finally {
      setBusyId(null);
    }
  };

  const dismiss = async (msg: Message) => {
    setBusyId(msg.id);
    try {
      await api(`/messages/${msg.id}/dismiss`, { method: 'POST' });
      pushToast('info', 'Dismissed');
      bumpRev();
      if (active) void loadThread(active);
    } catch (err) {
      pushToast('error', 'Could not dismiss', err instanceof Error ? err.message : '');
    } finally {
      setBusyId(null);
    }
  };

  const pendingInbound = thread.filter((m) => m.direction === 'INBOUND' && m.status === 'RECEIVED');
  const activeConv = conversations.find((c) => c.conversationKey === active);

  return (
    <Page className="h-[calc(100vh-140px)]">
      <div className="grid h-full grid-cols-[320px_1fr] gap-4 max-[900px]:grid-cols-1">
        {/* Conversation rail */}
        <GlassCard className="flex max-h-full flex-col overflow-hidden">
          <div className="border-b border-white/[0.07] p-3.5">
            <div className="relative">
              <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search conversations…"
                className="field !pl-9 !text-sm"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {loading && (
              <div className="flex justify-center py-10">
                <Spinner size={18} />
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <EmptyState
                icon={ChatCircleDots}
                title="No conversations yet"
                body="Inbound DMs and comments appear here within seconds of Meta delivering the webhook."
              />
            )}
            {filtered.map((c) => {
              const isActive = c.conversationKey === active;
              return (
                <button
                  key={c.conversationKey}
                  onClick={() => setActive(c.conversationKey)}
                  className={`mb-1 flex w-full items-start gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors ${
                    isActive ? 'border border-violet-400/40 bg-violet-500/15' : 'border border-transparent hover:bg-white/5'
                  }`}
                >
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/5">
                    <PlatformIcon platform={c.platform} size={14} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-slate-200">{c.sender}</span>
                      <span className="shrink-0 text-[10px] text-slate-500">{relTime(c.lastAt)}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <span className="truncate text-xs text-slate-500">{c.lastBody}</span>
                      {c.unread > 0 && (
                        <span className="ml-auto flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-amber-400/20 px-1 text-[10px] font-bold text-amber-300">
                          {c.unread}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </GlassCard>

        {/* Thread */}
        <GlassCard className="flex max-h-full flex-col overflow-hidden">
          {!active ? (
            <EmptyState
              icon={ChatCircleDots}
              title="Select a conversation"
              body="Replies are drafted by your configured AI provider and held for approval by default."
            />
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-5 py-3.5">
                <div className="flex items-center gap-2.5">
                  <PlatformIcon platform={activeConv?.platform || 'INSTAGRAM'} size={17} />
                  <div>
                    <div className="font-display text-sm font-semibold text-white">{activeConv?.sender || active}</div>
                    <div className="text-[11px] text-slate-500">
                      {activeConv?.accountLabel} · {activeConv?.platform}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone="violet">human-in-the-loop</Badge>
                  <Link to="/settings" className="btn-ghost inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs">
                    <ShieldWarning size={13} /> Blocklist
                  </Link>
                </div>
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
                {threadLoading && (
                  <div className="flex justify-center py-6">
                    <Spinner size={18} />
                  </div>
                )}
                {thread.map((m) => {
                  const outbound = m.direction === 'OUTBOUND';
                  return (
                    <div key={m.id} className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[76%] ${outbound ? 'items-end' : 'items-start'}`}>
                        {/* message bubble */}
                        <div
                          className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                            outbound
                              ? 'border border-violet-400/30 bg-violet-500/15 text-slate-100'
                              : 'border border-white/[0.07] bg-white/[0.05] text-slate-200'
                          } ${m.status === 'AWAITING_APPROVAL' ? 'border-dashed border-amber-400/50 bg-amber-500/[0.07]' : ''} ${
                            m.status === 'DISMISSED' ? 'opacity-40' : ''
                          }`}
                        >
                          <div className="whitespace-pre-wrap break-words">{m.body}</div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                            <span>{outbound ? 'you' : m.sender}</span>
                            <span>{relTime(m.createdAt)}</span>
                            {m.aiGenerated && (
                              <span className="flex items-center gap-1 text-violet-300">
                                <Sparkle size={9} /> {m.aiModel}
                                {m.latencyMs ? ` · ${m.latencyMs}ms` : ''}
                              </span>
                            )}
                            {m.status === 'BLOCKED' && <Badge tone="red">blocklisted — manual only</Badge>}
                            {outbound && m.status !== 'AWAITING_APPROVAL' && <StatusBadge status={m.status} />}
                          </div>
                        </div>

                        {/* draft action row */}
                        {m.status === 'AWAITING_APPROVAL' && (
                          <div className="mt-2 rounded-[12px] border border-amber-400/30 bg-amber-500/[0.06] p-3">
                            <div className="mb-2 flex items-center justify-between">
                              <span className="label !text-amber-300">Awaiting your approval</span>
                              <StatusBadge status={m.status} />
                            </div>
                            <Textarea
                              value={editText !== null ? editText : m.body}
                              onChange={(e) => setEditText(e.target.value)}
                              onFocus={() => editText === null && setEditText(m.body)}
                              className="!min-h-[70px] !text-sm"
                            />
                            <div className="mt-2 flex gap-2">
                              <Button
                                onClick={() => approve(m)}
                                loading={busyId === m.id}
                                className="!px-3 !py-1.5 !text-xs"
                              >
                                <PaperPlaneTilt size={13} /> Approve & send
                              </Button>
                              <Button
                                variant="ghost"
                                onClick={() => void dismiss(m)}
                                disabled={busyId === m.id}
                                className="!px-3 !py-1.5 !text-xs"
                              >
                                <X size={13} /> Dismiss
                              </Button>
                              <button
                                onClick={() => setEditText(null)}
                                className="ml-auto text-[11px] text-slate-500 hover:text-slate-300"
                              >
                                reset edit
                              </button>
                            </div>
                          </div>
                        )}

                        {/* inbound action row */}
                        {!outbound && m.status === 'RECEIVED' && (
                          <div className="mt-2 flex gap-2">
                            <Button
                              onClick={() => void generateDraft(m)}
                              loading={drafting === m.id}
                              variant="ghost"
                              className="!px-3 !py-1.5 !text-xs"
                            >
                              <Sparkle size={13} /> Draft AI reply
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() => void dismiss(m)}
                              disabled={busyId === m.id}
                              className="!px-3 !py-1.5 !text-xs"
                            >
                              <X size={13} /> No reply needed
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {pendingInbound.length > 0 && (
                  <div className="rounded-[10px] border border-amber-400/20 bg-amber-500/[0.05] px-3 py-2 text-center text-[11px] text-amber-200">
                    {pendingInbound.length} message{pendingInbound.length === 1 ? '' : 's'} awaiting review — auto-reply is off for
                    this account
                  </div>
                )}
              </div>
            </>
          )}
        </GlassCard>
      </div>
    </Page>
  );
}
