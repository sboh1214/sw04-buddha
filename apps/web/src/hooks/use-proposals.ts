'use client';

import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { meBelongsTo, refreshOwnMe } from '@/hooks/use-me';
import {
  type CreateProposalBody,
  type Proposal,
  api,
  isForAnotherAccount,
  unwrap,
} from '@/lib/api';
import { MY_PROPOSALS_KEY, PROPOSALS_KEY, proposalFailure } from '@/lib/proposals';
import { useSession } from '@/lib/use-session';

/**
 * 내 제안 (#77, ADR-0089): the member's own proposals, the form's submit and the 철회. Private —
 * `['proposals']` is in `PRIVATE_QUERY_ROOTS`, so nothing of it is ever dehydrated into a page —
 * and every read waits for the session like `useWatchlist`: the routes need the cookie, and a
 * signed-out request would take a 401 the retry rule refuses to retry.
 *
 * The query and mutation options are exported apart from the hooks so they can be tested under
 * the node runner (use-proposals.test.ts), as use-watchlist.ts does.
 */

/** Just enough of better-auth's session to say whether anybody is signed in (use-portfolio.ts). */
type SessionLike = { user: unknown } | null;

/** One page of `GET /me/proposals`: newest first, the cursor of the next page. */
export interface ProposalPage {
  items: Proposal[];
  nextCursor: string | null;
}

/**
 * `GET /me/proposals`, one page per 더 보기 press (the API's default page, 20) — newest first, as
 * the API orders them. 내 제안 and its preview on the MY summary share it.
 */
export function myProposalsInfiniteQueryOptions(session?: SessionLike) {
  return {
    queryKey: MY_PROPOSALS_KEY,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }): Promise<ProposalPage> => {
      const { data, meta } = unwrap(
        await api.GET('/api/v1/me/proposals', {
          params: { query: pageParam === undefined ? {} : { cursor: pageParam } },
        }),
      );
      return { items: data, nextCursor: meta.nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ProposalPage) => last.nextCursor ?? undefined,
    enabled: session != null,
  };
}

/**
 * 내 제안's list and the MY summary's preview of it. `isPending` covers the session lookup too, as
 * `useWatchlist` does.
 */
export function useMyProposals() {
  const { data: session, isPending: sessionPending } = useSession();
  const query = useInfiniteQuery(myProposalsInfiniteQueryOptions(session));
  return {
    ...query,
    isPending: sessionPending || (session != null && query.isPending),
    isLoggedIn: session != null,
  };
}

/**
 * `POST /me/proposals` as mutation options. The answer is the proposal, 접수; the list is asked again
 * (it is usually not mounted on the form, so that only marks it stale for 내 제안, where the form goes
 * next). A refusal that says the screen is out of date asks for what it is out of date about: the
 * session when the cookie is another account's (`onSessionChanged`), `['me']` when the onboarding
 * or the 본인확인 is not done any more — the onboarding gate follows it (`proposalFailure`).
 */
export function createProposalOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  post: (body: CreateProposalBody) => Promise<Proposal> = postProposal,
) {
  return {
    mutationFn: post,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PROPOSALS_KEY });
    },
    onError: async (error: Error, body: CreateProposalBody) => {
      // Only the kind is read here — the sentence (a restriction's end among it) is the form's.
      const failure = proposalFailure(error, (iso) => iso);
      if (failure.kind === 'session') onSessionChanged();
      if (failure.kind === 'refresh') await refreshOwnMe(queryClient, body.expectedAccountId);
    },
  };
}

async function postProposal(body: CreateProposalBody): Promise<Proposal> {
  return unwrap(await api.POST('/api/v1/me/proposals', { body })).data;
}

/**
 * The form's submit. Its body names the account the form was drawn for — the `Me` it was drawn
 * from (`ProposalFields`' `accountId`) — never the session's: in the render between the session
 * naming another account and SessionCacheGuard's reset the session already says B while the form
 * is still A's, and a proposal naming B would be taken with B's cookie — B's 접수 proposal, typed
 * on A's screen (ADR-0091). So it offers no account of its own, and nothing waits for the session:
 * the form is drawn only once `GET /me` answered.
 */
export function useCreateProposal() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  return useMutation(createProposalOptions(queryClient, () => void refetchSession()));
}

/** What a 철회 press sends: the proposal and the account the screen shows. */
export interface RetractVariables {
  id: string;
  expectedAccountId: string;
}

async function postRetract({ id, expectedAccountId }: RetractVariables): Promise<Proposal> {
  return unwrap(
    await api.POST('/api/v1/me/proposals/{id}/retract', {
      params: { path: { id } },
      body: { expectedAccountId },
    }),
  ).data;
}

/**
 * Replaces one proposal in the cached pages with the server's answer, so the list shows 철회 at
 * once — the refetch that follows may fail, and the 철회 button must not stay on a proposal that is
 * not 접수 any more. Only into the account's own cache (`meBelongsTo`): an answer that lands after
 * the tab switched accounts writes nothing.
 */
export function storeProposal(queryClient: QueryClient, proposal: Proposal, account: string) {
  if (!meBelongsTo(queryClient, account)) return;
  queryClient.setQueryData<{ pages: ProposalPage[]; pageParams: unknown[] }>(
    MY_PROPOSALS_KEY,
    (held) =>
      held === undefined
        ? held
        : {
            ...held,
            pages: held.pages.map((page) => ({
              ...page,
              items: page.items.map((item) => (item.id === proposal.id ? proposal : item)),
            })),
          },
  );
}

/**
 * `POST /me/proposals/:id/retract` as mutation options: the answer goes into the list
 * (`storeProposal`), then the list is read again — on a refusal too, since a 철회 refused for its
 * status means the review started meanwhile, and the list should say so. The onboarding never
 * refuses a 철회 (signed in is enough, owner decision 2026-10-19), so nothing here asks for
 * `['me']`; a cookie of another account asks for the session.
 */
export function retractProposalOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  post: (variables: RetractVariables) => Promise<Proposal> = postRetract,
) {
  const settle = () => queryClient.invalidateQueries({ queryKey: PROPOSALS_KEY });
  return {
    mutationFn: post,
    onSuccess: async (proposal: Proposal, variables: RetractVariables) => {
      storeProposal(queryClient, proposal, variables.expectedAccountId);
      await settle();
    },
    onError: async (error: Error) => {
      if (isForAnotherAccount(error)) onSessionChanged();
      await settle();
    },
  };
}

/**
 * 내 제안's 철회. Its body names the account whose list the screen shows — MY's `Me`
 * (`ProposalsBody`' `accountId`) — never the session's: in the render between the session naming
 * another account and SessionCacheGuard's reset the session already says B while the list is still
 * A's (ADR-0091). So it offers no account of its own.
 */
export function useRetractProposal() {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  return useMutation(retractProposalOptions(queryClient, () => void refetchSession()));
}
