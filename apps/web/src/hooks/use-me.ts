'use client';

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { copy } from '@/copy';
import { api, isForAnotherAccount, unwrap, type Me, type UpdateTimeZoneBody } from '@/lib/api';
import { authClient, authErrorMessage } from '@/lib/auth-client';
import { useSession } from '@/lib/use-session';

/** Query key rule from PLAN 11.5. */
export const ME_QUERY_KEY = ['me'] as const;

export async function fetchMe(): Promise<Me> {
  return unwrap(await api.GET('/api/v1/me')).data;
}

/**
 * Profile + balance + linked login methods (`GET /api/v1/me`). Only runs while the
 * better-auth session says we are logged in, so a logged-out visitor never triggers a 401.
 */
export function useMe() {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: fetchMe,
    enabled: session !== null && session !== undefined,
  });
  return {
    ...query,
    /** True until we know whether there is a session (avoids a logged-out flash). */
    isPending: sessionPending || (session != null && query.isPending),
    isLoggedIn: session != null,
  };
}

/**
 * `POST /api/v1/me/password`: the first password of an account that has none, set from the
 * settings screen (a social-only user). The sign-up's /set-password step uses
 * `useSetPasswordAndContact` (use-contact.ts) instead. Refreshes the linked-account list, which
 * decides whether the settings screen offers "set" or "change".
 *
 * The body names the account the screen shows (`expectedAccountId`, A-PG-24), read from the
 * session as `useCharge` reads it: the cookie decides whose password is set, and a settings tab
 * left open beside a window that signed in as somebody else would otherwise give THAT account a
 * first password typed here — one whoever typed it knows. The server refuses the mismatch
 * before better-auth is asked; the refusal refetches the session so SessionCacheGuard shows
 * the account that is really signed in. `ready` is false until the session is known, and the
 * form keeps its submit disabled until then.
 */
export function useSetPassword() {
  const queryClient = useQueryClient();
  const { data: session, refetch: refetchSession } = useSession();
  const accountId = session?.user.id;
  const mutation = useMutation({
    mutationFn: async (newPassword: string) => {
      // Unreachable while the form honours `ready`.
      if (!accountId) throw new Error('password set before the session was known');
      return unwrap(
        await api.POST('/api/v1/me/password', {
          body: { newPassword, expectedAccountId: accountId },
        }),
      ).data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
    onError: (error: Error) => {
      if (isForAnotherAccount(error)) void refetchSession();
    },
  });
  return { ...mutation, ready: accountId !== undefined };
}

/**
 * Whether `['me']` may take a write made for `account`: it holds that account's profile, or no
 * profile at all.
 *
 * `account` is not a guess. For a contact or a password it is the `expectedAccountId` the
 * request sent, which the server compared with the cookie before writing; for a `Me` a write
 * answered with it is that answer's own `id`, the account whose row was written. Either way a 2xx
 * PROVES whose write it was. The entry, unlike `['positions']`, carries its owner (`Me.id`), so
 * the comparison is the entry's own and needs no reading of the session. A profile of somebody
 * else means the tab switched accounts while the request ran (SessionCacheGuard reset the caches
 * and the other account's `GET /me` landed) — or, for the cookie-only `PATCH /me`, that the tab
 * never learned of a switch (`storeMe`): writing the answer there would show one account's name,
 * number or choices on the other's screen, and even a mere refresh is not this answer's to ask
 * for — the guard owns that entry. No profile at all is nothing of anybody's to overwrite, and
 * the request that fills it asks the cookie.
 */
export function meBelongsTo(queryClient: QueryClient, account: string): boolean {
  const held = queryClient.getQueryData<Me>(ME_QUERY_KEY);
  return held === undefined || held.id === account;
}

/** The profile field a profile write owns: the one `storeMe` takes from its answer. */
export type ProfileField = 'nickname' | 'timeZone';

/**
 * Writes the profile a profile write answered with (`PATCH /me`, `PUT /me/time-zone`) into
 * `['me']`, so every observer — TimeZoneProvider, the header — takes it without a refetch.
 *
 * Only the field the write changed (`field`): the answer is a whole `Me`, but the write changed
 * nothing else. Two profile writes can overlap — a nickname save and a time-zone save from the
 * same settings screen — and each answer is a snapshot of the whole profile read right after
 * its own UPDATE: a time-zone answer that read the nickname before the nickname's UPDATE
 * committed, landing last, would put the old nickname back while the database holds the new
 * one. So each write takes only its own field from its answer. The rest of the answer is no
 * better: its `balance` is what the server read right after the UPDATE. A fill or a payout that
 * committed after that read may already have reached the tab as `user:balance` and patched
 * `['me']` (realtime-provider.tsx), which drops a repeat of that event; writing the whole answer
 * would put the older balance back on the header chip, the wallet and the order panel until the
 * next refetch. `storeContact` (use-contact.ts) takes only `contact` for the same reason.
 *
 * A `GET /me` already in flight (a window-focus refetch, a realtime resnapshot) is cancelled
 * first, as `storeContact` and realtime-provider.tsx do before they patch `['me']`: it may have
 * left before the write committed, and answering after this one it would put the old nickname
 * or zone back until the next refetch — the toast saying 저장했습니다 over times read in the zone
 * just left. The cancel reverts the entry to what it held before that request; if that is
 * nothing (a first fetch), the entry is re-asked rather than filled: it held nobody's profile,
 * and the request that fills it asks the cookie (`meBelongsTo`).
 *
 * Only while `['me']` still belongs to the account the answer is (`me.id`): checked before the
 * cancel, so another account's profile held there is never touched — its refresh is not
 * cancelled either — and again after it, since the cancel is awaited. Another account's profile
 * there means the tab and the cookie disagree on who is signed in, and the write went to the
 * cookie's account. Either the tab already switched after the request left (SessionCacheGuard
 * reset the cache and the next account's `GET /me` landed), or the tab never learned of a switch
 * at all: a window still showing A beside one that signed in as B, which no `visibilitychange`
 * tells (session-cache-guard.tsx), so `PATCH /me` — cookie only (A-PG-24) — renamed B. So
 * `onSessionChanged` asks for the session again: in the first case it changes nothing, in the
 * second SessionCacheGuard resets the cache and the screen shows the account that was written,
 * which is what lets the member see that the account changed (A-PG-24).
 */
export async function storeMe(
  queryClient: QueryClient,
  me: Me,
  field: ProfileField,
  onSessionChanged: () => void,
): Promise<void> {
  if (!meBelongsTo(queryClient, me.id)) {
    onSessionChanged();
    return;
  }
  await queryClient.cancelQueries({ queryKey: ME_QUERY_KEY, exact: true });
  const held = queryClient.getQueryData<Me>(ME_QUERY_KEY);
  if (held) {
    if (held.id === me.id)
      queryClient.setQueryData<Me>(ME_QUERY_KEY, {
        ...held,
        profile: { ...held.profile, [field]: me.profile[field] },
      });
    else onSessionChanged();
    return;
  }
  await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY, exact: true });
}

