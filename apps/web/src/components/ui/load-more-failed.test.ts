import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SRC, screenSources } from '@/test/screen-text';

/**
 * Every 더 보기 list says when its 더 보기 failed (owner decision 2026-10-20 7, ADR-0075 5-14): the
 * 토론, the community list, the comments, the home's, the search's and 관련 시장's market grid,
 * MY's lists (조치·신고 내역's two too, #50), the admin lists (the report queue and the action log
 * too, #50, #187's review list of repeated links, its rows and a row's entries, #139's account
 * restriction requests and #184's retention records) and the market picker (the write screen's and the community list's market
 * filter) —
 * each draws `LoadMoreFailed` first in its 더 보기 button's own condition
 * (`… && (<>`), so the two come and go together and a list with no 더 보기 says nothing (5-14(c));
 * on the list the button pages; with that list's own first-read failure message (5-14(a)). No
 * DOM under node, so the sources are read, per list: one more 더 보기 written without the notice,
 * a notice moved out of its button's condition or given another message fails here.
 *
 * And nothing that reads a paged list's query has a failure rung on `isError` alone: that flag is
 * true after a failed 더 보기 too, so such a rung swapped every row read so far for its error the
 * moment one 더 보기 failed — on the list's own screen (MY's 거래 내역 and 결제 내역 and the admin
 * lists did) and on any other screen reading the same query (the MY summary's 거래 내역 preview,
 * on its way back from the wallet tab). `readFailed` (lib/query-client.ts) leaves a 더 보기's
 * failure out. What the notice shows, and when, is query-client.test.ts's.
 */

const LOAD_MORE = '{copy.loadMore}';

/** Every screen source, by its path under src/. */
const sources = screenSources().map((file) => ({
  file: path.relative(SRC, file),
  text: readFileSync(file, 'utf8'),
}));

/** The screen sources that draw a 더 보기. */
const lists = sources.filter(({ text }) => text.includes(LOAD_MORE));

/**
 * What may stand between a button's condition and its notice: the fragment the two share
 * (`… && (<>`) and comments — nothing else, so the notice is drawn under exactly the button's
 * condition (a comment's text may not run past its own end).
 */
const OPENS_THE_BUTTONS_FRAGMENT = /&& \(\s*<>\s*(?:\{\/\*(?:(?!\*\/)[\s\S])*\*\/\}\s*)*$/;

/** The `LoadMoreFailed` elements of `text`: what each pages, its props, and the code around it. */
function noticesOf(
  text: string,
): { list: string; message: string; before: string; toButton: string }[] {
  const parts = text.split('<LoadMoreFailed');
  return parts.slice(1).map((after, index) => ({
    list: /^\s*list=\{(\w+)\}/.exec(after)?.[1] ?? '',
    message: /\bmessage=\{([^}]+)\}/.exec(after.slice(0, after.indexOf('/>')))?.[1] ?? '',
    before: parts.slice(0, index + 1).join('<LoadMoreFailed'),
    toButton: after.slice(0, after.indexOf(LOAD_MORE)),
  }));
}

/** The descriptions of `text`'s alerts of one status (`<Alert.Root status="…">`). */
function alertMessages(text: string, status: 'error' | 'warning'): Set<string> {
  const alert = new RegExp(
    `<Alert\\.Root status="${status}"[^>]*>((?:(?!</Alert\\.Root>)[\\s\\S])*)</Alert\\.Root>`,
    'g',
  );
  return new Set(
    [...text.matchAll(alert)].flatMap(
      (match) =>
        /<Alert\.Description>\{([^}]+)\}<\/Alert\.Description>/.exec(match[1] ?? '')?.[1] ?? [],
    ),
  );
}

/**
 * The messages `text` gives a first read that failed: `LoadFailed`'s (MY), or an error alert's
 * (the rest — a refresh notice is a `warning` alert).
 */
function firstReadMessages(text: string): Set<string> {
  const messages = alertMessages(text, 'error');
  for (const match of text.matchAll(/<LoadFailed\s+message=\{([^}]+)\}/g)) {
    if (match[1] !== undefined) messages.add(match[1]);
  }
  return messages;
}

