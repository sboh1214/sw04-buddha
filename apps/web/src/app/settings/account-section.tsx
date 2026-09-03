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
import { authClient, authErrorMessage } from '@/lib/auth-client';
import { ProfileUnavailable } from './profile-unavailable';
import { SettingsSection } from './section';

const schema = z.object({ newEmail: z.email(copy.errEmailInvalid) });
type FormValues = z.infer<typeof schema>;

/** Where the links in the verification / change-email mails bring the browser back to. */
const CALLBACK = '/settings';

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
        <AccountFields email={me.email} emailVerified={me.emailVerified} />
      )}
    </SettingsSection>
  );
}

function AccountFields({ email, emailVerified }: { email: string; emailVerified: boolean }) {
  const noEmail = isNoEmailAddress(email);

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
    const { error } = await authClient.changeEmail({ newEmail, callbackURL: CALLBACK });
    if (error) {
      toaster.create({ type: 'error', title: authErrorMessage(error) });
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
