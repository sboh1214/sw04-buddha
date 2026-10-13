import { type OrderStatus, PAID_COIN_SALES_ENABLED } from '@buddha/shared';
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
export const MY_WALLET_PATH = '/my/wallet';
export const MY_SETTINGS_PATH = '/my/settings';

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
 * 내 글, 관심 시장 and 알림 are placeholders until #51, #89 and #53 fill them. Next 16 types
 * `href`, so the list is declared as routes rather than plain strings.
 */
export const MY_TABS: readonly { key: MyTabKey; href: Route; label: string }[] = [
  { key: 'positions', href: '/my/positions', label: copy.myPositions },
  { key: 'orders', href: '/my/orders', label: copy.myOrders },
  { key: 'history', href: '/my/history', label: copy.myHistory },
  { key: 'wallet', href: MY_WALLET_PATH, label: copy.myWallet },
  { key: 'posts', href: '/my/posts', label: copy.myPosts },
  { key: 'watchlist', href: '/my/watchlist', label: copy.myWatchlist },
  { key: 'notifications', href: '/my/notifications', label: copy.myNotifications },
  { key: 'settings', href: MY_SETTINGS_PATH, label: copy.mySettings },
];

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
 * 대기 주문 (owner decision 2026-10-13): an order still resting on the book, filled or not in
 * part. Every other state is done and belongs to 거래·정산 이력.
 */
export function isPendingOrder(status: OrderStatus): boolean {
  return status === 'open' || status === 'partially_filled';
}
