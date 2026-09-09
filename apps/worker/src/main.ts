import { closeDb, createDb, type Db } from '@buddha/db';
import { isNotConnectionError, type Queue, type Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { waitForDb } from './db-ready.js';
import { getEnv } from './env.js';
import { startHealthServer, type HealthServer } from './health.js';
import { createProcessor } from './jobs/index.js';
import { LEDGER_AUDIT_QUERY_TIMEOUT_MS } from './jobs/ledger-audit.js';
import { logger } from './logger.js';
import {
  BULLMQ_REDIS_OPTIONS,
  createQueues,
  createWorker,
  JOB_SCHEDULES,
  QUEUE_NAMES,
} from './queues.js';
import { createPublisher, createPublisherRedis } from './realtime.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function describeRedis(url: string): { host: string; db: string } {
  const parsed = new URL(url);
  return { host: parsed.host, db: parsed.pathname.replace(/^\//, '') || '0' };
}

interface Handles {
  /** null when WORKER_HEALTH_PORT is 0. */
  health: HealthServer | null;
  redis: Redis;
  publishRedis: Redis;
  db: Db;
  auditDb: Db;
  queues: Queue[];
  workers: Worker[];
}

async function main(): Promise<void> {
  const env = getEnv();

  // Up first, answering 503, so a runner that polls /health from the moment the process
  // starts (Playwright's webServer, CI) sees "starting" rather than a refused connection it
  // might read as "not this port". Bound before anything else is opened: an EADDRINUSE then
  // fails startup with nothing to tear down.
  let ready = false;
  const health = await startHealthServer({
    port: env.WORKER_HEALTH_PORT,
    host: env.WORKER_HOST,
    isReady: () => ready,
    queues: QUEUE_NAMES,
    logger,
  });

  // One shared ioredis connection for every Queue and for the workers'
  // non-blocking commands. BullMQ duplicates it internally for each Worker's
  // blocking connection and closes those duplicates in Worker.close(); this
  // instance is ours to close.
  const redis = new Redis(env.REDIS_URL, BULLMQ_REDIS_OPTIONS);
  redis.on('error', (err) => logger.error({ err }, 'redis error'));
  redis.on('reconnecting', () => logger.warn('redis reconnecting'));
  redis.on('end', () => logger.info('redis connection ended'));

  // Jobs read and write Postgres (ledger audit, close, settlement), so the worker owns a
  // small pool of its own: it never talks to apps/api (PLAN 9).
  const db = createDb(env.DATABASE_URL, { max: 4, applicationName: 'buddha-worker' });
  // The ledger audit aggregates the whole ledger in one statement, so it gets its own single
  // connection with a timeout to match; the pool above keeps the 30-second guard for
  // everything else (see LEDGER_AUDIT_QUERY_TIMEOUT_MS). Named apart from the manual
  // script's 'buddha-worker-audit' so pg_stat_activity tells the two apart. A SIGTERM during
  // the audit hits SHUTDOWN_TIMEOUT_MS below and force-exits; Postgres then finishes or
  // times out the orphaned statement on its own, and the next run records the same accounts.
  const auditDb = createDb(env.DATABASE_URL, {
    max: 1,
    applicationName: 'buddha-worker-audit-job',
    queryTimeoutMs: LEDGER_AUDIT_QUERY_TIMEOUT_MS,
  });
  // Realtime events (PLAN 8) go out on a connection of their OWN, not the shared one. Subscriber
  // mode is not the reason — the worker never subscribes — the option sets are: the connection
  // above must keep `maxRetriesPerRequest: null` for BullMQ's blocking reads, and a client with
  // that option never rejects a command it has queued, nor may it carry a `commandTimeout` that
  // would. A publish on it can therefore park forever, and because both publishes happen after
  // their transaction commits, `runScan` is sequential and the `markets` queue is
  // `concurrency: 1`, one parked publish stops every market behind it and every later close and
  // settlement job — with `/health` still answering ready. `createPublisherRedis` (realtime.ts)
  // bounds it, the way the API splits `REDIS_QUEUE` off its shared client for the same reason.
  const publishRedis = createPublisherRedis(env.REDIS_URL, logger);
  const processor = createProcessor({
    db,
    auditDb,
    publish: createPublisher(publishRedis, logger),
    logger,
  });

  const queueByName = createQueues(redis);
  const queues = Object.values(queueByName);
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

  for (const schedule of JOB_SCHEDULES) {
    await queueByName[schedule.queue].upsertJobScheduler(schedule.id, schedule.repeat, {
      name: schedule.name,
    });
  }

  // Everything awaited above proved REDIS. `createDb` only constructs a pool — node-postgres
  // connects on first checkout — so without this the flag promised a settlement worker on a
  // database it had never reached, and `/health` answered 200 while every close and finalize
  // transaction failed. env.ts says the runners wait for this "the way they wait for the API",
  // and the API's probe covers db AND redis (health.controller.ts); closing and settling are
  // Postgres transactions, so the flag has to have touched Postgres once.
  //
  // Retries rather than throwing, and `waitForDb` says why at length: a rejecting one-shot would
  // reach `main().catch` and `process.exit(1)`, killing the health port that was bound first
  // precisely so a poller sees 503 rather than a refused connection. The Redis half already
  // parks the same way.
  //
  // This gates the PROBE, not the queue: the Workers above are already consuming, and a scan
  // that runs while we wait fails and is retried exactly as before (A-M5-15). `db` only, not
  // `auditDb` — same DATABASE_URL, so probing it would prove the same server twice while
  // holding the audit pool's single slot. It is a fact about BOOT: a Postgres that dies later
  // leaves this flag at 200 (Q-M5-11).
  const dbReady = await waitForDb(() => db.execute(sql`select 1`), { logger });

  logger.info(
    {
      redis: describeRedis(env.REDIS_URL),
      db: { attempts: dbReady.attempts },
      queues: QUEUE_NAMES,
      schedules: JOB_SCHEDULES.map((schedule) => `${schedule.name}@${schedule.repeat.pattern}`),
    },
    'worker ready',
  );
  ready = true;

  installShutdownHandlers({ health, redis, publishRedis, db, auditDb, queues, workers });
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
      // 0. Stop answering /health: a poller must not take a worker that is draining for one
      //    that will pick up the next job.
      ['health', () => handles.health?.close() ?? Promise.resolve()],
      // 1. Stop taking new jobs, wait for in-flight ones, close blocking duplicates.
      ['workers', () => Promise.all(handles.workers.map((worker) => worker.close()))],
      // 2. Release queue-side resources (the shared connection stays open).
      ['queues', () => Promise.all(handles.queues.map((queue) => queue.close()))],
      // 3. Close the connections we own. The publisher's `quit()` runs under its own
      //    `commandTimeout`, so a Redis that has stopped answering cannot hold the shutdown
      //    here either; the shared one has no such bound and is what the watchdog is for.
      ['redis', () => handles.redis.quit()],
      ['publishRedis', () => handles.publishRedis.quit()],
      ['db', () => closeDb(handles.db)],
      ['auditDb', () => closeDb(handles.auditDb)],
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
