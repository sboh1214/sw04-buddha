import { randomUUID } from 'node:crypto';
import {
  isJudgementDelayStatus,
  judgementDelayNextReviewRefusal,
  judgementDelayStatusRefusal,
  type MarketDisplayState,
  type MarketJudgementDelayRecordedPayload,
} from '@buddha/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type * as schema from './schema/index.js';
import { marketEvents, marketJudgementDelays, type markets, profiles } from './schema/index.js';

type MarketRow = typeof markets.$inferSelect;

/** A 판정 지연 기록 (#142): a row of `market_judgement_delays`. */
export type MarketJudgementDelayRow = typeof marketJudgementDelays.$inferSelect;

/** A transaction handle of either app that writes and reads back what it inserted. */
type Executor = Pick<NodePgDatabase<typeof schema>, 'insert'>;

/** Anything that reads: a transaction handle or the pooled `Db`. */
type Reader = Pick<NodePgDatabase<typeof schema>, 'select'>;

/*
 * 판정 지연 기록 (#142, ADR-0106; ADR-0093 decision 1 #173 items 2·7·11·13, decision 3 '#142 지연
 * 사유', the owner's answers of 2026-11-03): the one place a record is written
 * (`recordJudgementDelay`, one admin, the API's `POST /admin/markets/:id/judgement-delays`) and
 * read — every record of a market with its recorder for the admin detail (`readJudgementDelays`),
 * and the current one without any account for the public detail (`readPublicJudgementDelay`).
 * The writer is called under `lockMarket`, with the market read `FOR UPDATE` after the lock and
 * `now` the DB clock read after the last lock, in the caller's transaction; it writes no admin
 * action (the API's) and publishes nothing (the caller republishes `market:status` with the key
 * unchanged after COMMIT). Nothing else writes a record, and nothing ever writes one again: no
 * edit, no withdrawal (owner answer (4)), and no job acts on one — the next review time and the
 * long-delay deadline passing create nothing (#173 item 11; the worker's tests pin it).
 */

/** The market row as `recordJudgementDelay` judges it: what reads '판정 지연', and its version. */
export type JudgementDelayMarketRow = Pick<
  MarketRow,
  | 'id'
  | 'status'
  | 'judgementVersion'
  | 'scheduledJudgementAt'
  | 'disputeDeadline'
  | 'disputeHoldCount'
  | 'correctionPending'
>;

export interface RecordJudgementDelayInput {
  /** The market row the caller read `FOR UPDATE` after `lockMarket`, in the same transaction. */
  market: JudgementDelayMarketRow;
  /** 지연 사유 (approvalReasonSchema: trimmed, 1–500 characters), public. */
  reason: string;
  /** 다음 검토 시각: after `now` and at most JUDGEMENT_DELAY_REVIEW_MAX_DAYS × 24 hours later. */
  nextReviewAt: Date;
  /** The recording admin (#173 item 2: one admin), the event's actor. */
  recordedBy: string;
  /** The DB clock read after the locks (`clockTimestamp`): what is judged, the record's instant. */
  now: Date;
}

export interface RecordJudgementDelayResult {
  /** The record row: the market's current record from now on. */
  delay: MarketJudgementDelayRow;
  /** Its `judgement_delay_recorded` event's id; the market's `status_event_id` does not move. */
  eventId: number;
}

/** What `isJudgementDelayed` (@buddha/shared) reads of a market row: the label's state. */
function displayStateOf(market: JudgementDelayMarketRow): MarketDisplayState {
  return {
    status: market.status,
    scheduledJudgementAt: market.scheduledJudgementAt?.toISOString() ?? null,
    disputeDeadline: market.disputeDeadline?.toISOString() ?? null,
    disputeHoldCount: market.disputeHoldCount,
    correctionPending: market.correctionPending,
  };
}

/**
 * 판정 지연 기록 (#142; ADR-0093 decision 1 #173 items 2·11): one admin records, at once, why a
 * delayed market's judgement is late and when it is next reviewed. The API refuses first, on the
 * same clock and with the same rules of @buddha/shared (MARKET_JUDGEMENT_DELAY_REFUSALS), so each
 * of these throws as a caller's bug before anything is written: a market that does not read
 * '판정 지연' at `now` (`judgementDelayStatusRefusal`: neither CLOSED nor PROVISIONAL, a CLOSED one
 * before its scheduled judgement or with none, a PROVISIONAL one before its 이의 기한 or held by
 * nothing — a waiting judgement registration refuses nothing), a next review time not after `now`
 * or more than JUDGEMENT_DELAY_REVIEW_MAX_DAYS × 24 hours after it
 * (`judgementDelayNextReviewRefusal`), and a PROVISIONAL market with no judgement version.
 *
 * The `judgement_delay_recorded` event first — a direct insert, not `transitionMarket`: no status
 * change (from and to null), the admin, payload `{delayId, reason, nextReviewAt, marketStatus,
 * judgementVersion}` (MarketJudgementDelayRecordedPayload: the time as ISO, the version null on
 * CLOSED) at `now` — then its `market_judgement_delays` row with that event's id (the row's id
 * generated first, so the event names it), the reason, the time, the episode (the market's status
 * and judgement version), the admin and `now`. Nothing of the market changes: no status, no
 * result, no scheduled judgement (#172 item 14), no `status_event_id`, no `updated_at` — so the
 * caller's `market:status` republishes the unchanged key, and open details refetch (A-M4-36).
 */
