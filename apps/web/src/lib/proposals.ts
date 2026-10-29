import {
  PROPOSAL_BACKGROUND_MAX,
  PROPOSAL_NOTE_MAX,
  PROPOSAL_QUESTION_MAX,
  PROPOSAL_REJECTION_REASONS,
  PROPOSAL_SOURCES_MAX,
  PROPOSAL_YES_CONDITION_MAX,
  canLinkProposalMarket,
  canMoveProposal,
  isProposalDeadlineOpen,
  proposalLimitedDetailsSchema,
  uuidParamSchema,
  type ProposalRejectionReason,
  type ProposalStatus,
} from '@buddha/shared';
import type { Route } from 'next';
import * as z from 'zod';
import { copy } from '@/copy';
import {
  type AdminProposal,
  type AdoptProposalBody,
  type CreateProposalBody,
  type LinkProposalMarketBody,
  type RejectProposalBody,
  isApiError,
  isForAnotherAccount,
} from './api';
import { nicknameShown } from './account-closure';
import { type CategoryNode, locateCategory } from './category-tree';
import { kstLocalToIso } from './datetime';
import { formatWait } from './phone-verification';
import { restrictedMessage } from './restriction';

/**
 * 시장 제안 (#77, ADR-0089) as the screens read it: the form (`/proposals/new`), 내 제안
 * (`/my/proposals`, a MY sub-page and no tab), and the operators' review (`/admin/proposals`). The
 * RULES are @buddha/shared's — the lengths, the date rule (`isProposalDeadlineOpen`), the status
 * moves (`canMoveProposal`) — the very ones the API applies, so a form neither accepts what the
 * server refuses on those grounds nor refuses what it accepts; only the messages are localised
 * here. Owner decisions: ADR-0069 decision 4, the #77 rows, and decision 7 (the limits count by the
 * verified number, which only the server knows).
 *
 * Pure functions, kept out of the components so vitest can run them under its node environment.
 */

/** 내 제안: a MY sub-page, linked from the MY summary and 설정 — not a ninth tab (ADR-0069 #77 위치). */
export const MY_PROPOSALS_PATH = '/my/proposals' satisfies Route;
/** The form. Outside MY: the search's no-results screen and the explore home link to it. */
export const NEW_PROPOSAL_PATH = '/proposals/new' satisfies Route;
export const ADMIN_PROPOSALS_PATH = '/admin/proposals' satisfies Route;

/**
 * Where the form sends a visitor with no session: the login screen, told to come back to the
 * form. A fixed path — nothing of the request travels into `next`.
 */
export const NEW_PROPOSAL_LOGIN_PATH = `/login?next=${encodeURIComponent(NEW_PROPOSAL_PATH)}`;

/**
 * The query keys. `['proposals']` is a private root (`PRIVATE_QUERY_ROOTS`, market-keys.ts): the
 * member's own proposals, never fetched on the server or dehydrated. No key under it says whose
 * they are (SessionCacheGuard resets the cache on an account change). The admin keys sit under the
 * private `['admin']` root, each list by its status filter under one prefix so a write refreshes
 * every filter.
 */
export const PROPOSALS_KEY = ['proposals'] as const;
export const MY_PROPOSALS_KEY = [...PROPOSALS_KEY, 'mine'] as const;
export const ADMIN_PROPOSALS_KEY = ['admin', 'proposals'] as const;
export const ADMIN_PROPOSAL_KEY = ['admin', 'proposal'] as const;
export const adminProposalsKey = (status: ProposalStatus | '') =>
  [...ADMIN_PROPOSALS_KEY, status] as const;
/** On the canonical lower-cased uuid, as `adminMarketKey` (A-M3-29). */
export const adminProposalKey = (id: string) => [...ADMIN_PROPOSAL_KEY, id.toLowerCase()] as const;

/** The route segment as a proposal id, or undefined when it cannot be one (no request is sent). */
export function proposalIdParam(id: string): string | undefined {
  return uuidParamSchema.safeParse(id).data;
}

