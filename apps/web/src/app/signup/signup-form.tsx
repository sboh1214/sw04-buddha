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
import { PasswordInput } from '@/components/ui/password-input';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { authClient, authErrorMessage, signUp } from '@/lib/auth-client';

/** PLAN 10.2: password >= 8 chars. 128 is better-auth's default maxPasswordLength. */
export const passwordSchema = z
  .string()
  .min(8, copy.errPasswordTooShort)
  .max(128, copy.errPasswordTooLong);

const schema = z
  .object({
    email: z.email(copy.errEmailInvalid),
    password: passwordSchema,
    passwordConfirm: z.string(),
  })
  .refine((v) => v.password === v.passwordConfirm, {
    message: copy.errPasswordMismatch,
    path: ['passwordConfirm'],
  });
type FormValues = z.infer<typeof schema>;

/**
 * Verification is mandatory (PLAN 17 Q1 decision): the link in the mail completes the
 * sign-up and signs the user in (`/login` then bounces a logged-in visitor to `/`).
 * A duplicate email gets the same answer from the API (no enumeration), hence the hint.
 */
const VERIFY_CALLBACK = '/login';

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
    // better-auth requires `name`; the visible nickname lives in `profiles` (PLAN 10.4) and is
    // auto-generated server-side, so the local part of the email is enough here.
    const { error } = await signUp.email({
      email: values.email,
      password: values.password,
      name: values.email.split('@')[0] ?? values.email,
      callbackURL: VERIFY_CALLBACK,
    });
    if (error) {
      setFormError(authErrorMessage(error, copy.signupFailed));
      return;
    }
    setSentTo(values.email);
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
            <Field.ErrorText>{errors.email?.message}</Field.ErrorText>
          </Field.Root>
          <Field.Root invalid={!!errors.password} required>
            <Field.Label>{copy.password}</Field.Label>
            <PasswordInput autoComplete="new-password" {...register('password')} />
            <Field.HelperText>{copy.passwordHint}</Field.HelperText>
            <Field.ErrorText>{errors.password?.message}</Field.ErrorText>
          </Field.Root>
          <Field.Root invalid={!!errors.passwordConfirm} required>
            <Field.Label>{copy.passwordConfirm}</Field.Label>
            <PasswordInput autoComplete="new-password" {...register('passwordConfirm')} />
            <Field.ErrorText>{errors.passwordConfirm?.message}</Field.ErrorText>
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

/** Shown after sign-up: where the mail went, how to get another one, and the way to login. */
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
      </HStack>
    </Stack>
  );
}
