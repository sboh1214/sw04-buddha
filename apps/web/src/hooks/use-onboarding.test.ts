import { MutationObserver, QueryObserver, type QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ApiError, type Me } from '@/lib/api';
import { getQueryClient } from '@/lib/query-client';
import { ME_QUERY_KEY } from './use-me';
import {
  recordConsentsOptions,
  setInterestCategoriesOptions,
  setOnboardingNicknameOptions,
  storeOnboardingAnswer,
} from './use-onboarding';

/**
 * The onboarding's cache writes (#58, ADR-0072), driven through the REAL QueryClient
 * (`getQueryClient()` answers a fresh one per call under node). The `['me']` observer stands in for
 * the stepper and the gate, which both read `onboarding.nextStep` there: a write's answer must be
 * in the entry when its mutation settles, must not be undone by a `GET /me` that left before it,
 * and must never land in another account's entry.
 */

const consents = (['terms', 'privacy', 'age', 'marketing'] as const).map((item) => ({
  item,
  version: 'draft-2026-10-18',
  agreed: item !== 'marketing',
  recordedAt: '2026-10-18T00:00:00.000Z',
}));

/** A new account as the stepper first sees it: nothing done. */
const fresh: Me = {
  id: 'user-1',
  email: 'a@example.com',
  emailVerified: true,
  profile: {
    nickname: 'user_ab12',
    role: 'user',
    createdAt: '2026-10-18T00:00:00.000Z',
    timeZone: null,
    nicknameChangeAvailableAt: null,
    interestCategoryIds: [],
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

/** The consent step's answer. */
const consented: Me = {
  ...fresh,
  onboarding: { ...fresh.onboarding, consent: true, nextStep: 'verification', consents },
};

/** The nickname step's answer: the start Coin paid with it. */
const verifiedMe: Me = {
  ...consented,
  verification: {
    realName: '홍길동',
    phone: '01012345678',
    verifiedAt: '2026-10-18T00:00:00.000Z',
  },
  onboarding: { ...consented.onboarding, verification: true, nextStep: 'nickname' },
};
const named: Me = {
  ...verifiedMe,
  profile: { ...verifiedMe.profile, nickname: '새닉네임' },
  balance: { availableCoin: '10000', lockedCoin: '0' },
  startGrant: { status: 'granted', amountCoin: '10000', grantedAt: '2026-10-18T00:00:01.000Z' },
  onboarding: { ...verifiedMe.onboarding, nickname: true, completed: true, nextStep: null },
};

const otherMe: Me = { ...fresh, id: 'user-2', email: 'b@example.com' };

const refused = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code: code as never,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  });

const forAnotherAccount = () =>
  refused(403, 'FORBIDDEN', [
    { path: ['expectedAccountId'], message: 'session belongs to another account' },
  ]);

