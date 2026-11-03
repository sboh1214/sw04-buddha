import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { approvalReasonSchema } from './approvals.js';
import { INT4_MAX, MARKET_FALLBACK_SOURCES_MAX, MARKET_SOURCE_URL_MAX } from './constants.js';
import {
  type MarketResult,
  approvalStatusSchema,
  marketResultSchema,
  marketStatusSchema,
} from './enums.js';
import {
  type ExpectedAccountBody,
  expectedAccountBodySchema,
  expectedAccountIdSchema,
} from './expected-account.js';
import type { MarketPauseEndKind, MarketPauseReviewResult } from './market-pause.js';
import { storableInstantSchema } from './market-rules.js';
import { ruleVersionNumberSchema } from './market-supplement.js';

/**
 * 판정 등록과 별도 검토자 승인 (#152, ADR-0103; ADR-0093 decision 1 #173 items 1·4·5·9·11–13·15,
 * decision 3 the #152 rows '역할'·'판정 출처'·'증거'·'등록 시점', ADR-0056 decision 1-1):
 *
 * - 판정 등록 (`POST /admin/markets/:id/judgements`, CLOSED, any time after the close): any admin
 *   writes the result (YES, NO or VOID — VOID is chosen here and nowhere before the close, #173
 *   item 4), the source picked from the rule's (`market_sources`: priority 0 the 1차 출처, 1..3 the
 *   대체 출처 in order, ADR-0097) — a fallback with the reason the primary could not be used, and
 *   none only for a VOID, the judgement a source outside the rules leads to — a VOID's reason, the
 *   evidence (1..JUDGEMENT_EVIDENCE_LINKS_MAX links and the collection instant; no files) and the
 *   description of what was confirmed (#173 item 13 keeps them for #24's public record). It opens
 *   a `market_judgement` approval request (#171, approvals.ts) whose frozen payload is the
 *   registration and whose reason is the description, and changes no status (#173 item 1). One
 *   waits per market at a time; it is refused when no admin but the registrant could decide it
 *   (`no_decider`), while the release setting `market.dispute_window` is undecided, and as YES or
 *   NO on a market closed early as 판정 불가 (`judgementVoidOnly`, ADR-0102).
 * - 승인 (`…/judgements/:requestId/approve`): an admin other than the registrant ('역할'), the
 *   market still CLOSED. Before its scheduled judgement the approver confirms the NO condition's
 *   event deadline (`eventDeadlineConfirmed`, '등록 시점'). The approval publishes the result:
 *   CLOSED → PROVISIONAL (the `provisional` event), `markets.resolved_result` the result, VOID too
 *   (#173 item 9), and an append-only judgement (`market_judgements`, @buddha/db) numbered from 1 —
 *   only approved judgements are numbered — that fixes the 이의 기한: the approval's instant plus
 *   `market.dispute_window` as read then (#173 item 5), never moved by a later change of the value.
 * - 반려 (an admin other than the registrant, with a reason) and 철회 (the registrant), in any
 *   status: the market stays CLOSED and a judgement is registered again (#173 item 1) — by any
 *   admin, the rejecting one included; only a judgement's registrant may not decide that one.
 * - 확정: once the deadline has passed with nothing held — no 판정 이의 of the version pending or
 *   accepted (#175, market-dispute.ts), and from #176 no correction waiting — the worker moves
 *   PROVISIONAL → RESOLVED (`resolved`, actor NULL; the job `market.resolve`, jobs.ts) and the
 *   payout follows (`market.finalize`; a VOID's is #126's).
 *
 * The registration, the 반려 and the 철회 are admin actions alone (`market_judgement_request` …,
 * enums.ts); the approval also writes the `provisional` event. Admins alone read the registrations
 * and the judgements for now: the public judging record (#24) shows the source, the evidence, the
 * collection instant and a VOID's reason, never who registered or approved it (#173 item 13). The
 * public `Market` carries the status, `resolvedResult`, and since #175 the current version and its
 * 이의 기한 (`judgementVersion`, `disputeDeadline`; #173 items 6·13).
 */

