'use client';

import {
  Alert,
  Box,
  Button,
  CloseButton,
  Field,
  HStack,
  Heading,
  Input,
  NativeSelect,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { POST_SEARCH_TERM_MAX } from '@buddha/shared';
import type { Route } from 'next';
import Form from 'next/form';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { MarketPicker } from '@/components/post/market-picker';
import { PostCard } from '@/components/post/post-card';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useCategories } from '@/hooks/use-markets';
import { useCommunityPosts } from '@/hooks/use-posts';
import { type Category } from '@/lib/api';
import { groupCategories } from '@/lib/category-tree';
import { searchCategoryOptions } from '@/lib/market-search';
import {
  COMMUNITY_PATH,
  type CommunityFilters,
  communityPath,
  communitySearchFields,
  isFiltered,
  postReadErrorMessage,
  writePath,
} from '@/lib/posts';
import { refreshFailed } from '@/lib/query-client';
import { PILL_BUTTON, PILL_SELECT } from '../market-filters';

/** Placeholders at a card's height while the first page loads. */
const SKELETON_ROWS = [0, 1, 2, 3];

/**
 * The community list (#46, ADR-0073): the `h2` with 글쓰기, the search box (title and text, within
 * the market and category picked), the market filter (a chip naming the market, or a picker that
 * finds one by its title) and the category select (either level, as the search screen's), and the
 * cards, newest first — the only order (#45-7) — one page per 더 보기.
 *
 * Every control writes to the URL and reads its value back out of the `filters` prop the server
 * normalised (the home's rule): the query string is the one source of truth, so a filtered list is
 * a link anyone can open.
 */
export function CommunityScreen({
  filters,
  categories: seeded,
  marketTitle,
}: {
  filters: CommunityFilters;
  /** Read by the server component for the first paint; absent if that read failed. */
  categories?: Category[];
  /** The title of the market `filters.market` names, read on the server; absent if it failed. */
  marketTitle?: string;
}) {
  const router = useRouter();
  const categories = useCategories();
  const tree = groupCategories(categories.data ?? seeded ?? []);
  const { groups, unlisted } = searchCategoryOptions(tree, filters.category);
  const [picking, setPicking] = useState(false);
  const go = (next: CommunityFilters) => router.push(communityPath(next) as Route);

  return (
    <Stack gap="6" data-testid="community-screen">
      <HStack justify="space-between" gap="3" flexWrap="wrap">
        {/* The nav owns the h1, so the screen's title is an h2, as the home's headline is. */}
        <Heading as="h2" textStyle="headline">
          {copy.communityTitle}
        </Heading>
        {/* The search screen's submit's props, in its order: Chakra memoises a style set's CSS
            under its keys sorted, so the same set in another order hydrates as another class
            (market-filters.tsx `PILL_BUTTON` says more). */}
        <Button asChild h="40px" px="5" borderRadius="pill" colorPalette="brand">
          <NextLink href={writePath(filters.market) as Route} data-testid="community-write">
            {copy.communityWrite}
          </NextLink>
        </Button>
      </HStack>

      <SearchBox filters={filters} />

      <HStack gap="2" flexWrap="wrap" data-testid="community-filters">
        {filters.market === undefined ? (
          <Button
            {...PILL_BUTTON}
            variant="outline"
            aria-expanded={picking}
            onClick={() => setPicking((open) => !open)}
            data-testid="community-market-pick"
          >
            {copy.communityFilterMarketPick}
          </Button>
        ) : (
          <HStack
            {...PILL_BUTTON}
            gap="1"
            pe="1"
            borderWidth="1px"
            borderColor="brand.border"
            maxW="100%"
            data-testid="community-market-filter"
          >
            <Text as="span" textStyle="emphasisSm" truncate>
              {`${copy.communityFilterMarket}: ${marketTitle ?? copy.communityFilterMarketUnknown}`}
            </Text>
            <CloseButton
              size="2xs"
              aria-label={copy.communityFilterMarketClear}
              onClick={() => go({ ...filters, market: undefined })}
              data-testid="community-market-clear"
            />
          </HStack>
        )}
        <Field.Root width="auto">
          <Field.Label srOnly>{copy.communityCategory}</Field.Label>
          <NativeSelect.Root size="md">
            <NativeSelect.Field
              {...PILL_SELECT}
              value={filters.category ?? ''}
              onChange={(event) =>
                go({
                  ...filters,
                  category: event.target.value === '' ? undefined : event.target.value,
                })
              }
              data-testid="community-category"
            >
              <option value="">{copy.communityCategoryAll}</option>
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
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </Field.Root>
      </HStack>

      {picking && filters.market === undefined && (
        <Box borderWidth="1px" borderColor="border.subtle" borderRadius="card" p="4" maxW="640px">
          <MarketPicker
            prompt={copy.marketPickerFilterPrompt}
            onPick={(market) => {
              setPicking(false);
              go({ ...filters, market: market.id });
            }}
            testId="community-market-picker"
          />
        </Box>
      )}

      <PostList filters={filters} />
    </Stack>
  );
}

