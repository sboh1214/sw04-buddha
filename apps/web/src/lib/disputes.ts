import {
  DISPUTE_LINKS_MAX,
  DISPUTE_REASON_MAX,
  type DisputeEligibility,
  type DisputeNotAllowedReason,
  MARKET_DISPUTE_REFUSALS,
  type MarketDisputeStatus,
  disputeNotAllowedDetailsSchema,
  duplicateLinkIndexes,
  evidenceLinkSchema,
} from '@buddha/shared';
import type { Route } from 'next';
import { copy } from '@/copy';
import {
  type Market,
  type MyDispute,
  type MyMarketDispute,
  type SubmitDisputeBody,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  validationField,
  validationMessage,
  validationPath,
} from './api';
import { loginPathBackTo } from './next-path';

/**
 * 판정 이의 (#175, ADR-0104; ADR-0093 decision 1 #173 items 1·2·5–8·11–13·15, decision 3 '#175 토론의
 * 이의 안내') as the member's screens read it: the public detail's 이의 기한 row and its link, the
 * discussion's and the write screen's note while the deadline is ahead, the submission screen
 * (`/markets/[slug]/dispute`) and MY '판정 이의' (`/my/disputes`). Not 제재 이의 — a sanction appeal
 * goes by email (ADR-0084), and member copy says '판정 이의' wherever the two could be confused.
 *
 * The RULES are @buddha/shared's — the links (`evidenceLinkSchema`, `duplicateLinkIndexes`), the
 * reason's length, the refusals — the very ones the API applies, so the form neither takes what
 * the server refuses on those grounds nor refuses what it takes; only the messages are localised
 * here. Who may dispute (a fill on the market, #173 item 6), the deadline and the one per version
 * are the server's, read for the screen (`GET /me/disputes/markets/:id`) and asked again at the
 * submission. The admin's decisions are lib/admin-disputes.ts' (admin-only); the statuses' words
 * are this module's, which the operators' screens read too.
 *
 * Pure functions, kept out of the components so vitest can run them under its node environment.
 */

/** MY '판정 이의': a MY sub-page, linked from MY 설정 and the dispute screen — not a ninth tab. */
export const MY_DISPUTES_PATH = '/my/disputes' satisfies Route;

/** The submission screen of a market, by its address (`/markets/[slug]/dispute`). */
export function disputePath(slug: string): string {
  return `/markets/${slug}/dispute`;
}

/**
 * Where the submission screen sends a visitor with no session: the login screen, told to come back
 * to that screen (`loginPathBackTo`, which keeps the path on this origin).
 */
export function disputeLoginPath(slug: string): string {
  return loginPathBackTo(disputePath(slug));
}

/**
 * The query keys. `['disputes']` is a private root (`PRIVATE_QUERY_ROOTS`, market-keys.ts): the
 * member's own disputes and standing, read with the member's cookie, never fetched on the server
 * or dehydrated — the links and the reason are the submitter's and the operators' alone (#173 item
 * 13, PRIVATE_DATA `dispute`). The operators' reads are under `['admin']`.
 *
 * Both entries end with the account the screen shows — the `Me` it was drawn from — as ADR-0091's
 * (`watchStateKey`): the answers name no owner, and a submission, a 철회 or the list's 철회 acts on
 * what was drawn from them, naming that account. `['me']` can turn from A to B in place before
 * the session does, with no reset of SessionCacheGuard's (ADR-0090 결정 4-2): one entry for both
 * would draw A's links and reason under B's name. The guard resets them with the rest all the same.
 * `accountId` is undefined while that account is not known: the query is disabled then.
 */
export const DISPUTES_KEY = ['disputes'] as const;
/** Every account's MY list: what an invalidation names. */
export const MY_DISPUTES_KEY = [...DISPUTES_KEY, 'mine'] as const;
export const myDisputesKey = (accountId: string | undefined) =>
  [...MY_DISPUTES_KEY, accountId] as const;
export const MY_MARKET_DISPUTE_KEY = [...DISPUTES_KEY, 'market'] as const;
/** Every account's standing on one market, on the canonical lower-cased uuid (A-M3-29). */
export const myMarketDisputesKey = (marketId: string) =>
  [...MY_MARKET_DISPUTE_KEY, marketId.toLowerCase()] as const;
