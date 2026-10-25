import { useEffect, useState } from 'react';
import { Sparkle, ShieldWarning, Clock, Trash, DownloadSimple, WarningCircle, X } from '@phosphor-icons/react';
import { api, downloadAuthed } from '../lib/api';
import { useStore, pushToast, bumpRev } from '../lib/store';
import {
  Page,
  PageHeader,
  GlassCard,
  Button,
  Badge,
  Field,
  Input,
  Select,
  Toggle,
  Spinner,
} from '../components/ui';
import type { AppSettings } from '../lib/types';
import { analytics } from '../lib/analytics';

type SavePatch = {
  ai?: Partial<AppSettings['ai']> & { apiKey?: string };
  blocklist?: string[];
  quietHours?: AppSettings['quietHours'];
  timezone?: string;
  followerTracking?: boolean;
};

export function Settings() {
  const { rev } = useStore();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [aiKey, setAiKey] = useState('');
  const [blockInput, setBlockInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [wipeText, setWipeText] = useState('');
  const [wipeOpen, setWipeOpen] = useState(false);
  const [analyticsConsent, setAnalyticsConsent] = useState(() => analytics.isConsentGranted());

  const load = () =>
    api<AppSettings>('/settings')
      .then(setSettings)
      .catch((e) => pushToast('error', 'Could not load settings', e.message));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);

  const save = async (patch: SavePatch, toast = true) => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (patch.ai) body.ai = { ...patch.ai, ...(aiKey ? { apiKey: aiKey } : {}) };
      if (patch.blocklist) body.blocklist = patch.blocklist;
      if (patch.quietHours) body.quietHours = patch.quietHours;
      if (patch.timezone) body.timezone = patch.timezone;
      if (patch.followerTracking !== undefined) body.followerTracking = patch.followerTracking;
      await api('/settings', { method: 'PUT', body });
      setAiKey('');
      await load();
      bumpRev();
      if (toast) pushToast('success', 'Settings saved');
    } catch (err) {
      pushToast('error', 'Save failed', err instanceof Error ? err.message : '');
    } finally {
      setSaving(false);
    }
  };

  const addBlockWord = () => {
    const w = blockInput.trim();
    if (!w || !settings) return;
    if (settings.blocklist.includes(w)) return setBlockInput('');
    void save({ blocklist: [...settings.blocklist, w] });
    setBlockInput('');
  };

  const exportData = async () => {
    try {
      await downloadAuthed('/settings/export', 'exotic-bot-export.json');
      pushToast('success', 'Data export downloaded', 'Tokens are redacted');
    } catch (err) {
      pushToast('error', 'Export failed', err instanceof Error ? err.message : '');
    }
  };

  const wipe = async () => {
    if (wipeText !== 'WIPE') return;
    try {
      await api('/settings/wipe', { method: 'POST', body: { confirm: 'WIPE' } });
      pushToast('warn', 'All data wiped', 'Accounts, messages, posts and metrics are gone');
      setWipeOpen(false);
      setWipeText('');
      bumpRev();
      void load();
    } catch (err) {
      pushToast('error', 'Wipe failed', err instanceof Error ? err.message : '');
    }
  };

  if (!settings) {
    return (
      <div className="flex justify-center py-24">
        <Spinner size={22} />
      </div>
    );
  }

  return (
    <Page>
      <PageHeader title="Settings" subtitle="AI engine, reply rules, quiet hours and data control." />

      <div className="grid grid-cols-2 gap-4 max-[1000px]:grid-cols-1">
        {/* AI provider */}
        <GlassCard className="p-5">
          <div className="mb-4 flex items-center gap-2">
            <Sparkle size={16} className="text-violet-300" />
            <div className="font-display text-sm font-semibold text-white">AI reply engine</div>
            <Badge tone={settings.ai.hasKey || settings.ai.provider === 'ollama' ? 'green' : 'amber'}>
              {settings.ai.hasKey || settings.ai.provider === 'ollama' ? 'configured' : 'key needed'}
            </Badge>
          </div>
          <div className="space-y-4">
            <Field label="Provider">
              <Select
                value={settings.ai.provider}
                onChange={(e) => void save({ ai: { provider: e.target.value as AppSettings['ai']['provider'] } }, false)}
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="ollama">Local Ollama</option>
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Model" hint="blank = provider default">
                <Input
                  value={settings.ai.model || ''}
                  onChange={(e) => setSettings({ ...settings, ai: { ...settings.ai, model: e.target.value } })}
                  placeholder="gpt-4o-mini / claude-3-5-haiku"
                  onBlur={() => void save({ ai: { model: settings.ai.model } }, false)}
                />
              </Field>
              <Field label="Reply tone">
                <Select
                  value={settings.ai.tone}
                  onChange={(e) => void save({ ai: { tone: e.target.value as AppSettings['ai']['tone'] } })}
                >
                  <option value="friendly">Friendly</option>
                  <option value="professional">Professional</option>
                  <option value="casual">Casual</option>
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Memory window" hint="last N messages kept in context">
                <Input
                  type="number"
                  min={2}
                  max={40}
                  value={settings.ai.memoryWindow}
                  onChange={(e) =>
                    setSettings({ ...settings, ai: { ...settings.ai, memoryWindow: Number(e.target.value) || 8 } })
                  }
                  onBlur={() => void save({ ai: { memoryWindow: settings.ai.memoryWindow } }, false)}
                />
              </Field>
              <Field
                label="API key"
                hint={settings.ai.keyHint ? `stored: ${settings.ai.keyHint} — encrypted at rest` : 'not set yet'}
              >
                <Input
                  type="password"
                  value={aiKey}
                  onChange={(e) => setAiKey(e.target.value)}
                  placeholder={settings.ai.keyHint ? '•••••• (leave blank to keep)' : 'paste key'}
                />
              </Field>
            </div>
            <Button loading={saving} onClick={() => void save({ ai: {} })} className="w-full">
              Save AI settings
            </Button>
          </div>
        </GlassCard>

        {/* Reply rules */}
        <GlassCard className="p-5">
          <div className="mb-4 flex items-center gap-2">
            <ShieldWarning size={16} className="text-cyan-300" />
            <div className="font-display text-sm font-semibold text-white">Reply rules</div>
            <Badge tone="violet">human-in-the-loop</Badge>
          </div>

          <div className="mb-3 rounded-[10px] border border-white/[0.07] bg-white/[0.03] px-3 py-2.5 text-xs leading-relaxed text-slate-400">
            Auto-reply stays <strong className="text-white">off per platform</strong> until enabled on the Accounts page.
            Blocklisted messages are never auto-replied — they go straight to manual review. Quiet hours hold all bot-initiated
            sends.
          </div>

          <div className="label mb-2">Keyword blocklist</div>
          <div className="mb-2 flex gap-2">
            <Input
              value={blockInput}
              onChange={(e) => setBlockInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addBlockWord();
                }
              }}
              placeholder="add a word, press Enter"
            />
            <Button variant="ghost" onClick={addBlockWord}>
              Add
            </Button>
          </div>
          {settings.blocklist.length === 0 ? (
            <p className="text-xs text-slate-600">No blocklist words yet.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {settings.blocklist.map((w) => (
                <span
                  key={w}
                  className="inline-flex items-center gap-1 rounded-full border border-red-400/30 bg-red-500/10 px-2.5 py-1 text-xs text-red-200"
                >
                  {w}
                  <button
                    aria-label={`Remove ${w}`}
                    onClick={() => void save({ blocklist: settings.blocklist.filter((x) => x !== w) })}
                    className="hover:text-white"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </GlassCard>

        {/* Quiet hours */}
        <GlassCard className="p-5">
          <div className="mb-4 flex items-center gap-2">
            <Clock size={16} className="text-amber-300" />
            <div className="font-display text-sm font-semibold text-white">Quiet hours</div>
            <Toggle
              checked={settings.quietHours.enabled}
              onChange={(v) => void save({ quietHours: { ...settings.quietHours, enabled: v } })}
              label="Quiet hours"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="From">
              <Input
                type="time"
                value={settings.quietHours.start}
                onChange={(e) =>
                  setSettings({ ...settings, quietHours: { ...settings.quietHours, start: e.target.value } })
                }
                disabled={!settings.quietHours.enabled}
              />
            </Field>
            <Field label="To">
              <Input
                type="time"
                value={settings.quietHours.end}
                onChange={(e) => setSettings({ ...settings, quietHours: { ...settings.quietHours, end: e.target.value } })}
                disabled={!settings.quietHours.enabled}
              />
            </Field>
            <Field label="Timezone">
              <Input
                value={settings.timezone}
                onChange={(e) => setSettings({ ...settings, timezone: e.target.value })}
                placeholder="Europe/Berlin"
              />
            </Field>
          </div>
          <Button
            variant="ghost"
            className="mt-3 w-full"
            loading={saving}
            onClick={() => void save({ quietHours: settings.quietHours, timezone: settings.timezone })}
          >
            Save quiet hours
          </Button>
          <p className="mt-2 text-[11px] text-slate-500">
            During quiet hours the bot performs no outbound action — replies are held as drafts for morning approval.
          </p>
        </GlassCard>

        {/* Data control */}
        <GlassCard className="p-5">
          <div className="mb-4 flex items-center gap-2">
            <Trash size={16} className="text-red-300" />
            <div className="font-display text-sm font-semibold text-white">Data control</div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-[10px] border border-white/[0.07] px-3 py-2.5">
              <div>
                <div className="text-sm text-slate-200">Anonymous product analytics</div>
                <div className="text-[11px] text-slate-500">
                  PostHog events for setup + reply approval — off until you enable it
                </div>
              </div>
              <Toggle
                checked={analyticsConsent}
                onChange={(v) => {
                  analytics.setConsent(v);
                  setAnalyticsConsent(v);
                  pushToast(v ? 'success' : 'info', v ? 'Product analytics enabled' : 'Product analytics disabled');
                }}
                label="Product analytics"
              />
            </div>

            <div className="flex items-center justify-between gap-3 rounded-[10px] border border-white/[0.07] px-3 py-2.5">
              <div>
                <div className="text-sm text-slate-200">Follower tracking (unfollower diff)</div>
                <div className="text-[11px] text-slate-500">Daily snapshot, opt-in</div>
              </div>
              <Toggle
                checked={settings.followerTracking}
                onChange={(v) => void save({ followerTracking: v })}
                label="Follower tracking"
              />
            </div>

            <Button variant="ghost" className="w-full" onClick={exportData}>
              <DownloadSimple size={15} /> Export all data (JSON, tokens redacted)
            </Button>

            <Button
              variant="ghost"
              className="w-full"
              onClick={() => {
                if (window.confirm('Disconnect ALL accounts? Content and history are kept.')) {
                  void api('/settings/disconnect-all', { method: 'POST' }).then(() => {
                    pushToast('warn', 'All accounts disconnected');
                    bumpRev();
                  });
                }
              }}
            >
              <WarningCircle size={15} /> Disconnect all accounts
            </Button>

            {!wipeOpen ? (
              <Button variant="danger" className="w-full" onClick={() => setWipeOpen(true)}>
                <Trash size={15} /> Wipe all data…
              </Button>
            ) : (
              <div className="rounded-[10px] border border-red-400/40 bg-red-500/[0.08] p-3">
                <div className="mb-2 text-xs leading-relaxed text-red-200">
                  Permanently deletes every account connection, message, post, metric, media record, track and setting. Your
                  operator login survives. This cannot be undone.
                </div>
                <div className="flex gap-2">
                  <Input value={wipeText} onChange={(e) => setWipeText(e.target.value)} placeholder='type "WIPE" to confirm' />
                  <Button variant="danger" disabled={wipeText !== 'WIPE'} onClick={() => void wipe()}>
                    Delete
                  </Button>
                </div>
                <button onClick={() => setWipeOpen(false)} className="mt-2 text-[11px] text-slate-500 hover:text-slate-300">
                  cancel
                </button>
              </div>
            )}
          </div>
        </GlassCard>
      </div>
    </Page>
  );
}
