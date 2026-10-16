import {
  MARKET_SEARCH_TERM_MAX,
  MARKET_STATUSES,
  MARKET_TITLE_MAX,
  RELATED_MARKET_STATUSES,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError } from './api';
import { MARKET_STATUS_LABEL } from './market-admin';
import { SEARCH_INPUT_MAX_LENGTH } from './market-search';
import {
  relatedHint,
  relatedLinkErrorMessage,
  relatedPickState,
  relatedSearchQuery,
  relatedSearchSubmit,
  relatedSearchTerm,
} from './related-markets';

const HUB = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const LINKED = 'a1b2c3d4-0000-4000-8000-000000000001';
const OTHER = 'b1b2c3d4-0000-4000-8000-000000000002';

const apiError = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);

describe('relatedPickState (the admin picker, #65)', () => {
  it('offers to link any other market, marks the linked ones and the market itself', () => {
    const linked = new Set([LINKED]);
    expect(relatedPickState(OTHER, HUB, linked)).toBe('linkable');
    expect(relatedPickState(LINKED, HUB, linked)).toBe('linked');
    expect(relatedPickState(HUB, HUB, linked)).toBe('self');
  });

  it('reads ids in any case, as the API lower-cases them', () => {
    const linked = new Set([LINKED]);
    expect(relatedPickState(LINKED.toUpperCase(), HUB, linked)).toBe('linked');
    expect(relatedPickState(HUB.toUpperCase(), HUB, linked)).toBe('self');
  });
});

describe('relatedSearchTerm', () => {
  it('is the admin list’s q: trimmed, never blank, never past the API’s bound', () => {
    expect(relatedSearchTerm('  첫눈  ')).toBe('첫눈');
    expect(relatedSearchTerm('   ')).toBeUndefined();
    expect(relatedSearchTerm('')).toBeUndefined();
    expect(relatedSearchTerm('가'.repeat(MARKET_SEARCH_TERM_MAX))).toHaveLength(
      MARKET_SEARCH_TERM_MAX,
    );
    expect(relatedSearchTerm('가'.repeat(MARKET_SEARCH_TERM_MAX + 1))).toBeUndefined();
  });

  it('takes whatever the picker’s box can hold, so a pasted title past the bound still searches', () => {
    // Review on #65: the box had no maxLength, and a pasted title (up to MARKET_TITLE_MAX) read
    // as no term. The box now holds SEARCH_INPUT_MAX_LENGTH, which a browser counts in UTF-16
    // units and the schema in code points: a full box of anything, padded, is a term.
    expect(SEARCH_INPUT_MAX_LENGTH).toBe(MARKET_SEARCH_TERM_MAX);
    expect(MARKET_TITLE_MAX).toBeGreaterThan(SEARCH_INPUT_MAX_LENGTH);
    for (const q of [
      '가'.repeat(SEARCH_INPUT_MAX_LENGTH),
      '\u{1F327}'.repeat(SEARCH_INPUT_MAX_LENGTH / 2),
      ` ${'비'.repeat(SEARCH_INPUT_MAX_LENGTH - 2)} `,
      // A title of MARKET_TITLE_MAX pasted into the box keeps its first SEARCH_INPUT_MAX_LENGTH.
      '첫눈'.repeat(MARKET_TITLE_MAX / 2).slice(0, SEARCH_INPUT_MAX_LENGTH),
    ]) {
      expect(q).toHaveLength(SEARCH_INPUT_MAX_LENGTH);
      expect(relatedSearchTerm(q), q).toBe(q.trim());
    }
  });

  it('asks again when 찾기 is pressed on the term already searched, and clears on a blank box', () => {
    // Review on #65: the search is keyed on its term, so a failed search pressed again with the
    // same text set an equal term and sent nothing.
    expect(relatedSearchSubmit('첫눈', undefined)).toEqual({ term: '첫눈', refetch: false });
    expect(relatedSearchSubmit('  첫눈 ', '첫눈')).toEqual({ term: '첫눈', refetch: true });
    expect(relatedSearchSubmit('부산', '첫눈')).toEqual({ term: '부산', refetch: false });
    expect(relatedSearchSubmit('   ', '첫눈')).toEqual({ term: undefined, refetch: false });
    expect(relatedSearchSubmit('', undefined)).toEqual({ term: undefined, refetch: false });
  });

  it('asks for the term and the cursor only when there is one', () => {
    expect(relatedSearchQuery('첫눈')).toEqual({ q: '첫눈' });
    expect(relatedSearchQuery('첫눈', 'c')).toEqual({ q: '첫눈', cursor: 'c' });
  });
});

describe('relatedHint (the admin panel, #65)', () => {
  it('names the statuses a detail shows by the labels the panel badges markets with', () => {
    const hint = relatedHint();
    // Review on #65: the hint said '거래 중' for `open`, whose badge right under it reads '진행 중'.
    expect(hint).toBe(
      `${copy.adminRelatedHint} ${copy.adminRelatedHintShownLead} ` +
        `${copy.marketStatusOpen}·${copy.marketStatusClosed}·${copy.marketStatusResolved}·` +
        `${copy.marketStatusSettled}${copy.adminRelatedHintShownTail} ${copy.adminRelatedHintNoEffect}`,
    );
    expect(hint).not.toContain('거래 중');
    // Every shown status by its label, and neither hidden one (ADR-0061 decision 1, item 19).
    for (const status of MARKET_STATUSES) {
      const label = MARKET_STATUS_LABEL[status];
      expect(hint.includes(label), status).toBe(RELATED_MARKET_STATUSES.includes(status as never));
    }
  });
});

describe('relatedLinkErrorMessage', () => {
  it('says a market cannot be related to itself when the API names the field that sent it', () => {
    // The link's body field, and the unlink's path param (an unlink has no body).
    for (const field of ['marketId', 'relatedMarketId']) {
      expect(
        relatedLinkErrorMessage(
          apiError(400, 'VALIDATION_ERROR', [{ path: [field], message: 'must be another market' }]),
        ),
        field,
      ).toBe(copy.errRelatedSelf);
    }
  });

  it('says the market is gone for NOT_FOUND, and falls back for the rest', () => {
    expect(relatedLinkErrorMessage(apiError(404, 'NOT_FOUND'))).toBe(copy.adminMarketNotFound);
    expect(relatedLinkErrorMessage(apiError(400, 'VALIDATION_ERROR'))).toBe(copy.errUnknown);
    expect(relatedLinkErrorMessage(new Error('network'))).toBe(copy.errUnknown);
  });
});
