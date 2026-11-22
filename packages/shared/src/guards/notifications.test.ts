import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  NOTIFICATION_DEFINITIONS,
  defineNotification,
  type NotificationDefinition,
} from '../notifications.js';
import {
  NOTIFICATION_IDENTITY_PARAM,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_REGISTRY,
  type NotificationTypeEntry,
  findExcludedNotification,
  findNotificationDefinitionProblems,
} from './notifications.js';

const entry = (type: string, ...text: string[]): NotificationTypeEntry => ({
  type,
  text,
  reason: 'test',
});

const features = (candidate: NotificationTypeEntry) => [
  ...new Set(findExcludedNotification(candidate).map((hit) => hit.feature)),
];

describe('NOTIFICATION_TYPES (#113, #53)', () => {
  it('registers exactly the product list: the registry is keyed by NOTIFICATION_DEFINITIONS', () => {
    // ADR-0157: the product list is the source and the registry is keyed by it, so a type
    // defined without its text, or an entry left for a removed type, fails to compile (and this).
    expect(Object.keys(NOTIFICATION_TYPE_REGISTRY).sort()).toEqual(
      NOTIFICATION_DEFINITIONS.map((definition: NotificationDefinition) => definition.type).sort(),
    );
    expect(NOTIFICATION_TYPES.map((entry) => entry.type)).toEqual(
      Object.keys(NOTIFICATION_TYPE_REGISTRY),
    );
  });

  it('registers each type once, with its text and a reason', () => {
    const types = NOTIFICATION_TYPES.map((candidate) => candidate.type);
    expect(new Set(types).size).toBe(types.length);
    for (const candidate of NOTIFICATION_TYPES) {
      expect(candidate.reason.trim(), candidate.type).not.toBe('');
      expect(candidate.text.length, candidate.type).toBeGreaterThan(0);
    }
  });

  it('registers the 거래 three of #134 and the 시장 five of #54 with single-brace placeholders only (ADR-0158, ADR-0159)', () => {
    expect(Object.keys(NOTIFICATION_TYPE_REGISTRY)).toEqual([
      'order_filled',
      'orders_cancelled',
      'orders_expired',
      'market_closed',
      'market_paused',
      'market_resumed',
      'market_cancelled',
      'market_rules_supplemented',
    ]);
    // `{{key}}` in the web's copy must be a business fact (legal.test.ts): never here.
    for (const candidate of NOTIFICATION_TYPES) {
      for (const text of candidate.text) {
        expect(text, candidate.type).not.toMatch(/\{\{|\}\}/);
        for (const [, key] of text.matchAll(/\{([^{}]*)\}/g)) {
          expect(key, `${candidate.type}: ${text}`).toMatch(/^[a-z][a-zA-Z]*$/);
        }
      }
    }
  });

  it('words the 시장 five as 54-1 answered, the pause labels as the 공개 판정 기록 shows them', () => {
    const labels = ['사건 선공개(조기 결과)', '담보·원장 장애', '실질 기준 변경'];
    expect(NOTIFICATION_TYPE_REGISTRY.market_closed.text).toEqual([
      '{market} 거래 마감',
      '{market} 거래 조기 마감',
    ]);
    expect(NOTIFICATION_TYPE_REGISTRY.market_paused.text).toEqual([
      '{market} 거래 일시 중단 · 사유: {reason}',
      ...labels,
    ]);
    expect(NOTIFICATION_TYPE_REGISTRY.market_resumed.text).toEqual([
      '{market} 거래 재개 · 중단 사유: {reason}',
      ...labels,
    ]);
    expect(NOTIFICATION_TYPE_REGISTRY.market_cancelled.text).toEqual(['{market} 시장 취소']);
    expect(NOTIFICATION_TYPE_REGISTRY.market_rules_supplemented.text).toEqual([
      '{market} 규칙 보충 {version} · 사유: {reason}',
      'v',
    ]);
    for (const type of [
      'market_closed',
      'market_paused',
      'market_resumed',
      'market_cancelled',
      'market_rules_supplemented',
    ] as const) {
      expect(NOTIFICATION_TYPE_REGISTRY[type].reason, type).toContain('ADR-0159');
      expect(findExcludedNotification({ type, ...NOTIFICATION_TYPE_REGISTRY[type] }), type).toEqual(
        [],
      );
    }
  });

  it('names no excluded feature, as a type or in its text (N05 §4)', () => {
    expect(
      NOTIFICATION_TYPES.map((candidate) => ({
        type: candidate.type,
        hits: findExcludedNotification(candidate),
      })).filter((result) => result.hits.length > 0),
    ).toEqual([]);
  });
});

