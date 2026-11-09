import type { APIRequestContext, APIResponse, Locator, Page } from '@playwright/test';
import type { AdminMarket, Market, MyDispute } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  NO_FILL_CANCEL_REASON,
  approveAsReviewer,
  createDraftMarket,
  createOpenMarket,
  closeMarket,
  detailCopyTestId,
  documentSurvived,
  expect,
  helperTraders,
  leaveNoJudgement,
  leaveNoPauseDecision,
  markDocument,
  meOf,
  pauseMarket,
  recordJudgementDelay,
  registerCorrection,
  registerJudgement,
  requestPauseDecision,
  sendJudgementDecision,
  sendPauseDecision,
  skipUnlessResolvable,
  submitForReview,
  subscribed,
  test,
  tradeOnce,
  waitForSettled,
} from './helpers';

/** #24: real approved records, visible anonymously and to a member; no owner SQL or fake DTOs. */
const minuteIso = (ms: number) => new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
const adminPath = (id: string) => `/api/v1/admin/markets/${id}`;

async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} -> ${String(response.status())} ${body}`).toBe(true);
  return (JSON.parse(body) as { data: T }).data;
}
async function publicMarket(context: APIRequestContext, id: string) {
  return dataOf<Market>(await context.get(`/api/v1/markets/${id}`));
}
function recordOf(page: Page): Locator {
  return page.getByTestId(detailCopyTestId(page, 'market-judging-record'));
}
async function visit(page: Page, market: { id: string; slug: string }) {
  const joined = subscribed(page, market.id);
  await page.goto(`/markets/${market.slug}`);
  await joined;
  await markDocument(page);
  await expect(recordOf(page)).toContainText(copy.judgingPrinciple);
}
async function noOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(widths.content).toBeLessThanOrEqual(widths.viewport);
}
async function noPrivateFacts(
  context: APIRequestContext,
  market: { id: string; slug: string },
  secrets: string[],
) {
  const response = await publicMarket(context, market.id);
  const html = await (await context.get(`/markets/${market.slug}`)).text();
  for (const secret of secrets) {
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(html).not.toContain(secret);
  }
  return response;
}
async function approve(
  secondAdmin: APIRequestContext,
  marketId: string,
  requestId: string,
  reason: string,
) {
  return dataOf<AdminMarket>(
    await sendJudgementDecision(secondAdmin, marketId, requestId, 'approve', {
      reason,
      eventDeadlineConfirmed: true,
    }),
  );
}

/** All temporary pending requests are removed even when a public assertion fails. */
test.describe('공개 판정 기록 (#24)', () => {
  test('방문자와 회원이 승인된 v1·정정 v2와 이의 처리 사유를 보고 내부 요청·계정·이의 본문은 보지 못한다', async ({
    admin,
    secondAdmin,
    browser,
    baseURL,
    page,
    request,
  }) => {
    test.slow();
    await skipUnlessResolvable(admin);
    const [first, second] = await Promise.all([meOf(admin), meOf(secondAdmin)]);
    const traders = await helperTraders(admin);
    const holders = await Promise.all(traders.map((trader) => meOf(trader)));
    const market = await createOpenMarket(admin, {
      group: '공개 판정 기록 버전',
      ruleItems: {
        fallbackSources: [{ name: '대체 발표 기관', url: 'https://example.org/public-source' }],
        fallbackCondition: '1차 출처에 발표가 없으면 대체 발표 기관을 확인합니다.',
      },
      times: { judgementTimeZone: 'America/New_York' },
    });
    const member = await browser.newContext({
      baseURL,
      storageState: await traders[0].storageState(),
      viewport: page.viewportSize() ?? undefined,
      timezoneId: 'Asia/Seoul',
      locale: 'ko-KR',
    });
    const privatePrefix = `private-${market.tag}`;
    const secrets = [
      `${privatePrefix}-rejected`,
      `${privatePrefix}-reject-reason`,
      `${privatePrefix}-retracted`,
      `${privatePrefix}-approval-v1`,
      `${privatePrefix}-approval-v2`,
      `${privatePrefix}-dispute-body-0`,
      `${privatePrefix}-dispute-body-1`,
      `${privatePrefix}-dispute-evidence-0`,
      `${privatePrefix}-dispute-evidence-1`,
      ...[first, second, ...holders].flatMap((account) => [account.id, account.email]),
      ...[first, second, ...holders].flatMap((account) =>
        account.profile.nickname ? [account.profile.nickname] : [],
      ),
    ];
    const disputeIds: string[] = [];
    try {
      await closeMarket(admin, market.id);
      await visit(page, market);
      const memberPage = await member.newPage();
      await visit(memberPage, market);
      const record = recordOf(page);
      await expect(record).toContainText(copy.judgingNoVersion);
      // Both unsuccessful registrations remain internal, including their evidence and reasons.
      const rejected = await registerJudgement(admin, market.id, {
        description: secrets[0],
        links: [`https://example.com/${secrets[0]}`],
      });
      await dataOf(
        await sendJudgementDecision(
          secondAdmin,
          market.id,
          rejected.judgement.pending!.requestId,
          'reject',
          { reason: secrets[1] },
        ),
      );
      const retracted = await registerJudgement(admin, market.id, {
        description: secrets[2],
        links: [`https://example.com/${secrets[2]}`],
      });
      await dataOf(
        await sendJudgementDecision(
          admin,
          market.id,
          retracted.judgement.pending!.requestId,
          'retract',
        ),
      );
      const evidence1 = `https://example.com/public/${market.tag}/${'long-evidence-'.repeat(12)}v1`;
      const description1 = `공개된 대체 출처 발표에서 사건이 발생했음을 확인했습니다. ${market.tag}`;
      const fallbackReason =
        '1차 출처의 발표 페이지가 열리지 않아 지정된 대체 출처를 확인했습니다.';
      const pending = await registerJudgement(admin, market.id, {
        source: { priority: 1 },
        fallbackReason,
        links: [evidence1],
        description: description1,
      });
      expect((await publicMarket(request, market.id)).judgingRecord.versions).toEqual([]);
      await expect(record).not.toContainText(description1);
      await approve(secondAdmin, market.id, pending.judgement.pending!.requestId, secrets[3]!);
      // These eligible holders' real disputes pin v1 before its one-minute window passes.
      for (const [index, trader] of traders.entries()) {
        const dispute = await dataOf<MyDispute>(
          await trader.post(`/api/v1/markets/${market.id}/disputes`, {
            data: {
              expectedAccountId: holders[index]!.id,
              judgementVersion: 1,
              links: [`https://example.com/${privatePrefix}-dispute-evidence-${String(index)}`],
              reason: `${privatePrefix}-dispute-body-${String(index)}`,
            },
          }),
        );
        disputeIds.push(dispute.id);
      }
      const id = detailCopyTestId(page, 'market-judging-record');
      await expect(page.getByTestId(`${id}-version-1`)).toContainText(description1);
      await expect(record.getByRole('link', { name: evidence1, exact: true })).toHaveAttribute(
        'href',
        evidence1,
      );
      await expect(record).toContainText(fallbackReason);
      await expect(page.getByTestId(`${id}-version-1-collected-at-judgement-zone`)).toBeVisible();
      await expect(page.getByTestId(`${id}-version-1-collected-at-viewer-zone`)).toBeVisible();
      const acceptedReason = `공식 정정 발표를 확인하여 이의를 수용합니다. ${market.tag}`;
      const dismissedReason = `해당 내용은 원 발표와 일치하여 이의를 기각합니다. ${market.tag}`;
      for (const [index, decision] of (['accept', 'dismiss'] as const).entries()) {
        await dataOf(
          await secondAdmin.post(
            `${adminPath(market.id)}/disputes/${disputeIds[index]}/${decision}`,
            {
              data: {
                expectedAccountId: second.id,
                reason: index === 0 ? acceptedReason : dismissedReason,
                noConflictConfirmed: true,
              },
            },
          ),
        );
      }
      await expect(record).toContainText(acceptedReason);
      await expect(record).toContainText(dismissedReason);
      const correctionReason = `공식 발표가 사건 자체를 철회하여 무효로 정정합니다. ${market.tag}`;
      const voidReason = '공식 기관이 해당 사건을 취소하여 규칙의 무효 조건에 해당합니다.';
      const correctedDescription = `사건 취소 공지의 본문과 날짜를 다시 확인했습니다. ${market.tag}`;
      const correction = await registerCorrection(admin, market.id, {
        result: 'VOID',
        source: null,
        voidReason,
        reason: correctionReason,
        description: correctedDescription,
        links: [`https://example.com/public/${market.tag}/v2`],
      });
      // A pending correction is not a public v2, even though its accepted dispute is public.
      expect(
        (await publicMarket(request, market.id)).judgingRecord.versions.map((v) => v.version),
      ).toEqual([1]);
      await expect(record).not.toContainText(correctionReason);
      await expect(page.getByTestId(`${id}-version-1`)).toContainText(copy.judgingCurrentVersion);
      // visit() already waited for the market room subscription. Keep this v1 document open:
      // only its public GETs fail, so a changed result must come from the real status event.
      const isMarketRead = (url: URL) => url.pathname === `/api/v1/markets/${market.id}`;
      let failedReads = 0;
      await page.route(isMarketRead, (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        failedReads += 1;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal error' } }),
        });
      });
      try {
        await approve(secondAdmin, market.id, correction.judgement.pending!.requestId, secrets[4]!);
        await expect(page.getByTestId('market-detail-result')).toHaveText(copy.marketResultVoid);
        await expect(page.getByTestId(`${id}-stale`)).toHaveText(copy.judgingRecordStale);
        await expect(page.getByTestId(`${id}-version-1`)).toHaveCount(0);
        await expect(record).not.toContainText(copy.judgingCurrentVersion);
        await expect(record).not.toContainText(description1);
        await expect(record).toContainText(copy.judgingPrinciple);
        // Refused through the client's automatic retries: still no old "current judgement".
        const notice = page.getByTestId('market-detail-refresh-failed');
        await expect(notice).toContainText(copy.marketRefreshFailed);
        expect(failedReads).toBeGreaterThan(0);
        const retry = notice.getByRole('button', { name: copy.retry, exact: true });
        await expect(retry).toHaveAttribute('data-testid', 'market-detail-refresh-retry');
        await expect(retry).toBeEnabled();
        await expect(page.getByTestId(`${id}-stale`)).toBeVisible();
        await expect(page.getByTestId(`${id}-version-1`)).toHaveCount(0);
        expect(await documentSurvived(page)).toBe(true);

        await page.unroute(isMarketRead);
        const [recoveredResponse] = await Promise.all([
          page.waitForResponse(
            (response) =>
              response.request().method() === 'GET' &&
              isMarketRead(new URL(response.url())) &&
              response.ok(),
          ),
          retry.click(),
        ]);
        const recoveredBody = (await recoveredResponse.json()) as { data: Market };
        expect(recoveredBody.data.judgingRecord.versions[0]?.version).toBe(2);
        await expect(page.getByTestId(`${id}-stale`)).toHaveCount(0);
        await expect(notice).toHaveCount(0);
        await expect(page.getByTestId(`${id}-version-2`)).toContainText(copy.judgingCurrentVersion);
        expect(await documentSurvived(page)).toBe(true);
      } finally {
        await page.unroute(isMarketRead);
      }
      await expect(page.getByTestId(`${id}-version-2`)).toContainText(copy.marketResultVoid);
      await expect(record).toContainText(correctionReason);
      await expect(record).toContainText(voidReason);
      await expect(record).toContainText(correctedDescription);
      const previous = page.getByTestId(`${id}-previous-1`);
      await previous.locator('summary').click();
      await expect(page.getByTestId(`${id}-version-1`)).toContainText(description1);
      await expect(recordOf(memberPage)).toContainText(correctedDescription);
      await expect(record).toContainText(copy.judgingOperator);
      for (const secret of [...secrets, ...disputeIds]) {
        await expect(record).not.toContainText(secret);
        await expect(recordOf(memberPage)).not.toContainText(secret);
      }
      expect(await documentSurvived(page)).toBe(true);
      expect(await documentSurvived(memberPage)).toBe(true);
      await noOverflow(page);
      const publicValue = await noPrivateFacts(request, market, [...secrets, ...disputeIds]);
      expect(publicValue.judgingRecord.versions.map((v) => [v.version, v.result])).toEqual([
        [2, 'VOID'],
        [1, 'YES'],
      ]);
      expect(publicValue.judgingRecord.disputes).toMatchObject({
        total: 2,
        byVersion: [
          { judgementVersion: 1, total: 2, counts: { accepted: 1, dismissed: 1, pending: 0 } },
        ],
      });
      expect((await publicMarket(memberPage.request, market.id)).judgingRecord).toEqual(
        publicValue.judgingRecord,
      );
      await waitForSettled(admin, market.id);
      await expect(record).toContainText(copy.judgingResolvedAt);
      await expect(record).toContainText(copy.judgingSettledAt);
      await expect(record).not.toContainText(copy.judgingPayoutDelayed);
      await expect(page.getByTestId(`${id}-version-2`)).toContainText(correctedDescription);
      expect(await documentSurvived(page)).toBe(true);
    } finally {
      await leaveNoJudgement(admin, market.id);
      // A failure before acceptance should not leave this fixture pinning a market forever.
      for (const id of disputeIds) {
        await secondAdmin
          .post(`${adminPath(market.id)}/disputes/${id}/dismiss`, {
            data: {
              expectedAccountId: second.id,
              reason: '공개 기록 시험 정리',
              noConflictConfirmed: true,
            },
          })
          .catch(() => undefined);
      }
      await member.close();
    }
  });

  test('중단·재개·조기 마감의 공개 설명과 최신·이전 지연 기록을 화면 갱신 없이 읽고 내부 승인 사유는 숨긴다', async ({
    admin,
    secondAdmin,
    page,
    request,
  }) => {
    test.slow();
    await helperTraders(admin);
    const due = new Date(Date.now() + 90_000).toISOString();
    const market = await createOpenMarket(admin, {
      group: '공개 중단 지연 기록',
      closeAt: due,
      ruleItems: { eventDeadline: due },
      times: { scheduledJudgementAt: due, judgementTimeZone: 'America/New_York' },
    });
    const second = await meOf(secondAdmin);
    const secret = `internal-pause-decision-${market.tag}`;
    const pauseNote = `발표가 예정보다 먼저 공개되어 거래를 중단합니다. ${'공개 설명을 확인합니다. '.repeat(12)}${market.tag}`;
    try {
      await visit(page, market);
      const record = recordOf(page);
      await pauseMarket(admin, market.id, 'early_result', { note: pauseNote });
      await expect(record).toContainText(pauseNote);
      await expect(record).toContainText(copy.judgingResultPublishedAt);
      const resume = await requestPauseDecision(admin, market.id, 'resume', { reason: secret });
      await dataOf(
        await sendPauseDecision(
          secondAdmin,
          market.id,
          resume.pause.pending!.requestId,
          'approve',
          { reason: secret },
        ),
      );
      await expect(record).toContainText(copy.judgingResumedAt);
      await tradeOnce(admin, market.id);
      await pauseMarket(admin, market.id, 'basis_change', {
        note: `기준의 공개 설명을 검토합니다. ${market.tag}`,
      });
      const early = await requestPauseDecision(admin, market.id, 'early_close', {
        reviewResult: 'judgeable',
        reason: secret,
      });
      await dataOf(
        await sendPauseDecision(secondAdmin, market.id, early.pause.pending!.requestId, 'approve', {
          reason: secret,
        }),
      );
      await expect(record).toContainText(copy.judgingEarlyClosedAt);
      await expect
        .poll(async () => (await publicMarket(request, market.id)).judgementDelayed, {
          timeout: 120_000,
          intervals: [1_000],
        })
        .toBe(true);
      const firstReason = `발표 자료의 세부 항목 확인을 기다립니다. ${market.tag}`;
      const secondReason = `자료 보완 일정을 확인하여 다음 검토 시각을 변경합니다. ${market.tag}`;
      await recordJudgementDelay(admin, market.id, { reason: firstReason });
      await expect(record).toContainText(firstReason);
      await recordJudgementDelay(admin, market.id, { reason: secondReason });
      await expect(record).toContainText(secondReason);
      await expect(record).toContainText(firstReason);
      await expect(record).toContainText(copy.judgingCurrentDelay);
      await expect(record).toContainText(copy.judgingPreviousDelay);
      expect(await documentSurvived(page)).toBe(true);
      const publicValue = await noPrivateFacts(request, market, [secret, second.id]);
      expect(publicValue.judgingRecord.pauses.map((pause) => pause.endKind)).toEqual([
        'early_closed',
        'resumed',
      ]);
      expect(
        publicValue.judgingRecord.delays.map((delay) => [delay.reason, delay.current]),
      ).toEqual([
        [secondReason, true],
        [firstReason, false],
      ]);
      expect(publicValue.judgingRecord.versions).toEqual([]);
      await expect(record).toContainText(copy.judgingNoVersion);
      await noOverflow(page);
    } finally {
      await leaveNoPauseDecision(admin, market.id);
    }
  });

  test('운영자 취소와 무체결 자동 취소는 사유·취소 시각만 공개하고 판정이나 지급 완료를 만들어 내지 않는다', async ({
    admin,
    secondAdmin,
    page,
    request,
  }) => {
    const [first, second] = await Promise.all([meOf(admin), meOf(secondAdmin)]);
    const market = await createDraftMarket(admin, {
      group: '공개 취소 기록',
      closeAt: minuteIso(Date.now() + 3 * 3_600_000),
      times: { scheduledOpenAt: minuteIso(Date.now() + 3_600_000) },
    });
    const submitted = await submitForReview(admin, market.id);
    await approveAsReviewer(admin, market.id, submitted.review.pending!.requestId);
    await visit(page, market);
    const reason = `예정된 공식 발표가 취소되어 시장을 개장하지 않습니다. ${market.tag}`;
    const secret = `internal-cancel-approval-${market.tag}`;
    const pending = await dataOf<AdminMarket>(
      await admin.post(`${adminPath(market.id)}/cancel-requests`, {
        data: { expectedAccountId: first.id, reason },
      }),
    );
    const requestId = pending.cancel.pending!.requestId;
    try {
      await dataOf(
        await secondAdmin.post(`${adminPath(market.id)}/cancel-requests/${requestId}/approve`, {
          data: { expectedAccountId: second.id, reason: secret },
        }),
      );
      await expect(recordOf(page)).toContainText(reason);
      await expect(recordOf(page)).toContainText(copy.judgingCancelledAt);
      await expect(recordOf(page)).not.toContainText(copy.judgingSettledAt);
      const cancelled = await noPrivateFacts(request, market, [
        secret,
        first.id,
        second.id,
        requestId,
      ]);
      expect(cancelled).toMatchObject({
        status: 'cancelled',
        resolvedResult: null,
        resolvedAt: null,
        settledAt: null,
      });
      expect(cancelled.judgingRecord.versions).toEqual([]);
      expect(cancelled.judgingRecord.cancellation?.reason).toBe(reason);
      expect(await documentSurvived(page)).toBe(true);
      await noOverflow(page);
    } finally {
      await admin
        .post(`${adminPath(market.id)}/cancel-requests/${requestId}/retract`, {
          data: { expectedAccountId: first.id },
        })
        .catch(() => undefined);
    }
    // The approved early close uses the same automatic no-fill path as the scheduled worker.
    const quiet = await createOpenMarket(admin, { group: '공개 무체결 취소 기록' });
    await pauseMarket(admin, quiet.id, 'basis_change');
    const early = await requestPauseDecision(admin, quiet.id, 'early_close', {
      reviewResult: 'judgeable',
      reason: secret,
    });
    try {
      await dataOf(
        await sendPauseDecision(secondAdmin, quiet.id, early.pause.pending!.requestId, 'approve', {
          reason: secret,
        }),
      );
      const auto = await noPrivateFacts(request, quiet, [secret]);
      expect(auto).toMatchObject({
        status: 'cancelled',
        resolvedResult: null,
        resolvedAt: null,
        settledAt: null,
      });
      expect(auto.judgingRecord.cancellation?.reason).toBe(NO_FILL_CANCEL_REASON);
      expect(auto.judgingRecord.versions).toEqual([]);
      await page.goto(`/markets/${quiet.slug}`);
      await expect(recordOf(page)).toContainText(NO_FILL_CANCEL_REASON);
      await expect(recordOf(page)).toContainText(copy.judgingCancelledAt);
      await expect(recordOf(page)).not.toContainText(copy.judgingSettledAt);
    } finally {
      await leaveNoPauseDecision(admin, quiet.id);
    }
  });
});
