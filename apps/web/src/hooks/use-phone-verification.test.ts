import { MutationObserver, QueryObserver, type QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ApiError, type Me, type PhoneVerification } from '@/lib/api';
import { getQueryClient } from '@/lib/query-client';
import { ME_QUERY_KEY } from './use-me';
import {
  confirmVerificationOptions,
  requestCodeOptions,
  storeVerification,
  updateRealNameOptions,
} from './use-phone-verification';

/**
 * 본인확인's cache writes (ADR-0070), driven through the REAL QueryClient (`getQueryClient()`
 * answers a fresh one per call under node). Nothing renders: apps/web runs vitest under
 * `environment: 'node'`, which is why `storeVerification` and the mutations' options are exported
 * apart from their hooks. The `['me']` observer stands in for the onboarding gate, which observes
 * that entry on every page.
 *
 * Every write names the account the screen shows (`expectedAccountId`, A-PG-24). The server
 * compares it with the cookie; what these tests pin is the client half — what a refusal as
 * another account does, what "verified already" does, and that an answer landing after the tab
 * switched accounts writes nothing into the other account's `['me']`.
 */

const verified: PhoneVerification = {
  realName: '홍길동',
  phone: '01012345678',
  verifiedAt: '2026-10-18T00:00:00.000Z',
};

/** The account as the gate first sees it: signed in, not verified yet. */
const unverified: Me = {
  id: 'user-1',
  email: 'a@example.com',
  emailVerified: true,
  profile: {
    nickname: '테스터',
    role: 'user',
    createdAt: '2026-08-01T00:00:00.000Z',
    timeZone: null,
  },
  balance: { availableCoin: '0', lockedCoin: '0' },
  linkedAccounts: [],
  verification: null,
};

/** The account the tab switched to while a request ran (SessionCacheGuard reset, then B's GET). */
const otherMe: Me = { ...unverified, id: 'user-2', email: 'b@example.com' };

const refused = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code: code as never,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  });

/** The 403 `assertExpectedAccount` answers when the cookie is not the account the body names. */
const forAnotherAccount = () =>
  refused(403, 'FORBIDDEN', [
    { path: ['expectedAccountId'], message: 'session belongs to another account' },
  ]);

const alreadyVerified = () =>
  refused(409, 'PHONE_VERIFICATION_NOT_ALLOWED', { reason: 'already_verified' });

