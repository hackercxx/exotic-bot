import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChatCircleDots, PaperPlaneTilt, CalendarBlank, ChartLineUp, Sparkle, Plus, UserCircle } from '@phosphor-icons/react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { fmtNum, relTime, sparklinePath } from '../lib/format';
import { Page, PageHeader, GlassCard, Stagger, StaggerItem, Badge, Spinner, EmptyState, type IconC } from '../components/ui';
import type { Account, Post } from '../lib/types';

interface Summary {
  hasInsights: boolean;
  connectedAccounts: number;
  followers: number;
  series: { date: string; followers: number; reach: number; impressions: number; engagement: number }[];
  totals: { reach: number; impressions: number; engagement: number };
  postsPublished: number;
  sentToday: number;
  receivedTotal: number;
}

function StatCard({
  icon: Icon,
  label,
  value,
  delta,
  series,
  accent,
}: {
  icon: IconC;
  label: string;
  value: string;
  delta?: string;
  series?: number[];
  accent?: string;
}) {
  return (
    <GlassCard hover className="p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="label">{label}</div>
          <div className="mt-2 font-display text-2xl font-semibold text-white">{value}</div>
          {delta && <div className="mt-1 text-xs text-cyan-300">{delta}</div>}
        </div>
        <div
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10"
          style={{ background: `${accent || 'rgba(229,25,45,0.16)'}` }}
        >
          <Icon size={19} weight="duotone" className="text-violet-200" />
        </div>
      </div>
      {series && series.length >= 2 && (
        <div className="mt-3 h-9">
          <svg width="100%" height="36" viewBox="0 0 160 36" preserveAspectRatio="none" className="overflow-visible">
            <path d={sparklinePath(series, 160, 36)} fill="none" stroke="#FF4D5A" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
      )}
    </GlassCard>
  );
}

