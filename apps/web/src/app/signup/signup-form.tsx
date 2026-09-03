'use client';

import {
  Alert,
  Button,
  Field,
  HStack,
  Input,
  Link,
  Separator,
  Stack,
  Text,
} from '@chakra-ui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import NextLink from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { SocialButtons } from '@/components/auth/social-buttons';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { api, isApiError, unwrap } from '@/lib/api';
import { authClient, authErrorMessage } from '@/lib/auth-client';

const schema = z.object({ email: z.email(copy.errEmailInvalid) });
type FormValues = z.infer<typeof schema>;

/**
 * Sign-up asks for the email only (ADR-0024): the account has no password until the
 * verification link proves the mailbox, and the link itself leads to the set-password page.
 * The answer never says whether the address was already registered.
 */
const VERIFY_CALLBACK = '/set-password';

export function SignupForm() {
  const [formError, setFormError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      unwrap(await api.POST('/api/v1/auth/register', { body: { email: values.email } }));
      setSentTo(values.email);
    } catch (error) {
      setFormError(
        isApiError(error, 'VALIDATION_ERROR') ? copy.errEmailInvalid : copy.signupFailed,
      );
    }
  });

  if (sentTo) return <CheckMailPanel email={sentTo} />;

  return (
    <Stack gap="6">
      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <Stack gap="4">
          {formError && (
            <Alert.Root status="error" role="alert">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{formError}</Alert.Description>
              </Alert.Content>
            </Alert.Root>
          )}
          <Field.Root invalid={!!errors.email} required>
            <Field.Label>{copy.email}</Field.Label>
            <Input
              type="email"
              autoComplete="email"
              placeholder={copy.emailPlaceholder}
              {...register('email')}
            />
            <Field.HelperText>{copy.signupEmailHint}</Field.HelperText>
            <Field.ErrorText>{errors.email?.message}</Field.ErrorText>
          </Field.Root>
          <Button type="submit" size="lg" loading={isSubmitting}>
            {copy.signupWithEmail}
          </Button>
          <Text fontSize="xs" color="fg.subtle">
            {copy.signupNotice}
          </Text>
        </Stack>
      </form>

      <HStack>
        <Separator flex="1" />
        <Text fontSize="sm" color="fg.muted" flexShrink="0">
          {copy.orContinueWith}
        </Text>
        <Separator flex="1" />
      </HStack>

      <SocialButtons callbackURL="/" />

      <Text fontSize="sm" color="fg.muted" textAlign="center">
        {copy.alreadyHaveAccount}{' '}
        <Link asChild colorPalette="brand" color="colorPalette.fg" fontWeight="medium">
          <NextLink href="/login">{copy.login}</NextLink>
        </Link>
      </Text>
    </Stack>
  );
}

/** Shown after registering: where the mail went, how to get another one, where to log in. */
function CheckMailPanel({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);

  async function resend() {
    setBusy(true);
    const { error } = await authClient.sendVerificationEmail({
      email,
      callbackURL: VERIFY_CALLBACK,
    });
    setBusy(false);
    toaster.create(
      error
        ? { type: 'error', title: authErrorMessage(error) }
        : { type: 'success', title: copy.verificationResent },
    );
  }

  return (
    <Stack gap="4" data-testid="signup-check-mail">
      <Alert.Root status="success">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>{copy.signupCheckMailTitle}</Alert.Title>
          <Alert.Description>
            {copy.signupCheckMailBefore}{' '}
            <Text as="span" fontWeight="semibold" data-testid="signup-sent-to">
              {email}
            </Text>
            <br />
            {copy.signupCheckMailAfter}
          </Alert.Description>
        </Alert.Content>
      </Alert.Root>
      <Text fontSize="sm" color="fg.muted">
        {copy.signupCheckMailHint}
      </Text>
      <HStack gap="4" flexWrap="wrap">
        <Button variant="outline" onClick={() => void resend()} loading={busy}>
          {copy.resendVerification}
        </Button>
        <Link asChild colorPalette="brand" color="colorPalette.fg" fontWeight="medium">
          <NextLink href="/login">{copy.backToLogin}</NextLink>
        </Link>
        {/* An address that is already verified gets no mail from either the register call or
            the resend button above (better-auth answers both without sending, so the address
            is not disclosed). Reset is the exit for a verified account with no password. */}
        <Link asChild colorPalette="brand" color="colorPalette.fg" fontWeight="medium">
          <NextLink href="/reset-password">{copy.resetTitle}</NextLink>
        </Link>
      </HStack>
    </Stack>
  );
}
