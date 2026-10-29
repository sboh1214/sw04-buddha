'use client';

import {
  Alert,
  Box,
  Button,
  Field,
  HStack,
  Heading,
  Input,
  Link as ChakraLink,
  NativeSelect,
  Skeleton,
  Stack,
} from '@chakra-ui/react';
import { MARKET_SORTS, type MarketListStatus, type MarketSort } from '@buddha/shared';
import type { Route } from 'next';
import Form from 'next/form';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { toaster } from '@/components/ui/toaster';
import { ProposeMarketEntry } from '@/components/proposals/propose-market-entry';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { useCategories, useMarketSearch } from '@/hooks/use-markets';
import { useMe } from '@/hooks/use-me';
import { useSearchBoxTurn } from '@/hooks/use-search-box';
import {
  useRecentSearches,
  useRecordSearch,
  useSearchHistoryWrite,
} from '@/hooks/use-search-history';
import { type Category } from '@/lib/api';
import { groupCategories } from '@/lib/category-tree';
import { type MarketSearch as Search, type SearchFilters } from '@/lib/market-keys';
import {
  SEARCH_INPUT_MAX_LENGTH,
  SEARCH_PATH,
  isMarketSearch,
  recentSearchPath,
  searchBoxKey,
  searchCategoryOptions,
  searchErrorMessage,
  searchFormFields,
  searchPath,
  searchScreenBody,
  searchStatusOptions,
} from '@/lib/market-search';
import { sessionListSection } from '@/lib/query-client';
import { type SearchHistoryWrite, searchHistoryFailureMessage } from '@/lib/search-history';
import { useSession } from '@/lib/use-session';
import { MarketGrid } from '../market-list';
import { PILL_SELECT, SORT_LABEL } from '../market-filters';

/**
 * The search screen (#15, ADR-0066): the `h2`, the screen's own search box, the three filters
 * (상태 · 카테고리 · 정렬) and under them the results — or, with no term, the member's recent
 * searches or a prompt (`searchScreenBody`).
 *
 * Every control writes to the URL and reads its value back out of the `filters` prop the server
 * normalised, as the home's do (market-filters.tsx): the query string is the one source of truth.
 * The box submits a term within the filters on screen (`searchFormFields`); the header's box starts
 * afresh. A submitted term is recorded for a signed-in member (`useRecordSearch`), and so is a
 * recent search picked from the list, as a new search (owner decision 2026-10-16, ADR-0066: "새
 * 검색으로 기록") — a filter, an order or 더 보기 changes the URL or the page and records nothing,
 * and neither does a search opened by its address (ADR-0066). The record, the recent list and its
 * deletes are the account's whose `Me` the screen was drawn from — the header's — never the
 * session's (use-search-history.ts, ADR-0091).
 */
