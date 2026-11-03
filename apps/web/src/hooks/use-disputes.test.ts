import { readFileSync } from 'node:fs';
import { MutationObserver, type QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type Me, type MyDispute, type MyMarketDispute, api } from '@/lib/api';
import { myDisputesKey, myMarketDisputeKey } from '@/lib/disputes';
import { isPrivateQueryKey, marketKey } from '@/lib/market-keys';
import { getQueryClient } from '@/lib/query-client';
import { ME_QUERY_KEY } from './use-me';
import {
  type DisputePage,
  type RetractDisputeVariables,
  type SubmitDisputeVariables,
  myDisputesInfiniteQueryOptions,
  myMarketDisputeQueryOptions,
  refreshMyMarketDisputeOnStatus,
  retractDisputeOptions,
  storeDispute,
  submitDisputeOptions,
} from './use-disputes';

/**
 * 판정 이의's member cache (#175, ADR-0104), driven through the REAL QueryClient under node — the
 * options are exported apart from their hooks for this (use-proposals.test.ts does the same).
 */

const MARKET = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
/** The entries of the account the screens below show, 'user-1' (ADR-0091). */
const MINE = myMarketDisputeKey(MARKET, 'user-1');
const LIST = myDisputesKey('user-1');
const me = (id: string) => ({ id }) as Me;

const dispute = (fields: Partial<MyDispute> = {}): MyDispute => ({
  id: 'd1b07384-d9a0-4c9b-8e2f-2d1c0f8a4b11',
  judgementVersion: 1,
  links: ['https://example.com/a'],
  reason: '규칙의 출처와 다릅니다.',
  status: 'pending',
  submittedAt: '2026-11-30T03:00:00.000Z',
  decidedAt: null,
  decisionReason: null,
  retractedAt: null,
  market: { id: MARKET, slug: 'first-snow', title: '첫눈이 올까?', status: 'provisional' },
  retractable: true,
  ...fields,
});

const variables = (account = 'user-1'): SubmitDisputeVariables => ({
  marketId: MARKET,
  body: {
    judgementVersion: 1,
    links: ['https://example.com/a'],
    reason: '사유',
    expectedAccountId: account,
  },
});

const refused = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  } as never);
const forAnotherAccount = () =>
  refused(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'another account' }]);

const invalidated = (queryClient: QueryClient, key: readonly unknown[]) =>
  queryClient.getQueryState(key)?.isInvalidated;

function seed(queryClient: QueryClient, held: MyDispute) {
  queryClient.setQueryData(ME_QUERY_KEY, me('user-1'));
  queryClient.setQueryData<{ pages: DisputePage[]; pageParams: unknown[] }>(LIST, {
    pages: [{ items: [held], nextCursor: null }],
    pageParams: [undefined],
  });
  queryClient.setQueryData<MyMarketDispute>(MINE, {
    eligibility: 'eligible',
    judgementVersion: 1,
    dispute: null,
  });
  queryClient.setQueryData(marketKey(MARKET), { id: MARKET });
}

describe('the member’s 판정 이의 reads', () => {
  it('are private, wait for a session, and name the market by its uuid', async () => {
    // Under the account the screen shows (ADR-0091), read once it is known and signed in.
    const standing = myMarketDisputeQueryOptions(MARKET, 'user-1', { user: {} });
    expect(standing.queryKey).toEqual(['disputes', 'market', MARKET.toLowerCase(), 'user-1']);
    expect(isPrivateQueryKey(standing.queryKey)).toBe(true);
    expect(standing.enabled).toBe(true);
    expect(myMarketDisputeQueryOptions(MARKET, 'user-1', null).enabled).toBe(false);
    expect(myMarketDisputeQueryOptions(MARKET, undefined, { user: {} }).enabled).toBe(false);
    const list = myDisputesInfiniteQueryOptions('user-1', { user: {} });
    expect(list.queryKey).toEqual(['disputes', 'mine', 'user-1']);
    expect(myDisputesInfiniteQueryOptions('user-1', undefined).enabled).toBe(false);
    expect(myDisputesInfiniteQueryOptions(undefined, { user: {} }).enabled).toBe(false);
    expect(list.getNextPageParam({ items: [], nextCursor: 'c2' })).toBe('c2');
    expect(list.getNextPageParam({ items: [], nextCursor: null })).toBeUndefined();

    const get = vi.spyOn(api, 'GET').mockResolvedValue({
      data: { data: [], meta: { nextCursor: null } },
      response: new Response(null, { status: 200 }),
    } as never);
    try {
      await standing.queryFn();
      expect(get).toHaveBeenLastCalledWith('/api/v1/me/disputes/markets/{marketId}', {
        params: { path: { marketId: MARKET } },
      });
      await list.queryFn({ pageParam: 'c2' });
      expect(get).toHaveBeenLastCalledWith('/api/v1/me/disputes', {
        params: { query: { cursor: 'c2' } },
      });
    } finally {
      get.mockRestore();
    }
  });
});

