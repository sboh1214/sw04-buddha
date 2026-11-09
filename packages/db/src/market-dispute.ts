import {
  HOLDING_DISPUTE_STATUSES,
  MARKET_DISPUTE_DECISION_STATUSES,
  MARKET_JUDGEMENT_APPROVAL_KIND,
  approvalReasonSchema,
  disputeDecisionRefusal,
  disputeLinksSchema,
  disputeReasonSchema,
  disputeRetractionRefusal,
  type AdminDisputeListStatus,
  type DisputeDecisionRefusal,
  type DisputeEligibility,
  type DisputeRetractionRefusal,
  type DisputeSubmissionRefusal,
  type Keyset,
  type MarketDisputeDecision,
  type MarketStatus,
} from '@buddha/shared';
import { and, asc, desc, eq, gt, inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { isHumanAccountSql } from './account-types.js';
import type * as schema from './schema/index.js';
import {
  approvalRequests,
  marketDisputes,
  marketJudgements,
  markets,
  orders,
  profiles,
} from './schema/index.js';

type MarketRow = typeof markets.$inferSelect;

/** A 판정 이의 (#175): a row of `market_disputes`. */
export type MarketDisputeRow = typeof marketDisputes.$inferSelect;

/** A transaction handle of either app that writes and reads back. */
type Executor = Pick<NodePgDatabase<typeof schema>, 'insert' | 'update' | 'select'>;

/** Anything that reads: a transaction handle or the pooled `Db`. */
type Reader = Pick<NodePgDatabase<typeof schema>, 'select'>;

/*
 * 판정 이의 (#175, ADR-0104; ADR-0093 decision 1 #173 items 1·2·5–8·13·15, decision 3 '#176 정정
 * 대기', the owner's answers of 2026-11-02 and 2026-11-03): the one place a dispute is written, as a
 * judgement is `approveMarketJudgement`'s — `submitMarketDispute` (a member, while the 이의 기한 is
 * ahead), `retractMarketDispute` (its submitter, likewise), `decideMarketDispute` (기각·수용, one
 * admin other than the version's registrant), and for a 판정 정정 (#176, ADR-0105)
 * `closeDisputesForCorrection` (정정으로 종결, inside `correctMarketJudgement`) and
 * `reopenAcceptedDisputes` (a rejected or retracted correction's accepted disputes back to
 * pending) — each keeping `markets.dispute_hold_count` in the same transaction (the closing's is
 * set to 0 with the version it moves), and the one place the hold is asked (`confirmationHold`,
 * and `marketConfirmationHeld` for the worker's scan): a holding dispute of the current version,
 * or a waiting correction. Each writer is called under `lockMarket`, with the market read `FOR
 * UPDATE` after the lock and `now` the DB clock read after the last lock, in the caller's
 * transaction; each writes no admin action (the API's) and publishes nothing (the caller
 * republishes `market:status` after COMMIT). Never the confirmation: the worker alone confirms
 * (ADR-0103 9-12), the API registering `market.resolve` after the last dismissal past the
 * deadline, or after a correction's 반려 or 철회 that leaves nothing holding past it.
 */

/** HOLDING_DISPUTE_STATUSES as SQL literals, as the WHERE of `market_disputes_holding_idx`. */
const HOLDING_SQL = sql.raw(HOLDING_DISPUTE_STATUSES.map((status) => `'${status}'`).join(', '));

/**
 * The disputes that hold version `version` of market `marketId` — columns of an outer query or
 * values — as `market_disputes_holding_idx` serves them: pending or accepted (#173 items 1·7;
 * owner answer 2026-11-02).
 */
function holdingDisputesOf(marketId: SQLWrapper | string, version: SQLWrapper | number): SQL {
  return sql`${marketDisputes.marketId} = ${marketId} AND ${marketDisputes.judgementVersion} = ${version} AND ${marketDisputes.status} IN (${HOLDING_SQL})`;
}

/** MARKET_JUDGEMENT_APPROVAL_KIND as an SQL literal, as the hold spells it. */
const JUDGEMENT_KIND_SQL = sql.raw(`'${MARKET_JUDGEMENT_APPROVAL_KIND}'`);

/**
 * The `market_judgement` requests waiting on market `marketId` — a column of an outer query (the
 * uuid cast to text, as `target_id` holds it) or a value — by the approval requests' indexes: one
 * market's in `approval_requests_target_idx`, the waiting ones of a scan in
 * `approval_requests_pending_requested_at_idx` (#176, decision 3 '#176 정정 대기'). Any waiting
 * one, without reading its payload: on a PROVISIONAL market only a correction waits through the
 * routes (a first judgement's needs CLOSED), so this errs toward holding.
 */
function waitingJudgementsOf(marketId: SQL | string): SQL {
  return sql`${approvalRequests.targetType} = 'market' AND ${approvalRequests.targetId} = ${marketId} AND ${approvalRequests.kind} = ${JUDGEMENT_KIND_SQL} AND ${approvalRequests.status} = 'pending'`;
}

/**
 * Whether something holds a PROVISIONAL market's confirmation past its 이의 기한 (#173 items 1·7;
 * decision 3 '#176 정정 대기'): a dispute of its current judgement version that is pending or
 * accepted — an accepted one waits for a correction, and goes back to pending if the one
 * registered for it is rejected or retracted (owner answer 2026-11-02) — or a waiting
 * `market_judgement` request, a correction (#176, ADR-0105: its 반려 or 철회 carries on with the
 * version's deadline and disputes, its approval makes the next version with a new deadline). The
 * authoritative read, never the `dispute_hold_count` or `correction_pending` mirror. False for a
 * market with no judgement.
 */
export async function confirmationHold(
  executor: Reader,
  market: Pick<MarketRow, 'id' | 'judgementVersion'>,
): Promise<boolean> {
  if (market.judgementVersion === null) return false;
  const [held] = await executor
    .select({ id: marketDisputes.id })
    .from(marketDisputes)
    .where(holdingDisputesOf(market.id, market.judgementVersion))
    .limit(1);
  if (held !== undefined) return true;
  const [waiting] = await executor
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(waitingJudgementsOf(market.id))
    .limit(1);
  return waiting !== undefined;
}

/**
 * `confirmationHold` as SQL about the `markets` row of the outer query — `EXISTS` of a holding
 * dispute of its current version, or of a waiting `market_judgement` request (#176) — for the
 * worker's scan (`dueProvisionalMarkets`), so a held market takes no slot of its batch. Read by
 * index, never by a sequential scan: the holding disputes in `market_disputes_holding_idx`, the
 * waiting requests in `approval_requests_pending_requested_at_idx` (a queue's few rows, which the
 * planner hashes once for the batch) or `approval_requests_target_idx` (per market), as it costs
 * them — the schema test reads the plan.
 */
export function marketConfirmationHeld(): SQL {
  return sql`(EXISTS (SELECT 1 FROM ${marketDisputes} WHERE ${holdingDisputesOf(markets.id, markets.judgementVersion)}) OR EXISTS (SELECT 1 FROM ${approvalRequests} WHERE ${waitingJudgementsOf(sql`${markets.id}::text`)}))`;
}

/**
 * Whether `userId` has a fill on `marketId` (#173 item 6 '자격': 그 시장에 체결 이력이 있는 사용자):
 * an order of theirs on it with anything filled — the taker's and the resting order's alike, so
 * either side of a fill counts — whatever became of the order (a cancelled remainder keeps its
 * filled part, and a Coin-amount order counts its contracts like any other — #119, ADR-0112: a
 * rejected order filled none). The one place eligibility reads the orders.
 * A 사용자 is a person's account (`isHumanAccountSql`, #115 — the participants' rule, #177 13항):
 * the 운영 마켓메이커's own fills give it nothing to dispute with, while a member whose fill's other
 * side was the 운영 마켓메이커 has one like any other. Fills exist from #119's intake on, which the
 * deployed environment opens with `order.accepting` (ADR-0107 결정 3). The same basis as
 * `markets.trader_count` (#121, market-stats.ts): it counts the accounts this answers true for, so
 * `trader_count = 0` is #20's '사용자 체결 0건', until #132 leaves abnormal fills out (#177 13항);
 * #20 decides from the fills on this basis, abnormal or not (#177 14항, ADR-0107 결정 5): its
 * market-wide twin is `marketHasHumanFill` (market-cancel.ts).
 */
export async function hasMarketFill(
  executor: Reader,
  userId: string,
  marketId: string,
): Promise<boolean> {
  const [filled] = await executor
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.userId, userId),
        eq(orders.marketId, marketId),
        gt(orders.filledQty, 0),
        isHumanAccountSql(orders.userId),
      ),
    )
    .limit(1);
  return filled !== undefined;
}

