import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  lockAdminRoles,
  lockMarket,
  recordSettlementFailure,
  retrySettlingMarket,
  schema,
  settledMarketEvents,
  settlementRetryErrorKind,
  type Db,
  type SettlementFailureRecord,
  type SettlementProgress,
  type SettleSettlingMarketResult,
} from '@buddha/db';
import { type AdminSettlementRetryResult } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';
import { MarketJobs } from '../jobs/market-jobs.service.js';
import { fieldError, lockedMarketRow, type Tx } from '../markets/market-item-rules.js';
import { MarketPublisher } from '../realtime/market-publisher.js';

type Settled = Extract<SettleSettlingMarketResult, { outcome: 'settled' }>;

/** The fixed line of an attempt that ran and could not be recorded: the market alone. */
export const SETTLEMENT_RETRY_UNRECORDED_LOG = 'settlement retry ran and could not be recorded';

/**
 * 정산 다시 시도 (#145, ADR-0163; 145-7 "1인, 사유 필수 … 매 분 자동 재시도와 같은 검사를 하고,
 * 지급액이나 검사를 바꾸지 못한다", 145-14 "지급 중(SETTLING)만"; #173 14항): one admin, with a
 * reason, runs one payout attempt of a SETTLING market at once — the worker's own core
 * (@buddha/db `retrySettlingMarket`, which runs `settleSettlingMarket`), so the checks are the
 * automatic retry's by construction and nothing of the request reaches them but the reason.
 *
 * One request, one `actionId` (Q-C): the id of its `market_settlement_retry` row in whichever
 * branch writes it.
 * - The payout's transaction: the market lock, the row (404), the admin role re-read under the
 *   admin-roles shared lock (this moves Coin; the reconciliation run's order, which a grant's
 *   `nowait` locks cannot deadlock), then the retry body — `settling` only, else the `status`
 *   refusal with nothing recorded (a refused click is no attempt); the `settled` row before the
 *   core (Q-A: its notices stay the transaction's last call), committed only with the payout.
 * - After COMMIT: the worker's publishes in its order, then the bot recall job (best effort; the
 *   recall scan repairs a miss). The answer is `settled` with the `finalized` event's id.
 * - A throw before the attempt started (`progress.started`): a lock wait, a timeout or a lost
 *   connection is TRANSACTION_BUSY (Q-B) and anything else answers as itself; nothing is recorded
 *   — the run that held the lock records its own outcome.
 * - A throw after it: the attempt ran and rolled back; `recordSettlementFailure` writes it in one
 *   transaction of its own (the step's attempt and error, and the `failed` row), and the answer
 *   is 200 `failed` with the step read back — or `settled` when the request's own settled row is
 *   already there (a COMMIT whose acknowledgement was lost, Q-C). When that record fails too, a
 *   fixed line and 500: nothing of the attempt is recorded.
 */
@Injectable()
export class SettlementRetryService {
  private readonly logger = new Logger(SettlementRetryService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly publisher: MarketPublisher,
    private readonly jobs: MarketJobs,
  ) {}

  async retry(
    adminId: string,
    marketId: string,
    reason: string,
  ): Promise<AdminSettlementRetryResult> {
    const actionId = randomUUID();
    const progress: SettlementProgress = {};
    let settled: Settled;
    try {
      settled = await this.db.transaction(async (tx) => {
        await lockMarket(tx, marketId);
        await lockedMarketRow(tx, marketId);
        await this.assertAdmin(tx, adminId);
        const attempt = await retrySettlingMarket(
          tx,
          { marketId, adminId, reason, actionId },
          progress,
        );
        if (attempt.outcome === 'not_settling') {
          // Thrown inside, so nothing of this request commits (145-14: SETTLING only).
          throw fieldError('status', 'Market is not settling', 'not settling');
        }
        return attempt.settled;
      });
    } catch (error) {
      const kind = settlementRetryErrorKind(error, progress);
      if (kind === 'busy') {
        throw new AppError('TRANSACTION_BUSY', {
          message: 'The market is busy; retry the settlement later',
          cause: error,
        });
      }
      if (kind === 'other') throw error;
      return this.recordFailure(marketId, progress, error, { adminId, reason, actionId });
    }
    await this.publish(settled);
    return { outcome: 'settled', statusEventId: String(settled.statusEventId) };
  }

  /** The attempt ran and rolled back: record it (one transaction) and answer its outcome. */
  private async recordFailure(
    marketId: string,
    progress: SettlementProgress,
    error: unknown,
    retry: { adminId: string; reason: string; actionId: string },
  ): Promise<AdminSettlementRetryResult> {
    let recorded: SettlementFailureRecord;
    try {
      recorded = await recordSettlementFailure(this.db, marketId, progress.running, error, retry);
    } catch (recordError) {
      // A fixed line, the market alone: no admin, reason or error text (ADR-0064).
      this.logger.error(`${SETTLEMENT_RETRY_UNRECORDED_LOG} (market ${marketId})`);
      throw new AppError('INTERNAL', { cause: recordError });
    }
    if (recorded.outcome === 'settled') {
      // The payout committed and only its acknowledgement was lost: its events went with it
      // (nothing here holds them); the bot recall is still asked for, as after a payout.
      await this.jobs.recallMarketMaker(marketId);
      if (recorded.statusEventId === null) throw new AppError('INTERNAL');
      return { outcome: 'settled', statusEventId: String(recorded.statusEventId) };
    }
    return {
      outcome: 'failed',
      settlementLastError: recorded.step?.lastError ?? null,
      settlementAttempts: recorded.step?.attempts ?? null,
    };
  }

  /**
   * The worker's publishes of a settled run, in its order (`settledMarketEvents`): the status,
   * then each member's balance and positions, then the inbox signals — issued together, awaited
   * together; a failed publish is logged by the publisher without the member. Then the bot
   * recall, as the worker's `withMarketMakerRecall` does on its `settled` publish.
   */
  private async publish(settled: Settled): Promise<void> {
    const events = settledMarketEvents(settled);
    await Promise.all([
      this.publisher.publishMarket(settled.marketId, events.status),
      ...events.user.map(([userId, event]) => this.publisher.publishUser(userId, event)),
    ]);
    await this.jobs.recallMarketMaker(settled.marketId);
  }

  /** The role re-read in the transaction (reconciliation.service.ts `assertAdmin`'s pattern). */
  private async assertAdmin(tx: Tx, adminId: string): Promise<void> {
    await lockAdminRoles(tx, 'shared');
    const [profile] = await tx
      .select({ role: schema.profiles.role })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, adminId))
      .limit(1);
    if (profile?.role !== 'admin') throw new AppError('FORBIDDEN', { message: 'Admin only' });
  }
}
