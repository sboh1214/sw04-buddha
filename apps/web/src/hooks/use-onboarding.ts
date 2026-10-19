'use client';

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ME_QUERY_KEY, meBelongsTo, refreshOwnMe } from '@/hooks/use-me';
import {
  api,
  isApiError,
  isForAnotherAccount,
  unwrap,
  type Me,
  type RecordConsentsBody,
  type SetInterestCategoriesBody,
  type SetOnboardingNicknameBody,
} from '@/lib/api';
import { nicknameRefusalNeedsRefresh } from '@/lib/nickname';
import { takeOnboardingAnswer, type OnboardingWrite } from '@/lib/onboarding';
import { useSession } from '@/lib/use-session';

/**
 * The onboarding's writes (#58, ADR-0072) apart from the 본인확인, which is #183's
 * (use-phone-verification.ts): the consent step, the nickname step — with which the server grants
 * the start Coin — and the interest categories. Each answers the whole `Me`, and what the write
 * changed goes into `['me']` before the mutation settles (`storeOnboardingAnswer`), so the
 * stepper, which reads `onboarding.nextStep` there, moves on in the same render the answer lands —
 * and the gate on the page it then returns to already sees the onboarding done.
 *
 * Every write names the account the screen shows (`expectedAccountId`, A-PG-24): a window still
 * showing account A after another one signed in as B would otherwise record A's answers as B's
 * consent, or spend B's nickname step and start Coin. A refusal as another account asks for the
 * session again, so SessionCacheGuard puts the real account on screen, as every owner write does.
 *
 * The cache writer and the mutations' options are exported apart from their hooks: apps/web runs
 * vitest under `environment: 'node'` (use-onboarding.test.ts).
 */

async function postConsents(body: RecordConsentsBody): Promise<Me> {
  return unwrap(await api.POST('/api/v1/me/consents', { body })).data;
}

async function postNickname(body: SetOnboardingNicknameBody): Promise<Me> {
  return unwrap(await api.POST('/api/v1/me/onboarding/nickname', { body })).data;
}

async function putInterests(body: SetInterestCategoriesBody): Promise<Me> {
  return unwrap(await api.PUT('/api/v1/me/interest-categories', { body })).data;
}

/**
 * Writes what an onboarding write changed (`takeOnboardingAnswer`) from its answer into `['me']`,
 * as `storeMe` does for a profile write: a `GET /me` in flight is cancelled first, so an answer
 * that left before the write committed cannot put the step back; nothing is written over another
 * account's profile — the tab and the cookie disagree on who is signed in, so the session is asked
 * for again (`onSessionChanged`); and an empty entry is re-asked rather than built from the answer.
 *
 * After the nickname step `GET /me` is asked again as well, in the background: the start Coin it
 * may have paid moved the balance, which this write does not take from its answer (see
 * `takeOnboardingAnswer`) — the refetch answers it with whatever came after.
 */
export async function storeOnboardingAnswer(
  queryClient: QueryClient,
  me: Me,
  write: OnboardingWrite,
  onSessionChanged: () => void,
): Promise<void> {
  if (!meBelongsTo(queryClient, me.id)) {
    onSessionChanged();
    return;
  }
  await queryClient.cancelQueries({ queryKey: ME_QUERY_KEY, exact: true });
  const held = queryClient.getQueryData<Me>(ME_QUERY_KEY);
  if (!held) {
    await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY, exact: true });
    return;
  }
  if (held.id !== me.id) {
    onSessionChanged();
    return;
  }
  queryClient.setQueryData<Me>(ME_QUERY_KEY, takeOnboardingAnswer(held, me, write));
  if (write === 'nickname') {
    void queryClient.invalidateQueries({
      queryKey: ME_QUERY_KEY,
      exact: true,
      refetchType: 'active',
    });
  }
}

/** `POST /me/consents` as mutation options: the consent step (#57-5). */
export function recordConsentsOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  post: (body: RecordConsentsBody) => Promise<Me> = postConsents,
) {
  return {
    mutationFn: post,
    // Returned, so `mutateAsync` settles only once `['me']` holds the answer.
    onSuccess: (me: Me) => storeOnboardingAnswer(queryClient, me, 'consent', onSessionChanged),
    onError: (error: Error) => {
      if (isForAnotherAccount(error)) onSessionChanged();
    },
  };
}

/**
 * `POST /me/onboarding/nickname` as mutation options: the nickname step (#57-6), and with it the
 * start Coin (#70) — the answer's `startGrant` is what the notice screen shows. A refusal that
 * says the screen is out of date (the step done in another tab, a step before it not done) asks
 * `['me']` again, and the stepper follows.
 */
export function setOnboardingNicknameOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  post: (body: SetOnboardingNicknameBody) => Promise<Me> = postNickname,
) {
  return {
    mutationFn: post,
    onSuccess: (me: Me) => storeOnboardingAnswer(queryClient, me, 'nickname', onSessionChanged),
    onError: async (error: Error, body: SetOnboardingNicknameBody) => {
      if (isForAnotherAccount(error)) {
        onSessionChanged();
        return;
      }
      if (nicknameRefusalNeedsRefresh(error)) {
        await refreshOwnMe(queryClient, body.expectedAccountId);
      }
    },
  };
}

/**
 * `PUT /me/interest-categories` as mutation options: the interest categories (#57-7), some or none
 * (the skip). Open to onboarded accounts only; an ONBOARDING_REQUIRED says `['me']` is out of date
 * (a revision asked for the consent again meanwhile) and asks it again.
 */
export function setInterestCategoriesOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  put: (body: SetInterestCategoriesBody) => Promise<Me> = putInterests,
) {
  return {
    mutationFn: put,
    onSuccess: (me: Me) => storeOnboardingAnswer(queryClient, me, 'interests', onSessionChanged),
    onError: async (error: Error, body: SetInterestCategoriesBody) => {
      if (isForAnotherAccount(error)) {
        onSessionChanged();
        return;
      }
      if (isApiError(error, 'ONBOARDING_REQUIRED')) {
        await refreshOwnMe(queryClient, body.expectedAccountId);
      }
    },
  };
}

/**
 * The account the screen shows (`accountId`, the session's user id — the `useCharge` source),
 * which every step sends as `expectedAccountId`, and `ready`, false until better-auth has said
 * whose session this is; the steps keep their submit disabled until then.
 */
function useScreenAccount() {
  const queryClient = useQueryClient();
  const { data: session, refetch } = useSession();
  const accountId = session?.user.id;
  return { queryClient, accountId, refetchSession: () => void refetch() };
}

/** `recordConsentsOptions` as the consent step's mutation. */
export function useRecordConsents() {
  const { queryClient, accountId, refetchSession } = useScreenAccount();
  const mutation = useMutation(recordConsentsOptions(queryClient, refetchSession));
  return { ...mutation, accountId, ready: accountId !== undefined };
}

/** `setOnboardingNicknameOptions` as the nickname step's mutation. */
export function useSetOnboardingNickname() {
  const { queryClient, accountId, refetchSession } = useScreenAccount();
  const mutation = useMutation(setOnboardingNicknameOptions(queryClient, refetchSession));
  return { ...mutation, accountId, ready: accountId !== undefined };
}

/** `setInterestCategoriesOptions` as the interests step's mutation. */
export function useSetInterestCategories() {
  const { queryClient, accountId, refetchSession } = useScreenAccount();
  const mutation = useMutation(setInterestCategoriesOptions(queryClient, refetchSession));
  return { ...mutation, accountId, ready: accountId !== undefined };
}
