import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { coinAmountSchema } from './api/coin-amount.js';
import { approvalReasonSchema } from './approvals.js';
import { adminMarketJudgementCompensationSchema } from './judgement-compensation.js';
import {
  type MarketResult,
  type MarketStatus,
  approvalStatusSchema,
  marketResultSchema,
  marketStatusSchema,
} from './enums.js';
import {
  type ExpectedAccountBody,
  expectedAccountBodySchema,
  expectedAccountIdSchema,
} from './expected-account.js';
import {
  judgementEvidenceLinksSchema,
  judgementEvidenceSchema,
  judgementVersionSchema,
} from './market-judgement.js';
import { storableInstantSchema } from './market-rules.js';

/**
 * 판정 오류 사건 (#144 part 1, ADR-0165; owner answers 144-3·144-4·144-5·144-8·144-9 and
 * 144-13·144-14; ADR-0093 decision 1 #173 items 8·12·13·15; ADR-0120 범위·decisions 5·6):
 *
 * - 등록 (`POST /admin/markets/:id/judgement-incidents`): from the result's confirmation on —
 *   RESOLVED, SETTLING or SETTLED (144-8 "결과 확정 뒤 언제든", no deadline; #173 item 12 names
 *   RESOLVED 결과 확정) — any admin without a conflict on the market (ADR-0120 범위 "판정·정정 등록")
 *   writes what went wrong (오류 내용, the request's reason), the evidence (links and the
 *   collection instant) and the correct result, which differs from the paid one. It opens a
 *   `market_judgement_incident` approval request (#171) whose frozen payload is the registration
 *   and changes nothing else: the market row, its judgements and its settlement records never move
 *   (ADR-0165 decision 2). One waits per market at a time; none is taken once one is confirmed
 *   (144-14); it is refused when no admin but the registrant and the paid version's registrant
 *   could decide it (`no_decider`, approvals.ts). The paid version's registrant may register one
 *   (144-4 "사건 등록과 보상 요청은 할 수 있다").
 * - 오류 확인 (`…/:requestId/confirm`, SETTLED alone — 144-13 "지급 완료 뒤에만") and 기각
 *   (`…/dismiss`, RESOLVED·SETTLING·SETTLED), both with a reason, by an admin who is neither the
 *   registrant (#171), nor the paid version's registrant (144-4, `judgementIncidentDecisionRefusal`
 *   — the 판정 이의 precedent, market-dispute.ts `disputeDecisionRefusal`), nor conflicted on the
 *   market (#143, re-checked for the registrant too, ADR-0120 decision 5). The confirmation writes
 *   the permanent incident (`market_judgement_incidents`, @buddha/db, migration 0080) whose
 *   corrected result readers show in place of the paid one (144-5: the detail's 결과 줄 with a '판정
 *   정정' mark, the theme results, the related markets' VOID filter) and whose 오류 내용, evidence
 *   and collection instant the public judging record publishes (#173 item 13), never an identity
 *   or the reviewer's reason. A dismissed or retracted incident stays in `approval_requests` and
 *   `admin_actions` alone, and another may be registered after it (144-14).
 * - 철회 (`…/retract`): the registrant's, in any status, before a decision; a self-declared
 *   conflict retracts the declarer's own waiting incident (ADR-0120 decision 6).
 *
 * No Coin moves here: 판정 오류 보상 is #144 part 2 (ADR-0166, judgement-compensation.ts), whose
 * state the admin record carries beside the incident's (`compensation`).
 */

/** `approval_requests.kind` of a 판정 오류 사건 (#171: lower-case words, `_`; never the judgement's). */
export const MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND = 'market_judgement_incident';

/** The statuses an incident is registered and dismissed in: 결과 확정 onwards (144-8). */
export const JUDGEMENT_INCIDENT_STATUSES = [
  'resolved',
  'settling',
  'settled',
] as const satisfies readonly MarketStatus[];
export type JudgementIncidentStatus = (typeof JUDGEMENT_INCIDENT_STATUSES)[number];

/** The status an incident is confirmed in: 지급 완료 alone (144-13). */
export const JUDGEMENT_INCIDENT_CONFIRMABLE_STATUS = 'settled' satisfies MarketStatus;

