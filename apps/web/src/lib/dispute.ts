import { DISPUTE_REASON_MAX, type MarketStatus, createDisputeBodySchema } from '@buddha/shared';
import * as z from 'zod';
import { copy } from '@/copy';
import { type CreateDisputeBody, type Dispute, isApiError, validationField } from './api';
import { sessionListSection } from './query-client';

/**
 * Every decision behind 이의 제기 on the market detail (PLAN 11.3, 5.5; M5 design 5.3), as pure
 * functions: which of the section's states to draw, what the form accepts, and which words a
 * refusal becomes. `components/market/dispute-section.tsx` renders what these answer and decides
 * nothing itself, because apps/web runs vitest under `environment: 'node'` — a decision left in
 * a component is a decision no unit test can reach (the rule `use-trade.ts` states).
 */

// ---- the form -----------------------------------------------------------------------

/**
 * The dialog's two fields, as typed. The reason restates the API's bounds with the API's own
 * constant so only the message is localised (the `nickname-form.tsx` precedent); the URL is
 * NOT restated — `createDisputeBodySchema`'s own `evidenceUrl` rule is asked, because stating
 * a URL rule twice is how a form comes to accept what the server refuses with nothing but a
 * generic toast (the `optionalCouponCode` precedent in form-schema.ts). Blank means "none":
 * the field is optional, and `toCreateDisputeBody` sends it as null.
 */
export const disputeFormSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, copy.errDisputeReason)
    .max(DISPUTE_REASON_MAX, copy.errDisputeReason),
  evidenceUrl: z
    .string()
    .trim()
    .refine(
      (url) => url === '' || createDisputeBodySchema.shape.evidenceUrl.safeParse(url).success,
      copy.errDisputeEvidence,
    ),
});
export type DisputeFormValues = z.infer<typeof disputeFormSchema>;

export const EMPTY_DISPUTE_FORM: DisputeFormValues = { reason: '', evidenceUrl: '' };

/** Only for values `disputeFormSchema` accepted: the reason is non-blank and the URL is valid. */
export function toCreateDisputeBody(values: DisputeFormValues): CreateDisputeBody {
  const evidenceUrl = values.evidenceUrl.trim();
  return { reason: values.reason.trim(), evidenceUrl: evidenceUrl === '' ? null : evidenceUrl };
}

// ---- the section --------------------------------------------------------------------

/**
 * What the section draws. `hidden` is a real answer, not an absence: the section is on every
 * detail screen and renders nothing for most of a market's life.
 *
 * - `signedOut` — 로그인하면 이의를 제기할 수 있습니다 with a link back to this market.
 * - `pending` — the session or the account's row is still unknown; a skeleton.
 * - `failed` — the row's first fetch failed; an error and 다시 시도.
 * - `filed` — the account's own dispute, with its review once there is one. `stale` says the
 *   last refresh failed and the row shown is the previous answer.
 * - `windowClosed` — 이의 기간이 끝났습니다: nothing to press.
 * - `notResolving` — 지금은 이의를 제기할 수 없습니다: the market says `resolving` but carries
 *   no deadline to file against, which no transition path writes (test factories can).
 * - `canFile` — the 이의 제기 button.
 */
export type DisputeSectionView =
  | { kind: 'hidden' }
  | { kind: 'signedOut' }
  | { kind: 'pending' }
  | { kind: 'failed' }
  | { kind: 'filed'; dispute: Dispute; stale: boolean }
  | { kind: 'windowClosed' }
  | { kind: 'notResolving' }
  | { kind: 'canFile'; disputeUntil: string };

