import type { AdminMarket } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  ONE_READ_MS,
  REALTIME_BUDGET_MS,
  type OrderTerms,
  approvePauseDecisionAsReviewer,
  approveSupplementAsReviewer,
  createOpenMarket,
  createScheduledMarket,
  dataOf,
  detailCopyTestId,
  documentSurvived,
  expect,
  expectDecided,
  freshEmail,
  inboxOf,
  leaveNoPauseDecision,
  leaveNoSupplement,
  markDocument,
  meOf,
  myUnread,
  notificationRow,
  notificationRowIds,
  notificationRows,
  noticeTypesOf,
  onlyNoticeOf,
  openCounted,
  pauseMarket,
  placeOrder,
  requestPauseDecision,
  requestSupplement,
  sendPauseDecision,
  signUp,
  test,
  unreadCountOf,
  watchThroughApi,
} from './helpers';

/**
 * 시장 상태 알림 (#54, ADR-0159; owner answers 52-1, 52-5, 52-8…52-10, 54-1…54-8) on the screens,
 * every event through the API as production makes it: MY › 알림's rows of `market_paused`,
 * `market_resumed`, `market_closed`, `market_rules_supplemented` and `market_cancelled`, in the
 * sentences the owner approved (54-1), each under 시장 and leading to the market's detail (54-4).
 *
 * 1: an admin's 일시 중단 and the approved 재개 reach a watcher without a reload, each with the
 * public reason label (52-9; the resume the ended pause's, 54-2), while a member who unwatched
 * before them hears nothing (AC 5), and the approval sent again adds nothing (AC 6). 2: the
 * audience is the watchers and the holders of a contract (52-1): a 사건 선공개 pause and its
 * approved 조기 마감 tell the holders of either side and a watcher, while a member with only a
 * resting order hears of its cancel alone (#134) — the close's params exactly the title and
 * `early` (AC 8), its row opening the closed market (AC 7). 3: a supplement of the title alone
 * tells nobody, one of the YES 조건 tells the watcher its version and reason, which the detail's
 * version history shows (52-10, 54-3, AC 4). 4: an operator's cancel of a 개장 예정 market tells
 * its watcher (52-5). The bot's stop telling nobody (AC 3) needs the worker's bot run: the API and
 * database tests pin it (market-maker-control.controller.test.ts, market-notifications.test.ts).
 *
 * The 마켓메이커 of a `createOpenMarket` market posts no quotes under the regression profile (stage
 * thresholds 0/0/0), so a member's immediate buy meets only another member's resting bid. Each
 * member sends at most one order — well under the 20 a minute (global-setup.ts). Rows of one event
 * share its instant, so their order falls to their ids: rows are found by type, never by place.
 */

/** A 지정가(GTC) NO buy of two at 40: the resting bid an immediate YES buy meets as a pair mint. */
const NO_BID: OrderTerms = {
  outcome: 'NO',
  side: 'buy',
  timeInForce: 'gtc',
  limitPriceCoin: 40,
  qty: 2,
};

/** An 즉시 거래(IOC) YES buy of one: it meets the NO bid at the bid's price (YES 60). */
const YES_TAKE: OrderTerms = {
  outcome: 'YES',
  side: 'buy',
  timeInForce: 'ioc',
  limitPriceCoin: 99,
  qty: 1,
};

/** A 지정가 YES buy of one at 10: it meets nothing (10 + 40 < 100) and rests. */
const YES_LOW_BID: OrderTerms = {
  outcome: 'YES',
  side: 'buy',
  timeInForce: 'gtc',
  limitPriceCoin: 10,
  qty: 1,
};

/** The reason a re-sent approval gives (1..500 characters): it is refused before it is read. */
const RESENT_APPROVAL_REASON = '같은 요청을 다시 승인합니다. 이미 결정된 요청입니다.';