// ---- statuses and reasons -------------------------------------------------------------

/** The owner's five words (ADR-0069 decision 4 #77): 접수·검토·채택·반려 and the proposer's 철회. */
export const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = {
  submitted: copy.proposalStatusSubmitted,
  reviewing: copy.proposalStatusReviewing,
  adopted: copy.proposalStatusAdopted,
  rejected: copy.proposalStatusRejected,
  retracted: copy.proposalStatusRetracted,
};

/**
 * Colour only reinforces the label (PLAN 11.2): gray while it waits or once it was retracted,
 * orange under review, brand for 채택, `no` for 반려 — the order list's palette.
 */
export const PROPOSAL_STATUS_PALETTE: Record<ProposalStatus, 'brand' | 'gray' | 'orange' | 'no'> = {
  submitted: 'gray',
  reviewing: 'orange',
  adopted: 'brand',
  rejected: 'no',
  retracted: 'gray',
};

/**
 * What the time a proposal took its status is called beside it (`statusChangedAt`): when it was
 * proposed, when the review started, when it was adopted, rejected or retracted.
 */
export const PROPOSAL_STATUS_TIME_LABEL: Record<ProposalStatus, string> = {
  submitted: copy.proposalSubmittedAt,
  reviewing: copy.proposalReviewStartedAt,
  adopted: copy.proposalStatusAdopted,
  rejected: copy.proposalStatusRejected,
  retracted: copy.proposalStatusRetracted,
};

/** The owner's list of 반려 reasons (ADR-0069 decision 4 #77 사유), in its order. */
export const PROPOSAL_REJECTION_REASON_LABEL: Record<ProposalRejectionReason, string> = {
  duplicate: copy.proposalReasonDuplicate,
  ambiguous_criteria: copy.proposalReasonAmbiguousCriteria,
  prohibited_topic: copy.proposalReasonProhibitedTopic,
  other: copy.proposalReasonOther,
};

/** Whether the proposer may retract it: only from 접수 (the shared transition table). */
export function canRetractProposal(status: ProposalStatus): boolean {
  return canMoveProposal(status, 'retracted');
}

/**
 * What the operators may do with a proposal: start the review (접수), adopt (검토), reject (접수 or
 * 검토) — the shared transition table — and link a market to a 채택 that has none, once
 * (`canLinkProposalMarket`, owner decision 2026-10-19), so a button is never offered for a write the
 * server refuses. Nothing else out of 채택, and nothing out of 반려 or 철회.
 */
export function adminProposalActions(proposal: Pick<AdminProposal, 'status' | 'adoption'>): {
  review: boolean;
  adopt: boolean;
  reject: boolean;
  link: boolean;
} {
  const { status, adoption } = proposal;
  return {
    review: canMoveProposal(status, 'reviewing'),
    adopt: canMoveProposal(status, 'adopted'),
    reject: canMoveProposal(status, 'rejected'),
    link: canLinkProposalMarket(status, (adoption?.market ?? null) !== null),
  };
}

/**
 * An account as the admin screens name it — the proposer, who started the review, who decided,
 * who linked a market later: its nickname, or '탈퇴한 사용자' once its member closed the account
 * (#140, ADR-0086: `AdminAccountActor`'s nickname is null then — the operators still review and
 * decide its proposals, ADR-0069 decision 4 #140). Every line of the list and of the detail's
 * record that names one goes through here, so none of them draws an empty name; '' only for a step
 * with no account (never with its time, which the record shows alone then).
 */
export function proposalActorName(actor: AdminProposal['proposer'] | null): string {
  return actor === null ? '' : nicknameShown(actor.nickname);
}

// ---- dates ----------------------------------------------------------------------------

/** Korea keeps no daylight saving since 1988: a Korean date is the UTC date nine hours on. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

/**
 * Today's date in Korea, `YYYY-MM-DD`: the earliest date the form offers (`min`). The rule itself
 * is `isProposalDeadlineOpen` (@buddha/shared), which the server asks at its own clock; this is
 * the same day boundary (proposals.test.ts pins that the two agree).
 */
