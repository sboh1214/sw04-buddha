import { resolveRobots } from 'next/dist/build/webpack/loaders/metadata/resolve-route-data';
import { describe, expect, it } from 'vitest';
import robots from '@/app/robots';

/**
 * `/robots.txt` (`app/robots.ts`, #47, owner decision 2026-10-20 1): crawlers keep off `/api/`,
 * where the market detail's 토론 is read in the browser, and nothing else is closed — the market
 * detail stays indexed. The e2e reads the file Next serves (discussion.spec.ts). Here, not beside
 * the route: a file under `app/` named `robots.*` is a metadata route to the web endpoint registry
 * (excluded-features.test.ts).
 *
 * The text is rendered by Next's own `resolveRobots` — what the route serves — and read the two
 * ways crawlers read it, because they disagree on order: RFC 9309 (Google, Bing) takes the LONGEST
 * matching rule, while a first-match parser (Python's `urllib.robotparser`, which many scrapers
 * use) takes the FIRST matching line. Next writes a rule's `Allow` lines before its `Disallow`
 * lines, so an `allow: '/'` beside the `disallow` served `Allow: /` first and opened `/api/` to
 * every first-match crawler while the longest-match reading still looked closed.
 */

/** The `User-Agent: *` group's rules, in file order. */
function rulesOf(text: string): { allow: boolean; path: string }[] {
  const rules: { allow: boolean; path: string }[] = [];
  let inStar = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const [field = '', ...rest] = line.split(':');
    const value = rest.join(':').trim();
    const name = field.trim().toLowerCase();
    if (name === 'user-agent') inStar = value === '*';
    else if (inStar && (name === 'allow' || name === 'disallow') && value !== '') {
      rules.push({ allow: name === 'allow', path: value });
    }
  }
  return rules;
}

/** Whether a crawler that takes the FIRST matching line may fetch `path`. */
function firstMatchAllows(text: string, path: string): boolean {
  return rulesOf(text).find((rule) => path.startsWith(rule.path))?.allow ?? true;
}

/** Whether an RFC 9309 crawler (longest match, `Allow` on a tie) may fetch `path`. */
function longestMatchAllows(text: string, path: string): boolean {
  const matching = rulesOf(text).filter((rule) => path.startsWith(rule.path));
  if (matching.length === 0) return true;
  const longest = Math.max(...matching.map((rule) => rule.path.length));
  return matching.some((rule) => rule.path.length === longest && rule.allow);
}

describe('robots.txt', () => {
  it('closes /api/ to every crawler and nothing else', () => {
    expect(robots()).toEqual({ rules: { userAgent: '*', disallow: '/api/' } });
  });

  it('is served as two lines', () => {
    expect(
      resolveRobots(robots())
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== ''),
    ).toEqual(['User-Agent: *', 'Disallow: /api/']);
  });

  it('keeps /api/ closed and the pages open whichever way a crawler matches', () => {
    const text = resolveRobots(robots());
    for (const allows of [firstMatchAllows, longestMatchAllows]) {
      // The 토론's read, a post image and the rest of the API.
      expect(allows(text, '/api/v1/markets/3f2504e0-4f89-11d3-9a0c-0305e82c3301/posts')).toBe(
        false,
      );
      expect(allows(text, '/api/v1/media/a.webp')).toBe(false);
      expect(allows(text, '/api/v1/markets')).toBe(false);
      // The pages, the market detail first.
      expect(allows(text, '/markets/rate-cut-2026')).toBe(true);
      expect(allows(text, '/')).toBe(true);
      expect(allows(text, '/community')).toBe(true);
    }
  });

  it('would catch an Allow: / served ahead of the Disallow', () => {
    // The evaluators themselves: the file this route served before, read both ways.
    const before = resolveRobots({ rules: { userAgent: '*', allow: '/', disallow: '/api/' } });
    expect(before.split('\n').filter((line) => line !== '')).toEqual([
      'User-Agent: *',
      'Allow: /',
      'Disallow: /api/',
    ]);
    expect(longestMatchAllows(before, '/api/v1/markets/x/posts')).toBe(false);
    expect(firstMatchAllows(before, '/api/v1/markets/x/posts')).toBe(true);
  });
});
