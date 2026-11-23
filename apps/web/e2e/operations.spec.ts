import type { APIRequestContext, Locator, Page, Response } from '@playwright/test';
import {
  type AdminAwaitingJudgementMarket,
  type AdminClosingMarket,
  type AdminMarket,
  type AdminMarketWorkEntry,
  type AdminOperationsFailure,
  type AdminSettlementRetryResult,
  MARKET_WORK_KINDS,
} from '@buddha/shared';
import { copy } from '../src/copy';
import {
  accountIdOf,
  adminAccount,
  approveJudgementAsReviewer,
  closeMarket,
  createOpenMarket,
  expect,
  expectNoSideScroll,
  helperTraders,
  judgeMarket,
  leaveNoJudgement,
  pauseMarket,
  recordJudgementDelay,
  recoverMarketHold,
  registerJudgement,
  signIn,
  skipUnlessResolvable,
  test,
  toastsOf,
  tradeOnce,
  waitForResolved,
  waitForSettled,
  waitPast,
  workerProbeDisabled,
} from './helpers';

/**
 * 운영 대기열 (#145 part 1, ADR-0163; N03 §8): `/admin/operations`, after 이의 접수 in the admin menu,
 * with its three lists — 마감 예정 by window (24시간·3일·7일, 145-1), 판정 대기·지연 with its stage and
 * the current delay record (145-2, 145-11), 정산 실패 with 처리 멈춤 and failed recalls (145-4,
 * 145-8) — and the one operator action, 정산 다시 시도 (145-7, 145-14). A: the windows on two fresh
 * markets, the links to the lists #145 does not build, an empty list. B: a 출처 지연 — a closed
 * market past its scheduled judgement is listed under 지연만 with no record and its status untouched
 * (AC 3), takes a record and a registration, and leaves once judged (AC 7). C: a payout held by a
 * ledger failure is listed as 정산 실패, an operator's retry fails while the hold stands and the
 * market settles once it is recovered, leaving the list (AC 4, AC 7) — and D (#145 part 2,
 * ADR-0164): that market's 작업 이력 holds its tag edit, its pause, its judgement and its payout's
 * attempts, failure record and 시스템 steps, each kind filter only its own, each with 담당자, 시각 and 사유,
 * and none of a second market's work (AC 6).
 *
 * The e2e database persists across runs and both projects share it serially, so each test makes
 * fresh markets, finds its rows by test id after paging (judgement.spec.ts's `showInJudgements`)
 * and never counts rows; what each list holds exactly, its order and its bounds to the millisecond
 * are the API's and the database's tests (admin-operations.controller.test.ts,
 * operations-queues.test.ts), the retry's outcomes and its no-double-payout proofs
 * settlement-retries.controller.test.ts' and market-finalize.test.ts'.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** B's close and scheduled judgement, seconds ahead of its making (delay.spec.ts's). */
const DUE_IN_MS = 25_000;
/** C's close: the trade and the pause first, then the worker's close on schedule. */
const CLOSE_IN_MS = 2 * MINUTE_MS;
/** How long C waits for the worker's close of its paused market (reconciliation.spec.ts's). */
const CLOSE_WAIT_MS = 240_000;
/** How long C waits for its payout to fail (a job at once, the per-minute scan behind it). */
const FAILED_WAIT_MS = 90_000;
const ROOT = '/api/v1/admin/operations';
/** The rows one read of a market's 작업 이력 answers (the API's default page). */
const HISTORY_PAGE = 20;
const minuteIso = (ms: number) => new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString();

/** Every row of one list as `context` reads it through the API, page after page. */
async function rowsOf<T>(context: APIRequestContext, path: string): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams(path.split('?')[1] ?? '');
    query.set('limit', '100');
    if (cursor !== null) query.set('cursor', cursor);
    const response = await context.get(`${ROOT}/${path.split('?')[0] ?? ''}?${query.toString()}`);
    const body = await response.text();
    expect(response.ok(), body).toBe(true);
    const page = JSON.parse(body) as { data: T[]; meta: { nextCursor: string | null } };
    rows.push(...page.data);
    cursor = page.meta.nextCursor;
  } while (cursor !== null);
  return rows;
}