export function koreanToday(now: Date): string {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * A proposal's date (`YYYY-MM-DD`, a Korean calendar date) as a screen writes it, in the style of
 * the date part of every absolute time here (`2026. 11. 1.`, formatKst). Not converted to any time
 * zone: it is a day, not an instant. `''` for anything that is not such a date.
 */
export function formatProposalDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return '';
  const [, year, month, day] = match;
  return `${String(Number(year))}. ${String(Number(month))}. ${String(Number(day))}.`;
}

// ---- the form -------------------------------------------------------------------------

/** What the inputs hold: strings, a blank category for none. */
export interface ProposalFormValues {
  question: string;
  /** `<input type="date">`'s value, `YYYY-MM-DD`, or '' until one is picked. */
  deadline: string;
  yesCondition: string;
  expectedSources: string;
  background: string;
  /** The category's id as the `<select>` holds it; '' for none (it is optional). */
  categoryId: string;
}

export const EMPTY_PROPOSAL_FORM: ProposalFormValues = {
  question: '',
  deadline: '',
  yesCondition: '',
  expectedSources: '',
  background: '',
  categoryId: '',
};

const CATEGORY_ID_PATTERN = /^\d+$/;
const isoDate = z.iso.date();

/**
 * The form's schema: the API's `createProposalBodySchema` restated field by field only for its
 * messages — the same trimming, the same lengths, the date at the browser's clock by the shared
 * rule (the server checks again at its own). `now` is injectable for tests.
 */
