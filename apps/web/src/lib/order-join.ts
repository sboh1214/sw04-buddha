import { isLiveOrderStatus, type OrderStatus } from '@buddha/shared';
import { type InfiniteData } from '@tanstack/react-query';
import { type Order } from './api';

/**
 * The join that keeps a late answer from rolling an order row back (#123, ADR-0141 결정 8), apart
 * from my-orders.ts so query-client.ts can register it without importing the screen rules (and,
 * through them, components) at the root of every page.
 */

/** One cursor page of `GET /me/orders` or `GET /me/fills`, the shape every infinite list holds. */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export type OrderPages = InfiniteData<CursorPage<Order>, string | undefined>;

/** Whether the order still rests (대기·부분 체결): `isLiveOrderStatus` of its status. */
export function isLiveOrder(order: { status: OrderStatus }): boolean {
  return isLiveOrderStatus(order.status);
}

/** 남은 수량: what a live quantity order still rests with; null for a budget order (never live). */
export function remainingQty(order: Pick<Order, 'qty' | 'filledQty'>): number | null {
  return order.qty === null ? null : order.qty - order.filledQty;
}

/**
 * The ordering an order row can be compared by (ADR-0141 결정 8): `orders_keep_record` (0062) keeps
 * an ended row as it is, never lowers `filled_qty` and only moves a status forward, so an ended
 * order outranks every live reading and a live one ranks by what filled. `Order` has no version
 * and `updated_at` is not kept monotone, so this is the whole key.
 */
export function orderRank(order: Pick<Order, 'status' | 'filledQty'>): number {
  return isLiveOrder(order) ? order.filledQty : Number.POSITIVE_INFINITY;
}

/**
 * The detail key's join (query-client.ts registers it): `incoming` unless it ranks below what is
 * held — a GET that left before a cancel's answer landed, or before a fill, cannot put back 대기
 * or a smaller 체결 수량. The same rank takes `incoming`, so a change of `awaitingRecovery` lands.
 */
export function joinOrder(held: Order | undefined, incoming: Order): Order {
  if (held === undefined) return incoming;
  return orderRank(incoming) >= orderRank(held) ? incoming : held;
}

/**
 * The live lists' join: the pages and their cursors are `incoming`'s, each row joined with the
 * held row of its id (`joinOrder`). An id the held pages ended keeps its ended row even when a late
 * read brings it back live, and the list's `select` takes it out (`liveRowsOnly`).
 */
export function joinOrderPages(held: OrderPages | undefined, incoming: OrderPages): OrderPages {
  if (held === undefined) return incoming;
  const heldById = new Map<string, Order>();
  for (const page of held.pages) for (const order of page.items) heldById.set(order.id, order);
  if (heldById.size === 0) return incoming;
  return {
    ...incoming,
    pages: incoming.pages.map((page) => ({
      ...page,
      items: page.items.map((order) => joinOrder(heldById.get(order.id), order)),
    })),
  };
}

/** `held` with `order` in place of the row of its id; undefined (write nothing) when none is. */
export function withOrderInPages(
  held: OrderPages | undefined,
  order: Order,
): OrderPages | undefined {
  if (held === undefined) return undefined;
  if (!held.pages.some((page) => page.items.some((row) => row.id === order.id))) return undefined;
  return {
    ...held,
    pages: held.pages.map((page) => ({
      ...page,
      items: page.items.map((row) => (row.id === order.id ? joinOrder(row, order) : row)),
    })),
  };
}

/**
 * The live list's `select`: the rows still live. A cancel's answer or a read back of an order that
 * ended is written into the pages (`withOrderInPages`), and this takes the row out at once — the
 * 결과 4 '끝나면 바로 뺀다' — while the join keeps it from coming back.
 */
export function liveRowsOnly(data: OrderPages): OrderPages {
  return {
    ...data,
    pages: data.pages.map((page) => ({ ...page, items: page.items.filter(isLiveOrder) })),
  };
}
