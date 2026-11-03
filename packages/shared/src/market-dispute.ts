import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { cursorQuerySchema } from './api/pagination.js';
import { approvalReasonSchema } from './approvals.js';
import { type AdminActionType, marketStatusSchema } from './enums.js';
import {
  type ExpectedAccountBody,
  expectedAccountBodySchema,
  expectedAccountIdSchema,
} from './expected-account.js';
import {
  JUDGEMENT_EVIDENCE_LINKS_MAX,
  JUDGEMENT_EVIDENCE_LINK_MAX,
  duplicateLinkIndexes,
  evidenceLinkSchema,
  judgementVersionSchema,
} from './market-judgement.js';

/**
 * 판정 이의 (#175, ADR-0104; ADR-0093 decision 1 #173 items 1·2·5–8·11–13·15, decision 3 the rows
 * '#175 토론의 이의 안내' and '#176 정정 대기', decision 4, and the owner's answers of 2026-11-02
 * and 2026-11-03; the correction's part #176, ADR-0105). Not 제재 이의 — a sanction appeal goes by
 * email (ADR-0084) and is apart:
 *
 * - 제출 (`POST /markets/:id/disputes`): a member with a fill on the market — either side of a fill
 *   counts (#173 item 6, `hasMarketFill` in @buddha/db) — disputes the provisional result of its
 *   current judgement version while the 이의 기한 #152 fixed is ahead (`now < disputeDeadline`,
 *   the database clock under the market lock; #173 item 5). Evidence links (1..DISPUTE_LINKS_MAX)
 *   and a reason, both required; one per member per judgement version — a retracted one still
 *   counts, so a dispute is never edited by retracting and submitting again ('고칠 수는 없다').
 *   An account restriction or a writing restriction leaves it open (#173 item 6, ADR-0069 #45-12);
 *   an unfinished onboarding refuses it (ONBOARDING_REQUIRED, #57 item 8). An admin may not
 *   dispute: admins never trade and decide disputes (#173 item 15). Nobody can until #119 opens
 *   orders: no fill exists before it.
 * - 철회 (`POST /me/disputes/:id/retract`, signed in is enough): the submitter's own, while it is
 *   pending and the deadline is ahead. After the deadline it is the reason the market waits.
 * - 기각·수용 (`POST /admin/markets/:id/disputes/:disputeId/dismiss`, `…/accept`): one admin who is
 *   not the registrant of the dispute's judgement version — its approver may (#173 item 2) — with
 *   a reason the submitter reads (#173 item 7). A dismissal is final. Accepting is a correction
 *   (#173 item 7, market-judgement.ts): the accepted dispute keeps holding the market until a
 *   correction is approved, which moves the version past it (it stays accepted); a correction
 *   registered for it that is rejected or retracted sends it back to pending, to be dismissed or
 *   accepted again with a new correction (owner answer 2026-11-02; #176, ADR-0105).
 * - 정정으로 종결 (#173 item 8): a correction's approval closes the replaced version's pending
 *   disputes (`closed_by_correction`); their submitters may dispute the new version within its
 *   new deadline — one per member per version.
 * - The hold (#173 items 1·7): a dispute of the current version pending or accepted
 *   (HOLDING_DISPUTE_STATUSES) keeps the market PROVISIONAL past its deadline, and so does a
 *   waiting correction (decision 3 '#176 정정 대기'). With neither — every dispute dismissed or
 *   retracted — the worker confirms it at the deadline, or within seconds of the last dismissal
 *   after it (the API enqueues `market.resolve`); no review deadline (#173 item 7).
 * - The labels (#173 items 11·12, owner answer 2026-11-03): a PROVISIONAL market a dispute holds
 *   reads '이의 검토 중' before its deadline, and one a dispute or a waiting correction holds '판정
 *   지연' after it (`isDisputeUnderReview`, `isJudgementDelayed`, market-times.ts) — the public
 *   `Market` carries the flags, the deadline and whether disputes are taken (`disputeOpen`), so an
 *   anonymous visitor sees the deadline and the link (#173 item 6).
 *
 * The submitter and the body (the links and the reason) are the submitter's and the operators'
 * alone (#173 item 13, PRIVATE_DATA `dispute`); the count, the statuses and the decision reasons
 * are #24's public record, without the decider. The submission and the retraction are the member's
 * own rows (`market_disputes`, @buddha/db); a decision is an admin action
 * (MARKET_DISPUTE_DECISION_ACTION_TYPES). No market event, release setting or approval kind.
 */

