import { randomUUID } from 'node:crypto';
import { JOB_NAMES, type MarketJobData } from '@buddha/shared';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { ENQUEUE_TIMEOUT_MS } from './market-jobs.js';
import type { Publish } from './realtime.js';

export type EnqueueMarketMakerRecall = (marketId: string) => Promise<void>;

/** UUID registration ids let the repair scan recover even after an exhausted failed job. */
export function createEnqueueMarketMakerRecall(
  queue: Pick<Queue<MarketJobData>, 'add'>,
  logger: Logger,
  timeoutMs = ENQUEUE_TIMEOUT_MS,
): EnqueueMarketMakerRecall {
  return async (marketId) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        queue.add(
          JOB_NAMES.marketMakerRecall,
          { marketId },
          {
            jobId: `${JOB_NAMES.marketMakerRecall}.${marketId}.${randomUUID()}`,
            deduplication: { id: `${JOB_NAMES.marketMakerRecall}.${marketId}` },
            removeOnComplete: true,
          },
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Recall enqueue timed out')), timeoutMs);
        }),
      ]);
    } catch (err) {
      logger.warn({ marketId, err }, 'market maker recall not enqueued; repair scan will retry');
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Every worker status publisher is called after commit. Queueing is independent of Redis publish. */
export function withMarketMakerRecall(
  publish: Publish,
  enqueue: EnqueueMarketMakerRecall,
): Publish {
  return async (channel, event) => {
    await Promise.all([
      publish(channel, event),
      event.type === 'market:status' && (event.status === 'settled' || event.status === 'cancelled')
        ? enqueue(event.marketId)
        : Promise.resolve(),
    ]);
  };
}
