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
  type RelatedSearchState,
  relatedSearchQuery,
  relatedSearchSection,
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

/** The search after its term answered: rows, no failure, no placeholder, no next page. */
const answered: RelatedSearchState = {
  isPending: false,
  isLoadingError: false,
  isRefetchError: false,
  error: null,
  isPlaceholderData: false,
  hasNextPage: false,
};

describe('relatedSearchSection (the picker’s results, #65)', () => {
  it('offers rows, and 더 보기 under them, only from the submitted term’s own answer', () => {
    expect(relatedSearchSection(answered, 3)).toEqual({ stale: false, body: 'rows', more: false });
    expect(relatedSearchSection({ ...answered, hasNextPage: true }, 20)).toEqual({
      stale: false,
      body: 'rows',
      more: true,
    });
  });

  it('reads pages held from the last term as pending: no row to link, no 더 보기', () => {
    // Codex review on #214: shown as ready, the last term's rows stood under the new one with a
    // live 연결 while a slow search ran. Whatever is held, and however it would otherwise read.
    for (const held of [
      { ...answered, isPlaceholderData: true, hasNextPage: true },
      { ...answered, isPlaceholderData: true, isRefetchError: true },
    ]) {
      expect(relatedSearchSection(held, 20)).toEqual({
        stale: false,
        body: 'pending',
        more: false,
      });
    }
  });

  it('keeps the other lists’ rungs: the first load, its failure, the empty line, a stale refresh', () => {
    expect(relatedSearchSection({ ...answered, isPending: true }, 0)).toEqual({
      stale: false,
      body: 'pending',
      more: false,
    });
    expect(relatedSearchSection({ ...answered, isLoadingError: true }, 0)).toEqual({
      stale: false,
      body: 'failed',
      more: false,
    });
    // No 더 보기 without a row to put it under.
    expect(relatedSearchSection({ ...answered, hasNextPage: true }, 0)).toEqual({
      stale: false,
      body: 'empty',
      more: false,
    });
    // A refresh that failed keeps its rows under the notice, 더 보기 included.
    expect(
      relatedSearchSection({ ...answered, isRefetchError: true, hasNextPage: true }, 20),
    ).toEqual({ stale: true, body: 'rows', more: true });
  });
});

describe('relatedHint (the admin panel, #65)', () => {
  it('names the markets a detail does not show, by the labels the panel badges them with', () => {
    const hint = relatedHint();
    // ADR-0093 decision 3, the #174 row: a detail leaves out a cancelled market and one whose
    // result is 무효 — the second is no status, so the hint names the hidden markets rather than
    // the eight shown statuses — besides the drafts and reviews no public page shows.
    expect(hint).toBe(
      `${copy.adminRelatedHint} ` +
        `${copy.marketStatusDraft}·${copy.marketStatusReview}·${copy.marketStatusCancelled}` +
        `${copy.adminRelatedHintHiddenStatusTail} ${copy.marketResultVoid}` +
        `${copy.adminRelatedHintHiddenResultTail} ${copy.adminRelatedHintNoEffect}`,
    );
    expect(hint).toBe(
      '연결한 두 시장은 서로의 상세에 관련 시장으로 보입니다. 초안·검수 중·취소인 시장과 결과가 ' +
        '무효인 시장은 상세에 보이지 않습니다. 연결은 두 시장의 규칙·거래·판정·정산을 바꾸지 않습니다.',
    );
    // Every status by its label exactly when a detail leaves it out — the shown ones are not
    // named (no label of one is inside another's, so `includes` reads one label alone).
    for (const status of MARKET_STATUSES) {
      const label = MARKET_STATUS_LABEL[status];
      expect(hint.includes(label), status).toBe(!RELATED_MARKET_STATUSES.includes(status as never));
    }
    expect(hint).toContain(copy.marketResultVoid);
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

  it('says the session changed when the cookie is another account’s (ADR-0092)', () => {
    expect(
      relatedLinkErrorMessage(
        apiError(403, 'FORBIDDEN', [
          { path: ['expectedAccountId'], message: 'session belongs to another account' },
        ]),
      ),
    ).toBe(copy.sessionChanged);
  });

  it('says the market is gone for NOT_FOUND, and falls back for the rest', () => {
    expect(relatedLinkErrorMessage(apiError(404, 'NOT_FOUND'))).toBe(copy.adminMarketNotFound);
    expect(relatedLinkErrorMessage(apiError(400, 'VALIDATION_ERROR'))).toBe(copy.errUnknown);
    expect(relatedLinkErrorMessage(new Error('network'))).toBe(copy.errUnknown);
  });
});
