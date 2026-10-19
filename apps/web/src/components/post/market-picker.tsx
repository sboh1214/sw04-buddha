'use client';

import {
  Alert,
  Badge,
  Box,
  Button,
  Field,
  HStack,
  Input,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { marketSearchTermSchema } from '@buddha/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { marketSearchInfiniteQueryOptions } from '@/hooks/use-markets';
import { type MarketSummary } from '@/lib/api';
import { MARKET_STATUS_LABEL, MARKET_STATUS_PALETTE } from '@/lib/market-admin';
import { DEFAULT_SEARCH_FILTERS, type MarketSearch } from '@/lib/market-keys';
import { SEARCH_INPUT_MAX_LENGTH, searchErrorMessage } from '@/lib/market-search';

/**
 * Picks a market by its title (#46, ADR-0073): the write screen's first step when it was opened
 * without one (#45-1: «커뮤니티 목록에서 시장을 골라»), and the community list's market filter.
 *
 * It searches as the search screen does (`GET /markets` with the term, every public status — a
 * post takes any of them, #45-6 — 추천 order), through the same query options, so a market found
 * here is one the search screen finds too. A draft is never public, so it is never offered.
 */
export function MarketPicker({
  prompt,
  onPick,
  testId = 'market-picker',
}: {
  /** What the picker is for, shown until a term is searched. */
  prompt: string;
  onPick: (market: MarketSummary) => void;
  testId?: string;
}) {
  const [typed, setTyped] = useState('');
  const [term, setTerm] = useState<string | undefined>(undefined);
  // A hook needs a key even before a term exists; the query is off until one does.
  const search: MarketSearch = { ...DEFAULT_SEARCH_FILTERS, q: term ?? '' };
  const results = useInfiniteQuery({
    ...marketSearchInfiniteQueryOptions(search),
    enabled: term !== undefined,
  });
  const rows = results.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Stack gap="3" data-testid={testId}>
      <form
        role="search"
        aria-label={copy.marketPickerLabel}
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = marketSearchTermSchema.safeParse(typed);
          setTerm(parsed.success ? parsed.data : undefined);
        }}
      >
        <HStack gap="2">
          <Field.Root flex="1">
            <Field.Label srOnly>{copy.marketPickerLabel}</Field.Label>
            <Input
              value={typed}
              maxLength={SEARCH_INPUT_MAX_LENGTH}
              placeholder={copy.marketPickerPlaceholder}
              onChange={(event) => setTyped(event.target.value)}
              data-testid={`${testId}-input`}
            />
          </Field.Root>
          <Button type="submit" variant="outline" data-testid={`${testId}-submit`}>
            {copy.marketPickerSubmit}
          </Button>
        </HStack>
      </form>
      {term === undefined ? (
        <Text textStyle="bodySm" color="fg.muted">
          {prompt}
        </Text>
      ) : results.isPending ? (
        <Skeleton height="96px" borderRadius="row" />
      ) : results.isLoadingError ? (
        <Stack gap="2" align="flex-start">
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{searchErrorMessage(results.error)}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button size="sm" variant="outline" onClick={() => void results.refetch()}>
            {copy.retry}
          </Button>
        </Stack>
      ) : rows.length === 0 ? (
        <EmptyState message={copy.marketPickerEmpty} data-testid={`${testId}-empty`} />
      ) : (
        <Stack gap="2">
          <Box as="ul" listStyleType="none">
            {rows.map((market) => (
              <HStack
                as="li"
                key={market.id}
                justify="space-between"
                gap="3"
                py="2"
                borderBottomWidth="1px"
                borderColor="border.subtle"
                data-testid={`${testId}-row`}
              >
                <Stack gap="0.5" minW="0">
                  <Text textStyle="emphasisSm" lineClamp="2">
                    {market.title}
                  </Text>
                  <HStack gap="2">
                    <Text as="span" textStyle="bodyXs" color="fg.muted">
                      {market.category.nameKo}
                    </Text>
                    <Badge
                      size="sm"
                      variant="subtle"
                      colorPalette={MARKET_STATUS_PALETTE[market.status]}
                    >
                      {MARKET_STATUS_LABEL[market.status]}
                    </Badge>
                  </HStack>
                </Stack>
                <Button
                  size="xs"
                  variant="outline"
                  flexShrink="0"
                  aria-label={`${market.title} ${copy.marketPickerPick}`}
                  onClick={() => onPick(market)}
                  data-testid={`${testId}-pick`}
                >
                  {copy.marketPickerPick}
                </Button>
              </HStack>
            ))}
          </Box>
          {results.hasNextPage && (
            <Button
              alignSelf="center"
              size="sm"
              variant="outline"
              loading={results.isFetchingNextPage}
              onClick={() => void results.fetchNextPage()}
            >
              {copy.loadMore}
            </Button>
          )}
        </Stack>
      )}
    </Stack>
  );
}
