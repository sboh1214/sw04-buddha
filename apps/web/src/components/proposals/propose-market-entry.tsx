'use client';

import { Button, Stack, Text } from '@chakra-ui/react';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { NEW_PROPOSAL_PATH } from '@/lib/proposals';

/**
 * '시장 제안하기' (#77, ADR-0089): the way to the form from the two places the owner named — the
 * search's no-results screen and the bottom of the explore home (ADR-0069 decision 4 #77 위치). A
 * line and a link, the same for every visitor: the form's page sends a visitor with no session to
 * the login screen and back (`NEW_PROPOSAL_LOGIN_PATH`), so the home's HTML stays the same for a
 * signed-in and an anonymous visitor.
 */
export function ProposeMarketEntry({ testId }: { testId: string }) {
  return (
    <Stack align="center" gap="3" py="6" px="4" textAlign="center" data-testid={testId}>
      <Text color="fg.muted">{copy.proposeMarketEntry}</Text>
      <Button asChild size="sm" variant="outline" borderRadius="pill">
        <NextLink href={NEW_PROPOSAL_PATH}>{copy.proposeMarket}</NextLink>
      </Button>
    </Stack>
  );
}
