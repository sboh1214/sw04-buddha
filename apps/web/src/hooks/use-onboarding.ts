'use client';

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ME_QUERY_KEY, meBelongsTo, refreshOwnMe } from '@/hooks/use-me';
import {
  api,
  isApiError,
  isForAnotherAccount,
  unwrap,
  type AnswerInterestsStepBody,
  type Me,
  type RecordConsentsBody,
  type SetInterestCategoriesBody,
  type SetOnboardingNicknameBody,
} from '@/lib/api';
import { nicknameRefusalNeedsRefresh } from '@/lib/nickname';
import {
  leavingSkipsInterests,
  takeOnboardingAnswer,
  type OnboardingScreen,
  type OnboardingWrite,
} from '@/lib/onboarding';
import { useSession } from '@/lib/use-session';

/**
 * The onboarding's writes (#58, ADR-0072) apart from the 본인확인, which is #183's
 * (use-phone-verification.ts): the consent step, the nickname step — with which the server grants
 * the start Coin — the interests step and its skip when the account leaves it (ADR-0078), and MY
 * 설정's interest categories (#41), which share the step's `['me']` write. Each answers the whole
 * `Me`, and what the write
 * changed goes into `['me']` before the mutation settles (`storeOnboardingAnswer`), so the
 * stepper, which reads `onboarding.nextStep` there, moves on in the same render the answer lands —
 * and the gate on the page it then returns to already sees the onboarding done.
 *
 * Every write names the account the screen shows (`expectedAccountId`, A-PG-24): a window still
 * showing account A after another one signed in as B would otherwise record A's answers as B's
 * consent, or spend B's nickname step and start Coin. A refusal as another account asks for the
 * session again, so SessionCacheGuard puts the real account on screen, as every owner write does.
 *
 * The cache writer and the mutations' options are exported apart from their hooks: apps/web runs
 * vitest under `environment: 'node'` (use-onboarding.test.ts).
 */

async function postConsents(body: RecordConsentsBody): Promise<Me> {
  return unwrap(await api.POST('/api/v1/me/consents', { body })).data;
}

async function postNickname(body: SetOnboardingNicknameBody): Promise<Me> {
  return unwrap(await api.POST('/api/v1/me/onboarding/nickname', { body })).data;
}

async function postInterestsStep(body: AnswerInterestsStepBody): Promise<Me> {
  return unwrap(await api.POST('/api/v1/me/onboarding/interests', { body })).data;
}

async function putInterests(body: SetInterestCategoriesBody): Promise<Me> {
  return unwrap(await api.PUT('/api/v1/me/interest-categories', { body })).data;
}

/**
 * The skip sent as the account leaves: `keepalive`, so the browser still delivers it once the tab
 * is closed or another document is loading (`pagehide`). Called synchronously from the handler —
 * openapi-fetch starts the request before its first `await` — and nobody reads the answer; only
 * 로그아웃 waits for it to come (`InterestsLeaveReport.beforeSignOut`).
 */
async function postInterestsLeft(body: AnswerInterestsStepBody): Promise<void> {
  await api.POST('/api/v1/me/onboarding/interests', { body, keepalive: true });
}

/**
 * Writes what an onboarding write changed (`takeOnboardingAnswer`) from its answer into `['me']`,
 * as `storeMe` does for a profile write: a `GET /me` in flight is cancelled first, so an answer
 * that left before the write committed cannot put the step back; nothing is written over another
 * account's profile — the tab and the cookie disagree on who is signed in, so the session is asked
 * for again (`onSessionChanged`); and an empty entry is re-asked rather than built from the answer.
 *
 * After the nickname step `GET /me` is asked again as well, in the background: the start Coin it
 * may have paid moved the balance, which this write does not take from its answer (see
 * `takeOnboardingAnswer`) — the refetch answers it with whatever came after.
 */
