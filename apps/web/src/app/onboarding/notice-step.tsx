'use client';

import { Alert, Button, List, Stack } from '@chakra-ui/react';
import { CoinText } from '@/components/ui/coin-text';
import { copy } from '@/copy';
import { type Me } from '@/lib/api';
import { startGrantNotice } from '@/lib/onboarding';

/**
 * The short notice after the start Coin (#58, ADR-0069 decision 1 #57-10): what was paid — or, while
 * the amount is undecided, the owner's sentence in its place (decision 4 #70), or, when the verified
 * number's start Coin is another account's (paid, or rarely still waiting), the owner's sentence that
 * this number cannot receive it (오너 결정 2026-10-19) — that Coin cannot be exchanged for cash, and
 * that the operating liquidity (the bot) can be the other side of a trade. Then the interest
 * categories (#57-7).
 *
 * Nothing here is recorded: the server granted (or left waiting) with the nickname step, and this
 * screen only says so. `startGrant` is `['me']`'s, so a payment that lands while it is open (the
 * amount entered meanwhile: `user:balance`, then `GET /me` again, realtime-provider.tsx) shows the
 * amount in place of the sentence. The amount is a fact, not a heading: no number or score stands
 * out beyond it (N04 §4), and nothing here buys or offers Coin (N06).
 */
export function NoticeStep({
  startGrant,
  onNext,
}: {
  startGrant: Me['startGrant'];
  onNext: () => void;
}) {
  const notice = startGrantNotice(startGrant);
  return (
    <Stack gap="5" data-testid="notice-step">
      {notice.kind === 'granted' && (
        <Alert.Root status="success" data-testid="notice-granted">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{copy.onboardingNoticeGranted}</Alert.Title>
            <Alert.Description>
              {copy.onboardingNoticeAmount}{' '}
              <CoinText
                amount={notice.amountCoin}
                fontWeight="semibold"
                data-testid="notice-amount"
              />
            </Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {notice.kind === 'pending' && (
        <Alert.Root status="info" data-testid="notice-pending">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.walletStartGrantPending}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {notice.kind === 'number_used' && (
        <Alert.Root status="info" data-testid="notice-number-used">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.onboardingNoticeNumberUsed}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      <List.Root gap="2" ps="5" data-testid="notice-facts">
        <List.Item>{copy.onboardingNoticeNoCash}</List.Item>
        <List.Item>{copy.onboardingNoticeCounterparty}</List.Item>
      </List.Root>
      <Button size="lg" onClick={onNext} data-testid="notice-next">
        {copy.onboardingNoticeNext}
      </Button>
    </Stack>
  );
}
