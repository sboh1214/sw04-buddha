'use client';

import { Alert, Box, Button, Heading, HStack, Skeleton, Stack, Text } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { type Me } from '@/lib/api';
import {
  ONBOARDING_SCREENS,
  onboardingPath,
  onboardingScreen,
  type OnboardingScreen,
} from '@/lib/onboarding';
import { profileView } from '@/lib/query-client';
import { ConsentStep } from './consent-step';
import { InterestsStep } from './interests-step';
import { NicknameStep } from './nickname-step';
import { NoticeStep } from './notice-step';
import { VerificationStep } from './verification-step';

/** Each screen's name: the progress list's entries and the heading of the screen shown. */
const SCREEN_TITLES: Readonly<Record<OnboardingScreen, string>> = {
  consent: copy.onboardingStepConsent,
  verification: copy.onboardingStepVerification,
  nickname: copy.onboardingStepNickname,
  notice: copy.onboardingStepNotice,
  interests: copy.onboardingStepInterests,
};

/**
 * /onboarding (#58, ADR-0072): the stepper. `next` is already validated by the page
 * (`onboardingNext`). Which screen shows is the server's answer — `GET /me`'s `onboarding.nextStep`
 * in `['me']`, the notice standing before the interests (`onboardingScreen`) — so an account
 * resumes at its remaining step whenever and wherever it comes back (#57-8), and every step's
 * write puts its answer into `['me']` before it settles, which moves the stepper on in the same
 * render. The ONE place that navigates away is the effect below, keyed on nothing being left: an
 * account that arrives done already (another tab finished, or Back returned here) is sent straight
 * on, and the last step lands in the same place — nothing can navigate twice.
 */
export function OnboardingForm({ next }: { next: string }) {
  const { data: me, isPending, isFetching, isLoggedIn, refetch } = useMe();
  // The four states MY's screens read (`profileView`), for the same reason: the page's
  // session check is server-side and runs only on navigation, so a session that ends under this
  // form (it expired, another tab signed out) left it offering a retry that can only 401.
  const view = profileView({ isLoggedIn, isPending, isFetching, hasProfile: me !== undefined });

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

  let body: ReactNode;
  if (view === 'failed') {
    // Signed in, and `/me` settled without a profile. This is the one screen the gate leaves such
    // an account, so it must offer a way out of the error.
    body = (
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
  } else if (me === undefined) {
    body = <Skeleton height="64" />;
  } else {
    // Keyed on the account, so a session switched under this screen (SessionCacheGuard) mounts a
    // fresh stepper — and fresh steps — for the new one instead of keeping the previous account's
    // inputs, countdowns and the notice it read.
    body = <Stepper key={me.id} me={me} next={next} />;
  }

  // 로그아웃 under every rung of an account held here (owner decision 2026-10-13, #16): the header
  // has no profile menu and MY is gated, so without it an account that does not want to go on —
  // or cannot, while `/me` fails or no text arrives — could not sign out at all.
  return (
    <Stack gap="4">
      {body}
      <SignOutButton alignSelf="center" data-testid="onboarding-logout" />
    </Stack>
  );
}

/**
 * The screens of one account's onboarding. `noticeRead` is the one piece of state the server does
 * not hold (lib/onboarding.ts `ONBOARDING_SCREENS`).
 *
 * The heading names the screen and takes the focus when the screen changes — a step finished, or
 * the server sent the account back to an earlier one — so a screen reader hears where it is and
 * the keyboard starts from the top of the new step. Not on the first screen: arriving on the page
 * is no change, and the browser's own focus handling of a navigation stands.
 */
function Stepper({ me, next }: { me: Me; next: string }) {
  const router = useRouter();
  const [noticeRead, setNoticeRead] = useState(false);
  const screen = onboardingScreen(me.onboarding, noticeRead);
  const heading = useRef<HTMLHeadingElement>(null);
  const lastScreen = useRef<OnboardingScreen | null>(screen);

  useEffect(() => {
    if (screen === null) router.replace(next as Route);
  }, [screen, next, router]);

  useEffect(() => {
    if (screen !== null && screen !== lastScreen.current) heading.current?.focus();
    lastScreen.current = screen;
  }, [screen]);

  // On its way to `next` (the effect above), so not held here.
  if (screen === null) return <Skeleton height="64" />;

  const position = ONBOARDING_SCREENS.indexOf(screen);
  let step: ReactNode;
  switch (screen) {
    case 'consent':
      step = <ConsentStep />;
      break;
    case 'verification':
      step = (
        <Stack gap="4">
          <Text color="fg.muted">{copy.verificationIntro}</Text>
          <VerificationStep />
        </Stack>
      );
      break;
    case 'nickname':
      step = <NicknameStep nickname={me.profile.nickname} role={me.profile.role} />;
      break;
    case 'notice':
      step = <NoticeStep startGrant={me.startGrant} onNext={() => setNoticeRead(true)} />;
      break;
    case 'interests':
      step = <InterestsStep />;
      break;
  }

  return (
    <Stack gap="5" data-testid={`onboarding-step-${screen}`}>
      <Progress current={position} />
      <Stack gap="1">
        <Text fontSize="sm" color="fg.muted" data-testid="onboarding-position">
          {position + 1} / {ONBOARDING_SCREENS.length}
        </Text>
        <Heading
          as="h3"
          size="lg"
          ref={heading}
          tabIndex={-1}
          outline="none"
          data-testid="onboarding-heading"
        >
          {SCREEN_TITLES[screen]}
        </Heading>
      </Stack>
      {step}
    </Stack>
  );
}

/**
 * Where the account stands among the screens: a bar segment per screen, filled up to the current
 * one, at any width (375px included). The names are read out as an ordered list, the current one
 * marked as the current step; the visible name is the heading below.
 */
function Progress({ current }: { current: number }) {
  return (
    <HStack
      as="ol"
      gap="1"
      listStyleType="none"
      aria-label={copy.onboardingProgress}
      data-testid="onboarding-progress"
    >
      {ONBOARDING_SCREENS.map((screen, index) => (
        <Box
          as="li"
          key={screen}
          flex="1"
          h="1.5"
          borderRadius="full"
          bg={index <= current ? 'colorPalette.solid' : 'bg.emphasized'}
          colorPalette="brand"
          aria-current={index === current ? 'step' : undefined}
        >
          <Text srOnly>{SCREEN_TITLES[screen]}</Text>
        </Box>
      ))}
    </HStack>
  );
}
