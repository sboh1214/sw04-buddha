import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { approvalReasonSchema } from './approvals.js';
import { JUDGEMENT_DELAY_REVIEW_MAX_DAYS } from './constants.js';
import type { MarketStatus } from './enums.js';
import { expectedAccountIdSchema } from './expected-account.js';
import { judgementVersionSchema } from './market-judgement.js';
import { storableInstantSchema } from './market-rules.js';
import { type MarketDisplayState, isJudgementDelayed, longDelayDeadline } from './market-times.js';

/**
 * 판정 지연 기록 (#142, ADR-0106; ADR-0093 decision 1 #173 items 2·7·11·13, decision 2 #172 item
 * 14, decision 3 '#142 지연 사유', decision 4, and the owner's answers of 2026-11-03 (1)–(4)):
 *
 * - 기록 (`POST /admin/markets/:id/judgement-delays`): one admin alone, no approval request (#173
 *   item 2) — any admin, the registrant of a waiting judgement included — on a market that reads
 *   '판정 지연' on the database clock under the market lock (`judgementDelayStatusRefusal`): a
 *   CLOSED market past its scheduled judgement, or a PROVISIONAL one a 판정 이의 or a waiting 판정
 *   정정 holds past its 이의 기한 (#173 items 7·11; `isJudgementDelayed`). It writes the reason —
 *   one public sentence, 1..500 characters, no classification (decision 3; M13 may add one) — and
 *   the next review time: a future instant at most JUDGEMENT_DELAY_REVIEW_MAX_DAYS × 24 hours
 *   after the record (`judgementDelayNextReviewRefusal`, owner answer (1)), kept in UTC.
 * - A record changes no `markets` column: no status, no result — never a NO or a VOID — and the
 *   scheduled judgement is never moved (#172 item 14: the record announces the lateness). It
 *   never makes a market read '판정 지연' either; past its scheduled judgement a CLOSED market
 *   reads so with no record (#173 item 11).
 * - No edit and no withdrawal (owner answer (4)): a change is a new record, and the earlier ones
 *   stay as its history (`market_judgement_delays`, append-only, @buddha/db).
 * - The current record (`currentJudgementDelay`): the newest of the market's current episode —
 *   the status and judgement version it was recorded on. A judgement's approval, a correction's
 *   approval or the confirmation leaves the earlier records history without writing anything; a
 *   rejected or retracted correction keeps the version's.
 * - Public (`Market.judgementDelay`, `marketJudgementDelayOf`): while the market reads '판정 지연'
 *   and has a current record, its reason, its next review time and whether that time has passed
 *   ('갱신 대기', owner answer (2)) on the server's clock at the read — never who recorded it nor
 *   when (#173 item 13, decision 3). The time passing creates nothing (#173 item 11): the public
 *   keeps the last reason and the admin detail warns that the update is late.
 * - 장기 지연 (owner answer (3), `isLongDelayDeadlineReached`): a CLOSED market past its long-delay
 *   deadline (`longDelayDeadline`) gets a warning in its admin 판정 panel to apply the rule's
 *   지연·취소·무효 처리 through 판정 등록 (#152) — nothing is automatic; the list is #145's.
 *
 * Each record writes the market event `judgement_delay_recorded` (no status change, the market's
 * `status_event_id` unmoved, so `market:status` republishes the unchanged key) and the admin action
 * `market_delay_record` (enums.ts).
 */

// ---- limits ---------------------------------------------------------------------------
/** JUDGEMENT_DELAY_REVIEW_MAX_DAYS in hours: the CHECK's `interval '168 hours'`, DST-free. */
export const JUDGEMENT_DELAY_REVIEW_MAX_HOURS = JUDGEMENT_DELAY_REVIEW_MAX_DAYS * 24;

/** JUDGEMENT_DELAY_REVIEW_MAX_DAYS in milliseconds: N × 24 hours, an addition of instants. */
export const JUDGEMENT_DELAY_REVIEW_MAX_MS = JUDGEMENT_DELAY_REVIEW_MAX_HOURS * 3_600_000;

