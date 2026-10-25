import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CalendarBlank,
  Plus,
  CaretLeft,
  CaretRight,
  ArrowsClockwise,
  Trash,
  PencilSimple,
  PaperPlaneTilt,
  Images,
  UploadSimple,
  WarningCircle,
} from '@phosphor-icons/react';
import { api, getToken, ApiError } from '../lib/api';
import { useStore, pushToast, bumpRev } from '../lib/store';
import { DAY_NAMES } from '../lib/format';
import {
  Page,
  PageHeader,
  GlassCard,
  Button,
  Badge,
  Field,
  Input,
  Textarea,
  Select,
  Modal,
  StatusBadge,
  Spinner,
  EmptyState,
} from '../components/ui';
import type { Account, MediaAsset, Post } from '../lib/types';

interface ComposerState {
  platform: 'INSTAGRAM' | 'WHATSAPP';
  accountId: string;
  caption: string;
  captionVariantB: string;
  mediaUrl: string;
  mediaType: 'IMAGE' | 'VIDEO' | 'NONE';
  target: string;
  scheduleDate: string;
  scheduleTime: string;
  cron: string;
}

const EMPTY: ComposerState = {
  platform: 'INSTAGRAM',
  accountId: '',
  caption: '',
  captionVariantB: '',
  mediaUrl: '',
  mediaType: 'NONE',
  target: '',
  scheduleDate: '',
  scheduleTime: '',
  cron: '',
};