async function patchNickname(nickname: string): Promise<Me> {
  return unwrap(await api.PATCH('/api/v1/me', { body: { nickname } })).data;
}

async function putTimeZone(body: UpdateTimeZoneBody): Promise<Me> {
  return unwrap(await api.PUT('/api/v1/me/time-zone', { body })).data;
}

/**
 * `PATCH /api/v1/me` (nickname) as mutation options: the answer's profile goes into `['me']`
 * through `storeMe`. Exported apart from its hook, as use-contact.ts does its own, because
 * apps/web runs vitest under `environment: 'node'` (use-me.test.ts). `onSessionChanged` is the
 * hook's session refetch and `patch` stands in the request; both parameters so a test can watch
 * them.
 */
export function updateNicknameOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  patch: (nickname: string) => Promise<Me> = patchNickname,
) {
  return {
    mutationFn: patch,
    // Returned, so `mutateAsync` settles only once `['me']` holds the answer.
    onSuccess: (me: Me) => storeMe(queryClient, me, 'nickname', onSessionChanged),
  };
}

/** `updateNicknameOptions` as the settings card's mutation. */
export function useUpdateNickname() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  return useMutation(updateNicknameOptions(queryClient, () => void refetchSession()));
}

/**
 * `PUT /api/v1/me/time-zone` (ADR-0063) as mutation options: the zone to read times in, or
 * `null` to follow the browser again, and the account the screen shows (`expectedAccountId`,
 * A-PG-24 — the server refuses a cookie of another account before it writes). The answer's
 * profile goes into `['me']` through `storeMe`, as the nickname's does, so TimeZoneProvider
 * switches every time on screen without a refetch — and a `GET /me` that left before the PUT
 * cannot switch them back. The 403 for another account asks for the session again, as the
 * contact's does, so SessionCacheGuard puts the account really signed in on screen.
 */
export function updateTimeZoneOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  put: (body: UpdateTimeZoneBody) => Promise<Me> = putTimeZone,
) {
  return {
    mutationFn: put,
    // Returned, so `mutateAsync` settles only once `['me']` holds the answer.
    onSuccess: (me: Me) => storeMe(queryClient, me, 'timeZone', onSessionChanged),
    onError: (error: Error) => {
      if (isForAnotherAccount(error)) onSessionChanged();
    },
  };
}

/**
 * `updateTimeZoneOptions` as the settings 시간대 card's mutation, plus the account the screen
 * shows (`accountId`, the session's user id — `useUpdateContact`'s source), which the card sends
 * as `expectedAccountId`. `ready` is false until better-auth has said whose session this is; the
 * card keeps its save disabled until then.
 */
export function useUpdateTimeZone() {
  const queryClient = useQueryClient();
  const { data: session, refetch: refetchSession } = useSession();
  const accountId = session?.user.id;
  const mutation = useMutation(updateTimeZoneOptions(queryClient, () => void refetchSession()));
  return { ...mutation, accountId, ready: accountId !== undefined };
}

/** Query key rule from PLAN 11.5. */
export const ACCOUNTS_QUERY_KEY = ['me', 'accounts'] as const;

/**
 * better-auth `listAccounts`: the source of truth for `account` rows (incl. the row id
 * `unlinkAccount` takes) and therefore for "does this user have a password yet".
 *
 * Lives here rather than in either settings section because both of them observe this one
 * key: whichever renders last owns the fetch, so a queryFn written twice would make the
 * error message depend on render order. The catch is belt-and-braces: `fetchOrNetworkError`
 * already turns a transport failure into an ordinary `{ error }`, so nothing should reach
 * it, but a throw from anywhere else must still not surface an English message.
 */
export function useLinkedAccounts() {
  return useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: async () => {
      let result;
      try {
        result = await authClient.listAccounts();
      } catch {
        throw new Error(copy.errNetwork);
      }
      if (result.error) throw new Error(authErrorMessage(result.error));
      return result.data;
    },
  });
}
