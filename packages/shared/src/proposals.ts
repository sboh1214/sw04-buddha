import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { cursorQuerySchema } from './api/pagination.js';
import { uuidSchema } from './api/uuid.js';
import { INT4_MAX, MARKET_SOURCE_MAX, MARKET_TEXT_MAX } from './constants.js';
import {
  marketStatusSchema,
  proposalRejectionReasonSchema,
  proposalStatusSchema,
  type ProposalStatus,
} from './enums.js';

/**
 * 시장 제안 (#77): a member proposes a market — a question, the date its result will be known, the
 * YES condition and the sources expected to settle it — and follows it in 내 제안; operators review
 * it for duplicates and for whether it can be judged, and adopt or reject it with a reason (N05 §6,
 * N03 §2). Owner decisions (ADR-0069 decision 4, the #77 rows; decision 1 #57-8·#57-13; decision 2
 * #45-12; decision 7):
 *
 * - The form: the question (100 characters), one date by which the result is known, the YES
 *   condition (1,000 characters) and the expected sources, all required; a background and a
 *   wished-for category, optional. No probability anywhere (N02 §10). No edits after submitting.
 * - Who: an account that finished the onboarding, not under an account restriction (#139) nor a
 *   writing restriction (#185). At most PROPOSAL_LIMITS.pendingProposals proposals waiting
 *   (접수·검토) and PROPOSAL_LIMITS.dailyProposals a day, counted by the verified number's keyed
 *   hash (ADR-0071), not by account (decision 7) — members only: an operator's account is exempt,
 *   as from the frequency limits (owner decision 2026-10-19). The repeated-link check does not
 *   apply.
 * - The statuses (PROPOSAL_STATUSES): 접수 → 검토 → 채택·반려, 접수 → 반려 directly, and 접수 → 철회 by
 *   the proposer — signed in is enough for that, whatever the onboarding (owner decision
 *   2026-10-19). 채택 and 반려 are never undone.
 * - A 반려 names a reason from PROPOSAL_REJECTION_REASONS — a 중복 with the existing market — and an
 *   explanation the proposer reads; a 채택 may carry a memo. The operators' internal memo is apart
 *   and never reaches the proposer.
 * - A 채택 may make a market draft filled from the proposal, or link an existing market; the
 *   proposer sees the market's link once it is public (not DRAFT or REVIEW). It grants no Coin and
 * opens   nothing: the market opens through the operators' own steps (#78 adds the second
 * reviewer). A   proposal adopted with no market may have one linked later, once, the same two ways
 *   (`canLinkProposalMarket`, owner decision 2026-10-19); it stays 채택.
 * - Only the proposer and the operators see a proposal. A market never shows who proposed it, and
 *   a proposal is not something to report.
 */

/** The question, the market's title-to-be (owner decision: 100 characters). */
export const PROPOSAL_QUESTION_MAX = 100;
/** The YES condition, the market's rules-to-be (owner decision: 1,000 characters). */
export const PROPOSAL_YES_CONDITION_MAX = 1_000;
/**
 * The expected sources. The owner set no length; this PR takes the length of the market field a
 * draft fills from it (`resolutionSource`, MARKET_SOURCE_MAX), so an adopted proposal always fits.
 */
export const PROPOSAL_SOURCES_MAX = MARKET_SOURCE_MAX;
/**
 * The background. The owner set no length; this PR takes the length of the market field a draft
 * fills from it (`description`, MARKET_TEXT_MAX), so an adopted proposal always fits.
 */
export const PROPOSAL_BACKGROUND_MAX = MARKET_TEXT_MAX;
/** A 반려's explanation to the proposer, a 채택's memo, the operators' internal memo. */
export const PROPOSAL_NOTE_MAX = 1_000;

/**
 * The owner's limits (ADR-0069 decision 4 #77, 남용 방지), counted by the verified number's keyed
 * hash across every account that verified it (decision 7): proposals waiting for the operators
 * (접수·검토, PENDING_PROPOSAL_STATUSES), and proposals made in the last `dailyWindowSeconds` — a
 * rolling 24 hours, as the 본인확인's daily limits count (PHONE_VERIFICATION_LIMITS), whatever their
 * status since (a retracted or rejected one still counts for its day; owner decision 2026-10-19).
 * A member's limits: an operator's account proposes past them (owner decision 2026-10-19).
 */
export const PROPOSAL_LIMITS = {
  pendingProposals: 5,
  dailyProposals: 3,
  dailyWindowSeconds: 24 * 60 * 60,
} as const;

/** The statuses that wait for the operators: the pending limit counts these. */
export const PENDING_PROPOSAL_STATUSES = [
  'submitted',
  'reviewing',
] as const satisfies readonly ProposalStatus[];

