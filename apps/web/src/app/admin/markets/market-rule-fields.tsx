'use client';

import { Field, Fieldset, HStack, Input, Text, Textarea } from '@chakra-ui/react';
import { MARKET_LONG_DELAY_DAYS_MAX, MARKET_LONG_DELAY_DAYS_MIN } from '@buddha/shared';
import { type UseFormReturn } from 'react-hook-form';
import { copy } from '@/copy';
import { voidPayoutText } from '@/lib/market-detail';
import { type MarketFormValues } from '@/lib/market-form';
import { MarketSourcesField } from './market-sources-field';

interface MarketRuleFieldsProps {
  form: UseFormReturn<MarketFormValues>;
  /** Every input; true unless the market is draft or open (design 3.4). */
  disabled: boolean;
}

/** The same for every market: computed once, not per keystroke. */
const VOID_PAYOUT = voidPayoutText();

/**
 * 규칙 항목 (#23, ADR-0097; ADR-0093 decision 2 #172 items 7–10): the market form's group after the
 * question, one input per rule item in OPEN_ITEMS order — 배경 (the market's `description`), the YES
 * and NO conditions, the event deadline (KST, whole minutes, as 마감), the primary source's name
 * and address, the fallbacks (`MarketSourcesField`), the switch condition, the long-delay deadline
 * in days and the delay handling. A draft saves with any of them blank; the draft's notice names
 * what 열기 still needs, and on an open market an item it had may not be emptied
 * (`marketFormSchema`'s `openMarket`, the API's RULES_REQUIRED).
 *
 * The switch condition shows only while there is a fallback to switch to (#172 item 9) — and while
 * it still holds text another writer left with no fallback, so the refusal of that has an input to
 * be fixed in. Under 지연·취소·무효 처리 stands the VOID payout, read-only: one rule for every market,
 * never written per market (#173 item 9, ADR-0093 result 1).
 */
export function MarketRuleFields({ form, disabled }: MarketRuleFieldsProps) {
  const {
    register,
    watch,
    formState: { errors },
  } = form;
  const showCondition =
    watch('fallbackSources').length > 0 || watch('fallbackCondition').trim() !== '';

  return (
    <Fieldset.Root disabled={disabled} data-testid="market-rule-items">
      <Fieldset.Legend fontWeight="semibold">{copy.adminMarketRuleItems}</Fieldset.Legend>
      <Fieldset.HelperText>{copy.adminMarketRuleItemsHint}</Fieldset.HelperText>
      <Fieldset.Content gap="3" mt="2">
        <Field.Root invalid={!!errors.description}>
          <Field.Label>{copy.adminMarketDescription}</Field.Label>
          <Textarea rows={3} data-testid="market-description" {...register('description')} />
          <Field.ErrorText>{errors.description?.message}</Field.ErrorText>
        </Field.Root>

        <Field.Root invalid={!!errors.yesCondition}>
          <Field.Label>{copy.adminMarketYesCondition}</Field.Label>
          <Textarea rows={3} data-testid="market-yes-condition" {...register('yesCondition')} />
          <Field.ErrorText>{errors.yesCondition?.message}</Field.ErrorText>
        </Field.Root>

        <Field.Root invalid={!!errors.noCondition}>
          <Field.Label>{copy.adminMarketNoCondition}</Field.Label>
          <Textarea rows={3} data-testid="market-no-condition" {...register('noCondition')} />
          <Field.HelperText>{copy.adminMarketNoConditionHint}</Field.HelperText>
          <Field.ErrorText>{errors.noCondition?.message}</Field.ErrorText>
        </Field.Root>

        <Field.Root invalid={!!errors.eventDeadline} maxW="56">
          <Field.Label>{copy.adminMarketEventDeadline}</Field.Label>
          <Input
            type="datetime-local"
            data-testid="market-event-deadline"
            {...register('eventDeadline')}
          />
          <Field.ErrorText>{errors.eventDeadline?.message}</Field.ErrorText>
        </Field.Root>

        <Fieldset.Root>
          <Fieldset.Legend fontSize="sm" fontWeight="medium">
            {copy.adminMarketPrimarySource}
          </Fieldset.Legend>
          <HStack gap="2" align="start" flexWrap="wrap" mt="1.5">
            <Field.Root invalid={!!errors.primarySourceName} flex="1" minW="40">
              <Field.Label>{copy.adminMarketSourceName}</Field.Label>
              <Input
                autoComplete="off"
                data-testid="market-primary-source-name"
                {...register('primarySourceName')}
              />
              <Field.ErrorText>{errors.primarySourceName?.message}</Field.ErrorText>
            </Field.Root>
            <Field.Root invalid={!!errors.primarySourceUrl} flex="2" minW="56">
              <Field.Label>{copy.adminMarketSourceUrl}</Field.Label>
              <Input
                type="url"
                inputMode="url"
                autoComplete="off"
                placeholder={copy.adminMarketSourceUrlPlaceholder}
                data-testid="market-primary-source-url"
                {...register('primarySourceUrl')}
              />
              <Field.ErrorText>{errors.primarySourceUrl?.message}</Field.ErrorText>
            </Field.Root>
          </HStack>
        </Fieldset.Root>

        <MarketSourcesField form={form} disabled={disabled} />

        {showCondition && (
          <Field.Root invalid={!!errors.fallbackCondition}>
            <Field.Label>{copy.adminMarketFallbackCondition}</Field.Label>
            <Textarea
              rows={2}
              data-testid="market-fallback-condition"
              {...register('fallbackCondition')}
            />
            <Field.ErrorText>{errors.fallbackCondition?.message}</Field.ErrorText>
          </Field.Root>
        )}

        <Field.Root invalid={!!errors.longDelayDays}>
          <Field.Label>{copy.adminMarketLongDelayDays}</Field.Label>
          <HStack gap="2">
            <Input
              type="number"
              inputMode="numeric"
              min={MARKET_LONG_DELAY_DAYS_MIN}
              max={MARKET_LONG_DELAY_DAYS_MAX}
              step={1}
              w="24"
              data-testid="market-long-delay-days"
              {...register('longDelayDays')}
            />
            <Text fontSize="sm" color="fg.muted">
              {copy.adminMarketLongDelayDaysSuffix}
            </Text>
          </HStack>
          <Field.ErrorText>{errors.longDelayDays?.message}</Field.ErrorText>
        </Field.Root>

        <Field.Root invalid={!!errors.delayHandling}>
          <Field.Label>{copy.adminMarketDelayHandling}</Field.Label>
          <Textarea rows={4} data-testid="market-delay-handling" {...register('delayHandling')} />
          <Field.HelperText>{copy.adminMarketDelayHandlingHint}</Field.HelperText>
          <Field.ErrorText>{errors.delayHandling?.message}</Field.ErrorText>
          <Text fontSize="sm" color="fg.muted" data-testid="market-void-payout">
            <Text as="span" fontWeight="medium">
              {copy.rulesVoidPayout}
            </Text>{' '}
            {VOID_PAYOUT}
          </Text>
        </Field.Root>
      </Fieldset.Content>
    </Fieldset.Root>
  );
}
