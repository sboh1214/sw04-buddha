import { Alert, Stack } from '@chakra-ui/react';
import type { Metadata, Route } from 'next';
import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/auth/auth-card';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { copy } from '@/copy';
import { verifyLinkErrorCode } from '@/lib/auth-client';
import { getServerSession } from '@/lib/session.server';
import { SetPasswordForm } from './set-password-form';

export const metadata: Metadata = { title: `${copy.setPasswordTitle} | ${copy.appName}` };

/**
 * Where the sign-up verification link lands (ADR-0024): the mailbox is proven and the user
 * is signed in, so this is the first moment a password may be chosen.
 *
 * A failed link arrives here too, as `?error=<CODE>` (better-auth's verify-email
 * `redirectOnError`: TOKEN_EXPIRED, INVALID_TOKEN, USER_NOT_FOUND). It neither creates nor
 * clears a session, so both cases are reachable:
 * - no session (the usual one — a broken link can never sign anyone in): the page is useless,
 *   so the visitor goes to the login screen AND the code goes with them, where it becomes the
 *   expired-link notice next to the "register again" and "reset your password" hints.
 * - session present: they verified earlier in this browser and the form below works, so the
 *   note says the link is stale without sending them after a new one.
 *
 * 로그아웃 sits under the form in every state (owner decision 2026-10-13, #16): an account that has
 * not verified its phone yet (ADR-0070) is kept out of MY, where the other 로그아웃 is, by the
 * onboarding gate.
 */
export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  const brokenLink = verifyLinkErrorCode(error);
  if (!(await getServerSession())) {
    const suffix = brokenLink ? `&error=${encodeURIComponent(brokenLink)}` : '';
    redirect(`/login?next=/set-password${suffix}` as Route);
  }
  return (
    <AuthCard title={copy.setPasswordTitle} subtitle={copy.setPasswordSubtitle}>
      <Stack gap="4">
        {brokenLink && (
          <Alert.Root status="info" role="status" data-testid="set-password-notice">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.setPasswordLinkStale}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}
        <SetPasswordForm />
        <SignOutButton alignSelf="center" data-testid="set-password-logout" />
      </Stack>
    </AuthCard>
  );
}
