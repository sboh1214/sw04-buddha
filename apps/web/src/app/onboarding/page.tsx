import type { Metadata, Route } from 'next';
import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/auth/auth-card';
import { copy } from '@/copy';
import { onboardingNext, onboardingPath } from '@/lib/onboarding';
import { getServerSession } from '@/lib/session.server';
import { OnboardingForm } from './onboarding-form';

export const metadata: Metadata = { title: `${copy.onboardingTitle} | ${copy.appName}` };

/**
 * The onboarding (#58, ADR-0072): 약관 동의 → 본인확인 → 닉네임 설정 → 시작 Coin 안내 → 관심
 * 카테고리, from whichever step the account has left. The gate (ADR-0043, lib/onboarding.ts) sends
 * every signed-in account with a step left here — every new account once it is signed in (an email
 * sign-up right after /set-password), and an account whose consent a revision asked for again —
 * and `?next=` is the page it was sent away from, or the one it signed up from (#57-9). It is
 * validated here once (`onboardingNext`: a path on this origin, never /onboarding itself) and the
 * stepper only ever navigates to the validated value.
 *
 * No session → the login screen, carrying this page AND its `next`, so signing in resumes the
 * same round trip.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const nextPath = onboardingNext(next);
  if (!(await getServerSession())) {
    redirect(`/login?next=${encodeURIComponent(onboardingPath(nextPath))}` as Route);
  }
  return (
    <AuthCard title={copy.onboardingTitle}>
      <OnboardingForm next={nextPath} />
    </AuthCard>
  );
}
