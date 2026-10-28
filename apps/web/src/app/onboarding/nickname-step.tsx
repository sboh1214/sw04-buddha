'use client';

import { Alert, Button, Field, Input, Stack, Text } from '@chakra-ui/react';
import { NICKNAME_MAX_LENGTH } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { useSetOnboardingNickname } from '@/hooks/use-onboarding';
import { nicknameFailure, nicknameFormSchema, type NicknameFormValues } from '@/lib/nickname';

/**
 * 닉네임 설정, the onboarding's third step (#58, ADR-0069 decision 1 #57-6): the input starts with
 * the nickname the account has — its auto nickname `user_XXXX` (ADR-0052) — and confirming it
 * unchanged sets it. Another one is held to the rules (`nicknameFormSchema`, the shared ones the
 * server applies) before anything is sent, and so is the one it has unless it is the auto nickname
 * (`keptNicknameViolation`: a nickname typed through MY 설정 before #58, or an admin's — the seed's
 * 관리자 — meets the rules here, and one that breaks them is refused under the input so the member
 * types another, 오너 결정 2026-10-19 (2차) 2); what only the server knows (taken, ignoring case,
 * or given up by another account less than 30 days ago) comes back under the input.
 *
 * With this step the server grants the start Coin (#70) — the answer's `startGrant` goes into
 * `['me']` with the nickname (use-onboarding.ts), and the stepper shows the notice about it. A
 * refusal that says the screen is out of date (the step done in another tab, a step before it no
 * longer done) has asked `['me']` again before it reaches this form: the stepper moves to wherever
 * the server says, saying why above that step's heading, and this step and its line go with it —
 * the line stays only when `['me']` did not move (its read failed), and then it says what to do.
 *
 * `nickname` seeds the input once: the stepper keys this step on the account, so a session switched
 * under it mounts a fresh one. `accountId` is that account (the stepper's `me.id`), which the
 * answer names (`expectedAccountId`) — never the session's (use-onboarding.ts, ADR-0078 7-29).
 */
export function NicknameStep({ nickname, accountId }: { nickname: string; accountId: string }) {
  const save = useSetOnboardingNickname();
  const formatDate = useFormatDateTime();
  const [notice, setNotice] = useState<string | null>(null);
  const schema = useMemo(() => nicknameFormSchema(nickname, { onboarding: true }), [nickname]);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<NicknameFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { nickname },
  });

  const onSubmit = handleSubmit(async (values) => {
    setNotice(null);
    try {
      await save.mutateAsync({ nickname: values.nickname, expectedAccountId: accountId });
    } catch (error) {
      const failure = nicknameFailure(error, formatDate);
      if (failure.kind === 'field') {
        setError('nickname', { message: failure.message }, { shouldFocus: true });
        return;
      }
      setNotice(failure.message);
    }
  });

  return (
    <Stack gap="5" data-testid="nickname-step">
      <Text color="fg.muted">{copy.nicknameStepIntro}</Text>
      {notice && (
        <Alert.Root status="error" role="alert" data-testid="nickname-step-notice">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{notice}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <Stack gap="4">
          <Field.Root invalid={!!errors.nickname} required>
            <Field.Label>{copy.nickname}</Field.Label>
            <Input
              autoComplete="nickname"
              maxLength={NICKNAME_MAX_LENGTH}
              data-testid="nickname-step-input"
              {...register('nickname')}
            />
            <Field.HelperText>
              {copy.nicknameHint}. {copy.nicknameRulesHint} {copy.nicknameChangeRule}
            </Field.HelperText>
            <Field.ErrorText data-testid="nickname-step-error">
              {errors.nickname?.message}
            </Field.ErrorText>
          </Field.Root>
          <Button type="submit" size="lg" loading={isSubmitting} data-testid="nickname-step-submit">
            {copy.nicknameStepSubmit}
          </Button>
        </Stack>
      </form>
    </Stack>
  );
}