// ---- limits ---------------------------------------------------------------------------
/** At most this many 근거 링크 per dispute: the judgement's evidence rule (#173 item 6). */
export const DISPUTE_LINKS_MAX = JUDGEMENT_EVIDENCE_LINKS_MAX;

/** A 근거 링크's length, as a judgement's evidence link (`JUDGEMENT_EVIDENCE_LINK_MAX`). */
export const DISPUTE_LINK_MAX = JUDGEMENT_EVIDENCE_LINK_MAX;

/** The reason's length (the M5 dispute's `DISPUTE_REASON_MAX`, ADR-0046 before it dropped it). */
export const DISPUTE_REASON_MAX = 2_000;

// ---- statuses -------------------------------------------------------------------------
/**
 * `market_disputes.status` (a varchar(20) held by a CHECK, so a value is a migration's):
 * - `pending` 검토 중: submitted and not decided — it holds the market;
 * - `dismissed` 기각: an admin found nothing to change (#173 item 7);
 * - `accepted` 수용: an admin accepted it, which is a correction (#173 item 7) — it holds the market
 *   until a correction is approved and moves the version past it (owner answer 2026-11-02), and
 *   goes back to `pending` when the correction registered for it is rejected or retracted;
 * - `retracted` 철회: its submitter took it back within the deadline — still the one per version;
 * - `closed_by_correction` 정정으로 종결 (#176, ADR-0105; #173 item 8): still pending when a
 *   correction's approval replaced its version — `closedAt` the approval's instant, no decider.
 */
export const MARKET_DISPUTE_STATUSES = [
  'pending',
  'dismissed',
  'accepted',
  'retracted',
  'closed_by_correction',
] as const;
export type MarketDisputeStatus = (typeof MARKET_DISPUTE_STATUSES)[number];
export const marketDisputeStatusSchema = z
  .enum(MARKET_DISPUTE_STATUSES)
  .meta({ id: 'MarketDisputeStatus' });

/**
 * Where each status may go: a pending dispute is dismissed, accepted or retracted, or closed by a
 * correction's approval (#173 item 8); an accepted one goes back to pending when the correction
 * registered for it is rejected or retracted (owner answer 2026-11-02; #176, ADR-0105) — its
 * decision cleared, its submission kept — and is decided again. Nothing leaves the others. The
 * database holds the same (`market_disputes_keep_record`).
 */
export const MARKET_DISPUTE_TRANSITIONS: Readonly<
  Record<MarketDisputeStatus, readonly MarketDisputeStatus[]>
> = {
  pending: ['dismissed', 'accepted', 'retracted', 'closed_by_correction'],
  dismissed: [],
  accepted: ['pending'],
  retracted: [],
  closed_by_correction: [],
};

export function canMoveMarketDispute(from: MarketDisputeStatus, to: MarketDisputeStatus): boolean {
  return MARKET_DISPUTE_TRANSITIONS[from].includes(to);
}

/**
 * The statuses that hold a PROVISIONAL market's confirmation, of its current judgement version
 * (#173 items 1·7; owner answer 2026-11-02): an undecided dispute, and an accepted one waiting for
 * its correction — once a correction moves the version neither holds (#176, ADR-0105).
 * `markets.dispute_hold_count` counts these, for the labels alone.
 */
export const HOLDING_DISPUTE_STATUSES = [
  'pending',
  'accepted',
] as const satisfies readonly MarketDisputeStatus[];

export function isHoldingDisputeStatus(status: MarketDisputeStatus): boolean {
  return (HOLDING_DISPUTE_STATUSES as readonly MarketDisputeStatus[]).includes(status);
}

