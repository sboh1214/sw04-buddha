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
import { useQueryClient } from '@tanstack/react-query';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { SocialButtons } from '@/components/auth/social-buttons';
import { PasswordInput } from '@/components/ui/password-input';
import { copy } from '@/copy';
import { AUTH_ERROR, authClient, authErrorMessage, signIn } from '@/lib/auth-client';

const schema = z.object({
  email: z.email(copy.errEmailInvalid),
  password: z.string().min(1, copy.errRequired),
});
type FormValues = z.infer<typeof schema>;

export function LoginForm({ next, notice }: { next: string; notice?: string | undefined }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(notice ?? null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    const { error } = await signIn.email({ email: values.email, password: values.password });
    if (error) {
      if (error.code === AUTH_ERROR.EMAIL_NOT_VERIFIED) {
        // The API does not mail on sign-in (ADR-0023); asking here keeps the link landing
        // on /login, where an expired one shows a notice, and surfaces a mail outage.
        const { error: resendError } = await authClient.sendVerificationEmail({
          email: values.email,
          callbackURL: '/login',
        });
        setFormError(resendError ? copy.emailNotVerifiedResendFailed : copy.emailNotVerified);
        return;
      }
      setFormError(
        error.status === 401 || error.code === AUTH_ERROR.INVALID_EMAIL_OR_PASSWORD
          ? copy.loginFailed
          : authErrorMessage(error),
      );
      return;
    }
    // Drop the previous account's cache rather than only invalidating `['me']`: signing out
    // is not the only way to get here (an expired session, a failed sign-out, or simply
    // opening /login), and no query key carries a user id, so anything left over would be
    // served to this session. `signIn.social` needs no equivalent — it reloads the document.
    queryClient.clear();
    router.push(next as Route);
    router.refresh();
  });

  return (
    <Stack gap="6">
      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <Stack gap="4">
          {formError && (
            <Stack gap="1">
              <Alert.Root status="error" role="alert">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{formError}</Alert.Description>
                </Alert.Content>
              </Alert.Root>
              {/* An account whose link was never clicked has no password yet, so the failure
                  above is indistinguishable from a typo (ADR-0024). */}
              <Text fontSize="xs" color="fg.subtle">
                {copy.loginResendHint}{' '}
                <Link asChild colorPalette="brand" color="colorPalette.fg">
                  <NextLink href="/signup">{copy.signup}</NextLink>
                </Link>
              </Text>
              {/* The other half of ADR-0024: verified but never got as far as a password.
                  Re-registering is silent for a verified address, so reset is the way back.
                  Named, not linked — the link itself is the one on the password field, and a
                  second link with the same name would break e2e locators. */}
              <Text fontSize="xs" color="fg.subtle">
                {copy.loginSetPasswordHint}
              </Text>
            </Stack>
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
            <HStack justify="space-between" w="full">
              <Field.Label>{copy.password}</Field.Label>
              <Link asChild fontSize="sm" color="fg.muted">
                <NextLink href="/reset-password">{copy.forgotPassword}</NextLink>
              </Link>
            </HStack>
            <PasswordInput autoComplete="current-password" {...register('password')} />
            <Field.ErrorText>{errors.password?.message}</Field.ErrorText>
          </Field.Root>
          <Button type="submit" size="lg" loading={isSubmitting}>
            {copy.loginWithEmail}
          </Button>
        </Stack>
      </form>

      <HStack>
        <Separator flex="1" />
        <Text fontSize="sm" color="fg.muted" flexShrink="0">
          {copy.orContinueWith}
        </Text>
        <Separator flex="1" />
      </HStack>

      <SocialButtons callbackURL={next} />

      <Text fontSize="sm" color="fg.muted" textAlign="center">
        {copy.noAccountYet}{' '}
        <Link asChild colorPalette="brand" color="colorPalette.fg" fontWeight="medium">
          <NextLink href="/signup">{copy.signup}</NextLink>
        </Link>
      </Text>
    </Stack>
  );
}
