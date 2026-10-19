import { MutationObserver, type QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type CreateProposalBody, type Me, type Proposal } from '@/lib/api';
import { isPrivateQueryKey } from '@/lib/market-keys';
import { MY_PROPOSALS_KEY, PROPOSALS_KEY } from '@/lib/proposals';
import { getQueryClient } from '@/lib/query-client';
import { ME_QUERY_KEY } from './use-me';
import {
  type ProposalPage,
  type RetractVariables,
  createProposalOptions,
  myProposalsInfiniteQueryOptions,
  retractProposalOptions,
} from './use-proposals';

/**
 * 내 제안's cache writes (#77, ADR-0089), driven through the REAL QueryClient under node — the
 * options are exported apart from their hooks for this (use-watchlist.test.ts does the same).
 */

const me = (id: string) => ({ id }) as Me;

const proposal = (id: string, status: Proposal['status']): Proposal => ({
  id,
  question: `질문 ${id}`,
  deadline: '2026-12-31',
  yesCondition: 'YES 조건',
  expectedSources: '출처',
  background: null,
  category: null,
  status,
  createdAt: '2026-10-19T03:00:00.000Z',
  statusChangedAt: '2026-10-19T03:00:00.000Z',
  rejection: null,
  adoption: null,
});

const body = (account = 'user-1'): CreateProposalBody => ({
  question: '질문',
  deadline: '2026-12-31',
  yesCondition: 'YES 조건',
  expectedSources: '출처',
  background: null,
  categoryId: null,
  expectedAccountId: account,
});

const refused = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);
const forAnotherAccount = () =>
  refused(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'another account' }]);

/** The list as 내 제안 holds it: one page, newest first. */
function seedList(queryClient: QueryClient, items: Proposal[]) {
  queryClient.setQueryData<{ pages: ProposalPage[]; pageParams: unknown[] }>(MY_PROPOSALS_KEY, {
    pages: [{ items, nextCursor: null }],
    pageParams: [undefined],
  });
}

const listed = (queryClient: QueryClient) =>
  queryClient
    .getQueryData<{ pages: ProposalPage[] }>(MY_PROPOSALS_KEY)
    ?.pages.flatMap((page) => page.items);

const invalidated = (queryClient: QueryClient, key: readonly unknown[]) =>
  queryClient.getQueryState(key)?.isInvalidated;

describe('the 내 제안 query', () => {
  it('is private, waits for a session, and pages on its cursor until a null one', () => {
    const options = myProposalsInfiniteQueryOptions({ user: {} });
    expect(options.queryKey).toEqual(['proposals', 'mine']);
    expect(isPrivateQueryKey(options.queryKey)).toBe(true);
    expect(options.enabled).toBe(true);
    expect(myProposalsInfiniteQueryOptions(null).enabled).toBe(false);
    expect(myProposalsInfiniteQueryOptions(undefined).enabled).toBe(false);
    expect(options.initialPageParam).toBeUndefined();
    expect(options.getNextPageParam({ items: [], nextCursor: 'c2' })).toBe('c2');
    expect(options.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();
  });
});

describe('createProposalOptions', () => {
  it('marks 내 제안 for a refetch once the proposal is taken', async () => {
    const queryClient = getQueryClient();
    seedList(queryClient, []);
    const post = vi.fn((_: CreateProposalBody) => Promise.resolve(proposal('p1', 'submitted')));
    const observer = new MutationObserver(
      queryClient,
      createProposalOptions(queryClient, () => undefined, post),
    );
    await observer.mutate(body());
    expect(post.mock.calls[0]?.[0]).toEqual(body());
    expect(invalidated(queryClient, MY_PROPOSALS_KEY)).toBe(true);
    queryClient.clear();
  });

  it('asks for the session when the cookie is another account’s, and for ["me"] when the onboarding is not done', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(ME_QUERY_KEY, me('user-1'));
    const sessionChanged = vi.fn();
    const failWith = (error: Error) =>
      new MutationObserver(
        queryClient,
        createProposalOptions(queryClient, sessionChanged, () => Promise.reject(error)),
      );

    await expect(failWith(forAnotherAccount()).mutate(body())).rejects.toThrow();
    expect(sessionChanged).toHaveBeenCalledTimes(1);
    expect(invalidated(queryClient, ME_QUERY_KEY)).toBe(false);

    await expect(failWith(refused(409, 'ONBOARDING_REQUIRED')).mutate(body())).rejects.toThrow();
    expect(sessionChanged).toHaveBeenCalledTimes(1);
    expect(invalidated(queryClient, ME_QUERY_KEY)).toBe(true);
    queryClient.clear();
  });

  it('leaves another account’s ["me"] alone, and does nothing for a limit', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(ME_QUERY_KEY, me('user-2'));
    const onboarding = new MutationObserver(
      queryClient,
      createProposalOptions(
        queryClient,
        () => undefined,
        () => Promise.reject(refused(409, 'ONBOARDING_REQUIRED')),
      ),
    );
    await expect(onboarding.mutate(body('user-1'))).rejects.toThrow();
    expect(invalidated(queryClient, ME_QUERY_KEY)).toBe(false);

    const sessionChanged = vi.fn();
    const limited = new MutationObserver(
      queryClient,
      createProposalOptions(queryClient, sessionChanged, () =>
        Promise.reject(
          refused(429, 'PROPOSAL_LIMITED', { reason: 'daily', limit: 3, retryAfterSeconds: 60 }),
        ),
      ),
    );
    await expect(limited.mutate(body('user-2'))).rejects.toThrow();
    expect(sessionChanged).not.toHaveBeenCalled();
    expect(invalidated(queryClient, ME_QUERY_KEY)).toBe(false);
    queryClient.clear();
  });
});

