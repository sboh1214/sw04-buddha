import {
  formatCoin,
  parseCoinAmount,
  regrantNotAllowedDetailsSchema,
  type RegrantRefusal,
} from '@buddha/shared';
import { copy } from '@/copy';
import {
  type ApplyRegrantResult,
  isApiError,
  isApiUnreachable,
  isForAnotherAccount,
  type Regrant,
  type RegrantStatus,
} from './api';
import { type Refusal, refusalOf, restrictionOf, restrictionTermText } from './restriction';

/**
 * 재지급 (#74, ADR-0155; N01 §2, N04 §5; owner answers 2026-11-21): the wallet's card, always on
 * MY 지갑 (answer 10). A member whose 가용 코인 ran down to the threshold applies, and the API gives
 * the release setting's amount at once in that request when every condition holds (answer 3) —
 * nothing waits, a refused request is applied for again once its reasons are gone (answer 2).
 * While any of the six release settings is undecided the card says '준비 중' (answer 12); open, it
 * lists the amount, the threshold, the period's re-grants left and the lifetime cap left, and when
 * a request now would be refused, every reason with its numbers and the absolute times in the
 * member's zone (answer 9). Not linked from the order screen's shortfall (answer 11). Pure
 * functions of the API's answers, kept out of `app/` so vitest runs them under its node
 * environment.
 */

/**
 * `GET /me/regrant`'s root: under the private `me` root (`PRIVATE_QUERY_ROOTS`) — the member's own
 * status, read with their cookie, never on the server and never dehydrated.
 */
export const REGRANT_STATUS_KEY = ['me', 'regrant'] as const;

/**
 * The status of the account the wallet was drawn for — its `Me`'s id (ADR-0091, as
 * `accountClosureKey`): the answer names no owner, and the card's 재지급 신청 names that account
 * (`expectedAccountId`). An entry read for another account — `['me']` turned from A to B in place
 * (ADR-0090 결정 4-2) — is never drawn as B's.
 */
export const regrantStatusKey = (accountId: string) => [...REGRANT_STATUS_KEY, accountId] as const;

/**
 * The one intent the card's request id is filed under (`IdempotencyKeys`' `regrant-key`
 * namespace, per account): a click whose answer never came sends the same id again, and the API
 * answers the re-grant it gave (`replayed`) rather than a second one (N01 §9).
 */
export const REGRANT_INTENT = 'regrant';

const coin = (amount: string): string => formatCoin(parseCoinAmount(amount));

/** Whether 재지급 신청 is on: every setting decided and nothing refuses it now. */
export function canApplyRegrant(status: Pick<RegrantStatus, 'open' | 'eligible'>): boolean {
  return status.open && status.eligible;
}

/** '최근 30일 3회 중 2회': the period's re-grants left of its limit (never below 0). */
export function regrantPeriodText(days: number, limit: number, used: number): string {
  const left = Math.max(0, limit - used);
  return (
    `${copy.regrantPeriodRecent} ${String(days)}${copy.regrantDayUnit} ` +
    `${String(limit)}${copy.regrantTimesOf} ${String(left)}${copy.regrantTimesUnit}`
  );
}

/** One line of the card's facts. */
export interface RegrantFact {
  readonly testId: string;
  readonly label: string;
  readonly value: string;
}

/**
 * What the card lists while open, in its order: 1회 지급액, 신청 기준 ('가용 코인 990,000 Coin
 * 이하'), 남은 횟수 ('최근 30일 3회 중 2회') and 남은 누적 한도 ('450,000 Coin (누적 상한 500,000
 * Coin)'). Nothing while not open — the numbers are unknown then (every one null).
 */
export function regrantFacts(status: RegrantStatus): readonly RegrantFact[] {
  const {
    amountCoin,
    thresholdCoin,
    periodDays,
    periodLimit,
    periodUsed,
    totalCapCoin,
    remainingCapCoin,
  } = status;
  if (
    !status.open ||
    amountCoin === null ||
    thresholdCoin === null ||
    periodDays === null ||
    periodLimit === null ||
    periodUsed === null ||
    totalCapCoin === null ||
    remainingCapCoin === null
  ) {
    return [];
  }
  return [
    { testId: 'regrant-amount', label: copy.regrantAmount, value: coin(amountCoin) },
    {
      testId: 'regrant-threshold',
      label: copy.regrantThreshold,
      value: `${copy.walletBalance} ${coin(thresholdCoin)} ${copy.regrantAtOrBelow}`,
    },
    {
      testId: 'regrant-period',
      label: copy.regrantPeriod,
      value: regrantPeriodText(periodDays, periodLimit, periodUsed),
    },
    {
      testId: 'regrant-remaining-cap',
      label: copy.regrantRemainingCap,
      value: `${coin(remainingCapCoin)} (${copy.regrantTotalCap} ${coin(totalCapCoin)})`,
    },
  ];
}