/** `approval_requests.kind` of a judgement's registration (#171: lower-case words, `_`). */
export const MARKET_JUDGEMENT_APPROVAL_KIND = 'market_judgement';

// ---- limits ---------------------------------------------------------------------------
/** At most this many evidence links per judgement (decision 3 '증거': one or more). */
export const JUDGEMENT_EVIDENCE_LINKS_MAX = 5;

/** An evidence link's length, as a rule source's address (`MARKET_SOURCE_URL_MAX`). */
export const JUDGEMENT_EVIDENCE_LINK_MAX = MARKET_SOURCE_URL_MAX;

/**
 * The bounds of the release setting `market.dispute_window` (DISPUTE_WINDOW_SETTING), in minutes:
 * at least one, so a result is never confirmed at its publication, and at most a week — a guard
 * against a typo, no product rule (the lead-close gap's ceiling, LEAD_CLOSE_GAP_MAX_MINUTES).
 */
export const DISPUTE_WINDOW_MIN_MINUTES = 1;
export const DISPUTE_WINDOW_MAX_MINUTES = 10_080;

/** A dispute window's length in minutes, as read and stored on a judgement. */
export const disputeWindowMinutesSchema = z
  .number()
  .int()
  .min(DISPUTE_WINDOW_MIN_MINUTES)
  .max(DISPUTE_WINDOW_MAX_MINUTES);

/**
 * A judgement's version: 1 for a market's first approved judgement — a rejected or retracted
 * registration takes none — and one more per correction (#176). int4, as `market_judgements`.
 */
export const judgementVersionSchema = z.number().int().min(1).max(INT4_MAX);

// ---- the source ---------------------------------------------------------------------
/**
 * A source of the rules by its priority (`market_sources.priority`, ADR-0097 7-3): 0 the 1차 출처,
 * 1..MARKET_FALLBACK_SOURCES_MAX the 대체 출처 in order.
 */
export const judgementSourcePrioritySchema = z
  .number()
  .int()
  .min(0)
  .max(MARKET_FALLBACK_SOURCES_MAX);

/** Whether `priority` is a 대체 출처's, which the judgement takes with a reason (decision 3). */
export function isFallbackSourcePriority(priority: number): boolean {
  return priority >= 1;
}

/**
 * The source a judgement names (decision 3 '판정 출처'): its priority, and its name and address
 * copied from the market's rules when it was registered — the rules are frozen after the close
 * (ADR-0101: no supplement then), so they are the rule version's too.
 */
export const judgementSourceSchema = z
  .object({ priority: judgementSourcePrioritySchema, name: z.string(), url: z.string() })
  .meta({ id: 'JudgementSource' });
export type JudgementSource = z.infer<typeof judgementSourceSchema>;

/**
 * The evidence as stored and read (decision 3 '증거'): the links, in the registrant's order, and
 * the collection instant (ISO). The description of what was confirmed is the request's reason.
 */
export const judgementEvidenceSchema = z
  .object({ links: z.array(z.string()), collectedAt: z.iso.datetime() })
  .meta({ id: 'JudgementEvidence' });
export type JudgementEvidence = z.infer<typeof judgementEvidenceSchema>;

