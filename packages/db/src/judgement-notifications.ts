import {
  MARKET_DISPUTE_CLOSED_BY_CORRECTION_NOTIFICATION,
  MARKET_DISPUTE_DECIDED_NOTIFICATION,
  MARKET_JUDGEMENT_CORRECTED_NOTIFICATION,
  MARKET_JUDGEMENT_DELAYED_NOTIFICATION,
  MARKET_PROVISIONAL_RESULT_NOTIFICATION,
  MARKET_SETTLED_NOTIFICATION,
  NOTIFIED_DISPUTE_DECISIONS,
  serializeCoinAmount,
  type MarketDisputeClosedByCorrectionParams,
  type MarketDisputeDecidedParams,
  type MarketJudgementCorrectedParams,
  type MarketJudgementDelayedParams,
  type MarketProvisionalResultParams,
  type MarketResult,
  type MarketSettledParams,
  type MarketStatus,
  type NotificationParamValues,
  type NotifiedDisputeDecision,
} from '@buddha/shared';
import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import type { MarketDisputeRow } from './market-dispute.js';
import type { NotificationInput } from './notifications.js';
import type { markets } from './schema/index.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type MarketRow = typeof markets.$inferSelect;

/*
 * 판정·정산 알림 (#188, ADR-0160; N05 §4·§8, N03 §3–§8, 52-1·52-11~52-15, 188-1~188-6): who hears
 * of a market's judgement and payout, and the inputs that tell them. Pure builders (ADR-0158) plus
 * the settlement's own audience read; the transaction owners append the inputs to the ONE
 * `createNotifications` call of their event, last, after its writes and unlocked reads (ADR-0157
 * 결정 4, ADR-0158 12-20):
 *
 * - J1 a first judgement's approval, CLOSED → PROVISIONAL, and J2 a correction's approval (the
 *   API's market-judgement.service.ts): `judgementNotificationInputs` to `marketAudience`
 *   (market-notifications.ts — 52-14 "대상은 관심·보유 기준 그대로다"); J2 adds
 *   `disputeClosureNotificationInputs` for the disputes it closed, in the same call, same key;
 * - J3 an admin's 기각 or 수용 (market-dispute.service.ts): `disputeDecisionNotificationInput` to
 *   the submitter alone (52-14), keyed by the decision's `admin_actions` row;
 * - J4 a 판정 지연 record that is the first of its episode or changes the reason or the next
 *   review time (market-judgement-delay.service.ts; 52-11, 188-5): `judgementNotificationInputs`;
 * - J5 the finalize's settling → settled (the worker's market-finalize.ts): `settlementAudience`
 *   and `settlementNotificationInputs`, all or nothing with the payout (188-2 — no savepoint).
 *
 * Never: 결과 확정 (`resolveProvisionalMarket`, 52-12), 지급 중, a deadline drawing near or a
 * payout held (52-13), a time passing (ADR-0106 결정 6), a judgement's or a correction's
 * registration, 반려 or 철회 and the accepted → pending reopen (188-6), a member's own dispute
 * submit or retract, the post-payout correction and compensation (#144, 52-20) —
 * judgement-notifications.test.ts pins the callers.
 *
 * A throw here, or an input the definitions refuse, rolls the event back (ADR-0157 결정 4의 7) —
 * at J5 the payout with it (188-2). So the builders never produce what the definitions refuse, a
 * thrown message names no account (the finalize writes it into the admin-visible
 * `market_settlement_steps.last_error`), and the tests run real rows through `createNotifications`.
 */

/**
 * 52-1 at the payout (ADR-0159 결과 6): the watchers now ∪ the holders the payout recorded, each
 * once, sorted by byte order, each with its own summed payout (null: a watcher who held nothing).
 */
export interface SettlementRecipient {
  readonly userId: string;
  /** The sum of the member's `position_settlements.payout_coin` here (0 included); null: none. */
  readonly payoutCoin: bigint | null;
}

