import { MARKET_SEARCH_TERM_MAX, MARKET_SORTS, PUBLIC_MARKET_STATUSES } from '@buddha/shared';
import { hashKey } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ApiError, type Category, type MarketSummary, unwrap } from './api';
import { groupCategories } from './category-tree';
import { MARKET_STATUS_LABEL } from './market-admin';
import { DEFAULT_SEARCH_FILTERS, type SearchFilters, marketSearchKey } from './market-keys';
import { type MarketPages } from './market-live';
import { currentSearchTerm } from './nav';
import {
  SEARCH_INPUT_MAX_LENGTH,
  SEARCH_PATH,
  isMarketSearch,
  recentSearchPath,
  type SearchBoxOwner,
  searchBoxKey,
  searchBoxOwner,
  searchCategoryOptions,
  searchErrorMessage,
  searchFiltersFromSearchParams,
  searchFormFields,
  searchPath,
  searchQuery,
  searchScreenBody,
  searchStatusOptions,
  searchToRecord,
  seedsSearchResults,
  tagSearchPath,
} from './market-search';

/**
 * 시장 검색 (#15, ADR-0066): the screen's URL and its decisions. Owner decisions pinned here
 * (ADR-0061): every public status first and a choice per status label (decision 1, item 13), the
 * home's three orders starting on 추천 (item 14), and with no term the member's recent searches
 * or a prompt (decision 3, the #15 rows) — recording a signed-in member's submitted term, and a
 * recent search they picked as a new search (owner decision 2026-10-16, ADR-0066), only.
 */

const category = (id: number, slug: string, nameKo: string, parentId: number | null): Category => ({
  id,
  slug,
  nameKo,
  sortOrder: id * 10,
  parentId,
});

const TREE = groupCategories([
  category(1, 'economy', '경제', null),
  category(2, 'weather', '날씨', null),
  category(11, 'housing', '부동산', 1),
  category(12, 'jobs', '고용', 1),
  category(21, 'rain', '강수', 2),
]);

describe('searchFiltersFromSearchParams', () => {
  it('starts on every public status and 추천, with no term and no category', () => {
    expect(searchFiltersFromSearchParams({})).toEqual(DEFAULT_SEARCH_FILTERS);
    expect(DEFAULT_SEARCH_FILTERS).toEqual({ status: 'all', sort: 'recommended' });
  });

  it('keeps a term, trimmed, and each status, order and category', () => {
    expect(
      searchFiltersFromSearchParams({
        q: '  금리 ',
        status: 'closed',
        sort: 'closing',
        category: ' economy ',
      }),
    ).toEqual({ q: '금리', status: 'closed', sort: 'closing', category: 'economy' });
    for (const status of [...PUBLIC_MARKET_STATUSES, 'all'] as const) {
      expect(searchFiltersFromSearchParams({ q: 'x', status }).status).toBe(status);
    }
    for (const sort of MARKET_SORTS) {
      expect(searchFiltersFromSearchParams({ q: 'x', sort }).sort).toBe(sort);
    }
  });

  it('drops what the screen cannot show rather than redirecting', () => {
    // A draft is no public status, the volume order is gone (item 11) and 최근 관심 등록 순 is the
    // watchlist's: each falls back to its default.
    expect(searchFiltersFromSearchParams({ q: 'x', status: 'draft', sort: 'volume' })).toEqual({
      ...DEFAULT_SEARCH_FILTERS,
      q: 'x',
    });
    // Nor is one in review (ADR-0093 decision 1, item 12), and a bookmarked `voided` names a
    // status #174 removed (VOID is a result now): both fall back to every status.
    for (const status of ['review', 'voided']) {
      expect(searchFiltersFromSearchParams({ q: 'x', status }).status, status).toBe('all');
    }
    expect(searchFiltersFromSearchParams({ q: 'x', sort: 'watched' }).sort).toBe('recommended');
    // A blank, over-long or NUL term is no term: the screen shows what it shows with none.
    for (const q of ['', '   ', 'y'.repeat(101), 'a\u0000b']) {
      expect('q' in searchFiltersFromSearchParams({ q }), JSON.stringify(q)).toBe(false);
    }
    expect('category' in searchFiltersFromSearchParams({ category: '  ' })).toBe(false);
  });

  it('searches and records whatever a search box can hold (its maxLength, in UTF-16 units)', () => {
    // The boxes' `maxLength` counts UTF-16 units; the schema counts code points. So a full box of
    // anything — Latin, Hangul, astral characters (two units each), padded with spaces — is a
    // term the screen searches, the header shows and a member's submit records, never 'no term'.
    expect(SEARCH_INPUT_MAX_LENGTH).toBe(MARKET_SEARCH_TERM_MAX);
    const full = [
      'x'.repeat(SEARCH_INPUT_MAX_LENGTH),
      '가'.repeat(SEARCH_INPUT_MAX_LENGTH),
      '\u{1F327}'.repeat(SEARCH_INPUT_MAX_LENGTH / 2),
      ` ${'비'.repeat(SEARCH_INPUT_MAX_LENGTH - 2)} `,
    ];
    for (const q of full) {
      expect(q).toHaveLength(SEARCH_INPUT_MAX_LENGTH);
      expect(searchFiltersFromSearchParams({ q }).q, q).toBe(q.trim());
      expect(currentSearchTerm(SEARCH_PATH, new URLSearchParams({ q })), q).toBe(q.trim());
      expect(searchToRecord(q, 'user-a')?.query, q).toBe(q.trim());
    }
    // One unit more than the box holds is past the bound, which is what the box keeps out.
    expect(
      'q' in searchFiltersFromSearchParams({ q: 'x'.repeat(SEARCH_INPUT_MAX_LENGTH + 1) }),
    ).toBe(false);
  });

  it('takes the first value of a repeated param', () => {
    expect(
      searchFiltersFromSearchParams({
        q: ['비', '눈'],
        status: ['cancelled', 'open'],
        sort: ['newest', 'closing'],
        category: ['weather', 'economy'],
      }),
    ).toEqual({ q: '비', status: 'cancelled', sort: 'newest', category: 'weather' });
  });

  it('keys one search once, however its URL was spelled', () => {
    const a = searchFiltersFromSearchParams({ q: 'rain', status: 'all', sort: 'recommended' });
    const b = searchFiltersFromSearchParams({ sort: 'recommended', q: ' rain ' });
    if (!isMarketSearch(a) || !isMarketSearch(b)) throw new Error('expected a search');
    expect(hashKey(marketSearchKey(a))).toBe(hashKey(marketSearchKey(b)));
  });
});