export function proposalFormSchema(now: () => Date = () => new Date()) {
  return z.object({
    question: z
      .string()
      .trim()
      .min(1, copy.errProposalQuestion)
      .max(PROPOSAL_QUESTION_MAX, copy.errProposalQuestion),
    deadline: z
      .string()
      .refine(
        (value) => isoDate.safeParse(value).success && isProposalDeadlineOpen(value, now()),
        copy.errProposalDeadline,
      ),
    yesCondition: z
      .string()
      .trim()
      .min(1, copy.errProposalYesCondition)
      .max(PROPOSAL_YES_CONDITION_MAX, copy.errProposalYesCondition),
    expectedSources: z
      .string()
      .trim()
      .min(1, copy.errProposalSources)
      .max(PROPOSAL_SOURCES_MAX, copy.errProposalSources),
    background: z.string().trim().max(PROPOSAL_BACKGROUND_MAX, copy.errProposalBackground),
    categoryId: z
      .string()
      .refine((value) => value === '' || CATEGORY_ID_PATTERN.test(value), copy.errProposalCategory),
  });
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

/**
 * The body for values `proposalFormSchema` accepted, with the account the screen shows
 * (`expectedAccountId`, as every owner write). A blank background and a blank category are none.
 * Nothing else is sent: the form has no probability (N02 §10), and the API drops a field it does
 * not know.
 */
export function toCreateProposalBody(
  values: ProposalFormValues,
  expectedAccountId: string,
): CreateProposalBody {
  return {
    question: values.question.trim(),
    deadline: values.deadline,
    yesCondition: values.yesCondition.trim(),
    expectedSources: values.expectedSources.trim(),
    background: orNull(values.background),
    categoryId: values.categoryId === '' ? null : Number(values.categoryId),
    expectedAccountId,
  };
}

/** The API's first issue, when the error carries one as an object. */
function firstIssue(error: unknown): { path?: unknown; message?: unknown } | undefined {
  if (!isApiError(error) || !Array.isArray(error.details)) return undefined;
  const first: unknown = error.details[0];
  return typeof first === 'object' && first !== null ? first : undefined;
}

/** The path the API's first issue names, joined (`market.categoryId`), when it names one. */
export function issuePath(error: unknown): string | undefined {
  const path = firstIssue(error)?.path;
  if (!Array.isArray(path) || path.length === 0) return undefined;
  return path.map(String).join('.');
}

/**
 * The API's first issue's own word for what is wrong with the field (`required`, `inactive`), when
 * it says one: what tells two refusals of one field apart.
 */
export function issueMessage(error: unknown): string | undefined {
  const message = firstIssue(error)?.message;
  return typeof message === 'string' ? message : undefined;
}

/** `retryAfterSeconds` of a RATE_LIMITED answer, when it carries one. */
function rateLimitWait(details: unknown): number | undefined {
  const parsed = z.object({ retryAfterSeconds: z.number().positive() }).safeParse(details);
  return parsed.success ? parsed.data.retryAfterSeconds : undefined;
}

/** `message` with the wait after it, as the 본인확인's limits say it ('… 3시간 뒤에 다시 시도해 주세요.'). */
function withWait(message: string, seconds: number): string {
  return `${message} ${formatWait(seconds)} ${copy.verificationRetryAfter}`;
}

const FORM_FIELD_MESSAGES: Partial<Record<keyof ProposalFormValues, string>> = {
  question: copy.errProposalQuestion,
  deadline: copy.errProposalDeadline,
  yesCondition: copy.errProposalYesCondition,
  expectedSources: copy.errProposalSources,
  background: copy.errProposalBackground,
  categoryId: copy.errProposalCategory,
};

/** What the form does with a refused `POST /me/proposals`. */
export type ProposalFailure =
  /**
   * Under the field the server named: a date that is past by its clock (the browser's clock ran
   * ahead or the page sat open over midnight), a category retired meanwhile, or a field the form
   * and the server disagree about after a deploy.
   */
  | { kind: 'field'; field: keyof ProposalFormValues; message: string }
  /**
   * The screen is out of date: the onboarding or the 본인확인 is not done any more (another tab, a
   * revision of the terms). `['me']` is asked again and the onboarding gate takes the page on.
   */
  | { kind: 'refresh'; message: string }
  /** The cookie is another account's: the session is asked again (SessionCacheGuard follows). */
  | { kind: 'session'; message: string }
  /**
   * A writing or an account restriction (RESTRICTED, #185·#139): said above the form with its end,
   * and the way to 조치·신고 내역 under it (`RefusalText`) — owner decision 2026-10-22 evening.
   */
  | { kind: 'restricted'; message: string }
  /** Anything else, said above the form: a limit (with when, for the daily one), the rest. */
  | { kind: 'notice'; message: string };

/**
 * A refusal of the form, read. The limits (PROPOSAL_LIMITED, ADR-0069 decision 4 #77 and decision
 * 7): the waiting one passes only once the operators decide or the member retracts, so it names no
 * time; the daily one names when the oldest of the day's proposals leaves the 24 hours, rounded up
 * as the server rounds it. A writing or an account restriction (RESTRICTED — ADR-0069 decision 4
 * #77 자격, #185 and #139) is said as every refused write says it (`restrictedMessage`): which
 * restriction keeps a proposal closed and until when, in the member's time zone (`formatDate`,
 * ADR-0063) — the later-ending one when both stand, as the server names it.
 */
export function proposalFailure(
  error: unknown,
  formatDate: (iso: string) => string,
): ProposalFailure {
  const restricted = restrictedMessage(error, 'proposal', formatDate);
  if (restricted !== undefined) return { kind: 'restricted', message: restricted };
  if (isForAnotherAccount(error)) return { kind: 'session', message: copy.sessionChanged };
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const field = issuePath(error) as keyof ProposalFormValues | undefined;
    const message = field === undefined ? undefined : FORM_FIELD_MESSAGES[field];
    if (field !== undefined && message !== undefined) return { kind: 'field', field, message };
    return { kind: 'notice', message: copy.errUnknown };
  }
  if (isApiError(error, 'PROPOSAL_LIMITED')) {
    const details = proposalLimitedDetailsSchema.safeParse(error.details);
    if (!details.success) return { kind: 'notice', message: copy.errUnknown };
    const { reason, retryAfterSeconds } = details.data;
    if (reason === 'pending') return { kind: 'notice', message: copy.errProposalPendingLimit };
    return {
      kind: 'notice',
      message:
        retryAfterSeconds === null
          ? copy.errProposalDailyLimit
          : withWait(copy.errProposalDailyLimit, retryAfterSeconds),
    };
  }
  if (isApiError(error, 'RATE_LIMITED')) {
    const wait = rateLimitWait(error.details);
    return {
      kind: 'notice',
      message:
        wait === undefined
          ? copy.errProposalTooManyRequests
          : withWait(copy.errProposalTooManyRequests, wait),
    };
  }
  if (isApiError(error, 'ONBOARDING_REQUIRED')) {
    return { kind: 'refresh', message: copy.errProposalOnboarding };
  }
  if (isApiError(error, 'VERIFICATION_REQUIRED')) {
    return { kind: 'refresh', message: copy.errProposalVerification };
  }
  return { kind: 'notice', message: copy.errUnknown };
}

