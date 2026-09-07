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
import { useState } from 'react';
import { copy } from '@/copy';
import { useCategories } from '@/hooks/use-markets';
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
 * The categories come from the same `['categories']` entry the page prefetched, so the tabs are
 * in the first paint. A failed read is not worth an error region here — 전체 still works and the
 * list underneath reports its own failure.
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
  'data-testid'?: string;
}

export function MarketFilters({
  filters,
  'data-testid': testId = 'market-filters',
}: MarketFiltersProps) {
  const router = useRouter();
  const categories = useCategories();
  /**
   * The only local state on the screen, and it is a draft rather than a filter: what is typed
   * before Enter is not yet part of the URL. It is seeded from the URL and deliberately not
   * re-synced afterwards — an effect that wrote state back on every navigation would fight the
   * user's typing, and `react-hooks` refuses `setState` in an effect body outright.
   */
  const [term, setTerm] = useState(filters.q ?? '');

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
          const trimmed = term.trim();
          go({ q: trimmed === '' ? undefined : trimmed });
        }}
      >
        <HStack gap="2">
          <Field.Root flex="1">
            {/* Visually hidden, not absent: a placeholder is not an accessible name (AC 6). */}
            <Field.Label srOnly>{copy.searchLabel}</Field.Label>
            <Input
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
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
          {categories.isPending ? (
            <Skeleton height="8" width="48" borderRadius="l2" />
          ) : (
            (categories.data ?? []).map((category) => (
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