// ---- refusals -------------------------------------------------------------------------
/**
 * The refusal details of a registration and of a decision (VALIDATION_ERROR, the API's), each
 * message under the head of the path it names:
 * - `status`: a registration or an approval on a market that is not CLOSED (`notClosed` — not
 *   closed yet, or PROVISIONAL since another approval); a 반려 and a 철회 take any status;
 * - `judgement`: another registration of the market is waiting (`pending` — one at a time);
 * - `disputeWindow`: the release setting `market.dispute_window` is undecided (`undecided`), at
 *   the registration and at the approval: no deadline can be fixed from no value;
 * - `source`: a YES or NO with none (`required`, the body's); a priority the market has no source
 *   for (`unknown`);
 * - `fallbackReason`: a fallback source without one (`required`), any other with one
 *   (`fallbackOnly`) — both the body's;
 * - `voidReason`: a VOID without one (`required`), a YES or NO with one (`voidOnly`) — the body's;
 * - `result`: a YES or NO on a market closed early as 판정 불가 (`voidOnly`, `judgementVoidOnly`);
 * - `evidence`: a link given twice (`duplicateLink`, on `evidence.links.<index>`, the body's); a
 *   collection instant after the registration's database clock (`collectedAfterNow`, on
 *   `evidence.collectedAt`);
 * - `eventDeadlineConfirmed`: an approval before the scheduled judgement without the reviewer's
 *   confirmation of the event deadline (`required`);
 * - `requestId`: the path's request is no `market_judgement` request of the market (`unknown`).
 */
export const MARKET_JUDGEMENT_REFUSALS = {
  status: { notClosed: 'not closed' },
  judgement: { pending: 'pending' },
  disputeWindow: { undecided: 'undecided' },
  source: { required: 'required', unknown: 'unknown' },
  fallbackReason: { required: 'required', fallbackOnly: 'only for a fallback source' },
  voidReason: { required: 'required', voidOnly: 'only for VOID' },
  result: { voidOnly: 'void only' },
  evidence: { duplicateLink: 'duplicate', collectedAfterNow: 'after now' },
  eventDeadlineConfirmed: { required: 'required' },
  requestId: { unknown: 'unknown' },
} as const;

type Refusals = typeof MARKET_JUDGEMENT_REFUSALS;
type RefusalMessage<P extends keyof Refusals> = Refusals[P][keyof Refusals[P]];

/** A registration's choice refused for itself: the path the detail names and its message. */
export type JudgementChoiceRefusal =
  | { path: 'source'; message: Refusals['source']['required'] }
  | { path: 'fallbackReason'; message: RefusalMessage<'fallbackReason'> }
  | { path: 'voidReason'; message: RefusalMessage<'voidReason'> };

/** What `judgementChoiceRefusals` reads of a registration: its result, source and reasons. */
export interface JudgementChoice {
  result: MarketResult;
  source: { priority: number } | null;
  fallbackReason?: string | null;
  voidReason?: string | null;
}

/**
 * Why a registration's result, source and reasons do not go together — the source, then the
 * fallback reason, then the VOID reason — or empty when they do (decision 3 '판정 출처', #173
 * items 9·13): a YES or NO names a source; a fallback source carries the reason the primary could
 * not be used, and nothing else does; a VOID carries its reason, and nothing else does. The body
 * refuses with these (`registerJudgementBodySchema`); the screen checks its form by them.
 */
export function judgementChoiceRefusals(choice: JudgementChoice): JudgementChoiceRefusal[] {
  const refusals: JudgementChoiceRefusal[] = [];
  const isVoid = choice.result === 'VOID';
  if (choice.source === null && !isVoid) {
    refusals.push({ path: 'source', message: MARKET_JUDGEMENT_REFUSALS.source.required });
  }
  const fallback = choice.source !== null && isFallbackSourcePriority(choice.source.priority);
  const fallbackReason = choice.fallbackReason != null;
  if (fallback && !fallbackReason) {
    refusals.push({
      path: 'fallbackReason',
      message: MARKET_JUDGEMENT_REFUSALS.fallbackReason.required,
    });
  } else if (!fallback && fallbackReason) {
    refusals.push({
      path: 'fallbackReason',
      message: MARKET_JUDGEMENT_REFUSALS.fallbackReason.fallbackOnly,
    });
  }
  const voidReason = choice.voidReason != null;
  if (isVoid && !voidReason) {
    refusals.push({ path: 'voidReason', message: MARKET_JUDGEMENT_REFUSALS.voidReason.required });
  } else if (!isVoid && voidReason) {
    refusals.push({ path: 'voidReason', message: MARKET_JUDGEMENT_REFUSALS.voidReason.voidOnly });
  }
  return refusals;
}

