'use client';

import { Alert, Button, Field, Link, Separator, Skeleton, Stack, Text } from '@chakra-ui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { ContactInputs } from '@/components/auth/contact-inputs';
import { PasswordInput } from '@/components/ui/password-input';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { ContactStepError, useSetPasswordAndContact } from '@/hooks/use-contact';
import { useMe } from '@/hooks/use-me';
import { CREDENTIAL_PROVIDER_ID } from '@/lib/auth-client';
import { contactFormShape } from '@/lib/contact-form';
import { newPasswordSchema } from '@/lib/password';

/**
 * The email sign-up's own contact step (ADR-0043): an account with no real name and mobile
 * number gives them here, together with its first password — the first moment the mailbox is
 * proven, so no personal data is ever stored for an address nobody has verified. An account
 * that already has a contact (the gate sent it through /onboarding first) gets the same shape
 * with the two fields unchecked and unused, so one `useForm` type covers both.
 *
 * With the contact fields the confirmation check is re-applied rather than inherited through
 * `safeExtend`: zod skips a refinement once any field has failed, so a mismatch hid behind a
 * blank name or number and only surfaced on a second submit. `when` runs it on every parse —
 * the two password values are always strings here, so the comparison is always meaningful.
 */
const withContactSchema = z
  .object({ ...newPasswordSchema.shape, ...contactFormShape })
  .refine((v) => v.newPassword === v.newPasswordConfirm, {
    message: copy.errPasswordMismatch,
    path: ['newPasswordConfirm'],
    when: () => true,
  });
// Nothing here can fail but the password fields, so the inherited refinement already runs.
const passwordOnlySchema = newPasswordSchema.safeExtend({
  realName: z.string(),
  phone: z.string(),
});
type FormValues = z.input<typeof withContactSchema>;

export function SetPasswordForm() {
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
          <NextLink href="/">{copy.goHome}</NextLink>
        </Link>
      </Stack>
    );
  }

  // Mounted once `me` is known, so the schema — with or without the contact fields — is fixed
  // from the form's first render (the gate may have sent the account through /onboarding
  // already, in which case only the password is asked for).
  return <SetPasswordFields needsContact={me.contact === null} />;
}

function SetPasswordFields({ needsContact }: { needsContact: boolean }) {
  const router = useRouter();
  const finish = useSetPasswordAndContact();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver<FormValues, unknown, FormValues>(
      needsContact ? withContactSchema : passwordOnlySchema,
    ),
    defaultValues: { newPassword: '', newPasswordConfirm: '', realName: '', phone: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await finish.mutateAsync({
        newPassword: values.newPassword,
        contact: needsContact ? { realName: values.realName, phone: values.phone } : null,
      });
      toaster.create({ type: 'success', title: copy.passwordSet });
      router.push('/');
      router.refresh();
    } catch (error) {
      if (error instanceof ContactStepError) {
        // The password is saved, so this screen now answers "already set"; /onboarding is
        // where the contact can still be given (and the gate would send them there anyway).
        toaster.create({ type: 'error', title: copy.setPasswordContactFailed });
        router.push('/onboarding');
        return;
      }
      toaster.create({ type: 'error', title: copy.errUnknown });
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
        {needsContact && (
          <Stack gap="4" data-testid="set-password-contact">
            <Separator />
            <Text fontSize="sm" fontWeight="medium">
              {copy.setPasswordContactHeading}
            </Text>
            <ContactInputs
              realName={register('realName')}
              phone={register('phone')}
              errors={{ realName: errors.realName?.message, phone: errors.phone?.message }}
            />
          </Stack>
        )}
        <Button type="submit" size="lg" loading={isSubmitting}>
          {copy.setPasswordSubmit}
        </Button>
      </Stack>
    </form>
  );
}