/**
 * One more (+1), one fewer (−1) or as many (0, an acceptance or a reopening) holding disputes on
 * the market's mirror, and `updated_at` at the write's instant — the `ts` its republished
 * `market:status` carries — read back.
 */
async function moveHoldCount(
  tx: Executor,
  marketId: string,
  delta: 1 | 0 | -1,
  now: Date,
): Promise<MarketRow> {
  const [row] = await tx
    .update(markets)
    .set({ disputeHoldCount: sql`${markets.disputeHoldCount} + ${delta}`, updatedAt: now })
    .where(eq(markets.id, marketId))
    .returning();
  if (!row) throw new Error(`Market ${marketId} lost its dispute count while locked`);
  return row;
}

interface StandingInput {
  market: Pick<MarketRow, 'id' | 'status' | 'judgementVersion' | 'disputeDeadline'>;
  userId: string;
  /** The version asked about: the body's for a submission, the market's own for a read. */
  judgementVersion: number;
  now: Date;
}

/**
 * The first submission refusal that holds, in DISPUTE_SUBMISSION_REFUSALS' order, or null: the
 * submission's checks and the dispute screen's eligibility are one.
 */
async function submissionRefusal(
  executor: Reader,
  { market, userId, judgementVersion, now }: StandingInput,
): Promise<DisputeSubmissionRefusal | null> {
  if (market.status !== 'provisional') return 'not_provisional';
  if (judgementVersion !== market.judgementVersion) return 'stale_version';
  // markets_provisional_check holds the deadline on a PROVISIONAL market.
  if (market.disputeDeadline === null) {
    throw new Error(`Market ${market.id} is provisional without its dispute deadline`);
  }
  if (now.getTime() >= market.disputeDeadline.getTime()) return 'deadline_passed';
  const [profile] = await executor
    .select({ role: profiles.role })
    .from(profiles)
    .where(eq(profiles.userId, userId));
  if (!profile) throw new Error(`Account ${userId} has no profile`);
  if (profile.role === 'admin') return 'admin';
  if (!(await hasMarketFill(executor, userId, market.id))) return 'no_fill';
  const [existing] = await executor
    .select({ id: marketDisputes.id })
    .from(marketDisputes)
    .where(
      and(
        eq(marketDisputes.marketId, market.id),
        eq(marketDisputes.judgementVersion, judgementVersion),
        eq(marketDisputes.userId, userId),
      ),
    )
    .limit(1);
  if (existing) return 'duplicate';
  return null;
}

