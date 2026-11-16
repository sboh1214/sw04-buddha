import {
  type OrderCancelReason,
  type OrderRejectReason,
  type OrderStatus,
  formatCoin,
} from '@buddha/shared';
import { copy } from '@/copy';
import { formatContracts } from './market-admin';
import type { OrderBlockReason, OrderFailure } from './order-panel';

/**
 * 주문 패널's words for what the server decided (#66, ADR-0140; ADR-0135 결정 4 '주문 상태와 사유의
 * 이름', E3): the six states, the eleven reasons an order row is 거절 with, the seven it is 취소
 * 완료 with, the refusals that write no row, and the lines that keep 주문 확인 off. Each reason has
 * its case and none falls through: a new one fails to compile here.
 */

/** 대기·부분 체결·전량 체결·취소 완료·만료·거절 — the keys MY reads too, so both say the same. */
export function orderStatusLabel(status: OrderStatus): string {
  switch (status) {
    case 'open':
      return copy.orderStatusOpen;
    case 'partially_filled':
      return copy.orderStatusPartiallyFilled;
    case 'filled':
      return copy.orderStatusFilled;
    case 'cancelled':
      return copy.orderStatusCancelled;
    case 'expired':
      return copy.orderStatusExpired;
    case 'rejected':
      return copy.orderStatusRejected;
  }
}

/**
 * A 거절 row's sentence: its reason's name, then what it means. The six of #66's acceptance —
 * 잔액 부족, 보유량 부족, 마감, 호가 부족, 가격 한도, 일시 중단 — are six different sentences, and
 * 계정 확인 중·관리자 권한 are E3's names. 잔액 부족 and 보유량 부족 add their figures when the
 * panel has them (`insufficientCoinLine`, `insufficientContractsLine`).
 */
export function rejectReasonText(reason: OrderRejectReason): string {
  switch (reason) {
    case 'insufficient_coin':
      return copy.orderRejectInsufficientCoin;
    case 'insufficient_contracts':
      return copy.orderRejectInsufficientContracts;
    case 'not_open_yet':
      return copy.orderRejectNotOpenYet;
    case 'closed':
      return copy.orderRejectClosed;
    case 'paused':
      return copy.orderRejectPaused;
    case 'no_quote':
      return copy.orderRejectNoQuote;
    case 'price_limit':
      return copy.orderRejectPriceLimit;
    case 'budget_too_small':
      return copy.orderRejectBudgetTooSmall;
    case 'self_trade':
      return copy.orderRejectSelfTrade;
    case 'ledger_hold':
      return copy.orderRejectLedgerHold;
    case 'admin_role_revoked':
      return copy.orderRejectAdminRoleRevoked;
  }
}

/**
 * A 취소 완료 row's name, and for the two an order's intake writes — 즉시 거래 잔량 and 자기 체결 —
 * the sentence the result card says. The rest are #123's to say on its list.
 */
export function cancelReasonText(reason: OrderCancelReason): string {
  switch (reason) {
    case 'by_owner':
      return copy.orderCancelByOwner;
    case 'ioc_remainder':
      return copy.orderCancelIocRemainder;
    case 'self_trade':
      return copy.orderCancelSelfTrade;
    case 'paused':
      return copy.orderCancelPaused;
    case 'admin_role':
      return copy.orderCancelAdminRole;
    case 'restricted':
      return copy.orderCancelRestricted;
    case 'account_closed':
      return copy.orderCancelAccountClosed;
  }
}

/**
 * A 거절 row's reason by its short name (#123, ADR-0141; 결정 4, E3 '계정 확인 중'·'관리자 권한'):
 * MY's lists, the state history and the end's notice. Its own copy key, never the sentence cut at
 * its dash — the sentence is `rejectReasonText`'s, for the order's detail and the panel.
 */
export function rejectReasonName(reason: OrderRejectReason): string {
  switch (reason) {
    case 'insufficient_coin':
      return copy.orderRejectNameInsufficientCoin;
    case 'insufficient_contracts':
      return copy.orderRejectNameInsufficientContracts;
    case 'not_open_yet':
      return copy.orderRejectNameNotOpenYet;
    case 'closed':
      return copy.orderRejectNameClosed;
    case 'paused':
      return copy.orderRejectNamePaused;
    case 'no_quote':
      return copy.orderRejectNameNoQuote;
    case 'price_limit':
      return copy.orderRejectNamePriceLimit;
    case 'budget_too_small':
      return copy.orderRejectNameBudgetTooSmall;
    case 'self_trade':
      return copy.orderRejectNameSelfTrade;
    case 'ledger_hold':
      return copy.orderRejectNameLedgerHold;
    case 'admin_role_revoked':
      return copy.orderRejectNameAdminRoleRevoked;
  }
}

/**
 * A 취소 완료 row's reason by its short name (#123, ADR-0141; 결정 4). '탈퇴' has its case though no
 * member screen meets it: the closure ends the sign-in in the same transaction
 * (account-closure.service.ts), so nothing hides it.
 */
export function cancelReasonName(reason: OrderCancelReason): string {
  switch (reason) {
    case 'by_owner':
      return copy.orderCancelNameByOwner;
    case 'ioc_remainder':
      return copy.orderCancelNameIocRemainder;
    case 'self_trade':
      return copy.orderCancelNameSelfTrade;
    case 'paused':
      return copy.orderCancelNamePaused;
    case 'admin_role':
      return copy.orderCancelNameAdminRole;
    case 'restricted':
      return copy.orderCancelNameRestricted;
    case 'account_closed':
      return copy.orderCancelNameAccountClosed;
  }
}

