import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth/auth-card';
import { copy } from '@/copy';
import { RequestResetForm, SetNewPasswordForm } from './reset-password-form';

export const metadata: Metadata = { title: `${copy.resetTitle} | ${copy.appName}` };

/**
 * Two modes on one route:
 * - no token: ask for the email (`requestPasswordReset` with `redirectTo: '/reset-password'`);
 * - `?token=`: better-auth's email link lands here (it appends `token`), set a new password.
 * better-auth redirects to `?error=INVALID_TOKEN` when the link is bad or expired.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;
  if (token) {
    return (
      <AuthCard title={copy.resetNewTitle}>
        <SetNewPasswordForm token={token} />
      </AuthCard>
    );
  }
  return (
    <AuthCard title={copy.resetTitle} subtitle={copy.resetSubtitle}>
      <RequestResetForm tokenInvalid={error === 'INVALID_TOKEN'} />
    </AuthCard>
  );
}