/**
 * The 대기기간 as the card says it under the facts, or null when there is none (0 hours) or the
 * settings are not all decided.
 */
export function regrantWaitText(status: Pick<RegrantStatus, 'open' | 'waitHours'>): string | null {
  if (!status.open || status.waitHours === null || status.waitHours === 0) return null;
  const hours = status.waitHours.toLocaleString('ko-KR');
  return `${copy.regrantWaitLead} ${hours}${copy.regrantWaitTail}`;
}

/**
 * The account restriction's sentence with its end, the form of every restricted refusal
 * (lib/restriction.ts, `RefusalText`: the sentence says the end; owner decision 2026-10-22):
 * '…(2026. 12. 1. 오전 9:00까지).' or '…(무기한).' — `endsAt` null for 무기한. Undefined when the
 * end is not known (the restriction not read, or read as none while the status still names one):
 * the sentence alone then.
 */
function restrictedText(
  endsAt: string | null | undefined,
  formatDate: (iso: string) => string,
): string {
  const term = endsAt === undefined ? '' : `(${restrictionTermText(endsAt, formatDate)})`;
  return `${copy.regrantRefusalRestricted}${term}.`;
}

/**
 * One refusal's sentence (owner answer 9: the reason and the numbers): the threshold, when the
 * wait ends, the period's limit and when its oldest re-grant frees one, the cap left against the
 * amount, the account restriction's end — the times absolute, in the member's zone (`formatDate`,
 * `useFormatDateTime`). A number the reason needs is never null while the status is open
 * (`GET /me/regrant` and REGRANT_NOT_ALLOWED's details); should one be, the sentence goes without
 * it. The status carries no restriction end: `restrictionEndsAt` is the account restriction MY
 * reads (`GET /me/moderation/restriction`'s `accountRestriction`, the rule `assertCanTrade` and
 * the status's `restricted` both ask — `useAccountBlock`), undefined while it is not known.
 */
export function regrantRefusalText(
  reason: RegrantRefusal,
  status: RegrantStatus,
  formatDate: (iso: string) => string,
  restrictionEndsAt?: string | null,
): string {
  switch (reason) {
    case 'not_ready':
      return copy.regrantNotReady;
    case 'restricted':
      return restrictedText(restrictionEndsAt, formatDate);
    case 'held':
      return copy.regrantRefusalHeld;
    case 'no_start_grant':
      return copy.regrantRefusalNoStartGrant;
    case 'not_exhausted':
      return status.thresholdCoin === null
        ? copy.regrantBlocked
        : `${copy.regrantRefusalNotExhaustedLead} ${coin(status.thresholdCoin)} ` +
            copy.regrantRefusalNotExhaustedTail;
    case 'live_orders':
      return copy.regrantRefusalLiveOrders;
    case 'unsettled_positions':
      return copy.regrantRefusalUnsettled;
    case 'waiting':
      return status.waitUntil === null
        ? copy.regrantRefusalWaiting
        : `${copy.regrantRefusalWaiting} ${formatDate(status.waitUntil)}${copy.regrantFrom}`;
    case 'period_limit': {
      if (status.periodDays === null || status.periodLimit === null) return copy.regrantBlocked;
      const used =
        `${copy.regrantPeriodRecent} ${String(status.periodDays)}${copy.regrantDayUnit} ` +
        `${copy.regrantRefusalPeriodLimitMiddle} ${String(status.periodLimit)}` +
        `${copy.regrantTimesUnit}${copy.regrantRefusalPeriodLimitTail}`;
      return status.nextPeriodAt === null
        ? used
        : `${used} ${formatDate(status.nextPeriodAt)}${copy.regrantAgainFrom}`;
    }
    case 'total_cap':
      return status.remainingCapCoin === null || status.amountCoin === null
        ? copy.regrantBlocked
        : `${copy.regrantRemainingCap} ${coin(status.remainingCapCoin)}` +
            `${copy.regrantRefusalTotalCapMiddle} ${coin(status.amountCoin)}` +
            copy.regrantRefusalTotalCapTail;
  }
}

/** A refusal as the card lists it: the reason, its sentence, and whether a restriction gave it. */
export interface RegrantRefusalLine extends Refusal {
  readonly reason: RegrantRefusal;
}

/**
 * What keeps a re-grant from being given now, in the order the server asks them — every one, not
 * only the first (owner answer 9). The account restriction's line says its end when it is known
 * (`restrictionEndsAt`, `regrantRefusalText`) and has the way to 조치·신고 내역 under it
 * (`restricted`). Nothing while the settings are not all decided: the card says '준비 중' alone
 * then (owner answer 12), whatever else the server listed.
 */
