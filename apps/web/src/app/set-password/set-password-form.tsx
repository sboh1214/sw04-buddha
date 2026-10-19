'use client';

import { Alert, Button, Field, Link, Skeleton, Stack } from '@chakra-ui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { PasswordInput } from '@/components/ui/password-input';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useMe, useSetPassword } from '@/hooks/use-me';
import { isForAnotherAccount } from '@/lib/api';
import { CREDENTIAL_PROVIDER_ID } from '@/lib/auth-client';
import { newPasswordSchema, type NewPasswordValues } from '@/lib/password';

/**
 * The email sign-up's first password (ADR-0024). Nothing else is asked here since ADR-0070: the
 * consent, the real name and the number, and the nickname are the onboarding's steps on
 * /onboarding (#58). `next` — the page the visitor signed up from, home without one — is where the
 * form goes on, and the onboarding gate takes the account from there to its remaining step, as it
 * takes every account with one left, and brings it back to `next` at the end — so one place, the
 * gate, decides where an account that has not finished goes. On a page the gate exempts for a
 * login-only action (the post page, `ONBOARDING_EXEMPT_PAGES`) it does not: the account stays there
 * with its steps left until its next move (ADR-0073 9-37, asked in 결과 4의 4).
 */
export function SetPasswordForm({ next }: { next: string }) {
  const { data: me, isPending, isFetching, refetch } = useMe();

  if (isPending) return <Skeleton height="32" />;

  // `GET /me` settled without a profile — it failed, or the session the server saw is already
  // gone on the client. It decides which of the two branches below applies, so neither may be
  // guessed, and this page is the only place a first password can be set: a skeleton that
  // never ends would leave the account permanently half-finished.
  if (!me) {
    return (
      <Stack gap="3" align="flex-start" data-testid="set-password-unavailable">
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.errProfileLoad}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
        <Button size="sm" variant="outline" loading={isFetching} onClick={() => void refetch()}>
          {copy.retry}
        </Button>
      </Stack>
    );
  }

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
          <NextLink href={next as Route}>{next === '/' ? copy.goHome : copy.continueOn}</NextLink>
        </Link>
      </Stack>
    );
  }

  // Keyed on the account, so a session switched under this screen (SessionCacheGuard) mounts a
  // fresh form for the new one instead of keeping the previous account's typed values.
  return <SetPasswordFields key={me.id} next={next} />;
}

function SetPasswordFields({ next }: { next: string }) {
  const router = useRouter();
  const setPassword = useSetPassword();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<NewPasswordValues>({
    resolver: zodResolver(newPasswordSchema),
    defaultValues: { newPassword: '', newPasswordConfirm: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      // The body names the account the screen shows (`expectedAccountId`, A-PG-24): read from
      // the session by the hook, whose `ready` keeps the button off until it is known.
      await setPassword.mutateAsync(values.newPassword);
      toaster.create({ type: 'success', title: copy.passwordSet });
      router.push(next as Route);
      router.refresh();
    } catch (error) {
      // Another account's cookie: nothing was written, and the session refetch the hook started
      // lets SessionCacheGuard swap this screen for the account that is really signed in.
      toaster.create({
        type: 'error',
        title: isForAnotherAccount(error) ? copy.sessionChanged : copy.errUnknown,
      });
    }
  });

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
        <Button type="submit" size="lg" loading={isSubmitting} disabled={!setPassword.ready}>
          {copy.setPasswordSubmit}
        </Button>
      </Stack>
    </form>
  );
}
