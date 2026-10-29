'use client';

import { Alert, Button, Field, Skeleton, Stack, Text } from '@chakra-ui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { PasswordInput } from '@/components/ui/password-input';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useLinkedAccounts, useMe, useSetPassword } from '@/hooks/use-me';
import { isForAnotherAccount } from '@/lib/api';
import {
  AUTH_ERROR,
  CREDENTIAL_PROVIDER_ID,
  authClient,
  authErrorMessage,
} from '@/lib/auth-client';
import { newPasswordSchema, passwordSchema, type NewPasswordValues } from '@/lib/password';
import { ProfileUnavailable } from './profile-unavailable';
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
 *
 * The account the card is for is the one of this screen's `Me`, as every other MY 설정 card's —
 * `listAccounts` names no owner — so the card waits for `GET /me` as they do (`ProfileUnavailable`),
 * and the first password names that `Me`'s id (`SetPasswordFields`' `accountId`, ADR-0091). Both
 * forms are keyed by it: `['me']` can turn from A to B in place, before the session does and so
 * with no reset of SessionCacheGuard's to empty the card first (a window-focus refetch of `GET /me`
 * answered with B's cookie ahead of better-auth's session refetch, a realtime resnapshot, a window
 * beside one that signed in as B — ADR-0090 결정 4-2). Unkeyed, the passwords typed on A's card
 * would stay with '비밀번호 저장' on, now naming B — B's `Me` — with B's cookie: B's first password,
 * typed for A. Keyed, the card starts again empty for B.
 */
export function PasswordForm() {
  const { data: me, isPending } = useMe();
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
      {isPending || !me ? (
        <ProfileUnavailable />
      ) : accounts.isPending ? (
        <Skeleton height="10" />
      ) : accounts.isError ? (
        <AccountsUnavailable
          message={accounts.error.message}
          retrying={accounts.isFetching}
          onRetry={() => void accounts.refetch()}
        />
      ) : hasCredential ? (
        <ChangePasswordFields key={me.id} />
      ) : (
        <SetPasswordFields key={me.id} accountId={me.id} />
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

/**
 * The password names the account the card was drawn for (`accountId`, its `Me`'s id), never the
 * session's: in the render between the session naming another account and SessionCacheGuard's
 * reset the session already says B while the card is still A's, and a password sent as B's would
 * be B's first password, typed on A's card (ADR-0091). The server refuses it as another account's.
 */
function SetPasswordFields({ accountId }: { accountId: string }) {
  const setPassword = useSetPassword();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<NewPasswordValues>({ resolver: zodResolver(newPasswordSchema) });

  const onSubmit = handleSubmit(async ({ newPassword }) => {
    try {
      // The account the card was drawn for rides along (`expectedAccountId`, A-PG-24).
      await setPassword.mutateAsync({ newPassword, expectedAccountId: accountId });
      toaster.create({ type: 'success', title: copy.passwordSet });
      reset();
    } catch (error) {
      // The cookie is another account's (A-PG-24): no password was set, and the hook has asked
      // the session to refetch so the screen follows the account that is really signed in.
      toaster.create({
        type: 'error',
        title: isForAnotherAccount(error) ? copy.sessionChanged : copy.errUnknown,
      });
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
