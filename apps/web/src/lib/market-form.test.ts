import {
  MARKET_TAGS_MAX,
  MARKET_TAGS_MIN,
  TAG_NAME_MAX,
  marketTagsSchema,
  tagNameSchema,
} from '@buddha/shared';
import fc from 'fast-check';
import { createFormControl } from 'react-hook-form';
import { afterAll, describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type AdminMarket, type Category } from './api';
import {
  AFTER_SAVE_RESET,
  EMPTY_MARKET_FORM,
  FOLLOW_SERVER_RESET,
  type MarketFormValues,
  addTags,
  isHttpUrl,
  marketFormSchema,
  marketToFormValues,
  resolveMarketFormSchema,
  toCreateMarketBody,
  sameTags,
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
      tags: [],
      imageUrl: null,
      closeAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('sends the tags in entry order, and none as an empty list (a draft may have none, #17)', () => {
    expect(toCreateMarketBody({ ...valid, tags: ['금리', 'CPI'] }).tags).toEqual(['금리', 'CPI']);
    expect(toCreateMarketBody(valid).tags).toEqual([]);
    // What the box holds and has not added is never sent.
    expect(toCreateMarketBody({ ...valid, tagInput: '서울' })).not.toHaveProperty('tagInput');
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

  it('sends the whole ordered tag set only when it changed (#17)', () => {
    const tagged = { ...original, tags: ['금리', 'CPI'] };
    expect(toUpdateMarketBody(tagged, tagged)).toEqual({});
    // A tag added, one removed, the order changed: the whole set, in its new order.
    expect(toUpdateMarketBody({ ...tagged, tags: ['금리', 'CPI', '서울'] }, tagged)).toEqual({
      tags: ['금리', 'CPI', '서울'],
    });
    expect(toUpdateMarketBody({ ...tagged, tags: ['CPI'] }, tagged)).toEqual({ tags: ['CPI'] });
    expect(toUpdateMarketBody({ ...tagged, tags: ['CPI', '금리'] }, tagged)).toEqual({
      tags: ['CPI', '금리'],
    });
    expect(toUpdateMarketBody({ ...tagged, tags: [] }, tagged)).toEqual({ tags: [] });
    // Re-cased only: the same tag, which the API would keep in its first spelling anyway.
    expect(toUpdateMarketBody({ ...tagged, tags: ['금리', 'cpi'] }, tagged)).toEqual({});
    // The box is never sent.
    expect(toUpdateMarketBody({ ...tagged, tagInput: '서울' }, tagged)).toEqual({});
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

describe('addTags', () => {
  it('normalises a typed name and adds it at the end', () => {
    expect(addTags([], '  서울  ')).toEqual({ tags: ['서울'], rest: '' });
    expect(addTags(['서울'], '한국   영화')).toEqual({ tags: ['서울', '한국 영화'], rest: '' });
    // NFC: a name typed in decomposed jamo is the composed one.
    expect(addTags([], '서울'.normalize('NFD')).tags).toEqual(['서울']);
  });

  it("splits a pasted list on commas, skipping blanks ('a, b,')", () => {
    expect(addTags([], '서울, 기상청,  , CPI,')).toEqual({
      tags: ['서울', '기상청', 'CPI'],
      rest: '',
    });
    // A box of blanks adds nothing and leaves nothing behind.
    expect(addTags(['서울'], ' , ,')).toEqual({ tags: ['서울'], rest: '' });
  });

  it('refuses a second name of one tag, case and spacing aside', () => {
    expect(addTags(['AI'], 'ai')).toEqual({
      tags: ['AI'],
      rest: 'ai',
      error: copy.errMarketTagDuplicate,
    });
    expect(addTags(['한국 영화'], '한국  영화').error).toBe(copy.errMarketTagDuplicate);
    // Within one pasted list too.
    expect(addTags([], 'CPI, cpi')).toEqual({
      tags: ['CPI'],
      rest: 'cpi',
      error: copy.errMarketTagDuplicate,
    });
  });

  it('refuses a sixth tag', () => {
    const five = ['a1', 'a2', 'a3', 'a4', 'a5'];
    expect(five).toHaveLength(MARKET_TAGS_MAX);
    expect(addTags(five, '서울')).toEqual({
      tags: five,
      rest: '서울',
      error: copy.errMarketTagsMax,
    });
    // A list that would run past five adds up to five and keeps the rest in the box.
    expect(addTags(['a1', 'a2', 'a3', 'a4'], 'b1, b2, b3')).toEqual({
      tags: ['a1', 'a2', 'a3', 'a4', 'b1'],
      rest: 'b2, b3',
      error: copy.errMarketTagsMax,
    });
  });

  it('explains a name too long or outside the allowed characters', () => {
    const long = '가'.repeat(TAG_NAME_MAX + 1);
    expect(addTags([], long)).toEqual({ tags: [], rest: long, error: copy.errMarketTagLength });
    expect(addTags([], '가'.repeat(TAG_NAME_MAX)).tags).toHaveLength(1);
    for (const bad of ['#AI', 'K-', '서울!', '-서울', '이모지🙂', '_밑줄']) {
      expect(addTags([], bad), bad).toEqual({
        tags: [],
        rest: bad,
        error: copy.errMarketTagFormat,
      });
    }
    for (const good of ['S&P500', 'K-팝', '2026 지방선거', 'C++', '원·달러', 'v1.0']) {
      expect(addTags([], good).tags, good).toEqual([good]);
    }
  });

  it('adds the names before a refused one and keeps it, with what follows, in the box as typed', () => {
    expect(addTags([], '서울, 기상#청 ,날씨')).toEqual({
      tags: ['서울'],
      rest: '기상#청 ,날씨',
      error: copy.errMarketTagFormat,
    });
  });

  it("takes one name exactly when the shared tagNameSchema does — the API's rule", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 24 }),
          fc.stringMatching(/^[가-힣A-Za-z0-9 \-_.&+·#!]{0,24}$/),
        ),
        (typed) => {
          fc.pre(!typed.includes(',') && typed.trim() !== '');
          const added = addTags([], typed);
          const parsed = tagNameSchema.safeParse(typed);
          expect(added.tags.length === 1, typed).toBe(parsed.success);
          if (parsed.success) expect(added.tags).toEqual([parsed.data]);
        },
      ),
    );
  });

  it('never leaves a list the shared marketTagsSchema would refuse', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[가-힣A-Za-z0-9 ,]{0,12}$/), { maxLength: 8 }),
        (inputs) => {
          let tags: string[] = [];
          for (const input of inputs) tags = addTags(tags, input).tags;
          expect(marketTagsSchema.safeParse(tags).success).toBe(true);
        },
      ),
    );
  });
});