/**
 * Where each status may go (ADR-0069 decision 4 #77): 접수 to 검토, 반려 or (by the proposer) 철회;
 * 검토 to 채택 or 반려; nothing out of 채택, 반려 or 철회. The database holds the same table
 * (migration 0046's trigger), whoever writes.
 */
export const PROPOSAL_TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  submitted: ['reviewing', 'rejected', 'retracted'],
  reviewing: ['adopted', 'rejected'],
  adopted: [],
  rejected: [],
  retracted: [],
};

export function canMoveProposal(from: ProposalStatus, to: ProposalStatus): boolean {
  return PROPOSAL_TRANSITIONS[from].includes(to);
}

/**
 * Whether a market may be linked to a proposal now (owner decision 2026-10-19): only to a 채택
 * that has none — adopted with no market and not linked since. Once, so a proposal with a market
 * never takes another; the status stays 채택. Not a move of PROPOSAL_TRANSITIONS: the database
 * allows exactly this one change of a 채택 (migration 0046's trigger), whoever writes.
 */
export function canLinkProposalMarket(status: ProposalStatus, hasMarket: boolean): boolean {
  return status === 'adopted' && !hasMarket;
}

/** Korea keeps no daylight saving since 1988: a Korean date is the UTC date nine hours on. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

/** The Korean calendar date `at` falls on, `YYYY-MM-DD`. */
function koreanDateOf(at: Date): string {
  return new Date(at.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Whether `deadline` (`YYYY-MM-DD`) may be a proposal's date at `now`: today in Korea or later. A
 * date already past names a question whose result is known, which N03 §2 never opens; the owner
 * set no further bound. The server asks it at its database clock; a screen may ask it at its own
 * to warn early.
 */
export function isProposalDeadlineOpen(deadline: string, now: Date): boolean {
  // `YYYY-MM-DD` strings order as the dates do.
  return deadline >= koreanDateOf(now);
}

/**
 * The close time a draft made from a proposal starts with when the operator gives none: 00:00 in
 * Korea of the proposal's date — trading stops as the day the result is to be known begins. Only
 * where the draft starts: a draft is not public and every field of it can be edited before it
 * opens (`PATCH /admin/markets/:id`).
 */
export function proposalDraftCloseAt(deadline: string): Date {
  return new Date(`${deadline}T00:00:00.000+09:00`);
}

/** The account the screen shows (better-auth `user.id`, text), as every owner write carries. */
const expectedAccountIdSchema = z.string().min(1).max(255);

/** A category id: int4 column, so an unbounded id would reach Postgres out of range (500). */
const categoryIdSchema = z.number().int().positive().max(INT4_MAX);

/**
 * `POST /me/proposals`: the form (ADR-0069 decision 4 #77). Every text is trimmed; the four
 * required ones may not be blank, an empty background is none. The date is a calendar date
 * (`YYYY-MM-DD`), today in Korea or later (`isProposalDeadlineOpen`, checked by the server at its
 * clock). The category is any active one under an active parent, either level — the categories
 * `GET /categories` lists (#17) — or none. A field the form does not have — a probability, say
 * (N02 §10) — is dropped, never stored. And the account the screen shows (`expectedAccountId`, as
 * on every owner write since A-PG-24): a window still showing account A after another one signed
 * in as B would otherwise propose as B.
 */
export const createProposalBodySchema = z
  .object({
    question: z.string().trim().min(1).max(PROPOSAL_QUESTION_MAX),
    deadline: z.iso.date(),
    yesCondition: z.string().trim().min(1).max(PROPOSAL_YES_CONDITION_MAX),
    expectedSources: z.string().trim().min(1).max(PROPOSAL_SOURCES_MAX),
    background: z.string().trim().max(PROPOSAL_BACKGROUND_MAX).nullish(),
    categoryId: categoryIdSchema.nullish(),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'CreateProposalBody' });
export type CreateProposalBody = z.infer<typeof createProposalBodySchema>;

/**
 * `POST /me/proposals/:id/retract`: the account the screen shows, and nothing else — a body rather
 * than a query or a header, so the account id stays out of the address.
 */
export const proposalWriteBodySchema = z
  .object({ expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'ProposalWriteBody' });
export type ProposalWriteBody = z.infer<typeof proposalWriteBodySchema>;

/** The category a proposal wished for, as a list shows one. */
const proposalCategorySchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  nameKo: z.string(),
});

/**
 * The wished-for category as the operators see it: whether it is still in use (`isActive`). A
 * wish retired since it was proposed is no default for a draft — the 채택 form leaves the draft's
 * category to the operator and names the wish as retired (owner decision 2026-10-19).
 */
const adminProposalCategorySchema = proposalCategorySchema.extend({ isActive: z.boolean() });

