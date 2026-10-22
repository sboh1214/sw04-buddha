'use client';

import { Alert, Box, Button, Field, HStack, Stack, Text, Textarea } from '@chakra-ui/react';
import { BIO_MAX_LENGTH } from '@buddha/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useMe, useUpdateBio } from '@/hooks/use-me';
import { useProfileDraftTakenBack } from '@/hooks/use-profile-draft';
import { useKeepForStep, useSettingsStep } from '@/hooks/use-settings-step';
import {
  bioDraft,
  bioEdit,
  bioFormSchema,
  bioLengthText,
  bioToSend,
  profileItemFailure,
  profileItemSaveGoesToStep,
  type BioFormValues,
} from '@/lib/profile';
import {
  bioDraftToKeep,
  bioToRestore,
  clearSessionProfileDraft,
  keepSessionProfileDraft,
} from '@/lib/profile-drafts';
import { ProfileUnavailable } from './profile-unavailable';
import { SettingsSection } from './section';

/**
 * 소개 (#41, ADR-0078): the public profile's 소개, edited here (ADR-0069 decision 4 #41: «MY 설정»).
 * Plain text of at most 160 characters with its line breaks, never a link (#37-3); saving an empty
 * box clears it — a deletion, which stays open during a writing or an account restriction while a
 * new text does not (#37-9, decision 7: the server's check, #185/#139 bring the restriction), and
 * which an account facing a re-consent alone makes here too, with a session alone (owner decision
 * 2026-10-21 answer 2): the page is the gate's exception for it, and its new text goes to the step
 * first, coming back here (`useSettingsStep`, ADR-0078 7-24) — the text typed kept in the tab for
 * the hour and put back in the box on return (owner decision 2026-10-22 answer 3, 7-25).
 */
export function BioSection() {
  const { data: me, isPending } = useMe();
  return (
    <SettingsSection title={copy.settingsBio} hint={copy.settingsBioHint} testId="settings-bio">
      {isPending || !me ? (
        <ProfileUnavailable height="24" />
      ) : (
        // Keyed by account: a tab that switched accounts starts from the new one's 소개.
        <BioFields key={me.id} bio={me.profile.bio} accountId={me.id} />
      )}
    </SettingsSection>
  );
}

/**
 * Seeded from the profile and kept in sync with later refetches without discarding a text in
 * progress — the nickname card's arrangement (`values` + `keepDirtyValues`). The count under the
 * box is the server's (`bioDraft`: normalised, code points), so the limit shows before saving,
 * and 저장 waits while the box holds more than the limit or nothing new. The body names the account
 * the card shows (`expectedAccountId`). With a step left — a re-consent, the only one the gate
 * keeps on this page — a new text is not sent: 저장 goes to the step (`profileItemSaveGoesToStep`),
 * and a new text the server refused for the onboarding goes there too (`afterRefusal`). As the page
 * goes to the step — this card's save or another's — the box's text, when saving it would change
 * the 소개, is kept in the tab (`useKeepForStep`, lib/profile-drafts.ts); drawn again for the account
 * with no step left, the box takes it back unsaved (`useProfileDraftTakenBack`) — unless what it
 * holds by then is a text of the member's own (the step done in another tab, learned while typing
 * here: `bioToRestore`) — and a save that lands drops what was kept (owner decision 2026-10-22
 * answer 3).
 */
