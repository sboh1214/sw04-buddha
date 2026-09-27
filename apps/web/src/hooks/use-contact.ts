'use client';

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { api, unwrap, type Contact, type ContactBody, type Me } from '@/lib/api';

/**
 * The account's real name and mobile number (ADR-0043). There is no read of its own: `GET /me`
 * carries `contact` (null until given), so every screen reads it from `useMe()` — the gate, the
 * settings card and /onboarding all observe the one `['me']` entry.
 *
 * The cache writer and the /set-password step's mutation are exported apart from their hooks,
 * for the reason `use-trade.ts` gives: apps/web runs vitest under `environment: 'node'`, so a
 * decision sealed in a hook body is one no unit test can reach (use-contact.test.ts).
 */

async function putContact(body: ContactBody): Promise<Contact> {
  return unwrap(await api.PUT('/api/v1/me/contact', { body })).data;
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
 */
export async function storeContact(queryClient: QueryClient, contact: Contact): Promise<void> {
  await queryClient.cancelQueries({ queryKey: ME_QUERY_KEY, exact: true });
  const held = queryClient.getQueryData<Me>(ME_QUERY_KEY);
  if (held) {
    queryClient.setQueryData<Me>(ME_QUERY_KEY, { ...held, contact });
    return;
  }
  await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY, exact: true });
}

/** `PUT /api/v1/me/contact` (upsert): /onboarding and the settings card. */
export function useUpdateContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: putContact,
    // Returned, so `mutateAsync` settles only once `['me']` holds the contact.
    onSuccess: (contact) => storeContact(queryClient, contact),
  });
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
  setPassword: (newPassword: string) => Promise<unknown>;
  putContact: (body: ContactBody) => Promise<Contact>;
}

const passwordStepCalls: PasswordStepCalls = {
  setPassword: async (newPassword) =>
    unwrap(await api.POST('/api/v1/me/password', { body: { newPassword } })),
  putContact,
};

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
 */
export function setPasswordAndContactOptions(
  queryClient: QueryClient,
  calls: PasswordStepCalls = passwordStepCalls,
) {
  return {
    mutationFn: async ({
      newPassword,
      contact,
    }: {
      newPassword: string;
      contact: ContactBody | null;
    }): Promise<Contact | null> => {
      await calls.setPassword(newPassword);
      if (contact === null) return null;
      try {
        return await calls.putContact(contact);
      } catch (error) {
        throw new ContactStepError(error);
      }
    },
    onSuccess: async (contact: Contact | null) => {
      if (contact !== null) await storeContact(queryClient, contact);
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
    onError: async (error: Error) => {
      // Only the half-done case changed anything on the server.
      if (error instanceof ContactStepError) {
        await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      }
    },
  };
}

/** `setPasswordAndContactOptions` as the /set-password form's mutation. */
export function useSetPasswordAndContact() {
  const queryClient = useQueryClient();
  return useMutation(setPasswordAndContactOptions(queryClient));
}