describe('searchPath and searchQuery', () => {
  it('leaves every default out, so a bare search is /search?q=…', () => {
    expect(searchPath(DEFAULT_SEARCH_FILTERS)).toBe(SEARCH_PATH);
    expect(SEARCH_PATH).toBe('/search');
    expect(searchPath({ ...DEFAULT_SEARCH_FILTERS, q: '금리' })).toBe(
      `/search?q=${encodeURIComponent('금리')}`,
    );
    expect(searchQuery({ q: 'x', status: 'closed', sort: 'newest', category: 'economy' })).toEqual({
      q: 'x',
      status: 'closed',
      category: 'economy',
      sort: 'newest',
    });
    expect(searchPath({ q: 'x', status: 'closed', sort: 'newest', category: 'economy' })).toBe(
      '/search?q=x&status=closed&category=economy&sort=newest',
    );
  });

  it('round-trips through searchFiltersFromSearchParams for every status and order', () => {
    const views: SearchFilters[] = [DEFAULT_SEARCH_FILTERS];
    for (const status of [...PUBLIC_MARKET_STATUSES, 'all'] as const) {
      for (const sort of MARKET_SORTS) views.push({ q: '금리', status, sort, category: 'jobs' });
    }
    for (const view of views) {
      expect(searchFiltersFromSearchParams(searchQuery(view))).toEqual(view);
    }
  });

  it('gives the screen’s box the filters on screen beside its term, never the term itself', () => {
    // The screen's box refines: a new term is searched within what is picked.
    expect(
      searchFormFields({ q: '금리', status: 'closed', sort: 'closing', category: 'economy' }),
    ).toEqual([
      ['status', 'closed'],
      ['category', 'economy'],
      ['sort', 'closing'],
    ]);
    expect(searchFormFields({ ...DEFAULT_SEARCH_FILTERS, q: '금리' })).toEqual([]);
  });

  it('runs a recent search within the filters on screen: the filters were never recorded', () => {
    const filters: SearchFilters = { status: 'closed', sort: 'newest' };
    expect(recentSearchPath(filters, '금리')).toBe(
      `/search?q=${encodeURIComponent('금리')}&status=closed&sort=newest`,
    );
    expect(recentSearchPath(DEFAULT_SEARCH_FILTERS, 'rain')).toBe('/search?q=rain');
  });

  it("opens a tag's own search: its name as the term, every filter the screen's default (#17)", () => {
    expect(tagSearchPath('서울')).toBe(`/search?q=${encodeURIComponent('서울')}`);
    // The characters a tag may hold come back as the same term, spaces and '&' and '+' included.
    for (const name of ['S&P500', 'C++', '한국 영화', '원·달러', 'K-팝']) {
      const query = new URL(tagSearchPath(name), 'https://buddha.test').searchParams;
      expect(searchFiltersFromSearchParams({ q: query.get('q') ?? undefined }), name).toEqual({
        ...DEFAULT_SEARCH_FILTERS,
        q: name,
      });
    }
  });
});

