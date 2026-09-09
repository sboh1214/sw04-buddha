'use client';

import {
  type QueryClient,
  hashKey,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  type CreateDisputeBody,
  type Dispute,
  api,
  isApiError,
  unwrap,
  validationField,
} from '@/lib/api';
import { type SessionIdentity, cacheOwnerAccount } from '@/components/auth/session-cache-guard';
import { DISPUTES_KEY, marketKey, myDisputesKey } from '@/lib/market-keys';
import { restartQueries } from '@/lib/query-client';
import { useSession } from '@/lib/use-session';

/**
 * The dispute section's data layer (PLAN 5.5, 11.3; M5 design 5.2): the account's own dispute
 * on one market, and filing one.
 *
 * Nothing here decides what the section renders — `lib/dispute.ts` does, as a pure function —
 * and the two cache decisions that DO live here (what a filed row writes, what a refusal
 * corrects) are exported apart from the hooks, for the reason `use-trade.ts` gives: apps/web
 * runs vitest under `environment: 'node'`, so a decision sealed in a mutation callback is a
 * decision no unit test can reach.
 */

/**
 * Just enough of better-auth's `useSession().data` to answer "is anybody signed in" — the
 * shape `positionsQueryOptions` takes, for the same reason: the gate is a value a test can pin.
 */
type SessionLike = { user: unknown } | null;

/**
 * `GET /me/disputes?marketId=`: the account's one row on this market, or `null`.
 *
 * `null` rather than `undefined` for "none", because react-query reads an `undefined` answer as
 * a queryFn that returned nothing and keeps the query pending — and "no dispute" is the ordinary
 * answer for nearly every visitor of a resolving market, which is precisely the answer the
 * section needs in order to offer the button. The route pages, but UNIQUE `(market_id,
 * user_id)` bounds this filter at one row, so the first page is the whole answer.
 *
 * Gated on the session like every private query (use-portfolio.ts): the route needs the cookie,
 * and a signed-out request would take a 401 that the retry rule refuses to retry — the section
 * would draw an error where it means to draw "sign in".
 */
export function myDisputeQueryOptions(marketId: string, session?: SessionLike, wanted = true) {
  const id = marketId.toLowerCase();
  return {
    queryKey: myDisputesKey(id),
    queryFn: async (): Promise<Dispute | null> => {
      const { data } = unwrap(
        await api.GET('/api/v1/me/disputes', { params: { query: { marketId: id } } }),
      );
      return data[0] ?? null;
    },
    // `wanted` is the market's status through `disputeSectionWanted` (lib/dispute.ts): the
    // detail mounts this section for every market and only a resolving or finished one can draw
    // the row, so an open market's visit must not spend a private request on it.
    enabled: session != null && wanted,
  };
}

/**
 * The section's read. `isPending` covers the session lookup as well (use-me.ts): without it a
 * signed-in reload flashes the sign-in prompt, because a disabled query reports `isPending`
 * with no data of its own.
 */
export function useMyDispute(marketId: string, wanted = true) {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useQuery(myDisputeQueryOptions(marketId, session, wanted));
  return {
    ...query,
    isPending: sessionPending || (session != null && query.isPending),
    isLoggedIn: session != null,
  };
}

/**
 * `POST /markets/:id/disputes`. No `Idempotency-Key` and no `expectedAccountId`: the UNIQUE
 * `(market_id, user_id)` row already makes a retry after a lost answer a refusal rather than a
 * second dispute, and the body names no account — the cookie is the whole identity, and a
 * dispute filed for whoever the cookie now belongs to is that account's own to see.
 *
 * `onDone` fires BEFORE the cache work so the toast and the closing dialog are instant, and the
 * cache work is awaited so the button stays disabled (`isPending`) until the row has landed —
 * the `useTrade` precedent.
 */
