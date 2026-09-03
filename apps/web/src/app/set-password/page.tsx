import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/auth/auth-card';
import { copy } from '@/copy';
import { getServerSession } from '@/lib/session.server';
import { SetPasswordForm } from './set-password-form';

export const metadata: Metadata = { title: `${copy.setPasswordTitle} | ${copy.appName}` };

/**
 * Where the sign-up verification link lands (ADR-0024): the mailbox is proven and the user
 * is signed in, so this is the first moment a password may be chosen. Without a session the
 * page is useless, so it sends the visitor to the login screen.
 */
export default async function SetPasswordPage() {
  if (!(await getServerSession())) redirect('/login?next=/set-password');
  return (
    <AuthCard title={copy.setPasswordTitle} subtitle={copy.setPasswordSubtitle}>
      <SetPasswordForm />
    </AuthCard>
  );
}
