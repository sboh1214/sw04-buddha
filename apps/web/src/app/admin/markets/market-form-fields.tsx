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
import { type Category, type MarketSummary } from '@/lib/api';
import { groupCategories } from '@/lib/category-tree';
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
  /**
   * The market being edited, passed straight to the 미리보기 so an already-traded market previews
   * at its LIVE price rather than the one it opened at. Absent on 시장 만들기.
   */
  base?: MarketSummary;
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
  base,
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
  // The flat `GET /categories` list as the two-level tree the select draws (ADR-0041). Grouped
  // here on every render rather than memoised: it is a few dozen rows, and `watch()` above
  // already re-renders this component per keystroke for the preview's sake.
  const tree = groupCategories(categories);

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
            {/* A native `<select>` with `<optgroup>`s rather than a custom menu: the tree is
                two levels deep by convention (ADR-0041), which is exactly the one level of
                grouping the element has built in, and the screen reader, the keyboard and the
                mobile picker all already know how to read a group label.

                A market is filed under a LEAF: a parent that has active leaves is the group's
                label and not an option of its own, the way Kalshi files a series under a
                sub-category and never under "Economics" itself. A parent with no active leaves
                is offered as a plain option instead — the API accepts any active category at
                either level, and there is no leaf to send the market to.

                The one hidden option per group is for a market that already sits on such a
                parent — filed before its leaves existed; the seed does not move existing rows
                (ADR-0041). `marketToFormValues` prefills that parent's id, and a `<select>`
                whose value matches no option displays as blank while the form quietly holds
                the id, so the admin would read 카테고리 선택 for a market that is in 경제.
                `hidden` keeps it out of the list, `disabled` keeps a browser that ignores
                `hidden` (older iOS) from letting it be picked, and the closed control still
                shows the option a programmatic value selects — the placeholder trick, applied
                to a real row. It is always in the DOM, never gated on the current value: the
                form writes the select through its ref on mount and on reset, and an option
                that appears a render later would be too late for either. */}
            <NativeSelect.Field
              placeholder={copy.adminMarketCategoryPlaceholder}
              data-testid="market-category"
              {...register('categoryId')}
            >
              {tree.map(({ category: parent, children }) =>
                children.length === 0 ? (
                  <option key={parent.id} value={String(parent.id)}>
                    {parent.nameKo}
                  </option>
                ) : (
                  <optgroup key={parent.id} label={parent.nameKo}>
                    <option value={String(parent.id)} disabled hidden>
                      {parent.nameKo}
                    </option>
                    {children.map((leaf) => (
                      <option key={leaf.id} value={String(leaf.id)}>
                        {leaf.nameKo}
                      </option>
                    ))}
                  </optgroup>
                ),
              )}
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

      <MarketPreview values={values} categories={categories} base={base} />
    </Stack>
  );
}
