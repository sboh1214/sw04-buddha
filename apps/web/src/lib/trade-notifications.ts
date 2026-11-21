import type { OrderFilledParams, OrdersCancelledParams, OrdersExpiredParams } from '@buddha/shared';
import { copy } from '@/copy';
import { formatQuantity } from './market-admin';
import { averagePriceText, contractSideLabel } from './order-confirm';

/**
 * 거래 알림 (#134, ADR-0158; N05 §4; owner answers 52-2…52-6, 134-1…134-4) as the inbox's row
 * words them: the titles of `order_filled`, `orders_cancelled` and `orders_expired` from the params
 * their definitions parsed (@buddha/shared notifications.ts). The sentences are copy.ts' templates
 * with single-brace placeholders (`{market}`), filled here — never `{{…}}`, which copy keeps for
 * the business facts (legal.test.ts). Pure and node-safe, so trade-notifications.test.ts runs
 * them; the renderers (components/notifications) only call them.
 */

/** A placeholder of a notification template: `{name}`, a camelCase name. */
const PLACEHOLDER = /\{([a-zA-Z]+)\}/g;

/** The placeholders of `template`, in order of first appearance. */
export function notificationTextKeys(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ''))];
}

/**
 * `template` with each `{name}` replaced by `values[name]`. Throws when a placeholder has no value
 * or a value has no placeholder: either is a title that passes the wrong keys, and no row should
 * show a raw `{name}` or drop a figure. A value is inserted as it is (never read for placeholders).
 */
export function fillNotificationText(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  const used = new Set<string>();
  const text = template.replace(PLACEHOLDER, (_, key: string) => {
    const value = Object.hasOwn(values, key) ? values[key] : undefined;
    if (value === undefined) throw new Error(`no value for {${key}} in '${template}'`);
    used.add(key);
    return value;
  });
  const unknown = Object.keys(values).filter((key) => !used.has(key));
  if (unknown.length > 0) {
    throw new Error(`'${template}' has no {${unknown.join('}, {')}}`);
  }
  return text;
}

/** A count of events, orders or markets as the titles write it: grouped, no unit. */
const count = (n: number) => formatQuantity(String(n));

/**
 * An `order_filled` notification's title (52-6, 134-1, 134-3): the market, the resting order's
 * contract and direction ('NO 매수'), 부분 체결 or 전량 체결, and the fills it holds — their total
 * quantity and average price (`amountCoin / qty`, MY's half-up 0.01 Coin; for resting fills always
 * the order's own price, N01 §4), with 체결 N회 (the row's `eventCount`) once two or more merged.
 * When the notification does not hold every fill of the order — its `qty` is not the order's
 * filled quantity, as after a read (52-6: the next fill is a new notification) — its quantity is
 * '이번' and the order's whole follows: '(주문 3계약 중 3계약 체결)' (134-3).
 */
export function orderFilledTitle(params: OrderFilledParams, eventCount: number): string {
  const merged = eventCount > 1;
  const since = BigInt(params.qty) !== BigInt(params.orderFilledQty);
  const template = since
    ? merged
      ? copy.notificationOrderFilledMergedSince
      : copy.notificationOrderFilledSince
    : merged
      ? copy.notificationOrderFilledMerged
      : copy.notificationOrderFilled;
  return fillNotificationText(template, {
    market: params.marketTitle,
    contract: contractSideLabel(params.outcome, params.side),
    state: params.fullyFilled ? copy.orderStatusFilled : copy.orderStatusPartiallyFilled,
    ...(merged ? { count: count(eventCount) } : {}),
    // formatQuantity, not formatContracts: the template writes 계약 after the number itself.
    qty: formatQuantity(params.qty),
    price: averagePriceText({ filledQty: Number(params.qty), filledAmountCoin: params.amountCoin }),
    ...(since
      ? {
          orderQty: formatQuantity(params.orderQty),
          orderFilledQty: formatQuantity(params.orderFilledQty),
        }
      : {}),
  });
}

/** The account events' reasons as the sentence names them (52-3): 관리자 권한, 계정 제한. */
const ACCOUNT_CANCEL_REASON_NAMES = {
  admin_role: copy.orderCancelNameAdminRole,
  restricted: copy.orderCancelNameRestricted,
} as const satisfies Record<Exclude<OrdersCancelledParams['reason'], 'paused'>, string>;

/**
 * An `orders_cancelled` notification's title (52-3, 52-4): a market's 일시 중단 names the market
 * ('<시장> 일시 중단으로 대기 주문 2건 취소'); an account event names its reason and how many
 * markets it reached ('계정 제한으로 대기 주문 3건 취소(시장 2곳)').
 */
export function ordersCancelledTitle(params: OrdersCancelledParams): string {
  if (params.reason === 'paused') {
    // The definition's refine holds a paused notice to its market's title, and notificationView
    // shows only params the definition parsed.
    if (params.marketTitle === null) throw new Error('a paused notice names its market');
    return fillNotificationText(copy.notificationOrdersCancelledMarket, {
      market: params.marketTitle,
      count: count(params.orderCount),
    });
  }
  return fillNotificationText(copy.notificationOrdersCancelledAccount, {
    reason: ACCOUNT_CANCEL_REASON_NAMES[params.reason],
    count: count(params.orderCount),
    markets: count(params.marketCount),
  });
}

/**
 * An `orders_expired` notification's title (52-4, 52-5): the market and why its resting orders
 * expired — 거래 마감 or 시장 취소 — with how many.
 */
export function ordersExpiredTitle(params: OrdersExpiredParams): string {
  return fillNotificationText(
    params.cause === 'closed'
      ? copy.notificationOrdersExpiredClosed
      : copy.notificationOrdersExpiredCancelled,
    { market: params.marketTitle, count: count(params.orderCount) },
  );
}
