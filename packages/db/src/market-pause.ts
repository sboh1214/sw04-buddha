import {
  recoverPausedMarketReconciliation,
  type ReconciliationRecoveryEvidence,
} from './reconciliation-recovery.js';
import { randomUUID } from 'node:crypto';
import {
  MARKET_NO_FILL_CANCEL_REASON,
  MARKET_PAUSE_PATH_END_KINDS,
  MARKET_PAUSE_PATH_STATUSES,
  pauseDecisionRefusal,
  pauseReasonNeedsPublishedAt,
  type MarketCancelledEarlyPayload,
  type MarketEarlyClosedPayload,
  type MarketPausePath,
  type MarketPauseReason,
  type MarketPauseReviewResult,
  type MarketPausedPayload,
  type MarketResumedPayload,
} from '@buddha/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Db } from './client.js';
import { marketHasHumanFill } from './market-cancel.js';
import { transitionMarket } from './market-transitions.js';
import {
  cancelLockedOrders,
  expireLockedOrders,
  type CancelledOrders,
  type ExpiredOrders,
  type LockedOrders,
} from './order-cancel.js';
import type * as schema from './schema/index.js';
import { marketPauses, markets } from './schema/index.js';

type MarketRow = typeof markets.$inferSelect;

/** A pause (#114): a row of `market_pauses`. */
export type MarketPauseRow = typeof marketPauses.$inferSelect;

/** A transaction handle of either app, as `transitionMarket` takes it, that also reads back. */
type Executor = Pick<NodePgDatabase<typeof schema>, 'insert' | 'update' | 'select'>;

/** A transaction: what the pause and its end take, as they cancel orders (order-cancel.ts). */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Anything that reads: a transaction handle or the pooled `Db`. */
type Reader = Pick<NodePgDatabase<typeof schema>, 'select'>;

/*
 * 거래 일시 중단·재개·조기 마감 (#114, ADR-0102; ADR-0093 decision 1 #173 items 1–4, decision 3 '#114 조기 결과의 공개
 * 시각'): the one place each edge into and out of PAUSED is taken, as the open is
 * `openScheduledMarket`'s (ADR-0100 결정 2), so the rule lives once — `pauseMarket` (OPEN → PAUSED,
 * one admin), `endMarketPause` (PAUSED → OPEN or CLOSED — CANCELLED with no fill a person's account
 * is on, #20 — by another admin's approval) and `endPauseAtClose` (the worker's close at `close_at`
 * of a PAUSED market). The resting orders — people's and the 운영 마켓메이커's — are cancelled here as 취소
 * 완료(일시 중단), in the same transaction, through order-cancel.ts (#178, ADR-0113; #173 item 3,
 * ADR-0107 결정 5 '#119 일시 중단 때 대기 주문'): at the pause, but for `ledger_failure`, whose orders keep
 * their locks until the recovery (결정 4 #178 rows) — the approval of its 재개 or 조기 마감, which cancels
 * them before the status changes. A non-held market's 조기 마감 expires what is left after the status
 * changes, as the close at `close_at` does (#120, ADR-0107 결정 5 '#120 조기 마감'). The intake (#119)
 * refuses new orders '일시 중단' meanwhile. #93 may call `pauseMarket` with `ledger_failure`. Each is
 * called under `lockMarket`, with the market read `FOR UPDATE` after the lock, its orders locked
 * after that (`lockMarketOrders`, required by `pauseMarket` and `endMarketPause`) and `now` the DB
 * clock read after the last lock, in the caller's transaction; each writes no admin action (the
 * API's) and publishes nothing (the caller publishes `market:status` after COMMIT, and
 * `market:book` when it cancelled or expired any order — `cancelled` or `expired.expired`
 * non-empty, #179 and a non-held 조기 마감's expiry, #120; a lock change alone has no event).
 */

/**
 * Why `pauseMarket` left a market as it was, in the order it is judged (the API answers each with
 * MARKET_PAUSE_REFUSALS of @buddha/shared):
 * - `not_open`: the market is not OPEN — a PAUSED one included (`status` 'not open');
 * - `close_passed`: its close has come, by the clock too: a market stays OPEN past its close until
 *   the worker closes it (`closeAt` 'closed');
 * - `published_after_pause`: the publication instant is after the pause's (`resultPublishedAt`
 *   'after the pause').
 */
export type PauseSkipReason = 'not_open' | 'close_passed' | 'published_after_pause';