function BioFields({ bio, accountId }: { bio: string | null; accountId: string }) {
  const update = useUpdateBio();
  const router = useRouter();
  const step = useSettingsStep();
  const id = useId();
  const [notice, setNotice] = useState<string | null>(null);
  const values = useMemo(() => ({ bio: bio ?? '' }), [bio]);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    setValue,
    getValues,
    control,
    formState: { errors, isDirty },
  } = useForm<BioFormValues>({
    resolver: zodResolver(bioFormSchema),
    defaultValues: values,
    values,
    resetOptions: { keepDirtyValues: true },
  });
  const draft = bioDraft(useWatch({ control, name: 'bio' }));
  useKeepForStep(() => {
    const text = bioDraftToKeep(getValues('bio'), bio);
    if (text !== null) keepSessionProfileDraft(accountId, { kind: 'bio', text });
  });
  useProfileDraftTakenBack('bio', accountId, step.stepLeft, (kept) => {
    const text = bioToRestore(kept, bio, getValues('bio'));
    if (text === null) return false;
    setValue('bio', text, { shouldDirty: true });
    return true;
  });

  const onSubmit = handleSubmit(async (form) => {
    setNotice(null);
    const next = bioToSend(form.bio);
    if (profileItemSaveGoesToStep(bioEdit(next), step.stepLeft)) {
      step.toStep();
      return;
    }
    try {
      const me = await update.mutateAsync({ bio: next, expectedAccountId: accountId });
      // What the server kept (trimmed, line breaks as `\n`), not what was typed. Explicitly not
      // keepDirtyValues, as the time-zone card does: the form's resetOptions would keep the
      // submitted text as dirty instead of taking the saved one.
      reset({ bio: me.profile.bio ?? '' }, { keepDirtyValues: false });
      // Saved: nothing an earlier trip to the step kept of the box is wanted back.
      clearSessionProfileDraft('bio');
      toaster.create({ type: 'success', title: next === null ? copy.bioCleared : copy.bioSaved });
      // The profile is the server's page alone (ADR-0078 7-12), but the router keeps the pages it
      // drew for Back and Forward whatever their age: without this, Back to the profile this
      // screen was opened from would show the 소개 from before the save.
      router.refresh();
    } catch (error) {
      const failure = profileItemFailure(error);
      if (failure.kind === 'field') {
        setError('bio', { message: failure.message }, { shouldFocus: true });
        return;
      }
      // `refresh`: the hook has asked `['me']` again, and the gate or the step follows it.
      if (step.afterRefusal(error)) return;
      setNotice(failure.message);
    }
  });

  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate>
      <Stack gap="3">
        {notice && (
          <Alert.Root status="error" role="alert" data-testid="bio-notice">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{notice}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}
        <Field.Root invalid={!!errors.bio || draft.tooLong}>
          {/* The card's heading already says 소개; the label names the box for a screen reader. */}
          <Field.Label srOnly>{copy.settingsBio}</Field.Label>
          <Textarea
            rows={4}
            placeholder={copy.bioPlaceholder}
            // UTF-16 units: twice the code points, so a box of emoji is never cut short; the count
            // below is the rule, and it keeps counting past it ('172 / 160자'), as a comment's.
            maxLength={BIO_MAX_LENGTH * 2}
            aria-describedby={`${id}-length ${id}-limit`}
            data-testid="bio-input"
            {...register('bio')}
          />
          <Field.ErrorText data-testid="bio-error">{errors.bio?.message}</Field.ErrorText>
        </Field.Root>
        <HStack justify="space-between" gap="3" flexWrap="wrap">
          <Text
            as="span"
            id={`${id}-length`}
            textStyle="bodyXs"
            color={draft.tooLong ? 'fg.error' : 'fg.muted'}
            data-testid="bio-length"
          >
            {bioLengthText(draft.length)}
          </Text>
          <Button
            type="submit"
            loading={update.isPending}
            disabled={!isDirty || draft.tooLong}
            data-testid="bio-save"
          >
            {copy.save}
          </Button>
        </HStack>
        {/* Mounted before anything is in it, so the message is announced when it appears. */}
        <Box id={`${id}-limit`} role="status" aria-live="polite" data-testid="bio-limit">
          {draft.tooLong && !errors.bio && (
            <Text textStyle="bodyXs" color="fg.error">
              {copy.errBioTooLong}
            </Text>
          )}
        </Box>
      </Stack>
    </form>
  );
}
