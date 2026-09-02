import {
  Queue,
  Worker,
  type ConnectionOptions,
  type JobsOptions,
  type Processor,
  type WorkerOptions,
} from 'bullmq';

/** Queues consumed by this worker (PLAN 9). */
export const QUEUE_NAMES = ['markets', 'audit', 'stats'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/** Job names (PLAN 9). Producers (apps/api) must use the same strings. */
export const JOB_NAMES = {
  marketClose: 'market.close',
  marketFinalize: 'market.finalize',
  ledgerAudit: 'ledger.audit',
  marketTraderCount: 'market.trader_count',
} as const;
export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

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
