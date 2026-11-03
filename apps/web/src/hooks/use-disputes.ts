'use client';

import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useInstantReached } from '@/hooks/use-instant-reached';
import { refreshOwnMe } from '@/hooks/use-me';
import {
  type Market,
  type MyDispute,
  type MyMarketDispute,
  type SubmitDisputeBody,
  api,
  isForAnotherAccount,
  unwrap,
} from '@/lib/api';
import {
  DISPUTES_KEY,
  disputeSubmitFailure,
  myDisputesKey,
  myMarketDisputeKey,
  myMarketDisputesKey,
  openDisputeDeadline,
} from '@/lib/disputes';
import { marketKey } from '@/lib/market-keys';
import { restartQueries } from '@/lib/query-client';
import { useSession } from '@/lib/use-session';

/**
 * 판정 이의 (#175, ADR-0104): the member's own disputes and standing, the submission and the 철회,
 * and the one-shot timer that takes the submission link away at the 이의 기한. Private —
 * `['disputes']` is in `PRIVATE_QUERY_ROOTS`, so nothing of it is ever dehydrated into a page — and
 * every read waits for the session like `useMyProposals`: the routes need the cookie, and a
 * signed-out request would take a 401 the retry rule refuses to retry.
 *
 * The query and mutation options are exported apart from the hooks so they can be tested under
 * the node runner (use-disputes.test.ts), as use-proposals.ts does.
 */

/** Just enough of better-auth's session to say whether anybody is signed in (use-portfolio.ts). */
type SessionLike = { user: unknown } | null;

/**
 * `GET /me/disputes/markets/:marketId`: whether the account may dispute the market's current
 * judgement version now, that version, and the account's dispute of it — the submission screen's
 * state. By the market's uuid (the screen read the public market first), under the account the
 * screen shows (`accountId`, `myMarketDisputeKey`): read only once it is known and signed in.
 */
export function myMarketDisputeQueryOptions(
  marketId: string,
  accountId: string | undefined,
  session?: SessionLike,
) {
  return {
    queryKey: myMarketDisputeKey(marketId, accountId),
    queryFn: async (): Promise<MyMarketDispute> =>
      unwrap(
        await api.GET('/api/v1/me/disputes/markets/{marketId}', {
          params: { path: { marketId } },
        }),
      ).data,
    enabled: session != null && accountId !== undefined,
  };
}

/** The submission screen's standing for `accountId`. `isPending` covers the session lookup too. */
export function useMyMarketDispute(marketId: string, accountId: string | undefined) {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useQuery(myMarketDisputeQueryOptions(marketId, accountId, session));
  return {
    ...query,
    isPending: sessionPending || (session != null && query.isPending),
    isLoggedIn: session != null,
  };
}

/** One page of `GET /me/disputes`: newest first, the cursor of the next page. */
export interface DisputePage {
  items: MyDispute[];
  nextCursor: string | null;
}

/**
 * `GET /me/disputes`, one page per 더 보기 press (the API's default page, 20), newest first, under
 * the account the screen shows (`accountId`, `myDisputesKey`).
 */
export function myDisputesInfiniteQueryOptions(
  accountId: string | undefined,
  session?: SessionLike,
) {
  return {
    queryKey: myDisputesKey(accountId),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<DisputePage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/me/disputes', {
          params: { query: pageParam === undefined ? {} : { cursor: pageParam } },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: DisputePage) => last.nextCursor ?? undefined,
    enabled: session != null && accountId !== undefined,
  };
}

/**
 * MY '판정 이의' for `accountId`. `isPending` covers the session lookup too, as `useMyProposals`
 * does — and the account's: the list waits for `GET /me`.
 */
export function useMyDisputes(accountId: string | undefined) {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useInfiniteQuery(myDisputesInfiniteQueryOptions(accountId, session));
  return {
    ...query,
    isPending: sessionPending || (session != null && query.isPending),
    isLoggedIn: session != null,
  };
}

