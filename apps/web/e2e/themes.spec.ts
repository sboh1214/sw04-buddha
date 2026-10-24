import { type APIRequestContext, type Page } from '@playwright/test';
import { copy } from '../src/copy';
import {
  adminAccount,
  closeMarket,
  createDraftMarket,
  createOpenMarket,
  expect,
  freshTag,
  signIn,
  subscribed,
  test,
} from './helpers';

/**
 * 테마 (#81, ADR-0088; owner decisions in ADR-0069 decision 4, the #81 rows, and of 2026-10-19,
 * two rounds): an admin makes a theme at an address of their choosing — a date outside 2000 to
 * 2100 is refused on the form — puts a draft in it, which does not make it publishable, then two
 * open markets — a theme is published only with a market in it that is not a draft — writes a
 * notice and publishes it; a signed-out visitor then finds it on the list page (`/themes`), on the
 * explore home's 진행 중인 테마 and on the detail of a market in it, the link saying the theme's
 * status — each in the server's HTML too — and opens its page at the slug, 시장 탐색 lit: the
 * period in Korean dates and its status, the introduction and the notice with their addresses
 * linked, and the two open markets as the home's cards (the draft has none). One market is judged
 * while the visitor is on the page:
 * its result appears there without a reload, YES and a link to the market. The address cannot
 * change after the publish, and an unsaved one typed before it is dropped. The admin renames the
 * theme, edits the notice (수정됨), hides it and shows it again, and takes the judged market out;
 * the page follows each. Unpublishing takes the theme off every one of those places, and its page
 * is a 404.
 *
 * The status boundaries, the list's order and the voided markets are the API's integration
 * tests' (themes.controller.test.ts): no product path voids a market yet (M8), and the order is
 * checked against themes of chosen dates where no other spec's themes share the list, which the
 * e2e database — shared by every spec and kept between runs — cannot promise.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** The Korean date `days` from today, `YYYY-MM-DD`: what the admin's date inputs take. */
function koreanDate(days: number): string {
  return new Date(Date.now() + KST_OFFSET_MS + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The period as the owner asked it written, '10월 20일 ~ 11월 3일' (2026-10-19), with the year on
 * the start when a date is not this year's and on the end too when its year is another (the
 * second round) — the page's own rule (`formatThemePeriod`), restated as the reader sees it. This
 * spec's period is yesterday to today, so it carries years only around a Korean New Year.
 */
function writtenPeriod({ startDate, endDate }: { startDate: string; endDate: string }): string {
  const thisYear = Number(koreanDate(0).slice(0, 4));
  const parts = (date: string) => date.split('-').map(Number) as [number, number, number];
  const [startYear, startMonth, startDay] = parts(startDate);
  const [endYear, endMonth, endDay] = parts(endDate);
  const write = (year: number, month: number, day: number, withYear: boolean) =>
    `${withYear ? `${String(year)}년 ` : ''}${String(month)}월 ${String(day)}일`;
  return `${write(startYear, startMonth, startDay, startYear !== thisYear || endYear !== thisYear)} ~ ${write(endYear, endMonth, endDay, endYear !== startYear)}`;
}

/**
 * 시장 탐색 is the current area in the header's row 1 and in the tab bar — both in the DOM at every
 * width, one of them hidden — on the theme pages (owner decision 2026-10-19, second round), with
 * no category row (that is the home's and the market details', as on the search screen).
 */
async function expectExploreLit(page: Page): Promise<void> {
  for (const list of [
    page.locator(`header nav[aria-label="${copy.navPrimary}"] a`),
    page.locator('[data-testid="bottom-tabs"] a'),
  ]) {
    await expect(list.filter({ hasText: copy.navExplore })).toHaveAttribute('aria-current', 'page');
    await expect(list.and(page.locator('[aria-current="page"]'))).toHaveCount(1);
  }
  await expect(page.getByTestId('nav-categories')).toHaveCount(0);
}

/**
 * Lets the admin page's toasts go before its next press. A toast pauses while the pointer rests
 * on the stack, and the stack — two refused publishes, three markets put in, a notice and the
 * publish — grows over the button the next step presses (on a phone over most of the screen; how
 * far down that button sits depends on everything above it, the admin menu's rows among them), so
 * the pointer left on it by the last press would hold them there for good and the press would
 * wait on them. Every press that comes right after toasts goes through here.
 */
async function letToastsGo(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-scope="toast"][data-part="root"]')).toHaveCount(0);
}

