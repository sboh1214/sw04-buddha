'use client';

import { Alert, Link as ChakraLink } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { useDisputeOpen } from '@/hooks/use-disputes';
import { useMarket } from '@/hooks/use-markets';
import { type Market } from '@/lib/api';
import { disputePath } from '@/lib/disputes';

/**
 * '토론 글은 판정 이의가 아닙니다.' and the link to the market's submission screen (ADR-0093 decision 3
 * '#175 토론의 이의 안내', #175, ADR-0104): above the detail's discussion list and on the write
 * screen with that market chosen, on a 잠정 결과 while its 이의 기한 is ahead — a post is read by
 * everyone and decides nothing, a 판정 이의 is the operators' to decide. Gone at the deadline
 * without a reload (`useDisputeOpen`: the API's `disputeOpen`, then a one-shot timer — from the
 * server's `now` when the screen has it). One line and the link, nothing of who may dispute (the
 * submission screen says it) and nothing of a payout. Not inside the write screen's sanction
 * banner, which says nothing of an appeal (ADR-0084 6-11).
 */
export function DisputeDiscussionNote({
  market,
  now,
  testId,
}: {
  market: Pick<Market, 'slug' | 'disputeOpen' | 'disputeDeadline'>;
  now?: number;
  testId: string;
}) {
  const open = useDisputeOpen(market, now);
  if (!open) return null;
  return (
    <Alert.Root status="info" role="note" size="sm" data-testid={testId}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>
          {copy.discussionDisputeNote}{' '}
          <ChakraLink asChild colorPalette="brand" color="colorPalette.fg" fontWeight="medium">
            <NextLink href={disputePath(market.slug) as Route} data-testid={`${testId}-link`}>
              {copy.marketDisputeSubmit}
            </NextLink>
          </ChakraLink>
        </Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}

/**
 * The note above the detail's discussion list: the detail's own row (the seeded key, no second
 * request), read here so the section itself keeps reading posts alone (its cards draw no market
 * line, discussion.test.ts). Nothing until the row is there.
 */
export function MarketDisputeDiscussionNote({
  marketId,
  now,
  testId,
}: {
  marketId: string;
  now?: number;
  testId: string;
}) {
  const market = useMarket(marketId).data;
  if (market === undefined) return null;
  return <DisputeDiscussionNote market={market} now={now} testId={testId} />;
}
