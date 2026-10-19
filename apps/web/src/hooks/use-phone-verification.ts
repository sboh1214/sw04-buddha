'use client';

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ME_QUERY_KEY, meBelongsTo, refreshOwnMe } from '@/hooks/use-me';
import {
  api,
  isApiError,
  isForAnotherAccount,
  unwrap,
  type ConfirmPhoneVerificationBody,
  type Me,
  type PhoneVerification,
  type PhoneVerificationCodeSent,
  type RequestPhoneVerificationCodeBody,
  type UpdateRealNameBody,
} from '@/lib/api';
import { afterVerification } from '@/lib/onboarding';
import { isVerifiedAlready } from '@/lib/phone-verification';
import { useSession } from '@/lib/use-session';

/**
 * 본인확인 (#183, ADR-0070): the SMS code, its confirmation and the real-name change of MY 설정.
 * There is no read of its own: `GET /me` carries `verification` (null until the code is
 * confirmed), so every screen reads it from `useMe()` — the onboarding gate, /onboarding and the
 * settings card all observe the one `['me']` entry.
 *
 * Every write names the account the screen shows (`expectedAccountId`, A-PG-24): the cookie
 * decides whose verification the server writes, and a tab whose cookie another tab has since
 * signed in as somebody else would otherwise text a code for THAT account, verify it with what
 * was typed here, or rename it. The server compares the two before it does anything and answers
 * a mismatch with the 403 `isForAnotherAccount` recognises; every hook here then refetches the
 * session so SessionCacheGuard puts the real account on screen, as the wallet's do.
 *
 * The cache writer and the mutations' options are exported apart from their hooks: apps/web runs
 * vitest under `environment: 'node'`, so a decision sealed in a hook body is one no unit test can
 * reach (use-phone-verification.test.ts).
 */

async function postCode(
  body: RequestPhoneVerificationCodeBody,
): Promise<PhoneVerificationCodeSent> {
  return unwrap(await api.POST('/api/v1/me/phone-verification/code', { body })).data;
}

async function postConfirm(body: ConfirmPhoneVerificationBody): Promise<PhoneVerification> {
  return unwrap(await api.POST('/api/v1/me/phone-verification/confirm', { body })).data;
}

async function putRealName(body: UpdateRealNameBody): Promise<PhoneVerification> {
  return unwrap(await api.PUT('/api/v1/me/real-name', { body })).data;
}

/**
 * Writes the account's verification into `['me']` straight away rather than invalidating: the
 * gate and /onboarding's stepper read that entry, and a refetch still in flight when the stepper
 * moves on would leave it holding `verification: null` for one more render — enough to show the
 * step again. The onboarding's own `verification` and where it resumes go with it
 * (`afterVerification`, lib/onboarding.ts: the step done, the next one the nickname, #58), worked
 * out by the same function the server answers `GET /me` with.
 * `PhoneVerification` itself never says whose it is, so the account is the `expectedAccountId`
 * the request sent (`meBelongsTo`, use-me.ts); `storeMe` there is the same write for a profile.
 *
 * A `GET /me` already in flight (a window-focus refetch, a realtime resnapshot) is cancelled
 * first, as realtime-provider.tsx does before it patches `['me']`: it may have left before the
 * write committed, and answering after this one it would put `verification: null` (or the old
 * real name) back. The cancel reverts the entry to what it held before that request; if that is
 * nothing (a first fetch), there is nothing to patch and the request is re-issued — the write has
 * committed, so its answer carries the record.
 *
 * Only while `['me']` still belongs to `account`: checked before the cancel, so a profile of
 * another account held there is never touched — its refresh is not cancelled either — and again
 * after it, since the cancel is awaited. An EMPTY entry passes the first check (it holds nobody's
 * profile), so right after SessionCacheGuard's reset the other account's first `GET /me` may be
 * the one cancelled; the entry is then empty again and only re-asked with the cookie, so the cost
 * is one extra request, never a write.
 */
export async function storeVerification(
  queryClient: QueryClient,
  verification: PhoneVerification,
  account: string,
): Promise<void> {
  if (!meBelongsTo(queryClient, account)) return;
  await queryClient.cancelQueries({ queryKey: ME_QUERY_KEY, exact: true });
  const held = queryClient.getQueryData<Me>(ME_QUERY_KEY);
  if (held) {
    if (held.id === account) {
      queryClient.setQueryData<Me>(ME_QUERY_KEY, {
        ...held,
        verification,
        onboarding: afterVerification(held.onboarding),
      });
    }
    return;
  }
  await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY, exact: true });
}

