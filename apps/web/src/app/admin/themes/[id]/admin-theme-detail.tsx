'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  DataList,
  Field,
  Heading,
  HStack,
  Input,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { THEME_NOTICE_BODY_MAX, THEME_NOTICE_TITLE_MAX, uuidParamSchema } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useEffect, useId, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { ThemeStatusBadge } from '@/components/theme/theme-card';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useAdminRelatedSearch } from '@/hooks/use-admin-markets';
import {
  applyAdminTheme,
  applyAdminThemeMarkets,
  useAdminTheme,
  useAdminThemeMarkets,
} from '@/hooks/use-admin-themes';
import {
  EMPTY_THEME_NOTICE_FORM,
  type ThemeFormValues,
  type ThemeNoticeFormValues,
  formatThemeMarketLinked,
  formatThemeNoticeByline,
  themeActorName,
  themeFormError,
  themeFormSchema,
  themeFormValues,
  themeNoticeFormSchema,
  themePickState,
  themeSlugEditable,
  themeWriteErrorMessage,
  toThemeNoticeBody,
  toUpdateThemeBody,
} from '@/lib/admin-themes';
import {
  type AdminTheme,
  type AdminThemeMarket,
  type AdminThemeNotice,
  api,
  isApiError,
  unwrap,
} from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { AFTER_SAVE_RESET, FOLLOW_SERVER_RESET } from '@/lib/market-form';
import { SEARCH_INPUT_MAX_LENGTH } from '@/lib/market-search';
import { listSection } from '@/lib/query-client';
import { relatedSearchSection, relatedSearchSubmit } from '@/lib/related-markets';
import { formatThemePeriod, themePath } from '@/lib/themes';
import {
  ConfirmDialog,
  RefreshFailedNotice,
  RelatedMarketLine,
} from '../../markets/[id]/admin-market-detail';
import { ThemeFormFields } from '../theme-form-fields';

/**
 * 테마 상세(관리) (#81, ADR-0088): one theme — its publication, the edit form, its markets and its
 * notices. Owner decisions (ADR-0069 decision 4, the #81 rows, and of 2026-10-19): every admin may
 * do all of it at any time; a theme is unpublished and never deleted, and a notice hidden and
 * never deleted; publishing needs a market in the theme that is not a draft (the second round's
 * answer); the address is fixed once published, through an unpublish too;
 * every change records the admin and the time and asks no reason (the API's). Times are in Korean
 * time (`formatKst`, ADR-0063); the period is Korean dates as they are.
 */
export function AdminThemeDetail({ id }: { id: string }) {
  // A malformed id is a wrong address, so it is 찾을 수 없습니다 without a request.
  const themeId = uuidParamSchema.safeParse(id).data;
  const theme = useAdminTheme(themeId ?? '', themeId !== undefined);

  if (themeId === undefined || (theme.isError && isApiError(theme.error, 'NOT_FOUND'))) {
    return (
      <Stack gap="4">
        <BackLink />
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.adminThemeNotFound}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      </Stack>
    );
  }
  if (theme.isPending) return <Skeleton height="48" />;
  if (theme.isLoadingError) {
    return (
      <Stack gap="4">
        <BackLink />
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errUnknown}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      </Stack>
    );
  }

  const data = theme.data;
  return (
    <Stack gap="4">
      <BackLink />
      {theme.isRefetchError && (
        <RefreshFailedNotice testId="admin-theme-stale" onRetry={() => void theme.refetch()} />
      )}
      <Stack gap="1">
        <HStack gap="2" flexWrap="wrap" align="baseline">
          <Heading as="h3" size="lg" data-testid="admin-theme-name">
            {data.name}
          </Heading>
          <ThemeStatusBadge theme={data} />
          <Badge
            colorPalette={data.publishedAt === null ? 'gray' : 'green'}
            variant="subtle"
            data-testid="admin-theme-published"
          >
            {data.publishedAt === null ? copy.adminThemeUnpublished : copy.adminThemePublished}
          </Badge>
        </HStack>
        <Text fontSize="sm" color="fg.muted" fontFamily="mono">
          {themePath(data.slug)}
        </Text>
      </Stack>

      <PublishButtons theme={data} />

      <Card.Root>
        <Card.Body>
          <DataList.Root orientation="horizontal" size="sm">
            <Item label={copy.themePeriod}>{formatThemePeriod(data, theme.dataUpdatedAt)}</Item>
            <Item label={copy.adminThemeCreatedBy}>{themeActorName(data.createdBy)}</Item>
            <Item label={copy.adminThemeCreatedAt}>{formatKst(data.createdAt)}</Item>
            <Item label={copy.adminThemeUpdatedAt}>{formatKst(data.updatedAt)}</Item>
            <Item label={copy.adminThemePublishedAt}>
              {data.publishedAt === null ? '—' : formatKst(data.publishedAt)}
            </Item>
          </DataList.Root>
        </Card.Body>
      </Card.Root>

      <EditThemeCard theme={data} />
      {/* Keyed by the theme: a fresh search for each theme opened on this route. */}
      <ThemeMarketsPanel key={data.id} themeId={data.id} />
      <ThemeNoticesPanel theme={data} />
    </Stack>
  );
}