export async function storeOnboardingAnswer(
  queryClient: QueryClient,
  me: Me,
  write: OnboardingWrite,
  onSessionChanged: () => void,
): Promise<void> {
  if (!meBelongsTo(queryClient, me.id)) {
    onSessionChanged();
    return;
  }
  await queryClient.cancelQueries({ queryKey: ME_QUERY_KEY, exact: true });
  const held = queryClient.getQueryData<Me>(ME_QUERY_KEY);
  if (!held) {
    await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY, exact: true });
    return;
  }
  if (held.id !== me.id) {
    onSessionChanged();
    return;
  }
  queryClient.setQueryData<Me>(ME_QUERY_KEY, takeOnboardingAnswer(held, me, write));
  if (write === 'nickname') {
    void queryClient.invalidateQueries({
      queryKey: ME_QUERY_KEY,
      exact: true,
      refetchType: 'active',
    });
  }
}

/**
 * `POST /me/consents` as mutation options: the consent step (#57-5) and MY 설정's marketing switch
 * (오너 결정 2026-10-19 (2차) 4), whose answer is the same `onboarding` with the marketing answer
 * changed.
 */
export function recordConsentsOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  post: (body: RecordConsentsBody) => Promise<Me> = postConsents,
) {
  return {
    mutationFn: post,
    // Returned, so `mutateAsync` settles only once `['me']` holds the answer.
    onSuccess: (me: Me) => storeOnboardingAnswer(queryClient, me, 'consent', onSessionChanged),
    onError: (error: Error) => {
      if (isForAnotherAccount(error)) onSessionChanged();
    },
  };
}

/**
 * `POST /me/onboarding/nickname` as mutation options: the nickname step (#57-6), and with it the
 * start Coin (#70) — the answer's `startGrant` is what the notice screen shows. A refusal that
 * says the screen is out of date (the step done in another tab, a step before it not done) asks
 * `['me']` again, and the stepper follows.
 */
export function setOnboardingNicknameOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  post: (body: SetOnboardingNicknameBody) => Promise<Me> = postNickname,
) {
  return {
    mutationFn: post,
    onSuccess: (me: Me) => storeOnboardingAnswer(queryClient, me, 'nickname', onSessionChanged),
    onError: async (error: Error, body: SetOnboardingNicknameBody) => {
      if (isForAnotherAccount(error)) {
        onSessionChanged();
        return;
      }
      if (nicknameRefusalNeedsRefresh(error)) {
        await refreshOwnMe(queryClient, body.expectedAccountId);
      }
    },
  };
}

/**
 * The interests step's write (`answerInterestsStepOptions`): while one is on its way, leaving sends
 * no skip (`createInterestsLeaveReport`).
 */
export const INTERESTS_STEP_MUTATION_KEY = ['onboarding', 'interests'] as const;

/**
 * What both interest category writes do once they settle: the answer's `onboarding` and categories
 * into `['me']`; a refusal as another account asks for the session again, and an
 * ONBOARDING_REQUIRED says `['me']` is out of date (a revision asked for the consent again
 * meanwhile) and asks it again.
 */
function interestsWriteOptions<Body extends { expectedAccountId: string }>(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  write: (body: Body) => Promise<Me>,
) {
  return {
    mutationFn: write,
    onSuccess: (me: Me) => storeOnboardingAnswer(queryClient, me, 'interests', onSessionChanged),
    onError: async (error: Error, body: Body) => {
      if (isForAnotherAccount(error)) {
        onSessionChanged();
        return;
      }
      if (isApiError(error, 'ONBOARDING_REQUIRED')) {
        await refreshOwnMe(queryClient, body.expectedAccountId);
      }
    },
  };
}

/**
 * `POST /me/onboarding/interests` as mutation options: the interests step's answer from its screen
 * (#57-7), some categories or none (the skip) — for onboarded accounts only, and, as the account's
 * first choice, let through a writing or an account restriction (owner decision 2026-10-21 answer
 * 4, the server's rule). Keyed (`INTERESTS_STEP_MUTATION_KEY`) so the stepper does not report the
 * screen left while its answer is on the way (`createInterestsLeaveReport`).
 */
