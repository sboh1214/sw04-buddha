import {
  ACCOUNT_CLOSURE_CONFIRMATION,
  accountClosureNotAllowedDetailsSchema,
  formatCoin,
  parseCoinAmount,
  type AccountClosureRefusal,
} from '@buddha/shared';
import { copy } from '@/copy';
import { isApiError, isApiUnreachable, isForAnotherAccount, type AccountClosureCheck } from './api';
import { type Refusal, refusalOf, restrictedMessage, restrictionSentence } from './restriction';

/**
 * 탈퇴 (#140, ADR-0086; ADR-0069 decision 1 #57-15…#57-18, decision 3 #37-15…#37-17, decision 4
 * #140 rows): the member closes their own account from MY 설정 — at once, on one confirmation
 * screen that says the Coin left is forfeited and that it cannot be undone, the member typing
 * '탈퇴' (decision 4 #140 «마지막 확인»). Pure functions of the API's answers, kept out of `app/` so
 * vitest runs them under its node environment.
 */

/**
 * The confirmation screen: under MY 설정, which it is opened from (the brief's «MY 설정 탈퇴»), so
 * the 설정 tab stays the current one (`isMyTabCurrent` covers a tab's subtree). No cash-out word
 * in it (#113): 탈퇴 closes an account, it never takes Coin out. The onboarding gate leaves it to
 * an account that has not finished its onboarding, a re-consent left included
 * (`ONBOARDING_EXEMPT_PATHS`, owner decision 2026-10-23 (2차) 3), and every onboarding screen links
 * to it at its very bottom (`ONBOARDING_CLOSURE_LINK`, (4차) 1).
 */
export const MY_CLOSURE_PATH = '/my/settings/closure';

/**
 * `GET /me/closure`, the screen's read of what a closure would do now. Under the private `me`
 * root (`PRIVATE_QUERY_ROOTS`): the member's balance and refusals, read with their cookie, never
 * on the server and never dehydrated — like `['me', 'accounts']`.
 */
export const ACCOUNT_CLOSURE_KEY = ['me', 'closure'] as const;

/**
 * Whether the typed text confirms: exactly '탈퇴', blanks around it aside — the rule the API's body
 * holds it to (`accountClosureBodySchema`), so the button is enabled for what the server takes.
 */
export function isClosureConfirmed(typed: string): boolean {
  return typed.trim() === ACCOUNT_CLOSURE_CONFIRMATION;
}

/**
 * Each refusal's sentence (CLOSURE_NOT_ALLOWED and the check's `refusals`): what keeps the closure
 * from going ahead now and when it can — the admin role until it is revoked (#57-17), contracts
 * until all are settled (#57-16), a payment or a refund until it ends (ADR-0069 decision 7), and
 * waiting orders (their cancellation before a closure is #178's).
 */
export const CLOSURE_REFUSAL_TEXT: Readonly<Record<AccountClosureRefusal, string>> = {
  admin: copy.closureRefusalAdmin,
  unsettled_contracts: copy.closureRefusalUnsettled,
  payment_in_progress: copy.closureRefusalPayment,
  pending_orders: copy.closureRefusalPendingOrders,
};

/**
 * What keeps the closure from going ahead now, as the screen lists it before anything is typed:
 * the check's refusals in the order the closure asks them, then the restriction it would be
 * refused for (decision 4 #140 «제재 중 탈퇴» — the later-ending one of the two, its end in the
 * member's zone, and the way to 조치·신고 내역 under it). Empty when nothing does.
 */
export function closureBlockers(
  check: AccountClosureCheck,
  formatDate: (iso: string) => string,
): Refusal[] {
  const refusals = check.refusals.map((reason) => ({
    message: CLOSURE_REFUSAL_TEXT[reason],
    restricted: false,
  }));
  if (check.restriction === null) return refusals;
  return [
    ...refusals,
    { message: restrictionSentence(check.restriction, 'closure', formatDate), restricted: true },
  ];
}

/** One line of what the closure deletes and keeps, under the Coin on the confirmation screen. */
export interface ClosureLine {
  readonly testId: string;
  readonly text: string;
}