export function Dashboard() {
  const { counters, events, rev } = useStore();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [upcoming, setUpcoming] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, a, p] = await Promise.all([
          api<Summary>('/analytics/summary?days=30'),
          api<{ accounts: Account[] }>('/accounts'),
          api<{ posts: Post[] }>('/posts'),
        ]);
        if (cancelled) return;
        setSummary(s);
        setAccounts(a.accounts);
        setUpcoming(
          p.posts
            .filter((post) => post.status === 'SCHEDULED' || post.status === 'FAILED')
            .sort((x, y) => (x.scheduledFor || '').localeCompare(y.scheduledFor || ''))
            .slice(0, 5),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rev]);

  const followersSeries = summary?.series.map((s) => s.followers) || [];
  const reachSeries = summary?.series.map((s) => s.reach) || [];

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <Spinner size={22} />
      </div>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Dashboard"
        subtitle="Everything outbound is human-in-the-loop until you enable auto-reply."
        actions={
          <>
            <Link to="/content?compose=1" className="btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm">
              <Plus size={15} /> New post
            </Link>
            <Link to="/inbox" className="btn-ghost inline-flex items-center gap-2 px-4 py-2 text-sm">
              <ChatCircleDots size={15} /> Inbox
              {counters.pending > 0 && (
                <span className="rounded-full bg-amber-400/20 px-1.5 text-[10px] font-bold text-amber-300">
                  {counters.pending}
                </span>
              )}
            </Link>
          </>
        }
      />

      <Stagger className="grid grid-cols-4 gap-4 max-[1100px]:grid-cols-2 max-[640px]:grid-cols-1">
        <StaggerItem>
          <StatCard
            icon={ChartLineUp}
            label="Followers"
            value={summary?.hasInsights ? fmtNum(summary.followers) : '—'}
            delta={summary?.hasInsights ? 'from Graph API insights' : 'connect Instagram to sync insights'}
            series={followersSeries}
          />
        </StaggerItem>
        <StaggerItem>
          <StatCard
            icon={Sparkle}
            label="Reach · 30d"
            value={summary?.hasInsights ? fmtNum(summary.totals.reach) : '—'}
            series={reachSeries}
            accent="rgba(229,25,45,0.14)"
          />
        </StaggerItem>
        <StaggerItem>
          <StatCard
            icon={PaperPlaneTilt}
            label="Replies sent today"
            value={fmtNum(summary?.sentToday || 0)}
            delta={`${fmtNum(summary?.receivedTotal || 0)} inbound total`}
            accent="rgba(229,25,45,0.16)"
          />
        </StaggerItem>
        <StaggerItem>
          <StatCard
            icon={CalendarBlank}
            label="Posts published · 30d"
            value={fmtNum(summary?.postsPublished || 0)}
            delta={`${counters.scheduled} scheduled`}
            accent="rgba(229,25,45,0.14)"
          />
        </StaggerItem>
      </Stagger>

      <div className="mt-4 grid grid-cols-3 gap-4 max-[1100px]:grid-cols-1">
        {/* Pending approvals */}
        <StaggerItem className="col-span-1">
          <GlassCard className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="font-display text-sm font-semibold text-white">Awaiting approval</div>
              <Badge tone={counters.pending ? 'amber' : 'gray'}>{counters.pending}</Badge>
            </div>
            {counters.pending === 0 ? (
              <p className="text-xs leading-relaxed text-slate-500">
                Nothing waiting. Inbound messages land here for review whenever auto-reply is off.
              </p>
            ) : (
              <Link to="/inbox" className="btn-primary inline-flex w-full items-center justify-center gap-2 px-3 py-2 text-xs">
                Review {counters.pending} message{counters.pending === 1 ? '' : 's'}
              </Link>
            )}
            <div className="mt-4 space-y-2 border-t border-white/[0.07] pt-3">
              <div className="label">Connected accounts</div>
              {accounts.filter((a) => a.status !== 'DISCONNECTED').length === 0 ? (
                <div className="text-xs text-slate-500">
                  <Link to="/accounts" className="text-violet-300 underline-offset-2 hover:underline">
                    Connect your first account →
                  </Link>
                </div>
              ) : (
                accounts
                  .filter((a) => a.status !== 'DISCONNECTED')
                  .map((a) => (
                    <div key={a.id} className="flex items-center justify-between text-xs">
                      <span className="truncate text-slate-300">{a.label}</span>
                      <Badge tone={a.status === 'CONNECTED' ? 'green' : 'amber'}>{a.status === 'CONNECTED' ? 'live' : 'expiring'}</Badge>
                    </div>
                  ))
              )}
            </div>
          </GlassCard>
        </StaggerItem>

        {/* Upcoming / failed posts */}
        <StaggerItem className="col-span-1">
          <GlassCard className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="font-display text-sm font-semibold text-white">Schedule</div>
              <Link to="/content" className="text-xs text-cyan-300 hover:underline">
                open calendar
              </Link>
            </div>
            {upcoming.length === 0 ? (
              <p className="text-xs text-slate-500">No scheduled posts. Draft one in Content.</p>
            ) : (
              <ul className="space-y-2">
                {upcoming.map((p) => (
                  <li key={p.id} className="rounded-[10px] border border-white/[0.07] bg-white/[0.03] px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-slate-200">{p.caption.slice(0, 46) || '(no caption)'}</span>
                      <Badge tone={p.status === 'FAILED' ? 'red' : 'violet'}>{p.status.toLowerCase()}</Badge>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-slate-500">
                      {p.scheduledFor ? relTime(p.scheduledFor) : 'unscheduled'}
                      {p.cron ? ` · recurring ${p.cron}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </GlassCard>
        </StaggerItem>

        {/* Activity feed */}
        <StaggerItem className="col-span-1">
          <GlassCard className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="font-display text-sm font-semibold text-white">Activity</div>
              <UserCircle size={14} className="text-slate-500" />
            </div>
            <ul className="max-h-[240px] space-y-2 overflow-y-auto pr-1">
              {events.length === 0 && <li className="text-xs text-slate-500">No activity yet — events stream in live.</li>}
              {events.slice(0, 12).map((e) => (
                <li key={e.id} className="flex items-start gap-2 text-xs leading-relaxed">
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                      e.level === 'error'
                        ? 'bg-red-400'
                        : e.level === 'warn'
                          ? 'bg-amber-400'
                          : e.level === 'success'
                            ? 'bg-emerald-400'
                            : 'bg-cyan-400'
                    }`}
                  />
                  <span className="min-w-0 text-slate-300">
                    {e.message}
                    <span className="ml-1.5 text-slate-600">{relTime(e.createdAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </GlassCard>
        </StaggerItem>
      </div>

      {!summary?.hasInsights && (
        <div className="mt-4">
          <GlassCard className="p-5">
            <EmptyState
              icon={ChartLineUp}
              title="Analytics will populate from real Graph API data"
              body="Once an Instagram Business account is connected, the nightly insights job fills followers, reach, impressions and engagement. No demo numbers are ever seeded."
              action={
                <Link to="/accounts" className="btn-ghost inline-block px-4 py-2 text-sm">
                  Connect account
                </Link>
              }
            />
          </GlassCard>
        </div>
      )}
    </Page>
  );
}
