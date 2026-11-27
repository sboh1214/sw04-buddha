import type { APIRequestContext } from '@playwright/test';
import type { AdminMarket, Market, MyDispute, MyMarketDispute, Notification } from '@buddha/shared';
import { copy } from '../src/copy';
import { formatKst } from '../src/lib/datetime';
import { expectNoExcludedText, openSettlementRecords } from './acceptance';
import {
  DEFAULT_JUDGEMENT_TIME_ZONE,
  ONE_READ_MS,
  REALTIME_BUDGET_MS,
  type OrderTerms,
  type TestMarket,
  approveJudgementAsReviewer,
  approvePauseDecisionAsReviewer,
  closeMarket,
  createOpenMarket,
  dataOf,
  decideDispute,
  detailCopyTestId,
  documentSurvived,
  expect,
  expectDecided,
  freshEmail,
  helperTraders,
  inboxOf,
  judgeMarket,
  leaveNoCorrection,
  leaveNoJudgement,
  markDocument,
  myUnread,
  noticeTypesOf,
  noticesOf,
  notificationRow,
  onlyNoticeOf,
  openCounted,
  pauseMarket,
  placeOrder,
  recordJudgementDelay,
  registerCorrection,
  requestPauseDecision,
  sendJudgementDecision,
  signUp,
  skipUnlessResolvable,
  submitDispute,
  test,
  unreadCountOf,
  waitForSettled,
  waitPast,
  watchThroughApi,
} from './helpers';

/**
 * 판정·정산 알림 (#188, ADR-0160; owner answers 52-1, 52-11…52-15, 188-1…188-6) on the screens,
 * every event through the API as production makes it: MY › 알림's rows of
 * `market_provisional_result`, `market_judgement_corrected`, `market_dispute_closed_by_correction`,
 * `market_dispute_decided` and `market_judgement_delayed`, in the sentences the owner approved
 * (188-1), each under 시장 and leading to the market's detail (188-4). settlement.spec.ts walks
 * `market_settled` with its payouts (52-12, 52-15).
 *
 * 1: a 잠정 결과 reaches the watcher and the holders of either side (52-1 — one of them to be paid
 * 0) with its result and 이의 기한, the watcher's count rising without a reload; its row opens the
 * detail's top — the result, the deadline, the dispute link — over the 공개 판정 기록's source (AC
 * 2). An approved 판정 정정 tells the same audience its result and new deadline, and the submitter
 * of the pending dispute it closed that too (52-14 — two notices of one event); the approval sent
 * again adds nothing (AC 10). 2: 기각 and 수용 go to the dispute's submitter alone with the public
 * reason (52-14, 188-3); the accepted dispute a retracted correction sends back to 검토 중 tells
 * nobody (188-6) and its second decision is a notice of its own; while a dispute holds the market
 * past its deadline no 최종 정산 comes, and after the last 기각 each holder hears of the payout once
 * (52-12, 52-13, AC 6). 3: the scheduled judgement passing tells nobody (AC 5, N03 §4); each 판정
 * 지연 기록 that is the first or changes the reason or the time does (52-11, 188-5) — a New York
 * market's time read in Seoul with New York's on a line under it (52-15, #22) — and an identical
 * re-record does not.
 *
 * The 마켓메이커 of a `createOpenMarket` market posts no quotes under the regression profile (stage
 * thresholds 0/0/0), so a member's immediate buy meets only another member's resting bid; in 1
 * and 2 the spec's own members are the fills, which a 판정 이의 needs (#173 item 6). The dispute
 * window is the 1분 the suite's global setup enters (global-setup.ts): disputes go in right after
 * the approval, and the tests that need it skip on a database with a longer one
 * (`skipUnlessResolvable`). Rows of one event share its instant, so their order falls to their ids:
 * notices are found by type, never by place — and a member who holds a contract also hears of the
 * close (#54) and of the payout once the worker reaches it.
 */

const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A 지정가(GTC) NO buy of one at 40: the resting bid an immediate YES buy meets as a pair mint. */
const NO_BID: OrderTerms = {
  outcome: 'NO',
  side: 'buy',
  timeInForce: 'gtc',
  limitPriceCoin: 40,
  qty: 1,
};