describe('submitDisputeOptions', () => {
  it('puts the dispute in the standing, then reads the disputes and the market again', async () => {
    const queryClient = getQueryClient();
    seed(queryClient, dispute({ id: 'other' }));
    const answered = dispute();
    const post = vi.fn((_: SubmitDisputeVariables) => Promise.resolve(answered));
    const observer = new MutationObserver(
      queryClient,
      submitDisputeOptions(queryClient, () => undefined, post),
    );
    await observer.mutate(variables());
    expect(post.mock.calls[0]?.[0]).toEqual(variables());
    // The one per version: the standing is `duplicate` with the dispute at once.
    expect(queryClient.getQueryData(MINE)).toEqual({
      eligibility: 'duplicate',
      judgementVersion: 1,
      dispute: answered,
    });
    expect(invalidated(queryClient, LIST)).toBe(true);
    // The market reads '이의 검토 중' now.
    expect(invalidated(queryClient, marketKey(MARKET))).toBe(true);
    queryClient.clear();
  });

  it('asks for the session, ["me"] or the standing by what the refusal says', async () => {
    const queryClient = getQueryClient();
    seed(queryClient, dispute());
    const sessionChanged = vi.fn();
    const failWith = (error: Error) =>
      new MutationObserver(
        queryClient,
        submitDisputeOptions(queryClient, sessionChanged, () => Promise.reject(error)),
      );

    await expect(failWith(forAnotherAccount()).mutate(variables())).rejects.toThrow();
    expect(sessionChanged).toHaveBeenCalledTimes(1);
    expect(invalidated(queryClient, MINE)).toBe(false);

    await expect(
      failWith(refused(409, 'ONBOARDING_REQUIRED')).mutate(variables()),
    ).rejects.toThrow();
    expect(invalidated(queryClient, ME_QUERY_KEY)).toBe(true);

    await expect(
      failWith(refused(409, 'DISPUTE_NOT_ALLOWED', { reason: 'deadline_passed' })).mutate(
        variables(),
      ),
    ).rejects.toThrow();
    expect(invalidated(queryClient, MINE)).toBe(true);
    expect(sessionChanged).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });
});