/** Counts the session refetches a refusal asks for (the hooks pass better-auth's `refetch`). */
function sessionRefetches() {
  let count = 0;
  return {
    onSessionChanged: () => {
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
 * first one, as the gate's mount does.
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

describe('storeVerification', () => {
  it('patches the record into the profile already held, without a request', async () => {
    const queryClient = getQueryClient();
    const me = meObserver(queryClient, () => Promise.resolve(unverified));
    try {
      await me.observer.refetch();

      await storeVerification(queryClient, verified, 'user-1');

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual({
        ...unverified,
        verification: verified,
      });
      expect(me.observer.getCurrentResult().data?.verification).toEqual(verified);
      expect(me.requests()).toBe(1);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('cancels a GET /me that left before the confirmation, so its verification: null cannot land on top', async () => {
    // THE HAZARD: a window-focus refetch is in flight when the confirmation commits. Answering
    // after the patch with the profile it read before, it would send the member from `next`
    // straight back to /onboarding.
    const queryClient = getQueryClient();
    const stale = deferred<Me>();
    const me = meObserver(queryClient, (request) =>
      request === 1 ? Promise.resolve(unverified) : stale.promise,
    );
    try {
      await me.observer.refetch();
      const inflight = me.observer.refetch();
      expect(queryClient.getQueryState(ME_QUERY_KEY)?.fetchStatus).toBe('fetching');

      await storeVerification(queryClient, verified, 'user-1');
      stale.resolve(unverified);
      await inflight;
      await settle();

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.verification).toEqual(verified);
      expect(queryClient.getQueryState(ME_QUERY_KEY)?.fetchStatus).toBe('idle');
      expect(me.requests()).toBe(2);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('re-asks when the cancel leaves nothing to patch (the first GET /me was in flight)', async () => {
    const queryClient = getQueryClient();
    const first = deferred<Me>();
    const me = meObserver(queryClient, (request) =>
      request === 1 ? first.promise : Promise.resolve({ ...unverified, verification: verified }),
    );
    try {
      expect(me.requests()).toBe(1);

      await storeVerification(queryClient, verified, 'user-1');

      expect(me.requests()).toBe(2);
      expect(me.observer.getCurrentResult().data?.verification).toEqual(verified);
      // …and the first request, landing late with what it read before, is dropped.
      first.resolve(unverified);
      await settle();
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.verification).toEqual(verified);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('builds no profile out of a record when nothing has asked for one', async () => {
    const queryClient = getQueryClient();

    await storeVerification(queryClient, verified, 'user-1');

    expect(queryClient.getQueryState(ME_QUERY_KEY)).toBeUndefined();
    queryClient.clear();
  });

  it("leaves another account's profile alone, its refresh in flight included", async () => {
    // THE HAZARD: A's confirmation answers after the tab switched to B. Patching would show A's
    // real name and number on B's screen and let B past the gate.
    const queryClient = getQueryClient();
    const refresh = deferred<Me>();
    const me = meObserver(queryClient, (request) =>
      request === 1 ? Promise.resolve(otherMe) : refresh.promise,
    );
    try {
      await me.observer.refetch();
      const inflight = me.observer.refetch();

      await storeVerification(queryClient, verified, 'user-1');

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(otherMe);
      expect(queryClient.getQueryState(ME_QUERY_KEY)?.fetchStatus).toBe('fetching');
      refresh.resolve(otherMe);
      await inflight;
      expect(me.requests()).toBe(2);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });
});

describe('POST /me/phone-verification/code (requestCodeOptions)', () => {
  const body = { realName: '홍길동', phone: '01012345678', expectedAccountId: 'user-1' };
  const sent = { expiresInSeconds: 180, resendAfterSeconds: 60 };

  it('sends the account the screen shows and changes nothing in the cache', async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const posted: unknown[] = [];
    const me = meObserver(queryClient, () => Promise.resolve(unverified));
    try {
      await me.observer.refetch();
      const request = new MutationObserver(
        queryClient,
        requestCodeOptions(queryClient, session.onSessionChanged, (post) => {
          posted.push(post);
          return Promise.resolve(sent);
        }),
      );

      await expect(request.mutate(body)).resolves.toEqual(sent);

      expect(posted).toEqual([body]);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(unverified);
      expect(me.requests()).toBe(1);
      expect(session.count()).toBe(0);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('refetches the session on a refusal as another account', async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const request = new MutationObserver(
      queryClient,
      requestCodeOptions(queryClient, session.onSessionChanged, () =>
        Promise.reject(forAnotherAccount()),
      ),
    );

    await expect(request.mutate(body)).rejects.toBeInstanceOf(ApiError);

    expect(session.count()).toBe(1);
    queryClient.clear();
  });

  it("asks ['me'] again when the account verified already (another tab), before rejecting", async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const me = meObserver(queryClient, (request) =>
      Promise.resolve(request === 1 ? unverified : { ...unverified, verification: verified }),
    );
    try {
      await me.observer.refetch();
      const request = new MutationObserver(
        queryClient,
        requestCodeOptions(queryClient, session.onSessionChanged, () =>
          Promise.reject(alreadyVerified()),
        ),
      );

      await expect(request.mutate(body)).rejects.toBeInstanceOf(ApiError);

      // Already refreshed when the rejection reaches the form: the page moves on with it.
      expect(me.requests()).toBe(2);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.verification).toEqual(verified);
      expect(session.count()).toBe(0);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it("does not ask for another account's ['me'] on that refusal", async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const me = meObserver(queryClient, () => Promise.resolve(otherMe));
    try {
      await me.observer.refetch();
      const request = new MutationObserver(
        queryClient,
        requestCodeOptions(queryClient, session.onSessionChanged, () =>
          Promise.reject(alreadyVerified()),
        ),
      );

      await expect(request.mutate(body)).rejects.toBeInstanceOf(ApiError);

      expect(me.requests()).toBe(1);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('leaves the session and the cache alone on any other refusal', async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const me = meObserver(queryClient, () => Promise.resolve(unverified));
    try {
      await me.observer.refetch();
      for (const error of [
        refused(429, 'PHONE_VERIFICATION_LIMITED', {
          reason: 'resend_interval',
          retryAfterSeconds: 30,
        }),
        refused(502, 'SMS_SEND_FAILED'),
        refused(502, 'SMS_SEND_UNCONFIRMED'),
        refused(403, 'FORBIDDEN'),
      ]) {
        const request = new MutationObserver(
          queryClient,
          requestCodeOptions(queryClient, session.onSessionChanged, () => Promise.reject(error)),
        );
        await expect(request.mutate(body)).rejects.toBe(error);
      }

      expect(session.count()).toBe(0);
      expect(me.requests()).toBe(1);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });
});

describe('POST /me/phone-verification/confirm (confirmVerificationOptions)', () => {
  const body = { code: '123456', expectedAccountId: 'user-1' };

  it("writes the record into that account's ['me'] before it settles", async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const me = meObserver(queryClient, () => Promise.resolve(unverified));
    try {
      await me.observer.refetch();
      const confirm = new MutationObserver(
        queryClient,
        confirmVerificationOptions(queryClient, session.onSessionChanged, () =>
          Promise.resolve(verified),
        ),
      );

      await expect(confirm.mutate(body)).resolves.toEqual(verified);

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.verification).toEqual(verified);
      expect(me.requests()).toBe(1);
      expect(session.count()).toBe(0);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it("does not patch another account's profile when the answer lands after a switch", async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const me = meObserver(queryClient, () => Promise.resolve(unverified));
    try {
      await me.observer.refetch();
      const confirm = new MutationObserver(
        queryClient,
        confirmVerificationOptions(queryClient, session.onSessionChanged, () => {
          queryClient.setQueryData<Me>(ME_QUERY_KEY, otherMe);
          return Promise.resolve(verified);
        }),
      );

      await expect(confirm.mutate(body)).resolves.toEqual(verified);

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(otherMe);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('refetches the session on a refusal as another account, and patches nothing', async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const me = meObserver(queryClient, () => Promise.resolve(unverified));
    try {
      await me.observer.refetch();
      const confirm = new MutationObserver(
        queryClient,
        confirmVerificationOptions(queryClient, session.onSessionChanged, () =>
          Promise.reject(forAnotherAccount()),
        ),
      );

      await expect(confirm.mutate(body)).rejects.toBeInstanceOf(ApiError);

      expect(session.count()).toBe(1);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(unverified);
      expect(me.requests()).toBe(1);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it("asks ['me'] again when another tab verified first, and nothing on a wrong code", async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const me = meObserver(queryClient, (request) =>
      Promise.resolve(request === 1 ? unverified : { ...unverified, verification: verified }),
    );
    try {
      await me.observer.refetch();
      const wrong = new MutationObserver(
        queryClient,
        confirmVerificationOptions(queryClient, session.onSessionChanged, () =>
          Promise.reject(
            refused(409, 'VERIFICATION_CODE_REJECTED', {
              reason: 'mismatch',
              remainingAttempts: 4,
            }),
          ),
        ),
      );
      await expect(wrong.mutate(body)).rejects.toBeInstanceOf(ApiError);
      expect(me.requests()).toBe(1);

      const already = new MutationObserver(
        queryClient,
        confirmVerificationOptions(queryClient, session.onSessionChanged, () =>
          Promise.reject(alreadyVerified()),
        ),
      );
      await expect(already.mutate(body)).rejects.toBeInstanceOf(ApiError);
      expect(me.requests()).toBe(2);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.verification).toEqual(verified);
      expect(session.count()).toBe(0);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });
});

describe('PUT /me/real-name (updateRealNameOptions)', () => {
  const held: Me = { ...unverified, verification: verified };
  const renamed: PhoneVerification = { ...verified, realName: '김철수' };
  const body = { realName: '김철수', expectedAccountId: 'user-1' };

  it("writes the renamed record into that account's ['me']", async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const me = meObserver(queryClient, () => Promise.resolve(held));
    try {
      await me.observer.refetch();
      const rename = new MutationObserver(
        queryClient,
        updateRealNameOptions(queryClient, session.onSessionChanged, () =>
          Promise.resolve(renamed),
        ),
      );

      await expect(rename.mutate(body)).resolves.toEqual(renamed);

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.verification).toEqual(renamed);
      expect(me.requests()).toBe(1);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it("asks ['me'] again when the server has no record any more, the session on another account", async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const me = meObserver(queryClient, (request) =>
      Promise.resolve(request === 1 ? held : unverified),
    );
    try {
      await me.observer.refetch();
      const gone = new MutationObserver(
        queryClient,
        updateRealNameOptions(queryClient, session.onSessionChanged, () =>
          Promise.reject(refused(409, 'VERIFICATION_REQUIRED')),
        ),
      );
      await expect(gone.mutate(body)).rejects.toBeInstanceOf(ApiError);
      expect(me.requests()).toBe(2);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.verification).toBeNull();

      const switched = new MutationObserver(
        queryClient,
        updateRealNameOptions(queryClient, session.onSessionChanged, () =>
          Promise.reject(forAnotherAccount()),
        ),
      );
      await expect(switched.mutate(body)).rejects.toBeInstanceOf(ApiError);
      expect(session.count()).toBe(1);
      expect(me.requests()).toBe(2);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });
});
