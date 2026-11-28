import type { APIRequestContext, APIResponse, Locator, Page, Request } from '@playwright/test';
import type {
  AdminMarket,
  AdminMarketJudgementIncidentQueueItem,
  AdminMarketWorkEntry,
  LedgerEntry,
  Market,
  MySettlement,
} from '@buddha/shared';
import { MINUS_SIGN } from '@buddha/shared';
import { copy } from '../src/copy';
import { expectNoExcludedText } from './acceptance';
import { test } from './admin-role-fixture';
import {
  accountIdOf,
  adminAccount,
  closeMarket,
  createOpenMarket,
  detailCopyTestId,
  documentSurvived,
  expect,
  expectNoSideScroll,
  helperTraders,
  inboxOf,
  judgeMarket,
  judgementEvidenceLink,
  kstLocalOf,
  markDocument,
  meOf,
  noticesOf,
  notificationRow,
  openCounted,
  secondAdminAccount,
  signIn,
  skipUnlessResolvable,
  subscribed,
  waitForSettled,
} from './helpers';

/**
 * 판정 오류 사건과 공개 정정 기록 (#144 part 1, ADR-0165; owner answers 144-3·144-4·144-5·144-8·144-9,
 * 144-13·144-14·144-19; #144 AC 1·2·4, N03 §9 '지급 후 오류 시험' in part): a market judged YES and
 * paid — the worker confirms it after the one-minute dispute window and pays it out — then, on its
 * admin detail, the admin who registered that paid judgement (`admin`: 144-4 lets the paid
 * version's registrant register an incident, and `judgeMarket` registers as admin and approves as
 * the reviewer) registers a 판정 오류 사건 — NO, what went wrong, a link and its collection instant —
 * and nothing public changes: it waits, its registrant has no 오류 확인 or 기각 (#171) and alone
 * may retract it. The second admin (`reviewer`) finds it in 판정 오류 사건 검토 대기, under 검수 대기,
 * opens its detail and confirms it with a reason. A visitor's open detail then reads, without a
 * reload (the same-key `market:status` repeat), the corrected result NO with the 판정 정정 mark
 * and 144-5's settled sentence, and the public 판정 기록 carries the 판정 정정 section — NO, 원래 결과
 * YES (v1), the no-claw-back sentence, the description and evidence — above the paid version, and
 * 144-9's 고객센터 이메일 line; no admin identity and no reviewer's reason. The market row, its
 * judgement version and its status never move (AC 2). The work history lists the registration and
 * the confirmation under 판정.
 *
 * Before any of that, the reviewer alone cannot register one: with the paid version's registrant
 * (`admin`) and the registrant themself excluded, no admin is left to decide it (`no_decider`) —
 * checked under the admin-role lock (admin-role-fixture.ts), so no spec's temporary third admin
 * is in the count.
 *
 * Every refusal's details and order, the records, the database's guards and the public answers'
 * private fields are the API's and the database's integration tests
 * (admin-market-judgement-incidents.controller.test.ts, private-data.test.ts, packages/db
 * market-judgement-incident.test.ts); the panel, its dialogs, the queue and what a refusal says are
 * unit-tested (market-judgement-incident-panel.test.tsx, admin-market-judgement-incidents.test.tsx,
 * lib/market-judgement-incident.test.ts). The queue is oldest first on a database earlier runs
 * added to, so it is paged through until the spec's row shows, and a run that fails halfway
 * retracts what it left waiting.
 */

const MINUTE_MS = 60 * 1_000;

/** The ISO instant of the whole minute `ms` falls in: what a `datetime-local` input holds. */
function minuteIso(ms: number): string {
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString();
}

/** `{ data }` out of the success envelope, with the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} -> ${String(response.status())} ${body}`).toBe(true);
  return (JSON.parse(body) as { data: T }).data;
}

/** A refusal's `details`, once its status and code are the ones expected. */
async function refusalOf(response: APIResponse, status: number, code: string): Promise<unknown> {
  const body = await response.text();
  expect(response.status(), body).toBe(status);
  const { error } = JSON.parse(body) as { error: { code: string; details: unknown } };
  expect(error.code).toBe(code);
  return error.details;
}

async function adminMarketOf(context: APIRequestContext, id: string): Promise<AdminMarket> {
  return dataOf<AdminMarket>(await context.get(`/api/v1/admin/markets/${id}`));
}

/** `POST /admin/markets/:id/judgement-incidents` as the admin `context` is signed in as. */
async function sendIncidentRegistration(
  context: APIRequestContext,
  marketId: string,
  body: { correctedResult: 'YES' | 'NO' | 'VOID'; description: string; links: string[] },
): Promise<APIResponse> {
  return context.post(`/api/v1/admin/markets/${marketId}/judgement-incidents`, {
    data: {
      noConflictConfirmed: true,
      correctedResult: body.correctedResult,
      description: body.description,
      evidence: {
        links: body.links,
        collectedAt: new Date(Date.now() - 5 * MINUTE_MS).toISOString(),
      },
      expectedAccountId: await accountIdOf(context),
    },
  });
}

