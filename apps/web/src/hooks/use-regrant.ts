'use client';

import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ApplyRegrantResult,
  type RegrantStatus,
  api,
  isApiError,
  isForAnotherAccount,
  unwrap,
} from '@/lib/api';
import { IdempotencyKeys } from '@/lib/idempotency';
import { REGRANT_INTENT, regrantDetailsOf, regrantRereadAt, regrantStatusKey } from '@/lib/regrant';
import { useSession } from '@/lib/use-session';
import { useInstantReached } from './use-instant-reached';
import { ME_QUERY_KEY } from './use-me';
import { LEDGER_QUERY_KEY } from './use-wallet';

/**
 * `GET /me/regrant` (재지급, #74, ADR-0155): whether a re-grant would be given now — open, eligible,
 * every refusal and the numbers the wallet's card shows. Kept under the account the wallet was
 * drawn for (`regrantStatusKey`, ADR-0091): the answer names no owner. Fresh every time the card is
 * mounted (`staleTime: 0`, as the closure's check): what it says follows the balance, the orders
 * and the holdings, which move on other screens, and the request asks everything again under its
 * locks anyway (a refusal then redraws the card from its details, `useApplyRegrant`).
 */
export function regrantStatusQueryOptions(accountId: string) {
  return {
    queryKey: regrantStatusKey(accountId),
    queryFn: async () => unwrap(await api.GET('/api/v1/me/regrant')).data,
    staleTime: 0,
  };
}

export function useRegrantStatus(accountId: string) {
  return useQuery(regrantStatusQueryOptions(accountId));
}

/** Reads `accountId`'s status again: its entry alone (`regrantStatusKey`), never another's. */
export function readRegrantStatusAgain(queryClient: QueryClient, accountId: string) {
  return queryClient.invalidateQueries({ queryKey: regrantStatusKey(accountId), exact: true });
}

/**
 * When `accountId`'s status was last written (its `dataUpdatedAt`), undefined with none held.
 * Read after a press was refused, it is the reading REGRANT_NOT_ALLOWED's details became: the
 * press's promise is rejected after `onError` has put them in place (`applyRegrantOptions`).
 */
export function regrantStatusReadAt(queryClient: QueryClient, accountId: string) {
  return queryClient.getQueryState(regrantStatusKey(accountId))?.dataUpdatedAt;
}

/**
 * Reads the status again when the 대기기간 or the period's slot it names runs out while the card is
 * on screen (`regrantRereadAt`: the earlier of `waitUntil` and `nextPeriodAt`, a second's slack
 * after it) — nothing is published then, so the button would otherwise stay off and the sentence
 * '…부터 받을 수 있습니다' stay up until a focus or a reload. A one-shot timer on the browser's
 * clock (`useInstantReached`, no server anchor here); a new reading with another instant is
 * waited for afresh.
 */
export function useRegrantRereadAt(accountId: string, status: RegrantStatus | undefined): void {
  const queryClient = useQueryClient();
  const readAgain = useCallback(() => {
    void readRegrantStatusAgain(queryClient, accountId);
  }, [queryClient, accountId]);
  useInstantReached(regrantRereadAt(status), undefined, readAgain);
}

/**
 * Reads the status again when the balance the wallet shows moves while the card is on screen —
 * `['me']`'s 가용 코인 or 주문 잠금 코인: a fill, a payout or a correction (`user:balance`), an order
 * of the account resting or ending (the wallet's lock watch reads `['me']` again for it,
 * `useWalletLockWatch`). Those are what `not_exhausted` and `live_orders` are about, so the card's
 * button follows them rather than waiting for the next mount or focus. Not on the first reading:
 * the status is read on mount already.
 */
export function useRegrantFollowsBalance(accountId: string, balance: string | undefined): void {
  const queryClient = useQueryClient();
  const seen = useRef(balance);
  useEffect(() => {
    if (balance === undefined || seen.current === balance) return;
    const first = seen.current === undefined;
    seen.current = balance;
    if (first) return;
    void readRegrantStatusAgain(queryClient, accountId);
  }, [queryClient, accountId, balance]);
}

/** What a press of 재지급 신청 sends: the account the wallet was drawn for (ADR-0092). */
export interface ApplyRegrantRequest {
  expectedAccountId: string;
}