/** The public page's status code, as a signed-out visitor opens it. */
async function pageStatus(request: APIRequestContext, path: string): Promise<number> {
  return (await request.get(path)).status();
}

const themeCard = (page: Page, id: string) => page.getByTestId(`theme-card-${id}`);

test.describe('테마', () => {
  test('관리자가 시장 둘로 테마를 만들어 공개하면 목록·홈·시장 상세에서 보이고, 비공개로 돌리면 사라진다', async ({
    admin,
    browser,
    page,
    request,
  }) => {
    // One group in both titles, so the admin's search finds the two of them and nothing else.
    const group = freshTag();
    const a = await createOpenMarket(admin, { group });
    const b = await createOpenMarket(admin, { group });
    // A draft: on no public page, and so no market a publish counts (owner decision 2026-10-19,
    // second round).
    const draft = await createDraftMarket(admin, { group });
    const slug = `e2e-theme-${group}`;
    const name = `E2E 테마 ${group}`;
    const renamed = `${name} 고침`;
    // On since yesterday and ending today (KST), both days in the period: 진행 중, and the ongoing
    // theme that ends soonest, so the home's few cards hold it whatever else is on.
    const period = { startDate: koreanDate(-1), endDate: koreanDate(0) };
    const noticeUrl = `https://example.com/e2e/${group}`;
    const introUrl = `https://example.com/e2e/intro-${group}`;
    // The theme's id, read off its admin detail's address, for the checks after the admin leaves.
    let createdId: string | undefined;

    const adminContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);

      // --- 테마 만들기, from the menu: the address, the name, the introduction and the dates.
      await adminPage.goto('/admin/markets');
      await adminPage
        .getByTestId('admin-nav')
        .getByRole('link', { name: copy.adminThemes, exact: true })
        .click();
      await expect(adminPage).toHaveURL(/\/admin\/themes$/);
      await adminPage.getByTestId('theme-slug').fill(slug);
      await adminPage.getByTestId('theme-name-input').fill(name);
      await adminPage
        .getByTestId('theme-intro-input')
        .fill(`첫 줄 ${group}\n둘째 줄은 ${introUrl} 에 있습니다.`);
      // A date before 2000 is the form's to refuse, in the range's words (owner decision
      // 2026-10-19, second round); nothing is made.
      await adminPage.getByTestId('theme-start-date').fill('1999-12-31');
      await adminPage.getByTestId('theme-end-date').fill(period.endDate);
      await adminPage.getByTestId('theme-create').click();
      await expect(adminPage.getByText(copy.errThemeDateRange)).toBeVisible();
      await expect(adminPage).toHaveURL(/\/admin\/themes$/);
      await adminPage.getByTestId('theme-start-date').fill(period.startDate);
      // The Korean-date hint is read with both date fields, not only seen under them.
      const hintId = await adminPage.getByTestId('theme-period-hint').getAttribute('id');
      expect(hintId).toBeTruthy();
      for (const field of ['theme-start-date', 'theme-end-date']) {
        await expect(adminPage.getByTestId(field)).toHaveAttribute('aria-describedby', hintId!);
      }
      await adminPage.getByTestId('theme-create').click();
      await expect(adminPage.getByText(copy.adminThemeCreated)).toBeVisible();
      await expect(adminPage).toHaveURL(/\/admin\/themes\/[0-9a-f-]{36}$/);
      const themeId = adminPage.url().split('/').at(-1) ?? '';
      createdId = themeId;
      await expect(adminPage.getByTestId('admin-theme-name')).toHaveText(name);
      await expect(adminPage.getByTestId('admin-theme-published')).toHaveText(
        copy.adminThemeUnpublished,
      );
      // Not public before it is published.
      expect(await pageStatus(request, `/themes/${slug}`)).toBe(404);

      // --- an empty theme is not published (owner decision 2026-10-19), as 공개하기 says beside it.
      await expect(adminPage.getByTestId('theme-publish-hint')).toHaveText(
        copy.adminThemePublishHint,
      );
      // …and read with 공개하기 (its `aria-describedby`), not only seen beside it.
      await expect(adminPage.getByTestId('theme-publish')).toHaveAccessibleDescription(
        copy.adminThemePublishHint,
      );
      const publishOnce = async () => {
        await letToastsGo(adminPage);
        const answer = adminPage.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            response.url().endsWith(`/api/v1/admin/themes/${themeId}/publish`),
        );
        await adminPage.getByTestId('theme-publish').click();
        return (await answer).status();
      };
      expect(await publishOnce()).toBe(400);
      await expect(adminPage.getByText(copy.adminThemePublishNeedsMarket).first()).toBeVisible();
      await expect(adminPage.getByTestId('admin-theme-published')).toHaveText(
        copy.adminThemeUnpublished,
      );

      // --- the draft, found by title and put in: still not published — a draft does not count
      // (the second round).
      const markets = adminPage.getByTestId('admin-theme-markets');
      await expect(markets.getByTestId('admin-theme-markets-empty')).toHaveText(
        copy.adminThemeMarketsEmpty,
      );
      await letToastsGo(adminPage);
      await markets.getByTestId('admin-theme-market-search-input').fill(group);
      await markets.getByTestId('admin-theme-market-search-submit').click();
      await markets.getByTestId(`admin-theme-market-link-${draft.id}`).click();
      await expect(markets.getByTestId(`admin-theme-market-${draft.id}`)).toContainText(
        draft.title,
      );
      expect(await publishOnce()).toBe(400);
      await expect(adminPage.getByText(copy.adminThemePublishNeedsMarket).first()).toBeVisible();
      await expect(adminPage.getByTestId('admin-theme-published')).toHaveText(
        copy.adminThemeUnpublished,
      );

      // --- the two open markets, put in with a click each.
      for (const market of [a, b]) {
        await letToastsGo(adminPage);
        await markets.getByTestId(`admin-theme-market-link-${market.id}`).click();
        await expect(markets.getByTestId(`admin-theme-market-${market.id}`)).toContainText(
          market.title,
        );
        await expect(markets.getByTestId(`admin-theme-market-in-${market.id}`)).toHaveText(
          copy.adminThemeMarketAlreadyLinked,
        );
      }

      // --- a notice, plain text with an address in it.
      const notices = adminPage.getByTestId('admin-theme-notices');
      await letToastsGo(adminPage);
      await notices.getByTestId('theme-notice-new-title').fill(`일정 안내 ${group}`);
      await notices
        .getByTestId('theme-notice-new-body')
        .fill(`자세한 일정은 ${noticeUrl} 에서 봅니다.`);
      await notices.getByTestId('theme-notice-new-submit').click();
      await expect(adminPage.getByText(copy.adminThemeNoticeCreated)).toBeVisible();
      await expect(notices.getByText(`일정 안내 ${group}`)).toBeVisible();

      // --- publish: now it has markets. A new address typed and not saved is not the theme's.
      await letToastsGo(adminPage);
      await adminPage.getByTestId('theme-slug').fill(`${slug}-unsaved`);
      await expect(adminPage.getByTestId('theme-save')).toBeEnabled();
      expect(await publishOnce()).toBe(200);
      await expect(adminPage.getByText(copy.adminThemePublishDone)).toBeVisible();
      await expect(adminPage.getByTestId('theme-publish-hint')).toHaveCount(0);
      await expect(adminPage.getByTestId('admin-theme-published')).toHaveText(
        copy.adminThemePublished,
      );
      // The address is fixed from the first publish on (owner decision 2026-10-19), and the
      // field shows the real one: the unsaved edit is dropped, so nothing is left to save.
      await expect(adminPage.getByTestId('theme-slug')).toHaveAttribute('readonly', '');
      await expect(adminPage.getByTestId('theme-slug')).toHaveValue(slug);
      await expect(adminPage.getByTestId('theme-save')).toBeDisabled();
      await expect(adminPage.getByText(copy.adminThemeSlugFixed)).toBeVisible();

      // --- the list page, signed out, in the server's HTML too.
      const listHtml = await (await request.get('/themes')).text();
      expect(listHtml).toContain(name);
      await page.goto('/themes');
      await expectExploreLit(page);
      const card = themeCard(page, themeId);
      await expect(card).toContainText(name);
      await expect(card).toContainText(copy.themeStatusOngoing);
      await expect(page.getByTestId(`theme-card-period-${themeId}`)).toHaveText(
        writtenPeriod(period),
      );

      // --- the theme's page at its slug: period, status, introduction, notice, the two cards.
      await card.getByRole('link', { name }).click();
      await expect(page).toHaveURL(new RegExp(`/themes/${slug}$`));
      await expect(page.getByTestId('theme-name')).toHaveText(name);
      await expect(page.getByTestId('theme-status')).toHaveText(copy.themeStatusOngoing);
      await expect(page.getByTestId('theme-period')).toHaveText(writtenPeriod(period));
      await expectExploreLit(page);
      const intro = page.getByTestId('theme-intro');
      await expect(intro).toContainText(`첫 줄 ${group}`);
      // The introduction's address is a link out too (owner decision 2026-10-19, second round).
      const introLink = intro.getByRole('link', { name: introUrl });
      await expect(introLink).toHaveAttribute('href', introUrl);
      await expect(introLink).toHaveAttribute('target', '_blank');
      const notice = page.getByTestId('theme-notices').getByRole('article');
      await expect(notice).toHaveCount(1);
      await expect(notice.getByRole('heading', { level: 4 })).toHaveText(`일정 안내 ${group}`);
      // The address is a link out, opening apart from the page.
      const link = notice.getByRole('link', { name: noticeUrl });
      await expect(link).toHaveAttribute('href', noticeUrl);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(notice.getByText(copy.themeNoticeEdited)).toHaveCount(0);
      // The participation links are the markets' cards, each opening its market.
      const grid = page.getByTestId('theme-markets');
      for (const market of [a, b]) {
        await expect(
          grid.getByTestId(`market-card-${market.id}`).getByRole('link', { name: market.title }),
        ).toHaveAttribute('href', `/markets/${market.slug}`);
      }
      // The draft in it has no card: no public page shows a draft.
      await expect(grid.getByTestId(`market-card-${draft.id}`)).toHaveCount(0);
      // No market has a result yet.
      await expect(page.getByTestId('theme-results-empty')).toHaveText(copy.themeResultsEmpty);
      const pageHtml = await (await request.get(`/themes/${slug}`)).text();
      expect(pageHtml).toContain(name);
      expect(pageHtml).toContain(`data-testid="market-card-${a.id}"`);

      // --- b is judged YES while the visitor is on the page: its result appears without a
      // reload (the card's `market:status` restarts the results list), linked to the market.
      const live = subscribed(page, b.id);
      await page.goto(`/themes/${slug}`);
      await live;
      await closeMarket(admin, b.id);
      const judged = await admin.post(`/api/v1/admin/markets/${b.id}/resolve`, {
        data: { result: 'YES' },
      });
      expect(judged.status(), await judged.text()).toBe(200);
      const results = page.getByTestId('theme-results');
      await expect(results.getByTestId(`theme-result-outcome-${b.id}`)).toHaveText(copy.yes);
      await expect(
        results.getByTestId(`theme-result-${b.id}`).getByRole('link', { name: b.title }),
      ).toHaveAttribute('href', `/markets/${b.slug}`);
      await expect(results.getByTestId(`theme-result-${a.id}`)).toHaveCount(0);
      await expect(results.getByTestId('theme-results-empty')).toHaveCount(0);
      // A judged market keeps its card (the 판정 is worked off to 정산 by the worker meanwhile, so
      // the status label is left unasserted), and the server's HTML has the row too.
      await expect(grid.getByTestId(`market-card-${b.id}`)).toBeVisible();
      expect(await (await request.get(`/themes/${slug}`)).text()).toContain(
        `data-testid="theme-result-${b.id}"`,
      );

      // --- the explore home's 진행 중인 테마, on 전체, and not under a category. (When none is
      // ongoing the row is the upcoming ones under 예정된 테마, and with neither no card but 모든
      // 테마 — `homeThemesRow`'s unit tests and the row's render test, app/home-themes.test.tsx:
      // the e2e database's other themes are not this spec's to choose.)
      await page.goto('/');
      const home = page.getByTestId('home-themes');
      await expect(home.getByRole('heading', { level: 2 })).toHaveText(copy.homeThemesOngoing);
      await expect(themeCard(page, themeId)).toBeVisible();
      await expect(home.getByTestId('home-themes-all')).toHaveAttribute('href', '/themes');
      // The server reads the home's themes into its HTML, so the check after the unpublish below
      // that they are gone from it means something.
      expect(await (await request.get('/')).text()).toContain(name);
      await page.goto(`/?category=${a.categorySlug}`);
      await expect(page.getByTestId('markets-grid')).toBeVisible();
      await expect(page.getByTestId('home-themes')).toHaveCount(0);

      // --- the detail of a market in it links back to the theme, saying its status (owner
      // decision 2026-10-19, second round). (An ended theme's link, '· 종료', is the render
      // test's, app/markets/[slug]/market-themes.test.tsx.)
      await page.goto(`/markets/${a.slug}`);
      const themeLink = page.getByTestId(`market-theme-${themeId}`);
      await expect(themeLink).toHaveAttribute('href', `/themes/${slug}`);
      await expect(themeLink).toHaveAccessibleName(`${name} · ${copy.themeStatusOngoing}`);
      await expect(themeLink).toContainText(name);
      await expect(themeLink).toContainText(copy.themeStatusOngoing);
      // One label: the status at the name's size and line height, not the page's 16px beside the
      // tag's 12px name.
      const textBox = (testId: string) =>
        page.getByTestId(testId).evaluate((element) => {
          const style = getComputedStyle(element);
          return { fontSize: style.fontSize, lineHeight: style.lineHeight };
        });
      expect(await textBox(`market-theme-status-${themeId}`)).toEqual(
        await textBox(`market-theme-name-${themeId}`),
      );
      // In the server's HTML too: the link, and its name with the status.
      const detailHtml = await (await request.get(`/markets/${a.slug}`)).text();
      expect(detailHtml).toContain(`data-testid="market-theme-${themeId}"`);
      expect(detailHtml).toContain(`aria-label="${name} · ${copy.themeStatusOngoing}"`);

      // --- renamed after publishing (editable at any time): the list says the new name.
      await letToastsGo(adminPage);
      await adminPage.getByTestId('theme-name-input').fill(renamed);
      await adminPage.getByTestId('theme-save').click();
      await expect(adminPage.getByText(copy.adminThemeSaved)).toBeVisible();
      await expect(adminPage.getByTestId('admin-theme-name')).toHaveText(renamed);
      await expect(adminPage.getByTestId('theme-save')).toBeDisabled();
      await page.goto('/themes');
      await expect(themeCard(page, themeId)).toContainText(renamed);

      // --- an edited notice says 수정됨 (owner decision 2026-10-19).
      await letToastsGo(adminPage);
      await notices.getByRole('button', { name: copy.adminThemeNoticeEdit }).click();
      const editForm = notices.locator('form[data-testid^="theme-notice-edit-form-"]');
      await editForm.locator('textarea').fill(`고친 일정은 ${noticeUrl} 에서 봅니다.`);
      await editForm.getByRole('button', { name: copy.save }).click();
      await expect(adminPage.getByText(copy.adminThemeNoticeSaved)).toBeVisible();
      await page.goto(`/themes/${slug}`);
      await expect(notice.getByText(copy.themeNoticeEdited)).toBeVisible();
      await expect(notice).toContainText('고친 일정은');

      // --- hidden behind its confirmation, off the page and kept for the admin; shown again.
      await letToastsGo(adminPage);
      await notices.getByRole('button', { name: copy.adminThemeNoticeHide }).click();
      await adminPage.getByTestId('admin-theme-notice-hide-confirm').click();
      await expect(adminPage.getByText(copy.adminThemeNoticeHidden)).toBeVisible();
      await expect(notices.getByText(copy.adminThemeNoticeHiddenTag)).toBeVisible();
      await page.goto(`/themes/${slug}`);
      await expect(notice).toHaveCount(0);
      await expect(page.getByTestId('theme-notices-empty')).toHaveText(copy.themeNoticesEmpty);
      await letToastsGo(adminPage);
      await notices.getByRole('button', { name: copy.adminThemeNoticeShow }).click();
      await expect(adminPage.getByText(copy.adminThemeNoticeShown)).toBeVisible();
      await expect(notices.getByText(copy.adminThemeNoticeHiddenTag)).toHaveCount(0);
      await page.goto(`/themes/${slug}`);
      await expect(notice).toHaveCount(1);
      await expect(notice).toContainText('고친 일정은');

      // --- b taken out behind its confirmation: its card and its result leave the page, a's
      // card stays (and keeps the theme publishable — it stays published either way).
      await letToastsGo(adminPage);
      await markets.getByTestId(`admin-theme-market-unlink-${b.id}`).click();
      await adminPage.getByTestId('admin-theme-market-unlink-confirm').click();
      await expect(adminPage.getByText(copy.adminThemeMarketUnlinked)).toBeVisible();
      await expect(markets.getByTestId(`admin-theme-market-${b.id}`)).toHaveCount(0);
      await page.goto(`/themes/${slug}`);
      await expect(grid.getByTestId(`market-card-${a.id}`)).toBeVisible();
      await expect(grid.getByTestId(`market-card-${b.id}`)).toHaveCount(0);
      await expect(page.getByTestId(`theme-result-${b.id}`)).toHaveCount(0);
      await expect(page.getByTestId('theme-results-empty')).toHaveText(copy.themeResultsEmpty);

      // --- unpublish, behind its confirmation: off every public place, the page a 404.
      await letToastsGo(adminPage);
      await adminPage.getByTestId('theme-unpublish').click();
      await expect(adminPage.getByText(copy.adminThemeUnpublishBody)).toBeVisible();
      await adminPage.getByTestId('theme-unpublish-dialog-confirm').click();
      await expect(adminPage.getByText(copy.adminThemeUnpublishDone)).toBeVisible();
      await expect(adminPage.getByTestId('admin-theme-published')).toHaveText(
        copy.adminThemeUnpublished,
      );
    } finally {
      await adminContext.close();
    }

    expect(await pageStatus(request, `/themes/${slug}`)).toBe(404);
    await page.goto('/themes');
    await expect(page.getByTestId('theme-list')).toBeVisible();
    await expect(themeCard(page, createdId ?? '')).toHaveCount(0);
    // `name` is the start of `renamed`, so these say neither is there.
    expect(await (await request.get('/themes')).text()).not.toContain(name);
    expect(await (await request.get('/')).text()).not.toContain(name);
    expect(await (await request.get(`/markets/${a.slug}`)).text()).not.toContain(
      `data-testid="market-theme-${createdId ?? ''}"`,
    );
    await page.goto(`/markets/${a.slug}`);
    await expect(page.getByTestId('market-detail')).toBeVisible();
    await expect(page.getByTestId('market-themes')).toHaveCount(0);
  });
});
