import { type Db } from '@buddha/db';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import { type Logger } from 'pino';
import { JOB_NAMES } from '../queues.js';
import { runLedgerAudit } from './ledger-audit.js';

export interface JobContext {
  db: Db;
  logger: Logger;
}

/** Result shape BullMQ stores for a completed job. */
type JobResult = Record<string, unknown>;

type Handler = (job: Job, context: JobContext) => Promise<JobResult>;

/**
 * Job handlers by name (PLAN 9). Market and stats jobs arrive with M3/M4; until then an
 * unknown job must not be retried, so the dispatcher rejects it with UnrecoverableError.
 */
const HANDLERS: Partial<Record<string, Handler>> = {
  [JOB_NAMES.ledgerAudit]: async (_job, { db, logger }) => {
    const result = await runLedgerAudit(db);
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