describe('searchStatusOptions', () => {
  it('is 모든 상태, then one per public status, labelled as the badge is (ADR-0061 decision 1)', () => {
    // ADR-0093 decision 3, the #174 row: every public status, 취소 included, in lifecycle order.
    const options = searchStatusOptions();
    expect(options.map((option) => option.value)).toEqual([
      'all',
      'scheduled',
      'open',
      'paused',
      'closed',
      'provisional',
      'resolved',
      'settling',
      'settled',
      'cancelled',
    ]);
    expect(options.map((option) => option.label)).toEqual([
      copy.searchStatusAll,
      '개장 예정',
      '거래 중',
      '거래 일시 중단',
      '거래 마감',
      '잠정 결과',
      '결과 확정',
      '지급 중',
      '지급 완료',
      '취소',
    ]);
    // A result is no status: no 무효 choice (nor '판정 지연', a display #22·#142 bring).
    expect(options.map((option) => option.label)).not.toContain(copy.marketResultVoid);
    // One per label: no two statuses share one.
    for (const status of PUBLIC_MARKET_STATUSES) {
      expect(options.find((option) => option.value === status)?.label).toBe(
        MARKET_STATUS_LABEL[status],
      );
    }
    expect(new Set(options.map((option) => option.label)).size).toBe(options.length);
    expect(options.map((option) => option.value)).not.toContain('draft');
    expect(options.map((option) => option.value)).not.toContain('review');
  });
});

describe('searchCategoryOptions', () => {
  it('groups each top-level category with itself first, then its leaves', () => {
    expect(searchCategoryOptions(TREE, undefined)).toEqual({
      groups: [
        {
          label: '경제',
          options: [
            { value: 'economy', label: `경제 ${copy.marketsAll}` },
            { value: 'housing', label: '부동산' },
            { value: 'jobs', label: '고용' },
          ],
        },
        {
          label: '날씨',
          options: [
            { value: 'weather', label: `날씨 ${copy.marketsAll}` },
            { value: 'rain', label: '강수' },
          ],
        },
      ],
      unlisted: undefined,
    });
  });

  it('offers a slug the tree does not know as it is, so the select never claims 모든 카테고리', () => {
    expect(searchCategoryOptions(TREE, 'housing').unlisted).toBeUndefined();
    expect(searchCategoryOptions(TREE, 'economy').unlisted).toBeUndefined();
    expect(searchCategoryOptions(TREE, 'retired').unlisted).toBe('retired');
    expect(searchCategoryOptions([], 'economy').unlisted).toBe('economy');
  });
});

describe('searchScreenBody', () => {
  const signedIn = { pending: false, signedIn: true };
  const signedOut = { pending: false, signedIn: false };
  const unknown = { pending: true, signedIn: false };

  it('lists the results of a term for anyone: the search is public (item 18)', () => {
    const search = { ...DEFAULT_SEARCH_FILTERS, q: '금리' };
    for (const session of [signedIn, signedOut, unknown]) {
      expect(searchScreenBody(search, session)).toBe('results');
    }
  });

  it('with no term, the member’s recent searches or a prompt — after the session is known', () => {
    // ADR-0061 decision 3, the #15 rows. Until the session is known (the server render and
    // hydration) neither is drawn, so the HTML is the same for every visitor.
    const filters: SearchFilters = { status: 'closed', sort: 'closing' };
    expect(searchScreenBody(filters, signedIn)).toBe('recent');
    expect(searchScreenBody(filters, signedOut)).toBe('prompt');
    expect(searchScreenBody(filters, unknown)).toBe('pending');
    expect(searchScreenBody(DEFAULT_SEARCH_FILTERS, { pending: true, signedIn: true })).toBe(
      'pending',
    );
  });
});