function BackLink() {
  return (
    <ChakraLink
      asChild
      fontSize="sm"
      colorPalette="brand"
      color="colorPalette.fg"
      alignSelf="flex-start"
    >
      <NextLink href="/admin/themes">← {copy.adminBackToThemes}</NextLink>
    </ChakraLink>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <DataList.Item>
      <DataList.ItemLabel>{label}</DataList.ItemLabel>
      <DataList.ItemValue>{children}</DataList.ItemValue>
    </DataList.Item>
  );
}

/**
 * 공개하기 · 비공개로 돌리기, and the public page while it is published. Publishing asks nothing (it
 * is undone by unpublishing); unpublishing asks first, since every public entry loses the theme at
 * once. Beside 공개하기 a line says what a publish needs — a market in the theme that is not a
 * draft (owner decisions 2026-10-19) — and is the button's description (`aria-describedby`), so a
 * screen reader says the rule with the button rather than only after a refusal, as the period
 * hint is the date fields'. A publish without such a market is refused by the API, which the toast
 * says in the same words; the server alone decides, since a draft may open meanwhile.
 */
function PublishButtons({ theme }: { theme: AdminTheme }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const publishHintId = useId();
  const published = theme.publishedAt !== null;
  const write = useMutation({
    mutationFn: async (to: 'publish' | 'unpublish') =>
      unwrap(
        to === 'publish'
          ? await api.POST('/api/v1/admin/themes/{id}/publish', {
              params: { path: { id: theme.id } },
            })
          : await api.POST('/api/v1/admin/themes/{id}/unpublish', {
              params: { path: { id: theme.id } },
            }),
      ).data,
    onSuccess: async (fresh, to) => {
      toaster.create({
        type: 'success',
        title: to === 'publish' ? copy.adminThemePublishDone : copy.adminThemeUnpublishDone,
      });
      setConfirming(false);
      await applyAdminTheme(queryClient, fresh);
    },
    onError: (error) => {
      setConfirming(false);
      toaster.create({ type: 'error', title: themeWriteErrorMessage(error) });
    },
  });
  return (
    <HStack gap="2" flexWrap="wrap">
      {published ? (
        <>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirming(true)}
            data-testid="theme-unpublish"
          >
            {copy.adminThemeUnpublish}
          </Button>
          <Button asChild size="sm" variant="ghost">
            <NextLink href={themePath(theme.slug) as Route} data-testid="theme-view-public">
              {copy.adminThemeViewPublic}
            </NextLink>
          </Button>
        </>
      ) : (
        <>
          <Button
            size="sm"
            loading={write.isPending}
            onClick={() => write.mutate('publish')}
            aria-describedby={publishHintId}
            data-testid="theme-publish"
          >
            {copy.adminThemePublish}
          </Button>
          <Text id={publishHintId} fontSize="sm" color="fg.muted" data-testid="theme-publish-hint">
            {copy.adminThemePublishHint}
          </Text>
        </>
      )}
      <ConfirmDialog
        testId="theme-unpublish-dialog"
        open={confirming}
        onClose={() => setConfirming(false)}
        title={copy.adminThemeUnpublishTitle}
        confirmLabel={copy.adminThemeUnpublish}
        loading={write.isPending}
        onConfirm={() => write.mutate('unpublish')}
      >
        <Text>{copy.adminThemeUnpublishBody}</Text>
      </ConfirmDialog>
    </HStack>
  );
}

