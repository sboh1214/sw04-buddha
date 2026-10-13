import { Container, Heading, Stack } from '@chakra-ui/react';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';

export const metadata: Metadata = { title: `${copy.communityTitle} | ${copy.appName}` };

/**
 * `/community`: 커뮤니티, one of the three top-level areas (N02 §2, #16) — the header's row 1 and
 * the mobile tab bar both lead here, signed in or not — and nothing more yet.
 *
 * A nav item has to lead somewhere — a link to a 404 is worse than no link. What the area holds
 * is #46's, so this is a PLACEHOLDER and deliberately not a stub of the feature: no data, no
 * query, no client component, no route segment under it. When #46 builds the area, this file is
 * replaced, not extended.
 *
 * Static on purpose — nothing here reads a cookie, a search param or the API, so Next
 * prerenders it at build time like `/login`, and it stays up when the API is down. The chrome
 * matches the home page's Kalshi measurements (content width 1320px, 24px side padding, the
 * 30px headline) so the visitor does not see the page narrow and widen between the two.
 */
export default function CommunityPage() {
  return (
    <Container maxW="1320px" px="6" py="10">
      <Stack gap="6">
        <Heading as="h2" textStyle="headline">
          {copy.communityTitle}
        </Heading>
        <EmptyState message={copy.communityComingSoon} data-testid="community-coming-soon" />
      </Stack>
    </Container>
  );
}
