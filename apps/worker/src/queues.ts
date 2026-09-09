import { JOB_NAMES, QUEUE_NAMES, type JobName, type QueueName } from '@buddha/shared';
import {
  Queue,
  Worker,
  type ConnectionOptions,
  type JobsOptions,
  type Processor,
  type WorkerOptions,
} from 'bullmq';

/**
 * Queue and job names live in @buddha/shared (jobs.ts) since M5: the API is the producer of
 * `market.close` / `market.finalize` and one module keeps a renamed job from leaving it adding
 * work no worker handles. Re-exported so the worker's own modules keep one import site.
 */
export { JOB_NAMES, QUEUE_NAMES, type JobName, type QueueName };

/** Which jobs belong to which queue. */
export const QUEUE_JOBS: Record<QueueName, readonly JobName[]> = {
  markets: [JOB_NAMES.marketClose, JOB_NAMES.marketFinalize],
  audit: [JOB_NAMES.ledgerAudit],
  stats: [JOB_NAMES.marketTraderCount],
};

/**
 * PLAN 9: every job is idempotent and retried 3 times with exponential
 * backoff. Failed jobs are kept (bounded) so they can be inspected; completed
 * jobs are trimmed to keep Redis small.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 5_000 },
} as const satisfies JobsOptions;

/**
 * The per-minute safety-net scans of PLAN 5.5: the delayed job the API registers per market
 * is the fast path, and a market whose job was lost (Redis restarted, the API's best-effort
 * add failed after COMMIT) is still closed or settled within a minute. Both run the same
 * per-market transaction as the delayed job, so a scan and a delayed job for one market are
 * one close, never two (market-close.ts, market-finalize.ts).
 */
const EVERY_MINUTE = { pattern: '* * * * *', tz: 'Asia/Seoul' } as const;

/**
 * Repeatable jobs this worker installs at boot (PLAN 9). `upsertJobScheduler` is keyed by
 * id, so restarting the worker updates the schedule instead of piling up duplicates.
 */
export const JOB_SCHEDULES = [
  {
    id: 'ledger-audit-daily',
    queue: 'audit',
    name: JOB_NAMES.ledgerAudit,
    // 04:00 KST every day; BullMQ resolves the pattern in this zone, DST-free for Seoul.
    repeat: { pattern: '0 4 * * *', tz: 'Asia/Seoul' },
  },
  // No `data`: a scan is the job without a market id (marketJobDataSchema).
  { id: 'market-close-scan', queue: 'markets', name: JOB_NAMES.marketClose, repeat: EVERY_MINUTE },
  {
    id: 'market-finalize-scan',
    queue: 'markets',
    name: JOB_NAMES.marketFinalize,
    repeat: EVERY_MINUTE,
  },
] as const satisfies readonly {
  id: string;
  queue: QueueName;
  name: JobName;
  repeat: { pattern: string; tz: string };
}[];

export function createQueue(name: QueueName, connection: ConnectionOptions): Queue {
  return new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
}

export function createQueues(connection: ConnectionOptions): Record<QueueName, Queue> {
  const entries = QUEUE_NAMES.map((name) => [name, createQueue(name, connection)] as const);
  return Object.fromEntries(entries) as Record<QueueName, Queue>;
}

export function createWorker(
  name: QueueName,
  processor: Processor,
  connection: ConnectionOptions,
  opts: Omit<WorkerOptions, 'connection'> = {},
): Worker {
  return new Worker(name, processor, { concurrency: 1, ...opts, connection });
}
