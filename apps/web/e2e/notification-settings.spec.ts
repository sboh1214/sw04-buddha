import type { APIRequestContext, Page } from '@playwright/test';
import type { Notification, PlaceOrderResult } from '@buddha/shared';
import { formatCoin } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  NOTIFICATION_SETTINGS_API_PATH,
  ONE_READ_MS,
  REALTIME_BUDGET_MS,
  type OrderTerms,
  accountIdOf,
  approvePauseDecisionAsReviewer,
  commentThroughApi,
  createOpenMarket,
  dataOf,
  expect,
  expectNoSideScroll,
  freshEmail,
  freshTag,
  inboxOf,
  judgeMarket,
  leaveNoJudgement,
  leaveNoPauseDecision,
  meOf,
  myUnread,
  notificationCategoryOn,
  notificationRow,
  notificationSettingBox,
  notificationSettingsOf,
  noticeTypesOf,
  noticesOf,
  onlyNoticeOf,
  openCounted,
  pauseMarket,
  placeOrder,
  postThroughApi,
  requestPauseDecision,
  setNotificationCategory,
  signUp,
  skipUnlessResolvable,
  switchAccountUnderScreen,
  switchNotificationCategoryOnScreen,
  test,
  toastsOf,
  unreadCountOf,
  waitForSettled,
  watchThroughApi,
} from './helpers';

/**
 * 알림 수신 설정 (#56, ADR-0162; owner answers 52-21…52-23, 56-1…56-5) on the screens, every event
 * through the API as production makes it, on fresh accounts.
 *
 * 1: MY › 설정's '알림 수신' card — three switches (거래·시장·커뮤니티) all on at first (52-21), none
 * locked, no channel or price item (AC 9), the 56-3 line and its link to the 정산 list (52-23); a
 * press saves at once and holds across a reload; MY › 알림's '수신 설정' link opens the card (56-4);
 * a tab whose account changed under it is refused and changes nobody's settings (AC 2); a visitor
 * is sent to the login. 2: 거래 — while A's 거래 is off a fill of A's resting order neither makes nor
 * grows A's unread notice (52-22, AC 4); A's notice stays listed and counted (56-1); on again, the
 * next fill joins that notice, the off fill never counted. 3: one pause, two members with opposite
 * settings — each gets only its own on category's notice (per input, AC 4); on again, the resume
 * arrives (AC 5). 4: 커뮤니티 — a reply and a warning while off make nothing (AC 6, 52-16), on again
 * both arrive, the reply joining the unread notice. 5: everything off — no 시장 notice of the
 * result or the payout, and the 정산 record with its payout of 0 is on MY 거래·정산 이력 (52-23, AC 8).
 *
 * The 마켓메이커 of a `createOpenMarket` market posts no quotes under the regression profile, so a
 * member's immediate buy meets only another member's resting bid. Orders stay under 20 a minute per
 * member and comments under 5 per writer (global-setup.ts, write-limits.ts). Notices are found by
 * type and id, never by place.
 */

/** A 지정가(GTC) NO buy at 40: the resting bid an immediate YES buy meets as a pair mint. */
const NO_BID = (qty: number): OrderTerms => ({
  outcome: 'NO',
  side: 'buy',
  timeInForce: 'gtc',
  limitPriceCoin: 40,
  qty,
});

/** An 즉시 거래(IOC) YES buy of one: it meets a NO bid at the bid's price (YES 60). */
const YES_TAKE: OrderTerms = {
  outcome: 'YES',
  side: 'buy',
  timeInForce: 'ioc',
  limitPriceCoin: 99,
  qty: 1,
};

/** What no line of the card may name (#56 AC 9, N05 §4, N04 §7, N06). */
const EXCLUDED_WORDS = [
  '가격',
  '이메일',
  '푸시',
  '점수',
  '순위',
  'Forecast',
  '구매',
  '충전',
  '결제',
];

/** The unread count's read, as the browser asks it. */
const UNREAD_COUNT_PATH = '/api/v1/me/notifications/unread-count';

/** Opens MY › 설정 and waits for the card's switches, drawn from the member's settings. */
async function openSettings(page: Page): Promise<void> {
  const read = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === NOTIFICATION_SETTINGS_API_PATH,
  );
  await page.goto('/my/settings');
  expect((await read).status()).toBe(200);
  await expect(page.getByTestId('settings-notifications-list')).toBeVisible();
}

