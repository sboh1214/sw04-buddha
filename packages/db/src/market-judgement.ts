import {
  MARKET_JUDGEMENT_APPROVAL_KIND,
  MARKET_SCAN_BATCH_MAX,
  SETTLEMENT_STEPS,
  approvalReasonSchema,
  disputeDeadlineOf,
  disputeWindowMinutesSchema,
  isBeforeScheduledJudgement,
  marketJudgementRequestPayloadSchema,
  type MarketJudgementCorrectedPayload,
  type MarketJudgementRequestPayload,
  type MarketProvisionalPayload,
  type MarketResolvedByDeadlinePayload,
  type MarketResult,
} from '@buddha/shared';
import { and, asc, desc, eq, lte, not, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  closeDisputesForCorrection,
  confirmationHold,
  marketConfirmationHeld,
  type MarketDisputeRow,
} from './market-dispute.js';
import { transitionMarket } from './market-transitions.js';
import type * as schema from './schema/index.js';
import {
  type approvalRequests,
  marketEvents,
  marketJudgements,
  marketSettlementSteps,
  markets,
} from './schema/index.js';

type MarketRow = typeof markets.$inferSelect;

/** A judgement (#152): a row of `market_judgements`. */
export type MarketJudgementRow = typeof marketJudgements.$inferSelect;

/** A transaction handle of either app, as `transitionMarket` takes it, that also reads back. */
type Executor = Pick<NodePgDatabase<typeof schema>, 'insert' | 'update' | 'select'>;

/** Anything that reads: a transaction handle or the pooled `Db`. */
type Reader = Pick<NodePgDatabase<typeof schema>, 'select'>;

/*
 * 판정 (#152, ADR-0103; ADR-0093 decision 1 #173 items 1·5·9, decision 3 the #152 rows): the one
 * place each edge of the judgement is taken, as the open is `openScheduledMarket`'s and the pause
 * `pauseMarket`'s — `approveMarketJudgement` (CLOSED → PROVISIONAL, an admin other than the
 * registrant approving a `market_judgement` request; the API's), `correctMarketJudgement` (판정
 * 정정: a PROVISIONAL market's next version, the same approval of a request whose `correction` is
 * set; #176, ADR-0105) and `resolveProvisionalMarket` (PROVISIONAL → RESOLVED once the dispute
 * deadline has passed with nothing held; the worker's `market.resolve` alone — after #175's last
 * dismissal past the deadline too, or a correction's 반려 or 철회 past it, which the API registers
 * at once: ADR-0103 9-12, ADR-0104). Each is called under `lockMarket`, with `now` the DB clock
 * read after the last lock, in the caller's transaction; each writes no admin action (the API's)
 * and publishes nothing (the caller publishes `market:status` after COMMIT). A first judgement's
 * registration, its 반려 and its 철회 change no market and live in the API alone
 * (`approval_requests`); a correction's also set the `correction_pending` mirror
 * (`setCorrectionPending`) and its 반려 and 철회 reopen its accepted disputes
 * (`reopenAcceptedDisputes`, market-dispute.ts).
 */

/**
 * Why `approveMarketJudgement` left a market as it was: `not_closed` — it is not CLOSED (not
 * closed yet, or PROVISIONAL since another approval; MARKET_JUDGEMENT_REFUSALS `status` 'not
 * closed').
 */
export type JudgementPublishSkipReason = 'not_closed';

export interface ApproveMarketJudgementInput {
  /** The market row the caller read `FOR UPDATE` after `lockMarket`, in the same transaction. */
  market: Pick<
    MarketRow,
    'id' | 'status' | 'ruleVersion' | 'judgementVersion' | 'scheduledJudgementAt'
  >;
  /**
   * The `market_judgement` request being approved (pending or already approved in this
   * transaction): its payload (`marketJudgementRequestPayloadSchema`) is the registration, its
   * reason the description, its requester the registrant.
   */
  request: Pick<
    typeof approvalRequests.$inferSelect,
    'id' | 'kind' | 'targetType' | 'targetId' | 'payload' | 'requestedBy' | 'requestReason'
  >;
  /** The DB clock read after the locks: what is judged, the publication's instant. */
  now: Date;
  /** The approving admin — never the registrant (throws) — the event's actor. */
  approverId: string;
  /**
   * Whether the approver confirmed the NO condition's event deadline (decision 3 '등록 시점').
   * Required true before the market's scheduled judgement — the API refuses it first
   * (`eventDeadlineConfirmed` 'required'), so false then throws here — and kept either way.
   */
  eventDeadlineConfirmed: boolean;
  /** The release setting `market.dispute_window` as the approval read it, minutes (1..10,080). */
  disputeWindowMinutes: number;
}

