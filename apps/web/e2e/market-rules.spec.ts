import { type APIResponse, type Page, type Request } from '@playwright/test';
import { type MarketSource, PROPOSED_CONTRACT_TERMS, formatCoin } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  accountIdOf,
  adminAccount,
  createDraftMarket,
  createOpenMarket,
  detailCopyTestId,
  expect,
  freshTag,
  kstLocalOf,
  signIn,
  test,
} from './helpers';

/**
 * 규칙 항목 (#23, ADR-0097; ADR-0093 decision 2 #172 items 7–10 and decision 3's #23 rows; #173
 * item 9): an operator writes a market's rules on the market form one item at a time — 배경, the
 * YES and NO conditions, the 사건 기한 in KST, the 1차 출처's name and http(s) address, up to three
 * 대체 출처 in priority order (위로·아래로 move one, 추가 is off at three) with the condition for
 * switching to them, the 장기 지연 기한 in days and the 지연·취소·무효 처리 — under which the VOID
 * payout stands fixed. A draft saves with any of them blank or half a source, and its detail names
 * what 열기 still needs, which 열기 refuses naming; an address that is not http(s) and a fallback
 * row left empty are refused under their inputs, the empty row's refusal going as it is typed
 * into. Once every item is filled the notice goes and the market opens, and an open market cannot
 * lose an item it had. 빼기 takes a fallback out, and the last one out takes the switch condition
 * with it: the market saves with no fallback and a blank condition.
 *
 * A visitor who is not signed in reads every item on the detail's 규칙, in the form's order and all
 * of it at once — nothing folds (decision 3 '#23 문장 길이와 표시') — with each source's name a link
 * to its address, the fallbacks numbered, and the one 무효 지급 line every market has; the server's
 * HTML holds the texts too. A market with no fallback reads 없음 there, and has no switch row.
 *
 * The entry rules (lengths, schemes, the 500 and 5,000 limits, the empty source, the merged
 * 'no fallback source' check), RULES_REQUIRED item by item, the `rules_edited` record and the
 * public DTO are the API's integration tests (admin-markets.controller.test.ts,
 * markets.controller.test.ts); the form's rules and mappings and the section's rows are unit-tested
 * (lib/market-form.test.ts, lib/market-admin.test.ts, rules-section.test.tsx). This spec follows
 * them through the screens, at both widths.
 */

const DAY_MS = 24 * 60 * 60 * 1_000;

/** `days` from now as the admin's `datetime-local` takes it, in KST (`YYYY-MM-DDTHH:mm`). */
function kstLocalIn(days: number): string {
  return kstLocalOf(new Date(Date.now() + days * DAY_MS).toISOString());
}

/** `formatInTimeZone`'s style with no marker: Seoul's, which every project's browser is in. */
const UNMARKED = /^\d{4}\. \d{1,2}\. \d{1,2}\. (오전|오후) \d{1,2}:\d{2}$/;

/**
 * The 무효 지급 line (#173 item 9, ADR-0093 result 1): the same for every market, from the terms
 * the market maker prices with — never a per-market input, never a refund (N03 §6).
 */
const VOID_PAYOUT =
  `${copy.rulesVoidPayoutYes} ${formatCoin(PROPOSED_CONTRACT_TERMS.voidPayoutYesCoin)}, ` +
  `${copy.rulesVoidPayoutNo} ${formatCoin(PROPOSED_CONTRACT_TERMS.voidPayoutNoCoin)}` +
  copy.rulesVoidPayoutTail;

/** 규칙's rows in order, as the form's (OPEN_ITEMS) — 배경 is its own section before it. */
const RULE_ROWS = [
  copy.rulesYes,
  copy.rulesNo,
  copy.rulesEventDeadline,
  copy.rulesPrimarySource,
  copy.rulesFallbackSources,
  copy.rulesFallbackCondition,
  copy.rulesLongDelay,
  copy.rulesDelayHandling,
  copy.rulesVoidPayout,
  copy.rulesCloseAt,
];

