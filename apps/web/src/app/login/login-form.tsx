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
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { AUTH_ERROR, authErrorMessage, signIn } from '@/lib/auth-client';

const schema = z.object({
  email: z.email(copy.errEmailInvalid),
  password: z.string().min(1, copy.errRequired),
});
type FormValues = z.infer<typeof schema>;

export function LoginForm({ next, socialError }: { next: string; socialError: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(
    socialError ? copy.socialUnavailable : null,
  );
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    const { error } = await signIn.email({ email: values.email, password: values.password });
    if (error) {
      setFormError(
        error.code === AUTH_ERROR.EMAIL_NOT_VERIFIED
          ? copy.emailNotVerified
          : error.status === 401 || error.code === AUTH_ERROR.INVALID_EMAIL_OR_PASSWORD
            ? copy.loginFailed
            : authErrorMessage(error),
      );
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    router.push(next as Route);
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