export const myMarketDisputeKey = (marketId: string, accountId: string | undefined) =>
  [...myMarketDisputesKey(marketId), accountId] as const;

// ---- statuses -------------------------------------------------------------------------

/**
 * A dispute's status in the member's and the operators' words: 검토 중 · 기각 · 수용 · 철회 ·
 * 정정으로 종결 (#176, ADR-0105; #173 item 8 — a pending dispute of a version a correction replaced).
 */
export const DISPUTE_STATUS_LABEL: Record<MarketDisputeStatus, string> = {
  pending: copy.disputeStatusPending,
  dismissed: copy.disputeStatusDismissed,
  accepted: copy.disputeStatusAccepted,
  retracted: copy.disputeStatusRetracted,
  closed_by_correction: copy.disputeStatusClosedByCorrection,
};

/**
 * Colour only reinforces the label (PLAN 11.2): orange under review — the market waits for it — and
 * for 수용, which holds it too until its correction; `no` for 기각, and gray once retracted or closed
 * by a correction (no decision either way, #176), as a proposal's 철회. MY reads it through
 * `myDisputePalette`, which turns a 수용 a correction already answered gray; the operators' record
 * keeps the status's colour.
 */
export const DISPUTE_STATUS_PALETTE: Record<MarketDisputeStatus, 'gray' | 'orange' | 'no'> = {
  pending: 'orange',
  dismissed: 'no',
  accepted: 'orange',
  retracted: 'gray',
  closed_by_correction: 'gray',
};

// ---- the deadline ---------------------------------------------------------------------

/** The longest a one-shot wait for the deadline holds at once — a day; it then waits again. */
const DISPUTE_DEADLINE_WAIT_MAX_MS = 24 * 60 * 60 * 1_000;

/**
 * How long from `now` until the 이의 기한 has come (`deadline`, `now < deadline` takes disputes —
 * `isDisputeOpen`, the submission's own rule), at most a day; `null` once it has come or for an
 * unreadable deadline. A held market publishes nothing at its deadline (the worker skips it), so
 * the detail's link and the discussion's note go by a one-shot timer of this length
 * (`useDisputeOpen`), never by a clock read in render.
 */
export function disputeDeadlineWait(deadline: string, now: number): number | null {
  const at = Date.parse(deadline);
  if (Number.isNaN(at) || at <= now) return null;
  return Math.min(at - now, DISPUTE_DEADLINE_WAIT_MAX_MS);
}

/**
 * The deadline a screen waits for: the market's 이의 기한 while the API says disputes are taken
 * (`disputeOpen`, the server's clock at the read), else null — nothing to wait for, and the link
 * is not drawn.
 */
export function openDisputeDeadline(
  market: Pick<Market, 'disputeOpen' | 'disputeDeadline'>,
): string | null {
  return market.disputeOpen ? market.disputeDeadline : null;
}

// ---- the submission screen ------------------------------------------------------------

/**
 * Why a submission is refused or not offered, in the member's words (DISPUTE_NOT_ALLOWED's
 * `details.reason` and `MyMarketDispute.eligibility` alike, one sentence each): the market shows
 * no provisional result, the judgement on screen was replaced (a correction, #176), the 이의 기한 has
 * come, the
 * account is an admin's (#173 item 15), it has no fill on the market (#173 item 6), it disputed
 * this version already (a retracted one counts); a retraction's — decided, retracted; and a
 * decision's registrant, which no member meets.
 */
export const DISPUTE_REFUSAL_TEXT: Readonly<Record<DisputeNotAllowedReason, string>> = {
  not_provisional: copy.disputeRefusalNotProvisional,
  stale_version: copy.disputeRefusalStaleVersion,
  deadline_passed: copy.disputeRefusalDeadlinePassed,
  admin: copy.disputeRefusalAdmin,
  no_fill: copy.disputeRefusalNoFill,
  duplicate: copy.disputeRefusalDuplicate,
  decided: copy.disputeRefusalDecided,
  retracted: copy.disputeRefusalRetracted,
  registrant: copy.errUnknown,
  own: copy.errUnknown,
};