const closingIds = async (context: APIRequestContext, within: '24h' | '3d' | '7d') =>
  (await rowsOf<AdminClosingMarket>(context, `closing?within=${within}`)).map((row) => row.id);

const judgementRow = async (
  context: APIRequestContext,
  filter: 'all' | 'delayed',
  marketId: string,
) =>
  (await rowsOf<AdminAwaitingJudgementMarket>(context, `judgements?filter=${filter}`)).find(
    (row) => row.id === marketId,
  );

const failureRow = async (context: APIRequestContext, marketId: string) =>
  (await rowsOf<AdminOperationsFailure>(context, 'failures')).find(
    (row) => row.id === marketId && row.kind === 'settlement_failed',
  );

async function marketOf(admin: APIRequestContext, marketId: string): Promise<AdminMarket> {
  const response = await admin.get(`/api/v1/admin/markets/${marketId}`);
  const body = await response.text();
  expect(response.ok(), body).toBe(true);
  return (JSON.parse(body) as { data: AdminMarket }).data;
}

/** Sets an OPEN market's tags through the admin edit (`market_update`, #172 item 14). */
async function editTags(admin: APIRequestContext, marketId: string, tags: string[]): Promise<void> {
  const response = await admin.patch(`/api/v1/admin/markets/${marketId}`, {
    data: { tags, expectedAccountId: await accountIdOf(admin) },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

/**
 * Presses a list's 더 보기 until `row` shows, or until no page follows (`present: false` then
 * passes): the lists put earlier runs' markets before a fresh one.
 */
async function showIn(page: Page, list: string, row: Locator): Promise<boolean> {
  const more = page.getByTestId(`admin-operations-${list}-more`);
  const empty = page.getByTestId(`admin-operations-${list}-empty`);
  const table = page.getByTestId(`admin-operations-${list}-list`);
  await expect(table.or(empty).first()).toBeVisible();
  for (let pages = 0; pages < 100; pages += 1) {
    if (await row.isVisible()) return true;
    if (!(await more.isVisible())) return false;
    const next = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === `${ROOT}/${list}`,
    );
    await more.click();
    await next;
    await expect(
      page.locator(`[data-testid="admin-operations-${list}-more"][data-loading]`),
    ).toHaveCount(0);
  }
  return row.isVisible();
}

/** Lets the page's toasts go before the next press (themes.spec.ts's `letToastsGo`). */
async function letToastsGo(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await expect(toastsOf(page)).toHaveCount(0);
}

/** The retry POST this page sends next for `marketId`. */
function nextRetry(page: Page, marketId: string): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/admin/markets/${marketId}/settlement-retries`,
  );
}

/** Every entry of one market's 작업 이력 as `context` reads it, oldest first, page after page. */
async function workHistoryOf(
  context: APIRequestContext,
  marketId: string,
  kind?: AdminMarketWorkEntry['kind'],
): Promise<AdminMarketWorkEntry[]> {
  const entries: AdminMarketWorkEntry[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (kind !== undefined) query.set('kind', kind);
    if (cursor !== null) query.set('cursor', cursor);
    const response = await context.get(
      `/api/v1/admin/markets/${marketId}/work-history?${query.toString()}`,
    );
    const body = await response.text();
    expect(response.ok(), body).toBe(true);
    const page = JSON.parse(body) as {
      data: AdminMarketWorkEntry[];
      meta: { nextCursor: string | null };
    };
    entries.push(...page.data);
    cursor = page.meta.nextCursor;
  } while (cursor !== null);
  return entries;
}

/** Presses the history's 더 보기 until no page follows, so every entry is on screen. */
async function showWholeHistory(page: Page): Promise<void> {
  const more = page.getByTestId('market-work-history-more');
  await expect(
    page.getByTestId('market-work-history-list').or(page.getByTestId('market-work-history-empty')),
  ).toBeVisible();
  for (let pages = 0; pages < 20 && (await more.isVisible()); pages += 1) {
    const next = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname.endsWith('/work-history'),
    );
    await more.click();
    await next;
    await expect(
      page.locator('[data-testid="market-work-history-more"][data-loading]'),
    ).toHaveCount(0);
  }
  await expect(more).toHaveCount(0);
}

/** The ids of the history rows on screen, in order. */
function workRowIds(page: Page): Promise<(string | null)[]> {
  return page
    .getByTestId('market-work-history-list')
    .locator('tbody > tr')
    .evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-testid')?.replace('market-work-entry-', '') ?? null),
    );
}

/** The one entry of `type` in `entries` that `match` picks, failing when there is none. */
function onlyEntry(
  entries: readonly AdminMarketWorkEntry[],
  type: AdminMarketWorkEntry['type'],
  match: (entry: AdminMarketWorkEntry) => boolean = () => true,
): AdminMarketWorkEntry {
  const found = entries.filter((entry) => entry.type === type && match(entry));
  expect(found, `${type} in the history`).toHaveLength(1);
  return found[0]!;
}

/**
 * D (#145 part 2, ADR-0164; AC 6): `market`'s 작업 이력, reached from its detail's header, as the
 * API reads it and as the screen draws it — every entry with its 담당자 (a nickname or 시스템), 시각
 * and 사유 (or the line standing for one, 145-16); each of the four kinds the spec made — 수정 (the
 * tag edit), 중단 (the pause), 판정 (the registration and its approval), 지급 (the operator's
 * attempts, the recovery, the failure record and the 시스템 steps) — under its own filter and only
 * there; and nothing of `other`, a second market with work of its own.
 */
async function checkWorkHistory(
  page: Page,
  admin: APIRequestContext,
  market: { id: string; tag: string },
  expected: {
    addedTag: string;
    pauseNote: string;
    failedReason: string;
    settledReason: string | null;
    other: { id: string; addedTag: string };
  },
): Promise<void> {
  const entries = await workHistoryOf(admin, market.id);
  const tagEdit = onlyEntry(entries, 'market_update', (entry) =>
    entry.changes.some(
      (change) =>
        change.field === 'tags' && JSON.stringify(change.after).includes(expected.addedTag),
    ),
  );
  expect(tagEdit).toMatchObject({ kind: 'edit', reasonBasis: 'changed_items' });
  expect(onlyEntry(entries, 'market_pause')).toMatchObject({
    kind: 'pause',
    reason: expected.pauseNote,
  });
  const registered = onlyEntry(entries, 'market_judgement_request');
  const approved = onlyEntry(entries, 'market_judgement_approve');
  for (const judged of [registered, approved]) {
    expect(judged.kind).toBe('judgement');
    expect(judged.reason ?? '').not.toBe('');
  }
  expect(onlyEntry(entries, 'resolved')).toMatchObject({ kind: 'judgement', actor: null });
  const failedRetry = onlyEntry(
    entries,
    'market_settlement_retry',
    (entry) => entry.reason === expected.failedReason,
  );
  expect(failedRetry).toMatchObject({ kind: 'settlement', retryOutcome: 'failed' });
  const settledRetry =
    expected.settledReason === null
      ? null
      : onlyEntry(
          entries,
          'market_settlement_retry',
          (entry) => entry.reason === expected.settledReason,
        );
  if (settledRetry !== null) expect(settledRetry.retryOutcome).toBe('settled');
  expect(onlyEntry(entries, 'reconciliation_recovery_approve').kind).toBe('settlement');
  for (const step of ['settling', 'finalized'] as const) {
    expect(onlyEntry(entries, step)).toMatchObject({ kind: 'settlement', actor: null });
  }
  const failure = onlyEntry(entries, 'settlement_step');
  expect(failure).toMatchObject({ kind: 'settlement', actor: null });
  expect(failure.settlement?.settlementAttempts ?? 0).toBeGreaterThan(0);
  // A second market's work never appears here (AC 6), and it has its own.
  expect(JSON.stringify(entries)).not.toContain(expected.other.addedTag);
  expect(JSON.stringify(entries)).not.toContain(expected.other.id);
  expect(JSON.stringify(await workHistoryOf(admin, expected.other.id))).toContain(
    expected.other.addedTag,
  );

  // --- on screen, from the detail's header: 전체, oldest first, every entry with who, when, why.
  await page.goto(`/admin/markets/${market.id}`);
  const link = page.getByTestId('market-detail-work-history');
  await expect(link).toHaveText(copy.adminMarketWorkHistory);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/admin/markets/${market.id}/work-history$`));
  await expect(page.getByTestId('market-work')).toHaveAttribute('data-kind', 'all');
  await showWholeHistory(page);
  await expect.poll(() => workRowIds(page)).toEqual(entries.map((entry) => entry.id));
  const part = (entry: AdminMarketWorkEntry, name: string) =>
    page.getByTestId(`market-work-entry-${entry.id}-${name}`);
  for (const entry of entries) {
    await expect(part(entry, 'actor')).toHaveText(
      entry.actor === null ? copy.eventSystem : (entry.actor.nickname ?? copy.postAuthorFormer),
    );
    await expect(part(entry, 'at')).not.toBeEmpty();
    await expect(part(entry, 'reason')).not.toBeEmpty();
  }
  await expect(part(tagEdit, 'basis')).toHaveText(copy.adminMarketWorkBasisChangedItems);
  await expect(part(tagEdit, 'changes')).toContainText(expected.addedTag);
  await expect(part(failedRetry, 'outcome')).toHaveText(copy.adminMarketWorkRetryFailed);
  await expect(part(failedRetry, 'reason')).toContainText(expected.failedReason);
  if (settledRetry !== null) {
    await expect(part(settledRetry, 'outcome')).toHaveText(copy.adminMarketWorkRetrySettled);
  }
  await expect(part(failure, 'label')).toHaveText(copy.adminMarketWorkStep);
  await expect(part(failure, 'attempts')).toBeVisible();
  await expect(part(failure, 'error-text')).not.toBeEmpty();
  await expect(page.getByTestId('market-work-history')).not.toContainText(expected.other.addedTag);
  await expectNoSideScroll(page);

  // --- each kind: its own entries only, the four the spec made among them.
  const made: Partial<Record<AdminMarketWorkEntry['kind'], AdminMarketWorkEntry[]>> = {
    edit: [tagEdit],
    pause: [onlyEntry(entries, 'market_pause')],
    judgement: [registered, approved],
    settlement: [failedRetry, failure],
  };
  for (const kind of MARKET_WORK_KINDS) {
    const read = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname.endsWith('/work-history') &&
        new URL(response.url()).searchParams.get('kind') === kind,
    );
    await page.getByTestId(`market-work-kind-${kind}`).click();
    await read;
    await expect(page).toHaveURL(new RegExp(`/work-history\\?kind=${kind}$`));
    await expect(page.getByTestId('market-work')).toHaveAttribute('data-kind', kind);
    await expect(page.getByTestId(`market-work-kind-${kind}`)).toHaveAttribute(
      'aria-current',
      'page',
    );
    // The previous kind's rows stay while this one loads: its first page first, then the rest.
    const ofKind = entries.filter((entry) => entry.kind === kind).map((entry) => entry.id);
    await expect.poll(() => workRowIds(page)).toEqual(ofKind.slice(0, HISTORY_PAGE));
    await showWholeHistory(page);
    await expect.poll(() => workRowIds(page)).toEqual(ofKind);
    for (const entry of made[kind] ?? []) {
      await expect(page.getByTestId(`market-work-entry-${entry.id}`)).toHaveAttribute(
        'data-kind',
        kind,
      );
    }
  }
  await page.getByTestId('market-work-kind-all').click();
  await expect(page).toHaveURL(new RegExp(`/admin/markets/${market.id}/work-history$`));
}