export async function recordJudgementDelay(
  tx: Executor,
  { market, reason, nextReviewAt, recordedBy, now }: RecordJudgementDelayInput,
): Promise<RecordJudgementDelayResult> {
  const refused =
    judgementDelayStatusRefusal(displayStateOf(market), now.getTime()) ??
    judgementDelayNextReviewRefusal(nextReviewAt, now.getTime());
  if (refused !== null || !isJudgementDelayStatus(market.status)) {
    throw new Error(`Market ${market.id} takes no judgement delay record (${String(refused)})`);
  }
  const marketStatus = market.status;
  const judgementVersion = marketStatus === 'closed' ? null : market.judgementVersion;
  // markets_provisional_check holds a version on every PROVISIONAL market.
  if (marketStatus === 'provisional' && judgementVersion === null) {
    throw new Error(`Market ${market.id} is provisional without its judgement`);
  }

  const delayId = randomUUID();
  const payload: MarketJudgementDelayRecordedPayload = {
    delayId,
    reason,
    nextReviewAt: nextReviewAt.toISOString(),
    marketStatus,
    judgementVersion,
  };
  const [event] = await tx
    .insert(marketEvents)
    .values({
      marketId: market.id,
      type: 'judgement_delay_recorded',
      actorId: recordedBy,
      payload: { ...payload },
      createdAt: now,
    })
    .returning({ id: marketEvents.id });
  if (!event) throw new Error('market_events insert returned no row');
  const [delay] = await tx
    .insert(marketJudgementDelays)
    .values({
      id: delayId,
      marketId: market.id,
      reason,
      nextReviewAt,
      marketStatus,
      judgementVersion,
      recordedBy,
      recordedAt: now,
      eventId: event.id,
    })
    .returning();
  if (!delay) throw new Error('market_judgement_delays insert returned no row');
  return { delay, eventId: event.id };
}

/** A record as the admin detail reads it: with its recorder's nickname. */
export interface JudgementDelayRead extends MarketJudgementDelayRow {
  /**
   * Null once the recorder closed the account — a former admin's (ADR-0086: an admin cannot close
   * one), whose record stays with its id.
   */
  recordedByNickname: string | null;
}

const recorder = alias(profiles, 'judgement_delay_recorder');

/**
 * Every record of a market, the newest first — the greatest `event_id`, the commit order under
 * the market lock (`market_judgement_delays_market_id_event_id_idx`) — each with its recorder's
 * nickname (a LEFT join: a missing profile hides no record): `AdminMarket.judgementDelays`, every
 * episode's, which the API marks with the current one (`withCurrentJudgementDelay` of
 * @buddha/shared: the first of the market's current status and judgement version). Admins only:
 * the public reads `readPublicJudgementDelay`, and #24 decides any public history.
 */
export async function readJudgementDelays(
  executor: Reader,
  marketId: string,
): Promise<JudgementDelayRead[]> {
  const rows = await executor
    .select({ delay: marketJudgementDelays, recordedByNickname: recorder.nickname })
    .from(marketJudgementDelays)
    .leftJoin(recorder, eq(recorder.userId, marketJudgementDelays.recordedBy))
    .where(eq(marketJudgementDelays.marketId, marketId))
    .orderBy(desc(marketJudgementDelays.eventId));
  return rows.map(({ delay, recordedByNickname }) => ({ ...delay, recordedByNickname }));
}

/**
 * What the public detail reads of a record: what it says and the episode it was made on — no
 * id, no account and no record time (#173 item 13, decision 3: 작업자·시각은 기록에 따로) — a
 * `JudgementDelayRecord` of @buddha/shared.
 */
export type PublicJudgementDelayRead = Pick<
  MarketJudgementDelayRow,
  'reason' | 'nextReviewAt' | 'marketStatus' | 'judgementVersion'
>;

/**
 * The market's current record (#142, ADR-0106: the episode rule of `currentJudgementDelay` in
 * @buddha/shared): the newest — the greatest `event_id` — recorded on the market's current status
 * and judgement version (none on CLOSED), or null when it has none: a market neither CLOSED nor
 * PROVISIONAL, a PROVISIONAL one whose earlier records were made while CLOSED or on a version a
 * correction replaced, or none recorded. The query selects no account and no record time, so
 * nothing of who recorded it can leave through the public detail; through `executor`, inside its
 * snapshot. It does not ask whether the market reads '판정 지연' — that is the read's clock:
 * `marketJudgementDelayOf` of @buddha/shared builds `Market.judgementDelay` from it.
 */
export async function readPublicJudgementDelay(
  executor: Reader,
  market: Pick<MarketRow, 'id' | 'status' | 'judgementVersion'>,
): Promise<PublicJudgementDelayRead | null> {
  if (!isJudgementDelayStatus(market.status)) return null;
  const version = market.status === 'closed' ? null : market.judgementVersion;
  const [row] = await executor
    .select({
      reason: marketJudgementDelays.reason,
      nextReviewAt: marketJudgementDelays.nextReviewAt,
      marketStatus: marketJudgementDelays.marketStatus,
      judgementVersion: marketJudgementDelays.judgementVersion,
    })
    .from(marketJudgementDelays)
    .where(
      and(
        eq(marketJudgementDelays.marketId, market.id),
        eq(marketJudgementDelays.marketStatus, market.status),
        version === null
          ? isNull(marketJudgementDelays.judgementVersion)
          : eq(marketJudgementDelays.judgementVersion, version),
      ),
    )
    .orderBy(desc(marketJudgementDelays.eventId))
    .limit(1);
  return row ?? null;
}
