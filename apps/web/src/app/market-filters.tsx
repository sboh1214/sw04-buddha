'use client';

import { Box, Button, Field, HStack, Input, NativeSelect, Skeleton, Stack } from '@chakra-ui/react';
import {
  MARKET_SORTS,
  PUBLIC_MARKET_STATUSES,
  type MarketSort,
  type PublicMarketStatus,
} from '@buddha/shared';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { copy } from '@/copy';
import { useCategories } from '@/hooks/use-markets';
import { type Category } from '@/lib/api';
import { MARKET_STATUS_LABEL } from '@/lib/market-admin';
// Aliased: this module exports a COMPONENT called `MarketFilters`, and the filter object it
// renders is the type of the same name from the key module. The component keeps the name the
// screens use; the type is spelled `Filters` here and nowhere else.
import { DEFAULT_MARKET_FILTERS, type MarketFilters as Filters } from '@/lib/market-keys';

/**
 * The home screen's controls (PLAN 11.3): 카테고리 탭 · 정렬 · 상태 · 검색.
 *
 * Every control writes to the URL and reads its value back out of the `filters` prop the server
 * normalised — never out of local state. That is the whole design: the query string is the single
 * source of truth, so the SSR render, the client cache key and a link someone pastes into a chat
 * all describe the same screen. The cost is that a control shows its new value when the
 * navigation lands rather than on the keystroke, which is the honest thing to show anyway: the
 * list below it has not changed yet either.
 *
 * The categories arrive twice: as a server-read PROP, which is what puts the tabs in the first
 * paint, and from `useCategories()` afterwards, which is what keeps them fresh and gives the
 * screen a value at all when this component is rendered without the prop. It has to be a prop and
 * not the `['categories']` cache entry, because `Nav` renders above this page and builds that
 * query first, which makes react-query defer its hydration to an effect that never runs on the
 * server (see app/page.tsx). A failed read is not worth an error region here — 전체 still works
 * and the list underneath reports its own failure.
 */

/** PLAN 11.3's three orders. Local to this file: no other screen sorts a market list. */
const SORT_LABEL: Record<MarketSort, string> = {
  volume: copy.sortVolume,
  closing: copy.sortClosing,
  newest: copy.sortNewest,
};

/**
 * The filters as a query string, with everything that equals the default left out — so the
 * default view's URL is a bare `/` and a shared link carries only what was actually chosen.
 * Dropping them is safe in both directions: `filtersFromSearchParams` falls back to exactly these
 * defaults for a missing param.
 *
 * Exported because it is the one decision in this file that can be tested without a DOM.
 */
export function filterQuery(filters: Filters): Record<string, string> {
  return {
    ...(filters.category === undefined ? {} : { category: filters.category }),
    ...(filters.q === undefined ? {} : { q: filters.q }),
    ...(filters.sort === DEFAULT_MARKET_FILTERS.sort ? {} : { sort: filters.sort }),
    ...(filters.status === DEFAULT_MARKET_FILTERS.status ? {} : { status: filters.status }),
  };
}

export interface MarketFiltersProps {
  /** Normalised once on the server; every control's value is read from here. */
  filters: Filters;
  /** Read by the server component for the first paint; absent if that read failed. */
  categories?: Category[];
  'data-testid'?: string;
}

