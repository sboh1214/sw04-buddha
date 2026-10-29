import { readFileSync } from 'node:fs';
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

  it('never asks for ["me"]: the onboarding does not refuse a 철회 (owner decision 2026-10-19)', async () => {
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
    await expect(failWith(refused(404, 'NOT_FOUND')).mutate(press())).rejects.toThrow();
    await expect(failWith(refused(500, 'INTERNAL')).mutate(press())).rejects.toThrow();
    expect(invalidated(queryClient, ME_QUERY_KEY)).toBe(false);
    expect(invalidated(queryClient, MY_PROPOSALS_KEY)).toBe(true);
    queryClient.clear();
  });
});

describe('the account a proposal and a 철회 name (ADR-0091)', () => {
  it('is the one of the `Me` the screen was drawn from, never the session’s, and the screens are keyed by it', () => {
    // In the render between the session naming B and SessionCacheGuard's reset the form and the
    // list still show A's, and a body naming the session's account would be taken with B's cookie:
    // B's 접수 proposal with the text typed on A's screen. No component renders under node, so the
    // wiring is pinned in the sources: the hooks offer no account (no session id), the form is
    // drawn from the header's `Me` and keyed by it — `['me']` can turn to B in place before the
    // session does, and an unkeyed form would keep what was typed for A, now naming B — and 내
    // 제안's body is handed MY's `Me`'s id, keyed by it (the 철회 picked from A's list goes) and
    // sends it. e2e proposals.spec.ts ('탭의 계정이 …', '탭의 세션이 …') drives them.
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source('./use-proposals.ts')).not.toMatch(/user\.id/);
    const form = source('../app/proposals/new/proposal-form.tsx');
    expect(form).toMatch(/<ProposalFields\s+key=\{me\.data\.id\}\s+accountId=\{me\.data\.id\}/);
    expect(form).toContain('toCreateProposalBody(values, accountId)');
    expect(form).not.toMatch(/\bcreate\.accountId\b/);
    const list = source('../app/my/proposals/my-proposals.tsx');
    expect(
      list.match(
        /<ProposalsBody key=\{accountId\} proposals=\{proposals\} accountId=\{accountId\}/g,
      ),
    ).toHaveLength(2);
    expect(list).toContain('expectedAccountId: accountId }');
    expect(list).not.toMatch(/\bretract\.accountId\b/);
  });

  it('keeps the refusal as another account’s above the keyed form, so the form drawn again says why', () => {
    // The refusal asks for the session again; once it names the account really signed in,
    // SessionCacheGuard's reset takes `['me']` back to waiting and the form is drawn again for it —
    // a notice kept in the form would go with A's. It is kept in `ProposalForm`, above the key.
    // e2e proposals.spec.ts ('… 세션이 아직 앞 계정을 말하는 채 …') drives that order.
    const form = readFileSync(
      new URL('../app/proposals/new/proposal-form.tsx', import.meta.url),
      'utf8',
    );
    const top = form.slice(form.indexOf('export function ProposalForm()'));
    expect(top.slice(0, top.indexOf('\n}\n'))).toContain(
      'const [accountChanged, setAccountChanged] = useState<Refusal | null>(null);',
    );
    expect(form).toContain("if (failure.kind === 'session') onAccountChanged(refusal);");
    expect(form).toContain('const notice = refused ?? accountChanged;');
  });

  it('offers 철회 only once MY’s account is known', () => {
    // The list can come before `GET /me`: a 철회 opened then could only send nothing, and would
    // close as the key turns to the account. e2e proposals.spec.ts ('… 내 정보를 읽기 전에는 …')
    // holds `GET /me` and sees it off.
    const list = readFileSync(
      new URL('../app/my/proposals/my-proposals.tsx', import.meta.url),
      'utf8',
    );
    expect(list).toContain('retractable={accountId !== undefined}');
    expect(list).toContain('disabled={!retractable}');
    expect(list).toContain('confirmDisabled={accountId === undefined}');
  });
});