test.describe('시장 상태 알림 (#54)', () => {
  test('일시 중단과 재개는 관심 등록자에게 공개 사유와 함께 새로 고침 없이 오고 누르면 시장 상세가 열리며, 그 전에 관심을 해제한 회원은 받지 않고 다시 보낸 승인은 아무것도 더하지 않는다 @ac189-8', async ({
    admin,
    secondAdmin,
    browser,
    page,
  }) => {
    test.slow(); // two members, a market through the review, a pause and its approved resume
    const uContext = await browser.newContext();
    let marketId: string | undefined;
    try {
      const uPage = await uContext.newPage();
      await signUp(page, freshEmail());
      await signUp(uPage, freshEmail());
      const w = page.request;
      const u = uPage.request;
      const market = await createOpenMarket(admin);
      marketId = market.id;

      // --- W watches; U watches and unwatches before any event (AC 5).
      await watchThroughApi(page, market.id);
      await watchThroughApi(uPage, market.id);
      await watchThroughApi(uPage, market.id, false);

      // --- W keeps MY open, its count read (none) and its socket in W's room.
      await openCounted(page, '/my');
      await expect(myUnread(page)).toHaveCount(0);
      await page.waitForTimeout(REALTIME_BUDGET_MS);
      await markDocument(page);

      // --- The admin pauses it for 실질 기준 변경: W's count turns 1 without a reload.
      await pauseMarket(admin, market.id, 'basis_change');
      await expect(myUnread(page)).toHaveText('1', { timeout: REALTIME_BUDGET_MS + ONE_READ_MS });
      expect(await documentSurvived(page)).toBe(true);
      const [paused, ...pausedMore] = await inboxOf(w);
      expect(pausedMore).toEqual([]);
      if (paused === undefined) throw new Error('W has no notice of the pause');
      expect(paused).toMatchObject({
        type: 'market_paused',
        category: 'market',
        params: { marketTitle: market.title, reason: 'basis_change' },
        target: { kind: 'market', slug: market.slug },
        eventCount: 1,
        readAt: null,
      });
      // U unwatched before it: nothing (AC 5).
      expect(await inboxOf(u)).toEqual([]);
      expect(await unreadCountOf(u)).toBe(0);

      // --- MY › 알림: one row under 시장, the reason in the 공개 판정 기록's label (52-9, 54-1).
      await openCounted(page, '/my/notifications');
      await expect(notificationRows(page)).toHaveCount(1);
      const pausedRow = notificationRow(page, paused.id);
      await expect(pausedRow).toHaveAttribute('data-read', 'false');
      await expect(pausedRow.getByTestId('notification-row-category')).toHaveText(
        copy.notificationCategoryMarket,
      );
      await expect(pausedRow.getByTestId('notification-row-title')).toHaveText(
        `${market.title} 거래 일시 중단 · 사유: 실질 기준 변경`,
      );
      await expect(pausedRow).toHaveAttribute('href', `/markets/${market.slug}`);
      await page.waitForTimeout(REALTIME_BUDGET_MS);
      await markDocument(page);

      // --- The 재개, reviewed 판정 가능 and approved by the second admin: W's count turns 2
      // without a reload, the resume on top with the ended pause's reason (52-9, 54-2).
      const requested = await requestPauseDecision(admin, market.id, 'resume', {
        reviewResult: 'judgeable',
      });
      const requestId = requested.pause.pending?.requestId;
      if (requestId === undefined) throw new Error('no 재개 waits after its request');
      expect((await approvePauseDecisionAsReviewer(admin, market.id, requestId)).status).toBe(
        'open',
      );
      await expect(myUnread(page)).toHaveText('2', { timeout: REALTIME_BUDGET_MS + ONE_READ_MS });
      await expect(notificationRows(page)).toHaveCount(2);
      expect(await documentSurvived(page)).toBe(true);
      const [resumed] = await inboxOf(w);
      if (resumed === undefined || resumed.id === paused.id) {
        throw new Error('the 재개 made no notice of its own');
      }
      expect(resumed).toMatchObject({
        type: 'market_resumed',
        category: 'market',
        params: { marketTitle: market.title, reason: 'basis_change' },
        target: { kind: 'market', slug: market.slug },
        eventCount: 1,
      });
      expect(await notificationRowIds(page)).toEqual([resumed.id, paused.id]);
      await expect(
        notificationRow(page, resumed.id).getByTestId('notification-row-title'),
      ).toHaveText(`${market.title} 거래 재개 · 중단 사유: 실질 기준 변경`);

      // --- The approval sent again: refused as decided, and nothing new for W (AC 6); U still
      // has nothing.
      const before = { inbox: await inboxOf(w), unread: await unreadCountOf(w) };
      expect(before.unread).toBe(2);
      await expectDecided(
        await sendPauseDecision(secondAdmin, market.id, requestId, 'approve', {
          reason: RESENT_APPROVAL_REASON,
        }),
      );
      expect({ inbox: await inboxOf(w), unread: await unreadCountOf(w) }).toEqual(before);
      expect(await inboxOf(u)).toEqual([]);

      // --- Pressed: the market's detail, at its top (54-4); back on 알림 the row is read.
      await notificationRow(page, resumed.id).click();
      await expect(page).toHaveURL(`/markets/${market.slug}`);
      await expect(page.getByTestId('watch-button')).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL('/my/notifications');
      await expect(notificationRow(page, resumed.id)).toHaveAttribute('data-read', 'true');
      await expect(notificationRow(page, paused.id)).toHaveAttribute('data-read', 'false');
    } finally {
      if (marketId !== undefined) await leaveNoPauseDecision(admin, marketId);
      await uContext.close();
    }
  });

  test('계약을 가진 회원과 관심 등록자는 일시 중단과 조기 마감을 알림으로 받고, 대기 주문만 있던 회원은 주문 취소 알림만 받으며, 마감 알림을 누르면 마감된 시장 상세가 열린다', async ({
    admin,
    browser,
    page,
  }) => {
    test.slow(); // four members, a market through the review, a pause and its approved 조기 마감
    const contexts = await Promise.all([
      browser.newContext(),
      browser.newContext(),
      browser.newContext(),
    ]);
    let marketId: string | undefined;
    try {
      const [bPage, cPage, wPage] = await Promise.all([
        contexts[0].newPage(),
        contexts[1].newPage(),
        contexts[2].newPage(),
      ]);
      for (const each of [page, bPage, cPage, wPage]) await signUp(each, freshEmail());
      const [a, b, c, w] = [page.request, bPage.request, cPage.request, wPage.request];
      const market = await createOpenMarket(admin);
      marketId = market.id;

      // --- A's NO bid of two at 40 rests; B's immediate YES buy fills one of it: A holds a NO
      // (one still resting), B a YES (52-1 counts both sides — one may pay nothing). C's YES bid
      // at 10 rests and meets nothing: C holds nothing and watches nothing. W only watches.
      expect((await placeOrder(a, market.id, crypto.randomUUID(), NO_BID)).order.status).toBe(
        'open',
      );
      expect((await placeOrder(b, market.id, crypto.randomUUID(), YES_TAKE)).order.status).toBe(
        'filled',
      );
      expect((await placeOrder(c, market.id, crypto.randomUUID(), YES_LOW_BID)).order.status).toBe(
        'open',
      );
      await watchThroughApi(wPage, market.id);
      // A's fill is #134's notice; nobody else has one yet.
      expect(await noticeTypesOf(a)).toEqual(['order_filled']);
      for (const member of [b, c, w]) expect(await noticeTypesOf(member)).toEqual([]);

      // --- The admin pauses it for 사건 선공개: the resting orders cancelled (#134's notice to A
      // and C) and the pause told to the holders and the watcher — not to C, whose order alone it
      // touched (52-1).
      await pauseMarket(admin, market.id, 'early_result');
      expect(await noticeTypesOf(a)).toEqual(['market_paused', 'order_filled', 'orders_cancelled']);
      for (const member of [b, w]) expect(await noticeTypesOf(member)).toEqual(['market_paused']);
      expect(await noticeTypesOf(c)).toEqual(['orders_cancelled']);
      expect(onlyNoticeOf(await inboxOf(a), 'market_paused').params).toEqual({
        marketTitle: market.title,
        reason: 'early_result',
      });

      // --- The 조기 마감, approved by the second admin: a person's fill is on it, so CLOSED — a
      // 거래 조기 마감 to each holder and the watcher, nothing new to C (52-8).
      const requested = await requestPauseDecision(admin, market.id, 'early_close');
      const requestId = requested.pause.pending?.requestId;
      if (requestId === undefined) throw new Error('no 조기 마감 waits after its request');
      expect((await approvePauseDecisionAsReviewer(admin, market.id, requestId)).status).toBe(
        'closed',
      );
      expect(await noticeTypesOf(a)).toEqual([
        'market_closed',
        'market_paused',
        'order_filled',
        'orders_cancelled',
      ]);
      for (const member of [b, w]) {
        expect(await noticeTypesOf(member)).toEqual(['market_closed', 'market_paused']);
      }
      expect(await noticeTypesOf(c)).toEqual(['orders_cancelled']);
      // Its params are the title and `early`, exactly: no count, no holding, nobody else (AC 8).
      const aInbox = await inboxOf(a);
      const closed = onlyNoticeOf(aInbox, 'market_closed');
      expect(closed).toMatchObject({
        category: 'market',
        target: { kind: 'market', slug: market.slug },
        eventCount: 1,
      });
      expect(closed.params).toEqual({ marketTitle: market.title, early: true });
      expect(onlyNoticeOf(await inboxOf(w), 'market_closed').params).toEqual(closed.params);

      // --- A's 알림: four rows, the market's two in the owner's words (54-1).
      await openCounted(page, '/my/notifications');
      await expect(notificationRows(page)).toHaveCount(4);
      await expect(myUnread(page)).toHaveText('4');
      await expect(
        notificationRow(page, onlyNoticeOf(aInbox, 'market_paused').id).getByTestId(
          'notification-row-title',
        ),
      ).toHaveText(`${market.title} 거래 일시 중단 · 사유: 사건 선공개(조기 결과)`);
      const closedRow = notificationRow(page, closed.id);
      await expect(closedRow.getByTestId('notification-row-category')).toHaveText(
        copy.notificationCategoryMarket,
      );
      await expect(closedRow.getByTestId('notification-row-title')).toHaveText(
        `${market.title} 거래 조기 마감`,
      );

      // --- Pressed: the market's detail, closed (AC 7).
      await closedRow.click();
      await expect(page).toHaveURL(`/markets/${market.slug}`);
      await expect(page.getByTestId('market-status-notice')).toContainText(copy.marketClosedNotice);
    } finally {
      if (marketId !== undefined) await leaveNoPauseDecision(admin, marketId);
      for (const each of contexts) await each.close();
    }
  });

  test('제목만 고친 규칙 보충은 알리지 않고, YES 조건을 바꾼 보충은 관심 등록자에게 새 제목·버전·사유로 오며, 누르면 시장 상세의 규칙 버전 이력에서 그 사유를 본다', async ({
    admin,
    page,
  }) => {
    await signUp(page, freshEmail());
    const w = page.request;
    const market = await createOpenMarket(admin);
    try {
      await watchThroughApi(page, market.id);
      await openCounted(page, '/my/notifications');
      await expect(page.getByTestId('my-notifications-empty')).toHaveText(copy.notificationsEmpty);
      await page.waitForTimeout(REALTIME_BUDGET_MS);
      await markDocument(page);

      // --- A supplement of the title alone: v2, and nobody told (52-10 — 제목·배경만 고친 보충은
      // 알리지 않는다): past the realtime budget and a read, still nothing.
      const newTitle = `${market.title} (보충한 제목)`;
      await requestSupplement(admin, market.id, { title: newTitle });
      expect((await approveSupplementAsReviewer(admin, market.id)).ruleVersion).toBe(2);
      await page.waitForTimeout(REALTIME_BUDGET_MS + ONE_READ_MS);
      await expect(page.getByTestId('my-notifications-empty')).toHaveText(copy.notificationsEmpty);
      await expect(myUnread(page)).toHaveCount(0);
      expect(await inboxOf(w)).toEqual([]);
      expect(await unreadCountOf(w)).toBe(0);

      // --- A supplement of the YES 조건 with its public reason: v3, told to the watcher without a
      // reload — the title after the supplements, the version and the reason (52-10, 54-3).
      const reason = `YES 조건에 공식 발표만 센다고 분명히 적습니다 ${market.tag}`;
      await requestSupplement(
        admin,
        market.id,
        {
          yesCondition: `사건 기한까지 확인 코드가 공식 발표되면 YES입니다. 확인 코드 ${market.tag}.`,
        },
        { reason },
      );
      expect((await approveSupplementAsReviewer(admin, market.id)).ruleVersion).toBe(3);
      await expect(myUnread(page)).toHaveText('1', { timeout: REALTIME_BUDGET_MS + ONE_READ_MS });
      await expect(notificationRows(page)).toHaveCount(1);
      expect(await documentSurvived(page)).toBe(true);
      const [notice, ...more] = await inboxOf(w);
      expect(more).toEqual([]);
      if (notice === undefined) throw new Error('W has no notice of the supplement');
      expect(notice).toMatchObject({
        type: 'market_rules_supplemented',
        category: 'market',
        params: { marketTitle: newTitle, ruleVersion: 3, reason },
        target: { kind: 'market', slug: market.slug },
        eventCount: 1,
      });
      const row = notificationRow(page, notice.id);
      await expect(row.getByTestId('notification-row-title')).toHaveText(
        `${newTitle} 규칙 보충 v3 · 사유: ${reason}`,
      );

      // --- Pressed: the detail, whose version history shows v3 with the same reason (AC 4).
      await row.click();
      await expect(page).toHaveURL(`/markets/${market.slug}`);
      const card = detailCopyTestId(page, 'market-rule-versions');
      await expect(page.getByTestId(`${card}-version-3-reason`)).toHaveText(reason);
    } finally {
      await leaveNoSupplement(admin, market.id);
    }
  });

  test('개장 예정 시장의 취소는 관심 등록자에게 시장 취소 알림으로 오고, 누르면 취소된 시장 상세가 열린다', async ({
    admin,
    secondAdmin,
    page,
  }) => {
    await signUp(page, freshEmail());
    const w = page.request;
    const [first, second] = await Promise.all([meOf(admin), meOf(secondAdmin)]);
    const market = await createScheduledMarket(admin);
    await watchThroughApi(page, market.id);

    // --- Admin 1 asks to cancel it, admin 2 approves (#20, ADR-0117): never opened, 취소.
    let requestId: string | undefined;
    try {
      const asked = await dataOf<AdminMarket>(
        await admin.post(`/api/v1/admin/markets/${market.id}/cancel-requests`, {
          data: {
            reason: `판정 출처가 운영을 멈춰 열지 않고 끝냅니다 ${market.tag}`,
            expectedAccountId: first.id,
          },
        }),
      );
      requestId = asked.cancel.pending?.requestId;
      if (requestId === undefined) throw new Error('no cancel request waits after the request');
      const cancelled = await dataOf<AdminMarket>(
        await secondAdmin.post(
          `/api/v1/admin/markets/${market.id}/cancel-requests/${requestId}/approve`,
          {
            data: {
              reason: `출처가 멈춘 것을 확인했습니다 ${market.tag}`,
              expectedAccountId: second.id,
            },
          },
        ),
      );
      expect(cancelled.status).toBe('cancelled');
    } finally {
      // A failure before the approval leaves the request waiting; once approved, nothing waits.
      if (requestId !== undefined) {
        await admin
          .post(`/api/v1/admin/markets/${market.id}/cancel-requests/${requestId}/retract`, {
            data: { expectedAccountId: first.id },
          })
          .catch(() => undefined);
      }
    }

    // --- The watcher's notice: 시장 취소 (52-5) — no holder exists before the open.
    const [notice, ...more] = await inboxOf(w);
    expect(more).toEqual([]);
    if (notice === undefined) throw new Error('W has no notice of the cancel');
    expect(notice).toMatchObject({
      type: 'market_cancelled',
      category: 'market',
      params: { marketTitle: market.title },
      target: { kind: 'market', slug: market.slug },
      eventCount: 1,
    });
    await openCounted(page, '/my/notifications');
    await expect(myUnread(page)).toHaveText('1');
    await expect(notificationRows(page)).toHaveCount(1);
    const row = notificationRow(page, notice.id);
    await expect(row.getByTestId('notification-row-title')).toHaveText(`${market.title} 시장 취소`);

    // --- Pressed: the market's detail, 취소 (AC 7).
    await row.click();
    await expect(page).toHaveURL(`/markets/${market.slug}`);
    await expect(page.getByTestId('market-status-notice')).toContainText(
      copy.marketCancelledNotice,
    );
  });
});
