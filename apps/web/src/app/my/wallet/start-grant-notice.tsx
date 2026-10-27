'use client';

import { Alert } from '@chakra-ui/react';
import { copy } from '@/copy';
import { type Me } from '@/lib/api';
import { startGrantPending } from '@/lib/wallet';

/**
 * '시작 Coin은 준비되는 대로 지급됩니다.' while the account's start Coin waits for its amount
 * (ADR-0069 decision 4 #70, `startGrantPending`), and nothing otherwise. Under the balance it
 * explains, which is still the account's real one — 0 for a new account — wherever MY shows that
 * balance as the wallet's: the wallet's balance card (`/my/wallet`) and MY 요약's wallet preview
 * (owner decision 2026-10-18). When the worker pays the grant, `user:balance` moves the figure and
 * asks for the profile again (`applyBalanceEvent`), which takes the notice away in both.
 *
 * An info alert with no `role`: it is there from the moment the balance is, not news to announce,
 * like the wallet's fixed notice.
 */
export function StartGrantPendingNotice({
  me,
  testId,
  mt,
  size,
}: {
  me: Pick<Me, 'startGrant'> | undefined;
  testId: string;
  mt?: string;
  size?: 'sm' | 'md';
}) {
  if (!startGrantPending(me)) return null;
  return (
    <Alert.Root status="info" mt={mt} size={size} data-testid={testId}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{copy.walletStartGrantPending}</Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}
