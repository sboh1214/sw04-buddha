import { JOB_NAMES, QUEUE_NAMES, type JobName, type QueueName } from '@buddha/shared';
import {
  Queue,
  Worker,
  type ConnectionOptions,
  type JobsOptions,
  type Processor,
  type WorkerOptions,
} from 'bullmq';
import { type RedisOptions } from 'ioredis';

/**
 * Queue and job names live in @buddha/shared (jobs.ts) since M5: the API is the producer of
 * `market.close` / `market.finalize` and one module keeps a renamed job from leaving it adding
 * work no worker handles. Re-exported so the worker's own modules keep one import site.
 */
export { JOB_NAMES, QUEUE_NAMES, type JobName, type QueueName };

/**
 * The options of the ONE connection every Queue and Worker shares (main.ts builds it). Exported
 * so the constraint that shapes it is a value a test can read — main.ts has no test of its own,
 * and this is the reason the worker opens a second connection for realtime events.
 *
 * `maxRetriesPerRequest: null` is BullMQ's requirement for a connection its Workers use: a
 * blocking read must never fail because of a transient reconnect. It is also what makes this
 * connection unusable for a PUBLISH — ioredis flushes its offline queue with an error only when
 * that option is a NUMBER, so a queued command here is never rejected.
 *
 * `commandTimeout` and `socketTimeout` must NEVER be added here, tempting as it is: ioredis arms
 * the per-command timer for every command, blocking ones included, so a two-second bound would
 * reject BullMQ's BRPOPLPUSH/BZPOPMIN every two seconds and the worker would thrash. The bounds
 * live on the publisher's own connection instead (`createPublisherRedis`, realtime.ts).
 */
export const BULLMQ_REDIS_OPTIONS = {
  maxRetriesPerRequest: null,
  // Same backoff BullMQ applies to connections it creates itself (1s..20s).
  retryStrategy: (times: number) => Math.max(Math.min(Math.exp(times), 20_000), 1_000),
  connectionName: 'buddha-worker',
} as const satisfies RedisOptions;

/** Which jobs belong to which queue. */
export const QUEUE_JOBS: Record<QueueName, readonly JobName[]> = {
  markets: [JOB_NAMES.marketClose, JOB_NAMES.marketFinalize],
  audit: [JOB_NAMES.ledgerAudit],
  stats: [JOB_NAMES.marketTraderCount],
  wallet: [JOB_NAMES.startGrantPay],
  media: [JOB_NAMES.mediaOrphanCleanup],
  community: [JOB_NAMES.communityRecordsPurge],
  retention: [JOB_NAMES.retentionPurge],
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
 * The per-minute safety-net scans of PLAN 5.5: the job the API registers per market (delayed
 * to `close_at`, or immediate after the judgement — ADR-0046) is the fast path, and a market
 * whose job was lost (Redis restarted, the API's best-effort add failed after COMMIT) is still
 * closed or settled within a minute. Both run the same per-market transaction as that job, so a
 * scan and the job for one market are one close or settlement, never two (market-close.ts,
 * market-finalize.ts).
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
  // #70 (ADR-0071): the start grants that waited for an amount are paid within a minute of an
  // admin entering one. A run while the amount is undecided reads one row and stops.
  {
    id: 'start-grant-pay',
    queue: 'wallet',
    name: JOB_NAMES.startGrantPay,
    repeat: EVERY_MINUTE,
  },
  // #46 (ADR-0073): the uploads no post took within ORPHAN_MEDIA_HOURS, hourly at :17 — a day's
  // grace makes the minute of the hour immaterial, and off the hour keeps it apart from the rest.
  {
    id: 'media-orphan-cleanup',
    queue: 'media',
    name: JOB_NAMES.mediaOrphanCleanup,
    repeat: { pattern: '17 * * * *', tz: 'Asia/Seoul' },
  },
  // #187 (ADR-0083): the write limits' and the repetition rules' records older than their 24-hour
  // windows, hourly at :37 — off the hour and away from the orphan clean-up.
  {
    id: 'community-records-purge',
    queue: 'community',
    name: JOB_NAMES.communityRecordsPurge,
    repeat: { pattern: '37 * * * *', tz: 'Asia/Seoul' },
  },
  // #184 (ADR-0087): the records past their retention period, once a day at 04:30 KST — after the
  // ledger audit (04:00), in the quiet hours. A period counts in days, so the hour is immaterial,
  // and a run while every period is undecided only reads the settings and the expired holds.
  {
    id: 'retention-purge-daily',
    queue: 'retention',
    name: JOB_NAMES.retentionPurge,
    repeat: { pattern: '30 4 * * *', tz: 'Asia/Seoul' },
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
