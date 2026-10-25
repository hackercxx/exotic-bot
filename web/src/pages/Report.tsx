import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CaretLeft, DownloadSimple } from '@phosphor-icons/react';
import { api } from '../lib/api';
import { Page, GlassCard, Button, Spinner } from '../components/ui';
import type { Post } from '../lib/types';

interface ReportData {
  generatedAt: string;
  windowDays: number;
  metrics: { date: string; followers: number; reach: number; impressions: number; engagement: number }[];
  posts: Pick<Post, 'id' | 'caption' | 'platform' | 'publishedAt' | 'status' | 'error'>[];
  issues: { id: string; level: string; message: string; createdAt: string }[];
  messageCount: number;
}

/** Printable daily report (§4.7) — clean layout + window.print() → PDF. */
export function Report() {
  const navigate = useNavigate();
  const [data, setData] = useState<ReportData | null>(null);
  const [days, setDays] = useState(7);

  useEffect(() => {
    api<ReportData>(`/analytics/report?days=${days}`)
      .then(setData)
      .catch(() => setData(null));
  }, [days]);

  return (
    <Page>
      <div className="no-print mb-5 flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={() => navigate('/analytics')}>
          <CaretLeft size={14} /> Back to analytics
        </Button>
        <div className="flex items-center gap-2">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="field !w-auto !py-1.5 !text-xs">
            <option value={1}>Last 24h</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
          </select>
          <Button onClick={() => window.print()}>
            <DownloadSimple size={15} /> Print / save PDF
          </Button>
        </div>
      </div>

      {!data ? (
        <div className="flex justify-center py-20">
          <Spinner size={22} />
        </div>
      ) : (
        <GlassCard className="print-card p-8">
          <header className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-white/10 pb-4 print-plain">
            <div>
              <div className="font-display text-2xl font-semibold text-white">EXOTIC BOT — Daily Report</div>
              <div className="mt-1 text-sm text-slate-400">
                Last {data.windowDays} day{data.windowDays === 1 ? '' : 's'} · generated{' '}
                {new Date(data.generatedAt).toLocaleString()}
              </div>
            </div>
            <div className="font-mono text-xs text-slate-500">{data.messageCount} messages handled</div>
          </header>

          {/* Metrics table */}
          <section className="mb-7">
            <h2 className="label mb-2">Daily metrics (Graph API insights)</h2>
            {data.metrics.length === 0 ? (
              <p className="text-sm text-slate-500">No metric rows in this window — connect an Instagram account to populate.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs print-plain">
                  <thead>
                    <tr className="border-b border-white/10 text-slate-500">
                      <th className="py-2 pr-4 font-semibold">Date</th>
                      <th className="py-2 pr-4 font-semibold text-right">Followers</th>
                      <th className="py-2 pr-4 font-semibold text-right">Reach</th>
                      <th className="py-2 pr-4 font-semibold text-right">Impressions</th>
                      <th className="py-2 font-semibold text-right">Engagement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.metrics.map((m) => (
                      <tr key={m.date} className="border-b border-white/[0.05] text-slate-300">
                        <td className="py-1.5 pr-4 font-mono">{String(m.date).slice(0, 10)}</td>
                        <td className="py-1.5 pr-4 text-right">{m.followers}</td>
                        <td className="py-1.5 pr-4 text-right">{m.reach}</td>
                        <td className="py-1.5 pr-4 text-right">{m.impressions}</td>
                        <td className="py-1.5 text-right">{m.engagement}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Posts */}
          <section className="mb-7">
            <h2 className="label mb-2">Posts published in window</h2>
            {data.posts.length === 0 ? (
              <p className="text-sm text-slate-500">No posts published in this window.</p>
            ) : (
              <ul className="space-y-1.5 text-sm print-plain">
                {data.posts.map((p) => (
                  <li key={p.id} className="flex items-start justify-between gap-3 rounded-lg border border-white/[0.07] px-3 py-2">
                    <span className="min-w-0 truncate text-slate-300">{p.caption}</span>
                    <span className="shrink-0 font-mono text-[10px] text-slate-500">
                      {p.platform.toLowerCase()} · {p.publishedAt ? new Date(p.publishedAt).toLocaleString() : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Issues */}
          <section>
            <h2 className="label mb-2">Warnings & errors</h2>
            {data.issues.length === 0 ? (
              <p className="text-sm text-emerald-400">No warnings or errors in this window. ✓</p>
            ) : (
              <ul className="space-y-1.5 text-xs print-plain">
                {data.issues.map((i) => (
                  <li key={i.id} className="flex items-start gap-2 text-slate-400">
                    <span className={`font-mono ${i.level === 'error' ? 'text-red-400' : 'text-amber-400'}`}>
                      {i.level.toUpperCase()}
                    </span>
                    <span className="flex-1">{i.message}</span>
                    <span className="font-mono text-[10px] text-slate-600">{new Date(i.createdAt).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </GlassCard>
      )}
    </Page>
  );
}