// ---- statuses -------------------------------------------------------------------------
/**
 * The statuses a record is made on (`market_judgement_delays.market_status`, held by a CHECK):
 * the two that read '판정 지연' (`isJudgementDelayed`, #173 items 11·12). A CLOSED market's record
 * has no judgement version, a PROVISIONAL one's the version it was recorded on.
 */
export const JUDGEMENT_DELAY_STATUSES = [
  'closed',
  'provisional',
] as const satisfies readonly MarketStatus[];
export type JudgementDelayStatus = (typeof JUDGEMENT_DELAY_STATUSES)[number];
export const judgementDelayStatusSchema = z
  .enum(JUDGEMENT_DELAY_STATUSES)
  .meta({ id: 'JudgementDelayStatus' });

export function isJudgementDelayStatus(status: MarketStatus): status is JudgementDelayStatus {
  return (JUDGEMENT_DELAY_STATUSES as readonly MarketStatus[]).includes(status);
}

// ---- refusals -------------------------------------------------------------------------
/**
 * The refusal details of a record (VALIDATION_ERROR, the API's), each message under the path it
 * names, in this order after the body's own checks:
 * - `status` (`judgementDelayStatusRefusal`): a market neither CLOSED nor PROVISIONAL
 *   (`notAwaitingJudgement`); a CLOSED or PROVISIONAL one that does not read '판정 지연' on the
 *   database clock (`notDelayed` — before its scheduled judgement, or with none; before its 이의
 *   기한, or held by nothing);
 * - `nextReviewAt` (`judgementDelayNextReviewRefusal`, the database clock after the locks): not
 *   after now (`notAfterNow`), or later than JUDGEMENT_DELAY_REVIEW_MAX_DAYS × 24 hours from now
 *   (`tooFarAhead`; exactly that far is taken).
 */
export const MARKET_JUDGEMENT_DELAY_REFUSALS = {
  status: { notAwaitingJudgement: 'not awaiting a judgement', notDelayed: 'not delayed' },
  nextReviewAt: {
    notAfterNow: 'not after now',
    tooFarAhead: `more than ${JUDGEMENT_DELAY_REVIEW_MAX_DAYS} days ahead`,
  },
} as const;

type Refusals = typeof MARKET_JUDGEMENT_DELAY_REFUSALS;
export type JudgementDelayStatusRefusal = Refusals['status'][keyof Refusals['status']];
export type JudgementDelayNextReviewRefusal =
  Refusals['nextReviewAt'][keyof Refusals['nextReviewAt']];

const instantMs = (at: string | Date) => (typeof at === 'string' ? Date.parse(at) : at.getTime());

/**
 * Why a market takes no record at `nowMs` — its status, then whether it reads '판정 지연' — or
 * null when it takes one (#173 items 2·7·11). The service refuses with it on the database clock
 * after the market lock; the admin screen turns the button off by it. A waiting judgement
 * registration refuses nothing.
 */
export function judgementDelayStatusRefusal(
  market: MarketDisplayState,
  nowMs: number,
): JudgementDelayStatusRefusal | null {
  if (!isJudgementDelayStatus(market.status)) {
    return MARKET_JUDGEMENT_DELAY_REFUSALS.status.notAwaitingJudgement;
  }
  return isJudgementDelayed(market, nowMs)
    ? null
    : MARKET_JUDGEMENT_DELAY_REFUSALS.status.notDelayed;
}

/**
 * Why a next review time is refused at `nowMs`, or null when it is taken (owner answer (1)):
 * after `nowMs` and at most JUDGEMENT_DELAY_REVIEW_MAX_MS later, to the millisecond, whatever the
 * market's status. The service refuses with it on the database clock it records the row at; the
 * admin dialog checks its draft by it on the screen's clock.
 */
export function judgementDelayNextReviewRefusal(
  nextReviewAt: string | Date,
  nowMs: number,
): JudgementDelayNextReviewRefusal | null {
  const at = instantMs(nextReviewAt);
  if (at <= nowMs) return MARKET_JUDGEMENT_DELAY_REFUSALS.nextReviewAt.notAfterNow;
  if (at > nowMs + JUDGEMENT_DELAY_REVIEW_MAX_MS) {
    return MARKET_JUDGEMENT_DELAY_REFUSALS.nextReviewAt.tooFarAhead;
  }
  return null;
}