export type ApproveMarketJudgementResult =
  | {
      published: true;
      /** The market row read back: `provisional`, its result, version, deadline and event. */
      market: MarketRow;
      /** The judgement the approval made, the market's current one. */
      judgement: MarketJudgementRow;
      /** The `provisional` event's id, the market's `status_event_id`. */
      eventId: number;
    }
  | { published: false; reason: JudgementPublishSkipReason };

type JudgementRequest = ApproveMarketJudgementInput['request'];

/**
 * A `market_judgement` request's registration (its frozen payload), checked as an approval reads
 * it: a request of another kind or market, an approval by its registrant (decision 3 '역할') and a
 * payload the shared schema refuses each throw — the API refuses the two first, so a caller's bug.
 */
function registrationOf(
  market: { id: string },
  request: JudgementRequest,
  approverId: string,
): MarketJudgementRequestPayload {
  if (
    request.kind !== MARKET_JUDGEMENT_APPROVAL_KIND ||
    request.targetType !== 'market' ||
    request.targetId !== market.id
  ) {
    throw new Error(`Request ${request.id} is no judgement of market ${market.id}`);
  }
  if (approverId === request.requestedBy) {
    throw new Error('A judgement is approved by an admin other than its registrant');
  }
  return marketJudgementRequestPayloadSchema.parse(request.payload);
}

/**
 * The approval's checks after its status (C5, decision 3 '등록 시점'): the rule version the
 * registration followed is still the market's — nothing moves it after the close (ADR-0101 takes
 * no supplement then) — and an approval before the scheduled judgement confirms the event
 * deadline; either failing throws (the API refuses the second first). Answers what the judgement
 * keeps of the confirmation: only one that was asked for — after the scheduled judgement none is.
 */
function approvalConfirmation(
  market: Pick<MarketRow, 'id' | 'ruleVersion' | 'scheduledJudgementAt'>,
  registration: MarketJudgementRequestPayload,
  now: Date,
  eventDeadlineConfirmed: boolean,
): boolean {
  if (registration.ruleVersion !== market.ruleVersion) {
    throw new Error(
      `Market ${market.id} is at rule version ${String(market.ruleVersion)}, its judgement ` +
        `followed ${String(registration.ruleVersion)}`,
    );
  }
  const early = isBeforeScheduledJudgement(market.scheduledJudgementAt, now.getTime());
  if (early && !eventDeadlineConfirmed) {
    throw new Error('A judgement approved before its scheduled time confirms the event deadline');
  }
  return early && eventDeadlineConfirmed;
}

interface JudgementRowInput {
  marketId: string;
  request: JudgementRequest;
  registration: MarketJudgementRequestPayload;
  version: number;
  /** What `approvalConfirmation` answered. */
  eventDeadlineConfirmed: boolean;
  disputeWindowMinutes: number;
  /** The approval's instant: `published_at`. */
  now: Date;
  /** `now` plus the window, exactly (market_judgements_dispute_check). */
  disputeDeadline: Date;
  approverId: string;
  /** The event that published it: `provisional`, or `judgement_corrected` for a correction. */
  eventId: number;
  /** 정정 사유: null for version 1 alone (market_judgements_correction_reason_check). */
  correctionReason: string | null;
}

/**
 * The `market_judgements` row an approval makes — the first judgement's and a correction's alike:
 * the registration as the request froze it (the source's name and address as copied from the
 * rules), the description its reason, the confirmation, the window, `now` as `published_at`, the
 * deadline, the 정정 사유, the request, the registrant, the approver and the event.
 */