/** An admin's decision on a pending dispute (#173 item 2), as its route names it. */
export const MARKET_DISPUTE_DECISIONS = ['dismiss', 'accept'] as const;
export type MarketDisputeDecision = (typeof MARKET_DISPUTE_DECISIONS)[number];

/** The status each decision gives the dispute. */
export const MARKET_DISPUTE_DECISION_STATUSES = {
  dismiss: 'dismissed',
  accept: 'accepted',
} as const satisfies Record<MarketDisputeDecision, MarketDisputeStatus>;

/** The admin action each decision writes (ADMIN_ACTION_TYPES, target the market). */
export const MARKET_DISPUTE_DECISION_ACTION_TYPES = {
  dismiss: 'market_dispute_dismiss',
  accept: 'market_dispute_accept',
} as const satisfies Record<MarketDisputeDecision, AdminActionType>;

// ---- refusals -------------------------------------------------------------------------
/**
 * Why a dispute write is refused (DISPUTE_NOT_ALLOWED, 409, `details.reason`). A submission, in
 * the order it asks (DISPUTE_SUBMISSION_REFUSALS), after the body's own checks and NOT_FOUND for a
 * market that is not public:
 * - `not_provisional`: the market shows no provisional result — not judged yet, or confirmed;
 * - `stale_version`: the body's `judgementVersion` is not the market's current one — the screen
 *   showed a result a correction (#176, ADR-0105) has replaced since, as `expectedAccountId`
 *   guards the account;
 * - `deadline_passed`: the 이의 기한 has come (`now >= disputeDeadline`, the database clock);
 * - `admin`: the submitter holds the admin role (#173 item 15);
 * - `no_fill`: the submitter has no fill on the market, on either side (#173 item 6);
 * - `duplicate`: the submitter has a dispute of that version already, a retracted one included.
 * A retraction (DISPUTE_RETRACTION_REFUSALS): `decided` (dismissed, accepted or closed by a
 * correction, #176), `retracted`, or `deadline_passed`. A decision (DISPUTE_DECISION_REFUSALS):
 * `retracted`, `decided` (as a retraction's), `registrant` — the deciding admin registered the
 * dispute's judgement version (#173 item 2; its approver may decide) — or `own`: the deciding
 * admin submitted the dispute (an account given the admin role after it disputed). A dispute of
 * another account or market is NOT_FOUND.
 */
export const DISPUTE_NOT_ALLOWED_REASONS = [
  'not_provisional',
  'stale_version',
  'deadline_passed',
  'admin',
  'no_fill',
  'duplicate',
  'decided',
  'retracted',
  'registrant',
  'own',
] as const;
export type DisputeNotAllowedReason = (typeof DISPUTE_NOT_ALLOWED_REASONS)[number];
export const disputeNotAllowedReasonSchema = z
  .enum(DISPUTE_NOT_ALLOWED_REASONS)
  .meta({ id: 'DisputeNotAllowedReason' });

/** DISPUTE_NOT_ALLOWED's details: the first reason the write met. */
export const disputeNotAllowedDetailsSchema = z
  .object({ reason: disputeNotAllowedReasonSchema })
  .meta({ id: 'DisputeNotAllowedDetails' });
export type DisputeNotAllowedDetails = z.infer<typeof disputeNotAllowedDetailsSchema>;

/** A submission's refusals, in the order it asks them (ADR-0104). */
export const DISPUTE_SUBMISSION_REFUSALS = [
  'not_provisional',
  'stale_version',
  'deadline_passed',
  'admin',
  'no_fill',
  'duplicate',
] as const satisfies readonly DisputeNotAllowedReason[];
export type DisputeSubmissionRefusal = (typeof DISPUTE_SUBMISSION_REFUSALS)[number];

/** A retraction's refusals: a dispute no longer pending, or one whose deadline has come. */
export const DISPUTE_RETRACTION_REFUSALS = [
  'decided',
  'retracted',
  'deadline_passed',
] as const satisfies readonly DisputeNotAllowedReason[];
export type DisputeRetractionRefusal = (typeof DISPUTE_RETRACTION_REFUSALS)[number];