export interface SubmitMarketDisputeInput {
  /** The market row the caller read `FOR UPDATE` after `lockMarket`, in the same transaction. */
  market: Pick<MarketRow, 'id' | 'status' | 'judgementVersion' | 'disputeDeadline'>;
  /** The submitter, whose profile the caller holds `FOR KEY SHARE` (a closure racing it waits). */
  userId: string;
  /** The judgement version the screen showed (the body's): refused unless the current one. */
  judgementVersion: number;
  /** 근거 링크 and 사유 as the body schema took them (`disputeLinksSchema`, `disputeReasonSchema`). */
  links: readonly string[];
  reason: string;
  /** The DB clock read after the locks: what is judged, the submission's instant. */
  now: Date;
}

export type SubmitMarketDisputeResult =
  | {
      created: true;
      /** The dispute, pending. */
      dispute: MarketDisputeRow;
      /** The market row read back: `dispute_hold_count` one more. */
      market: MarketRow;
    }
  | { created: false; reason: DisputeSubmissionRefusal };

/**
 * 판정 이의 제출 (#175; ADR-0093 decision 1 #173 items 5·6·15): a member disputes a market's
 * provisional result. It writes a dispute when the market is PROVISIONAL, the version is its
 * current one, `now` is before its 이의 기한 (`now < dispute_deadline`, to the millisecond — the
 * confirmation needs `deadline <= now`, so the two never overlap, ADR-0103 9-2), the submitter is
 * not an admin, has a fill on it (`hasMarketFill`) and has no dispute of that version yet — a
 * retracted one included — checked in that order (DISPUTE_SUBMISSION_REFUSALS); otherwise it
 * writes nothing and says why. No restriction is asked: an account or a writing restriction leaves
 * disputes open (#173 item 6, ADR-0069 #45-12); the onboarding is the caller's (#57 item 8).
 *
 * The dispute — pending, the links and the reason as the body schema parses them (a body it
 * refuses is a caller's bug and throws), `now` — and one more on `markets.dispute_hold_count`, its
 * `updated_at` `now`.
 */
export async function submitMarketDispute(
  tx: Executor,
  input: SubmitMarketDisputeInput,
): Promise<SubmitMarketDisputeResult> {
  const { market, userId, judgementVersion, now } = input;
  const links = disputeLinksSchema.safeParse(input.links);
  const reason = disputeReasonSchema.safeParse(input.reason);
  if (!links.success || !reason.success) {
    throw new Error('A dispute is submitted with the links and the reason its body schema takes');
  }
  const refusal = await submissionRefusal(tx, { market, userId, judgementVersion, now });
  if (refusal !== null) return { created: false, reason: refusal };

  const [dispute] = await tx
    .insert(marketDisputes)
    .values({
      marketId: market.id,
      judgementVersion,
      userId,
      links: links.data,
      reason: reason.data,
      submittedAt: now,
    })
    .returning();
  if (!dispute) throw new Error('market_disputes insert returned no row');
  return { created: true, dispute, market: await moveHoldCount(tx, market.id, 1, now) };
}