async function insertJudgement(tx: Executor, row: JudgementRowInput): Promise<MarketJudgementRow> {
  const { registration, request, now } = row;
  const { source } = registration;
  const [judgement] = await tx
    .insert(marketJudgements)
    .values({
      marketId: row.marketId,
      version: row.version,
      result: registration.result,
      sourcePriority: source?.priority ?? null,
      sourceName: source?.name ?? null,
      sourceUrl: source?.url ?? null,
      fallbackReason: registration.fallbackReason,
      voidReason: registration.voidReason,
      evidenceLinks: registration.evidence.links,
      evidenceDescription: request.requestReason,
      collectedAt: new Date(registration.evidence.collectedAt),
      ruleVersion: registration.ruleVersion,
      eventDeadlineConfirmed: row.eventDeadlineConfirmed,
      disputeWindowMinutes: row.disputeWindowMinutes,
      publishedAt: now,
      disputeDeadline: row.disputeDeadline,
      correctionReason: row.correctionReason,
      approvalId: request.id,
      registeredBy: request.requestedBy,
      approvedBy: row.approverId,
      provisionalEventId: row.eventId,
      createdAt: now,
    })
    .returning();
  if (!judgement) throw new Error('market_judgements insert returned no row');
  return judgement;
}

/**
 * CLOSED → PROVISIONAL (#152; ADR-0093 decision 1 #173 items 1·5·9 — '별도 검토자가 판정을 승인할
 * 때'), in the approval's transaction: it publishes a CLOSED market's judgement and fixes its
 * dispute deadline; a market not CLOSED is left as it was (`not_closed`). VOID goes the same way
 * (#173 item 9). Refused at the API first, so a caller's bug here, each throws before anything is
 * written: a request of another kind or market, an approval by its registrant (decision 3 '역할'),
 * a payload the shared schema refuses, a correction's (`correctMarketJudgement` approves those:
 * the payload's `correction` tells them apart, never the status — #176), a window out of range, a
 * rule version that moved since the registration (nothing moves it after the close: ADR-0101
 * takes no supplement then — C5), and an approval before the scheduled judgement without the
 * event deadline confirmed.
 *
 * `transitionMarket`'s `provisional` event — from `closed`, to `provisional`, the approver, payload
 * `{version, result, approvalId, requestedBy, disputeDeadline}` (MarketProvisionalPayload) at
 * `now` — with the market's `resolved_result` the result (ADR-0095 8-2, 8-7), `judgement_version`
 * the next version (1 for the first: only approved judgements are numbered) and `dispute_deadline`
 * `now` plus the window, exactly (#173 item 5: fixed now, never moved by a later change of the
 * setting). Then the `market_judgements` row: the registration as the request froze it, the
 * description its reason, the confirmation (false at or after the scheduled judgement, where none
 * is asked, whatever the caller sent), the window, `now` as `published_at`, the deadline, the
 * request, the registrant, the approver and the event. `resolved_at` stays null: it is the
 * confirmation's (ADR-0095 결과 5). The caller registers `market.resolve` at the deadline after
 * COMMIT (`marketResolveJobId`).
 */
export async function approveMarketJudgement(
  tx: Executor,
  input: ApproveMarketJudgementInput,
): Promise<ApproveMarketJudgementResult> {
  const { market, request, now, approverId, disputeWindowMinutes } = input;
  const registration = registrationOf(market, request, approverId);
  if (registration.correction !== null) {
    throw new Error(`Request ${request.id} is a correction: correctMarketJudgement approves it`);
  }
  if (!disputeWindowMinutesSchema.safeParse(disputeWindowMinutes).success) {
    throw new Error(`A dispute window of ${String(disputeWindowMinutes)} minutes is out of range`);
  }
  if (market.status !== 'closed') return { published: false, reason: 'not_closed' };
  const eventDeadlineConfirmed = approvalConfirmation(
    market,
    registration,
    now,
    input.eventDeadlineConfirmed,
  );

  const version = (market.judgementVersion ?? 0) + 1;
  const disputeDeadline = disputeDeadlineOf(now, disputeWindowMinutes);
  const payload: MarketProvisionalPayload = {
    version,
    result: registration.result,
    approvalId: request.id,
    requestedBy: request.requestedBy,
    disputeDeadline: disputeDeadline.toISOString(),
  };
  const eventId = await transitionMarket(tx, {
    marketId: market.id,
    from: 'closed',
    to: 'provisional',
    type: 'provisional',
    actorId: approverId,
    payload: { ...payload },
    at: now,
    set: { resolvedResult: registration.result, judgementVersion: version, disputeDeadline },
  });
  const judgement = await insertJudgement(tx, {
    marketId: market.id,
    request,
    registration,
    version,
    eventDeadlineConfirmed,
    disputeWindowMinutes,
    now,
    disputeDeadline,
    approverId,
    eventId,
    correctionReason: null,
  });
  const [row] = await tx.select().from(markets).where(eq(markets.id, market.id));
  if (!row) throw new Error(`Market ${market.id} was judged but could not be read back`);
  return { published: true, market: row, judgement, eventId };
}

