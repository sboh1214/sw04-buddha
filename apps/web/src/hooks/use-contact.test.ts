import { MutationObserver, QueryObserver, type QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ApiError, type Contact, type Me } from '@/lib/api';
import { getQueryClient } from '@/lib/query-client';
import {
  ContactStepError,
  setPasswordAndContactOptions,
  storeContact,
  type PasswordStepCalls,
} from './use-contact';
import { ME_QUERY_KEY } from './use-me';

/**
 * The contact's cache writes, driven through the REAL QueryClient (`getQueryClient()` answers a
 * fresh one per call under node). Nothing renders: apps/web runs vitest under
 * `environment: 'node'`, which is why `storeContact` and the /set-password step's mutation
 * options are exported apart from their hooks. The `['me']` observer stands in for the
 * onboarding gate, which observes that entry on every page.
 */

const saved: Contact = { realName: '홍길동', phone: '01012345678' };

/** The account as the gate first sees it: signed in, no contact yet. */
const noContact: Me = {
  id: 'user-1',
  email: 'a@example.com',
  emailVerified: true,
  profile: { nickname: '테스터', role: 'user', createdAt: '2026-08-01T00:00:00.000Z' },
  balance: { availableP: '0', lockedP: '0' },
  linkedAccounts: [],
  contact: null,
};

/** What `GET /me` answers once the password is saved: the account has a credential row now. */
const withPassword: Me = {
  ...noContact,
  linkedAccounts: [
    {
      id: 'account-1',
      accountId: 'user-1',
      providerId: 'credential',
      createdAt: '2026-09-28T00:00:00.000Z',
    },
  ],
};

const refused = (status: number, code: string) =>
  new ApiError(status, { code, message: 'x' } as never);

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

