'use client';

import { Alert, Button, Skeleton, Stack } from '@chakra-ui/react';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';

/**
 * What a settings card shows while `GET /me` has not produced a profile: the skeleton until
 * the query settles, then a recoverable error. Both cards that need the profile observe the
 * same `['me']` query, so this lives in one place and they render identical states.
 *
 * The error is only for "signed in, but the profile did not arrive" — the one state a retry
 * can fix. Signing out removes the `['me']` cache while better-auth's session atom still
 * holds the old session, so without the `isFetching` and `isLoggedIn` guards both cards
 * would flash a failure on a perfectly good logout, and a client that has no session at all
 * would get a retry button that can never load anything (the query is disabled).
 *
 * Deliberately no `role="alert"`: two cards mount this at once (and the password card mounts
 * its own), so an assertive live region would announce the same sentence two or three times.
 */
export function ProfileUnavailable({ height = '10' }: { height?: string }) {
  const { isPending, isFetching, isLoggedIn, refetch } = useMe();
  if (isPending || isFetching || !isLoggedIn) return <Skeleton height={height} />;
  return (
    <Stack gap="3" align="flex-start">
      <Alert.Root status="error">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{copy.errProfileLoad}</Alert.Description>
        </Alert.Content>
      </Alert.Root>
      <Button size="sm" variant="outline" onClick={() => void refetch()}>
        {copy.retry}
      </Button>
    </Stack>
  );
}
