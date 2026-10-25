import { useEffect, useState, type FormEvent } from 'react';
import { InstagramLogo, WhatsappLogo, PlugsConnected, WarningCircle, Trash, ArrowRight, Paperclip, CaretDown } from '@phosphor-icons/react';
import { api } from '../lib/api';
import { useStore, pushToast, bumpRev } from '../lib/store';
import { relTime } from '../lib/format';
import {
  Page,
  PageHeader,
  GlassCard,
  Stagger,
  StaggerItem,
  Button,
  Badge,
  Field,
  Input,
  Toggle,
  EmptyState,
  Spinner,
} from '../components/ui';
import { InstagramConnect } from '../components/InstagramConnect';
import { WhatsAppPairing } from '../components/WhatsAppPairing';
import type { Account } from '../lib/types';
import { analytics } from '../lib/analytics';

export function Accounts() {
  const { rev } = useStore();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [metaConfigured, setMetaConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [waId, setWaId] = useState('');
  const [waToken, setWaToken] = useState('');
  const [waBusy, setWaBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ accounts: Account[]; metaConfigured: boolean }>('/accounts')
      .then((r) => {
        setAccounts(r.accounts);
        setMetaConfigured(r.metaConfigured);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [rev]);

  // The OAuth round-trip lands here with ?connected=instagram — the real
  // "channel connected" moment. The param is consumed so a reload can't double count.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected') !== 'instagram') return;
    analytics.trackChannelConnected('instagram');
    params.delete('connected');
    const qs = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
  }, []);

  const connectWhatsApp = async (e: FormEvent) => {
    e.preventDefault();
    setWaBusy(true);
    setError(null);
    try {
      await api('/accounts/whatsapp', {
        method: 'POST',
        body: { phoneNumberId: waId.trim(), accessToken: waToken.trim() },
      });
      pushToast('success', 'WhatsApp Business connected');
      setWaId('');
      setWaToken('');
      bumpRev();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setWaBusy(false);
    }
  };

  const toggleAutoReply = async (account: Account, value: boolean) => {
    if (value) {
      const ok = window.confirm(
        `Enable auto-reply for ${account.label}?\n\nThe AI will send replies without review. Blocklist and quiet hours still apply, and every action is audited.`,
      );
      if (!ok) return;
    }
    try {
      await api(`/accounts/${account.id}`, { method: 'PATCH', body: { autoReplyEnabled: value } });
      pushToast(value ? 'warn' : 'info', `Auto-reply ${value ? 'enabled' : 'disabled'} for ${account.label}`);
      bumpRev();
    } catch (err) {
      pushToast('error', 'Could not update', err instanceof Error ? err.message : '');
    }
  };

  const disconnect = async (account: Account) => {
    if (!window.confirm(`Disconnect ${account.label}? Outbound actions stop immediately; history is kept.`)) return;
    try {
      await api(`/accounts/${account.id}`, { method: 'DELETE' });
      pushToast('info', 'Account disconnected', account.label);
      bumpRev();
    } catch (err) {
      pushToast('error', 'Disconnect failed', err instanceof Error ? err.message : '');
    }
  };

  const registerWebhooks = async () => {
    try {
      const { callbackUrl } = await api<{ callbackUrl: string }>('/accounts/webhooks/register', { method: 'POST' });
      pushToast('success', 'Webhook subscription registered', callbackUrl);
    } catch (err) {
      pushToast('error', 'Webhook registration failed', err instanceof Error ? err.message : '');
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <Spinner size={22} />
      </div>
    );
  }

  const live = accounts.filter((a) => a.status !== 'DISCONNECTED');

  return (
    <Page>
      <PageHeader
        title="Accounts"
        subtitle="Official Meta APIs only — OAuth for Instagram, Cloud API for WhatsApp."
        actions={
          <Button variant="ghost" onClick={registerWebhooks}>
            <Paperclip size={15} /> Register webhook URL
          </Button>
        }
      />

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-[10px] border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <WarningCircle size={16} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {live.length === 0 && (
        <GlassCard className="mb-5">
          <EmptyState
            icon={PlugsConnected}
            title="Zero connected accounts — fresh instance"
            body="This is the correct first-run state: no demo or dummy accounts are ever seeded. Connect your first account below."
          />
        </GlassCard>
      )}

      <Stagger className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
        {/* Instagram card */}
        <StaggerItem>
          <GlassCard className="flex h-full flex-col p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-pink-400/30 bg-pink-500/10">
                  <InstagramLogo size={22} weight="duotone" className="text-pink-300" />
                </div>
                <div>
                  <div className="font-display text-sm font-semibold text-white">Instagram</div>
                  <div className="text-xs text-slate-500">Direct sign-in (private API) · no Meta app needed</div>
                </div>
              </div>
              {(() => {
                const ig = accounts.find((a) => a.platform === 'INSTAGRAM' && a.status !== 'DISCONNECTED');
                if (!ig) return <Badge tone="gray">not connected</Badge>;
                return (
                  <Badge tone={ig.status === 'CONNECTED' ? 'green' : ig.status === 'TOKEN_EXPIRING' ? 'amber' : 'red'}>
                    {ig.status === 'TOKEN_EXPIRING' ? 'token expiring' : ig.status.toLowerCase()}
                  </Badge>
                );
              })()}
            </div>

            <div className="mt-4 flex-1 space-y-2 text-xs text-slate-400">
              {accounts
                .filter((a) => a.platform === 'INSTAGRAM')
                .map((ig) => (
                  <div key={ig.id} className="rounded-[10px] border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm text-slate-200">{ig.label}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-500">auto-reply</span>
                        <Toggle
                          checked={ig.autoReplyEnabled}
                          onChange={(v) => void toggleAutoReply(ig, v)}
                          label={`Auto-reply for ${ig.label}`}
                        />
                      </div>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-slate-500">
                      <span>ig_id: {ig.externalId}</span>
                      {ig.pageId && <span>page: {ig.pageId}</span>}
                      {ig.tokenExpiresAt && (
                        <span className={new Date(ig.tokenExpiresAt).getTime() - Date.now() < 7 * 86400000 ? 'text-amber-300' : ''}>
                          token expires {relTime(ig.tokenExpiresAt)} ({new Date(ig.tokenExpiresAt).toISOString().slice(0, 10)})
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => void disconnect(ig)}
                        className="inline-flex items-center gap-1 text-[11px] text-red-300/80 hover:text-red-300"
                      >
                        <Trash size={11} /> disconnect
                      </button>
                    </div>
                  </div>
                ))}
              {accounts.filter((a) => a.platform === 'INSTAGRAM').length === 0 && (
                <p>
                  Connect via OAuth 2.0 — the app exchanges your code for a <strong className="text-slate-300">long-lived
                  token</strong> (60 days) and schedules an automatic refresh on day 50.
                </p>
              )}
            </div>

            <div className="mt-4">
              {!metaConfigured && (
                <div className="mb-3 rounded-[10px] border border-white/10 bg-white/[0.03] p-3 font-mono text-[11px] leading-relaxed text-slate-400">
                  <div className="mb-1 font-sans text-xs font-semibold text-amber-300">OAuth not configured yet</div>
                  Set in <span className="text-cyan-300">.env</span> then restart:
                  <div className="mt-1 text-slate-500">META_APP_ID=…</div>
                  <div className="text-slate-500">META_APP_SECRET=…</div>
                  <div className="text-slate-500">META_REDIRECT_URI={window.location.origin.replace('3001', '4000')}/api/accounts/instagram/callback</div>
                </div>
              )}
              <InstagramConnect
                connected={accounts.some((a) => a.platform === 'INSTAGRAM' && a.status !== 'DISCONNECTED')}
                metaConfigured={metaConfigured}
                onDone={() => bumpRev()}
              />
            </div>
          </GlassCard>
        </StaggerItem>

        {/* WhatsApp card */}
        <StaggerItem>
          <GlassCard className="flex h-full flex-col p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-emerald-400/30 bg-emerald-500/10">
                  <WhatsappLogo size={22} weight="duotone" className="text-emerald-300" />
                </div>
                <div>
                  <div className="font-display text-sm font-semibold text-white">WhatsApp Business</div>
                  <div className="text-xs text-slate-500">Phone number + pairing code (or Cloud API)</div>
                </div>
              </div>
              {(() => {
                const wa = accounts.find((a) => a.platform === 'WHATSAPP' && a.status !== 'DISCONNECTED');
                if (!wa) return <Badge tone="gray">not connected</Badge>;
                return (
                  <Badge tone={wa.status === 'CONNECTED' ? 'green' : wa.status === 'TOKEN_EXPIRING' ? 'amber' : 'red'}>
                    {wa.status.toLowerCase()}
                  </Badge>
                );
              })()}
            </div>

            <div className="mt-4 flex-1 space-y-2 text-xs text-slate-400">
              {accounts
                .filter((a) => a.platform === 'WHATSAPP')
                .map((wa) => (
                  <div key={wa.id} className="rounded-[10px] border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm text-slate-200">{wa.label}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-500">auto-reply</span>
                        <Toggle
                          checked={wa.autoReplyEnabled}
                          onChange={(v) => void toggleAutoReply(wa, v)}
                          label={`Auto-reply for ${wa.label}`}
                        />
                      </div>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 font-mono text-[10px] text-slate-500">
                      <span>phone_number_id: {wa.phoneNumberId || wa.externalId}</span>
                      {wa.wabaId && <span>waba: {wa.wabaId}</span>}
                    </div>
                    <div className="mt-2">
                      <button
                        onClick={() => void disconnect(wa)}
                        className="inline-flex items-center gap-1 text-[11px] text-red-300/80 hover:text-red-300"
                      >
                        <Trash size={11} /> disconnect
                      </button>
                    </div>
                  </div>
                ))}
              {accounts.filter((a) => a.platform === 'WHATSAPP').length === 0 && (
                <p>
                  Inbound messages are signature-verified with <span className="font-mono text-cyan-300">X-Hub-Signature-256</span> against your
                  APP_SECRET, then queued for processing.
                </p>
              )}
            </div>

            <div className="mt-4">
              <WhatsAppPairing
                connected={accounts.some((a) => a.platform === 'WHATSAPP' && a.status !== 'DISCONNECTED')}
                onDone={() => bumpRev()}
              />
              <details className="mt-3 rounded-[10px] border border-white/[0.07] bg-white/[0.02] p-3">
                <summary className="cursor-pointer list-none text-[11px] text-slate-500 transition-colors hover:text-slate-300">
                  <CaretDown size={11} className="mr-1 inline" /> Connect via Cloud API instead (phone number ID + token)
                </summary>
                <form onSubmit={connectWhatsApp} className="space-y-3 pt-3">
                  <Field label="Phone number ID">
                    <Input value={waId} onChange={(e) => setWaId(e.target.value)} placeholder="109876543210987" required />
                  </Field>
                  <Field label="System user access token">
                    <Input
                      type="password"
                      value={waToken}
                      onChange={(e) => setWaToken(e.target.value)}
                      placeholder="EAAB…"
                      required
                    />
                  </Field>
                  <div className="flex gap-2">
                    <Button type="submit" loading={waBusy} className="flex-1">
                      Verify & connect
                    </Button>
                  </div>
                </form>
              </details>
            </div>
          </GlassCard>
        </StaggerItem>
      </Stagger>

      <GlassCard className="mt-5 p-5">
        <div className="font-display text-sm font-semibold text-white">Webhooks</div>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
          Point your Meta app at <span className="font-mono text-cyan-300">https://&lt;your-host&gt;/webhooks/meta</span> with the
          verify token from <span className="font-mono">.env (VERIFY_TOKEN)</span>. Every POST is signature-checked before it is
          accepted; invalid signatures are rejected with 401 and audited. Set <span className="font-mono">PUBLIC_WEBHOOK_URL</span>{' '}
          to your public https origin, then use “Register webhook URL” above for the API-driven registration.
        </p>
      </GlassCard>
    </Page>
  );
}
