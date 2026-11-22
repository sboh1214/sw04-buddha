import {
  MARKET_PAUSE_REASONS,
  MARKET_RULES_SUPPLEMENTED_NOTIFICATION,
  type MarketPauseReason,
  NOTIFICATION_PARAM_STRING_MAX,
  NOTIFICATION_TYPE_REGISTRY,
  findExcludedText,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { NOTIFICATION_RENDERERS } from '@/components/notifications/notification-renderers';
import { copy } from '@/copy';
import {
  marketCancelledTitle,
  marketClosedTitle,
  marketPausedTitle,
  marketResumedTitle,
  marketRulesSupplementedTitle,
} from './market-notifications';
import { notificationTextKeys } from './trade-notifications';

const TITLE = '첫눈이 올까';

/** The five types of #54 (ADR-0159), in NOTIFICATION_DEFINITIONS' order. */
const MARKET_TYPES = [
  'market_closed',
  'market_paused',
  'market_resumed',
  'market_cancelled',
  'market_rules_supplemented',
] as const;

/** Each pause reason's label as the 공개 판정 기록 shows it (52-9). */
const LABELS: Readonly<Record<MarketPauseReason, string>> = {
  early_result: '사건 선공개(조기 결과)',
  ledger_failure: '담보·원장 장애',
  basis_change: '실질 기준 변경',
};

/**
 * 시장 상태 알림's words (#54, ADR-0159; owner answers 54-1 — the six sentences approved as shown
 * —, 54-2 the resume's reason, 54-3 the supplement's reason in the title): each type's title from
 * the params its definition stores, filled into copy.ts' templates.
 */
describe('the six sentences (54-1)', () => {
  it('are the owner’s, word for word', () => {
    expect([
      copy.notificationMarketClosed,
      copy.notificationMarketClosedEarly,
      copy.notificationMarketPaused,
      copy.notificationMarketResumed,
      copy.notificationMarketCancelled,
      copy.notificationMarketRulesSupplemented,
    ]).toEqual([
      '{market} 거래 마감',
      '{market} 거래 조기 마감',
      '{market} 거래 일시 중단 · 사유: {reason}',
      '{market} 거래 재개 · 중단 사유: {reason}',
      '{market} 시장 취소',
      '{market} 규칙 보충 {version} · 사유: {reason}',
    ]);
  });

  it('say the owner’s examples', () => {
    expect(marketClosedTitle({ marketTitle: TITLE, early: false })).toBe('첫눈이 올까 거래 마감');
    expect(marketClosedTitle({ marketTitle: TITLE, early: true })).toBe(
      '첫눈이 올까 거래 조기 마감',
    );
    expect(marketPausedTitle({ marketTitle: TITLE, reason: 'early_result' })).toBe(
      '첫눈이 올까 거래 일시 중단 · 사유: 사건 선공개(조기 결과)',
    );
    expect(marketResumedTitle({ marketTitle: TITLE, reason: 'basis_change' })).toBe(
      '첫눈이 올까 거래 재개 · 중단 사유: 실질 기준 변경',
    );
    expect(marketCancelledTitle({ marketTitle: TITLE })).toBe('첫눈이 올까 시장 취소');
    expect(
      marketRulesSupplementedTitle({
        marketTitle: TITLE,
        ruleVersion: 3,
        reason: '대체 출처에 기상청 발표를 더합니다.',
      }),
    ).toBe('첫눈이 올까 규칙 보충 v3 · 사유: 대체 출처에 기상청 발표를 더합니다.');
  });
});

describe('market_paused and market_resumed (52-9, 54-2, 54-5)', () => {
  it('name each of the three reasons by the 공개 판정 기록’s label', () => {
    expect(MARKET_PAUSE_REASONS).toEqual(Object.keys(LABELS));
    for (const reason of MARKET_PAUSE_REASONS) {
      expect(marketPausedTitle({ marketTitle: TITLE, reason }), reason).toBe(
        `첫눈이 올까 거래 일시 중단 · 사유: ${LABELS[reason]}`,
      );
      // The resume carries the ended pause's reason (54-2).
      expect(marketResumedTitle({ marketTitle: TITLE, reason }), reason).toBe(
        `첫눈이 올까 거래 재개 · 중단 사유: ${LABELS[reason]}`,
      );
    }
    // The labels are copy's — the pause dialog's, the queue's and the record's words.
    expect(LABELS).toEqual({
      early_result: copy.pauseReasonEarlyResult,
      ledger_failure: copy.pauseReasonLedgerFailure,
      basis_change: copy.pauseReasonBasisChange,
    });
  });
});

describe('market_rules_supplemented (52-10, 54-3)', () => {
  it('names the version as the version history does', () => {
    for (const [version, name] of [
      [2, 'v2'],
      [3, 'v3'],
      [12, 'v12'],
    ] as const) {
      expect(
        marketRulesSupplementedTitle({ marketTitle: TITLE, ruleVersion: version, reason: '사유' }),
      ).toBe(`첫눈이 올까 규칙 보충 ${name} · 사유: 사유`);
    }
  });

  it('writes a free-text reason as stored, braces and dollar signs included', () => {
    for (const reason of ['{x}', '{market} {reason} {version}', '$&', "$1 $$ $` $'", '{{x}}']) {
      expect(
        marketRulesSupplementedTitle({ marketTitle: TITLE, ruleVersion: 3, reason }),
        reason,
      ).toBe(`첫눈이 올까 규칙 보충 v3 · 사유: ${reason}`);
    }
  });

  it('writes a reason at the cap whole, as its definition takes it', () => {
    const reason = '가'.repeat(NOTIFICATION_PARAM_STRING_MAX);
    expect(reason).toHaveLength(500);
    const params = MARKET_RULES_SUPPLEMENTED_NOTIFICATION.params.parse({
      marketTitle: TITLE,
      ruleVersion: 3,
      reason,
    });
    expect(marketRulesSupplementedTitle(params)).toBe(`첫눈이 올까 규칙 보충 v3 · 사유: ${reason}`);
    // One unit past it is no notice the definition stores.
    expect(
      MARKET_RULES_SUPPLEMENTED_NOTIFICATION.params.safeParse({
        marketTitle: TITLE,
        ruleVersion: 3,
        reason: `${reason}가`,
      }).success,
    ).toBe(false);
  });
});

describe('the market title', () => {
  it('is written as stored in every title, braces, dollar signs and astral letters included', () => {
    const marketTitle = '{market} $& 𝕏';
    expect(marketClosedTitle({ marketTitle, early: false })).toBe('{market} $& 𝕏 거래 마감');
    expect(marketClosedTitle({ marketTitle, early: true })).toBe('{market} $& 𝕏 거래 조기 마감');
    expect(marketPausedTitle({ marketTitle, reason: 'ledger_failure' })).toBe(
      '{market} $& 𝕏 거래 일시 중단 · 사유: 담보·원장 장애',
    );
    expect(marketResumedTitle({ marketTitle, reason: 'ledger_failure' })).toBe(
      '{market} $& 𝕏 거래 재개 · 중단 사유: 담보·원장 장애',
    );
    expect(marketCancelledTitle({ marketTitle })).toBe('{market} $& 𝕏 시장 취소');
    expect(marketRulesSupplementedTitle({ marketTitle, ruleVersion: 2, reason: '$&' })).toBe(
      '{market} $& 𝕏 규칙 보충 v2 · 사유: $&',
    );
  });
});

describe('the templates (ADR-0158 구현의 선택: single-brace placeholders)', () => {
  it('has each template’s placeholders equal to the keys its title passes', () => {
    const expected: readonly (readonly [string, string[]])[] = [
      [copy.notificationMarketClosed, ['market']],
      [copy.notificationMarketClosedEarly, ['market']],
      [copy.notificationMarketPaused, ['market', 'reason']],
      [copy.notificationMarketResumed, ['market', 'reason']],
      [copy.notificationMarketCancelled, ['market']],
      [copy.notificationMarketRulesSupplemented, ['market', 'version', 'reason']],
    ];
    for (const [template, keys] of expected) {
      expect(notificationTextKeys(template).sort(), template).toEqual([...keys].sort());
      // Never the legal pages' {{key}} (legal.test.ts holds those to business facts).
      expect(template, template).not.toContain('{{');
    }
    // Every title above filled its template through fillNotificationText, which throws on a
    // missing or an unknown key — so each passes exactly these.
  });

  it('are the renderers’ copy and the guard registry’s text, word for word (54-1)', () => {
    expect(NOTIFICATION_RENDERERS.market_closed.copy).toEqual([
      copy.notificationMarketClosed,
      copy.notificationMarketClosedEarly,
    ]);
    for (const type of ['market_paused', 'market_resumed'] as const) {
      expect(NOTIFICATION_RENDERERS[type].copy.slice(1), type).toEqual(Object.values(LABELS));
    }
    expect(NOTIFICATION_RENDERERS.market_paused.copy[0]).toBe(copy.notificationMarketPaused);
    expect(NOTIFICATION_RENDERERS.market_resumed.copy[0]).toBe(copy.notificationMarketResumed);
    expect(NOTIFICATION_RENDERERS.market_cancelled.copy).toEqual([
      copy.notificationMarketCancelled,
    ]);
    // 'v' is the word that fills {version} ('v3').
    expect(NOTIFICATION_RENDERERS.market_rules_supplemented.copy).toEqual([
      copy.notificationMarketRulesSupplemented,
      'v',
    ]);
    for (const type of MARKET_TYPES) {
      expect(NOTIFICATION_RENDERERS[type].copy, type).toEqual(
        NOTIFICATION_TYPE_REGISTRY[type].text,
      );
      for (const text of NOTIFICATION_RENDERERS[type].copy) {
        expect(findExcludedText(text), text).toEqual([]);
        expect(text, text).not.toMatch(/배지|badge/i);
      }
    }
  });
});