export function useFileDispute(marketId: string, onDone?: (dispute: Dispute) => void) {
  const queryClient = useQueryClient();
  // A refetch of the session is what lets `SessionCacheGuard` reset the caches when the cookie
  // turns out to belong to nobody: `void`, because the reset it resolves to is not waited on.
  const { refetch: refetchSession } = useSession();
  return useMutation({
    // The account that PRESSED, read from the guard rather than from a render closure
    // (session-cache-guard.tsx says why: react-query pushes fresh options into a pending
    // mutation from an effect, so a closure keeps naming the account that started the work
    // however long the tab has since belonged to somebody else). query-core stores what this
    // answers as the mutation's own `context` and hands it to `onSuccess`, so the reading
    // survives the section unmounting and needs no ref.
    onMutate: () => ({ sent: cacheOwnerAccount() }),
    mutationFn: async (body: CreateDisputeBody) =>
      unwrap(
        await api.POST('/api/v1/markets/{id}/disputes', {
          params: { path: { id: marketId } },
          body,
        }),
      ).data,
    onSuccess: async (dispute, _body, { sent }) => {
      // A dispute answers for the account that SENT it, and this tab may no longer BE that
      // account: nothing cancels an in-flight POST, so a sign-out and a sign-in as somebody
      // else would land A's `reason` and A's `evidenceUrl` — free text nobody but A and the
      // admins may read — in the cache `SessionCacheGuard` has just reset for B, under a
      // 이의를 접수했습니다 toast telling B they filed it. Unlike a trade, NOTHING here is
      // public, so a mismatch writes nothing at all: there is no `applyTradeMarket` half to
      // keep. And nothing would undo it — no realtime event carries a dispute (PLAN 8 has
      // none) and `applyDisputeFiled` excludes the very key it seeds from the invalidation
      // that follows, so B would go on reading A's objection, without the 이의 제기 button,
      // until that entry happened to be refetched.
      if (disputeAnswerScope({ sent, account: cacheOwnerAccount() }) === 'refetch') {
        // Re-asked rather than dropped, because `sent` is a BELIEF and not a proof: the body
        // names no account (see above), so unlike `tradeAnswerScope`'s server-compared
        // `expectedAccountId` this reading can be wrong in the OTHER direction too — the
        // cookie may already have been B's when the POST left, in which case the row the
        // server filed is B's OWN and dropping it would leave the section offering 이의 제기
        // until the server refuses the next press as DUPLICATE_REQUEST.
        //
        // `restartQueries` for the reason `applyDisputeError`'s DUPLICATE_REQUEST branch uses
        // it: a first fetch that left before this row was committed would otherwise be waited
        // on rather than replaced.
        await restartQueries(queryClient, DISPUTES_KEY);
        return;
      }
      onDone?.(dispute);
      await applyDisputeFiled(queryClient, dispute);
    },
    onError: async (error) => {
      await applyDisputeError(queryClient, marketId, error, () => void refetchSession());
    },
  });
}

/** What a dispute answer may still do in this tab. */
export type DisputeAnswerScope = 'file' | 'refetch';

/**
 * Whether a filed dispute still belongs to whoever is looking at this tab — `tradeAnswerScope`'s
 * job (use-trade.ts) for the one answer in this app that is private the whole way through.
 *
 * Both readings come from `cacheOwnerAccount()` (session-cache-guard.tsx), which is module state
 * published from an effect above every screen: `sent` is what it said when the button was
 * pressed, `account` what it says now. Neither may be read from a render closure, for the reason
 * that module exists at all.
 *
 * Two things make this NOT a copy of the trade gate:
 *
 * - there is no proof. A trade sends `expectedAccountId` and the server compares it with the
 *   cookie before it reserves anything, so a 2xx PROVES whose trade it was. A dispute sends no
 *   such field on purpose (`useFileDispute` says why) and `Dispute` carries no `userId` — only
 *   `AdminDispute` does — so the press-time reading is the best this tab has, and it can be
 *   stale in either direction. That is why `refetch` means "ask the server", not "throw away".
 * - there is no public half. `applyTradeMarket` exists because a market moved whoever the tab
 *   belongs to now; a dispute's reason, evidence URL and admin note are one account's, so a
 *   mismatch keeps none of it.
 *
 * `undefined` on either side means the guard has not spoken — before better-auth's first answer,
 * or in a tree that does not mount it (this app's node tests, a future embed) — and answers
 * `file`, `tradeAnswerScope`'s permissive fallback: nothing of anybody's is on screen to
 * overwrite there, and refusing would swallow the toast and the seed the section flips on for an
 * ordinary filer.
 */
