'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  HStack,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { ThemeStatusBadge } from '@/components/theme/theme-card';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { OperatorFieldset } from '@/components/ui/operator-fieldset';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { ADMIN_THEMES_KEY, applyAdminTheme, useAdminThemes } from '@/hooks/use-admin-themes';
import { useOperatorId } from '@/hooks/use-operator';
import { useSessionChanged } from '@/hooks/use-session-changed';
import {
  EMPTY_THEME_FORM,
  type ThemeFormValues,
  themeFormError,
  themeFormSchema,
  themeWriteErrorMessage,
  toCreateThemeBody,
} from '@/lib/admin-themes';
import { type CreateThemeBody, api, unwrap } from '@/lib/api';
import { formatThemePeriod } from '@/lib/themes';
import { ThemeFormFields } from './theme-form-fields';

/**
 * 테마 (#81, ADR-0088) for admins: 테마 만들기, then every theme, published or not, the newest
 * first, 20 a page — each with its status, its publication and its period, opening its detail.
 * A 더 보기 that failed keeps the themes read so far and says so above its button
 * (`LoadMoreFailed`, the first read's `copy.errUnknown` — owner decision 2026-10-20 7, ADR-0075
 * 5-14, as every 더 보기 list); only a first read that failed (`isLoadingError`) shows the error.
 */
export function AdminThemes() {
  const themes = useAdminThemes();
  // The admin on screen: 테마 만들기 is drawn again for each (ADR-0092 answer 1, `OperatorFieldset`).
  const operatorId = useOperatorId();
  const rows = themes.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Stack gap="4">
      <CreateThemeCard key={operatorId ?? ''} />
      {themes.isPending ? (
        <Skeleton height="24" />
      ) : themes.isLoadingError ? (
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errUnknown}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      ) : rows.length === 0 ? (
        <Text color="fg.muted" data-testid="admin-themes-empty">
          {copy.adminThemesEmpty}
        </Text>
      ) : (
        <Stack gap="2" data-testid="admin-themes-list">
          {rows.map((theme) => (
            <HStack
              key={theme.id}
              justify="space-between"
              borderWidth="1px"
              borderRadius="l2"
              p="3"
              gap="3"
              flexWrap="wrap"
              data-testid={`admin-theme-${theme.id}`}
            >
              <Stack gap="0.5" minW="0">
                <HStack gap="2" flexWrap="wrap">
                  <ChakraLink asChild fontWeight="semibold">
                    <NextLink href={`/admin/themes/${theme.id}`}>{theme.name}</NextLink>
                  </ChakraLink>
                  <ThemeStatusBadge theme={theme} />
                  <Badge
                    colorPalette={theme.publishedAt === null ? 'gray' : 'green'}
                    variant="subtle"
                  >
                    {theme.publishedAt === null
                      ? copy.adminThemeUnpublished
                      : copy.adminThemePublished}
                  </Badge>
                </HStack>
                <Text fontSize="xs" color="fg.muted">
                  /themes/{theme.slug} · {formatThemePeriod(theme, themes.dataUpdatedAt)}
                </Text>
              </Stack>
            </HStack>
          ))}
          {themes.hasNextPage && (
            <>
              <LoadMoreFailed
                list={themes}
                message={copy.errUnknown}
                data-testid="admin-themes-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={themes.isFetchingNextPage}
                onClick={() => void themes.fetchNextPage()}
                data-testid="admin-themes-more"
              >
                {copy.loadMore}
              </Button>
            </>
          )}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * 테마 만들기 → an unpublished theme. On success the admin lands on its detail, where markets go
 * in and 공개하기 is (a theme is published with a market in it, owner decision 2026-10-19). Made
 * as the admin on screen (`useOperatorId`, ADR-0092): 만들기 waits for `GET /me`, and the cookie
 * of another account is refused (`copy.sessionChanged`, the session asked again). The card is
 * drawn for that admin (keyed by it above) and its fields wait for it (`OperatorFieldset`):
 * `['me']` turning from A to B in place drops what A typed (owner decision 2026-10-26 17:21
 * answer 1).
 */
function CreateThemeCard() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const operatorId = useOperatorId();
  const sessionChanged = useSessionChanged();
  const form = useForm<ThemeFormValues>({
    resolver: zodResolver(themeFormSchema),
    defaultValues: EMPTY_THEME_FORM,
  });
  const {
    handleSubmit,
    setError,
    formState: { isSubmitting },
  } = form;

  const create = useMutation({
    mutationFn: async (body: CreateThemeBody) =>
      unwrap(await api.POST('/api/v1/admin/themes', { body })).data,
    onSuccess: async (theme) => {
      toaster.create({ type: 'success', title: copy.adminThemeCreated, description: theme.name });
      await Promise.all([
        applyAdminTheme(queryClient, theme),
        queryClient.invalidateQueries({ queryKey: ADMIN_THEMES_KEY }),
      ]);
      router.push(`/admin/themes/${theme.id}`);
    },
    onError: (error) => {
      sessionChanged(error);
      // A taken or malformed slug and the other fields' bounds land on their field; the rest is
      // the toast.
      const fieldError = themeFormError(error);
      if (fieldError) {
        setError(fieldError.field, { message: fieldError.message });
        return;
      }
      toaster.create({ type: 'error', title: themeWriteErrorMessage(error) });
    },
  });

  const submit = handleSubmit(async (values) => {
    if (operatorId === undefined) return;
    await create
      .mutateAsync({ ...toCreateThemeBody(values), expectedAccountId: operatorId })
      .catch(() => undefined); // reported by onError
  });

  return (
    <Card.Root>
      <Card.Header>
        <Text fontWeight="semibold">{copy.adminThemeCreate}</Text>
      </Card.Header>
      <Card.Body>
        <form onSubmit={(event) => void submit(event)} noValidate>
          <OperatorFieldset disabled={operatorId === undefined}>
            <Stack gap="3">
              <ThemeFormFields form={form} />
              <Button
                type="submit"
                size="sm"
                alignSelf="flex-start"
                loading={isSubmitting}
                disabled={operatorId === undefined}
                data-testid="theme-create"
              >
                {copy.adminThemeCreate}
              </Button>
            </Stack>
          </OperatorFieldset>
        </form>
      </Card.Body>
    </Card.Root>
  );
}