/** An 즉시 거래(IOC) YES buy of one: it meets the NO bid at the bid's price (YES 60). */
const YES_TAKE: OrderTerms = {
  outcome: 'YES',
  side: 'buy',
  timeInForce: 'ioc',
  limitPriceCoin: 99,
  qty: 1,
};

/** The reason a re-sent approval gives (1..500 characters): it is refused before it is read. */
const RESENT_APPROVAL_REASON = '같은 정정을 다시 승인합니다. 이미 결정된 요청입니다.';

/** The reason a `finally` dismisses a dispute a failed run left pending with. */
const CLEANUP_DISMISS_REASON = '실패한 판정·정산 알림 E2E의 이의 보류 정리';

/**
 * How far ahead of its making spec 3's market closes and is judged: room for opening it through
 * the review and closing it early (`closeMarket`), delay.spec.ts' DUE_IN_MS.
 */
const DUE_IN_MS = 25_000;

/** How long spec 3 waits for the public market to read '판정 지연' (#22: on the read). */
const DELAYED_WAIT_MS = 60_000;

/** How long past an instant nothing is published at a spec looks again for what did not come. */
const PASSED_SLACK_MS = 10_000;

/** A zone other than Seoul, where both projects run (playwright.config.ts). */
const NEW_YORK_ZONE = 'America/New_York';

/** The judgement zone's line of an instant judged in New York, read in Seoul (DST either way). */
const NEW_YORK_LINE = new RegExp(
  `^${copy.rulesJudgementZoneLine} \\d{4}\\. \\d{1,2}\\. \\d{1,2}\\. (오전|오후) \\d{1,2}:\\d{2} ` +
    '\\((GMT-4|GMT-5)\\)$',
);

/** The types of #188's notices: what a late worker run may add (`market_settled`) aside. */
const JUDGEMENT_TYPES = [
  'market_judgement_delayed',
  'market_provisional_result',
  'market_judgement_corrected',
  'market_dispute_decided',
  'market_dispute_closed_by_correction',
] as const;

/** The member's notices of #188's judgement types, newest first — never the payout's. */
async function judgementNoticesOf(context: APIRequestContext): Promise<Notification[]> {
  return (await inboxOf(context)).filter((notice) =>
    (JUDGEMENT_TYPES as readonly string[]).includes(notice.type),
  );
}

/**
 * What each notice is and says, its read state aside: a row a spec pressed turns read meanwhile,
 * the read sent without waiting (53-2).
 */
async function sayingsOf(context: APIRequestContext) {
  return (await judgementNoticesOf(context)).map(({ id, type, params }) => ({ id, type, params }));
}

/** The ids of the member's notices of `type`, newest first. */
async function idsOf(context: APIRequestContext, type: string): Promise<string[]> {
  return noticesOf(await inboxOf(context), type).map((notice) => notice.id);
}

/** What every #188 notice of `market` is besides its type and params (188-4, 53-4). */
function marketNotice(market: Pick<TestMarket, 'slug'>) {
  return { category: 'market', target: { kind: 'market', slug: market.slug }, eventCount: 1 };
}

/**
 * Trades the spec's two members on `market` — A's NO bid rests, B's immediate YES buy meets it:
 * A holds a NO, B a YES, each with a fill (a dispute's eligibility, #173 item 6) — and closes it
 * early: a pause and the reviewer's approved 조기 마감 (#114), which #54 tells them of.
 */
async function tradeAndClose(
  admin: APIRequestContext,
  market: TestMarket,
  a: APIRequestContext,
  b: APIRequestContext,
): Promise<void> {
  expect((await placeOrder(a, market.id, crypto.randomUUID(), NO_BID)).order.status).toBe('open');
  expect((await placeOrder(b, market.id, crypto.randomUUID(), YES_TAKE)).order.status).toBe(
    'filled',
  );
  await pauseMarket(admin, market.id);
  await requestPauseDecision(admin, market.id, 'early_close', { reviewResult: 'judgeable' });
  expect((await approvePauseDecisionAsReviewer(admin, market.id)).status).toBe('closed');
}