export interface RetractMarketDisputeInput {
  /** The dispute row the caller read `FOR UPDATE` after the market lock and the market row. */
  dispute: Pick<MarketDisputeRow, 'id' | 'marketId' | 'judgementVersion' | 'status'>;
  /** Its market's row, read `FOR UPDATE` after `lockMarket`. */
  market: Pick<MarketRow, 'id' | 'judgementVersion' | 'disputeDeadline'>;
  /** The DB clock read after the locks: what is judged, the retraction's instant. */
  now: Date;
}

export type RetractMarketDisputeResult =
  | {
      retracted: true;
      /** The dispute, retracted at `now`. */
      dispute: MarketDisputeRow;
      /** The market row read back: `dispute_hold_count` one fewer. */
      market: MarketRow;
    }
  | { retracted: false; reason: DisputeRetractionRefusal };

/**
 * 판정 이의 철회 (#175; #173 item 6 '기한 안에 철회할 수 있다'): the submitter takes back a dispute
 * that is pending while its version's 이의 기한 is ahead (`now < deadline`); a decided, retracted
 * or correction-closed one (#176: `decided`), or one whose deadline has come — it has become the
 * reason the market waits — is refused (`disputeRetractionRefusal` of @buddha/shared, status
 * first). Whose it is is the caller's question (another account's is NOT_FOUND). It stays the
 * one of its version: no second dispute.
 *
 * The dispute `retracted` at `now`, and one fewer on `markets.dispute_hold_count`. A pending
 * dispute of a version that is not the market's current one throws: a correction closes those
 * when it moves the version (`closeDisputesForCorrection`, #176). A dispute a rejected or
 * retracted correction sent back to pending is retractable again while the deadline is ahead.
 */
export async function retractMarketDispute(
  tx: Executor,
  { dispute, market, now }: RetractMarketDisputeInput,
): Promise<RetractMarketDisputeResult> {
  if (dispute.marketId !== market.id) {
    throw new Error(`Dispute ${dispute.id} is not of market ${market.id}`);
  }
  if (
    dispute.status === 'pending' &&
    (dispute.judgementVersion !== market.judgementVersion || market.disputeDeadline === null)
  ) {
    throw new Error(`Dispute ${dispute.id} is pending on a version its market no longer has`);
  }
  // The deadline is read only for a pending dispute, of the market's current version.
  const refusal = disputeRetractionRefusal(dispute, market.disputeDeadline ?? now, now.getTime());
  if (refusal !== null) return { retracted: false, reason: refusal };

  const [retracted] = await tx
    .update(marketDisputes)
    .set({ status: 'retracted', retractedAt: now })
    .where(and(eq(marketDisputes.id, dispute.id), eq(marketDisputes.status, 'pending')))
    .returning();
  if (!retracted) throw new Error(`Dispute ${dispute.id} changed while its market was locked`);
  return {
    retracted: true,
    dispute: retracted,
    market: await moveHoldCount(tx, market.id, -1, now),
  };
}

export interface DecideMarketDisputeInput {
  /** The market row the caller read `FOR UPDATE` after `lockMarket`. */
  market: Pick<MarketRow, 'id' | 'judgementVersion'>;
  /** The dispute row the caller read `FOR UPDATE` after the market and `lockAdminRoles`. */
  dispute: Pick<MarketDisputeRow, 'id' | 'marketId' | 'judgementVersion' | 'status' | 'userId'>;
  /** The deciding admin — never the registrant of the dispute's version, nor its submitter. */
  adminId: string;
  decision: MarketDisputeDecision;
  /** The decision's reason (approvalReasonSchema: trimmed, 1–500), which the submitter reads. */
  reason: string;
  /** The DB clock read after the locks: the decision's instant. */
  now: Date;
}

export type DecideMarketDisputeResult =
  | {
      decided: true;
      /** The dispute, dismissed or accepted at `now` by the admin with the reason. */
      dispute: MarketDisputeRow;
      /** The market row read back: one fewer on `dispute_hold_count` for a dismissal. */
      market: MarketRow;
      /**
       * Whether the market is still held after the decision (`confirmationHold`): false after the
       * last holding dispute's dismissal, when the caller registers `market.resolve` if the
       * deadline has passed (#173 item 7 '모두 기각되면 바로 확정').
       */
      held: boolean;
    }
  | { decided: false; reason: Exclude<DisputeDecisionRefusal, 'registrant' | 'own'> };

