import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_DEFINITIONS,
  NOTIFICATION_EVENT_KEY_PATTERN,
  NOTIFICATION_PARAM_STRING_MAX,
  NOTIFICATION_TARGET_KINDS,
  NOTIFICATION_TYPE_PATTERN,
  NOTIFICATION_UNREAD_COUNT_CAP,
  defineNotification,
  notificationCategorySchema,
  notificationParamsSchema,
  notificationReadResultSchema,
  notificationSchema,
  notificationTargetSchema,
  notificationUnreadCountSchema,
  type Notification,
} from './notifications.js';

const notification: Notification = {
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  type: 'market_closed',
  category: 'market',
  params: { title: '시장 제목', closeAt: '2026-11-21T03:00:00.000Z', amountCoin: '120' },
  target: { kind: 'market', slug: 'korea-rate-cut-2026' },
  eventCount: 1,
  occurredAt: '2026-11-21T03:00:00.000Z',
  readAt: null,
};

describe('notification categories (N05 §4, 52-21)', () => {
  it('are the three settings units, exactly', () => {
    expect(NOTIFICATION_CATEGORIES).toEqual(['trade', 'market', 'community']);
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(notificationCategorySchema.parse(category)).toBe(category);
    }
    // N05 §4's 가격 변동 (#146) is post-MVP: a fourth category comes with its own migration.
    expect(notificationCategorySchema.safeParse('price').success).toBe(false);
  });
});

