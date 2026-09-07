'use client';

import {
  Field,
  HStack,
  Input,
  NativeSelect,
  Slider,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { Controller, type UseFormReturn } from 'react-hook-form';
import { copy } from '@/copy';
import { type Category } from '@/lib/api';
import { type MarketFormValues, maxLossHelp } from '@/lib/market-form';
import { MarketPreview } from './market-preview';

interface MarketFormFieldsProps {
  form: UseFormReturn<MarketFormValues>;
  categories: Category[];
  /** Every input; false unless the market is draft or open (design 3.4). */
  disabled?: boolean;
  /** Probability and liquidity, which only a draft may change. */
  lmsrDisabled?: boolean;
  /** The slug is chosen at creation only. */
  showSlug?: boolean;
}

/**
 * The inputs of the market form (PLAN 12), shared by 시장 만들기 and the detail's 수정 card so
 * the two cannot drift. The owner holds the `useForm` and decides what a submit means.
 *
 * The 미리보기 beneath them (Q-M3-6) is fed from the same `watch()`, so both screens got it at
 * once and neither can show a stale card.
 */
export function MarketFormFields({
  form,
  categories,
  disabled = false,
  lmsrDisabled = false,
  showSlug = false,
}: MarketFormFieldsProps) {
  const {
    register,
    control,
    watch,
    formState: { errors },
  } = form;
  // The whole values object rather than the two fields the max-loss line needs: `watch()`
  // re-renders this component on every keystroke, which is what makes the preview below track
  // typing. Nothing else changes — the help line still reads the same two fields.
  const values = watch();
  const maxLoss = maxLossHelp(values.probabilityPct, values.liquidityB);

  return (
    <Stack gap="3">
      <Field.Root invalid={!!errors.title} required disabled={disabled}>
        <Field.Label>{copy.adminMarketTitle}</Field.Label>
        <Input autoComplete="off" data-testid="market-title" {...register('title')} />
        <Field.ErrorText>{errors.title?.message}</Field.ErrorText>
      </Field.Root>

      <Field.Root invalid={!!errors.description} disabled={disabled}>
        <Field.Label>{copy.adminMarketDescription}</Field.Label>
        <Textarea rows={3} data-testid="market-description" {...register('description')} />
        <Field.ErrorText>{errors.description?.message}</Field.ErrorText>
      </Field.Root>

      <Field.Root invalid={!!errors.rules} disabled={disabled}>
        <Field.Label>{copy.adminMarketRules}</Field.Label>
        <Textarea rows={4} data-testid="market-rules" {...register('rules')} />
        <Field.HelperText>{copy.adminMarketRulesHint}</Field.HelperText>
        <Field.ErrorText>{errors.rules?.message}</Field.ErrorText>
      </Field.Root>

      <HStack gap="2" align="start" flexWrap="wrap">
        <Field.Root invalid={!!errors.resolutionSource} disabled={disabled} flex="1" minW="56">
          <Field.Label>{copy.adminMarketSource}</Field.Label>
          <Input autoComplete="off" data-testid="market-source" {...register('resolutionSource')} />
          <Field.ErrorText>{errors.resolutionSource?.message}</Field.ErrorText>
        </Field.Root>
        <Field.Root invalid={!!errors.categoryId} required disabled={disabled} maxW="56">
          <Field.Label>{copy.adminMarketCategory}</Field.Label>
          <NativeSelect.Root>
            <NativeSelect.Field
              placeholder={copy.adminMarketCategoryPlaceholder}
              data-testid="market-category"
              {...register('categoryId')}
            >
              {categories.map((category) => (
                <option key={category.id} value={String(category.id)}>
                  {category.nameKo}
                </option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
          <Field.ErrorText>{errors.categoryId?.message}</Field.ErrorText>
        </Field.Root>
      </HStack>

      <HStack gap="2" align="start" flexWrap="wrap">
        <Field.Root invalid={!!errors.imageUrl} disabled={disabled} flex="1" minW="56">
          <Field.Label>{copy.adminMarketImageUrl}</Field.Label>
          <Input
            type="url"
            autoComplete="off"
            placeholder={copy.adminMarketImageUrlPlaceholder}
            data-testid="market-image-url"
            {...register('imageUrl')}
          />
          <Field.ErrorText>{errors.imageUrl?.message}</Field.ErrorText>
        </Field.Root>
        <Field.Root invalid={!!errors.closeAt} required disabled={disabled} maxW="56">
          <Field.Label>{copy.adminMarketCloseAt}</Field.Label>
          <Input type="datetime-local" data-testid="market-close-at" {...register('closeAt')} />
          <Field.ErrorText>{errors.closeAt?.message}</Field.ErrorText>
        </Field.Root>
      </HStack>

      <HStack gap="4" align="start" flexWrap="wrap">
        <Field.Root
          invalid={!!errors.probabilityPct}
          disabled={disabled || lmsrDisabled}
          flex="1"
          minW="56"
        >
          <Controller
            control={control}
            name="probabilityPct"
            render={({ field }) => (
              <Slider.Root
                min={1}
                max={99}
                step={1}
                value={[field.value]}
                onValueChange={(details) => field.onChange(details.value[0] ?? field.value)}
                onBlur={field.onBlur}
                disabled={disabled || lmsrDisabled}
                width="full"
                data-testid="market-probability"
              >
                <HStack justify="space-between">
                  <Slider.Label>{copy.adminMarketInitialProb}</Slider.Label>
                  <Text fontVariantNumeric="tabular-nums" data-testid="market-probability-value">
                    {copy.yes} {String(field.value)}%
                  </Text>
                </HStack>
                <Slider.Control>
                  <Slider.Track>
                    <Slider.Range />
                  </Slider.Track>
                  <Slider.Thumbs />
                </Slider.Control>
              </Slider.Root>
            )}
          />
          <Field.ErrorText>{errors.probabilityPct?.message}</Field.ErrorText>
        </Field.Root>
        <Field.Root
          invalid={!!errors.liquidityB}
          required
          disabled={disabled || lmsrDisabled}
          maxW="48"
        >
          <Field.Label>{copy.adminMarketLiquidity}</Field.Label>
          <Input inputMode="decimal" data-testid="market-liquidity" {...register('liquidityB')} />
          {maxLoss !== undefined && (
            <Field.HelperText data-testid="market-max-loss">{maxLoss}</Field.HelperText>
          )}
          <Field.ErrorText>{errors.liquidityB?.message}</Field.ErrorText>
        </Field.Root>
      </HStack>

      {showSlug && (
        <Field.Root invalid={!!errors.slug} disabled={disabled} maxW="md">
          <Field.Label>{copy.adminMarketSlug}</Field.Label>
          <Input autoComplete="off" data-testid="market-slug" {...register('slug')} />
          <Field.ErrorText>{errors.slug?.message}</Field.ErrorText>
        </Field.Root>
      )}

      <MarketPreview values={values} categories={categories} />
    </Stack>
  );
}