function sessionRefetches() {
  let count = 0;
  return {
    onSessionChanged: () => {
      count += 1;
    },
    count: () => count,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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

describe('storeOnboardingAnswer', () => {
  it('moves the stepper on with the answer, without a request (the consent step)', async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const me = meObserver(queryClient, () => Promise.resolve(fresh));
    try {
      await me.observer.refetch();

      await storeOnboardingAnswer(queryClient, consented, 'consent', session.onSessionChanged);

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(consented);
      expect(me.observer.getCurrentResult().data?.onboarding.nextStep).toBe('verification');
      expect(me.requests()).toBe(1);
      expect(session.count()).toBe(0);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('cancels a GET /me that left before the write, so it cannot put the step back', async () => {
    const queryClient = getQueryClient();
    const stale = deferred<Me>();
    const me = meObserver(queryClient, (request) =>
      request === 1 ? Promise.resolve(fresh) : stale.promise,
    );
    try {
      await me.observer.refetch();
      const inflight = me.observer.refetch();

      await storeOnboardingAnswer(queryClient, consented, 'consent', () => undefined);
      stale.resolve(fresh);
      await inflight;
      await settle();

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.onboarding.nextStep).toBe('verification');
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('after the nickname step, shows the start Coin at once and asks GET /me again for the balance', async () => {
    const queryClient = getQueryClient();
    const me = meObserver(queryClient, (request) =>
      Promise.resolve(request === 1 ? verifiedMe : named),
    );
    try {
      await me.observer.refetch();

      await storeOnboardingAnswer(queryClient, named, 'nickname', () => undefined);

      // At once: what the notice screen reads.
      const held = queryClient.getQueryData<Me>(ME_QUERY_KEY);
      expect(held?.startGrant).toEqual(named.startGrant);
      expect(held?.profile.nickname).toBe('새닉네임');
      expect(held?.onboarding).toMatchObject({ completed: true, nextStep: null });
      // Then the balance, from a GET /me of its own (not taken from the write's snapshot).
      await settle();
      expect(me.requests()).toBe(2);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.balance.availableCoin).toBe('10000');
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it("leaves another account's profile alone and asks for the session again", async () => {
    // THE HAZARD: the write went to the cookie's account while the tab shows another one.
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const me = meObserver(queryClient, () => Promise.resolve(otherMe));
    try {
      await me.observer.refetch();

      await storeOnboardingAnswer(queryClient, consented, 'consent', session.onSessionChanged);

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(otherMe);
      expect(session.count()).toBe(1);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('builds no profile out of an answer when nothing has asked for one', async () => {
    const queryClient = getQueryClient();
    await storeOnboardingAnswer(queryClient, consented, 'consent', () => undefined);
    expect(queryClient.getQueryState(ME_QUERY_KEY)).toBeUndefined();
    queryClient.clear();
  });
});

describe('the onboarding mutations', () => {
  it('records the consent and settles only once ["me"] holds it', async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const posted: unknown[] = [];
    const me = meObserver(queryClient, () => Promise.resolve(fresh));
    try {
      await me.observer.refetch();
      const record = new MutationObserver(
        queryClient,
        recordConsentsOptions(queryClient, session.onSessionChanged, (body) => {
          posted.push(body);
          return Promise.resolve(consented);
        }),
      );
      const body = {
        consents: {
          terms: { version: 'draft-2026-10-18', agreed: true },
          privacy: { version: 'draft-2026-10-18', agreed: true },
          age: { version: 'draft-2026-10-18', agreed: true },
          marketing: { version: 'draft-2026-10-18', agreed: false },
        },
        expectedAccountId: 'user-1',
      } as const;

      await record.mutate(body);

      expect(posted).toEqual([body]);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.onboarding.nextStep).toBe('verification');
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('refetches the session on a refusal as another account, for every step', async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const rejectAsOther = () => Promise.reject(forAnotherAccount());
    const consent = new MutationObserver(
      queryClient,
      recordConsentsOptions(queryClient, session.onSessionChanged, rejectAsOther),
    );
    const nickname = new MutationObserver(
      queryClient,
      setOnboardingNicknameOptions(queryClient, session.onSessionChanged, rejectAsOther),
    );
    const interests = new MutationObserver(
      queryClient,
      setInterestCategoriesOptions(queryClient, session.onSessionChanged, rejectAsOther),
    );

    await expect(consent.mutate({} as never)).rejects.toBeInstanceOf(ApiError);
    await expect(
      nickname.mutate({ nickname: 'x', expectedAccountId: 'user-1' }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      interests.mutate({ categoryIds: [], expectedAccountId: 'user-1' }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(session.count()).toBe(3);
    queryClient.clear();
  });

  it("asks ['me'] again when the nickname step was done elsewhere, or a step before it is not", async () => {
    for (const error of [
      refused(409, 'NICKNAME_NOT_ALLOWED', { reason: 'already_set' }),
      refused(409, 'ONBOARDING_REQUIRED', { steps: ['verification'] }),
    ]) {
      const queryClient = getQueryClient();
      const me = meObserver(queryClient, (request) =>
        Promise.resolve(request === 1 ? verifiedMe : named),
      );
      try {
        await me.observer.refetch();
        const nickname = new MutationObserver(
          queryClient,
          setOnboardingNicknameOptions(
            queryClient,
            () => undefined,
            () => Promise.reject(error),
          ),
        );

        await expect(
          nickname.mutate({ nickname: 'user_ab12', expectedAccountId: 'user-1' }),
        ).rejects.toBe(error);

        // Already refreshed when the rejection reaches the step: the stepper follows the server.
        expect(me.requests()).toBe(2);
      } finally {
        me.unsubscribe();
        queryClient.clear();
      }
    }
  });

  it('leaves the cache alone on a nickname rule refusal: the step says it under the input', async () => {
    const queryClient = getQueryClient();
    const me = meObserver(queryClient, () => Promise.resolve(verifiedMe));
    try {
      await me.observer.refetch();
      const nickname = new MutationObserver(
        queryClient,
        setOnboardingNicknameOptions(
          queryClient,
          () => undefined,
          () => Promise.reject(refused(409, 'NICKNAME_NOT_ALLOWED', { reason: 'taken' })),
        ),
      );

      await expect(
        nickname.mutate({ nickname: 'Taken', expectedAccountId: 'user-1' }),
      ).rejects.toBeInstanceOf(ApiError);

      expect(me.requests()).toBe(1);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(verifiedMe);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('records the interest categories (none: the skip) and finishes the onboarding', async () => {
    const queryClient = getQueryClient();
    const done: Me = {
      ...named,
      profile: { ...named.profile, interestCategoryIds: [] },
      onboarding: { ...named.onboarding, interests: true, nextStep: null },
    };
    const me = meObserver(queryClient, () => Promise.resolve(named));
    try {
      await me.observer.refetch();
      const interests = new MutationObserver(
        queryClient,
        setInterestCategoriesOptions(
          queryClient,
          () => undefined,
          () => Promise.resolve(done),
        ),
      );

      await interests.mutate({ categoryIds: [], expectedAccountId: 'user-1' });

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.onboarding.nextStep).toBeNull();
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });
});
