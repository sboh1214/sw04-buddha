import { hashKey } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import type { ThemeSummary } from './api';
import { MARKETS_KEY, dehydratePublic, isPrivateQueryKey, relatedMarketsKey } from './market-keys';
import { getQueryClient } from './query-client';
import {
  HOME_THEMES_KEY,
  HOME_THEMES_LIMIT,
  THEMES_KEY,
  THEME_LIST_KEY,
  THEME_STATUS_LABEL,
  formatThemePeriod,
  homeThemesQuery,
  homeThemesRow,
  linkedTextParts,
  marketThemesKey,
  prefetchHomeThemes,
  prefetchThemeMarkets,
  showsHomeThemes,
  themeKey,
  themeLinkLabel,
  themeMarketsKey,
  themePageQuery,
  themePath,
  themeResultLabel,
  themeResultsKey,
  themeSlugParam,
} from './themes';

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

describe('theme keys (#81, ADR-0088)', () => {
  it('keys every theme read on the lower-cased id, all public', () => {
    for (const key of [
      themeKey(ID.toUpperCase()),
      themeResultsKey(ID.toUpperCase()),
      marketThemesKey(ID.toUpperCase()),
      themeMarketsKey(ID.toUpperCase()),
    ]) {
      expect(key.at(-1)).toBe(ID);
      expect(isPrivateQueryKey(key)).toBe(false);
    }
    for (const key of [THEME_LIST_KEY, HOME_THEMES_KEY]) expect(isPrivateQueryKey(key)).toBe(false);
  });

  it('puts the page, the list, the home row, the results and the links under one root', () => {
    for (const key of [
      THEME_LIST_KEY,
      HOME_THEMES_KEY,
      themeKey(ID),
      themeResultsKey(ID),
      marketThemesKey(ID),
    ]) {
      expect(key.slice(0, THEMES_KEY.length)).toEqual([...THEMES_KEY]);
    }
  });

  it("puts a theme's cards under the public market lists, apart from 관련 시장's", () => {
    // Under ['markets'], so the card join, the socket's card writes and the reconnect reach them.
    expect(themeMarketsKey(ID).slice(0, MARKETS_KEY.length)).toEqual([...MARKETS_KEY]);
    expect(hashKey(themeMarketsKey(ID))).not.toBe(hashKey(relatedMarketsKey(ID)));
  });
});

describe('theme requests', () => {
  it('sends the cursor only when there is one', () => {
    expect(themePageQuery()).toEqual({});
    expect(themePageQuery('c')).toEqual({ cursor: 'c' });
  });

  it('asks the home for the first few published themes, of every status', () => {
    expect(homeThemesQuery()).toEqual({ limit: HOME_THEMES_LIMIT });
    expect(HOME_THEMES_LIMIT).toBe(6);
  });

  it('shows the home row on 전체 only: not under a category, not in the 관심 시장 view', () => {
    expect(showsHomeThemes({ sort: 'recommended' })).toBe(true);
    expect(showsHomeThemes({ sort: 'newest' })).toBe(true);
    expect(showsHomeThemes({ sort: 'recommended', category: 'economy' })).toBe(false);
    expect(showsHomeThemes({ watchlist: true, sort: 'watched' })).toBe(false);
  });
});

describe('homeThemesRow (owner decision 2026-10-19, second round)', () => {
  const theme = (id: string, status: ThemeSummary['status']): ThemeSummary => ({
    id,
    slug: `theme-${id}`,
    name: `테마 ${id}`,
    startDate: '2026-10-20',
    endDate: '2026-11-03',
    status,
  });

  it('shows the ongoing themes, and no upcoming one beside them', () => {
    const page = [theme('a', 'ongoing'), theme('b', 'ongoing'), theme('c', 'upcoming')];
    expect(homeThemesRow(page)).toEqual({ status: 'ongoing', themes: page.slice(0, 2) });
  });

  it('shows the upcoming themes when none is ongoing, and no ended one beside them', () => {
    const page = [theme('a', 'upcoming'), theme('b', 'ended')];
    expect(homeThemesRow(page)).toEqual({ status: 'upcoming', themes: page.slice(0, 1) });
  });

  it('keeps the row, with no card, while every public theme has ended — 모든 테마 stays', () => {
    expect(homeThemesRow([theme('a', 'ended')])).toEqual({ status: null, themes: [] });
  });

  it('has no row at all only when no theme is public', () => {
    expect(homeThemesRow([])).toBeNull();
  });
});

