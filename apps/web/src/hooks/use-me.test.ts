import { MutationObserver, QueryObserver, type QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ApiError, type Me, type UpdateBioBody, type UpdateTimeZoneBody } from '@/lib/api';
import { getQueryClient } from '@/lib/query-client';
import {
  ME_QUERY_KEY,
  storeMe,
  updateBioOptions,
  updateNicknameOptions,
  updateTimeZoneOptions,
} from './use-me';

/**
 * The profile writes' cache writes (`PATCH /me`, `PUT /me/time-zone`, `PUT /me/bio`), driven through the REAL
 * QueryClient (`getQueryClient()` answers a fresh one per call under node). Nothing renders:
 * apps/web runs vitest under `environment: 'node'`, which is why `storeMe` and the two mutations'
 * options are exported apart from their hooks. The `['me']` observer stands in for
 * TimeZoneProvider, which observes that entry at the root of every page (ADR-0063).
 */

/** The account as the settings screen first sees it: following the browser. */
const following: Me = {
  id: 'user-1',
  email: 'a@example.com',
  emailVerified: true,
  profile: {
    publicId: 'k7m2p9qx4z',
    nickname: '테스터',
    role: 'user',
    createdAt: '2026-08-01T00:00:00.000Z',
    timeZone: null,
    nicknameChangeAvailableAt: null,
    interestCategoryIds: [],
    bio: null,
  },
  balance: { availableCoin: '0', lockedCoin: '0' },
  linkedAccounts: [],
  verification: null,
  startGrant: null,
  onboarding: {
    consent: false,
    verification: false,
    nickname: false,
    completed: false,
    interests: false,
    nextStep: 'consent',
    consents: [],
  },
};

/** What `PUT /me/time-zone` answers once New York is saved. */
const inNewYork: Me = {
  ...following,
  profile: { ...following.profile, timeZone: 'America/New_York' },
};

/** The account the tab switched to while a request ran (SessionCacheGuard reset, then B's GET). */
const otherMe: Me = { ...following, id: 'user-2', email: 'b@example.com' };

/** Counts the session refetches a write asks for (the hooks pass better-auth's `refetch`). */
function sessionRefetches() {
  let count = 0;
  return {
    refetch: () => {
      count += 1;
    },
    count: () => count,
  };
}

/** A promise the test settles itself, so "which answer lands after which write" is explicit. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Lets a late answer run every callback it has queued before the test looks. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * An `['me']` observer whose n-th request (1-based) answers `answer(n)`. Subscribing issues the
 * first one, as the provider's mount does.
 */