/**
 * A refused 철회: the review started (or the proposal was decided) in the meantime — the list is
 * read again and the button goes with the status — the proposal is not this account's (any more),
 * the session changed, or anything else. The onboarding never refuses it: signed in is enough
 * (owner decision 2026-10-19, as for deleting one's own post), so there is no such line.
 */
export function retractFailureMessage(error: unknown): string {
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  if (isApiError(error, 'VALIDATION_ERROR') && issuePath(error) === 'status') {
    return copy.errProposalRetractStatus;
  }
  if (isApiError(error, 'NOT_FOUND')) return copy.errProposalNotFound;
  return copy.errUnknown;
}

// ---- the operators' forms -------------------------------------------------------------

/** The 반려 form: a reason from the owner's list, the explanation, and a duplicate's market. */
export interface RejectProposalFormValues {
  reason: ProposalRejectionReason | '';
  explanation: string;
  /** The picked market's id; '' while none is picked. Only a 중복 names one. */
  duplicateMarketId: string;
}

export const EMPTY_REJECT_FORM: RejectProposalFormValues = {
  reason: '',
  explanation: '',
  duplicateMarketId: '',
};

/**
 * `rejectProposalBodySchema` restated for its messages: a reason, an explanation of 1~1,000
 * characters, and for a 중복 the existing market (required; any other reason sends none).
 */
export const rejectProposalFormSchema = z
  .object({
    // '' is the select's placeholder: refused, so the submitted values always hold a reason.
    reason: z
      .union([z.enum(PROPOSAL_REJECTION_REASONS), z.literal('')], {
        error: copy.errProposalRejectReason,
      })
      .refine((value) => value !== '', copy.errProposalRejectReason),
    explanation: z
      .string()
      .trim()
      .min(1, copy.errProposalExplanation)
      .max(PROPOSAL_NOTE_MAX, copy.errProposalExplanation),
    duplicateMarketId: z.string(),
  })
  .superRefine((values, ctx) => {
    if (values.reason === 'duplicate' && values.duplicateMarketId === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['duplicateMarketId'],
        message: copy.errProposalDuplicateMarket,
      });
    }
  });

/** Only for values `rejectProposalFormSchema` accepted. */
export function toRejectProposalBody(values: RejectProposalFormValues): RejectProposalBody {
  const reason = values.reason as ProposalRejectionReason;
  return {
    reason,
    explanation: values.explanation.trim(),
    ...(reason === 'duplicate' ? { duplicateMarketId: values.duplicateMarketId } : {}),
  };
}

/** Where a 채택 leads (ADR-0069 decision 4 #77 채택과 시장): nowhere, a new draft, an existing market. */
export type AdoptMarketChoice = 'none' | 'draft' | 'existing';

/**
 * The market part of the 채택 form and of the later link's (owner decision 2026-10-19): where it
 * leads, and the draft's or the existing market's fields. The link offers the same two markets as
 * the 채택 — a draft made from the proposal or an existing market — but never none.
 */
