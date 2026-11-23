import type { APIRequestContext, APIResponse, Locator, Page, Request } from '@playwright/test';
import type {
  AdminMarket,
  AdminMarketJudgementIncidentQueueItem,
  AdminMarketWorkEntry,
  Market,
} from '@buddha/shared';
import { copy } from '../src/copy';
import { test } from './admin-role-fixture';
import {
  accountIdOf,
  adminAccount,
  closeMarket,
  createOpenMarket,
  detailCopyTestId,
  documentSurvived,
  expect,
  judgeMarket,
  judgementEvidenceLink,
  kstLocalOf,
  markDocument,
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
  test('지급 완료 시장에서 지급한 판정의 등록자가 사건을 등록하면 아무것도 공개되지 않고, 다른 관리자가 검토 대기에서 찾아 사유와 함께 오류 확인하면 방문자의 상세가 리프레시 없이 정정된 결과와 판정 정정을 보이고 공개 판정 기록에 정정 기록과 고객센터 이메일 안내가 올라가며, 시장 행과 판정 버전은 그대로다', async ({
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
