'use client';

import { Alert, Box, Button, Heading, HStack, Skeleton, Stack, Text } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { useInterestsLeaveReport } from '@/hooks/use-onboarding';
import { type Me } from '@/lib/api';
import { consentStepItems } from '@/lib/consent';
import {
  ONBOARDING_SCREENS,
  isStepBack,
  onboardingPath,
  onboardingReturnReason,
  onboardingScreen,
  type OnboardingReturnReason,
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

/** Why the account is on an earlier step than it was going to (오너 결정 2026-10-19 (2차) 6). */
const RETURN_REASONS: Readonly<Record<OnboardingReturnReason, string>> = {
  reconsent: copy.onboardingReconsentReason,
  earlier_step: copy.errOnboardingStepsFirst,
};

/**
 * /onboarding (#58, ADR-0072): the stepper. `next` is already validated by the page
 * (`onboardingNext`). Which screen shows is the server's answer — `GET /me`'s `onboarding.nextStep`
 * in `['me']`, and after the nickname step on this visit the notice and the interests
 * (`onboardingScreen`) — so an account resumes at its remaining step whenever and wherever it comes
 * back (#57-8), and every step's write puts its answer into `['me']` before it settles, which moves
 * the stepper on in the same render. The ONE place that navigates away is the effect below, keyed
 * on nothing being left: an account that arrives done already (another tab finished, Back returned
 * here, or it left at the notice or the interests — they are shown once, 오너 결정 2026-10-19
 * (2차) 5) is sent straight on, and the last step lands in the same place — nothing can navigate
 * twice. Leaving at the notice or the interests tells the server it skipped the interests step
 * (`useInterestsLeaveReport`, owner decision 2026-10-21 (2nd) answer 2, ADR-0078) — 로그아웃 too,
 * which tells it before the session ends: the stepper hands its report to the button below
 * (`beforeSignOut`), since the stepper goes only once the session has.
 */
export function OnboardingForm({ next }: { next: string }) {
  const { data: me, isPending, isFetching, isLoggedIn, refetch } = useMe();
  // The stepper's `beforeSignOut` while one is on screen.
  const leaveReport = useRef<(() => Promise<void>) | null>(null);
  const holdLeaveReport = useCallback((report: (() => Promise<void>) | null) => {
    leaveReport.current = report;
  }, []);
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
    body = <Stepper key={me.id} me={me} next={next} onLeaveReport={holdLeaveReport} />;
  }

  // 로그아웃 under every rung of an account held here (owner decision 2026-10-13, #16): the header
  // has no profile menu and MY is gated, so without it an account that does not want to go on —
  // or cannot, while `/me` fails or no text arrives — could not sign out at all.
  return (
    <Stack gap="4">
      {body}
      <SignOutButton
        alignSelf="center"
        data-testid="onboarding-logout"
        beforeSignOut={() => leaveReport.current?.() ?? Promise.resolve()}
      />
    </Stack>
  );
}

/**
 * The screens of one account's onboarding. What the visit holds beside the server's answer
 * (`StepperVisit`): whether the nickname step was the next step on it — then the notice and the
 * interests follow the grant — and whether the notice was read. Both are kept as the render goes
 * (the documented way to adjust state to what changed since the last render), so they are true in
 * the very render whose `['me']` says the nickname step is done.
 *
 * The heading names the screen and takes the focus when the screen changes — a step finished, or
 * the server sent the account back to an earlier one — so a screen reader hears where it is and
 * the keyboard starts from the top of the new step. Not on the first screen: arriving on the page
 * is no change, and the browser's own focus handling of a navigation stands. Above the heading the
 * stepper says why the account is on an earlier step than it was going to (오너 결정 2026-10-19
 * (2차) 6, `onboardingReturnReason`): read out at once (`alert`) when the server sent it back while
 * it was here. When the gate brought it for a re-consent the sentence is there from the first
 * render, a `status` that screen readers do not reliably read out when it appears with its text in
 * it — so that first screen is the one whose heading takes the focus on arrival, and the heading is
 * described by the sentence (`aria-describedby`): the step's name and the reason are read together
 * (ADR-0072 7-36).
 */
function Stepper({
  me,
  next,
  onLeaveReport,
}: {
  me: Me;
  next: string;
  /** Takes what 로그아웃 calls before it ends the session, and null as the stepper goes. */
  onLeaveReport: (report: (() => Promise<void>) | null) => void;
}) {
  const router = useRouter();
  const [noticeRead, setNoticeRead] = useState(false);
  const [reachedNickname, setReachedNickname] = useState(me.onboarding.nextStep === 'nickname');
  if (!reachedNickname && me.onboarding.nextStep === 'nickname') setReachedNickname(true);
  const screen = onboardingScreen(me.onboarding, { reachedNickname, noticeRead });
  // The screen shown, and whether the server sent the account back to it from a later one.
  const [shown, setShown] = useState({ screen, sentBack: false });
  if (shown.screen !== screen) setShown({ screen, sentBack: isStepBack(shown.screen, screen) });
  const reason = onboardingReturnReason(me.onboarding, screen, shown.sentBack);
  // Brought here for a re-consent, rather than sent back while on this screen.
  const arrivedForReconsent = reason === 'reconsent' && !shown.sentBack;
  const reasonId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // No screen before the first, so the effect below focuses it, only on a re-consent arrival.
  const lastScreen = useRef<OnboardingScreen | null>(arrivedForReconsent ? null : screen);
  // Leaving the notice or the interests unanswered is the interests step's skip: the server is told
  // — by 로그아웃 before the session ends (`onLeaveReport`), else as the stepper or the page goes.
  const reportBeforeSignOut = useInterestsLeaveReport(screen, me.id);
  useEffect(() => {
    onLeaveReport(reportBeforeSignOut);
    return () => onLeaveReport(null);
  }, [onLeaveReport, reportBeforeSignOut]);

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
      step = <ConsentStep items={consentStepItems(me.onboarding.consents)} />;
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
      step = <NicknameStep nickname={me.profile.nickname} />;
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
      {reason !== null && (
        <Alert.Root
          id={reasonId}
          status="warning"
          role={shown.sentBack ? 'alert' : 'status'}
          data-testid="onboarding-return-reason"
        >
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{RETURN_REASONS[reason]}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
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
          aria-describedby={arrivedForReconsent ? reasonId : undefined}
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