/**
 * Whether a record's next review time has passed at `nowMs` ('갱신 대기', owner answer (2)): from
 * the instant on, to the millisecond. Nothing follows from it but the display — the public keeps
 * the reason, the admin detail warns that the update is late (#173 item 11). A DTO's
 * `nextReviewPassed` is it on the server's clock at the read; a screen's one-shot timer at the
 * instant flips it without a reload.
 */
export function judgementDelayReviewPassed(nextReviewAt: string | Date, nowMs: number): boolean {
  return nowMs >= instantMs(nextReviewAt);
}

// ---- the current record ---------------------------------------------------------------
/** What the current-record rule reads of a record: the status and version it was made on. */
export interface JudgementDelayEpisode {
  marketStatus: MarketStatus;
  judgementVersion: number | null;
}

/** What it reads of the market: its status and its current judgement version. */
export interface JudgementDelayMarket {
  status: MarketStatus;
  judgementVersion: number | null;
}

/**
 * Whether a record is of the market's current episode: recorded on the status and the judgement
 * version the market has now. A judgement's approval (CLOSED → PROVISIONAL v1), a correction's
 * approval (the next version) and the confirmation end an episode; a rejected or retracted
 * correction keeps it.
 */
export function isCurrentJudgementDelayEpisode(
  record: JudgementDelayEpisode,
  market: JudgementDelayMarket,
): boolean {
  return (
    record.marketStatus === market.status && record.judgementVersion === market.judgementVersion
  );
}

/**
 * The market's current record: the newest of its current episode, from `records` newest first
 * (by `market_judgement_delays.event_id`, the commit order under the market lock), or null when
 * none is of it. The earlier records are history; none is ever written again.
 */
export function currentJudgementDelay<T extends JudgementDelayEpisode>(
  records: readonly T[],
  market: JudgementDelayMarket,
): T | null {
  return records.find((record) => isCurrentJudgementDelayEpisode(record, market)) ?? null;
}

/**
 * `records` (newest first) each with whether it is the market's current record
 * (`currentJudgementDelay`): at most one is — `AdminJudgementDelay.current`.
 */
export function withCurrentJudgementDelay<T extends JudgementDelayEpisode>(
  records: readonly T[],
  market: JudgementDelayMarket,
): (T & { current: boolean })[] {
  const current = currentJudgementDelay(records, market);
  return records.map((record) => ({ ...record, current: record === current }));
}

/** What the public answer reads of a record: what it says and the episode it was made on. */
export interface JudgementDelayRecord extends JudgementDelayEpisode {
  reason: string;
  nextReviewAt: string | Date;
}

/**
 * `Market.judgementDelay` at `nowMs` (the server's clock at the read, the one its
 * `judgementDelayed` is read on): the current record's reason, its next review time as ISO and
 * whether that has passed, while the market reads '판정 지연' (`isJudgementDelayed`); null while it
 * does not, and while it has no current record — a CLOSED market's record never labels it once
 * PROVISIONAL. `records` newest first.
 */
export function marketJudgementDelayOf(
  records: readonly JudgementDelayRecord[],
  market: MarketDisplayState & { judgementVersion: number | null },
  nowMs: number,
): MarketJudgementDelay | null {
  if (!isJudgementDelayed(market, nowMs)) return null;
  const current = currentJudgementDelay(records, market);
  if (current === null) return null;
  return {
    reason: current.reason,
    nextReviewAt: new Date(instantMs(current.nextReviewAt)).toISOString(),
    nextReviewPassed: judgementDelayReviewPassed(current.nextReviewAt, nowMs),
  };
}

