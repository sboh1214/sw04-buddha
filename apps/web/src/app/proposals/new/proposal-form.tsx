'use client';

import {
  Alert,
  Button,
  Field,
  Input,
  NativeSelect,
  Skeleton,
  Stack,
  Text,
  Textarea,
} from '@chakra-ui/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { RefusalText } from '@/components/moderation/refusal-text';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { EmptyState } from '@/components/ui/empty-state';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useCategories } from '@/hooks/use-markets';
import { useMe } from '@/hooks/use-me';
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
import { type Refusal } from '@/lib/restriction';

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
 * above the form — a writing or an account restriction with its end and the way to 조치·신고 내역
 * (#185, #139), a limit with when the next one may go, the screen out of date (the hook asked for
 * the session or `['me']` again, and the onboarding gate follows the latter).
 *
 * The proposal is the account's whose `Me` the screen was drawn from — the header's — which the
 * submit names (`expectedAccountId`), never the session's: in the render between the session
 * naming another account and SessionCacheGuard's reset the session already says B while the form
 * is still A's, and a proposal naming B would be taken with B's cookie — B's, with the text typed
 * on A's screen (ADR-0091). The server refuses it as another account's. So the form waits for
 * `GET /me` (the write screens' rungs, `WriteGate`: a placeholder, and the profile's failure), and
 * is keyed by that account: `['me']` can also turn from A to B in place, before the session does
 * and so with no reset of SessionCacheGuard's (a window-focus refetch of `GET /me` answered with
 * B's cookie ahead of better-auth's session refetch, a realtime resnapshot — ADR-0090 결정 4-2).
 * Unkeyed, what was typed for A would stay, the submit now naming B with B's cookie; keyed, the
 * form starts again empty for B.
 *
 * The refusal as another account's (`copy.sessionChanged`) is kept above the keyed form
 * (`accountChanged`): the session read again on it says the account really signed in,
 * SessionCacheGuard's reset then takes `['me']` back to waiting, and the form is drawn again for
 * that account — which says why it started again, in the same place above the form.
 */
export function ProposalForm() {
  const me = useMe();
  // The refusal as another account's, kept across the form drawn again (above).
  const [accountChanged, setAccountChanged] = useState<Refusal | null>(null);
  if (me.data !== undefined) {
    // Keyed by the account it was drawn for (above).
    return (
      <ProposalFields
        key={me.data.id}
        accountId={me.data.id}
        accountChanged={accountChanged}
        onAccountChanged={setAccountChanged}
      />
    );
  }
  // Signed in, and `GET /me` failed without ever answering: whose proposal it would be is unknown,
  // so nothing is offered (`usePostWriter`'s `failed`).
  if (me.isLoggedIn && me.isError) {
    return <EmptyState message={copy.errProfileLoad} data-testid="proposal-form-failed" />;
  }
  return <Skeleton height="320px" borderRadius="card" data-testid="proposal-form-pending" />;
}

function ProposalFields({
  accountId,
  accountChanged,
  onAccountChanged,
}: {
  accountId: string;
  /** A submit refused as another account's, on this form or the one drawn before it. */
  accountChanged: Refusal | null;
  onAccountChanged: (refusal: Refusal | null) => void;
}) {
  const router = useRouter();
  const create = useCreateProposal();
  const categories = useCategories();
  // The member's time zone (ADR-0063): a restriction's end in the refusal is an absolute time.
  const format = useFormatDateTime();
  const [refused, setRefused] = useState<Refusal | null>(null);
  const notice = refused ?? accountChanged;
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
    setRefused(null);
    onAccountChanged(null);
    try {
      // The account the form was drawn for rides along (`expectedAccountId`, A-PG-24).
      await create.mutateAsync(toCreateProposalBody(values, accountId));
      toaster.create({ type: 'success', title: copy.proposalSubmitted });
      router.push(MY_PROPOSALS_PATH);
    } catch (error) {
      const failure = proposalFailure(error, format);
      if (failure.kind === 'field') {
        setError(failure.field, { message: failure.message }, { shouldFocus: true });
        return;
      }
      const refusal = { message: failure.message, restricted: failure.kind === 'restricted' };
      // Another account's: the form is about to be drawn again for the account really signed in,
      // and says why there (`ProposalForm`).
      if (failure.kind === 'session') onAccountChanged(refusal);
      else setRefused(refusal);
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
              <Alert.Description>
                <RefusalText message={notice.message} restricted={notice.restricted} />
              </Alert.Description>
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
          data-testid="proposal-submit"
        >
          {copy.proposalSubmit}
        </Button>
      </Stack>
    </form>
  );
}
