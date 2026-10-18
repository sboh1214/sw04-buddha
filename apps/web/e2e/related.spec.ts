import { type APIRequestContext, type Page } from '@playwright/test';
import { copy } from '../src/copy';
import {
  REALTIME_BUDGET_MS,
  adminAccount,
  closeMarket,
  createOpenMarket,
  expect,
  expectYellowWarning,
  freshTag,
  signIn,
  subscribed,
  test,
} from './helpers';

/**
 * 관련 시장 (#65, ADR-0068; owner decisions in ADR-0061 decision 1, items 18·19, and decision 3,
 * the #65 rows, and ADR-0068's of 2026-10-17): an admin links two markets on the admin detail, and
 * each market's detail then shows the other as the home's card, in the section after 토론 — its
 * heading over the home's grid, with no card around it — two-way, public, in the server's HTML.
 * The admin's list names who linked each market by nickname. Unlinking takes both away again, and
 * the section stays with its empty notice. The cards are live like the home's: a status change of
 * a related market reaches the detail that lists it without a reload.
 *
 * Which statuses are shown (never voided, never a draft) and the 추천 order are the API's
 * integration tests' (related-markets.controller.test.ts): no product path voids a market today,
 * and the order needs fills, which no route makes until the CLOB (#119).
 */

const related = (page: Page) => page.getByTestId('market-related');
const card = (page: Page, id: string) => related(page).getByTestId(`market-card-${id}`);

/** `POST /admin/markets/:id/related` straight at the API, for a spec whose subject is not the UI. */
async function linkThroughApi(admin: APIRequestContext, id: string, relatedId: string) {
  const res = await admin.post(`/api/v1/admin/markets/${id}/related`, {
    data: { marketId: relatedId },
  });
  expect(res.status(), await res.text()).toBe(200);
}

/** The nickname of the account `context` is signed in as (`GET /me`). */
async function nicknameOf(context: APIRequestContext): Promise<string> {
  const res = await context.get('/api/v1/me');
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { data: { profile: { nickname: string } } }).data.profile.nickname;
}

/** The vertical order of two elements: the second starts below the first ends. */
async function expectBelow(page: Page, upper: string, lower: string): Promise<void> {
  const [a, b] = await Promise.all([
    page.getByTestId(upper).boundingBox(),
    page.getByTestId(lower).boundingBox(),
  ]);
  if (a === null || b === null) throw new Error(`${upper} or ${lower} has no box`);
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
}

