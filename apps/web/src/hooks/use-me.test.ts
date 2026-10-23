import {
  InfiniteQueryObserver,
  MutationObserver,
  QueryObserver,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  api,
  type DeleteProfileImageBody,
  type Me,
  type Post,
  type PostAuthor,
  type PostComment,
  type PostSummary,
  type UpdateBioBody,
  type UpdateTimeZoneBody,
} from '@/lib/api';
import { type CommentPage, type CommentPages, postCommentsKey } from '@/lib/comments';
import {
  type CountedPostPage,
  type PostPage,
  communityPostsKey,
  marketPostsKey,
  postKey,
} from '@/lib/posts';
import { getQueryClient } from '@/lib/query-client';
import {
  ME_QUERY_KEY,
  type ProfileImageUpload,
  deleteProfileImageOptions,
  putProfileImage,
  storeMe,
  updateBioOptions,
  updateNicknameOptions,
  updateTimeZoneOptions,
  uploadProfileImageOptions,
} from './use-me';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The profile writes' cache writes (`PATCH /me`, `PUT /me/time-zone`, `PUT /me/bio`, the profile
 * image's upload and deletion), driven through the REAL
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
    imageUrl: null,
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

/** A stored profile image's id, as `GET /media/:mediaId` serves it. */
const IMAGE = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const NEXT_IMAGE = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

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

  it('takes the image’s address alone from a profile image answer (#141)', async () => {
    const queryClient = getQueryClient();
    const me = meObserver(queryClient, () => Promise.resolve(inNewYork));
    try {
      await me.observer.refetch();
      const withImage: Me = {
        ...following,
        profile: { ...following.profile, nickname: '옛이름', imageUrl: `/api/v1/media/${IMAGE}` },
      };

      await storeMe(queryClient, withImage, 'image', () => undefined);

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.profile).toEqual({
        ...inNewYork.profile,
        imageUrl: `/api/v1/media/${IMAGE}`,
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

describe('the profile image (#141)', () => {
  it('sends the file itself, under its type, with the account in the query', async () => {
    const answered: Me = {
      ...following,
      profile: { ...following.profile, imageUrl: `/api/v1/media/${IMAGE}` },
    };
    // openapi-fetch's `{ data, response }`, the shape `unwrap` reads.
    const reply: never = {
      data: { data: answered },
      response: new Response(null, { status: 200 }),
    } as never;
    const put = vi.spyOn(api, 'PUT').mockResolvedValue(reply);
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });

    await expect(putProfileImage({ file, expectedAccountId: following.id })).resolves.toEqual(
      answered,
    );

    const [path, init] = put.mock.calls[0] as unknown as [
      string,
      {
        params: unknown;
        body: unknown;
        headers: Record<string, string>;
        bodySerializer: (body: unknown) => unknown;
      },
    ];
    expect(path).toBe('/api/v1/me/profile-image');
    expect(init.params).toEqual({ query: { expectedAccountId: following.id } });
    expect(init.headers).toEqual({ 'Content-Type': 'image/webp' });
    // The file as it is: neither JSON nor a form.
    expect(init.bodySerializer(init.body)).toBe(file);
  });

  it('writes the address each upload answers into every observer, and null once deleted', async () => {
    const queryClient = getQueryClient();
    const me = meObserver(queryClient, () => Promise.resolve(following));
    const sent: ProfileImageUpload[] = [];
    const answers = [IMAGE, NEXT_IMAGE];
    const upload = new MutationObserver(
      queryClient,
      uploadProfileImageOptions(
        queryClient,
        () => undefined,
        (body) => {
          sent.push(body);
          const id = answers.shift() ?? IMAGE;
          return Promise.resolve({
            ...following,
            profile: { ...following.profile, imageUrl: `/api/v1/media/${id}` },
          });
        },
      ),
    );
    const deletions: DeleteProfileImageBody[] = [];
    const remove = new MutationObserver(
      queryClient,
      deleteProfileImageOptions(
        queryClient,
        () => undefined,
        (body) => {
          deletions.push(body);
          return Promise.resolve(following);
        },
      ),
    );
    const image = () => me.observer.getCurrentResult().data?.profile.imageUrl;
    try {
      await me.observer.refetch();
      const file = new Blob([new Uint8Array([1])], { type: 'image/png' });

      await upload.mutate({ file, expectedAccountId: following.id });
      expect(image()).toBe(`/api/v1/media/${IMAGE}`);
      // A replacement is a new address (a new id per upload), so no cache shows the old image.
      await upload.mutate({ file, expectedAccountId: following.id });
      expect(image()).toBe(`/api/v1/media/${NEXT_IMAGE}`);
      await remove.mutate({ expectedAccountId: following.id });
      expect(image()).toBeNull();

      expect(sent.map((body) => body.expectedAccountId)).toEqual([following.id, following.id]);
      expect(deletions).toEqual([{ expectedAccountId: following.id }]);
      expect(me.requests()).toBe(1);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('asks for the session on another account, GET /me again on ONBOARDING_REQUIRED, and neither for a refused file', async () => {
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
      new ApiError(422, {
        code: 'IMAGE_NOT_ALLOWED',
        message: 'refused',
        details: { reason: 'type' },
      }),
    ];
    const upload = new MutationObserver(
      queryClient,
      uploadProfileImageOptions(queryClient, session.refetch, () =>
        Promise.reject(failures.shift() ?? new Error('no failure left')),
      ),
    );
    try {
      await me.observer.refetch();
      const body = {
        file: new Blob([new Uint8Array([1])], { type: 'image/png' }),
        expectedAccountId: following.id,
      };

      await expect(upload.mutate(body)).rejects.toThrow('other account');
      expect(session.count()).toBe(1);
      expect(me.requests()).toBe(1);
      await expect(upload.mutate(body)).rejects.toThrow('onboarding');
      await settle();
      expect(session.count()).toBe(1);
      expect(me.requests()).toBe(2);
      await expect(upload.mutate(body)).rejects.toThrow('refused');
      await settle();
      expect(session.count()).toBe(1);
      expect(me.requests()).toBe(2);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(following);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('sends a profile image again after a 429 that asks to wait, twice at most, as the post editor does (ADR-0079 7-18)', async () => {
    const queryClient = getQueryClient();
    const me = meObserver(queryClient, () => Promise.resolve(following));
    const busy = (seconds: number) =>
      new ApiError(429, {
        code: 'RATE_LIMITED',
        message: 'busy',
        details: { retryAfterSeconds: seconds },
      });
    const slept: number[] = [];
    const retry = {
      sleep: (ms: number) => {
        slept.push(ms);
        return Promise.resolve();
      },
      alive: () => true,
    };
    const answers: (() => Promise<Me>)[] = [];
    const sent: ProfileImageUpload[] = [];
    const upload = new MutationObserver(
      queryClient,
      uploadProfileImageOptions(
        queryClient,
        () => undefined,
        (body) => {
          sent.push(body);
          return answers.shift()!();
        },
        retry,
      ),
    );
    const body = {
      file: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      expectedAccountId: following.id,
    };
    try {
      await me.observer.refetch();
      // Busy twice, then stored: the third send is the outcome.
      answers.push(
        () => Promise.reject(busy(2)),
        () => Promise.reject(busy(2)),
        () =>
          Promise.resolve({
            ...following,
            profile: { ...following.profile, imageUrl: `/api/v1/media/${IMAGE}` },
          }),
      );
      await upload.mutate(body);
      expect(sent).toEqual([body, body, body]);
      expect(slept).toEqual([2_000, 2_000]);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.profile.imageUrl).toBe(
        `/api/v1/media/${IMAGE}`,
      );
      // Busy three times: the third refusal is the outcome.
      sent.length = 0;
      slept.length = 0;
      answers.push(
        () => Promise.reject(busy(2)),
        () => Promise.reject(busy(2)),
        () => Promise.reject(busy(2)),
      );
      await expect(upload.mutate(body)).rejects.toThrow('busy');
      expect(sent).toHaveLength(3);
      expect(slept).toEqual([2_000, 2_000]);
      // A wait longer than 10 seconds, and any other refusal, is the outcome at once.
      sent.length = 0;
      slept.length = 0;
      answers.push(() => Promise.reject(busy(60)));
      await expect(upload.mutate(body)).rejects.toThrow('busy');
      answers.push(() =>
        Promise.reject(
          new ApiError(422, {
            code: 'IMAGE_NOT_ALLOWED',
            message: 'refused',
            details: { reason: 'type' },
          }),
        ),
      );
      await expect(upload.mutate(body)).rejects.toThrow('refused');
      expect(sent).toHaveLength(2);
      expect(slept).toEqual([]);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('asks for the session again when a deletion is refused for another account', async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const me = meObserver(queryClient, () => Promise.resolve(following));
    const remove = new MutationObserver(
      queryClient,
      deleteProfileImageOptions(queryClient, session.refetch, () =>
        Promise.reject(
          new ApiError(403, {
            code: 'FORBIDDEN',
            message: 'other account',
            details: [
              { path: ['expectedAccountId'], message: 'session belongs to another account' },
            ],
          }),
        ),
      ),
    );
    try {
      await me.observer.refetch();
      await expect(remove.mutate({ expectedAccountId: following.id })).rejects.toThrow(
        'other account',
      );
      expect(session.count()).toBe(1);
      expect(me.requests()).toBe(1);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(following);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });
});

/**
 * The faces of the member a card, a post or a comment the tab holds carries, after the member's
 * profile image changed (Codex review on PR #225, ADR-0079 7-21): every one of them shows the new
 * address — or none, once deleted — at once, the rest of each entry as it was.
 */
describe('the member’s faces the tab holds, after a profile image change (#141, ADR-0079 7-21)', () => {
  const OWN = following.profile.publicId;
  const OTHER = 'a2b3c4d5e6';
  const POST = 'b7c9a1d2-6f34-4e58-9b0a-2d1e5f8c7a46';
  const OTHER_POST = '6f9619ff-8b86-d011-b42d-00c04fc964ff';
  const FORMER_POST = '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
  const MARKET = 'd3b07384-d9a0-4c9b-8e2f-2d1c0f8a4b11';
  const OLD = `/api/v1/media/${IMAGE}`;
  const NEW = `/api/v1/media/${NEXT_IMAGE}`;
  const OTHER_IMAGE = '/api/v1/media/5a1d2f3e-6b7c-4d8e-9f0a-1b2c3d4e5f60';
  const market = {
    id: MARKET,
    slug: 'rate-cut',
    title: '금리 인하?',
    status: 'open',
    category: { slug: 'economy', nameKo: '경제' },
  } as const;

  const face = (publicId: string, imageUrl: string | null): PostAuthor => ({
    kind: 'member',
    publicId,
    nickname: publicId === OWN ? following.profile.nickname : '근거왕',
    imageUrl,
    isAdmin: false,
  });
  const card = (id: string, author: PostAuthor): PostSummary => ({
    id,
    title: '제목',
    excerpt: '본문',
    thumbnailUrl: null,
    author,
    market,
    createdAt: '2026-10-18T00:00:00.000Z',
    editedAt: null,
    commentCount: 2,
    likeCount: 1,
  });
  const postOf = (id: string, author: PostAuthor): Post => ({
    state: 'published',
    id,
    title: '제목',
    body: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '본문' }] }],
    },
    author,
    market,
    createdAt: '2026-10-18T00:00:00.000Z',
    editedAt: null,
    commentCount: 2,
    likeCount: 1,
  });
  const comment = (
    id: string,
    author: PostAuthor,
    parentId: string | null = null,
  ): PostComment => ({
    state: 'published',
    id,
    parentId,
    body: '댓글',
    author,
    createdAt: '2026-10-19T00:00:00.000Z',
    editedAt: null,
    likeCount: 0,
  });
  const C1 = '11111111-1111-4111-8111-111111111111';
  const C2 = '22222222-2222-4222-8222-222222222222';
  const C3 = '33333333-3333-4333-8333-333333333333';
  const R1 = '44444444-4444-4444-8444-444444444444';
  const R2 = '55555555-5555-4555-8555-555555555555';
  const R3 = '66666666-6666-4666-8666-666666666666';
  const R4 = '77777777-7777-4777-8777-777777777777';

  /** The member's own 댓글 C1 (a 대댓글 of someone else's, one of theirs and a hidden one under it,
   * more to read by '답글 더 보기'), a deleted 댓글 with their 대댓글, and someone else's 댓글. */
  const commentPage = (image: string | null, nextCursor: string | null = null): CommentPage => ({
    items: [
      {
        comment: comment(C1, face(OWN, image)),
        replies: [
          comment(R1, face(OTHER, OTHER_IMAGE), C1),
          comment(R2, face(OWN, image), C1),
          { state: 'hidden', id: R3 },
        ],
        repliesNextCursor: 'r1',
      },
      {
        comment: { state: 'deleted', id: C2 },
        replies: [comment(R4, face(OWN, image), C2)],
        repliesNextCursor: null,
      },
      { comment: comment(C3, face(OTHER, null)), replies: [], repliesNextCursor: null },
    ],
    nextCursor,
  });

  /** Every face of the member's the entries hold, as `[where, imageUrl]`. */
  function ownFaces(queryClient: QueryClient): [string, string | null][] {
    const faces: [string, string | null][] = [];
    const add = (where: string, author: PostAuthor) => {
      if (author.kind === 'member' && author.publicId === OWN) faces.push([where, author.imageUrl]);
    };
    for (const [key, held] of queryClient.getQueriesData<
      InfiniteData<PostPage> | Post | CommentPages
    >({ queryKey: ['posts'] })) {
      const where = JSON.stringify(key);
      if (held === undefined) continue;
      if ('state' in held) {
        if (held.state === 'published') add(where, held.author);
      } else if (key[1] === 'comments') {
        for (const page of (held as CommentPages).pages)
          for (const thread of page.items)
            for (const each of [thread.comment, ...thread.replies])
              if (each.state === 'published') add(`${where} ${each.id}`, each.author);
      } else {
        for (const page of (held as InfiniteData<PostPage>).pages)
          for (const item of page.items) add(`${where} ${item.id}`, item.author);
      }
    }
    return faces;
  }

  it('puts the new address on every one of the member’s faces — the cards, a market’s 토론, the post page, its 댓글 and 대댓글 — and null once deleted, everyone else’s and each entry’s time, stale mark and failed read as they were, with no read', async () => {
    const queryClient = getQueryClient();
    const withOld: Me = { ...following, profile: { ...following.profile, imageUrl: OLD } };
    queryClient.setQueryData(ME_QUERY_KEY, withOld);
    // Read a minute ago: stale by time, which the patch must not change.
    const readAt = Date.now() - 60_000;
    const seed = (key: readonly unknown[], data: unknown) =>
      queryClient.setQueryData(key, data, { updatedAt: readAt });
    const list: InfiniteData<PostPage> = {
      pages: [
        {
          items: [card(POST, face(OWN, OLD)), card(OTHER_POST, face(OTHER, OTHER_IMAGE))],
          nextCursor: 'c1',
        },
        { items: [card(FORMER_POST, { kind: 'former_member' })], nextCursor: null },
      ],
      pageParams: [undefined, 'c1'],
    };
    const searched: InfiniteData<PostPage> = {
      pages: [{ items: [card(OTHER_POST, face(OTHER, OTHER_IMAGE))], nextCursor: null }],
      pageParams: [undefined],
    };
    const discussion: InfiniteData<CountedPostPage> = {
      pages: [{ items: [card(POST, face(OWN, OLD))], nextCursor: null, total: 1 }],
      pageParams: [undefined],
    };
    const otherPost = postOf(OTHER_POST, face(OTHER, OTHER_IMAGE));
    const otherComments: CommentPages = {
      pages: [
        {
          items: [
            { comment: comment(C3, face(OTHER, null)), replies: [], repliesNextCursor: null },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    };
    seed(communityPostsKey({}), list);
    seed(communityPostsKey({ q: '금리' }), searched);
    seed(marketPostsKey(MARKET), discussion);
    seed(postKey(POST), postOf(POST, face(OWN, OLD)));
    seed(postKey(OTHER_POST), otherPost);
    seed(postKey(FORMER_POST), { state: 'hidden', id: FORMER_POST, market, commentCount: 0 });
    seed(postCommentsKey(POST), { pages: [commentPage(OLD)], pageParams: [undefined] });
    seed(postCommentsKey(OTHER_POST), otherComments);
    // A write elsewhere marked the comment pages to be read again: they stay so.
    await queryClient.invalidateQueries({
      queryKey: postCommentsKey(POST),
      exact: true,
      refetchType: 'none',
    });
    // The post's last read failed — deleted in another tab: its NOT_FOUND, which the post page
    // draws as its 404 (post-screen.tsx), stays with the post held.
    const gone = new ApiError(404, { code: 'NOT_FOUND', message: 'gone' });
    await queryClient
      .fetchQuery({ queryKey: postKey(POST), queryFn: () => Promise.reject(gone), retry: false })
      .catch(() => undefined);
    expect(queryClient.getQueryState(postKey(POST))?.status).toBe('error');
    expect(ownFaces(queryClient).map(([, image]) => image)).toEqual(Array(6).fill(OLD));

    const answers: Me[] = [{ ...following, profile: { ...following.profile, imageUrl: NEW } }];
    const upload = new MutationObserver(
      queryClient,
      uploadProfileImageOptions(
        queryClient,
        () => undefined,
        () => Promise.resolve(answers.shift() ?? following),
      ),
    );
    const remove = new MutationObserver(
      queryClient,
      deleteProfileImageOptions(
        queryClient,
        () => undefined,
        () => Promise.resolve(following),
      ),
    );
    try {
      await upload.mutate({
        file: new Blob([new Uint8Array([1])], { type: 'image/png' }),
        expectedAccountId: following.id,
      });
      // Six faces: a community card, a 토론 card, the post's byline, 댓글 C1, 대댓글 R2 and R4.
      const faces = ownFaces(queryClient);
      expect(faces).toHaveLength(6);
      expect(faces.filter(([, image]) => image !== NEW)).toEqual([]);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.profile.imageUrl).toBe(NEW);
      // Everyone else's, untouched — the very objects held.
      const listHeld = queryClient.getQueryData<InfiniteData<PostPage>>(communityPostsKey({}));
      expect(listHeld?.pages[0]?.items[1]).toBe(list.pages[0]?.items[1]);
      expect(listHeld?.pages[1]).toBe(list.pages[1]);
      expect(queryClient.getQueryData(communityPostsKey({ q: '금리' }))).toBe(searched);
      expect(queryClient.getQueryData(postKey(OTHER_POST))).toBe(otherPost);
      expect(queryClient.getQueryData(postCommentsKey(OTHER_POST))).toBe(otherComments);
      const thread = queryClient.getQueryData<CommentPages>(postCommentsKey(POST))?.pages[0]
        ?.items[0];
      expect(thread?.replies[0]).toEqual(comment(R1, face(OTHER, OTHER_IMAGE), C1));
      expect(thread?.replies[2]).toEqual({ state: 'hidden', id: R3 });
      expect(thread?.repliesNextCursor).toBe('r1');
      expect(
        queryClient.getQueryData<InfiniteData<CountedPostPage>>(marketPostsKey(MARKET))?.pages[0]
          ?.total,
      ).toBe(1);
      // Each entry's time and stale mark as they were, and nothing read.
      for (const key of [
        communityPostsKey({}),
        marketPostsKey(MARKET),
        postKey(POST),
        postCommentsKey(POST),
      ]) {
        expect(queryClient.getQueryState(key)?.dataUpdatedAt).toBe(readAt);
      }
      expect(queryClient.getQueryState(postCommentsKey(POST))?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(marketPostsKey(MARKET))?.isInvalidated).toBe(false);
      expect(queryClient.getQueryState(postKey(POST))).toMatchObject({
        status: 'error',
        error: gone,
      });
      expect(queryClient.isFetching()).toBe(0);

      // Deleted: no image on any of them — the nickname's first letter is drawn.
      await remove.mutate({ expectedAccountId: following.id });
      expect(ownFaces(queryClient).map(([, image]) => image)).toEqual(Array(6).fill(null));
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.profile.imageUrl).toBeNull();
      expect(queryClient.getQueryState(postCommentsKey(POST))?.dataUpdatedAt).toBe(readAt);
      expect(queryClient.isFetching()).toBe(0);
    } finally {
      queryClient.clear();
    }
  });

  it('cancels a read on its way, which may have left before the change, and makes it again; a 더 보기 on its way is cancelled and left to press again', async () => {
    const queryClient = getQueryClient();
    queryClient.setQueryData(ME_QUERY_KEY, {
      ...following,
      profile: { ...following.profile, imageUrl: OLD },
    });
    const postReads: ReturnType<typeof deferred<Post>>[] = [];
    const post = new QueryObserver<Post>(queryClient, {
      queryKey: postKey(POST),
      queryFn: () => {
        const read = deferred<Post>();
        postReads.push(read);
        return read.promise;
      },
      retry: false,
    });
    const pageReads: ReturnType<typeof deferred<CommentPage>>[] = [];
    const comments = new InfiniteQueryObserver<
      CommentPage,
      Error,
      CommentPages,
      readonly unknown[],
      string | undefined
    >(queryClient, {
      queryKey: postCommentsKey(POST),
      queryFn: () => {
        const read = deferred<CommentPage>();
        pageReads.push(read);
        return read.promise;
      },
      initialPageParam: undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      retry: false,
    });
    const unsubscribe = [post.subscribe(() => undefined), comments.subscribe(() => undefined)];
    const postImage = () => {
      const held = post.getCurrentResult().data;
      return held?.state === 'published' && held.author.kind === 'member'
        ? held.author.imageUrl
        : 'none';
    };
    const upload = new MutationObserver(
      queryClient,
      uploadProfileImageOptions(
        queryClient,
        () => undefined,
        () => Promise.resolve({ ...following, profile: { ...following.profile, imageUrl: NEW } }),
      ),
    );
    try {
      postReads[0]?.resolve(postOf(POST, face(OWN, OLD)));
      pageReads[0]?.resolve(commentPage(OLD, 'c1'));
      await settle();
      // A read of the post (a focus) and a 더 보기 of the comments leave before the write commits.
      void post.refetch();
      void comments.fetchNextPage();
      await settle();
      expect(postReads).toHaveLength(2);
      expect(pageReads).toHaveLength(2);

      await upload.mutate({
        file: new Blob([new Uint8Array([1])], { type: 'image/png' }),
        expectedAccountId: following.id,
      });
      await settle();
      expect(postImage()).toBe(NEW);
      // The post's read was made again; the 더 보기 was not — its button is there to press.
      expect(postReads).toHaveLength(3);
      expect(pageReads).toHaveLength(2);
      // The reads that left before land late, and change nothing.
      postReads[1]?.resolve(postOf(POST, face(OWN, OLD)));
      pageReads[1]?.resolve({
        items: [{ comment: comment(C2, face(OWN, OLD)), replies: [], repliesNextCursor: null }],
        nextCursor: null,
      });
      await settle();
      expect(postImage()).toBe(NEW);
      const pages = comments.getCurrentResult();
      expect(pages.data?.pages).toHaveLength(1);
      expect(pages.hasNextPage).toBe(true);
      expect(pages.isFetchingNextPage).toBe(false);
      expect(ownFaces(queryClient).map(([, image]) => image)).toEqual(Array(4).fill(NEW));
      // The read made again reads the change.
      postReads[2]?.resolve(postOf(POST, face(OWN, NEW)));
      await settle();
      expect(postImage()).toBe(NEW);
      expect(post.getCurrentResult().isFetching).toBe(false);
    } finally {
      for (const stop of unsubscribe) stop();
      queryClient.clear();
    }
  });
});
