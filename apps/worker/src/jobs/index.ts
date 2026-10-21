import { type Db } from '@buddha/db';
import { type ObjectStorage } from '@buddha/storage';
import { marketJobDataSchema, type MarketJobData } from '@buddha/shared';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import { type Logger } from 'pino';
import * as z from 'zod';
import { JOB_NAMES } from '../queues.js';
import { type Publish } from '../realtime.js';
import { runLedgerAudit } from './ledger-audit.js';
import { closeDueMarkets, closeMarket } from './market-close.js';
import { finalizeDueMarkets, finalizeMarket } from './market-finalize.js';
import { removeOrphanMedia } from './media-orphan-cleanup.js';
import { type ScanFailure } from './scan.js';
import { payPendingStartGrants } from './start-grant-pay.js';

export interface JobContext {
  db: Db;
  /** Same database, longer statement timeout (LEDGER_AUDIT_QUERY_TIMEOUT_MS): the audit only. */
  auditDb: Db;
  /** Realtime events after a market job commits (realtime.ts); best effort, never throws. */
  publish: Publish;
  /** The media store (#46): the orphan clean-up removes objects from it. */
  storage: ObjectStorage;
  logger: Logger;
}

/** Result shape BullMQ stores for a completed job. */
type JobResult = Record<string, unknown>;

type Handler = (job: Job, context: JobContext) => Promise<JobResult>;

/**
 * `market.close` / `market.finalize` payload (jobs.ts in @buddha/shared). A payload the schema
 * refuses is a producer bug, not a transient failure: retrying it three times with backoff
 * would only delay the failed-set entry, so it is UnrecoverableError. A scheduler job carries
 * `{}` (BullMQ stores an absent template `data` as an empty object) — the scan.
 */
function parseMarketJob(job: Job): MarketJobData {
  const parsed = marketJobDataSchema.safeParse(job.data ?? {});
  if (!parsed.success) {
    throw new UnrecoverableError(
      `Invalid ${job.name} payload (job ${String(job.id)}): ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/**
 * Job handlers by name (PLAN 9). An unknown job must not be retried, so the dispatcher rejects
 * it with UnrecoverableError. `market.trader_count` (stats) is not scheduled by anything yet.
 */
const HANDLERS: Partial<Record<string, Handler>> = {
  [JOB_NAMES.marketClose]: async (job, { db, publish, logger }) => {
    const { marketId } = parseMarketJob(job);
    if (marketId) {
      const result = await closeMarket(db, marketId, publish);
      logger.info(result, 'market close');
      return result;
    }
    const { closed, skipped, failed, failures } = await closeDueMarkets(db, publish);
    return reportScan({ closed, skipped, failed }, failures, 'market close', closed, logger);
  },
  [JOB_NAMES.marketFinalize]: async (job, { db, publish, logger }) => {
    const { marketId } = parseMarketJob(job);
    if (marketId) {
      const result = await finalizeMarket(db, marketId, publish, logger);
      logger.info(toLoggable(result), 'market finalize');
      return toLoggable(result);
    }
    const { settled, skipped, failed, failures } = await finalizeDueMarkets(db, publish, logger);
    return reportScan({ settled, skipped, failed }, failures, 'market finalize', settled, logger);
  },
  [JOB_NAMES.ledgerAudit]: async (_job, { auditDb, logger }) => {
    const result = await runLedgerAudit(auditDb);
    if (result.recorded > 0) {
      logger.error(
        { checked: result.checked, recorded: result.recorded },
        'ledger audit found balance mismatches',
      );
    } else {
      logger.info({ checked: result.checked }, 'ledger audit clean');
    }
    return { checked: result.checked, mismatches: result.recorded };
  },
  [JOB_NAMES.startGrantPay]: async (_job, { db, publish, logger }) => {
    const { undecided, paid, skipped, failed, failures } = await payPendingStartGrants(db, publish);
    // Like a scan's: one error line per grant, the run itself does not fail (the next run, a
    // minute later, tries them again).
    for (const { grantId, err } of failures) {
      logger.error({ grantId, err }, 'start grant payment failed');
    }
    const result = {
      undecided,
      paid,
      skipped,
      failed,
      failures: failures.map(({ grantId, message }) => ({ grantId, message })),
    };
    // Every minute: quiet unless it paid something or failed.
    logger[paid > 0 || failed > 0 ? 'info' : 'debug'](result, 'start grant payment');
    return result;
  },
  [JOB_NAMES.mediaOrphanCleanup]: async (_job, { db, storage, logger }) => {
    const { queued, removed, failed, failures, pending } = await removeOrphanMedia(db, storage);
    // An object the store kept stays queued (media_deletions) and a later run tries it again: one
    // error line each, with how many times the store has refused it, and the run itself does not
    // fail (retrying the job at once would only ask the same store again).
    for (const { storageKey, attempts, err } of failures) {
      logger.error(
        { storageKey, attempts, err },
        'orphan upload object not removed; kept for retry',
      );
    }
    const result = {
      queued,
      removed,
      failed,
      failures: failures.map(({ storageKey, attempts, message }) => ({
        storageKey,
        attempts,
        message,
      })),
      pending,
    };
    logger[queued > 0 || removed > 0 || failed > 0 ? 'info' : 'debug'](
      result,
      'orphan upload clean-up',
    );
    return result;
  },
};

/**
 * BullMQ stores a job's return value as JSON, and pino serialises the log object the same
 * way: a bigint in either throws. The Coin amount goes out as the decimal string every wire
 * format of this project uses.
 */
function toLoggable(result: Awaited<ReturnType<typeof finalizeMarket>>): JobResult {
  if (result.outcome !== 'settled') return result;
  const { paidCoin, settledAt, ...rest } = result;
  return { ...rest, paidCoin: paidCoin.toString(), settledAt: settledAt.toISOString() };
}

/**
 * A scan's failures do not fail the job (scan.ts: the scan carries on past them, and the
 * next run retries them anyway), so the log is where they must be visible: one error line per
 * market, with the thrown value so the stack and any Postgres code survive. The job result
 * keeps only `{ marketId, message }` of each — BullMQ stores it as JSON, and an Error (or a
 * pg DatabaseError) is not a value to persist that way. The counts line stays at debug when
 * the scan did nothing: it runs every minute.
 */
function reportScan(
  counts: Record<string, number>,
  failures: ScanFailure[],
  what: string,
  done: number,
  logger: Logger,
): JobResult {
  for (const { marketId, err } of failures) {
    logger.error({ marketId, err }, `${what} failed in scan`);
  }
  const result = {
    ...counts,
    failures: failures.map(({ marketId, message }) => ({ marketId, message })),
  };
  logger[done > 0 || failures.length > 0 ? 'info' : 'debug'](result, `${what} scan`);
  return result;
}

export function createProcessor(context: JobContext): Processor {
  return async (job) => {
    const handler = HANDLERS[job.name];
    if (!handler) {
      throw new UnrecoverableError(
        `No handler registered for job "${job.name}" on queue "${job.queueName}"`,
      );
    }
    return handler(job, context);
  };
}