export interface PauseMarketInput {
  /** The market row the caller read `FOR UPDATE` after `lockMarket`, in the same transaction. */
  market: Pick<MarketRow, 'id' | 'status' | 'closeAt'>;
  /** The market's live orders, `lockMarketOrders(tx, market.id)` after the row, before `now`. */
  orders: LockedOrders;
  /** The DB clock read after the locks (`clockTimestamp`): what is judged, the pause's instant. */
  now: Date;
  /** The pausing admin (#173 item 2: one admin), the event's actor. */
  actorId: string;
  reason: MarketPauseReason;
  /** What happened (approvalReasonSchema: trimmed, 1–500 characters). Private unless confirmed. */
  note: string;
  /** Explicit publication consent for this note; omitted by legacy/internal callers. */
  notePublic?: true;
  /**
   * For `early_result` alone, when the result was published (decision 3, the operator's); null
   * for any other reason. A mismatch is a caller's bug (the body refuses it first) and throws.
   */
  resultPublishedAt: Date | null;
}

export type PauseMarketResult =
  | {
      paused: true;
      /** The market row read back after the writes: `paused`, its event's id and instant. */
      market: MarketRow;
      /** The pause row, lasting (no end). */
      pause: MarketPauseRow;
      /** The `paused` event's id, the market's `status_event_id`. */
      eventId: number;
      /** The orders it cancelled at `now` (none for `ledger_failure`: they wait, `held` empty). */
      cancelled: CancelledOrders;
    }
  | { paused: false; reason: PauseSkipReason };

/**
 * OPEN → PAUSED (#114; ADR-0093 decision 1 #173 items 2·3): 거래 일시 중단 by one admin, at once,
 * with one of the three reasons and a note, and for `early_result` the publication instant. It
 * pauses a market that is OPEN, whose close is after `now` and whose publication instant (if any)
 * is not after `now`, checked in that order (PauseSkipReason); otherwise it writes nothing and says
 * why.
 *
 * The pause is `transitionMarket`'s `paused` event — from `open`, to `paused`, the admin, payload
 * `{pauseId, reason, resultPublishedAt}` (MarketPausedPayload: the instant as ISO, null but for
 * `early_result`; `notePublic: true` only when publication was explicitly confirmed), at `now`,
 * the market's `status_event_id` — then its `market_pauses` row with
 * that id (generated first, so the event names it), the reason, the note, the instant, `now`, the
 * admin and the event, lasting. Nothing else of the market changes: `close_at` stays, and the
 * close still comes at it, on schedule (#173 item 3). Orders: after the pause row, every resting
 * order of the market — people's and the 운영 마켓메이커's — is cancelled 일시 중단 at `now`, its
 * lock given back (`cancelLockedOrders`, #178), but for `ledger_failure`, whose orders wait for
 * the recovery with their locks; new ones are rejected '일시 중단' (#119). A skipped pause cancels
 * nothing.
 */
export async function pauseMarket(
  tx: Tx,
  { market, orders, now, actorId, reason, note, notePublic, resultPublishedAt }: PauseMarketInput,
): Promise<PauseMarketResult> {
  assertMarketOrders(orders, market.id);
  if (pauseReasonNeedsPublishedAt(reason) !== (resultPublishedAt !== null)) {
    throw new Error(
      `A pause for ${reason} is recorded ${
        pauseReasonNeedsPublishedAt(reason) ? 'with' : 'without'
      } the result's publication instant`,
    );
  }
  if (market.status !== 'open') return { paused: false, reason: 'not_open' };
  if (market.closeAt.getTime() <= now.getTime()) return { paused: false, reason: 'close_passed' };
  if (resultPublishedAt !== null && resultPublishedAt.getTime() > now.getTime()) {
    return { paused: false, reason: 'published_after_pause' };
  }

  const pauseId = randomUUID();
  const payload: MarketPausedPayload = {
    pauseId,
    reason,
    resultPublishedAt: resultPublishedAt?.toISOString() ?? null,
    ...(notePublic === true ? { notePublic } : {}),
  };
  const eventId = await transitionMarket(tx, {
    marketId: market.id,
    from: 'open',
    to: 'paused',
    type: 'paused',
    actorId,
    payload: { ...payload },
    at: now,
  });
  const [pause] = await tx
    .insert(marketPauses)
    .values({
      id: pauseId,
      marketId: market.id,
      reason,
      note,
      resultPublishedAt,
      pausedAt: now,
      pausedBy: actorId,
      pauseEventId: eventId,
    })
    .returning();
  if (!pause) throw new Error('market_pauses insert returned no row');
  const cancelled =
    reason === 'ledger_failure'
      ? { cancelled: [], held: [], touched: { positions: [] } }
      : await cancelLockedOrders(tx, orders, { reason: 'paused', at: now });
  const [row] = await tx.select().from(markets).where(eq(markets.id, market.id));
  if (!row) throw new Error(`Market ${market.id} was paused but could not be read back`);
  return { paused: true, market: row, pause, eventId, cancelled };
}