/** The fields a proposal was submitted with: the same for the proposer and the operators. */
const proposalFields = {
  id: z.uuid(),
  question: z.string(),
  /** The date the result is to be known, `YYYY-MM-DD` (a Korean date). */
  deadline: z.iso.date(),
  yesCondition: z.string(),
  expectedSources: z.string(),
  background: z.string().nullable(),
  /** The wished-for category; null when none was picked, or when the category went away. */
  category: proposalCategorySchema.nullable(),
  status: proposalStatusSchema,
  createdAt: z.iso.datetime(),
};

/**
 * A public market a proposal points the proposer at: its address (`slug`) and title. Only once it
 * is public — never a DRAFT or REVIEW one, which no public route serves.
 */
export const proposalMarketSchema = z
  .object({ id: z.uuid(), slug: z.string(), title: z.string() })
  .meta({ id: 'ProposalMarket' });
export type ProposalMarket = z.infer<typeof proposalMarketSchema>;

/**
 * One of the caller's proposals (`GET /me/proposals`, `GET /me/proposals/:id` and the writes'
 * answers): what it submitted, the status and when it took it, and the reason the operators gave.
 * No operator is named, nothing of the internal memo is there, and neither is the verified number
 * nor its hash.
 *
 * - `rejection` is there once 반려: the reason, the explanation, and for a 중복 the existing market
 *   while it is public (`duplicateMarket`, null while it is DRAFT or REVIEW).
 * - `adoption` is there once 채택: the memo, if any, and the market it led to while that market is
 *   public (`market`, null while it is DRAFT or REVIEW or when none was linked — at the 채택 or
 * later).   Never a promise of Coin or of opening.
 */
export const proposalSchema = z
  .object({
    ...proposalFields,
    /** When it took its status: submitted, review started, decided or retracted. */
    statusChangedAt: z.iso.datetime(),
    rejection: z
      .object({
        reason: proposalRejectionReasonSchema,
        explanation: z.string(),
        duplicateMarket: proposalMarketSchema.nullable(),
      })
      .nullable(),
    adoption: z
      .object({
        memo: z.string().nullable(),
        market: proposalMarketSchema.nullable(),
      })
      .nullable(),
  })
  .meta({ id: 'Proposal' });
export type Proposal = z.infer<typeof proposalSchema>;

/** A market a proposal is linked to, as the operators see it: any status, drafts included. */
export const adminProposalMarketSchema = proposalMarketSchema
  .extend({ status: marketStatusSchema })
  .meta({ id: 'AdminProposalMarket' });
export type AdminProposalMarket = z.infer<typeof adminProposalMarketSchema>;

/**
 * A proposal on the admin screen (`GET /admin/proposals`, `GET /admin/proposals/:id` and the
 * writes' answers): what was submitted, who proposed it, who started the review and who decided it
 * and when (ADR-0069 decision 4 #77, 검토 흐름·기록), the reason or memo, the market — and who
 * linked it and when, when it was linked after the 채택 (owner decision 2026-10-19) — and the
 * operators' internal memo. Accounts are named as every admin record names one
 * (`AdminAccountActor`: id and current nickname — null for an account its member closed, #140,
 * whose proposals the operators still review). The wished-for category says whether it is still
 * in use.
 */
export const adminProposalSchema = z
  .object({
    ...proposalFields,
    category: adminProposalCategorySchema.nullable(),
    proposer: adminAccountActorSchema,
    reviewStartedAt: z.iso.datetime().nullable(),
    reviewStartedBy: adminAccountActorSchema.nullable(),
    /** The 채택 or 반려. */
    decidedAt: z.iso.datetime().nullable(),
    decidedBy: adminAccountActorSchema.nullable(),
    retractedAt: z.iso.datetime().nullable(),
    /** A market linked after the 채택, once; null while none was (or it came with the 채택). */
    marketLinkedAt: z.iso.datetime().nullable(),
    marketLinkedBy: adminAccountActorSchema.nullable(),
    rejection: z
      .object({
        reason: proposalRejectionReasonSchema,
        explanation: z.string(),
        duplicateMarket: adminProposalMarketSchema.nullable(),
      })
      .nullable(),
    adoption: z
      .object({
        memo: z.string().nullable(),
        market: adminProposalMarketSchema.nullable(),
      })
      .nullable(),
    /** The operators' own note; never shown to the proposer. */
    internalMemo: z.string().nullable(),
  })
  .meta({ id: 'AdminProposal' });
export type AdminProposal = z.infer<typeof adminProposalSchema>;

/** `GET /admin/proposals` (no `.meta`: query DTO). Newest first; any status unless one is named. */
export const adminProposalListQuerySchema = cursorQuerySchema.extend({
  status: proposalStatusSchema.optional(),
});
export type AdminProposalListQuery = z.infer<typeof adminProposalListQuerySchema>;

