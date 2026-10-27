import type { Metadata, Route } from 'next';
import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/auth/auth-card';
import { copy } from '@/copy';
import { safeNextPath } from '@/lib/next-path';
import { getServerSession } from '@/lib/session.server';
import { SignupForm } from './signup-form';

export const metadata: Metadata = { title: `${copy.signupTitle} | ${copy.appName}` };

/**
 * Sign-up (ADR-0024). `?next=` is the page the visitor was on — the login screen's 회원가입 link
 * carries it — and the sign-up takes it along to the onboarding's end (#58, ADR-0069 decision 1
 * #57-9): through the social provider's callback, or through the verification mail's link to
 * /set-password. A visitor already signed in goes straight there.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const nextPath = safeNextPath(next);
  if (await getServerSession()) redirect(nextPath as Route);
  return (
    <AuthCard title={copy.signupTitle} subtitle={copy.signupSubtitle}>
      <SignupForm next={nextPath} />
    </AuthCard>
  );
}
