import { PROPOSED_CONTRACT_TERMS, formatCoin } from '@buddha/shared';
import { useForm } from 'react-hook-form';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { EMPTY_MARKET_FORM, type MarketFormValues } from '@/lib/market-form';
import { byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { MarketRuleFields } from './market-rule-fields';

/** The group inside a form holding `values`, as the market form mounts it. */
function Fields({ values, disabled = false }: { values: MarketFormValues; disabled?: boolean }) {
  const form = useForm<MarketFormValues>({ defaultValues: values });
  return <MarketRuleFields form={form} disabled={disabled} />;
}

const draw = (values: Partial<MarketFormValues>, disabled = false) =>
  renderWithQueries(<Fields values={{ ...EMPTY_MARKET_FORM, ...values }} disabled={disabled} />);

/** The inputs of the group, by test id, in the order they are drawn. */
const INPUTS = [
  'market-description',
  'market-yes-condition',
  'market-no-condition',
  'market-event-deadline',
  'market-primary-source-name',
  'market-primary-source-url',
  'market-fallback-condition',
  'market-long-delay-days',
  'market-delay-handling',
];

/**
 * The market form's 규칙 항목 as drawn (#23, ADR-0097): one input per rule item in OPEN_ITEMS
 * order, the switch condition only with a fallback, and the fixed VOID line under the delay
 * handling. What the inputs hold on save is `marketFormSchema`'s (lib/market-form.test.ts).
 */
describe('MarketRuleFields', () => {
  it('draws an input per rule item in the open-items order, labelled with the item names', () => {
    const html = draw({
      fallbackSources: [{ name: '연합뉴스', url: 'https://yna.co.kr' }],
      fallbackCondition: '없으면',
    });
    expect(testIdsStartingWith(html, 'market-').filter((id) => INPUTS.includes(id))).toEqual(
      INPUTS,
    );
    // The fallbacks sit between the primary source and the switch condition.
    expect(html.indexOf('market-primary-source-url')).toBeLessThan(
      html.indexOf('market-fallback-0-name'),
    );
    expect(html.indexOf('market-fallback-0-name')).toBeLessThan(
      html.indexOf('market-fallback-condition'),
    );
    for (const label of [
      copy.adminMarketRuleItems,
      copy.adminMarketDescription,
      copy.adminMarketYesCondition,
      copy.adminMarketNoCondition,
      copy.adminMarketEventDeadline,
      copy.adminMarketPrimarySource,
      copy.adminMarketFallbackSources,
      copy.adminMarketFallbackCondition,
      copy.adminMarketLongDelayDays,
      copy.adminMarketDelayHandling,
    ]) {
      expect(html, label).toContain(label);
    }
    // 배경 is the public detail's word for the description (no more 설명).
    expect(copy.adminMarketDescription).toBe(copy.marketBackground);
    expect(byTestId(html, 'market-event-deadline')?.attributes.type).toBe('datetime-local');
    expect(byTestId(html, 'market-long-delay-days')?.attributes.type).toBe('number');
    expect(html).toContain(copy.adminMarketLongDelayDaysSuffix);
  });

  it('asks the switch condition only while there is a fallback, or text left without one', () => {
    expect(byTestId(draw({}), 'market-fallback-condition')).toBeUndefined();
    // Another writer left a condition with no fallback: it stays, so its refusal can be fixed.
    expect(
      byTestId(draw({ fallbackCondition: '없으면' }), 'market-fallback-condition'),
    ).toBeDefined();
  });

  it('states the VOID payout under the delay handling, read-only, from the contract terms', () => {
    const html = draw({});
    const line = byTestId(html, 'market-void-payout');
    expect(line?.text).toContain(copy.rulesVoidPayout);
    expect(line?.text).toContain(
      `YES 계약은 계약마다 ${formatCoin(PROPOSED_CONTRACT_TERMS.voidPayoutYesCoin)}`,
    );
    expect(line?.text).toContain(
      `NO 계약은 계약마다 ${formatCoin(PROPOSED_CONTRACT_TERMS.voidPayoutNoCoin)}`,
    );
    // A rule, never a refund (N03 §6); and nothing the operator types.
    expect(line?.text).not.toMatch(/환불|원금/);
    expect(html.indexOf('market-delay-handling')).toBeLessThan(html.indexOf('market-void-payout'));
  });

  it('says no delay alone is a NO, in both hints (N03 §4)', () => {
    expect(copy.adminMarketNoConditionHint).toContain('사건 기한까지');
    expect(copy.adminMarketDelayHandlingHint).toContain('늦어진 것만으로 NO로 판정하지 않습니다');
  });

  it('is off as a whole when the market is locked', () => {
    const html = draw({}, true);
    expect(byTestId(html, 'market-rule-items')?.attributes).toHaveProperty('disabled');
  });
});
