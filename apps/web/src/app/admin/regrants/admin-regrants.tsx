'use client';

import { Alert, Button, HStack, Link as ChakraLink, Skeleton, Stack, Text } from '@chakra-ui/react';
import { formatCoin, parseCoinAmount } from '@buddha/shared';
import type { Route } from 'next';
import NextLink from 'next/link';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useAdminRegrants } from '@/hooks/use-admin-regrants';
import { nicknameShown } from '@/lib/account-closure';
import { type AdminRegrant } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { adminUserModerationPath } from '@/lib/moderation';
import { ADMIN_RELEASE_SETTINGS_PATH } from '@/lib/retention';

/**
 * 재지급 기록 (#74, ADR-0155; owner answer 2026-11-21 3: «관리자 화면은 지급 기록 조회만»): every
 * re-grant a member applied for in the wallet and got in that request, newest first — when, the
 * account (its nickname, '탈퇴한 사용자' once closed, to its member page; its public id), the Coin
 * given and the 가용 코인 read under the lock just before (소진 확인). Read-only: no admin gives,
 * adjusts or takes back Coin (ADR-0107). The amount and the conditions are the six release
 * settings, so the screen says so above the list with the way there. 20 records per page with 더
 * 보기 (A-M2-5); a 더 보기 that failed keeps the records read so far and says so above its button
 * (`LoadMoreFailed`, ADR-0075 5-14); only a first read that failed shows the error in their place.
 */
export function AdminRegrants() {
  const regrants = useAdminRegrants();
  const rows = regrants.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Stack gap="4" data-testid="admin-regrants">
      <Stack gap="2">
        <Text color="fg.muted">{copy.adminRegrantsIntro}</Text>
        <Text fontSize="sm" color="fg.muted" data-testid="admin-regrants-settings-notice">
          {copy.adminRegrantsSettingsNotice}{' '}
          <ChakraLink asChild colorPalette="brand" color="colorPalette.fg">
            <NextLink href={ADMIN_RELEASE_SETTINGS_PATH} data-testid="admin-regrants-settings-link">
              {copy.adminRegrantsSettingsLink}
            </NextLink>
          </ChakraLink>
        </Text>
      </Stack>
      {regrants.isPending ? (
        <Skeleton height="24" />
      ) : regrants.isLoadingError ? (
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errUnknown}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      ) : rows.length === 0 ? (
        <Text color="fg.muted" data-testid="admin-regrants-empty">
          {copy.adminRegrantsEmpty}
        </Text>
      ) : (
        <Stack gap="2">
          <Stack as="ol" gap="2" listStyleType="none" data-testid="admin-regrants-list">
            {rows.map((regrant) => (
              <RegrantRow key={regrant.id} regrant={regrant} />
            ))}
          </Stack>
          {regrants.hasNextPage && (
            <>
              <LoadMoreFailed
                list={regrants}
                message={copy.errUnknown}
                data-testid="admin-regrants-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                loading={regrants.isFetchingNextPage}
                onClick={() => void regrants.fetchNextPage()}
                data-testid="admin-regrants-more"
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
 * One re-grant: the account to its member page with its public id, when (in Seoul, as every admin
 * screen), the Coin given and the 가용 코인 before it — wrapping rather than scrolling sideways at
 * phone width.
 */
function RegrantRow({ regrant }: { regrant: AdminRegrant }) {
  return (
    <Stack
      as="li"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      gap="1"
      data-testid={`admin-regrant-${regrant.id}`}
    >
      <HStack justify="space-between" align="baseline" gap="3" flexWrap="wrap">
        <HStack gap="2" flexWrap="wrap" minW="0">
          <ChakraLink asChild fontWeight="semibold" overflowWrap="anywhere">
            <NextLink
              href={adminUserModerationPath(regrant.account.userId) as Route}
              data-testid="admin-regrant-account"
            >
              {nicknameShown(regrant.account.nickname)}
            </NextLink>
          </ChakraLink>
          <Text fontSize="xs" color="fg.muted" fontFamily="mono">
            {regrant.account.publicId}
          </Text>
        </HStack>
        <Text fontSize="sm" color="fg.muted" data-testid="admin-regrant-at">
          {formatKst(regrant.createdAt)}
        </Text>
      </HStack>
      <HStack gap="3" flexWrap="wrap" fontSize="sm" fontVariantNumeric="tabular-nums">
        <Text data-testid="admin-regrant-amount">
          {copy.adminRegrantAmount} {formatCoin(parseCoinAmount(regrant.amountCoin))}
        </Text>
        <Text color="fg.muted" data-testid="admin-regrant-available-before">
          {copy.adminRegrantAvailableBefore}{' '}
          {formatCoin(parseCoinAmount(regrant.availableBeforeCoin))}
        </Text>
      </HStack>
    </Stack>
  );
}
