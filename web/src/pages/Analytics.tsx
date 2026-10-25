import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChartLineUp, DownloadSimple, Trash, ArrowsClockwise, WarningCircle } from '@phosphor-icons/react';
import { api, downloadAuthed } from '../lib/api';
import { useStore, pushToast } from '../lib/store';
import { fmtNum, DAY_NAMES, heatColor, relTime } from '../lib/format';
import {
  Page,
  PageHeader,
  GlassCard,
  Stagger,
  StaggerItem,
  Button,
  Badge,
  Toggle,
  Sparkline,
  Spinner,
  EmptyState,
} from '../components/ui';
import type { HeatCell, MetricPoint } from '../lib/types';

interface Summary {
  hasInsights: boolean;
  connectedAccounts: number;
  followers: number;
  series: MetricPoint[];
  totals: { reach: number; impressions: number; engagement: number };
  postsPublished: number;
  sentToday: number;
  receivedTotal: number;
}

interface Heatmap {
  hasData: boolean;
  sampledPosts: number;
  max: number;
  cells: HeatCell[];
}

interface Unfollowers {
  enabled: boolean;
  total: number;
  snapshots: number;
  items: { id: string; externalId: string; detectedAt: string }[];
}

export function Analytics() {
  const { rev } = useStore();
  const navigate = useNavigate();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [heatmap, setHeatmap] = useState<Heatmap | null>(null);
  const [unfollowers, setUnfollowers] = useState<Unfollowers | null>(null);
  const [settingsFetched, setSettingsFetched] = useState<{ followerTracking: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, h, u, st] = await Promise.all([
        api<Summary>('/analytics/summary?days=30'),
        api<Heatmap>('/analytics/heatmap'),
        api<Unfollowers>('/analytics/unfollowers'),
        api<{ followerTracking: boolean }>('/settings'),
      ]);
      setSummary(s);
      setHeatmap(h);
      setUnfollowers(u);
      setSettingsFetched(st);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, rev]);

  const toggleTracking = async (on: boolean) => {
    try {
      await api('/settings', { method: 'PUT', body: { followerTracking: on } });
      setSettingsFetched({ followerTracking: on });
      pushToast('info', on ? 'Follower tracking enabled' : 'Follower tracking disabled', on ? 'Daily snapshots start tonight at 06:10' : '');
      setUnfollowers(on && unfollowers ? { ...unfollowers, enabled: true } : unfollowers);
    } catch (err) {
      pushToast('error', 'Could not update', err instanceof Error ? err.message : '');
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadAuthed('/analytics/export.csv', 'exotic-bot-metrics.csv');
      pushToast('success', 'CSV exported');
    } catch (err) {
      pushToast('error', 'Export failed', err instanceof Error ? err.message : '');
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <Spinner size={22} />
      </div>
    );
  }

  const series = summary?.series || [];
  const spark = (pick: (m: MetricPoint) => number) => series.map(pick);

  return (
    <Page>
      <PageHeader
        title="Analytics"
        subtitle="Every number comes from the Graph API — nothing here is simulated."
        actions={
          <>
            <Button variant="ghost" onClick={() => void exportCsv()} loading={exporting}>
              <DownloadSimple size={15} /> Export CSV
            </Button>
            <Button variant="ghost" onClick={() => navigate('/analytics/report')}>
              <ChartLineUp size={15} /> Daily report
            </Button>
          </>
        }
      />

      {/* Cards */}
      <Stagger className="grid grid-cols-4 gap-4 max-[1100px]:grid-cols-2 max-[640px]:grid-cols-1">
        {[
          { label: 'Followers', value: summary?.hasInsights ? fmtNum(summary.followers) : '—', data: spark((m) => m.followers) },
          { label: 'Reach · 30d', value: summary?.hasInsights ? fmtNum(summary.totals.reach) : '—', data: spark((m) => m.reach) },
          {
            label: 'Impressions · 30d',
            value: summary?.hasInsights ? fmtNum(summary.totals.impressions) : '—',
            data: spark((m) => m.impressions),
          },
          {
            label: 'Engagement · 30d',
            value: summary?.hasInsights ? fmtNum(summary.totals.engagement) : '—',
            data: spark((m) => m.engagement),
          },
        ].map((card) => (
          <StaggerItem key={card.label}>
            <GlassCard hover className="p-5">
              <div className="label">{card.label}</div>
              <div className="mt-1.5 font-display text-2xl font-semibold text-white">{card.value}</div>
              <div className="mt-2">
                {card.data.length >= 2 ? (
                  <Sparkline values={card.data} width={150} height={38} />
                ) : (
                  <div className="h-[38px]" />
                )}
              </div>
            </GlassCard>
          </StaggerItem>
        ))}
      </Stagger>

      {!summary?.hasInsights && (
        <GlassCard className="mt-4">
          <EmptyState
            icon={ChartLineUp}
            title="No insights synced yet"
            body="The nightly job (06:00) pulls follower_count, reach, impressions and engagement from the Instagram Graph API once an account is connected. Failed syncs are logged to the activity terminal with the exact Meta error."
            action={
              <Button variant="ghost" onClick={() => navigate('/accounts')}>
                Go to Accounts
              </Button>
            }
          />
        </GlassCard>
      )}

      {/* Heatmap */}
      <div className="mt-4 grid grid-cols-[1fr_340px] gap-4 max-[1000px]:grid-cols-1">
        <GlassCard className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="font-display text-sm font-semibold text-white">Best time to post</div>
              <div className="text-xs text-slate-500">
                engagement of published posts by day × hour (UTC){' '}
                {heatmap?.hasData ? `· ${heatmap.sampledPosts} posts sampled` : ''}
              </div>
            </div>
            <Badge tone={heatmap?.hasData ? 'cyan' : 'gray'}>{heatmap?.hasData ? 'live data' : 'no data yet'}</Badge>
          </div>

          {!heatmap?.hasData ? (
            <EmptyState
              icon={ChartLineUp}
              title="Heatmap needs published-post insights"
              body="Publish a few posts (with media) and the nightly job will pull likes/comments/shares/saves per post, bucketed by publish slot."
            />
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[640px]">
                <div className="grid grid-cols-[36px_repeat(24,1fr)] gap-1">
                  <div />
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="text-center font-mono text-[9px] text-slate-600">
                      {h % 3 === 0 ? String(h).padStart(2, '0') : ''}
                    </div>
                  ))}
                  {DAY_NAMES.map((day, d) => (
                    <div key={day} className="contents">
                      <div className="flex items-center text-[10px] text-slate-500">{day}</div>
                      {Array.from({ length: 24 }, (_, h) => {
                        const cell = heatmap.cells.find((c) => c.day === d && c.hour === h);
                        const intensity = cell && heatmap.max > 0 ? cell.avg / heatmap.max : 0;
                        return (
                          <div
                            key={`${d}-${h}`}
                            title={`${day} ${String(h).padStart(2, '0')}:00 — avg engagement ${cell?.avg || 0} across ${cell?.posts || 0} post(s)`}
                            className="h-6 rounded-[4px] transition-transform hover:scale-110"
                            style={{ background: heatColor(intensity) }}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex items-center justify-end gap-1.5 text-[10px] text-slate-500">
                  low
                  {[0.05, 0.25, 0.5, 0.75, 1].map((t) => (
                    <span key={t} className="h-3 w-6 rounded-sm" style={{ background: heatColor(t) }} />
                  ))}
                  high
                </div>
              </div>
            </div>
          )}
        </GlassCard>

        {/* Unfollower tracker */}
        <GlassCard className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="font-display text-sm font-semibold text-white">Unfollower tracker</div>
            <Toggle
              checked={settingsFetched?.followerTracking || false}
              onChange={(v) => void toggleTracking(v)}
              label="Follower tracking"
            />
          </div>
          <p className="mb-3 text-xs leading-relaxed text-slate-500">
            Opt-in: stores a daily follower-ID snapshot and diffs it. Needs <span className="font-mono">instagram_manage_insights</span>.
          </p>
          {!unfollowers?.enabled ? (
            <div className="rounded-[10px] border border-white/[0.07] bg-white/[0.03] px-3 py-4 text-center text-xs text-slate-500">
              Tracking is off — flip the toggle to start nightly snapshots.
            </div>
          ) : unfollowers.items.length === 0 ? (
            <div className="rounded-[10px] border border-emerald-400/20 bg-emerald-500/[0.07] px-3 py-4 text-center text-xs text-emerald-300">
              No unfollowers detected yet ({unfollowers.snapshots} snapshot{unfollowers.snapshots === 1 ? '' : 's'} taken)
            </div>
          ) : (
            <>
              <div className="mb-2 flex items-center gap-2">
                <Badge tone="red">{unfollowers.total} total</Badge>
                <span className="text-[10px] text-slate-600">{unfollowers.snapshots} snapshots</span>
              </div>
              <ul className="max-h-[240px] space-y-1.5 overflow-y-auto pr-1">
                {unfollowers.items.map((u) => (
                  <li
                    key={u.id}
                    className="flex items-center justify-between rounded-[10px] border border-white/[0.07] px-3 py-2 text-xs"
                  >
                    <span className="truncate font-mono text-slate-400">{u.externalId}</span>
                    <span className="shrink-0 text-slate-600">{relTime(u.detectedAt)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="mt-4 border-t border-white/[0.07] pt-3 text-[11px] text-slate-500">
            <WarningCircle size={11} className="mr-1 inline text-amber-400" />
            Opt-out anytime in Settings → data.
          </div>
        </GlassCard>
      </div>

      {/* Recent issues */}
      <GlassCard className="mt-4 p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="font-display text-sm font-semibold text-white">Sync health</div>
          <Button variant="ghost" className="!px-3 !py-1.5 !text-xs" onClick={() => void load()}>
            <ArrowsClockwise size={13} /> Refresh
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-3 text-center max-[700px]:grid-cols-1">
          <div className="rounded-[10px] border border-white/[0.07] bg-white/[0.03] p-3">
            <div className="font-display text-lg font-semibold text-white">{summary?.connectedAccounts ?? 0}</div>
            <div className="label mt-0.5">connected accounts</div>
          </div>
          <div className="rounded-[10px] border border-white/[0.07] bg-white/[0.03] p-3">
            <div className="font-display text-lg font-semibold text-white">{fmtNum(summary?.receivedTotal || 0)}</div>
            <div className="label mt-0.5">inbound messages</div>
          </div>
          <div className="rounded-[10px] border border-white/[0.07] bg-white/[0.03] p-3">
            <div className="font-display text-lg font-semibold text-white">{fmtNum(summary?.sentToday || 0)}</div>
            <div className="label mt-0.5">replies sent today</div>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 text-[11px] text-slate-600">
          <Trash size={11} /> Warnings and errors from sync jobs stream into the activity terminal.
        </div>
      </GlassCard>
    </Page>
  );
}
