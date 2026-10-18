'use client';

import { Alert, Button, Skeleton, Stack } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { onboardingPath } from '@/lib/onboarding';
import { profileView } from '@/lib/query-client';
import { VerificationStep } from './verification-step';

/**
 * `next` is already validated by the page (`onboardingNext`). The ONE place that navigates on
 * is the effect below, keyed on `['me']` holding a verification: a member who arrives verified
 * already (another tab finished, or Back returned here) is sent straight on, and a confirmation
 * lands in the same place because `useConfirmPhoneVerification` writes the record into `['me']`
 * before its promise settles — so the gate on `next` already sees it, and nothing can navigate
 * twice.
 *
 * The step on screen is the verification alone (#183). The owner's order of the onboarding is
 * 약관 동의 → 본인확인 → 닉네임 (ADR-0069 decision 4, #58), and #58 adds the other two around it.
 */
export function OnboardingForm({ next }: { next: string }) {
  const router = useRouter();
  const { data: me, isPending, isFetching, isLoggedIn, refetch } = useMe();
  const verified = me?.verification != null;
  // The four states MY's screens read (`profileView`), for the same reason: the page's
  // session check is server-side and runs only on navigation, so a session that ends under this
  // form (it expired, another tab signed out) left it offering a retry that can only 401.
  const view = profileView({ isLoggedIn, isPending, isFetching, hasProfile: me !== undefined });

  useEffect(() => {
    if (verified) router.replace(next as Route);
  }, [verified, next, router]);

  // On its way to `next` (the effect above), so not held here.
  if (verified) return <Skeleton height="64" />;

  // Back through the login screen to this same round trip, as the page's own redirect sends it.
  // No 로그아웃 here: there is no session left to end.
  if (view === 'signedOut') {
    return (
      <EmptyState
        data-testid="onboarding-signed-out"
        message={copy.onboardingSignedOut}
        action={
          <Button asChild size="sm" variant="outline">
            <NextLink href={{ pathname: '/login', query: { next: onboardingPath(next) } }}>
              {copy.login}
            </NextLink>
          </Button>
        }
      />
    );
  }

  let step: ReactNode;
  if (view === 'pending') {
    step = <Skeleton height="64" />;
  } else if (view === 'failed') {
    // Signed in, and `/me` settled without a profile. This is the one screen the gate leaves such
    // an account, so it must offer a way out of the error.
    step = (
      <Stack gap="3" align="flex-start" data-testid="onboarding-unavailable">
        <Alert.Root status="error" role="alert">
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
  } else {
    // Keyed on the account, so a session switched under this screen (SessionCacheGuard) mounts a
    // fresh step for the new one instead of keeping the previous account's inputs and countdowns.
    step = <VerificationStep key={me?.id} />;
  }

  // 로그아웃 under every rung of an account held here (owner decision 2026-10-13, #16): the header
  // has no profile menu and MY is gated, so without it an account that does not want to verify —
  // or cannot, while `/me` fails or no text arrives — could not sign out at all.
  return (
    <Stack gap="4">
      {step}
      <SignOutButton alignSelf="center" data-testid="onboarding-logout" />
    </Stack>
  );
}
