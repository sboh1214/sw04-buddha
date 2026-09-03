import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth/auth-card';
import { copy } from '@/copy';
import { verifyLinkErrorCode } from '@/lib/auth-client';
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
  // A repeated parameter arrives as an array: `token` would reach better-auth as one and be
  // refused by its zod body schema (generic error instead of "link expired"), and a strict
  // `error === 'INVALID_TOKEN'` would silently drop the banner.
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>;
}) {
  const { token, error } = await searchParams;
  const resetToken = Array.isArray(token) ? token[0] : token;
  if (resetToken) {
    return (
      <AuthCard title={copy.resetNewTitle}>
        <SetNewPasswordForm token={resetToken} />
      </AuthCard>
    );
  }
  return (
    <AuthCard title={copy.resetTitle} subtitle={copy.resetSubtitle}>
      <RequestResetForm tokenInvalid={verifyLinkErrorCode(error) === 'invalid_token'} />
    </AuthCard>
  );
}
