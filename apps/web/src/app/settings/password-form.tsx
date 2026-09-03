'use client';

import { Button, Field, Skeleton, Stack, Text } from '@chakra-ui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { PasswordInput } from '@/components/ui/password-input';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import {
  AUTH_ERROR,
  CREDENTIAL_PROVIDER_ID,
  authClient,
  authErrorMessage,
} from '@/lib/auth-client';
import { passwordSchema } from '@/app/signup/signup-form';
import { ACCOUNTS_QUERY_KEY } from './linked-accounts';
import { SettingsSection } from './section';

const schema = z
  .object({
    currentPassword: z.string().min(1, copy.errRequired),
    newPassword: passwordSchema,
    newPasswordConfirm: z.string(),
  })
  .refine((v) => v.newPassword === v.newPasswordConfirm, {
    message: copy.errPasswordMismatch,
    path: ['newPasswordConfirm'],
  });
type FormValues = z.infer<typeof schema>;

/** Password change (`changePassword`). Hidden for social-only users without a credential. */
export function PasswordForm() {
  const accounts = useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await authClient.listAccounts();
      if (error) throw new Error(authErrorMessage(error));
      return data;
    },
  });
  const hasCredential = accounts.data?.some((a) => a.providerId === CREDENTIAL_PROVIDER_ID);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (values) => {
    const { error } = await authClient.changePassword({
      currentPassword: values.currentPassword,
      newPassword: values.newPassword,
      revokeOtherSessions: true,
    });
    if (error) {
      if (error.code === AUTH_ERROR.INVALID_PASSWORD) {
        setError('currentPassword', { message: copy.passwordWrong });
      } else {
        toaster.create({ type: 'error', title: authErrorMessage(error) });
      }
      return;
    }
    toaster.create({ type: 'success', title: copy.passwordChanged });
    reset();
  });

  return (
    <SettingsSection title={copy.settingsPassword} testId="settings-password">
      {accounts.isPending ? (
        <Skeleton height="10" />
      ) : !hasCredential ? (
        <Text fontSize="sm" color="fg.muted">
          {copy.passwordNotSet}
        </Text>
      ) : (
        <form onSubmit={(e) => void onSubmit(e)} noValidate>
          <Stack gap="4">
            <Field.Root invalid={!!errors.currentPassword} required>
              <Field.Label>{copy.currentPassword}</Field.Label>
              <PasswordInput autoComplete="current-password" {...register('currentPassword')} />
              <Field.ErrorText>{errors.currentPassword?.message}</Field.ErrorText>
            </Field.Root>
            <Field.Root invalid={!!errors.newPassword} required>
              <Field.Label>{copy.newPassword}</Field.Label>
              <PasswordInput autoComplete="new-password" {...register('newPassword')} />
              <Field.HelperText>{copy.passwordHint}</Field.HelperText>
              <Field.ErrorText>{errors.newPassword?.message}</Field.ErrorText>
            </Field.Root>
            <Field.Root invalid={!!errors.newPasswordConfirm} required>
              <Field.Label>{copy.newPasswordConfirm}</Field.Label>
              <PasswordInput autoComplete="new-password" {...register('newPasswordConfirm')} />
              <Field.ErrorText>{errors.newPasswordConfirm?.message}</Field.ErrorText>
            </Field.Root>
            <Button type="submit" alignSelf="flex-start" loading={isSubmitting}>
              {copy.settingsPassword}
            </Button>
          </Stack>
        </form>
      )}
    </SettingsSection>
  );
}