export function answerInterestsStepOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  post: (body: AnswerInterestsStepBody) => Promise<Me> = postInterestsStep,
) {
  return {
    mutationKey: INTERESTS_STEP_MUTATION_KEY,
    ...interestsWriteOptions(queryClient, onSessionChanged, post),
  };
}

/**
 * `PUT /me/interest-categories` as mutation options: MY 설정's interest categories (#41), the ones
 * kept (none: all dropped). Never the step's answer: a category added is a change — for onboarded
 * accounts only and refused under a restriction, the first one too (owner decision 2026-10-21
 * (2nd) answer 2) — and dropping needs sign-in only (the server's rules, ADR-0078).
 */
export function setInterestCategoriesOptions(
  queryClient: QueryClient,
  onSessionChanged: () => void,
  put: (body: SetInterestCategoriesBody) => Promise<Me> = putInterests,
) {
  return interestsWriteOptions(queryClient, onSessionChanged, put);
}

/**
 * Tells the server the account left the interests step without an answer — the skip, which the
 * step records as its answer (owner decision 2026-10-21 (2nd) answer 2, ADR-0078; ADR-0072 counts
 * leaving the start-Coin notice or the interests screen as skipping). Fire and forget: the page is
 * going, and a refusal (the onboarding no longer done, another account's cookie, no session) or a
 * lost request leaves the step unanswered (ADR-0078 7-23) — the server's own rule still keeps
 * MY 설정's first pick a change. The promise settles once the answer came or the request failed,
 * and never rejects: only 로그아웃 waits on it (`InterestsLeaveReport.beforeSignOut`).
 */
export function reportInterestsLeft(
  expectedAccountId: string,
  post: (body: AnswerInterestsStepBody) => Promise<void> = postInterestsLeft,
): Promise<void> {
  return post({ categoryIds: [], expectedAccountId }).catch(() => undefined);
}

/**
 * How long 로그아웃 on the start-Coin notice or the interests waits for the skip it sends first
 * (`InterestsLeaveReport.beforeSignOut`) before it ends the session anyway: the skip needs the
 * session, and one that has not come by then is left to race the sign-out (ADR-0078 7-23) rather
 * than keeping the account from signing out.
 */
export const SIGN_OUT_LEAVE_REPORT_WAIT_MS = 2_000;

/** Settles once `promise` has, or `ms` went by — whichever is first. Never rejects. */
function settledWithin(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, elapsed]).finally(() => clearTimeout(timer));
}

/** The stepper's leave report (`createInterestsLeaveReport`). */
export interface InterestsLeaveReport {
  /** What the stepper shows now — its screen and the account on it — every render. */
  readonly show: (screen: OnboardingScreen | null, accountId: string) => void;
  /** The stepper going away inside the app, or the page going (`pagehide`). */
  readonly leave: () => void;
  /**
   * 로그아웃 about to end the session: the skip sent now, while the session is there, and waited
   * for — at most `waitMs`. Nothing to wait for when leaving does not skip.
   */
  readonly beforeSignOut: () => Promise<void>;
}

/**
 * The stepper's leave report (owner decision 2026-10-21 (2nd) answer 2, ADR-0078): while the
 * screen is the start-Coin notice or the interests and no answer of the step is on its way —
 * asked of the mutation cache as the account leaves (`INTERESTS_STEP_MUTATION_KEY`,
 * `leavingSkipsInterests`): that answer answers the step itself, and a skip racing it could turn
 * the picks into a change — leaving sends the skip (`reportInterestsLeft`), once, whichever way the
 * account leaves. The screen reached nothing to skip or finished the step (null): nothing is sent.
 * A cache emptied under the stepper (after the sign-out, or for another account) forgets an answer
 * in flight, and the skip then sent is refused (401, 403) — it changes nothing. Plain, not a hook,
 * so the unit tests drive it under `environment: 'node'`.
 */