/**
 * What the confirmation says the closure deletes and keeps, in its order (owner decision 2026-10-23
 * (3차) 7, ADR-0086): what goes at once (#57-18) and, right under it, that the 본인확인 record —
 * number and real name — is kept for the retention period and then deleted (ADR-0070 2차 답 1, the
 * exception to «곧바로»); what stays — posts, comments and likes, bylined '탈퇴한 사용자' (#37-16,
 * #37-17); and, only for an account whose start Coin was paid (`startGrantReceived`, owner
 * decision 2026-10-23 (3차) 9), that the same number gets no start Coin again on a new sign-up
 * (#57-1). A grant still waiting is cancelled by the closure and its number may receive the start
 * Coin with the next account (owner decision 2026-10-18 on #70), so that account is told nothing,
 * and no other limit counted by number is mentioned.
 */
export function closureLines(
  check: Pick<AccountClosureCheck, 'startGrantReceived'>,
): readonly ClosureLine[] {
  return [
    { testId: 'closure-deleted', text: copy.closureDeleted },
    { testId: 'closure-phone-records', text: copy.closurePhoneRecords },
    { testId: 'closure-kept', text: copy.closureKept },
    ...(check.startGrantReceived
      ? [{ testId: 'closure-start-grant', text: copy.closureStartGrant }]
      : []),
  ];
}

/**
 * The Coin the closure forfeits, as the screen writes it ('12,000 Coin'): the available balance
 * now — reserved Coin cannot exist without a waiting order, which refuses the closure.
 */
export function closureCoinText(check: Pick<AccountClosureCheck, 'availableCoin'>): string {
  return formatCoin(parseCoinAmount(check.availableCoin));
}

/**
 * What a refused closure says (`POST /me/closure`), and whether a restriction gave it — then the
 * way to 조치·신고 내역 goes under it (`RefusalText`):
 * - RESTRICTED: which restriction and until when (decision 4 #140, `restrictedMessage`);
 * - CLOSURE_NOT_ALLOWED: its reason's sentence (the screen's check is out of date — the hook reads
 *   it again);
 * - the cookie of another account (the screen's account and the session differ): the shared
 *   sentence, and the hook asks for the session again;
 * - UNAUTHENTICATED: the session is gone — signed out elsewhere, or the account closed already (a
 *   closure ends every session, so a request sent again after an answer that never arrived meets
 *   this);
 * - the confirmation the server did not take (never while the button follows
 *   `isClosureConfirmed`), a request that never reached the API, and anything else.
 */
export function closureFailure(error: unknown, formatDate: (iso: string) => string): Refusal {
  const restricted = restrictedMessage(error, 'closure', formatDate);
  if (restricted !== undefined) return refusalOf(error, restricted);
  if (isApiError(error, 'CLOSURE_NOT_ALLOWED')) {
    const details = accountClosureNotAllowedDetailsSchema.safeParse(error.details);
    return refusalOf(
      error,
      details.success ? CLOSURE_REFUSAL_TEXT[details.data.reason] : copy.closureBlocked,
    );
  }
  if (isForAnotherAccount(error)) return refusalOf(error, copy.sessionChanged);
  if (isApiError(error, 'UNAUTHENTICATED')) return refusalOf(error, copy.errClosureSignedOut);
  if (isApiError(error, 'VALIDATION_ERROR')) return refusalOf(error, copy.errClosureConfirmation);
  if (isApiUnreachable(error)) return refusalOf(error, copy.errNetwork);
  return refusalOf(error, copy.errUnknown);
}

/**
 * The account's nickname where an operator's screen names it: '탈퇴한 사용자' once its member
 * closed it — the nickname went with the closure (#37-16), and the operators' records of the
 * account stay (#57-18), so the account still appears there, named as every public byline names
 * it.
 */
export function nicknameShown(nickname: string | null): string {
  return nickname ?? copy.postAuthorFormer;
}

/** What `afterClosureInOrder` runs, in its order. */
export interface AfterClosureSteps {
  /**
   * better-auth's sign-out: the closure already ended every session on the server, so this only
   * clears the session cookie and tells the other tabs (better-auth's broadcast). `{ error }` on a
   * failure, which changes nothing: the session is gone either way.
   */
  readonly signOut: () => Promise<{ error?: unknown }>;
  /** Empties the tab's caches and leaves for home, saying the closure was done. */
  readonly onClosed: () => void;
}

/**
 * After a closure: the cookie cleared first, so nothing that follows sends a session the server
 * deleted, then home — whatever the sign-out answered (`signOutInOrder` stays signed in on a
 * failure; here there is no session to stay in). Plain, so the unit tests drive it under
 * `environment: 'node'`.
 */
export async function afterClosureInOrder(steps: AfterClosureSteps): Promise<void> {
  try {
    await steps.signOut();
  } catch {
    // Not the closure's to hear: the account is closed and its sessions are gone.
  }
  steps.onClosed();
}
