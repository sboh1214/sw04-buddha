'use client';

import { Alert, Button, Link as ChakraLink, Field, HStack, Input, Stack } from '@chakra-ui/react';
import { NICKNAME_MAX_LENGTH } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { RefusalText } from '@/components/moderation/refusal-text';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useMe, useUpdateNickname } from '@/hooks/use-me';
import { useProfileDraftTakenBack } from '@/hooks/use-profile-draft';
import { useKeepForStep, useSettingsStep } from '@/hooks/use-settings-step';
import {
  nicknameFormSchema,
  settingsNicknameFailure,
  type NicknameFormValues,
} from '@/lib/nickname';
import { profileItemSaveGoesToStep, profilePath } from '@/lib/profile';
import {
  clearSessionProfileDraft,
  keepSessionProfileDraft,
  nicknameDraftToKeep,
  nicknameToRestore,
} from '@/lib/profile-drafts';
import { isRestricted } from '@/lib/restriction';
import { ProfileUnavailable } from './profile-unavailable';
import { SettingsSection } from './section';

/** The field error's type for a writing restriction's refusal (#185): its link goes with it. */
const RESTRICTED_ERROR = 'restricted';

/**
 * 프로필: the nickname, and the way to the member's own public profile (#41, ADR-0078) — where the
 * nickname, the image (#141), the 소개 and the interest categories edited on this screen are shown
 * to everyone
 * (`/u/<publicId>`, whose own page links back here, ADR-0069 decision 4 #41). MY's summary has the
 * same way there (owner decision 2026-10-21 answer 7).
 */
export function NicknameForm() {
  const { data: me, isPending } = useMe();
  return (
    <SettingsSection title={copy.settingsProfile} testId="settings-profile">
      {isPending || !me ? (
        <ProfileUnavailable />
      ) : (
        <Stack gap="4">
          {/* Keyed by account: a tab that switched accounts starts from the new one's nickname. */}
          <NicknameFields key={me.id} nickname={me.profile.nickname} accountId={me.id} />
          <ChakraLink asChild alignSelf="flex-start" textStyle="bodySm" color="brand.fg">
            <NextLink
              href={profilePath(me.profile.publicId) as Route}
              data-testid="settings-view-profile"
            >
              {copy.viewOwnProfile}
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
 * input. MY 설정 is reached by an onboarded account (the gate) — and by one facing a re-consent
 * alone (ONBOARDING_EXEMPT_PAGES, #41), whose change the server takes only once it has agreed again
 * (owner decision 2026-10-22 answer 1, `PATCH /me` behind OnboardedGuard): a change is a new value
 * of a public item, so 저장 goes to the step without sending (`profileItemSaveGoesToStep`, as the
 * 소개 and the categories, `useSettingsStep`), and comes back here. As the page goes to the step —
 * this card's save or another's — the nickname typed, when it names another than the account's, is
 * kept in the tab (`useKeepForStep`, lib/profile-drafts.ts); drawn again for the account with no
 * step left, the box takes it back unsaved (`useProfileDraftTakenBack`) — unless it holds a
 * nickname of the member's own by then (the step done in another tab, learned while typing here:
 * `nicknameToRestore`) — and a change that lands drops what was kept, as the 소개's (owner decision
 * 2026-10-22 (2nd) answer 2, ADR-0078 7-25). A change the server refused for the onboarding — sent
 * before `GET /me` said a step is left — has had `['me']` asked again by the hook, and goes on as
 * the 소개's does (`afterRefusal`, the box's nickname kept as for 저장): to the step without a word
 * on MY 설정, else with the gate; where neither moves, the card says what the 소개's says there
 * (`settingsNicknameFailure` — '약관 동의 등 남은 절차를 마친 뒤에 할 수 있습니다.', not the onboarding
 * stepper's '앞 단계를 먼저 마쳐 주세요.').
 */
function NicknameFields({ nickname, accountId }: { nickname: string; accountId: string }) {
  const update = useUpdateNickname();
  const router = useRouter();
  const step = useSettingsStep();
  const formatDate = useFormatDateTime();
  const [notice, setNotice] = useState<string | null>(null);
  const values = useMemo(() => ({ nickname }), [nickname]);
  const schema = useMemo(() => nicknameFormSchema(nickname), [nickname]);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    setValue,
    getValues,
    formState: { errors, isDirty },
  } = useForm<NicknameFormValues>({
    resolver: zodResolver(schema),
    defaultValues: values,
    values,
    resetOptions: { keepDirtyValues: true },
  });
  useKeepForStep(() => {
    const text = nicknameDraftToKeep(getValues('nickname'), nickname);
    if (text !== null) keepSessionProfileDraft(accountId, { kind: 'nickname', text });
  });
  useProfileDraftTakenBack('nickname', accountId, step.stepLeft, (kept) => {
    const text = nicknameToRestore(kept, nickname, getValues('nickname'));
    if (text === null) return false;
    setValue('nickname', text, { shouldDirty: true });
    return true;
  });

  const onSubmit = handleSubmit(async (form) => {
    setNotice(null);
    // A change is always a new value (no nickname is cleared).
    if (profileItemSaveGoesToStep('replace', step.stepLeft)) {
      step.toStep();
      return;
    }
    try {
      // The account this screen shows (#58: PATCH /me names it, as every owner write does).
      await update.mutateAsync({ nickname: form.nickname, expectedAccountId: accountId });
      reset({ nickname: form.nickname });
      // Saved: nothing an earlier trip to the step kept of the box is wanted back — by this account
      // (bio-section.tsx, ADR-0078 7-30).
      clearSessionProfileDraft('nickname', accountId);
      toaster.create({ type: 'success', title: copy.nicknameSaved });
      // Back to the profile (or to a post's byline) shows the new nickname (bio-section.tsx).
      router.refresh();
    } catch (error) {
      const failure = settingsNicknameFailure(error, formatDate);
      if (failure.kind === 'field') {
        // A writing restriction's refusal (#185) is told by its type: the way to 조치·신고 내역
        // goes under it, and goes with it when the field's error clears.
        setError(
          'nickname',
          { type: isRestricted(error) ? RESTRICTED_ERROR : 'server', message: failure.message },
          { shouldFocus: true },
        );
        return;
      }
      // `refresh`: the hook has asked `['me']` again, and the gate or the step follows it.
      if (failure.kind === 'refresh' && step.afterRefusal(error)) return;
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
          <Field.ErrorText data-testid="nickname-error">
            <RefusalText
              message={errors.nickname?.message ?? ''}
              restricted={errors.nickname?.type === RESTRICTED_ERROR}
            />
          </Field.ErrorText>
        </Field.Root>
      </Stack>
    </form>
  );
}
