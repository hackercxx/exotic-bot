import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth, type AuthedRequest } from '../middleware/auth';
import { getRawSetting } from '../services/settings';

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

/** Dashboard + analytics cards: last N days of real Graph API insights. */
analyticsRouter.get('/summary', async (req: AuthedRequest, res) => {
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 86400000);

  const [metrics, postCount, sentToday, receivedTotal, accounts] = await Promise.all([
    prisma.metric.findMany({
      where: { account: { userId: req.userId }, date: { gte: since } },
      orderBy: { date: 'asc' },
    }),
    prisma.post.count({ where: { userId: req.userId, status: 'PUBLISHED', publishedAt: { gte: since } } }),
    prisma.message.count({
      where: {
        direction: 'OUTBOUND',
        status: { in: ['AUTO_SENT', 'SENT'] },
        sentAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      },
    }),
    prisma.message.count({ where: { direction: 'INBOUND' } }),
    prisma.account.findMany({ where: { userId: req.userId, status: { not: 'DISCONNECTED' } } }),
  ]);

  const byDate = new Map<string, { date: string; followers: number; reach: number; impressions: number; engagement: number }>();
  for (const m of metrics) {
    const key = m.date.toISOString().slice(0, 10);
    byDate.set(key, {
      date: key,
      followers: m.followers,
      reach: m.reach,
      impressions: m.impressions,
      engagement: m.engagement,
    });
  }
  const series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const latest = series[series.length - 1] || { date: null, followers: 0, reach: 0, impressions: 0, engagement: 0 };
  const totals = series.reduce(
    (acc, r) => ({ reach: acc.reach + r.reach, impressions: acc.impressions + r.impressions, engagement: acc.engagement + r.engagement }),
    { reach: 0, impressions: 0, engagement: 0 },
  );

  res.json({
    hasInsights: series.length > 0,
    connectedAccounts: accounts.length,
    followers: latest.followers,
    series,
    totals,
    postsPublished: postCount,
    sentToday,
    receivedTotal,
  });
});

/**
 * Best-time-to-post heatmap (§4.7): day × hour grid built from the actual
 * engagement of published posts (PostInsight joined on publishedAt slot).
 */
analyticsRouter.get('/heatmap', async (req: AuthedRequest, res) => {
  const posts = await prisma.post.findMany({
    where: { userId: req.userId, status: 'PUBLISHED', publishedAt: { not: null }, platform: 'INSTAGRAM' },
    orderBy: { publishedAt: 'desc' },
    take: 400,
    include: { insight: true },
  });

  const grid: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const counts: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  let withInsights = 0;

  for (const post of posts) {
    if (!post.publishedAt) continue;
    const engagement = post.insight
      ? post.insight.likes + post.insight.comments * 2 + post.insight.shares * 3 + post.insight.saves * 4
      : 0;
    if (!post.insight) continue;
    withInsights++;
    const day = post.publishedAt.getUTCDay();
    const hour = post.publishedAt.getUTCHours();
    grid[day][hour] += engagement;
    counts[day][hour] += 1;
  }

  const cells = grid.flatMap((row, d) =>
    row.map((value, h) => ({
      day: d,
      hour: h,
      engagement: value,
      posts: counts[d][h],
      avg: counts[d][h] ? Math.round(value / counts[d][h]) : 0,
    })),
  );
  const max = Math.max(1, ...cells.map((c) => c.avg));
  res.json({
    hasData: withInsights > 0,
    sampledPosts: withInsights,
    max,
    cells,
    // Slots are UTC — the UI labels them against the operator timezone setting.
    timezoneNote: 'Heatmap slots are computed from publishedAt in UTC',
  });
});

/** Opt-in unfollower tracker (requires follower tracking enabled + insights permission). */
analyticsRouter.get('/unfollowers', async (req: AuthedRequest, res) => {
  const raw = await getRawSetting(req.userId!, 'followerTracking');
  const enabled = raw === 'true';
  if (!enabled) {
    return res.json({ enabled: false, items: [], total: 0 });
  }
  const [items, total, lists] = await Promise.all([
    prisma.unfollower.findMany({
      where: { account: { userId: req.userId } },
      orderBy: { detectedAt: 'desc' },
      take: 100,
    }),
    prisma.unfollower.count({ where: { account: { userId: req.userId } } }),
    prisma.followerList.count({ where: { account: { userId: req.userId } } }),
  ]);
  res.json({ enabled: true, items, total, snapshots: lists });
});

/** CSV export of daily metrics (§4.7). */
analyticsRouter.get('/export.csv', async (req: AuthedRequest, res) => {
  const metrics = await prisma.metric.findMany({
    where: { account: { userId: req.userId } },
    orderBy: { date: 'asc' },
    include: { account: { select: { label: true, externalId: true } } },
  });
  const header = 'date,account,followers,reach,impressions,engagement\n';
  const rows = metrics
    .map(
      (m) =>
        `${m.date.toISOString().slice(0, 10)},${JSON.stringify(m.account.label)},${m.followers},${m.reach},${m.impressions},${m.engagement}`,
    )
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="exotic-bot-metrics.csv"');
  res.send(header + rows + '\n');
});

/** Data behind the printable daily report (rendered + printed client-side). */
analyticsRouter.get('/report', async (req: AuthedRequest, res) => {
  const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
  const since = new Date(Date.now() - days * 86400000);
  const [metrics, posts, events, messages] = await Promise.all([
    prisma.metric.findMany({
      where: { account: { userId: req.userId }, date: { gte: since } },
      orderBy: { date: 'asc' },
    }),
    prisma.post.findMany({
      where: { userId: req.userId, publishedAt: { gte: since } },
      orderBy: { publishedAt: 'desc' },
      select: { id: true, caption: true, platform: true, publishedAt: true, status: true, error: true },
    }),
    prisma.event.findMany({ where: { createdAt: { gte: since }, level: { in: ['error', 'warn'] } }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.message.aggregate({
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
  ]);
  res.json({
    generatedAt: new Date().toISOString(),
    windowDays: days,
    metrics,
    posts,
    issues: events,
    messageCount: messages._count._all,
  });
});
