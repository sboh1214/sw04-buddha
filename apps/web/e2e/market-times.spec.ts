import { type APIResponse, type Page, type Request } from '@playwright/test';
import type { AdminMarket, Market } from '@buddha/shared';
import { copy } from '../src/copy';
import { formatKst } from '../src/lib/datetime';
import {
  accountIdOf,
  adminAccount,
  approveAsReviewer,
  approveSupplementAsReviewer,
  closeMarket,
  createDraftMarket,
  createOpenMarket,
  DEFAULT_JUDGEMENT_TIME_ZONE,
  detailCopyTestId,
  expect,
  fillRuleItemInputs,
  fillTimeInputs,
  freshTag,
  kstLocalOf,
  leaveNoSupplement,
  openThroughReview,
  ruleItemsFor,
  sendSupplement,
  signIn,
  submitRefusedItems,
  test,
  timesFor,
} from './helpers';

/**
 * 시장 시간 (#22, ADR-0098; ADR-0093 decision 2 #172 items 11–14, decision 3 '#22 시간대' and '#21
 * 앞당긴 개장', the owner's answers A1 and A2 of 2026-10-31): an operator enters a market's 예정
 * 개장·거래 마감·발표 예정·예정 판정 시각 on the market form in KST, one input each after the rule
 * items, and picks its 판정 기준 시간대 — Asia/Seoul pre-filled for the operator to confirm, from the
 * zones MY 설정 lists, with no "follow the browser" row. Times out of order — the scheduled open at
 * or after the close, the close after the scheduled judgement, the 사건 기한 after it (A1) — are
 * refused under both inputs before anything is sent; a close later than the announcement time
 * less the 선행 마감 gap (the release setting `market.lead_close_gap`) is not refused on a draft but
 * named by the open-items check, which keeps 검수 제출 off and refuses it (#78). A draft made
 * without its times names them; saving the pre-filled zone confirms it. Approved before its
 * scheduled open, a market waits as 개장 예정 — there is no early open: moved earlier to a time
 * already come, it opens at once (#21, ADR-0100). Once open, its times are rule version items
 * (#80, ADR-0101): the edit form shows them off and the API refuses a PATCH that changes one. The
 * scheduled open and judgement are fixed, and the close only moves later by a supplement another
 * admin approves, never past the scheduled judgement (A2) — refused on the supplement's form and
 * by the API.
 *
 * A visitor reads every time of the rules in their own zone and, when the market's 판정 기준
 * 시간대 is another, in that zone too on a second line — after hydration only: the server's HTML
 * holds one KST line per time, with no marker (ADR-0063). A closed market whose scheduled
 * judgement has passed reads '판정 지연' in place of '거래 마감' (#173 item 11).
 *
 * No spec writes the release setting: a value would stay in the e2e database and change
 * release-settings.spec.ts's counts (docs/SETTINGS.md). The lead close is read off the setting the
 * database holds, 미정 on a fresh one; its decided-gap cases are the API's integration tests
 * (admin-markets-times.controller.test.ts, and admin-markets-supplement.controller.test.ts for an
 * open market's), as are every refusal's details, the minute precision and the records. The
 * form's rules, the rows and the second line are unit-tested (lib/market-form.test.ts,
 * rules-section.test.tsx, time-zone-provider.test.tsx). Both projects run in Seoul
 * (playwright.config.ts); a context of its own reads New York.
 */

const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A zone other than Seoul that every engine knows, with daylight saving time. */
const NEW_YORK_ZONE = 'America/New_York';

/** `formatInTimeZone`'s style with no marker: what Seoul, and every admin screen, reads. */
const DATE_TIME = '\\d{4}\\. \\d{1,2}\\. \\d{1,2}\\. (오전|오후) \\d{1,2}:\\d{2}';

/**
 * The same in New York, its offset after it. The instants are relative to the run's clock, so
 * whether New York is on EDT or EST that day decides which.
 */
const NEW_YORK = new RegExp(`^${DATE_TIME} \\((GMT-4|GMT-5)\\)$`);

/** The judgement zone's line of a market judged in New York, read in another zone. */
const NEW_YORK_LINE = new RegExp(
  `^${copy.rulesJudgementZoneLine} ${DATE_TIME} \\((GMT-4|GMT-5)\\)$`,
);

