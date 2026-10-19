'use client';

import {
  Alert,
  Badge,
  Button,
  Field,
  HStack,
  Input,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import NextLink from 'next/link';
import { useState } from 'react';
import { copy } from '@/copy';
import { useAdminRelatedSearch } from '@/hooks/use-admin-markets';
import { type MarketSummary } from '@/lib/api';
import { MARKET_STATUS_LABEL, MARKET_STATUS_PALETTE } from '@/lib/market-admin';
import { SEARCH_INPUT_MAX_LENGTH } from '@/lib/market-search';
import { relatedSearchSection, relatedSearchSubmit } from '@/lib/related-markets';

/** A market as the picker shows it: the title to its admin detail, and its status. */
export function AdminMarketLine({
  market,
  testId,
}: {
  market: { id: string; title: string; status: MarketSummary['status'] };
  testId?: string;
}) {
  return (
    <HStack gap="2" flexWrap="wrap" minW="0" data-testid={testId}>
      <ChakraLink asChild fontWeight="semibold" wordBreak="break-word">
        <NextLink href={`/admin/markets/${market.id}`}>{market.title}</NextLink>
      </ChakraLink>
      <Badge colorPalette={MARKET_STATUS_PALETTE[market.status]} variant="subtle">
        {MARKET_STATUS_LABEL[market.status]}
      </Badge>
    </HStack>
  );
}

/**
 * Picks one market by its title for a 시장 제안 (#77, ADR-0089): the existing market a 중복 반려 names,
 * or the one a 채택 links. Any status, drafts included — the operators' own list
 * (`GET /admin/markets?q=`), the 관련 시장 panel's search (ADR-0068) with its query, its rules for
 * the term and its results ladder (`relatedSearchSection`: no rows of an earlier term stand under
 * a new one, so 선택 never picks a market the submitted search did not find). Once picked, the
 * market stands alone with 다시 고르기.
 */
export function MarketPicker({
  label,
  picked,
  onPick,
  error,
  testId,
}: {
  label: string;
  picked: MarketSummary | null;
  onPick: (market: MarketSummary | null) => void;
  error?: string;
  testId: string;
}) {
  const [input, setInput] = useState('');
  const [term, setTerm] = useState<string | undefined>(undefined);
  const search = useAdminRelatedSearch(term);
  const results = search.data?.pages.flatMap((page) => page.items) ?? [];
  const section = relatedSearchSection(search, results.length);

  if (picked !== null) {
    return (
      <Stack gap="1" data-testid={testId}>
        <Text fontSize="sm" fontWeight="medium">
          {label}
        </Text>
        <HStack
          justify="space-between"
          borderWidth="1px"
          borderRadius="l2"
          p="3"
          gap="3"
          flexWrap="wrap"
          data-testid={`${testId}-picked`}
        >
          <AdminMarketLine market={picked} />
          <Button
            size="sm"
            variant="outline"
            onClick={() => onPick(null)}
            data-testid={`${testId}-repick`}
          >
            {copy.adminProposalRepick}
          </Button>
        </HStack>
      </Stack>
    );
  }

  return (
    <Stack gap="3" data-testid={testId}>
      <Field.Root invalid={error !== undefined}>
        <Field.Label>{label}</Field.Label>
        <HStack gap="2" w="full">
          <Input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              // Inside another form: Enter searches here rather than submitting that form.
              if (event.key !== 'Enter') return;
              event.preventDefault();
              const next = relatedSearchSubmit(input, term);
              if (next.refetch) void search.refetch();
              else setTerm(next.term);
            }}
            placeholder={copy.adminRelatedSearchPlaceholder}
            // The API's bound on a term: a pasted title past it would read as no term.
            maxLength={SEARCH_INPUT_MAX_LENGTH}
            autoComplete="off"
            aria-label={`${label} ${copy.adminProposalPickMarket}`}
            data-testid={`${testId}-input`}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              const next = relatedSearchSubmit(input, term);
              if (next.refetch) void search.refetch();
              else setTerm(next.term);
            }}
            data-testid={`${testId}-submit`}
          >
            {copy.adminRelatedSearchSubmit}
          </Button>
        </HStack>
        <Field.ErrorText>{error}</Field.ErrorText>
      </Field.Root>

      {term !== undefined &&
        (section.body === 'pending' ? (
          <Skeleton height="12" />
        ) : section.body === 'failed' ? (
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.errUnknown}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        ) : section.body === 'empty' ? (
          <Text color="fg.muted" fontSize="sm" data-testid={`${testId}-empty`}>
            {copy.adminRelatedSearchEmpty}
          </Text>
        ) : (
          <Stack gap="2" data-testid={`${testId}-results`}>
            {results.map((market) => (
              <HStack
                key={market.id}
                justify="space-between"
                borderWidth="1px"
                borderRadius="l2"
                p="3"
                gap="3"
                flexWrap="wrap"
              >
                <AdminMarketLine market={market} />
                <Button
                  size="sm"
                  onClick={() => onPick(market)}
                  // One 선택 per result: named after its market, so a list of buttons says which.
                  aria-label={`${market.title} ${copy.adminProposalPick}`}
                  data-testid={`${testId}-pick-${market.id}`}
                >
                  {copy.adminProposalPick}
                </Button>
              </HStack>
            ))}
            {section.more && (
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={search.isFetchingNextPage}
                onClick={() => void search.fetchNextPage()}
              >
                {copy.loadMore}
              </Button>
            )}
          </Stack>
        ))}
    </Stack>
  );
}