describe('formatThemePeriod (owner decisions 2026-10-19)', () => {
  /** An instant of 2026 in Korea: the year the reader is in. */
  const IN_2026 = Date.parse('2026-10-19T12:00:00+09:00');

  it("writes Korean dates as '10월 20일 ~ 11월 3일', with no leading zero, in this year", () => {
    expect(formatThemePeriod({ startDate: '2026-10-20', endDate: '2026-11-03' }, IN_2026)).toBe(
      '10월 20일 ~ 11월 3일',
    );
  });

  it('writes a one-day theme as its one date', () => {
    expect(formatThemePeriod({ startDate: '2026-10-20', endDate: '2026-10-20' }, IN_2026)).toBe(
      '10월 20일',
    );
    expect(formatThemePeriod({ startDate: '2025-10-20', endDate: '2025-10-20' }, IN_2026)).toBe(
      '2025년 10월 20일',
    );
  });

  it('writes the year once when the period is wholly in another year', () => {
    // The owner's example: a theme of last year.
    expect(formatThemePeriod({ startDate: '2025-10-20', endDate: '2025-11-03' }, IN_2026)).toBe(
      '2025년 10월 20일 ~ 11월 3일',
    );
    expect(formatThemePeriod({ startDate: '2027-03-02', endDate: '2027-03-09' }, IN_2026)).toBe(
      '2027년 3월 2일 ~ 3월 9일',
    );
  });

  it('writes both years when the period crosses one, so it never reads backwards', () => {
    expect(formatThemePeriod({ startDate: '2026-12-20', endDate: '2027-01-03' }, IN_2026)).toBe(
      '2026년 12월 20일 ~ 2027년 1월 3일',
    );
    expect(formatThemePeriod({ startDate: '2025-12-20', endDate: '2026-01-03' }, IN_2026)).toBe(
      '2025년 12월 20일 ~ 2026년 1월 3일',
    );
  });

  it("reads this year at the Korean date of the read, not the reader's UTC date", () => {
    const period = { startDate: '2027-01-01', endDate: '2027-01-31' };
    // 2027-01-01 00:30 in Korea is still 2026 in UTC: the dates are this year's.
    expect(formatThemePeriod(period, Date.parse('2026-12-31T15:30:00Z'))).toBe(
      '1월 1일 ~ 1월 31일',
    );
    expect(formatThemePeriod(period, Date.parse('2026-12-31T14:30:00Z'))).toBe(
      '2027년 1월 1일 ~ 1월 31일',
    );
  });

  it('writes the dates as they are, whatever the time zone (no instant is converted)', () => {
    // The same text the server rendered: a date has no zone to convert.
    expect(formatThemePeriod({ startDate: '2026-01-01', endDate: '2026-01-31' }, IN_2026)).toBe(
      '1월 1일 ~ 1월 31일',
    );
  });
});

describe('labels and addresses', () => {
  it('labels the three statuses 예정·진행 중·종료', () => {
    expect(THEME_STATUS_LABEL).toEqual({ upcoming: '예정', ongoing: '진행 중', ended: '종료' });
  });

  it("names a market detail's theme link with its status, an ended theme too (owner decision 2026-10-19, second round)", () => {
    expect(themeLinkLabel({ name: '노벨상 주간', status: 'ongoing' })).toBe(
      '노벨상 주간 · 진행 중',
    );
    expect(themeLinkLabel({ name: '노벨상 주간', status: 'upcoming' })).toBe('노벨상 주간 · 예정');
    expect(themeLinkLabel({ name: '노벨상 주간', status: 'ended' })).toBe('노벨상 주간 · 종료');
  });

  it("writes a result as the contract's YES or NO, and a VOID result 무효 (#174)", () => {
    expect(themeResultLabel({ result: 'YES' })).toBe(copy.yes);
    expect(themeResultLabel({ result: 'NO' })).toBe(copy.no);
    expect(themeResultLabel({ result: 'VOID' })).toBe('무효');
  });

  it('addresses a theme by its slug and reads the segment back however it arrived', () => {
    expect(themePath('2026-election')).toBe('/themes/2026-election');
    expect(themeSlugParam('2026-election')).toBe('2026-election');
    expect(themeSlugParam(encodeURIComponent('노벨상-주간'))).toBe('노벨상-주간');
    expect(themeSlugParam('노벨상-주간')).toBe('노벨상-주간');
    // A stray % does not decode: passed on, for the API to answer as an unknown theme.
    expect(themeSlugParam('%E0%A4%A')).toBe('%E0%A4%A');
  });
});