/**
 * Why `correctMarketJudgement` left a market as it was (#176): `not_provisional` — it is not
 * PROVISIONAL (MARKET_JUDGEMENT_REFUSALS `status` 'not provisional': confirmed — which a waiting
 * correction's hold rules out but a factory — or never published); `stale` — its current version
 * is not the correction's base version (`correction.baseVersion` 'stale': another correction was
 * approved first, which one-waiting-per-market rules out).
 */
export type JudgementCorrectionSkipReason = 'not_provisional' | 'stale';

export interface CorrectMarketJudgementInput {
  /** The market row the caller read `FOR UPDATE` after `lockMarket`, in the same transaction. */
  market: Pick<
    MarketRow,
    'id' | 'status' | 'ruleVersion' | 'judgementVersion' | 'scheduledJudgementAt'
  >;
  /**
   * The `market_judgement` request being approved (pending or already approved in this
   * transaction) whose payload's `correction` is set: its payload is the new version's
   * registration, its reason the description, its requester the registrant.
   */
  request: JudgementRequest;
  /** The DB clock read after the locks: what is judged, the new version's publication. */
  now: Date;
  /** The approving admin — never the registrant (throws) — the event's actor. */
  approverId: string;
  /** As `approveMarketJudgement`'s: required true before the scheduled judgement. */
  eventDeadlineConfirmed: boolean;
}

export type CorrectMarketJudgementResult =
  | {
      corrected: true;
      /**
       * The market row the UPDATE returned: still `provisional`, the new result, version and
       * deadline, `dispute_hold_count` 0, `correction_pending` false, `status_event_id` the
       * `judgement_corrected` event, `updated_at` `now`.
       */
      market: MarketRow;
      /** The judgement the correction made, the market's current one: version `previous` + 1. */
      judgement: MarketJudgementRow;
      /** The version it replaced (the base version), kept as it was published. */
      previous: MarketJudgementRow;
      /** The `judgement_corrected` event's id, the market's `status_event_id`. */
      eventId: number;
      /** The base version's pending disputes it closed (정정으로 종결), the oldest submission first. */
      closedDisputes: MarketDisputeRow[];
    }
  | { corrected: false; reason: JudgementCorrectionSkipReason };

/**
 * 판정 정정 (#176, ADR-0105; ADR-0093 decision 1 #173 items 2·5·8, decision 3 '#176 정정 대기'), in
 * the approval's transaction: an admin other than the registrant approves a correction of a
 * PROVISIONAL market's current version, which makes the next version — the status unchanged (no
 * PROVISIONAL → PROVISIONAL transition: `transitionMarket` is not used). A market not PROVISIONAL
 * (`not_provisional`) or no longer at the correction's base version (`stale`) is left as it was.
 * Refused at the API first, so a caller's bug here, each throws before anything is written: a
 * request of another kind or market, an approval by its registrant, a payload the shared schema
 * refuses, a first judgement's (`approveMarketJudgement`'s), a 정정 사유 out of approvalReasonSchema,
 * a rule version that moved since the registration, an approval before the scheduled judgement
 * without the event deadline confirmed (as a first judgement's, decision 3 '등록 시점'), and a base
 * version with no judgement row.
 *
 * In one go, in this order: (1) the base version's pending disputes closed as 정정으로 종결 at
 * `now` (`closeDisputesForCorrection`, before the version moves — ADR-0104 결과 5; the accepted
 * ones stay accepted, answered by the correction); (2) the `judgement_corrected` event — no status
 * on either side, the approver, payload `{version, previousVersion, result, previousResult,
 * approvalId, requestedBy, disputeDeadline, closedDisputes}` (MarketJudgementCorrectedPayload) at
 * `now`; (3) the `market_judgements` row of the next version, as a first judgement's
 * (`insertJudgement`) with its 정정 사유 and the base version's `dispute_window_minutes` — never the
 * release setting (#173 item 5 '첫 기한과 같은 길이'), so every version has v1's length — and the
 * deadline `now` plus it (later than the base's: `now` is after its publication); (4) the market:
 * `resolved_result` the new result, `judgement_version` and `dispute_deadline` the new version's,
 * `dispute_hold_count` 0 (the new version has no dispute, and the base version's hold nothing now),
 * `correction_pending` false, `status_event_id` the event (so `market:status` republishes
 * PROVISIONAL under a newer key) and `updated_at` `now` — matched on the status and the base
 * version, so a row that moved fails loudly. The caller writes the admin action and, after
 * COMMIT, publishes `market:status` and registers `market.resolve` at the new deadline; the old
 * deadline's job finds `not_due` (the deadline it reads is the new one) and needs no cancel.
 */