/** Retracts the incident `context`'s admin left waiting, for a `finally`. Best effort. */
async function leaveNoIncident(context: APIRequestContext, marketId: string): Promise<void> {
  const market = await adminMarketOf(context, marketId).catch(() => null);
  const requestId = market?.judgementIncident.pending?.requestId;
  if (requestId === undefined) return;
  await context
    .post(`/api/v1/admin/markets/${marketId}/judgement-incidents/${requestId}/retract`, {
      data: { expectedAccountId: await accountIdOf(context) },
    })
    .catch(() => undefined);
}

/** Retracts the compensation request `context`'s admin left waiting, for a `finally`. */
async function leaveNoCompensationRequest(
  context: APIRequestContext,
  marketId: string,
): Promise<void> {
  const market = await adminMarketOf(context, marketId).catch(() => null);
  const requestId = market?.judgementIncident.compensation?.pending?.requestId;
  if (requestId === undefined) return;
  await context
    .post(`/api/v1/admin/markets/${marketId}/judgement-compensations/${requestId}/retract`, {
      data: { expectedAccountId: await accountIdOf(context) },
    })
    .catch(() => undefined);
}

/** Every request id 판정 오류 사건 검토 대기 holds, read through to its last page. */
async function waitingIncidentIds(context: APIRequestContext): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const after: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
    const response = await context.get(
      `/api/v1/admin/market-judgement-incidents?limit=100${after}`,
    );
    const body = await response.text();
    expect(response.ok(), body).toBe(true);
    const page = JSON.parse(body) as {
      data: AdminMarketJudgementIncidentQueueItem[];
      meta: { nextCursor: string | null };
    };
    ids.push(...page.data.map((item) => item.requestId));
    cursor = page.meta.nextCursor;
  } while (cursor !== null);
  return ids;
}

/** Presses 더 보기 on 판정 오류 사건 검토 대기 until `row` shows (oldest first, earlier runs' rows). */
async function showInIncidents(page: Page, row: Locator): Promise<void> {
  const more = page.getByTestId('admin-market-judgement-incidents-more');
  for (let pages = 0; pages < 50; pages += 1) {
    await expect(more.or(row).first()).toBeVisible();
    if (await row.isVisible()) return;
    const next = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/v1/admin/market-judgement-incidents',
    );
    await more.click();
    await next;
    await expect(
      page.locator('[data-testid="admin-market-judgement-incidents-more"][data-loading]'),
    ).toHaveCount(0);
  }
  await expect(row).toBeVisible();
}

/** Lets the page's toasts go before the next press (a toast stack can cover the panel). */
async function letToastsGo(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-scope="toast"][data-part="root"]')).toHaveCount(0);
}

