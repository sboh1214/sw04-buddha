import type { APIRequestContext, Browser, Locator, Page } from '@playwright/test';
import {
  type ExcludedFeatureId,
  type MyFill,
  type Order,
  type Position,
  findExcludedText,
  isLiveOrderStatus,
} from '@buddha/shared';
import { dataOf, expect } from './helpers';

/**
 * 화면 인수 시험의 공통 도우미 (#189 2부, ADR-0178): what the acceptance steps of several specs
 * share, kept here instead of a copy in each spec.
 *
 * Every test #189 counts carries `@ac189-<n>` in its title, `n` the issue's acceptance criterion
 * (1..13). The tag is a title tag, so Playwright's JSON report lists it under the test's `tags`
 * and `scripts/e2e-summary.mjs` tables it; the default config's `grepInvert` never matches it, so
 * the tagged tests run in the six ordinary shards like any other. A test may carry several.
 */

// ---- 다른 회원의 화면 -------------------------------------------------------------------------

/**
 * A page of `member`'s own browser session at `page`'s width: a new context from the cookie of
 * `member` — an API context bound to a browser context, as `helperTraders` gives — so a spec can
 * read what that member sees (judgement-error.spec.ts's and judging-record.spec.ts's way). The
 * project's other options (base URL, locale, time zone, `isMobile`) come with `browser.newContext`
 * itself. The caller closes it: `await memberPage.context().close()`, in a `finally`.
 */
export async function asMember(
  browser: Browser,
  member: APIRequestContext,
  page: Page,
): Promise<Page> {
  const context = await browser.newContext({
    storageState: await member.storageState(),
    viewport: page.viewportSize() ?? undefined,
  });
  return context.newPage();
}

// ---- 기준 11: 확률 입력·점수·순위·Forecast 입력 -------------------------------------------------

/**
 * What criterion 11 names (N02 §10, N04 §7): a probability input or a Forecast, and a score or a
 * rank — the `probability-input` and `scoring` rows of the excluded list (#113,
 * `EXCLUDED_FEATURES`). The other rows (paid Coin, rewards, transfers, the replaced terms) have
 * their own static checks and are not this criterion's.
 */
export const CRITERION_11_FEATURES: readonly ExcludedFeatureId[] = ['probability-input', 'scoring'];

/**
 * The screen as rendered names no excluded feature of criterion 11: the text a reader sees
 * (`innerText` of `scope`, the whole page by default) through the same word list and allowances
 * the static checks use (`findExcludedText`, docs/GUARDS.md). The static checks read the source;
 * this reads what a test's own data and the server's answers made of it. Call it once the screen
 * has drawn what it is being checked for (after a web-first assertion on it), and on the inbox
 * for the notifications.
 */
export async function expectNoExcludedText(page: Page, scope?: Locator): Promise<void> {
  const text = await (scope ?? page.locator('body')).innerText();
  const hits = findExcludedText(text, { features: CRITERION_11_FEATURES });
  expect(
    hits.map(
      (hit) =>
        `${hit.feature} '${hit.match}' …${text.slice(Math.max(0, hit.index - 20), hit.index + 20)}…`,
    ),
    `excluded text on ${page.url()}`,
  ).toEqual([]);
}

// ---- 기준 10: 다른 회원의 비공개 자산·주문 ------------------------------------------------------

/**
 * None of `figures` — another member's balance, holding or order as a screen would write them
 * ('997,514 Coin', '37계약') — is on `page`: neither in its text nor anywhere in its HTML (the
 * hydration payload included), the latter read with digit boundaries so a long number that merely
 * contains one is no hit. Pick figures that nothing else on the screen can show (a quantity no
 * public count equals). Call it once the screen has drawn the item it is checked on.
 */