/** `orders` is `lockMarketOrders` of `marketId`: the one market's batch, nothing else. */
function assertMarketOrders(orders: LockedOrders, marketId: string): void {
  if (
    orders.scope.kind !== 'market' ||
    orders.scope.marketId !== marketId ||
    orders.markets.length !== 1 ||
    orders.markets[0]!.marketId !== marketId
  ) {
    throw new Error(`A pause takes the orders lockMarketOrders locked of market ${marketId}`);
  }
}

/**
 * Why `endMarketPause` left a market as it was, in the order it is judged (the API answers each
 * with MARKET_PAUSE_REFUSALS of @buddha/shared):
 * - `not_paused`: the market is not PAUSED — closed at its close, or the other path approved
 *   (`status` 'not paused');
 * - `close_passed`: its close has come, by the clock too (`closeAt` 'closed');
 * - `stale`: the request's pause is not the market's lasting one — it ended, and the market paused
 *   again since (`pause` 'stale').
 */
export type EndPauseSkipReason = 'not_paused' | 'close_passed' | 'stale';

export interface EndMarketPauseInput {
  /** The market row the caller read `FOR UPDATE` after `lockMarket`, in the same transaction. */
  market: Pick<MarketRow, 'id' | 'status' | 'closeAt'>;
  /** The market's live orders, `lockMarketOrders(tx, market.id)` after the row, before `now`. */
  orders: LockedOrders;
  /** The pause the request decides (its payload's `pauseId`): the row, or `{ id }` alone. */
  pause: Pick<MarketPauseRow, 'id'>;
  /** The DB clock read after the locks: what is judged, the end's instant. */
  now: Date;
  /** The approving admin — never the requester (throws) — the event's actor and `ended_by`. */
  approverId: string;
  path: MarketPausePath;
  /** The request's review result: a `basis_change` pause's, null for the other reasons. */
  reviewResult: MarketPauseReviewResult | null;
  /** The approved `market_pause_decision` request, `end_approval_id`. */
  approvalId: string;
  /** Its requester, in the event's payload. */
  requestedBy: string;
  recovery?: ReconciliationRecoveryEvidence | null;
}

export type EndMarketPauseResult =
  | {
      ended: true;
      /**
       * The market row read back after the writes: `open`, `closed`, or `cancelled` for an early
       * close with no fill a person's account is on (#20) — its event's id.
       */
      market: MarketRow;
      /** The pause row, ended. */
      pause: MarketPauseRow;
      /** The `resumed`, `closed` or `cancelled` event's id, the market's `status_event_id`. */
      eventId: number;
      /** The orders it cancelled at `now`, before the status changed (재개, a held 조기 마감). */
      cancelled: CancelledOrders;
      /** The orders a non-held 조기 마감 expired at `now`, after the status changed (#120). */
      expired: ExpiredOrders;
    }
  | { ended: false; reason: EndPauseSkipReason };

