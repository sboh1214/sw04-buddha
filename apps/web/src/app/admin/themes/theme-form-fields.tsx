'use client';

import { Field, HStack, Input, Stack, Text, Textarea } from '@chakra-ui/react';
import {
  MARKET_SLUG_MAX,
  THEME_DATE_MAX,
  THEME_DATE_MIN,
  THEME_INTRO_MAX,
  THEME_NAME_MAX,
} from '@buddha/shared';
import { useId } from 'react';
import { type UseFormReturn } from 'react-hook-form';
import { copy } from '@/copy';
import { type ThemeFormValues } from '@/lib/admin-themes';

/**
 * The inputs of the theme form (#81, ADR-0088), shared by 테마 만들기 and the detail's 수정 card so
 * the two cannot drift: the address, the name, the introduction and the period in Korean dates
 * (owner decision 2026-10-19). The owner of the `useForm` decides what a submit means.
 */
export function ThemeFormFields({
  form,
  slugFixed = false,
}: {
  form: UseFormReturn<ThemeFormValues>;
  /** The theme has been published: the address is shown, read-only (owner decision 2026-10-19). */
  slugFixed?: boolean;
}) {
  const {
    register,
    formState: { errors },
  } = form;
  // The period's one hint is under both date fields, so it is not either field's helper text:
  // each input names it by id, and a screen reader reads it with the label. Ark's field sets
  // `aria-describedby` only from a helper text of its own, which these have none of, and links
  // an error through `aria-errormessage`, so naming the hint here takes nothing away.
  const periodHintId = useId();
  return (
    <Stack gap="3">
      <Field.Root invalid={!!errors.slug} required readOnly={slugFixed}>
        <Field.Label>{copy.adminThemeSlug}</Field.Label>
        <Input
          autoComplete="off"
          maxLength={MARKET_SLUG_MAX}
          data-testid="theme-slug"
          {...register('slug')}
        />
        <Field.HelperText>
          {slugFixed ? copy.adminThemeSlugFixed : copy.adminThemeSlugHint}
        </Field.HelperText>
        <Field.ErrorText>{errors.slug?.message}</Field.ErrorText>
      </Field.Root>

      <Field.Root invalid={!!errors.name} required>
        <Field.Label>{copy.adminThemeName}</Field.Label>
        <Input
          autoComplete="off"
          maxLength={THEME_NAME_MAX}
          data-testid="theme-name-input"
          {...register('name')}
        />
        <Field.ErrorText>{errors.name?.message}</Field.ErrorText>
      </Field.Root>

      <Field.Root invalid={!!errors.intro} required>
        <Field.Label>{copy.adminThemeIntro}</Field.Label>
        <Textarea
          rows={4}
          maxLength={THEME_INTRO_MAX}
          data-testid="theme-intro-input"
          {...register('intro')}
        />
        <Field.ErrorText>{errors.intro?.message}</Field.ErrorText>
      </Field.Root>

      <Stack gap="1">
        <HStack gap="2" align="start" flexWrap="wrap">
          <Field.Root invalid={!!errors.startDate} required maxW="56">
            <Field.Label>{copy.adminThemeStartDate}</Field.Label>
            {/* `min`/`max`: the dates the API stores, so a browser offers no year it refuses. */}
            <Input
              type="date"
              min={THEME_DATE_MIN}
              max={THEME_DATE_MAX}
              aria-describedby={periodHintId}
              data-testid="theme-start-date"
              {...register('startDate')}
            />
            <Field.ErrorText>{errors.startDate?.message}</Field.ErrorText>
          </Field.Root>
          <Field.Root invalid={!!errors.endDate} required maxW="56">
            <Field.Label>{copy.adminThemeEndDate}</Field.Label>
            <Input
              type="date"
              min={THEME_DATE_MIN}
              max={THEME_DATE_MAX}
              aria-describedby={periodHintId}
              data-testid="theme-end-date"
              {...register('endDate')}
            />
            <Field.ErrorText>{errors.endDate?.message}</Field.ErrorText>
          </Field.Root>
        </HStack>
        <Text id={periodHintId} fontSize="xs" color="fg.muted" data-testid="theme-period-hint">
          {copy.adminThemePeriodHint}
        </Text>
      </Stack>
    </Stack>
  );
}