export async function expectNoPrivateFigures(
  page: Page,
  figures: readonly string[],
): Promise<void> {
  const text = await page.locator('body').innerText();
  const html = await page.content();
  for (const figure of figures) {
    expect(text, `${figure} on ${page.url()}`).not.toContain(figure);
    const bounded = new RegExp(
      `(?<![\\d,])${figure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d,])`,
    );
    expect(bounded.test(html), `${figure} in the HTML of ${page.url()}`).toBe(false);
  }
}

// ---- 주문 패널 (#66; order-panel.spec.ts와 기준 9의 두 제한 시험) -----------------------------

/**
 * The panel on this width: the order column from md, the sheet the 매수 bar opens below it — on
 * `contract` when one is named (its button pressed), as it stands otherwise.
 */
export async function openPanel(page: Page, contract?: 'YES' | 'NO'): Promise<Locator> {
  const id = contract === 'NO' ? 'no' : 'yes';
  let place: Locator;
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    place = page.getByTestId('order-area');
  } else {
    place = page.getByTestId('order-sheet');
    if (!(await place.isVisible())) await page.getByTestId(`order-entry-${id}`).click();
  }
  await expect(place.getByTestId('order-panel')).toBeVisible();
  if (contract !== undefined) await place.getByTestId(`order-contract-${id}`).click();
  return place;
}

export interface PanelOrder {
  side?: 'buy' | 'sell';
  kind?: 'ioc' | 'gtc';
  qty?: number;
  budget?: number;
  limit?: number;
}

/** Fills the panel's choices and fields, and waits for the quote of exactly them. */
export async function fillOrder(panel: Locator, order: PanelOrder): Promise<void> {
  await panel.getByTestId(`order-side-${order.side ?? 'buy'}`).click();
  await panel.getByTestId(`order-kind-${order.kind ?? 'ioc'}`).click();
  if (order.budget !== undefined) {
    await panel.getByTestId('order-size-budget').click();
    await panel.getByTestId('order-budget').fill(String(order.budget));
  } else {
    if ((order.side ?? 'buy') === 'buy' && (order.kind ?? 'ioc') === 'ioc') {
      await panel.getByTestId('order-size-qty').click();
    }
    await panel.getByTestId('order-qty').fill(String(order.qty ?? 1));
  }
  if (order.limit !== undefined) await panel.getByTestId('order-limit').fill(String(order.limit));
}

/** 주문 확인, then the frozen table. */
export async function openReview(panel: Locator): Promise<Locator> {
  await expect(panel.getByTestId('order-quote')).toBeVisible();
  await expect(panel.getByTestId('order-confirm-open')).toBeEnabled();
  await panel.getByTestId('order-confirm-open').click();
  const review = panel.getByTestId('order-review');
  await expect(review).toBeVisible();
  return review;
}

/**
 * One order through the panel, sent from 확인: the panel, whose `order-result` then holds the
 * server's answer (`data-status`).
 */
export async function orderOnPanel(
  page: Page,
  contract: 'YES' | 'NO',
  order: PanelOrder,
): Promise<Locator> {
  const panel = await openPanel(page, contract);
  await fillOrder(panel, order);
  const review = await openReview(panel);
  await review.getByTestId('order-submit').click();
  return panel;
}

// ---- 기준 5: 접히지 않은 확인 ---------------------------------------------------------------

/**
 * `row` is shown in full on a phone (N02 §4, ADR-0135 D:16472): visible, inside no folded or
 * hidden region — no `<details>` at all, no `hidden`, `inert`, `aria-hidden` or closed
 * collapsible (`data-state="closed"`) ancestor — and on screen once scrolled to, not clipped away
 * by the sheet's own box.
 */
export async function expectNotCollapsed(row: Locator, name: string): Promise<void> {
  await expect(row, name).toBeVisible();
  const folded = await row.evaluate((element) => {
    const fold = element.closest(
      'details, [hidden], [inert], [aria-hidden="true"], [data-state="closed"]',
    );
    return fold === null ? null : fold.outerHTML.slice(0, 120);
  });
  expect(folded, `${name} sits in a folded region`).toBeNull();
  await row.scrollIntoViewIfNeeded();
  await expect(row, name).toBeInViewport({ ratio: 1 });
}