/**
 * PAUSED → OPEN (재개) or PAUSED → CLOSED or CANCELLED (조기 마감) by an approved next path (#114;
 * ADR-0093 decision 1 #173 items 2·4, owner answers Q1·Q2 of 2026-11-02), in the approval's
 * transaction. It ends a market that is PAUSED, whose close is after `now` and whose lasting pause
 * is the request's, checked in that order (EndPauseSkipReason); otherwise it writes nothing and
 * says why. A review result the pause's reason does not allow (`pauseDecisionRefusal` of
 * @buddha/shared: required for `basis_change`, none for the others, `not_judgeable` only with
 * `early_close`) was refused at the request, so here it is a caller's bug and throws — as does an
 * approval by the requester.
 *
 * `transitionMarket`'s event, its actor the approver, at `now`:
 * - `resume`: `resumed`, paused → open, payload `{pauseId, approvalId, requestedBy, reviewResult}`
 *   (MarketResumedPayload). `open_at` stays the first open's (the 신규 order reads it);
 * - `early_close`: `closed`, paused → closed, payload `{closedAt, source: 'early_close', pauseId,
 *   approvalId, requestedBy, reviewResult}` (MarketEarlyClosedPayload): `closedAt` is `now`, the
 *   actual close, and `close_at` stays the scheduled one — a rule-version item (#80, migration
 *   0053's guard). No VOID here: the judgement chooses it after the close (#173 item 4, #152).
 *   With no fill a person's account is on (`marketHasHumanFill`, read under the market lock — #20,
 *   ADR-0107 결정 4 '#120·#20'), whatever the pause's reason or review result, 판정 불가 included:
 *   `cancelled` instead, paused → cancelled, payload `{cancelledAt, source: 'early_close', reason,
 *   pauseId, approvalId, requestedBy, reviewResult}` (MarketCancelledPayload) with the system
 *   sentence (MARKET_NO_FILL_CANCEL_REASON); the result type stays null, and no judgement, 판정 이의
 *   or payout follows.
 *
 * For 재개, and for the 조기 마감 of a market held for a ledger failure, every live order of the market
 * is cancelled 일시 중단 at `now` before the event, its lock given back (`cancelLockedOrders` with
 * `endsHold`, #178): for a `ledger_failure` pause this is its recovery (ADR-0107 결정 4 #178 rows,
 * '조기 마감은 복구를 겸함'), and comes before any CLOSED or CANCELLED. The 조기 마감 of a market not held gets
 * the close's own processing instead (ADR-0107 결정 4 '#120·#20', 결정 5 '#120 조기 마감'): after the
 * event, every live order ends 만료 at `now` (`expireLockedOrders`, #120). After another reason's
 * pause both find nothing (the pause cancelled them), but rows from before #178. The
 * reconciliation's pass on the recovery is #93's.
 *
 * Then the pause's end: `resumed` or `early_closed` (a cancelling early close too: the end kind
 * says how the pause ended, the event where the market went), `now`, the approver, the event, the
 * request and the review result (a `basis_change` pause's alone). The caller cancels the close job
 * after COMMIT for an early close (hygiene: the worker skips a closed market anyway). A skip or a
 * throw cancels nothing.
 */
export async function endMarketPause(
  tx: Tx,
  input: EndMarketPauseInput,
): Promise<EndMarketPauseResult> {
  const { market, orders, now, approverId, path, reviewResult, approvalId, requestedBy } = input;
  assertMarketOrders(orders, market.id);
  if (approverId === requestedBy) {
    throw new Error('A pause decision is approved by an admin other than its requester');
  }
  if (market.status !== 'paused') return { ended: false, reason: 'not_paused' };
  if (market.closeAt.getTime() <= now.getTime()) return { ended: false, reason: 'close_passed' };
  const current = await currentMarketPause(tx, market.id);
  if (current?.id !== input.pause.id) return { ended: false, reason: 'stale' };
  const refusal = pauseDecisionRefusal(current.reason, { path, reviewResult });
  if (refusal !== null) {
    throw new Error(`A ${current.reason} pause's ${path} is refused: ${refusal.message}`);
  }

  await recoverPausedMarketReconciliation(tx, {
    marketId: market.id,
    approvalId,
    requestedBy,
    approverId,
    recovery: input.recovery,
  });
  const held = orders.markets[0]?.held ?? false;
  // 재개, and the 조기 마감 of a held market (its approval is the recovery, ADR-0107 결정 4 #178):
  // 취소 완료(일시 중단) before the status changes.
  const cancelled =
    path === 'resume' || held
      ? await cancelLockedOrders(tx, orders, { reason: 'paused', at: now, endsHold: true })
      : { cancelled: [], held: [], touched: { positions: [] } };
  const decided = { pauseId: current.id, approvalId, requestedBy, reviewResult };
  const resumed: MarketResumedPayload = decided;
  const earlyClosed: MarketEarlyClosedPayload = {
    closedAt: now.toISOString(),
    source: 'early_close',
    ...decided,
  };
  // '사용자 체결 0건' under the market lock (#20, ADR-0107 결정 4 '#120·#20'): an early close with
  // no fill a person's account is on cancels the market; the pause's end and the 만료 after it
  // (`path === 'early_close' && !held`) are the same.
  const cancels = path === 'early_close' && !(await marketHasHumanFill(tx, market.id));
  const earlyCancelled: MarketCancelledEarlyPayload = {
    cancelledAt: now.toISOString(),
    source: 'early_close',
    reason: MARKET_NO_FILL_CANCEL_REASON,
    ...decided,
  };
  const eventId = await transitionMarket(tx, {
    marketId: market.id,
    from: 'paused',
    to: cancels ? 'cancelled' : MARKET_PAUSE_PATH_STATUSES[path],
    type: path === 'resume' ? 'resumed' : cancels ? 'cancelled' : 'closed',
    actorId: approverId,
    payload:
      path === 'resume' ? { ...resumed } : cancels ? { ...earlyCancelled } : { ...earlyClosed },
    at: now,
  });
  const [pause] = await tx
    .update(marketPauses)
    .set({
      endKind: MARKET_PAUSE_PATH_END_KINDS[path],
      endedAt: now,
      endedBy: approverId,
      endEventId: eventId,
      endApprovalId: approvalId,
      reviewResult,
    })
    .where(and(eq(marketPauses.id, current.id), isNull(marketPauses.endedAt)))
    .returning();
  if (!pause) throw new Error(`Pause ${current.id} ended while its market was locked`);
  // 조기 마감 of a market not held: the close's own processing, 만료 at the close's instant (#120).
  const expired: ExpiredOrders =
    path === 'early_close' && !held
      ? await expireLockedOrders(tx, orders, { at: now })
      : { expired: [], held: [], touched: { positions: [] } };
  const [row] = await tx.select().from(markets).where(eq(markets.id, market.id));
  if (!row) throw new Error(`Market ${market.id} left its pause but could not be read back`);
  return { ended: true, market: row, pause, eventId, cancelled, expired };
}