describe('storeContact', () => {
  it('patches the contact into the profile already held, without a request', async () => {
    const queryClient = getQueryClient();
    const me = meObserver(queryClient, () => Promise.resolve(noContact));
    try {
      await me.observer.refetch();

      await storeContact(queryClient, saved);

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual({ ...noContact, contact: saved });
      expect(me.observer.getCurrentResult().data?.contact).toEqual(saved);
      expect(me.requests()).toBe(1);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('cancels a GET /me that left before the PUT, so its contact: null cannot land on top', async () => {
    // THE HAZARD: a window-focus refetch (or a realtime resnapshot) is in flight when the PUT
    // commits. It answers after the patch with the profile it read BEFORE the contact existed,
    // and the gate on `next` then sends the member straight back to an empty /onboarding.
    const queryClient = getQueryClient();
    const stale = deferred<Me>();
    const me = meObserver(queryClient, (request) =>
      request === 1 ? Promise.resolve(noContact) : stale.promise,
    );
    try {
      await me.observer.refetch();
      const inflight = me.observer.refetch();
      expect(queryClient.getQueryState(ME_QUERY_KEY)?.fetchStatus).toBe('fetching');

      await storeContact(queryClient, saved);
      stale.resolve(noContact);
      await inflight;
      await settle();

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.contact).toEqual(saved);
      expect(me.observer.getCurrentResult().data?.contact).toEqual(saved);
      expect(queryClient.getQueryState(ME_QUERY_KEY)?.fetchStatus).toBe('idle');
      expect(me.requests()).toBe(2);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('re-asks when the cancel leaves nothing to patch (the first GET /me was in flight)', async () => {
    // Cancelling a FIRST fetch reverts the entry to pending with no data and nothing fetching:
    // writing nothing there would leave the gate undecided until the next focus. The new
    // request leaves after the PUT committed, so its answer carries the contact.
    const queryClient = getQueryClient();
    const first = deferred<Me>();
    const me = meObserver(queryClient, (request) =>
      request === 1 ? first.promise : Promise.resolve({ ...withPassword, contact: saved }),
    );
    try {
      expect(me.requests()).toBe(1);
      expect(queryClient.getQueryData(ME_QUERY_KEY)).toBeUndefined();

      await storeContact(queryClient, saved);

      expect(me.requests()).toBe(2);
      expect(me.observer.getCurrentResult().isPending).toBe(false);
      expect(me.observer.getCurrentResult().data?.contact).toEqual(saved);

      // …and the first request, landing late with what it read before the PUT, is dropped.
      first.resolve(noContact);
      await settle();
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.contact).toEqual(saved);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('builds no profile out of a contact when nothing has asked for one', async () => {
    const queryClient = getQueryClient();

    await storeContact(queryClient, saved);

    expect(queryClient.getQueryState(ME_QUERY_KEY)).toBeUndefined();
    queryClient.clear();
  });
});

describe('the /set-password step (setPasswordAndContactOptions)', () => {
  /**
   * The step's two requests as a log, sharing it with the `['me']` observer's refetches, so a
   * test reads the whole order off one array. `refuse` makes that request fail.
   */
  function stepCalls(log: string[], refuse?: 'password' | 'contact'): PasswordStepCalls {
    return {
      setPassword: (newPassword) => {
        log.push(`POST /me/password ${newPassword}`);
        return refuse === 'password'
          ? Promise.reject(refused(400, 'VALIDATION_ERROR'))
          : Promise.resolve({ ok: true });
      },
      putContact: (body) => {
        log.push(`PUT /me/contact ${body.realName}`);
        return refuse === 'contact'
          ? Promise.reject(refused(503, 'INTERNAL'))
          : Promise.resolve(body);
      },
    };
  }

  /** The gate's `['me']`, held with no contact; later requests answer `after` and are logged. */
  async function heldMe(queryClient: QueryClient, log: string[], after: Me) {
    let heldAtRefresh: Contact | null | undefined;
    const me = meObserver(queryClient, (request) => {
      if (request === 1) return Promise.resolve(noContact);
      log.push('GET /me');
      heldAtRefresh = queryClient.getQueryData<Me>(ME_QUERY_KEY)?.contact;
      return Promise.resolve(after);
    });
    await me.observer.refetch();
    return { ...me, heldAtRefresh: () => heldAtRefresh };
  }

  it('saves the password, then the contact, then refreshes ["me"] once', async () => {
    const queryClient = getQueryClient();
    const log: string[] = [];
    const me = await heldMe(queryClient, log, { ...withPassword, contact: saved });
    const step = new MutationObserver(
      queryClient,
      setPasswordAndContactOptions(queryClient, stepCalls(log)),
    );
    try {
      await expect(step.mutate({ newPassword: 'pw-123456', contact: saved })).resolves.toEqual(
        saved,
      );

      expect(log).toEqual(['POST /me/password pw-123456', 'PUT /me/contact 홍길동', 'GET /me']);
      // The contact was already in `['me']` when the refresh left, so the gate on the next page
      // never reads `null` in between.
      expect(me.heldAtRefresh()).toEqual(saved);
      expect(me.observer.getCurrentResult().data).toEqual({ ...withPassword, contact: saved });
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('asks for the password alone when the account already has a contact', async () => {
    const queryClient = getQueryClient();
    const log: string[] = [];
    const me = await heldMe(queryClient, log, withPassword);
    const step = new MutationObserver(
      queryClient,
      setPasswordAndContactOptions(queryClient, stepCalls(log)),
    );
    try {
      await expect(step.mutate({ newPassword: 'pw-123456', contact: null })).resolves.toBeNull();

      expect(log).toEqual(['POST /me/password pw-123456', 'GET /me']);
      expect(me.observer.getCurrentResult().data).toEqual(withPassword);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('stops at a refused password: no contact request, no refresh, no ContactStepError', async () => {
    // Nothing changed on the server, so the form stays as it is and offers the same button.
    const queryClient = getQueryClient();
    const log: string[] = [];
    const me = await heldMe(queryClient, log, withPassword);
    const step = new MutationObserver(
      queryClient,
      setPasswordAndContactOptions(queryClient, stepCalls(log, 'password')),
    );
    try {
      const error: unknown = await step
        .mutate({ newPassword: 'pw-123456', contact: saved })
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ApiError);
      expect(error).not.toBeInstanceOf(ContactStepError);
      expect(log).toEqual(['POST /me/password pw-123456']);
      expect(me.observer.getCurrentResult().data).toEqual(noContact);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('reports a contact refused AFTER the password saved as ContactStepError, and refreshes', async () => {
    // The password is set, so /set-password now shows "already set" and cannot retry the step:
    // the form sends the member to /onboarding on this error, and `['me']` must already say the
    // account has a password (and still no contact) when it does.
    const queryClient = getQueryClient();
    const log: string[] = [];
    const me = await heldMe(queryClient, log, withPassword);
    const step = new MutationObserver(
      queryClient,
      setPasswordAndContactOptions(queryClient, stepCalls(log, 'contact')),
    );
    try {
      const error: unknown = await step
        .mutate({ newPassword: 'pw-123456', contact: saved })
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ContactStepError);
      expect((error as ContactStepError).cause).toBeInstanceOf(ApiError);
      expect(log).toEqual(['POST /me/password pw-123456', 'PUT /me/contact 홍길동', 'GET /me']);
      expect(me.observer.getCurrentResult().data).toEqual(withPassword);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });
});
