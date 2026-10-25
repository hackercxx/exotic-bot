import { prisma } from '../db';
import { broadcast } from './socket';

export type EventLevel = 'info' | 'success' | 'warn' | 'error';

export interface LogEventInput {
  level?: EventLevel;
  message: string;
  meta?: Record<string, unknown>;
  userId?: string | null;
}

/**
 * Writes an immutable audit entry and streams it to connected dashboards.
 * Every outbound action, token refresh, publish result and error goes here (§7).
 */
export async function logEvent(input: LogEventInput): Promise<void> {
  try {
    const event = await prisma.event.create({
      data: {
        userId: input.userId ?? null,
        level: input.level ?? 'info',
        message: input.message,
        meta: JSON.stringify(input.meta ?? {}),
      },
    });
    broadcast({
      type: 'event:new',
      data: {
        id: event.id,
        level: event.level,
        message: event.message,
        meta: input.meta ?? {},
        createdAt: event.createdAt,
      },
    });
  } catch (err) {
    // Never let audit logging take down the request that triggered it.
    // eslint-disable-next-line no-console
    console.error('[events] failed to persist event:', err);
  }
}

export async function recomputeCounters(_userId?: string) {
  void _userId; // single-operator app: counters are global
  const [awaitingApproval, connectedAccounts, scheduled] = await Promise.all([
    prisma.message.count({ where: { status: { in: ['RECEIVED', 'AWAITING_APPROVAL'] } } }),
    prisma.account.count({ where: { status: { not: 'DISCONNECTED' } } }),
    prisma.post.count({ where: { status: 'SCHEDULED' } }),
  ]);
  broadcast({ type: 'counters', data: { awaitingApproval, connectedAccounts, scheduled } });
}