/**
 * A decision's refusals: a dispute no longer pending, a decider who registered its version, or
 * one who submitted it.
 */
export const DISPUTE_DECISION_REFUSALS = [
  'retracted',
  'decided',
  'registrant',
  'own',
] as const satisfies readonly DisputeNotAllowedReason[];
export type DisputeDecisionRefusal = (typeof DISPUTE_DECISION_REFUSALS)[number];

const instantMs = (at: string | Date) => (typeof at === 'string' ? Date.parse(at) : at.getTime());

/**
 * Why its submitter may not retract a dispute at `nowMs` — its status first, then its version's
 * 이의 기한 — or null when they may (#173 item 6: 기한 안에 철회할 수 있다): a pending one, one a
 * rejected or retracted correction sent back to pending included (#176). The retraction refuses
 * with it on the database clock; `MyDispute.retractable` is its null at the read.
 */
export function disputeRetractionRefusal(
  dispute: { status: MarketDisputeStatus },
  disputeDeadline: string | Date,
  nowMs: number,
): DisputeRetractionRefusal | null {
  if (dispute.status === 'retracted') return 'retracted';
  if (dispute.status !== 'pending') return 'decided';
  if (nowMs >= instantMs(disputeDeadline)) return 'deadline_passed';
  return null;
}

/**
 * Why `adminId` may not dismiss or accept a dispute — its status first (pending alone: again once
 * a rejected or retracted correction sent it back, #176), then whether `adminId` registered the
 * dispute's judgement version (`registeredBy`, `market_judgements.registered_by`; #173 item 2),
 * then whether `adminId` submitted it (`submittedBy`: an admin never submits, but a member given
 * the role after disputing would decide their own) — or null when they may. The decision refuses
 * with it; the admin screen turns the buttons off by it. Admins who declared an interest (#173
 * item 15) are #143's to add.
 */
export function disputeDecisionRefusal(
  dispute: { status: MarketDisputeStatus },
  adminId: string,
  registeredBy: string,
  submittedBy: string,
): DisputeDecisionRefusal | null {
  if (dispute.status === 'retracted') return 'retracted';
  if (dispute.status !== 'pending') return 'decided';
  if (adminId === registeredBy) return 'registrant';
  if (adminId === submittedBy) return 'own';
  return null;
}

/**
 * A member's standing on a market's current judgement version (`MyMarketDispute.eligibility`):
 * `eligible`, or the first submission refusal that holds, in DISPUTE_SUBMISSION_REFUSALS' order —
 * never `stale_version`, since the read is of the current version.
 */
export const DISPUTE_ELIGIBILITIES = [
  'eligible',
  'not_provisional',
  'deadline_passed',
  'admin',
  'no_fill',
  'duplicate',
] as const satisfies readonly ('eligible' | DisputeSubmissionRefusal)[];
export type DisputeEligibility = (typeof DISPUTE_ELIGIBILITIES)[number];
export const disputeEligibilitySchema = z
  .enum(DISPUTE_ELIGIBILITIES)
  .meta({ id: 'DisputeEligibility' });

/** The body's own refusal messages (VALIDATION_ERROR), under the path each names. */
export const MARKET_DISPUTE_REFUSALS = {
  /** A link given twice, compared trimmed (`duplicateLinkIndexes`), on `links.<index>`. */
  links: { duplicateLink: 'duplicate' },
} as const;

// ---- bodies ---------------------------------------------------------------------------
/** 근거 링크: 1..DISPUTE_LINKS_MAX distinct http(s) links, each trimmed, ≤ DISPUTE_LINK_MAX. */
export const disputeLinksSchema = z
  .array(evidenceLinkSchema)
  .min(1)
  .max(DISPUTE_LINKS_MAX)
  .superRefine((links, ctx) => {
    for (const index of duplicateLinkIndexes(links)) {
      ctx.addIssue({
        code: 'custom',
        path: [index],
        message: MARKET_DISPUTE_REFUSALS.links.duplicateLink,
      });
    }
  });

