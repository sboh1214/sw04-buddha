'use client';

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import {
  api,
  isForAnotherAccount,
  unwrap,
  type Contact,
  type ContactBody,
  type Me,
} from '@/lib/api';
import { useSession } from '@/lib/use-session';

/**
 * The account's real name and mobile number (ADR-0043). There is no read of its own: `GET /me`
 * carries `contact` (null until given), so every screen reads it from `useMe()` — the gate, the
 * settings card and /onboarding all observe the one `['me']` entry.
 *
 * Every write names the account the screen shows (`expectedAccountId`, A-PG-24): the cookie
 * decides whose row the server writes, and a tab whose cookie another tab has since signed in
 * as somebody else would otherwise overwrite THAT account's real name and number with what was
 * typed here. The server compares the two before it writes anything and answers a mismatch
 * with the 403 `isForAnotherAccount` recognises; every hook here then refetches the session so
 * SessionCacheGuard puts the real account on screen, as the wallet's do.
 *
 * The cache writer and the two mutations' options are exported apart from their hooks, for the
 * reason `use-trade.ts` gives: apps/web runs vitest under `environment: 'node'`, so a decision
 * sealed in a hook body is one no unit test can reach (use-contact.test.ts).
 */

/** The two fields a form collects; the body adds the account the screen shows. */
export type ContactFields = Omit<ContactBody, 'expectedAccountId'>;

async function putContact(body: ContactBody): Promise<Contact> {
  return unwrap(await api.PUT('/api/v1/me/contact', { body })).data;
}

/**
 * Whether `['me']` may take a write made for `account`: it holds that account's profile, or no
 * profile at all.
 *
 * `account` is not a guess. It is the `expectedAccountId` the request sent, and the server
 * compared it with the cookie before writing, so a 2xx PROVES whose contact (or password) it
 * was — which `Contact` itself never says. The entry, unlike `['positions']` (`tradeAnswerScope`,
 * use-trade.ts), carries its owner (`Me.id`), so the comparison is the entry's own and needs no
 * reading of the session. A profile of somebody else means the tab switched accounts while the
 * request ran (SessionCacheGuard reset the caches and the other account's `GET /me` landed):
 * patching A's name and number into B's profile would show them on B's screen and hand them
 * to B's gate, and even a mere refresh is not this answer's to ask for — the guard owns that
 * entry now. No profile at all is nothing of anybody's to overwrite, and the request that fills
 * it asks the cookie.
 */
export function meBelongsTo(queryClient: QueryClient, account: string): boolean {
  const held = queryClient.getQueryData<Me>(ME_QUERY_KEY);
  return held === undefined || held.id === account;
}

/**
 * Writes the saved contact into `['me']` straight away rather than invalidating: the gate reads
 * that entry, and a refetch still in flight when /onboarding navigates on would leave it
 * holding `contact: null` for one more render — enough to send the member straight back.
 *
 * A `GET /me` already in flight (a window-focus refetch, a realtime resnapshot) is cancelled
 * first, as realtime-provider.tsx does before it patches `['me']`: it may have left before the
 * PUT committed, and resolving after this write it would put `contact: null` back. The cancel
 * reverts the entry to what it held before that request; if that is nothing (a first fetch),
 * there is nothing to patch and the request is re-issued — the PUT has committed, so its
 * answer carries the contact.
 *
 * Only while `['me']` still belongs to `account`, the one the PUT was sent for (`meBelongsTo`):
 * checked before the cancel, so a profile of another account held there is never touched — its
 * refresh is not cancelled either — and again after it, since the cancel is awaited. An EMPTY
 * entry passes the first check (it holds nobody's profile), so right after SessionCacheGuard's
 * reset the other account's first `GET /me` may be the one cancelled; the entry is then empty
 * again and only re-asked with the cookie, so the cost is one extra request, never a write.
 */
export async function storeContact(
  queryClient: QueryClient,
  contact: Contact,
  account: string,
): Promise<void> {
  if (!meBelongsTo(queryClient, account)) return;
  await queryClient.cancelQueries({ queryKey: ME_QUERY_KEY, exact: true });
  const held = queryClient.getQueryData<Me>(ME_QUERY_KEY);
  if (held) {
    if (held.id === account) queryClient.setQueryData<Me>(ME_QUERY_KEY, { ...held, contact });
    return;
  }
  await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY, exact: true });
}

/**
 * `PUT /api/v1/me/contact` (upsert) as mutation options: /onboarding and the settings card.
 * The variables are the whole body, `expectedAccountId` included, so the account the cache
 * write is scoped to is the very string the server compared. `onSessionChanged` is the hook's
 * session refetch; a parameter so a test can observe it.
 */
export function updateContactOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  put: (body: ContactBody) => Promise<Contact> = putContact,
) {
  return {
    mutationFn: put,
    // Returned, so `mutateAsync` settles only once `['me']` holds the contact.
    onSuccess: (contact: Contact, body: ContactBody) =>
      storeContact(queryClient, contact, body.expectedAccountId),
    // The cookie is somebody else's now: nothing was written. The refetch lets SessionCacheGuard
    // reset the caches and put the account that is really signed in on screen.
    onError: (error: Error) => {
      if (isForAnotherAccount(error)) onSessionChanged();
    },
  };
}

/**
 * `updateContactOptions` as a hook, plus the account the screen shows (`accountId`, the
 * session's user id — the `useCharge` source), which the form sends as `expectedAccountId`.
 * `ready` is false until better-auth has said whose session this is; the forms keep their
 * submit disabled until then rather than send a body with no account in it.
 */