/**
 * 기각·수용 (#175; ADR-0093 decision 1 #173 items 2·7): one admin who did not register the dispute's
 * judgement version — its approver may — dismisses a pending dispute (nothing to change) or accepts
 * it (a correction, #176), with a reason the submitter reads. A dispute no longer pending is
 * refused (`disputeDecisionRefusal` of @buddha/shared, status first: `retracted`, `decided`); a
 * decision by the registrant or by the submitter throws — the API refuses it first (`registrant`,
 * `own`), and here it is a caller's bug, as an approval by its registrant is. A dismissal is final;
 * an acceptance is undone only when the correction registered for it is rejected or retracted
 * (`reopenAcceptedDisputes`, owner answer 2026-11-02; #176), and the dispute, pending again, is
 * decided here again. The market's status is not asked again: a pending dispute exists only on a
 * PROVISIONAL market of its version. Admins who declared an interest (#173 item 15) are #143's to
 * keep out.
 *
 * The dispute `dismissed` or `accepted`, the admin, `now` and the reason; a dismissal takes one
 * off `markets.dispute_hold_count` — an accepted dispute still holds until a correction moves the
 * version. `held` reads a waiting correction too (`confirmationHold`).
 */
export async function decideMarketDispute(
  tx: Executor,
  input: DecideMarketDisputeInput,
): Promise<DecideMarketDisputeResult> {
  const { market, dispute, adminId, decision, now } = input;
  if (dispute.marketId !== market.id) {
    throw new Error(`Dispute ${dispute.id} is not of market ${market.id}`);
  }
  const reason = approvalReasonSchema.safeParse(input.reason);
  if (!reason.success) throw new Error('A dispute is decided with a reason of 1 to 500 characters');
  const [judgement] = await tx
    .select({ registeredBy: marketJudgements.registeredBy })
    .from(marketJudgements)
    .where(
      and(
        eq(marketJudgements.marketId, dispute.marketId),
        eq(marketJudgements.version, dispute.judgementVersion),
      ),
    );
  if (!judgement) throw new Error(`Dispute ${dispute.id} has no judgement`);
  const refusal = disputeDecisionRefusal(dispute, adminId, judgement.registeredBy, dispute.userId);
  if (refusal === 'registrant') {
    throw new Error('A dispute is decided by an admin other than its judgement’s registrant');
  }
  if (refusal === 'own')
    throw new Error('A dispute is decided by an admin other than its submitter');
  if (refusal !== null) return { decided: false, reason: refusal };

  const [decided] = await tx
    .update(marketDisputes)
    .set({
      status: MARKET_DISPUTE_DECISION_STATUSES[decision],
      decidedBy: adminId,
      decidedAt: now,
      decisionReason: reason.data,
    })
    .where(and(eq(marketDisputes.id, dispute.id), eq(marketDisputes.status, 'pending')))
    .returning();
  if (!decided) throw new Error(`Dispute ${dispute.id} changed while its market was locked`);
  // An accepted dispute still holds until its correction: the count stays, the instant moves.
  const row = await moveHoldCount(tx, market.id, decision === 'dismiss' ? -1 : 0, now);
  return { decided: true, dispute: decided, market: row, held: await confirmationHold(tx, row) };
}

/** Oldest submission first, then the id: the order a version's disputes are read in. */
const bySubmission = (a: MarketDisputeRow, b: MarketDisputeRow) =>
  a.submittedAt.getTime() - b.submittedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export interface CloseDisputesForCorrectionInput {
  /**
   * The market row the caller read `FOR UPDATE` after `lockMarket`, before the correction moves
   * it: its `judgement_version` is the version replaced.
   */
  market: Pick<MarketRow, 'id' | 'judgementVersion'>;
  /** The correction's approval instant: each closure's `closed_at`. */
  now: Date;
}

/**
 * 정정으로 종결 (#176, ADR-0105; ADR-0093 decision 1 #173 item 8): the pending disputes of the
 * version a correction's approval replaces, `closed_by_correction` at `now` — no decider, no
 * reason; their submitters may dispute the new version within its new deadline. The accepted ones
 * stay accepted: the correction answers them, and they hold nothing once the version moved. Only
 * `correctMarketJudgement` calls it, before it moves the version (ADR-0104 결과 5), so no pending
 * dispute is ever left on an old version (`retractMarketDispute`, `decideMarketDispute` assume
 * none); the mirror is set to 0 by that same move, not here. Returns the closed disputes, the
 * oldest submission first; none when none was pending. A market with no judgement throws.
 */
export async function closeDisputesForCorrection(
  tx: Executor,
  { market, now }: CloseDisputesForCorrectionInput,
): Promise<MarketDisputeRow[]> {
  if (market.judgementVersion === null) {
    throw new Error(`Market ${market.id} has no judgement whose disputes a correction closes`);
  }
  const closed = await tx
    .update(marketDisputes)
    .set({ status: 'closed_by_correction', closedAt: now })
    .where(
      and(
        eq(marketDisputes.marketId, market.id),
        eq(marketDisputes.judgementVersion, market.judgementVersion),
        eq(marketDisputes.status, 'pending'),
      ),
    )
    .returning();
  return closed.sort(bySubmission);
}