/**
 * The indexes of the links that repeat an earlier one, compared trimmed and exactly: each is
 * refused on its own index (`evidence.duplicateLink`).
 */
export function duplicateLinkIndexes(links: readonly string[]): number[] {
  const seen = new Set<string>();
  const repeated: number[] = [];
  links.forEach((link, index) => {
    const key = link.trim();
    if (seen.has(key)) repeated.push(index);
    seen.add(key);
  });
  return repeated;
}

/**
 * Whether a market accepts a VOID judgement alone (ADR-0102 결과 5, Q17 (a)): its last pause — the
 * newest, `AdminMarket.pause.history[0]` — ended in an approved 조기 마감 reviewed 판정 불가
 * (`not_judgeable`: "판정이 VOID 규칙을 따른다"). The registration refuses a YES or NO on it
 * (`result` 'void only'); the screen preselects VOID and says why.
 */
export function judgementVoidOnly(
  lastPause: {
    endKind: MarketPauseEndKind | null;
    reviewResult: MarketPauseReviewResult | null;
  } | null,
): boolean {
  return lastPause?.endKind === 'early_closed' && lastPause.reviewResult === 'not_judgeable';
}

/**
 * Whether `nowMs` is before the market's scheduled judgement (예정 판정 시각, #22) — decision 3
 * '등록 시점': the register and approve screens warn then, and the approval needs the reviewer's
 * confirmation of the NO condition's event deadline (`eventDeadlineConfirmed`). The complement of
 * `isJudgementDelayed`'s instant check. A market with none (opened before #22) is never before it.
 */
export function isBeforeScheduledJudgement(
  scheduledJudgementAt: string | Date | null,
  nowMs: number,
): boolean {
  if (scheduledJudgementAt === null) return false;
  const at =
    typeof scheduledJudgementAt === 'string'
      ? Date.parse(scheduledJudgementAt)
      : scheduledJudgementAt.getTime();
  return nowMs < at;
}

/**
 * 이의 기한 (#173 item 5): the provisional result's publication plus the window read then, exact to
 * the millisecond (no rounding) — what `market_judgements.dispute_deadline` holds.
 */
export function disputeDeadlineOf(publishedAt: Date, windowMinutes: number): Date {
  return new Date(publishedAt.getTime() + windowMinutes * 60_000);
}

// ---- bodies ---------------------------------------------------------------------------
/** An http or https address, as an evidence link takes one. */
export const httpUrlSchema = z.url({ protocol: /^https?$/ });

/**
 * An evidence link: trimmed, http or https, at most JUDGEMENT_EVIDENCE_LINK_MAX characters. A
 * judgement's evidence and a 판정 이의's 근거 링크 (#175, market-dispute.ts) take the same one.
 */
export const evidenceLinkSchema = z
  .string()
  .trim()
  .max(JUDGEMENT_EVIDENCE_LINK_MAX)
  .refine((url) => httpUrlSchema.safeParse(url).success, 'Invalid URL');

/**
 * `POST /admin/markets/:id/judgements` (판정 등록, CLOSED; decision 3 the #152 rows):
 * - `result`: YES, NO or VOID;
 * - `source`: the rule's source by its priority (`{priority}` — the server copies its name and
 *   address), or null for none, which a VOID alone may name (`source` 'required' otherwise);
 * - `fallbackReason`: why the primary could not be used — required for a fallback source and
 *   refused for any other (null or left out);
 * - `voidReason`: required for a VOID and refused for a YES or NO (null or left out), public with
 *   the record (#24);
 * - `evidence`: 1..JUDGEMENT_EVIDENCE_LINKS_MAX distinct http(s) links and the collection
 *   instant, from STORABLE_INSTANT_MIN on, not after the registration (the service's) and with no
 *   lower bound — an early result can predate the close;
 * - `description`: what was confirmed — the request's reason;
 * - and the admin on screen (ADR-0092).
 * Each text trimmed, 1..500 characters (approvals.ts). Whether the market has the source, accepts
 * a YES or NO (`judgementVoidOnly`) and may be judged at all are the service's.
 */