export function disputeAnswerScope(a: {
  sent: SessionIdentity | undefined;
  account: SessionIdentity | undefined;
}): DisputeAnswerScope {
  if (a.sent === undefined || a.account === undefined) return 'file';
  return a.sent === a.account ? 'file' : 'refetch';
}

/**
 * The filed row into the entry the section reads, then every OTHER entry under the root
 * re-asked.
 *
 * The seed is the primary path, not an optimisation: the answer IS the row, the section flips
 * from the button to 이의 접수됨 on it, and no realtime event carries a dispute (PLAN 8 has
 * none), so nothing else would deliver it. The invalidation deliberately EXCLUDES the entry
 * just seeded — a refetch of it could only restate what was written, which is the 남발 PLAN
 * 11.5 refuses — while any other list of the account's disputes (none is mounted on the detail
 * today, but the root is theirs) must not go on saying there is none.
 *
 * Keyed on the ROW's `marketId`, not the mutation's argument: the API answers with the
 * canonical lower-cased id, which is the string the section's key is built from.
 *
 * Deliberately unguarded: WHOSE answer this is, is `disputeAnswerScope`'s call in
 * `useFileDispute`, which never reaches this writer for another account's row — the
 * `applyTradeResult` split, where the gate lives in the hook and the writer stays dumb. The
 * exclusion above is correct on the healthy path and is not what that gate replaces.
 */
export function applyDisputeFiled(queryClient: QueryClient, dispute: Dispute): Promise<void> {
  const seeded = myDisputesKey(dispute.marketId);
  queryClient.setQueryData<Dispute | null>(seeded, dispute);
  const seededHash = hashKey(seeded);
  return queryClient.invalidateQueries({
    queryKey: DISPUTES_KEY,
    predicate: (query) => hashKey(query.queryKey) !== seededHash,
  });
}

/**
 * Every refusal corrects the cache it contradicts, so the section re-derives through
 * `disputeSectionView` from a cache that agrees with the server (the `applyTradeError`
 * table's rule). Awaited by the caller, so the dialog's button stays disabled until the
 * corrected row has landed.
 *
 * - DISPUTE_WINDOW_CLOSED: the MARKET row is stale — its `disputeUntil` is past, or its status
 *   has moved to settled/voided under the reader — so it is re-asked. `restartQueries` rather
 *   than a bare invalidation, the fourth time that distinction has mattered in this app: an
 *   unseeded first fetch still in flight would otherwise be waited on rather than replaced.
 *   The dispute row itself is not touched; there is none.
 * - DUPLICATE_REQUEST: a row EXISTS that the cache does not show — filed in another tab, or by
 *   an earlier press whose answer was lost — so the account's disputes are re-asked and the
 *   section will draw 이의 접수됨 from the refetch.
 * - VALIDATION_ERROR naming `status`: the market is not resolving at all (open, closed), which
 *   the cached row must have said wrongly; re-ask the market.
 * - UNAUTHENTICATED: the cookie belongs to nobody now — have better-auth refetch, so
 *   `SessionCacheGuard` resets the caches and the section flips to the sign-in prompt.
 * - NOT_FOUND: no such market on the public routes (`dispute.service.ts` answers it for a draft
 *   as well as for an unknown id); the detail's own row is re-asked and answers the same.
 * - a field-naming VALIDATION_ERROR: nothing in any cache is wrong; the dialog shows it.
 */
export async function applyDisputeError(
  queryClient: QueryClient,
  marketId: string,
  error: unknown,
  onSessionChanged: () => void,
): Promise<void> {
  if (isApiError(error, 'DISPUTE_WINDOW_CLOSED')) {
    await restartQueries(queryClient, marketKey(marketId));
    return;
  }
  if (isApiError(error, 'DUPLICATE_REQUEST')) {
    await restartQueries(queryClient, DISPUTES_KEY);
    return;
  }
  if (isApiError(error, 'VALIDATION_ERROR') && validationField(error) === 'status') {
    await restartQueries(queryClient, marketKey(marketId));
    return;
  }
  if (isApiError(error, 'UNAUTHENTICATED')) {
    onSessionChanged();
    return;
  }
  if (isApiError(error, 'NOT_FOUND')) {
    await queryClient.invalidateQueries({ queryKey: marketKey(marketId) });
  }
}