export function useUpdateContact() {
  const queryClient = useQueryClient();
  const { data: session, refetch: refetchSession } = useSession();
  const accountId = session?.user.id;
  const mutation = useMutation(updateContactOptions(queryClient, () => void refetchSession()));
  return { ...mutation, accountId, ready: accountId !== undefined };
}

/**
 * The contact half of the email sign-up's /set-password step failed AFTER its password was
 * saved. The step cannot be retried on that screen — it now shows "password already set" —
 * so the form sends the member to /onboarding instead of offering the same button again.
 */
export class ContactStepError extends Error {
  constructor(cause: unknown) {
    super('The password was saved but the contact was not', { cause });
    this.name = 'ContactStepError';
  }
}

/** The two requests of the /set-password step; a parameter only so a test can stand them in. */
export interface PasswordStepCalls {
  setPassword: (body: { newPassword: string; expectedAccountId: string }) => Promise<unknown>;
  putContact: (body: ContactBody) => Promise<Contact>;
}

const passwordStepCalls: PasswordStepCalls = {
  setPassword: async (body) => unwrap(await api.POST('/api/v1/me/password', { body })),
  putContact,
};

/** What the /set-password form submits. */
export interface PasswordStepVariables {
  newPassword: string;
  /** The real name and number for an account without them; `null` asks for the password only. */
  contact: ContactFields | null;
  /**
   * The account the step was started for, read once at submit and sent as `expectedAccountId`
   * on BOTH requests: the contact follows the password automatically, and a second reading of
   * the session in between could only name whoever the cookie belongs to by then.
   */
  accountId: string;
}

/**
 * The /set-password step of an email sign-up (ADR-0024, ADR-0043) as mutation options: the
 * first password, then — for an account without one (`contact` given) — the real name and
 * mobile number, then ONE refresh of `['me']`.
 *
 * One mutation rather than `useSetPassword` followed by `useUpdateContact`: that hook refreshes
 * `['me']` as soon as the password is saved, which swaps the form for its "password already
 * set" branch while the contact request is still to be made. Here `['me']` is refreshed once
 * both are done (the linked-account list changed: the account has a password now), and the
 * contact is written into it first so the gate on the next page already sees it. A refused
 * password changed nothing and refreshes nothing; a refused contact comes after a saved
 * password, so it refreshes too and surfaces as `ContactStepError`.
 *
 * Both requests carry the same `expectedAccountId` (`PasswordStepVariables.accountId`). The
 * contact leaves right after the password's answer, so another tab signing in as somebody else
 * during the password request used to send it with THAT account's cookie, overwriting its row
 * (A-PG-24). Now the server refuses it, and on a screen that was already stale the password is
 * refused first, so nothing at all is written. Either refusal refetches the session
 * (`onSessionChanged`) and refreshes nothing itself: the guard's reset refetches `['me']` for
 * the account that is really signed in. Every `['me']` write is scoped to the step's account
 * (`meBelongsTo`), so an answer landing after the guard already switched the tab leaves the
 * other account's profile alone.
 */
export function setPasswordAndContactOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  calls: PasswordStepCalls = passwordStepCalls,
) {
  return {
    mutationFn: async ({
      newPassword,
      contact,
      accountId,
    }: PasswordStepVariables): Promise<Contact | null> => {
      await calls.setPassword({ newPassword, expectedAccountId: accountId });
      if (contact === null) return null;
      try {
        return await calls.putContact({ ...contact, expectedAccountId: accountId });
      } catch (error) {
        throw new ContactStepError(error);
      }
    },
    onSuccess: async (contact: Contact | null, { accountId }: PasswordStepVariables) => {
      if (!meBelongsTo(queryClient, accountId)) return;
      if (contact !== null) await storeContact(queryClient, contact, accountId);
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
    onError: async (error: Error, { accountId }: PasswordStepVariables) => {
      const cause = error instanceof ContactStepError ? error.cause : error;
      if (isForAnotherAccount(cause)) {
        onSessionChanged();
        return;
      }
      // Only the half-done case changed anything on the server.
      if (error instanceof ContactStepError && meBelongsTo(queryClient, accountId)) {
        await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      }
    },
  };
}

/**
 * `setPasswordAndContactOptions` as the /set-password form's mutation, plus the account the
 * form sends (`accountId`, the session's user id) and `ready`, false until it is known.
 */
export function useSetPasswordAndContact() {
  const queryClient = useQueryClient();
  const { data: session, refetch: refetchSession } = useSession();
  const accountId = session?.user.id;
  const mutation = useMutation(
    setPasswordAndContactOptions(queryClient, () => void refetchSession()),
  );
  return { ...mutation, accountId, ready: accountId !== undefined };
}

/** How the /set-password step failed, which decides what its form says and where it goes. */
export type PasswordStepFailure =
  /** The password was refused as another account's: nothing was written. */
  | 'session-changed'
  /** The password was saved, then the contact refused as another account's. */
  | 'contact-session-changed'
  /** The password was saved, then the contact failed for any other reason. */
  | 'contact-failed'
  /** The password was not saved (network, server, validation). */
  | 'failed';

/**
 * The /set-password form's reading of a failed step. `contact-session-changed` is the half-done
 * case with a twist: the password WAS saved, for the account the step was started for, but the
 * cookie now belongs to somebody else — so the /onboarding the plain half-done case sends the
 * member to would be THAT account's, under a toast telling it that its contact failed. The
 * form says what happened instead and goes home; the account that set the password meets the
 * onboarding gate on its next sign-in.
 */
export function passwordStepFailure(error: unknown): PasswordStepFailure {
  if (error instanceof ContactStepError) {
    return isForAnotherAccount(error.cause) ? 'contact-session-changed' : 'contact-failed';
  }
  return isForAnotherAccount(error) ? 'session-changed' : 'failed';
}
