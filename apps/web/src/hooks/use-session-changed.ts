'use client';

import { isForAnotherAccount } from '@/lib/api';
import { type AuthClientError, isAuthForAnotherAccount } from '@/lib/auth-client';
import { useSession } from '@/lib/use-session';

/**
 * What an admin write does with the refusal that the cookie is another account's
 * (`isForAnotherAccount` — the write named the admin on screen, `useOperatorId`, and another tab
 * signed in as someone else, ADR-0092): asks for the session again, so SessionCacheGuard empties
 * the cache and the screen shows the account that is really signed in, as the operator writes of
 * ADR-0091 do (`useRefreshAdminAccounts`, `moderationOptions`). Answers whether the error was that
 * refusal, so the caller shows `copy.sessionChanged` and refreshes nothing else — the reset reads
 * everything again. Apart from `use-operator.ts`, whose admin is never the session's: the session
 * is only asked again here, never read for an account.
 */
export function useSessionChanged(): (error: unknown) => boolean {
  const { refetch: refetchSession } = useSession();
  return (error: unknown) => {
    if (!isForAnotherAccount(error)) return false;
    void refetchSession();
    return true;
  };
}

/**
 * The same for the better-auth writes of MY 설정 — changing the password, starting a change of
 * address, linking a social login (ADR-0092) — whose failures are better-auth's `{ error }` rather
 * than a thrown ApiError: the card named the account it was drawn for (its `Me`'s id), the cookie
 * is another account's, and nothing was written. Asks for the session again and answers whether it
 * was that refusal, so the card shows `copy.sessionChanged`.
 */
export function useAuthSessionChanged(): (error: AuthClientError | null | undefined) => boolean {
  const { refetch: refetchSession } = useSession();
  return (error) => {
    if (!isAuthForAnotherAccount(error)) return false;
    void refetchSession();
    return true;
  };
}
