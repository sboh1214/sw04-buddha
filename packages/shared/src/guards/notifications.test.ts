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

  it('registers the 거래 three of #134, the 시장 five of #54, the 판정·정산 six of #188 and the 커뮤니티 six of #135 with single-brace placeholders only (ADR-0158~ADR-0161)', () => {
    expect(Object.keys(NOTIFICATION_TYPE_REGISTRY)).toEqual([
      'order_filled',
      'orders_cancelled',
      'orders_expired',
      'market_closed',
      'market_paused',
      'market_resumed',
      'market_cancelled',
      'market_rules_supplemented',
      'market_judgement_delayed',
      'market_provisional_result',
      'market_judgement_corrected',
      'market_dispute_decided',
      'market_dispute_closed_by_correction',
      'market_settled',
      'post_replied',
      'comment_replied',
      'moderation_action_taken',
      'moderation_action_cancelled',
      'moderation_restriction_end_changed',
      'proposal_decided',
    ]);
    expect(Object.keys(NOTIFICATION_TYPE_REGISTRY)).toHaveLength(20);
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

  it('words the 판정·정산 six as 188-1 answered: results and decisions as the detail and MY 판정 이의 show them', () => {
    const results = ['YES', 'NO', '무효'];
    const zoneLine = '판정 기준 시간대';
    expect(NOTIFICATION_TYPE_REGISTRY.market_judgement_delayed.text).toEqual([
      '{market} 판정 지연 · 다음 검토 {nextReview} · 사유: {reason}',
      zoneLine,
    ]);
    expect(NOTIFICATION_TYPE_REGISTRY.market_provisional_result.text).toEqual([
      '{market} 잠정 결과: {result} · 이의 기한 {deadline}',
      ...results,
      zoneLine,
    ]);
    expect(NOTIFICATION_TYPE_REGISTRY.market_judgement_corrected.text).toEqual([
      '{market} 판정 정정 · 잠정 결과: {result} · 새 이의 기한 {deadline}',
      ...results,
      zoneLine,
    ]);
    expect(NOTIFICATION_TYPE_REGISTRY.market_dispute_decided.text).toEqual([
      '{market} 판정 이의 {decision} · 사유: {reason}',
      '기각',
      '수용',
    ]);
    expect(NOTIFICATION_TYPE_REGISTRY.market_dispute_closed_by_correction.text).toEqual([
      '{market} 판정 이의 정정으로 종결 · 새 이의 기한 {deadline}',
      zoneLine,
    ]);
    // 52-12 '확정 결과와 지급 완료를 나눠 적는다'; no time in it (188-1); a watcher's has no payout.
    expect(NOTIFICATION_TYPE_REGISTRY.market_settled.text).toEqual([
      '{market} 결과 확정: {result} · 지급 완료 · 내 지급액 {payout}',
      '{market} 결과 확정: {result} · 지급 완료',
      ...results,
    ]);
    for (const type of [
      'market_judgement_delayed',
      'market_provisional_result',
      'market_judgement_corrected',
      'market_dispute_decided',
      'market_dispute_closed_by_correction',
      'market_settled',
    ] as const) {
      const { text, reason } = NOTIFICATION_TYPE_REGISTRY[type];
      expect(reason, type).toContain('ADR-0160');
      expect(findExcludedNotification({ type, text, reason }), type).toEqual([]);
      for (const sentence of text) {
        // A VOID payout is a 지급, never a refund (N03 §6); no P&L, score or rank (52-15, N04).
        expect(sentence, type).not.toMatch(
          /환불|원금|손익|순위|랭킹|실력|점수|스코어|수익률|승률|적중|정답|맞힌|배지|정산 기준/,
        );
        // No amount, count or time is written into the copy: each is a placeholder.
        expect(sentence, type).not.toMatch(/[0-9]/);
      }
    }
  });

  it('words the 커뮤니티 six as 135-5 answered: the action words as MY 조치·신고 내역 shows them', () => {
    const replyWords = (subject: string) => [
      `${subject} · {author}`,
      `${subject} {count}개 · 마지막: {author}`,
      subject,
      `${subject} {count}개`,
      '{nickname}(운영자)',
      '탈퇴한 사용자',
    ];
    const actions = [
      '숨김',
      '경고',
      '닉네임 강제 변경',
      '소개 비우기',
      '프로필 이미지 삭제',
      '작성 제한',
      '계정 제한',
    ];
    expect(NOTIFICATION_TYPE_REGISTRY.post_replied.text).toEqual(replyWords('내 글에 새 댓글'));
    expect(NOTIFICATION_TYPE_REGISTRY.comment_replied.text).toEqual(
      replyWords('내 댓글에 새 답글'),
    );
    expect(NOTIFICATION_TYPE_REGISTRY.moderation_action_taken.text).toEqual([
      '운영 조치: {action}',
      '운영 조치: {action} · {term}',
      ...actions,
      '까지',
      '무기한',
    ]);
    expect(NOTIFICATION_TYPE_REGISTRY.moderation_action_cancelled.text).toEqual([
      '운영 조치 취소: {action}',
      ...actions,
    ]);
    // A 감경's new end is always an instant (never 무기한); a 조기 해제 carries no time (135-5 (f)).
    expect(NOTIFICATION_TYPE_REGISTRY.moderation_restriction_end_changed.text).toEqual([
      '운영 조치 감경: {action} · {term}',
      '운영 조치 조기 해제: {action}',
      '작성 제한',
      '계정 제한',
      '까지',
    ]);
    expect(NOTIFICATION_TYPE_REGISTRY.proposal_decided.text).toEqual([
      '시장 제안 {decision} · {question}',
      '채택',
      '반려',
    ]);
    // The renderer copy counts the web pins (lib/notifications.test.ts): 6·6·11·8·5·3.
    expect(
      (
        [
          'post_replied',
          'comment_replied',
          'moderation_action_taken',
          'moderation_action_cancelled',
          'moderation_restriction_end_changed',
          'proposal_decided',
        ] as const
      ).map((type) => NOTIFICATION_TYPE_REGISTRY[type].text.length),
    ).toEqual([6, 6, 11, 8, 5, 3]);
    for (const type of [
      'post_replied',
      'comment_replied',
      'moderation_action_taken',
      'moderation_action_cancelled',
      'moderation_restriction_end_changed',
      'proposal_decided',
    ] as const) {
      const { text, reason } = NOTIFICATION_TYPE_REGISTRY[type];
      expect(reason, type).toContain('ADR-0161');
      expect(reason, type).toContain('135-5');
      expect(findExcludedNotification({ type, text, reason }), type).toEqual([]);
      for (const sentence of text) {
        // A count is a count, never a score or a skill (#135 AC 5, N05 §2); no reward near a
        // reply (the activity-reward pattern); never a reason, an operator or a reporter (135-2).
        expect(sentence, type).not.toMatch(
          /점수|순위|랭킹|실력|평판|등급|배지|스코어|보상|보너스|지급|사유|신고|처리자|좋아요/,
        );
        // No count, time or name is written into the copy: each is a placeholder.
        expect(sentence, type).not.toMatch(/[0-9]/);
      }
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
  it('finds nothing in the product list (#134’s three, #54’s five, #188’s six, #135’s six) or in a definition that keeps the rules', () => {
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
    // Read by the API through the id the type keeps (`replyId`, ADR-0161) when the list is read,
    // never stored: a closed member's name and a forced nickname change show at once.
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
    // #135's names pass; an author's id or an account restriction as a NAME would not (values
    // such as `account_restriction` are fine).
    for (const key of ['replyId', 'replyCreatedAt', 'action', 'endsAt', 'change', 'decision']) {
      expect(NOTIFICATION_IDENTITY_PARAM.test(key), key).toBe(false);
    }
    for (const key of ['replyAuthorId', 'accountRestriction', 'userAction']) {
      expect(NOTIFICATION_IDENTITY_PARAM.test(key), key).toBe(true);
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
          targets: ['dispute' as NotificationDefinition['targets'][number]],
          merge: 'sum' as unknown as NotificationDefinition['merge'],
        }),
        planted({ type: 'planted_nowhere', targets: [] }),
      ]),
    ).toEqual([
      'Bad-Type: type shape',
      'planted_notice: listed twice',
      'planted_other: category price',
      'planted_other: target kind dispute',
      'planted_other: merge',
      'planted_nowhere: no target kind',
    ]);
  });
});
