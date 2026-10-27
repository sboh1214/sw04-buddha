'use client';

import { Button, ClientOnly, Field, HStack, NativeSelect, Skeleton, Stack } from '@chakra-ui/react';
import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useMe, useUpdateTimeZone } from '@/hooks/use-me';
import {
  browserTimeZone,
  supportedTimeZones,
  timeZoneFromSelect,
  timeZoneOptions,
  timeZoneSaveFailure,
  timeZoneSelectValue,
} from '@/lib/time-zone';
import { ProfileUnavailable } from './profile-unavailable';
import { SettingsSection } from './section';

/**
 * 시간대 (ADR-0061 #60-8, ADR-0063): the zone every member-screen time is read in. The first
 * choice follows the browser (nothing stored) and names the zone it follows today; then every
 * IANA zone the browser knows. Each zone reads as its IANA name and the Korean name the browser
 * gives it (`timeZoneLabel`, owner decision 2026-10-16); the values sent are the IANA names.
 * Saving writes `PUT /me/time-zone` for the account the card shows
 * (`expectedAccountId`), and the profile it answers goes into `['me']`, so the times elsewhere
 * switch as soon as it lands.
 *
 * The fields are `ClientOnly`: the browser's zone and its list exist only in the browser, and the
 * server's render of this page must not name a zone (ADR-0063's rule for every first paint).
 */
export function TimeZoneSection() {
  const { data: me, isPending } = useMe();
  return (
    <SettingsSection
      title={copy.settingsTimeZone}
      hint={copy.settingsTimeZoneHint}
      testId="settings-time-zone"
    >
      {isPending || !me ? (
        <ProfileUnavailable />
      ) : (
        <ClientOnly fallback={<Skeleton height="10" />}>
          {/* Keyed by account: a tab that switched accounts starts from the new one's choice. */}
          <TimeZoneFields key={me.id} picked={me.profile.timeZone} />
        </ClientOnly>
      )}
    </SettingsSection>
  );
}

interface FormValues {
  timeZone: string;
}

/**
 * Seeded from the profile and kept in sync with later refetches without discarding a choice in
 * progress — the nickname card's arrangement (`values` + `keepDirtyValues`).
 */
function TimeZoneFields({ picked }: { picked: string | null }) {
  const update = useUpdateTimeZone();
  const browser = browserTimeZone();
  const options = useMemo(
    () => timeZoneOptions(supportedTimeZones(), picked, browser),
    [picked, browser],
  );
  const values = useMemo(() => ({ timeZone: timeZoneSelectValue(picked) }), [picked]);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isDirty },
  } = useForm<FormValues>({
    defaultValues: values,
    values,
    resetOptions: { keepDirtyValues: true },
  });

  const onSubmit = handleSubmit(async (form) => {
    // The account the card shows rides along (`expectedAccountId`, A-PG-24). Unreachable while
    // the button honours `ready`.
    if (update.accountId === undefined) return;
    try {
      const me = await update.mutateAsync({
        timeZone: timeZoneFromSelect(form.timeZone),
        expectedAccountId: update.accountId,
      });
      // Explicitly not keepDirtyValues, as the real-name card does: the form's resetOptions would
      // otherwise keep the submitted value as dirty instead of taking the saved one.
      reset({ timeZone: timeZoneSelectValue(me.profile.timeZone) }, { keepDirtyValues: false });
      toaster.create({ type: 'success', title: copy.timeZoneSaved });
    } catch (error) {
      const failure = timeZoneSaveFailure(error);
      if (failure.kind === 'field') {
        setError('timeZone', { message: failure.message });
        return;
      }
      toaster.create({ type: 'error', title: failure.title, description: failure.description });
    }
  });

  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate>
      <Stack gap="4">
        <Field.Root invalid={!!errors.timeZone}>
          {/* The card's heading already says 시간대; the label names the control for a screen
              reader without printing the word twice. */}
          <Field.Label srOnly>{copy.settingsTimeZone}</Field.Label>
          <HStack w="full" align="start">
            {/* `minW="0"`: a select is as wide as its longest option by default, and
                `America/Argentina/ComodRivadavia` beside the button would push a 375px page
                sideways. */}
            <NativeSelect.Root size="md" flex="1" minW="0">
              <NativeSelect.Field data-testid="time-zone-select" {...register('timeZone')}>
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
            <Button
              type="submit"
              loading={update.isPending}
              disabled={!isDirty || !update.ready}
              data-testid="time-zone-save"
            >
              {copy.save}
            </Button>
          </HStack>
          <Field.ErrorText>{errors.timeZone?.message}</Field.ErrorText>
        </Field.Root>
      </Stack>
    </form>
  );
}
