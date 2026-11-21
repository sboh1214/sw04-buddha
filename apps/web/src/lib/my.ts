import { PAID_COIN_SALES_ENABLED } from '@buddha/shared';
import type { Route } from 'next';
import { copy } from '@/copy';
import { walletPackageId } from './charge-guide';
import { safeNextPath } from './next-path';

/**
 * MY, the signed-in reader's own area (#16, owner decision 2026-10-13): `/my` is the summary and
 * each tab is one segment under it. Pure functions of the URL and of an order's status, kept out
 * of `app/my` so vitest can run them under its node environment — the split `lib/nav.ts` makes.
 */

export const MY_PATH = '/my';
export const MY_ORDERS_PATH = '/my/orders';
export const MY_HISTORY_PATH = '/my/history';
export const MY_WALLET_PATH = '/my/wallet';
export const MY_SETTINGS_PATH = '/my/settings';
/** MY › 알림 (#53, ADR-0157): the member's inbox, newest first. */
export const MY_NOTIFICATIONS_PATH = '/my/notifications';

export type MyTabKey =
  | 'positions'
  | 'orders'
  | 'history'
  | 'wallet'
  | 'posts'
  | 'watchlist'
  | 'notifications'
  | 'settings';

/**
 * The tabs in the owner's order: N02 §8 with 관심 시장 added (N04 §3, N05 §3) and 알림·설정 as two.
 * Every tab has its content: #89 filled 관심 시장 (ADR-0064), #51 내 글 (ADR-0080) and #53 알림
 * (ADR-0157), whose tab carries the unread count (53-1). Next 16 types `href`, so the list is
 * declared as routes rather than plain strings.
 */
export const MY_TABS: readonly { key: MyTabKey; href: Route; label: string }[] = [
  { key: 'positions', href: '/my/positions', label: copy.myPositions },
  { key: 'orders', href: MY_ORDERS_PATH, label: copy.myOrders },
  { key: 'history', href: MY_HISTORY_PATH, label: copy.myHistory },
  { key: 'wallet', href: MY_WALLET_PATH, label: copy.myWallet },
  { key: 'posts', href: '/my/posts', label: copy.myPosts },
  { key: 'watchlist', href: '/my/watchlist', label: copy.myWatchlist },
  { key: 'notifications', href: MY_NOTIFICATIONS_PATH, label: copy.myNotifications },
  { key: 'settings', href: MY_SETTINGS_PATH, label: copy.mySettings },
];

/**
 * 주문 상세 (#123, ADR-0141): one order's page under 대기 주문 (ADR-0135 결과 4 #123 '주소'), so the
 * tab strip reads 대기 주문 there whatever the order's state (`isMyTabCurrent`). Its id as given:
 * the page reads it, and the server answers a malformed one as it answers another account's.
 */
export function myOrderPath(orderId: string): Route {
  return `${MY_ORDERS_PATH}/${orderId}` as Route;
}

/** How many rows each tab's preview on the `/my` summary shows before its 전체 보기. */
export const MY_PREVIEW_ROWS = 3;

