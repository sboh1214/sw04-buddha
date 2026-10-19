'use client';

import { Container, Skeleton } from '@chakra-ui/react';
import type { Route } from 'next';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useMe } from '@/hooks/use-me';
import { gatedPagePath, needsOnboarding, onboardingPath } from '@/lib/onboarding';

/**
 * The onboarding gate (ADR-0043, keyed on 본인확인 by ADR-0070 and on the whole onboarding since
 * #58, ADR-0072), wrapped around every page by the root layout: a signed-in account with an
 * onboarding step left — the consent (again after a revision that asked for it), the 본인확인, the
 * nickname (#57-8) — is sent to `/onboarding?next=<this page>`, from everywhere but the exempt
 * routes (lib/onboarding.ts, where the decision lives and is tested), and resumes at that step.
 * Not for the interest categories: shown once after the nickname step, they are skipped by an
 * account that left before answering them (오너 결정 2026-10-19 (2차) 5).
 * /admin is gated like the rest — it renders inside this same `<main>`, and an operator onboards
 * like any account (ADR-0069 decision 4 #58).
 *
 * Client-side because the answer is `GET /me`'s `onboarding`, which the page already fetches
 * for the nav's balance chip; see lib/onboarding.ts for why not `proxy.ts`. It keeps the screens;
 * the server keeps the actions (`OnboardedGuard`).
 *
 * Flash: until the session and `/me` have answered, the page renders as usual — hiding every
 * page from every member for that long would cost far more than it saves the few who are
 * redirected. Once the answer names a step left, the page is replaced by a placeholder the size
 * of the onboarding card in the same render that schedules the redirect, so the gated page is
 * visible for at most the session and `/me` round trips of a hard load (and never on a client-side
 * navigation, where `['me']` is already known). `replace`, so Back does not return to a page
 * that would only redirect again.
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: me, isLoggedIn } = useMe();
  const redirect = needsOnboarding(pathname, isLoggedIn && me ? me.onboarding : undefined);

  useEffect(() => {
    if (!redirect) return;
    router.replace(onboardingPath(gatedPagePath(pathname, window.location)) as Route);
  }, [redirect, pathname, router]);

  if (!redirect) return children;
  return (
    <Container maxW="sm" py={{ base: '8', md: '16' }} data-testid="onboarding-gate">
      <Skeleton height="64" />
    </Container>
  );
}