// ---- refusals -------------------------------------------------------------------------
/**
 * The refusal details of an incident's registration and decisions (VALIDATION_ERROR, the API's),
 * each message under the path it names — a registration in this order: `status`, `judgement`
 * 'legacy', `correctedResult`, `evidence` 'after now', `incident` 'confirmed', `incident`
 * 'pending', then `no_decider` (approvals.ts); a confirmation or a dismissal: `requestId`
 * 'unknown', the approval engine's own (`decided`, `retracted`, `requester`), `decider`
 * 'registrant', the conflict check (FORBIDDEN `market_conflict`), then for a confirmation `status`
 * 'not settled' and `incident` 'confirmed':
 * - `status`: a registration or a dismissal on a market whose result is not confirmed — before
 *   RESOLVED, or CANCELLED (`notResultConfirmed`, 144-8); a confirmation before SETTLED
 *   (`notSettled`, 144-13). A 철회 asks no status;
 * - `judgement`: a market judged by the interim route before #152, with no judgement version
 *   (`legacy`, D4: never handled);
 * - `correctedResult`: the paid result itself (`sameResult` — nothing to correct);
 * - `evidence`: a link given twice (`duplicateLink`, on `evidence.links.<index>`, the body's); a
 *   collection instant after the registration's database clock (`collectedAfterNow`, on
 *   `evidence.collectedAt`);
 * - `incident`: a confirmed incident of the market exists (`confirmed`, 144-14 — at the
 *   registration and, racing another, at the confirmation); another registration waits
 *   (`pending` — one at a time);
 * - `decider`: the decider registered the paid judgement version (`registrant`, 144-4 — on a
 *   confirmation and a dismissal alike, `judgementIncidentDecisionRefusal`);
 * - `requestId`: the path's request is no `market_judgement_incident` request of the market
 *   (`unknown`).
 */
export const MARKET_JUDGEMENT_INCIDENT_REFUSALS = {
  status: { notResultConfirmed: 'not result confirmed', notSettled: 'not settled' },
  judgement: { legacy: 'legacy' },
  correctedResult: { sameResult: 'same result' },
  evidence: { duplicateLink: 'duplicate', collectedAfterNow: 'after now' },
  incident: { confirmed: 'confirmed', pending: 'pending' },
  decider: { registrant: 'registrant' },
  requestId: { unknown: 'unknown' },
} as const;

type Refusals = typeof MARKET_JUDGEMENT_INCIDENT_REFUSALS;
type RefusalMessage<P extends keyof Refusals> = Refusals[P][keyof Refusals[P]];

/** The incident actions a status is asked of; a 철회 asks none. */
export type JudgementIncidentStatusAction = 'register' | 'confirm' | 'dismiss';

/**
 * Why a market's status refuses an incident's registration, confirmation or dismissal, or null
 * when it takes it: a registration and a dismissal from the result's confirmation on (RESOLVED,
 * SETTLING, SETTLED — 144-8), a confirmation once paid (SETTLED — 144-13). The service refuses
 * with it; the admin screen turns its buttons off by it.
 */
export function judgementIncidentStatusRefusal(
  status: MarketStatus,
  action: JudgementIncidentStatusAction,
): RefusalMessage<'status'> | null {
  if (!(JUDGEMENT_INCIDENT_STATUSES as readonly MarketStatus[]).includes(status)) {
    return MARKET_JUDGEMENT_INCIDENT_REFUSALS.status.notResultConfirmed;
  }
  if (action === 'confirm' && status !== JUDGEMENT_INCIDENT_CONFIRMABLE_STATUS) {
    return MARKET_JUDGEMENT_INCIDENT_REFUSALS.status.notSettled;
  }
  return null;
}

/**
 * Why `adminId` may not confirm or dismiss an incident for being the paid judgement version's
 * registrant (`paidRegisteredBy`, `market_judgements.registered_by` at `markets.judgement_version`
 * — `AdminMarket.judgement.current.registeredBy`), or null when they may (144-4 "지급한 판정
 * 버전을 등록한 관리자는 그 사건의 검토와 보상 승인을 하지 못한다", as a 판정 이의's decision
 * refuses its version's registrant, `disputeDecisionRefusal`). The registrant of the incident is
 * the approval engine's (`requester`); a conflict is #143's. The service refuses with it
 * (`decider` 'registrant'); the admin screen turns both buttons off by it. Migration 0080 holds the
 * same rule on `approval_requests` and on the incident row.
 */
