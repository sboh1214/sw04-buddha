import {
  UnrecoverableError,
  isNotConnectionError,
  type Processor,
  type Queue,
  type Worker,
} from 'bullmq';
import { Redis } from 'ioredis';
import { getEnv } from './env.js';
import { logger } from './logger.js';
import { createQueues, createWorker, QUEUE_NAMES } from './queues.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * M0: no job handlers exist yet. Anything that reaches a worker is unknown, and
 * unknown jobs must not be retried (UnrecoverableError bypasses the retry policy).
 */
const processor: Processor = (job) =>
  Promise.reject(
    new UnrecoverableError(
      `No handler registered for job "${job.name}" on queue "${job.queueName}"`,
    ),
  );

function describeRedis(url: string): { host: string; db: string } {
  const parsed = new URL(url);
  return { host: parsed.host, db: parsed.pathname.replace(/^\//, '') || '0' };
}

interface Handles {
  redis: Redis;
  queues: Queue[];
  workers: Worker[];
}

async function main(): Promise<void> {
  const env = getEnv();

  // One shared ioredis connection for every Queue and for the workers'
  // non-blocking commands. BullMQ duplicates it internally for each Worker's
  // blocking connection and closes those duplicates in Worker.close(); this
  // instance is ours to close.
  const redis = new Redis(env.REDIS_URL, {
    // Required by BullMQ for connections used by Workers: never fail a blocking
    // command because of transient reconnects.
    maxRetriesPerRequest: null,
    // Same backoff BullMQ applies to connections it creates itself (1s..20s).
    retryStrategy: (times) => Math.max(Math.min(Math.exp(times), 20_000), 1_000),
    connectionName: 'buddha-worker',
  });
  redis.on('error', (err) => logger.error({ err }, 'redis error'));
  redis.on('reconnecting', () => logger.warn('redis reconnecting'));
  redis.on('end', () => logger.info('redis connection ended'));

  const queues = Object.values(createQueues(redis));
  const workers = QUEUE_NAMES.map((name) => createWorker(name, processor, redis));

  // Every Queue/Worker re-emits errors of the shared connection. Connection
  // errors are already logged once by the ioredis handler above, so they are
  // demoted to debug here; anything else is a real problem.
  const logInstanceError = (kind: 'queue' | 'worker', name: string) => (err: Error) => {
    if (isNotConnectionError(err)) {
      logger.error({ err, queue: name }, `${kind} error`);
    } else {
      logger.debug({ err: err.message, queue: name }, `${kind} connection error`);
    }
  };
  for (const queue of queues) {
    queue.on('error', logInstanceError('queue', queue.name));
  }
  for (const worker of workers) {
    worker.on('error', logInstanceError('worker', worker.name));
    worker.on('failed', (job, err) =>
      logger.warn({ queue: worker.name, jobId: job?.id, jobName: job?.name, err }, 'job failed'),
    );
    worker.on('completed', (job) =>
      logger.debug({ queue: worker.name, jobId: job.id, jobName: job.name }, 'job completed'),
    );
  }

  await Promise.all([...queues, ...workers].map((instance) => instance.waitUntilReady()));
  logger.info({ redis: describeRedis(env.REDIS_URL), queues: QUEUE_NAMES }, 'worker ready');

  installShutdownHandlers({ redis, queues, workers });
}

function installShutdownHandlers(handles: Handles): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    // Worker.close() can hang while Redis is unreachable (bullmq#4656); never
    // let a stuck shutdown keep the process alive forever.
    const forceExit = setTimeout(() => {
      logger.fatal({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    // Each step runs to completion even if an earlier one rejects: the shared
    // connection must always be closed, otherwise its socket keeps the event
    // loop alive and the process never exits.
    const steps: Array<[string, () => Promise<unknown>]> = [
      // 1. Stop taking new jobs, wait for in-flight ones, close blocking duplicates.
      ['workers', () => Promise.all(handles.workers.map((worker) => worker.close()))],
      // 2. Release queue-side resources (the shared connection stays open).
      ['queues', () => Promise.all(handles.queues.map((queue) => queue.close()))],
      // 3. Close the connection we own.
      ['redis', () => handles.redis.quit()],
    ];
    let failed = false;
    for (const [name, run] of steps) {
      try {
        await run();
      } catch (err) {
        failed = true;
        logger.error({ err, step: name }, 'shutdown step failed');
      }
    }
    if (failed) {
      // Leave the watchdog armed: if a handle is still open, it will force the exit.
      process.exitCode = 1;
      return;
    }
    clearTimeout(forceExit);
    logger.info('shutdown complete');
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  process.exit(1);
});

main().catch((err: unknown) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
