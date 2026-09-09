import { type Db } from '@buddha/db';
import { marketJobDataSchema, type MarketJobData } from '@buddha/shared';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import { type Logger } from 'pino';
import * as z from 'zod';
import { JOB_NAMES } from '../queues.js';
import { type Publish } from '../realtime.js';
import { runLedgerAudit } from './ledger-audit.js';
import { closeDueMarkets, closeMarket } from './market-close.js';
import { finalizeDueMarkets, finalizeMarket } from './market-finalize.js';
import { type ScanFailure } from './scan.js';

export interface JobContext {
  db: Db;
  /** Same database, longer statement timeout (LEDGER_AUDIT_QUERY_TIMEOUT_MS): the audit only. */
  auditDb: Db;
  /** Realtime events after a market job commits (realtime.ts); best effort, never throws. */
  publish: Publish;
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
      const result = await finalizeMarket(db, marketId, publish);
      logger.info(toLoggable(result), 'market finalize');
      return toLoggable(result);
    }
    const { settled, skipped, failed, failures } = await finalizeDueMarkets(db, publish);
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
};

/**
 * BullMQ stores a job's return value as JSON, and pino serialises the log object the same
 * way: a bigint in either throws. The P amount goes out as the decimal string every wire
 * format of this project uses.
 */
function toLoggable(result: Awaited<ReturnType<typeof finalizeMarket>>): JobResult {
  if (result.outcome === 'skipped') return result;
  const { paidP, settledAt, ...rest } = result;
  return { ...rest, paidP: paidP.toString(), settledAt: settledAt.toISOString() };
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
