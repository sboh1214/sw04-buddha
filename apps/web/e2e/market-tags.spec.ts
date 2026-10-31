import { type APIResponse, type Page } from '@playwright/test';
import type { AdminMarket } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  adminAccount,
  createDraftMarket,
  createOpenMarket,
  expect,
  freshEmail,
  freshTag,
  signIn,
  signUp,
  test,
} from './helpers';

/**
 * 태그 (#17, ADR-0093 decision 2 #172 item 2; ADR-0061 result 3 and ADR-0066 result 3 for the
 * search): an operator gives a market its tags on the market form — typed and added with Enter or
 * 넣기, a comma-separated list at once, a second name of one tag refused on the spot — and a name
 * some tag already has in another case is linked to that tag in its first spelling. A draft may be
 * made without everything 열기 needs: its detail says what is missing (the open-items check: 정산
 * 규칙 · 카테고리 · 태그 1~5개), 열기 is refused naming it, and once it is filled the notice goes and
 * 열기 opens it. An open market cannot be edited down to no tags. A reader then sees the tags on
 * the detail as '#이름' chips in the order entered, each opening that tag's search — which lists
 * the market although its title holds no such word, and which, opened by its address, is not
 * recorded in the reader's recent searches (ADR-0066). The public search matches a tag's whole
 * name in any case, never a part of it.
 *
 * The rules themselves (the name pattern, the count, the order kept, the first spelling winning)
 * are unit-tested on both sides (lib/market-form.test.ts, admin-markets.controller.test.ts); this
 * spec follows them through the screens.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `days` from now as the admin's `datetime-local` takes it, in KST (`YYYY-MM-DDTHH:mm`). */
function kstLocalIn(days: number): string {
  return new Date(Date.now() + KST_OFFSET_MS + days * DAY_MS).toISOString().slice(0, 16);
}

/** `{ data }` out of the success envelope, with the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} -> ${String(response.status())} ${body}`).toBe(true);
  return (JSON.parse(body) as { data: T }).data;
}

/**
 * Lets the page's toasts go before the next press (themes.spec.ts's `letToastsGo`): a toast pauses
 * while the pointer rests on the stack, and on a phone the stack covers the form's buttons.
 */
async function letToastsGo(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-scope="toast"][data-part="root"]')).toHaveCount(0);
}

const card = (page: Page, id: string) => page.getByTestId(`market-card-${id}`);
const results = (page: Page) => page.getByTestId('search-results');

