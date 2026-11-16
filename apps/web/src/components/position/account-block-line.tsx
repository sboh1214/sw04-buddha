'use client';

import { Alert, Link as ChakraLink, Text } from '@chakra-ui/react';
import NextLink from 'next/link';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import type { AccountBlock } from '@/hooks/use-account-block';
import { MY_MODERATION_PATH } from '@/lib/moderation';
import { restrictedLineParts } from '@/lib/order-reasons';

/**
 * D13's restriction line with its end unbroken: '(2026. 11. 23. 오후 12:35까지)' never splits
 * between the year and the month (ADR-0140 결정 2-23). The account line below and the order
 * panel's refusal card draw it.
 */
export function RestrictedText({ endsAtText }: { endsAtText: string | null }) {
  const [head, end, tail] = restrictedLineParts(endsAtText);
  return (
    <>
      {head}
      <Text as="span" whiteSpace="nowrap">
        {end}
      </Text>
      {tail}
    </>
  );
}

/**
 * D13 (ADR-0135; #66 ADR-0140, out of the order panel since #67, ADR-0142): why an admin or a
 * restricted account has 주문 확인 and every '매도' off while the values stay — an admin is told it
 * is one, a restriction names its end and links to 조치·신고 내역. The order panel draws it above
 * the form (`order-account-blocked`), MY above its holdings (`portfolio-account-blocked`). `id` is
 * what the buttons it turns off point at (`aria-describedby`). Nothing for an account that may
 * order.
 */
export function AccountBlockLine({
  id,
  account,
  restrictionEndsAt,
  testId,
}: {
  id: string;
  account: AccountBlock;
  restrictionEndsAt: string | null;
  testId: string;
}) {
  const format = useFormatDateTime();
  if (account === null) return null;
  return (
    <Alert.Root
      id={id}
      status="warning"
      role="status"
      tabIndex={-1}
      outline="none"
      data-testid={testId}
    >
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>
          {account === 'admin' ? (
            copy.orderAdmin
          ) : (
            <RestrictedText
              endsAtText={restrictionEndsAt === null ? null : format(restrictionEndsAt)}
            />
          )}
        </Alert.Description>
        {account === 'restricted' && (
          <ChakraLink asChild colorPalette="brand" color="colorPalette.fg" fontSize="sm">
            <NextLink href={MY_MODERATION_PATH}>{copy.myModeration}</NextLink>
          </ChakraLink>
        )}
      </Alert.Content>
    </Alert.Root>
  );
}
