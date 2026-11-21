import { readFileSync } from 'node:fs';
import { MutationObserver, QueryObserver, type QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ApplyRegrantResult, type RegrantStatus, api } from '@/lib/api';
import { instantWait } from '@/lib/datetime';
import { IdempotencyKeys, type KeyStorage } from '@/lib/idempotency';
import { getQueryClient } from '@/lib/query-client';
import {
  REGRANT_INTENT,
  regrantFailureShown,
  regrantPressFailure,
  regrantRereadAt,
  regrantStatusKey,
} from '@/lib/regrant';
import { ME_QUERY_KEY } from './use-me';
import {
  applyRegrantOptions,
  readRegrantStatusAgain,
  regrantKeyring,
  regrantStatusQueryOptions,
  regrantStatusReadAt,
} from './use-regrant';
import { LEDGER_QUERY_KEY } from './use-wallet';

/**
 * The wallet's 재지급 requests (#74, ADR-0155), with the API client's methods stubbed: the status's
 * read, and what a press sends and keeps — its request id per account until the server answers
 * (N01 §9), and the reads it asks again. Nothing renders (vitest runs under `environment: 'node'`).
 */

const ACCOUNT = 'user-a';
const NAME = `buddha:regrant-key:${ACCOUNT}:${REGRANT_INTENT}`;

const eligible: RegrantStatus = {
  open: true,
  eligible: true,
  refusals: [],
  amountCoin: '50000',
  thresholdCoin: '990000',
  waitHours: 0,
  waitUntil: null,
  periodDays: 30,
  periodLimit: 3,
  periodUsed: 0,
  nextPeriodAt: null,
  totalCapCoin: '500000',
  totalGrantedCoin: '0',
  remainingCapCoin: '500000',
};

const granted: ApplyRegrantResult = {
  regrant: {
    id: '0b8a3c5e-2f4d-4e6a-9b1c-3d5e7f9a1b2c',
    amountCoin: '50000',
    createdAt: '2026-11-21T03:00:00.000Z',
  },
  replayed: false,
};

/** sessionStorage as the keys see it: a map that outlives one press. */
function fakeStorage(): KeyStorage & { size(): number } {
  const items = new Map<string, string>();
  return {
    getItem: (name) => items.get(name) ?? null,
    setItem: (name, value) => void items.set(name, value),
    removeItem: (name) => void items.delete(name),
    size: () => items.size,
  };
}

const answered = (data: unknown) =>
  ({ data: { data }, response: new Response(null, { status: 200 }) }) as never;

const refused = (status: number, code: string, details?: unknown) =>
  ({
    error: { error: { code, message: 'x', ...(details === undefined ? {} : { details }) } },
    response: new Response(null, { status }),
  }) as never;

/** A press's options over `queryClient`, the session's refetch watched, the ids in `storage`. */
function press(queryClient: QueryClient, storage: KeyStorage) {
  const onSessionChanged = vi.fn();
  const keys = new IdempotencyKeys(ACCOUNT, storage, 'regrant-key');
  const observer = new MutationObserver(
    queryClient,
    applyRegrantOptions(queryClient, onSessionChanged, () => keys),
  );
  return { observer, onSessionChanged };
}

/** The `Idempotency-Key` each stubbed POST carried, in order. */
function sentKeys(post: { mock: { calls: unknown[][] } }): string[] {
  return post.mock.calls.map(
    (call) =>
      (call[1] as { params: { header: { 'Idempotency-Key': string } } }).params.header[
        'Idempotency-Key'
      ],
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the status read', () => {
  it('asks GET /me/regrant under the account, fresh at every mount', async () => {
    const get = vi.spyOn(api, 'GET').mockResolvedValue(answered(eligible));
    const options = regrantStatusQueryOptions(ACCOUNT);
    expect(options.queryKey).toEqual(regrantStatusKey(ACCOUNT));
    expect(options.staleTime).toBe(0);
    await expect(options.queryFn()).resolves.toEqual(eligible);
    expect(get).toHaveBeenCalledWith('/api/v1/me/regrant');
  });
});

