'use client';

import { Alert, Button, Field, Skeleton, Stack, Text } from '@chakra-ui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { PasswordInput } from '@/components/ui/password-input';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useLinkedAccounts, useSetPassword } from '@/hooks/use-me';
import {
  AUTH_ERROR,
  CREDENTIAL_PROVIDER_ID,
  authClient,
  authErrorMessage,
} from '@/lib/auth-client';
import { newPasswordSchema, passwordSchema, type NewPasswordValues } from '@/lib/password';
import { SettingsSection } from './section';

const changeSchema = z
  .object({
    currentPassword: z.string().min(1, copy.errRequired),
    newPassword: passwordSchema,
    newPasswordConfirm: z.string(),
  })
  .refine((v) => v.newPassword === v.newPasswordConfirm, {
    message: copy.errPasswordMismatch,
    path: ['newPasswordConfirm'],
  });
type ChangeValues = z.infer<typeof changeSchema>;

/**
 * Change the password (`changePassword`, needs the current one) or set the first one for an
 * account that has none: a social-only user, or someone who left the set-password step of
 * the sign-up (ADR-0024) unfinished.
 */
export function PasswordForm() {
  const accounts = useLinkedAccounts();
  const hasCredential = accounts.data?.some((a) => a.providerId === CREDENTIAL_PROVIDER_ID);

  return (
    <SettingsSection
      // On error `hasCredential` is undefined, and neither "변경" nor "설정" is known to be
      // true, so the heading falls back to the neutral noun instead of picking a side.
      title={
        accounts.isError
          ? copy.password
          : hasCredential
            ? copy.settingsPassword
            : copy.setPasswordTitle
      }
      testId="settings-password"
    >
      {accounts.isPending ? (
        <Skeleton height="10" />
      ) : accounts.isError ? (
        <AccountsUnavailable
          message={accounts.error.message}
          retrying={accounts.isFetching}
          onRetry={() => void accounts.refetch()}
        />
      ) : hasCredential ? (
        <ChangePasswordFields />
      ) : (
        <SetPasswordFields />
      )}
    </SettingsSection>
  );
}

/**
 * `listAccounts` failed (session gone, auth endpoint down). That list is the only thing that
 * says whether this account already has a password, so neither form may be shown: offering
 * "설정" to someone who has one misstates their account and dies on submit with a generic
 * error. `message` is already Korean — the query normalises both failure shapes.
 */
function AccountsUnavailable({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <Stack gap="3" align="flex-start">
      <Alert.Root status="error" role="alert" data-testid="password-accounts-error">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{message}</Alert.Description>
        </Alert.Content>
      </Alert.Root>
      <Button size="sm" variant="outline" loading={retrying} onClick={onRetry}>
        {copy.retry}
      </Button>
    </Stack>
  );
}

function ChangePasswordFields() {
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ChangeValues>({ resolver: zodResolver(changeSchema) });

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
  );
}

function SetPasswordFields() {
  const setPassword = useSetPassword();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<NewPasswordValues>({ resolver: zodResolver(newPasswordSchema) });

  const onSubmit = handleSubmit(async ({ newPassword }) => {
    try {
      await setPassword.mutateAsync(newPassword);
      toaster.create({ type: 'success', title: copy.passwordSet });
      reset();
    } catch {
      toaster.create({ type: 'error', title: copy.errUnknown });
    }
  });

  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate>
      <Stack gap="4">
        <Text fontSize="sm" color="fg.muted">
          {copy.passwordNotSet}
        </Text>
        <Field.Root invalid={!!errors.newPassword} required>
          <Field.Label>{copy.password}</Field.Label>
          <PasswordInput
            autoComplete="new-password"
            data-testid="new-password"
            {...register('newPassword')}
          />
          <Field.HelperText>{copy.passwordHint}</Field.HelperText>
          <Field.ErrorText>{errors.newPassword?.message}</Field.ErrorText>
        </Field.Root>
        <Field.Root invalid={!!errors.newPasswordConfirm} required>
          <Field.Label>{copy.passwordConfirm}</Field.Label>
          <PasswordInput
            autoComplete="new-password"
            data-testid="new-password-confirm"
            {...register('newPasswordConfirm')}
          />
          <Field.ErrorText>{errors.newPasswordConfirm?.message}</Field.ErrorText>
        </Field.Root>
        <Button type="submit" alignSelf="flex-start" loading={isSubmitting}>
          {copy.setPasswordSubmit}
        </Button>
      </Stack>
    </form>
  );
}