function isUnder(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

/**
 * Whether a tab is the page being shown: its own route and its subtree, never a look-alike
 * prefix (`/my/ordersx`). The summary at `/my` is no tab's page.
 */
export function isMyTabCurrent(pathname: string, href: string): boolean {
  return isUnder(pathname, href);
}

/**
 * How far MY's tab strip scrolls sideways to show the current tab whole, in px (negative is
 * leftward), from the two boxes' viewport edges; 0 when it is already in view. The strip alone
 * scrolls by it: `scrollIntoView` also moves the window, so a restored scroll (a reload, Back)
 * that left the strip above the viewport pulled the page up to it. A tab wider than the strip
 * keeps its start in view.
 */
export function tabStripScrollDelta(
  strip: { left: number; right: number },
  tab: { left: number; right: number },
): number {
  if (tab.left < strip.left) return tab.left - strip.left;
  if (tab.right > strip.right) return Math.min(tab.right - strip.right, tab.left - strip.left);
  return 0;
}

/**
 * Where MY's session gate (`requireMySession`, my.server.ts) sends a visitor with no session: the
 * login page, told to come back to the MY page they asked for. `pathname` and `search` come from the headers `proxy.ts` stamps; a
 * path that is not under `/my` (or not a safe same-origin path) falls back to the summary, so a
 * client-supplied value cannot steer the redirect anywhere else.
 *
 * The query string is dropped — nothing under MY is worth carrying through a login but the
 * package the public `/charge` page sent the visitor to buy (`/my/wallet?package=<id>`,
 * ADR-0044), and that one only while paid Coin is on sale (PAID_COIN_SALES_ENABLED, ADR-0049).
 * Only the parsed id travels, so nothing a crafted link adds rides into `next`.
 */
export function myLoginPath(
  pathname: string | null | undefined,
  search: string | null | undefined,
  salesEnabled: boolean = PAID_COIN_SALES_ENABLED,
): string {
  const path =
    typeof pathname === 'string' &&
    isUnder(pathname, MY_PATH) &&
    safeNextPath(pathname) === pathname
      ? pathname
      : MY_PATH;
  let next = path;
  if (path === MY_WALLET_PATH && salesEnabled) {
    // `getAll`, so a repeated parameter is refused as the wallet page refuses it (an array).
    const values = new URLSearchParams(search ?? '').getAll('package');
    const packageId = walletPackageId(values.length === 1 ? values[0] : values);
    if (packageId !== undefined) next = `${MY_WALLET_PATH}?package=${packageId}`;
  }
  return `/login?next=${encodeURIComponent(next)}`;
}

/**
 * Whether a list of orders offers 더 보기: the full tab while there is a next page, and a /my
 * preview (`limit`, MY_PREVIEW_ROWS) until it holds that many rows. 대기 주문 (#123) and the three
 * history lists (#124) read the server's own filtered lists, a page of 20 each, so a preview holds
 * its three rows from the first page and offers none; the rule stays for a list a cache write left
 * short of them.
 */
export function showMoreOrders(
  hasNextPage: boolean,
  rows: number,
  limit: number | undefined,
): boolean {
  return hasNextPage && (limit === undefined || rows < limit);
}

/**
 * What 대기 주문's live list says, for the history's empty 주문 목록: `some` and `none` once it
 * answered, `pending` while it is read, `failed` when that read did not come.
 */
export type LiveOrdersReading = 'some' | 'none' | 'pending' | 'failed';

/**
 * The live list's reading from its ladder (`listView`) and whether it holds a row (or a page still
 * to read). A refresh that failed keeps the rows it had, so it still answers by them; with none it
 * is as unsure as a failed read (an order placed since may rest there), so it says `failed`.
 */
export function liveOrdersReading(
  view: 'pending' | 'failed' | 'stale' | 'ready',
  holdsRows: boolean,
): LiveOrdersReading {
  if (view === 'pending' || view === 'failed') return view;
  if (holdsRows) return 'some';
  return view === 'stale' ? 'failed' : 'none';
}

/**
 * Why 거래·정산 이력's 주문 목록 has no row with no filter on (owner decision 2026-10-13; #124,
 * ADR-0143): the server's ended list (`state=ended`) holds none, and the live list says which of
 * the owner's two wordings is true. `none`: it has never ordered (아직 주문 내역이 없습니다).
 * `pendingOnly`: every order it has is still 대기, so none has finished (끝난 주문이 없습니다) and
 * 대기 주문 is where they are; "no orders" would be false about it. `pending`: the live list is
 * still read — a skeleton, neither wording yet. `endedNone`: the live list could not be read, so
 * only what IS known is said — no order has ended — and never that the account has none. `null`
 * while an ended order is there to show.
 */
export function orderHistoryEmpty(
  ended: number,
  live: LiveOrdersReading,
): 'none' | 'pendingOnly' | 'pending' | 'endedNone' | null {
  if (ended > 0) return null;
  switch (live) {
    case 'some':
      return 'pendingOnly';
    case 'none':
      return 'none';
    case 'pending':
      return 'pending';
    case 'failed':
      return 'endedNone';
  }
}
