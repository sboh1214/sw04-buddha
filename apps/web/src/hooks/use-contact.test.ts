import { MutationObserver, QueryObserver, type QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ApiError, type Contact, type Me } from '@/lib/api';
import { getQueryClient } from '@/lib/query-client';
import {
  ContactStepError,
  passwordStepFailure,
  setPasswordAndContactOptions,
  storeContact,
  updateContactOptions,
  type PasswordStepCalls,
} from './use-contact';
import { ME_QUERY_KEY } from './use-me';

/**
 * The contact's cache writes, driven through the REAL QueryClient (`getQueryClient()` answers a
 * fresh one per call under node). Nothing renders: apps/web runs vitest under
 * `environment: 'node'`, which is why `storeContact` and the /set-password step's mutation
 * options are exported apart from their hooks. The `['me']` observer stands in for the
 * onboarding gate, which observes that entry on every page.
 *
 * Every write names the account the screen shows (`expectedAccountId`, A-PG-24). The server
 * compares it with the cookie; what these tests pin is the client half — which id each request
 * carries, what a refusal as another account does, and that an answer landing after the tab
 * switched accounts writes nothing into the other account's `['me']`.
 */

const saved: Contact = { realName: '홍길동', phone: '01012345678' };

/** The account as the gate first sees it: signed in, no contact yet. */
const noContact: Me = {
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

/** The account the tab switched to while a request ran (SessionCacheGuard reset, then B's GET). */
const otherMe: Me = { ...noContact, id: 'user-2', email: 'b@example.com', contact: saved };

const refused = (status: number, code: string) =>
  new ApiError(status, { code, message: 'x' } as never);

/** The 403 `assertExpectedAccount` answers when the cookie is not the account the body names. */
const forAnotherAccount = () =>
  new ApiError(403, {
    code: 'FORBIDDEN',
    message: 'x',
    details: [{ path: ['expectedAccountId'], message: 'session belongs to another account' }],
  });

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

describe('storeContact', () => {
  it('patches the contact into the profile already held, without a request', async () => {
    const queryClient = getQueryClient();
    const me = meObserver(queryClient, () => Promise.resolve(noContact));
    try {
      await me.observer.refetch();

      await storeContact(queryClient, saved, 'user-1');

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

      await storeContact(queryClient, saved, 'user-1');
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

      await storeContact(queryClient, saved, 'user-1');

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

    await storeContact(queryClient, saved, 'user-1');

    expect(queryClient.getQueryState(ME_QUERY_KEY)).toBeUndefined();
    queryClient.clear();
  });

  it('checks the owner again after the awaited cancel: a switch during it is not patched', async () => {
    // The first check passed (['me'] held user-1), but by the time the awaited cancel settled
    // the entry held B's profile — here the in-flight GET /me writes it as it is aborted,
    // standing in for the guard's reset and B's GET /me landing in that gap. A manual write, so
    // the cancel keeps it rather than reverting. Patching now would put A's real name and
    // number into B's profile.
    const queryClient = getQueryClient();
    const switched: Me = { ...otherMe, contact: null };
    queryClient.setQueryData<Me>(ME_QUERY_KEY, noContact);
    const inflight = queryClient.fetchQuery<Me>({
      queryKey: ME_QUERY_KEY,
      staleTime: 0,
      queryFn: ({ signal }) =>
        new Promise<Me>((_, reject) => {
          signal.addEventListener('abort', () => {
            queryClient.setQueryData<Me>(ME_QUERY_KEY, switched);
            reject(new Error('aborted'));
          });
        }),
    });
    expect(queryClient.getQueryState(ME_QUERY_KEY)?.fetchStatus).toBe('fetching');

    await storeContact(queryClient, saved, 'user-1');

    expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(switched);
    await expect(inflight).resolves.toEqual(switched);
    queryClient.clear();
  });

  it("leaves another account's profile alone, its refresh in flight included", async () => {
    // THE HAZARD: A's PUT answers after the tab switched to B (SessionCacheGuard reset and B's
    // GET /me landed). Patching would show A's real name and number on B's screen and hand
    // them to B's gate; cancelling would drop B's own refresh.
    const queryClient = getQueryClient();
    const refresh = deferred<Me>();
    const me = meObserver(queryClient, (request) =>
      request === 1 ? Promise.resolve({ ...otherMe, contact: null }) : refresh.promise,
    );
    try {
      await me.observer.refetch();
      const inflight = me.observer.refetch();

      await storeContact(queryClient, saved, 'user-1');

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual({ ...otherMe, contact: null });
      expect(queryClient.getQueryState(ME_QUERY_KEY)?.fetchStatus).toBe('fetching');
      refresh.resolve(otherMe);
      await inflight;
      expect(me.observer.getCurrentResult().data).toEqual(otherMe);
      expect(me.requests()).toBe(2);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });
});

describe('the /set-password step (setPasswordAndContactOptions)', () => {
  /**
   * The step's two requests as a log, sharing it with the `['me']` observer's refetches, so a
   * test reads the whole order off one array — each request with the account it named. `refuse`
   * makes that request fail: plainly, or as the server's refusal of another account's cookie.
   */
  type Refusal = 'password' | 'contact' | 'password-account' | 'contact-account';
  function stepCalls(log: string[], refuse?: Refusal): PasswordStepCalls {
    return {
      setPassword: ({ newPassword, expectedAccountId }) => {
        log.push(`POST /me/password ${newPassword} as ${expectedAccountId}`);
        if (refuse === 'password') return Promise.reject(refused(400, 'VALIDATION_ERROR'));
        if (refuse === 'password-account') return Promise.reject(forAnotherAccount());
        return Promise.resolve({ ok: true });
      },
      putContact: ({ realName, phone, expectedAccountId }) => {
        log.push(`PUT /me/contact ${realName} as ${expectedAccountId}`);
        if (refuse === 'contact') return Promise.reject(refused(503, 'INTERNAL'));
        if (refuse === 'contact-account') return Promise.reject(forAnotherAccount());
        return Promise.resolve({ realName, phone });
      },
    };
  }

  /** The form's submission for the account the gate's `['me']` holds (`noContact`). */
  const submit = (contact: Contact | null) => ({
    newPassword: 'pw-123456',
    contact,
    accountId: 'user-1',
  });

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
    const session = sessionRefetches();
    const log: string[] = [];
    const me = await heldMe(queryClient, log, { ...withPassword, contact: saved });
    const step = new MutationObserver(
      queryClient,
      setPasswordAndContactOptions(queryClient, session.onSessionChanged, stepCalls(log)),
    );
    try {
      await expect(step.mutate(submit(saved))).resolves.toEqual(saved);

      // Both requests name the account the step started for, captured once at submit.
      expect(log).toEqual([
        'POST /me/password pw-123456 as user-1',
        'PUT /me/contact 홍길동 as user-1',
        'GET /me',
      ]);
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
    const session = sessionRefetches();
    const log: string[] = [];
    const me = await heldMe(queryClient, log, withPassword);
    const step = new MutationObserver(
      queryClient,
      setPasswordAndContactOptions(queryClient, session.onSessionChanged, stepCalls(log)),
    );
    try {
      await expect(step.mutate(submit(null))).resolves.toBeNull();

      expect(log).toEqual(['POST /me/password pw-123456 as user-1', 'GET /me']);
      expect(me.observer.getCurrentResult().data).toEqual(withPassword);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('stops at a refused password: no contact request, no refresh, no ContactStepError', async () => {
    // Nothing changed on the server, so the form stays as it is and offers the same button.
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const log: string[] = [];
    const me = await heldMe(queryClient, log, withPassword);
    const step = new MutationObserver(
      queryClient,
      setPasswordAndContactOptions(
        queryClient,
        session.onSessionChanged,
        stepCalls(log, 'password'),
      ),
    );
    try {
      const error: unknown = await step.mutate(submit(saved)).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ApiError);
      expect(error).not.toBeInstanceOf(ContactStepError);
      expect(passwordStepFailure(error)).toBe('failed');
      expect(log).toEqual(['POST /me/password pw-123456 as user-1']);
      expect(me.observer.getCurrentResult().data).toEqual(noContact);
      expect(session.count()).toBe(0);
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
    const session = sessionRefetches();
    const log: string[] = [];
    const me = await heldMe(queryClient, log, withPassword);
    const step = new MutationObserver(
      queryClient,
      setPasswordAndContactOptions(
        queryClient,
        session.onSessionChanged,
        stepCalls(log, 'contact'),
      ),
    );
    try {
      const error: unknown = await step.mutate(submit(saved)).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ContactStepError);
      expect((error as ContactStepError).cause).toBeInstanceOf(ApiError);
      expect(passwordStepFailure(error)).toBe('contact-failed');
      expect(log).toEqual([
        'POST /me/password pw-123456 as user-1',
        'PUT /me/contact 홍길동 as user-1',
        'GET /me',
      ]);
      expect(me.observer.getCurrentResult().data).toEqual(withPassword);
      expect(session.count()).toBe(0);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });
  it('stops at a password refused as another account: nothing written, the session refetched', async () => {
    // A stale screen (another tab signed in as B; side-by-side windows never refetch): the
    // server refuses the FIRST request, so B gets neither A's password nor A's contact.
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const log: string[] = [];
    const me = await heldMe(queryClient, log, withPassword);
    const step = new MutationObserver(
      queryClient,
      setPasswordAndContactOptions(
        queryClient,
        session.onSessionChanged,
        stepCalls(log, 'password-account'),
      ),
    );
    try {
      const error: unknown = await step.mutate(submit(saved)).catch((thrown: unknown) => thrown);

      expect(error).not.toBeInstanceOf(ContactStepError);
      expect(passwordStepFailure(error)).toBe('session-changed');
      expect(log).toEqual(['POST /me/password pw-123456 as user-1']);
      expect(session.count()).toBe(1);
      // The guard's reset refetches `['me']` for the real account; the step asks for nothing.
      expect(me.observer.getCurrentResult().data).toEqual(noContact);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('reports a contact refused as another account apart from the plain half-done case', async () => {
    // THE REVIEWED RACE: B signed in elsewhere while A's password request ran. The password is
    // A's (the server compared it), the contact left with B's cookie and was refused. The form
    // must not send B to /onboarding under "your contact failed", and `['me']` is left to the
    // guard's reset rather than refreshed with B's cookie here.
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const log: string[] = [];
    const me = await heldMe(queryClient, log, withPassword);
    const step = new MutationObserver(
      queryClient,
      setPasswordAndContactOptions(
        queryClient,
        session.onSessionChanged,
        stepCalls(log, 'contact-account'),
      ),
    );
    try {
      const error: unknown = await step.mutate(submit(saved)).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ContactStepError);
      expect(passwordStepFailure(error)).toBe('contact-session-changed');
      expect(log).toEqual([
        'POST /me/password pw-123456 as user-1',
        'PUT /me/contact 홍길동 as user-1',
      ]);
      expect(session.count()).toBe(1);
      expect(me.observer.getCurrentResult().data).toEqual(noContact);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it("writes nothing into ['me'] once it holds another account's profile", async () => {
    // Both requests were A's (the server compared them), but by the time the contact answered
    // the tab had switched: SessionCacheGuard reset the caches and B's GET /me landed.
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const log: string[] = [];
    const me = await heldMe(queryClient, log, withPassword);
    const calls = stepCalls(log);
    const step = new MutationObserver(
      queryClient,
      setPasswordAndContactOptions(queryClient, session.onSessionChanged, {
        ...calls,
        putContact: async (body) => {
          const answer = await calls.putContact(body);
          queryClient.setQueryData<Me>(ME_QUERY_KEY, otherMe);
          return answer;
        },
      }),
    );
    try {
      await expect(step.mutate(submit(saved))).resolves.toEqual(saved);

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(otherMe);
      // Not even a refresh: that entry is the guard's now.
      expect(log).toEqual([
        'POST /me/password pw-123456 as user-1',
        'PUT /me/contact 홍길동 as user-1',
      ]);
      expect(session.count()).toBe(0);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it("refreshes nothing after a half-done step once ['me'] holds another account's profile", async () => {
    // The password was saved for user-1 and the contact then failed for an ordinary reason, but
    // the tab had switched in between (SessionCacheGuard reset, B's GET /me landed). The
    // half-done refresh is user-1's to ask for: sent now, it would go with B's cookie into the
    // entry the guard owns.
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const log: string[] = [];
    const me = await heldMe(queryClient, log, otherMe);
    const calls = stepCalls(log, 'contact');
    const step = new MutationObserver(
      queryClient,
      setPasswordAndContactOptions(queryClient, session.onSessionChanged, {
        ...calls,
        putContact: async (body) => {
          queryClient.setQueryData<Me>(ME_QUERY_KEY, otherMe);
          return calls.putContact(body);
        },
      }),
    );
    try {
      const error: unknown = await step.mutate(submit(saved)).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ContactStepError);
      expect(passwordStepFailure(error)).toBe('contact-failed');
      expect(log).toEqual([
        'POST /me/password pw-123456 as user-1',
        'PUT /me/contact 홍길동 as user-1',
      ]);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(otherMe);
      expect(session.count()).toBe(0);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });
});

describe('passwordStepFailure', () => {
  it('reads a failed /set-password step for its form', () => {
    expect(passwordStepFailure(forAnotherAccount())).toBe('session-changed');
    expect(passwordStepFailure(new ContactStepError(forAnotherAccount()))).toBe(
      'contact-session-changed',
    );
    expect(passwordStepFailure(new ContactStepError(refused(503, 'INTERNAL')))).toBe(
      'contact-failed',
    );
    expect(passwordStepFailure(new ContactStepError(new TypeError('Failed to fetch')))).toBe(
      'contact-failed',
    );
    // The CSRF 403 names no field: not an account switch.
    expect(passwordStepFailure(refused(403, 'FORBIDDEN'))).toBe('failed');
    expect(passwordStepFailure(new ContactStepError(refused(403, 'FORBIDDEN')))).toBe(
      'contact-failed',
    );
    expect(passwordStepFailure(new TypeError('Failed to fetch'))).toBe('failed');
  });
});

describe('PUT /me/contact from /onboarding and the settings card (updateContactOptions)', () => {
  const body = { ...saved, expectedAccountId: 'user-1' };

  it("sends the account the screen shows and patches that account's ['me']", async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const sent: unknown[] = [];
    const me = meObserver(queryClient, () => Promise.resolve(noContact));
    try {
      await me.observer.refetch();
      const update = new MutationObserver(
        queryClient,
        updateContactOptions(queryClient, session.onSessionChanged, (put) => {
          sent.push(put);
          return Promise.resolve({ realName: put.realName, phone: put.phone });
        }),
      );

      await expect(update.mutate(body)).resolves.toEqual(saved);

      expect(sent).toEqual([body]);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual({ ...noContact, contact: saved });
      expect(session.count()).toBe(0);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('refetches the session on a refusal as another account, and patches nothing', async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const me = meObserver(queryClient, () => Promise.resolve(noContact));
    try {
      await me.observer.refetch();
      const update = new MutationObserver(
        queryClient,
        updateContactOptions(queryClient, session.onSessionChanged, () =>
          Promise.reject(forAnotherAccount()),
        ),
      );

      await expect(update.mutate(body)).rejects.toBeInstanceOf(ApiError);

      expect(session.count()).toBe(1);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual(noContact);
      expect(me.requests()).toBe(1);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('leaves the session alone on any other failure', async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const update = new MutationObserver(
      queryClient,
      updateContactOptions(queryClient, session.onSessionChanged, () =>
        Promise.reject(refused(403, 'FORBIDDEN')),
      ),
    );

    await expect(update.mutate(body)).rejects.toBeInstanceOf(ApiError);

    expect(session.count()).toBe(0);
    queryClient.clear();
  });

  it('scopes the patch to the account the body named, not to any account of its own', async () => {
    // The owner the cache write checks is the body's `expectedAccountId` — the string the server
    // compared — so the same success patches user-2's profile for a body naming user-2, and
    // leaves user-1's alone.
    const bodyFor2 = { ...saved, expectedAccountId: 'user-2' };
    const answered = (put: typeof bodyFor2) =>
      Promise.resolve({ realName: put.realName, phone: put.phone });
    for (const [held, patched] of [
      [{ ...otherMe, contact: null }, true],
      [noContact, false],
    ] as const) {
      const queryClient = getQueryClient();
      const session = sessionRefetches();
      queryClient.setQueryData<Me>(ME_QUERY_KEY, held);
      const update = new MutationObserver(
        queryClient,
        updateContactOptions(queryClient, session.onSessionChanged, answered),
      );

      await expect(update.mutate(bodyFor2)).resolves.toEqual(saved);

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY), held.id).toEqual(
        patched ? { ...held, contact: saved } : held,
      );
      queryClient.clear();
    }
  });

  it("does not patch another account's profile when the answer lands after a switch", async () => {
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const me = meObserver(queryClient, () => Promise.resolve(noContact));
    try {
      await me.observer.refetch();
      const update = new MutationObserver(
        queryClient,
        updateContactOptions(queryClient, session.onSessionChanged, (put) => {
          queryClient.setQueryData<Me>(ME_QUERY_KEY, { ...otherMe, contact: null });
          return Promise.resolve({ realName: put.realName, phone: put.phone });
        }),
      );

      await expect(update.mutate(body)).resolves.toEqual(saved);

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)).toEqual({ ...otherMe, contact: null });
      expect(me.requests()).toBe(1);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });
});