describe('the database shapes (migration 0078)', () => {
  it('holds a type to lower-case words of 2 to 48 characters', () => {
    for (const type of ['ab', 'order_filled', 'market_closed', `a${'b'.repeat(47)}`]) {
      expect(NOTIFICATION_TYPE_PATTERN.test(type), type).toBe(true);
    }
    for (const type of ['a', 'Order', '1st', 'order-filled', `a${'b'.repeat(48)}`, '']) {
      expect(NOTIFICATION_TYPE_PATTERN.test(type), type).toBe(false);
    }
  });

  it('holds an event key and a merge key to ids and colons, up to 128 characters', () => {
    for (const key of ['1', '3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'market:abc:closed', 'A_b']) {
      expect(NOTIFICATION_EVENT_KEY_PATTERN.test(key), key).toBe(true);
    }
    for (const key of ['', 'a b', 'a/b', 'ㄱ', 'x'.repeat(129)]) {
      expect(NOTIFICATION_EVENT_KEY_PATTERN.test(key), key).toBe(false);
    }
  });
});

describe('notification targets', () => {
  it('lead to a market by its slug, in every status: the target carries none', () => {
    expect(notificationTargetSchema.parse({ kind: 'market', slug: 'korea-rate-cut-2026' })).toEqual(
      { kind: 'market', slug: 'korea-rate-cut-2026' },
    );
    // A Korean slug is NFC-normalised, as the market's own.
    const decomposed = '기준금리'.normalize('NFD');
    expect(notificationTargetSchema.parse({ kind: 'market', slug: decomposed })).toEqual({
      kind: 'market',
      slug: '기준금리',
    });
    // A status or a URL beside it is not kept: the web maps the kind to its own path.
    expect(
      notificationTargetSchema.parse({
        kind: 'market',
        slug: 'abc',
        status: 'settled',
        url: 'https://elsewhere.example',
      }),
    ).toEqual({ kind: 'market', slug: 'abc' });
  });

  it('refuses an unknown kind, a bad slug and a missing one', () => {
    for (const target of [
      { kind: 'order', id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
      { kind: 'url', href: 'https://elsewhere.example' },
      { kind: 'market', slug: 'Not A Slug' },
      { kind: 'market', slug: 'ab' },
      { kind: 'market', slug: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
      { kind: 'market' },
      { slug: 'abc' },
      'market',
    ]) {
      expect(notificationTargetSchema.safeParse(target).success, JSON.stringify(target)).toBe(
        false,
      );
    }
  });

  it('lists every kind of the union, in its order', () => {
    expect(notificationTargetSchema.options.map((option) => option.shape.kind.value)).toEqual([
      ...NOTIFICATION_TARGET_KINDS,
    ]);
  });
});

describe('notification parameters', () => {
  it('take flat values only: a string, a number, a boolean or null', () => {
    const params = { title: '제목', count: 3, filled: true, closedAt: null, ratio: 0.5 };
    expect(notificationParamsSchema.parse(params)).toEqual(params);
    expect(notificationParamsSchema.parse({})).toEqual({});
    for (const value of [{ nested: 1 }, [1, 2], undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(notificationParamsSchema.safeParse({ value }).success, JSON.stringify(value)).toBe(
        false,
      );
    }
    expect(
      notificationParamsSchema.safeParse({ text: 'x'.repeat(NOTIFICATION_PARAM_STRING_MAX) })
        .success,
    ).toBe(true);
    expect(
      notificationParamsSchema.safeParse({ text: 'x'.repeat(NOTIFICATION_PARAM_STRING_MAX + 1) })
        .success,
    ).toBe(false);
  });

  it('take camelCase names only', () => {
    for (const key of ['title', 'amountCoin', 'a', `a${'b'.repeat(39)}`]) {
      expect(notificationParamsSchema.safeParse({ [key]: 1 }).success, key).toBe(true);
    }
    for (const key of ['Title', 'amount_coin', '1st', 'a-b', '', `a${'b'.repeat(40)}`]) {
      expect(notificationParamsSchema.safeParse({ [key]: 1 }).success, key).toBe(false);
    }
  });
});

describe('notification DTOs', () => {
  it('answer a notification with its type as a pattern, so the web can fall back on one it does not know', () => {
    expect(notificationSchema.parse(notification)).toEqual(notification);
    const read = { ...notification, eventCount: 3, readAt: '2026-11-21T04:00:00.000Z' };
    expect(notificationSchema.parse(read)).toEqual(read);
    // A type the list does not hold yet still parses (53-11 ④); one of a bad shape does not.
    expect(notificationSchema.parse({ ...notification, type: 'future_type' }).type).toBe(
      'future_type',
    );
    for (const bad of [
      { type: 'Bad-Type' },
      { category: 'price' },
      { eventCount: 0 },
      { eventCount: 1.5 },
      { occurredAt: '2026-11-21 03:00' },
      { readAt: undefined },
      { id: 'not-a-uuid' },
      { target: { kind: 'order', id: '1' } },
      { params: { nested: { a: 1 } } },
    ]) {
      expect(
        notificationSchema.safeParse({ ...notification, ...bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it('counts unread up to the cap, the cap meaning that many or more', () => {
    expect(NOTIFICATION_UNREAD_COUNT_CAP).toBe(100);
    for (const unreadCount of [0, 1, 99, NOTIFICATION_UNREAD_COUNT_CAP]) {
      expect(notificationUnreadCountSchema.parse({ unreadCount })).toEqual({ unreadCount });
    }
    for (const unreadCount of [-1, 1.5, NOTIFICATION_UNREAD_COUNT_CAP + 1, '3']) {
      expect(notificationUnreadCountSchema.safeParse({ unreadCount }).success).toBe(false);
    }
    expect(notificationReadResultSchema.parse({ notification, unreadCount: 4 })).toEqual({
      notification,
      unreadCount: 4,
    });
    expect(notificationReadResultSchema.safeParse({ notification, unreadCount: 101 }).success).toBe(
      false,
    );
  });
});

describe('NOTIFICATION_DEFINITIONS (#53, 52-20)', () => {
  it('holds no type yet: #53 ships the inbox, the producers their types', () => {
    // Pinned empty. Each producer edits this pin as it appends its own: #134 (거래), #54 (시장
    // 상태), #188 (판정·정산), #135 (커뮤니티, 52-19's 제안), #144 (정정·보상). 시작 Coin, a
    // re-grant's result, a review's rejection and a market's opening are no notification (52-20).
    expect(NOTIFICATION_DEFINITIONS).toEqual([]);
  });

  it('types a definition by its own params, its merge included', () => {
    const merged = defineNotification({
      type: 'test_merged',
      category: 'trade',
      targets: ['market'],
      params: z.object({ label: z.string(), total: z.number().int() }),
      merge: (held, next) => ({ label: next.label, total: held.total + next.total }),
    });
    expect(merged.merge?.({ label: 'a', total: 1 }, { label: 'b', total: 2 })).toEqual({
      label: 'b',
      total: 3,
    });
    expect(merged.params.parse({ label: 'x', total: 2 })).toEqual({ label: 'x', total: 2 });
  });
});
