import { createFormControl } from 'react-hook-form';
import { afterAll, describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type AdminMarket, type Category } from './api';
import {
  AFTER_SAVE_RESET,
  EMPTY_MARKET_FORM,
  FOLLOW_SERVER_RESET,
  type MarketFormValues,
  isHttpUrl,
  marketFormSchema,
  marketToFormValues,
  resolveMarketFormSchema,
  toCreateMarketBody,
  toResolveMarketBody,
  toUpdateMarketBody,
} from './market-form';

const originalTz = process.env.TZ;
afterAll(() => {
  process.env.TZ = originalTz;
});

const NOW = Date.parse('2026-09-06T00:00:00.000Z');
const now = () => NOW;

const valid: MarketFormValues = {
  ...EMPTY_MARKET_FORM,
  title: '  10월 기준금리가 인하될까?  ',
  description: '설명',
  rules: '한국은행 발표 기준',
  resolutionSource: '한국은행',
  categoryId: '3',
  imageUrl: 'https://example.com/a.png',
  closeAt: '2026-10-01T09:00',
  slug: '',
};

const messages = (result: { error?: { issues: { message: string }[] } }) =>
  result.error?.issues.map((issue) => issue.message) ?? [];

describe('isHttpUrl', () => {
  it('accepts http(s) only', () => {
    expect(isHttpUrl('https://example.com/x')).toBe(true);
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('ftp://example.com')).toBe(false);
    expect(isHttpUrl('example.com')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });
});

