import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TimeZoneScope } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { type InboxNotification, type Me } from '@/lib/api';
import { SEOUL_TIME_ZONE, formatInTimeZone, formatKst } from '@/lib/datetime';
import { MY_PREVIEW_ROWS } from '@/lib/my';
import { type NotificationPage, notificationListKey } from '@/lib/notifications';
import { byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import {
  MyNotifications,
  type Notifications,
  NotificationsBody,
  NotificationsReadAll,
} from './my-notifications';

const ACCOUNT = { id: 'b7c9a1d2-6f34-4e58-9b0a-2d1e5f8c7a46' } as Me;
const UNREAD_ID = '9b2c8e4a-1f3d-4c6b-8a7e-5d4c3b2a1f01';
const READ_ID = '9b2c8e4a-1f3d-4c6b-8a7e-5d4c3b2a1f02';

const notification = (id: string, fields: Partial<InboxNotification> = {}): InboxNotification => ({
  id,
  type: 'test_notice',
  category: 'market',
  params: { label: '첫눈' },
  target: { kind: 'market', slug: 'first-snow' },
  eventCount: 1,
  occurredAt: '2026-11-21T03:00:00.000Z',
  readAt: null,
  ...fields,
});

/** A list as a read leaves it, with the flags a test overrides. */
const list = (pages: NotificationPage[], flags: Partial<Notifications> = {}): Notifications => ({
  data: { pages, pageParams: pages.map(() => undefined) },
  hasNextPage: pages.at(-1)?.nextCursor != null,
  isPending: false,
  isLoadingError: false,
  isRefetchError: false,
  error: null,
  isFetchNextPageError: false,
  isFetchingNextPage: false,
  failureReason: null,
  refetch: () => Promise.reject(new Error('not in a test')),
  fetchNextPage: () => Promise.reject(new Error('not in a test')),
  ...flags,
});

/** The body drawn from `notifications` (`useMyNotifications` waits for a session node lacks). */
const drawn = (notifications: Notifications, limit?: number, testId = 'my-notifications') =>
  renderWithQueries(
    <NotificationsBody
      notifications={notifications}
      accountId={ACCOUNT.id}
      testId={testId}
      {...(limit === undefined ? {} : { limit })}
    />,
  );

/** One row of the drawn HTML, by the notification's id. */
const rowOf = (html: string, id: string) => {
  const at = html.indexOf(`data-notification-id="${id}"`);
  if (at < 0) return undefined;
  const start = html.lastIndexOf('<', at);
  const end = html.indexOf('</li>', at);
  return html.slice(start, end);
};

/**
 * MY › 알림 as drawn (#53, ADR-0157; owner answers 53-1…53-3, 53-11): the member's notifications
 * newest first, unread ones marked by more than colour, '모두 읽음', the ladder and 더 보기.
 */
describe('MyNotifications', () => {
  it('waits for the session before drawing the list, with 모두 읽음 off (MY’s ladder)', () => {
    const html = renderWithQueries(<MyNotifications />, [
      [notificationListKey(ACCOUNT.id), { pages: [], pageParams: [] }],
      [ME_QUERY_KEY, ACCOUNT],
    ]);
    expect(byTestId(html, 'my-notifications')?.text).toContain(copy.myNotifications);
    expect(byTestId(html, 'my-notifications-read-all')?.text).toBe(copy.notificationsReadAll);
    expect(byTestId(html, 'my-notifications-read-all')?.attributes).toHaveProperty('disabled');
    expect(byTestId(html, 'my-notifications-empty')).toBeUndefined();
    expect(byTestId(html, 'my-notifications-read-all-failed')).toBeUndefined();
  });

  it('links 수신 설정 beside 모두 읽음 to MY › 설정’s card, reading nothing (#56, 56-4)', () => {
    const html = renderWithQueries(<MyNotifications />, [
      [notificationListKey(ACCOUNT.id), { pages: [], pageParams: [] }],
      [ME_QUERY_KEY, ACCOUNT],
    ]);
    const link = byTestId(html, 'my-notifications-settings-link');
    expect(link?.text).toBe('수신 설정');
    expect(link?.attributes.href).toBe('/my/settings#settings-notifications');
    // In the heading's row, before 모두 읽음.
    expect(html.indexOf('my-notifications-settings-link')).toBeLessThan(
      html.indexOf('my-notifications-read-all'),
    );
    expect(byTestId(html, 'my-notifications')?.text).not.toContain(copy.settingsNotifications);
  });

  it('says there is none while the member has no notification', () => {
    const html = drawn(list([{ items: [], nextCursor: null }]));
    expect(byTestId(html, 'my-notifications-empty')?.text).toBe('알림이 없습니다.');
    expect(byTestId(html, 'my-notifications-list')).toBeUndefined();
    expect(byTestId(html, 'my-notifications-more')).toBeUndefined();
  });

  it('draws a skeleton while reading, and the error with 다시 시도 when the first read failed', () => {
    const pending = drawn(list([], { data: undefined, isPending: true }));
    expect(byTestId(pending, 'my-notifications-empty')).toBeUndefined();
    expect(byTestId(pending, 'my-notifications-list')).toBeUndefined();
    const failed = drawn(
      list([], { data: undefined, isLoadingError: true, error: new Error('down') }),
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(copy.errUnknown);
    expect(failed).toContain(copy.retry);
    expect(byTestId(failed, 'my-notifications-empty')).toBeUndefined();
  });

  it('lists them newest first as served, unread told apart by weight, a dot and 안 읽음 — not colour alone', () => {
    const html = drawn(
      list([
        {
          items: [
            notification(UNREAD_ID, { occurredAt: '2026-11-21T05:00:00.000Z' }),
            notification(READ_ID, {
              category: 'trade',
              target: { kind: 'market', slug: 'closed-market' },
              readAt: '2026-11-21T04:30:00.000Z',
            }),
          ],
          nextCursor: null,
        },
      ]),
    );
    // The server's order (53-3: 발생 시각 최신순), one row each.
    expect([...html.matchAll(/data-notification-id="([^"]+)"/g)].map((match) => match[1])).toEqual([
      UNREAD_ID,
      READ_ID,
    ]);
    const unread = rowOf(html, UNREAD_ID) ?? '';
    const read = rowOf(html, READ_ID) ?? '';
    expect(unread).toContain('data-read="false"');
    expect(read).toContain('data-read="true"');
    // Unread: the dot (hidden from a screen reader) and the words a screen reader reads instead.
    expect(byTestId(unread, 'notification-row-unread-dot')?.attributes['aria-hidden']).toBe('true');
    expect(unread).toContain(copy.notificationUnread);
    expect(byTestId(read, 'notification-row-unread-dot')).toBeUndefined();
    expect(read).not.toContain(copy.notificationUnread);
    // The category, the title — the fallback for a type this web does not know (53-11 ④) — and
    // the time in the member's zone (KST until the profile says otherwise).
    expect(byTestId(unread, 'notification-row-category')?.text).toBe('시장');
    expect(byTestId(unread, 'notification-row-title')?.text).toBe('시장 알림');
    expect(byTestId(read, 'notification-row-title')?.text).toBe('거래 알림');
    expect(byTestId(unread, 'notification-row-time')?.text).toBe('2026. 11. 21. 오후 2:00');
    // A link to its target, the market's detail; a read one goes there too.
    expect(byTestId(unread, 'notification-row')?.attributes.href).toBe('/markets/first-snow');
    expect(byTestId(read, 'notification-row')?.attributes.href).toBe('/markets/closed-market');
    // No raw params or ids on screen: the label is the type's renderer's to word.
    expect(byTestId(unread, 'notification-row')?.text).not.toContain('첫눈');
  });

  it('draws each 거래 알림 with its own title and leads it to the order or the history (#134)', () => {
    // ADR-0158: three rows as the API answers them (occurredAt aside); none is the fallback.
    const ORDER_ID = '7d0f9a2e-4b1c-4e8d-9a3f-1c2b3d4e5f60';
    const MARKET_ID = '3e5a7c9b-2d4f-4a6b-8c1d-0e2f4a6b8c0d';
    const FILLED_ID = '9b2c8e4a-1f3d-4c6b-8a7e-5d4c3b2a1f21';
    const CANCELLED_ID = '9b2c8e4a-1f3d-4c6b-8a7e-5d4c3b2a1f22';
    const EXPIRED_ID = '9b2c8e4a-1f3d-4c6b-8a7e-5d4c3b2a1f23';
    const html = drawn(
      list([
        {
          items: [
            notification(FILLED_ID, {
              type: 'order_filled',
              category: 'trade',
              params: {
                marketTitle: '첫눈이 올까',
                outcome: 'NO',
                side: 'buy',
                qty: '3',
                amountCoin: '120',
                fullyFilled: true,
                orderQty: '3',
                orderFilledQty: '3',
              },
              target: { kind: 'order', orderId: ORDER_ID },
              eventCount: 3,
            }),
            notification(CANCELLED_ID, {
              type: 'orders_cancelled',
              category: 'trade',
              params: {
                reason: 'paused',
                orderCount: 2,
                marketCount: 1,
                marketTitle: '첫눈이 올까',
              },
              target: { kind: 'order_history', marketId: MARKET_ID },
            }),
            notification(EXPIRED_ID, {
              type: 'orders_expired',
              category: 'trade',
              params: { marketTitle: '첫눈이 올까', cause: 'cancelled', orderCount: 1 },
              target: { kind: 'order_history', marketId: null },
              readAt: '2026-11-21T04:30:00.000Z',
            }),
          ],
          nextCursor: null,
        },
      ]),
    );
    const filled = rowOf(html, FILLED_ID) ?? '';
    const cancelled = rowOf(html, CANCELLED_ID) ?? '';
    const expired = rowOf(html, EXPIRED_ID) ?? '';
    expect(byTestId(filled, 'notification-row-category')?.text).toBe('거래');
    expect(byTestId(filled, 'notification-row-title')?.text).toBe(
      '첫눈이 올까 NO 매수 주문 전량 체결 · 체결 3회 · 누적 3계약 · 평균 40.00 Coin',
    );
    expect(byTestId(filled, 'notification-row')?.attributes.href).toBe(`/my/orders/${ORDER_ID}`);
    expect(byTestId(cancelled, 'notification-row-title')?.text).toBe(
      '첫눈이 올까 일시 중단으로 대기 주문 2건 취소',
    );
    expect(byTestId(cancelled, 'notification-row')?.attributes.href).toBe(
      `/my/history?market=${MARKET_ID}`,
    );
    expect(byTestId(expired, 'notification-row-title')?.text).toBe(
      '첫눈이 올까 시장 취소로 대기 주문 1건 만료',
    );
    expect(byTestId(expired, 'notification-row')?.attributes.href).toBe('/my/history');
    expect(expired).toContain('data-read="true"');
    // None drew the fallback title (53-11 ④).
    expect(html).not.toContain(`${copy.notificationCategoryTrade} ${copy.notificationFallback}`);
  });

  it('draws each 시장 알림 with its own title under 시장 and leads it to the market’s detail (#54)', () => {
    // ADR-0159: one row per type as the API answers them, every one targeting the market (54-4).
    const target = { kind: 'market', slug: 'first-snow' } as const;
    const rows = [
      ['market_closed', { marketTitle: '첫눈이 올까', early: false }, '첫눈이 올까 거래 마감'],
      ['market_closed', { marketTitle: '첫눈이 올까', early: true }, '첫눈이 올까 거래 조기 마감'],
      [
        'market_paused',
        { marketTitle: '첫눈이 올까', reason: 'early_result' },
        '첫눈이 올까 거래 일시 중단 · 사유: 사건 선공개(조기 결과)',
      ],
      [
        'market_resumed',
        { marketTitle: '첫눈이 올까', reason: 'basis_change' },
        '첫눈이 올까 거래 재개 · 중단 사유: 실질 기준 변경',
      ],
      ['market_cancelled', { marketTitle: '첫눈이 올까' }, '첫눈이 올까 시장 취소'],
      [
        'market_rules_supplemented',
        { marketTitle: '첫눈이 올까', ruleVersion: 3, reason: '대체 출처에 {x} $&를 더합니다.' },
        '첫눈이 올까 규칙 보충 v3 · 사유: 대체 출처에 {x} $&를 더합니다.',
      ],
    ] as const;
    const ids = rows.map((_, index) => `9b2c8e4a-1f3d-4c6b-8a7e-5d4c3b2a1f3${String(index)}`);
    const html = drawn(
      list([
        {
          items: rows.map(([type, params], index) =>
            notification(ids[index] ?? '', { type, category: 'market', params, target }),
          ),
          nextCursor: null,
        },
      ]),
    );
    rows.forEach(([type, , title], index) => {
      const drawnRow = rowOf(html, ids[index] ?? '') ?? '';
      expect(byTestId(drawnRow, 'notification-row-category')?.text, type).toBe(
        copy.notificationCategoryMarket,
      );
      expect(byTestId(drawnRow, 'notification-row-title')?.text, type).toBe(title);
      expect(byTestId(drawnRow, 'notification-row')?.attributes.href, type).toBe(
        '/markets/first-snow',
      );
    });
    // None drew the fallback title (53-11 ④).
    expect(html).not.toContain(`${copy.notificationCategoryMarket} ${copy.notificationFallback}`);
  });

  it('draws each 판정·정산 알림 with its own title under 시장 and leads it to the market’s detail (#188)', () => {
    // ADR-0160: one row per type as the API answers them, every one targeting the market (188-4)
    // — the settled one too (AC 12). Seoul's market for a Seoul member: one line each.
    const target = { kind: 'market', slug: 'first-snow' } as const;
    const deadline = '2026-09-07T06:00:00.000Z';
    const at = formatKst(deadline);
    const zone = SEOUL_TIME_ZONE;
    const rows = [
      [
        'market_judgement_delayed',
        {
          marketTitle: '첫눈이 올까',
          reason: '{x} $&',
          nextReviewAt: deadline,
          judgementTimeZone: zone,
        },
        `첫눈이 올까 판정 지연 · 다음 검토 ${at} · 사유: {x} $&`,
      ],
      [
        'market_provisional_result',
        {
          marketTitle: '첫눈이 올까',
          result: 'YES',
          disputeDeadline: deadline,
          judgementTimeZone: zone,
        },
        `첫눈이 올까 잠정 결과: YES · 이의 기한 ${at}`,
      ],
      [
        'market_judgement_corrected',
        {
          marketTitle: '첫눈이 올까',
          result: 'VOID',
          disputeDeadline: deadline,
          judgementTimeZone: null,
        },
        `첫눈이 올까 판정 정정 · 잠정 결과: 무효 · 새 이의 기한 ${at}`,
      ],
      [
        'market_dispute_decided',
        {
          marketTitle: '첫눈이 올까',
          decision: 'dismissed',
          reason: '1차 출처의 발표가 같습니다.',
        },
        '첫눈이 올까 판정 이의 기각 · 사유: 1차 출처의 발표가 같습니다.',
      ],
      [
        'market_dispute_closed_by_correction',
        { marketTitle: '첫눈이 올까', disputeDeadline: deadline, judgementTimeZone: zone },
        `첫눈이 올까 판정 이의 정정으로 종결 · 새 이의 기한 ${at}`,
      ],
      [
        'market_settled',
        { marketTitle: '첫눈이 올까', result: 'NO', payoutCoin: '0' },
        '첫눈이 올까 결과 확정: NO · 지급 완료 · 내 지급액 0 Coin',
      ],
      [
        'market_settled',
        { marketTitle: '첫눈이 올까', result: 'YES', payoutCoin: null },
        '첫눈이 올까 결과 확정: YES · 지급 완료',
      ],
    ] as const;
    const ids = rows.map((_, index) => `9b2c8e4a-1f3d-4c6b-8a7e-5d4c3b2a1f4${String(index)}`);
    const items = rows.map(([type, params], index) =>
      notification(ids[index] ?? '', { type, category: 'market', params, target }),
    );
    // Settled in Seoul, as a Seoul member's MY is once the profile is known.
    const html = renderWithQueries(
      <TimeZoneScope zone={SEOUL_TIME_ZONE} settled>
        <NotificationsBody
          notifications={list([{ items, nextCursor: null }])}
          accountId={ACCOUNT.id}
          testId="my-notifications"
        />
      </TimeZoneScope>,
    );
    rows.forEach(([type, , title], index) => {
      const drawnRow = rowOf(html, ids[index] ?? '') ?? '';
      expect(byTestId(drawnRow, 'notification-row-category')?.text, type).toBe(
        copy.notificationCategoryMarket,
      );
      expect(byTestId(drawnRow, 'notification-row-title')?.text, type).toBe(title);
      expect(byTestId(drawnRow, 'notification-row-judgement-zone'), type).toBeUndefined();
      expect(byTestId(drawnRow, 'notification-row')?.attributes.href, type).toBe(
        '/markets/first-snow',
      );
      // A 무효 result is a payout, never a refund (N03 §6).
      expect(drawnRow, type).not.toMatch(/환불|원금/);
    });
    // None drew the fallback title (53-11 ④).
    expect(html).not.toContain(`${copy.notificationCategoryMarket} ${copy.notificationFallback}`);
  });

  it('draws a timed notice’s 판정 기준 시간대 on a line under its title, only once settled in another zone (52-15, #22)', () => {
    // A Seoul member and a New York market: the sentence in Seoul, the second line in New York —
    // the detail's rule (`DateTimeText`), inside the row's title element.
    const deadline = '2026-09-07T06:00:00.000Z';
    const newYork = 'America/New_York';
    const timed = [
      [
        'market_judgement_delayed',
        {
          marketTitle: '첫눈이 올까',
          reason: '사유',
          nextReviewAt: deadline,
          judgementTimeZone: newYork,
        },
        `첫눈이 올까 판정 지연 · 다음 검토 ${formatKst(deadline)} · 사유: 사유`,
      ],
      [
        'market_provisional_result',
        {
          marketTitle: '첫눈이 올까',
          result: 'NO',
          disputeDeadline: deadline,
          judgementTimeZone: newYork,
        },
        `첫눈이 올까 잠정 결과: NO · 이의 기한 ${formatKst(deadline)}`,
      ],
      [
        'market_judgement_corrected',
        {
          marketTitle: '첫눈이 올까',
          result: 'YES',
          disputeDeadline: deadline,
          judgementTimeZone: newYork,
        },
        `첫눈이 올까 판정 정정 · 잠정 결과: YES · 새 이의 기한 ${formatKst(deadline)}`,
      ],
      [
        'market_dispute_closed_by_correction',
        { marketTitle: '첫눈이 올까', disputeDeadline: deadline, judgementTimeZone: newYork },
        `첫눈이 올까 판정 이의 정정으로 종결 · 새 이의 기한 ${formatKst(deadline)}`,
      ],
    ] as const;
    const line = `${copy.rulesJudgementZoneLine} ${formatInTimeZone(deadline, newYork)}`;
    expect(line).toMatch(/\(GMT-4\)$/);
    const drawnIn = (
      zone: string,
      settled: boolean,
      type: (typeof timed)[number][0],
      params: InboxNotification['params'],
    ) =>
      renderWithQueries(
        <TimeZoneScope zone={zone} settled={settled}>
          <NotificationsBody
            notifications={list([
              {
                items: [notification(UNREAD_ID, { type, category: 'market', params })],
                nextCursor: null,
              },
            ])}
            accountId={ACCOUNT.id}
            testId="my-notifications"
          />
        </TimeZoneScope>,
      );
    for (const [type, params, title] of timed) {
      const settled = drawnIn(SEOUL_TIME_ZONE, true, type, params);
      expect(byTestId(settled, 'notification-row-judgement-zone')?.text, type).toBe(line);
      // The title element holds both lines: the sentence first, the zone's line after it.
      expect(byTestId(settled, 'notification-row-title')?.text, type).toBe(`${title}${line}`);
      // Unsettled — the server's render, the hydrating one, the profile not yet known: one line.
      const unsettled = drawnIn(SEOUL_TIME_ZONE, false, type, params);
      expect(byTestId(unsettled, 'notification-row-judgement-zone'), type).toBeUndefined();
      expect(byTestId(unsettled, 'notification-row-title')?.text, type).toBe(title);
      // The member reads New York too: the sentence in New York, and no second line.
      const sameZone = drawnIn(newYork, true, type, params);
      expect(byTestId(sameZone, 'notification-row-judgement-zone'), type).toBeUndefined();
      expect(byTestId(sameZone, 'notification-row-title')?.text, type).toBe(
        title.replace(formatKst(deadline), formatInTimeZone(deadline, newYork)),
      );
      // No zone, or one the engine cannot read: no second line either.
      for (const judgementTimeZone of [null, '', 'Mars/Olympus_Mons']) {
        const html = drawnIn(SEOUL_TIME_ZONE, true, type, { ...params, judgementTimeZone });
        expect(byTestId(html, 'notification-row-judgement-zone'), String(judgementTimeZone)).toBe(
          undefined,
        );
        expect(byTestId(html, 'notification-row-title')?.text, type).toBe(title);
      }
    }
    // The untimed two never draw one.
    for (const [type, params] of [
      ['market_dispute_decided', { marketTitle: '첫눈', decision: 'accepted', reason: '사유' }],
      ['market_settled', { marketTitle: '첫눈', result: 'YES', payoutCoin: '200' }],
    ] as const) {
      const html = renderWithQueries(
        <TimeZoneScope zone={SEOUL_TIME_ZONE} settled>
          <NotificationsBody
            notifications={list([
              {
                items: [notification(UNREAD_ID, { type, category: 'market', params })],
                nextCursor: null,
              },
            ])}
            accountId={ACCOUNT.id}
            testId="my-notifications"
          />
        </TimeZoneScope>,
      );
      expect(byTestId(html, 'notification-row-judgement-zone'), type).toBeUndefined();
    }
  });

  it('draws each 커뮤니티 알림 with its own title under 커뮤니티 and leads it to the post, 조치·신고 내역 or 내 제안 (#135)', () => {
    // ADR-0161: one row per type as the API answers them — a reply row's name from its
    // `replyAuthor` (52-15), none when that reply is hidden or deleted (null, 135-4) — each at the
    // top of its screen (135-7). A Seoul member: the restriction's end in Seoul, one line.
    const postId = '5c1e9f3a-7b2d-4e6f-8a0c-2d4f6a8c0e1b';
    const commentId = '6d2f0a4b-8c3e-4f7a-9b1d-3e5a7b9d1f2c';
    const actionId = '8f4b2c6d-0e5a-4b9c-8d3f-5a7c9e1b3d4e';
    const proposalId = '9a5c3d7e-1f6b-4cad-9e4a-6b8dae2c4e5f';
    const reply = {
      replyId: '1b6d4e8f-2a7c-4dbe-8f5b-7c9ebf3d5f60',
      replyCreatedAt: '2026-11-21T03:00:00.000Z',
    };
    const endsAt = '2026-09-08T06:00:00.000Z';
    const member = {
      kind: 'member',
      publicId: 'k7m2p9qx4z',
      nickname: '눈사람',
      imageUrl: null,
      isAdmin: false,
    } as const;
    const postTarget = { kind: 'post', postId } as const;
    const commentTarget = { kind: 'comment', postId, commentId } as const;
    const actionTarget = { kind: 'moderation_action', actionId } as const;
    const rows: readonly (readonly [Partial<InboxNotification>, string, string])[] = [
      [
        { type: 'post_replied', params: reply, target: postTarget, replyAuthor: member },
        '내 글에 새 댓글 · 눈사람',
        `/community/posts/${postId}`,
      ],
      [
        {
          type: 'post_replied',
          params: reply,
          target: postTarget,
          eventCount: 3,
          replyAuthor: { ...member, isAdmin: true },
        },
        '내 글에 새 댓글 3개 · 마지막: 눈사람(운영자)',
        `/community/posts/${postId}`,
      ],
      [
        { type: 'comment_replied', params: reply, target: commentTarget, replyAuthor: null },
        '내 댓글에 새 답글',
        `/community/posts/${postId}`,
      ],
      [
        {
          type: 'comment_replied',
          params: reply,
          target: commentTarget,
          eventCount: 2,
          replyAuthor: { kind: 'former_member' },
        },
        '내 댓글에 새 답글 2개 · 마지막: 탈퇴한 사용자',
        `/community/posts/${postId}`,
      ],
      [
        {
          type: 'moderation_action_taken',
          params: { action: 'hide', endsAt: null },
          target: actionTarget,
        },
        '운영 조치: 숨김',
        '/my/moderation',
      ],
      [
        {
          type: 'moderation_action_taken',
          params: { action: 'writing_restriction', endsAt },
          target: actionTarget,
        },
        `운영 조치: 작성 제한 · ${formatKst(endsAt)}까지`,
        '/my/moderation',
      ],
      [
        {
          type: 'moderation_action_taken',
          params: { action: 'account_restriction', endsAt: null },
          target: actionTarget,
        },
        '운영 조치: 계정 제한 · 무기한',
        '/my/moderation',
      ],
      [
        {
          type: 'moderation_action_cancelled',
          params: { action: 'hide' },
          target: actionTarget,
        },
        '운영 조치 취소: 숨김',
        '/my/moderation',
      ],
      [
        {
          type: 'moderation_restriction_end_changed',
          params: { action: 'writing_restriction', change: 'shorten', endsAt },
          target: actionTarget,
        },
        `운영 조치 감경: 작성 제한 · ${formatKst(endsAt)}까지`,
        '/my/moderation',
      ],
      [
        {
          type: 'moderation_restriction_end_changed',
          params: { action: 'account_restriction', change: 'lift', endsAt },
          target: actionTarget,
        },
        '운영 조치 조기 해제: 계정 제한',
        '/my/moderation',
      ],
      [
        {
          type: 'proposal_decided',
          params: { decision: 'adopted', question: '첫눈이 서울에 올까?' },
          target: { kind: 'proposal', proposalId },
        },
        '시장 제안 채택 · 첫눈이 서울에 올까?',
        '/my/proposals',
      ],
    ];
    const ids = rows.map((_, index) => `9b2c8e4a-1f3d-4c6b-8a7e-5d4c3b2a1f${String(50 + index)}`);
    const items = rows.map(([fields], index) =>
      notification(ids[index] ?? '', { category: 'community', ...fields }),
    );
    const html = renderWithQueries(
      <TimeZoneScope zone={SEOUL_TIME_ZONE} settled>
        <NotificationsBody
          notifications={list([{ items, nextCursor: null }])}
          accountId={ACCOUNT.id}
          testId="my-notifications"
        />
      </TimeZoneScope>,
    );
    rows.forEach(([fields, title, href], index) => {
      const type = String(fields.type);
      const drawnRow = rowOf(html, ids[index] ?? '') ?? '';
      expect(byTestId(drawnRow, 'notification-row-category')?.text, type).toBe(
        copy.notificationCategoryCommunity,
      );
      expect(byTestId(drawnRow, 'notification-row-title')?.text, type).toBe(title);
      expect(byTestId(drawnRow, 'notification-row-judgement-zone'), type).toBeUndefined();
      expect(byTestId(drawnRow, 'notification-row')?.attributes.href, type).toBe(href);
      // Never the operator or a reporter (135-2), never the replier's account id.
      expect(drawnRow, type).not.toMatch(/신고|관리자|k7m2p9qx4z/);
    });
    expect(html).not.toContain(
      `${copy.notificationCategoryCommunity} ${copy.notificationFallback}`,
    );
  });

  it('draws a restriction’s end in the member’s settled zone, on one line (135-6)', () => {
    // A New York member: the end in New York — no 판정 기준 시간대 line, a restriction has none.
    const newYork = 'America/New_York';
    const endsAt = '2026-09-08T06:00:00.000Z';
    const at = formatInTimeZone(endsAt, newYork);
    expect(at).not.toBe(formatKst(endsAt));
    for (const [type, params, title] of [
      [
        'moderation_action_taken',
        { action: 'account_restriction', endsAt },
        `운영 조치: 계정 제한 · ${at}까지`,
      ],
      [
        'moderation_restriction_end_changed',
        { action: 'writing_restriction', change: 'shorten', endsAt },
        `운영 조치 감경: 작성 제한 · ${at}까지`,
      ],
    ] as const) {
      const html = renderWithQueries(
        <TimeZoneScope zone={newYork} settled>
          <NotificationsBody
            notifications={list([
              {
                items: [
                  notification(UNREAD_ID, {
                    type,
                    category: 'community',
                    params,
                    target: {
                      kind: 'moderation_action',
                      actionId: '8f4b2c6d-0e5a-4b9c-8d3f-5a7c9e1b3d4e',
                    },
                  }),
                ],
                nextCursor: null,
              },
            ])}
            accountId={ACCOUNT.id}
            testId="my-notifications"
          />
        </TimeZoneScope>,
      );
      expect(byTestId(html, 'notification-row-title')?.text, type).toBe(title);
      expect(byTestId(html, 'notification-row-judgement-zone'), type).toBeUndefined();
    }
  });

  it('draws a target this web cannot lead to as a button that only marks it read', () => {
    const html = drawn(
      list([
        {
          items: [notification(UNREAD_ID, { target: { kind: 'dispute', id: 'p1' } as never })],
          nextCursor: null,
        },
      ]),
    );
    const row = byTestId(html, 'notification-row');
    expect(row?.attributes.type).toBe('button');
    expect(row?.attributes).not.toHaveProperty('href');
    expect(html).toMatch(/<button[^>]*data-testid="notification-row"/);
  });

  it('offers 더 보기 while a page follows, and says a 더 보기 failed above it, keeping the rows', () => {
    const one = [{ items: [notification(UNREAD_ID)], nextCursor: 'c2' }];
    expect(byTestId(drawn(list(one)), 'my-notifications-more')?.text).toBe(copy.loadMore);
    expect(byTestId(drawn(list(one)), 'my-notifications-more-failed')).toBeUndefined();
    const failedMore = drawn(list(one, { isFetchNextPageError: true, error: new Error('x') }));
    expect(byTestId(failedMore, 'my-notifications-more-failed')?.text).toBe(copy.errUnknown);
    expect(byTestId(failedMore, 'my-notifications-more')?.text).toBe(copy.loadMore);
    expect(rowOf(failedMore, UNREAD_ID)).toBeDefined();
  });

  it('keeps the rows under a notice with 다시 시도 when a refresh failed', () => {
    const html = drawn(
      list([{ items: [notification(UNREAD_ID)], nextCursor: null }], {
        isRefetchError: true,
        error: new Error('down'),
      }),
    );
    const stale = byTestId(html, 'my-notifications-stale');
    expect(stale?.attributes.role).toBe('status');
    expect(stale?.text).toContain(copy.marketRefreshFailed);
    expect(stale?.text).toContain(copy.retry);
    expect(rowOf(html, UNREAD_ID)).toBeDefined();
    // Not when the list is empty and nothing failed.
    expect(
      byTestId(drawn(list([{ items: [], nextCursor: null }])), 'my-notifications-stale'),
    ).toBeUndefined();
  });

  it('draws MY 요약’s preview as the first three rows with no 더 보기 (53-11 ②)', () => {
    const items = Array.from({ length: 5 }, (_, n) =>
      notification(`9b2c8e4a-1f3d-4c6b-8a7e-5d4c3b2a1f1${String(n)}`),
    );
    const html = drawn(
      list([{ items, nextCursor: 'c2' }]),
      MY_PREVIEW_ROWS,
      'my-preview-notifications',
    );
    expect(
      testIdsStartingWith(html, 'notification-row').filter((id) => id === 'notification-row'),
    ).toHaveLength(MY_PREVIEW_ROWS);
    expect(byTestId(html, 'my-preview-notifications-list')).toBeDefined();
    expect(byTestId(html, 'my-preview-notifications-more')).toBeUndefined();
    expect(
      byTestId(
        drawn(list([{ items: [], nextCursor: null }]), 3, 'my-preview-notifications'),
        'my-preview-notifications-empty',
      )?.text,
    ).toBe(copy.notificationsEmpty);
  });
});

describe('모두 읽음 (53-2)', () => {
  const button = (props: Parameters<typeof NotificationsReadAll>[0]) =>
    byTestId(renderWithQueries(<NotificationsReadAll {...props} />), 'my-notifications-read-all');

  it('is off while nothing is unread, the count is not read yet or the account is not known', () => {
    const press = () => undefined;
    expect(button({ unreadCount: 0, pending: false, onPress: press })?.attributes).toHaveProperty(
      'disabled',
    );
    expect(
      button({ unreadCount: undefined, pending: false, onPress: press })?.attributes,
    ).toHaveProperty('disabled');
    expect(
      button({ unreadCount: 3, pending: false, onPress: undefined })?.attributes,
    ).toHaveProperty('disabled');
    expect(
      button({ unreadCount: 3, pending: false, onPress: press })?.attributes,
    ).not.toHaveProperty('disabled');
    // While its write is on its way it shows so, and takes no second press.
    expect(button({ unreadCount: 3, pending: true, onPress: press })?.attributes).toHaveProperty(
      'data-loading',
    );
  });
});

describe('the page and its preview', () => {
  const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

  it('is a MY tab gated on the session, and the summary previews it with 전체 보기', () => {
    expect(source('./page.tsx')).toContain('await requireMySession();');
    expect(source('./page.tsx')).toContain('<MyNotifications />');
    const summary = source('../summary.tsx');
    expect(summary).toContain('<NotificationsPreview />');
    expect(summary).toContain('testId="my-preview-notifications"');
    expect(summary).toContain('href={notificationsTab.href}');
    expect(summary).toContain('limit={MY_PREVIEW_ROWS}');
    // 준비 중 is gone from MY: every tab has its content.
    expect(summary).not.toContain('ComingSoon');
  });

  it('marks a row read on a click and a middle click, not awaited, and names MY’s account', () => {
    const row = source('../../../components/notifications/notification-row.tsx');
    expect(row).toContain('onClick={markRead}');
    expect(row).toMatch(/onAuxClick=\{\(event\) => \{\s*if \(event\.button === 1\) markRead\(\);/);
    expect(row).toContain('if (unread) onRead(notification);');
    const body = source('./my-notifications.tsx');
    expect(body).toContain('read.mutate({ id: item.id, expectedAccountId: accountId });');
    expect(body).toContain('readAll.mutate({ expectedAccountId: accountId });');
    expect(body).not.toMatch(/mutateAsync|await read/);
  });

  it('breaks a title’s Korean at spaces, a run too long for the row still wrapping (#134)', () => {
    const row = source('../../../components/notifications/notification-row.tsx');
    const title = row.slice(0, row.indexOf('data-testid="notification-row-title"'));
    expect(title.slice(title.lastIndexOf('<Text'))).toMatch(
      /wordBreak="keep-all"\s+overflowWrap="anywhere"/,
    );
  });
});