function meObserver(queryClient: QueryClient, answer: (request: number) => Promise<Me>) {
  let requests = 0;
  const observer = new QueryObserver<Me>(queryClient, {
    queryKey: ME_QUERY_KEY,
    queryFn: () => {
      requests += 1;
      return answer(requests);
    },
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  return { observer, requests: () => requests, unsubscribe };
}

/** The zone the provider would read: what its `useMe` observer holds now. */
const zoneHeld = (me: ReturnType<typeof meObserver>) =>
  me.observer.getCurrentResult().data?.profile.timeZone;

describe('storeMe', () => {
  it('replaces the profile held with the answer, without a request', async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const me = meObserver(queryClient, () => Promise.resolve(following));
    try {
      await me.observer.refetch();

      await storeMe(queryClient, inNewYork, 'timeZone', session.refetch);

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(inNewYork);
      expect(zoneHeld(me)).toBe('America/New_York');
      expect(me.requests()).toBe(1);
      expect(session.count()).toBe(0);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('cancels a GET /me that left before the write, so its old zone cannot land on top', async () => {
    // THE HAZARD: a window-focus refetch (or a realtime resnapshot) is in flight when the PUT
    // commits. It answers after the write with the profile it read BEFORE, and every time on
    // screen goes back to the browser's zone under the toast saying the zone was saved.
    const queryClient = getQueryClient();
    const stale = deferred<Me>();
    const me = meObserver(queryClient, (request) =>
      request === 1 ? Promise.resolve(following) : stale.promise,
    );
    try {
      await me.observer.refetch();
      const inflight = me.observer.refetch();
      expect(queryClient.getQueryState(ME_QUERY_KEY)?.fetchStatus).toBe('fetching');

      await storeMe(queryClient, inNewYork, 'timeZone', () => undefined);
      stale.resolve(following);
      await inflight;
      await settle();

      expect(zoneHeld(me)).toBe('America/New_York');
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(inNewYork);
      expect(queryClient.getQueryState(ME_QUERY_KEY)?.fetchStatus).toBe('idle');
      expect(me.requests()).toBe(2);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('re-asks rather than fills when the cancel leaves nothing held (the first GET /me was in flight)', async () => {
    // The entry held nobody's profile, so the answer is not written into it: the new request
    // asks the cookie, and it leaves after the PUT committed, so it carries the zone.
    const queryClient = getQueryClient();
    const first = deferred<Me>();
    const me = meObserver(queryClient, (request) =>
      request === 1 ? first.promise : Promise.resolve(inNewYork),
    );
    try {
      expect(me.requests()).toBe(1);

      await storeMe(queryClient, inNewYork, 'timeZone', () => undefined);

      expect(me.requests()).toBe(2);
      expect(zoneHeld(me)).toBe('America/New_York');
      // …and the first request, landing late with what it read before the PUT, is dropped.
      first.resolve(following);
      await settle();
      expect(zoneHeld(me)).toBe('America/New_York');
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it("leaves another account's profile alone, its refresh in flight included", async () => {
    // THE HAZARD: A's PUT answers after the tab switched to B (SessionCacheGuard reset and B's
    // GET /me landed). Writing A's `Me` would put A's nickname, balance and verification on B's
    // screen; cancelling would drop B's own refresh.
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const refresh = deferred<Me>();
    const me = meObserver(queryClient, (request) =>
      request === 1 ? Promise.resolve(otherMe) : refresh.promise,
    );
    try {
      await me.observer.refetch();
      const inflight = me.observer.refetch();

      await storeMe(queryClient, inNewYork, 'timeZone', session.refetch);

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(otherMe);
      expect(queryClient.getQueryState(ME_QUERY_KEY)?.fetchStatus).toBe('fetching');
      const refreshed: Me = { ...otherMe, profile: { ...otherMe.profile, nickname: '비' } };
      refresh.resolve(refreshed);
      await inflight;
      expect(me.observer.getCurrentResult().data).toEqual(refreshed);
      expect(me.requests()).toBe(2);
      // The session is asked again, which changes nothing here: it already names B.
      expect(session.count()).toBe(1);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('asks for the session again when the write went to the account the cookie names, not the one on screen', async () => {
    // THE HAZARD: a window still showing A beside one that signed in as B (no visibilitychange,
    // and a sign-in is not broadcast). A cookie-only `PATCH /me` from it renames B and answers
    // B's `Me`. Left at that, the window keeps showing A under '저장했습니다' and B's nickname
    // changed with nothing on screen to say so; the refetch lets SessionCacheGuard put B there.
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const me = meObserver(queryClient, () => Promise.resolve(following));
    try {
      await me.observer.refetch();

      await storeMe(
        queryClient,
        { ...otherMe, profile: { ...otherMe.profile, nickname: '비' } },
        'nickname',
        session.refetch,
      );

      expect(session.count()).toBe(1);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(following);
      expect(me.requests()).toBe(1);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('takes only its own field, so an older answer of the other profile write cannot undo it', async () => {
    // THE HAZARD (Codex on #209): a nickname save and a time-zone save overlap. The time-zone
    // answer read the profile before the nickname's UPDATE committed, so it carries the old
    // nickname; it lands after the nickname answer. Taking its whole profile would put the old
    // nickname back while the database holds the new one.
    const queryClient = getQueryClient();
    const me = meObserver(queryClient, () => Promise.resolve(following));
    try {
      await me.observer.refetch();
      const renamed: Me = { ...following, profile: { ...following.profile, nickname: '새이름' } };

      await storeMe(queryClient, renamed, 'nickname', () => undefined);
      await storeMe(queryClient, inNewYork, 'timeZone', () => undefined);

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.profile).toEqual({
        ...following.profile,
        nickname: '새이름',
        timeZone: 'America/New_York',
      });

      // The other order: a nickname answer that read the zone before the zone's UPDATE.
      await storeMe(
        queryClient,
        { ...renamed, profile: { ...renamed.profile, nickname: '또이름' } },
        'nickname',
        () => undefined,
      );
      expect(zoneHeld(me)).toBe('America/New_York');
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.profile.nickname).toBe('또이름');
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('takes when the nickname may change next with the nickname, and nothing else (#58)', async () => {
    // A change starts the 30 days (ADR-0069 decision 1 #57-6): the settings card says when.
    const queryClient = getQueryClient();
    const me = meObserver(queryClient, () => Promise.resolve(inNewYork));
    try {
      await me.observer.refetch();
      const changed: Me = {
        ...following,
        profile: {
          ...following.profile,
          nickname: '새이름',
          nicknameChangeAvailableAt: '2026-11-17T00:00:00.000Z',
          interestCategoryIds: [9],
        },
      };

      await storeMe(queryClient, changed, 'nickname', () => undefined);

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.profile).toEqual({
        ...inNewYork.profile,
        nickname: '새이름',
        nicknameChangeAvailableAt: '2026-11-17T00:00:00.000Z',
      });
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('takes the 소개 alone from a PUT /me/bio answer (#41)', async () => {
    // The 소개's answer is a snapshot of the whole profile too: a nickname it read before a
    // nickname save committed must not come back with it.
    const queryClient = getQueryClient();
    const me = meObserver(queryClient, () => Promise.resolve(inNewYork));
    try {
      await me.observer.refetch();
      const withBio: Me = {
        ...following,
        profile: { ...following.profile, nickname: '옛이름', bio: '첫 줄\n둘째 줄' },
      };

      await storeMe(queryClient, withBio, 'bio', () => undefined);

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.profile).toEqual({
        ...inNewYork.profile,
        bio: '첫 줄\n둘째 줄',
      });
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('keeps a balance that changed while the write ran, taking only the profile from the answer', async () => {
    // THE HAZARD: the answer's balance is what the server read right after the UPDATE. A fill
    // that committed after that read reached the tab first as `user:balance`, which patched
    // `['me']` (realtime-provider.tsx) and is not sent again; the answer must not put the older
    // balance back on the header chip, the wallet and the order panel.
    const queryClient = getQueryClient();
    const me = meObserver(queryClient, () => Promise.resolve(following));
    try {
      await me.observer.refetch();
      const afterFill = { availableCoin: '70', lockedCoin: '30' };
      // What the realtime handler does with the event.
      queryClient.setQueryData<Me>(ME_QUERY_KEY, (held) => held && { ...held, balance: afterFill });

      await storeMe(queryClient, inNewYork, 'timeZone', () => undefined);

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual({
        ...following,
        profile: inNewYork.profile,
        balance: afterFill,
      });
      expect(zoneHeld(me)).toBe('America/New_York');
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });
});

describe('the profile mutations', () => {
  it('switches the zone every observer reads as soon as PUT /me/time-zone answers', async () => {
    // ADR-0063: the save's answer replaces `['me']`, so a client-side move to a market reads
    // the new zone with no refetch — and `mutateAsync` settles only once it is there.
    const queryClient = getQueryClient();
    const sent: UpdateTimeZoneBody[] = [];
    const me = meObserver(queryClient, () => Promise.resolve(following));
    const save = new MutationObserver(
      queryClient,
      updateTimeZoneOptions(
        queryClient,
        () => undefined,
        (body) => {
          sent.push(body);
          return Promise.resolve(body.timeZone === null ? following : inNewYork);
        },
      ),
    );
    try {
      await me.observer.refetch();

      const body = { timeZone: 'America/New_York', expectedAccountId: following.id };
      await expect(save.mutate(body)).resolves.toEqual(inNewYork);
      expect(zoneHeld(me)).toBe('America/New_York');

      // Following the browser again is a `null`, and it lands the same way.
      const clear = { timeZone: null, expectedAccountId: following.id };
      await expect(save.mutate(clear)).resolves.toEqual(following);
      expect(zoneHeld(me)).toBeNull();
      expect(sent).toEqual([body, clear]);
      expect(me.requests()).toBe(1);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('writes the nickname answer the same way, past a GET /me in flight', async () => {
    const queryClient = getQueryClient();
    const stale = deferred<Me>();
    const renamed: Me = { ...following, profile: { ...following.profile, nickname: '새이름' } };
    const me = meObserver(queryClient, (request) =>
      request === 1 ? Promise.resolve(following) : stale.promise,
    );
    const rename = new MutationObserver(
      queryClient,
      updateNicknameOptions(
        queryClient,
        () => undefined,
        () => Promise.resolve(renamed),
      ),
    );
    try {
      await me.observer.refetch();
      const inflight = me.observer.refetch();

      await rename.mutate({ nickname: '새이름', expectedAccountId: following.id });
      stale.resolve(following);
      await inflight;
      await settle();

      expect(me.observer.getCurrentResult().data?.profile.nickname).toBe('새이름');
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('asks for the session again when the time zone PUT is refused for another account', async () => {
    // The 403 naming `expectedAccountId` (A-PG-24): nothing was written, and SessionCacheGuard
    // needs the session to put the account really signed in on screen. Any other failure is
    // not a sign of a switch.
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const me = meObserver(queryClient, () => Promise.resolve(following));
    const failures = [
      new ApiError(403, {
        code: 'FORBIDDEN',
        message: 'other account',
        details: [{ path: ['expectedAccountId'], message: 'session belongs to another account' }],
      }),
      new ApiError(400, {
        code: 'VALIDATION_ERROR',
        message: 'invalid',
        details: [{ path: ['timeZone'], message: 'must be an IANA time zone name' }],
      }),
    ];
    const save = new MutationObserver(
      queryClient,
      updateTimeZoneOptions(queryClient, session.refetch, () =>
        Promise.reject(failures.shift() ?? new Error('no failure left')),
      ),
    );
    try {
      await me.observer.refetch();
      const body = { timeZone: 'America/New_York', expectedAccountId: following.id };

      await expect(save.mutate(body)).rejects.toThrow('other account');
      expect(session.count()).toBe(1);
      await expect(save.mutate(body)).rejects.toThrow('invalid');
      expect(session.count()).toBe(1);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(following);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('asks for the session again when the nickname PATCH is refused for another account (#58)', async () => {
    // PATCH /me names the account since #58 (`expectedAccountId`): its 403 is the same sign of a
    // switch as the time zone's. A refused nickname (the rules, the interval) is not.
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const me = meObserver(queryClient, () => Promise.resolve(following));
    const failures = [
      new ApiError(403, {
        code: 'FORBIDDEN',
        message: 'other account',
        details: [{ path: ['expectedAccountId'], message: 'session belongs to another account' }],
      }),
      new ApiError(409, {
        code: 'NICKNAME_NOT_ALLOWED',
        message: 'taken',
        details: { reason: 'taken' },
      }),
    ];
    const rename = new MutationObserver(
      queryClient,
      updateNicknameOptions(queryClient, session.refetch, () =>
        Promise.reject(failures.shift() ?? new Error('no failure left')),
      ),
    );
    try {
      await me.observer.refetch();
      const body = { nickname: '새이름', expectedAccountId: following.id };

      await expect(rename.mutate(body)).rejects.toThrow('other account');
      expect(session.count()).toBe(1);
      await expect(rename.mutate(body)).rejects.toThrow('taken');
      expect(session.count()).toBe(1);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(following);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('asks GET /me again before the nickname PATCH’s ONBOARDING_REQUIRED reaches the card (owner decision 2026-10-22 answer 1)', async () => {
    // The server changes no nickname of an account that has not done its onboarding — a revision
    // asked for the consent again while MY 설정 was open: the refusal settles only once `['me']` says
    // so, and MY 설정's step (`useSettingsStep().afterRefusal`) reads where to go from it. A refused
    // nickname (the rules) asks nothing.
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const onboarded: Me = {
      ...following,
      onboarding: {
        ...following.onboarding,
        consent: true,
        verification: true,
        nickname: true,
        completed: true,
        nextStep: null,
      },
    };
    const reconsent: Me = {
      ...onboarded,
      onboarding: {
        ...onboarded.onboarding,
        consent: false,
        completed: false,
        nextStep: 'consent',
      },
    };
    const me = meObserver(queryClient, (request) =>
      Promise.resolve(request === 1 ? onboarded : reconsent),
    );
    const failures = [
      new ApiError(409, {
        code: 'ONBOARDING_REQUIRED',
        message: 'onboarding',
        details: { steps: ['consent'] },
      }),
      new ApiError(409, {
        code: 'NICKNAME_NOT_ALLOWED',
        message: 'reserved',
        details: { reason: 'reserved_word' },
      }),
    ];
    const rename = new MutationObserver(
      queryClient,
      updateNicknameOptions(queryClient, session.refetch, () =>
        Promise.reject(failures.shift() ?? new Error('no failure left')),
      ),
    );
    try {
      await me.observer.refetch();
      const body = { nickname: '새이름', expectedAccountId: following.id };

      await expect(rename.mutate(body)).rejects.toThrow('onboarding');
      // No settling first: the new `['me']` is there as the refusal arrives.
      expect(me.requests()).toBe(2);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.onboarding.nextStep).toBe('consent');
      await expect(rename.mutate(body)).rejects.toThrow('reserved');
      await settle();
      expect(me.requests()).toBe(2);
      expect(session.count()).toBe(0);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('writes the 소개 PUT /me/bio answered — set and cleared — into every observer (#41)', async () => {
    const queryClient = getQueryClient();
    const sent: UpdateBioBody[] = [];
    const me = meObserver(queryClient, () => Promise.resolve(following));
    const save = new MutationObserver(
      queryClient,
      updateBioOptions(
        queryClient,
        () => undefined,
        (body) => {
          sent.push(body);
          return Promise.resolve({
            ...following,
            profile: { ...following.profile, bio: body.bio },
          });
        },
      ),
    );
    try {
      await me.observer.refetch();

      const body = { bio: '안녕하세요', expectedAccountId: following.id };
      await save.mutate(body);
      expect(me.observer.getCurrentResult().data?.profile.bio).toBe('안녕하세요');

      // Clearing is a `null` (decision 7: open during a restriction), and it lands the same way.
      const clear = { bio: null, expectedAccountId: following.id };
      await save.mutate(clear);
      expect(me.observer.getCurrentResult().data?.profile.bio).toBeNull();
      expect(sent).toEqual([body, clear]);
      expect(me.requests()).toBe(1);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('asks for the session on another account, and GET /me again on ONBOARDING_REQUIRED (#41)', async () => {
    // MY 설정 is reached onboarded: ONBOARDING_REQUIRED says another tab or a revision changed
    // that, so `['me']` is asked again and the gate follows it. A refused 소개 (too long) is
    // neither.
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const me = meObserver(queryClient, () => Promise.resolve(following));
    const failures = [
      new ApiError(403, {
        code: 'FORBIDDEN',
        message: 'other account',
        details: [{ path: ['expectedAccountId'], message: 'session belongs to another account' }],
      }),
      new ApiError(409, {
        code: 'ONBOARDING_REQUIRED',
        message: 'onboarding',
        details: { steps: ['consent'] },
      }),
      new ApiError(400, {
        code: 'VALIDATION_ERROR',
        message: 'invalid',
        details: [{ path: ['bio'], message: 'at most 160 characters, not 161' }],
      }),
    ];
    const save = new MutationObserver(
      queryClient,
      updateBioOptions(queryClient, session.refetch, () =>
        Promise.reject(failures.shift() ?? new Error('no failure left')),
      ),
    );
    try {
      await me.observer.refetch();
      const body = { bio: '소개', expectedAccountId: following.id };

      await expect(save.mutate(body)).rejects.toThrow('other account');
      expect(session.count()).toBe(1);
      expect(me.requests()).toBe(1);
      await expect(save.mutate(body)).rejects.toThrow('onboarding');
      await settle();
      expect(session.count()).toBe(1);
      expect(me.requests()).toBe(2);
      await expect(save.mutate(body)).rejects.toThrow('invalid');
      await settle();
      expect(session.count()).toBe(1);
      expect(me.requests()).toBe(2);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(following);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });
});
