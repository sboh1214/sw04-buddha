import { ORDER_STATUSES, type OrderStatus } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  MY_TABS,
  isMyTabCurrent,
  isPendingOrder,
  myLoginPath,
  orderHistoryEmpty,
  tabStripScrollDelta,
} from './my';
import { safeNextPath } from './next-path';

const PACKAGE_ID = '0190c7a4-0000-7000-8000-000000000001';

/** The `next` a login path carries, decoded the way the login page reads it. */
function nextOf(loginPath: string): string | null {
  expect(loginPath.startsWith('/login?')).toBe(true);
  return new URL(loginPath, 'https://x.invalid').searchParams.get('next');
}

describe('MY_TABS', () => {
  it("lists the owner's eight tabs in order, one route each under /my", () => {
    expect(MY_TABS.map((tab) => tab.label)).toEqual([
      '보유 계약',
      '대기 주문',
      '거래·정산 이력',
      '지갑',
      '내 글',
      '관심 시장',
      '알림',
      '설정',
    ]);
    expect(MY_TABS.map((tab) => tab.href)).toEqual([
      '/my/positions',
      '/my/orders',
      '/my/history',
      '/my/wallet',
      '/my/posts',
      '/my/watchlist',
      '/my/notifications',
      '/my/settings',
    ]);
    expect(copy.myNotifications).not.toContain('설정');
  });
});

describe('isMyTabCurrent', () => {
  it('marks a tab on its own route and its subtree only', () => {
    expect(isMyTabCurrent('/my/orders', '/my/orders')).toBe(true);
    expect(isMyTabCurrent('/my/orders/x', '/my/orders')).toBe(true);
    expect(isMyTabCurrent('/my/ordersx', '/my/orders')).toBe(false);
    expect(isMyTabCurrent('/my/history', '/my/orders')).toBe(false);
  });

  it('marks no tab on the summary', () => {
    for (const tab of MY_TABS) expect(isMyTabCurrent('/my', tab.href), tab.href).toBe(false);
  });
});

describe('tabStripScrollDelta', () => {
  const strip = { left: 16, right: 359 };

  it('leaves a tab already in the strip where it is', () => {
    expect(tabStripScrollDelta(strip, { left: 16, right: 80 })).toBe(0);
    expect(tabStripScrollDelta(strip, { left: 300, right: 359 })).toBe(0);
  });

  it('scrolls only as far as the tab is cut off, on either side', () => {
    expect(tabStripScrollDelta(strip, { left: 400, right: 470 })).toBe(111);
    expect(tabStripScrollDelta(strip, { left: -50, right: 20 })).toBe(-66);
  });

  it('keeps the start of a tab wider than the strip in view', () => {
    expect(tabStripScrollDelta(strip, { left: 100, right: 500 })).toBe(84);
    expect(tabStripScrollDelta(strip, { left: -100, right: 500 })).toBe(-116);
  });
});

describe('myLoginPath', () => {
  it('sends the visitor to the login page, told to come back to the MY page asked for', () => {
    expect(myLoginPath('/my', '')).toBe('/login?next=%2Fmy');
    for (const tab of MY_TABS) {
      const next = nextOf(myLoginPath(tab.href, null));
      expect(next).toBe(tab.href);
      // What LoginPage does with it: same-origin, so it is where the sign-in lands.
      expect(safeNextPath(next)).toBe(tab.href);
    }
  });

  it('falls back to the summary for a path that is not under /my or not safe', () => {
    for (const pathname of [null, undefined, '', '/', '/myx', '/admin/users', '//evil', '/my\\x']) {
      expect(nextOf(myLoginPath(pathname, '')), String(pathname)).toBe('/my');
    }
  });

  it('drops the query string: a settings error or a crafted parameter never rides into next', () => {
    expect(nextOf(myLoginPath('/my/settings', '?error=link'))).toBe('/my/settings');
    expect(nextOf(myLoginPath('/my/history', '?next=https://evil.example'))).toBe('/my/history');
  });

  it('keeps the /charge package through the login only while paid Coin is on sale', () => {
    const search = `?package=${PACKAGE_ID}&x=1`;
    expect(nextOf(myLoginPath('/my/wallet', search, true))).toBe(
      `/my/wallet?package=${PACKAGE_ID}`,
    );
    expect(nextOf(myLoginPath('/my/wallet', search, false))).toBe('/my/wallet');
    // Closed is the shipped state (ADR-0049), and the default reads it.
    expect(nextOf(myLoginPath('/my/wallet', search))).toBe('/my/wallet');
  });

  it('ignores a package that is not one id, and a package on any other tab', () => {
    for (const search of [
      '?package=../admin',
      '?package=',
      `?package=${PACKAGE_ID}&package=${PACKAGE_ID}`,
    ]) {
      expect(nextOf(myLoginPath('/my/wallet', search, true)), search).toBe('/my/wallet');
    }
    expect(nextOf(myLoginPath('/my/orders', `?package=${PACKAGE_ID}`, true))).toBe('/my/orders');
  });
});

describe('isPendingOrder', () => {
  it('puts open and partially filled orders under 대기 주문 and every other state in 이력', () => {
    const pending = ORDER_STATUSES.filter((status) => isPendingOrder(status));
    expect(pending).toEqual(['open', 'partially_filled']);
  });
});

describe('orderHistoryEmpty', () => {
  const order = (status: OrderStatus) => ({ status });

  it('says an account that never ordered has no orders', () => {
    expect(orderHistoryEmpty([])).toBe('none');
  });

  it('says none has finished when every order is still 대기 — never that there are none', () => {
    expect(orderHistoryEmpty([order('open')])).toBe('pendingOnly');
    expect(orderHistoryEmpty([order('open'), order('partially_filled')])).toBe('pendingOnly');
  });

  it('has nothing to say while a finished order is there to show', () => {
    for (const status of ORDER_STATUSES.filter((s) => !isPendingOrder(s))) {
      expect(orderHistoryEmpty([order('open'), order(status)]), status).toBeNull();
    }
  });

  it("reads as the owner's two wordings, the second with 대기 주문 as its link", () => {
    expect(copy.portfolioOrdersEmpty).toBe('아직 주문 내역이 없습니다.');
    expect(
      `${copy.portfolioOrderHistoryEmpty} ${copy.portfolioPendingOrdersHintBefore} ${copy.myOrders}${copy.portfolioPendingOrdersHintAfter}`,
    ).toBe('끝난 주문이 없습니다. 대기 중인 주문은 대기 주문에서 볼 수 있습니다.');
  });
});