export const registerJudgementBodySchema = z
  .object({
    result: marketResultSchema,
    source: z.object({ priority: judgementSourcePrioritySchema }).nullable(),
    fallbackReason: approvalReasonSchema.nullish(),
    voidReason: approvalReasonSchema.nullish(),
    evidence: z.object({
      links: z
        .array(evidenceLinkSchema)
        .min(1)
        .max(JUDGEMENT_EVIDENCE_LINKS_MAX)
        .superRefine((links, ctx) => {
          for (const index of duplicateLinkIndexes(links)) {
            ctx.addIssue({
              code: 'custom',
              path: [index],
              message: MARKET_JUDGEMENT_REFUSALS.evidence.duplicateLink,
            });
          }
        }),
      collectedAt: storableInstantSchema,
    }),
    description: approvalReasonSchema,
    expectedAccountId: expectedAccountIdSchema,
  })
  .superRefine(
    (body, ctx) => {
      for (const { path, message } of judgementChoiceRefusals(body)) {
        ctx.addIssue({ code: 'custom', path: [path], message });
      }
    },
    // Only once every field holds: a priority out of range is its own one issue, never read as
    // a fallback's.
    { when: (payload) => payload.issues.length === 0 },
  )
  .meta({ id: 'RegisterJudgementBody' });
export type RegisterJudgementBody = z.infer<typeof registerJudgementBodySchema>;

/**
 * `POST /admin/markets/:id/judgements/:requestId/approve` (an admin other than the registrant,
 * CLOSED): the approver's reason (the decision reason, required and trimmed), whether the approver
 * confirmed the NO condition's event deadline — required true when the approval comes before the
 * scheduled judgement (`eventDeadlineConfirmed` 'required', the service's), kept on the judgement
 * either way — and the admin on screen.
 */
export const approveJudgementBodySchema = z
  .object({
    reason: approvalReasonSchema,
    eventDeadlineConfirmed: z.boolean(),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'ApproveJudgementBody' });
export type ApproveJudgementBody = z.infer<typeof approveJudgementBodySchema>;

/**
 * `POST /admin/markets/:id/judgements/:requestId/reject` (반려, an admin other than the
 * registrant, in any status): the reason (the decision reason, required) and the admin on screen.
 */
export const rejectJudgementBodySchema = z
  .object({ reason: approvalReasonSchema, expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'RejectJudgementBody' });
export type RejectJudgementBody = z.infer<typeof rejectJudgementBodySchema>;

/**
 * `POST /admin/markets/:id/judgements/:requestId/retract` (철회, the registrant's, in any status):
 * the admin on screen and nothing else — `expectedAccountBodySchema` itself.
 */
export const retractJudgementBodySchema = expectedAccountBodySchema;
export type RetractJudgementBody = ExpectedAccountBody;

// ---- records --------------------------------------------------------------------------
/**
 * `approval_requests.payload` of a registration (frozen at the insert, migration 0021): the
 * result, the source with its name and address copied from `market_sources` (null for none), the
 * fallback and VOID reasons (null where none), the evidence and the rule version the market had
 * (`markets.rule_version`, null for a market opened before #80) — the approval copies it all to
 * the judgement. The description is the request's reason. No `.meta`: no route answers it as is.
 */
export const marketJudgementRequestPayloadSchema = z.object({
  result: marketResultSchema,
  source: judgementSourceSchema.nullable(),
  fallbackReason: z.string().nullable(),
  voidReason: z.string().nullable(),
  evidence: judgementEvidenceSchema,
  ruleVersion: ruleVersionNumberSchema.nullable(),
});
export type MarketJudgementRequestPayload = z.infer<typeof marketJudgementRequestPayloadSchema>;