/**
 * The lists `text` pages: `list.fetchNextPage()`, `fetchNextPage()` destructured from one, or the
 * comment list's `readMoreComments(list)` (hooks/use-comments.ts — its `fetchNextPage`, and the
 * pages read again from the first when the server no longer opens the cursor, ADR-0074 7-29).
 */
function pagedLists(text: string): string[] {
  return [
    ...[...text.matchAll(/void (\w+)\.fetchNextPage\(\)/g)].map((match) => match[1] ?? ''),
    ...[...text.matchAll(/void readMoreComments\((\w+)\)/g)].map((match) => match[1] ?? ''),
    ...(/void fetchNextPage\(\)/.test(text)
      ? [...text.matchAll(/\{[^}]*\bfetchNextPage\b[^}]*\}\s*=\s*(\w+);/g)].map(
          (match) => match[1] ?? '',
        )
      : []),
  ];
}

/**
 * The hooks whose query some 더 보기 pages: the hook each paged list is bound from in its own file
 * (`const list = useLedger()`), and the hooks whose lists the market grid pages (`<MarketGrid
 * list={…}>`). `useInfiniteQuery` written in place is that screen's own query.
 */
const pagedHooks = [
  ...new Set(
    sources.flatMap(({ text }) => {
      const gridLists = [...text.matchAll(/<MarketGrid\s+list=\{(\w+)\}/g)].map(
        (match) => match[1] ?? '',
      );
      return [...pagedLists(text), ...gridLists].flatMap((list) =>
        [...text.matchAll(new RegExp(`\\bconst ${list} = (use\\w+)\\(`, 'g'))].map(
          (match) => match[1] ?? '',
        ),
      );
    }),
  ),
]
  .filter((hook) => hook !== 'useInfiniteQuery')
  .sort();