export interface ProposalMarketFormValues {
  market: AdoptMarketChoice;
  /**
   * The draft's category as the `<select>` holds it; '' for the proposal's own when it may stand
   * in (`proposalCategoryFitsDraft`), else for none picked yet.
   */
  categoryId: string;
  /** The draft's close time, `datetime-local` in KST; '' for the default (`proposalDraftCloseAt`). */
  closeAt: string;
  /** The existing market's id; '' while none is picked. */
  marketId: string;
}

/** The 채택 form. */
export interface AdoptProposalFormValues extends ProposalMarketFormValues {
  /** The memo the proposer reads, optional. */
  memo: string;
}

export const EMPTY_ADOPT_FORM: AdoptProposalFormValues = {
  memo: '',
  market: 'none',
  categoryId: '',
  closeAt: '',
  marketId: '',
};

/**
 * The later link's form (owner decision 2026-10-19): the market part with the two choices that
 * link one — there is no 'none', which is not linking.
 */
export interface LinkProposalMarketFormValues extends Omit<ProposalMarketFormValues, 'market'> {
  market: 'draft' | 'existing';
}

/** An existing market first (the nearer to linking one); a draft made from the proposal is the other. */
export const EMPTY_LINK_FORM: LinkProposalMarketFormValues = {
  market: 'existing',
  categoryId: '',
  closeAt: '',
  marketId: '',
};

/**
 * Whether a draft may take the proposal's own category when the operator picks none: a leaf, or a
 * parent with no active leaves — where the market form would file a market (ADR-0041: markets sit
 * on leaves, and a parent that has leaves is not offered). A wished parent that has leaves is not:
 * the operator picks one (the server refuses that fallback too, as no category). Nor is a wish
 * retired since it was proposed (`isActive` false, owner decision 2026-10-19): the draft's
 * category is left blank for the operator, and the wish is named as retired
 * (`retiredWishLine`) — the server refuses that fallback too ('inactive'). `tree` is the active
 * categories (`groupCategories`); an active wish not in it — the list not loaded yet — is left to
 * the server, which answers a parent with leaves naming `market.categoryId` ('required').
 */
export function proposalCategoryFitsDraft(
  category: { slug: string; isActive: boolean } | null,
  tree: readonly CategoryNode[],
): boolean {
  if (category === null || !category.isActive) return false;
  const place = locateCategory(tree, category.slug);
  return place === undefined || place.leaf !== undefined || place.parent.children.length === 0;
}

/**
 * The line under the draft's category when the proposer's wish is retired (owner decision
 * 2026-10-19): what was wished for, said to be out of use, so the operator picks another.
 */
export function retiredWishLine(name: string): string {
  return `${copy.adminProposalDraftCategoryWishedBy}: ${name} ${copy.adminProposalDraftCategoryRetired}`;
}

/**
 * The line under the draft's category that names the proposer's wish. `kind` is the test id's
 * suffix (`…-category-retired`, `…-category-wish`).
 */
export interface DraftCategoryHint {
  kind: 'retired' | 'wish';
  text: string;
}

/** What the draft's category shows for the proposer's wish: the 채택's and the later link's alike. */
export interface DraftCategoryView {
  /** Whether the wish stands in when none is picked (`proposalCategoryFitsDraft`). */
  wishFits: boolean;
  /** The blank option's label: the wish where it stands in, else '카테고리 선택'. */
  blankLabel: string;
  /** The line under the list, or none. */
  hint: DraftCategoryHint | null;
}

/**
 * The draft's category for the proposer's wish (`category`) against the active categories
 * (`tree`). A wish that may stand in is the blank option, and nothing is said below. A wish
 * retired since it was proposed (owner decision 2026-10-19 13) leaves the blank option '카테고리
 * 선택' and is named below as retired (`retiredWishLine`) — whatever level it was. An active
 * wished parent that has leaves leaves the blank option '카테고리 선택' too and is named below
 * with the ask to pick a leaf (ADR-0041). No wish: '카테고리 선택' and nothing below.
 */