/** The member's one notice of `type` whose id is `id`. */
function noticeById(inbox: readonly Notification[], id: string): Notification | undefined {
  return inbox.find((notice) => notice.id === id);
}

test.describe('알림 수신 설정 (#56)', () => {
  test('MY › 설정의 알림 수신 카드는 거래·시장·커뮤니티 스위치 셋이 처음엔 모두 켜져 있고, 누르면 바로 저장되어 다시 들어와도 유지되며, 정산 기록 안내와 정산 목록 링크가 있고, MY › 알림의 수신 설정 링크가 이 카드로 오며, 계정이 바뀐 탭의 저장은 거절되고, 비로그인은 로그인으로 간다', async ({
    browser,
    page,
  }) => {
    test.slow(); // two members, a stale tab and a visitor
    const otherContext = await browser.newContext();
    const shownContext = await browser.newContext();
    const visitorContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      await signUp(other, freshEmail());
      const b = await meOf(other.request);
      await signUp(page, freshEmail());
      const a = await meOf(page.request);

      // --- Never saved: all three on (52-21 '처음엔 켜짐'), in the shared order.
      expect(await notificationSettingsOf(page.request)).toEqual({
        categories: [
          { category: 'trade', enabled: true },
          { category: 'market', enabled: true },
          { category: 'community', enabled: true },
        ],
      });

      // --- The card: titled and hinted as approved (56-5), exactly three switches, all on and
      // none locked (52-21), each with what it covers; no channel, price or score item (AC 9).
      await openSettings(page);
      const card = page.getByTestId('settings-notifications');
      await expect(card.getByRole('heading', { name: copy.settingsNotifications })).toBeVisible();
      await expect(card).toContainText(copy.settingsNotificationsHint);
      await expect(card.getByRole('checkbox')).toHaveCount(3);
      await expect(card.locator('[data-testid$="-switch"]')).toHaveCount(3);
      for (const category of ['trade', 'market', 'community'] as const) {
        const box = notificationSettingBox(page, category);
        await expect(box).toBeChecked();
        await expect(box).toBeEnabled();
        await expect(card.getByTestId(`settings-notifications-${category}-hint`)).toBeVisible();
      }
      for (const word of EXCLUDED_WORDS) await expect(card).not.toContainText(word);
      // The card sits after 화면 모드 and before 조치·신고 내역 (56-4).
      const order = await page
        .locator('section[data-testid^="settings-"]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));
      const at = (testId: string) => order.indexOf(testId);
      expect(at('settings-notifications')).toBe(at('settings-theme') + 1);
      expect(at('settings-moderation')).toBe(at('settings-notifications') + 1);
      if ((page.viewportSize()?.width ?? 0) < 768) await expectNoSideScroll(page);

      // --- The 56-3 line and its link: 거래·정산 이력's 정산 list (52-23).
      await expect(card.getByTestId('settings-notifications-note')).toHaveText(
        copy.notificationSettingsHistoryNote,
      );
      const historyLink = card.getByTestId('settings-notifications-history-link');
      await expect(historyLink).toHaveText(copy.notificationSettingsHistoryLink);
      await historyLink.click();
      await expect(page).toHaveURL('/my/history?kind=settlements');
      await expect(page.getByTestId('my-settlement-history')).toBeVisible();

      // --- 시장 off: saved at once with its toast, still off after a reload, and the API agrees;
      // the other two untouched.
      await openSettings(page);
      await switchNotificationCategoryOnScreen(page, 'market', false);
      await page.reload();
      await expect(notificationSettingBox(page, 'market')).not.toBeChecked();
      await expect(notificationSettingBox(page, 'trade')).toBeChecked();
      await expect(notificationSettingBox(page, 'community')).toBeChecked();
      expect(await notificationCategoryOn(page.request, 'market')).toBe(false);
      expect(await notificationCategoryOn(page.request, 'trade')).toBe(true);

      // --- MY › 알림's '수신 설정' beside '모두 읽음' opens the card (56-4).
      await openCounted(page, '/my/notifications');
      const settingsLink = page.getByTestId('my-notifications-settings-link');
      await expect(settingsLink).toHaveText(copy.notificationsSettingsLink);
      await settingsLink.click();
      await expect(page).toHaveURL('/my/settings#settings-notifications');
      await expect(page.getByTestId('settings-notifications')).toBeInViewport();
      // The jump stops below the sticky header (section.tsx's scroll margin), not under it.
      const header = await page.locator('header').boundingBox();
      const cardHeading = page.getByTestId('settings-notifications').getByRole('heading');
      await expect
        .poll(async () => (await cardHeading.boundingBox())?.y ?? -1)
        .toBeGreaterThanOrEqual((header?.y ?? 0) + (header?.height ?? Infinity));
      await expect(notificationSettingBox(page, 'market')).not.toBeChecked();

      // --- A's screen, B's cookie (time-zone.spec.ts's stale tab, ADR-0090): the card still
      // drawn from A's `Me` and A's settings, a press names A — refused as another account's, the
      // switch back to A's value, nobody's settings changed (AC 2).
      await openSettings(page);
      await shownContext.addCookies(await page.context().cookies());
      await switchAccountUnderScreen(
        page,
        shownContext.request,
        { id: b.id, cookies: await otherContext.cookies() },
        (request) =>
          request.method() === 'GET' &&
          new URL(request.url()).pathname === NOTIFICATION_SETTINGS_API_PATH,
      );
      const writes: unknown[] = [];
      page.on('request', (request) => {
        if (
          request.method() === 'PUT' &&
          new URL(request.url()).pathname.startsWith(`${NOTIFICATION_SETTINGS_API_PATH}/`)
        ) {
          writes.push(request.postDataJSON());
        }
      });
      const tradeBox = notificationSettingBox(page, 'trade');
      await expect(tradeBox).toBeChecked();
      await expect(notificationSettingBox(page, 'market')).not.toBeChecked();
      const refused = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `${NOTIFICATION_SETTINGS_API_PATH}/trade`,
      );
      await page.getByTestId('settings-notifications-trade-switch').click();
      expect((await refused).status()).toBe(403);
      await expect(toastsOf(page).getByText(copy.sessionChanged)).toBeVisible();
      // Refused: the switch shows A's value again.
      await expect(tradeBox).toBeChecked();
      expect(writes).toEqual([{ enabled: false, expectedAccountId: a.id }]);
      expect(await notificationCategoryOn(other.request, 'trade')).toBe(true);
      expect(await notificationCategoryOn(other.request, 'market')).toBe(true);
      expect(await notificationCategoryOn(shownContext.request, 'trade')).toBe(true);
      expect(await notificationCategoryOn(shownContext.request, 'market')).toBe(false);

      // --- A visitor: MY › 설정 sends it to the login (requireMySession).
      const visitor = await visitorContext.newPage();
      await visitor.goto('/my/settings');
      await expect(visitor).toHaveURL(/\/login/);
      const anonymous = await visitor.request.get(NOTIFICATION_SETTINGS_API_PATH);
      expect(anonymous.status()).toBe(401);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await otherContext.close();
      await shownContext.close();
      await visitorContext.close();
    }
  });

  test('거래를 끈 동안 대기 주문의 체결은 알림을 만들지도 안 읽은 알림에 더하지도 않고, 이미 받은 알림은 그대로 목록과 안 읽은 수에 남으며, 다시 켜면 다음 체결이 그 알림에 합쳐지되 꺼 둔 동안의 체결은 세지 않는다', async ({
    admin,
    browser,
    page,
  }) => {
    test.slow(); // two members, a market through the review and four orders
    const bContext = await browser.newContext();
    try {
      const bPage = await bContext.newPage();
      await signUp(page, freshEmail());
      await signUp(bPage, freshEmail());
      const a = page.request;
      const b = bPage.request;
      const market = await createOpenMarket(admin);

      // --- A's NO bid of 3 rests; B takes 1: A's one unread `order_filled` (52-6).
      const order = (await placeOrder(a, market.id, crypto.randomUUID(), NO_BID(3))).order;
      await placeOrder(b, market.id, crypto.randomUUID(), YES_TAKE);
      const [first] = await inboxOf(a);
      if (first === undefined) throw new Error('A has no notice of the first fill');
      expect(first).toMatchObject({
        type: 'order_filled',
        category: 'trade',
        target: { kind: 'order', orderId: order.id },
        eventCount: 1,
        readAt: null,
      });
      expect(first.params).toMatchObject({ qty: '1', orderFilledQty: '1', fullyFilled: false });

      // --- A turns 거래 off on screen, then keeps MY open with its count read and its socket up.
      await openSettings(page);
      await switchNotificationCategoryOnScreen(page, 'trade', false);
      await openCounted(page, '/my');
      await expect(myUnread(page)).toHaveText('1');
      await page.waitForTimeout(REALTIME_BUDGET_MS);
      let countReads = 0;
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === UNREAD_COUNT_PATH) countReads += 1;
      });

      // --- B takes 1 while it is off: the order fills (2 of 3), and A's notice is as it was —
      // same id, one event, the first fill's quantity — no new row, no signal (52-22, AC 4).
      const taken = await placeOrder(b, market.id, crypto.randomUUID(), YES_TAKE);
      expect(taken.order.status).toBe('filled');
      await page.waitForTimeout(REALTIME_BUDGET_MS + ONE_READ_MS);
      expect(countReads).toBe(0);
      await expect(myUnread(page)).toHaveText('1');
      expect(await inboxOf(a)).toEqual([first]);
      expect(await unreadCountOf(a)).toBe(1);
      const filled = await dataOf<{ filledQty: number }>(
        await a.get(`/api/v1/me/orders/${order.id}`),
      );
      expect(filled.filledQty).toBe(2);

      // --- 56-1: what A had stays listed, unread, on MY › 알림.
      await openCounted(page, '/my/notifications');
      await expect(notificationRow(page, first.id)).toHaveAttribute('data-read', 'false');

      // --- On again; B takes the last 1: it joins the same unread notice — two events, 이번 2,
      // the order's whole 3 of 3 beside it (the off fill never counted, ADR-0158 '이번').
      await openSettings(page);
      await switchNotificationCategoryOnScreen(page, 'trade', true);
      await placeOrder(b, market.id, crypto.randomUUID(), YES_TAKE);
      const [merged, ...others] = await inboxOf(a);
      expect(others).toEqual([]);
      expect(merged).toMatchObject({ id: first.id, eventCount: 2, readAt: null });
      expect(merged?.params).toMatchObject({
        qty: '2',
        orderFilledQty: '3',
        orderQty: '3',
        fullyFilled: true,
      });
      await openCounted(page, '/my/notifications');
      await expect(
        notificationRow(page, first.id).getByTestId('notification-row-title'),
      ).toHaveText(
        `${market.title} NO 매수 주문 전량 체결 · 체결 2회 · 이번 2계약 · 평균 40.00 Coin ` +
          '(주문 3계약 중 3계약 체결)',
      );
    } finally {
      await bContext.close();
    }
  });

  test('한 일시 중단에서 거래만 끈 회원은 시장 알림만, 시장만 끈 회원은 주문 취소 알림만 받고, 시장을 다시 켜면 재개 알림이 온다', async ({
    admin,
    browser,
    page,
  }) => {
    test.slow(); // two members, a market through the review, a pause and its approved resume
    const cContext = await browser.newContext();
    let marketId: string | undefined;
    try {
      const cPage = await cContext.newPage();
      await signUp(page, freshEmail());
      await signUp(cPage, freshEmail());
      const a = page.request;
      const c = cPage.request;
      const market = await createOpenMarket(admin);
      marketId = market.id;

      // --- Both rest a NO bid and watch; A: 거래 off · 시장 on; C: 거래 on · 시장 off.
      await placeOrder(a, market.id, crypto.randomUUID(), NO_BID(1));
      await placeOrder(c, market.id, crypto.randomUUID(), NO_BID(1));
      await watchThroughApi(page, market.id);
      await watchThroughApi(cPage, market.id);
      await setNotificationCategory(a, 'trade', false);
      await setNotificationCategory(c, 'market', false);

      // --- The pause: one event, two categories — each member hears its own on category only.
      await pauseMarket(admin, market.id, 'basis_change');
      expect(await noticeTypesOf(a)).toEqual(['market_paused']);
      expect(await noticeTypesOf(c)).toEqual(['orders_cancelled']);
      expect(onlyNoticeOf(await inboxOf(a), 'market_paused')).toMatchObject({
        category: 'market',
        target: { kind: 'market', slug: market.slug },
      });

      // --- C turns 시장 on; the approved 재개 reaches both (AC 5), the pause never C's.
      await setNotificationCategory(c, 'market', true);
      const requested = await requestPauseDecision(admin, market.id, 'resume', {
        reviewResult: 'judgeable',
      });
      const requestId = requested.pause.pending?.requestId;
      if (requestId === undefined) throw new Error('no 재개 waits after its request');
      expect((await approvePauseDecisionAsReviewer(admin, market.id, requestId)).status).toBe(
        'open',
      );
      expect(await noticeTypesOf(a)).toEqual(['market_paused', 'market_resumed']);
      expect(await noticeTypesOf(c)).toEqual(['market_resumed', 'orders_cancelled']);
      expect(onlyNoticeOf(await inboxOf(c), 'market_resumed')).toMatchObject({
        category: 'market',
        params: { marketTitle: market.title, reason: 'basis_change' },
      });
    } finally {
      if (marketId !== undefined) await leaveNoPauseDecision(admin, marketId);
      await cContext.close();
    }
  });

  test('커뮤니티를 끈 동안 내 글의 댓글과 운영 조치는 알림이 없고, 다시 켜면 다음 댓글이 안 읽은 알림에 합쳐지고 경고 알림이 온다', async ({
    admin,
    browser,
    page,
  }) => {
    test.slow(); // four members, three comments and two warnings
    const tag = freshTag();
    const contexts = await Promise.all([
      browser.newContext(),
      browser.newContext(),
      browser.newContext(),
    ]);
    try {
      const pages = await Promise.all(contexts.map((context) => context.newPage()));
      await signUp(page, freshEmail());
      for (const each of pages) await signUp(each, freshEmail());
      const p = page.request;
      const [r1, r2, r3] = pages.map((each) => each.request) as [
        APIRequestContext,
        APIRequestContext,
        APIRequestContext,
      ];
      const pMe = await meOf(p);
      const operator = await accountIdOf(admin);
      const market = await createOpenMarket(admin);
      const postId = await postThroughApi(p, market.id, `댓글 받을 글 ${tag}`, tag);
      /** An operator's warning of P: its id. */
      const warn = async () => {
        const res = await admin.post(`/api/v1/admin/moderation/users/${pMe.id}/warn`, {
          data: {
            reason: 'spam',
            note: `회원이 읽는 설명 ${tag}`,
            subject: null,
            expectedAccountId: operator,
          },
        });
        expect(res.status(), await res.text()).toBe(200);
        return ((await res.json()) as { data: { id: string } }).data.id;
      };

      // --- R1's 댓글: P's `post_replied`, one reply.
      const c1 = await commentThroughApi(r1, postId, null, `R1의 댓글 ${tag}`);
      const first = onlyNoticeOf(await inboxOf(p), 'post_replied');
      expect(first).toMatchObject({ category: 'community', eventCount: 1, readAt: null });
      expect(first.params).toEqual({ replyId: c1.id, replyCreatedAt: c1.createdAt });

      // --- P turns 커뮤니티 off on screen. R2's 댓글 and a warning make nothing: the notice as it
      // was (52-22), and no `moderation_action_taken` (AC 6 — 52-16's notices too).
      await openSettings(page);
      await switchNotificationCategoryOnScreen(page, 'community', false);
      await commentThroughApi(r2, postId, null, `R2의 댓글 ${tag}`);
      const offWarning = await warn();
      expect(await inboxOf(p)).toEqual([first]);
      expect(await unreadCountOf(p)).toBe(1);

      // --- On again: R3's 댓글 joins the unread notice — two replies, the latest R3's (R2's never
      // counted) — and the next warning arrives.
      await switchNotificationCategoryOnScreen(page, 'community', true);
      const c3 = await commentThroughApi(r3, postId, null, `R3의 댓글 ${tag}`);
      const merged = onlyNoticeOf(await inboxOf(p), 'post_replied');
      expect(merged).toMatchObject({ id: first.id, eventCount: 2, readAt: null });
      expect(merged.params).toEqual({ replyId: c3.id, replyCreatedAt: c3.createdAt });
      const onWarning = await warn();
      const warned = onlyNoticeOf(await inboxOf(p), 'moderation_action_taken');
      expect(warned).toMatchObject({
        category: 'community',
        target: { kind: 'moderation_action', actionId: onWarning },
      });
      expect(warned.params).toEqual({ action: 'warning', endsAt: null });
      expect(JSON.stringify(await inboxOf(p))).not.toContain(offWarning);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });

  test('모두 꺼도 판정·정산은 알림 없이 진행되고, 지급 0의 정산 기록은 MY 거래·정산 이력의 정산 목록에 있다', async ({
    admin,
    browser,
    baseURL,
    page,
  }) => {
    test.slow(); // two members, a market through the review, a judgement and the payout
    await skipUnlessResolvable(admin);
    const viewport = page.viewportSize();
    const hContext = await browser.newContext({ baseURL, viewport });
    let marketId: string | undefined;
    try {
      const hPage = await hContext.newPage();
      await signUp(page, freshEmail());
      await signUp(hPage, freshEmail());
      const s = page.request;
      const h = hPage.request;
      const market = await createOpenMarket(admin);
      marketId = market.id;

      // --- S rests a NO bid of 2 at 70; H's immediate YES buy meets it: opposite sides.
      const order = async (
        context: APIRequestContext,
        outcome: 'YES' | 'NO',
        price: number,
        timeInForce: 'gtc' | 'ioc',
      ) =>
        dataOf<PlaceOrderResult>(
          await context.post(`/api/v1/markets/${market.id}/orders`, {
            headers: { 'Idempotency-Key': crypto.randomUUID() },
            data: {
              expectedAccountId: await accountIdOf(context),
              side: 'buy',
              outcome,
              qty: 2,
              limitPriceCoin: price,
              timeInForce,
            },
          }),
        );
      expect((await order(s, 'NO', 70, 'gtc')).order.status).toBe('open');
      expect((await order(h, 'YES', 99, 'ioc')).order.status).toBe('filled');
      // S's resting bid's fill, heard while 거래 was on: what S must keep after turning all off.
      const before = await inboxOf(s);
      expect(noticesOf(before, 'order_filled')).toHaveLength(1);

      // --- S turns all three off on screen (52-21 '모두 끌 수 있고', AC 7); H keeps them on.
      await openSettings(page);
      for (const category of ['trade', 'market', 'community'] as const) {
        await switchNotificationCategoryOnScreen(page, category, false);
      }

      // --- The pause, the approved 조기 마감, the judgement (YES — S holds NO) and the payout.
      await pauseMarket(admin, market.id);
      await requestPauseDecision(admin, market.id, 'early_close', { reviewResult: 'judgeable' });
      expect((await approvePauseDecisionAsReviewer(admin, market.id)).status).toBe('closed');
      await judgeMarket(admin, market.id, 'YES');
      const settled = await waitForSettled(admin, market.id);
      expect(settled.resolvedResult).toBe('YES');

      // --- H heard of the 잠정 결과 and the 최종 정산; S of nothing at all, what it had kept.
      const hInbox = await inboxOf(h);
      expect(noticesOf(hInbox, 'market_provisional_result')).toHaveLength(1);
      expect(onlyNoticeOf(hInbox, 'market_settled').params).toMatchObject({
        result: 'YES',
        payoutCoin: '200',
      });
      const sInbox = await inboxOf(s);
      expect(sInbox).toEqual(before);
      expect(sInbox.filter((notice) => notice.type.startsWith('market_'))).toEqual([]);
      const filled = onlyNoticeOf(before, 'order_filled');
      expect(noticeById(sInbox, filled.id)).toEqual(filled);

      // --- S's 정산 record on MY 거래·정산 이력 (52-23): the losing contract kept, payout 0.
      await page.goto('/my/history?kind=settlements');
      const row = page
        .getByTestId('my-settlement-history')
        .getByTestId(`history-settlement-${market.id}-NO`);
      await expect(row).toContainText(market.title);
      await expect(row.getByTestId('history-settlement-result')).toHaveText(copy.yes);
      await expect(row.getByTestId('history-settlement-qty')).toHaveText('2계약');
      await expect(row.getByTestId('history-settlement-payout')).toHaveText(formatCoin(0n));
      if ((viewport?.width ?? 0) < 768) await expectNoSideScroll(page);
    } finally {
      if (marketId !== undefined) {
        await leaveNoPauseDecision(admin, marketId);
        await leaveNoJudgement(admin, marketId);
      }
      await hContext.close();
    }
  });
});