/**
 * 수정: the address until the first publish, the name, the introduction and the period, at any
 * time (before, during and after the period, published or not). Only the fields that changed are
 * sent; a save that changes nothing sends nothing.
 */
function EditThemeCard({ theme }: { theme: AdminTheme }) {
  const queryClient = useQueryClient();
  const original = useMemo(() => themeFormValues(theme), [theme]);
  const slugFixed = !themeSlugEditable(theme);
  // `values` follows the server as the market edit form does (FOLLOW_SERVER_RESET): a refetch
  // that changed a field resets it unless the admin has edited it.
  const form = useForm<ThemeFormValues>({
    resolver: zodResolver(themeFormSchema),
    values: original,
    resetOptions: FOLLOW_SERVER_RESET,
  });
  const {
    handleSubmit,
    reset,
    resetField,
    setError,
    formState: { isSubmitting, isDirty },
  } = form;

  // Once the theme is published (here, or by another admin while this page is open) its address
  // is fixed and the field read-only: an unsaved slug typed before then is dropped, so the field
  // shows the real address and the form is not left dirty with a value no save would send
  // (`toUpdateThemeBody` leaves a fixed slug out). The `values` follow above does not do it: a
  // publish changes none of the form's fields, so the values stay equal and nothing resets.
  useEffect(() => {
    if (slugFixed) resetField('slug', { defaultValue: theme.slug });
  }, [slugFixed, theme.slug, resetField]);

  const update = useMutation({
    mutationFn: async (body: NonNullable<ReturnType<typeof toUpdateThemeBody>>) =>
      unwrap(
        await api.PATCH('/api/v1/admin/themes/{id}', { params: { path: { id: theme.id } }, body }),
      ).data,
    onSuccess: async (saved) => {
      toaster.create({ type: 'success', title: copy.adminThemeSaved });
      reset(themeFormValues(saved), AFTER_SAVE_RESET);
      await applyAdminTheme(queryClient, saved);
    },
    onError: (error) => {
      const fieldError = themeFormError(error);
      if (fieldError) {
        setError(fieldError.field, { message: fieldError.message });
        return;
      }
      toaster.create({ type: 'error', title: themeWriteErrorMessage(error) });
    },
  });

  const submit = handleSubmit(async (values) => {
    const body = toUpdateThemeBody(values, theme);
    if (body === undefined) return;
    await update.mutateAsync(body).catch(() => undefined); // reported by onError
  });

  return (
    <Card.Root>
      <Card.Header>
        <Text fontWeight="semibold">{copy.adminThemeEdit}</Text>
      </Card.Header>
      <Card.Body>
        <form onSubmit={(event) => void submit(event)} noValidate>
          <Stack gap="3">
            <ThemeFormFields form={form} slugFixed={slugFixed} />
            <Button
              type="submit"
              size="sm"
              alignSelf="flex-start"
              loading={isSubmitting}
              disabled={!isDirty}
              data-testid="theme-save"
            >
              {copy.save}
            </Button>
          </Stack>
        </form>
      </Card.Body>
    </Card.Root>
  );
}

/**
 * The theme's markets: every one in any status, the latest put in first, with who put it in and
 * when, each taken out after a confirmation; and the picker that finds markets by title (`GET
 * /admin/markets?q=`, the 관련 시장 picker's own request and rules) and puts one in with a click.
 * Free composition (ADR-0069 decision 4, '편성 규칙'): any status, no cap, a market in any number
 * of themes. Putting in or taking out changes nothing of the market (N05 §7). The picker's 더 보기
 * that failed keeps the results read so far and says so above its button (`LoadMoreFailed`, the
 * first read's `copy.errUnknown` — owner decision 2026-10-20 7, ADR-0075 5-14, as 관련 시장's
 * picker on the market detail).
 */
