import type { Metadata, Route } from 'next';
import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/auth/auth-card';
import { copy } from '@/copy';
import { onboardingNext, onboardingPath } from '@/lib/onboarding';
import { getServerSession } from '@/lib/session.server';
import { OnboardingForm } from './onboarding-form';

export const metadata: Metadata = { title: `${copy.onboardingTitle} | ${copy.appName}` };

/**
 * Where the onboarding gate (ADR-0043) sends a signed-in account that has no real name and
 * mobile number: social sign-ups, and every account older than the requirement. `?next=` is the
 * page it was sent away from; it is validated here once (`onboardingNext`: a path on this
 * origin, never /onboarding itself) and the form only ever navigates to the validated value.
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
    <AuthCard title={copy.onboardingTitle} subtitle={copy.onboardingSubtitle}>
      <OnboardingForm next={nextPath} />
    </AuthCard>
  );
}