export function judgementIncidentDecisionRefusal(
  adminId: string,
  paidRegisteredBy: string,
): RefusalMessage<'decider'> | null {
  return adminId === paidRegisteredBy
    ? MARKET_JUDGEMENT_INCIDENT_REFUSALS.decider.registrant
    : null;
}

// ---- bodies ---------------------------------------------------------------------------
/**
 * `POST /admin/markets/:id/judgement-incidents` (판정 오류 사건 등록 — RESOLVED, SETTLING or
 * SETTLED; 144-3, 144-8):
 * - `noConflictConfirmed`: the registrant's 이해충돌 없음 confirmation (ADR-0120 decision 5: no
 *   default, the box starts unchecked);
 * - `correctedResult`: the correct result — YES, NO or VOID, never the paid one (`correctedResult`
 *   'same result', the service's);
 * - `description`: 오류 내용 — what went wrong, the request's reason; trimmed, 1..500;
 * - `evidence`: 1..JUDGEMENT_EVIDENCE_LINKS_MAX distinct http(s) links (a judgement's rule) and
 *   the collection instant, from STORABLE_INSTANT_MIN on, not after the registration (the
 *   service's, on the database clock) and with no lower bound;
 * - and the admin on screen (ADR-0092).
 * No public-notice field: the description, links and collection instant are published once
 * confirmed (#173 item 13), and the form carries the public-input notice the way a judgement's
 * registration does (ADR-0121 decision 6 — a notice, no body field).
 */
export const registerJudgementIncidentBodySchema = z
  .object({
    noConflictConfirmed: z.literal(true),
    correctedResult: marketResultSchema,
    description: approvalReasonSchema,
    evidence: z.object({ links: judgementEvidenceLinksSchema, collectedAt: storableInstantSchema }),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'RegisterJudgementIncidentBody' });
export type RegisterJudgementIncidentBody = z.infer<typeof registerJudgementIncidentBodySchema>;

/**
 * `POST /admin/markets/:id/judgement-incidents/:requestId/confirm` (오류 확인, SETTLED; 144-3,
 * 144-13): the reviewer's reason (the decision reason, admins only — never public), the reviewer's
 * 이해충돌 없음 confirmation (ADR-0120 decision 5) and the admin on screen.
 */
export const confirmJudgementIncidentBodySchema = z
  .object({
    reason: approvalReasonSchema,
    noConflictConfirmed: z.literal(true),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'ConfirmJudgementIncidentBody' });
export type ConfirmJudgementIncidentBody = z.infer<typeof confirmJudgementIncidentBodySchema>;

/**
 * `POST /admin/markets/:id/judgement-incidents/:requestId/dismiss` (기각 — 144-3 "기각도 그
 * 검토자가 사유와 함께 한다"): a review decision as a confirmation is (144-4 names both), so the same
 * body and the same exclusions — the reason, the confirmation and the admin on screen.
 */
export const dismissJudgementIncidentBodySchema = z
  .object({
    reason: approvalReasonSchema,
    noConflictConfirmed: z.literal(true),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'DismissJudgementIncidentBody' });
export type DismissJudgementIncidentBody = z.infer<typeof dismissJudgementIncidentBodySchema>;

/**
 * `POST /admin/markets/:id/judgement-incidents/:requestId/retract` (철회, the registrant's, in any
 * status): the admin on screen and nothing else — `expectedAccountBodySchema` itself.
 */
export const retractJudgementIncidentBodySchema = expectedAccountBodySchema;
export type RetractJudgementIncidentBody = ExpectedAccountBody;

// ---- records --------------------------------------------------------------------------
/**
 * `approval_requests.payload` of an incident (frozen at the insert, migration 0021): the
 * registrant's conflict confirmation, the paid judgement version and its result as they were at
 * the registration, the corrected result and the evidence (the links trimmed, the instant ISO).
 * The description is the request's reason. Migration 0080 holds the confirmed incident row to its
 * `judgementVersion` and `correctedResult`. No `.meta`: no route answers it as is.
 */
