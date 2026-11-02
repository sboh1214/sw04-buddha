import { JOB_NAMES, marketFinalizeJobId, type MarketJobData } from '@buddha/shared';
import { type JobsOptions, type Queue } from 'bullmq';
import { type Logger } from 'pino';

/**
 * What a job hands its follow-up `market.finalize` to after its transaction COMMITS (#152,
 * ADR-0103): the worker's confirmation of a provisional result (`market.resolve`) registers the
 * payout at once, as the API registered it after ADR-0046's interim judgement. Best effort,
 * never throws — the per-minute `market-finalize-scan` settles a RESOLVED market whose job never
 * made it to Redis.
 */
export type EnqueueFinalize = (marketId: string, resolvedAt: Date) => Promise<void>;

/**
 * Upper bound on one registration (ms). The worker's queues share the BullMQ connection, whose
 * `maxRetriesPerRequest: null` never rejects a command it has queued (queues.ts): on a Redis that
 * stopped answering, an unbounded `add` would park the `markets` queue (`concurrency: 1`) behind a
 * confirmation that has already committed. The publisher's figure (realtime.ts), for the same
 * reason; the add keeps running after the bound, and a late success is what was wanted.
 */
export const ENQUEUE_TIMEOUT_MS = 2_000;

/**
 * `removeOnComplete: true`, as the API's producer has it (MARKET_JOB_OPTIONS): the job's id is
 * fixed by market and instant, and BullMQ refuses to add a job whose id still exists in any set.
 * The rest are the queue's defaults (DEFAULT_JOB_OPTIONS: three attempts with backoff).
 */
const FINALIZE_JOB_OPTIONS = { removeOnComplete: true } as const satisfies JobsOptions;

/**
 * `EnqueueFinalize` on the worker's own `markets` queue: `market.finalize` for the market, due at
 * once, under `marketFinalizeJobId(marketId, resolvedAt)` — a second add of one confirmation is
 * answered with the existing job, and a run that finds the market settled skips. A failure or a
 * timeout is logged at warn and swallowed: the confirmation has committed, and the scan is the
 * safety net.
 */
export function createEnqueueFinalize(
  queue: Pick<Queue<MarketJobData>, 'add'>,
  logger: Logger,
  timeoutMs: number = ENQUEUE_TIMEOUT_MS,
): EnqueueFinalize {
  return async (marketId, resolvedAt) => {
    const jobId = marketFinalizeJobId(marketId, resolvedAt);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`add ${jobId} timed out after ${String(timeoutMs)} ms`)),
        timeoutMs,
      );
    });
    try {
      const add = queue.add(
        JOB_NAMES.marketFinalize,
        { marketId },
        {
          ...FINALIZE_JOB_OPTIONS,
          jobId,
        },
      );
      // The add's own late rejection, after the bound, is the one already reported.
      add.catch(() => undefined);
      await Promise.race([add, timeout]);
    } catch (err) {
      logger.warn({ err, jobId }, 'market finalize not enqueued; the finalize scan settles it');
    } finally {
      clearTimeout(timer);
    }
  };
}
