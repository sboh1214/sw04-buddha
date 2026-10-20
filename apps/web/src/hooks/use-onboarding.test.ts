import { MutationObserver, QueryObserver, type QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  api,
  type AnswerInterestsStepBody,
  type Me,
  type SetInterestCategoriesBody,
} from '@/lib/api';
import { getQueryClient } from '@/lib/query-client';
import { ME_QUERY_KEY } from './use-me';
import {
  INTERESTS_STEP_MUTATION_KEY,
  SIGN_OUT_LEAVE_REPORT_WAIT_MS,
  answerInterestsStepOptions,
  createInterestsLeaveReport,
  recordConsentsOptions,
  reportInterestsLeft,
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
    publicId: 'k7m2p9qx4z',
    nickname: 'user_ab12',
    role: 'user',
    createdAt: '2026-10-18T00:00:00.000Z',
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
      answerInterestsStepOptions(queryClient, session.onSessionChanged, rejectAsOther),
    );
    const settings = new MutationObserver(
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
    await expect(
      settings.mutate({ categoryIds: [], expectedAccountId: 'user-1' }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(session.count()).toBe(4);
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
        answerInterestsStepOptions(
          queryClient,
          () => undefined,
          () => Promise.resolve(done),
        ),
      );

      await interests.mutate({ categoryIds: [], expectedAccountId: 'user-1' });

      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.onboarding).toMatchObject({
        interests: true,
        nextStep: null,
      });
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });

  it('keys the step’s answer, which the stepper’s leave report waits on, and not MY 설정’s write', async () => {
    const queryClient = getQueryClient();
    let settle: (me: Me) => void = () => undefined;
    const pending = new Promise<Me>((resolve) => {
      settle = resolve;
    });
    const step = new MutationObserver(
      queryClient,
      answerInterestsStepOptions(
        queryClient,
        () => undefined,
        () => pending,
      ),
    );
    const settings = new MutationObserver(
      queryClient,
      setInterestCategoriesOptions(
        queryClient,
        () => undefined,
        () => pending,
      ),
    );
    const answering = () => queryClient.isMutating({ mutationKey: INTERESTS_STEP_MUTATION_KEY });
    try {
      const saved = settings.mutate({ categoryIds: [1], expectedAccountId: 'user-1' });
      expect(answering()).toBe(0);
      const answered = step.mutate({ categoryIds: [1], expectedAccountId: 'user-1' });
      expect(answering()).toBe(1);
      settle(named);
      await Promise.all([saved, answered]);
      expect(answering()).toBe(0);
    } finally {
      queryClient.clear();
    }
  });
});

describe('MY 설정’s interest categories write with another account’s cookie (PR #224 Codex review, ADR-0078 7-29)', () => {
  it('a body naming the account shown is refused and leaves the session to be read again; one naming the cookie’s account would be taken', async () => {
    // The render between the session naming B and SessionCacheGuard's reset (an effect): ['me']
    // still holds A's picks while the cookie is already B's. What this documents is the server's
    // rule (A-PG-24, mimicked by `put`) and the write's options (`setInterestCategoriesOptions`):
    // a body naming A is refused, nothing is written, the session is asked again and ['me'] keeps
    // A's entry; a body naming B is taken with B's cookie. Both bodies are built here — which
    // account the card itself names (its `Me`'s, not the session's) is guarded by profile.spec.ts
    // ('탭의 계정이 다른 회원으로 바뀐 뒤 …'), which drives the card in a browser.
    const queryClient = getQueryClient();
    const session = sessionRefetches();
    const a: Me = { ...named, profile: { ...named.profile, interestCategoryIds: [1] } };
    const b: Me = {
      ...named,
      id: 'user-2',
      email: 'b@example.com',
      profile: { ...named.profile, publicId: 'b7m2p9qx4z', interestCategoryIds: [7] },
    };
    /** Each account's interest categories on the server, and the account its cookie names. */
    const server = new Map<string, readonly number[]>([
      [a.id, [1]],
      [b.id, [7]],
    ]);
    const signedIn = b.id;
    const put = (body: SetInterestCategoriesBody): Promise<Me> => {
      if (body.expectedAccountId !== signedIn) return Promise.reject(forAnotherAccount());
      server.set(signedIn, body.categoryIds);
      return Promise.resolve({
        ...b,
        profile: { ...b.profile, interestCategoryIds: body.categoryIds },
      });
    };
    const me = meObserver(queryClient, () => Promise.resolve(a));
    const save = new MutationObserver(
      queryClient,
      setInterestCategoriesOptions(queryClient, session.onSessionChanged, put),
    );
    try {
      await me.observer.refetch();
      const shown = queryClient.getQueryData<Me>(ME_QUERY_KEY);
      expect(shown?.id).toBe(a.id);

      await expect(
        save.mutate({ categoryIds: [1, 3], expectedAccountId: a.id }),
      ).rejects.toBeInstanceOf(ApiError);
      // Nothing written to either account; the session is asked again, so SessionCacheGuard puts B
      // on screen; the card's entry keeps A's picks until that reset.
      expect(server.get(b.id)).toEqual([7]);
      expect(server.get(a.id)).toEqual([1]);
      expect(session.count()).toBe(1);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.profile.interestCategoryIds).toEqual([1]);

      // THE HAZARD the card no longer has: it named the session's account, B, and the server took
      // the picks A's card showed as B's — only the answer, another account's, was kept out of
      // ['me'].
      await save.mutate({ categoryIds: [1, 3], expectedAccountId: b.id });
      expect(server.get(b.id)).toEqual([1, 3]);
      expect(queryClient.getQueryData<Me>(ME_QUERY_KEY)?.profile.interestCategoryIds).toEqual([1]);
    } finally {
      me.unsubscribe();
      queryClient.clear();
    }
  });
});