function ThemeMarketsPanel({ themeId }: { themeId: string }) {
  const queryClient = useQueryClient();
  const markets = useAdminThemeMarkets(themeId, true);
  const linkedIds = useMemo(
    () => new Set((markets.data ?? []).map((row) => row.id)),
    [markets.data],
  );
  const rows = markets.data ?? [];
  const section = listSection(markets, rows.length);
  const [removing, setRemoving] = useState<AdminThemeMarket | null>(null);
  const [input, setInput] = useState('');
  const [term, setTerm] = useState<string | undefined>(undefined);
  const search = useAdminRelatedSearch(term);
  const results = search.data?.pages.flatMap((page) => page.items) ?? [];
  const searchSection = relatedSearchSection(search, results.length);

  const onError = (error: unknown) =>
    toaster.create({
      type: 'error',
      title: isApiError(error, 'NOT_FOUND') ? copy.adminMarketNotFound : copy.errUnknown,
    });

  const link = useMutation({
    mutationFn: async (marketId: string) =>
      unwrap(
        await api.POST('/api/v1/admin/themes/{id}/markets', {
          params: { path: { id: themeId } },
          body: { marketId },
        }),
      ).data,
    onSuccess: async (fresh) => {
      toaster.create({ type: 'success', title: copy.adminThemeMarketLinked });
      await applyAdminThemeMarkets(queryClient, themeId, fresh);
    },
    onError,
  });

  const unlink = useMutation({
    mutationFn: async (marketId: string) =>
      unwrap(
        await api.DELETE('/api/v1/admin/themes/{id}/markets/{marketId}', {
          params: { path: { id: themeId, marketId } },
        }),
      ).data,
    onSuccess: async (fresh) => {
      toaster.create({ type: 'success', title: copy.adminThemeMarketUnlinked });
      setRemoving(null);
      await applyAdminThemeMarkets(queryClient, themeId, fresh);
    },
    onError,
  });

  return (
    <Card.Root data-testid="admin-theme-markets">
      <Card.Header>
        <Stack gap="1">
          <Text fontWeight="semibold">{copy.adminThemeMarkets}</Text>
          <Text fontSize="sm" color="fg.muted">
            {copy.adminThemeMarketsHint}
          </Text>
        </Stack>
      </Card.Header>
      <Card.Body>
        <Stack gap="5">
          <Stack gap="3">
            {section.stale && (
              <RefreshFailedNotice
                testId="admin-theme-markets-stale"
                onRetry={() => void markets.refetch()}
              />
            )}
            {section.body === 'pending' ? (
              <Skeleton height="12" />
            ) : section.body === 'failed' ? (
              <Alert.Root status="error" role="alert">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{copy.errUnknown}</Alert.Description>
                </Alert.Content>
              </Alert.Root>
            ) : section.body === 'empty' ? (
              <Text color="fg.muted" data-testid="admin-theme-markets-empty">
                {copy.adminThemeMarketsEmpty}
              </Text>
            ) : (
              <Stack gap="2" data-testid="admin-theme-markets-list">
                {rows.map((row) => (
                  <HStack
                    key={row.id}
                    justify="space-between"
                    borderWidth="1px"
                    borderRadius="l2"
                    p="3"
                    gap="3"
                    flexWrap="wrap"
                    data-testid={`admin-theme-market-${row.id}`}
                  >
                    <RelatedMarketLine market={row}>
                      <Text fontSize="xs" color="fg.muted">
                        {formatThemeMarketLinked(row)}
                      </Text>
                    </RelatedMarketLine>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setRemoving(row)}
                      data-testid={`admin-theme-market-unlink-${row.id}`}
                    >
                      {copy.adminThemeMarketUnlink}
                    </Button>
                  </HStack>
                ))}
              </Stack>
            )}
          </Stack>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              const next = relatedSearchSubmit(input, term);
              if (next.refetch) void search.refetch();
              else setTerm(next.term);
            }}
            noValidate
          >
            <Field.Root>
              <Field.Label>{copy.adminThemeMarketSearchLabel}</Field.Label>
              <HStack gap="2" w="full">
                <Input
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder={copy.adminRelatedSearchPlaceholder}
                  maxLength={SEARCH_INPUT_MAX_LENGTH}
                  autoComplete="off"
                  data-testid="admin-theme-market-search-input"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  data-testid="admin-theme-market-search-submit"
                >
                  {copy.adminThemeMarketSearchSubmit}
                </Button>
              </HStack>
            </Field.Root>
          </form>

          {term !== undefined && (
            <Stack gap="3">
              {searchSection.stale && (
                <RefreshFailedNotice
                  testId="admin-theme-market-search-stale"
                  onRetry={() => void search.refetch()}
                />
              )}
              {searchSection.body === 'pending' ? (
                <Skeleton height="12" />
              ) : searchSection.body === 'failed' ? (
                <Alert.Root status="error" role="alert">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>{copy.errUnknown}</Alert.Description>
                  </Alert.Content>
                </Alert.Root>
              ) : searchSection.body === 'empty' ? (
                <Text color="fg.muted" data-testid="admin-theme-market-search-empty">
                  {copy.adminRelatedSearchEmpty}
                </Text>
              ) : (
                <Stack gap="2" data-testid="admin-theme-market-search-results">
                  {results.map((row) => (
                    <HStack
                      key={row.id}
                      justify="space-between"
                      borderWidth="1px"
                      borderRadius="l2"
                      p="3"
                      gap="3"
                      flexWrap="wrap"
                      data-testid={`admin-theme-market-result-${row.id}`}
                    >
                      <RelatedMarketLine market={row} />
                      {themePickState(row.id, linkedIds) === 'linkable' ? (
                        <Button
                          size="sm"
                          loading={link.isPending && link.variables === row.id}
                          disabled={link.isPending}
                          onClick={() => link.mutate(row.id)}
                          data-testid={`admin-theme-market-link-${row.id}`}
                        >
                          {copy.adminThemeMarketLink}
                        </Button>
                      ) : (
                        <Badge variant="subtle" data-testid={`admin-theme-market-in-${row.id}`}>
                          {copy.adminThemeMarketAlreadyLinked}
                        </Badge>
                      )}
                    </HStack>
                  ))}
                  {searchSection.more && (
                    <>
                      <LoadMoreFailed
                        list={search}
                        message={copy.errUnknown}
                        data-testid="admin-theme-market-search-more-failed"
                      />
                      <Button
                        alignSelf="center"
                        size="sm"
                        variant="ghost"
                        loading={search.isFetchingNextPage}
                        onClick={() => void search.fetchNextPage()}
                        data-testid="admin-theme-market-search-more"
                      >
                        {copy.loadMore}
                      </Button>
                    </>
                  )}
                </Stack>
              )}
            </Stack>
          )}
        </Stack>

        <ConfirmDialog
          testId="admin-theme-market-unlink"
          open={removing !== null}
          onClose={() => setRemoving(null)}
          title={copy.adminThemeMarketUnlinkTitle}
          confirmLabel={copy.adminThemeMarketUnlink}
          loading={unlink.isPending}
          onConfirm={() => {
            if (removing) unlink.mutate(removing.id);
          }}
        >
          <Stack gap="2">
            <Text fontWeight="medium">{removing?.title}</Text>
            <Text>{copy.adminThemeMarketUnlinkBody}</Text>
          </Stack>
        </ConfirmDialog>
      </Card.Body>
    </Card.Root>
  );
}