/**
 * The member's standing on a market after its `market:status` (#175, ADR-0104): a 기각 or 수용 —
 * or a submission or 철회 in another tab — republishes the event with the status unchanged, and
 * neither the decision nor its reason is in any event, so an open submission screen asks again.
 * A refetch the event cannot spare (realtime-provider's RULE, its first kind); `restartQueries`
 * asks only where the screen is open, and a first read begun before the decision is asked again.
 */
export function refreshMyMarketDisputeOnStatus(
  queryClient: QueryClient,
  marketId: string,
): Promise<void> {
  return restartQueries(queryClient, myMarketDisputesKey(marketId));
}

/**
 * Puts one dispute the server answered with into the caches that hold it — the MY list's pages and
 * its market's standing — so the screen shows its new status at once: the refetch that follows may
 * fail, and the 철회 button must not stay on a dispute that is not pending any more. Only into the
 * entries of `account` — the `expectedAccountId` the server compared with the cookie
 * (`myDisputesKey`, `myMarketDisputeKey`): an answer that lands after the tab switched accounts
 * writes nothing into what another account's screen draws.
 */
export function storeDispute(queryClient: QueryClient, dispute: MyDispute, account: string) {
  queryClient.setQueryData<{ pages: DisputePage[]; pageParams: unknown[] }>(
    myDisputesKey(account),
    (held) =>
      held === undefined
        ? held
        : {
            ...held,
            pages: held.pages.map((page) => ({
              ...page,
              items: page.items.map((item) => (item.id === dispute.id ? dispute : item)),
            })),
          },
  );
  queryClient.setQueryData<MyMarketDispute>(
    myMarketDisputeKey(dispute.market.id, account),
    (held) =>
      held === undefined || held.judgementVersion !== dispute.judgementVersion
        ? held
        : // The one per version: once one is submitted the standing is `duplicate`, retracted or not.
          { ...held, eligibility: 'duplicate', dispute },
  );
}

/** What a submission sends: the market and the body (the version, the links, the reason). */
export interface SubmitDisputeVariables {
  marketId: string;
  body: SubmitDisputeBody;
}

async function postDispute({ marketId, body }: SubmitDisputeVariables): Promise<MyDispute> {
  return unwrap(
    await api.POST('/api/v1/markets/{id}/disputes', { params: { path: { id: marketId } }, body }),
  ).data;
}

/**
 * `POST /markets/:id/disputes` as mutation options. The answer — the dispute, 검토 중 — goes into
 * the standing (`storeDispute`), then the member's disputes and the market are read again: the
 * market reads '이의 검토 중' now (the API republishes `market:status` too, which an open detail
 * follows). A refusal that says the screen is out of date asks for what it is out of date about:
 * the session when the cookie is another account's (`onSessionChanged`), `['me']` when the
 * onboarding is not done any more — the onboarding gate follows it — and the standing for a
 * DISPUTE_NOT_ALLOWED (the deadline came, the version was replaced, a dispute sent elsewhere).
 */
export function submitDisputeOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  post: (variables: SubmitDisputeVariables) => Promise<MyDispute> = postDispute,
) {
  return {
    mutationFn: post,
    onSuccess: async (dispute: MyDispute, variables: SubmitDisputeVariables) => {
      storeDispute(queryClient, dispute, variables.body.expectedAccountId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: DISPUTES_KEY }),
        queryClient.invalidateQueries({ queryKey: marketKey(variables.marketId) }),
      ]);
    },
    onError: async (error: Error, variables: SubmitDisputeVariables) => {
      const failure = disputeSubmitFailure(error);
      if (failure.kind === 'session') onSessionChanged();
      if (failure.kind === 'onboarding') {
        await refreshOwnMe(queryClient, variables.body.expectedAccountId);
      }
      if (failure.kind === 'refusal' && failure.refresh) {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: myMarketDisputeKey(variables.marketId, variables.body.expectedAccountId),
          }),
          queryClient.invalidateQueries({ queryKey: marketKey(variables.marketId) }),
        ]);
      }
    },
  };
}