describe('findExcludedNotification', () => {
  // N05 §4: the notifications the initial product leaves out, as #53 might name them.
  it.each([
    ['score_updated', '새 점수가 나왔습니다', 'scoring'],
    ['rank_changed', '순위가 올랐습니다', 'scoring'],
    ['forecast_edited', 'Forecast가 수정되었습니다', 'probability-input'],
    ['coin_low', 'Coin을 충전하고 보너스를 받으세요', 'paid-purchase'],
    ['package_discount', '오늘만 할인', 'paid-purchase'],
    ['attendance_reward', '출석 보상을 받으세요', 'activity-reward'],
  ])('finds %s: %s (%s)', (type, text, feature) => {
    expect(features(entry(type, text))).toContain(feature);
  });

  it('looks at the type name and the text alike', () => {
    expect(features(entry('rank_changed', '알림'))).toEqual(['scoring']);
    expect(features(entry('market_moved', '랭킹이 바뀌었습니다'))).toEqual(['scoring']);
  });

  it('lets a notification about the user’s own market through', () => {
    expect(
      findExcludedNotification(entry('market_resolved', '{title} 시장이 판정되었습니다.')),
    ).toEqual([]);
  });
});

/** A planted definition: a flat, private-safe one unless `change` says otherwise. */
const planted = (change: Partial<NotificationDefinition> = {}): NotificationDefinition => ({
  ...defineNotification({
    type: 'planted_notice',
    category: 'market',
    targets: ['market'],
    params: z.object({ title: z.string(), count: z.number().int(), done: z.boolean() }),
    merge: null,
  }),
  ...change,
});

describe('findNotificationDefinitionProblems (ADR-0157)', () => {
  it('finds nothing in the product list (#134’s three, #54’s five) or in a definition that keeps the rules', () => {
    expect(NOTIFICATION_DEFINITIONS.length).toBeGreaterThan(0);
    expect(findNotificationDefinitionProblems(NOTIFICATION_DEFINITIONS)).toEqual([]);
    expect(
      findNotificationDefinitionProblems([
        planted(),
        planted({
          type: 'planted_merged',
          category: 'trade',
          params: z.object({
            closedAt: z.iso.datetime().nullable(),
            state: z.enum(['partial', 'full']),
            amountCoin: z.string(),
            kind: z.literal('fill'),
          }),
          merge: (held) => held,
        }),
      ]),
    ).toEqual([]);
  });

  it('refuses a param that would store another member or their identity (52-15, ADR-0086)', () => {
    // Read through the target when the list is read, never stored: a closed member's name and a
    // forced nickname change show at once.
    for (const key of [
      'nickname',
      'authorNickname',
      'replyAuthor',
      'userId',
      'accountId',
      'counterpartyId',
      'publicId',
      'email',
      'phone',
    ]) {
      expect(NOTIFICATION_IDENTITY_PARAM.test(key), key).toBe(true);
      expect(
        findNotificationDefinitionProblems([planted({ params: z.object({ [key]: z.string() }) })]),
        key,
      ).toEqual([`planted_notice.${key}: names another account or its identity`]);
    }
    for (const key of ['title', 'amountCoin', 'closeAt', 'state', 'count']) {
      expect(NOTIFICATION_IDENTITY_PARAM.test(key), key).toBe(false);
    }
  });

  it('refuses params that are not flat, and names outside the pattern', () => {
    // The type refuses nested params at compile time already; this is the run-time net.
    const nested = z.object({
      nested: z.object({ a: z.string() }),
      list: z.array(z.string()),
      loose: z.unknown(),
      Bad_Name: z.string(),
    }) as unknown as NotificationDefinition['params'];
    expect(findNotificationDefinitionProblems([planted({ params: nested })])).toEqual([
      'planted_notice.nested: not a flat value',
      'planted_notice.list: not a flat value',
      'planted_notice.loose: not a flat value',
      'planted_notice.Bad_Name: name shape',
    ]);
    expect(
      findNotificationDefinitionProblems([
        planted({ params: z.string() as unknown as NotificationDefinition['params'] }),
      ]),
    ).toEqual(['planted_notice: params are not an object']);
  });

  it('refuses a bad type, a type listed twice, a category or target outside the lists and a merge that is no function', () => {
    expect(
      findNotificationDefinitionProblems([
        planted({ type: 'Bad-Type' }),
        planted(),
        planted(),
        planted({
          type: 'planted_other',
          category: 'price' as NotificationDefinition['category'],
          targets: ['post' as NotificationDefinition['targets'][number]],
          merge: 'sum' as unknown as NotificationDefinition['merge'],
        }),
        planted({ type: 'planted_nowhere', targets: [] }),
      ]),
    ).toEqual([
      'Bad-Type: type shape',
      'planted_notice: listed twice',
      'planted_other: category price',
      'planted_other: target kind post',
      'planted_other: merge',
      'planted_nowhere: no target kind',
    ]);
  });
});
