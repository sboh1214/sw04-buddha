import { Inject, Injectable } from '@nestjs/common';
import { recordJudgementDelay, schema, type Db } from '@buddha/db';
import {
  JUDGEMENT_DELAY_REVIEW_MAX_DAYS,
  MARKET_JUDGEMENT_DELAY_REFUSALS,
  judgementDelayNextReviewRefusal,
  judgementDelayStatusRefusal,
  type AdminMarket,
  type JudgementDelayNextReviewRefusal,
  type JudgementDelayStatusRefusal,
  type MarketDelayRecordActionPayload,
  type RecordJudgementDelayBody,
  type WithoutExpectedAccount,
} from '@buddha/shared';
import { AppError } from '../common/errors/app-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { MarketAdminService } from './market-admin.service.js';
import { fieldError, lockedMarketRow } from './market-item-rules.js';
import { lockMarket } from './market-lock.js';
import { readMarketSources } from './market-sources.js';
import { displayStateOf, marketTagNames } from './market.service.js';

const { status: STATUS, nextReviewAt: NEXT_REVIEW } = MARKET_JUDGEMENT_DELAY_REFUSALS;
const MAX_DAYS = JUDGEMENT_DELAY_REVIEW_MAX_DAYS;

/**
 * The top-level message of each refusal, by its MARKET_JUDGEMENT_DELAY_REFUSALS detail (the
 * `status` ones, then the `nextReviewAt` ones).
 */
const REFUSAL_MESSAGES: Readonly<
  Record<JudgementDelayStatusRefusal | JudgementDelayNextReviewRefusal, string>
> = {
  [STATUS.notAwaitingJudgement]:
    'A judgement delay is recorded on a market awaiting its judgement: closed or provisional',
  [STATUS.notDelayed]:
    'The market’s judgement is not delayed: a closed market before its scheduled judgement ' +
    '(or with none), or a provisional one before its dispute deadline or held by nothing',
  [NEXT_REVIEW.notAfterNow]: 'The next review time must be after now',
  [NEXT_REVIEW.tooFarAhead]: `The next review time must be at most ${String(MAX_DAYS)} days after now`,
};

/** VALIDATION_ERROR naming `path` with its MARKET_JUDGEMENT_DELAY_REFUSALS `detail`. */
function refused(path: 'status', detail: JudgementDelayStatusRefusal): AppError;
function refused(path: 'nextReviewAt', detail: JudgementDelayNextReviewRefusal): AppError;
function refused(
  path: 'status' | 'nextReviewAt',
  detail: JudgementDelayStatusRefusal | JudgementDelayNextReviewRefusal,
): AppError {
  return fieldError(path, REFUSAL_MESSAGES[detail], detail);
}

/**
 * 판정 지연 기록 (#142, ADR-0106; ADR-0093 decision 1 #173 items 2·7·11·13, decision 2 #172 item
 * 14, decision 3 '#142 지연 사유', decision 4, the owner's answers of 2026-11-03 (1)–(4);
 * market-judgement-delay.ts in @buddha/shared and @buddha/db): one admin, at once and alone — no
 * approval request, no role re-read and no registrant exclusion, as a pause (#173 item 2) — records
 * why a market's judgement is late and when it is next reviewed. Each record is a new one: the
 * earlier ones stay as its history, none is edited or withdrawn (owner answer (4)), and the public
 * detail shows the current one (`Market.judgementDelay`). Nothing of the market changes — no
 * status, no result, no scheduled judgement (#172 item 14), no `status_event_id` — and neither the
 * next review time nor the long-delay deadline passing creates anything (#173 item 11).
 *
 * One transaction with its `admin_actions` row (`market_delay_record`), under MarketAdminService's
 * lock order: the market lock (`lockMarket`), the market row FOR UPDATE, then the database clock
 * (clock.ts) — so a record serialises with the worker's confirmation and with every judgement,
 * correction and 판정 이의 write of the market, and what it judges and records is the market as
 * that clock finds it. After COMMIT `market:status` again with the UNCHANGED key (A-M4-36, as a
 * 판정 이의 write): an open detail refetches its `judgementDelay`.
 */
@Injectable()
export class MarketJudgementDelayService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly markets: MarketAdminService,
  ) {}

  /**
   * 기록 (`POST /admin/markets/:id/judgement-delays`): any admin, on a market that reads '판정 지연'
   * on the database clock read after the market lock — a CLOSED market at or past its scheduled
   * judgement, or a PROVISIONAL one a 판정 이의 or a waiting 판정 정정 holds at or past its 이의 기한
   * (#173 items 7·11; a waiting judgement registration refuses nothing) — with a public reason and
   * a next review time after that clock and at most JUDGEMENT_DELAY_REVIEW_MAX_DAYS × 24 hours
   * after it (owner answer (1)), whatever the status. Refused, after the body's own checks, in this
   * order: NOT_FOUND; `status` 'not awaiting a judgement' (any status but those two), `status`
   * 'not delayed', `nextReviewAt` 'not after now', `nextReviewAt` 'more than 7 days ahead'.
   * `recordJudgementDelay` writes the `judgement_delay_recorded` event (the admin its actor) and
   * the record on the market's status and judgement version, at that clock; `market_delay_record`
   * records the event's fields. Answers the admin detail, the new record current.
   */
  async record(
    adminId: string,
    id: string,
    body: WithoutExpectedAccount<RecordJudgementDelayBody>,
  ): Promise<AdminMarket> {
    const market = await this.db.transaction(async (tx) => {
      await lockMarket(tx, id);
      const current = await lockedMarketRow(tx, id);
      // After the market lock (clock.ts): the record sorts after whatever committed on the market
      // while this transaction queued — a judgement's approval or the worker's confirmation that
      // ended the delay among them — and judges the market as that left it.
      const now = await clockTimestamp(tx);
      const statusRefusal = judgementDelayStatusRefusal(displayStateOf(current), now.getTime());
      if (statusRefusal !== null) throw refused('status', statusRefusal);
      const nextReviewAt = new Date(body.nextReviewAt);
      const timeRefusal = judgementDelayNextReviewRefusal(nextReviewAt, now.getTime());
      if (timeRefusal !== null) throw refused('nextReviewAt', timeRefusal);
      const { delay } = await recordJudgementDelay(tx, {
        market: current,
        reason: body.reason,
        nextReviewAt,
        recordedBy: adminId,
        now,
      });
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'market_delay_record',
        targetType: 'market',
        targetId: id,
        payload: {
          delayId: delay.id,
          reason: delay.reason,
          nextReviewAt: delay.nextReviewAt.toISOString(),
          marketStatus: delay.marketStatus,
          judgementVersion: delay.judgementVersion,
        } satisfies MarketDelayRecordActionPayload,
        createdAt: now,
      });
      // The market row is the one read under the lock: the record changed nothing of it.
      return this.markets.toAdminMarket(
        tx,
        current,
        await marketTagNames(tx, id),
        await readMarketSources(tx, id),
      );
    });
    // Outside the transaction, as every market write publishes: a subscriber answers
    // `market:status` with a REFETCH, which must find the committed record. The key is the
    // market's unchanged `status_event_id`, so no client applies it as a transition.
    await this.markets.publishStatus(market);
    return market;
  }
}