/**
 * The submission screen's submit. Its body names the account the form was drawn for — the `Me` it
 * was drawn from — never the session's (ADR-0091, as `useCreateProposal`): the form waits for
 * `GET /me` and is keyed by that account.
 */
export function useSubmitDispute() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  return useMutation(submitDisputeOptions(queryClient, () => void refetchSession()));
}

/** What a 철회 press sends: the dispute, its market and the account the screen shows. */
export interface RetractDisputeVariables {
  id: string;
  marketId: string;
  expectedAccountId: string;
}

async function postRetract({ id, expectedAccountId }: RetractDisputeVariables): Promise<MyDispute> {
  return unwrap(
    await api.POST('/api/v1/me/disputes/{disputeId}/retract', {
      params: { path: { disputeId: id } },
      body: { expectedAccountId },
    }),
  ).data;
}

/**
 * `POST /me/disputes/:id/retract` as mutation options: the answer goes into the caches
 * (`storeDispute`), then the member's disputes and the market are read again — on a refusal too,
 * since a 철회 refused for its status or its deadline means the screen is out of date. The
 * onboarding never refuses a 철회 (signed in is enough, as a proposal's), so nothing here asks for
 * `['me']`; a cookie of another account asks for the session.
 */
export function retractDisputeOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  post: (variables: RetractDisputeVariables) => Promise<MyDispute> = postRetract,
) {
  const settle = (marketId: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: DISPUTES_KEY }),
      queryClient.invalidateQueries({ queryKey: marketKey(marketId) }),
    ]);
  return {
    mutationFn: post,
    onSuccess: async (dispute: MyDispute, variables: RetractDisputeVariables) => {
      storeDispute(queryClient, dispute, variables.expectedAccountId);
      await settle(variables.marketId);
    },
    onError: async (error: Error, variables: RetractDisputeVariables) => {
      if (isForAnotherAccount(error)) onSessionChanged();
      await settle(variables.marketId);
    },
  };
}

/**
 * A dispute's 철회 (the submission screen's and MY's). Its body names the account whose screen it
 * is — the `Me` it was drawn from — never the session's (ADR-0091). So it offers no account of its
 * own.
 */
export function useRetractDispute() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  return useMutation(retractDisputeOptions(queryClient, () => void refetchSession()));
}

/**
 * Whether the market takes 판정 이의 now, as a screen shows it (#173 items 5·6, ADR-0104): the API's
 * `disputeOpen` — the server's clock at the read — until its 이의 기한 comes on this screen's
 * clock. A held market publishes nothing at its deadline (the worker skips it), so a one-shot timer
 * takes the link and the note away then, without a reload (`useInstantReached`, whose core this
 * was before #142 waited for a next review time the same way); a later read that says otherwise
 * wins (an approved correction's new deadline, #176, ADR-0105, starts a new wait).
 *
 * `anchor` is the server's own instant at the read when the screen has one (the detail's `now`,
 * `detailWindowEnd`): the deadline is then judged at that instant plus the time elapsed since, as
 * the countdown measures (`tickingNow`), so a browser clock that runs ahead does not take the link
 * away early. Without one, the browser's clock. Never a clock read in render: the first render
 * — the server's HTML — is the API's flag alone, and the timer runs in an effect. `onClosed` runs
 * once the deadline comes on screen (the detail reads the market again then, for its label).
 */
export function useDisputeOpen(
  market: Pick<Market, 'disputeOpen' | 'disputeDeadline'>,
  anchor?: number,
  onClosed?: () => void,
): boolean {
  const deadline = openDisputeDeadline(market);
  // Open again for a new deadline (another read, another version): the timer waits for it afresh.
  const closed = useInstantReached(deadline, anchor, onClosed);
  return deadline !== null && !closed;
}