describe('sameTags', () => {
  it('is the same tags in the same order, case and spacing aside (the API compares so)', () => {
    expect(sameTags([], [])).toBe(true);
    expect(sameTags(['AI', '서울'], ['ai', '서울'])).toBe(true);
    expect(sameTags(['한국 영화'], ['한국  영화'])).toBe(true);
    expect(sameTags(['AI', '서울'], ['서울', 'AI'])).toBe(false);
    expect(sameTags(['AI'], ['AI', '서울'])).toBe(false);
    expect(sameTags(['AI'], ['AJ'])).toBe(false);
  });
});

describe('the tag copy', () => {
  it('names the shared bounds, so a change to them shows here', () => {
    expect(copy.openItemTags).toContain(`${String(MARKET_TAGS_MIN)}~${String(MARKET_TAGS_MAX)}개`);
    expect(copy.adminMarketTagsHint).toContain(
      `${String(MARKET_TAGS_MIN)}~${String(MARKET_TAGS_MAX)}개`,
    );
    expect(copy.errMarketTagsMax).toContain(`${String(MARKET_TAGS_MAX)}개`);
    expect(copy.errMarketTagLength).toContain(`${String(TAG_NAME_MAX)}자`);
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
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  createdBy: 'admin',
  netCollectedCoin: '0',
  openInterest: { yes: 0, no: 0 },
  settlementSteps: [],
  statusEventId: '1',
  events: [],
  tags: [],
  missingOpenItems: [],
};

describe('marketFormSchema tags', () => {
  const tagMessages = (result: {
    error?: { issues: { message: string; path: PropertyKey[] }[] };
  }) =>
    result.error?.issues
      .filter((issue) => issue.path[0] === 'tags' || issue.path[0] === 'tagInput')
      .map((issue) => `${String(issue.path[0])}: ${issue.message}`) ?? [];

  it('accepts none on a draft, and up to five distinct valid names', () => {
    const schema = marketFormSchema({ now });
    expect(schema.safeParse({ ...valid, tags: [] }).success).toBe(true);
    expect(schema.safeParse({ ...valid, tags: ['a1', 'a2', 'a3', 'a4', 'a5'] }).success).toBe(true);
  });

  it('refuses what the box would have refused (a backstop), on the tags field', () => {
    const schema = marketFormSchema({ now });
    expect(tagMessages(schema.safeParse({ ...valid, tags: ['AI', 'ai'] }))).toEqual([
      `tags: ${copy.errMarketTagDuplicate}`,
    ]);
    expect(
      tagMessages(schema.safeParse({ ...valid, tags: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] })),
    ).toEqual([`tags: ${copy.errMarketTagsMax}`]);
    expect(tagMessages(schema.safeParse({ ...valid, tags: ['#AI'] }))).toEqual([
      `tags: ${copy.errMarketTagFormat}`,
    ]);
  });

  it('refuses an open market edited down to no tags, as the API does', () => {
    const open = marketFormSchema({ now, tagsRequired: true });
    expect(tagMessages(open.safeParse({ ...valid, tags: [] }))).toEqual([
      `tags: ${copy.errMarketTagsOpen}`,
    ]);
    expect(open.safeParse({ ...valid, tags: ['금리'] }).success).toBe(true);
    // Emptied: refused when the market had tags.
    const tagged = { ...valid, tags: ['금리'] };
    expect(
      tagMessages(
        marketFormSchema({ now, original: tagged, tagsRequired: true }).safeParse({
          ...tagged,
          tags: [],
        }),
      ),
    ).toEqual([`tags: ${copy.errMarketTagsOpen}`]);
    // Untouched and empty is exempt, unlike the rules: a market opened before #17 has no tags,
    // and an edit of its title or close time must still save (the form then sends no tags).
    const legacy = { ...valid, tags: [] };
    expect(
      marketFormSchema({ now, original: legacy, tagsRequired: true }).safeParse({
        ...legacy,
        title: '새 제목',
      }).success,
    ).toBe(true);
  });

  it('refuses a save while the box holds a name it did not add, rather than dropping it', () => {
    const schema = marketFormSchema({ now });
    expect(tagMessages(schema.safeParse({ ...valid, tagInput: '서울#' }))).toEqual([
      `tagInput: ${copy.errMarketTagPending}`,
    ]);
    expect(schema.safeParse({ ...valid, tagInput: '   ' }).success).toBe(true);
  });
});

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
      tags: [],
      tagInput: '',
      imageUrl: '',
      closeAt: '2026-10-01T09:00',
      slug: 'rate-cut-2026',
    });
  });

  it('prefills the tags as stored, in order, and an empty box', () => {
    const values = marketToFormValues({ ...market, tags: ['AI', '서울'] }, categories);
    expect(values.tags).toEqual(['AI', '서울']);
    expect(values.tagInput).toBe('');
    expect(toUpdateMarketBody(values, values)).toEqual({});
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
  it('sends the result with blanks as null and text trimmed, as the admin on screen', () => {
    expect(toResolveMarketBody({ result: 'NO', note: '', evidenceUrl: '  ' }, 'admin-1')).toEqual({
      result: 'NO',
      note: null,
      evidenceUrl: null,
      // ADR-0092: the server refuses a 판정 made under another account's cookie.
      expectedAccountId: 'admin-1',
    });
    expect(
      toResolveMarketBody(
        { result: 'YES', note: ' 공식 발표 ', evidenceUrl: 'https://e.com/a ' },
        'admin-1',
      ),
    ).toEqual({
      result: 'YES',
      note: '공식 발표',
      evidenceUrl: 'https://e.com/a',
      expectedAccountId: 'admin-1',
    });
  });
});