/**
 * What the submission screen shows under the market (`/markets/[slug]/dispute`):
 * - `pending`: the standing is still being read (the session, `GET /me`, the standing) — or read
 *   again: the live row is a 잠정 결과 the `provisional` event moved it to, its REST read (with the
 *   version and the deadline) not in yet, or the standing was read for another version than the
 *   row's (before the judgement, or before a correction replaced it, #176; the screen reads it
 *   again, and it says nothing of this version meanwhile — the form is offered again on the new
 *   version, the member's dispute of the old one being MY's alone);
 * - `failed`: the standing's read failed — 다시 시도;
 * - `closed`: no form, one sentence why (`DISPUTE_REFUSAL_TEXT`) — the market no longer shows a
 *   provisional result or the deadline came on the live row (its status and the screen's timer
 *   come first: the standing read before them is out of date), else the standing's refusal;
 * - `form`: the form, submitting the version the standing was read for.
 * The member's own dispute of the version is drawn beside whichever it is
 * (`MyMarketDispute.dispute`).
 */
export type DisputeScreenView =
  | { kind: 'pending' }
  | { kind: 'failed' }
  | { kind: 'closed'; reason: Exclude<DisputeEligibility, 'eligible'> }
  | { kind: 'form'; judgementVersion: number };

export function disputeScreenView(input: {
  /** The live market's status (`useMarket`). */
  status: Market['status'];
  /** The live market's judgement version: null on a row an event moved before its REST read. */
  judgementVersion: number | null;
  /** Whether disputes are taken now: the API's `disputeOpen` and the screen's timer. */
  open: boolean;
  standing: MyMarketDispute | undefined;
  failed: boolean;
}): DisputeScreenView {
  if (input.status !== 'provisional') return { kind: 'closed', reason: 'not_provisional' };
  if (input.judgementVersion === null) return { kind: 'pending' };
  if (!input.open) return { kind: 'closed', reason: 'deadline_passed' };
  if (input.standing === undefined || input.standing.judgementVersion !== input.judgementVersion) {
    return input.failed ? { kind: 'failed' } : { kind: 'pending' };
  }
  const { eligibility, judgementVersion } = input.standing;
  if (eligibility !== 'eligible') return { kind: 'closed', reason: eligibility };
  // `eligible` is read for a version; none would be a market with no judgement, not eligible.
  if (judgementVersion === null) return { kind: 'closed', reason: 'not_provisional' };
  return { kind: 'form', judgementVersion };
}

/** The form as typed: one input per link, in order (at least one), and the reason. */
export interface DisputeFormValues {
  links: readonly string[];
  reason: string;
}

export const EMPTY_DISPUTE_FORM: DisputeFormValues = { links: [''], reason: '' };

/** What each field says is wrong with it, or null; `links` one per input. */
export interface DisputeFormErrors {
  links: (string | null)[];
  reason: string | null;
}

/**
 * The form read against the submission's body (`submitDisputeBodySchema`, which the API checks
 * again): each link trimmed, http(s), at most DISPUTE_LINK_MAX characters (`evidenceLinkSchema`),
 * none twice (`duplicateLinkIndexes`), 1..DISPUTE_LINKS_MAX of them; the reason trimmed,
 * 1..DISPUTE_REASON_MAX. `body` is what is sent, with the version and the account, once `ready`.
 */
export function disputeDraft(values: DisputeFormValues): {
  ready: boolean;
  links: string[];
  reason: string;
  errors: DisputeFormErrors;
} {
  const links = values.links.map((link) => link.trim());
  const repeated = new Set(duplicateLinkIndexes(links));
  const counted = links.length >= 1 && links.length <= DISPUTE_LINKS_MAX;
  const linkErrors = links.map((link, index) => {
    if (!counted) return copy.errDisputeLinks;
    if (!evidenceLinkSchema.safeParse(link).success) return copy.errDisputeLink;
    return repeated.has(index) ? copy.errDisputeLinkDuplicate : null;
  });
  const reason = values.reason.trim();
  const reasonError =
    reason.length >= 1 && reason.length <= DISPUTE_REASON_MAX ? null : copy.errDisputeReason;
  return {
    ready: counted && linkErrors.every((error) => error === null) && reasonError === null,
    links,
    reason,
    errors: { links: linkErrors, reason: reasonError },
  };
}