export function draftCategoryView(
  category: { slug: string; nameKo: string; isActive: boolean } | null,
  tree: readonly CategoryNode[],
): DraftCategoryView {
  const wishFits = proposalCategoryFitsDraft(category, tree);
  if (category === null) {
    return { wishFits, blankLabel: copy.adminMarketCategoryPlaceholder, hint: null };
  }
  if (!category.isActive) {
    return {
      wishFits,
      blankLabel: copy.adminMarketCategoryPlaceholder,
      hint: { kind: 'retired', text: retiredWishLine(category.nameKo) },
    };
  }
  if (wishFits) {
    return {
      wishFits,
      blankLabel: `${copy.adminProposalDraftCategoryFromProposal} (${category.nameKo})`,
      hint: null,
    };
  }
  return {
    wishFits,
    blankLabel: copy.adminMarketCategoryPlaceholder,
    hint: {
      kind: 'wish',
      text: `${copy.adminProposalDraftCategoryFromProposal}: ${category.nameKo}. ${copy.adminProposalDraftCategoryPickLeaf}`,
    },
  };
}

const marketFormFields = {
  categoryId: z.string(),
  closeAt: z.string(),
  marketId: z.string(),
};

/**
 * The market part's checks, the 채택's and the link's alike. A draft needs a category: the one
 * picked, else the proposal's when it may stand in (`proposalCategoryFits`) — the server refuses a
 * draft with neither. A close time typed must be in the future (`now`); a blank one is the server's
 * default, which it checks itself (a default already past is refused naming `market.closeAt`,
 * `adminProposalFailure`). Linking needs a picked market.
 */
function checkMarketChoice(
  values: ProposalMarketFormValues | LinkProposalMarketFormValues,
  ctx: z.RefinementCtx,
  proposalCategoryFits: boolean,
  now: () => number,
) {
  if (values.market === 'draft') {
    const picked = CATEGORY_ID_PATTERN.test(values.categoryId);
    if (!picked && !(values.categoryId === '' && proposalCategoryFits)) {
      ctx.addIssue({
        code: 'custom',
        path: ['categoryId'],
        message: copy.errProposalDraftCategory,
      });
    }
    if (values.closeAt !== '') {
      const iso = kstLocalToIso(values.closeAt);
      if (iso === null || new Date(iso).getTime() <= now()) {
        ctx.addIssue({
          code: 'custom',
          path: ['closeAt'],
          message: copy.errProposalDraftCloseAt,
        });
      }
    }
  }
  if (values.market === 'existing' && values.marketId === '') {
    ctx.addIssue({
      code: 'custom',
      path: ['marketId'],
      message: copy.errProposalExistingMarket,
    });
  }
}

/** The 채택 form's schema: the memo, and the market part (`checkMarketChoice`). */
export function adoptProposalFormSchema(
  proposalCategoryFits: boolean,
  now: () => number = Date.now,
) {
  return z
    .object({
      memo: z.string().trim().max(PROPOSAL_NOTE_MAX, copy.errProposalMemo),
      market: z.enum(['none', 'draft', 'existing']),
      ...marketFormFields,
    })
    .superRefine((values, ctx) => checkMarketChoice(values, ctx, proposalCategoryFits, now));
}

/**
 * The later link's schema (owner decision 2026-10-19): a draft or an existing market — never
 * none — with the 채택's checks.
 */
export function linkProposalMarketFormSchema(
  proposalCategoryFits: boolean,
  now: () => number = Date.now,
) {
  return z
    .object({ market: z.enum(['draft', 'existing']), ...marketFormFields })
    .superRefine((values, ctx) => checkMarketChoice(values, ctx, proposalCategoryFits, now));
}

/** A draft or an existing market as the API takes it (`ProposalAdoptionMarket`). */
function toProposalAdoptionMarket(
  values: LinkProposalMarketFormValues,
): LinkProposalMarketBody['market'] {
  if (values.market === 'existing') return { type: 'existing', marketId: values.marketId };
  const closeAt = values.closeAt === '' ? null : kstLocalToIso(values.closeAt);
  return {
    type: 'draft',
    ...(values.categoryId === '' ? {} : { categoryId: Number(values.categoryId) }),
    ...(closeAt === null ? {} : { closeAt }),
  };
}