/**
 * The theme page's notices (owner decision 2026-10-19): plain text, up to 100 and 5,000
 * characters, whose web addresses the page links; written, edited — the page then marks it
 * 수정됨 — hidden after a confirmation and shown again, never deleted. Every notice is here, hidden
 * ones too, with who wrote it.
 */
function ThemeNoticesPanel({ theme }: { theme: AdminTheme }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [hiding, setHiding] = useState<AdminThemeNotice | null>(null);

  const create = useMutation({
    mutationFn: async (values: ThemeNoticeFormValues) =>
      unwrap(
        await api.POST('/api/v1/admin/themes/{id}/notices', {
          params: { path: { id: theme.id } },
          body: toThemeNoticeBody(values),
        }),
      ).data,
    onSuccess: async (fresh) => {
      toaster.create({ type: 'success', title: copy.adminThemeNoticeCreated });
      await applyAdminTheme(queryClient, fresh);
    },
    onError: (error) => toaster.create({ type: 'error', title: themeWriteErrorMessage(error) }),
  });

  const visibility = useMutation({
    mutationFn: async ({ noticeId, to }: { noticeId: string; to: 'hide' | 'show' }) =>
      unwrap(
        to === 'hide'
          ? await api.POST('/api/v1/admin/themes/{id}/notices/{noticeId}/hide', {
              params: { path: { id: theme.id, noticeId } },
            })
          : await api.POST('/api/v1/admin/themes/{id}/notices/{noticeId}/show', {
              params: { path: { id: theme.id, noticeId } },
            }),
      ).data,
    onSuccess: async (fresh, { to }) => {
      toaster.create({
        type: 'success',
        title: to === 'hide' ? copy.adminThemeNoticeHidden : copy.adminThemeNoticeShown,
      });
      setHiding(null);
      await applyAdminTheme(queryClient, fresh);
    },
    onError: (error) => {
      setHiding(null);
      toaster.create({ type: 'error', title: themeWriteErrorMessage(error) });
    },
  });

  return (
    <Card.Root data-testid="admin-theme-notices">
      <Card.Header>
        <Stack gap="1">
          <Text fontWeight="semibold">{copy.adminThemeNotices}</Text>
          <Text fontSize="sm" color="fg.muted">
            {copy.adminThemeNoticesHint}
          </Text>
        </Stack>
      </Card.Header>
      <Card.Body>
        <Stack gap="5">
          <NoticeForm
            testId="theme-notice-new"
            submitLabel={copy.adminThemeNoticeCreate}
            initial={EMPTY_THEME_NOTICE_FORM}
            resetOnSuccess
            onSubmit={(values) => create.mutateAsync(values)}
          />
          {theme.notices.length === 0 ? (
            <Text color="fg.muted" data-testid="admin-theme-notices-empty">
              {copy.adminThemeNoticesEmpty}
            </Text>
          ) : (
            <Stack gap="3" data-testid="admin-theme-notices-list">
              {theme.notices.map((notice) => (
                <Stack
                  key={notice.id}
                  gap="2"
                  borderWidth="1px"
                  borderRadius="l2"
                  p="3"
                  data-testid={`admin-theme-notice-${notice.id}`}
                >
                  {editing === notice.id ? (
                    <EditNotice theme={theme} notice={notice} onDone={() => setEditing(null)} />
                  ) : (
                    <>
                      <HStack gap="2" flexWrap="wrap">
                        <Text fontWeight="semibold">{notice.title}</Text>
                        {notice.hiddenAt !== null && (
                          <Badge
                            variant="subtle"
                            data-testid={`admin-theme-notice-hidden-${notice.id}`}
                          >
                            {copy.adminThemeNoticeHiddenTag}
                          </Badge>
                        )}
                      </HStack>
                      <Text fontSize="xs" color="fg.muted">
                        {formatThemeNoticeByline(notice)}
                      </Text>
                      <Text fontSize="sm" whiteSpace="pre-wrap" wordBreak="break-word">
                        {notice.body}
                      </Text>
                      <HStack gap="2">
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => setEditing(notice.id)}
                          data-testid={`admin-theme-notice-edit-${notice.id}`}
                        >
                          {copy.adminThemeNoticeEdit}
                        </Button>
                        {notice.hiddenAt === null ? (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => setHiding(notice)}
                            data-testid={`admin-theme-notice-hide-${notice.id}`}
                          >
                            {copy.adminThemeNoticeHide}
                          </Button>
                        ) : (
                          <Button
                            size="xs"
                            variant="outline"
                            loading={
                              visibility.isPending && visibility.variables.noticeId === notice.id
                            }
                            onClick={() => visibility.mutate({ noticeId: notice.id, to: 'show' })}
                            data-testid={`admin-theme-notice-show-${notice.id}`}
                          >
                            {copy.adminThemeNoticeShow}
                          </Button>
                        )}
                      </HStack>
                    </>
                  )}
                </Stack>
              ))}
            </Stack>
          )}
        </Stack>
        <ConfirmDialog
          testId="admin-theme-notice-hide"
          open={hiding !== null}
          onClose={() => setHiding(null)}
          title={copy.adminThemeNoticeHideTitle}
          confirmLabel={copy.adminThemeNoticeHide}
          loading={visibility.isPending}
          onConfirm={() => {
            if (hiding) visibility.mutate({ noticeId: hiding.id, to: 'hide' });
          }}
        >
          <Stack gap="2">
            <Text fontWeight="medium">{hiding?.title}</Text>
            <Text>{copy.adminThemeNoticeHideBody}</Text>
          </Stack>
        </ConfirmDialog>
      </Card.Body>
    </Card.Root>
  );
}