describe('searchToRecord', () => {
  it('records a signed-in member’s term, trimmed, as the account on screen', () => {
    expect(searchToRecord('  금리 인상 ', 'user-a')).toEqual({
      query: '금리 인상',
      expectedAccountId: 'user-a',
    });
    expect(searchToRecord('x'.repeat(100), 'user-a')?.query).toHaveLength(100);
  });

  it('records nothing for a visitor or a session not yet known (ADR-0061 decision 3)', () => {
    expect(searchToRecord('금리', undefined)).toBeUndefined();
  });

  it('records a recent search picked from the list as a new search of the term its link runs', () => {
    // Owner decision 2026-10-16 (ADR-0066): "새 검색으로 기록". The entry's stored term is what
    // the click records and what its link searches, one string, so the new record is the same
    // entry (distinct by the term) and moves it to the top — whatever filters are on screen,
    // which the link keeps and the record never holds.
    for (const query of ['금리', 'Rain 100mm', '%_\\', '한'.repeat(MARKET_SEARCH_TERM_MAX)]) {
      for (const filters of [
        DEFAULT_SEARCH_FILTERS,
        { status: 'closed', sort: 'newest', category: 'economy' } satisfies SearchFilters,
      ]) {
        const linked = new URL(recentSearchPath(filters, query), 'http://localhost');
        const searched = searchFiltersFromSearchParams({
          q: linked.searchParams.get('q') ?? undefined,
        }).q;
        expect(searchToRecord(query, 'user-a'), query).toEqual({
          query: searched,
          expectedAccountId: 'user-a',
        });
      }
    }
  });

  it('records nothing for a term the list would not search', () => {
    for (const raw of ['', '   ', 'x'.repeat(101), 'a\u0000b', null, 7, new Blob(['금리'])]) {
      expect(searchToRecord(raw, 'user-a'), typeof raw).toBeUndefined();
    }
  });
});