// ---- the long delay -------------------------------------------------------------------
/**
 * Whether a CLOSED market's 장기 지연 기한 (`longDelayDeadline`: the scheduled judgement plus
 * `longDelayDays` × 24 hours, #172 item 10) has come at `nowMs` (owner answer 2026-11-03 (3)): its
 * admin 판정 panel then warns to apply the rule's 지연·취소·무효 처리 (`delayHandling`) through 판정
 * 등록 — VOID too needs #152's registration and another admin's approval. False on any other
 * status (a PROVISIONAL market has a result) and while either time is not filled in. Nothing
 * happens at the deadline (#173 item 11); records and a waiting registration change nothing.
 */
export function isLongDelayDeadlineReached(
  market: {
    status: MarketStatus;
    scheduledJudgementAt: string | null;
    longDelayDays: number | null;
  },
  nowMs: number,
): boolean {
  if (market.status !== 'closed') return false;
  const deadline = longDelayDeadline(market.scheduledJudgementAt, market.longDelayDays);
  return deadline !== null && nowMs >= Date.parse(deadline);
}

// ---- bodies ---------------------------------------------------------------------------
/**
 * `POST /admin/markets/:id/judgement-delays` (one admin): the reason — public, required and
 * trimmed, 1..500 (approvals.ts) — the next review time (an ISO instant in UTC from
 * STORABLE_INSTANT_MIN on; seconds taken) and the admin on screen (ADR-0092). Whether the market
 * reads '판정 지연' and whether the time is ahead and within the bound are the service's, on the
 * database clock under the market lock (MARKET_JUDGEMENT_DELAY_REFUSALS).
 */
export const recordJudgementDelayBodySchema = z
  .object({
    reason: approvalReasonSchema,
    nextReviewAt: storableInstantSchema,
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'RecordJudgementDelayBody' });
export type RecordJudgementDelayBody = z.infer<typeof recordJudgementDelayBodySchema>;

// ---- records --------------------------------------------------------------------------
/**
 * `judgement_delay_recorded`'s payload (enums.ts): the record row, its reason (public, so the
 * event carries it for #188's notices and #145's list), its next review time (ISO), and the status
 * and judgement version it was made on (null on CLOSED). The event's actor is the admin; it names
 * no other account.
 */
export interface MarketJudgementDelayRecordedPayload {
  delayId: string;
  reason: string;
  nextReviewAt: string;
  marketStatus: JudgementDelayStatus;
  judgementVersion: number | null;
}

/**
 * `market_delay_record`'s payload (admin_actions, target the market): the event's fields. No
 * before and after: the market row is unchanged.
 */
export type MarketDelayRecordActionPayload = MarketJudgementDelayRecordedPayload;

// ---- read models ----------------------------------------------------------------------
/**
 * `Market.judgementDelay` (`marketJudgementDelayOf`): the current record's reason, its next review
 * time (ISO) and whether it has passed on the server's clock at the read ('갱신 대기'). Nobody's
 * name and no record time (#173 item 13, decision 3); no earlier record (#24 decides any public
 * history).
 */
export const marketJudgementDelaySchema = z
  .object({
    reason: z.string(),
    nextReviewAt: z.iso.datetime(),
    nextReviewPassed: z.boolean(),
  })
  .meta({ id: 'MarketJudgementDelay' });
export type MarketJudgementDelay = z.infer<typeof marketJudgementDelaySchema>;

/**
 * One record as the admin detail shows it (`AdminMarket.judgementDelays`, newest first): what it
 * says, the status and judgement version it was made on (null on CLOSED), when (the database
 * clock) and by whom — an account closed since keeps its id with a null nickname — and whether it
 * is the market's current record (`withCurrentJudgementDelay`: at most one is).
 */
export const adminJudgementDelaySchema = z
  .object({
    id: z.uuid(),
    reason: z.string(),
    nextReviewAt: z.iso.datetime(),
    marketStatus: judgementDelayStatusSchema,
    judgementVersion: judgementVersionSchema.nullable(),
    recordedAt: z.iso.datetime(),
    recordedBy: adminAccountActorSchema,
    current: z.boolean(),
  })
  .meta({ id: 'AdminJudgementDelay' });
export type AdminJudgementDelay = z.infer<typeof adminJudgementDelaySchema>;