/** The body for a ready draft: the version the screen showed and the account on screen. */
export function toSubmitDisputeBody(
  draft: { links: string[]; reason: string },
  judgementVersion: number,
  expectedAccountId: string,
): SubmitDisputeBody {
  return { judgementVersion, links: draft.links, reason: draft.reason, expectedAccountId };
}

/** DISPUTE_NOT_ALLOWED's reason, or undefined for an answer that does not carry one. */
export function disputeRefusalOf(error: unknown): DisputeNotAllowedReason | undefined {
  if (!isApiError(error, 'DISPUTE_NOT_ALLOWED')) return undefined;
  const details = disputeNotAllowedDetailsSchema.safeParse(error.details);
  return details.success ? details.data.reason : undefined;
}

/**
 * Where a refused submission is said:
 * - `field`: under the input it is about — a link (`index`: not http(s), too long, given twice; or,
 *   without one, their count) or the reason (VALIDATION_ERROR);
 * - `refusal`: above the form — DISPUTE_NOT_ALLOWED by its reason (`DISPUTE_REFUSAL_TEXT`) and the
 *   market gone (NOT_FOUND); `refresh` when the screen is out of date: the standing is read again
 *   and the screen follows it (a version replaced, the deadline come, a dispute sent in another
 *   tab);
 * - `onboarding`: the onboarding is not done any more (ONBOARDING_REQUIRED, #57 item 8):
 *   `['me']` is asked again and the onboarding gate takes the page on;
 * - `session`: the cookie is another account's (ADR-0092): the session is asked again;
 * - `notice`: a session ended, a request that never reached the API, anything else.
 * No restriction refuses it (#173 item 6, ADR-0069 #45-12): there is no RESTRICTED line.
 */
export type DisputeSubmitFailure =
  | { kind: 'field'; field: 'links'; index?: number; message: string }
  | { kind: 'field'; field: 'reason'; message: string }
  | { kind: 'refusal'; message: string; refresh: boolean }
  | { kind: 'onboarding'; message: string }
  | { kind: 'session'; message: string }
  | { kind: 'notice'; message: string };

export function disputeSubmitFailure(error: unknown): DisputeSubmitFailure {
  if (isForAnotherAccount(error)) return { kind: 'session', message: copy.sessionChanged };
  const refused = disputeRefusalOf(error);
  if (refused !== undefined) {
    return { kind: 'refusal', message: DISPUTE_REFUSAL_TEXT[refused], refresh: true };
  }
  if (isApiError(error, 'DISPUTE_NOT_ALLOWED')) {
    return { kind: 'refusal', message: copy.errUnknown, refresh: true };
  }
  if (isApiError(error, 'ONBOARDING_REQUIRED')) {
    return { kind: 'onboarding', message: copy.errDisputeOnboarding };
  }
  if (isApiError(error, 'NOT_FOUND')) {
    return { kind: 'refusal', message: copy.errDisputeMarketGone, refresh: true };
  }
  if (isApiError(error, 'UNAUTHENTICATED')) {
    return { kind: 'notice', message: copy.errUnauthenticated };
  }
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const path = validationPath(error) ?? [];
    switch (validationField(error)) {
      case 'links': {
        const index = path[1];
        if (typeof index !== 'number') {
          return { kind: 'field', field: 'links', message: copy.errDisputeLinks };
        }
        const duplicate = validationMessage(error) === MARKET_DISPUTE_REFUSALS.links.duplicateLink;
        return {
          kind: 'field',
          field: 'links',
          index,
          message: duplicate ? copy.errDisputeLinkDuplicate : copy.errDisputeLink,
        };
      }
      case 'reason':
        return { kind: 'field', field: 'reason', message: copy.errDisputeReason };
      case 'judgementVersion':
        return { kind: 'refusal', message: copy.disputeRefusalStaleVersion, refresh: true };
      default:
        return { kind: 'notice', message: copy.errUnknown };
    }
  }
  return { kind: 'notice', message: isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown };
}