export interface ReopenAcceptedDisputesInput {
  /** The market row the caller read `FOR UPDATE` after `lockMarket`: its current version. */
  market: Pick<MarketRow, 'id' | 'judgementVersion'>;
  /**
   * The accepted disputes the rejected or retracted correction answered — its request's frozen
   * `correction.disputeIds` (the server listed them at the registration).
   */
  disputeIds: readonly string[];
  /** The DB clock read after the locks: the market's `updated_at`. */
  now: Date;
}

export interface ReopenAcceptedDisputesResult {
  /** The disputes sent back to pending, the oldest submission first (none when none was left). */
  disputes: MarketDisputeRow[];
  /** The market row read back: `dispute_hold_count` as it was (both statuses hold), `now`. */
  market: MarketRow;
}

/**
 * accepted → pending (#176, ADR-0105; owner answer 2026-11-02): when a correction is rejected —
 * or retracted by its registrant, this PR's choice: the correction the dispute waited for is gone
 * either way — the disputes it was registered for (`disputeIds`) that are still `accepted` on the
 * market's current version go back to pending, their decision cleared (`decided_by`, `decided_at`
 * and `decision_reason`, as market_disputes_decision_check holds; the acceptance stays in
 * `admin_actions` `market_dispute_accept` and the frozen request) and their submission kept, so
 * they rejoin the queue by their submission. An admin who did not register the version dismisses
 * one or accepts it again with a new correction (`decideMarketDispute`); its submitter may retract
 * it again before the deadline. A dispute accepted after the registration is not among them and
 * stays accepted; one of another market or version, or no longer accepted, is left as it is. The
 * market stays PROVISIONAL at its version, its deadline as it was; the mirror does not move.
 */
export async function reopenAcceptedDisputes(
  tx: Executor,
  { market, disputeIds, now }: ReopenAcceptedDisputesInput,
): Promise<ReopenAcceptedDisputesResult> {
  const reopened =
    disputeIds.length === 0 || market.judgementVersion === null
      ? []
      : await tx
          .update(marketDisputes)
          .set({ status: 'pending', decidedBy: null, decidedAt: null, decisionReason: null })
          .where(
            and(
              inArray(marketDisputes.id, [...disputeIds]),
              eq(marketDisputes.marketId, market.id),
              eq(marketDisputes.judgementVersion, market.judgementVersion),
              eq(marketDisputes.status, 'accepted'),
            ),
          )
          .returning();
  return {
    disputes: reopened.sort(bySubmission),
    market: await moveHoldCount(tx, market.id, 0, now),
  };
}

// ---- readers --------------------------------------------------------------------------------

/**
 * The market a dispute is about, as the member's and the operators' lists link to it, with its
 * current judgement version: a dispute of an older one is of a version a correction replaced
 * (#176).
 */
export interface DisputeMarketRef {
  id: string;
  slug: string;
  title: string;
  status: MarketStatus;
  judgementVersion: number;
}

/** A dispute as the operators read it: with its submitter's and decider's nicknames. */
export interface MarketDisputeRead extends MarketDisputeRow {
  /** Null once the submitter closed the account (its pending dispute is still decided, #140). */
  submitterNickname: string | null;
  deciderNickname: string | null;
}

/** One of the operators' queue rows (`GET /admin/market-disputes`): the dispute and its market. */
export interface AdminDisputeRead extends MarketDisputeRead {
  market: DisputeMarketRef;
}

/** One of a member's disputes: its market and its version's 이의 기한 (for `retractable`). */
export interface MemberDisputeRead extends MarketDisputeRow {
  market: DisputeMarketRef;
  /** `market_judgements.dispute_deadline` of the dispute's version. */
  disputeDeadline: Date;
}

/** A keyset page: at most `limit` items, and the next page's keyset when there is one. */
export interface DisputePage<T> {
  items: T[];
  next: Keyset | null;
}

export interface DisputePageInput {
  /** The previous page's `next` (a decoded cursor, `decodeKeyset(cursor, 'uuid')`). */
  after?: Keyset | undefined;
  limit: number;
}

const submitter = alias(profiles, 'dispute_submitter');
const decider = alias(profiles, 'dispute_decider');

const marketRef = {
  id: markets.id,
  slug: markets.slug,
  title: markets.title,
  status: markets.status,
  judgementVersion: markets.judgementVersion,
};