/**
 * The final settlement's audience (52-1, 52-12, 52-15; ADR-0159 결과 6): the market's watchers now
 * and every account the payout recorded in `position_settlements` — exactly the holders of one
 * contract or more at the payout (its `qty > 0` CHECK; 지급 0 losers included, 52-1 "지급 0이 될 보유
 * 포함"; the 운영 마켓메이커's rows too, which the write path's gate skips, 53-5). After the payout
 * `positions.qty` is 0, so `marketAudience` would read the watchers only; the in-memory
 * settlements of a run hold qty-0 rows and are empty on a run whose payout was already done. A
 * holder of both outcomes is one recipient with the SUM of both payouts (VOID 50 × each side, a
 * YES/NO result 100 × the winning side + 0).
 *
 * One statement, index reads (`market_watches_market_id_idx`; the primary key of
 * `position_settlements` leads with `market_id`), NO row lock: read inside the finalize's
 * transaction after its `finalized` transition, under `lockMarket` and the market row FOR UPDATE
 * — every effective watch or unwatch waits for it (ADR-0159 12-2). The payout, its records and the
 * transition are one transaction (ADR-0118 결정 2), so this sees all of the market's records or
 * none. `SUM(bigint)` is `numeric`: cast to text and read as a bigint, never a JS number.
 */
export async function settlementAudience(tx: Tx, marketId: string): Promise<SettlementRecipient[]> {
  const { rows } = await tx.execute<{ user_id: string; payout: string | null }>(sql`
    SELECT user_id, s.payout FROM (
      SELECT user_id FROM market_watches WHERE market_id = ${marketId}
      UNION
      SELECT user_id FROM position_settlements WHERE market_id = ${marketId}
    ) a
    LEFT JOIN (
      SELECT user_id, SUM(payout_coin)::text AS payout FROM position_settlements
      WHERE market_id = ${marketId} GROUP BY user_id
    ) s USING (user_id)
    ORDER BY user_id COLLATE "C"`);
  return rows.map((row) => ({
    userId: row.user_id,
    payoutCoin: row.payout === null ? null : BigInt(row.payout),
  }));
}

/** One judgement event of a market, as its transaction owner tells it (#188). */
export type JudgementNotice =
  /** 판정 지연 (52-11, 188-5): the record's public reason and its next review time. */
  | { kind: 'delayed'; reason: string; nextReviewAt: Date }
  /** 잠정 결과 (52-12): a first judgement's result and 이의 기한. */
  | { kind: 'provisional'; result: MarketResult; disputeDeadline: Date }
  /** 판정 정정 (52-12, 52-14, 188-1): the new version's result and its new 이의 기한. */
  | { kind: 'corrected'; result: MarketResult; disputeDeadline: Date };

/** The event a notice tells: its key and its instant, the 발생 시각. */
export interface JudgementNoticeEvent {
  /** `marketEventKey(id)` of a market event; `adminActionEventKey(id)` of a decision (J3). */
  readonly eventKey: string;
  readonly occurredAt: Date;
}

/** The market as the event wrote or read it under its lock: what a timed notice names. */
export type JudgementNoticeMarket = Pick<
  MarketRow,
  'slug' | 'title' | 'status' | 'judgementTimeZone'
>;

/** The statuses a market is in after each notice's event (a mismatch is a caller bug). */
const JUDGEMENT_STATUS_AFTER: { readonly [K in JudgementNotice['kind']]: readonly MarketStatus[] } =
  {
    // '판정 지연' reads on a CLOSED market past its scheduled judgement or a held PROVISIONAL one.
    delayed: ['closed', 'provisional'],
    provisional: ['provisional'],
    corrected: ['provisional'],
  };

/** A thrown caller bug, naming no account: a message can land in `last_error` (ADR-0160). */
function callerBug(message: string): never {
  throw new Error(`judgement notice: ${message}`);
}

const isBlank = (text: string): boolean => text.trim().length === 0;

