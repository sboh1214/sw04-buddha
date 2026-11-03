'use client';

import { Button, Field, HStack, Input, Stack, Tag } from '@chakra-ui/react';
import { type KeyboardEvent } from 'react';
import { type UseFormReturn, useController } from 'react-hook-form';
import { copy } from '@/copy';
import { type MarketFormValues, addTags } from '@/lib/market-form';

interface MarketTagsFieldProps {
  form: UseFormReturn<MarketFormValues>;
  /** The whole field; true unless the market is draft or open (design 3.4). */
  disabled: boolean;
}

/**
 * 태그 (#17, ADR-0093 decision 2 #172 item 2), the market form's field after the category: a box
 * where the operator types a name and adds it with Enter or 넣기 — a pasted '서울, 기상청' goes in as
 * two — and the tags as chips in entry order, each with its 빼기. `addTags` holds every rule (1..5,
 * the shared name rules, one name per tag whatever its case), so a refused name stays in the box
 * with the reason under it, and the form's schema checks the same again on save.
 *
 * A plain input and Chakra's `Tag` rather than its TagsInput: Ark's tags input validates with a
 * yes or no, so it could not say which rule a name broke, and it keeps the names as typed rather
 * than normalised; the rules then live in one pure function the node tests reach.
 *
 * The box adds on Enter and 넣기 only, never on leaving it: a chip appearing as the box loses focus
 * would move the buttons under a pointer that is already pressing one. A name left in the box is
 * kept (`tagInput`) and the save refuses it (`errMarketTagPending`) rather than dropping it. Enter
 * while an IME composes a syllable is the composition's own, not an add.
 */
export function MarketTagsField({ form, disabled }: MarketTagsFieldProps) {
  const {
    control,
    register,
    getValues,
    setValue,
    setError,
    clearErrors,
    formState: { errors },
  } = form;
  const { field: tags } = useController({ control, name: 'tags' });
  // A new list: what was said about the last one (an API refusal included) no longer holds. After
  // a submit the change validates the list again, which says it anew if it still holds.
  const changeTags = (next: string[]) => {
    clearErrors('tags');
    tags.onChange(next);
  };
  const input = register('tagInput', {
    // A refusal said under the box is about what it held; typing again starts over.
    onChange: () => clearErrors('tagInput'),
  });

  const add = () => {
    const typed = getValues('tagInput');
    if (typed.trim() === '') return;
    const result = addTags(tags.value, typed);
    if (result.tags.length !== tags.value.length) changeTags(result.tags);
    setValue('tagInput', result.rest, { shouldDirty: true });
    if (result.error === undefined) clearErrors('tagInput');
    else setError('tagInput', { type: 'manual', message: result.error });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    // Enter in a form's text box submits the form: here it adds the name instead.
    event.preventDefault();
    add();
  };

  const error = errors.tagInput?.message ?? errors.tags?.message;
  return (
    <Field.Root invalid={error !== undefined} disabled={disabled}>
      <Field.Label>{copy.adminMarketTags}</Field.Label>
      <Stack gap="2" w="full">
        <HStack gap="2" w="full" maxW="md">
          <Input
            autoComplete="off"
            enterKeyHint="done"
            placeholder={copy.adminMarketTagsPlaceholder}
            flex="1"
            minW="0"
            data-testid="market-tags-input"
            {...input}
            onKeyDown={onKeyDown}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            flexShrink="0"
            disabled={disabled}
            onClick={add}
            data-testid="market-tags-add"
          >
            {copy.adminMarketTagAdd}
          </Button>
        </HStack>
        {tags.value.length > 0 && (
          <HStack
            as="ul"
            listStyleType="none"
            gap="2"
            flexWrap="wrap"
            data-testid="market-tags-list"
          >
            {tags.value.map((name, index) => (
              <Tag.Root
                as="li"
                key={name}
                size="lg"
                variant="subtle"
                maxW="full"
                data-testid={`market-tags-item-${String(index)}`}
              >
                <Tag.Label>{name}</Tag.Label>
                <Tag.EndElement>
                  <Tag.CloseTrigger
                    disabled={disabled}
                    aria-label={`${name} ${copy.adminMarketTagRemove}`}
                    onClick={() => {
                      changeTags(tags.value.filter((_, at) => at !== index));
                    }}
                    data-testid={`market-tags-remove-${String(index)}`}
                  />
                </Tag.EndElement>
              </Tag.Root>
            ))}
          </HStack>
        )}
      </Stack>
      <Field.HelperText>{copy.adminMarketTagsHint}</Field.HelperText>
      <Field.ErrorText data-testid="market-tags-error">{error}</Field.ErrorText>
    </Field.Root>
  );
}