export function createInterestsLeaveReport(
  queryClient: QueryClient,
  post: (body: AnswerInterestsStepBody) => Promise<void> = postInterestsLeft,
  waitMs: number = SIGN_OUT_LEAVE_REPORT_WAIT_MS,
): InterestsLeaveReport {
  let shown: { screen: OnboardingScreen | null; accountId: string } | null = null;
  let sent: Promise<void> | null = null;
  const send = (): Promise<void> | null => {
    if (sent === null && shown !== null) {
      const answering = queryClient.isMutating({ mutationKey: INTERESTS_STEP_MUTATION_KEY }) > 0;
      if (leavingSkipsInterests(shown.screen, answering)) {
        sent = reportInterestsLeft(shown.accountId, post);
      }
    }
    return sent;
  };
  return {
    show: (screen, accountId) => {
      shown = { screen, accountId };
    },
    leave: () => {
      // Nobody waits: the page or the stepper is going.
      void send();
    },
    beforeSignOut: () => {
      const report = send();
      return report === null ? Promise.resolve() : settledWithin(report, waitMs);
    },
  };
}

/**
 * The stepper's leave report (`createInterestsLeaveReport`) for its life. Leaving is the stepper
 * going away inside the app (a link, Back, the account's cache emptied), the page going
 * (`pagehide`: the tab closed, reloaded — ADR-0072 7-35 counts a reload as leaving — or another
 * site opened), or 로그아웃, which ends the session before the stepper goes — so the page's
 * 로그아웃 calls what this returns first (`beforeSignOut`), and the stepper going after it sends
 * nothing more. The stepper finishing the step goes on to `next` with nothing left to show, so it
 * sends nothing. What the latest render showed is what the report reads; the stepper never mounts
 * on the notice or the interests (it reaches them after the nickname step on the same visit), so a
 * development remount reports nothing.
 */
export function useInterestsLeaveReport(
  screen: OnboardingScreen | null,
  accountId: string,
): () => Promise<void> {
  const queryClient = useQueryClient();
  const [report] = useState(() => createInterestsLeaveReport(queryClient));
  useEffect(() => {
    report.show(screen, accountId);
  });
  useEffect(() => {
    window.addEventListener('pagehide', report.leave);
    return () => {
      window.removeEventListener('pagehide', report.leave);
      report.leave();
    };
  }, [report]);
  return report.beforeSignOut;
}

/**
 * The account the screen shows (`accountId`, the session's user id — the `useCharge` source),
 * which every step sends as `expectedAccountId`, and `ready`, false until better-auth has said
 * whose session this is; the steps keep their submit disabled until then.
 */
function useScreenAccount() {
  const queryClient = useQueryClient();
  const { data: session, refetch } = useSession();
  const accountId = session?.user.id;
  return { queryClient, accountId, refetchSession: () => void refetch() };
}

/** `recordConsentsOptions` as the consent step's mutation, and MY 설정's marketing switch's. */
export function useRecordConsents() {
  const { queryClient, accountId, refetchSession } = useScreenAccount();
  const mutation = useMutation(recordConsentsOptions(queryClient, refetchSession));
  return { ...mutation, accountId, ready: accountId !== undefined };
}

/** `setOnboardingNicknameOptions` as the nickname step's mutation. */
export function useSetOnboardingNickname() {
  const { queryClient, accountId, refetchSession } = useScreenAccount();
  const mutation = useMutation(setOnboardingNicknameOptions(queryClient, refetchSession));
  return { ...mutation, accountId, ready: accountId !== undefined };
}

/** `answerInterestsStepOptions` as the interests step's mutation. */
export function useAnswerInterestsStep() {
  const { queryClient, accountId, refetchSession } = useScreenAccount();
  const mutation = useMutation(answerInterestsStepOptions(queryClient, refetchSession));
  return { ...mutation, accountId, ready: accountId !== undefined };
}

/** `setInterestCategoriesOptions` as MY 설정's interest categories card's mutation (#41). */
export function useSetInterestCategories() {
  const { queryClient, accountId, refetchSession } = useScreenAccount();
  const mutation = useMutation(setInterestCategoriesOptions(queryClient, refetchSession));
  return { ...mutation, accountId, ready: accountId !== undefined };
}
