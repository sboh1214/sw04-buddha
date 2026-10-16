'use client';

import { Box, Button, Field, HStack, Heading, NativeSelect, Stack } from '@chakra-ui/react';
import { type WatchlistSort } from '@buddha/shared';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { copy } from '@/copy';
import { useCategories } from '@/hooks/use-markets';
import { type Category } from '@/lib/api';
import { groupCategories } from '@/lib/category-tree';
import {
  homeHeading,
  homePath,
  isWatchlistView,
  sidebarLinks,
  sortOptions,
  watchlistToggleTarget,
  withSort,
} from '@/lib/home-view';
import { type HomeFilters } from '@/lib/market-keys';
import { useSession } from '@/lib/use-session';
import { SubcategoryChips } from './subcategory-sidebar';

/**
 * The home screen's headline bar (PLAN 11.3, ADR-0041 Kalshi's category page): the `h2` that
 * names what the grid shows on the left, and on the right the 관심 시장 toggle and the 정렬 select
 * as pill controls (ADR-0065). There is no status control: the home lists open markets only and
 * the other statuses are the search screen's (ADR-0061 decision 1, item 13). The search box and
 * the top-level category tabs that used to live here are the header's now (nav.tsx: the search
 * field in row 1, the categories in row 2), and the leaves of the chosen category are the
 * sidebar's (subcategory-sidebar.tsx) — on a phone, the chip row this component draws under the
 * headline.
 *
 * Every control writes to the URL and reads its value back out of the `filters` prop the server
 * normalised — never out of local state. That is the whole design: the query string is the single
 * source of truth, so the SSR render, the client cache key and a link someone pastes into a chat
 * all describe the same screen. The cost is that a control shows its new value when the
 * navigation lands rather than on the keystroke, which is the honest thing to show anyway: the
 * list below it has not changed yet either.
 *
 * The 관심 시장 toggle is pressed when the URL says so (`?watchlist=1`), for every visitor alike,
 * so the server's HTML does not depend on who asks. Where a press goes is `watchlistToggleTarget`:
 * a visitor the session has answered for as signed out is sent to sign in and back to the view
 * (ADR-0061 decision 1, item 12), anyone else to the view or back to the public list.
 *
 * The categories arrive twice: as a server-read PROP, which is what puts the category's name in
 * the headline of the first paint, and from `useCategories()` afterwards, which is what keeps it
 * fresh and gives the screen a value at all when this component is rendered without the prop.
 * It has to be a prop and not the `['categories']` cache entry, because `Nav` renders above this
 * page and builds that query first, which makes react-query defer its hydration to an effect
 * that never runs on the server (see app/page.tsx). A failed read is not worth an error region
 * here — the headline falls back to 예측시장 and the list underneath reports its own failure.
 */

/** The orders' names (ADR-0061 decision 1, items 9–11; decision 3, the #63 row). */
const SORT_LABEL: Record<WatchlistSort, string> = {
  recommended: copy.sortRecommended,
  newest: copy.sortNewest,
  closing: copy.sortClosing,
  watched: copy.sortWatched,
};

export interface MarketFiltersProps {
  /** Normalised once on the server; every control's value is read from here. */
  filters: HomeFilters;
  /** Read by the server component for the first paint; absent if that read failed. */
  categories?: Category[];
  'data-testid'?: string;
}

/**
 * Kalshi's control pill, on a native `<select>`: 40px tall, a 100px radius, the emphasized alpha
 * stroke and no fill. The right padding leaves room for the chevron `NativeSelect.Indicator`
 * draws over it. `ps`/`pe` rather than `px`/`pr` because those are the keys the size recipe
 * sets, so the override replaces them instead of racing a `padding-inline` shorthand.
 */
const PILL_SELECT = {
  h: '40px',
  ps: '4',
  pe: '9',
  borderRadius: 'pill',
  borderWidth: '1px',
  borderColor: 'border.emphasized',
  bg: 'transparent',
  textStyle: 'emphasisSm',
} as const;

