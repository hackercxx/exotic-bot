import { prisma } from '../db';
import { config } from '../config';
import { logEvent } from './events';

export type JobPayload = Record<string, unknown>;
export type JobHandler = (payload: JobPayload) => Promise<void>;

const handlers = new Map<string, JobHandler>();
let timer: NodeJS.Timeout | null = null;
let running = false;
let bullmq: { queue: any; worker: any } | null = null;

export function registerHandler(name: string, handler: JobHandler) {
  handlers.set(name, handler);
}

export interface EnqueueOptions {
  delayMs?: number;
  /** dedupe key: skips enqueue when a PENDING/RUNNING job with this name+key exists */
  key?: string;
}

/**
 * Durable job enqueue.
 * - memory driver (default): persisted in the Job table, survives restarts
 * - bullmq driver: BullMQ + Redis (set QUEUE_DRIVER=bullmq), same handler registry
 */
export async function enqueue(name: string, payload: JobPayload = {}, opts: EnqueueOptions = {}) {
  const delayMs = opts.delayMs ?? 0;
  const runAt = new Date(Date.now() + delayMs);

  if (opts.key) {
    const existing = await prisma.job.findFirst({
      where: { name, status: { in: ['PENDING', 'RUNNING'] }, payload: { contains: opts.key } },
    });
    if (existing) return existing.id;
  }

  if (config.queue.driver === 'bullmq' && bullmq) {
    await bullmq.queue.add(name, { payload }, { delay: delayMs, attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
    return `bullmq:${name}:${runAt.toISOString()}`;
  }

  const job = await prisma.job.create({
    data: { name, payload: JSON.stringify({ ...payload, __key: opts.key }), runAt },
  });
  return job.id;
}

/** Runs due PENDING jobs (memory driver). Exported so tests can force a tick. */
export async function runDueJobs(limit = 5): Promise<number> {
  if (running) return 0;
  running = true;
  let processed = 0;
  try {
    const due = await prisma.job.findMany({
      where: { status: 'PENDING', runAt: { lte: new Date() } },
      orderBy: { runAt: 'asc' },
      take: limit,
    });
    for (const job of due) {
      const claimed = await prisma.job.updateMany({
        where: { id: job.id, status: 'PENDING' },
        data: { status: 'RUNNING', attempts: { increment: 1 } },
      });
      if (claimed.count === 0) continue;
      processed++;

      const handler = handlers.get(job.name);
      let payload: JobPayload = {};
      try {
        payload = JSON.parse(job.payload || '{}');
      } catch {
        payload = {};
      }
      delete payload.__key;

      if (!handler) {
        await prisma.job.update({
          where: { id: job.id },
          data: { status: 'FAILED', lastError: `No handler registered for "${job.name}"` },
        });
        continue;
      }

      try {
        await handler(payload);
        await prisma.job.update({ where: { id: job.id }, data: { status: 'DONE', lastError: null } });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const attempts = job.attempts + 1;
        const maxAttempts = 3;
        if (attempts < maxAttempts) {
          const backoffMs = 5000 * 2 ** (attempts - 1);
          await prisma.job.update({
            where: { id: job.id },
            data: { status: 'PENDING', runAt: new Date(Date.now() + backoffMs), lastError: message },
          });
        } else {
          await prisma.job.update({
            where: { id: job.id },
            data: { status: 'FAILED', lastError: message },
          });
          await logEvent({
            level: 'error',
            message: `Job ${job.name} failed after ${attempts} attempts: ${message}`,
            meta: { jobId: job.id },
          });
        }
      }
    }
  } finally {
    running = false;
  }
  return processed;
}

async function initBullmq() {
  const { Queue, Worker } = await import('bullmq');
  const connection = { url: config.queue.redisUrl };
  const queue = new Queue('exotic-jobs', { connection });
  const worker = new Worker(
    'exotic-jobs',
    async (job) => {
      const handler = handlers.get(job.name);
      if (!handler) throw new Error(`No handler registered for "${job.name}"`);
      await handler((job.data as any)?.payload ?? {});
    },
    { connection, concurrency: 4 },
  );
  worker.on('failed', async (job, err) => {
    await logEvent({ level: 'error', message: `BullMQ job ${job?.name} failed: ${err.message}` });
  });
  bullmq = { queue, worker };
}

export async function startQueue() {
  if (config.queue.driver === 'bullmq') {
    try {
      await initBullmq();
      await logEvent({ level: 'info', message: 'Queue driver: bullmq (Redis)' });
    } catch (err) {
      await logEvent({
        level: 'warn',
        message: `Redis unavailable (${err instanceof Error ? err.message : 'err'}) — falling back to DB-backed queue`,
      });
    }
  } else {
    await logEvent({ level: 'info', message: 'Queue driver: memory (DB-backed jobs, no Redis needed)' });
  }
  if (!timer) timer = setInterval(() => void runDueJobs(), 1000);
  timer.unref?.();
}

export async function stopQueue() {
  if (timer) clearInterval(timer);
  timer = null;
  if (bullmq) {
    await bullmq.worker.close().catch(() => undefined);
    await bullmq.queue.close().catch(() => undefined);
    bullmq = null;
  }
}