/** 사유: trimmed, 1..DISPUTE_REASON_MAX characters. */
export const disputeReasonSchema = z.string().trim().min(1).max(DISPUTE_REASON_MAX);

/**
 * `POST /markets/:id/disputes` (a member, onboarded): the judgement version the screen showed —
 * refused as `stale_version` once it is not the market's current one — the 근거 링크, the reason
 * and the account the screen shows (ADR-0092). Everything else (the deadline, the fill, the one
 * per version) is the service's, under the market lock.
 */
export const submitDisputeBodySchema = z
  .object({
    judgementVersion: judgementVersionSchema,
    links: disputeLinksSchema,
    reason: disputeReasonSchema,
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'SubmitDisputeBody' });
export type SubmitDisputeBody = z.infer<typeof submitDisputeBodySchema>;

/**
 * `POST /me/disputes/:disputeId/retract` (the submitter's, signed in is enough): the account the
 * screen shows and nothing else — `expectedAccountBodySchema` itself.
 */
export const retractDisputeBodySchema = expectedAccountBodySchema;
export type RetractDisputeBody = ExpectedAccountBody;

/**
 * `POST /admin/markets/:id/disputes/:disputeId/dismiss` and `…/accept` (one admin other than the
 * version's registrant): the reason the submitter reads (#173 item 7) and #24 publishes without
 * the decider (#173 item 13) — required and trimmed, 1..500 (approvals.ts) — and the admin on
 * screen.
 */
export const decideDisputeBodySchema = z
  .object({ reason: approvalReasonSchema, expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'DecideDisputeBody' });
export type DecideDisputeBody = z.infer<typeof decideDisputeBodySchema>;

// ---- records --------------------------------------------------------------------------
/**
 * `market_dispute_dismiss`'s and `market_dispute_accept`'s payload (admin_actions, target the
 * market): the dispute, its judgement version and the decision's reason — never the submitter's
 * links or reason (#173 item 13).
 */
export interface MarketDisputeDecisionActionPayload {
  disputeId: string;
  judgementVersion: number;
  reason: string;
}
export type MarketDisputeDismissActionPayload = MarketDisputeDecisionActionPayload;
export type MarketDisputeAcceptActionPayload = MarketDisputeDecisionActionPayload;

// ---- read models ----------------------------------------------------------------------
/**
 * The market a dispute is about, as the member's and the operators' lists link to it, with its
 * current judgement version (`Market.judgementVersion`, public; never null — a dispute is of a
 * judged market): a dispute of an older version is one a correction replaced (#176, ADR-0105).
 */
export const disputeMarketSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    title: z.string(),
    status: marketStatusSchema,
    judgementVersion: judgementVersionSchema,
  })
  .meta({ id: 'DisputeMarket' });
export type DisputeMarket = z.infer<typeof disputeMarketSchema>;

/** What a dispute says and how it ended: the same for its submitter and the operators. */
const disputeFields = {
  id: z.uuid(),
  judgementVersion: judgementVersionSchema,
  /** 근거 링크, in the submitter's order. */
  links: z.array(z.string()),
  reason: z.string(),
  status: marketDisputeStatusSchema,
  submittedAt: z.iso.datetime(),
  /**
   * The 기각 or 수용; null while pending — a rejected correction's reopening clears it (#176) — once
   * retracted and once closed by a correction.
   */
  decidedAt: z.iso.datetime().nullable(),
  /** The decision's reason, which the submitter reads (#173 item 7); null as `decidedAt`. */
  decisionReason: z.string().nullable(),
  /** The 철회; null unless retracted. */
  retractedAt: z.iso.datetime().nullable(),
  /**
   * 정정으로 종결 (#176, ADR-0105): the approval of the correction that replaced its version; null
   * unless `closed_by_correction`.
   */
  closedAt: z.iso.datetime().nullable(),
};

/**
 * One of the caller's disputes (`GET /me/disputes`, newest first, `cursorQuerySchema`; the writes'
 * answers): its market, what it submitted, the status and the decision's reason and time, and
 * whether it may still be retracted (`disputeRetractionRefusal` null at the read). Never who
 * decided it (#173 item 13: the decider is nobody's but the operators').
 */