test.describe('운영 대기열 (#145)', () => {
  test('마감 예정은 고른 범위 안에 마감되는 시장을 가까운 순으로 보이고 시장을 누르면 처리 화면으로 가며, 메뉴의 이의 접수 다음에 있고 검수 대기·이의 접수로 가는 줄이 있다', async ({
    admin,
    page,
  }) => {
    const soon = await createOpenMarket(admin, { closeAt: minuteIso(Date.now() + 2 * HOUR_MS) });
    const later = await createOpenMarket(admin, { closeAt: minuteIso(Date.now() + 2 * DAY_MS) });
    // In 7일 alone, so the 7일 view is told from the 3일 one it replaces.
    const far = await createOpenMarket(admin, { closeAt: minuteIso(Date.now() + 5 * DAY_MS) });

    // --- the API: 24시간 holds the first alone, 3일 the first two, 7일 all three (145-1).
    expect(await closingIds(admin, '24h')).toContain(soon.id);
    expect(await closingIds(admin, '24h')).not.toContain(later.id);
    for (const within of ['3d', '7d'] as const) {
      const ids = await closingIds(admin, within);
      expect(ids, within).toContain(soon.id);
      expect(ids, within).toContain(later.id);
      expect(ids.includes(far.id), within).toBe(within === '7d');
    }

    // --- the menu: 운영 대기열 right after 이의 접수, the first four as they were.
    await signIn(page, adminAccount.email, adminAccount.password);
    await page.goto('/admin/markets');
    const nav = page.getByTestId('admin-nav');
    expect((await nav.getByRole('link').allTextContents()).slice(0, 5)).toEqual([
      copy.adminMarkets,
      copy.adminMarketReviews,
      copy.adminThemes,
      copy.adminDisputes,
      copy.adminOperations,
    ]);
    await nav.getByRole('link', { name: copy.adminOperations, exact: true }).click();
    await expect(page).toHaveURL('/admin/operations');
    const screen = page.getByTestId('admin-operations');
    await expect(screen).toHaveAttribute('data-list', 'closing');
    await expect(screen.getByRole('heading', { level: 3 })).toHaveText(copy.adminOperations);
    await expect(screen).toContainText(copy.adminOperationsIntro);
    await expect(page.getByTestId('admin-operations-list-closing')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByTestId('admin-operations-within-24h')).toHaveAttribute(
      'aria-current',
      'page',
    );

    // --- 24시간: the first, its link to its detail; not the second.
    const soonRow = page.getByTestId(`admin-operations-closing-${soon.id}`);
    const laterRow = page.getByTestId(`admin-operations-closing-${later.id}`);
    expect(await showIn(page, 'closing', soonRow)).toBe(true);
    await expect(soonRow).toHaveAttribute('data-overdue', 'false');
    await expect(soonRow).toContainText(copy.marketStatusOpen);
    await expect(laterRow).toHaveCount(0);
    await expectNoSideScroll(page);

    // --- 3일: the first two, not the third; then 7일: all three.
    const farRow = page.getByTestId(`admin-operations-closing-${far.id}`);
    for (const within of ['3d', '7d'] as const) {
      await page.getByTestId(`admin-operations-within-${within}`).click();
      await expect(page).toHaveURL(`/admin/operations?within=${within}`);
      await expect(page.getByTestId(`admin-operations-within-${within}`)).toHaveAttribute(
        'aria-current',
        'page',
      );
      // A fresh mount reads the window's own first page: after the click the list keeps the last
      // window's rows on screen while the new one loads (keepPreviousData), and nothing in the DOM
      // tells those rows apart, so `showIn` could read them.
      await page.reload();
      expect(await showIn(page, 'closing', soonRow), within).toBe(true);
      expect(await showIn(page, 'closing', laterRow), within).toBe(true);
      expect(await showIn(page, 'closing', farRow), within).toBe(within === '7d');
    }
    await expectNoSideScroll(page);

    // --- the row leads to the market's processing screen.
    await page.getByTestId(`admin-operations-closing-link-${later.id}`).click();
    await expect(page).toHaveURL(`/admin/markets/${later.id}`);
    await expect(page.getByTestId('market-detail-title')).toHaveText(later.title);

    // --- the two lists #145 links only (issue 범위 '연결만').
    await page.goto('/admin/operations');
    await expect(page.getByTestId('admin-operations-other-lists')).toContainText(
      copy.adminOperationsOtherLists,
    );
    await page.getByTestId('admin-operations-to-reviews').click();
    await expect(page).toHaveURL('/admin/markets/reviews');
    await expect(page.getByTestId('admin-market-judgements')).toBeVisible();
    await page.goto('/admin/operations?list=judgements');
    await page.getByTestId('admin-operations-to-disputes').click();
    await expect(page).toHaveURL('/admin/disputes');
    await expect(page.getByTestId('admin-disputes')).toBeVisible();

    // --- an empty list, answered for this page alone (client-only; nothing written).
    const isFailuresRead = (url: URL) => url.pathname === `${ROOT}/failures`;
    await page.route(isFailuresRead, (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({ status: 200, json: { data: [], meta: { nextCursor: null } } });
    });
    try {
      await page.goto('/admin/operations?list=failures');
      await expect(page.getByTestId('admin-operations')).toHaveAttribute('data-list', 'failures');
      await expect(page.getByTestId('admin-operations-failures-empty')).toHaveText(
        copy.adminOperationsFailuresEmpty,
      );
      await expect(page.getByTestId('admin-operations-filter')).toHaveCount(0);
      await expect(page.getByTestId('admin-operations-within')).toHaveCount(0);
      await expectNoSideScroll(page);
    } finally {
      await page.unroute(isFailuresRead);
    }
  });

  test('출처 지연: 예정 판정 시각이 지난 거래 마감 시장이 지연만에 판정 등록 전·지연 기록 없음으로 보이고 상태는 거래 마감 그대로이며, 지연 기록과 판정 등록이 줄에 보이고 승인되어 잠정 결과가 되면 목록에서 빠진다', async ({
    admin,
    page,
  }) => {
    test.slow();
    // The helper's members before the clock: `closeMarket` trades one pair first (#20).
    await helperTraders(admin);
    await signIn(page, adminAccount.email, adminAccount.password);
    const dueAt = new Date(Date.now() + DUE_IN_MS).toISOString();
    const market = await createOpenMarket(admin, {
      closeAt: dueAt,
      ruleItems: { eventDeadline: dueAt },
      times: { scheduledJudgementAt: dueAt },
    });
    try {
      expect((await closeMarket(admin, market.id)).status).toBe('closed');
      await waitPast(page, dueAt, 2_000);

      // --- past its scheduled judgement: listed under 지연만, nothing registered, no record —
      // and the list changes nothing (AC 3): still CLOSED with no result.
      await expect
        .poll(async () => (await judgementRow(admin, 'delayed', market.id))?.delayed ?? false, {
          timeout: 30_000,
          intervals: [1_000],
        })
        .toBe(true);
      expect(await judgementRow(admin, 'delayed', market.id)).toMatchObject({
        status: 'closed',
        stage: 'unregistered',
        delay: null,
        judgementRequestId: null,
      });
      expect(await marketOf(admin, market.id)).toMatchObject({
        status: 'closed',
        resolvedResult: null,
      });

      await page.goto('/admin/operations?list=judgements&filter=delayed');
      await expect(page.getByTestId('admin-operations-filter-delayed')).toHaveAttribute(
        'aria-current',
        'page',
      );
      const row = page.getByTestId(`admin-operations-judgement-${market.id}`);
      expect(await showIn(page, 'judgements', row)).toBe(true);
      await expect(row).toHaveAttribute('data-stage', 'unregistered');
      await expect(row).toHaveAttribute('data-delayed', 'true');
      await expect(page.getByTestId(`admin-operations-judgement-stage-${market.id}`)).toHaveText(
        copy.adminOperationsStageUnregistered,
      );
      await expect(page.getByTestId(`admin-operations-judgement-no-delay-${market.id}`)).toHaveText(
        copy.adminOperationsNoDelayRecord,
      );
      await expectNoSideScroll(page);
      expect((await marketOf(admin, market.id)).status).toBe('closed');

      // --- a delay record: its reason and 다음 검토 on the row.
      const reason = `1차 출처의 발표가 늦어지고 있습니다 확인 코드 ${market.tag}`;
      await recordJudgementDelay(admin, market.id, { reason });
      await page.reload();
      expect(await showIn(page, 'judgements', row)).toBe(true);
      await expect(
        page.getByTestId(`admin-operations-judgement-delay-reason-${market.id}`),
      ).toHaveText(reason);
      await expect(
        page.getByTestId(`admin-operations-judgement-next-review-${market.id}`),
      ).toContainText(copy.adminOperationsNextReview);

      // --- a registration: 판정 승인 대기, with the way to where it is approved (145-2).
      const registered = await registerJudgement(admin, market.id);
      await page.reload();
      expect(await showIn(page, 'judgements', row)).toBe(true);
      await expect(row).toHaveAttribute('data-stage', 'awaiting_approval');
      const toApprovals = page.getByTestId(`admin-operations-judgement-to-approvals-${market.id}`);
      await expect(toApprovals).toHaveAttribute('href', '/admin/markets/reviews#market-judgements');
      await toApprovals.click();
      await expect(page).toHaveURL('/admin/markets/reviews#market-judgements');
      await expect(page.locator('#market-judgements')).toBeVisible();
      await expect(page.locator('#market-judgements')).toHaveAttribute(
        'data-testid',
        'admin-market-judgements',
      );

      // --- approved by another admin: PROVISIONAL with nothing holding it — out of the list.
      const judged = await approveJudgementAsReviewer(
        admin,
        market.id,
        registered.judgement.pending?.requestId,
      );
      expect(judged.status).toBe('provisional');
      expect(await judgementRow(admin, 'all', market.id)).toBeUndefined();
      await page.goto('/admin/operations?list=judgements&filter=delayed');
      expect(await showIn(page, 'judgements', row)).toBe(false);
    } finally {
      await leaveNoJudgement(admin, market.id);
    }
  });

  test('정산 중단과 재시도: 원장 장애로 묶인 시장의 지급이 실패하면 정산 실패에 대사 보류와 시도 횟수로 보이고, 보류가 남은 동안의 정산 다시 시도는 실패를 보이며, 복구 뒤에는 지급을 마치고 목록에서 빠진다 — 그 시장의 작업 이력에는 수정·중단·판정·지급이 담당자·시각·사유와 함께 남고 다른 시장의 것은 없다', async ({
    admin,
    secondAdmin,
    page,
  }) => {
    test.skip(workerProbeDisabled(), 'The worker must close, confirm and pay the market');
    test.slow();
    await skipUnlessResolvable(admin);
    await helperTraders(admin);
    await signIn(page, adminAccount.email, adminAccount.password);
    const operatorId = await accountIdOf(admin);
    const market = await createOpenMarket(admin, {
      closeAt: minuteIso(Date.now() + CLOSE_IN_MS + MINUTE_MS),
    });
    // D's second market: work of its own, which the first market's 작업 이력 never shows.
    const other = await createOpenMarket(admin);
    const otherTag = `${other.tag}w`;
    await editTags(admin, other.id, [...other.tags, otherTag]);
    const addedTag = `${market.tag}w`;
    const pauseNote = `원장 장애로 멈춘 시장의 지급 재시도 확인 ${market.tag}`;
    let settledReason: string | null = null;
    try {
      // --- 수정 while OPEN (D): a tag added, recorded with the actor, the time and both values.
      await editTags(admin, market.id, [...market.tags, addedTag]);
      // --- a fill, then the ledger-failure pause: the market closes on schedule with its hold
      // (a fill: 거래 마감, not 취소 — #20), is judged, and its payout fails on the hold.
      await tradeOnce(admin, market.id);
      await pauseMarket(admin, market.id, 'ledger_failure', { note: pauseNote });
      await expect
        .poll(async () => (await marketOf(admin, market.id)).status, {
          timeout: CLOSE_WAIT_MS,
          intervals: [1_000, 2_000],
        })
        .toBe('closed');
      await judgeMarket(admin, market.id, 'YES');
      await waitForResolved(admin, market.id);
      await expect
        .poll(async () => (await failureRow(admin, market.id)) !== undefined, {
          timeout: FAILED_WAIT_MS,
          intervals: [1_000, 2_000],
        })
        .toBe(true);
      const listed = await failureRow(admin, market.id);
      if (listed?.kind !== 'settlement_failed') throw new Error('no 정산 실패 row');
      expect(listed).toMatchObject({ status: 'settling', retryable: true });
      expect(listed.settlement.ledgerHeld).toBe(true);
      const attemptsBefore = listed.settlement.settlementAttempts;
      expect((await marketOf(admin, market.id)).status).toBe('settling');

      // --- on screen: 정산 실패 with 대사 보류 and its attempts.
      await page.goto('/admin/operations?list=failures');
      const row = page.getByTestId(`admin-operations-failure-settlement_failed-${market.id}`);
      expect(await showIn(page, 'failures', row)).toBe(true);
      await expect(row).toHaveAttribute('data-kind', 'settlement_failed');
      await expect(
        page.getByTestId(`admin-operations-failure-kind-settlement_failed-${market.id}`),
      ).toHaveText(copy.adminOperationsKindSettlementFailed);
      await expect(
        page.getByTestId(`admin-operations-failure-settlement_failed-${market.id}-ledger-held`),
      ).toHaveText(copy.adminOperationsLedgerHeld);
      await expect(
        page.getByTestId(`admin-operations-failure-settlement_failed-${market.id}-to-ledger`),
      ).toHaveAttribute('href', '/admin/audit-failures');
      await expectNoSideScroll(page);

      // --- 정산 다시 시도 while the hold stands: the attempt runs and fails, the dialog says so.
      const retry = page.getByTestId(`admin-operations-failure-retry-${market.id}`);
      await expect(retry).toHaveText(copy.adminSettlementRetry);
      await retry.click();
      const dialog = page.getByTestId('settlement-retry-dialog');
      await expect(dialog).toContainText(copy.adminSettlementRetryHint);
      await expect(dialog.getByTestId('settlement-retry-dialog-confirm')).toBeDisabled();
      const reason = `대사 보류가 남아 있는지 확인합니다 ${market.tag}`;
      await dialog.getByTestId('settlement-retry-reason').fill(reason);
      const failed = nextRetry(page, market.id);
      await dialog.getByTestId('settlement-retry-dialog-confirm').click();
      const failedResponse = await failed;
      expect(failedResponse.request().postDataJSON()).toEqual({
        reason,
        expectedAccountId: operatorId,
      });
      expect(failedResponse.status()).toBe(200);
      const outcome = ((await failedResponse.json()) as { data: AdminSettlementRetryResult }).data;
      expect(outcome.outcome).toBe('failed');
      if (outcome.outcome !== 'failed') throw new Error('the held payout did not fail');
      expect(outcome.settlementAttempts ?? 0).toBeGreaterThan(attemptsBefore);
      await expect(dialog.getByTestId('settlement-retry-failed')).toContainText(
        copy.adminSettlementRetryFailed,
      );
      await expect(dialog.getByTestId('settlement-retry-failed-attempts')).toBeVisible();
      await expect(dialog.getByTestId('settlement-retry-failed-error-text')).toContainText(
        'ledger recovery approval is pending',
      );
      await dialog.getByTestId('settlement-retry-dialog-cancel').click();
      await expect(dialog).toHaveCount(0);
      expect((await marketOf(admin, market.id)).status).toBe('settling');

      // --- the hold recovered (two admins, #93): the next attempt settles — this operator's or
      // the worker's per-minute scan, whichever comes first; the end state is what is asserted.
      await recoverMarketHold(admin, secondAdmin, market.id);
      await page.reload();
      if (await showIn(page, 'failures', row)) {
        await letToastsGo(page);
        await retry.click();
        const afterRecovery = `복구 뒤 다시 시도 ${market.tag}`;
        await dialog.getByTestId('settlement-retry-reason').fill(afterRecovery);
        const sent = nextRetry(page, market.id);
        await dialog.getByTestId('settlement-retry-dialog-confirm').click();
        const response = await sent;
        if (response.status() === 200) {
          expect(
            ((await response.json()) as { data: AdminSettlementRetryResult }).data,
          ).toMatchObject({ outcome: 'settled' });
          settledReason = afterRecovery;
          await expect(toastsOf(page).first()).toContainText(copy.adminSettlementRetryDone);
        } else {
          // The worker's scan won: the market was no longer 지급 중, nothing was attempted.
          expect(response.status()).toBe(400);
          await expect(toastsOf(page).first()).toContainText(copy.adminSettlementRetryNotSettling);
        }
        await expect(dialog).toHaveCount(0);
      }
      expect((await waitForSettled(admin, market.id)).status).toBe('settled');

      // --- settled: out of the list (AC 4).
      expect(await failureRow(admin, market.id)).toBeUndefined();
      await page.goto('/admin/operations?list=failures');
      expect(await showIn(page, 'failures', row)).toBe(false);

      // --- D: the market's 작업 이력 (#145 part 2, ADR-0164; AC 6).
      await checkWorkHistory(page, admin, market, {
        addedTag,
        pauseNote,
        failedReason: reason,
        settledReason,
        other: { id: other.id, addedTag: otherTag },
      });
    } finally {
      await leaveNoJudgement(admin, market.id);
    }
  });
});
