import { type Page } from '@playwright/test';
import { copy } from '../src/copy';
import {
  adminAccount,
  createOpenMarket,
  expect,
  freshEmail,
  signIn,
  signUp,
  test,
} from './helpers';

/**
 * 사용자 시간대 (#60 8항, ADR-0061 #60-8, ADR-0063): a member reads absolute times in the zone
 * picked in MY 설정, or the browser's; a marker follows a time only when that zone is not
 * Asia/Seoul; the admin screens stay KST. Both projects run with `timezoneId: 'Asia/Seoul'`
 * (playwright.config.ts), so "follow the browser" is Seoul unless a context says otherwise.
 *
 * The market's close is a day out, so New York reads it as EDT or EST depending on the calendar:
 * the marker is matched as either.
 */

/** `formatInTimeZone`'s style with no marker: what Seoul, and every admin screen, reads. */
const UNMARKED = /^\d{4}\. \d{1,2}\. \d{1,2}\. (오전|오후) \d{1,2}:\d{2}$/;

/** The same with New York's offset after it. */
const NEW_YORK = /^\d{4}\. \d{1,2}\. \d{1,2}\. (오전|오후) \d{1,2}:\d{2} \(GMT-[45]\)$/;

/** Any zone marker, anywhere in a text. */
const ANY_MARKER = /\(GMT/;

/**
 * The settings select's "follow the browser" choice for a browser in `zone`: the zone inside the
 * brackets as every option names one, its IANA name and the Korean name the browser's ICU gives
 * it (owner decision 2026-10-16, `timeZoneLabel`). The Korean words are the engine's, so only
 * their presence is matched.
 */
const followBrowser = (zone: string) =>
  new RegExp(
    `^${copy.timeZoneFollowBrowser} \\(${zone.replace(/[+.]/g, '\\$&')} — [^()]*[가-힣][^()]*\\)$`,
  );

/**
 * Waits until `/me` has answered on this page. Until then the close time is the server's Seoul
 * text, whatever the profile holds — the session and then `/me` arrive only after hydration, and
 * TimeZoneProvider holds Seoul until they have (ADR-0063) — so a check for that text would pass
 * at once and prove nothing. The header's balance chip reads the same `['me']` entry and shows an
 * amount only from then on, so after it the close time is read in the zone the profile holds.
 */
async function profileLoaded(page: Page): Promise<void> {
  await expect(page.getByTestId('balance-chip')).toContainText('Coin');
}

/** React's report of a server/client mismatch: dev "Hydration failed …", production #418/#423/#425. */
const HYDRATION_ERROR = /hydrat|#418|#423|#425/i;

/**
 * The hydration errors `page` reports from now on. A first client render in the visitor's zone
 * would differ from the server's Seoul HTML on every time it prints, so a screen that switches
 * zones must show none (ADR-0063).
 */
function watchHydration(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && HYDRATION_ERROR.test(message.text())) {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    if (HYDRATION_ERROR.test(error.message)) errors.push(error.message);
  });
  return errors;
}

/**
 * Brings the tab back into view while its session read is held, and checks that the close time
 * never left `expected` meanwhile. better-auth refetches the session on every return to the tab
 * and, for a visitor who is signed out, reports it pending again until the answer comes
 * (session-atom.mjs): TimeZoneProvider must hold the zone it settled on rather than drop back to
 * Seoul for that round trip (ADR-0063). Every text the element takes is recorded, so a flip that
 * lasts one render is caught; the held request proves the refetch really ran.
 */