export interface EndPauseAtCloseInput {
  marketId: string;
  /** The close's instant: the DB clock the worker read after the market lock. */
  now: Date;
  /** The worker's `closed` or `cancelled` event (`source: 'job'`). */
  eventId: number;
}

/**
 * The end of a PAUSED market's lasting pause at its close (#114; ADR-0093 decision 1 #173 items
 * 1·3: the close at `close_at` takes PAUSED to CLOSED on schedule, with no review and no approval —
 * or to CANCELLED with no fill a person's account is on, #20): `closed_at_close`, `now` and the
 * worker's `closed` or `cancelled` event, no approver, no request, no review result — the end kind
 * says how the pause ended, so a held market cancelled at its close stays held. Called by
 * `closeMarketAtClose` (the worker's `market.close`) in the transaction of that transition, under
 * the market lock. Returns the ended pause, or null when the market had none lasting (a row written
 * outside `pauseMarket`, a test's); a next-path request still waiting is moot from then on — its
 * approval is refused, its 반려 and 철회 still end it. It cancels no order: a `ledger_failure` market's
 * stay locked (held, ledger-held-markets.ts) until #93's recovery of the closed or cancelled market
 * expires them, and the close (`closeMarketAtClose`, #120) expires the rest after it.
 */
export async function endPauseAtClose(
  tx: Executor,
  { marketId, now, eventId }: EndPauseAtCloseInput,
): Promise<MarketPauseRow | null> {
  const [pause] = await tx
    .update(marketPauses)
    .set({ endKind: 'closed_at_close', endedAt: now, endEventId: eventId })
    .where(and(eq(marketPauses.marketId, marketId), isNull(marketPauses.endedAt)))
    .returning();
  return pause ?? null;
}

/**
 * Every pause of a market, the newest first (`paused_at`, then `id`): the admin detail's history
 * (`AdminMarket.pause.history`), where the first is the lasting one while it has no end. #24 reads
 * the same rows for the public judging record.
 */
export async function readMarketPauses(
  executor: Reader,
  marketId: string,
): Promise<MarketPauseRow[]> {
  return executor
    .select()
    .from(marketPauses)
    .where(eq(marketPauses.marketId, marketId))
    .orderBy(desc(marketPauses.pausedAt), desc(marketPauses.id));
}

/**
 * The market's lasting pause (no end), or null: a PAUSED market's current pause — at most one, by
 * the partial unique index of migration 0054. Read it under the market lock to act on it.
 */
export async function currentMarketPause(
  executor: Reader,
  marketId: string,
): Promise<MarketPauseRow | null> {
  const [pause] = await executor
    .select()
    .from(marketPauses)
    .where(and(eq(marketPauses.marketId, marketId), isNull(marketPauses.endedAt)))
    .limit(1);
  return pause ?? null;
}