describe('the notice above a 더 보기 that failed', () => {
  it('is drawn by every 더 보기 list, once per 더 보기', () => {
    // The walk found the lists the owner named, and the rest of this branch's.
    expect(lists.map(({ file }) => file).sort()).toEqual(
      [
        'app/admin/admins/admin-accounts.tsx',
        'app/admin/audit-failures/admin-audit-failures.tsx',
        'app/admin/coupons/admin-coupons.tsx',
        'app/admin/markets/[id]/admin-market-detail.tsx',
        'app/admin/markets/admin-markets.tsx',
        'app/admin/moderation/account-restriction-requests/admin-account-requests.tsx',
        'app/admin/moderation/actions/admin-moderation-actions.tsx',
        'app/admin/moderation/link-flags/admin-link-flags.tsx',
        'app/admin/notices/admin-notices.tsx',
        'app/admin/notices/notice-history.tsx',
        'app/admin/payments/admin-payments.tsx',
        'app/admin/reports/admin-reports.tsx',
        'app/admin/retention/admin-retention-purges.tsx',
        'app/admin/settings/admin-release-settings.tsx',
        'app/admin/users/admin-users.tsx',
        'app/community/community-screen.tsx',
        'app/market-list.tsx',
        'app/markets/[slug]/market-discussion.tsx',
        'app/my/moderation/my-moderation.tsx',
        'app/my/portfolio.tsx',
        'app/my/wallet/ledger-list.tsx',
        'app/my/wallet/payment-history.tsx',
        'app/my/watchlist/watchlist.tsx',
        'components/authored/authored-list.tsx',
        'components/post/comments-section.tsx',
        'components/post/market-picker.tsx',
      ].sort(),
    );
    for (const { file, text } of lists) {
      expect(noticesOf(text).length, file).toBe(text.split(LOAD_MORE).length - 1);
    }
  });

  it("stands first in its button's own condition, on the list that button pages", () => {
    for (const { file, text } of lists) {
      for (const { list, before, toButton } of noticesOf(text)) {
        expect(list, file).not.toBe('');
        // Opens the fragment the button's condition draws, so where no 더 보기 is offered — the
        // MY summary's 관심 시장 preview, a last page — it is not drawn either (5-14(c)).
        expect(before, `${file}: ${list}`).toMatch(OPENS_THE_BUTTONS_FRAGMENT);
        // The button is in that same fragment: no fragment closes and no other notice comes
        // before it.
        expect(toButton, `${file}: ${list}`).not.toContain('</>');
        expect(toButton, `${file}: ${list}`).not.toContain('<LoadMoreFailed');
        // Its own test id beside the button's.
        expect(toButton, file).toMatch(/data-testid=\{?[`"][^`"]*-more-failed[`"]\}?/);
        // The button pages the same list: `list.fetchNextPage()`, the comment list's
        // `readMoreComments(list)` (#48's 더 보기, which reads the pages again for a cursor the
        // server no longer opens), or `fetchNextPage()` destructured from it (MY's 거래 내역 and
        // 결제 내역).
        const pages = new RegExp(
          `void (?:${list}\\.fetchNextPage\\(\\)|readMoreComments\\(${list}\\))`,
        ).test(toButton)
          ? true
          : /void fetchNextPage\(\)/.test(toButton) &&
            new RegExp(`\\{[^}]*\\bfetchNextPage\\b[^}]*\\}\\s*=\\s*${list};`).test(text);
        expect(pages, `${file}: ${list}`).toBe(true);
      }
    }
  });

  it("says what that list's own first read says when it fails, never the refresh notice", () => {
    for (const { file, text } of lists) {
      const firstReads = firstReadMessages(text);
      const refreshNotices = alertMessages(text, 'warning');
      for (const { list, message } of noticesOf(text)) {
        expect(message, `${file}: ${list}`).not.toBe('');
        // The same expression the file gives its first read's failure (5-14(a)) — and not one it
        // gives a refresh that failed (`copy.marketRefreshFailed` and the like).
        expect([...firstReads], `${file}: ${list}`).toContain(message);
        expect([...refreshNotices], `${file}: ${list}`).not.toContain(message);
        // A message read from an error reads the error of the list it speaks for.
        for (const [, owner] of message.matchAll(/\b(\w+)\.error\b/g)) {
          expect(owner, `${file}: ${message}`).toBe(list);
        }
      }
    }
  });

  it('is never hidden by a failure rung that reads isError alone', () => {
    for (const { file, text } of lists) {
      for (const list of pagedLists(text)) {
        expect(text, `${file}: ${list}`).not.toMatch(new RegExp(`\\b${list}\\.isError\\b`));
      }
      // A list destructured from its hook takes `isError` from it no more either.
      expect(text, file).not.toMatch(/\{[^}]*\bisError\b[^}]*\bfetchNextPage\b[^}]*\}\s*=/);
    }
  });

  it('is never undone by another screen reading the same query on isError alone', () => {
    // The walk found the hooks of the lists that page outside a screen's own `useInfiniteQuery`.
    expect(pagedHooks).toEqual(
      [
        'useAdminAccountRequests',
        'useAdminGrantCandidates',
        'useAdminModerationActions',
        'useAdminNoticeActions',
        'useAdminNoticeRevisions',
        'useAdminNotices',
        'useAdminPayments',
        'useAdminRelatedSearch',
        'useAdminReportQueue',
        'useAdminRoleChanges',
        'useComments',
        'useCommunityPosts',
        'useLedger',
        'useMarketPosts',
        'useMarketSearch',
        'useMarkets',
        'useMyModerationActions',
        'useMyReports',
        'useOrders',
        'usePayments',
        'useRelatedMarkets',
        'useReleaseSettingChanges',
        'useRetentionPurges',
        'useWatchlist',
      ].sort(),
    );
    for (const { file, text } of sources) {
      for (const [, name = '', hook = ''] of text.matchAll(/\bconst (\w+) = (use\w+)\(/g)) {
        if (!pagedHooks.includes(hook)) continue;
        expect(text, `${file}: ${name} = ${hook}()`).not.toMatch(
          new RegExp(`\\b${name}\\.isError\\b`),
        );
      }
    }
  });
});