/** The notice's type and params (J1, J2, J4). */
function judgementNoticeOf(
  market: JudgementNoticeMarket,
  notice: JudgementNotice,
): { type: string; params: NotificationParamValues } {
  const marketTitle = market.title;
  const judgementTimeZone = market.judgementTimeZone;
  switch (notice.kind) {
    case 'delayed': {
      if (isBlank(notice.reason)) callerBug('a delay notice needs its public reason');
      const params: MarketJudgementDelayedParams = {
        marketTitle,
        reason: notice.reason,
        nextReviewAt: notice.nextReviewAt.toISOString(),
        judgementTimeZone,
      };
      return { type: MARKET_JUDGEMENT_DELAYED_NOTIFICATION.type, params };
    }
    case 'provisional': {
      const params: MarketProvisionalResultParams = {
        marketTitle,
        result: notice.result,
        disputeDeadline: notice.disputeDeadline.toISOString(),
        judgementTimeZone,
      };
      return { type: MARKET_PROVISIONAL_RESULT_NOTIFICATION.type, params };
    }
    case 'corrected': {
      const params: MarketJudgementCorrectedParams = {
        marketTitle,
        result: notice.result,
        disputeDeadline: notice.disputeDeadline.toISOString(),
        judgementTimeZone,
      };
      return { type: MARKET_JUDGEMENT_CORRECTED_NOTIFICATION.type, params };
    }
  }
}

/**
 * The inputs of a judgement event's notice (J1 잠정 결과, J2 판정 정정, J4 판정 지연): one per member
 * of `audience` (`marketAudience`, read under the event's locks right before the call), keyed by
 * the event (`marketEventKey` of the `provisional`, `judgement_corrected` or
 * `judgement_delay_recorded` event), at its instant, leading to the market's detail (`market`
 * target, 188-4), naming the title the market row holds (it cannot change after the close) and
 * the market's 판정 기준 시간대 (public, fixed after the close — null stays null). Times as ISO
 * instants (52-15). Pure: no SQL.
 *
 * Throws — a caller bug, and the event rolls back with it (ADR-0158 12-19) — when the market's
 * status is not one the notice's event leaves (`closed` or `provisional` for a delay; `provisional`
 * for a first judgement and a correction), even with an empty audience, and on a delay's blank
 * reason. An empty audience gives no input.
 */
export function judgementNotificationInputs(
  audience: readonly string[],
  market: JudgementNoticeMarket,
  notice: JudgementNotice & JudgementNoticeEvent,
): NotificationInput[] {
  if (!JUDGEMENT_STATUS_AFTER[notice.kind].includes(market.status)) {
    callerBug(`a ${notice.kind} notice of a market that is ${market.status}`);
  }
  const { type, params } = judgementNoticeOf(market, notice);
  return audience.map((userId) => ({
    userId,
    type,
    eventKey: notice.eventKey,
    occurredAt: notice.occurredAt,
    target: { kind: 'market', slug: market.slug },
    params,
  }));
}

/**
 * The inputs of the final settlement (J5, 52-12 '지급 완료 때 최종 정산', 52-15): one per
 * recipient of `settlementAudience`, keyed by the `finalized` event (`marketEventKey`), at the
 * payout's instant, leading to the settled market's detail — the confirmed `result` and the
 * recipient's own summed payout as a decimal string (`payoutCoin`, '0' included; null for a
 * watcher who held nothing), never a P&L or another member's payout (AC 11). Pure: no SQL.
 *
 * Throws — a caller bug, and the payout rolls back with it (188-2) — when `market.status` is not
 * `settled` (what the `finalized` transition writes: the finalize passes it, as its row was read
 * `settling`), even with no recipient. No recipient gives no input.
 */