describe('retractProposalOptions', () => {
  const press = (account = 'user-1'): RetractVariables => ({
    id: 'p1',
    expectedAccountId: account,
  });

  it('shows the 철회 at once, in place, and then reads the list again', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(ME_QUERY_KEY, me('user-1'));
    seedList(queryClient, [proposal('p2', 'submitted'), proposal('p1', 'submitted')]);
    const observer = new MutationObserver(
      queryClient,
      retractProposalOptions(
        queryClient,
        () => undefined,
        () => Promise.resolve(proposal('p1', 'retracted')),
      ),
    );
    await observer.mutate(press());
    expect(listed(queryClient)?.map((item) => [item.id, item.status])).toEqual([
      ['p2', 'submitted'],
      ['p1', 'retracted'],
    ]);
    expect(invalidated(queryClient, MY_PROPOSALS_KEY)).toBe(true);
    queryClient.clear();
  });

  it('writes nothing into a list the tab now holds for another account', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(ME_QUERY_KEY, me('user-2'));
    seedList(queryClient, [proposal('p1', 'submitted')]);
    const observer = new MutationObserver(
      queryClient,
      retractProposalOptions(
        queryClient,
        () => undefined,
        () => Promise.resolve(proposal('p1', 'retracted')),
      ),
    );
    await observer.mutate(press('user-1'));
    expect(listed(queryClient)?.map((item) => item.status)).toEqual(['submitted']);
    queryClient.clear();
  });

  it('reads the list again after a refusal (the review may have started), and asks for the session when it changed', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(ME_QUERY_KEY, me('user-1'));
    seedList(queryClient, [proposal('p1', 'submitted')]);
    const sessionChanged = vi.fn();
    const failWith = (error: Error) =>
      new MutationObserver(
        queryClient,
        retractProposalOptions(queryClient, sessionChanged, () => Promise.reject(error)),
      );

    await expect(
      failWith(refused(400, 'VALIDATION_ERROR', [{ path: ['status'], message: 'x' }])).mutate(
        press(),
      ),
    ).rejects.toThrow();
    expect(sessionChanged).not.toHaveBeenCalled();
    expect(invalidated(queryClient, PROPOSALS_KEY)).toBe(undefined); // the root holds no entry
    expect(invalidated(queryClient, MY_PROPOSALS_KEY)).toBe(true);
    expect(listed(queryClient)?.map((item) => item.status)).toEqual(['submitted']);

    await expect(failWith(forAnotherAccount()).mutate(press())).rejects.toThrow();
    expect(sessionChanged).toHaveBeenCalledTimes(1);
    expect(invalidated(queryClient, ME_QUERY_KEY)).toBe(false);
    queryClient.clear();
  });

  it('asks for the account’s ["me"] when the onboarding is not done any more, so the gate follows', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(ME_QUERY_KEY, me('user-1'));
    seedList(queryClient, [proposal('p1', 'submitted')]);
    const failWith = (error: Error) =>
      new MutationObserver(
        queryClient,
        retractProposalOptions(
          queryClient,
          () => undefined,
          () => Promise.reject(error),
        ),
      );
    // Another account's ["me"] in the tab: left to SessionCacheGuard.
    await expect(
      failWith(refused(409, 'ONBOARDING_REQUIRED')).mutate(press('user-2')),
    ).rejects.toThrow();
    expect(invalidated(queryClient, ME_QUERY_KEY)).toBe(false);
    await expect(failWith(refused(409, 'ONBOARDING_REQUIRED')).mutate(press())).rejects.toThrow();
    expect(invalidated(queryClient, ME_QUERY_KEY)).toBe(true);
    queryClient.clear();
  });
});