test.describe('관련 시장', () => {
  test('관리자가 두 시장을 연결하면 서로의 상세에 카드로 보이고, 해제하면 빈 안내만 남는다', async ({
    admin,
    browser,
    page,
    request,
  }) => {
    // One group in both titles, so the admin's search finds the two of them and nothing else.
    const group = freshTag();
    const a = await createOpenMarket(admin, { group });
    const b = await createOpenMarket(admin, { group });
    const adminNickname = await nicknameOf(admin);

    // --- before: the section is there, last, with its notice (ADR-0061 decision 1, item 19),
    // in the server's HTML too — it is public (item 18).
    const before = await (await request.get(`/markets/${a.slug}`)).text();
    expect(before).toContain('data-testid="market-related"');
    expect(before).toMatch(new RegExp(`<h2[^>]*>${copy.marketRelated}</h2>`));
    expect(before).toContain(copy.marketRelatedEmpty);
    await page.goto(`/markets/${a.slug}`);
    await expect(related(page).getByRole('heading', { level: 2 })).toHaveText(copy.marketRelated);
    await expect(related(page).getByTestId('markets-empty')).toHaveText(copy.marketRelatedEmpty);
    await expectBelow(page, 'market-discussion', 'market-related');
    // No card around the section (owner decision 2026-10-17): the heading and the grid stand on
    // the page, where the sections above it are cards with a border.
    await expect(related(page)).toHaveCSS('border-top-width', '0px');
    await expect(page.getByTestId('market-discussion')).not.toHaveCSS('border-top-width', '0px');

    // --- the admin links B from A's admin detail, found by title.
    const adminContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      await adminPage.goto(`/admin/markets/${a.id}`);
      const panel = adminPage.getByTestId('admin-related-markets');
      await expect(panel.getByTestId('admin-related-empty')).toHaveText(copy.adminRelatedEmpty);
      await panel.getByTestId('admin-related-search-input').fill(group);
      await panel.getByTestId('admin-related-search-submit').click();
      // A is in the results as the market itself, with nothing to press; B can be linked.
      await expect(panel.getByTestId(`admin-related-state-${a.id}`)).toHaveText(
        copy.adminRelatedThisMarket,
      );
      await panel.getByTestId(`admin-related-link-${b.id}`).click();
      await expect(adminPage.getByText(copy.adminRelatedLinked)).toBeVisible();
      const row = panel.getByTestId(`admin-related-${b.id}`);
      await expect(row).toContainText(b.title);
      await expect(row).toContainText(copy.marketStatusOpen);
      // Who linked it, by nickname (owner decision 2026-10-17): the seed admin the browser is.
      await expect(row.getByTestId(`admin-related-linked-by-${b.id}`)).toHaveText(adminNickname);
      // Linked now, so the result offers nothing more for B.
      await expect(panel.getByTestId(`admin-related-state-${b.id}`)).toHaveText(
        copy.adminRelatedAlreadyLinked,
      );

      // --- A's detail lists B, and B's lists A: two-way. In the HTML every visitor gets.
      const linkedHtml = await (await request.get(`/markets/${a.slug}`)).text();
      expect(linkedHtml).toContain(`data-testid="market-card-${b.id}"`);
      expect(linkedHtml).toContain(b.title);
      expect(linkedHtml).not.toContain(copy.marketRelatedEmpty);
      await page.goto(`/markets/${a.slug}`);
      await expect(card(page, b.id)).toBeVisible();
      await expect(card(page, b.id).getByRole('link', { name: b.title })).toHaveAttribute(
        'href',
        `/markets/${b.slug}`,
      );
      await expect(related(page).getByTestId('markets-empty')).toHaveCount(0);
      await page.goto(`/markets/${b.slug}`);
      await expect(card(page, a.id)).toBeVisible();
      // The card is the home's, titled one level under the section's h2.
      await expect(card(page, a.id).getByRole('heading', { level: 3 })).toHaveText(a.title);
      // B's admin detail lists A without anyone linking from there.
      await adminPage.goto(`/admin/markets/${b.id}`);
      await expect(
        adminPage.getByTestId('admin-related-markets').getByTestId(`admin-related-${a.id}`),
      ).toContainText(a.title);

      // --- unlink, from B's side, behind its confirmation.
      await adminPage.getByTestId(`admin-related-unlink-${a.id}`).click();
      await expect(adminPage.getByText(copy.adminRelatedUnlinkBody)).toBeVisible();
      await adminPage.getByTestId('admin-related-unlink-confirm').click();
      await expect(adminPage.getByText(copy.adminRelatedUnlinked)).toBeVisible();
      await expect(adminPage.getByTestId('admin-related-empty')).toHaveText(copy.adminRelatedEmpty);
    } finally {
      await adminContext.close();
    }

    // Both details are back to the notice; the section stays.
    for (const slug of [a.slug, b.slug]) {
      await page.goto(`/markets/${slug}`);
      await expect(related(page).getByTestId('markets-empty')).toHaveText(copy.marketRelatedEmpty);
      await expect(related(page).getByRole('article')).toHaveCount(0);
    }
  });

  test('관리자 패널은 붙여 넣은 긴 제목으로도 찾고, 실패한 찾기는 찾기로 다시 묻고, 다시 읽지 못한 연결 목록은 남긴 채 알린다', async ({
    admin,
    browser,
  }) => {
    // Review on #65 (ADR-0068 decision 5): the picker's box had no maxLength, so a pasted title past
    // the search term's bound searched nothing and said nothing; 찾기 on the term of a search that
    // failed sent nothing; and a list whose refresh failed passed for current.
    const a = await createOpenMarket(admin);
    // A title past the term's bound (MARKET_SEARCH_TERM_MAX, 100) and within MARKET_TITLE_MAX (120).
    const b = await createOpenMarket(admin, { group: `${freshTag()} ${'관측'.repeat(40)}` });
    const failed = {
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal error' } }),
    };

    const adminContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      let searchDown = true;
      const isSearch = (url: URL) =>
        url.pathname === '/api/v1/admin/markets' && url.searchParams.has('q');
      await adminPage.route(isSearch, (route) =>
        searchDown ? route.fulfill(failed) : route.continue(),
      );
      await adminPage.goto(`/admin/markets/${a.id}`);
      const panel = adminPage.getByTestId('admin-related-markets');
      await expect(panel.getByTestId('admin-related-empty')).toHaveText(copy.adminRelatedEmpty);

      // The whole title, pasted: the box keeps what a term can be, a part of the title.
      const input = panel.getByTestId('admin-related-search-input');
      const maxLength = Number(await input.getAttribute('maxlength'));
      expect(maxLength).toBeGreaterThan(0);
      expect(b.title.length).toBeGreaterThan(maxLength);
      await input.fill(b.title);
      await expect(input).toHaveValue(b.title.slice(0, maxLength));
      await panel.getByTestId('admin-related-search-submit').click();
      // Asked, and failed (after the client's retries): the panel says so.
      await expect(panel.getByRole('alert')).toContainText(copy.errUnknown);
      // 찾기 again on the same text asks again, and finds B.
      searchDown = false;
      await panel.getByTestId('admin-related-search-submit').click();
      await expect(panel.getByTestId(`admin-related-result-${b.id}`)).toContainText(b.title);
      await expect(panel.getByRole('alert')).toHaveCount(0);

      // Linked while A's list cannot be re-read: the row the write answered stays, under a notice
      // with 다시 시도, and 다시 시도 takes the notice away once the list reads again.
      let linksDown = true;
      const isLinks = (url: URL) => url.pathname === `/api/v1/admin/markets/${a.id}/related`;
      await adminPage.route(isLinks, (route) =>
        linksDown && route.request().method() === 'GET' ? route.fulfill(failed) : route.continue(),
      );
      await panel.getByTestId(`admin-related-link-${b.id}`).click();
      await expect(adminPage.getByText(copy.adminRelatedLinked)).toBeVisible();
      const stale = panel.getByTestId('admin-related-stale');
      await expect(stale).toContainText(copy.adminMarketRefreshFailed);
      // A warning, drawn yellow on the admin screens too (owner decision 2026-10-18, third round).
      await expectYellowWarning(stale);
      await expect(panel.getByTestId(`admin-related-${b.id}`)).toContainText(b.title);
      linksDown = false;
      await stale.getByRole('button', { name: copy.retry }).click();
      await expect(stale).toHaveCount(0);
      await expect(panel.getByTestId(`admin-related-${b.id}`)).toContainText(b.title);
    } finally {
      await adminContext.close();
    }
  });

  test('md의 가장 좁은 폭에서도 카드가 섹션 안에 들어가 옆으로 넘치지 않는다', async ({
    admin,
    page,
  }) => {
    // At 768px the section column is about 368px — about one 360px tile, and narrower where a
    // scrollbar takes its width — so the grid's track gives way to the column rather than run out
    // of it (MARKET_GRID_COLUMNS).
    await page.setViewportSize({ width: 768, height: 1024 });
    const a = await createOpenMarket(admin);
    const b = await createOpenMarket(admin);
    await linkThroughApi(admin, a.id, b.id);
    await page.goto(`/markets/${a.slug}`);
    const cardB = card(page, b.id);
    await expect(cardB).toBeVisible();
    const [section, tile] = await Promise.all([related(page).boundingBox(), cardB.boundingBox()]);
    if (section === null || tile === null) throw new Error('no box');
    expect(tile.x).toBeGreaterThanOrEqual(section.x);
    expect(tile.x + tile.width).toBeLessThanOrEqual(section.x + section.width);
    const width = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(width.scroll).toBeLessThanOrEqual(width.client);
  });

  test('관련 시장 카드는 홈의 카드처럼 실시간으로 바뀐다: 연결한 시장의 마감이 리프레시 없이 카드에 닿는다', async ({
    admin,
    page,
  }) => {
    const a = await createOpenMarket(admin);
    const b = await createOpenMarket(admin);
    await linkThroughApi(admin, a.id, b.id);

    // Armed before the navigation: the card joins B's room, as the home grid's cards do.
    const joined = subscribed(page, b.id);
    await page.goto(`/markets/${a.slug}`);
    await joined;
    const cardB = card(page, b.id);
    await expect(cardB).toBeVisible();
    await expect(cardB).not.toContainText(copy.marketStatusClosed);

    await closeMarket(admin, b.id);
    await expect(cardB).toContainText(copy.marketStatusClosed, { timeout: REALTIME_BUDGET_MS });
    // A closed market is still shown (ADR-0061 decision 1, item 19): after a reload too.
    await page.reload();
    await expect(card(page, b.id)).toContainText(copy.marketStatusClosed);
  });
});