export const marketJudgementIncidentRequestPayloadSchema = z.object({
  noConflictConfirmed: z.literal(true),
  judgementVersion: judgementVersionSchema,
  originalResult: marketResultSchema,
  correctedResult: marketResultSchema,
  evidence: judgementEvidenceSchema,
});
export type MarketJudgementIncidentRequestPayload = z.infer<
  typeof marketJudgementIncidentRequestPayloadSchema
>;

/**
 * `market_judgement_incident_register`'s payload (admin_actions, target `market`): the request it
 * opened and the registration as its payload froze it, with the description.
 */
export interface MarketJudgementIncidentRegisterActionPayload {
  approvalId: string;
  judgementVersion: number;
  originalResult: MarketResult;
  correctedResult: MarketResult;
  description: string;
  evidence: { links: string[]; collectedAt: string };
}

/**
 * `market_judgement_incident_confirm`'s payload: the request, the incident row it wrote, the
 * corrected result and the reviewer's reason.
 */
export interface MarketJudgementIncidentConfirmActionPayload {
  approvalId: string;
  incidentId: string;
  correctedResult: MarketResult;
  reason: string;
}

/** `market_judgement_incident_dismiss`'s payload: the request, its result and the reason. */
export interface MarketJudgementIncidentDismissActionPayload {
  approvalId: string;
  correctedResult: MarketResult;
  reason: string;
}

/**
 * `market_judgement_incident_retract`'s payload: the request its registrant retracted and its
 * result — and, when a self-declared conflict retracted it (ADR-0120 decision 6), the declaration.
 */
export interface MarketJudgementIncidentRetractActionPayload {
  conflictDeclarationId?: string;
  approvalId: string;
  correctedResult: MarketResult;
}

// ---- read models ----------------------------------------------------------------------
/** What a registration says, as every admin read model below shows it. */
const registrationFields = {
  correctedResult: marketResultSchema,
  /** 오류 내용: the request's reason. */
  description: z.string(),
  evidence: judgementEvidenceSchema,
};

/**
 * The incident waiting on a market (`AdminMarket.judgementIncident.pending`): the request, what it
 * says, who registered it and when. Neither its registrant nor the paid version's registrant may
 * decide it.
 */
export const marketJudgementIncidentPendingSchema = z
  .object({
    requestId: z.uuid(),
    ...registrationFields,
    requestedBy: adminAccountActorSchema,
    requestedAt: z.iso.datetime(),
  })
  .meta({ id: 'MarketJudgementIncidentPending' });
export type MarketJudgementIncidentPending = z.infer<typeof marketJudgementIncidentPendingSchema>;

/**
 * The market's confirmed incident (`market_judgement_incidents`, one per market, 144-14): the row,
 * the paid version and its result it corrects, what it says, who registered and who confirmed it
 * and when, and the reviewer's reason (admins only).
 */
export const marketJudgementIncidentConfirmedSchema = z
  .object({
    incidentId: z.uuid(),
    requestId: z.uuid(),
    judgementVersion: judgementVersionSchema,
    originalResult: marketResultSchema,
    ...registrationFields,
    registeredBy: adminAccountActorSchema,
    confirmedBy: adminAccountActorSchema,
    registeredAt: z.iso.datetime(),
    confirmedAt: z.iso.datetime(),
    reason: z.string(),
  })
  .meta({ id: 'MarketJudgementIncidentConfirmed' });
export type MarketJudgementIncidentConfirmed = z.infer<
  typeof marketJudgementIncidentConfirmedSchema
>;

/**
 * One incident registration of the admin detail's log (`AdminMarket.judgementIncident.log`): the
 * registration as `marketJudgementIncidentPendingSchema` and how it ended — `status` pending,
 * approved (오류 확인), rejected (기각) or retracted; the decider, the decision's instant and reason
 * (null unless decided); the 철회's instant (null unless retracted).
 */