/** Any zone marker, anywhere in a text. */
const ANY_MARKER = /\(GMT/;

/** Every judgement zone line inside an element (`DateTimeText`'s `<row>-judgement-zone`). */
const JUDGEMENT_LINES = '[data-testid$="-judgement-zone"]';

/** React's report of a server/client mismatch: dev "Hydration failed …", prod #418/#423/#425. */
const HYDRATION_ERROR = /hydrat|#418|#423|#425/i;

/** The ISO instant of the whole minute `ms` falls in: what a `datetime-local` input holds. */
function minuteIso(ms: number): string {
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString();
}

/**
 * The row's judgement zone line lies under its viewer's line, not beside it: the value cell is a
 * block (rules-section.tsx — a DataList value is a flex row, which would put the two side by side
 * with nothing between them). Only the boxes tell, the texts being whole either way.
 */
async function expectSecondLineUnder(page: Page, rowTestId: string): Promise<void> {
  const first = await page.getByTestId(`${rowTestId}-viewer-zone`).boundingBox();
  const second = await page.getByTestId(`${rowTestId}-judgement-zone`).boundingBox();
  if (first === null || second === null) throw new Error(`${rowTestId} has no two lines`);
  expect(second.y).toBeGreaterThanOrEqual(first.y + first.height - 1);
}

/** A time the spec set, which the type allows to be null. */
function present(iso: string | null): string {
  if (iso === null) throw new Error('the market has no such time');
  return iso;
}

/** A stored time as an instant, whatever ISO spelling the API wrote it in. */
function instantOf(iso: string | null): number | null {
  return iso === null ? null : Date.parse(iso);
}

/** `{ data }` out of the success envelope, with the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} -> ${String(response.status())} ${body}`).toBe(true);
  return (JSON.parse(body) as { data: T }).data;
}

/** The first detail of a `VALIDATION_ERROR` (400): the field the request sent comes first. */
async function firstDetail(response: APIResponse): Promise<unknown> {
  expect(response.status(), await response.text()).toBe(400);
  const { error } = (await response.json()) as { error: { code: string; details: unknown[] } };
  expect(error.code).toBe('VALIDATION_ERROR');
  return error.details[0];
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

/** A row of the admin market detail (`market-detail-…`): its value. */
const detailRow = (page: Page, testId: string) => page.getByTestId(testId).locator('dd');

/** Waits until the header knows nobody is signed in: the zone has settled (ADR-0063). */
async function signedOutSettled(page: Page): Promise<void> {
  await expect(page.getByRole('banner').getByRole('link', { name: copy.login })).toBeVisible();
}

/** The hydration errors `page` reports from now on (time-zone.spec.ts's `watchHydration`). */
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

test.describe('시장 시간', () => {
  test('관리자가 시장 만들기에서 네 시각을 한국 시간으로 넣고 판정 기준 시간대를 고르면 그대로 저장되고, 어긋난 순서는 두 입력 아래에서 거절되며, 발표 예정 시각보다 늦은 마감은 선행 마감으로 검수 제출이 꺼지고 거절되며 없음으로 고치면 검수를 거쳐 열린다. 서울의 방문자는 시각마다 판정 기준 시간대의 줄을 함께 읽는다', async ({
    admin,
    browser,
    page,
    request,
  }) => {
    const own = `t${freshTag()}`;
    const title = `E2E 시각 ${own}`;
    // An ASCII address, as every e2e market has (helpers.ts `createDraftMarket`).
    const slug = `e2e-${own}`;
    const start = Date.now();
    // Whole minutes, as the inputs hold them, so what is typed is the instant stored.
    const closeAt = minuteIso(start + DAY_MS);
    const items = { ...ruleItemsFor(own), eventDeadline: minuteIso(start + 2 * DAY_MS) };
    const times = timesFor(closeAt, items.eventDeadline, start);
    const openAt = present(times.scheduledOpenAt);
    const judgementAt = present(times.scheduledJudgementAt);
    // Before the close: a lead close no gap can pass (close ≤ announcement − gap, #172 item 13).
    const announcementAt = minuteIso(Date.parse(closeAt) - 30 * MINUTE_MS);
    const deadlineAt = present(items.eventDeadline);
    const longDelayAt = new Date(
      Date.parse(judgementAt) + (items.longDelayDays ?? 0) * DAY_MS,
    ).toISOString();

    const adminContext = await browser.newContext();
    try {
      const adminPage = await adminContext.newPage();
      await signIn(adminPage, adminAccount.email, adminAccount.password);
      // Every market create this page sends, to prove the form's refusals send none.
      const creates: unknown[] = [];
      adminPage.on('request', (sent) => {
        if (sent.method() === 'POST' && new URL(sent.url()).pathname === '/api/v1/admin/markets') {
          creates.push(sent.postDataJSON());
        }
      });

      // --- 시장 만들기: 시각 is one group after the rule items, the four times in KST in OPEN_ITEMS
      // order and then the 판정 기준 시간대 — Asia/Seoul pre-filled, MY 설정's zones with no
      // "follow the browser" row (#172 item 11).
      await adminPage.goto('/admin/markets');
      await expect(adminPage.getByTestId('market-create')).toBeEnabled();
      const zone = adminPage.getByTestId('market-judgement-time-zone');
      await expect(zone).toHaveValue(DEFAULT_JUDGEMENT_TIME_ZONE);
      expect(
        await adminPage
          .locator('[data-testid="market-rule-items"], [data-testid="market-times"]')
          .evaluateAll((groups) => groups.map((group) => group.getAttribute('data-testid'))),
      ).toEqual(['market-rule-items', 'market-times']);
      expect(
        await adminPage
          .getByTestId('market-times')
          .locator('input, select')
          .evaluateAll((inputs) =>
            inputs.map((input) => [input.getAttribute('data-testid'), input.getAttribute('type')]),
          ),
      ).toEqual([
        ['market-scheduled-open-at', 'datetime-local'],
        ['market-close-at', 'datetime-local'],
        ['market-scheduled-announcement-at', 'datetime-local'],
        ['market-scheduled-judgement-at', 'datetime-local'],
        ['market-judgement-time-zone', null],
      ]);
      await expect(zone.locator('option[value=""]')).toHaveCount(0);
      await expect(zone.locator(`option[value="${NEW_YORK_ZONE}"]`)).toHaveText(
        /^America\/New_York — \S*[가-힣]/,
      );

      await adminPage.getByTestId('market-title').fill(title);
      await adminPage.getByTestId('market-slug').fill(slug);
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
      await fillRuleItemInputs(adminPage, items);

      const openInput = adminPage.getByTestId('market-scheduled-open-at');
      const closeInput = adminPage.getByTestId('market-close-at');
      const judgementInput = adminPage.getByTestId('market-scheduled-judgement-at');
      const deadlineInput = adminPage.getByTestId('market-event-deadline');
      // The zone left as pre-filled until the times are in order.
      const typed = { ...times, closeAt, judgementTimeZone: null };

      // --- the scheduled open after the close (#172 item 12): refused under both.
      await fillTimeInputs(adminPage, {
        ...typed,
        scheduledOpenAt: minuteIso(Date.parse(closeAt) + HOUR_MS),
      });
      await adminPage.getByTestId('market-create').click();
      await expect(openInput).toHaveAccessibleErrorMessage(copy.errMarketTimeOpenBeforeClose);
      await expect(closeInput).toHaveAccessibleErrorMessage(copy.errMarketTimeOpenBeforeClose);

      // --- the scheduled judgement before the close: refused under both, and under the 사건 기한,
      // which is after it too (A1).
      await fillTimeInputs(adminPage, {
        ...typed,
        scheduledJudgementAt: minuteIso(Date.parse(closeAt) - HOUR_MS),
      });
      await adminPage.getByTestId('market-create').click();
      await expect(closeInput).toHaveAccessibleErrorMessage(copy.errMarketTimeCloseByJudgement);
      await expect(judgementInput).toHaveAccessibleErrorMessage(copy.errMarketTimeCloseByJudgement);
      await expect(deadlineInput).toHaveAccessibleErrorMessage(
        copy.errMarketTimeDeadlineByJudgement,
      );
      await expect(openInput).not.toHaveAttribute('aria-invalid', 'true');

      // --- the judgement at the close's minute, which is fine, but before the 사건 기한 (A1):
      // refused under those two, the close no more.
      await fillTimeInputs(adminPage, { ...typed, scheduledJudgementAt: closeAt });
      await adminPage.getByTestId('market-create').click();
      await expect(deadlineInput).toHaveAccessibleErrorMessage(
        copy.errMarketTimeDeadlineByJudgement,
      );
      await expect(judgementInput).toHaveAccessibleErrorMessage(
        copy.errMarketTimeDeadlineByJudgement,
      );
      await expect(closeInput).not.toHaveAttribute('aria-invalid', 'true');
      expect(creates).toEqual([]);

      // --- in order, with an announcement time before the close and New York picked: a draft
      // takes it — the lead close is never refused on entry (ADR-0098) — every time as typed.
      await fillTimeInputs(adminPage, {
        ...times,
        closeAt,
        scheduledAnnouncementAt: announcementAt,
        judgementTimeZone: NEW_YORK_ZONE,
      });
      await expect(zone).toHaveValue(NEW_YORK_ZONE);
      const created = adminPage.waitForRequest(
        (sent) =>
          sent.method() === 'POST' && new URL(sent.url()).pathname === '/api/v1/admin/markets',
      );
      await adminPage.getByTestId('market-create').click();
      expect((await created).postDataJSON()).toMatchObject({
        scheduledOpenAt: openAt,
        closeAt,
        scheduledAnnouncementAt: announcementAt,
        scheduledJudgementAt: judgementAt,
        judgementTimeZone: NEW_YORK_ZONE,
      });
      await expect(adminPage).toHaveURL(/\/admin\/markets\/[0-9a-f-]{36}$/);
      const marketId = adminPage.url().split('/').at(-1) ?? '';
      const stored = await dataOf<AdminMarket>(
        await admin.get(`/api/v1/admin/markets/${marketId}`),
      );
      expect(
        [
          stored.scheduledOpenAt,
          stored.closeAt,
          stored.scheduledAnnouncementAt,
          stored.scheduledJudgementAt,
        ].map(instantOf),
      ).toEqual([openAt, closeAt, announcementAt, judgementAt].map(instantOf));
      expect(stored.judgementTimeZone).toBe(NEW_YORK_ZONE);
      expect(stored.missingOpenItems).toEqual(['leadClose']);

      // --- the admin detail reads each time in KST, the zone by its names, and the gap the lead
      // close is held to: the release setting's, 미정 unless someone entered one.
      await expect(detailRow(adminPage, 'market-detail-scheduled-open-at')).toHaveText(
        formatKst(openAt),
      );
      await expect(detailRow(adminPage, 'market-detail-close-at')).toHaveText(formatKst(closeAt));
      await expect(detailRow(adminPage, 'market-detail-scheduled-announcement-at')).toHaveText(
        formatKst(announcementAt),
      );
      await expect(detailRow(adminPage, 'market-detail-scheduled-judgement-at')).toHaveText(
        formatKst(judgementAt),
      );
      await expect(detailRow(adminPage, 'market-detail-judgement-time-zone')).toHaveText(
        /^America\/New_York — /,
      );
      const gap = stored.leadCloseGapMinutes;
      await expect(detailRow(adminPage, 'market-detail-lead-close-gap')).toHaveText(
        gap === null
          ? copy.adminMarketLeadCloseGapUndecided
          : `${String(gap)}${copy.adminMarketLeadCloseGapMinutes}`,
      );
      // The preview is the visitor's rules in KST alone (decision 3 '#22 시간대': admin screens
      // are KST): the scheduled open while a draft, and no judgement zone line.
      const preview = adminPage.getByTestId('market-preview-rules');
      await expect(
        adminPage.getByTestId('market-preview-rules-scheduled-open-at-viewer-zone'),
      ).toHaveText(formatKst(openAt));
      await expect(adminPage.getByTestId('market-preview-rules-close-at-viewer-zone')).toHaveText(
        formatKst(closeAt),
      );
      await expect(preview.locator(JUDGEMENT_LINES)).toHaveCount(0);

      // --- the open-items check names 선행 마감, with a line that says why: 검수 제출 is off, and
      // the API refuses it naming the same (#78).
      const leadLine =
        gap === null
          ? copy.openItemRuleLeadCloseUndecided
          : `${copy.openItemRuleLeadCloseBefore} ${String(gap)}${copy.openItemRuleLeadCloseTail}`;
      const notice = adminPage.getByTestId('market-open-items');
      await expect(notice).toHaveText(
        [
          `${copy.adminMarketOpenItems}: ${copy.openItemLeadClose}`,
          `${copy.openItemLeadClose}: ${leadLine}`,
        ].join('\n'),
      );
      const submit = adminPage.getByTestId('market-review-submit');
      await expect(submit).toBeDisabled();
      expect(await submitRefusedItems(admin, marketId)).toEqual(stored.missingOpenItems);
      await expect(adminPage.getByTestId('market-detail-status')).toHaveText(
        copy.marketStatusDraft,
      );

      // --- the announcement cleared, '없음' (#172 item 13): only it is sent, and the market opens
      // through the review — submitted, and approved by the second admin past its scheduled open,
      // which opens it at once (#21, ADR-0100).
      await letToastsGo(adminPage);
      const announcementInput = adminPage.getByTestId('market-scheduled-announcement-at');
      await expect(announcementInput).toHaveValue(kstLocalOf(announcementAt));
      await announcementInput.fill('');
      const saved = nextPatch(adminPage, marketId);
      await adminPage.getByTestId('market-save').click();
      const body = (await saved).postDataJSON() as Record<string, unknown>;
      expect(body).toMatchObject({ scheduledAnnouncementAt: null });
      expect(Object.keys(body).sort()).toEqual(['expectedAccountId', 'scheduledAnnouncementAt']);
      await expect(adminPage.getByText(copy.adminMarketSaved)).toBeVisible();
      await expect(notice).toHaveCount(0);
      await expect(detailRow(adminPage, 'market-detail-scheduled-announcement-at')).toHaveText(
        copy.adminMarketAnnouncementNone,
      );
      await expect(submit).toBeEnabled();
      await openThroughReview(admin, marketId);
      await adminPage.reload();
      await expect(adminPage.getByTestId('market-detail-status')).toHaveText(copy.marketStatusOpen);
      // Open, its scheduled open and judgement are fixed (#172 item 14) and every time changes by
      // a supplement alone (#80): the inputs are locked.
      await expect(openInput).toBeDisabled();
      await expect(judgementInput).toBeDisabled();
    } finally {
      await adminContext.close();
    }

    // --- a visitor in Seoul, signed out: the times close 규칙 in the form's order — no 예정 개장
    // 시각 once open — each in Seoul and, the market being judged in New York, in New York on a
    // second line (decision 3 '#22 시간대': both, as they differ).
    await page.goto(`/markets/${slug}`);
    await signedOutSettled(page);
    const id = detailCopyTestId(page, 'market-rules');
    await expect(page.getByTestId(id).locator('dt')).toHaveText([
      copy.rulesYes,
      copy.rulesNo,
      copy.rulesEventDeadline,
      copy.rulesPrimarySource,
      copy.rulesFallbackSources,
      copy.rulesLongDelay,
      copy.rulesDelayHandling,
      copy.rulesVoidPayout,
      copy.rulesCloseAt,
      copy.rulesAnnouncementAt,
      copy.rulesJudgementAt,
      copy.rulesJudgementTimeZone,
    ]);
    await expect(page.getByTestId(`${id}-scheduled-open-at`)).toHaveCount(0);
    for (const [row, at] of [
      ['close-at', closeAt],
      ['judgement-at', judgementAt],
      ['event-deadline', deadlineAt],
      ['long-delay', longDelayAt],
    ] as const) {
      await expect(page.getByTestId(`${id}-${row}-viewer-zone`)).toHaveText(formatKst(at));
      await expect(page.getByTestId(`${id}-${row}-judgement-zone`)).toHaveText(NEW_YORK_LINE);
      await expectSecondLineUnder(page, `${id}-${row}`);
    }
    await expect(page.getByTestId(`${id}-announcement-at`)).toHaveText(copy.rulesAnnouncementNone);
    await expect(page.getByTestId(`${id}-judgement-time-zone`)).toHaveText(
      /^America\/New_York — \S*[가-힣]/,
    );

    // The server's HTML: one KST line per time, the zone by its IANA name, no marker (ADR-0063).
    const html = await (await request.get(`/markets/${slug}`)).text();
    expect(html).toContain(formatKst(closeAt));
    expect(html).toContain(formatKst(judgementAt));
    expect(html).toContain(NEW_YORK_ZONE);
    expect(html).not.toMatch(ANY_MARKER);
    expect(html).not.toContain('-judgement-zone"');
  });

  test('시각 없이 만든 초안은 예정 개장·예정 판정 시각과 판정 기준 시간대를 채울 항목으로 이름 대고 검수 제출이 꺼지며, 미리 채운 서울은 저장으로 확인되고, 예정 개장 시각 전에 승인되면 개장 예정으로 기다리다 예정 개장 시각을 지난 시각으로 앞당기면 바로 열린다. 연 시장의 시각은 수정으로 바뀌지 않고, 마감은 다른 관리자가 승인한 보충으로 예정 판정 시각까지 늦추기만 하며 예정 판정 시각은 바뀌지 않는다', async ({
    admin,
    page,
  }) => {
    // A draft from before #22, or an adopted proposal: every time but the close blank.
    const market = await createDraftMarket(admin, {
      times: { scheduledOpenAt: null, scheduledJudgementAt: null, judgementTimeZone: null },
    });
    const judgementAt = present(
      timesFor(market.closeAt, market.ruleItems.eventDeadline).scheduledJudgementAt,
    );
    const expectedAccountId = await accountIdOf(admin);

    await signIn(page, adminAccount.email, adminAccount.password);
    const path = `/api/v1/admin/markets/${market.id}`;
    // Every supplement request this page sends (#80), to prove the form's refusals send none.
    const requested: string[] = [];
    page.on('request', (sent) => {
      if (sent.method() === 'POST' && new URL(sent.url()).pathname === `${path}/supplements`) {
        requested.push(sent.url());
      }
    });
    await page.goto(`/admin/markets/${market.id}`);
    const status = page.getByTestId('market-detail-status');

    // --- the draft names the missing times, in OPEN_ITEMS order; 검수 제출 is off, and the API
    // refuses it naming them (#78).
    const missing = [
      copy.openItemScheduledOpenAt,
      copy.openItemScheduledJudgementAt,
      copy.openItemJudgementTimeZone,
    ].join(' · ');
    const notice = page.getByTestId('market-open-items');
    await expect(notice).toHaveText(`${copy.adminMarketOpenItems}: ${missing}`);
    for (const row of [
      'market-detail-scheduled-open-at',
      'market-detail-scheduled-judgement-at',
      'market-detail-judgement-time-zone',
    ]) {
      await expect(detailRow(page, row)).toHaveText('—');
    }
    await expect(detailRow(page, 'market-detail-scheduled-announcement-at')).toHaveText(
      copy.adminMarketAnnouncementNone,
    );
    const submit = page.getByTestId('market-review-submit');
    await expect(submit).toBeDisabled();
    expect(await submitRefusedItems(admin, market.id)).toEqual([
      'scheduledOpenAt',
      'scheduledJudgementAt',
      'judgementTimeZone',
    ]);
    await expect(status).toHaveText(copy.marketStatusDraft);

    // --- the zone shows Asia/Seoul pre-filled, and the form may be saved for it alone: saving is
    // the operator's confirmation (#172 item 11). With the scheduled open an hour ahead and the
    // judgement, the save sends the three and nothing else.
    await expect(page.getByTestId('market-judgement-time-zone')).toHaveValue(
      DEFAULT_JUDGEMENT_TIME_ZONE,
    );
    await expect(page.getByTestId('market-save')).toBeEnabled();
    const aheadAt = minuteIso(Date.now() + HOUR_MS);
    await letToastsGo(page);
    await fillTimeInputs(page, {
      scheduledOpenAt: aheadAt,
      scheduledAnnouncementAt: null,
      scheduledJudgementAt: judgementAt,
      judgementTimeZone: null,
    });
    const confirmed = nextPatch(page, market.id);
    await page.getByTestId('market-save').click();
    expect((await confirmed).postDataJSON()).toEqual({
      scheduledOpenAt: aheadAt,
      scheduledJudgementAt: judgementAt,
      judgementTimeZone: DEFAULT_JUDGEMENT_TIME_ZONE,
      expectedAccountId,
    });
    await expect(page.getByText(copy.adminMarketSaved)).toBeVisible();
    await expect(notice).toHaveCount(0);
    await expect(detailRow(page, 'market-detail-judgement-time-zone')).toHaveText(/^Asia\/Seoul/);

    // --- 검수 제출 on screen, and the second admin's approval an hour before the scheduled open:
    // 개장 예정, which the worker opens only at that time (#21, ADR-0100).
    await letToastsGo(page);
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByText(copy.adminMarketReviewSubmitted)).toBeVisible();
    await expect(status).toHaveText(copy.marketStatusReview);
    expect((await approveAsReviewer(admin, market.id)).status).toBe('scheduled');
    await page.reload();
    await expect(status).toHaveText(copy.marketStatusScheduled);
    await expect(page.getByTestId('market-review-scheduled')).toHaveText(
      copy.adminMarketReviewScheduledNote,
    );
    await expect(detailRow(page, 'market-detail-open-at')).toHaveText('—');

    // --- there is no early open: the operator moves the scheduled open earlier, with a reason and
    // no new review (ADR-0093 decision 3 '#21 앞당긴 개장'), and a time already come opens the
    // market at once, in the same write (#21) — the admin who moved it its opener.
    const passedAt = minuteIso(Date.now() - MINUTE_MS);
    const reason = `발표 일정이 당겨져 지금 엽니다 ${market.tag}`;
    await page.getByTestId('market-review-reschedule').click();
    const dialog = page.getByTestId('market-review-reschedule-dialog');
    await dialog.getByTestId('market-review-reschedule-at').fill(kstLocalOf(passedAt));
    await dialog.getByTestId('market-review-reschedule-reason').fill(reason);
    const rescheduled = page.waitForRequest(
      (sent) => sent.method() === 'POST' && new URL(sent.url()).pathname === `${path}/reschedule`,
    );
    await dialog.getByTestId('market-review-reschedule-dialog-confirm').click();
    expect((await rescheduled).postDataJSON()).toEqual({
      scheduledOpenAt: passedAt,
      reason,
      expectedAccountId,
    });
    await expect(page.getByText(copy.adminMarketReviewRescheduledOpened)).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(status).toHaveText(copy.marketStatusOpen);
    const opened = await dataOf<AdminMarket>(await admin.get(path));
    expect(opened.events.slice(0, 2).map((event) => event.type)).toEqual([
      'opened',
      'open_rescheduled',
    ]);
    expect(opened.events[0]).toMatchObject({
      actorId: expectedAccountId,
      fromStatus: 'scheduled',
      toStatus: 'open',
      payload: { source: 'reschedule' },
    });
    await expect(detailRow(page, 'market-detail-open-at')).toHaveText(
      formatKst(present(opened.openAt)),
    );

    // --- open, its times are rule version items (#80, ADR-0101; #172 item 14): the edit form
    // shows them off under a note, and the API refuses a PATCH that changes the scheduled
    // judgement or the close — they change by a supplement alone, and no supplement names the
    // scheduled open or judgement (ADR-0098).
    expect(opened.ruleVersion).toBe(1);
    await expect(page.getByTestId('market-edit-supplement-only')).toHaveText(
      copy.adminMarketEditSupplementOnly,
    );
    for (const input of [
      'market-scheduled-open-at',
      'market-close-at',
      'market-scheduled-judgement-at',
    ]) {
      await expect(page.getByTestId(input)).toBeDisabled();
    }
    const laterJudgementAt = new Date(Date.parse(judgementAt) + DAY_MS).toISOString();
    for (const [field, value] of [
      ['scheduledJudgementAt', laterJudgementAt],
      ['closeAt', judgementAt],
    ] as const) {
      expect(
        await firstDetail(await admin.patch(path, { data: { [field]: value, expectedAccountId } })),
      ).toMatchObject({ path: [field], message: 'supplement only while open' });
    }
    expect(
      await firstDetail(
        await sendSupplement(admin, market.id, { scheduledJudgementAt: laterJudgementAt }),
      ),
    ).toMatchObject({ path: ['changes'], message: 'not a supplement item: scheduledJudgementAt' });

    // --- a supplement holds the close to the rules the open market's edit held it to (ADR-0098
    // result 5): earlier is an early close, not a supplement (#172 item 14), and later stops at
    // the scheduled judgement (A2) — refused by the API naming the close, nothing left waiting.
    const earlierAt = minuteIso(Date.parse(market.closeAt) - HOUR_MS);
    const pastJudgementAt = minuteIso(Date.parse(judgementAt) + MINUTE_MS);
    expect(
      await firstDetail(await sendSupplement(admin, market.id, { closeAt: earlierAt })),
    ).toEqual({ path: ['closeAt'], message: 'cannot move earlier while open' });
    expect(
      await firstDetail(await sendSupplement(admin, market.id, { closeAt: pastJudgementAt })),
    ).toEqual({ path: ['closeAt'], message: 'must be at or before scheduledJudgementAt' });
    expect((await dataOf<AdminMarket>(await admin.get(path))).supplement.pending).toBeNull();

    // --- 보충 요청 on screen: the form holds the market's times, the scheduled open and judgement
    // locked; the same two closes are refused under its close input, and nothing is sent.
    await letToastsGo(page);
    await page.getByTestId('market-supplement-request').click();
    const form = page.getByTestId('market-supplement-form');
    const closeInput = form.getByTestId('market-close-at');
    await expect(closeInput).toBeEnabled();
    await expect(closeInput).toHaveValue(kstLocalOf(market.closeAt));
    await expect(form.getByTestId('market-scheduled-open-at')).toBeDisabled();
    await expect(form.getByTestId('market-scheduled-judgement-at')).toBeDisabled();
    await closeInput.fill(kstLocalOf(earlierAt));
    await form.getByTestId('market-supplement-submit').click();
    await expect(closeInput).toHaveAccessibleErrorMessage(copy.errMarketCloseEarlier);
    await closeInput.fill(kstLocalOf(pastJudgementAt));
    await form.getByTestId('market-supplement-submit').click();
    await expect(closeInput).toHaveAccessibleErrorMessage(copy.errMarketTimeCloseByJudgement);
    expect(requested).toEqual([]);

    // --- later, up to the scheduled judgement itself, with its reason and 정산 영향 검토: sent with
    // the close alone, against v1; it waits for another admin, the market unchanged meanwhile.
    // Whatever fails between the request and its approval, nothing is left waiting (the 규칙 보충
    // 대기 list of a database later runs reuse).
    const supplementReason = `사건 일정이 늦춰져 거래 마감을 늦춥니다 ${market.tag}`;
    const impact = `판정 기준과 출처가 그대로라 정산에 영향이 없습니다 ${market.tag}`;
    try {
      await closeInput.fill(kstLocalOf(judgementAt));
      await form.getByTestId('market-supplement-reason').fill(supplementReason);
      await form.getByTestId('market-supplement-impact').fill(impact);
      const sentRequest = page.waitForRequest(
        (sent) =>
          sent.method() === 'POST' && new URL(sent.url()).pathname === `${path}/supplements`,
      );
      await form.getByTestId('market-supplement-submit').click();
      expect((await sentRequest).postDataJSON()).toEqual({
        baseVersion: 1,
        changes: { closeAt: judgementAt },
        reason: supplementReason,
        settlementImpact: impact,
        expectedAccountId,
      });
      await expect(page.getByText(copy.adminMarketSupplementRequested)).toBeVisible();
      await expect(form).toHaveCount(0);
      await expect(page.getByTestId('market-supplement-pending-change-closeAt-after')).toHaveText(
        formatKst(judgementAt),
      );
      await expect(page.getByTestId('market-supplement-approve')).toBeDisabled();
      await expect(detailRow(page, 'market-detail-close-at')).toHaveText(formatKst(market.closeAt));

      // --- approved by the second admin: the close is the scheduled judgement in rule v2, and the
      // judgement stays as it was (#22 AC 2) — one `rules_supplemented` event names the close.
      expect(await approveSupplementAsReviewer(admin, market.id)).toMatchObject({
        status: 'open',
        ruleVersion: 2,
      });
    } finally {
      await leaveNoSupplement(admin, market.id);
    }
    await page.reload();
    await expect(detailRow(page, 'market-detail-close-at')).toHaveText(formatKst(judgementAt));
    await expect(page.getByTestId('market-supplement-version')).toHaveText(
      `${copy.adminMarketSupplementVersion} ${copy.ruleVersionName}2`,
    );
    const stored = await dataOf<AdminMarket>(await admin.get(path));
    expect(stored.status).toBe('open');
    expect(
      [stored.scheduledOpenAt, stored.closeAt, stored.scheduledJudgementAt].map(instantOf),
    ).toEqual([passedAt, judgementAt, judgementAt].map(instantOf));
    expect(stored.events[0]).toMatchObject({
      type: 'rules_supplemented',
      fromStatus: null,
      toStatus: null,
      payload: {
        version: 2,
        items: ['closeAt'],
        reason: supplementReason,
        requestedBy: expectedAccountId,
      },
    });
    expect(stored.events[0]?.actorId).not.toBe(expectedAccountId);
  });

  test('뉴욕 브라우저의 방문자는 규칙의 시각을 뉴욕 시간으로 읽고 판정 기준 시간대가 다를 때만 그 시간대의 줄을 함께 읽으며, 서버 HTML은 시각마다 한국 시간 한 줄이다', async ({
    admin,
    browser,
    page,
    request,
  }) => {
    const seoul = await createOpenMarket(admin);
    const newYork = await createOpenMarket(admin, {
      times: { judgementTimeZone: NEW_YORK_ZONE },
    });
    const judgementAt = present(seoul.times.scheduledJudgementAt);
    const rows = [
      ['close-at', seoul.closeAt],
      ['judgement-at', judgementAt],
      ['event-deadline', present(seoul.ruleItems.eventDeadline)],
      [
        'long-delay',
        new Date(
          Date.parse(judgementAt) + (seoul.ruleItems.longDelayDays ?? 0) * DAY_MS,
        ).toISOString(),
      ],
    ] as const;

    // --- a visitor in Seoul, the projects' own zone: a market judged in Seoul reads one line per
    // time — the zones are the same.
    await page.goto(`/markets/${seoul.slug}`);
    await signedOutSettled(page);
    const seoulId = detailCopyTestId(page, 'market-rules');
    await expect(page.getByTestId(`${seoulId}-close-at-viewer-zone`)).toHaveText(
      formatKst(seoul.closeAt),
    );
    await expect(page.getByTestId(seoulId).locator(JUDGEMENT_LINES)).toHaveCount(0);

    const context = await browser.newContext({ timezoneId: NEW_YORK_ZONE });
    try {
      const nyPage = await context.newPage();
      const hydrationErrors = watchHydration(nyPage);

      // --- in New York, signed out (ADR-0061 #60-8: the browser's zone): each time in New York,
      // marked, and under it the same instant in Seoul, the market's 판정 기준 시간대.
      await nyPage.goto(`/markets/${seoul.slug}`);
      await signedOutSettled(nyPage);
      const id = detailCopyTestId(nyPage, 'market-rules');
      for (const [row, at] of rows) {
        await expect(nyPage.getByTestId(`${id}-${row}-viewer-zone`)).toHaveText(NEW_YORK);
        await expect(nyPage.getByTestId(`${id}-${row}-judgement-zone`)).toHaveText(
          `${copy.rulesJudgementZoneLine} ${formatKst(at)}`,
        );
        await expectSecondLineUnder(nyPage, `${id}-${row}`);
      }
      await expect(nyPage.getByTestId(`${id}-announcement-at`)).toHaveText(
        copy.rulesAnnouncementNone,
      );
      await expect(nyPage.getByTestId(`${id}-judgement-time-zone`)).toHaveText(/^Asia\/Seoul — /);
      // Open: the scheduled open is history, not a rule row.
      await expect(nyPage.getByTestId(`${id}-scheduled-open-at`)).toHaveCount(0);
      expect(hydrationErrors).toEqual([]);

      // The server's HTML is every visitor's: KST, one line per time, no marker (ADR-0063).
      const html = await (await request.get(`/markets/${seoul.slug}`)).text();
      for (const [, at] of rows) expect(html).toContain(formatKst(at));
      expect(html).not.toMatch(ANY_MARKER);
      expect(html).not.toContain('-judgement-zone"');

      // --- a market judged in New York reads one line per time here: the zones are the same.
      await nyPage.goto(`/markets/${newYork.slug}`);
      await signedOutSettled(nyPage);
      await expect(nyPage.getByTestId(`${id}-close-at-viewer-zone`)).toHaveText(NEW_YORK);
      await expect(nyPage.getByTestId(`${id}-judgement-at-viewer-zone`)).toHaveText(NEW_YORK);
      await expect(nyPage.getByTestId(id).locator(JUDGEMENT_LINES)).toHaveCount(0);
      await expect(nyPage.getByTestId(`${id}-judgement-time-zone`)).toHaveText(
        /^America\/New_York — /,
      );
      expect(hydrationErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('예정 판정 시각이 지난 거래 마감 시장은 상세와 검색의 카드에서 거래 마감 대신 판정 지연으로 보인다', async ({
    admin,
    page,
    request,
  }) => {
    // Closes and is judged in 25 seconds: room for making it and opening it through the review,
    // which needs the close ahead, and then a short wait. The 사건 기한 is at the judgement too (A1).
    const dueAt = new Date(Date.now() + 25_000).toISOString();
    const market = await createOpenMarket(admin, {
      closeAt: dueAt,
      ruleItems: { eventDeadline: dueAt },
      times: { scheduledJudgementAt: dueAt },
    });
    // 마감 by the operator now (the interim manual close): closed, its judgement still ahead.
    const closed = await closeMarket(admin, market.id);
    expect(closed.status).toBe('closed');

    // The label is the server's, read at the read (#173 item 11): wait for the judgement to pass.
    await expect
      .poll(
        async () =>
          (await dataOf<Market>(await request.get(`/api/v1/markets/${market.slug}`)))
            .judgementDelayed,
        { timeout: 60_000, intervals: [1_000] },
      )
      .toBe(true);
    const adminView = await dataOf<AdminMarket>(
      await admin.get(`/api/v1/admin/markets/${market.id}`),
    );
    expect(adminView).toMatchObject({ status: 'closed', judgementDelayed: true });

    // --- the detail: '판정 지연' in place of '거래 마감', and a notice that says no result is out —
    // never that a late result means NO.
    await page.goto(`/markets/${market.slug}`);
    await expect(page.getByTestId('market-status-badge')).toHaveText(
      copy.marketStatusJudgementDelayed,
    );
    await expect(page.getByTestId('market-status-notice')).toContainText(
      copy.marketJudgementDelayedNotice,
    );

    // --- its card where the search lists it (every status is searched, ADR-0066).
    await page.goto(`/search?q=${market.tag}`);
    const card = page.getByTestId(`market-card-${market.id}`);
    await expect(card).toContainText(copy.marketStatusJudgementDelayed);
    await expect(card).not.toContainText(copy.marketStatusClosed);
  });
});
