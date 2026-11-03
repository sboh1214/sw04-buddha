import { MARKET_FALLBACK_SOURCES_MAX } from '@buddha/shared';
import { useForm } from 'react-hook-form';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { EMPTY_MARKET_FORM, type MarketFormValues } from '@/lib/market-form';
import { byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { MarketSourcesField } from './market-sources-field';

/** The field inside a form holding `values`, as the market form mounts it. */
function Field({ values, disabled = false }: { values: MarketFormValues; disabled?: boolean }) {
  const form = useForm<MarketFormValues>({ defaultValues: values });
  return <MarketSourcesField form={form} disabled={disabled} />;
}

const draw = (values: Partial<MarketFormValues>, disabled = false) =>
  renderWithQueries(<Field values={{ ...EMPTY_MARKET_FORM, ...values }} disabled={disabled} />);

const source = (name: string) => ({ name, url: `https://example.com/${name}` });

/**
 * The market form's 대체 출처 as drawn (#23, #172 item 9): 없음 for none, a row per fallback in
 * priority order with its name, address, 위로, 아래로 and 빼기, and 추가 off at the limit. What the
 * rows hold on save is `marketFormSchema`'s (lib/market-form.test.ts); the e2e
 * (market-rules.spec.ts) reorders, adds and removes rows through it, and types an empty row's
 * refusal away, which this string render cannot.
 */
describe('MarketSourcesField', () => {
  it('reads 없음 while there is no fallback, with 추가 on', () => {
    const html = draw({});
    expect(byTestId(html, 'market-fallback-none')?.text).toBe(copy.adminMarketFallbackNone);
    expect(byTestId(html, 'market-fallback-list')).toBeUndefined();
    const add = byTestId(html, 'market-fallback-add');
    expect(add?.text).toBe(copy.adminMarketFallbackAdd);
    expect(add?.attributes).not.toHaveProperty('disabled');
    // A button that is not a submit: adding a row never saves the form.
    expect(add?.attributes.type).toBe('button');
  });

  it('draws a row per fallback in priority order, each a group named for its place', () => {
    const html = draw({
      fallbackSources: [source('연합뉴스'), { name: '통계청', url: '' }],
      fallbackCondition: '없으면',
    });
    expect(byTestId(html, 'market-fallback-none')).toBeUndefined();
    expect(
      testIdsStartingWith(html, 'market-fallback-').filter((id) => id.endsWith('-name')),
    ).toEqual(['market-fallback-0-name', 'market-fallback-1-name']);
    // The inputs are registered, uncontrolled: their values reach them on mount, not in the HTML.
    expect(byTestId(html, 'market-fallback-1-url')?.attributes.placeholder).toBe('https://');
    expect(html).toContain(`aria-label="${copy.openItemFallbackSources} 2"`);
    // The first cannot go up, the last cannot go down; each can go.
    expect(byTestId(html, 'market-fallback-0-up')?.attributes).toHaveProperty('disabled');
    expect(byTestId(html, 'market-fallback-0-down')?.attributes).not.toHaveProperty('disabled');
    expect(byTestId(html, 'market-fallback-1-up')?.attributes).not.toHaveProperty('disabled');
    expect(byTestId(html, 'market-fallback-1-down')?.attributes).toHaveProperty('disabled');
    for (const button of ['up', 'down', 'remove']) {
      expect(byTestId(html, `market-fallback-0-${button}`)?.attributes.type, button).toBe('button');
    }
    expect(byTestId(html, 'market-fallback-1-remove')?.text).toBe(copy.adminMarketFallbackRemove);
  });

  it('turns 추가 off at the limit, and everything off when the market is locked', () => {
    const full = Array.from({ length: MARKET_FALLBACK_SOURCES_MAX }, (_, index) =>
      source(String(index)),
    );
    expect(
      byTestId(draw({ fallbackSources: full }), 'market-fallback-add')?.attributes,
    ).toHaveProperty('disabled');
    const locked = draw({ fallbackSources: [source('a'), source('b')] }, true);
    for (const id of [
      'market-fallback-add',
      'market-fallback-0-down',
      'market-fallback-1-up',
      'market-fallback-1-remove',
    ]) {
      expect(byTestId(locked, id)?.attributes, id).toHaveProperty('disabled');
    }
  });
});