/** `marketRef` as read: a disputed market has a judgement (the dispute's foreign key names one). */
function marketRefOf(
  market: Omit<DisputeMarketRef, 'judgementVersion'> & {
    judgementVersion: number | null;
  },
): DisputeMarketRef {
  const { judgementVersion } = market;
  if (judgementVersion === null) throw new Error(`Disputed market ${market.id} has no judgement`);
  return { ...market, judgementVersion };
}

/** The row comparison of a keyset page, both halves bound and cast (apps/api `keysetPredicate`). */
function keysetBound(key: SQLWrapper, after: Keyset, direction: 'before' | 'after'): SQL {
  const cursor = sql`(${after.createdAt.toISOString()}::timestamptz, ${after.id}::uuid)`;
  return direction === 'before'
    ? sql`(${key}, ${marketDisputes.id}) < ${cursor}`
    : sql`(${key}, ${marketDisputes.id}) > ${cursor}`;
}

function pageOf<T>(rows: T[], limit: number, keysetOf: (row: T) => Keyset): DisputePage<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, next: rows.length > limit && last ? keysetOf(last) : null };
}

/**
 * The disputes of version `version` of a market, in every status, the oldest submission first
 * (`AdminMarket.disputes`, the admin detail where they are decided), each with its submitter's and
 * decider's nicknames. Empty for a market with no judgement (`version` null). The count of those
 * that hold (HOLDING_DISPUTE_STATUSES) is the authoritative `holding`.
 */
export async function readMarketDisputes(
  executor: Reader,
  marketId: string,
  version: number | null,
): Promise<MarketDisputeRead[]> {
  if (version === null) return [];
  const rows = await executor
    .select({
      dispute: marketDisputes,
      submitterNickname: submitter.nickname,
      deciderNickname: decider.nickname,
    })
    .from(marketDisputes)
    .leftJoin(submitter, eq(submitter.userId, marketDisputes.userId))
    .leftJoin(decider, eq(decider.userId, marketDisputes.decidedBy))
    .where(and(eq(marketDisputes.marketId, marketId), eq(marketDisputes.judgementVersion, version)))
    .orderBy(asc(marketDisputes.submittedAt), asc(marketDisputes.id));
  return rows.map(({ dispute, submitterNickname, deciderNickname }) => ({
    ...dispute,
    submitterNickname,
    deciderNickname,
  }));
}

/**
 * The 처리됨 half's key: when it was decided, retracted or closed by a correction (#176) — one of
 * them exactly — as `market_disputes_ended_at_idx` spells it.
 */
const endedAt = sql<Date>`coalesce(${marketDisputes.decidedAt}, ${marketDisputes.retractedAt}, ${marketDisputes.closedAt})`;

/**
 * 이의 접수 (`GET /admin/market-disputes`, #175): `pending` — 검토 대기, the oldest submission first
 * over `(submitted_at, id)` ascending (`market_disputes_pending_submitted_at_idx`), the keyset the
 * submission's, a dispute a rejected or retracted correction reopened among them by its
 * submission (#176) — or `decided` — 처리됨, every dispute no longer pending (dismissed, accepted,
 * retracted, closed by a correction; ADMIN_DISPUTE_LIST_STATUS_MEMBERS), the latest end first over
 * `(coalesce(decided_at, retracted_at, closed_at), id)` descending
 * (`market_disputes_ended_at_idx`), the keyset that instant's. Each with its market (its current
 * version too) and the two nicknames; no price, majority or position (N03 §5).
 */
export async function readAdminDisputes(
  executor: Reader,
  { status, after, limit }: DisputePageInput & { status: AdminDisputeListStatus },
): Promise<DisputePage<AdminDisputeRead>> {
  const pending = status === 'pending';
  const key = pending ? marketDisputes.submittedAt : endedAt;
  const rows = await executor
    .select({
      dispute: marketDisputes,
      submitterNickname: submitter.nickname,
      deciderNickname: decider.nickname,
      market: marketRef,
    })
    .from(marketDisputes)
    .innerJoin(markets, eq(markets.id, marketDisputes.marketId))
    .leftJoin(submitter, eq(submitter.userId, marketDisputes.userId))
    .leftJoin(decider, eq(decider.userId, marketDisputes.decidedBy))
    .where(
      and(
        // Spelled as the two partial indexes' WHERE.
        pending
          ? sql`${marketDisputes.status} = 'pending'`
          : sql`${marketDisputes.status} <> 'pending'`,
        after ? keysetBound(key, after, pending ? 'after' : 'before') : undefined,
      ),
    )
    .orderBy(
      ...(pending
        ? [asc(marketDisputes.submittedAt), asc(marketDisputes.id)]
        : [desc(endedAt), desc(marketDisputes.id)]),
    )
    .limit(limit + 1);
  const items = rows.map((row) => ({
    ...row.dispute,
    submitterNickname: row.submitterNickname,
    deciderNickname: row.deciderNickname,
    market: marketRefOf(row.market),
  }));
  return pageOf(items, limit, (item) => {
    const at = pending ? item.submittedAt : (item.decidedAt ?? item.retractedAt ?? item.closedAt);
    // market_disputes_decision_check, _retracted_check and _closed_check: an ended dispute has
    // its instant.
    if (at === null) throw new Error(`Dispute ${item.id} ended with no instant`);
    return { createdAt: at, id: item.id };
  });
}