/**
 * The market of a 채택 (ADR-0069 decision 4 #77, 채택과 시장): a draft made from the proposal
 * (`draft`) — titled with the question, the YES condition as its rules, the sources as its
 * resolution source, the background as its description — in the category given here, else the
 * proposal's, closing at the time given here, else `proposalDraftCloseAt`; or a market that exists
 * already, in any status (`existing`).
 */
export const proposalAdoptionMarketSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('draft'),
      categoryId: categoryIdSchema.optional(),
      closeAt: z.iso.datetime().optional(),
    }),
    z.object({ type: z.literal('existing'), marketId: uuidSchema }),
  ])
  .meta({ id: 'ProposalAdoptionMarket' });
export type ProposalAdoptionMarket = z.infer<typeof proposalAdoptionMarketSchema>;

/**
 * `POST /admin/proposals/:id/adopt` (검토 → 채택): the memo the proposer reads, if any, and the
 * market, if any. Final: a 채택 is never undone. Every admin write on a proposal names the admin on
 * screen (`expectedAccountId`, ADR-0092 — 검토 시작 with `expectedAccountBodySchema`).
 */
export const adoptProposalBodySchema = z
  .object({
    memo: z.string().trim().max(PROPOSAL_NOTE_MAX).nullish(),
    market: proposalAdoptionMarketSchema.nullish(),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'AdoptProposalBody' });
export type AdoptProposalBody = z.infer<typeof adoptProposalBodySchema>;

/**
 * `POST /admin/proposals/:id/market` (owner decision 2026-10-19): the market of a proposal adopted
 * with none, linked later — a draft made from the proposal or an existing market, as at the 채택
 * (`proposalAdoptionMarketSchema`, the same defaults and refusals). Once: a proposal that has a
 * market — from the 채택 or from an earlier link — is refused. The status stays 채택, and the memo
 * stays as the 채택 left it.
 */
export const linkProposalMarketBodySchema = z
  .object({ market: proposalAdoptionMarketSchema, expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'LinkProposalMarketBody' });
export type LinkProposalMarketBody = z.infer<typeof linkProposalMarketBodySchema>;

/**
 * `POST /admin/proposals/:id/reject` (접수 or 검토 → 반려): the reason, the explanation the proposer
 * reads, and the existing market — required for a 중복 and refused for any other reason. Final.
 */
export const rejectProposalBodySchema = z
  .object({
    reason: proposalRejectionReasonSchema,
    explanation: z.string().trim().min(1).max(PROPOSAL_NOTE_MAX),
    duplicateMarketId: uuidSchema.nullish(),
    expectedAccountId: expectedAccountIdSchema,
  })
  .superRefine((body, ctx) => {
    const named = body.duplicateMarketId != null;
    if (body.reason === 'duplicate' && !named) {
      ctx.addIssue({
        code: 'custom',
        path: ['duplicateMarketId'],
        message: 'a duplicate names the existing market',
      });
    } else if (body.reason !== 'duplicate' && named) {
      ctx.addIssue({
        code: 'custom',
        path: ['duplicateMarketId'],
        message: 'only a duplicate names a market',
      });
    }
  })
  .meta({ id: 'RejectProposalBody' });
export type RejectProposalBody = z.infer<typeof rejectProposalBodySchema>;

/**
 * `PUT /admin/proposals/:id/internal-memo`: the operators' memo, in any status; empty or null
 * clears it. Never shown to the proposer.
 */
export const proposalInternalMemoBodySchema = z
  .object({
    memo: z.string().trim().max(PROPOSAL_NOTE_MAX).nullable(),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'ProposalInternalMemoBody' });
export type ProposalInternalMemoBody = z.infer<typeof proposalInternalMemoBodySchema>;

/**
 * PROPOSAL_LIMITED (429): no proposal was taken, because the verified number has
 * PROPOSAL_LIMITS.pendingProposals proposals waiting (`pending`: passes once one is decided or
 * retracted, so no time is given) or made PROPOSAL_LIMITS.dailyProposals in the last 24 hours
 * (`daily`: `retryAfterSeconds` is when the oldest of them leaves the window, rounded up to the
 * minute, as the 본인확인's limits shared with other accounts round theirs — the count takes in
 * every account that verified the number). `limit` is the limit reached.
 */
export const PROPOSAL_LIMIT_REASONS = ['pending', 'daily'] as const;
export type ProposalLimitReason = (typeof PROPOSAL_LIMIT_REASONS)[number];
export const proposalLimitedDetailsSchema = z.object({
  reason: z.enum(PROPOSAL_LIMIT_REASONS),
  limit: z.number().int().min(1),
  retryAfterSeconds: z.number().int().min(1).nullable(),
});
export type ProposalLimitedDetails = z.infer<typeof proposalLimitedDetailsSchema>;