/**
 * `provisional`'s payload (enums.ts): the judgement version the approval published, its result,
 * the approved request, its registrant's id and the 이의 기한 (ISO). The event's actor is the
 * approver.
 */
export interface MarketProvisionalPayload {
  version: number;
  result: MarketResult;
  approvalId: string;
  requestedBy: string;
  disputeDeadline: string;
}

/**
 * `resolved`'s payload since #152: the judgement version confirmed, its result and why it was
 * confirmed — its dispute deadline passed with nothing held (`deadline`). The confirmation after
 * the last holding 판정 이의 is dismissed past the deadline is the worker's too, so it is
 * `deadline` as well (#175, ADR-0104: the dismissal only enqueues `market.resolve`). The event's
 * actor is null, the worker.
 */
export interface MarketResolvedByDeadlinePayload {
  version: number;
  result: MarketResult;
  source: 'deadline';
}

/**
 * `resolved`'s payload before #152: ADR-0046's interim judgement by one admin (closed → resolved,
 * the actor), YES or NO with the optional note and evidence address. Nothing writes it now.
 */
export interface MarketInterimResolvedPayload {
  result: 'YES' | 'NO';
  note: string | null;
  evidenceUrl: string | null;
}

/** `resolved`'s payload, either kind: a `version` tells the confirmation since #152 apart. */
export type MarketResolvedPayload = MarketResolvedByDeadlinePayload | MarketInterimResolvedPayload;

/**
 * `market_judgement_request`'s payload (admin_actions, target `market`): the request it opened,
 * the registration as its payload froze it, and the description.
 */
export interface MarketJudgementRequestActionPayload extends MarketJudgementRequestPayload {
  approvalId: string;
  description: string;
}

/**
 * `market_judgement_approve`'s payload: the request, the version it made and its result, the
 * approver's reason and event-deadline confirmation, the window read and the deadline it fixed
 * (ISO), and `market_update`'s snapshot before and after.
 */
export interface MarketJudgementApproveActionPayload {
  approvalId: string;
  version: number;
  result: MarketResult;
  reason: string;
  eventDeadlineConfirmed: boolean;
  disputeWindowMinutes: number;
  disputeDeadline: string;
  before: unknown;
  after: unknown;
}

/** `market_judgement_reject`'s payload: the request, its result and the rejecting reason. */
export interface MarketJudgementRejectActionPayload {
  approvalId: string;
  result: MarketResult;
  reason: string;
}

/** `market_judgement_retract`'s payload: the request its registrant retracted and its result. */
export interface MarketJudgementRetractActionPayload {
  approvalId: string;
  result: MarketResult;
}

// ---- read models ----------------------------------------------------------------------
/** What a registration says, as every read model below shows it. */
const registrationFields = {
  result: marketResultSchema,
  /** Null for none — a VOID's alone. */
  source: judgementSourceSchema.nullable(),
  /** Null but for a fallback source. */
  fallbackReason: z.string().nullable(),
  /** Null but for a VOID. */
  voidReason: z.string().nullable(),
  evidence: judgementEvidenceSchema,
  /** 확인한 내용의 설명: the request's reason. */
  description: z.string(),
  /** The rule version the judgement follows (ADR-0101 결과 5); null for one opened before #80. */
  ruleVersion: ruleVersionNumberSchema.nullable(),
};

/**
 * The market's current judgement (`AdminMarket.judgement.current`; `market_judgements`): its
 * version, what it says, whether the approver confirmed the event deadline, the window read at
 * the approval and the instants it fixed (`publishedAt`, the approval's; `disputeDeadline`), the
 * approved request, and who registered and who approved it. An account closed since keeps its id
 * with a null nickname. Admins only: #24 publishes the record without the two names.
 */