export interface DisputeSectionInput {
  market: { status: MarketStatus; disputeUntil: string | null };
  /**
   * The instant the window is measured against — the detail's own server anchor (the ticks
   * window end, `detailWindowEnd`), never `Date.now()`: a clock read in a render is a different
   * string on the server and in the browser's first paint, and `disputeUntil` is the DATABASE's
   * clock, so the browser's would compare two machines (the trade panel says the same of its
   * 마감 gate). `undefined` when the ticks read failed; then the server has the last word.
   */
  now: number | undefined;
  /** `useMyDispute`'s flags — the session gate rides in `isLoggedIn`/`isPending`. */
  query: {
    isLoggedIn: boolean;
    isPending: boolean;
    isLoadingError: boolean;
    isRefetchError: boolean;
  };
  /** The account's row, `null` for none, `undefined` while unknown. */
  dispute: Dispute | null | undefined;
  /**
   * The file mutation's last refusal, if any. A DISPUTE_WINDOW_CLOSED from the server closes the
   * section on the spot: the anchor above is the page LOAD's instant and does not tick, so a
   * reader who opened the page before the deadline and pressed after it would otherwise be
   * offered the button again under the very toast that said the window is over.
   */
  refusal?: unknown;
}

/**
 * Whether a market's detail has any use for the account's dispute row: while a result is
 * proposed, and after the market finished (to keep showing a filed one). The section's
 * `hidden` answer AND the gate on `useMyDispute` — one predicate, so the row is never asked
 * for on a market where the card could not draw it: an open market's detail is the most
 * visited screen in the app, and a private `GET /me/disputes` per signed-in visit of it would
 * be a request whose answer nothing reads.
 */
export function disputeSectionWanted(status: MarketStatus): boolean {
  return status === 'resolving' || status === 'settled' || status === 'voided';
}

/**
 * The 이의 마감 instant the PUBLIC detail may still show — `null` once it has stopped being a
 * deadline. Its two readers are outside this card: the status notice's 이의 마감 row
 * (markets/[slug]/market-detail.tsx) and 정산 기준's 정산 예정 row (live-rules-section.tsx).
 *
 * `dispute_until` SURVIVES the settle, on purpose: the worker's UPDATE writes status, settled_at
 * and status_event_id and nothing else, because a settle CONSUMES the proposal — the row keeps
 * 결과 and 결과 확정 시각, so it keeps the window that closed beside them. The void is the
 * opposite and clears all three, echoing them into its payload as `discardedResult` /
 * `discardedDisputeUntil` (A-M3-23). The `finalized` payload carries no deadline, so the column
 * is the only record of when the window actually shut, and the ADMIN detail draws it beside
 * 정산 시각 as exactly that audit row.
 *
 * None of which is the public screen's business. PLAN 11.3 assigns the row by STATUS, not by
 * nullness — "`resolving`이면 결과·이의 마감시각·이의 제기 버튼. `settled`면 결과·내 손익" — and drawn
 * on a settled market the same instant is labelled 정산 예정 two cards above a notice saying the
 * payout already landed, which is the schedule PLAN 17 Q8 declined to promise at all. So the
 * gate lives here and the column stays.
 *
 * `closeAt` is the display twin and the precedent: it outlives its own deadline too, and the
 * countdown is drawn for `open` alone because a settled market has nothing to count down to.
 * `canChangeResult` (market-admin.ts) and `disputeSectionView` below already read this column
 * behind this same status question before they ever parse the instant.
 */
export function disputeDeadlineShown(market: {
  status: MarketStatus;
  disputeUntil: string | null;
}): string | null {
  return market.status === 'resolving' ? market.disputeUntil : null;
}

/**
 * Which state the section is in.
 *
 * The section exists for a `resolving` market, and for a FINISHED one (settled, voided) only
 * to keep showing a dispute the account filed — the review's outcome is worth reading after
 * the market has moved on (design 5.3). So a finished market answers `filed` or `hidden` and
 * nothing in between: no sign-in prompt for a market nobody can dispute any more, and no
 * skeleton that would collapse for the many visitors who filed nothing.
 *
 * The ladder is `sessionListSection`'s (query-client.ts) — signed out before pending before
 * failed, with `stale` riding above a row rather than replacing it — because this card reads a
 * session-gated query exactly as 내 포지션 does, and two ladders for one kind of query would be
 * one flag away from disagreeing on the same screen.
 *
 * Only the `empty` rung — signed in, answered, no row — asks about the window, and it asks the
 * server's refusal first: the anchor is the load instant, and a refusal is newer than it.
 */