/**
 * The list's search box: a real `<form>` to `/community` (`next/form`: the term and the filters go
 * in the URL — without JavaScript it still navigates and the server draws the first page), whose
 * hidden fields carry the market and the category picked, so a term is searched within them. It
 * is uncontrolled and keyed on the term the URL carries, as the search screen's box is: a
 * navigation that replaced the term remounts it.
 */
function SearchBox({ filters }: { filters: CommunityFilters }) {
  return (
    <Form
      action={COMMUNITY_PATH}
      prefetch={false}
      role="search"
      aria-label={copy.communitySearchLabel}
    >
      <HStack gap="2" maxW="640px">
        {communitySearchFields(filters).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <Input
          key={filters.q ?? ''}
          name="q"
          type="search"
          defaultValue={filters.q ?? ''}
          maxLength={POST_SEARCH_TERM_MAX}
          h="40px"
          borderRadius="pill"
          bg="surface.input"
          variant="subtle"
          _placeholder={{ color: 'fg.muted' }}
          aria-label={copy.communitySearchLabel}
          placeholder={copy.communitySearchPlaceholder}
          data-testid="community-search-input"
        />
        <Button
          type="submit"
          h="40px"
          px="5"
          borderRadius="pill"
          variant="outline"
          data-testid="community-search-submit"
        >
          {copy.communitySearchSubmit}
        </Button>
      </HStack>
    </Form>
  );
}

/**
 * The cards with their rungs, the search results' (N02 §3): the skeleton while loading, a first
 * load that failed (said apart from an unreachable server, with 다시 시도), the empty list — '조건에
 * 맞는 글이 없습니다' when a filter is on, an invitation to the first post when none is — the cards
 * with 더 보기, a notice above them when a later refresh failed, and the first read's message above
 * 더 보기 when it failed (`LoadMoreFailed`, owner decision 2026-10-20 7).
 */
function PostList({ filters }: { filters: CommunityFilters }) {
  const list = useCommunityPosts(filters);
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Stack as="section" gap="3" aria-label={copy.communityListLabel} data-testid="community-posts">
      {/* Not the bare flag: a refetch after a failed 더 보기 reports a refresh that never failed. */}
      {refreshFailed(list) && (
        <Alert.Root status="warning" role="status" data-testid="community-refresh-failed">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {list.isPending ? (
        SKELETON_ROWS.map((row) => <Skeleton key={row} height="112px" borderRadius="card" />)
      ) : list.isLoadingError ? (
        <Stack gap="3" align="flex-start" data-testid="community-error">
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{postReadErrorMessage(list.error)}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button size="sm" variant="outline" onClick={() => void list.refetch()}>
            {copy.retry}
          </Button>
        </Stack>
      ) : rows.length === 0 ? (
        <EmptyState
          message={isFiltered(filters) ? copy.communityEmptyFiltered : copy.communityEmpty}
          data-testid="community-empty"
        />
      ) : (
        <>
          {rows.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
          {list.hasNextPage && (
            <>
              <LoadMoreFailed
                list={list}
                message={postReadErrorMessage(list.error)}
                data-testid="community-more-failed"
              />
              <Button
                alignSelf="center"
                variant="outline"
                borderRadius="pill"
                borderColor="border.emphasized"
                h="40px"
                px="4"
                textStyle="emphasisSm"
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
                data-testid="community-more"
              >
                {copy.loadMore}
              </Button>
            </>
          )}
        </>
      )}
    </Stack>
  );
}