/** The `POST /admin/markets/:id<suffix>` this page sends next. */
function nextWrite(page: Page, marketId: string, suffix: string): Promise<Request> {
  return page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/v1/admin/markets/${marketId}${suffix}`,
  );
}

test.describe('판정 오류 사건 (#144, ADR-0165)', () => {
  test('지급 완료 시장에서 지급한 판정의 등록자가 사건을 등록하면 아무것도 공개되지 않고, 다른 관리자가 검토 대기에서 찾아 사유와 함께 오류 확인하면 방문자의 상세가 리프레시 없이 정정된 결과와 판정 정정을 보이고 공개 판정 기록에 정정 기록과 고객센터 이메일 안내가 올라가며, 시장 행과 판정 버전은 그대로다 @ac189-6', async ({
    browser,
    admin,
    reviewer,
    page,
  }) => {
    // The dispute window, a minute, is waited out, then the payout.
    test.slow();
    await skipUnlessResolvable(admin);
    const market = await createOpenMarket(admin);
    await closeMarket(admin, market.id);
    await judgeMarket(admin, market.id, 'YES');
    const paid = await waitForSettled(admin, market.id);
    expect(paid.resolvedResult).toBe('YES');
    expect(paid.judgementVersion).toBe(1);
    expect(paid.judgementIncident).toMatchObject({
      registrable: true,
      confirmable: true,
      pending: null,
      confirmed: null,
    });
    const first = await accountIdOf(admin);
    const second = await accountIdOf(reviewer);
    // The paid version's registrant is `admin` (`judgeMarket` registers as it): 144-4.
    expect(paid.judgement.current?.registeredBy.id).toBe(first);

    const link = judgementEvidenceLink(market.id);
    const collectedAt = minuteIso(Date.now() - 5 * MINUTE_MS);
    const description = `1차 출처가 발표를 정정해 결과는 NO입니다 ${market.tag}`;
    const reason = `정정 발표와 근거 링크를 확인했습니다 ${market.tag}`;

    // --- the reviewer alone cannot: with itself and the paid registrant out, no one decides it.
    expect(
      await refusalOf(
        await sendIncidentRegistration(reviewer, market.id, {
          correctedResult: 'NO',
          description,
          links: [link],
        }),
        409,
        'APPROVAL_NOT_ALLOWED',
      ),
    ).toEqual([{ path: ['request'], message: 'no_decider' }]);

    // --- the visitor, signed out, in the market's room first: 지급 완료, YES, no correction.
    const joined = subscribed(page, market.id);
    await page.goto(`/markets/${market.slug}`);
    await joined;
    await markDocument(page);
    const notice = page.getByTestId('market-status-notice');
    const result = notice.getByTestId('market-detail-result');
    await expect(result).toHaveText(copy.yes);
    await expect(notice.getByTestId('market-detail-result-corrected')).toHaveCount(0);
    const record = page.getByTestId(detailCopyTestId(page, 'market-judging-record'));
    const recordId = detailCopyTestId(page, 'market-judging-record');
    // 144-9: 결과 확정 뒤의 판정 오류는 고객센터 이메일로 — on the record before any incident.
    await expect(page.getByTestId(`${recordId}-report`)).toContainText(
      '결과 확정 뒤의 판정 오류는 고객센터 이메일',
    );
    await expect(page.getByTestId(`${recordId}-correction`)).toHaveCount(0);

    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    try {
      // --- admin 1, the paid version's registrant, registers it on the detail.
      const firstPage = await firstContext.newPage();
      await signIn(firstPage, adminAccount.email, adminAccount.password);
      await firstPage.goto(`/admin/markets/${market.id}`);
      const panel = firstPage.getByTestId('market-judgement-incident');
      await expect(panel).toHaveAttribute('data-status', 'settled');
      await expect(firstPage.getByTestId('market-judgement-incident-log-empty')).toHaveText(
        copy.adminMarketJudgementIncidentLogEmpty,
      );
      await letToastsGo(firstPage);
      await firstPage.getByTestId('market-judgement-incident-register').click();
      const dialog = firstPage.getByTestId('market-judgement-incident-register-dialog');
      await expect(dialog.getByTestId('market-judgement-incident-register-paid')).toContainText(
        'YES (v1)',
      );
      // The paid result is not offered.
      await expect(dialog.getByTestId('market-judgement-incident-result-yes')).toHaveCount(0);
      await dialog.getByTestId('market-judgement-incident-result-no').click();
      await dialog.getByTestId('market-judgement-incident-description').fill(description);
      await dialog.getByTestId('market-judgement-incident-link-0').fill(link);
      await dialog
        .getByTestId('market-judgement-incident-collected-at')
        .fill(kstLocalOf(collectedAt));
      const confirmRegister = dialog.getByTestId(
        'market-judgement-incident-register-dialog-confirm',
      );
      await expect(confirmRegister).toBeDisabled();
      await dialog.getByTestId('market-judgement-incident-register-confirm-conflict').click();
      await expect(confirmRegister).toBeEnabled();
      const registered = nextWrite(firstPage, market.id, '/judgement-incidents');
      await confirmRegister.click();
      expect((await registered).postDataJSON()).toEqual({
        correctedResult: 'NO',
        description,
        evidence: { links: [link], collectedAt },
        noConflictConfirmed: true,
        expectedAccountId: first,
      });
      await expect(firstPage.getByText(copy.adminMarketJudgementIncidentRegistered)).toBeVisible();
      await expect(dialog).toHaveCount(0);

      // --- waiting: its registrant has no 오류 확인 or 기각 (#171) and alone may retract it; one
      // waits at a time; nothing public changed.
      await expect(firstPage.getByTestId('market-judgement-incident-pending-result')).toHaveText(
        copy.no,
      );
      await expect(firstPage.getByTestId('market-judgement-incident-confirm')).toHaveCount(0);
      await expect(firstPage.getByTestId('market-judgement-incident-dismiss')).toHaveCount(0);
      await expect(firstPage.getByTestId('market-judgement-incident-retract')).toBeEnabled();
      await expect(firstPage.getByTestId('market-judgement-incident-own-note')).toHaveText(
        copy.adminMarketJudgementIncidentOwnNote,
      );
      await expect(
        firstPage.getByTestId('market-judgement-incident-unregistrable'),
      ).toHaveAttribute('data-reason', 'pending');
      const waiting = await adminMarketOf(admin, market.id);
      const requestId = waiting.judgementIncident.pending?.requestId;
      if (requestId === undefined) throw new Error(`no incident waits on market ${market.id}`);
      expect(waiting.judgementIncident.pending?.requestedBy.id).toBe(first);
      expect(
        await refusalOf(
          await sendIncidentRegistration(reviewer, market.id, {
            correctedResult: 'VOID',
            description,
            links: [link],
          }),
          400,
          'VALIDATION_ERROR',
        ),
      ).toEqual([{ path: ['incident'], message: 'pending' }]);
      const pendingPublic = await dataOf<Market>(
        await page.request.get(`/api/v1/markets/${market.id}`),
      );
      expect(pendingPublic.judgingRecord.correction).toBeNull();
      expect(JSON.stringify(pendingPublic)).not.toContain(description);
      await expect(result).toHaveText(copy.yes);

      // --- admin 2 finds it in 판정 오류 사건 검토 대기, under 검수 대기.
      const secondPage = await secondContext.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      expect(await waitingIncidentIds(reviewer)).toContain(requestId);
      await secondPage.goto('/admin/markets/reviews');
      await expect(secondPage.getByTestId('admin-market-judgement-incidents')).toContainText(
        copy.adminMarketJudgementIncidents,
      );
      const row = secondPage.getByTestId(`admin-market-judgement-incident-${requestId}`);
      await showInIncidents(secondPage, row);
      await expect(row).toHaveAttribute('data-market', market.id);
      await expect(
        secondPage.getByTestId(`admin-market-judgement-incident-original-${requestId}`),
      ).toHaveText(copy.yes);
      await expect(
        secondPage.getByTestId(`admin-market-judgement-incident-result-${requestId}`),
      ).toHaveText(copy.no);
      await secondPage.getByTestId(`admin-market-judgement-incident-link-${requestId}`).click();
      await expect(secondPage).toHaveURL(`/admin/markets/${market.id}`);

      // --- 오류 확인 with a reason and the conflict confirmation; no 철회 for the reviewer.
      await expect(secondPage.getByTestId('market-judgement-incident-retract')).toHaveCount(0);
      await expect(secondPage.getByTestId('market-judgement-incident-confirm-waits')).toHaveCount(
        0,
      );
      await expect(secondPage.getByTestId('market-judgement-incident-dismiss')).toBeEnabled();
      await letToastsGo(secondPage);
      await secondPage.getByTestId('market-judgement-incident-confirm').click();
      const confirmDialog = secondPage.getByTestId('market-judgement-incident-confirm-dialog');
      const confirm = confirmDialog.getByTestId('market-judgement-incident-confirm-dialog-confirm');
      await expect(
        confirmDialog.getByTestId('market-judgement-incident-confirm-dialog-request-result'),
      ).toHaveText(copy.no);
      await expect(confirm).toBeDisabled();
      await confirmDialog
        .getByTestId('market-judgement-incident-confirm-dialog-reason')
        .fill(reason);
      await expect(confirm).toBeDisabled();
      await confirmDialog.getByTestId('market-judgement-incident-confirm-confirm-conflict').click();
      await expect(confirm).toBeEnabled();
      const confirmed = nextWrite(
        secondPage,
        market.id,
        `/judgement-incidents/${requestId}/confirm`,
      );
      await confirm.click();
      expect((await confirmed).postDataJSON()).toEqual({
        reason,
        noConflictConfirmed: true,
        expectedAccountId: second,
      });
      await expect(
        secondPage.getByText(copy.adminMarketJudgementIncidentConfirmDone),
      ).toBeVisible();
      await expect(confirmDialog).toHaveCount(0);
      await expect(secondPage.getByTestId('market-judgement-incident-confirmed-result')).toHaveText(
        copy.no,
      );
      await expect(secondPage.getByTestId('market-detail-resolved-result')).toContainText(
        `${copy.yes} → ${copy.adminMarketResultCorrected} ${copy.no}`,
      );
      await expect(
        secondPage.getByTestId('market-judgement-incident-unregistrable'),
      ).toHaveAttribute('data-reason', 'confirmed');

      // --- AC 2: the market row, its version, its status and its paid result never moved.
      const after = await adminMarketOf(admin, market.id);
      expect(after).toMatchObject({
        status: 'settled',
        resolvedResult: 'YES',
        judgementVersion: 1,
        resolvedAt: paid.resolvedAt,
        settledAt: paid.settledAt,
      });
      expect(after.judgement.current?.version).toBe(1);
      expect(after.judgement.current?.result).toBe('YES');
      expect(after.judgementIncident.confirmed).toMatchObject({
        requestId,
        originalResult: 'YES',
        correctedResult: 'NO',
        reason,
      });

      // --- the visitor's open detail, without a reload: NO with the mark, 144-5's sentence, and
      // the record's 판정 정정 above the paid version — no identity, no reviewer's reason.
      await expect(result).toHaveText(copy.no);
      await expect(notice.getByTestId('market-detail-result-corrected')).toHaveText(
        copy.marketResultCorrected,
      );
      await expect(notice.getByTestId('market-status-notice-detail')).toHaveText(
        copy.marketSettledCorrected.replace('{paid}', copy.yes),
      );
      await expect(page.getByTestId(`${recordId}-correction-result`)).toHaveText(copy.no);
      await expect(page.getByTestId(`${recordId}-correction-original`)).toHaveText(
        `${copy.yes} (v1)`,
      );
      await expect(page.getByTestId(`${recordId}-correction-no-clawback`)).toHaveText(
        copy.judgingCorrectionNoClawback,
      );
      await expect(page.getByTestId(`${recordId}-correction-description`)).toHaveText(description);
      await expect(page.getByTestId(`${recordId}-correction-evidence`)).toContainText(link);
      await expect(page.getByTestId(`${recordId}-version-1`)).toContainText(
        `${copy.judgingCurrentVersion} v1`,
      );
      await expect(record).not.toContainText(reason);
      const publicMarket = await dataOf<Market>(
        await page.request.get(`/api/v1/markets/${market.id}`),
      );
      expect(publicMarket.resolvedResult).toBe('YES');
      expect(publicMarket.judgingRecord.correction).toMatchObject({
        result: 'NO',
        originalResult: 'YES',
        judgementVersion: 1,
        description,
        evidence: { links: [link], collectedAt },
      });
      const shown = JSON.stringify(publicMarket);
      for (const secret of [reason, first, second]) expect(shown).not.toContain(secret);
      // All of it came to the open page through the same-key repeat, not a reload.
      expect(await documentSurvived(page)).toBe(true);
      // The mark leads to the record, scrolling the same document.
      await notice.getByTestId('market-detail-result-corrected').click();
      await expect(record).toBeInViewport();
      expect(await documentSurvived(page)).toBe(true);

      // --- 작업 이력 under 판정: the registration and the confirmation.
      const history = await dataOf<AdminMarketWorkEntry[]>(
        await admin.get(`/api/v1/admin/markets/${market.id}/work-history?kind=judgement&limit=100`),
      );
      const types = history.map((entry) => entry.type);
      expect(types).toContain('market_judgement_incident_register');
      expect(types).toContain('market_judgement_incident_confirm');
      await firstPage.goto(`/admin/markets/${market.id}/work-history?kind=judgement`);
      const list = firstPage.getByTestId('market-work-history-list');
      await expect(list).toContainText(copy.adminMarketWorkIncidentRegister);
      await expect(list).toContainText(copy.adminMarketWorkIncidentConfirm);
    } finally {
      await leaveNoIncident(admin, market.id);
      await firstContext.close();
      await secondContext.close();
    }
  });
});

/**
 * 판정 오류 보상 (#144 part 2, ADR-0166; owner answers 144-1·144-2·144-4·144-6·144-7·144-10·144-11·
 * 144-12, 144-15·144-17·144-18·144-19; #144 AC 3·5·6·8, N03 §9 '지급 후 오류 시험'): a market judged YES
 * and paid — the helper's NO buyer (`traders[0]`) paid 0, the YES buyer (`traders[1]`) 100 — then
 * its 판정 오류 사건 (correct result NO) registered by the paid judgement's registrant (`admin`) and
 * confirmed by the second admin, through the API (the screens are spec A's). On the admin detail
 * the 판정 오류 보상 panel shows what the server computed — one account, 100 Coin — and `admin`
 * (144-4 lets the paid registrant ask) asks for it with an internal reason and the reason members
 * read; the public 판정 정정 says '승인 대기 · 대상 계정 1개' and nothing is paid. The second admin
 * approves it on the same panel: the NO buyer is paid 100 at once — the wallet's '판정 오류 보상'
 * row with '사유: …', the market and its 판정 기록, under the kind's filter; the recap's '내 보상
 * 100 Coin'; one 시장 notification in 144-18's sentence — and the YES buyer, over-paid by the
 * original result, keeps every Coin (no claw-back, AC 3), reads '보상 없음' and its MY 정산 이력 row
 * still says YES and 100 Coin with the '판정 정정 · 결과 NO' mark alone (144-17). The public record
 * says '지급 완료 · 대상 계정 1개 · 총 100 Coin', no account; the work history lists the request and
 * the approval under 지급. A 375 width scrolls nothing sideways.
 *
 * Every refusal (held, blocked, stale, registrant, conflict), the database's guards, the
 * reconciliations after a payout and the public answers' private fields are the API's and the
 * database's tests (admin-market-judgement-compensations.controller.test.ts, packages/db
 * judgement-compensation.test.ts, private-data.test.ts); the panel, its dialogs, the recipients
 * list, the recap and the wallet row are unit-tested.
 */
test.describe('판정 오류 보상 (#144, ADR-0166)', () => {
  test('오류가 확인된 지급 완료 시장에서 지급한 판정의 등록자가 보상을 요청하고 다른 관리자가 승인하면 더 받을 회원만 그 차액을 판정 오류 보상으로 받아 지갑·복기·알림에 보이고, 더 받은 회원의 Coin과 정산 기록은 그대로이며 두 회원의 잔액은 음수로 보이지 않고 공개 판정 기록은 건수와 총액만 싣는다 @ac189-6 @ac189-11', async ({
    browser,
    baseURL,
    admin,
    reviewer,
    page,
  }) => {
    // The dispute window, a minute, is waited out, then the payout.
    test.slow();
    await skipUnlessResolvable(admin);
    // `closeMarket`'s one pair: the first buys NO (paid 0 by YES), the second YES (paid 100).
    const [noHolder, yesHolder] = await helperTraders(admin);
    const market = await createOpenMarket(admin);
    await closeMarket(admin, market.id);
    await judgeMarket(admin, market.id, 'YES');
    await waitForSettled(admin, market.id);
    const first = await accountIdOf(admin);
    const second = await accountIdOf(reviewer);
    const [noMe, yesMe] = await Promise.all([meOf(noHolder), meOf(yesHolder)]);

    // --- the incident, registered by the paid registrant and confirmed by the second admin.
    const registered = await dataOf<AdminMarket>(
      await sendIncidentRegistration(admin, market.id, {
        correctedResult: 'NO',
        description: `1차 출처가 발표를 정정해 결과는 NO입니다 ${market.tag}`,
        links: [judgementEvidenceLink(market.id)],
      }),
    );
    const incidentRequest = registered.judgementIncident.pending?.requestId;
    if (incidentRequest === undefined) throw new Error(`no incident waits on ${market.id}`);
    const confirmed = await dataOf<AdminMarket>(
      await reviewer.post(
        `/api/v1/admin/markets/${market.id}/judgement-incidents/${incidentRequest}/confirm`,
        {
          data: {
            reason: `정정 발표를 확인했습니다 ${market.tag}`,
            noConflictConfirmed: true,
            expectedAccountId: second,
          },
        },
      ),
    );
    // 144-1: the NO buyer is owed 1 × 100 − 0; the YES buyer 0 − 100, so not a target.
    expect(confirmed.judgementIncident.compensation).toMatchObject({
      preview: { accountCount: 1, totalCoin: '100', closedCount: 0, blockedCount: 0 },
      held: false,
      pending: null,
      paid: null,
    });
    const publicOf = async () =>
      (await dataOf<Market>(await page.request.get(`/api/v1/markets/${market.id}`))).judgingRecord
        .correction;
    expect((await publicOf())?.compensation).toEqual({
      status: 'preparing',
      accountCount: null,
      paidCount: null,
      totalCoin: null,
    });
    // Each holder's ledger rows of this market (the helper's members trade on other markets of
    // the worker too, whose payouts may land meanwhile: the market's rows alone are compared).
    const marketRowsOf = async (holder: APIRequestContext) =>
      (
        await dataOf<LedgerEntry[]>(
          await holder.get(`/api/v1/me/ledger?marketId=${market.id}&limit=100`),
        )
      ).map(({ id, kind, amountCoin }) => ({ id, kind, amountCoin }));
    const noBefore = await marketRowsOf(noHolder);
    const yesBefore = await marketRowsOf(yesHolder);

    const reason = `정정된 결과로 보상을 요청합니다 ${market.tag}`;
    const userReason = `1차 출처의 정정 발표에 따라 결과를 NO로 바로잡았습니다 ${market.tag}`;
    const approval = `대상 계정과 금액을 확인했습니다 ${market.tag}`;
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    const contexts = [firstContext, secondContext];
    try {
      // --- admin 1 (the paid registrant, 144-4) asks for it on the detail.
      const firstPage = await firstContext.newPage();
      await signIn(firstPage, adminAccount.email, adminAccount.password);
      await firstPage.goto(`/admin/markets/${market.id}`);
      const panel = firstPage.getByTestId('market-judgement-compensation');
      await expect(panel.getByTestId('market-judgement-compensation-preview')).toHaveText(
        '대상 계정 1개 · 총 100 Coin',
      );
      await letToastsGo(firstPage);
      await panel.getByTestId('market-judgement-compensation-request').click();
      const dialog = firstPage.getByTestId('market-judgement-compensation-request-dialog');
      await dialog.getByTestId('market-judgement-compensation-request-reason').fill(reason);
      await dialog
        .getByTestId('market-judgement-compensation-request-user-reason')
        .fill(userReason);
      const confirmRequest = dialog.getByTestId(
        'market-judgement-compensation-request-dialog-confirm',
      );
      await expect(confirmRequest).toBeDisabled();
      await dialog.getByTestId('market-judgement-compensation-request-confirm-conflict').click();
      await expect(confirmRequest).toBeEnabled();
      const requested = nextWrite(firstPage, market.id, '/judgement-compensations');
      await confirmRequest.click();
      // No account and no amount in the body (144-1).
      expect((await requested).postDataJSON()).toEqual({
        reason,
        userReason,
        noConflictConfirmed: true,
        expectedAccountId: first,
      });
      await expect(
        firstPage.getByText(copy.adminMarketJudgementCompensationRequested),
      ).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await expect(panel.getByTestId('market-judgement-compensation-pending-summary')).toHaveText(
        '대상 계정 1개 · 총 100 Coin',
      );
      // Its requester decides nothing (#171).
      await expect(panel.getByTestId('market-judgement-compensation-approve')).toHaveCount(0);
      await expect(panel.getByTestId('market-judgement-compensation-retract')).toBeEnabled();
      // 승인 대기 in public with the 대상 count alone; nothing paid yet.
      expect((await publicOf())?.compensation).toEqual({
        status: 'pending',
        accountCount: 1,
        paidCount: null,
        totalCoin: null,
      });
      expect(await marketRowsOf(noHolder)).toEqual(noBefore);

      // --- admin 2 approves it on the same panel; the approval pays at once (144-2).
      const secondPage = await secondContext.newPage();
      await signIn(secondPage, secondAdminAccount.email, secondAdminAccount.password);
      await secondPage.goto(`/admin/markets/${market.id}`);
      const reviewPanel = secondPage.getByTestId('market-judgement-compensation');
      await expect(
        reviewPanel.getByTestId('market-judgement-compensation-pending-user-reason'),
      ).toHaveText(userReason);
      await letToastsGo(secondPage);
      await reviewPanel.getByTestId('market-judgement-compensation-approve').click();
      const approveDialog = secondPage.getByTestId('market-judgement-compensation-approve-dialog');
      const confirmApprove = approveDialog.getByTestId(
        'market-judgement-compensation-approve-dialog-confirm',
      );
      await approveDialog
        .getByTestId('market-judgement-compensation-approve-dialog-reason')
        .fill(approval);
      await expect(confirmApprove).toBeDisabled();
      await approveDialog
        .getByTestId('market-judgement-compensation-approve-confirm-conflict')
        .click();
      await expect(confirmApprove).toBeEnabled();
      const requestId = (await adminMarketOf(admin, market.id)).judgementIncident.compensation
        ?.pending?.requestId;
      if (requestId === undefined) throw new Error(`no compensation waits on ${market.id}`);
      const approved = nextWrite(
        secondPage,
        market.id,
        `/judgement-compensations/${requestId}/approve`,
      );
      await confirmApprove.click();
      expect((await approved).postDataJSON()).toEqual({
        reason: approval,
        noConflictConfirmed: true,
        expectedAccountId: second,
      });
      await expect(
        secondPage.getByText(copy.adminMarketJudgementCompensationApproved),
      ).toBeVisible();
      await expect(
        reviewPanel.getByTestId('market-judgement-compensation-paid-summary'),
      ).toHaveText('대상 계정 1개 중 1개 지급 · 총 100 Coin');
      await expect(reviewPanel.getByTestId('market-judgement-compensation-request')).toHaveCount(0);

      // --- the Coin: the NO buyer +100 on top, the YES buyer untouched (no claw-back, AC 3).
      const noAfter = await marketRowsOf(noHolder);
      expect(noAfter.slice(1)).toEqual(noBefore);
      expect(noAfter[0]).toMatchObject({ kind: 'JUDGEMENT_COMPENSATION', amountCoin: '100' });
      // Nothing written from the over-paid account, nothing taken back.
      expect(await marketRowsOf(yesHolder)).toEqual(yesBefore);
      const compensationEntries = async (holder: APIRequestContext) =>
        dataOf<LedgerEntry[]>(
          await holder.get(`/api/v1/me/ledger?kind=JUDGEMENT_COMPENSATION&marketId=${market.id}`),
        );
      const [entry, ...more] = await compensationEntries(noHolder);
      expect(more).toEqual([]);
      expect(entry).toMatchObject({
        kind: 'JUDGEMENT_COMPENSATION',
        amountCoin: '100',
        memo: userReason,
        marketId: market.id,
        marketSlug: market.slug,
        refType: 'judgement_compensation',
      });
      expect(await compensationEntries(yesHolder)).toEqual([]);
      // The paid records never move (AC 2); MY 정산 이력 carries the corrected result (144-17).
      const settlements = await dataOf<MySettlement[]>(
        await yesHolder.get(`/api/v1/me/settlements?marketId=${market.id}`),
      );
      expect(settlements).toEqual([
        expect.objectContaining({
          outcome: 'YES',
          result: 'YES',
          payoutCoin: '100',
          correctedResult: 'NO',
        }),
      ]);
      // 144-18: one 시장 notification to the one paid, none to the over-paid.
      const [notice, ...again] = noticesOf(await inboxOf(noHolder), 'market_judgement_compensated');
      expect(again).toEqual([]);
      expect(notice).toMatchObject({
        category: 'market',
        params: {
          marketTitle: market.title,
          originalResult: 'YES',
          correctedResult: 'NO',
          compensationCoin: '100',
        },
      });
      expect(noticesOf(await inboxOf(yesHolder), 'market_judgement_compensated')).toEqual([]);
      // In public: counts and the total, no account, nickname or members' reason (144-6).
      expect((await publicOf())?.compensation).toEqual({
        status: 'paid',
        accountCount: 1,
        paidCount: 1,
        totalCoin: '100',
      });
      const shown = JSON.stringify(
        await dataOf<Market>(await page.request.get(`/api/v1/markets/${market.id}`)),
      );
      for (const secret of [
        noMe.id,
        yesMe.id,
        noMe.profile.nickname ?? noMe.id,
        userReason,
        reason,
        approval,
        first,
        second,
      ]) {
        expect(shown).not.toContain(secret);
      }

      // --- the paid member's screens: the wallet row, its filter, the recap, the notification.
      const noContext = await browser.newContext({
        baseURL,
        storageState: await noHolder.storageState(),
        viewport: page.viewportSize() ?? undefined,
      });
      contexts.push(noContext);
      const noPage = await noContext.newPage();
      await noPage.goto(`/my/wallet?kind=judgement-compensation&market=${market.id}`);
      await expect(noPage.getByTestId('wallet-kind')).toHaveValue('JUDGEMENT_COMPENSATION');
      const ledger = noPage.getByTestId('ledger-list');
      await expect(ledger.getByTestId('ledger-type')).toHaveText([
        copy.ledgerTypeJudgementCompensation,
      ]);
      await expect(ledger.getByTestId('ledger-amount')).toHaveText(['+100 Coin']);
      await expect(ledger.getByTestId('ledger-reason')).toHaveText([`사유: ${userReason}`]);
      await expect(ledger.getByTestId('ledger-market')).toContainText(market.title);
      await expect(ledger.getByTestId('ledger-judging-link')).toHaveAttribute(
        'href',
        `/markets/${market.slug}#judging-record`,
      );
      await noPage.goto(`/markets/${market.slug}`);
      const noPosition = noPage.getByTestId('market-my-position');
      await expect(noPosition.getByTestId('market-settled-corrected-result')).toHaveText(
        '정정된 결과 NO',
      );
      await expect(noPosition.getByTestId('market-settled-compensation')).toHaveText(
        '내 보상 100 Coin',
      );
      const recordId = detailCopyTestId(noPage, 'market-judging-record');
      await expect(noPage.getByTestId(`${recordId}-correction-compensation`)).toHaveText(
        '지급 완료 · 대상 계정 1개 · 총 100 Coin',
      );
      await openCounted(noPage, '/my/notifications');
      if (notice === undefined) throw new Error('no compensation notice');
      await expect(
        notificationRow(noPage, notice.id).getByTestId('notification-row-title'),
      ).toHaveText(`${market.title} 판정 정정 · 결과를 NO로 바로잡고 100 Coin을 보상했습니다.`);
      await expect(
        notificationRow(noPage, notice.id).getByTestId('notification-row-category'),
      ).toHaveText(copy.notificationCategoryMarket);

      // --- the over-paid member: 보상 없음, the record and its MY 정산 이력 row as they were.
      const yesContext = await browser.newContext({
        baseURL,
        storageState: await yesHolder.storageState(),
        viewport: page.viewportSize() ?? undefined,
      });
      contexts.push(yesContext);
      const yesPage = await yesContext.newPage();
      await yesPage.goto(`/markets/${market.slug}`);
      const yesPosition = yesPage.getByTestId('market-my-position');
      await expect(yesPosition.getByTestId('market-settled-compensation')).toHaveText('보상 없음');
      await expect(
        yesPosition.getByTestId('market-settled-yes').getByTestId('market-settled-payout'),
      ).toHaveText('100 Coin');
      await yesPage.goto(`/my/history?kind=settlements&market=${market.id}`);
      const row = yesPage.getByTestId(`history-settlement-${market.id}-YES`);
      await expect(row.getByTestId('history-settlement-result')).toHaveText(copy.yes);
      await expect(row.getByTestId('history-settlement-payout')).toHaveText('100 Coin');
      await expect(row.getByTestId('history-settlement-corrected')).toHaveText(
        '판정 정정 · 결과 NO',
      );

      // --- #189 기준 6 (지급 후 오류, N03 §9 '잔액이 음수로 보이지 않는다'): neither member's
      // balance reads below zero anywhere it is shown — the header chip, the wallet's card and each
      // ledger row's balance after it, MY 보유 계약's card. Not the wallet as a whole: a ledger
      // row that takes Coin is written with the minus sign (ledger-list.tsx), and the helper
      // members' realized P&L may be a loss.
      for (const memberPage of [noPage, yesPage]) {
        await memberPage.goto(`/my/wallet?market=${market.id}`);
        await expect(memberPage.getByTestId('ledger-balance-after').first()).toBeVisible();
        // Each balance drawn before it is read — none left out of the reading below.
        await expect(memberPage.getByTestId('balance-chip')).toHaveText(/\d/);
        await expect(memberPage.getByTestId('wallet-available')).toBeVisible();
        await expect(memberPage.getByTestId('wallet-locked')).toBeVisible();
        const balances = [
          ...(await memberPage.getByTestId('balance-chip').allTextContents()),
          ...(await memberPage.getByTestId('wallet-available').allTextContents()),
          ...(await memberPage.getByTestId('wallet-locked').allTextContents()),
          ...(await memberPage.getByTestId('ledger-balance-after').allTextContents()),
        ];
        await memberPage.goto('/my/positions');
        await expect(memberPage.getByTestId('portfolio-available')).toBeVisible();
        await expectNoExcludedText(memberPage);
        balances.push(
          ...(await memberPage.getByTestId('portfolio-available').allTextContents()),
          ...(await memberPage.getByTestId('portfolio-locked').allTextContents()),
        );
        expect(balances.length).toBeGreaterThanOrEqual(5);
        for (const balance of balances) {
          expect(balance, memberPage.url()).toMatch(/\d/);
          expect(balance, memberPage.url()).not.toContain(MINUS_SIGN);
          expect(balance, memberPage.url()).not.toContain('-');
        }
      }

      // --- 375 wide, the record with its 판정 정정 and 보상 scrolls nothing sideways.
      await noPage.setViewportSize({ width: 375, height: 812 });
      await noPage.goto(`/markets/${market.slug}`);
      await expect(
        noPage.getByTestId(`${detailCopyTestId(noPage, 'market-judging-record')}-correction`),
      ).toBeVisible();
      await expectNoSideScroll(noPage);

      // --- 작업 이력 under 지급: the request and the approval, counts only.
      const history = await dataOf<AdminMarketWorkEntry[]>(
        await admin.get(
          `/api/v1/admin/markets/${market.id}/work-history?kind=settlement&limit=100`,
        ),
      );
      const types = history.map((each) => each.type);
      expect(types).toContain('market_judgement_compensation_request');
      expect(types).toContain('market_judgement_compensation_approve');
      expect(JSON.stringify(history)).not.toContain(noMe.id);
    } finally {
      await leaveNoCompensationRequest(admin, market.id);
      for (const context of contexts) await context.close();
    }
  });
});