/** An ended order's reason by its short name, or null (전량 체결 and 만료 carry none). */
export function orderReasonName(order: {
  rejectReason: OrderRejectReason | null;
  cancelReason: OrderCancelReason | null;
}): string | null {
  if (order.rejectReason !== null) return rejectReasonName(order.rejectReason);
  if (order.cancelReason !== null) return cancelReasonName(order.cancelReason);
  return null;
}

/**
 * The line 만료 shows on an order's detail (#123, ADR-0141): a 만료 has no reason of its own, and
 * every one comes of a market whose trading ended (#120, ADR-0115) — the market link says which.
 */
export function expiredReasonText(): string {
  return copy.orderExpiredReason;
}

/**
 * The reason line of an order's detail (#123, ADR-0141): a 거절's whole sentence; a 취소 완료's
 * short name, but the two an intake writes — 즉시 거래 잔량 and 자기 체결 — as their sentence (the
 * result card's); 만료's line; none for the rest.
 */
export function detailReasonText(order: {
  status: OrderStatus;
  rejectReason: OrderRejectReason | null;
  cancelReason: OrderCancelReason | null;
}): string | null {
  if (order.rejectReason !== null) return rejectReasonText(order.rejectReason);
  if (order.cancelReason === 'ioc_remainder' || order.cancelReason === 'self_trade') {
    return cancelReasonText(order.cancelReason);
  }
  if (order.cancelReason !== null) return cancelReasonName(order.cancelReason);
  return order.status === 'expired' ? expiredReasonText() : null;
}

/** D11: '잔액 부족 — 가용 코인 N Coin, 필요 M Coin'. No link (ADR-0135 D11). */
export function insufficientCoinLine(availableCoin: bigint, needCoin: bigint): string {
  return `${copy.orderShortCoinHead} ${formatCoin(availableCoin)}, ${copy.orderNeed} ${formatCoin(
    needCoin,
  )}`;
}

/** '매도 가능 N계약(대기 매도 잠금 K계약)', the panel's sell line and D11's figures. */
export function sellableLine(unlockedQty: number, restingSellQty: number): string {
  return `${copy.orderSellable} ${formatContracts(unlockedQty)}(${copy.orderRestingSellLock} ${formatContracts(
    restingSellQty,
  )})`;
}

/** D11: '보유량 부족 — 매도 가능 N계약(대기 매도 잠금 K계약)'. */
export function insufficientContractsLine(unlockedQty: number, restingSellQty: number): string {
  return `${copy.orderShortContractsHead} ${sellableLine(unlockedQty, restingSellQty)}`;
}

/**
 * D13's account restriction in three pieces: the sentence, then '(<끝>까지' or '(기한 없음' and ')'.
 * The middle one is drawn unbroken, so a date never splits between its year and its month
 * (ADR-0140 결정 2-23); `restrictedLine` is the three joined.
 */
export function restrictedLineParts(endsAtText: string | null): [string, string, string] {
  const end =
    endsAtText === null ? copy.orderRestrictedNoEnd : `${endsAtText}${copy.orderRestrictedUntil}`;
  return [`${copy.orderRestricted}(`, end, ')'];
}

/** D13's account restriction: '계정 제한 중에는 주문할 수 없습니다(<끝>까지)' or '(기한 없음)'. */
export function restrictedLine(endsAtText: string | null): string {
  return restrictedLineParts(endsAtText).join('');
}

/** The line a block shows (결정 2-9), but the account's and the holding's, which carry figures. */
export function blockText(reason: OrderBlockReason): string {
  switch (reason) {
    case 'admin':
      return copy.orderAdmin;
    case 'restricted':
      return copy.orderRestricted;
    case 'no_width':
      return copy.orderBlockNoWidth;
    case 'budget_too_small':
      return copy.orderBlockBudget;
    case 'no_quote':
      return copy.orderBlockNoQuote;
    case 'price_limit':
      // Not the 거절 row's past tense: nothing was ordered yet (ADR-0140 결정 2-23).
      return copy.orderBlockPriceLimit;
    case 'self_trade':
      return copy.orderRejectSelfTrade;
    case 'sell_none':
      return copy.orderSellNone;
    case 'insufficient_contracts':
      return copy.orderRejectInsufficientContracts;
  }
}

/**
 * A refusal with no row (`orders.controller.ts`), as one sentence. DUPLICATE_REQUEST never gets
 * here — it is read back — and a RESTRICTED's end is worded by the caller (`restrictedLine`).
 */
export function failureText(failure: OrderFailure, endsAtText: string | null = null): string {
  switch (failure.code) {
    case 'UNAUTHENTICATED':
      return copy.orderSignIn;
    case 'FORBIDDEN':
      return failure.anotherAccount === true ? copy.sessionChanged : copy.orderForbidden;
    case 'RESTRICTED':
      return restrictedLine(endsAtText);
    case 'ONBOARDING_REQUIRED':
      return copy.orderOnboarding;
    case 'NOT_FOUND':
      return copy.orderMarketGone;
    case 'VALIDATION_ERROR':
      return copy.orderInvalid;
    case 'ORDER_INTAKE_CLOSED':
      return failure.noWidth === true ? copy.orderBlockNoWidth : copy.orderIntakeClosed;
    case 'RATE_LIMITED':
      return failure.retryAfterSeconds === undefined
        ? `${copy.orderRateLimited}.`
        : `${copy.orderRateLimited}(${String(failure.retryAfterSeconds)}${copy.orderSeconds}).`;
    default:
      return copy.errUnknown;
  }
}