/** Month calendar + composer (§4.5): Draft → Scheduled → Publishing → Published/Failed. */
export function Content() {
  const { rev } = useStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const [posts, setPosts] = useState<Post[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [composerOpen, setComposerOpen] = useState(searchParams.get('compose') === '1');
  const [form, setForm] = useState<ComposerState>(EMPTY);
  const [selected, setSelected] = useState<Post | null>(null);
  const [mediaPicker, setMediaPicker] = useState(false);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const from = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1).toISOString();
    const to = new Date(cursor.getFullYear(), cursor.getMonth() + 2, 0, 23, 59).toISOString();
    try {
      const [p, a, m] = await Promise.all([
        api<{ posts: Post[] }>(`/posts?from=${from}&to=${to}`),
        api<{ accounts: Account[] }>('/accounts'),
        api<{ assets: MediaAsset[] }>('/media'),
      ]);
      setPosts(p.posts);
      setAccounts(a.accounts.filter((x) => x.status !== 'DISCONNECTED'));
      setMedia(m.assets);
    } finally {
      setLoading(false);
    }
  }, [cursor]);

  useEffect(() => {
    void load();
  }, [load, rev]);

  useEffect(() => {
    if (searchParams.get('compose') === '1') {
      setComposerOpen(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const openComposer = () => {
    setForm(EMPTY);
    setError(null);
    setComposerOpen(true);
  };

  const savePost = async (mode: 'draft' | 'schedule' | 'now') => {
    setSaving(true);
    setError(null);
    try {
      const scheduledFor =
        mode === 'schedule' && form.scheduleDate && form.scheduleTime
          ? new Date(`${form.scheduleDate}T${form.scheduleTime}:00`).toISOString()
          : null;
      const body = {
        platform: form.platform,
        accountId: form.accountId || null,
        caption: form.caption.trim(),
        captionVariantB: form.captionVariantB.trim() || null,
        mediaUrl: form.mediaUrl || null,
        mediaType: form.mediaUrl ? form.mediaType : 'NONE',
        target: form.target.trim() || null,
        scheduledFor: mode === 'now' ? new Date(Date.now() + 1500).toISOString() : scheduledFor,
        cron: form.cron.trim() || null,
      };
      const res = await api<{ post: Post }>('/posts', { method: 'POST', body });
      if (mode === 'now') {
        await api(`/posts/${res.post.id}/publish-now`, { method: 'POST' });
      }
      pushToast(
        mode === 'draft' ? 'info' : 'success',
        mode === 'draft' ? 'Draft saved' : mode === 'schedule' ? 'Post scheduled' : 'Publishing…',
      );
      setComposerOpen(false);
      bumpRev();
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save post');
    } finally {
      setSaving(false);
    }
  };

  /** Upload an image/video from this device into the media library, then attach it. */
  const uploadMedia = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setUploadingMedia(true);
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch('/api/media/upload', {
          method: 'POST',
          headers: { Authorization: `Bearer ${getToken()}` },
          body: fd,
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new ApiError(data?.error || 'Upload failed', res.status);
        const asset: MediaAsset = data.asset;
        pushToast('success', 'Media uploaded', asset.filename);
        setMedia((prev) => [asset, ...prev]);
        setForm((f) => ({
          ...f,
          mediaUrl: asset.path,
          mediaType: asset.mimeType.startsWith('video') ? 'VIDEO' : 'IMAGE',
        }));
        setMediaPicker(false);
        bumpRev();
      } catch (err) {
        pushToast('error', 'Upload failed', err instanceof Error ? err.message : '');
      } finally {
        setUploadingMedia(false);
      }
    };
    input.click();
  };

  const act = async (post: Post, action: 'retry' | 'delete') => {
    try {
      if (action === 'retry') {
        await api(`/posts/${post.id}/retry`, { method: 'POST' });
        pushToast('info', 'Retry queued');
      } else {
        if (!window.confirm('Delete this post?')) return;
        await api(`/posts/${post.id}`, { method: 'DELETE' });
        pushToast('info', 'Post deleted');
        setSelected(null);
      }
      bumpRev();
      void load();
    } catch (err) {
      pushToast('error', 'Action failed', err instanceof Error ? err.message : '');
    }
  };

  // calendar grid: weeks of the cursor month
  const cells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = new Date(first);
    start.setDate(first.getDate() - first.getDay());
    const out: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      out.push(d);
    }
    return out;
  }, [cursor]);

  const postsOn = (d: Date) => {
    const key = d.toISOString().slice(0, 10);
    return posts.filter((p) => {
      if (p.scheduledFor) return new Date(p.scheduledFor).toISOString().slice(0, 10) === key;
      return p.createdAt.slice(0, 10) === key;
    });
  };

  const liveAccounts = accounts.filter((a) => a.platform === form.platform);

  return (
    <Page>
      <PageHeader
        title="Content Calendar"
        subtitle="Scheduled posts fire through the official publish endpoints with automatic retries."
        actions={
          <Button onClick={openComposer}>
            <Plus size={15} /> New post
          </Button>
        }
      />

      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            className="btn-ghost p-2"
            aria-label="Previous month"
            onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
          >
            <CaretLeft size={15} />
          </button>
          <div className="font-display text-base font-semibold text-white">
            {cursor.toLocaleString('en-US', { month: 'long', year: 'numeric' })}
          </div>
          <button
            className="btn-ghost p-2"
            aria-label="Next month"
            onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
          >
            <CaretRight size={15} />
          </button>
          <Button variant="ghost" className="!px-3 !py-1.5 !text-xs" onClick={() => setCursor(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>
            Today
          </Button>
        </div>
        <div className="flex gap-1.5 text-[10px]">
          <Badge tone="violet">scheduled</Badge>
          <Badge tone="green">published</Badge>
          <Badge tone="red">failed</Badge>
          <Badge tone="gray">draft</Badge>
        </div>
      </div>

      <GlassCard className="overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-20">
            <Spinner size={22} />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-7 border-b border-white/[0.07]">
              {DAY_NAMES.map((d) => (
                <div key={d} className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  {d}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {cells.map((d, i) => {
                const inMonth = d.getMonth() === cursor.getMonth();
                const isToday = d.toDateString() === new Date().toDateString();
                const dayPosts = postsOn(d);
                return (
                  <div
                    key={i}
                    className={`min-h-[110px] border-b border-r border-white/[0.05] p-1.5 transition-colors ${
                      inMonth ? 'bg-transparent' : 'bg-black/20'
                    } ${isToday ? 'ring-1 ring-inset ring-violet-400/40' : ''}`}
                  >
                    <div
                      className={`mb-1 px-1 text-[11px] font-medium ${
                        isToday ? 'text-violet-300' : inMonth ? 'text-slate-400' : 'text-slate-700'
                      }`}
                    >
                      {d.getDate()}
                    </div>
                    <div className="space-y-1">
                      {dayPosts.slice(0, 3).map((p) => (
                        <button
                          key={p.id}
                          onClick={() => setSelected(p)}
                          className={`block w-full truncate rounded-md border px-1.5 py-1 text-left text-[10px] leading-tight transition-transform hover:scale-[1.02] ${
                            p.status === 'PUBLISHED'
                              ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                              : p.status === 'FAILED'
                                ? 'border-red-400/30 bg-red-500/10 text-red-200'
                                : p.status === 'PUBLISHING'
                                  ? 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200'
                                  : p.status === 'SCHEDULED'
                                    ? 'border-violet-400/30 bg-violet-500/10 text-violet-200'
                                    : 'border-white/10 bg-white/5 text-slate-400'
                          }`}
                          title={p.caption}
                        >
                          {p.caption.slice(0, 30) || '(untitled)'}
                          {p.cron && <ArrowsClockwise size={9} className="ml-1 inline" />}
                        </button>
                      ))}
                      {dayPosts.length > 3 && <div className="px-1 text-[9px] text-slate-600">+{dayPosts.length - 3} more</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </GlassCard>

      {/* drafts list under the calendar */}
      {posts.filter((p) => p.status === 'DRAFT').length > 0 && (
        <GlassCard className="mt-4 p-5">
          <div className="mb-3 font-display text-sm font-semibold text-white">Drafts</div>
          <ul className="space-y-2">
            {posts
              .filter((p) => p.status === 'DRAFT')
              .map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 rounded-[10px] border border-white/[0.07] px-3 py-2">
                  <span className="truncate text-sm text-slate-300">{p.caption.slice(0, 70)}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusBadge status={p.status} />
                    <Button variant="ghost" className="!px-2.5 !py-1 !text-[11px]" onClick={() => void act(p, 'delete')}>
                      <Trash size={11} />
                    </Button>
                  </div>
                </li>
              ))}
          </ul>
        </GlassCard>
      )}

      {/* ── Composer ─────────────────────────────────────────────── */}
      <Modal open={composerOpen} onClose={() => setComposerOpen(false)} title="Compose post" wide>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Platform">
              <Select
                value={form.platform}
                onChange={(e) => setForm({ ...form, platform: e.target.value as ComposerState['platform'], accountId: '' })}
              >
                <option value="INSTAGRAM">Instagram</option>
                <option value="WHATSAPP">WhatsApp</option>
              </Select>
            </Field>
            <Field label="Account">
              <Select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
                <option value="">Default connected account</option>
                {liveAccounts
                  .filter((a) => a.platform === form.platform)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>

          <Field label="Caption">
            <Textarea
              value={form.caption}
              onChange={(e) => setForm({ ...form, caption: e.target.value })}
              placeholder="Write the caption…"
              className="!min-h-[110px]"
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="A/B variant (optional)" hint="Kept alongside the primary caption.">
              <Textarea
                value={form.captionVariantB}
                onChange={(e) => setForm({ ...form, captionVariantB: e.target.value })}
                className="!min-h-[70px]"
              />
            </Field>
            <div className="space-y-4">
              {form.platform === 'WHATSAPP' && (
                <Field label="Target (recipient number)" hint="Required — WhatsApp sends to a specific JID/number.">
                  <Input
                    value={form.target}
                    onChange={(e) => setForm({ ...form, target: e.target.value })}
                    placeholder="+15551234567"
                  />
                </Field>
              )}
              <Field label="Media">
                <div className="flex gap-2">
                  <Input
                    value={form.mediaUrl}
                    onChange={(e) => setForm({ ...form, mediaUrl: e.target.value, mediaType: e.target.value ? 'IMAGE' : 'NONE' })}
                    placeholder="/uploads/… or https://…"
                  />
                  <Button variant="ghost" type="button" onClick={() => setMediaPicker(true)} className="shrink-0">
                    <Images size={15} />
                  </Button>
                </div>
              </Field>
              <Field label="Media type">
                <Select
                  value={form.mediaType}
                  onChange={(e) => setForm({ ...form, mediaType: e.target.value as ComposerState['mediaType'] })}
                >
                  <option value="NONE">None (text only)</option>
                  <option value="IMAGE">Image</option>
                  <option value="VIDEO">Video</option>
                </Select>
              </Field>
            </div>
          </div>

          <div className="rounded-[10px] border border-white/[0.07] bg-white/[0.03] p-3.5">
            <div className="label mb-2">Schedule</div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Date">
                <Input type="date" value={form.scheduleDate} onChange={(e) => setForm({ ...form, scheduleDate: e.target.value })} />
              </Field>
              <Field label="Time">
                <Input type="time" value={form.scheduleTime} onChange={(e) => setForm({ ...form, scheduleTime: e.target.value })} />
              </Field>
              <Field label="Recurring (cron)" hint="e.g. 0 18 * * 1,3,5 = Mon/Wed/Fri 18:00">
                <Input value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} placeholder="0 18 * * 1,3,5" />
              </Field>
            </div>
          </div>

          {form.mediaType === 'NONE' && form.platform === 'INSTAGRAM' && (
            <div className="flex items-start gap-2 rounded-[10px] border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              <WarningCircle size={14} className="mt-0.5 shrink-0" />
              Instagram has no text-only publish endpoint — attach media with a publicly reachable URL for this post to publish.
            </div>
          )}

          {error && (
            <div className="rounded-[10px] border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>
          )}

          <div className="flex flex-wrap justify-end gap-2 border-t border-white/[0.07] pt-4">
            <Button variant="ghost" onClick={() => setComposerOpen(false)}>
              Cancel
            </Button>
            <Button variant="ghost" loading={saving} disabled={!form.caption.trim()} onClick={() => void savePost('draft')}>
              Save draft
            </Button>
            <Button variant="ghost" loading={saving} disabled={!form.caption.trim()} onClick={() => void savePost('schedule')}>
              <CalendarBlank size={15} /> Schedule
            </Button>
            <Button loading={saving} disabled={!form.caption.trim()} onClick={() => void savePost('now')}>
              <PaperPlaneTilt size={15} /> Publish now
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Media picker ─────────────────────────────────────────── */}
      <Modal open={mediaPicker} onClose={() => setMediaPicker(false)} title="Choose from media library" wide>
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="text-xs text-slate-500">Pick an asset below, or upload one from this device.</span>
          <Button
            variant="ghost"
            type="button"
            loading={uploadingMedia}
            onClick={uploadMedia}
            className="shrink-0 !px-3 !py-1.5 !text-xs"
          >
            <UploadSimple size={13} /> Upload image / video
          </Button>
        </div>
        {media.length === 0 ? (
          <EmptyState
            icon={Images}
            title="No media uploaded yet"
            body="Upload an image or video from this device — it is stored on this host, thumbnailed server-side, and attached to your post."
          />
        ) : (
          <div className="grid max-h-[50vh] grid-cols-4 gap-3 overflow-y-auto max-[700px]:grid-cols-2">
            {media.map((asset) => (
              <button
                key={asset.id}
                onClick={() => {
                  setForm({
                    ...form,
                    mediaUrl: asset.path,
                    mediaType: asset.mimeType.startsWith('video') ? 'VIDEO' : 'IMAGE',
                  });
                  setMediaPicker(false);
                }}
                className="group overflow-hidden rounded-[10px] border border-white/10 transition-transform hover:scale-[1.02] hover:border-violet-400/50"
              >
                {asset.mimeType.startsWith('image') ? (
                  <img
                    src={asset.thumbnailPath || asset.path}
                    alt={asset.filename}
                    className="h-24 w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-24 w-full items-center justify-center bg-white/5 text-[10px] text-slate-400">video</div>
                )}
                <div className="truncate px-1.5 py-1 text-left text-[9px] text-slate-500">{asset.filename}</div>
              </button>
            ))}
          </div>
        )}
      </Modal>

      {/* ── Post detail ──────────────────────────────────────────── */}
      <Modal open={Boolean(selected)} onClose={() => setSelected(null)} title="Post detail">
        {selected && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={selected.status} />
              <Badge tone="cyan">{selected.platform.toLowerCase()}</Badge>
              {selected.cron && <Badge tone="violet">recurring {selected.cron}</Badge>}
              {selected.attempts > 0 && <Badge tone="amber">attempt {selected.attempts}/3</Badge>}
            </div>
            <div className="whitespace-pre-wrap rounded-[10px] border border-white/[0.07] bg-white/[0.03] p-3 text-sm text-slate-200">
              {selected.caption}
            </div>
            {selected.captionVariantB && (
              <div>
                <div className="label mb-1">A/B variant B</div>
                <div className="whitespace-pre-wrap rounded-[10px] border border-white/[0.07] bg-white/[0.03] p-3 text-sm text-slate-400">
                  {selected.captionVariantB}
                </div>
              </div>
            )}
            <dl className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <dt className="label">Scheduled</dt>
                <dd className="mt-0.5 text-slate-300">
                  {selected.scheduledFor ? new Date(selected.scheduledFor).toLocaleString() : '—'}
                </dd>
              </div>
              <div>
                <dt className="label">Published</dt>
                <dd className="mt-0.5 text-slate-300">
                  {selected.publishedAt ? new Date(selected.publishedAt).toLocaleString() : '—'}
                </dd>
              </div>
              {selected.externalId && (
                <div className="col-span-2">
                  <dt className="label">External ID</dt>
                  <dd className="mt-0.5 break-all font-mono text-slate-400">{selected.externalId}</dd>
                </div>
              )}
            </dl>
            {selected.error && (
              <div className="rounded-[10px] border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {selected.error}
              </div>
            )}
            <div className="flex justify-end gap-2 border-t border-white/[0.07] pt-4">
              {selected.status === 'FAILED' && (
                <Button onClick={() => void act(selected, 'retry')}>
                  <ArrowsClockwise size={14} /> Retry
                </Button>
              )}
              {selected.status !== 'PUBLISHED' && selected.status !== 'PUBLISHING' && (
                <>
                  <Button variant="ghost" onClick={() => window.open('/settings', '_self')}>
                    <PencilSimple size={14} /> Settings
                  </Button>
                  <Button variant="danger" onClick={() => void act(selected, 'delete')}>
                    <Trash size={14} /> Delete
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </Modal>
    </Page>
  );
}