export async function correctMarketJudgement(
  tx: Executor,
  input: CorrectMarketJudgementInput,
): Promise<CorrectMarketJudgementResult> {
  const { market, request, now, approverId } = input;
  const registration = registrationOf(market, request, approverId);
  const { correction } = registration;
  if (correction === null) {
    throw new Error(`Request ${request.id} is a first judgement: approveMarketJudgement takes it`);
  }
  const reason = approvalReasonSchema.safeParse(correction.reason);
  if (!reason.success) throw new Error('A correction has a reason of 1 to 500 characters');
  if (market.status !== 'provisional') return { corrected: false, reason: 'not_provisional' };
  const base = market.judgementVersion;
  if (base === null || correction.baseVersion !== base) {
    return { corrected: false, reason: 'stale' };
  }
  const eventDeadlineConfirmed = approvalConfirmation(
    market,
    registration,
    now,
    input.eventDeadlineConfirmed,
  );
  const [previous] = await tx
    .select()
    .from(marketJudgements)
    .where(and(eq(marketJudgements.marketId, market.id), eq(marketJudgements.version, base)));
  if (!previous) throw new Error(`Market ${market.id} has no judgement of version ${String(base)}`);

  const closedDisputes = await closeDisputesForCorrection(tx, { market, now });
  const version = base + 1;
  const { disputeWindowMinutes } = previous;
  const disputeDeadline = disputeDeadlineOf(now, disputeWindowMinutes);
  const payload: MarketJudgementCorrectedPayload = {
    version,
    previousVersion: base,
    result: registration.result,
    previousResult: previous.result,
    approvalId: request.id,
    requestedBy: request.requestedBy,
    disputeDeadline: disputeDeadline.toISOString(),
    closedDisputes: closedDisputes.length,
  };
  const [event] = await tx
    .insert(marketEvents)
    .values({
      marketId: market.id,
      type: 'judgement_corrected',
      actorId: approverId,
      payload: { ...payload },
      createdAt: now,
    })
    .returning({ id: marketEvents.id });
  if (!event) throw new Error('market_events insert returned no row');
  const judgement = await insertJudgement(tx, {
    marketId: market.id,
    request,
    registration,
    version,
    eventDeadlineConfirmed,
    disputeWindowMinutes,
    now,
    disputeDeadline,
    approverId,
    eventId: event.id,
    correctionReason: reason.data,
  });
  const [row] = await tx
    .update(markets)
    .set({
      resolvedResult: registration.result,
      judgementVersion: version,
      disputeDeadline,
      disputeHoldCount: 0,
      correctionPending: false,
      statusEventId: event.id,
      updatedAt: now,
    })
    .where(
      and(
        eq(markets.id, market.id),
        eq(markets.status, 'provisional'),
        eq(markets.judgementVersion, base),
      ),
    )
    .returning();
  if (!row) {
    throw new Error(`Market ${market.id} is no longer provisional at version ${String(base)}`);
  }
  return { corrected: true, market: row, judgement, previous, eventId: event.id, closedDisputes };
}

export interface SetCorrectionPendingInput {
  marketId: string;
  /** True for a correction's registration; false for its 반려 or 철회 (its approval sets it). */
  pending: boolean;
  /** The DB clock read after the locks: the market's `updated_at`, the republish's `ts`. */
  now: Date;
}

/**
 * The `correction_pending` mirror (#176, ADR-0105; ADR-0093 decision 3 '#176 정정 대기'), under the
 * market lock in the caller's transaction: true when a correction of a PROVISIONAL market is
 * registered, false when it is rejected or retracted (`correctMarketJudgement` clears it on the
 * approval) — for the label '판정 지연' past the deadline alone; the hold is the waiting request
 * itself (`confirmationHold`). True on a market that is not PROVISIONAL fails
 * (markets_correction_pending_status_check): the API refuses such a registration first. Returns
 * the market row read back, `updated_at` `now`.
 */