export function regrantRefusals(
  status: RegrantStatus,
  formatDate: (iso: string) => string,
  restrictionEndsAt?: string | null,
): readonly RegrantRefusalLine[] {
  if (!status.open) return [];
  return status.refusals.map((reason) => ({
    reason,
    message: regrantRefusalText(reason, status, formatDate, restrictionEndsAt),
    restricted: reason === 'restricted',
  }));
}

/**
 * How long after the instant the card waits for the status reads it again: the API judges the
 * wait and the period on the database's clock, which the browser's may run a little ahead of — a
 * second's slack makes the read land after it, as the order book's read at a close
 * (`BOOK_CLOSE_REREAD_SLACK_MS`).
 */
export const REGRANT_REREAD_SLACK_MS = 1_000;

/**
 * The instant the card reads the status again (`useInstantReached`): the earliest of when the
 * 대기기간 ends (`waitUntil`, set only while `waiting`) and when the period frees one
 * (`nextPeriodAt`, only while `period_limit`), plus the slack — nothing is published then, so the
 * button would otherwise stay off and '…부터 받을 수 있습니다' stay up after it came. Null while
 * neither is set, the settings are not all decided, or the status is not read yet. Another reading
 * with another instant is waited for afresh.
 */
export function regrantRereadAt(
  status: Pick<RegrantStatus, 'open' | 'waitUntil' | 'nextPeriodAt'> | undefined,
): string | null {
  if (status === undefined || !status.open) return null;
  const instants = [status.waitUntil, status.nextPeriodAt]
    .filter((at): at is string => at !== null)
    .map((at) => Date.parse(at))
    .filter((at) => !Number.isNaN(at));
  if (instants.length === 0) return null;
  return new Date(Math.min(...instants) + REGRANT_REREAD_SLACK_MS).toISOString();
}

/** The line after a grant (role="status"): '재지급 50,000 Coin을 받았습니다.' */
export function regrantGrantedText(regrant: Pick<Regrant, 'amountCoin'>): string {
  return `${copy.regrantGrantedLead} ${coin(regrant.amountCoin)}${copy.regrantGrantedTail}`;
}

/**
 * The line after a request the API answered with the re-grant its id had already given
 * (`replayed`, N01 §9): '재지급 50,000 Coin은 2026. 11. 21. 오후 12:00에 이미 받았습니다. 이번 신청으로
 * 더 받은 Coin은 없습니다.' — the time it was given, in the member's zone. True both when the id
 * was sent again at once after a lost answer and when it was kept (sessionStorage) until a press
 * days later: either way nothing new was given by this press, which the fresh line would claim.
 */
export function regrantReplayedText(
  regrant: Pick<Regrant, 'amountCoin' | 'createdAt'>,
  formatDate: (iso: string) => string,
): string {
  return (
    `${copy.regrantGrantedLead} ${coin(regrant.amountCoin)}${copy.regrantReplayedMiddle} ` +
    `${formatDate(regrant.createdAt)}${copy.regrantReplayedTail}`
  );
}

/** What a press the API granted says: the fresh line, or the replay's (`regrantReplayedText`). */
export function regrantResultText(
  result: ApplyRegrantResult,
  formatDate: (iso: string) => string,
): string {
  return result.replayed
    ? regrantReplayedText(result.regrant, formatDate)
    : regrantGrantedText(result.regrant);
}

/**
 * What a press refused with REGRANT_NOT_ALLOWED and its details says in the announced line under
 * the button: '지금은 재지급을 받을 수 없습니다.' and every reason's sentence from the details, in
 * the server's order — the reasons a screen reader would not otherwise hear, the list above being
 * redrawn without an announcement (the closure's refusal says its reason likewise,
 * `closureFailure`). '준비 중' alone when the details say a setting is undecided.
 */
export function regrantRefusedText(
  status: RegrantStatus,
  formatDate: (iso: string) => string,
): string {
  if (!status.open) return copy.regrantNotReady;
  const reasons = regrantRefusals(status, formatDate).map((line) => line.message);
  return [copy.regrantBlocked, ...reasons].join(' ');
}

/**
 * REGRANT_NOT_ALLOWED's details — the status the refusing request read under its locks, every
 * reason and the numbers — or undefined for any other answer (and for details that do not read,
 * never from this API).
 */
export function regrantDetailsOf(error: unknown): RegrantStatus | undefined {
  if (!isApiError(error, 'REGRANT_NOT_ALLOWED')) return undefined;
  const details = regrantNotAllowedDetailsSchema.safeParse(error.details);
  return details.success ? details.data : undefined;
}

