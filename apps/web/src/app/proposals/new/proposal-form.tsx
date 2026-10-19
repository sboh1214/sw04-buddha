'use client';

import { Alert, Button, Field, Input, NativeSelect, Stack, Text, Textarea } from '@chakra-ui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useCategories } from '@/hooks/use-markets';
import { useCreateProposal } from '@/hooks/use-proposals';
import { CATEGORY_TRAIL_SEPARATOR } from '@/lib/category-label';
import { groupCategories } from '@/lib/category-tree';
import {
  EMPTY_PROPOSAL_FORM,
  MY_PROPOSALS_PATH,
  type ProposalFormValues,
  koreanToday,
  proposalFailure,
  proposalFormSchema,
  toCreateProposalBody,
} from '@/lib/proposals';

const schema = proposalFormSchema();

/**
 * The form (ADR-0069 decision 4 #77 양식): the question, the one date the result is known by, the
 * YES condition and the expected sources, all required; a background and a wished-for category,
 * optional. No probability anywhere (N02 §10). Above it, the notice that a 채택 opens nothing and
 * pays nothing (N05 §6) and the limits; once submitted the proposal is 접수 and the member lands on
 * 내 제안, where it is the newest. Nothing can be edited after that (the owner's decision), so the
 * form is the only place the fields are typed.
 *
 * The rules are the API's (lib/proposals.ts); a refusal lands under the field the server named, or
 * above the form — a limit with when the next one may go, the screen out of date (the hook asked
 * for the session or `['me']` again, and the onboarding gate follows the latter).
 */
export function ProposalForm() {
  const router = useRouter();
  const create = useCreateProposal();
  const categories = useCategories();
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  // A refusal said above the form is out of sight from the submit button at its foot.
  useEffect(() => {
    if (notice !== null) noticeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [notice]);
  // The earliest date offered: today in Korea when the page was drawn. Only a hint to the picker —
  // the schema asks the rule again at submit, and the server at its own clock.
  const [today] = useState(() => koreanToday(new Date()));
  const tree = useMemo(() => groupCategories(categories.data ?? []), [categories.data]);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ProposalFormValues>({
    resolver: zodResolver(schema),
    defaultValues: EMPTY_PROPOSAL_FORM,
  });

  const onSubmit = handleSubmit(async (values) => {
    setNotice(null);
    if (create.accountId === undefined) return; // the button waits for the session
    try {
      await create.mutateAsync(toCreateProposalBody(values, create.accountId));
      toaster.create({ type: 'success', title: copy.proposalSubmitted });
      router.push(MY_PROPOSALS_PATH);
    } catch (error) {
      const failure = proposalFailure(error);
      if (failure.kind === 'field') {
        setError(failure.field, { message: failure.message }, { shouldFocus: true });
        return;
      }
      setNotice(failure.message);
    }
  });

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate data-testid="proposal-form">
      <Stack gap="5">
        <Alert.Root status="info" data-testid="proposal-notice">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.proposalNotice}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
        <Text fontSize="sm" color="fg.muted">
          {copy.proposalLimitsHint}
        </Text>
        {notice && (
          <Alert.Root ref={noticeRef} status="error" role="alert" data-testid="proposal-form-error">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{notice}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}

        <Field.Root invalid={!!errors.question} required>
          <Field.Label>{copy.proposalQuestion}</Field.Label>
          <Input autoComplete="off" data-testid="proposal-question" {...register('question')} />
          <Field.HelperText>{copy.proposalQuestionHint}</Field.HelperText>
          <Field.ErrorText>{errors.question?.message}</Field.ErrorText>
        </Field.Root>

        <Field.Root invalid={!!errors.deadline} required maxW="64">
          <Field.Label>{copy.proposalDeadline}</Field.Label>
          <Input
            type="date"
            min={today}
            data-testid="proposal-deadline"
            {...register('deadline')}
          />
          <Field.HelperText>{copy.proposalDeadlineHint}</Field.HelperText>
          <Field.ErrorText>{errors.deadline?.message}</Field.ErrorText>
        </Field.Root>

        <Field.Root invalid={!!errors.yesCondition} required>
          <Field.Label>{copy.proposalYesCondition}</Field.Label>
          <Textarea rows={4} data-testid="proposal-yes-condition" {...register('yesCondition')} />
          <Field.HelperText>{copy.proposalYesConditionHint}</Field.HelperText>
          <Field.ErrorText>{errors.yesCondition?.message}</Field.ErrorText>
        </Field.Root>

        <Field.Root invalid={!!errors.expectedSources} required>
          <Field.Label>{copy.proposalExpectedSources}</Field.Label>
          <Textarea
            rows={2}
            data-testid="proposal-expected-sources"
            {...register('expectedSources')}
          />
          <Field.HelperText>{copy.proposalExpectedSourcesHint}</Field.HelperText>
          <Field.ErrorText>{errors.expectedSources?.message}</Field.ErrorText>
        </Field.Root>

        <Field.Root invalid={!!errors.background}>
          <Field.Label>
            {copy.proposalBackground} {copy.proposalOptionalTag}
          </Field.Label>
          <Textarea rows={3} data-testid="proposal-background" {...register('background')} />
          <Field.ErrorText>{errors.background?.message}</Field.ErrorText>
        </Field.Root>

        <Field.Root invalid={!!errors.categoryId} maxW="sm">
          <Field.Label>
            {copy.proposalCategory} {copy.proposalOptionalTag}
          </Field.Label>
          <NativeSelect.Root>
            {/* Either level may be wished for (the API takes any active category), so a parent is
                an option of its own and each sub-category reads with its parent's name — one flat
                list, since an `<optgroup>`'s label cannot be picked. A list that failed to load
                leaves 고르지 않음 alone: the field is optional. */}
            <NativeSelect.Field data-testid="proposal-category" {...register('categoryId')}>
              <option value="">{copy.proposalCategoryNone}</option>
              {tree.flatMap(({ category: parent, children }) => [
                <option key={parent.id} value={String(parent.id)}>
                  {parent.nameKo}
                </option>,
                ...children.map((leaf) => (
                  <option key={leaf.id} value={String(leaf.id)}>
                    {`${parent.nameKo}${CATEGORY_TRAIL_SEPARATOR}${leaf.nameKo}`}
                  </option>
                )),
              ])}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
          <Field.ErrorText>{errors.categoryId?.message}</Field.ErrorText>
        </Field.Root>

        <Button
          type="submit"
          alignSelf="flex-start"
          loading={isSubmitting}
          disabled={create.accountId === undefined}
          data-testid="proposal-submit"
        >
          {copy.proposalSubmit}
        </Button>
      </Stack>
    </form>
  );
}