const memberDisputeColumns = {
  dispute: marketDisputes,
  market: marketRef,
  disputeDeadline: marketJudgements.disputeDeadline,
};

/**
 * MY 판정 이의 (`GET /me/disputes`, #175): `userId`'s disputes, the newest submission first over
 * `(submitted_at, id)` descending (`market_disputes_user_id_submitted_at_idx`), each with its
 * market — its current version, so a dispute of a version a correction replaced reads as such
 * (#176) — and its own version's 이의 기한. Never who decided one (#173 item 13): the DTO leaves
 * `decided_by` out.
 */
export async function readMyDisputes(
  executor: Reader,
  userId: string,
  { after, limit }: DisputePageInput,
): Promise<DisputePage<MemberDisputeRead>> {
  const rows = await executor
    .select(memberDisputeColumns)
    .from(marketDisputes)
    .innerJoin(markets, eq(markets.id, marketDisputes.marketId))
    .innerJoin(
      marketJudgements,
      and(
        eq(marketJudgements.marketId, marketDisputes.marketId),
        eq(marketJudgements.version, marketDisputes.judgementVersion),
      ),
    )
    .where(
      and(
        eq(marketDisputes.userId, userId),
        after ? keysetBound(marketDisputes.submittedAt, after, 'before') : undefined,
      ),
    )
    .orderBy(desc(marketDisputes.submittedAt), desc(marketDisputes.id))
    .limit(limit + 1);
  const items = rows.map(({ dispute, market, disputeDeadline }) => ({
    ...dispute,
    market: marketRefOf(market),
    disputeDeadline,
  }));
  return pageOf(items, limit, (item) => ({ createdAt: item.submittedAt, id: item.id }));
}

export interface ReadMyMarketDisputeInput {
  /** The market as read (a public one: the caller answers NOT_FOUND for any other). */
  market: Pick<
    MarketRow,
    'id' | 'slug' | 'title' | 'status' | 'judgementVersion' | 'disputeDeadline'
  >;
  userId: string;
  /** The read's clock (the DB clock): whether the 이의 기한 has come. */
  now: Date;
}

export interface MyMarketDisputeRead {
  /** `eligible`, or the first submission refusal that holds (never `stale_version`). */
  eligibility: DisputeEligibility;
  /** The version the standing was read for: the market's current one, null before a judgement. */
  judgementVersion: number | null;
  /** The member's dispute of that version, whatever its status; null when none. */
  dispute: MemberDisputeRead | null;
}

/**
 * The dispute screen's state (`GET /me/disputes/markets/:marketId`, #175): `userId`'s standing on
 * the market's current judgement version — as `submitMarketDispute` would answer a submission of
 * it now, in the same order — and their dispute of that version, if any (after the confirmation
 * too, so its result stays visible: #173 item 7).
 */
export async function readMyMarketDispute(
  executor: Reader,
  { market, userId, now }: ReadMyMarketDisputeInput,
): Promise<MyMarketDisputeRead> {
  const version = market.judgementVersion;
  if (version === null) {
    return { eligibility: 'not_provisional', judgementVersion: null, dispute: null };
  }
  const [row] = await executor
    .select(memberDisputeColumns)
    .from(marketDisputes)
    .innerJoin(markets, eq(markets.id, marketDisputes.marketId))
    .innerJoin(
      marketJudgements,
      and(
        eq(marketJudgements.marketId, marketDisputes.marketId),
        eq(marketJudgements.version, marketDisputes.judgementVersion),
      ),
    )
    .where(
      and(
        eq(marketDisputes.marketId, market.id),
        eq(marketDisputes.judgementVersion, version),
        eq(marketDisputes.userId, userId),
      ),
    )
    .limit(1);
  const refusal = await submissionRefusal(executor, {
    market,
    userId,
    judgementVersion: version,
    now,
  });
  // A read of the current version is never stale.
  if (refusal === 'stale_version') throw new Error(`Market ${market.id} moved while read`);
  return {
    eligibility: refusal ?? 'eligible',
    judgementVersion: version,
    dispute: row
      ? { ...row.dispute, market: marketRefOf(row.market), disputeDeadline: row.disputeDeadline }
      : null,
  };
}