export function MarketSearch({
  filters,
  categories: seeded,
  now,
}: {
  /** Normalised once on the server; every control's value is read from here. */
  filters: SearchFilters;
  /** Read by the server component for the first paint; absent if that read failed. */
  categories?: Category[];
  /**
   * The server's read of the results' first page, which the cards' countdowns measure against —
   * absent when nothing was seeded (no term, an empty answer or a failed read), as on the home.
   */
  now?: number;
}) {
  const router = useRouter();
  const categories = useCategories();
  const tree = groupCategories(categories.data ?? seeded ?? []);
  const { groups, unlisted } = searchCategoryOptions(tree, filters.category);
  const { data: session, isPending: sessionPending } = useSession();
  // The account the screen was drawn for: a submitted term is recorded for it, and the box is
  // drawn again when it turns into another (`SearchBox`).
  const accountId = useMe().data?.id;
  const record = useRecordSearch(accountId);
  const body = searchScreenBody(filters, { pending: sessionPending, signedIn: session != null });
  const go = (next: SearchFilters) => router.push(searchPath(next) as Route);

  return (
    <Stack gap="6" data-testid="search-screen">
      {/* The nav owns the h1, so the screen's title is an h2, as the home's headline is. */}
      <Heading as="h2" textStyle="headline">
        {copy.searchTitle}
      </Heading>

      <SearchBox filters={filters} accountId={accountId} onSubmitted={record} />

      <HStack gap="2" flexWrap="wrap" data-testid="search-filters">
        <PillSelect
          label={copy.searchStatus}
          value={filters.status}
          onChange={(value) => go({ ...filters, status: value as MarketListStatus })}
          testId="search-status"
        >
          {searchStatusOptions().map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </PillSelect>
        <PillSelect
          label={copy.searchCategory}
          value={filters.category ?? ''}
          onChange={(value) => go({ ...filters, category: value === '' ? undefined : value })}
          testId="search-category"
        >
          <option value="">{copy.searchCategoryAll}</option>
          {unlisted !== undefined && <option value={unlisted}>{unlisted}</option>}
          {groups.map((group) => (
            <optgroup key={group.options[0]?.value ?? group.label} label={group.label}>
              {group.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ))}
        </PillSelect>
        <PillSelect
          label={copy.marketSort}
          value={filters.sort}
          onChange={(value) => go({ ...filters, sort: value as MarketSort })}
          testId="search-sort"
        >
          {MARKET_SORTS.map((sort) => (
            <option key={sort} value={sort}>
              {SORT_LABEL[sort]}
            </option>
          ))}
        </PillSelect>
      </HStack>

      {isMarketSearch(filters) ? (
        <SearchResults search={filters} now={now} />
      ) : body === 'pending' ? (
        <Skeleton height="120px" borderRadius="card" data-testid="search-pending" />
      ) : body === 'recent' ? (
        <RecentSearches filters={filters} onPicked={record} />
      ) : (
        <EmptyState message={copy.searchPrompt} data-testid="search-prompt" />
      )}
    </Stack>
  );
}

/**
 * The screen's own search box: a real `<form>` to `/search` like the header's (`next/form`: the
 * term and the filters go in the URL, the screen's one source of truth — without JavaScript it
 * still navigates, and the server draws the first page of the results when it has any, owner
 * decision 2026-10-16, ADR-0066),
 * whose hidden fields carry the filters on screen, so a new term is searched within them. The
 * field holds at most `SEARCH_INPUT_MAX_LENGTH`, so whatever it holds is a term the screen
 * searches (lib/market-search.ts). It is uncontrolled and keyed on the term the URL carries, the
 * header box's rule (nav.tsx `SearchForm`): a navigation that replaced the term remounts it, and
 * a filter change keeps what is typed. It is keyed on its turn too (`useSearchBoxTurn`), also the
 * header box's rule (ADR-0091): a term typed for A is not B's to record, so the box starts again
 * when the account known turns into another — but not on `GET /me`'s first answer, which keeps
 * what was typed before it (owner decision 2026-10-26). With no term it takes the focus, since
 * typing one is the only thing the screen asks for then.
 *
 * Its landmark and its field are named '고른 조건으로 검색' (`searchRefineLabel`), not the header's
 * '시장 검색': on this screen both search landmarks are on the page, and two of one role with one
 * name are two things a screen reader cannot tell apart — while they do differ (the header's box
 * starts afresh, this one keeps the filters).
 */
function SearchBox({
  filters,
  accountId,
  onSubmitted,
}: {
  filters: SearchFilters;
  /**
   * The account a submitted term is recorded for: the `Me` the screen was drawn from. The box
   * starts again when it turns into another (`useSearchBoxTurn`).
   */
  accountId: string | undefined;
  onSubmitted: (term: unknown) => void;
}) {
  const turn = useSearchBoxTurn(accountId);
  return (
    <Form
      action={SEARCH_PATH}
      prefetch={false}
      role="search"
      aria-label={copy.searchRefineLabel}
      onSubmit={(event) => {
        onSubmitted(new FormData(event.currentTarget).get('q'));
      }}
    >
      <HStack gap="2" maxW="640px">
        {searchFormFields(filters).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <Input
          // The term the URL carries, and the box's turn (`searchBoxKey`).
          key={searchBoxKey(turn, filters.q)}
          name="q"
          type="search"
          defaultValue={filters.q ?? ''}
          maxLength={SEARCH_INPUT_MAX_LENGTH}
          h="40px"
          borderRadius="pill"
          bg="surface.input"
          variant="subtle"
          _placeholder={{ color: 'fg.muted' }}
          aria-label={copy.searchRefineLabel}
          placeholder={copy.searchPlaceholder}
          autoFocus={filters.q === undefined}
          data-testid="search-input"
        />
        <Button
          type="submit"
          h="40px"
          px="5"
          borderRadius="pill"
          colorPalette="brand"
          data-testid="search-submit"
        >
          {copy.searchSubmit}
        </Button>
      </HStack>
    </Form>
  );
}

/**
 * The home's pill select (`PILL_SELECT`), with its label kept for screen readers only, as the
 * home's 정렬 is: a select whose only name is its current option would read as '모든 상태' with
 * nothing to say it is the status.
 */
function PillSelect({
  label,
  value,
  onChange,
  testId,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <Field.Root width="auto">
      <Field.Label srOnly>{label}</Field.Label>
      <NativeSelect.Root size="md">
        <NativeSelect.Field
          {...PILL_SELECT}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          data-testid={testId}
        >
          {children}
        </NativeSelect.Field>
        <NativeSelect.Indicator />
      </NativeSelect.Root>
    </Field.Root>
  );
}

/**
 * The results: the home's grid (`MarketGrid`) over `GET /markets` with the term and the filters.
 * A first page with cards in it is the server's read, hydrated (app/search/page.tsx); anything
 * else is read in the browser, whose rungs are the three N02 §3 keeps apart — the skeleton while
 * loading, '검색 결과가 없습니다.' for an answer with nothing in it — and under it, there only, the way
 * to propose the market that was not found (#77, ADR-0089) — and a first load that failed,
 * which says whether the server could be reached at all (`searchErrorMessage`) and offers
 * 다시 시도 — plus the home's notice above the cards when a later refresh failed. Cards are `h3`,
 * under the screen's `h2`; each joins its market's room like the home's.
 */
function SearchResults({ search, now }: { search: Search; now: number | undefined }) {
  const results = useMarketSearch(search);
  return (
    <MarketGrid
      list={results}
      now={now}
      emptyMessage={copy.marketsSearchEmpty}
      errorMessage={searchErrorMessage(results.error)}
      cardTitleAs="h3"
      // 시장 제안하기 on the no-results screen (ADR-0069 decision 4 #77 위치), under the message.
      emptyAction={<ProposeMarketEntry testId="search-propose-market" />}
      testId="search-results"
    />
  );
}

/**
 * With no term, a signed-in member's own recent searches (ADR-0061 decision 3, the #15 rows): the
 * newest 10 distinct terms, each a link that runs it within the filters on screen
 * (`recentSearchPath`) and a delete, and a delete-all. Picking an entry records it as a new search
 * (`onPicked`, owner decision 2026-10-16), so it moves to the top of the list; the record goes in
 * the background, as a box's does, and the link navigates at once. Each entry shows its term only
 * (owner decision 2026-10-16, ADR-0066: the time it was searched is not shown). Private and
 * client-only: the root is in `PRIVATE_QUERY_ROOTS`. The ladder is the session-gated lists'
 * (`sessionListSection`): a session that ends under the screen shows the prompt instead. The list
 * is the account's whose `Me` the screen was drawn from, read once `GET /me` has answered
 * (ADR-0091); one that failed without ever answering leaves the list unread, said as its failure —
 * `copy.errProfileLoad`, with 다시 시도 reading `GET /me` again — rather than a skeleton for good.
 */
function RecentSearches({
  filters,
  onPicked,
}: {
  filters: SearchFilters;
  /** Records the entry's term as a new search (`useRecordSearch`). */
  onPicked: (term: unknown) => void;
}) {
  // The account the screen was drawn for: its list is drawn, and every delete names it.
  const me = useMe();
  const accountId = me.data?.id;
  // Signed in, and `GET /me` failed without ever answering: whose list it is is unknown, so none
  // is read (`usePostWriter`'s `failed`).
  const meFailed = me.isLoggedIn && me.isError && accountId === undefined;
  const recent = useRecentSearches(accountId);
  const write = useSearchHistoryWrite();
  const entries = recent.data ?? [];
  const section = sessionListSection(recent, entries.length);
  const body = meFailed ? 'failed' : section.body;
  const press = (change: SearchHistoryWrite) => {
    write.mutate(change, {
      onError: (error) => {
        toaster.create({ type: 'error', title: searchHistoryFailureMessage(error) });
      },
    });
  };

  if (body === 'signedOut') {
    return <EmptyState message={copy.searchPrompt} data-testid="search-prompt" />;
  }
  return (
    <Stack
      as="section"
      gap="3"
      aria-labelledby="recent-searches-title"
      data-testid="recent-searches"
    >
      <HStack justify="space-between" gap="3">
        <Heading as="h3" textStyle="titleLg" id="recent-searches-title">
          {copy.recentSearches}
        </Heading>
        {body === 'rows' && accountId !== undefined && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => press({ kind: 'clear', expectedAccountId: accountId })}
            data-testid="recent-searches-clear"
          >
            {copy.recentSearchesClear}
          </Button>
        )}
      </HStack>
      {section.stale && (
        <Alert.Root status="warning" role="status" data-testid="recent-searches-stale">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
          <Button size="xs" variant="outline" ml="auto" onClick={() => void recent.refetch()}>
            {copy.retry}
          </Button>
        </Alert.Root>
      )}
      {body === 'pending' ? (
        <Skeleton height="120px" borderRadius="card" />
      ) : body === 'failed' ? (
        <Stack gap="2" align="flex-start" data-testid="recent-searches-error">
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>
                {meFailed ? copy.errProfileLoad : searchErrorMessage(recent.error)}
              </Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void (meFailed ? me.refetch() : recent.refetch())}
          >
            {copy.retry}
          </Button>
        </Stack>
      ) : body === 'empty' ? (
        <EmptyState message={copy.recentSearchesEmpty} data-testid="recent-searches-empty" />
      ) : (
        <Box as="ul" listStyleType="none" data-testid="recent-searches-list">
          {entries.map((entry) => (
            <HStack
              as="li"
              key={entry.id}
              justify="space-between"
              gap="3"
              py="2"
              borderBottomWidth="1px"
              data-testid="recent-search"
            >
              <ChakraLink asChild textStyle="bodyMd" color="fg" minW="0" lineClamp="1">
                <NextLink
                  href={recentSearchPath(filters, entry.query) as Route}
                  prefetch={false}
                  onClick={() => onPicked(entry.query)}
                  data-testid="recent-search-link"
                >
                  {entry.query}
                </NextLink>
              </ChakraLink>
              {accountId !== undefined && (
                <Button
                  size="xs"
                  variant="ghost"
                  flexShrink="0"
                  aria-label={`${entry.query} ${copy.recentSearchDelete}`}
                  onClick={() =>
                    press({ kind: 'delete', id: entry.id, expectedAccountId: accountId })
                  }
                  data-testid="recent-search-delete"
                >
                  {copy.recentSearchDelete}
                </Button>
              )}
            </HStack>
          ))}
        </Box>
      )}
    </Stack>
  );
}
