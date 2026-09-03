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
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { SocialButtons } from '@/components/auth/social-buttons';
import { PasswordInput } from '@/components/ui/password-input';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { AUTH_ERROR, authErrorMessage, signUp } from '@/lib/auth-client';

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

export function SignupForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
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
    });
    if (error) {
      // better-auth 1.7.2 sign-up emits USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL.
      if (
        error.code === AUTH_ERROR.USER_ALREADY_EXISTS ||
        error.code === AUTH_ERROR.USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL
      ) {
        setError('email', { message: copy.emailAlreadyUsed });
      } else {
        setFormError(authErrorMessage(error, copy.signupFailed));
      }
      return;
    }
    toaster.create({ type: 'success', title: copy.signupDone, description: copy.verificationSent });
    await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    router.push('/');
    router.refresh();
  });

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