describe('retractDisputeOptions', () => {
  it('shows 철회 at once in MY and the standing, then reads both again — on a refusal too', async () => {
    const queryClient = getQueryClient();
    const held = dispute();
    seed(queryClient, held);
    queryClient.setQueryData<MyMarketDispute>(MINE, {
      eligibility: 'duplicate',
      judgementVersion: 1,
      dispute: held,
    });
    const answered = dispute({
      status: 'retracted',
      retractedAt: '2026-11-30T04:00:00.000Z',
      retractable: false,
    });
    const post = vi.fn((_: RetractDisputeVariables) => Promise.resolve(answered));
    const retract: RetractDisputeVariables = {
      id: held.id,
      marketId: MARKET,
      expectedAccountId: 'user-1',
    };
    await new MutationObserver(
      queryClient,
      retractDisputeOptions(queryClient, () => undefined, post),
    ).mutate(retract);
    const pages = queryClient.getQueryData<{ pages: DisputePage[] }>(LIST)?.pages;
    expect(pages?.[0]?.items).toEqual([answered]);
    expect(queryClient.getQueryData<MyMarketDispute>(MINE)?.dispute).toEqual(answered);
    expect(invalidated(queryClient, LIST)).toBe(true);
    expect(invalidated(queryClient, marketKey(MARKET))).toBe(true);

    // Refused as another account's: the session is asked again, and the lists read again.
    const sessionChanged = vi.fn();
    const fresh = getQueryClient();
    seed(fresh, held);
    await expect(
      new MutationObserver(
        fresh,
        retractDisputeOptions(fresh, sessionChanged, () => Promise.reject(forAnotherAccount())),
      ).mutate(retract),
    ).rejects.toThrow();
    expect(sessionChanged).toHaveBeenCalledTimes(1);
    expect(invalidated(fresh, LIST)).toBe(true);
    queryClient.clear();
    fresh.clear();
  });

  it('writes nothing into another account’s cache (an answer landing after the tab turned)', () => {
    const queryClient = getQueryClient();
    const held = dispute();
    seed(queryClient, held);
    storeDispute(queryClient, dispute({ status: 'retracted', retractable: false }), 'user-2');
    const pages = queryClient.getQueryData<{ pages: DisputePage[] }>(LIST)?.pages;
    expect(pages?.[0]?.items).toEqual([held]);
    // A dispute of another version leaves the standing of the current one alone.
    storeDispute(queryClient, dispute({ judgementVersion: 2 }), 'user-1');
    expect(queryClient.getQueryData<MyMarketDispute>(MINE)?.eligibility).toBe('eligible');
    // `['me']` turned to user-2 in place, before the session (no reset): user-2's screen reads its
    // own entry, and a late answer for user-1 — the submission's — never lands in it.
    queryClient.setQueryData(ME_QUERY_KEY, me('user-2'));
    const other: MyMarketDispute = { eligibility: 'eligible', judgementVersion: 1, dispute: null };
    queryClient.setQueryData<MyMarketDispute>(myMarketDisputeKey(MARKET, 'user-2'), other);
    storeDispute(queryClient, dispute(), 'user-1');
    expect(queryClient.getQueryData(myMarketDisputeKey(MARKET, 'user-2'))).toEqual(other);
    expect(queryClient.getQueryData<MyMarketDispute>(MINE)?.dispute).toEqual(dispute());
    queryClient.clear();
  });
});

describe('the deadline’s timer (useDisputeOpen)', () => {
  it('starts from the API’s flag and a timer in an effect, never a clock read in render', () => {
    // No component renders under node with effects, so the hook's wiring is pinned in its source:
    // the first render is the server's `disputeOpen` alone (the detail's HTML), and the timer —
    // set from an effect, the anchor's elapsed counted as the countdown counts it — closes it.
    const source = readFileSync(new URL('./use-disputes.ts', import.meta.url), 'utf8');
    const hook = source.slice(source.indexOf('export function useDisputeOpen('));
    expect(hook).toContain('const deadline = openDisputeDeadline(market);');
    expect(hook).toContain('return deadline !== null && closedAt !== deadline;');
    expect(hook).toContain('tickingNow(anchorAt, performance.now() - startedAt, Date.now())');
    expect(hook).toContain('timer = setTimeout(check, 0);');
    // `Date.now()` only inside the effect's timer callback.
    const body = hook.slice(0, hook.indexOf('useEffect(() => {\n    if (deadline === null)'));
    expect(body).not.toContain('Date.now()');
  });
});

describe('the standing after a market:status (refreshMyMarketDisputeOnStatus)', () => {
  it('asks again for the member’s standing on that market only — a decision is in no event', async () => {
    const queryClient = getQueryClient();
    const here = 'A1E1C0DE-0000-4000-8000-0000000000AA';
    const there = 'a1e1c0de-0000-4000-8000-0000000000bb';
    const standing = { eligibility: 'duplicate', judgementVersion: 1, dispute: null };
    queryClient.setQueryData(myMarketDisputeKey(here, 'user-1'), standing);
    queryClient.setQueryData(myMarketDisputeKey(here, 'user-2'), standing);
    queryClient.setQueryData(myMarketDisputeKey(there, 'user-1'), standing);
    queryClient.setQueryData(LIST, { pages: [], pageParams: [] });
    await refreshMyMarketDisputeOnStatus(queryClient, here);
    // Whichever account the entry is under: the event names none.
    expect(invalidated(queryClient, myMarketDisputeKey(here, 'user-1'))).toBe(true);
    expect(invalidated(queryClient, myMarketDisputeKey(here, 'user-2'))).toBe(true);
    expect(invalidated(queryClient, myMarketDisputeKey(there, 'user-1'))).toBe(false);
    expect(invalidated(queryClient, LIST)).toBe(false);
    queryClient.clear();
  });
});
