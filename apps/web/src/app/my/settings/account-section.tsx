'use client';

import { Badge, Button, Field, HStack, Input, Stack, Text } from '@chakra-ui/react';
import { isNoEmailAddress } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { useAuthSessionChanged } from '@/hooks/use-session-changed';
import { authClient, authErrorMessage } from '@/lib/auth-client';
import { MY_SETTINGS_PATH } from '@/lib/my';
import { ProfileUnavailable } from './profile-unavailable';
import { SettingsSection } from './section';

const schema = z.object({ newEmail: z.email(copy.errEmailInvalid) });
type FormValues = z.infer<typeof schema>;

/** Where the links in the verification / change-email mails bring the browser back to. */
const CALLBACK = MY_SETTINGS_PATH;

/**
 * Email address, its verification state and the change-email form (PLAN 17 Q5 decision):
 * a new address only applies once it is verified. Verified users first confirm from the
 * current address; unverified ones (incl. Kakao/Naver accounts without an email, which
 * carry a synthetic address) get the verification mail at the new address directly.
 */
export function AccountSection() {
  const { data: me, isPending } = useMe();
  return (
    <SettingsSection
      title={copy.settingsAccount}
      hint={copy.settingsAccountHint}
      testId="settings-account"
    >
      {/* `!me` covers a failed /me AND the session-gone case, where the query never runs and
          `isError` stays false — either way the card must not sit on a skeleton forever. */}
      {isPending || !me ? (
        <ProfileUnavailable />
      ) : (
        <AccountFields accountId={me.id} email={me.email} emailVerified={me.emailVerified} />
      )}
    </SettingsSection>
  );
}

/**
 * A change of address names the account the card was drawn for (`accountId`, its `Me`'s id) beside
 * better-auth's own body, and the API's hook compares it with the cookie's (ADR-0092): in the render
 * between the session naming B and SessionCacheGuard's reset the card is still A's while the cookie
 * is B's, and a change taken with B's cookie would mail B's address a confirmation naming the
 * address typed for A. Refused, nothing is mailed and the session is asked for again. 인증 메일 다시
 * 보내기 needs no account: it names the address on the card, and better-auth mails a signed-in
 * request only to its own account's address (another is EMAIL_MISMATCH).
 */
function AccountFields({
  accountId,
  email,
  emailVerified,
}: {
  accountId: string;
  email: string;
  emailVerified: boolean;
}) {
  const noEmail = isNoEmailAddress(email);
  const sessionChanged = useAuthSessionChanged();

  const resend = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.sendVerificationEmail({ email, callbackURL: CALLBACK });
      if (error) throw new Error(authErrorMessage(error));
    },
    onSuccess: () => toaster.create({ type: 'success', title: copy.verificationResent }),
    onError: (error) => toaster.create({ type: 'error', title: error.message }),
  });

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async ({ newEmail }) => {
    if (newEmail.toLowerCase() === email.toLowerCase()) {
      setError('newEmail', { message: copy.errEmailSame });
      return;
    }
    const { error } = await authClient.changeEmail(
      { newEmail, callbackURL: CALLBACK },
      // better-auth's body has no account; the client merges this one into it.
      { body: { expectedAccountId: accountId } },
    );
    if (error) {
      toaster.create({
        type: 'error',
        title: sessionChanged(error) ? copy.sessionChanged : authErrorMessage(error),
      });
      return;
    }
    toaster.create({
      type: 'success',
      title: emailVerified ? copy.changeEmailSentCurrent : copy.changeEmailSentNew,
    });
    reset();
  });

  return (
    <Stack gap="5">
      <Stack gap="2">
        <HStack gap="2" flexWrap="wrap">
          <Text fontSize="sm" color="fg.muted">
            {copy.email}:
          </Text>
          <Text fontSize="sm" data-testid="account-email">
            {noEmail ? copy.noEmail : email}
          </Text>
          <Badge
            colorPalette={emailVerified ? 'yes' : 'gray'}
            variant="subtle"
            data-testid="account-email-status"
          >
            {emailVerified ? copy.emailVerifiedBadge : copy.emailUnverifiedBadge}
          </Badge>
        </HStack>
        {noEmail ? (
          <Text fontSize="sm" color="fg.muted">
            {copy.noEmailNotice}
          </Text>
        ) : !emailVerified ? (
          <HStack gap="3" flexWrap="wrap">
            <Text fontSize="sm" color="fg.muted">
              {copy.settingsEmailUnverified}
            </Text>
            <Button
              size="xs"
              variant="outline"
              loading={resend.isPending}
              onClick={() => resend.mutate()}
              data-testid="resend-verification"
            >
              {copy.resendVerification}
            </Button>
          </HStack>
        ) : null}
      </Stack>

      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <Field.Root invalid={!!errors.newEmail}>
          <Field.Label>{copy.newEmail}</Field.Label>
          <HStack w="full" align="start">
            <Input
              type="email"
              autoComplete="email"
              placeholder={copy.emailPlaceholder}
              data-testid="new-email-input"
              {...register('newEmail')}
            />
            <Button type="submit" loading={isSubmitting} data-testid="change-email">
              {copy.changeEmail}
            </Button>
          </HStack>
          <Field.HelperText>
            {emailVerified ? copy.changeEmailHintVerified : copy.changeEmailHintUnverified}
          </Field.HelperText>
          <Field.ErrorText>{errors.newEmail?.message}</Field.ErrorText>
        </Field.Root>
      </form>
    </Stack>
  );
}
