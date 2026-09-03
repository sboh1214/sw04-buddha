import type { Metadata, Route } from 'next';
import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/auth/auth-card';
import { copy } from '@/copy';
import { authNoticeFor, safeNextPath } from '@/lib/auth-client';
import { getServerSession } from '@/lib/session.server';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: `${copy.loginTitle} | ${copy.appName}` };

/** Server component: already logged in -> straight to `next` (or home). */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string | string[] }>;
}) {
  const { next, error } = await searchParams;
  const nextPath = safeNextPath(next);
  if (await getServerSession()) redirect(nextPath as Route);
  return (
    <AuthCard title={copy.loginTitle} subtitle={copy.loginSubtitle}>
      {/* ?error= is a failed social round-trip, a bad link from the login resend (its
          callbackURL is /login), or one /set-password handed over — since ADR-0024 the
          sign-up mail lands there, and a broken link leaves no session to show it with. */}
      <LoginForm next={nextPath} notice={authNoticeFor(error, copy.socialUnavailable)} />
    </AuthCard>
  );
}