// ---- 기준 1: 주문의 MY 확인 -----------------------------------------------------------------

/**
 * What the member of `page` holds and ordered on `marketId`, as the API answers it, on MY's three
 * screens (N02 §10, #189 범위 '결과가 MY의 보유 계약·대기 주문·거래 이력에 보인다'): every
 * holding's quantity on 보유 계약 (`/my/positions`), every live order on 대기 주문 (`/my/orders`),
 * every ended one on 거래·정산 이력's 주문 and every fill on its 체결 — both filtered to the market,
 * so another market's rows never count. A fresh member's lists fit their first page.
 */
export async function expectOrdersOnMy(page: Page, marketId: string): Promise<void> {
  const read = <T>(path: string) => page.request.get(path).then((response) => dataOf<T>(response));
  const [orders, fills, positions] = await Promise.all([
    read<Order[]>(`/api/v1/me/orders?marketId=${marketId}`),
    read<MyFill[]>(`/api/v1/me/fills?marketId=${marketId}`),
    read<Position[]>('/api/v1/me/positions'),
  ]);
  const live = orders.filter((order) => isLiveOrderStatus(order.status));
  const ended = orders.filter((order) => !live.includes(order));
  const held = positions.filter((position) => position.marketId === marketId && position.qty > 0);

  // 보유 계약: each contract held, its quantity.
  await page.goto('/my/positions');
  const list = page.getByTestId('portfolio-positions');
  await expect(list).toBeVisible();
  for (const position of held) {
    await expect(
      list
        .getByTestId(`portfolio-position-${marketId}-${position.outcome}`)
        .getByTestId('position-qty'),
      `${position.outcome} 보유`,
    ).toHaveText(`${String(position.qty)}계약`);
  }

  // 대기 주문: each live order, with what is left of it.
  await page.goto('/my/orders');
  const pending = page.getByTestId('my-orders');
  if (live.length === 0) await expect(page.getByTestId('my-orders-empty')).toBeVisible();
  for (const order of live) {
    await expect(
      pending.getByTestId(`portfolio-order-${order.id}`).getByTestId('order-row-remaining'),
      `대기 주문 ${order.id}`,
    ).toHaveText(`${String((order.qty ?? 0) - order.filledQty - order.cancelledQty)}계약`);
  }

  // 거래·정산 이력: the ended orders with what filled, and every fill.
  await page.goto(`/my/history?market=${marketId}`);
  const history = page.getByTestId('my-order-history');
  for (const order of ended) {
    await expect(
      history.getByTestId(`portfolio-order-${order.id}`).getByTestId('history-order-filled'),
      `이력 ${order.id}`,
    ).toHaveText(`${String(order.filledQty)}계약`);
  }
  await page.goto(`/my/history?kind=fills&market=${marketId}`);
  const fillList = page.getByTestId('my-fill-history');
  await expect(fillList.locator('[data-fill-side]')).toHaveCount(fills.length);
  for (const fill of fills) {
    await expect(fillList.getByTestId(`history-fill-${fill.id}`)).toBeVisible();
  }
}

// ---- 기준 6: MY 정산 기록 ------------------------------------------------------------------

/**
 * The member's settlement records of one market on MY 거래·정산 이력 (`/my/history?kind=settlements
 * &market=`, the filter #34's 이력 연결 opens): one row per contract held at the payout. A helper
 * member trades on other markets of the worker too, so its records are counted under the market
 * filter only (e2e/README.md).
 */
export async function openSettlementRecords(page: Page, marketId: string): Promise<Locator> {
  await page.goto(`/my/history?kind=settlements&market=${marketId}`);
  const list = page.getByTestId('my-settlement-history');
  await expect(list).toBeVisible();
  return list.locator(`[data-testid^="history-settlement-${marketId}-"]`);
}