export const adminMarketJudgementSchema = z
  .object({
    version: judgementVersionSchema,
    ...registrationFields,
    eventDeadlineConfirmed: z.boolean(),
    disputeWindowMinutes: disputeWindowMinutesSchema,
    publishedAt: z.iso.datetime(),
    disputeDeadline: z.iso.datetime(),
    approvalId: z.uuid(),
    registeredBy: adminAccountActorSchema,
    approvedBy: adminAccountActorSchema,
  })
  .meta({ id: 'AdminMarketJudgement' });
export type AdminMarketJudgement = z.infer<typeof adminMarketJudgementSchema>;

/**
 * The registration waiting on a market (`AdminMarket.judgement.pending`): the request, what it
 * says, who registered it and when. Its registrant may not decide it (approvals.ts).
 */
export const marketJudgementPendingSchema = z
  .object({
    requestId: z.uuid(),
    ...registrationFields,
    requestedBy: adminAccountActorSchema,
    requestedAt: z.iso.datetime(),
  })
  .meta({ id: 'MarketJudgementPending' });
export type MarketJudgementPending = z.infer<typeof marketJudgementPendingSchema>;

/**
 * One registration of the admin detail's log (`AdminMarket.judgement.log`): the registration as
 * `marketJudgementPendingSchema` and how it ended — `status` pending, approved, rejected or
 * retracted; the decider, the decision's instant and reason (null unless decided); the 철회's
 * instant (null unless retracted); and the version an approval made (null unless approved).
 */
export const marketJudgementLogEntrySchema = marketJudgementPendingSchema
  .extend({
    status: approvalStatusSchema,
    decidedBy: adminAccountActorSchema.nullable(),
    decidedAt: z.iso.datetime().nullable(),
    decisionReason: z.string().nullable(),
    retractedAt: z.iso.datetime().nullable(),
    version: judgementVersionSchema.nullable(),
  })
  .meta({ id: 'MarketJudgementLogEntry' });
export type MarketJudgementLogEntry = z.infer<typeof marketJudgementLogEntrySchema>;

/** `AdminMarket.judgement`, in every status (#152): the judgement, the waiting one, every one. */
export const adminMarketJudgementStateSchema = z
  .object({
    /** The current judgement; null until one is approved (and for an interim one, before #152). */
    current: adminMarketJudgementSchema.nullable(),
    /** The waiting `market_judgement` request; null when none waits (at most one does). */
    pending: marketJudgementPendingSchema.nullable(),
    /** Every registration of the market, the newest first, the waiting one included. */
    log: z.array(marketJudgementLogEntrySchema),
    /**
     * Whether the release setting `market.dispute_window` is undecided now, read in the detail's
     * snapshot: a registration and an approval are refused while it is (`disputeWindow`).
     */
    disputeWindowUndecided: z.boolean(),
  })
  .meta({ id: 'AdminMarketJudgementState' });
export type AdminMarketJudgementState = z.infer<typeof adminMarketJudgementStateSchema>;

// ---- the queue ------------------------------------------------------------------------
/**
 * One row of `GET /admin/market-judgements` (판정 승인 대기, #152; query `cursorQuerySchema`): a
 * waiting registration and its market, the oldest request first, in any status — one on a market
 * no longer CLOSED only a 반려 or a 철회 ends. The scheduled judgement (null before #22) lets the
 * queue say an approval would come before it.
 */
export const adminMarketJudgementQueueItemSchema = z
  .object({
    requestId: z.uuid(),
    marketId: z.uuid(),
    slug: z.string(),
    title: z.string(),
    status: marketStatusSchema,
    closeAt: z.iso.datetime(),
    scheduledJudgementAt: z.iso.datetime().nullable(),
    result: marketResultSchema,
    requestedBy: adminAccountActorSchema,
    requestedAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminMarketJudgementQueueItem' });
export type AdminMarketJudgementQueueItem = z.infer<typeof adminMarketJudgementQueueItemSchema>;