export const myDisputeSchema = z
  .object({
    ...disputeFields,
    market: disputeMarketSchema,
    retractable: z.boolean(),
  })
  .meta({ id: 'MyDispute' });
export type MyDispute = z.infer<typeof myDisputeSchema>;

/**
 * `GET /me/disputes/markets/:marketId` (NOT_FOUND for a market that is not public): the caller's
 * standing on the market's current judgement version — `eligible` or why not, as the submission
 * would refuse — the version it was read for (null before a judgement; the form submits it), and
 * the caller's dispute of that version, whatever its status (null when none).
 */
export const myMarketDisputeSchema = z
  .object({
    eligibility: disputeEligibilitySchema,
    judgementVersion: judgementVersionSchema.nullable(),
    dispute: myDisputeSchema.nullable(),
  })
  .meta({ id: 'MyMarketDispute' });
export type MyMarketDispute = z.infer<typeof myMarketDisputeSchema>;

/**
 * A dispute on the admin screens: what was submitted, by whom (`submitter`; a closed account
 * keeps its id with a null nickname — its pending dispute is still decided, ADR-0069 decision 4
 * #140), how it ended and who decided it. `purgedAt`: a closed account's decided, retracted or
 * correction-closed dispute whose links and reason the retention emptied
 * (`retention.moderation_records`; `links` empty and `reason` '' then), null otherwise.
 */
export const adminMarketDisputeSchema = z
  .object({
    ...disputeFields,
    submitter: adminAccountActorSchema,
    decidedBy: adminAccountActorSchema.nullable(),
    purgedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'AdminMarketDispute' });
export type AdminMarketDispute = z.infer<typeof adminMarketDisputeSchema>;

/**
 * `AdminMarket.disputes`, in every status: the disputes of the current judgement version, the
 * oldest first (empty before a judgement), and how many hold the confirmation
 * (HOLDING_DISPUTE_STATUSES) — the admin detail stops polling for the confirmation while any do.
 */
export const adminMarketDisputesSchema = z
  .object({
    holding: z.number().int().min(0),
    items: z.array(adminMarketDisputeSchema),
  })
  .meta({ id: 'AdminMarketDisputes' });
export type AdminMarketDisputes = z.infer<typeof adminMarketDisputesSchema>;

/**
 * `GET /admin/market-disputes` (이의 접수): `pending` — 검토 대기, the oldest submission first, a
 * dispute a rejected correction reopened among them by its submission — or `decided` — 처리됨,
 * every dispute no longer pending (dismissed, accepted, retracted or closed by a correction), the
 * newest ending first (ADMIN_DISPUTE_LIST_STATUS_MEMBERS).
 */
export const ADMIN_DISPUTE_LIST_STATUSES = ['pending', 'decided'] as const;
export type AdminDisputeListStatus = (typeof ADMIN_DISPUTE_LIST_STATUSES)[number];

/** The dispute statuses each half of the list holds. */
export const ADMIN_DISPUTE_LIST_STATUS_MEMBERS = {
  pending: ['pending'],
  decided: ['dismissed', 'accepted', 'retracted', 'closed_by_correction'],
} as const satisfies Record<AdminDisputeListStatus, readonly MarketDisputeStatus[]>;

/** `GET /admin/market-disputes` (no `.meta`: query DTO), `pending` unless named. */
export const adminDisputeListQuerySchema = cursorQuerySchema.extend({
  status: z.enum(ADMIN_DISPUTE_LIST_STATUSES).default('pending'),
});
export type AdminDisputeListQuery = z.infer<typeof adminDisputeListQuerySchema>;

/**
 * One row of `GET /admin/market-disputes`: the dispute as the admin detail shows it and its market
 * (a link to its admin detail, where the decisions are made). No price, majority or position
 * (N03 §5).
 */
export const adminDisputeQueueItemSchema = adminMarketDisputeSchema
  .extend({ market: disputeMarketSchema })
  .meta({ id: 'AdminDisputeQueueItem' });
export type AdminDisputeQueueItem = z.infer<typeof adminDisputeQueueItemSchema>;
