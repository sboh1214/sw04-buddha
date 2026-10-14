'use client';

import { Button, Field, HStack, Input, Stack } from '@chakra-ui/react';
import { NICKNAME_MAX_LENGTH, NICKNAME_MIN_LENGTH, NICKNAME_PATTERN } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useMe, useUpdateNickname } from '@/hooks/use-me';
import { isApiError, validationField } from '@/lib/api';
import { ProfileUnavailable } from './profile-unavailable';
import { SettingsSection } from './section';

// Same bounds/pattern as @buddha/shared nicknameSchema (PLAN 11.5: the policy is not
// re-implemented, only the message is localised here); the API validates again.
const schema = z.object({
  nickname: z
    .string()
    .trim()
    .min(NICKNAME_MIN_LENGTH, copy.errNicknameFormat)
    .max(NICKNAME_MAX_LENGTH, copy.errNicknameFormat)
    .regex(NICKNAME_PATTERN, copy.errNicknameFormat),
});
type FormValues = z.infer<typeof schema>;

export function NicknameForm() {
  const { data: me, isPending } = useMe();
  return (
    <SettingsSection title={copy.settingsProfile} testId="settings-profile">
      {isPending || !me ? (
        <ProfileUnavailable />
      ) : (
        <NicknameFields nickname={me.profile.nickname} />
      )}
    </SettingsSection>
  );
}

/**
 * Mounted only once the profile is known, so the input is seeded synchronously (no empty
 * first paint, no reset-by-effect that could wipe an edit in progress). `values` keeps the
 * form in sync with later refetches (deep-compared by react-hook-form, so an unrelated
 * refetch with the same nickname is a no-op) without discarding a dirty field.
 */
function NicknameFields({ nickname }: { nickname: string }) {
  const update = useUpdateNickname();
  const values = useMemo(() => ({ nickname }), [nickname]);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: values,
    values,
    resetOptions: { keepDirtyValues: true },
  });

  const onSubmit = handleSubmit(async (form) => {
    try {
      await update.mutateAsync(form.nickname);
      reset({ nickname: form.nickname });
      toaster.create({ type: 'success', title: copy.nicknameSaved });
    } catch (error) {
      // Duplicate nickname -> VALIDATION_ERROR (PLAN 13 M1 AC) -> field error.
      if (
        isApiError(error, 'VALIDATION_ERROR') &&
        (validationField(error) ?? 'nickname') === 'nickname'
      ) {
        setError('nickname', { message: copy.errNicknameTaken });
        return;
      }
      toaster.create({
        type: 'error',
        title: copy.errUnknown,
        description: error instanceof Error ? error.message : undefined,
      });
    }
  });

  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate>
      <Stack gap="4">
        <Field.Root invalid={!!errors.nickname} required>
          <Field.Label>{copy.nickname}</Field.Label>
          <HStack w="full" align="start">
            <Input
              autoComplete="nickname"
              maxLength={20}
              data-testid="nickname-input"
              {...register('nickname')}
            />
            <Button type="submit" loading={update.isPending} disabled={!isDirty}>
              {copy.save}
            </Button>
          </HStack>
          <Field.HelperText>{copy.nicknameHint}</Field.HelperText>
          <Field.ErrorText>{errors.nickname?.message}</Field.ErrorText>
        </Field.Root>
      </Stack>
    </form>
  );
}
