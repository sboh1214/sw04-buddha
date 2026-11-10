import { randomUUID } from 'node:crypto';
import { JOB_NAMES, marketMakerJobId, type MarketMakerJobData } from '@buddha/shared';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { ENQUEUE_TIMEOUT_MS } from './market-jobs.js';

export type EnqueueMarketMaker = (marketId: string, generation: bigint) => Promise<void>;

/** Best effort after COMMIT. A failed registration never undoes a committed market/fill. */
export function createEnqueueMarketMaker(
  queue: Pick<Queue<MarketMakerJobData>, 'add'>,
  logger: Logger,
  timeoutMs = ENQUEUE_TIMEOUT_MS,
): EnqueueMarketMaker {
  return async (marketId, generation) => {
    const jobId = marketMakerJobId(marketId, generation, randomUUID());
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`add ${jobId} timed out`)), timeoutMs);
      });
      const add = queue.add(
        JOB_NAMES.marketMakerRefresh,
        { marketId, generation: generation.toString() },
        {
          jobId,
          deduplication: { id: marketId },
          removeOnComplete: true,
        },
      );
      add.catch(() => undefined);
      await Promise.race([add, timeout]);
    } catch (err) {
      logger.warn(
        { err, jobId, marketId },
        'market maker not enqueued; the minute scan retries durable work',
      );
    } finally {
      clearTimeout(timer);
    }
  };
}