/** The same pill as a button: 40px, a 100px radius and the emphasized stroke when off. */
const PILL_BUTTON = {
  h: '40px',
  px: '4',
  borderRadius: 'pill',
  borderWidth: '1px',
  borderColor: 'border.emphasized',
  textStyle: 'emphasisSm',
} as const;

export function MarketFilters({
  filters,
  categories: seeded,
  'data-testid': testId = 'market-filters',
}: MarketFiltersProps) {
  const router = useRouter();
  const categories = useCategories();
  // The query wins once it has an answer, so a client-side refresh moves the headline; until
  // then the server's own read stands, which is why there is no skeleton on a served page.
  const items = categories.data ?? seeded;
  const tree = groupCategories(items ?? []);
  // Derived once here for the chip row; the sidebar derives the same rows from the same inputs
  // for itself, which is cheaper than threading them across the page's two columns.
  const links = sidebarLinks(tree, filters);

  const { data: session, isPending: sessionPending } = useSession();
  const watching = isWatchlistView(filters);

  // `homePath` is `/` or `/?…`; the App Router takes either. A bare `/` rather than `?` when there
  // is nothing left to say.
  const go = (path: string) => router.push(path as Route);

  return (
    <Stack gap="4" data-testid={testId}>
      <HStack justify="space-between" align="center" flexWrap="wrap" gap="3">
        {/* The nav owns the h1, so the page's own title is an h2 (MY's layout does the same).
            It names the category the URL picked, or the screen itself when none is. */}
        <Heading as="h2" textStyle="headline">
          {homeHeading(tree, filters)}
        </Heading>

        <HStack gap="2" flexWrap="wrap">
          {/* 관심 시장 (ADR-0061 decision 1, item 12): a toggle over the category, pressed from the
              URL. The pill of the select beside it, filled with the brand tint when on — and
              `aria-pressed`, so colour never says it alone (PLAN 11.2). Not `disabled` while the
              session is unknown: the view itself waits for it (`WatchlistViewList` in
              market-list.tsx: `useWatchlist` is pending until the session is known, then
              `sessionListSection`). */}
          <Button
            {...PILL_BUTTON}
            variant={watching ? 'subtle' : 'outline'}
            colorPalette={watching ? 'brand' : 'gray'}
            aria-pressed={watching}
            onClick={() =>
              go(watchlistToggleTarget(filters, sessionPending ? undefined : session != null))
            }
            data-testid="market-watchlist-toggle"
          >
            {copy.homeWatchlistToggle}
          </Button>

          {/* `width="auto"`: the field recipe is a full-width column, which in this row would
              push the select under the toggle. The label stays in the DOM for screen readers — a
              select whose only name is its current option would read as "추천" with nothing to
              say it is the sort (AC 6) — but a visible 정렬 beside a pill that already reads 추천
              would be Kalshi's bar with a caption it does not carry. */}
          <Field.Root width="auto">
            <Field.Label srOnly>{copy.marketSort}</Field.Label>
            <NativeSelect.Root size="md">
              <NativeSelect.Field
                {...PILL_SELECT}
                value={filters.sort}
                onChange={(event) =>
                  go(homePath(withSort(filters, event.target.value as WatchlistSort)))
                }
                data-testid="market-sort"
              >
                {sortOptions(filters).map((sort) => (
                  <option key={sort} value={sort}>
                    {SORT_LABEL[sort]}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </Field.Root>
        </HStack>
      </HStack>

      {/* The sidebar's rows as a chip strip, phones only: the 180px column does not fit beside
          the grid there, and a visitor who tapped 경제 in the header still needs its leaves. */}
      {links.length > 0 && (
        <Box hideFrom="md">
          <SubcategoryChips links={links} />
        </Box>
      )}
    </Stack>
  );
}
