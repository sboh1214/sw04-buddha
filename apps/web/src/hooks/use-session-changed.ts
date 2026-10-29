'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { isForAnotherAccount } from '@/lib/api';
import { AUTH_ERROR, type AuthClientError, isAuthForAnotherAccount } from '@/lib/auth-client';
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

/**
 * What MY 설정's 인증 메일 다시 보내기 does with better-auth's 400 EMAIL_MISMATCH: the card asked for
 * the address it was drawn with, and better-auth mails a signed-in request only to its own
 * account's address — so the cookie's account no longer has that address: another account signed
 * in in another window (the card is still A's while the cookie is B's — nothing was mailed, ADR-0092
 * 결정 4), or this account's address changed elsewhere. Asks for the session again — so
 * SessionCacheGuard puts the account really signed in on screen — and `GET /me` again, so the card
 * shows that account's address as it now is. The card's message stays the generic one (owner
 * decision 2026-10-26 17:21 answer 5 «다시 읽고 일반 문구 유지»). Answers whether it was that refusal.
 * Like the two above, it never reads the session for an account.
 */
export function useAuthEmailMismatch(): (error: AuthClientError | null | undefined) => boolean {
  const { refetch: refetchSession } = useSession();
  const queryClient = useQueryClient();
  return (error) => {
    if (error?.code !== AUTH_ERROR.EMAIL_MISMATCH) return false;
    void refetchSession();
    void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    return true;
  };
}