/**
 * Sends an accepted 판정 이의 of a PROVISIONAL market back to 검토 중 when no 판정 정정 waits: an
 * accepted dispute holds the confirmation until a correction ends it and cannot be dismissed, so a
 * correction is registered for it and retracted at once (its 철회 reopens it, #176). Throws when
 * the registration is refused; for `releaseHolds`, which catches it.
 */
async function reopenAccepted(admin: APIRequestContext, marketId: string): Promise<void> {
  const market = await dataOf<AdminMarket>(await admin.get(`/api/v1/admin/markets/${marketId}`));
  if (market.status !== 'provisional' || market.judgement.pending !== null) return;
  if (!market.disputes.items.some((dispute) => dispute.status === 'accepted')) return;
  await registerCorrection(admin, marketId);
  await leaveNoCorrection(admin, marketId);
}

/**
 * Leaves no market of a persistent database held by what a failed run left: a waiting 판정 정정
 * retracted, an accepted dispute sent back to 검토 중 (`reopenAccepted`), then the run's disputes
 * dismissed — each refused, and so left alone, once decided or closed. Best effort, for a
 * `finally`; the market may be confirmed or paid out by then.
 */
async function releaseHolds(
  admin: APIRequestContext,
  marketId: string,
  disputeIds: readonly string[],
): Promise<void> {
  await leaveNoCorrection(admin, marketId);
  await reopenAccepted(admin, marketId).catch(() => undefined);
  for (const disputeId of disputeIds) {
    await decideDispute(admin, marketId, disputeId, 'dismiss', CLEANUP_DISMISS_REASON).catch(
      () => undefined,
    );
  }
  await leaveNoJudgement(admin, marketId);
}