describe('the interests step’s two requests (PR #224 Codex review, ADR-0078 7-28)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the step’s answer with keepalive, as the skip: the page going does not cancel either', async () => {
    const queryClient = getQueryClient();
    const answered: Me = {
      ...named,
      profile: { ...named.profile, interestCategoryIds: [3] },
      onboarding: { ...named.onboarding, interests: true },
    };
    const sent = vi.spyOn(api, 'POST').mockResolvedValue({
      data: { data: answered },
      response: new Response(null, { status: 200 }),
    });
    try {
      // The screen's 저장 (or 건너뛰기), and the skip the stepper sends as the account leaves: the
      // answer on its way holds the skip back, so the answer itself must outlive the page.
      const options = answerInterestsStepOptions(queryClient, () => undefined);
      await expect(
        options.mutationFn({ categoryIds: [3], expectedAccountId: 'user-1' }),
      ).resolves.toEqual(answered);
      await reportInterestsLeft('user-1');
      expect(sent.mock.calls).toEqual([
        [
          '/api/v1/me/onboarding/interests',
          { body: { categoryIds: [3], expectedAccountId: 'user-1' }, keepalive: true },
        ],
        [
          '/api/v1/me/onboarding/interests',
          { body: { categoryIds: [], expectedAccountId: 'user-1' }, keepalive: true },
        ],
      ]);
    } finally {
      queryClient.clear();
    }
  });
});

describe('reportInterestsLeft (owner decision 2026-10-21 (2nd) answer 2)', () => {
  it('sends the step’s skip for the account on screen, and swallows a failure', async () => {
    const sent: unknown[] = [];
    const answered = reportInterestsLeft('user-1', (body) => {
      sent.push(body);
      return Promise.resolve();
    });
    // Sent before the call returns: the page may be going (`pagehide`).
    expect(sent).toEqual([{ categoryIds: [], expectedAccountId: 'user-1' }]);
    await expect(answered).resolves.toBeUndefined();
    // A refusal or a lost request is nobody's to hear: it settles, it does not reject.
    let rejected = false;
    const lost = reportInterestsLeft('user-1', () => {
      rejected = true;
      return Promise.reject(new Error('offline'));
    });
    expect(rejected).toBe(true);
    await expect(lost).resolves.toBeUndefined();
  });
});

/**
 * The stepper's leave report (ADR-0078 decision 6, 7-23): what `useInterestsLeaveReport` runs as
 * the stepper renders (`show`), goes or the page goes (`leave`), and as 로그아웃 is about to end the
 * session (`beforeSignOut`) — driven here with the REAL QueryClient and the step's own mutation
 * options, so the hold-back while the step's answer is on its way is the one the stepper has.
 */