/**
 * `POST /me/phone-verification/code` as mutation options: /onboarding's 인증번호 받기 and 다시 받기.
 * Nothing in the cache changes on success — the code is not a record yet — and the answer's two
 * spans are the step's countdowns. `onSessionChanged` is the hook's session refetch and `post`
 * stands in the request; both parameters so a test can observe them.
 */
export function requestCodeOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  post: (body: RequestPhoneVerificationCodeBody) => Promise<PhoneVerificationCodeSent> = postCode,
) {
  return {
    mutationFn: post,
    // Returned, so `mutateAsync` rejects only once `['me']` has been asked again.
    onError: async (error: Error, body: RequestPhoneVerificationCodeBody) => {
      if (isForAnotherAccount(error)) {
        onSessionChanged();
        return;
      }
      // ONBOARDING_REQUIRED: the consent comes first (#58) and the account's no longer stands —
      // a revision that asked for it again while this screen was open — so the stepper goes back
      // to the consent step with the fresh `['me']`.
      if (isVerifiedAlready(error) || isApiError(error, 'ONBOARDING_REQUIRED')) {
        await refreshOwnMe(queryClient, body.expectedAccountId);
      }
    },
  };
}

/**
 * `POST /me/phone-verification/confirm` as mutation options: the record the server answers goes
 * into `['me']` (`storeVerification`) before `mutateAsync` settles, so the gate on the page
 * /onboarding returns to already sees it.
 */
export function confirmVerificationOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  post: (body: ConfirmPhoneVerificationBody) => Promise<PhoneVerification> = postConfirm,
) {
  return {
    mutationFn: post,
    onSuccess: (verification: PhoneVerification, body: ConfirmPhoneVerificationBody) =>
      storeVerification(queryClient, verification, body.expectedAccountId),
    onError: async (error: Error, body: ConfirmPhoneVerificationBody) => {
      if (isForAnotherAccount(error)) {
        onSessionChanged();
        return;
      }
      if (isVerifiedAlready(error)) await refreshOwnMe(queryClient, body.expectedAccountId);
    },
  };
}

/**
 * `PUT /me/real-name` as mutation options: MY 설정's real-name card. The answer is the whole
 * record (the number unchanged), written into `['me']` as a confirmation's is.
 */
export function updateRealNameOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  put: (body: UpdateRealNameBody) => Promise<PhoneVerification> = putRealName,
) {
  return {
    mutationFn: put,
    onSuccess: (verification: PhoneVerification, body: UpdateRealNameBody) =>
      storeVerification(queryClient, verification, body.expectedAccountId),
    onError: async (error: Error, body: UpdateRealNameBody) => {
      if (isForAnotherAccount(error)) {
        onSessionChanged();
        return;
      }
      // The card showed a record the server no longer has.
      if (isApiError(error, 'VERIFICATION_REQUIRED')) {
        await refreshOwnMe(queryClient, body.expectedAccountId);
      }
    },
  };
}

/**
 * The account the screen shows (`accountId`, the session's user id — the `useCharge` source),
 * which every form here sends as `expectedAccountId`, and `ready`, false until better-auth has
 * said whose session this is; the forms keep their submit disabled until then rather than send a
 * body with no account in it.
 */
function useScreenAccount() {
  const queryClient = useQueryClient();
  const { data: session, refetch } = useSession();
  const accountId = session?.user.id;
  return { queryClient, accountId, refetchSession: () => void refetch() };
}

/** `requestCodeOptions` as /onboarding's mutation. */
export function useRequestVerificationCode() {
  const { queryClient, accountId, refetchSession } = useScreenAccount();
  const mutation = useMutation(requestCodeOptions(queryClient, refetchSession));
  return { ...mutation, accountId, ready: accountId !== undefined };
}

/** `confirmVerificationOptions` as /onboarding's mutation. */
export function useConfirmPhoneVerification() {
  const { queryClient, accountId, refetchSession } = useScreenAccount();
  const mutation = useMutation(confirmVerificationOptions(queryClient, refetchSession));
  return { ...mutation, accountId, ready: accountId !== undefined };
}

/** `updateRealNameOptions` as the settings card's mutation. */
export function useUpdateRealName() {
  const { queryClient, accountId, refetchSession } = useScreenAccount();
  const mutation = useMutation(updateRealNameOptions(queryClient, refetchSession));
  return { ...mutation, accountId, ready: accountId !== undefined };
}
