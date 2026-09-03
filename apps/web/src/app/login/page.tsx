import type { Metadata, Route } from 'next';
import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/auth/auth-card';
import { copy } from '@/copy';
import { safeNextPath } from '@/lib/auth-client';
import { getServerSession } from '@/lib/session.server';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: `${copy.loginTitle} | ${copy.appName}` };

/** Server component: already logged in -> straight to `next` (or home). */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const nextPath = safeNextPath(next);
  if (await getServerSession()) redirect(nextPath as Route);
  return (
    <AuthCard title={copy.loginTitle} subtitle={copy.loginSubtitle}>
      {/* better-auth replaces the errorCallbackURL's error=social with the provider code. */}
      <LoginForm next={nextPath} socialError={error !== undefined} />
    </AuthCard>
  );
}