export function settlementNotificationInputs(
  recipients: readonly SettlementRecipient[],
  market: Pick<MarketRow, 'slug' | 'title' | 'status'>,
  notice: { result: MarketResult } & JudgementNoticeEvent,
): NotificationInput[] {
  if (market.status !== 'settled') {
    callerBug(`a settled notice of a market that is ${market.status}`);
  }
  return recipients.map(({ userId, payoutCoin }) => {
    const params: MarketSettledParams = {
      marketTitle: market.title,
      result: notice.result,
      payoutCoin: payoutCoin === null ? null : serializeCoinAmount(payoutCoin),
    };
    return {
      userId,
      type: MARKET_SETTLED_NOTIFICATION.type,
      eventKey: notice.eventKey,
      occurredAt: notice.occurredAt,
      target: { kind: 'market', slug: market.slug },
      params,
    };
  });
}

/**
 * The input of an admin's 기각 or 수용 (J3; 52-14, 188-3): to the dispute's submitter alone, the
 * decision (`dismissed` or `accepted`, the dispute's status after it) with its public reason, keyed
 * by the decision's `admin_actions` row (`adminActionEventKey`) — not by the dispute: an accepted
 * dispute sent back to pending by a correction's 반려·철회 (188-6, silent) is decided again, and
 * that decision is a notice of its own. At the decision's instant, leading to the market's detail
 * (188-4). Pure: no SQL.
 *
 * Throws — a caller bug — on a dispute that is not decided or has no decision reason.
 */
export function disputeDecisionNotificationInput(
  dispute: Pick<MarketDisputeRow, 'userId' | 'status' | 'decisionReason'>,
  market: Pick<MarketRow, 'slug' | 'title'>,
  event: JudgementNoticeEvent,
): NotificationInput {
  const decision = dispute.status;
  if (!(NOTIFIED_DISPUTE_DECISIONS as readonly string[]).includes(decision)) {
    callerBug(`a decision notice of a dispute that is ${decision}`);
  }
  if (dispute.decisionReason === null || isBlank(dispute.decisionReason)) {
    callerBug('a decision notice needs its public reason');
  }
  const params: MarketDisputeDecidedParams = {
    marketTitle: market.title,
    decision: decision as NotifiedDisputeDecision,
    reason: dispute.decisionReason,
  };
  return {
    userId: dispute.userId,
    type: MARKET_DISPUTE_DECIDED_NOTIFICATION.type,
    eventKey: event.eventKey,
    occurredAt: event.occurredAt,
    target: { kind: 'market', slug: market.slug },
    params,
  };
}

/**
 * The inputs of a correction's 정정으로 종결 (J2; 52-14 '정정으로 종결이면 새 이의 기한도 싣는다',
 * 188-1): one per dispute the correction closed (`correctMarketJudgement`'s `closedDisputes`), to
 * its submitter, with the new version's 이의 기한 only, keyed by the `judgement_corrected` event —
 * the key of the correction's audience notice, another type, so a submitter who also watches or
 * holds gets both (53-4) — at the approval's instant. One member disputes a version once (#173
 * 6항), so no two inputs share a recipient. Pure: no SQL.
 *
 * Throws — a caller bug — when the market is not `provisional` (even with no closed dispute) or a
 * dispute is not `closed_by_correction`. None closed gives no input.
 */
export function disputeClosureNotificationInputs(
  closed: readonly Pick<MarketDisputeRow, 'userId' | 'status'>[],
  market: JudgementNoticeMarket,
  notice: { disputeDeadline: Date } & JudgementNoticeEvent,
): NotificationInput[] {
  if (market.status !== 'provisional') {
    callerBug(`a closure notice of a market that is ${market.status}`);
  }
  const params: MarketDisputeClosedByCorrectionParams = {
    marketTitle: market.title,
    disputeDeadline: notice.disputeDeadline.toISOString(),
    judgementTimeZone: market.judgementTimeZone,
  };
  return closed.map((dispute) => {
    if (dispute.status !== 'closed_by_correction') {
      callerBug(`a closure notice of a dispute that is ${dispute.status}`);
    }
    return {
      userId: dispute.userId,
      type: MARKET_DISPUTE_CLOSED_BY_CORRECTION_NOTIFICATION.type,
      eventKey: notice.eventKey,
      occurredAt: notice.occurredAt,
      target: { kind: 'market', slug: market.slug },
      params,
    };
  });
}