/** A notice open for editing in its place: the title and the body, saved or cancelled. */
function EditNotice({
  theme,
  notice,
  onDone,
}: {
  theme: AdminTheme;
  notice: AdminThemeNotice;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: async (values: ThemeNoticeFormValues) => {
      const next = toThemeNoticeBody(values);
      // Only what changed; the same text again is no request.
      const body = {
        ...(next.title === notice.title ? {} : { title: next.title }),
        ...(next.body === notice.body ? {} : { body: next.body }),
      };
      if (Object.keys(body).length === 0) return undefined;
      return unwrap(
        await api.PATCH('/api/v1/admin/themes/{id}/notices/{noticeId}', {
          params: { path: { id: theme.id, noticeId: notice.id } },
          body,
        }),
      ).data;
    },
    onSuccess: async (fresh) => {
      onDone();
      if (fresh === undefined) return;
      toaster.create({ type: 'success', title: copy.adminThemeNoticeSaved });
      await applyAdminTheme(queryClient, fresh);
    },
    onError: (error) => toaster.create({ type: 'error', title: themeWriteErrorMessage(error) }),
  });
  return (
    <NoticeForm
      testId={`theme-notice-edit-form-${notice.id}`}
      submitLabel={copy.save}
      initial={{ title: notice.title, body: notice.body }}
      onSubmit={(values) => update.mutateAsync(values)}
      onCancel={onDone}
    />
  );
}