describe('searchBoxOwner and searchBoxKey', () => {
  // The box's key over the `Me` ids it is drawn for, in order (`useSearchBoxTurn`): `undefined` is
  // nobody known — `GET /me` pending or failed, SessionCacheGuard's reset, a sign-out. `from` is
  // the last account the tab knew when the box was drawn.
  const keysOver = (ids: (string | undefined)[], from?: string, term = '금리') => {
    let owner: SearchBoxOwner = { accountId: from, turn: 0 };
    return ids.map((id) => {
      owner = searchBoxOwner(owner, id);
      return searchBoxKey(owner.turn, term);
    });
  };

  it('keeps the box through `GET /me`’s first answer (owner decision 2026-10-26 «첫 답 전에 친 글자는 남김»)', () => {
    // A term typed before the tab knows any account stays once the first answer names one, and is
    // that account's: the key does not change, so the box is not drawn again.
    const [before, answered, again] = keysOver([undefined, 'user-a', 'user-a']);
    expect(answered).toBe(before);
    expect(again).toBe(before);
    expect(searchBoxOwner({ accountId: undefined, turn: 0 }, 'user-a')).toEqual({
      accountId: 'user-a',
      turn: 0,
    });
  });

  it('draws the box again when the account known turns into another (ADR-0091)', () => {
    // In place, before the session does (ADR-0090 결정 4-2): a draft typed for A is never submitted,
    // and recorded, for B.
    const [first, a, b, backToA] = keysOver([undefined, 'user-a', 'user-b', 'user-a']);
    expect(a).toBe(first);
    expect(b).not.toBe(a);
    expect(backToA).not.toBe(b);
    expect(backToA).not.toBe(a);
  });

  it('draws it again for B even with nobody known between A and B', () => {
    // SessionCacheGuard's reset puts `['me']` back to nothing before B's answer: that stretch is
    // not a first answer, so A's draft does not wait in the box for B.
    const [a, reset, b] = keysOver(['user-a', undefined, 'user-b']);
    expect(reset).toBe(a);
    expect(b).not.toBe(a);
    // Nobody known (a failed `GET /me`, a sign-out) clears nothing, and A again is no turn.
    const [, , aAgain] = keysOver(['user-a', undefined, 'user-a']);
    expect(aAgain).toBe(a);
  });

  it('starts a box drawn while nobody is known as the last account the tab knew', () => {
    // The search screen opened between the reset and B's answer: B is not the tab's first account.
    const [drawn, b] = keysOver([undefined, 'user-b'], 'user-a');
    expect(b).not.toBe(drawn);
    const [, a] = keysOver([undefined, 'user-a'], 'user-a');
    expect(a).toBe(drawn);
  });

  it('returns the same owner while nothing changes, so the box is not adjusted again', () => {
    const owner: SearchBoxOwner = { accountId: 'user-a', turn: 2 };
    expect(searchBoxOwner(owner, 'user-a')).toBe(owner);
    expect(searchBoxOwner(owner, undefined)).toBe(owner);
    expect(searchBoxOwner(owner, 'user-b')).toEqual({ accountId: 'user-b', turn: 3 });
  });

  it('is one key for each turn and term, so a box is drawn again when either changes', () => {
    // The URL's term (Back, a second search) and the turn.
    const keys = [
      searchBoxKey(0, undefined),
      searchBoxKey(1, undefined),
      searchBoxKey(0, '금리'),
      searchBoxKey(1, '금리'),
      // A term that holds the separator, or looks like a turn's.
      searchBoxKey(0, '1|금리'),
      searchBoxKey(1, '|금리'),
      searchBoxKey(10, '금리'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(searchBoxKey(1, '금리')).toBe(searchBoxKey(1, '금리'));
  });
});

describe('seedsSearchResults', () => {
  const card = { id: 'm1' } as MarketSummary;
  const pages = (...items: MarketSummary[][]): MarketPages => ({
    pages: items.map((page, index) => ({
      items: page,
      nextCursor: index < items.length - 1 ? `c${String(index)}` : null,
    })),
    pageParams: items.map((_, index) => (index === 0 ? undefined : `c${String(index - 1)}`)),
  });

  it('puts the server’s first page in the HTML when it holds a card (owner decision 2026-10-16)', () => {
    expect(seedsSearchResults(pages([card]))).toBe(true);
    expect(seedsSearchResults(pages([card], [card]))).toBe(true);
  });

  it('leaves an empty answer and a read that did not answer to the browser (N02 §3)', () => {
    // 'No results' and a failure are the browser's to show, from its own read: the HTML is then
    // the skeleton, never an empty state or an error the server decided.
    expect(seedsSearchResults(pages([]))).toBe(false);
    expect(seedsSearchResults({ pages: [], pageParams: [] })).toBe(false);
    expect(seedsSearchResults(undefined)).toBe(false);
  });
});

describe('searchErrorMessage', () => {
  it('never says no results: an unreachable server and an error answer each say so (N02 §3)', () => {
    expect(searchErrorMessage(new TypeError('Failed to fetch'))).toBe(copy.errNetwork);
    expect(searchErrorMessage(new ApiError(503, { code: 'INTERNAL', message: 'x' } as never))).toBe(
      copy.errUnknown,
    );
    for (const message of [copy.errNetwork, copy.errUnknown]) {
      expect(message).not.toBe(copy.marketsSearchEmpty);
    }
  });

  it('says the server cannot be reached for an answer the API did not write: the proxy’s 500, a gateway’s', () => {
    // The browser asks the web origin, and Next's rewrite answers a plain-text 500 when the API
    // is down; openapi-fetch hands that body over as text, so the error has no envelope.
    const proxied = (status: number, body: unknown) => {
      try {
        unwrap({ error: body as never, response: new Response(null, { status }) });
      } catch (error) {
        return error;
      }
      throw new Error('unwrap did not throw');
    };
    for (const status of [500, 502, 503, 504]) {
      expect(searchErrorMessage(proxied(status, 'Internal Server Error')), String(status)).toBe(
        copy.errNetwork,
      );
      expect(searchErrorMessage(proxied(status, { message: 'Bad Gateway' })), String(status)).toBe(
        copy.errNetwork,
      );
    }
    // The API's own answers, a 500 among them, reached it: the general message.
    const answered = { error: { code: 'INTERNAL', message: 'x' } };
    expect(searchErrorMessage(proxied(500, answered))).toBe(copy.errUnknown);
    // And a 4xx with no envelope is still an answer, not an outage.
    expect(searchErrorMessage(proxied(404, 'Not Found'))).toBe(copy.errUnknown);
  });
});