export const marketJudgementIncidentLogEntrySchema = marketJudgementIncidentPendingSchema
  .extend({
    status: approvalStatusSchema,
    decidedBy: adminAccountActorSchema.nullable(),
    decidedAt: z.iso.datetime().nullable(),
    decisionReason: z.string().nullable(),
    retractedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'MarketJudgementIncidentLogEntry' });
export type MarketJudgementIncidentLogEntry = z.infer<typeof marketJudgementIncidentLogEntrySchema>;

/**
 * `AdminMarket.judgementIncident`, in every status (#144, ADR-0165), read in the detail's
 * snapshot. The paid version's registrant, whom 144-4 excludes, is
 * `AdminMarket.judgement.current.registeredBy` (the paid version stays the current one).
 */
export const adminMarketJudgementIncidentSchema = z
  .object({
    /**
     * Whether a registration is taken now: the status is RESOLVED, SETTLING or SETTLED (144-8), the
     * market has a judgement version (not legacy), and no incident is confirmed (144-14) or waits.
     */
    registrable: z.boolean(),
    /** Whether the status takes a confirmation now: SETTLED (144-13). */
    confirmable: z.boolean(),
    /** The waiting `market_judgement_incident` request; null when none waits (at most one does). */
    pending: marketJudgementIncidentPendingSchema.nullable(),
    /** The confirmed incident; null until one is confirmed (at most one ever is, 144-14). */
    confirmed: marketJudgementIncidentConfirmedSchema.nullable(),
    /** Every incident registration of the market, the newest first, the waiting one included. */
    log: z.array(marketJudgementIncidentLogEntrySchema),
    /**
     * The confirmed incident's 판정 오류 보상 (#144 part 2, ADR-0166; judgement-compensation.ts);
     * null while none is confirmed.
     */
    compensation: adminMarketJudgementCompensationSchema.nullable(),
  })
  .meta({ id: 'AdminMarketJudgementIncident' });
export type AdminMarketJudgementIncident = z.infer<typeof adminMarketJudgementIncidentSchema>;

// ---- the queue ------------------------------------------------------------------------
/**
 * What a row of the 판정 오류 사건 검토 대기 queue waits for (ADR-0166 T13 — one queue for both):
 * `incident`, a registration's 오류 확인 or 기각 (`market_judgement_incident`); `compensation`, a
 * 보상 request's 승인 or 반려 (`market_judgement_compensation`, #144 part 2).
 */
export const MARKET_JUDGEMENT_INCIDENT_QUEUE_KINDS = ['incident', 'compensation'] as const;
export type MarketJudgementIncidentQueueKind =
  (typeof MARKET_JUDGEMENT_INCIDENT_QUEUE_KINDS)[number];

/**
 * One row of `GET /admin/market-judgement-incidents` (판정 오류 사건 검토 대기; query
 * `cursorQuerySchema`): a waiting incident registration or compensation request (`kind`) and its
 * market, the oldest request first — its status (a confirmation waits for SETTLED, 144-13; a
 * compensation is asked on a SETTLED market alone), the paid result and the corrected one (a
 * compensation's from its confirmed incident), who asked and when, and — for a compensation — its
 * frozen list's length and total (null for an incident). Never an account of the list.
 */
export const adminMarketJudgementIncidentQueueItemSchema = z
  .object({
    kind: z.enum(MARKET_JUDGEMENT_INCIDENT_QUEUE_KINDS),
    requestId: z.uuid(),
    marketId: z.uuid(),
    slug: z.string(),
    title: z.string(),
    status: marketStatusSchema,
    originalResult: marketResultSchema,
    correctedResult: marketResultSchema,
    requestedBy: adminAccountActorSchema,
    requestedAt: z.iso.datetime(),
    /** A compensation request's 대상 계정 count (its frozen list); null for an incident. */
    accountCount: z.number().int().min(1).nullable(),
    /** A compensation request's total, Coin as a decimal string; null for an incident. */
    totalCoin: coinAmountSchema.nullable(),
  })
  .meta({ id: 'AdminMarketJudgementIncidentQueueItem' });
export type AdminMarketJudgementIncidentQueueItem = z.infer<
  typeof adminMarketJudgementIncidentQueueItemSchema
>;
