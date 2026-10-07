'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  HStack,
  Link as ChakraLink,
  NativeSelect,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { MARKET_STATUSES, type MarketStatus, formatP, parsePAmount } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { ADMIN_MARKETS_KEY, useCategories } from '@/hooks/use-admin-markets';
import { api, unwrap } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import {
  MARKET_STATUS_LABEL,
  MARKET_STATUS_PALETTE,
  formatYesPrice,
  isAwaitingResolution,
  isAwaitingSettlement,
  isClosingSoon,
  marketFormError,
  transitionErrorMessage,
} from '@/lib/market-admin';
import {
  EMPTY_MARKET_FORM,
  type MarketFormValues,
  marketFormSchema,
  toCreateMarketBody,
} from '@/lib/market-form';
import { MarketFormFields } from './market-form-fields';

const createSchema = marketFormSchema();

/** PLAN 12 시장 목록 + 생성 폼. The status filter includes drafts, which the public list hides. */
export function AdminMarkets() {
  const [status, setStatus] = useState<MarketStatus | ''>('');

  // Cursor-paginated, 20 per page (PLAN 7), newest first; the same 더 보기 idiom as the coupon
  // screen. Keyed by filter under the shared prefix so a write invalidates every filter; the
  // previous filter's rows stay up while the next loads (as the user search does), so
  // changing the filter does not flash the skeleton.
  const markets = useInfiniteQuery({
    queryKey: [...ADMIN_MARKETS_KEY, status],
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/admin/markets', {
          params: {
            query: {
              ...(status ? { status } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const rows = markets.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Stack gap="4">
      <CreateMarketCard />

      {/* A Field, not a Text beside the select: only the label's `htmlFor` gives the select an
          accessible name. Horizontal and shrink-wrapped, so it reads as the one-line filter it
          was. */}
      <Field.Root orientation="horizontal" w="auto" gap="2">
        <Field.Label flex="0 0 auto">{copy.adminMarketStatusFilter}</Field.Label>
        <NativeSelect.Root maxW="48" size="sm">
          <NativeSelect.Field
            value={status}
            onChange={(event) => setStatus(event.target.value as MarketStatus | '')}
            data-testid="market-status-filter"
          >
            <option value="">{copy.adminMarketStatusAll}</option>
            {MARKET_STATUSES.map((value) => (
              <option key={value} value={value}>
                {MARKET_STATUS_LABEL[value]}
              </option>
            ))}
          </NativeSelect.Field>
          <NativeSelect.Indicator />
        </NativeSelect.Root>
      </Field.Root>

      {markets.isPending ? (
        <Skeleton height="24" />
      ) : markets.isError ? (
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errUnknown}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      ) : rows.length === 0 ? (
        <Text color="fg.muted">{copy.adminNoMarkets}</Text>
      ) : (
        <Stack gap="2">
          {rows.map((market) => (
            <HStack
              key={market.id}
              justify="space-between"
              borderWidth="1px"
              borderRadius="l2"
              p="3"
              gap="3"
              flexWrap="wrap"
              data-testid={`admin-market-${market.id}`}
            >
              <Stack gap="0.5" minW="0">
                <HStack gap="2" flexWrap="wrap">
                  <ChakraLink asChild fontWeight="semibold">
                    <NextLink href={`/admin/markets/${market.id}`}>{market.title}</NextLink>
                  </ChakraLink>
                  <Badge colorPalette={MARKET_STATUS_PALETTE[market.status]} variant="subtle">
                    {MARKET_STATUS_LABEL[market.status]}
                  </Badge>
                  {isClosingSoon(market) && (
                    <Badge colorPalette="orange" variant="solid">
                      {copy.adminMarketClosingSoon}
                    </Badge>
                  )}
                  {/* The two "waits on someone" badges (ADR-0046): closed waits for the admin's
                      판정, resolved for the worker's settlement — a resolved row that keeps its
                      badge is a failing step, which the detail's 정산 단계 panel names. */}
                  {isAwaitingResolution(market.status) && (
                    <Badge colorPalette="brand" variant="solid">
                      {copy.adminMarketAwaitingResolution}
                    </Badge>
                  )}
                  {isAwaitingSettlement(market.status) && (
                    <Badge colorPalette="brand" variant="solid">
                      {copy.adminMarketAwaitingSettlement}
                    </Badge>
                  )}
                </HStack>
                <Text fontSize="xs" color="fg.muted">
                  {market.category.nameKo} · {formatYesPrice(market.lastPrice)} ·{' '}
                  {copy.marketVolume} {formatP(parsePAmount(market.volumeP))} ·{' '}
                  {copy.adminMarketCloseAtShort} {formatKst(market.closeAt)}
                </Text>
              </Stack>
            </HStack>
          ))}
          {markets.hasNextPage && (
            <Button
              alignSelf="center"
              size="sm"
              variant="ghost"
              loading={markets.isFetchingNextPage}
              onClick={() => void markets.fetchNextPage()}
              data-testid="admin-markets-more"
            >
              {copy.loadMore}
            </Button>
          )}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * 시장 만들기 → a draft (design 3.4). On success the admin lands on the detail page, where
 * 열기 is: a draft cannot be opened from here, and the rules it may still lack live there.
 */
function CreateMarketCard() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const categories = useCategories();

  const form = useForm<MarketFormValues>({
    resolver: zodResolver(createSchema),
    defaultValues: EMPTY_MARKET_FORM,
  });
  const {
    handleSubmit,
    setError,
    formState: { isSubmitting },
  } = form;

  const create = useMutation({
    mutationFn: async (values: MarketFormValues) =>
      unwrap(await api.POST('/api/v1/admin/markets', { body: toCreateMarketBody(values) })).data,
    onSuccess: async (market) => {
      toaster.create({
        type: 'success',
        title: copy.adminMarketCreated,
        description: market.title,
      });
      await queryClient.invalidateQueries({ queryKey: ADMIN_MARKETS_KEY });
      router.push(`/admin/markets/${market.id}`);
    },
    onError: (error) => {
      // A taken slug or a retired category lands on its field (design §4); the rest — and a
      // VALIDATION_ERROR naming nothing the form has — is the toast.
      const fieldError = marketFormError(error);
      if (fieldError) {
        setError(fieldError.field, { message: fieldError.message });
        return;
      }
      toaster.create({ type: 'error', title: transitionErrorMessage(error) });
    },
  });

  // Reset only on success (the coupon screen's rule): a refused form keeps what was typed.
  // Nothing to reset here either — the page navigates away.
  const submit = handleSubmit(async (values) => {
    await create.mutateAsync(values).catch(() => undefined); // reported by onError
  });

  return (
    <Card.Root>
      <Card.Header>
        <Text fontWeight="semibold">{copy.adminMarketCreate}</Text>
      </Card.Header>
      <Card.Body>
        {/* Only a first load that failed has no list to offer; a refetch that failed keeps the
            cached categories, and with them the form and whatever is typed into it. */}
        {categories.isPending ? (
          <Skeleton height="24" />
        ) : categories.isLoadingError ? (
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.errUnknown}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        ) : (
          <form onSubmit={(e) => void submit(e)} noValidate>
            <Stack gap="3">
              <MarketFormFields form={form} categories={categories.data} showSlug />
              <Button
                type="submit"
                size="sm"
                alignSelf="flex-start"
                loading={isSubmitting}
                data-testid="market-create"
              >
                {copy.adminMarketCreate}
              </Button>
            </Stack>
          </form>
        )}
      </Card.Body>
    </Card.Root>
  );
}