/**
 * A notice's two fields with their bounds, for writing one and for editing one. A refused submit
 * keeps what was typed; a written notice empties the form when `resetOnSuccess`.
 */
function NoticeForm({
  testId,
  submitLabel,
  initial,
  resetOnSuccess = false,
  onSubmit,
  onCancel,
}: {
  testId: string;
  submitLabel: string;
  initial: ThemeNoticeFormValues;
  resetOnSuccess?: boolean;
  onSubmit: (values: ThemeNoticeFormValues) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const form = useForm<ThemeNoticeFormValues>({
    resolver: zodResolver(themeNoticeFormSchema),
    defaultValues: initial,
  });
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = form;
  const submit = handleSubmit(async (values) => {
    const done = await onSubmit(values).then(
      () => true,
      () => false, // reported by the caller's onError
    );
    if (done && resetOnSuccess) reset(EMPTY_THEME_NOTICE_FORM);
  });
  return (
    <form onSubmit={(event) => void submit(event)} noValidate data-testid={testId}>
      <Stack gap="3">
        <Field.Root invalid={!!errors.title} required>
          <Field.Label>{copy.adminThemeNoticeTitle}</Field.Label>
          <Input
            autoComplete="off"
            maxLength={THEME_NOTICE_TITLE_MAX}
            data-testid={`${testId}-title`}
            {...register('title')}
          />
          <Field.ErrorText>{errors.title?.message}</Field.ErrorText>
        </Field.Root>
        <Field.Root invalid={!!errors.body} required>
          <Field.Label>{copy.adminThemeNoticeBody}</Field.Label>
          <Textarea
            rows={4}
            maxLength={THEME_NOTICE_BODY_MAX}
            data-testid={`${testId}-body`}
            {...register('body')}
          />
          <Field.ErrorText>{errors.body?.message}</Field.ErrorText>
        </Field.Root>
        <HStack gap="2">
          <Button type="submit" size="sm" loading={isSubmitting} data-testid={`${testId}-submit`}>
            {submitLabel}
          </Button>
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              {copy.cancel}
            </Button>
          )}
        </HStack>
      </Stack>
    </form>
  );
}