/** The open-items notice and refusal join item names so (lib/market-admin.ts `openItemList`). */
const openItems = (...labels: string[]) => labels.join(' · ');

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

/** The `PATCH /admin/markets/:id` this page sends next. */
function nextPatch(page: Page, marketId: string): Promise<Request> {
  return page.waitForRequest(
    (request) =>
      request.method() === 'PATCH' &&
      new URL(request.url()).pathname === `/api/v1/admin/markets/${marketId}`,
  );
}

test.describe('규칙 항목', () => {
  test('관리자가 화면에서 규칙 항목을 하나씩 채우고 대체 출처의 순서를 바꿔 열면, 로그인하지 않은 방문자가 상세의 규칙에서 모든 항목을 접힘 없이 차례대로 읽고 출처의 이름은 그 주소로 간다', async ({
    admin,
    browser,
    page,
    request,
  }) => {
    const own = `r${freshTag()}`;
    const title = `E2E 규칙 항목 ${own}`;
    // An ASCII address, as every e2e market has (helpers.ts `createDraftMarket`).
    const slug = `e2e-${own}`;
    const background = `배경 문단 ${own}`;
    const yes = `공식 발표가 사건 기한까지 있으면 YES입니다. ${own}`;
    const no = `사건 기한까지 공식 발표가 없으면 NO입니다. ${own}`;
    const eventDeadline = kstLocalIn(3);
    const primary: MarketSource = {
      name: `1차 출처 ${own}`,
      url: `https://example.com/e2e/${own}/primary`,
    };
    // Entered in this order; 나 is moved up above 가, and 다 comes last.
    const first: MarketSource = {
      name: `대체 출처 가 ${own}`,
      url: `https://example.org/e2e/${own}/a`,
    };
    const second: MarketSource = {
      name: `대체 출처 나 ${own}`,
      url: `https://example.net/e2e/${own}/b`,
    };
    const third: MarketSource = {
      name: `대체 출처 다 ${own}`,
      url: `https://example.com/e2e/${own}/c`,
    };
    const condition = `1차 출처에 발표가 없으면 대체 출처를 순서대로 확인합니다. ${own}`;
    const delayHandling =
      `장기 지연 기한까지 판정하지 못하면 무효로 판정합니다. ` +
      `사건이 취소되거나 연기되면 무효입니다. ${own}`;

    const adminContext = await browser.newContext();
    // The 사건 기한 as the admin detail prints it in KST: what a reader in Seoul reads too.
    let deadlineText: string | undefined;
    try {
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      // Every market save this page sends, to prove the form's refusals send none.
      const patches: string[] = [];
      adminPage.on('request', (sent) => {
        const path = new URL(sent.url()).pathname;
        if (sent.method() === 'PATCH' && path.startsWith('/api/v1/admin/markets/')) {
          patches.push(path);
        }
      });

      // --- 시장 만들기: the rule items are one group after the question, in OPEN_ITEMS order, with
      // no fallback ('없음') and so no switch condition yet, and the VOID line fixed under them.
      await adminPage.goto('/admin/markets');
      await expect(adminPage.getByTestId('market-create')).toBeEnabled();
      const group = adminPage.getByTestId('market-rule-items');
      expect(
        await group
          .locator('input, textarea')
          .evaluateAll((inputs) => inputs.map((input) => input.getAttribute('data-testid'))),
      ).toEqual([
        'market-description',
        'market-yes-condition',
        'market-no-condition',
        'market-event-deadline',
        'market-primary-source-name',
        'market-primary-source-url',
        'market-long-delay-days',
        'market-delay-handling',
      ]);
      await expect(adminPage.getByTestId('market-fallback-none')).toHaveText(
        copy.adminMarketFallbackNone,
      );
      await expect(adminPage.getByTestId('market-fallback-condition')).toHaveCount(0);
      await expect(adminPage.getByTestId('market-void-payout')).toHaveText(
        `${copy.rulesVoidPayout} ${VOID_PAYOUT}`,
      );

      // A draft with the question, 배경 and the YES 조건 alone of its rule items: it may be made so.
      await adminPage.getByTestId('market-title').fill(title);
      await adminPage.getByTestId('market-slug').fill(slug);
      await adminPage.getByTestId('market-description').fill(`  ${background}  `);
      await adminPage.getByTestId('market-yes-condition').fill(yes);
      const category = adminPage.getByTestId('market-category');
      // A leaf: a top-level category with sub-categories is a group label, not an option.
      const choices = await category
        .locator('option:not([disabled])')
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value).filter(Boolean),
        );
      await category.selectOption(choices[0]!);
      await adminPage.getByTestId('market-tags-input').fill(own);
      await adminPage.getByTestId('market-tags-input').press('Enter');
      await adminPage.getByTestId('market-close-at').fill(kstLocalIn(2));
      const created = adminPage.waitForRequest(
        (sent) =>
          sent.method() === 'POST' && new URL(sent.url()).pathname === '/api/v1/admin/markets',
      );
      await adminPage.getByTestId('market-create').click();
      // Every rule item goes, the blank ones as blank (trimmed, null, none).
      expect((await created).postDataJSON()).toMatchObject({
        description: background,
        yesCondition: yes,
        noCondition: '',
        eventDeadline: null,
        primarySource: null,
        fallbackSources: [],
        fallbackCondition: '',
        longDelayDays: null,
        delayHandling: '',
      });
      await expect(adminPage).toHaveURL(/\/admin\/markets\/[0-9a-f-]{36}$/);
      const marketId = adminPage.url().split('/').at(-1) ?? '';

      // --- the draft names what 열기 still needs, and 열기 is refused naming the same.
      const missing = openItems(
        copy.openItemNoCondition,
        copy.openItemEventDeadline,
        copy.openItemPrimarySource,
        copy.openItemLongDelayDays,
        copy.openItemDelayHandling,
      );
      const notice = adminPage.getByTestId('market-open-items');
      await expect(notice).toHaveText(`${copy.adminMarketOpenItems}: ${missing}`);
      await letToastsGo(adminPage);
      await adminPage.getByTestId('market-open').click();
      await expect(
        adminPage.getByText(`${copy.errMarketOpenItemsMissing}: ${missing}`, { exact: true }),
      ).toBeVisible();
      await expect(adminPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusDraft,
      );

      // --- more of it, half a source included: the 1차 출처's name with no address, and two
      // fallbacks, the second a name alone. The switch condition shows once there is a fallback.
      await letToastsGo(adminPage);
      await adminPage.getByTestId('market-no-condition').fill(no);
      await adminPage.getByTestId('market-event-deadline').fill(eventDeadline);
      await adminPage.getByTestId('market-primary-source-name').fill(primary.name);
      await adminPage.getByTestId('market-fallback-add').click();
      await expect(adminPage.getByTestId('market-fallback-none')).toHaveCount(0);
      await expect(adminPage.getByTestId('market-fallback-condition')).toBeVisible();
      await adminPage.getByTestId('market-fallback-0-name').fill(first.name);
      await adminPage.getByTestId('market-fallback-0-url').fill(first.url);
      await adminPage.getByTestId('market-fallback-add').click();
      await adminPage.getByTestId('market-fallback-1-name').fill(second.name);
      await adminPage.getByTestId('market-save').click();
      await expect(adminPage.getByText(copy.adminMarketSaved)).toBeVisible();
      await expect(notice).toHaveText(
        `${copy.adminMarketOpenItems}: ${openItems(
          copy.openItemPrimarySource,
          copy.openItemFallbackSources,
          copy.openItemFallbackCondition,
          copy.openItemLongDelayDays,
          copy.openItemDelayHandling,
        )}`,
      );
      expect(patches).toHaveLength(1);

      // --- an address that is not http(s) is refused under its input, and nothing is sent.
      await letToastsGo(adminPage);
      const primaryUrl = adminPage.getByTestId('market-primary-source-url');
      await primaryUrl.fill(`ftp://example.com/e2e/${own}`);
      await adminPage.getByTestId('market-save').click();
      await expect(primaryUrl).toHaveAccessibleErrorMessage(copy.errMarketSourceUrl);
      expect(patches).toHaveLength(1);
      await primaryUrl.fill(primary.url);
      await adminPage.getByTestId('market-fallback-1-url').fill(second.url);

      // --- 나 moved up above 가: the rows swap, and the first cannot go up nor the last down.
      await adminPage.getByTestId('market-fallback-1-up').click();
      await expect(adminPage.getByTestId('market-fallback-0-name')).toHaveValue(second.name);
      await expect(adminPage.getByTestId('market-fallback-0-url')).toHaveValue(second.url);
      await expect(adminPage.getByTestId('market-fallback-1-name')).toHaveValue(first.name);
      await expect(adminPage.getByTestId('market-fallback-1-url')).toHaveValue(first.url);
      await expect(adminPage.getByTestId('market-fallback-0-up')).toBeDisabled();
      await expect(adminPage.getByTestId('market-fallback-1-down')).toBeDisabled();

      // --- a third, after which 추가 is off (three at most); left empty, it is refused on its row.
      await adminPage.getByTestId('market-fallback-add').click();
      await expect(adminPage.getByTestId('market-fallback-list').locator('li')).toHaveCount(3);
      await expect(adminPage.getByTestId('market-fallback-add')).toBeDisabled();
      await adminPage.getByTestId('market-save').click();
      await expect(adminPage.getByTestId('market-fallback-2-error')).toHaveText(
        copy.errMarketSourceEmpty,
      );
      expect(patches).toHaveLength(1);
      // Typed into, the row's refusal goes at once; the next save checks the row again.
      await adminPage.getByTestId('market-fallback-2-name').fill(third.name);
      await expect(adminPage.getByTestId('market-fallback-2-error')).toHaveCount(0);
      await adminPage.getByTestId('market-fallback-2-url').fill(third.url);
      await adminPage.getByTestId('market-fallback-condition').fill(condition);
      await adminPage.getByTestId('market-long-delay-days').fill('30');
      await adminPage.getByTestId('market-delay-handling').fill(delayHandling);

      // --- saved: the fallbacks go as the whole list in the order on screen, with the condition.
      const saved = nextPatch(adminPage, marketId);
      await adminPage.getByTestId('market-save').click();
      const body = (await saved).postDataJSON() as Record<string, unknown>;
      expect(body).toMatchObject({
        primarySource: primary,
        fallbackSources: [second, first, third],
        fallbackCondition: condition,
        longDelayDays: 30,
        delayHandling,
      });
      expect(Object.keys(body)).not.toContain('yesCondition');
      await expect(adminPage.getByText(copy.adminMarketSaved)).toBeVisible();
      await expect(notice).toHaveCount(0);
      await expect(
        adminPage.getByTestId('market-detail-fallback-sources').locator('li'),
      ).toHaveCount(3);
      const deadlineRow = adminPage.getByTestId('market-detail-event-deadline').locator('dd');
      await expect(deadlineRow).toHaveText(UNMARKED);
      deadlineText = (await deadlineRow.textContent()) ?? '';
      // The 사건 기한 typed in KST is the instant stored.
      const stored = await dataOf<{ eventDeadline: string | null }>(
        await admin.get(`/api/v1/admin/markets/${marketId}`),
      );
      expect(kstLocalOf(stored.eventDeadline ?? '')).toBe(eventDeadline);

      // --- 열기 opens it now.
      await letToastsGo(adminPage);
      await adminPage.getByTestId('market-open').click();
      await expect(adminPage.getByText(copy.adminMarketOpened)).toBeVisible();
      await expect(adminPage.getByTestId('market-detail-status')).toHaveText(copy.marketStatusOpen);

      // --- an open market cannot lose an item it had: the YES 조건 emptied is refused under its
      // input before anything is sent or confirmed, and the API refuses it too (RULES_REQUIRED).
      await letToastsGo(adminPage);
      const yesInput = adminPage.getByTestId('market-yes-condition');
      await expect(yesInput).toHaveValue(yes);
      await yesInput.fill('');
      await adminPage.getByTestId('market-save').click();
      await expect(yesInput).toHaveAccessibleErrorMessage(copy.errMarketRulesOpen);
      await expect(adminPage.getByTestId('market-edit-confirm')).toHaveCount(0);
      expect(patches).toHaveLength(2);
      const refused = await admin.patch(`/api/v1/admin/markets/${marketId}`, {
        data: { yesCondition: '', expectedAccountId: await accountIdOf(admin) },
      });
      expect(refused.status()).toBe(422);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
        'RULES_REQUIRED',
      );
    } finally {
      await adminContext.close();
    }
    if (deadlineText === undefined) throw new Error('the market was not opened');

    // --- the visitor, signed out: 배경 in its own section, then every row of 규칙 in the form's
    // order, all of it drawn at once, nothing in it that folds.
    await page.goto(`/markets/${slug}`);
    await expect(page.getByTestId('watch-button')).toBeVisible();
    const backgroundId = detailCopyTestId(page, 'market-background');
    await expect(page.getByTestId(`${backgroundId}-text`)).toHaveText(background);
    const id = detailCopyTestId(page, 'market-rules');
    const rules = page.getByTestId(id);
    await expect(rules.getByRole('heading', { level: 2 })).toHaveText(copy.rulesSectionTitle);
    await expect(rules.locator('dt')).toHaveText(RULE_ROWS);
    await expect(rules.locator('dd')).toHaveCount(RULE_ROWS.length);
    for (const value of await rules.locator('dd').all()) await expect(value).toBeVisible();
    await expect(rules.locator('button, details, summary, [aria-expanded]')).toHaveCount(0);
    await expect(rules).not.toContainText(background);

    await expect(page.getByTestId(`${id}-yes`)).toHaveText(yes);
    await expect(page.getByTestId(`${id}-no`)).toHaveText(no);
    await expect(page.getByTestId(`${id}-event-deadline`)).toHaveText(deadlineText);
    // Each source's name opens its address in a new tab.
    const primaryLink = page.getByTestId(`${id}-primary-source`).getByRole('link');
    await expect(primaryLink).toHaveText(primary.name);
    await expect(primaryLink).toHaveAttribute('href', primary.url);
    await expect(primaryLink).toHaveAttribute('target', '_blank');
    await expect(primaryLink).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    // The fallbacks numbered, in the order the operator left them.
    const fallbacks = page.getByTestId(`${id}-fallback-sources`);
    await expect(fallbacks.locator('ol')).toHaveCSS('list-style-type', 'decimal');
    await expect(fallbacks.locator('ol > li')).toHaveText([second.name, first.name, third.name]);
    for (const source of [second, first, third]) {
      await expect(fallbacks.getByRole('link', { name: source.name, exact: true })).toHaveAttribute(
        'href',
        source.url,
      );
    }
    await expect(page.getByTestId(`${id}-fallback-condition`)).toHaveText(condition);
    await expect(page.getByTestId(`${id}-long-delay`)).toHaveText(
      `${copy.rulesLongDelayBefore} 30${copy.rulesLongDelayTail}`,
    );
    await expect(page.getByTestId(`${id}-delay-handling`)).toHaveText(delayHandling);
    const voidPayout = page.getByTestId(`${id}-void-payout`);
    await expect(voidPayout).toHaveText(VOID_PAYOUT);
    await expect(voidPayout).not.toContainText(/환불|원금/);
    await expect(page.getByTestId(`${id}-close-at`)).toHaveText(UNMARKED);

    // The server's HTML holds the rules before any script runs (AC 2): no cookie on `request`.
    const html = await (await request.get(`/markets/${slug}`)).text();
    for (const text of [yes, no, condition, delayHandling, VOID_PAYOUT]) {
      expect(html).toContain(text);
    }
    expect(html).toContain(`href="${primary.url}"`);
  });

  test('관리자가 대체 출처를 하나씩 모두 빼면 넘어가는 조건의 입력도 사라지고, 저장한 시장의 대체 출처는 없음이고 조건은 비어 있다', async ({
    admin,
    page,
  }) => {
    const own = `r${freshTag()}`;
    const first: MarketSource = {
      name: `대체 출처 가 ${own}`,
      url: `https://example.org/e2e/${own}/a`,
    };
    const second: MarketSource = {
      name: `대체 출처 나 ${own}`,
      url: `https://example.net/e2e/${own}/b`,
    };
    const condition = `1차 출처에 발표가 없으면 대체 출처를 순서대로 확인합니다. ${own}`;
    const market = await createDraftMarket(admin, {
      ruleItems: { fallbackSources: [first, second], fallbackCondition: condition },
    });

    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto(`/admin/markets/${market.id}`);
    const rows = page.getByTestId('market-fallback-list').locator('li');
    const conditionInput = page.getByTestId('market-fallback-condition');
    await expect(rows).toHaveCount(2);
    await expect(conditionInput).toHaveValue(condition);

    // --- 빼기 on the first: the second takes its place, and the condition stays while one is left.
    await page.getByTestId('market-fallback-0-remove').click();
    await expect(rows).toHaveCount(1);
    await expect(page.getByTestId('market-fallback-0-name')).toHaveValue(second.name);
    await expect(page.getByTestId('market-fallback-0-url')).toHaveValue(second.url);
    await expect(conditionInput).toHaveValue(condition);

    // --- 빼기 on the last: 없음, and the condition's input goes with the list.
    await page.getByTestId('market-fallback-0-remove').click();
    await expect(page.getByTestId('market-fallback-list')).toHaveCount(0);
    await expect(page.getByTestId('market-fallback-none')).toHaveText(copy.adminMarketFallbackNone);
    await expect(conditionInput).toHaveCount(0);

    // --- saved: no fallback and the condition cleared, which the API takes as they are.
    const saved = nextPatch(page, market.id);
    await page.getByTestId('market-save').click();
    expect((await saved).postDataJSON()).toMatchObject({
      fallbackSources: [],
      fallbackCondition: '',
    });
    await expect(page.getByText(copy.adminMarketSaved)).toBeVisible();
    await expect(page.getByTestId('market-detail-fallback-sources').locator('dd')).toHaveText(
      copy.adminMarketFallbackNone,
    );
    await expect(page.getByTestId('market-detail-fallback-condition').locator('dd')).toHaveText(
      '—',
    );
    const stored = await dataOf<{ fallbackSources: MarketSource[]; fallbackCondition: string }>(
      await admin.get(`/api/v1/admin/markets/${market.id}`),
    );
    expect(stored).toMatchObject({ fallbackSources: [], fallbackCondition: '' });
  });

  test('대체 출처가 없는 시장의 규칙은 대체 출처를 없음으로 읽고, 넘어가는 조건의 줄은 없다', async ({
    admin,
    page,
  }) => {
    const market = await createOpenMarket(admin);
    const source = market.ruleItems.primarySource;
    if (source === null) throw new Error('the market has no primary source');

    await page.goto(`/markets/${market.slug}`);
    await expect(page.getByTestId('watch-button')).toBeVisible();
    const id = detailCopyTestId(page, 'market-rules');
    await expect(page.getByTestId(id).locator('dt')).toHaveText(
      RULE_ROWS.filter((row) => row !== copy.rulesFallbackCondition),
    );
    await expect(page.getByTestId(`${id}-fallback-sources`)).toHaveText(copy.rulesFallbackNone);
    await expect(page.getByTestId(`${id}-fallback-condition`)).toHaveCount(0);
    await expect(page.getByTestId(`${id}-primary-source`).getByRole('link')).toHaveAttribute(
      'href',
      source.url,
    );
    await expect(page.getByTestId(`${id}-long-delay`)).toHaveText(
      `${copy.rulesLongDelayBefore} ${String(market.ruleItems.longDelayDays)}` +
        copy.rulesLongDelayTail,
    );
    await expect(page.getByTestId(`${id}-void-payout`)).toHaveText(VOID_PAYOUT);
  });
});