describe('createInterestsLeaveReport (owner decision 2026-10-21 (2nd) answer 2)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A post that records what it was sent and settles when the test says. */
  function recordingPost() {
    const sent: AnswerInterestsStepBody[] = [];
    let settle: () => void = () => undefined;
    const post = (body: AnswerInterestsStepBody) => {
      sent.push(body);
      return new Promise<void>((resolve) => {
        settle = resolve;
      });
    };
    return { sent, post, settle: () => settle() };
  }

  it('sends the skip once when the account leaves the notice or the interests, and nothing elsewhere', () => {
    const queryClient = getQueryClient();
    const { sent, post, settle } = recordingPost();
    const report = createInterestsLeaveReport(queryClient, post);
    // Before the stepper has rendered, and on the three steps: nothing to skip yet.
    report.leave();
    for (const screen of ['consent', 'verification', 'nickname'] as const) {
      report.show(screen, 'user-1');
      report.leave();
    }
    expect(sent).toEqual([]);
    report.show('notice', 'user-1');
    report.leave();
    expect(sent).toEqual([{ categoryIds: [], expectedAccountId: 'user-1' }]);
    // Once: the stepper going after the page's `pagehide`, or after 로그아웃, sends no second one.
    report.show('interests', 'user-1');
    report.leave();
    void report.beforeSignOut();
    expect(sent).toHaveLength(1);
    settle();

    // The step answered: the stepper has nothing left to show, and leaving it is no skip.
    const done = createInterestsLeaveReport(queryClient, post);
    done.show('interests', 'user-1');
    done.show(null, 'user-1');
    done.leave();
    expect(sent).toHaveLength(1);
    queryClient.clear();
  });

  it('holds the skip back while the step’s own answer is on its way and once it came, but not for MY 설정’s write', async () => {
    const queryClient = getQueryClient();
    const { sent, post } = recordingPost();
    let answer: (me: Me) => void = () => undefined;
    const answering = new Promise<Me>((resolve) => {
      answer = resolve;
    });
    const step = new MutationObserver(
      queryClient,
      answerInterestsStepOptions(
        queryClient,
        () => undefined,
        () => answering,
      ),
    );
    // Another tab's cache: MY 설정's write there knows nothing of this one's step.
    const elsewhere = getQueryClient();
    const settings = new MutationObserver(
      elsewhere,
      setInterestCategoriesOptions(
        elsewhere,
        () => undefined,
        () => new Promise<Me>(() => undefined),
      ),
    );
    try {
      // The picks sent with 저장, then the account leaves — the page (`pagehide`), the stepper, or
      // 로그아웃: the answer answers the step, and a skip racing it could make the picks a change.
      const report = createInterestsLeaveReport(queryClient, post);
      report.show('interests', 'user-1');
      const picked = step.mutate({ categoryIds: [3], expectedAccountId: 'user-1' });
      report.leave();
      const signingOut = report.beforeSignOut();
      expect(sent).toEqual([]);
      answer(named);
      await picked;
      await signingOut;
      // Answered, before the stepper has moved on from the screen (it renders after): no skip —
      // nor once the sign-out has emptied the cache that remembers the answer, as it goes.
      report.leave();
      queryClient.clear();
      report.leave();
      expect(sent).toEqual([]);

      // A write of MY 설정 in flight is no answer of the step.
      const other = createInterestsLeaveReport(elsewhere, post);
      other.show('notice', 'user-1');
      void settings.mutate({ categoryIds: [3], expectedAccountId: 'user-1' });
      other.leave();
      expect(sent).toEqual([{ categoryIds: [], expectedAccountId: 'user-1' }]);
    } finally {
      queryClient.clear();
      elsewhere.clear();
    }
  });

  it('makes 로그아웃 wait for the step’s answer on its way, and send the skip only if it did not answer the step', async () => {
    // PR #224 Codex review (ADR-0078 7-28): 로그아웃 ends the session the answer on its way still
    // needs, so it waits for it — within the same wait as the skip — rather than racing it.
    vi.useFakeTimers();
    const queryClient = getQueryClient();
    /** The step's mutation as the screen holds it, whose answer the test settles. */
    function stepAnswer() {
      let settle: (outcome: Me | Error) => void = () => undefined;
      const observer = new MutationObserver(
        queryClient,
        answerInterestsStepOptions(
          queryClient,
          () => undefined,
          () =>
            new Promise<Me>((resolve, reject) => {
              settle = (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome));
            }),
        ),
      );
      return { observer, settle: (outcome: Me | Error) => settle(outcome) };
    }
    const picks: Me = {
      ...named,
      profile: { ...named.profile, interestCategoryIds: [3] },
      onboarding: { ...named.onboarding, interests: true },
    };
    try {
      // 저장, then 로그아웃 at once: it waits for the picks, which answer the step — no skip, and
      // the server ends with the picks.
      const first = recordingPost();
      const saved = stepAnswer();
      const report = createInterestsLeaveReport(queryClient, first.post);
      report.show('interests', 'user-1');
      const picked = saved.observer.mutate({ categoryIds: [3], expectedAccountId: 'user-1' });
      let signedOut = false;
      const before = report.beforeSignOut().then(() => {
        signedOut = true;
      });
      await vi.advanceTimersByTimeAsync(SIGN_OUT_LEAVE_REPORT_WAIT_MS - 1);
      expect(signedOut).toBe(false);
      saved.settle(picks);
      await picked;
      await before;
      expect(first.sent).toEqual([]);
      expect(queryClient.isMutating({ mutationKey: INTERESTS_STEP_MUTATION_KEY })).toBe(0);

      // The picks refused (a category closed meanwhile): the screen left unanswered, so the skip
      // goes after the refusal — never beside the picks — and the wait counts from 로그아웃.
      const second = recordingPost();
      const closed = stepAnswer();
      const refusedReport = createInterestsLeaveReport(queryClient, second.post);
      refusedReport.show('interests', 'user-2');
      const refusal = closed.observer
        .mutate({ categoryIds: [9], expectedAccountId: 'user-2' })
        .catch(() => undefined);
      let gaveUp = false;
      const late = refusedReport.beforeSignOut().then(() => {
        gaveUp = true;
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(second.sent).toEqual([]);
      closed.settle(refused(400, 'VALIDATION_ERROR', [{ path: ['categoryIds', 0], message: 'x' }]));
      await refusal;
      await vi.advanceTimersByTimeAsync(0);
      expect(second.sent).toEqual([{ categoryIds: [], expectedAccountId: 'user-2' }]);
      // Its answer does not come: 로그아웃 goes on once the one wait is over.
      await vi.advanceTimersByTimeAsync(SIGN_OUT_LEAVE_REPORT_WAIT_MS - 501);
      expect(gaveUp).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await late;
      expect(gaveUp).toBe(true);

      // The picks do not come within the wait: 로그아웃 goes on, and no skip races them.
      const third = recordingPost();
      const lost = stepAnswer();
      const stuck = createInterestsLeaveReport(queryClient, third.post);
      stuck.show('interests', 'user-3');
      void lost.observer
        .mutate({ categoryIds: [3], expectedAccountId: 'user-3' })
        .catch(() => undefined);
      let left = false;
      const going = stuck.beforeSignOut().then(() => {
        left = true;
      });
      await vi.advanceTimersByTimeAsync(SIGN_OUT_LEAVE_REPORT_WAIT_MS - 1);
      expect(left).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await going;
      expect(left).toBe(true);
      expect(third.sent).toEqual([]);
      // Nothing left listening to the cache once 로그아웃 went on.
      expect(queryClient.getMutationCache().hasListeners()).toBe(false);
    } finally {
      queryClient.clear();
    }
  });

  it('counts only the account’s own answers: another account’s on its way holds back no skip and keeps no 로그아웃 waiting', async () => {
    // PR #224 Codex review (ADR-0078 7-29): A saved its picks and the answer is slow; the tab then
    // switched to B, an onboarding account. SessionCacheGuard's `resetQueries` resets the queries,
    // not the mutations, so A's answer is still on its way in this tab's mutation cache — and it
    // answers A's step, not B's.
    vi.useFakeTimers();
    const queryClient = getQueryClient();
    /** The step's mutation as a screen holds it, whose answer the test settles. */
    function stepAnswer() {
      let settle: (me: Me) => void = () => undefined;
      const observer = new MutationObserver(
        queryClient,
        answerInterestsStepOptions(
          queryClient,
          () => undefined,
          () =>
            new Promise<Me>((resolve) => {
              settle = resolve;
            }),
        ),
      );
      return { observer, settle: (me: Me) => settle(me) };
    }
    const answering = () => queryClient.isMutating({ mutationKey: INTERESTS_STEP_MUTATION_KEY });
    try {
      const slow = stepAnswer();
      const picked = slow.observer.mutate({ categoryIds: [3], expectedAccountId: 'user-1' });
      await queryClient.resetQueries();
      expect(answering()).toBe(1);

      // B leaves the notice (a link, Back, the page going): not 'answering' — its skip goes.
      const left = recordingPost();
      const leaving = createInterestsLeaveReport(queryClient, left.post);
      leaving.show('notice', 'user-2');
      leaving.leave();
      expect(left.sent).toEqual([{ categoryIds: [], expectedAccountId: 'user-2' }]);

      // B signs out on the interests: the skip leaves at once — no wait on A's answer first — and
      // 로그아웃 goes on as soon as the skip's answer came, long before the two seconds.
      const out = recordingPost();
      const signingOut = createInterestsLeaveReport(queryClient, out.post);
      signingOut.show('interests', 'user-2');
      let signedOut = false;
      const before = signingOut.beforeSignOut().then(() => {
        signedOut = true;
      });
      expect(out.sent).toEqual([{ categoryIds: [], expectedAccountId: 'user-2' }]);
      out.settle();
      await vi.advanceTimersByTimeAsync(0);
      await before;
      expect(signedOut).toBe(true);
      expect(answering()).toBe(1);
      expect(queryClient.getMutationCache().hasListeners()).toBe(false);

      // The tab switched once more, to C, which saves its picks and signs out at once: 로그아웃
      // waits for C's answer, and goes on as soon as it came — A's still on its way — with no skip.
      const third = recordingPost();
      const saved = stepAnswer();
      const cScreen = createInterestsLeaveReport(queryClient, third.post);
      cScreen.show('interests', 'user-3');
      const picksC = saved.observer.mutate({ categoryIds: [5], expectedAccountId: 'user-3' });
      let cSignedOut = false;
      const cBefore = cScreen.beforeSignOut().then(() => {
        cSignedOut = true;
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(cSignedOut).toBe(false);
      saved.settle({ ...named, id: 'user-3' });
      await picksC;
      await vi.advanceTimersByTimeAsync(0);
      expect(cSignedOut).toBe(true);
      await cBefore;
      expect(third.sent).toEqual([]);
      expect(answering()).toBe(1);

      // A's own screen still sees its answer on its way: no skip races the picks.
      const own = recordingPost();
      const aScreen = createInterestsLeaveReport(queryClient, own.post);
      aScreen.show('interests', 'user-1');
      aScreen.leave();
      expect(own.sent).toEqual([]);
      slow.settle(named);
      await picked;
      expect(answering()).toBe(0);
    } finally {
      queryClient.clear();
    }
  });

  it('sends the skip before 로그아웃 ends the session and waits for its answer, at most a while', async () => {
    vi.useFakeTimers();
    const queryClient = getQueryClient();
    const first = recordingPost();
    const report = createInterestsLeaveReport(queryClient, first.post);
    report.show('notice', 'user-1');
    let waited = false;
    const before = report.beforeSignOut().then(() => {
      waited = true;
    });
    // Sent at once, and 로그아웃 waits for the answer.
    expect(first.sent).toEqual([{ categoryIds: [], expectedAccountId: 'user-1' }]);
    await vi.advanceTimersByTimeAsync(SIGN_OUT_LEAVE_REPORT_WAIT_MS - 1);
    expect(waited).toBe(false);
    first.settle();
    await before;
    expect(waited).toBe(true);
    // The stepper going after the sign-out sends nothing more.
    report.leave();
    expect(first.sent).toHaveLength(1);

    // An answer that does not come keeps nobody signed in: 로그아웃 goes on after the wait.
    const second = recordingPost();
    const slow = createInterestsLeaveReport(queryClient, second.post);
    slow.show('interests', 'user-2');
    let gaveUp = false;
    const late = slow.beforeSignOut().then(() => {
      gaveUp = true;
    });
    await vi.advanceTimersByTimeAsync(SIGN_OUT_LEAVE_REPORT_WAIT_MS - 1);
    expect(gaveUp).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await late;
    expect(gaveUp).toBe(true);
    expect(second.sent).toEqual([{ categoryIds: [], expectedAccountId: 'user-2' }]);

    // Nothing to skip: nothing sent, nothing waited for.
    const third = recordingPost();
    const elsewhere = createInterestsLeaveReport(queryClient, third.post);
    elsewhere.show('consent', 'user-3');
    await elsewhere.beforeSignOut();
    expect(third.sent).toEqual([]);
    queryClient.clear();
  });
});