test.describe('판정·정산 알림 (#188)', () => {
  test('잠정 결과는 관심 등록자와 두 쪽 보유자에게 결과와 이의 기한으로 오고 관심 등록자의 수는 리프레시 없이 늘며, 누르면 결과·이의 기한·이의 제출 링크와 판정 기록의 출처가 있는 시장 상세가 열리고, 판정 정정은 같은 대상에게 정정된 결과와 새 이의 기한으로, 정정으로 종결된 이의를 낸 회원에게는 종결 알림도 오며, 다시 보낸 승인은 아무것도 더하지 않는다 @ac189-6', async ({
    admin,
    reviewer,
    browser,
    page,
  }) => {
    // Three members, a market through the review, a judgement and its correction.
    test.slow();
    await skipUnlessResolvable(admin);
    const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    let marketId: string | undefined;
    const disputeIds: string[] = [];
    try {
      const [aPage, bPage] = await Promise.all([contexts[0].newPage(), contexts[1].newPage()]);
      for (const each of [aPage, bPage, page]) await signUp(each, freshEmail());
      const [a, b, w] = [aPage.request, bPage.request, page.request];
      const market = await createOpenMarket(admin);
      marketId = market.id;

      // --- A holds a NO (to be paid 0 on YES), B a YES, W watches; the market closes early.
      await watchThroughApi(page, market.id);
      await tradeAndClose(admin, market, a, b);
      for (const member of [a, b, w]) expect(await judgementNoticesOf(member)).toEqual([]);

      // --- W keeps MY open, its count read and its socket in W's room.
      const before = await unreadCountOf(w);
      await openCounted(page, '/my');
      await expect(myUnread(page)).toHaveText(String(before));
      await page.waitForTimeout(REALTIME_BUDGET_MS);
      await markDocument(page);

      // --- 판정 YES, approved by the reviewer: v1 and its 이의 기한, a minute on. A disputes v1 at
      // once — its pending dispute holds v1 until the correction closes it.
      const judged = await judgeMarket(admin, market.id, 'YES');
      const deadline = judged.disputeDeadline;
      if (deadline === null) throw new Error(`market ${market.id} has no dispute deadline`);
      disputeIds.push((await submitDispute(a, market.id, 1)).id);

      // --- W's count rises without a reload; A, B and W each hold one 잠정 결과 with the result,
      // the deadline and the market's zone — exactly, nothing about anyone (52-15, AC 11).
      await expect(myUnread(page)).toHaveText(String(before + 1), {
        timeout: REALTIME_BUDGET_MS + ONE_READ_MS,
      });
      expect(await documentSurvived(page)).toBe(true);
      const provisionalParams = {
        marketTitle: market.title,
        result: 'YES',
        disputeDeadline: deadline,
        judgementTimeZone: DEFAULT_JUDGEMENT_TIME_ZONE,
      };
      for (const member of [a, b, w]) {
        const notices = await judgementNoticesOf(member);
        expect(notices.map((notice) => notice.type)).toEqual(['market_provisional_result']);
        expect(notices[0]).toMatchObject(marketNotice(market));
        expect(notices[0]?.params).toEqual(provisionalParams);
      }

      // --- W's row: under 시장, the owner's sentence (188-1) — one line, Seoul's market for a
      // Seoul member.
      const provisional = onlyNoticeOf(await inboxOf(w), 'market_provisional_result');
      await openCounted(page, '/my/notifications');
      const provisionalRow = notificationRow(page, provisional.id);
      await expect(provisionalRow.getByTestId('notification-row-category')).toHaveText(
        copy.notificationCategoryMarket,
      );
      await expect(provisionalRow.getByTestId('notification-row-title')).toHaveText(
        `${market.title} 잠정 결과: YES · 이의 기한 ${formatKst(deadline)}`,
      );
      await expect(provisionalRow.getByTestId('notification-row-judgement-zone')).toHaveCount(0);
      await expect(provisionalRow).toHaveAttribute('href', `/markets/${market.slug}`);

      // --- Pressed: the market's detail, at its top the result, the 이의 기한 and the dispute
      // link; the 공개 판정 기록 below names the source (AC 2).
      await provisionalRow.click();
      await expect(page).toHaveURL(`/markets/${market.slug}`);
      const notice = page.getByTestId('market-status-notice');
      await expect(notice.getByTestId('market-detail-result')).toHaveText(copy.yes);
      await expect(notice.getByTestId('market-detail-dispute-deadline-viewer-zone')).toHaveText(
        formatKst(deadline),
      );
      await expect(notice.getByTestId('market-dispute-link')).toBeVisible();
      const record = detailCopyTestId(page, 'market-judging-record');
      await expect(page.getByTestId(`${record}-version-1-source`)).toContainText(
        copy.judgingPrimarySource,
      );

      // --- 판정 정정 to NO, approved by the reviewer: v2 and a new deadline. A's pending dispute
      // of v1 is closed by it (정정으로 종결).
      const registered = await registerCorrection(admin, market.id);
      const correctionId = registered.judgement.pending?.requestId;
      if (correctionId === undefined) throw new Error('no correction waits after its request');
      const corrected = await approveJudgementAsReviewer(admin, market.id, correctionId);
      expect(corrected.judgementVersion).toBe(2);
      const newDeadline = corrected.disputeDeadline;
      if (newDeadline === null) throw new Error(`market ${market.id} has no new dispute deadline`);
      const correctedParams = {
        marketTitle: market.title,
        result: 'NO',
        disputeDeadline: newDeadline,
        judgementTimeZone: DEFAULT_JUDGEMENT_TIME_ZONE,
      };
      // A — a holder and the closed dispute's submitter: the correction AND the closure, one
      // event's two types (53-4, 52-14); the closure carries the new deadline alone (188-1).
      const aNotices = await judgementNoticesOf(a);
      expect(aNotices.map((each) => each.type).sort()).toEqual([
        'market_dispute_closed_by_correction',
        'market_judgement_corrected',
        'market_provisional_result',
      ]);
      expect(onlyNoticeOf(aNotices, 'market_judgement_corrected').params).toEqual(correctedParams);
      const closure = onlyNoticeOf(aNotices, 'market_dispute_closed_by_correction');
      expect(closure).toMatchObject(marketNotice(market));
      expect(closure.params).toEqual({
        marketTitle: market.title,
        disputeDeadline: newDeadline,
        judgementTimeZone: DEFAULT_JUDGEMENT_TIME_ZONE,
      });
      // B and W: the correction alone.
      for (const member of [b, w]) {
        const notices = await judgementNoticesOf(member);
        expect(notices.map((each) => each.type).sort()).toEqual([
          'market_judgement_corrected',
          'market_provisional_result',
        ]);
        expect(onlyNoticeOf(notices, 'market_judgement_corrected').params).toEqual(correctedParams);
      }

      // --- The approval sent again: refused as decided, and every inbox as it was (AC 10).
      const held = await Promise.all([a, b, w].map((member) => sayingsOf(member)));
      const wCorrected = onlyNoticeOf(await inboxOf(w), 'market_judgement_corrected');
      await expectDecided(
        await sendJudgementDecision(reviewer, market.id, correctionId, 'approve', {
          reason: RESENT_APPROVAL_REASON,
          eventDeadlineConfirmed: true,
        }),
      );
      expect(await Promise.all([a, b, w].map((member) => sayingsOf(member)))).toEqual(held);

      // --- The rows: W's correction, A's closure — the new deadline in each (188-1).
      await openCounted(page, '/my/notifications');
      await expect(
        notificationRow(page, wCorrected.id).getByTestId('notification-row-title'),
      ).toHaveText(
        `${market.title} 판정 정정 · 잠정 결과: NO · 새 이의 기한 ${formatKst(newDeadline)}`,
      );
      await openCounted(aPage, '/my/notifications');
      await expect(
        notificationRow(aPage, closure.id).getByTestId('notification-row-title'),
      ).toHaveText(
        `${market.title} 판정 이의 정정으로 종결 · 새 이의 기한 ${formatKst(newDeadline)}`,
      );
    } finally {
      // v2 is confirmed and paid out at its own deadline: the helpers leave a settled market be.
      if (marketId !== undefined) await releaseHolds(admin, marketId, disputeIds);
      for (const each of contexts) await each.close();
    }
  });

  test('판정 이의를 화면에서 내면 상세가 이의 검토 중이고 지급이 보류되며, 기각과 수용은 그 이의를 낸 회원에게만 공개 처리 사유와 함께 오고, 정정의 철회로 검토 중으로 돌아간 이의는 알리지 않고 다시 처리하면 새 알림이 오며, 이의가 결과 확정을 막는 동안에는 최종 정산 알림이 없고 마지막 기각 뒤 지급이 끝나면 보유자마다 한 번 오고 MY 정산 기록도 하나다 @ac189-6 @ac189-11', async ({
    admin,
    browser,
    page,
  }) => {
    // Two members, a market through the review, a dispute window waited out, then the payout.
    test.slow();
    await skipUnlessResolvable(admin);
    const bContext = await browser.newContext();
    let marketId: string | undefined;
    const disputeIds: string[] = [];
    try {
      const bPage = await bContext.newPage();
      for (const each of [page, bPage]) await signUp(each, freshEmail());
      const [a, b] = [page.request, bPage.request];
      const market = await createOpenMarket(admin);
      marketId = market.id;
      await tradeAndClose(admin, market, a, b);

      // --- 판정 YES; A and B each dispute v1 at once (both have a fill on it) — A on the submission
      // screen (#189 기준 6, ADR-0178: the member's own way in), B through the API.
      const judged = await judgeMarket(admin, market.id, 'YES');
      const deadline = judged.disputeDeadline;
      if (deadline === null) throw new Error(`market ${market.id} has no dispute deadline`);
      await page.goto(`/markets/${market.slug}/dispute`);
      const form = page.getByTestId('dispute-form');
      await expect(form).toBeVisible();
      await form
        .getByTestId('dispute-link-0')
        .fill(`https://example.com/e2e/dispute/${market.id}/1`);
      await form
        .getByTestId('dispute-reason')
        .fill(`잠정 결과가 1차 출처의 발표와 다릅니다 ${market.tag}`);
      const submitted = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === `/api/v1/markets/${market.id}/disputes`,
      );
      await form.getByTestId('dispute-submit').click();
      const answer = await submitted;
      expect(answer.status(), await answer.text()).toBe(201);
      const aDispute = ((await answer.json()) as { data: MyDispute }).data;
      disputeIds.push(aDispute.id);
      await expect(page.getByTestId(`my-dispute-${aDispute.id}`)).toHaveAttribute(
        'data-status',
        'pending',
      );
      const bDispute = await submitDispute(b, market.id, 1);
      disputeIds.push(bDispute.id);

      // --- #189 기준 6 (N03 §9 '이의를 낼 수 있고 검토 중 지급 보류가 보인다'), inside the 이의 기한:
      // A's detail reads '이의 검토 중' where '잠정 결과' was (#173 12항, the one label) and says the
      // result waits for the review; MY 판정 이의 has A's 검토 중; MY's settlement records of the
      // market are none — nothing is paid while the dispute holds it.
      await page.goto(`/markets/${market.slug}`);
      await expect(page.getByTestId('market-status-badge')).toHaveText(
        copy.marketStatusDisputeUnderReview,
      );
      await expect(page.getByTestId('market-status-notice-detail')).toHaveText(
        copy.marketProvisionalUnderReview,
      );
      await expectNoExcludedText(page);
      await page.goto('/my/disputes');
      await expect(
        page
          .getByTestId('my-disputes-list')
          .getByTestId(`my-dispute-${aDispute.id}`)
          .getByTestId(`my-dispute-${aDispute.id}-status`),
      ).toHaveText(copy.disputeStatusPending);
      await expectNoExcludedText(page);
      const held = await openSettlementRecords(page, market.id);
      await expect(page.getByTestId('my-settlement-history-empty')).toBeVisible();
      await expect(held).toHaveCount(0);
      // A dispute is the member's own act: nothing told of it (ADR-0160 §6).
      for (const member of [a, b]) {
        expect((await judgementNoticesOf(member)).map((each) => each.type)).toEqual([
          'market_provisional_result',
        ]);
      }

      // --- The reviewer dismisses A's with its public reason: A alone hears, with the reason.
      const dismissal = `1차 출처의 발표가 잠정 결과와 같습니다 ${market.tag}`;
      await decideDispute(admin, market.id, aDispute.id, 'dismiss', dismissal);
      const aDecided = onlyNoticeOf(await inboxOf(a), 'market_dispute_decided');
      expect(aDecided).toMatchObject(marketNotice(market));
      expect(aDecided.params).toEqual({
        marketTitle: market.title,
        decision: 'dismissed',
        reason: dismissal,
      });
      expect(noticesOf(await inboxOf(b), 'market_dispute_decided')).toEqual([]);

      // --- …and accepts B's: B alone hears 수용 with its reason.
      const acceptance = `1차 출처가 발표를 정정했습니다 ${market.tag}`;
      await decideDispute(admin, market.id, bDispute.id, 'accept', acceptance);
      expect(onlyNoticeOf(await inboxOf(b), 'market_dispute_decided').params).toEqual({
        marketTitle: market.title,
        decision: 'accepted',
        reason: acceptance,
      });
      expect(await idsOf(a, 'market_dispute_decided')).toEqual([aDecided.id]);

      // --- A correction answering B's accepted dispute, then retracted: B's dispute is back to
      // 검토 중 and nobody is told (188-6) — no correction notice either, it was never approved.
      // Right after the 수용, so little can fail while it holds (no 기각 releases an accepted one).
      const registered = await registerCorrection(admin, market.id);
      expect(registered.judgement.pending?.correction?.disputeIds).toEqual([bDispute.id]);
      const quiet = await Promise.all([a, b].map((member) => sayingsOf(member)));
      await leaveNoCorrection(admin, market.id);
      const standing = await dataOf<MyMarketDispute>(
        await b.get(`/api/v1/me/disputes/markets/${market.id}`),
      );
      expect(standing.dispute?.status).toBe('pending');
      expect(await Promise.all([a, b].map((member) => sayingsOf(member)))).toEqual(quiet);

      // --- A's row in the owner's words (188-1, 188-3); pressed, the detail's 공개 판정 기록
      // holds the same reason (188-4).
      await openCounted(page, '/my/notifications');
      const aRow = notificationRow(page, aDecided.id);
      await expect(aRow.getByTestId('notification-row-category')).toHaveText(
        copy.notificationCategoryMarket,
      );
      await expect(aRow.getByTestId('notification-row-title')).toHaveText(
        `${market.title} 판정 이의 기각 · 사유: ${dismissal}`,
      );
      await aRow.click();
      await expect(page).toHaveURL(`/markets/${market.slug}`);
      await expect(page.getByTestId(detailCopyTestId(page, 'market-judging-record'))).toContainText(
        dismissal,
      );

      // --- Past the 이의 기한, B's pending dispute holds the 잠정 결과: no 최종 정산 (AC 6, 52-13).
      await waitPast(page, deadline, PASSED_SLACK_MS);
      const publicMarket = await dataOf<Market>(await a.get(`/api/v1/markets/${market.id}`));
      expect(publicMarket.status).toBe('provisional');
      for (const member of [a, b]) {
        expect(noticesOf(await inboxOf(member), 'market_settled')).toEqual([]);
      }

      // --- B's dispute dismissed again: a second notice of its own — a new decision, not a
      // duplicate of the first (its key is the decision's admin action).
      const second = `1차 출처의 정정 발표가 철회되었습니다 ${market.tag}`;
      await decideDispute(admin, market.id, bDispute.id, 'dismiss', second);
      expect(
        noticesOf(await inboxOf(b), 'market_dispute_decided').map((each) => each.params),
      ).toEqual([
        { marketTitle: market.title, decision: 'dismissed', reason: second },
        { marketTitle: market.title, decision: 'accepted', reason: acceptance },
      ]);
      expect(await idsOf(a, 'market_dispute_decided')).toEqual([aDecided.id]);

      // --- The last 기각 past the deadline lets the worker confirm and pay at once: each holder
      // hears of the payout once, with the confirmed result and the member's own payout (52-12).
      const settled = await waitForSettled(admin, market.id);
      expect(settled.resolvedResult).toBe('YES');
      for (const [member, payoutCoin] of [
        [a, '0'],
        [b, '100'],
      ] as const) {
        const payout = onlyNoticeOf(await inboxOf(member), 'market_settled');
        expect(payout).toMatchObject(marketNotice(market));
        expect(payout.params).toEqual({ marketTitle: market.title, result: 'YES', payoutCoin });
      }

      // --- #189 기준 6: on A's screens the hold has ended in the payout — 지급 완료 on the detail
      // and the market's settlement record once on MY (A's NO, paid 0).
      await page.goto(`/markets/${market.slug}`);
      await expect(page.getByTestId('market-status-badge')).toHaveText(copy.marketStatusSettled);
      const paid = await openSettlementRecords(page, market.id);
      await expect(page.getByTestId(`history-settlement-${market.id}-NO`)).toBeVisible();
      await expect(paid).toHaveCount(1);
    } finally {
      if (marketId !== undefined) await releaseHolds(admin, marketId, disputeIds);
      await bContext.close();
    }
  });

  test('예정 판정 시각이 지나는 것만으로는 아무것도 오지 않고, 판정 지연 기록은 관심 등록자에게 공개 사유와 다음 검토 시각으로 오며 판정 기준 시간대가 다르면 그 시각이 제목 아래 한 줄로 보이고, 같은 사유와 시각으로 다시 기록하면 알리지 않고 바뀐 기록만 알리며, 누르면 시장 상세의 지연 사유와 다음 검토 시각이 보인다 @ac189-6', async ({
    admin,
    page,
    request,
  }) => {
    // The scheduled judgement waited out with MY open.
    test.slow();
    await signUp(page, freshEmail());
    const w = page.request;
    // The helper's members (their sign-up, once per worker) before the clock: `closeMarket`
    // trades one pair first, and a close that passed before it would be 취소, not 마감 (#20).
    await helperTraders(admin);
    // Closes and is judged in seconds, in New York: W, in Seoul, reads its times in both zones.
    const dueAt = new Date(Date.now() + DUE_IN_MS).toISOString();
    const market = await createOpenMarket(admin, {
      closeAt: dueAt,
      ruleItems: { eventDeadline: dueAt },
      times: { scheduledJudgementAt: dueAt, judgementTimeZone: NEW_YORK_ZONE },
    });
    await watchThroughApi(page, market.id);
    expect((await closeMarket(admin, market.id)).status).toBe('closed');

    // --- W holds #54's notices of the close (its pause and 조기 마감, or the close on schedule)
    // and nothing of #188's.
    const atClose = await noticeTypesOf(w);
    expect(atClose).toContain('market_closed');
    for (const type of atClose) expect(['market_closed', 'market_paused']).toContain(type);
    const unreadAtClose = await unreadCountOf(w);

    // --- The scheduled judgement passes: '판정 지연' on the read (#173 item 11), and nothing is
    // told of a time passing (AC 5, N03 §4) — no notice ever says NO because a time passed.
    await waitPast(page, dueAt, PASSED_SLACK_MS);
    await expect
      .poll(
        async () =>
          (await dataOf<Market>(await request.get(`/api/v1/markets/${market.id}`)))
            .judgementDelayed,
        { timeout: DELAYED_WAIT_MS, intervals: [1_000] },
      )
      .toBe(true);
    expect(await noticeTypesOf(w)).toEqual(atClose);
    expect(await unreadCountOf(w)).toBe(unreadAtClose);

    // --- W keeps MY › 알림 open, its socket in W's room.
    await openCounted(page, '/my/notifications');
    await expect(myUnread(page)).toHaveText(String(unreadAtClose));
    await page.waitForTimeout(REALTIME_BUDGET_MS);
    await markDocument(page);

    // --- The first record: W's count rises without a reload; one notice with the public reason,
    // the next review time and the market's zone, exactly (52-11, 52-15).
    const reason = `1차 출처의 발표가 늦어지고 있습니다 확인 코드 ${market.tag}`;
    const nextReviewAt = new Date(Date.now() + DAY_MS).toISOString();
    await recordJudgementDelay(admin, market.id, { reason, nextReviewAt });
    await expect(myUnread(page)).toHaveText(String(unreadAtClose + 1), {
      timeout: REALTIME_BUDGET_MS + ONE_READ_MS,
    });
    expect(await documentSurvived(page)).toBe(true);
    const first = onlyNoticeOf(await inboxOf(w), 'market_judgement_delayed');
    expect(first).toMatchObject(marketNotice(market));
    expect(first.params).toEqual({
      marketTitle: market.title,
      reason,
      nextReviewAt,
      judgementTimeZone: NEW_YORK_ZONE,
    });

    // --- Its row: the time in W's zone (Seoul) in the sentence, New York's on the line under it
    // — inside the row's title, after the sentence (188-1, the detail's rule).
    const firstRow = notificationRow(page, first.id);
    const zoneLine = firstRow.getByTestId('notification-row-judgement-zone');
    await expect(zoneLine).toHaveText(NEW_YORK_LINE);
    await expect(firstRow.getByTestId('notification-row-title')).toHaveText(
      `${market.title} 판정 지연 · 다음 검토 ${formatKst(nextReviewAt)} · 사유: ${reason}` +
        ((await zoneLine.textContent()) ?? ''),
    );

    // --- The same reason and time recorded again: a record (200), and nothing told (52-11).
    await recordJudgementDelay(admin, market.id, { reason, nextReviewAt });
    expect(await idsOf(w, 'market_judgement_delayed')).toEqual([first.id]);
    expect(await unreadCountOf(w)).toBe(unreadAtClose + 1);

    // --- The time an hour later: a second notice, newest first.
    const laterReviewAt = new Date(Date.parse(nextReviewAt) + HOUR_MS).toISOString();
    await recordJudgementDelay(admin, market.id, { reason, nextReviewAt: laterReviewAt });
    const delays = noticesOf(await inboxOf(w), 'market_judgement_delayed');
    expect(delays.map((each) => each.params)).toEqual([
      { ...first.params, nextReviewAt: laterReviewAt },
      first.params,
    ]);
    expect(await unreadCountOf(w)).toBe(unreadAtClose + 2);
    const latest = delays[0];
    if (latest === undefined) throw new Error('unreachable: two notices were just read');

    // --- Pressed: the detail's top holds the reason and the later time (188-4).
    await openCounted(page, '/my/notifications');
    await notificationRow(page, latest.id).click();
    await expect(page).toHaveURL(`/markets/${market.slug}`);
    const notice = page.getByTestId('market-status-notice');
    await expect(notice.getByTestId('market-detail-delay-reason')).toHaveText(reason);
    await expect(notice.getByTestId('market-detail-next-review-viewer-zone')).toHaveText(
      formatKst(laterReviewAt),
    );
  });
});