/** Only for values `adoptProposalFormSchema` accepted. A blank memo is none. */
export function toAdoptProposalBody(values: AdoptProposalFormValues): AdoptProposalBody {
  const { market } = values;
  return {
    memo: orNull(values.memo),
    market: market === 'none' ? null : toProposalAdoptionMarket({ ...values, market }),
  };
}

/** Only for values `linkProposalMarketFormSchema` accepted. */
export function toLinkProposalMarketBody(
  values: LinkProposalMarketFormValues,
): LinkProposalMarketBody {
  return { market: toProposalAdoptionMarket(values) };
}

/** The internal memo's form (never shown to the proposer). */
export const internalMemoFormSchema = z.object({
  memo: z.string().trim().max(PROPOSAL_NOTE_MAX, copy.errProposalMemo),
});
export type InternalMemoFormValues = z.input<typeof internalMemoFormSchema>;

/** The fields of the operators' forms a refusal can land on. */
export type AdminProposalField = 'categoryId' | 'closeAt' | 'marketId' | 'duplicateMarketId';

/** What an operator's screen does with a refused review, 채택, 반려, link or memo. */
export interface AdminProposalFailure {
  message: string;
  /** The form field the refusal is about, when it is one. */
  field?: AdminProposalField;
  /**
   * The proposal moved under the screen (another operator decided it, or the proposer retracted
   * it): the detail is read again, and the buttons follow its status.
   */
  refresh: boolean;
}

/**
 * A refusal of an operator's write, read: a status that moved (VALIDATION_ERROR naming `status`),
 * a market linked meanwhile (naming `market`: another operator linked one first — the link is once,
 * owner decision 2026-10-19), the draft's category (none to stand in — `required` — or retired,
 * `inactive` — or unknown, a 404) or close time (past), a market that is not there (a 404 naming
 * the field that carried it), and the proposal itself gone (404).
 */
export function adminProposalFailure(error: unknown): AdminProposalFailure {
  const path = issuePath(error);
  if (isApiError(error, 'VALIDATION_ERROR')) {
    if (path === 'status') return { message: copy.errProposalStatus, refresh: true };
    if (path === 'market') return { message: copy.errProposalMarketAlreadyLinked, refresh: true };
    if (path === 'market.categoryId') {
      // A retired category — the proposal's own, or the one picked, retired meanwhile — is not
      // a missing one: the proposal may well name a category.
      const message =
        issueMessage(error) === 'inactive'
          ? copy.errProposalDraftCategoryInactive
          : copy.errProposalDraftCategory;
      return { message, field: 'categoryId', refresh: false };
    }
    if (path === 'market.closeAt') {
      return { message: copy.errProposalDraftCloseAt, field: 'closeAt', refresh: false };
    }
    if (path === 'duplicateMarketId') {
      return {
        message: copy.errProposalDuplicateMarket,
        field: 'duplicateMarketId',
        refresh: false,
      };
    }
    if (path === 'memo') return { message: copy.errProposalMemo, refresh: false };
    if (path === 'explanation') return { message: copy.errProposalExplanation, refresh: false };
    return { message: copy.errUnknown, refresh: false };
  }
  if (isApiError(error, 'NOT_FOUND')) {
    if (path === 'market.marketId') {
      return { message: copy.errProposalMarketNotFound, field: 'marketId', refresh: false };
    }
    if (path === 'duplicateMarketId') {
      return {
        message: copy.errProposalMarketNotFound,
        field: 'duplicateMarketId',
        refresh: false,
      };
    }
    if (path === 'market.categoryId') {
      return { message: copy.errProposalCategoryNotFound, field: 'categoryId', refresh: false };
    }
    return { message: copy.errProposalNotFound, refresh: true };
  }
  return { message: copy.errUnknown, refresh: false };
}