/**
 * `POST /me/regrant`: the re-grant, given at once when every condition holds (owner answer 3).
 *
 * The body names the account the wallet shows (`expectedAccountId`, ADR-0092) — the card's `Me`,
 * never the session's: in the render between the session naming another account and
 * SessionCacheGuard's reset a body naming the session's would be taken with B's cookie and give B
 * a re-grant applied for on A's screen (ADR-0091). The server refuses the mismatch before it reads
 * anything, and the refusal asks for the session again so SessionCacheGuard shows the account
 * really signed in.
 *
 * One `Idempotency-Key` per account until the server has answered (lib/idempotency.ts, the
 * `regrant-key` namespace, `REGRANT_INTENT`): a click whose answer never came — or came as a 5xx,
 * which may have acted — sends the same request id again, and the API answers the re-grant it gave
 * (`replayed: true`) rather than a second one (N01 §9), as an order's request id or a charge's key.
 * A decision (2xx, 4xx) spends it. Not the account refusal: the server judged the cookie, not this
 * id, which may be the one this account kept from an earlier lost answer. Kept in sessionStorage,
 * so a reload after a lost answer finds it, and filed under the account the request names, so
 * another account using this tab meanwhile neither sends nor spends it.
 *
 * Answered, the balance, the ledger and the status are read again (awaited, so the button stays
 * pending until they land): `['me']` exactly, every ledger entry, and this account's status.
 * REGRANT_NOT_ALLOWED carries the status the refusing request read under its locks: it takes the
 * status's place at once — the card lists every reason from it — and `['me']` is read again, the
 * balance being what most reasons are about. A RESTRICTED or ONBOARDING_REQUIRED refusal reads the
 * status again (the restrictions are read again by the MutationCache's rule, `afterRestricted`),
 * the second `['me']` too, so MY's gate takes the account through the step it has left.
 *
 * Mutation options apart from the hook, as use-me.ts' are, so a test can watch them in vitest's
 * node environment: `onSessionChanged` is the session's refetch and `keysFor` the account's ids.
 */
export function applyRegrantOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  keysFor: (account: string) => IdempotencyKeys,
) {
  const meAgain = () => queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY, exact: true });
  const statusAgain = (account: string) => readRegrantStatusAgain(queryClient, account);
  return {
    retry: false,
    mutationFn: async ({ expectedAccountId }: ApplyRegrantRequest): Promise<ApplyRegrantResult> => {
      const keys = keysFor(expectedAccountId);
      const result = await api.POST('/api/v1/me/regrant', {
        params: { header: { 'Idempotency-Key': keys.take(REGRANT_INTENT) } },
        body: { expectedAccountId },
      });
      // Only reached when the server answered; a throw above (no response) keeps the id.
      try {
        const { data } = unwrap(result);
        keys.settle(REGRANT_INTENT, result.response.status);
        return data;
      } catch (error) {
        if (!isForAnotherAccount(error)) keys.settle(REGRANT_INTENT, result.response.status);
        throw error;
      }
    },
    onSuccess: async (_result: ApplyRegrantResult, { expectedAccountId }: ApplyRegrantRequest) => {
      await Promise.all([
        meAgain(),
        queryClient.invalidateQueries({ queryKey: LEDGER_QUERY_KEY }),
        statusAgain(expectedAccountId),
      ]);
    },
    onError: async (error: unknown, { expectedAccountId }: ApplyRegrantRequest) => {
      if (isForAnotherAccount(error)) {
        onSessionChanged();
        return;
      }
      const details = regrantDetailsOf(error);
      if (details !== undefined) {
        // In place of the status read before, and not read again over it: the refusing request's
        // own reading is the newest there is.
        await queryClient.cancelQueries({
          queryKey: regrantStatusKey(expectedAccountId),
          exact: true,
        });
        queryClient.setQueryData(regrantStatusKey(expectedAccountId), details);
        await meAgain();
        return;
      }
      if (isApiError(error, 'RESTRICTED') || isApiError(error, 'ONBOARDING_REQUIRED')) {
        await Promise.all([statusAgain(expectedAccountId), meAgain()]);
      }
    },
  };
}

/**
 * The request ids of one mounted card, a handle per account (`IdempotencyKeys`, `regrant-key`):
 * the keys themselves sit in the tab's sessionStorage, so a new handle for the same account finds
 * the id an earlier one kept; with a throwing storage the handle's in-memory fallback IS the id,
 * so the card keeps its handle as long as the account stays.
 */
export function regrantKeyring(): (account: string) => IdempotencyKeys {
  let handle: { account: string; keys: IdempotencyKeys } | null = null;
  return (account) => {
    if (handle?.account !== account) {
      handle = { account, keys: new IdempotencyKeys(account, undefined, 'regrant-key') };
    }
    return handle.keys;
  };
}

/**
 * `applyRegrantOptions` with the tab's session and the card's keyring — in state, not a memo
 * React may drop, as the payments poll keeps its memory (`usePayments`).
 */
export function useApplyRegrant() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  const [keysFor] = useState(regrantKeyring);
  return useMutation(applyRegrantOptions(queryClient, () => void refetchSession(), keysFor));
}