export function disputeSectionView(a: DisputeSectionInput): DisputeSectionView {
  const resolving = a.market.status === 'resolving';
  if (!disputeSectionWanted(a.market.status)) return { kind: 'hidden' };
  const section = sessionListSection(a.query, a.dispute ? 1 : 0);
  if (section.body === 'rows' && a.dispute) {
    return { kind: 'filed', dispute: a.dispute, stale: section.stale };
  }
  if (!resolving) return { kind: 'hidden' };
  if (section.body === 'signedOut') return { kind: 'signedOut' };
  if (section.body === 'pending') return { kind: 'pending' };
  if (section.body === 'failed') return { kind: 'failed' };
  if (isApiError(a.refusal, 'DISPUTE_WINDOW_CLOSED')) return { kind: 'windowClosed' };
  if (a.market.disputeUntil === null) return { kind: 'notResolving' };
  if (a.now !== undefined && Date.parse(a.market.disputeUntil) <= a.now) {
    return { kind: 'windowClosed' };
  }
  return { kind: 'canFile', disputeUntil: a.market.disputeUntil };
}

// ---- refusals -----------------------------------------------------------------------

/** The two fields a VALIDATION_ERROR may name; anything else is a toast. */
export type DisputeFormField = 'reason' | 'evidenceUrl';

/**
 * A refusal that belongs UNDER a field: the server's VALIDATION_ERROR naming `reason` or
 * `evidenceUrl`, shown as that field's own error rather than as a toast that would scroll the
 * field off a 375px screen (the `marketFormError` precedent). The messages are the form's own,
 * so the server and the resolver cannot say two different things about one field.
 */
export function disputeFieldError(
  error: unknown,
): { field: DisputeFormField; message: string } | undefined {
  if (!isApiError(error, 'VALIDATION_ERROR')) return undefined;
  const field = validationField(error);
  if (field === 'reason') return { field, message: copy.errDisputeReason };
  if (field === 'evidenceUrl') return { field, message: copy.errDisputeEvidence };
  return undefined;
}

/**
 * Every other refusal as one Korean sentence (PLAN 7.4's codes): the window (`resolving` but
 * past `disputeUntil`, or settled/voided — the server answers one code for both), the UNIQUE
 * `(market, user)` row, a market that is not resolving at all (VALIDATION_ERROR naming
 * `status`), a session that ended under the dialog, a market gone from the public routes.
 * `disputeFieldError` is asked first by the caller, so a field-naming VALIDATION_ERROR never
 * reaches the generic line.
 */
export function disputeErrorMessage(error: unknown): string {
  if (isApiError(error, 'DISPUTE_WINDOW_CLOSED')) return copy.disputeWindowClosed;
  if (isApiError(error, 'DUPLICATE_REQUEST')) return copy.disputeAlreadyFiled;
  if (isApiError(error, 'VALIDATION_ERROR') && validationField(error) === 'status') {
    return copy.disputeNotResolving;
  }
  if (isApiError(error, 'UNAUTHENTICATED')) return copy.disputeLoginToFile;
  if (isApiError(error, 'NOT_FOUND')) return copy.errTradeNotFound;
  return copy.errUnknown;
}

/**
 * Whether a refusal ends the dialog. It does when the SECTION now says what the toast said —
 * the window closed, a row already filed, a market no longer resolving, a session that ended,
 * a market that vanished: `applyDisputeError` corrected the cache (or `disputeSectionView`
 * reads the refusal itself), so the state behind the dialog has already changed and a form
 * left open would be a form for a request that can never succeed. A field error or a 5xx
 * keeps it open, because the typed reason is the very thing the reader is about to fix or
 * resend, and a dialog that closed on a blip would lose it.
 */
export function disputeRefusalEndsDialog(error: unknown): boolean {
  return (
    isApiError(error, 'DISPUTE_WINDOW_CLOSED') ||
    isApiError(error, 'DUPLICATE_REQUEST') ||
    (isApiError(error, 'VALIDATION_ERROR') && validationField(error) === 'status') ||
    isApiError(error, 'UNAUTHENTICATED') ||
    isApiError(error, 'NOT_FOUND')
  );
}