describe('linkedTextParts (owner decisions 2026-10-19: notices and introductions, web addresses linked)', () => {
  const links = (text: string) =>
    linkedTextParts(text)
      .filter((part) => part.kind === 'link')
      .map((part) => part.text);

  it('keeps plain text as one run, line breaks and all', () => {
    expect(linkedTextParts('첫 줄\n둘째 줄')).toEqual([{ kind: 'text', text: '첫 줄\n둘째 줄' }]);
    expect(linkedTextParts('')).toEqual([]);
  });

  it('links http and https addresses between the words around them', () => {
    expect(linkedTextParts('일정은 https://example.com/a?b=1#c 에서 봅니다')).toEqual([
      { kind: 'text', text: '일정은 ' },
      { kind: 'link', text: 'https://example.com/a?b=1#c', href: 'https://example.com/a?b=1#c' },
      { kind: 'text', text: ' 에서 봅니다' },
    ]);
    expect(links('http://a.kr 그리고 https://b.kr')).toEqual(['http://a.kr', 'https://b.kr']);
  });

  it('ends an address at Korean text written right after it', () => {
    expect(links('주소는 https://example.com에서 확인')).toEqual(['https://example.com']);
    expect(links('주소는 https://example.com/a에서 확인')).toEqual(['https://example.com/a']);
  });

  it('goes on through a Korean path segment or query value, which a particle hardly follows', () => {
    expect(
      links('자세한 내용은 https://ko.wikipedia.org/wiki/제22대_국회의원_선거 를 보세요'),
    ).toEqual(['https://ko.wikipedia.org/wiki/제22대_국회의원_선거']);
    // This service's own Korean slugs, a theme's or a market's.
    expect(links('https://buddha.kr/themes/2026-선거 참고')).toEqual([
      'https://buddha.kr/themes/2026-선거',
    ]);
    expect(links('https://namu.wiki/w/서울.')).toEqual(['https://namu.wiki/w/서울']);
    expect(links('https://search.naver.com/search.naver?query=선거&where=news 에서')).toEqual([
      'https://search.naver.com/search.naver?query=선거&where=news',
    ]);
    const text = '보기: https://ko.wikipedia.org/wiki/서울_(도시), 끝';
    expect(links(text)).toEqual(['https://ko.wikipedia.org/wiki/서울_(도시)']);
    expect(
      linkedTextParts(text)
        .map((part) => part.text)
        .join(''),
    ).toBe(text);
  });

  it("leaves a sentence's closing punctuation and parenthesis out of the link", () => {
    expect(links('보세요: https://example.com.')).toEqual(['https://example.com']);
    expect(links('(https://example.com/x)')).toEqual(['https://example.com/x']);
    expect(links('https://example.com, 그리고')).toEqual(['https://example.com']);
    // A parenthesis the address opened itself stays.
    expect(links('https://ko.wikipedia.org/wiki/A_(B)')).toEqual([
      'https://ko.wikipedia.org/wiki/A_(B)',
    ]);
    // The punctuation is still in the text that follows.
    expect(linkedTextParts('https://example.com.').at(-1)).toEqual({ kind: 'text', text: '.' });
  });

  it('links nothing but http and https', () => {
    expect(links('javascript:alert(1) ftp://example.com mailto:a@b.kr www.example.com')).toEqual(
      [],
    );
    expect(links('https://')).toEqual([]);
  });

  it('gives back every character of the text, in order', () => {
    const text = '공지 https://a.kr/x, (https://b.kr) 끝.\n다음 줄 http://c.kr';
    expect(
      linkedTextParts(text)
        .map((part) => part.text)
        .join(''),
    ).toBe(text);
  });
});

describe('the server reads', () => {
  it("dehydrates a theme's first market page under the section's key, tried once", async () => {
    const queryClient = getQueryClient();
    await prefetchThemeMarkets(queryClient, ID, () =>
      Promise.resolve({ items: [], nextCursor: 'next' }),
    );
    const dehydrated = dehydratePublic(queryClient);
    expect(dehydrated.queries.map((query) => query.queryKey)).toEqual([themeMarketsKey(ID)]);

    let calls = 0;
    const failing = getQueryClient();
    await prefetchThemeMarkets(failing, ID, () => {
      calls += 1;
      return Promise.reject(new Error('down'));
    });
    expect(calls).toBe(1);
    expect(dehydratePublic(failing).queries).toEqual([]);
  });

  it("dehydrates the home's theme row, and nothing when the read failed", async () => {
    const queryClient = getQueryClient();
    await prefetchHomeThemes(queryClient, () => Promise.resolve([]));
    expect(dehydratePublic(queryClient).queries.map((query) => query.queryKey)).toEqual([
      HOME_THEMES_KEY,
    ]);
    const failing = getQueryClient();
    await prefetchHomeThemes(failing, () => Promise.reject(new Error('down')));
    expect(dehydratePublic(failing).queries).toEqual([]);
  });
});