/**
 * A refused 철회, as the toast says it: the dispute was decided or retracted meanwhile, or its
 * deadline came (DISPUTE_NOT_ALLOWED — the list or the screen is read again and the button goes),
 * it is not this account's (NOT_FOUND), the session changed, or anything else. The onboarding never
 * refuses it: signed in is enough (as a proposal's 철회, ADR-0089).
 */
export function disputeRetractFailureMessage(error: unknown): string {
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  const refused = disputeRefusalOf(error);
  if (refused === 'deadline_passed') return copy.errDisputeRetractDeadline;
  if (refused !== undefined) return DISPUTE_REFUSAL_TEXT[refused];
  if (isApiError(error, 'NOT_FOUND')) return copy.errDisputeNotFound;
  if (isApiError(error, 'UNAUTHENTICATED')) return copy.errUnauthenticated;
  return isApiUnreachable(error) ? copy.errNetwork : copy.errUnknown;
}

// ---- a dispute as read ----------------------------------------------------------------

/**
 * The instant a dispute took its status, and what that instant is called: 낸 시각 while pending
 * (a dispute a rejected or retracted correction sent back to 검토 중 included: its decision was
 * cleared, #176), the 기각's or 수용's (`decidedAt`), the 철회's (`retractedAt`), the 정정으로 종결's
 * (`closedAt`, the correction's approval).
 */
export function disputeStatusTime(
  dispute: Pick<MyDispute, 'status' | 'submittedAt' | 'decidedAt' | 'retractedAt' | 'closedAt'>,
): { label: string; at: string } {
  if (dispute.status === 'retracted' && dispute.retractedAt !== null) {
    return { label: copy.disputeRetractedAt, at: dispute.retractedAt };
  }
  if (dispute.status === 'closed_by_correction' && dispute.closedAt !== null) {
    return { label: copy.disputeClosedAt, at: dispute.closedAt };
  }
  if (dispute.decidedAt !== null) return { label: copy.disputeDecidedAt, at: dispute.decidedAt };
  return { label: copy.disputeSubmittedAt, at: dispute.submittedAt };
}

/**
 * What MY adds under one of the member's disputes (#175, #176, ADR-0105): for one the market's
 * judgement has moved past — `market.judgementVersion` above the dispute's — that the judgement
 * was corrected: an accepted one was answered by it, and one closed by it (정정으로 종결) may be
 * submitted again on the corrected judgement within its deadline (#173 item 8); for an accepted
 * one of the current version, that a correction follows (#173 item 7). `null` for the rest.
 */
export function disputeNote(
  dispute: Pick<MyDispute, 'status' | 'judgementVersion'> & {
    market: Pick<MyDispute['market'], 'judgementVersion'>;
  },
): { kind: 'accepted' | 'corrected' | 'closed'; text: string } | null {
  if (dispute.status === 'closed_by_correction') {
    return { kind: 'closed', text: copy.disputeClosedByCorrectionNote };
  }
  if (dispute.status !== 'accepted') return null;
  return dispute.judgementVersion < dispute.market.judgementVersion
    ? { kind: 'corrected', text: copy.disputeAcceptedCorrectedNote }
    : { kind: 'accepted', text: copy.disputeAcceptedNote };
}

/**
 * The colour of one of the member's disputes in MY and on the submission screen: its status's
 * (DISPUTE_STATUS_PALETTE), but gray for a 수용 a correction already answered — the market's
 * judgement moved past its version (`disputeNote`'s 'corrected', #176): it holds the market no
 * more and waits for nothing, so it no longer reads orange.
 */
export function myDisputePalette(
  dispute: Pick<MyDispute, 'status' | 'judgementVersion'> & {
    market: Pick<MyDispute['market'], 'judgementVersion'>;
  },
): 'gray' | 'orange' | 'no' {
  return disputeNote(dispute)?.kind === 'corrected'
    ? 'gray'
    : DISPUTE_STATUS_PALETTE[dispute.status];
}
