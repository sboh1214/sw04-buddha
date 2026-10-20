'use client';

import { Alert, Button, Link as ChakraLink, Field, HStack, Input, Stack } from '@chakra-ui/react';
import { NICKNAME_MAX_LENGTH } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { refreshOwnMe, useMe, useUpdateNickname } from '@/hooks/use-me';
import { nicknameFailure, nicknameFormSchema, type NicknameFormValues } from '@/lib/nickname';
import { profilePath } from '@/lib/profile';
import { ProfileUnavailable } from './profile-unavailable';
import { SettingsSection } from './section';

/**
 * 프로필: the nickname, and the way to the member's own public profile (#41, ADR-0078) — where the
 * nickname, the 소개 and the interest categories edited on this screen are shown to everyone
 * (`/u/<publicId>`, whose own page links back here, ADR-0069 decision 4 #41).
 */
export function NicknameForm() {
  const { data: me, isPending } = useMe();
  return (
    <SettingsSection title={copy.settingsProfile} testId="settings-profile">
      {isPending || !me ? (
        <ProfileUnavailable />
      ) : (
        <Stack gap="4">
          <NicknameFields nickname={me.profile.nickname} accountId={me.id} />
          <ChakraLink asChild alignSelf="flex-start" textStyle="bodySm" color="brand.fg">
            <NextLink
              href={profilePath(me.profile.publicId) as Route}
              data-testid="settings-view-profile"
            >
              {copy.settingsViewProfile}
            </NextLink>
          </ChakraLink>
        </Stack>
      )}
    </SettingsSection>
  );
}

/**
 * Mounted only once the profile is known, so the input is seeded synchronously (no empty
 * first paint, no reset-by-effect that could wipe an edit in progress). `values` keeps the
 * form in sync with later refetches (deep-compared by react-hook-form, so an unrelated
 * refetch with the same nickname is a no-op) without discarding a dirty field.
 *
 * The nickname rules of #58 (ADR-0069 decision 1 #57-6), the same ones as the onboarding's
 * nickname step (lib/nickname.ts): the format and, for a typed nickname, no `user_` prefix and no
 * operator-impersonating word, checked before sending; the server's answers for a nickname taken
 * (ignoring case) or held for 30 days after another account gave it up, and for the 30 days
 * between changes — with when the next change is allowed, in the member's time zone — under the
 * input. MY 설정 is reached only by an onboarded account (the gate), so `ONBOARDING_REQUIRED` here
 * means another tab's state changed: `['me']` is asked again, and the gate follows it.
 */
function NicknameFields({ nickname, accountId }: { nickname: string; accountId: string }) {
  const update = useUpdateNickname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const formatDate = useFormatDateTime();
  const [notice, setNotice] = useState<string | null>(null);
  const values = useMemo(() => ({ nickname }), [nickname]);
  const schema = useMemo(() => nicknameFormSchema(nickname), [nickname]);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isDirty },
  } = useForm<NicknameFormValues>({
    resolver: zodResolver(schema),
    defaultValues: values,
    values,
    resetOptions: { keepDirtyValues: true },
  });

  const onSubmit = handleSubmit(async (form) => {
    setNotice(null);
    try {
      // The account this screen shows (#58: PATCH /me names it, as every owner write does).
      await update.mutateAsync({ nickname: form.nickname, expectedAccountId: accountId });
      reset({ nickname: form.nickname });
      toaster.create({ type: 'success', title: copy.nicknameSaved });
      // Back to the profile (or to a post's byline) shows the new nickname (bio-section.tsx).
      router.refresh();
    } catch (error) {
      const failure = nicknameFailure(error, formatDate);
      if (failure.kind === 'field') {
        setError('nickname', { message: failure.message }, { shouldFocus: true });
        return;
      }
      if (failure.kind === 'refresh') void refreshOwnMe(queryClient, accountId);
      setNotice(failure.message);
    }
  });

  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate>
      <Stack gap="4">
        {notice && (
          <Alert.Root status="error" role="alert" data-testid="nickname-notice">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{notice}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}
        <Field.Root invalid={!!errors.nickname} required>
          <Field.Label>{copy.nickname}</Field.Label>
          <HStack w="full" align="start">
            <Input
              autoComplete="nickname"
              maxLength={NICKNAME_MAX_LENGTH}
              data-testid="nickname-input"
              {...register('nickname')}
            />
            <Button type="submit" loading={update.isPending} disabled={!isDirty}>
              {copy.save}
            </Button>
          </HStack>
          <Field.HelperText>
            {copy.nicknameHint}. {copy.nicknameRulesHint} {copy.nicknameChangeRule}
          </Field.HelperText>
          <Field.ErrorText data-testid="nickname-error">{errors.nickname?.message}</Field.ErrorText>
        </Field.Root>
      </Stack>
    </form>
  );
}