describe('the status read again when its instant comes', () => {
  const WAIT_UNTIL = '2026-11-22T06:00:00.000Z';
  const waiting: RegrantStatus = {
    ...eligible,
    eligible: false,
    refusals: ['waiting'],
    waitHours: 24,
    waitUntil: WAIT_UNTIL,
  };

  it('reads this account’s status again, and no other account’s', async () => {
    const queryClient = getQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await readRegrantStatusAgain(queryClient, ACCOUNT);
    expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual([
      { queryKey: regrantStatusKey(ACCOUNT), exact: true },
    ]);
    queryClient.clear();
  });

  it('turns the button on once the 대기기간 ends on screen, read a second past it and not before', async () => {
    vi.useFakeTimers();
    // An hour before the wait ends, on the browser's clock.
    vi.setSystemTime(Date.parse(WAIT_UNTIL) - 60 * 60 * 1_000);
    const queryClient = getQueryClient();
    // The read at the card's mount says waiting; the next one, once it has passed, eligible.
    const get = vi
      .spyOn(api, 'GET')
      .mockResolvedValueOnce(answered(waiting))
      .mockResolvedValue(answered(eligible));
    const card = new QueryObserver(queryClient, regrantStatusQueryOptions(ACCOUNT));
    const unsubscribe = card.subscribe(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(get).toHaveBeenCalledTimes(1);
      expect(card.getCurrentResult().data).toEqual(waiting);
      // The card's wait (`useRegrantRereadAt` → `useInstantReached`): the one-shot timer the
      // hook sets for the instant, and what it runs when it comes.
      const at = regrantRereadAt(card.getCurrentResult().data);
      expect(at).toBe('2026-11-22T06:00:01.000Z');
      const wait = instantWait(at ?? '', Date.now());
      expect(wait).toBe(60 * 60 * 1_000 + 1_000);
      setTimeout(() => void readRegrantStatusAgain(queryClient, ACCOUNT), wait ?? 0);

      // At the wait's end itself, nothing yet: the database's clock may be behind the browser's.
      await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
      expect(get).toHaveBeenCalledTimes(1);
      expect(card.getCurrentResult().data).toEqual(waiting);
      // A second past it: read again, and the card's status is the eligible one.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(get).toHaveBeenCalledTimes(2);
      expect(get).toHaveBeenLastCalledWith('/api/v1/me/regrant');
      expect(card.getCurrentResult().data).toEqual(eligible);
      // Nothing to wait for any more.
      expect(regrantRereadAt(card.getCurrentResult().data)).toBeNull();
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it('is waited for in the card by the one-shot timer of the member screens', () => {
    // No hook runs its effects under node: the wiring is pinned in the source, as
    // `useAccountBlock`'s and the order book's are (use-instant-reached.test.ts has the timer).
    const source = readFileSync(new URL('./use-regrant.ts', import.meta.url), 'utf8');
    const hook = source.slice(source.indexOf('export function useRegrantRereadAt('));
    expect(hook).toContain('useInstantReached(regrantRereadAt(status), undefined, readAgain);');
    expect(hook).toMatch(
      /const readAgain = useCallback\(\(\) => \{\s*void readRegrantStatusAgain\(queryClient, accountId\);\s*\}, \[queryClient, accountId\]\);/,
    );
  });
});

describe('the card’s keyring', () => {
  it('keeps one handle while the account stays, and files another account’s ids apart', () => {
    const keysFor = regrantKeyring();
    const a = keysFor(ACCOUNT);
    expect(keysFor(ACCOUNT)).toBe(a);
    const b = keysFor('user-b');
    expect(b).not.toBe(a);
    expect(b.take(REGRANT_INTENT)).not.toBe(a.take(REGRANT_INTENT));
  });
});

describe('a press of 재지급 신청', () => {
  it('names the account on screen, spends its request id on the grant and reads the balance, the ledger and the status again', async () => {
    const queryClient = getQueryClient();
    const storage = fakeStorage();
    const post = vi.spyOn(api, 'POST').mockResolvedValue(answered(granted));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { observer } = press(queryClient, storage);

    await expect(observer.mutate({ expectedAccountId: ACCOUNT })).resolves.toEqual(granted);
    expect(post).toHaveBeenCalledWith('/api/v1/me/regrant', {
      params: { header: { 'Idempotency-Key': expect.any(String) as string } },
      body: { expectedAccountId: ACCOUNT },
    });
    expect(storage.size()).toBe(0);
    expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual([
      { queryKey: ME_QUERY_KEY, exact: true },
      { queryKey: LEDGER_QUERY_KEY },
      { queryKey: regrantStatusKey(ACCOUNT), exact: true },
    ]);
    queryClient.clear();
  });

  it('sends the same request id again after an answer that never came or a 5xx, and a new one after the grant (N01 §9)', async () => {
    const queryClient = getQueryClient();
    const storage = fakeStorage();
    const post = vi
      .spyOn(api, 'POST')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(refused(500, 'INTERNAL'))
      .mockResolvedValueOnce(answered({ ...granted, replayed: true }))
      .mockResolvedValueOnce(refused(409, 'REGRANT_NOT_ALLOWED', eligible));
    const { observer } = press(queryClient, storage);

    await expect(observer.mutate({ expectedAccountId: ACCOUNT })).rejects.toThrow('fetch failed');
    const kept = storage.getItem(NAME);
    expect(kept).not.toBeNull();
    await expect(observer.mutate({ expectedAccountId: ACCOUNT })).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    expect(storage.getItem(NAME)).toBe(kept);
    // The server answers the grant the lost request made: replayed, nothing given twice.
    await expect(observer.mutate({ expectedAccountId: ACCOUNT })).resolves.toMatchObject({
      replayed: true,
    });
    expect(storage.size()).toBe(0);
    await expect(observer.mutate({ expectedAccountId: ACCOUNT })).rejects.toMatchObject({
      code: 'REGRANT_NOT_ALLOWED',
    });
    const [first, second, third, fourth] = sentKeys(post);
    expect([second, third]).toEqual([first, first]);
    expect(fourth).not.toBe(first);
    queryClient.clear();
  });

  it('puts REGRANT_NOT_ALLOWED’s status in place of the one read before, spends the id and reads the balance again', async () => {
    const queryClient = getQueryClient();
    const storage = fakeStorage();
    queryClient.setQueryData(regrantStatusKey(ACCOUNT), eligible);
    const status: RegrantStatus = {
      ...eligible,
      eligible: false,
      refusals: ['not_exhausted', 'live_orders'],
    };
    vi.spyOn(api, 'POST').mockResolvedValue(refused(409, 'REGRANT_NOT_ALLOWED', status));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { observer, onSessionChanged } = press(queryClient, storage);

    await expect(observer.mutate({ expectedAccountId: ACCOUNT })).rejects.toMatchObject({
      code: 'REGRANT_NOT_ALLOWED',
    });
    expect(queryClient.getQueryData(regrantStatusKey(ACCOUNT))).toEqual(status);
    expect(storage.size()).toBe(0);
    expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual([
      { queryKey: ME_QUERY_KEY, exact: true },
    ]);
    expect(onSessionChanged).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it('is refused only once the details are the status’s reading — the card’s line is tied to it', async () => {
    // Only Date is faked: the status's `dataUpdatedAt` is the details' write, apart from the read.
    vi.useFakeTimers({ toFake: ['Date'] });
    const READ = Date.parse('2026-11-21T03:00:00.000Z');
    vi.setSystemTime(READ);
    const queryClient = getQueryClient();
    queryClient.setQueryData(regrantStatusKey(ACCOUNT), eligible);
    expect(regrantStatusReadAt(queryClient, ACCOUNT)).toBe(READ);
    const status: RegrantStatus = { ...eligible, eligible: false, refusals: ['live_orders'] };
    vi.spyOn(api, 'POST').mockResolvedValue(refused(409, 'REGRANT_NOT_ALLOWED', status));
    const { observer } = press(queryClient, fakeStorage());
    const REFUSED = READ + 5_000;
    vi.setSystemTime(REFUSED);
    const format = (iso: string) => iso;

    // What the card's catch reads, after the hook's onError.
    const kept = await observer.mutate({ expectedAccountId: ACCOUNT }).then(
      () => undefined,
      (error: unknown) =>
        regrantPressFailure(error, format, regrantStatusReadAt(queryClient, ACCOUNT)),
    );
    expect(queryClient.getQueryData(regrantStatusKey(ACCOUNT))).toEqual(status);
    expect(kept?.readingAt).toBe(REFUSED);
    expect(regrantFailureShown(kept ?? null, status, REFUSED, format)).not.toBeNull();
    // The status read again later (the balance moved, a focus), eligible now: the line goes.
    vi.setSystemTime(REFUSED + 1_000);
    queryClient.setQueryData(regrantStatusKey(ACCOUNT), eligible);
    const newer = regrantStatusReadAt(queryClient, ACCOUNT) ?? 0;
    expect(newer).toBeGreaterThan(REFUSED);
    expect(regrantFailureShown(kept ?? null, eligible, newer, format)).toBeNull();
    queryClient.clear();
  });

  it('keeps the id and asks for the session again when the cookie is another account’s', async () => {
    const queryClient = getQueryClient();
    const storage = fakeStorage();
    queryClient.setQueryData(regrantStatusKey(ACCOUNT), eligible);
    vi.spyOn(api, 'POST').mockResolvedValue(
      refused(403, 'FORBIDDEN', [{ path: ['expectedAccountId'], message: 'x' }]),
    );
    const { observer, onSessionChanged } = press(queryClient, storage);

    await expect(observer.mutate({ expectedAccountId: ACCOUNT })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(storage.getItem(NAME)).not.toBeNull();
    expect(onSessionChanged).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(regrantStatusKey(ACCOUNT))).toEqual(eligible);
    queryClient.clear();
  });

  it('reads the status and the balance again after RESTRICTED or ONBOARDING_REQUIRED', async () => {
    for (const [status, code, details] of [
      [403, 'RESTRICTED', { kind: 'account', endsAt: null }],
      [409, 'ONBOARDING_REQUIRED', undefined],
    ] as const) {
      const queryClient = getQueryClient();
      const storage = fakeStorage();
      vi.spyOn(api, 'POST').mockResolvedValue(refused(status, code, details));
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      const { observer } = press(queryClient, storage);

      await expect(observer.mutate({ expectedAccountId: ACCOUNT })).rejects.toMatchObject({
        code,
      });
      expect(storage.size(), code).toBe(0);
      expect(
        invalidate.mock.calls.map(([filters]) => filters),
        code,
      ).toEqual(
        expect.arrayContaining([
          { queryKey: regrantStatusKey(ACCOUNT), exact: true },
          { queryKey: ME_QUERY_KEY, exact: true },
        ]),
      );
      vi.restoreAllMocks();
      queryClient.clear();
    }
  });
});