describe('marketFormSchema', () => {
  const schema = marketFormSchema({ now });

  it('accepts a complete form and trims the text fields', () => {
    const result = schema.safeParse(valid);
    expect(result.success).toBe(true);
    expect(result.data?.title).toBe('10월 기준금리가 인하될까?');
  });

  it('accepts blank rules, description, source, image and slug (draft may lack them)', () => {
    expect(
      schema.safeParse({ ...valid, rules: '', description: '', resolutionSource: '', imageUrl: '' })
        .success,
    ).toBe(true);
  });

  it('requires a title within 120 characters', () => {
    expect(messages(schema.safeParse({ ...valid, title: '   ' }))).toEqual([copy.errMarketTitle]);
    expect(messages(schema.safeParse({ ...valid, title: 'a'.repeat(121) }))).toEqual([
      copy.errMarketTitle,
    ]);
  });

  it('requires a chosen category', () => {
    expect(messages(schema.safeParse({ ...valid, categoryId: '' }))).toEqual([
      copy.errMarketCategory,
    ]);
  });

  it('refuses a non-http image URL', () => {
    expect(messages(schema.safeParse({ ...valid, imageUrl: 'javascript:alert(1)' }))).toEqual([
      copy.errMarketImageUrl,
    ]);
    expect(
      messages(schema.safeParse({ ...valid, imageUrl: `https://e.com/${'a'.repeat(500)}` })),
    ).toEqual([copy.errMarketImageUrl]);
  });

  it('requires a close time in the future, read as KST', () => {
    process.env.TZ = 'America/New_York';
    // 2026-09-06 08:59 KST = 2026-09-05 23:59Z: one minute before NOW.
    expect(messages(schema.safeParse({ ...valid, closeAt: '2026-09-06T08:59' }))).toEqual([
      copy.errMarketCloseAt,
    ]);
    expect(schema.safeParse({ ...valid, closeAt: '2026-09-06T09:01' }).success).toBe(true);
    expect(messages(schema.safeParse({ ...valid, closeAt: '' }))).toEqual([copy.errMarketCloseAt]);
    expect(messages(schema.safeParse({ ...valid, closeAt: 'nope' }))).toEqual([
      copy.errMarketCloseAt,
    ]);
  });

  it('exempts an untouched close time from the future rule when editing', () => {
    // A draft whose close time passed can still have its title fixed: the PATCH omits the
    // unchanged closeAt, and the API only checks what is sent.
    const original = { ...valid, closeAt: '2020-01-01T00:00' };
    const editing = marketFormSchema({ now, original });
    expect(editing.safeParse(original).success).toBe(true);
    expect(messages(editing.safeParse({ ...original, closeAt: '2020-01-02T00:00' }))).toEqual([
      copy.errMarketCloseAt,
    ]);
  });

  it('exempts an untouched blank category (retired since) when editing', () => {
    // The edit form prefills '' for a category no longer in GET /categories; a title-only
    // edit must still pass, since the PATCH omits the blank and the API accepts one without.
    const original = { ...valid, categoryId: '' };
    const editing = marketFormSchema({ now, original });
    expect(editing.safeParse(original).success).toBe(true);
    expect(editing.safeParse({ ...original, title: '고친 질문' }).success).toBe(true);
    expect(editing.safeParse({ ...original, categoryId: '4' }).success).toBe(true);
    expect(messages(editing.safeParse({ ...original, categoryId: 'x' }))).toEqual([
      copy.errMarketCategory,
    ]);
    // Only a blank *original* is exempt: clearing a chosen category is still a refusal.
    const chosen = marketFormSchema({ now, original: valid });
    expect(messages(chosen.safeParse({ ...valid, categoryId: '' }))).toEqual([
      copy.errMarketCategory,
    ]);
  });

  it('checks a typed slug with the shared rule and lets a blank one through', () => {
    expect(schema.safeParse({ ...valid, slug: '' }).success).toBe(true);
    expect(schema.safeParse({ ...valid, slug: '금리-2026' }).success).toBe(true);
    expect(messages(schema.safeParse({ ...valid, slug: 'ab' }))).toEqual([copy.errMarketSlug]);
    expect(messages(schema.safeParse({ ...valid, slug: 'Upper_Case' }))).toEqual([
      copy.errMarketSlug,
    ]);
    expect(
      messages(schema.safeParse({ ...valid, slug: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' })),
    ).toEqual([copy.errMarketSlug]);
  });
});

describe('toCreateMarketBody', () => {
  it('converts the form into the API body: KST → UTC, blanks → null', () => {
    process.env.TZ = 'UTC';
    expect(toCreateMarketBody({ ...valid, description: '  ', imageUrl: '' })).toEqual({
      title: '10월 기준금리가 인하될까?',
      description: null,
      rules: '한국은행 발표 기준',
      resolutionSource: '한국은행',
      categoryId: 3,
      imageUrl: null,
      closeAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('sends no initial probability or liquidity: a market is made without them (#125)', () => {
    const body = toCreateMarketBody(valid);
    expect(body).not.toHaveProperty('initialProbBp');
    expect(body).not.toHaveProperty('liquidityB');
  });

  it('sends the slug only when one was typed', () => {
    expect(toCreateMarketBody(valid)).not.toHaveProperty('slug');
    expect(toCreateMarketBody({ ...valid, slug: ' my-slug ' }).slug).toBe('my-slug');
  });
});

describe('toUpdateMarketBody', () => {
  const original: MarketFormValues = { ...valid, title: '원래 질문', closeAt: '2020-01-01T00:00' };

  it('is empty when nothing changed, even with a past close time', () => {
    expect(toUpdateMarketBody(original, original)).toEqual({});
    expect(toUpdateMarketBody({ ...original, title: ' 원래 질문 ' }, original)).toEqual({});
  });

  it('sends only the fields that differ', () => {
    expect(
      toUpdateMarketBody(
        { ...original, title: '새 질문', rules: '새 기준', closeAt: '2026-10-01T09:00' },
        original,
      ),
    ).toEqual({ title: '새 질문', rules: '새 기준', closeAt: '2026-10-01T00:00:00.000Z' });
    expect(toUpdateMarketBody({ ...original, description: '' }, original)).toEqual({
      description: null,
    });
    expect(toUpdateMarketBody({ ...original, categoryId: '4' }, original)).toEqual({
      categoryId: 4,
    });
  });

  it('never sends a blank category (a retired one prefilled as "")', () => {
    const noCategory = { ...original, categoryId: '' };
    expect(toUpdateMarketBody(noCategory, noCategory)).toEqual({});
    expect(toUpdateMarketBody({ ...original, categoryId: '' }, original)).toEqual({});
    // A title-only edit of such a market is `{ title }` once the schema has let it through.
    const edited = { ...noCategory, title: '고친 질문' };
    expect(marketFormSchema({ now, original: noCategory }).safeParse(edited).success).toBe(true);
    expect(toUpdateMarketBody(edited, noCategory)).toEqual({ title: '고친 질문' });
  });
});

const categories: Category[] = [
  { id: 1, slug: 'economy', nameKo: '경제', sortOrder: 1, parentId: null },
  { id: 2, slug: 'weather', nameKo: '날씨', sortOrder: 2, parentId: null },
];

const market: AdminMarket = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  slug: 'rate-cut-2026',
  title: '기준금리 인하?',
  description: null,
  rules: '',
  resolutionSource: null,
  category: { slug: 'weather', nameKo: '날씨' },
  imageUrl: null,
  status: 'draft',
  lastPrice: null,
  volumeCoin: '0',
  tradeCount: 0,
  traderCount: 0,
  closeAt: '2026-10-01T00:00:00.000Z',
  openAt: null,
  resolvedResult: null,
  resolvedAt: null,
  settledAt: null,
  voidedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  createdBy: 'admin',
  netCollectedCoin: '0',
  openInterest: { yes: 0, no: 0 },
  settlementSteps: [],
  statusEventId: '1',
  events: [],
};

describe('marketFormSchema rulesRequired', () => {
  it('requires rules only for the edit form of an open market', () => {
    const blank = { ...valid, rules: '   ' };
    expect(marketFormSchema({ now }).safeParse(blank).success).toBe(true);
    const refused = marketFormSchema({ now, rulesRequired: true }).safeParse(blank);
    expect(refused.success).toBe(false);
    expect(messages(refused)).toEqual([copy.errMarketRulesOpen]);
    expect(marketFormSchema({ now, rulesRequired: true }).safeParse(valid).success).toBe(true);
  });

  it('does not exempt untouched blank rules on an open market', () => {
    // Unlike closeAt: an open market without rules is an anomaly to fix, not a state to keep.
    const original = { ...valid, rules: '' };
    const refused = marketFormSchema({ now, original, rulesRequired: true }).safeParse(original);
    expect(refused.success).toBe(false);
    expect(messages(refused)).toEqual([copy.errMarketRulesOpen]);
  });
});

/**
 * The edit form's reset policies, run against react-hook-form's form control without a DOM
 * (what `useForm` wraps): the `values` prop resets under FOLLOW_SERVER_RESET, a save resets
 * with AFTER_SAVE_RESET, and every `reset()` inherits the former unless told otherwise.
 */
describe('edit-form reset policies', () => {
  const keys = Object.keys(EMPTY_MARKET_FORM) as (keyof MarketFormValues)[];

  /** A form as the screen mounts it, every field registered. */
  function mounted(values: MarketFormValues) {
    const form = createFormControl<MarketFormValues>({ values, resetOptions: FOLLOW_SERVER_RESET });
    for (const name of keys) form.register(name);
    form.control._state.mount = true;
    return form;
  }

  it('a background refetch keeps the fields the admin edited and follows the server elsewhere', () => {
    const original = marketToFormValues(market, categories);
    const form = mounted(original);
    form.setValue('title', '  새 제목  ', { shouldDirty: true });

    // Another writer changed the rules; the `values` prop resets the form to the new row.
    const fromServer = { ...original, rules: '다른 관리자가 고친 규칙' };
    form.reset(fromServer, FOLLOW_SERVER_RESET);
    expect(form.getValues()).toEqual({ ...fromServer, title: '  새 제목  ' });
    expect(form.control._getDirty()).toBe(true);
  });

  it('a save restarts clean on the saved row, including the fields just saved', () => {
    const original = marketToFormValues(market, categories);
    const saved = marketToFormValues({ ...market, title: '새 제목' }, categories);

    const form = mounted(original);
    form.setValue('title', '  새 제목  ', { shouldDirty: true });
    form.reset(saved, AFTER_SAVE_RESET);
    expect(form.getValues()).toEqual(saved);
    expect(form.control._getDirty()).toBe(false);

    // The trap the explicit options exist for: a bare reset() inherits the follow-server
    // policy, keeps the untrimmed input of the field just saved, and leaves the form dirty.
    const bare = mounted(original);
    bare.setValue('title', '  새 제목  ', { shouldDirty: true });
    bare.reset(saved);
    expect(bare.getValues().title).toBe('  새 제목  ');
    expect(bare.control._getDirty()).toBe(true);
  });
});

describe('marketToFormValues', () => {
  it('prefills the form, looking the category id up by slug and rendering KST', () => {
    process.env.TZ = 'UTC';
    expect(marketToFormValues(market, categories)).toEqual({
      title: '기준금리 인하?',
      description: '',
      rules: '',
      resolutionSource: '',
      categoryId: '2',
      imageUrl: '',
      closeAt: '2026-10-01T09:00',
      slug: 'rate-cut-2026',
    });
  });

  it('leaves the category blank when it is no longer in the active list', () => {
    expect(marketToFormValues(market, [categories[0] as Category]).categoryId).toBe('');
  });

  it('round-trips through toUpdateMarketBody as "no change"', () => {
    const values = marketToFormValues(market, categories);
    expect(toUpdateMarketBody(values, values)).toEqual({});
  });
});

describe('resolveMarketFormSchema', () => {
  const chosen = { result: 'YES' as const, note: '', evidenceUrl: '' };

  it('requires a result, which an untouched form does not hold at all', () => {
    // The radio group starts unselected, so `result` is `undefined` rather than a sentinel.
    expect(messages(resolveMarketFormSchema.safeParse({ note: '', evidenceUrl: '' }))).toEqual([
      copy.errMarketResultRequired,
    ]);
    expect(messages(resolveMarketFormSchema.safeParse({ ...chosen, result: 'MAYBE' }))).toEqual([
      copy.errMarketResultRequired,
    ]);
    expect(resolveMarketFormSchema.safeParse(chosen).success).toBe(true);
    expect(resolveMarketFormSchema.safeParse({ ...chosen, result: 'NO' }).success).toBe(true);
  });

  it('bounds the note to 1,000 characters and trims it', () => {
    expect(resolveMarketFormSchema.safeParse({ ...chosen, note: '  근거 확인  ' }).data?.note).toBe(
      '근거 확인',
    );
    expect(resolveMarketFormSchema.safeParse({ ...chosen, note: 'a'.repeat(1000) }).success).toBe(
      true,
    );
    expect(
      messages(resolveMarketFormSchema.safeParse({ ...chosen, note: 'a'.repeat(1001) })),
    ).toEqual([copy.errMarketResolveNote]);
  });

  it('accepts a blank or an http(s) evidence URL of at most 500 characters', () => {
    expect(resolveMarketFormSchema.safeParse(chosen).success).toBe(true);
    expect(
      resolveMarketFormSchema.safeParse({ ...chosen, evidenceUrl: ' https://example.com/x ' }).data
        ?.evidenceUrl,
    ).toBe('https://example.com/x');
    for (const bad of ['javascript:alert(1)', 'example.com', `https://e.com/${'a'.repeat(500)}`]) {
      expect(
        messages(resolveMarketFormSchema.safeParse({ ...chosen, evidenceUrl: bad })),
        bad,
      ).toEqual([copy.errMarketResolveEvidence]);
    }
  });
});

describe('toResolveMarketBody', () => {
  it('sends the result with blanks as null and text trimmed', () => {
    expect(toResolveMarketBody({ result: 'NO', note: '', evidenceUrl: '  ' })).toEqual({
      result: 'NO',
      note: null,
      evidenceUrl: null,
    });
    expect(
      toResolveMarketBody({ result: 'YES', note: ' 공식 발표 ', evidenceUrl: 'https://e.com/a ' }),
    ).toEqual({ result: 'YES', note: '공식 발표', evidenceUrl: 'https://e.com/a' });
  });
});
