import {
  MARKET_DISPUTE_DECIDED_NOTIFICATION,
  MARKET_JUDGEMENT_DELAYED_NOTIFICATION,
  MARKET_RESULTS,
  MARKET_SETTLED_NOTIFICATION,
  type MarketResult,
  NOTIFICATION_PARAM_STRING_MAX,
  NOTIFICATION_TYPE_REGISTRY,
  NOTIFIED_DISPUTE_DECISIONS,
  type NotifiedDisputeDecision,
  findExcludedText,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { NOTIFICATION_RENDERERS } from '@/components/notifications/notification-renderers';
import { copy } from '@/copy';
import { formatKst } from './datetime';
import {
  disputeClosedByCorrectionTitle,
  disputeDecidedTitle,
  judgementCorrectedTitle,
  judgementDelayedTitle,
  judgementCompensatedTitle,
  marketSettledTitle,
  provisionalResultTitle,
} from './judgement-notifications';
import { notificationTextKeys } from './trade-notifications';

const TITLE = '첫눈이 올까';
const ZONE = 'Asia/Seoul';

/** 2026-09-07 15:00 and 2026-09-08 15:00 in Seoul, the owner's examples' times (188-1). */
const DEADLINE = '2026-09-07T06:00:00.000Z';
const NEXT_DAY = '2026-09-08T06:00:00.000Z';

/** A `format` that shows what it was handed: the title holds the caller's formatting, not its own. */
const marked = (iso: string) => `<${iso}>`;

/** The six types of #188 (ADR-0160), in NOTIFICATION_DEFINITIONS' order. */
const JUDGEMENT_TYPES = [
  'market_judgement_delayed',
  'market_provisional_result',
  'market_judgement_corrected',
  'market_dispute_decided',
  'market_dispute_closed_by_correction',
  'market_settled',
] as const;

/** Each result's label as the detail's result row shows it. */
const RESULT_LABELS: Readonly<Record<MarketResult, string>> = {
  YES: 'YES',
  NO: 'NO',
  VOID: '무효',
};

/** Each told decision's label as MY 판정 이의 shows it (52-14). */
const DECISION_LABELS: Readonly<Record<NotifiedDisputeDecision, string>> = {
  dismissed: '기각',
  accepted: '수용',
};

/** Free text as a member or an operator may write it: placeholders and replacement patterns. */
const FREE_TEXTS = ['{x}', '{market} {reason} {nextReview}', '$&', "$1 $$ $` $'", '{{x}}'];

/**
 * 판정·정산 알림's words (#188, ADR-0160; owner answers 188-1 — the eight sentences and five
 * readings approved as shown —, 188-3 the decision's reason in the title, 52-15 the contents):
 * each type's title from the params its definition stores, filled into copy.ts' templates.
 */
describe('the eight sentences (188-1)', () => {
  it('are the owner’s, word for word', () => {
    expect([
      copy.notificationJudgementDelayed,
      copy.notificationProvisionalResult,
      copy.notificationJudgementCorrected,
      copy.notificationDisputeDecided,
      copy.notificationDisputeClosedByCorrection,
      copy.notificationMarketSettled,
      copy.notificationMarketSettledWatcher,
    ]).toEqual([
      '{market} 판정 지연 · 다음 검토 {nextReview} · 사유: {reason}',
      '{market} 잠정 결과: {result} · 이의 기한 {deadline}',
      '{market} 판정 정정 · 잠정 결과: {result} · 새 이의 기한 {deadline}',
      '{market} 판정 이의 {decision} · 사유: {reason}',
      '{market} 판정 이의 정정으로 종결 · 새 이의 기한 {deadline}',
      '{market} 결과 확정: {result} · 지급 완료 · 내 지급액 {payout}',
      '{market} 결과 확정: {result} · 지급 완료',
    ]);
  });

  it('say the owner’s examples', () => {
    expect(
      judgementDelayedTitle(
        {
          marketTitle: TITLE,
          reason: '기상청 발표가 늦어지고 있습니다.',
          nextReviewAt: NEXT_DAY,
          judgementTimeZone: ZONE,
        },
        formatKst,
      ),
    ).toBe(
      '첫눈이 올까 판정 지연 · 다음 검토 2026. 9. 8. 오후 3:00 · 사유: 기상청 발표가 늦어지고 있습니다.',
    );
    expect(
      provisionalResultTitle(
        { marketTitle: TITLE, result: 'YES', disputeDeadline: DEADLINE, judgementTimeZone: ZONE },
        formatKst,
      ),
    ).toBe('첫눈이 올까 잠정 결과: YES · 이의 기한 2026. 9. 7. 오후 3:00');
    expect(
      judgementCorrectedTitle(
        { marketTitle: TITLE, result: 'NO', disputeDeadline: NEXT_DAY, judgementTimeZone: ZONE },
        formatKst,
      ),
    ).toBe('첫눈이 올까 판정 정정 · 잠정 결과: NO · 새 이의 기한 2026. 9. 8. 오후 3:00');
    expect(
      disputeDecidedTitle({
        marketTitle: TITLE,
        decision: 'dismissed',
        reason: '1차 출처의 발표가 잠정 결과와 같습니다.',
      }),
    ).toBe('첫눈이 올까 판정 이의 기각 · 사유: 1차 출처의 발표가 잠정 결과와 같습니다.');
    expect(
      disputeDecidedTitle({
        marketTitle: TITLE,
        decision: 'accepted',
        reason: '1차 출처가 발표를 정정했습니다.',
      }),
    ).toBe('첫눈이 올까 판정 이의 수용 · 사유: 1차 출처가 발표를 정정했습니다.');
    expect(
      disputeClosedByCorrectionTitle(
        { marketTitle: TITLE, disputeDeadline: NEXT_DAY, judgementTimeZone: ZONE },
        formatKst,
      ),
    ).toBe('첫눈이 올까 판정 이의 정정으로 종결 · 새 이의 기한 2026. 9. 8. 오후 3:00');
    expect(marketSettledTitle({ marketTitle: TITLE, result: 'VOID', payoutCoin: '100' })).toBe(
      '첫눈이 올까 결과 확정: 무효 · 지급 완료 · 내 지급액 100 Coin',
    );
    expect(marketSettledTitle({ marketTitle: TITLE, result: 'YES', payoutCoin: null })).toBe(
      '첫눈이 올까 결과 확정: YES · 지급 완료',
    );
  });

  it('write each time as the caller formats it — the member’s zone, never the market’s', () => {
    // The renderer hands `useFormatDateTime()`'s (the member's zone, ADR-0093 #22); the market's
    // 판정 기준 시간대 is the second line's, never the sentence's.
    const zone = 'America/New_York';
    expect(
      judgementDelayedTitle(
        { marketTitle: TITLE, reason: '사유', nextReviewAt: NEXT_DAY, judgementTimeZone: zone },
        marked,
      ),
    ).toBe(`첫눈이 올까 판정 지연 · 다음 검토 <${NEXT_DAY}> · 사유: 사유`);
    expect(
      provisionalResultTitle(
        { marketTitle: TITLE, result: 'NO', disputeDeadline: DEADLINE, judgementTimeZone: zone },
        marked,
      ),
    ).toBe(`첫눈이 올까 잠정 결과: NO · 이의 기한 <${DEADLINE}>`);
    expect(
      judgementCorrectedTitle(
        { marketTitle: TITLE, result: 'YES', disputeDeadline: DEADLINE, judgementTimeZone: null },
        marked,
      ),
    ).toBe(`첫눈이 올까 판정 정정 · 잠정 결과: YES · 새 이의 기한 <${DEADLINE}>`);
    expect(
      disputeClosedByCorrectionTitle(
        { marketTitle: TITLE, disputeDeadline: DEADLINE, judgementTimeZone: zone },
        marked,
      ),
    ).toBe(`첫눈이 올까 판정 이의 정정으로 종결 · 새 이의 기한 <${DEADLINE}>`);
    // The 최종 정산 has no time in its title: the row's 발생 시각 is the payout's (188-1).
    expect(copy.notificationMarketSettled).not.toMatch(/\{(deadline|nextReview|at)\}/);
    expect(copy.notificationMarketSettledWatcher).not.toMatch(/\{(deadline|nextReview|at)\}/);
  });
});

describe('the result and the decision', () => {
  it('name each result as the detail’s result row does — 무효 for VOID, never a refund', () => {
    expect(MARKET_RESULTS).toEqual(Object.keys(RESULT_LABELS));
    expect(RESULT_LABELS).toEqual({ YES: copy.yes, NO: copy.no, VOID: copy.marketResultVoid });
    for (const result of MARKET_RESULTS) {
      const label = RESULT_LABELS[result];
      const params = {
        marketTitle: TITLE,
        result,
        disputeDeadline: DEADLINE,
        judgementTimeZone: ZONE,
      };
      expect(provisionalResultTitle(params, marked), result).toBe(
        `첫눈이 올까 잠정 결과: ${label} · 이의 기한 <${DEADLINE}>`,
      );
      expect(judgementCorrectedTitle(params, marked), result).toBe(
        `첫눈이 올까 판정 정정 · 잠정 결과: ${label} · 새 이의 기한 <${DEADLINE}>`,
      );
      for (const payoutCoin of ['0', '100', '200', null]) {
        const title = marketSettledTitle({ marketTitle: TITLE, result, payoutCoin });
        expect(title, `${result} ${String(payoutCoin)}`).toContain(
          `결과 확정: ${label} · 지급 완료`,
        );
        // N03 §6: a 무효 payout is a 지급, not what was paid given back.
        expect(title).not.toMatch(/환불|원금|손익/);
      }
    }
  });

  it('names each told decision as MY 판정 이의 does (52-14)', () => {
    expect(NOTIFIED_DISPUTE_DECISIONS).toEqual(Object.keys(DECISION_LABELS));
    expect(DECISION_LABELS).toEqual({
      dismissed: copy.disputeStatusDismissed,
      accepted: copy.disputeStatusAccepted,
    });
    for (const decision of NOTIFIED_DISPUTE_DECISIONS) {
      expect(disputeDecidedTitle({ marketTitle: TITLE, decision, reason: '사유' }), decision).toBe(
        `첫눈이 올까 판정 이의 ${DECISION_LABELS[decision]} · 사유: 사유`,
      );
    }
  });
});

describe('market_settled’s payout (52-15)', () => {
  it('is the member’s own as Coin, 0 included, grouped — and absent for a watcher', () => {
    for (const [payoutCoin, text] of [
      ['0', '0 Coin'],
      ['50', '50 Coin'],
      ['200', '200 Coin'],
      ['1234', '1,234 Coin'],
      ['1000000', '1,000,000 Coin'],
    ] as const) {
      expect(marketSettledTitle({ marketTitle: TITLE, result: 'NO', payoutCoin }), payoutCoin).toBe(
        `첫눈이 올까 결과 확정: NO · 지급 완료 · 내 지급액 ${text}`,
      );
    }
    // A watcher who held nothing at the payout: no amount, not even 0.
    const watcher = marketSettledTitle({ marketTitle: TITLE, result: 'NO', payoutCoin: null });
    expect(watcher).toBe('첫눈이 올까 결과 확정: NO · 지급 완료');
    expect(watcher).not.toContain('Coin');
  });

  it('draws what its definition stores and nothing it refuses', () => {
    for (const payoutCoin of ['0', '200', null]) {
      expect(
        MARKET_SETTLED_NOTIFICATION.params.safeParse({
          marketTitle: TITLE,
          result: 'YES',
          payoutCoin,
        }).success,
        String(payoutCoin),
      ).toBe(true);
    }
    for (const payoutCoin of ['-1', '01', '1.5', 100, '']) {
      expect(
        MARKET_SETTLED_NOTIFICATION.params.safeParse({
          marketTitle: TITLE,
          result: 'YES',
          payoutCoin,
        }).success,
        String(payoutCoin),
      ).toBe(false);
    }
  });
});

describe('a free-text reason (52-15, 188-3)', () => {
  it('is written as stored, braces and dollar signs included', () => {
    for (const reason of FREE_TEXTS) {
      expect(
        judgementDelayedTitle(
          { marketTitle: TITLE, reason, nextReviewAt: NEXT_DAY, judgementTimeZone: ZONE },
          marked,
        ),
        reason,
      ).toBe(`첫눈이 올까 판정 지연 · 다음 검토 <${NEXT_DAY}> · 사유: ${reason}`);
      for (const decision of NOTIFIED_DISPUTE_DECISIONS) {
        expect(disputeDecidedTitle({ marketTitle: TITLE, decision, reason }), reason).toBe(
          `첫눈이 올까 판정 이의 ${DECISION_LABELS[decision]} · 사유: ${reason}`,
        );
      }
    }
  });

  it('is written whole at the cap, as its definition takes it', () => {
    const reason = '가'.repeat(NOTIFICATION_PARAM_STRING_MAX);
    expect(reason).toHaveLength(500);
    const delayed = MARKET_JUDGEMENT_DELAYED_NOTIFICATION.params.parse({
      marketTitle: TITLE,
      reason,
      nextReviewAt: NEXT_DAY,
      judgementTimeZone: null,
    });
    expect(judgementDelayedTitle(delayed, formatKst)).toBe(
      `첫눈이 올까 판정 지연 · 다음 검토 2026. 9. 8. 오후 3:00 · 사유: ${reason}`,
    );
    const decided = MARKET_DISPUTE_DECIDED_NOTIFICATION.params.parse({
      marketTitle: TITLE,
      decision: 'accepted',
      reason,
    });
    expect(disputeDecidedTitle(decided)).toBe(`첫눈이 올까 판정 이의 수용 · 사유: ${reason}`);
    // One unit past it is no notice either definition stores.
    expect(
      MARKET_JUDGEMENT_DELAYED_NOTIFICATION.params.safeParse({
        marketTitle: TITLE,
        reason: `${reason}가`,
        nextReviewAt: NEXT_DAY,
        judgementTimeZone: null,
      }).success,
    ).toBe(false);
    expect(
      MARKET_DISPUTE_DECIDED_NOTIFICATION.params.safeParse({
        marketTitle: TITLE,
        decision: 'dismissed',
        reason: `${reason}가`,
      }).success,
    ).toBe(false);
  });
});

describe('the market title', () => {
  it('is written as stored in every title, braces, dollar signs and astral letters included', () => {
    const marketTitle = '{market} $& 𝕏';
    expect(
      judgementDelayedTitle(
        { marketTitle, reason: '$1', nextReviewAt: NEXT_DAY, judgementTimeZone: null },
        marked,
      ),
    ).toBe(`{market} $& 𝕏 판정 지연 · 다음 검토 <${NEXT_DAY}> · 사유: $1`);
    expect(
      provisionalResultTitle(
        { marketTitle, result: 'VOID', disputeDeadline: DEADLINE, judgementTimeZone: null },
        marked,
      ),
    ).toBe(`{market} $& 𝕏 잠정 결과: 무효 · 이의 기한 <${DEADLINE}>`);
    expect(
      judgementCorrectedTitle(
        { marketTitle, result: 'NO', disputeDeadline: DEADLINE, judgementTimeZone: null },
        marked,
      ),
    ).toBe(`{market} $& 𝕏 판정 정정 · 잠정 결과: NO · 새 이의 기한 <${DEADLINE}>`);
    expect(disputeDecidedTitle({ marketTitle, decision: 'dismissed', reason: '{reason}' })).toBe(
      '{market} $& 𝕏 판정 이의 기각 · 사유: {reason}',
    );
    expect(
      disputeClosedByCorrectionTitle(
        { marketTitle, disputeDeadline: DEADLINE, judgementTimeZone: null },
        marked,
      ),
    ).toBe(`{market} $& 𝕏 판정 이의 정정으로 종결 · 새 이의 기한 <${DEADLINE}>`);
    expect(marketSettledTitle({ marketTitle, result: 'YES', payoutCoin: '0' })).toBe(
      '{market} $& 𝕏 결과 확정: YES · 지급 완료 · 내 지급액 0 Coin',
    );
    // A title of 120 astral letters (240 UTF-16 units), within the definitions' cap.
    const astral = '𝕏'.repeat(120);
    expect(marketSettledTitle({ marketTitle: astral, result: 'NO', payoutCoin: null })).toBe(
      `${astral} 결과 확정: NO · 지급 완료`,
    );
  });
});

describe('the templates (ADR-0158 구현의 선택: single-brace placeholders)', () => {
  it('has each template’s placeholders equal to the keys its title passes', () => {
    const expected: readonly (readonly [string, string[]])[] = [
      [copy.notificationJudgementDelayed, ['market', 'nextReview', 'reason']],
      [copy.notificationProvisionalResult, ['market', 'result', 'deadline']],
      [copy.notificationJudgementCorrected, ['market', 'result', 'deadline']],
      [copy.notificationDisputeDecided, ['market', 'decision', 'reason']],
      [copy.notificationDisputeClosedByCorrection, ['market', 'deadline']],
      [copy.notificationMarketSettled, ['market', 'result', 'payout']],
      [copy.notificationMarketSettledWatcher, ['market', 'result']],
    ];
    for (const [template, keys] of expected) {
      expect(notificationTextKeys(template).sort(), template).toEqual([...keys].sort());
      // Never the legal pages' {{key}} (legal.test.ts holds those to business facts).
      expect(template, template).not.toContain('{{');
    }
    // Every title above filled its template through fillNotificationText, which throws on a
    // missing or an unknown key — so each passes exactly these.
  });

  it('are the renderers’ copy and the guard registry’s text, word for word (188-1)', () => {
    const results = [copy.yes, copy.no, copy.marketResultVoid];
    expect(NOTIFICATION_RENDERERS.market_judgement_delayed.copy).toEqual([
      copy.notificationJudgementDelayed,
      copy.rulesJudgementZoneLine,
    ]);
    expect(NOTIFICATION_RENDERERS.market_provisional_result.copy).toEqual([
      copy.notificationProvisionalResult,
      ...results,
      copy.rulesJudgementZoneLine,
    ]);
    expect(NOTIFICATION_RENDERERS.market_judgement_corrected.copy).toEqual([
      copy.notificationJudgementCorrected,
      ...results,
      copy.rulesJudgementZoneLine,
    ]);
    expect(NOTIFICATION_RENDERERS.market_dispute_decided.copy).toEqual([
      copy.notificationDisputeDecided,
      ...Object.values(DECISION_LABELS),
    ]);
    expect(NOTIFICATION_RENDERERS.market_dispute_closed_by_correction.copy).toEqual([
      copy.notificationDisputeClosedByCorrection,
      copy.rulesJudgementZoneLine,
    ]);
    expect(NOTIFICATION_RENDERERS.market_settled.copy).toEqual([
      copy.notificationMarketSettled,
      copy.notificationMarketSettledWatcher,
      ...Object.values(RESULT_LABELS),
    ]);
    // The second line's label is the detail's (`DateTimeText`).
    expect(copy.rulesJudgementZoneLine).toBe('판정 기준 시간대');
    for (const type of JUDGEMENT_TYPES) {
      expect(NOTIFICATION_RENDERERS[type].copy, type).toEqual(
        NOTIFICATION_TYPE_REGISTRY[type].text,
      );
      for (const text of NOTIFICATION_RENDERERS[type].copy) {
        expect(findExcludedText(text), text).toEqual([]);
        expect(text, text).not.toMatch(/배지|badge/i);
        // N03 §6, N04 §1·§3·§4: no refund, principal, P&L, rank, skill or score beside a result.
        expect(text, text).not.toMatch(
          /환불|원금|손익|순위|랭킹|실력|점수|스코어|수익률|승률|적중|정답|맞힌|정산 기준/,
        );
      }
    }
  });
});

/**
 * 판정 오류 보상 알림 (#144, ADR-0166; 52-20, owner answer 144-18 — '{시장} 판정 정정 · 결과를 {정정된
 * 결과}(으)로 바로잡고 {n} Coin을 보상했습니다.'): one title, the member's own compensation as Coin,
 * every result label taking '로', the registry's words, no P&L and nobody else's amount.
 */
describe('the 판정 오류 보상 sentence (144-18)', () => {
  it('is the owner’s, with each corrected result and the member’s own Coin', () => {
    expect(copy.notificationJudgementCompensated).toBe(
      '{market} 판정 정정 · 결과를 {result}로 바로잡고 {coin}을 보상했습니다.',
    );
    expect(
      judgementCompensatedTitle({
        marketTitle: TITLE,
        originalResult: 'YES',
        correctedResult: 'NO',
        compensationCoin: '100',
      }),
    ).toBe('첫눈이 올까 판정 정정 · 결과를 NO로 바로잡고 100 Coin을 보상했습니다.');
    expect(
      judgementCompensatedTitle({
        marketTitle: TITLE,
        originalResult: 'NO',
        correctedResult: 'VOID',
        compensationCoin: '12345',
      }),
    ).toBe('첫눈이 올까 판정 정정 · 결과를 무효로 바로잡고 12,345 Coin을 보상했습니다.');
    // A stored title holding a placeholder or a replacement pattern stays as written.
    for (const text of FREE_TEXTS) {
      expect(
        judgementCompensatedTitle({
          marketTitle: text,
          originalResult: 'VOID',
          correctedResult: 'YES',
          compensationCoin: '50',
        }),
      ).toBe(`${text} 판정 정정 · 결과를 YES로 바로잡고 50 Coin을 보상했습니다.`);
    }
  });

  it('draws the registry’s words, under 시장, with no P&L, refund or 정답', () => {
    const renderer = NOTIFICATION_RENDERERS.market_judgement_compensated;
    expect(renderer.copy).toEqual([
      copy.notificationJudgementCompensated,
      ...Object.values(RESULT_LABELS),
    ]);
    expect(renderer.copy).toEqual(NOTIFICATION_TYPE_REGISTRY.market_judgement_compensated.text);
    for (const text of renderer.copy) {
      expect(findExcludedText(text), text).toEqual([]);
      expect(text, text).not.toMatch(
        /환불|원금|손익|순위|랭킹|실력|점수|스코어|수익률|승률|적중|정답|맞힌|정산 기준|정산 오류/,
      );
    }
    // The sentence carries no amount of its own: the member's is the placeholder (52-15).
    expect(copy.notificationJudgementCompensated).not.toMatch(/\d/);
  });
});