export function MarketFilters({
  filters,
  categories: seeded,
  'data-testid': testId = 'market-filters',
}: MarketFiltersProps) {
  const router = useRouter();
  const categories = useCategories();
  // The query wins once it has an answer, so a client-side refresh moves the tabs; until then
  // the server's own read stands, which is why there is no skeleton on a served page.
  const items = categories.data ?? seeded;

  const go = (patch: Partial<Filters>) => {
    const search = new URLSearchParams(filterQuery({ ...filters, ...patch })).toString();
    // A bare `?…` is a relative href — `RouteImpl` accepts `SearchOrHash` on its own and the App
    // Router resolves it against the current pathname, which on this screen is always `/`. With
    // nothing left to say the link is `/`, not `?`.
    router.push(search === '' ? '/' : `?${search}`);
  };

  return (
    <Stack gap="4" data-testid={testId}>
      {/* No debounce anywhere in this repo, and none here: the search runs on submit, so Enter
          (or the button) is what costs a request. Same shape as the admin user search. */}
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          const typed = new FormData(event.currentTarget).get('q');
          const trimmed = (typeof typed === 'string' ? typed : '').trim();
          go({ q: trimmed === '' ? undefined : trimmed });
        }}
      >
        <HStack gap="2">
          <Field.Root flex="1">
            {/* Visually hidden, not absent: a placeholder is not an accessible name (AC 6). */}
            <Field.Label srOnly>{copy.searchLabel}</Field.Label>
            {/* Uncontrolled and KEYED on the term the URL carries, which is the whole of the
                reconciliation this field needs. What is typed before Enter is a draft, so it must
                survive a navigation the draft itself did not cause — picking a category, changing
                the sort — and it must NOT survive one that replaced the term: Back out of a
                search, or the header's own `/?q=…` form (nav.tsx), which posts from every route.
                A `useState` seeded on mount could do neither, because a search-param-only
                navigation on `/` re-renders this component without remounting it, so the seed was
                read once and the box then outlived every filter it was supposed to describe.
                Keying on `filters.q` remounts the field exactly when the URL's term changes and
                leaves it alone otherwise — no effect, and nothing that can fight the typing. */}
            <Input
              key={filters.q ?? ''}
              name="q"
              type="search"
              defaultValue={filters.q ?? ''}
              placeholder={copy.searchPlaceholder}
              data-testid="market-search"
            />
          </Field.Root>
          <Button type="submit" flexShrink="0" data-testid="market-search-submit">
            {copy.searchSubmit}
          </Button>
        </HStack>
      </form>

      {/* Links rather than a tablist: each tab IS a URL, which keeps middle-click, back and a
          pasted link working, and `aria-current` says which one is showing without a tabpanel
          that does not exist. Horizontally scrolling on a phone (PLAN 11.1). */}
      <Box
        as="nav"
        aria-label={copy.marketCategories}
        overflowX="auto"
        data-testid="market-category-tabs"
      >
        <HStack gap="2" minW="max-content" pb="1">
          <CategoryChip
            label={copy.marketsAll}
            active={filters.category === undefined}
            query={filterQuery({ ...filters, category: undefined })}
            testId="market-category-tab-all"
          />
          {/* The skeleton is only for a render that has neither source yet — a client-side
              navigation onto `/` before the query has answered. A served page has the prop. */}
          {items === undefined && categories.isPending ? (
            <Skeleton height="8" width="48" borderRadius="l2" />
          ) : (
            (items ?? []).map((category) => (
              <CategoryChip
                key={category.slug}
                label={category.nameKo}
                active={filters.category === category.slug}
                query={filterQuery({ ...filters, category: category.slug })}
                testId={`market-category-tab-${category.slug}`}
              />
            ))
          )}
        </HStack>
      </Box>

      <HStack gap="3" flexWrap="wrap">
        <Field.Root maxW="40">
          <Field.Label>{copy.marketSort}</Field.Label>
          <NativeSelect.Root size="sm">
            <NativeSelect.Field
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

        <Field.Root maxW="40">
          <Field.Label>{copy.marketStatusFilter}</Field.Label>
          <NativeSelect.Root size="sm">
            {/* Public statuses only — a draft is invisible outside the admin, and the API's own
                query schema refuses one. There is no '전체': the route always filters by one. */}
            <NativeSelect.Field
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
    </Stack>
  );
}

interface CategoryChipProps {
  label: string;
  active: boolean;
  query: Record<string, string>;
  testId: string;
}

/**
 * `prefetch={false}`: every chip points at this same force-dynamic route, so leaving the default
 * on would ask the server to render a whole filtered list for each chip that scrolls into view.
 * The selected state is carried by `aria-current` as well as by the fill (PLAN 11.2).
 */
function CategoryChip({ label, active, query, testId }: CategoryChipProps) {
  return (
    <Button asChild size="sm" flexShrink="0" variant={active ? 'solid' : 'outline'}>
      <NextLink
        href={{ pathname: '/', query }}
        prefetch={false}
        aria-current={active ? 'page' : undefined}
        data-testid={testId}
      >
        {label}
      </NextLink>
    </Button>
  );
}
