'use client';

import { Alert, Button, Field, Link, Skeleton, Stack } from '@chakra-ui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { PasswordInput } from '@/components/ui/password-input';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useMe, useSetPassword } from '@/hooks/use-me';
import { CREDENTIAL_PROVIDER_ID } from '@/lib/auth-client';
import { newPasswordSchema, type NewPasswordValues } from '@/lib/password';

export function SetPasswordForm() {
  const router = useRouter();
  const { data: me, isPending } = useMe();
  const setPassword = useSetPassword();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<NewPasswordValues>({ resolver: zodResolver(newPasswordSchema) });

  const onSubmit = handleSubmit(async ({ newPassword }) => {
    try {
      await setPassword.mutateAsync(newPassword);
      toaster.create({ type: 'success', title: copy.passwordSet });
      router.push('/');
      router.refresh();
    } catch {
      toaster.create({ type: 'error', title: copy.errUnknown });
    }
  });

  if (isPending || !me) return <Skeleton height="32" />;

  // A social account (or a returning visitor) may already have one; changing it needs the
  // current password, which is what the settings screen is for.
  if (me.linkedAccounts.some((account) => account.providerId === CREDENTIAL_PROVIDER_ID)) {
    return (
      <Stack gap="4" data-testid="password-already-set">
        <Alert.Root status="info">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.passwordAlreadySet}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
        <Link asChild colorPalette="brand" color="colorPalette.fg" fontWeight="medium">
          <NextLink href="/">{copy.goHome}</NextLink>
        </Link>
      </Stack>
    );
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate>
      <Stack gap="4">
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
        <Button type="submit" size="lg" loading={isSubmitting}>
          {copy.setPasswordSubmit}
        </Button>
      </Stack>
    </form>
  );
}