test.describe('태그', () => {
  test('관리자가 화면에서 태그 둘로 초안을 만들고, 빠진 항목을 채워 열면, 회원이 상세의 #태그를 눌러 그 태그의 검색에서 시장을 찾고 그 검색은 기록되지 않는다', async ({
    admin,
    browser,
    page,
  }) => {
    // A tag that exists before this market, in the spelling it was first made with: the seed's
    // 'CPI' — made here when the database has none, so the spec does not lean on the seed's
    // markets. The operator types it in the other case.
    const holder = await createDraftMarket(admin, { tags: ['CPI'] });
    const stored =
      (await dataOf<AdminMarket>(await admin.get(`/api/v1/admin/markets/${holder.id}`))).tags[0] ??
      '';
    expect(stored.toLowerCase()).toBe('cpi');
    const typed = stored === stored.toLowerCase() ? stored.toUpperCase() : stored.toLowerCase();
    // A tag of this market alone, which its title does not hold.
    const own = `t${freshTag()}`;
    const title = `E2E 태그 시장 ${freshTag()}`;
    expect(title).not.toContain(own);

    // The reader, a member, so a recorded search would show in their recent searches.
    await signUp(page, freshEmail());

    const adminContext = await browser.newContext();
    let marketId: string | undefined;
    try {
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);

      // --- 시장 만들기 with two tags and no rules: a draft may be made without them.
      await adminPage.goto('/admin/markets');
      await expect(adminPage.getByTestId('market-create')).toBeEnabled();
      await adminPage.getByTestId('market-title').fill(title);
      // An ASCII address, as every e2e market has (helpers.ts): `/markets/[slug]` does not reach a
      // slug with Hangul in it yet — the page hands the API its still-encoded segment, encoded
      // again (a defect older than #17, reported apart from it).
      await adminPage.getByTestId('market-slug').fill(`e2e-${own}`);
      const category = adminPage.getByTestId('market-category');
      // A leaf: a top-level category with sub-categories is a group label, not an option.
      const choices = await category
        .locator('option:not([disabled])')
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value).filter(Boolean),
        );
      await category.selectOption(choices[0]!);

      // A pasted list goes in as two names, in its order, each as typed (normalised).
      const box = adminPage.getByTestId('market-tags-input');
      await box.fill(`  ${typed} ,${own}`);
      await box.press('Enter');
      await expect(adminPage.getByTestId('market-tags-list').locator('li')).toHaveText([
        typed,
        own,
      ]);
      await expect(box).toHaveValue('');
      // The same tag in another case is refused on the spot, and stays in the box with why.
      await box.fill(stored);
      await adminPage.getByTestId('market-tags-add').click();
      await expect(adminPage.getByTestId('market-tags-error')).toHaveText(
        copy.errMarketTagDuplicate,
      );
      await expect(box).toHaveValue(stored);
      await expect(adminPage.getByTestId('market-tags-list').locator('li')).toHaveCount(2);
      await box.fill('');
      await expect(adminPage.getByTestId('market-tags-error')).toHaveCount(0);

      await adminPage.getByTestId('market-close-at').fill(kstLocalIn(2));
      const sent = adminPage.waitForRequest(
        (request) =>
          request.method() === 'POST' &&
          new URL(request.url()).pathname === '/api/v1/admin/markets',
      );
      await adminPage.getByTestId('market-create').click();
      expect(((await sent).postDataJSON() as { tags: unknown }).tags).toEqual([typed, own]);
      await expect(adminPage).toHaveURL(/\/admin\/markets\/[0-9a-f-]{36}$/);
      marketId = adminPage.url().split('/').at(-1) ?? '';

      // --- the draft: the existing tag in its first spelling, and what 열기 still needs.
      await expect(adminPage.getByTestId('market-detail-tags')).toHaveText(`${stored}, ${own}`);
      await expect(adminPage.getByTestId('market-tags-list').locator('li')).toHaveText([
        stored,
        own,
      ]);
      await expect(adminPage.getByTestId('market-open-items')).toHaveText(
        `${copy.adminMarketOpenItems}: ${copy.openItemRules}`,
      );
      await letToastsGo(adminPage);
      await adminPage.getByTestId('market-open').click();
      await expect(
        adminPage.getByText(`${copy.errMarketOpenItemsMissing}: ${copy.openItemRules}`, {
          exact: true,
        }),
      ).toBeVisible();
      await expect(adminPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusDraft,
      );

      // --- the rules filled in: the notice goes, and 열기 opens it.
      await adminPage.getByTestId('market-rules').fill(`자동화 테스트의 규칙 ${own}`);
      await letToastsGo(adminPage);
      await adminPage.getByTestId('market-save').click();
      await expect(adminPage.getByText(copy.adminMarketSaved)).toBeVisible();
      await expect(adminPage.getByTestId('market-open-items')).toHaveCount(0);
      await letToastsGo(adminPage);
      await adminPage.getByTestId('market-open').click();
      await expect(adminPage.getByText(copy.adminMarketOpened)).toBeVisible();
      await expect(adminPage.getByTestId('market-detail-status')).toHaveText(copy.marketStatusOpen);
      // No notice on an open market.
      await expect(adminPage.getByTestId('market-open-items')).toHaveCount(0);

      // --- an open market cannot be edited down to no tags: the form refuses, nothing is sent.
      const patches: string[] = [];
      adminPage.on('request', (request) => {
        if (request.method() === 'PATCH') patches.push(request.url());
      });
      await adminPage.getByTestId('market-tags-remove-1').click();
      await adminPage.getByTestId('market-tags-remove-0').click();
      await expect(adminPage.getByTestId('market-tags-list')).toHaveCount(0);
      await letToastsGo(adminPage);
      await adminPage.getByTestId('market-save').click();
      await expect(adminPage.getByTestId('market-tags-error')).toHaveText(copy.errMarketTagsOpen);
      await expect(adminPage.getByTestId('market-edit-confirm')).toHaveCount(0);
      expect(patches).toEqual([]);
    } finally {
      await adminContext.close();
    }

    // --- the reader: the chips in entry order, the stored spelling, each its tag's search.
    if (marketId === undefined) throw new Error('the market was not made');
    const market = await dataOf<AdminMarket>(await admin.get(`/api/v1/admin/markets/${marketId}`));
    expect(market.tags).toEqual([stored, own]);
    const historyWrites: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && path.startsWith('/api/v1/me/search-history')) {
        historyWrites.push(path);
      }
    });
    await page.goto(`/markets/${market.slug}`);
    const chips = page.getByTestId('market-tags').getByRole('link');
    await expect(chips).toHaveText([`#${stored}`, `#${own}`]);
    await expect(page.getByTestId('market-tag-0')).toHaveAttribute(
      'href',
      `/search?q=${encodeURIComponent(stored)}`,
    );
    await page.getByTestId('market-tag-1').click();
    await expect(page).toHaveURL(`/search?q=${own}`);
    // Found by the tag alone: the title holds no such word.
    await expect(results(page).getByRole('article')).toHaveCount(1);
    await expect(card(page, market.id)).toBeVisible();
    await expect(card(page, market.id)).toContainText(title);
    // Opened by its address, the search records nothing (ADR-0066).
    expect(historyWrites).toEqual([]);
    const recent = await dataOf<{ query: string }[]>(
      await page.request.get('/api/v1/me/search-history'),
    );
    expect(recent.map((row) => row.query)).not.toContain(own);
  });

  test('공개 검색은 제목에 없는 태그의 이름 전체로 시장을 찾고, 대소문자는 가리지 않으며, 이름의 일부로는 찾지 않는다', async ({
    admin,
    page,
  }) => {
    const own = `t${freshTag()}`;
    const market = await createOpenMarket(admin, { tags: ['서울', own] });
    expect(market.title).not.toContain(own);

    // The whole name, in another case: the market, and only it.
    await page.goto(`/search?q=${own.toUpperCase()}`);
    await expect(results(page).getByRole('article')).toHaveCount(1);
    await expect(card(page, market.id)).toBeVisible();

    // A part of the name is no tag's name, and no title holds it.
    await page.goto(`/search?q=${own.slice(0, -2)}`);
    await expect(page.getByTestId('markets-empty')).toHaveText(copy.marketsSearchEmpty);

    // The detail draws the tags in the order they were given, the server's HTML too.
    await page.goto(`/markets/${market.slug}`);
    await expect(page.getByTestId('market-tags').getByRole('link')).toHaveText([
      '#서울',
      `#${own}`,
    ]);
    const html = await (await page.request.get(`/markets/${market.slug}`)).text();
    expect(html).toContain(`#${own}`);
  });
});