export async function setCorrectionPending(
  tx: Executor,
  { marketId, pending, now }: SetCorrectionPendingInput,
): Promise<MarketRow> {
  const [row] = await tx
    .update(markets)
    .set({ correctionPending: pending, updatedAt: now })
    .where(eq(markets.id, marketId))
    .returning();
  if (!row) throw new Error(`Market ${marketId} not found`);
  return row;
}

/**
 * Why `resolveProvisionalMarket` left a market as it was, in the order it is judged:
 * - `not_found`: no market has the id (a job left from before a whole-database wipe);
 * - `not_provisional`: it is not PROVISIONAL — confirmed already (a duplicate job, the scan after
 *   the delayed job), or not published yet;
 * - `not_due`: its dispute deadline is still ahead (a stale job, or the job of a deadline a
 *   correction moved later, #176 — the market's own deadline is read, never the job's) — asked
 *   before the hold, so a market whose deadline is ahead stays `not_due`;
 * - `held`: its deadline has passed and something holds it (`confirmationHold`, #173 items 1·7):
 *   a 판정 이의 of its current version pending or accepted (#175, ADR-0104), or a correction
 *   waiting for its decision (#176, decision 3 '#176 정정 대기'). The last dismissal, or the
 *   correction's 반려 or 철회 with nothing else holding, lifts it, and the job the API registers
 *   then, or the per-minute scan, confirms the market; the correction's approval moves the
 *   deadline instead.
 */
export type ResolveSkipReason = 'not_found' | 'not_provisional' | 'not_due' | 'held';

export interface ResolveProvisionalMarketInput {
  marketId: string;
  /** The DB clock read after `lockMarket`: what is judged, the confirmation's instant. */
  now: Date;
}

export type ResolveProvisionalMarketResult =
  | {
      resolved: true;
      /** The market row read back: `resolved`, `resolved_at` `now`, its event's id. */
      market: MarketRow;
      /** The `resolved` event's id, the market's `status_event_id`. */
      eventId: number;
      /** The judgement version confirmed (`markets.judgement_version`) and its result. */
      version: number;
      result: MarketResult;
    }
  | { resolved: false; reason: ResolveSkipReason };

/**
 * PROVISIONAL → RESOLVED (#152; ADR-0093 decision 1 #173 item 1, an automatic edge: actor NULL,
 * the worker): the confirmation of a published result once its dispute deadline has passed with
 * nothing held. Called under `lockMarket`; it reads the market `FOR UPDATE` itself and confirms one
 * that is PROVISIONAL, whose `dispute_deadline` is at or before `now` and that nothing holds
 * (`confirmationHold`: no 판정 이의 of its current version pending or accepted, #175, and no
 * correction waiting, #176), checked in that order (ResolveSkipReason); otherwise it writes
 * nothing and says why. Only the worker calls it (ADR-0103 9-12): when the last holding dispute is
 * dismissed after the deadline, or a correction is rejected or retracted after it with nothing
 * else holding, the API registers `market.resolve` at once, and the per-minute scan
 * (`dueProvisionalMarkets`) confirms a market whose hold cleared and whose job was lost. After a
 * correction it confirms the current version, by its own deadline.
 *
 * `transitionMarket`'s `resolved` event — from `provisional`, to `resolved`, no actor, payload
 * `{version, result, source: 'deadline'}` (MarketResolvedByDeadlinePayload: the judgement version
 * confirmed, `markets.judgement_version`, and its result) at `now` — with `resolved_at` `now` (the
 * 확정 시각 theme results read, ADR-0095 결과 5), then one `pending` `market_settlement_steps` row
 * per SETTLEMENT_STEPS step, so the step table never lags the status (ADR-0046 D5; the API's
 * interim judgement wrote them before #152). A VOID is confirmed too; its payout fails loudly in
 * SETTLING until #126 (ADR-0095 8-5). The caller registers `market.finalize` after COMMIT
 * (`marketFinalizeJobId(marketId, now)`): RESOLVED → SETTLING is the finalize's own transaction.
 */
