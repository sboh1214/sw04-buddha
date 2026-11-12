import {
  beginMarketMakerRecallAttempt,
  recallMarketMakerFunds,
  recordMarketMakerRecallAttempt,
  selectPendingMarketMakerRecallIds,
  type Db,
} from '@buddha/db';
import type { Logger } from 'pino';
import { runScan } from './scan.js';

/** Settlement/cancellation has already committed. No public event or user payout is part of recall. */
export async function recallMarketMaker(db: Db, marketId: string, logger: Logger) {
  let startedAt: Date | undefined;
  try {
    return await db.transaction(async (tx) => {
      startedAt = await beginMarketMakerRecallAttempt(tx, marketId);
      const result = await recallMarketMakerFunds(tx, { marketId });
      if (result.outcome === 'unavailable') {
        if (result.reason !== 'not_found' && result.reason !== 'not_terminal') {
          await recordMarketMakerRecallAttempt(tx, {
            marketId,
            lastAttemptAt: startedAt,
            state:
              result.reason === 'ledger_hold' || result.reason === 'treasury_capacity'
                ? 'waiting'
                : 'failed',
            reason: result.reason,
          });
        }
        return { marketId, ...result };
      }
      await recordMarketMakerRecallAttempt(tx, {
        marketId,
        lastAttemptAt: startedAt,
        state: 'completed',
        reason: null,
      });
      return { marketId, outcome: result.outcome, amountCoin: result.recall.amountCoin.toString() };
    });
  } catch (error) {
    if (startedAt) {
      try {
        await db.transaction((tx) =>
          recordMarketMakerRecallAttempt(tx, {
            marketId,
            lastAttemptAt: startedAt!,
            state: 'failed',
            reason: 'execution_failed',
          }),
        );
      } catch (recordError) {
        logger.error(
          { marketId, err: recordError },
          'market maker recall failure could not be recorded',
        );
      }
    }
    // Only transaction errors consume the bounded BullMQ retries. Held/invalid books stay
    // observed and pending for the next scan; they are never repaired by this worker.
    throw error;
  }
}

export async function recallPendingMarketMakers(db: Db, logger: Logger) {
  const due = await selectPendingMarketMakerRecallIds(db);
  const { results, failed, failures } = await runScan(due, (id) =>
    recallMarketMaker(db, id, logger),
  );
  return {
    recalled: results.filter((r) => r.outcome === 'recalled').length,
    pending: results.filter((r) => r.outcome === 'unavailable').length,
    skipped: results.filter((r) => r.outcome === 'duplicate').length,
    failed,
    failures,
  };
}
