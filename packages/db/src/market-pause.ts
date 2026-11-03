import { randomUUID } from 'node:crypto';
import {
  MARKET_PAUSE_PATH_END_KINDS,
  MARKET_PAUSE_PATH_STATUSES,
  pauseDecisionRefusal,
  pauseReasonNeedsPublishedAt,
  type MarketEarlyClosedPayload,
  type MarketPausePath,
  type MarketPauseReason,
  type MarketPauseReviewResult,
  type MarketPausedPayload,
  type MarketResumedPayload,
} from '@buddha/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { transitionMarket } from './market-transitions.js';
import type * as schema from './schema/index.js';
import { marketPauses, markets } from './schema/index.js';

type MarketRow = typeof markets.$inferSelect;

/** A pause (#114): a row of `market_pauses`. */
export type MarketPauseRow = typeof marketPauses.$inferSelect;

/** A transaction handle of either app, as `transitionMarket` takes it, that also reads back. */
type Executor = Pick<NodePgDatabase<typeof schema>, 'insert' | 'update' | 'select'>;

/** Anything that reads: a transaction handle or the pooled `Db`. */
type Reader = Pick<NodePgDatabase<typeof schema>, 'select'>;

/*
 * 거래 일시 중단·재개·조기 마감 (#114, ADR-0102; ADR-0093 decision 1 #173 items 1–4, decision 3 '#114
 * 조기 결과의 공개 시각'): the one place each edge into and out of PAUSED is taken, as the open is
 * `openScheduledMarket`'s (ADR-0100 결정 2), so the rule lives once — `pauseMarket` (OPEN →
 * PAUSED, one admin), `endMarketPause` (PAUSED → OPEN or CLOSED, by another admin's approval) and
 * `endPauseAtClose` (the worker's close at `close_at` of a PAUSED market). M9 cancels the pending
 * orders at the pause here (#173 item 3; for `ledger_failure` after the recovery — #119, #178),
 * and #93 may call `pauseMarket` with `ledger_failure`. Each is called under `lockMarket`, with the
 * market read `FOR UPDATE` after the lock and `now` the DB clock read after the last lock, in the
 * caller's transaction; each writes no admin action (the API's) and publishes nothing (the caller
 * publishes `market:status` after COMMIT).
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
  /** The DB clock read after the locks (`clockTimestamp`): what is judged, the pause's instant. */
  now: Date;
  /** The pausing admin (#173 item 2: one admin), the event's actor. */
  actorId: string;
  reason: MarketPauseReason;
  /** What happened (approvalReasonSchema: trimmed, 1–500 characters), admins only. */
  note: string;
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
 * `early_result`), at `now`, the market's `status_event_id` — then its `market_pauses` row with
 * that id (generated first, so the event names it), the reason, the note, the instant, `now`, the
 * admin and the event, lasting. Nothing else of the market changes: `close_at` stays, and the
 * close still comes at it, on schedule (#173 item 3). Orders: none yet (M9 cancels the pending
 * ones here).
 */
export async function pauseMarket(
  tx: Executor,
  { market, now, actorId, reason, note, resultPublishedAt }: PauseMarketInput,
): Promise<PauseMarketResult> {
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
  const [row] = await tx.select().from(markets).where(eq(markets.id, market.id));
  if (!row) throw new Error(`Market ${market.id} was paused but could not be read back`);
  return { paused: true, market: row, pause, eventId };
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
}

export type EndMarketPauseResult =
  | {
      ended: true;
      /** The market row read back after the writes: `open` or `closed`, its event's id. */
      market: MarketRow;
      /** The pause row, ended. */
      pause: MarketPauseRow;
      /** The `resumed` or `closed` event's id, the market's `status_event_id`. */
      eventId: number;
    }
  | { ended: false; reason: EndPauseSkipReason };

/**
 * PAUSED → OPEN (재개) or PAUSED → CLOSED (조기 마감) by an approved next path (#114; ADR-0093
 * decision 1 #173 items 2·4, owner answers Q1·Q2 of 2026-11-02), in the approval's transaction. It
 * ends a market that is PAUSED, whose close is after `now` and whose lasting pause is the
 * request's, checked in that order (EndPauseSkipReason); otherwise it writes nothing and says why.
 * A review result the pause's reason does not allow (`pauseDecisionRefusal` of @buddha/shared:
 * required for `basis_change`, none for the others, `not_judgeable` only with `early_close`) was
 * refused at the request, so here it is a caller's bug and throws — as does an approval by the
 * requester.
 *
 * `transitionMarket`'s event, its actor the approver, at `now`:
 * - `resume`: `resumed`, paused → open, payload `{pauseId, approvalId, requestedBy, reviewResult}`
 *   (MarketResumedPayload). `open_at` stays the first open's (the 신규 order reads it);
 * - `early_close`: `closed`, paused → closed, payload `{closedAt, source: 'early_close', pauseId,
 *   approvalId, requestedBy, reviewResult}` (MarketEarlyClosedPayload): `closedAt` is `now`, the
 *   actual close, and `close_at` stays the scheduled one — a rule-version item (#80, migration
 *   0053's guard). No VOID here: the judgement chooses it after the close (#173 item 4, #152).
 *
 * Then the pause's end: `resumed` or `early_closed`, `now`, the approver, the event, the request
 * and the review result (a `basis_change` pause's alone). The caller cancels the close job after
 * COMMIT for an early close (hygiene: the worker skips a closed market anyway).
 */
export async function endMarketPause(
  tx: Executor,
  input: EndMarketPauseInput,
): Promise<EndMarketPauseResult> {
  const { market, now, approverId, path, reviewResult, approvalId, requestedBy } = input;
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

  const decided = { pauseId: current.id, approvalId, requestedBy, reviewResult };
  const resumed: MarketResumedPayload = decided;
  const earlyClosed: MarketEarlyClosedPayload = {
    closedAt: now.toISOString(),
    source: 'early_close',
    ...decided,
  };
  const eventId = await transitionMarket(tx, {
    marketId: market.id,
    from: 'paused',
    to: MARKET_PAUSE_PATH_STATUSES[path],
    type: path === 'resume' ? 'resumed' : 'closed',
    actorId: approverId,
    payload: path === 'resume' ? { ...resumed } : { ...earlyClosed },
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
  const [row] = await tx.select().from(markets).where(eq(markets.id, market.id));
  if (!row) throw new Error(`Market ${market.id} left its pause but could not be read back`);
  return { ended: true, market: row, pause, eventId };
}

export interface EndPauseAtCloseInput {
  marketId: string;
  /** The close's instant: the DB clock the worker read after the market lock. */
  now: Date;
  /** The worker's `closed` event (`source: 'job'`). */
  eventId: number;
}

/**
 * The end of a PAUSED market's lasting pause at its close (#114; ADR-0093 decision 1 #173 items
 * 1·3: the close at `close_at` takes PAUSED to CLOSED on schedule, with no review and no
 * approval): `closed_at_close`, `now` and the worker's `closed` event, no approver, no request, no
 * review result. Called by the worker's `market.close` in the transaction of that transition, under
 * the market lock. Returns the ended pause, or null when the market had none lasting (a row written
 * outside `pauseMarket`, a test's); a next-path request still waiting is moot from then on — its
 * approval is refused, its 반려 and 철회 still end it.
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
