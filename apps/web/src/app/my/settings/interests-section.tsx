'use client';

import { Alert, Button, HStack, Skeleton, Stack } from '@chakra-ui/react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useMemo, useState } from 'react';
import { InterestChecklist } from '@/components/profile/interest-checklist';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { useCategories } from '@/hooks/use-markets';
import { useMe } from '@/hooks/use-me';
import { useSetInterestCategories } from '@/hooks/use-onboarding';
import { useSettingsStep } from '@/hooks/use-settings-step';
import { groupCategories } from '@/lib/category-tree';
import { interestIds, withInterest } from '@/lib/onboarding';
import {
  interestsChanged,
  interestsEdit,
  profileItemFailure,
  profileItemSaveGoesToStep,
} from '@/lib/profile';
import { ProfileUnavailable } from './profile-unavailable';
import { SettingsSection } from './section';

/**
 * 관심 카테고리 (#41, ADR-0078): the interest categories the onboarding asked for once (#58, #57-7),
 * changed here (ADR-0069 decision 4 #41: «MY 설정») and shown on the public profile — every one
 * picked, nothing when none (#37-5). The operators' list (`GET /categories`, the seeded one until
 * #17), top-level and sub-categories alike, as many as the member likes, none included: unpicking
 * every one and saving clears them — a deletion, which stays open during a writing or an account
 * restriction while adding one does not (#37-9, decision 7: the server's check) — the first pick
 * here included: only the onboarding screen's first answer is let through (owner decision
 * 2026-10-21 answer 4 and (2nd) answer 2). Dropping needs a session alone, an account facing a
 * re-consent included (answer 2): the page is the gate's exception for it, and a category it adds
 * goes to the step first, coming back here (`useSettingsStep`, ADR-0078 7-24). Its own route
 * (`PUT /me/interest-categories`, `useSetInterestCategories`), the same `['me']` write as the
 * onboarding's step, and the same list (`InterestChecklist`).
 */
export function InterestsSection() {
  const { data: me, isPending } = useMe();
  return (
    <SettingsSection
      title={copy.settingsInterests}
      hint={copy.settingsInterestsHint}
      testId="settings-interests"
    >
      {isPending || !me ? (
        <ProfileUnavailable height="24" />
      ) : (
        // Keyed by account: a tab that switched accounts starts from the new one's picks.
        <InterestsFields key={me.id} held={me.profile.interestCategoryIds} />
      )}
    </SettingsSection>
  );
}

/**
 * The checkboxes start from the account's picks, and follow a later `['me']` (another tab saved)
 * while nothing on screen was changed — the nickname card's `keepDirtyValues`, by hand. What is
 * sent and compared is read among the categories the list offers (`interestIds`,
 * `interestsChanged`): a category operators retired is neither shown nor sent, so saving drops it,
 * as the public profile already leaves it out. A category retired while the screen was open is
 * refused by the server (VALIDATION_ERROR naming `categoryIds`): the list is loaded again and the
 * member picks again from what is there, as in the onboarding. With a step left — a re-consent, the
 * only one the gate keeps on this page — a save that adds a category is not sent: 저장 goes to the
 * step (`profileItemSaveGoesToStep`), and one the server refused for the onboarding goes there too.
 */
function InterestsFields({ held }: { held: readonly number[] }) {
  const categories = useCategories();
  const save = useSetInterestCategories();
  const router = useRouter();
  const step = useSettingsStep();
  const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set(held));
  const [base, setBase] = useState<readonly number[]>(held);
  const [notice, setNotice] = useState<string | null>(null);
  const offered = useMemo(() => categories.data ?? [], [categories.data]);
  const tree = useMemo(() => groupCategories(offered), [offered]);
  const chosen = interestIds(picked, offered);
  // A new `['me']`: taken while the screen still shows the picks it last said. React's way of
  // adjusting state to a prop, during render (no effect, no flash of the old picks).
  if (held !== base) {
    setBase(held);
    if (!interestsChanged(chosen, base, offered)) setPicked(new Set(held));
  }
  const changed = interestsChanged(chosen, held, offered);

  const onSave = async () => {
    const accountId = save.accountId;
    if (accountId === undefined) return;
    setNotice(null);
    if (profileItemSaveGoesToStep(interestsEdit(chosen, held), step.stepLeft)) {
      step.toStep();
      return;
    }
    try {
      await save.mutateAsync({ categoryIds: chosen, expectedAccountId: accountId });
      toaster.create({ type: 'success', title: copy.interestsSaved });
      // Back to the profile shows the new picks (bio-section.tsx says why). Here, not in the
      // hooks' shared write (`interestsWriteOptions`): the onboarding's step shares it and leaves
      // the screen instead.
      router.refresh();
    } catch (error) {
      if (step.afterRefusal(error)) return;
      const failure = profileItemFailure(error);
      if (failure.kind === 'categories') void categories.refetch();
      setNotice(failure.message);
    }
  };

  let list: ReactNode;
  if (categories.isPending) {
    list = <Skeleton height="40" />;
  } else if (categories.isError) {
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
    list = (
      <InterestChecklist
        tree={tree}
        picked={picked}
        onToggle={(id, checked) => setPicked((previous) => withInterest(previous, id, checked))}
      />
    );
  }

  return (
    <Stack gap="4">
      {notice && (
        <Alert.Root status="error" role="alert" data-testid="interests-notice">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{notice}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      {list}
      <HStack justify="flex-end">
        <Button
          onClick={() => void onSave()}
          loading={save.isPending}
          disabled={!save.ready || !categories.isSuccess || !changed}
          data-testid="interests-settings-save"
        >
          {copy.save}
        </Button>
      </HStack>
    </Stack>
  );
}