async function staysThroughSessionRefetch(page: Page, expected: RegExp): Promise<void> {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted: () => void = () => undefined;
  const refetched = new Promise<void>((resolve) => {
    intercepted = resolve;
  });
  const isSessionRead = (url: URL) => url.pathname === '/api/auth/get-session';
  await page.route(isSessionRead, async (route) => {
    intercepted();
    await held;
    await route.continue().catch(() => undefined); // the tab may have dropped it meanwhile
  });
  await page.evaluate(() => {
    const element = document.querySelector('[data-testid="market-rules-close-at"]');
    if (!element) throw new Error('no close time on the page');
    const texts: string[] = [];
    Object.assign(window, { closeAtTexts: texts });
    new MutationObserver(() => texts.push(element.textContent ?? '')).observe(element, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    // What better-auth's focus manager listens for (focus-manager.mjs); the page is visible.
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await refetched;
  // Two frames: whatever the pending state renders has been painted before the answer is let go.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const answered = page.waitForResponse((response) => isSessionRead(new URL(response.url())));
  release();
  await answered;
  await page.unroute(isSessionRead);
  const texts = await page.evaluate(
    () => (window as unknown as { closeAtTexts: string[] }).closeAtTexts,
  );
  expect(texts.filter((text) => !expected.test(text))).toEqual([]);
  await expect(page.getByTestId('market-rules-close-at')).toHaveText(expected);
}

test.describe('사용자 시간대', () => {
  test('MY 설정에서 고른 시간대로 마감 시각을 보이고, 브라우저를 따르면 시간대 표시가 사라진다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    await signUp(page, freshEmail());

    // Nothing picked yet: the browser's zone, which is Seoul here, so no marker.
    const closeAt = page.getByTestId('market-rules-close-at');
    await page.goto(`/markets/${market.slug}`);
    await profileLoaded(page);
    await expect(closeAt).toHaveText(UNMARKED);
    const seoulText = (await closeAt.textContent()) ?? '';

    await page.goto('/my/settings');
    const select = page.getByTestId('time-zone-select');
    // "Follow the browser" is the first choice, names the zone it follows, and is what is held.
    await expect(select).toHaveValue('');
    await expect(select.locator('option').first()).toHaveText(followBrowser('Asia/Seoul'));
    // Every IANA zone is listed, by its IANA name (the value) and a Korean name after it, or the
    // name alone where the engine has only an offset; and the longest label does not push the
    // page sideways at 375px.
    expect(await select.locator('option').count()).toBeGreaterThan(300);
    await expect(select.locator('option[value="America/New_York"]')).toHaveText(
      /^America\/New_York — \S*[가-힣]/,
    );
    await expect(select.locator('option[value="Etc/GMT+5"]')).toHaveText('Etc/GMT+5');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await select.selectOption('America/New_York');
    await page.getByTestId('time-zone-save').click();
    await expect(page.getByText(copy.timeZoneSaved)).toBeVisible();

    const hydrationErrors = watchHydration(page);
    await page.goto(`/markets/${market.slug}`);
    await expect(closeAt).toHaveText(NEW_YORK);
    expect(hydrationErrors).toEqual([]);
    // The server's HTML is the same for this member as for anyone: KST, unmarked (ADR-0063). The
    // zone switches only after hydration.
    const html = await (await page.request.get(`/markets/${market.slug}`)).text();
    expect(html).toContain(seoulText);
    expect(html).not.toMatch(ANY_MARKER);

    // The choice is kept, and following the browser again takes the marker away. The first
    // choice still names the BROWSER's zone, not the one in effect now: wait for `/me` first, so
    // a label read from the display zone would already say New York.
    await page.goto('/my/settings');
    await profileLoaded(page);
    await expect(select).toHaveValue('America/New_York');
    await expect(select.locator('option').first()).toHaveText(followBrowser('Asia/Seoul'));
    await select.selectOption({ value: '' });
    await page.getByTestId('time-zone-save').click();
    await expect(page.getByText(copy.timeZoneSaved)).toBeVisible();

    await page.goto(`/markets/${market.slug}`);
    await profileLoaded(page);
    await expect(closeAt).toHaveText(seoulText);
  });

  test('로그인하지 않으면 브라우저 시간대이고, 관리자 화면은 브라우저 시간대와 상관없이 한국 시간이며 시간대를 적지 않는다', async ({
    admin,
    browser,
  }) => {
    const market = await createOpenMarket(admin);
    // The seed admin follows its browser: no zone stored, so the context's zone is the member's.
    // The body names the account it is for (`expectedAccountId`, A-PG-24).
    const adminMe = (await (await admin.get('/api/v1/me')).json()) as { data: { id: string } };
    const cleared = await admin.put('/api/v1/me/time-zone', {
      data: { timeZone: null, expectedAccountId: adminMe.data.id },
    });
    expect(cleared.ok()).toBe(true);
    const detail = (await (await admin.get(`/api/v1/admin/markets/${market.id}`)).json()) as {
      data: { closeAt: string };
    };
    // The 마감 시각 field as KST wall-clock minutes, the way the admin form fills it.
    const kstLocal = new Date(Date.parse(detail.data.closeAt) + 9 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16);

    const context = await browser.newContext({ timezoneId: 'America/New_York' });
    try {
      const page = await context.newPage();
      const hydrationErrors = watchHydration(page);
      const closeAt = page.getByTestId('market-rules-close-at');

      // Signed out (ADR-0061 #60-8: 로그인하지 않았으면 브라우저 시간대): New York, marked, once the
      // header knows nobody is signed in.
      await page.goto(`/markets/${market.slug}`);
      // The header's: the position card below offers its own.
      await expect(page.getByRole('banner').getByRole('link', { name: copy.login })).toBeVisible();
      await expect(closeAt).toHaveText(NEW_YORK);
      expect(hydrationErrors).toEqual([]);
      await staysThroughSessionRefetch(page, NEW_YORK);

      await signIn(page, adminAccount.email, adminAccount.password);

      // "Follow the browser" names this browser's zone, which is New York here.
      await page.goto('/my/settings');
      await profileLoaded(page);
      const select = page.getByTestId('time-zone-select');
      await expect(select).toHaveValue('');
      await expect(select.locator('option').first()).toHaveText(followBrowser('America/New_York'));

      // A member screen in this browser reads New York, marked, switched after hydration...
      await page.goto(`/markets/${market.slug}`);
      await expect(closeAt).toHaveText(NEW_YORK);
      expect(hydrationErrors).toEqual([]);

      // ...and the admin detail reads KST, unmarked: the preview it borrows from the member
      // screens, the datetime-local field, and every other time on the page.
      await page.goto(`/admin/markets/${market.id}`);
      await expect(page.getByTestId('market-preview-rules-close-at')).toHaveText(UNMARKED);
      await expect(page.getByTestId('market-close-at')).toHaveValue(kstLocal);
      await expect(page.locator('main')).not.toContainText(ANY_MARKER);
    } finally {
      await context.close();
    }
  });
});
