'use client';

import { Alert, Button, Field, Input, Link, Stack, Text } from '@chakra-ui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { PasswordInput } from '@/components/ui/password-input';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { AUTH_ERROR, authClient, authErrorMessage } from '@/lib/auth-client';
import { passwordSchema } from '@/lib/password';

const requestSchema = z.object({ email: z.email(copy.errEmailInvalid) });
type RequestValues = z.infer<typeof requestSchema>;

export function RequestResetForm({ tokenInvalid }: { tokenInvalid: boolean }) {
  const [sent, setSent] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RequestValues>({ resolver: zodResolver(requestSchema) });

  const onSubmit = handleSubmit(async ({ email }) => {
    // The link in the email points at `${BETTER_AUTH_URL}/api/auth/reset-password/<token>`
    // and redirects to `redirectTo?token=<token>` (same-origin path is fine).
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: '/reset-password',
    });
    if (error) {
      toaster.create({ type: 'error', title: authErrorMessage(error) });
      return;
    }
    // Same message whether or not the email exists (no account enumeration).
    setSent(true);
  });

  return (
    <Stack gap="4">
      {tokenInvalid && (
        <Alert.Root status="warning" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.resetTokenInvalid}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {sent ? (
        <Alert.Root status="success" role="status">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.resetRequested}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      ) : (
        <form onSubmit={(e) => void onSubmit(e)} noValidate>
          <Stack gap="4">
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
            <Button type="submit" size="lg" loading={isSubmitting}>
              {copy.resetRequest}
            </Button>
          </Stack>
        </form>
      )}
      <Text fontSize="sm" textAlign="center">
        <Link asChild color="fg.muted">
          <NextLink href="/login">{copy.backToLogin}</NextLink>
        </Link>
      </Text>
    </Stack>
  );
}

const newPasswordSchema = z
  .object({ password: passwordSchema, passwordConfirm: z.string() })
  .refine((v) => v.password === v.passwordConfirm, {
    message: copy.errPasswordMismatch,
    path: ['passwordConfirm'],
  });
type NewPasswordValues = z.infer<typeof newPasswordSchema>;

export function SetNewPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<NewPasswordValues>({ resolver: zodResolver(newPasswordSchema) });

  const onSubmit = handleSubmit(async ({ password }) => {
    setFormError(null);
    const { error } = await authClient.resetPassword({ newPassword: password, token });
    if (error) {
      setFormError(
        error.code === AUTH_ERROR.INVALID_TOKEN ? copy.resetTokenInvalid : authErrorMessage(error),
      );
      return;
    }
    toaster.create({ type: 'success', title: copy.resetDone });
    router.push('/login');
  });

  return (
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
        <Field.Root invalid={!!errors.password} required>
          <Field.Label>{copy.newPassword}</Field.Label>
          <PasswordInput autoComplete="new-password" {...register('password')} />
          <Field.HelperText>{copy.passwordHint}</Field.HelperText>
          <Field.ErrorText>{errors.password?.message}</Field.ErrorText>
        </Field.Root>
        <Field.Root invalid={!!errors.passwordConfirm} required>
          <Field.Label>{copy.newPasswordConfirm}</Field.Label>
          <PasswordInput autoComplete="new-password" {...register('passwordConfirm')} />
          <Field.ErrorText>{errors.passwordConfirm?.message}</Field.ErrorText>
        </Field.Root>
        <Button type="submit" size="lg" loading={isSubmitting}>
          {copy.resetSubmit}
        </Button>
      </Stack>
    </form>
  );
}