/**
 * What a refused 재지급 신청 says under the button (role="alert"):
 * - REGRANT_NOT_ALLOWED with its details: every reason from them (`regrantRefusedText`) — the
 *   hook also puts the details in the status's place, and the card lists every reason from them
 *   (owner answer 9), but that redraw is not announced. Drawn only while the status is that
 *   reading or a newer one saying the same (`regrantFailureShown`);
 * - RESTRICTED: the account restriction and until when ('…(2026. 12. 1. 오전 9:00까지).', the
 *   form of every restricted refusal, lib/restriction.ts), with the way to 조치·신고 내역;
 * - the cookie of another account (the card's account and the session differ): the shared
 *   sentence — nothing was given, and the hook asks for the session again;
 * - ONBOARDING_REQUIRED: a step left (a revision asked for the consent again);
 * - UNAUTHENTICATED: the session is gone;
 * - a request that never reached the API, and anything else (the request id is kept for those
 *   that may have acted — no answer, a 5xx — so the next click is answered for this one).
 */
export function regrantFailure(error: unknown, formatDate: (iso: string) => string): Refusal {
  const details = regrantDetailsOf(error);
  if (details !== undefined) return refusalOf(error, regrantRefusedText(details, formatDate));
  if (isApiError(error, 'REGRANT_NOT_ALLOWED')) return refusalOf(error, copy.regrantBlocked);
  const restriction = restrictionOf(error);
  if (restriction !== undefined) {
    return refusalOf(error, restrictedText(restriction.endsAt, formatDate));
  }
  if (isForAnotherAccount(error)) return refusalOf(error, copy.sessionChanged);
  if (isApiError(error, 'ONBOARDING_REQUIRED')) return refusalOf(error, copy.errPostOnboarding);
  if (isApiError(error, 'UNAUTHENTICATED')) return refusalOf(error, copy.errUnauthenticated);
  if (isApiUnreachable(error)) return refusalOf(error, copy.errNetwork);
  return refusalOf(error, copy.errUnknown);
}

/**
 * A refused 재지급 신청 as the card keeps it under the button: its line (`regrantFailure`) and, for
 * REGRANT_NOT_ALLOWED with its details, the status reading those details became (`readingAt`: the
 * status's `dataUpdatedAt` once the hook wrote them in its place) — null for any other refusal.
 */
export interface RegrantPressFailure {
  readonly refusal: Refusal;
  readonly readingAt: number | null;
}

/**
 * What a refused press keeps. `statusReadAt` is the status's `dataUpdatedAt` read after the hook's
 * `onError` (`regrantStatusReadAt`): the press's promise is rejected only once that has put
 * REGRANT_NOT_ALLOWED's details in the status's place, so it is their reading.
 */
export function regrantPressFailure(
  error: unknown,
  formatDate: (iso: string) => string,
  statusReadAt: number | undefined,
): RegrantPressFailure {
  const fromDetails = regrantDetailsOf(error) !== undefined && statusReadAt !== undefined;
  return {
    refusal: regrantFailure(error, formatDate),
    readingAt: fromDetails ? statusReadAt : null,
  };
}

/**
 * The refusal the card draws under the button now, or null. REGRANT_NOT_ALLOWED's says why from
 * the status its details became (`readingAt`); once the status has a newer reading
 * (`statusUpdatedAt` past it: the balance moved, the wait or the period's slot ran out, a focus)
 * it stays only while that reading still refuses with the very same sentence
 * (`regrantRefusedText`) — the reasons and the button follow the newer reading, and the line
 * would otherwise say the re-grant can't be had, or why, against them. The same sentence keeps
 * it: the refusal's own read of `['me']` usually moves the balance the card had, which reads the
 * status again at once, and the announcement would go as soon as it came. Any other refusal stays
 * until the next press.
 */
export function regrantFailureShown(
  failure: RegrantPressFailure | null,
  status: RegrantStatus,
  statusUpdatedAt: number,
  formatDate: (iso: string) => string,
): Refusal | null {
  if (failure === null) return null;
  const { refusal, readingAt } = failure;
  if (readingAt === null || statusUpdatedAt <= readingAt) return refusal;
  const saysTheSame =
    !canApplyRegrant(status) && regrantRefusedText(status, formatDate) === refusal.message;
  return saysTheSame ? refusal : null;
}

/**
 * What the panel keeps of a refused press at this reading: the press while its line stands
 * (`regrantFailureShown`), null once a newer reading has withdrawn REGRANT_NOT_ALLOWED's line. The
 * panel drops it then, so the line stays withdrawn: a later reading that says the same sentence
 * again would otherwise bring it back, announced, with no press behind it.
 */
export function regrantFailureKept(
  failure: RegrantPressFailure | null,
  status: RegrantStatus,
  statusUpdatedAt: number,
  formatDate: (iso: string) => string,
): RegrantPressFailure | null {
  if (failure === null) return null;
  return regrantFailureShown(failure, status, statusUpdatedAt, formatDate) === null
    ? null
    : failure;
}
