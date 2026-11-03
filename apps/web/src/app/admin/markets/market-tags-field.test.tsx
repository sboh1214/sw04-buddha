import { useForm } from 'react-hook-form';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { EMPTY_MARKET_FORM, type MarketFormValues } from '@/lib/market-form';
import { byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { MarketTagsField } from './market-tags-field';

/** The field inside a form holding `values`, as the market form mounts it. */
function Field({ values, disabled = false }: { values: MarketFormValues; disabled?: boolean }) {
  const form = useForm<MarketFormValues>({ defaultValues: values });
  return <MarketTagsField form={form} disabled={disabled} />;
}

const draw = (values: Partial<MarketFormValues>, disabled = false) =>
  renderWithQueries(<Field values={{ ...EMPTY_MARKET_FORM, ...values }} disabled={disabled} />);

/**
 * The market form's 태그 field as drawn (#17): the box and 넣기, a chip per tag in entry order with
 * its own 빼기, and the hint. What adding does is `addTags` (lib/market-form.test.ts); the e2e
 * (market-tags.spec.ts) types into it.
 */
describe('MarketTagsField', () => {
  it('draws a chip per tag in entry order, each with a 빼기 named for its tag', () => {
    const html = draw({ tags: ['AI', '서울'] });
    expect(testIdsStartingWith(html, 'market-tags-item-')).toEqual([
      'market-tags-item-0',
      'market-tags-item-1',
    ]);
    expect(byTestId(html, 'market-tags-item-0')?.text).toBe('AI');
    expect(byTestId(html, 'market-tags-item-1')?.text).toBe('서울');
    const remove = byTestId(html, 'market-tags-remove-1');
    expect(remove?.attributes['aria-label']).toBe(`서울 ${copy.adminMarketTagRemove}`);
    // A button that is not a submit: removing a tag never saves the form.
    expect(remove?.attributes.type).toBe('button');
    expect(byTestId(html, 'market-tags-add')?.attributes.type).toBe('button');
    expect(html).toContain(copy.adminMarketTagsHint);
  });

  it('draws no chip list while there is no tag, and disables the box and buttons when locked', () => {
    expect(byTestId(draw({}), 'market-tags-list')).toBeUndefined();
    const locked = draw({ tags: ['AI'] }, true);
    expect(byTestId(locked, 'market-tags-input')?.attributes).toHaveProperty('disabled');
    expect(byTestId(locked, 'market-tags-add')?.attributes).toHaveProperty('disabled');
    expect(byTestId(locked, 'market-tags-remove-0')?.attributes).toHaveProperty('disabled');
  });
});