export async function resolveProvisionalMarket(
  tx: Executor,
  { marketId, now }: ResolveProvisionalMarketInput,
): Promise<ResolveProvisionalMarketResult> {
  const [market] = await tx.select().from(markets).where(eq(markets.id, marketId)).for('update');
  if (!market) return { resolved: false, reason: 'not_found' };
  if (market.status !== 'provisional') return { resolved: false, reason: 'not_provisional' };
  const { disputeDeadline, judgementVersion, resolvedResult } = market;
  // markets_provisional_check holds all three on a PROVISIONAL market.
  if (disputeDeadline === null || judgementVersion === null || resolvedResult === null) {
    throw new Error(`Market ${marketId} is provisional without its judgement`);
  }
  if (disputeDeadline.getTime() > now.getTime()) return { resolved: false, reason: 'not_due' };
  // Under the market lock every dispute writer takes, so no dispute lands or ends meanwhile.
  if (await confirmationHold(tx, market)) return { resolved: false, reason: 'held' };

  const payload: MarketResolvedByDeadlinePayload = {
    version: judgementVersion,
    result: resolvedResult,
    source: 'deadline',
  };
  const eventId = await transitionMarket(tx, {
    marketId,
    from: 'provisional',
    to: 'resolved',
    type: 'resolved',
    actorId: null,
    payload: { ...payload },
    at: now,
    set: { resolvedAt: now },
  });
  // A PROVISIONAL market has never been confirmed, so no step row exists yet: a plain insert, and
  // the primary key (market_id, step) turns any surprise into a rollback, not a duplicate.
  await tx.insert(marketSettlementSteps).values(
    SETTLEMENT_STEPS.map((step) => ({
      marketId,
      step,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    })),
  );
  const [row] = await tx.select().from(markets).where(eq(markets.id, marketId));
  if (!row) throw new Error(`Market ${marketId} was confirmed but could not be read back`);
  return {
    resolved: true,
    market: row,
    eventId,
    version: judgementVersion,
    result: resolvedResult,
  };
}

/**
 * The worker's confirmation scan (`market-resolve-scan`, #152): the PROVISIONAL markets whose
 * dispute deadline has passed on the database clock and that nothing holds — no 판정 이의 of
 * their current version pending or accepted (#175) and no correction waiting (#176;
 * `marketConfirmationHeld`) — the earliest deadline first, at most `limit` (MARKET_SCAN_BATCH_MAX
 * by default): so a held market takes no slot of a batch, and one whose hold cleared after its
 * deadline is confirmed within the minute. Served by `markets_provisional_dispute_deadline_idx`
 * (migration 0055), each market's hold read in `market_disputes_holding_idx` (0056) and an index
 * of `approval_requests` (`marketConfirmationHeld`). A plain read: `resolveProvisionalMarket`
 * re-checks everything under the lock. The query itself, not run, so the schema test reads its
 * plan.
 */
export function dueProvisionalMarkets(executor: Reader, limit: number = MARKET_SCAN_BATCH_MAX) {
  return executor
    .select({ id: markets.id })
    .from(markets)
    .where(
      and(
        eq(markets.status, 'provisional'),
        lte(markets.disputeDeadline, sql`now()`),
        not(marketConfirmationHeld()),
      ),
    )
    .orderBy(asc(markets.disputeDeadline), asc(markets.id))
    .limit(limit);
}

/**
 * Every judgement of a market, the newest version first — the current one and those corrections
 * replaced (#176's 판정 버전 이력), each as it was published, with its 정정 사유: the admin detail's
 * record, and #24's public one (without the two accounts). Empty until one is approved, and for a
 * market judged by the interim route before #152 (D4).
 */
export async function readMarketJudgements(
  executor: Reader,
  marketId: string,
): Promise<MarketJudgementRow[]> {
  return executor
    .select()
    .from(marketJudgements)
    .where(eq(marketJudgements.marketId, marketId))
    .orderBy(desc(marketJudgements.version));
}

/**
 * The market's current judgement — the one `markets.judgement_version` names — or null when it
 * has none (not judged yet, or judged by the interim route before #152).
 */
export async function currentMarketJudgement(
  executor: Reader,
  marketId: string,
): Promise<MarketJudgementRow | null> {
  const [row] = await executor
    .select({ judgement: marketJudgements })
    .from(marketJudgements)
    .innerJoin(
      markets,
      and(
        eq(markets.id, marketJudgements.marketId),
        eq(markets.judgementVersion, marketJudgements.version),
      ),
    )
    .where(eq(marketJudgements.marketId, marketId))
    .limit(1);
  return row?.judgement ?? null;
}
