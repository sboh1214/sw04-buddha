'use client';

import { Alert, Button, HStack, Skeleton, Stack, Text } from '@chakra-ui/react';
import { type ReactNode, useMemo, useState } from 'react';
import { InterestChecklist } from '@/components/profile/interest-checklist';
import { copy } from '@/copy';
import { useCategories } from '@/hooks/use-markets';
import { useAnswerInterestsStep } from '@/hooks/use-onboarding';
import { isApiError, isForAnotherAccount } from '@/lib/api';
import { groupCategories } from '@/lib/category-tree';
import { interestIds, withInterest } from '@/lib/onboarding';

/**
 * 관심 카테고리, the onboarding's last screen (#58, ADR-0069 decision 1 #57-7): after the start Coin
 * and its notice, before the market. The categories are the operators' list (D10) — the seeded one
 * until #17's admin screen, `GET /categories` — top-level and sub-categories alike, as many as the
 * member likes (`POST /me/onboarding/interests`). 건너뛰기 sends none, and either way the step is
 * answered and never asked again (#57-7) — nor is it once the account left this screen or the
 * notice before it: the screen shows once, right after the nickname step (오너 결정 2026-10-19
 * (2차) 5), and the stepper sends the same skip as the account leaves (owner decision 2026-10-21
 * (2nd) answer 2, ADR-0078). This screen's first answer is the account's first choice, which a
 * writing or an account restriction lets through (owner decision 2026-10-21 answer 4) — within 24
 * hours of the nickname step only (3rd answer 1): a screen left open past them sends a change, which
 * a restriction refuses (the general sentence below, until #185 and #139), while 건너뛰기 still
 * answers the step. MY 설정's card (#41) changes them later, a first pick there included, under the
 * restriction's rule.
 *
 * The categories are grouped as the header groups them (`groupCategories`): each top-level category
 * with its sub-categories under it, each a checkbox of its own (`InterestChecklist`, the list MY
 * 설정's card draws too, #41). A category an operator retired
 * while the screen was open is refused by the server (VALIDATION_ERROR naming it); the list is
 * loaded again and the member picks again from what is there. If the list cannot be loaded at all,
 * 건너뛰기 still works — the step must never hold an account that only wants the market.
 *
 * `accountId` is the account the stepper shows (its `me.id`), which the answer names
 * (`expectedAccountId`) — never the session's, which already says another account in the render
 * before SessionCacheGuard's reset (use-onboarding.ts, ADR-0078 7-29) — and the one the stepper's
 * leave report counts the answer for.
 */
export function InterestsStep({ accountId }: { accountId: string }) {
  const categories = useCategories();
  const save = useAnswerInterestsStep();
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const tree = useMemo(() => groupCategories(categories.data ?? []), [categories.data]);
  const chosen = interestIds(picked, categories.data ?? []);
  // Which of the two buttons is waiting: the one pressed spins, the other only waits disabled.
  const skipping = save.isPending && save.variables?.categoryIds.length === 0;

  const send = async (categoryIds: number[]) => {
    setNotice(null);
    try {
      await save.mutateAsync({ categoryIds, expectedAccountId: accountId });
    } catch (error) {
      if (isApiError(error, 'VALIDATION_ERROR')) {
        setNotice(copy.errInterestsUnavailable);
        void categories.refetch();
        return;
      }
      // ONBOARDING_REQUIRED: the hook asked `['me']` again and the stepper follows it, this step
      // and its line with it; the line stays only when `['me']` did not move (its read failed).
      if (isApiError(error, 'ONBOARDING_REQUIRED')) {
        setNotice(copy.errOnboardingStepsFirst);
        return;
      }
      setNotice(isForAnotherAccount(error) ? copy.sessionChanged : copy.errUnknown);
    }
  };

  const toggle = (id: number, checked: boolean) => {
    setPicked((previous) => withInterest(previous, id, checked));
  };

  let list: ReactNode;
  if (categories.isPending) {
    list = <Skeleton height="40" />;
  } else if (categories.isError) {
    // Read out like every other load failure here, so a screen reader hears why only 건너뛰기 is
    // left, not just a retry button.
    list = (
      <Stack gap="2" align="flex-start" data-testid="interests-unavailable">
        <Alert.Root status="error" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.interestsLoadError}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
        <Button size="sm" variant="outline" onClick={() => void categories.refetch()}>
          {copy.retry}
        </Button>
      </Stack>
    );
  } else {
    list = <InterestChecklist tree={tree} picked={picked} onToggle={toggle} />;
  }

  return (
    <Stack gap="5" data-testid="interests-step">
      <Text color="fg.muted">{copy.interestsIntro}</Text>
      {notice && (
        <Alert.Root status="error" role="alert" data-testid="interests-notice">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{notice}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {list}
      <HStack gap="3" justify="flex-end" wrap="wrap">
        <Button
          variant="ghost"
          onClick={() => void send([])}
          loading={skipping}
          disabled={save.isPending}
          data-testid="interests-skip"
        >
          {copy.interestsSkip}
        </Button>
        <Button
          onClick={() => void send(chosen)}
          loading={save.isPending && !skipping}
          disabled={chosen.length === 0 || save.isPending}
          data-testid="interests-save"
        >
          {copy.interestsSave}
        </Button>
      </HStack>
    </Stack>
  );
}
