'use client';

import { Box, Field, HStack, Heading, NativeSelect, Stack } from '@chakra-ui/react';
import {
  MARKET_SORTS,
  PUBLIC_MARKET_STATUSES,
  type MarketSort,
  type PublicMarketStatus,
} from '@buddha/shared';
import { useRouter } from 'next/navigation';
import { copy } from '@/copy';
import { useCategories } from '@/hooks/use-markets';
import { type Category } from '@/lib/api';
import { groupCategories } from '@/lib/category-tree';
import { filterQuery, homeHeading, sidebarLinks } from '@/lib/home-view';
import { MARKET_STATUS_LABEL } from '@/lib/market-admin';
// Aliased: this module exports a COMPONENT called `MarketFilters`, and the filter object it
// renders is the type of the same name from the key module. The component keeps the name the
// screens use; the type is spelled `Filters` here and nowhere else.
import { type MarketFilters as Filters } from '@/lib/market-keys';
import { SubcategoryChips } from './subcategory-sidebar';

/**
 * The home screen's headline bar (PLAN 11.3, ADR-0041 Kalshi's category page): the `h2` that
 * names what the grid shows on the left, and the 정렬 · 상태 controls as pill buttons on the
 * right. The search box and the top-level category tabs that used to live here are the
 * header's now (nav.tsx: the search field in row 1, the categories in row 2), and the leaves of
 * the chosen category are the sidebar's (subcategory-sidebar.tsx) — on a phone, the chip row
 * this component draws under the headline.
 *
 * Every control writes to the URL and reads its value back out of the `filters` prop the server
 * normalised — never out of local state. That is the whole design: the query string is the single
 * source of truth, so the SSR render, the client cache key and a link someone pastes into a chat
 * all describe the same screen. The cost is that a control shows its new value when the
 * navigation lands rather than on the keystroke, which is the honest thing to show anyway: the
 * list below it has not changed yet either.
 *
 * The categories arrive twice: as a server-read PROP, which is what puts the category's name in
 * the headline of the first paint, and from `useCategories()` afterwards, which is what keeps it
 * fresh and gives the screen a value at all when this component is rendered without the prop.
 * It has to be a prop and not the `['categories']` cache entry, because `Nav` renders above this
 * page and builds that query first, which makes react-query defer its hydration to an effect
 * that never runs on the server (see app/page.tsx). A failed read is not worth an error region
 * here — the headline falls back to 예측 시장 and the list underneath reports its own failure.
 */

/** PLAN 11.3's three orders. Local to this file: no other screen sorts a market list. */
const SORT_LABEL: Record<MarketSort, string> = {
  volume: copy.sortVolume,
  closing: copy.sortClosing,
  newest: copy.sortNewest,
};

export interface MarketFiltersProps {
  /** Normalised once on the server; every control's value is read from here. */
  filters: Filters;
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

  const go = (patch: Partial<Filters>) => {
    const search = new URLSearchParams(filterQuery({ ...filters, ...patch })).toString();
    // A bare `?…` is a relative href — `RouteImpl` accepts `SearchOrHash` on its own and the App
    // Router resolves it against the current pathname, which on this screen is always `/`. With
    // nothing left to say the link is `/`, not `?`.
    router.push(search === '' ? '/' : `?${search}`);
  };

  return (
    <Stack gap="4" data-testid={testId}>
      <HStack justify="space-between" align="center" flexWrap="wrap" gap="3">
        {/* The nav owns the h1, so the page's own title is an h2 (wallet/settings do the same).
            It names the category the URL picked, or the screen itself when none is. */}
        <Heading as="h2" textStyle="headline">
          {homeHeading(tree, filters)}
        </Heading>

        <HStack gap="2">
          {/* `width="auto"`: the field recipe is a full-width column, which in this row would
              push the second control under the first. The label stays in the DOM for screen
              readers — a select whose only name is its current option would read as "거래량"
              with nothing to say it is the sort (AC 6) — but a visible 정렬 beside a pill that
              already reads 거래량 would be Kalshi's bar with a caption it does not carry. */}
          <Field.Root width="auto">
            <Field.Label srOnly>{copy.marketSort}</Field.Label>
            <NativeSelect.Root size="md">
              <NativeSelect.Field
                {...PILL_SELECT}
                value={filters.sort}
                onChange={(event) => go({ sort: event.target.value as MarketSort })}
                data-testid="market-sort"
              >
                {MARKET_SORTS.map((sort) => (
                  <option key={sort} value={sort}>
                    {SORT_LABEL[sort]}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </Field.Root>

          <Field.Root width="auto">
            <Field.Label srOnly>{copy.marketStatusFilter}</Field.Label>
            <NativeSelect.Root size="md">
              {/* Public statuses only — a draft is invisible outside the admin, and the API's own
                  query schema refuses one. There is no '전체': the route always filters by one. */}
              <NativeSelect.Field
                {...PILL_SELECT}
                value={filters.status}
                onChange={(event) => go({ status: event.target.value as PublicMarketStatus })}
                data-testid="market-status-select"
              >
                {PUBLIC_MARKET_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {MARKET_STATUS_LABEL[status]}
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
