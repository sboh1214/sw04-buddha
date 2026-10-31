'use client';

import { Button, Field, Fieldset, HStack, Input, Stack, Text } from '@chakra-ui/react';
import { MARKET_FALLBACK_SOURCES_MAX } from '@buddha/shared';
import { type UseFormReturn, useFieldArray } from 'react-hook-form';
import { copy } from '@/copy';
import { type MarketFormValues } from '@/lib/market-form';

interface MarketSourcesFieldProps {
  form: UseFormReturn<MarketFormValues>;
  /** The whole field; true unless the market is draft or open (design 3.4). */
  disabled: boolean;
}

/**
 * 대체 출처 (#23, ADR-0093 decision 2 #172 item 9): the sources the judgement turns to, in order,
 * when the primary cannot be used — none, which reads 없음, up to MARKET_FALLBACK_SOURCES_MAX. Each
 * row is a name and an http(s) address (decision 3 '#23 출처 주소'), with 위로 and 아래로 to change
 * the priority and 빼기; 대체 출처 추가 adds an empty row at the end and is off at the limit. A row
 * left with both inputs blank is refused on save (`errMarketSourceEmpty`): it says nothing.
 *
 * The switch condition goes with the list: removing the last fallback clears it (the API refuses a
 * condition with no fallback), and the rule fields show it only while there is one. A change of the
 * list clears what was said about it, as the tag field does: an index a message named may now be
 * another row.
 *
 * The empty row's refusal goes as either of its inputs is typed into (`clearRowError`), and the
 * next save checks the row again. react-hook-form's own re-check of a typed input looks at that
 * input's path alone and never reaches the row's (#23, ADR-0097).
 */
export function MarketSourcesField({ form, disabled }: MarketSourcesFieldProps) {
  const {
    control,
    register,
    setValue,
    clearErrors,
    setError,
    getFieldState,
    formState: { errors },
  } = form;
  const { fields, append, remove, move } = useFieldArray({ control, name: 'fallbackSources' });
  const listError = errors.fallbackSources?.message ?? errors.fallbackSources?.root?.message;

  // The row's own refusal alone. `clearErrors` takes its inputs' with it, and an open market's
  // blank row has those too (`errMarketRulesOpen` under each blank input, `missingItemPaths`):
  // they are put back, so the typed input's twin keeps its own and react-hook-form checks the
  // typed one again.
  const clearRowError = (index: number) => {
    const row = `fallbackSources.${index}` as const;
    if (getFieldState(row).error?.message === undefined) return;
    const kept = (['name', 'url'] as const).flatMap((part) => {
      const { error } = getFieldState(`${row}.${part}`);
      return error === undefined ? [] : [{ part, error }];
    });
    clearErrors(row);
    for (const { part, error } of kept) setError(`${row}.${part}`, error);
  };

  const removeAt = (index: number) => {
    clearErrors('fallbackSources');
    remove(index);
    if (fields.length === 1) {
      setValue('fallbackCondition', '', { shouldDirty: true });
      clearErrors('fallbackCondition');
    }
  };
  const moveTo = (from: number, to: number) => {
    clearErrors('fallbackSources');
    move(from, to);
  };

  return (
    <Fieldset.Root invalid={listError !== undefined} disabled={disabled}>
      <Fieldset.Legend fontSize="sm" fontWeight="medium">
        {copy.adminMarketFallbackSources}
      </Fieldset.Legend>
      <Fieldset.Content gap="3" mt="1.5">
        {fields.length === 0 ? (
          <Text fontSize="sm" color="fg.muted" data-testid="market-fallback-none">
            {copy.adminMarketFallbackNone}
          </Text>
        ) : (
          <Stack as="ol" gap="3" listStyleType="none" data-testid="market-fallback-list">
            {fields.map((field, index) => {
              const rowErrors = errors.fallbackSources?.[index];
              // The row's name for a screen reader, '대체 출처 2': its inputs are 이름 and 주소.
              const rowName = `${copy.openItemFallbackSources} ${String(index + 1)}`;
              return (
                <Stack as="li" key={field.id} gap="1" data-testid={`market-fallback-${index}`}>
                  <HStack gap="2" align="start" flexWrap="wrap" role="group" aria-label={rowName}>
                    <Text fontSize="sm" color="fg.muted" pt="8" minW="4" aria-hidden>
                      {index + 1}.
                    </Text>
                    <Field.Root invalid={!!rowErrors?.name} flex="1" minW="40">
                      <Field.Label>{copy.adminMarketSourceName}</Field.Label>
                      <Input
                        autoComplete="off"
                        data-testid={`market-fallback-${index}-name`}
                        {...register(`fallbackSources.${index}.name`, {
                          onChange: () => clearRowError(index),
                        })}
                      />
                      <Field.ErrorText>{rowErrors?.name?.message}</Field.ErrorText>
                    </Field.Root>
                    <Field.Root invalid={!!rowErrors?.url} flex="2" minW="56">
                      <Field.Label>{copy.adminMarketSourceUrl}</Field.Label>
                      <Input
                        type="url"
                        inputMode="url"
                        autoComplete="off"
                        placeholder={copy.adminMarketSourceUrlPlaceholder}
                        data-testid={`market-fallback-${index}-url`}
                        {...register(`fallbackSources.${index}.url`, {
                          onChange: () => clearRowError(index),
                        })}
                      />
                      <Field.ErrorText>{rowErrors?.url?.message}</Field.ErrorText>
                    </Field.Root>
                    <HStack gap="1" pt="6" flexWrap="wrap">
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={disabled || index === 0}
                        onClick={() => moveTo(index, index - 1)}
                        data-testid={`market-fallback-${index}-up`}
                      >
                        ↑ {copy.adminMarketFallbackUp}
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={disabled || index === fields.length - 1}
                        onClick={() => moveTo(index, index + 1)}
                        data-testid={`market-fallback-${index}-down`}
                      >
                        ↓ {copy.adminMarketFallbackDown}
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={disabled}
                        onClick={() => removeAt(index)}
                        data-testid={`market-fallback-${index}-remove`}
                      >
                        {copy.adminMarketFallbackRemove}
                      </Button>
                    </HStack>
                  </HStack>
                  {/* The row itself: both inputs blank (`errMarketSourceEmpty`). */}
                  {rowErrors?.message !== undefined && (
                    <Text
                      fontSize="sm"
                      color="fg.error"
                      role="alert"
                      data-testid={`market-fallback-${index}-error`}
                    >
                      {rowErrors.message}
                    </Text>
                  )}
                </Stack>
              );
            })}
          </Stack>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          alignSelf="flex-start"
          disabled={disabled || fields.length >= MARKET_FALLBACK_SOURCES_MAX}
          onClick={() => {
            clearErrors('fallbackSources');
            append({ name: '', url: '' });
          }}
          data-testid="market-fallback-add"
        >
          {copy.adminMarketFallbackAdd}
        </Button>
      </Fieldset.Content>
      <Fieldset.ErrorText data-testid="market-fallback-error">{listError}</Fieldset.ErrorText>
    </Fieldset.Root>
  );
}
