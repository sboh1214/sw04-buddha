import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiError, type Me, type RecordMarketVisitBody } from '@/lib/api';
import { type Onboarding } from '@/lib/onboarding';
import {
  marketVisitKey,
  marketVisitToRecord,
  marketVisitToSend,
  recordMarketVisit,
} from './use-record-market-visit';

/**
 * 방문 기록 (#151, ADR-0170; 151-3, 151-4, 결정 6): what the market detail sends, when, and what
 * it does with the answer. No component renders under node with effects, so the effect's
 * decisions are the exported functions driven here render by render, and its wiring is pinned in
 * the source; the e2e (observation-metrics.spec.ts) watches the POST leave an open page.
 */

const MARKET = '0b6f3f3e-6a52-4c1e-9d0e-2f6d7a1b9c01';
const OTHER_MARKET = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const PATH = '/markets/some-market';

const DONE: Onboarding = {
  consent: true,
  verification: true,
  nickname: true,
  completed: true,
  interests: true,
  nextStep: null,
  consents: [],
};
const agreed = (item: 'terms' | 'privacy' | 'age') => ({
  item,
  version: 'draft-2026-10-18',
  agreed: true,
  recordedAt: '2026-10-18T00:00:00.000Z',
});
/** Done once, then a revision that changed members' rights asked for the consent again (#57-5). */
const RECONSENT: Onboarding = {
  ...DONE,
  consent: false,
  completed: false,
  nextStep: 'consent',
  consents: [agreed('terms'), agreed('privacy'), agreed('age')],
};
/** Signed up, nothing done yet. */
const FRESH: Onboarding = {
  consent: false,
  verification: false,
  nickname: false,
  completed: false,
  interests: false,
  nextStep: 'consent',
  consents: [],
};

const me = (id: string, onboarding: Onboarding = DONE): Me => ({
  id,
  email: `${id}@example.com`,
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
  verification: {
    realName: '홍길동',
    phone: '01012345678',
    verifiedAt: '2026-10-18T00:00:00.000Z',
  },
  startGrant: null,
  firstOrderPlaced: false,
  onboarding,
});

const forAnotherAccount = () =>
  new ApiError(403, {
    code: 'FORBIDDEN',
    message: 'x',
    details: [{ path: ['expectedAccountId'], message: 'session belongs to another account' }],
  });

/**
 * One mount of the hook, render by render: each render's `GET /me` state goes through
 * `marketVisitToRecord`, and the effect — which React runs only when a dependency changed — sends
 * what `marketVisitToSend` says, remembering the key in the mount's ref.
 */
function mount() {
  let sentKey: string | undefined;
  let deps: readonly unknown[] | undefined;
  const sent: RecordMarketVisitBody[] = [];
  return {
    sent,
    render(state: {
      isLoggedIn: boolean;
      me: Me | undefined;
      marketId?: string;
      pathname?: string;
      refetch?: () => void;
    }) {
      const marketId = state.marketId ?? MARKET;
      const accountId = marketVisitToRecord({
        isLoggedIn: state.isLoggedIn,
        me: state.me,
        pathname: state.pathname ?? PATH,
        marketId,
      })?.expectedAccountId;
      const next = [accountId, marketId, state.refetch];
      if (deps !== undefined && next.every((value, index) => Object.is(value, deps?.[index]))) {
        return;
      }
      deps = next;
      const body = marketVisitToSend(sentKey, accountId, marketId);
      if (body === undefined) return;
      sentKey = marketVisitKey(body);
      sent.push(body);
    },
  };
}

describe('marketVisitToRecord', () => {
  it('names the account on screen and the market for a signed-in, onboarded member', () => {
    expect(
      marketVisitToRecord({ isLoggedIn: true, me: me('a'), pathname: PATH, marketId: MARKET }),
    ).toEqual({ expectedAccountId: 'a', marketId: MARKET });
  });

  it('sends nothing signed out, while GET /me is out, or for an account the gate sends away', () => {
    // A visitor: the client never sends (the route would answer 401).
    expect(
      marketVisitToRecord({ isLoggedIn: false, me: undefined, pathname: PATH, marketId: MARKET }),
    ).toBeUndefined();
    // Signed out with a `Me` still cached from before: not an account to name.
    expect(
      marketVisitToRecord({ isLoggedIn: false, me: me('a'), pathname: PATH, marketId: MARKET }),
    ).toBeUndefined();
    // Signed in, `/me` not answered: the gate still renders the page on a hard load — never a
    // guess.
    expect(
      marketVisitToRecord({ isLoggedIn: true, me: undefined, pathname: PATH, marketId: MARKET }),
    ).toBeUndefined();
    // An onboarding step left — the first one, or a re-consent alone (151-4's basis is the
    // notice the consent step carries): the gate replaces the page, which is not an open.
    for (const onboarding of [FRESH, RECONSENT]) {
      expect(
        marketVisitToRecord({
          isLoggedIn: true,
          me: me('a', onboarding),
          pathname: PATH,
          marketId: MARKET,
        }),
        onboarding.nextStep ?? 'done',
      ).toBeUndefined();
    }
  });

  it('decides no role: an admin’s open is sent and the server keeps no row (151-3, 96-10)', () => {
    const admin = me('op');
    admin.profile.role = 'admin';
    expect(
      marketVisitToRecord({ isLoggedIn: true, me: admin, pathname: PATH, marketId: MARKET }),
    ).toEqual({ expectedAccountId: 'op', marketId: MARKET });
  });
});

describe('one mount of useRecordMarketVisit', () => {
  it('sends once when GET /me answers, and not again on re-renders, refetches or a new Me', () => {
    const page = mount();
    const refetch = () => undefined;
    // Session known, `/me` out: nothing.
    page.render({ isLoggedIn: true, me: undefined, refetch });
    expect(page.sent).toEqual([]);
    page.render({ isLoggedIn: true, me: me('a'), refetch });
    expect(page.sent).toEqual([{ expectedAccountId: 'a', marketId: MARKET }]);
    // A re-render, a focus refetch of `/me` (a new object, same account), a market event, a
    // hash change: the same key.
    page.render({ isLoggedIn: true, me: me('a'), refetch });
    page.render({ isLoggedIn: true, me: me('a'), refetch });
    // A new `refetch` re-runs the effect, which finds the key already sent (as StrictMode's
    // second run does).
    page.render({ isLoggedIn: true, me: me('a'), refetch: () => undefined });
    expect(page.sent).toHaveLength(1);
  });

  it('sends for another market in the same mount, and for the first market again after it', () => {
    const page = mount();
    page.render({ isLoggedIn: true, me: me('a') });
    page.render({ isLoggedIn: true, me: me('a'), marketId: OTHER_MARKET });
    page.render({ isLoggedIn: true, me: me('a'), marketId: OTHER_MARKET });
    page.render({ isLoggedIn: true, me: me('a') });
    expect(page.sent.map((body) => body.marketId)).toEqual([MARKET, OTHER_MARKET, MARKET]);
  });

  it('sends nothing signed out or gated, and once the gate lets the page stay', () => {
    const visitor = mount();
    visitor.render({ isLoggedIn: false, me: undefined });
    visitor.render({ isLoggedIn: false, me: undefined });
    expect(visitor.sent).toEqual([]);

    const gated = mount();
    gated.render({ isLoggedIn: true, me: undefined });
    gated.render({ isLoggedIn: true, me: me('a', RECONSENT) });
    gated.render({ isLoggedIn: true, me: me('a', FRESH) });
    expect(gated.sent).toEqual([]);
    // (The gate unmounts the page meanwhile; were it kept, the open after the step is one.)
    gated.render({ isLoggedIn: true, me: me('a') });
    expect(gated.sent).toEqual([{ expectedAccountId: 'a', marketId: MARKET }]);
  });

  it('names the new account after the tab’s session changed to it', () => {
    const page = mount();
    page.render({ isLoggedIn: true, me: me('a') });
    page.render({ isLoggedIn: true, me: me('b') });
    expect(page.sent.map((body) => body.expectedAccountId)).toEqual(['a', 'b']);
  });
});

describe('recordMarketVisit', () => {
  const body = { expectedAccountId: 'a', marketId: MARKET };

  it('posts the body once and resolves', async () => {
    const posted: RecordMarketVisitBody[] = [];
    let changed = 0;
    await recordMarketVisit(
      body,
      () => (changed += 1),
      (sent) => {
        posted.push(sent);
        return Promise.resolve();
      },
    );
    expect(posted).toEqual([body]);
    expect(changed).toBe(0);
  });

  it('swallows every refusal and failure without asking for the session or retrying', async () => {
    const failures: Error[] = [
      new ApiError(401, { code: 'UNAUTHENTICATED', message: 'x' }),
      new ApiError(409, { code: 'ONBOARDING_REQUIRED', message: 'x' }),
      new ApiError(404, { code: 'NOT_FOUND', message: 'x' }),
      new ApiError(429, { code: 'RATE_LIMITED', message: 'x' } as never),
      // A CSRF refusal names no field: not another account's.
      new ApiError(403, { code: 'FORBIDDEN', message: 'x' }),
      new ApiError(502, undefined),
      new TypeError('Failed to fetch'),
    ];
    for (const failure of failures) {
      let calls = 0;
      let changed = 0;
      await expect(
        recordMarketVisit(
          body,
          () => (changed += 1),
          () => {
            calls += 1;
            return Promise.reject(failure);
          },
        ),
      ).resolves.toBeUndefined();
      expect(calls, String(failure)).toBe(1);
      expect(changed, String(failure)).toBe(0);
    }
  });

  it('asks for the session again, once, on a refusal as another account, and does not retry', async () => {
    let calls = 0;
    let changed = 0;
    await expect(
      recordMarketVisit(
        body,
        () => (changed += 1),
        () => {
          calls += 1;
          return Promise.reject(forAnotherAccount());
        },
      ),
    ).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(changed).toBe(1);
  });
});

describe('useRecordMarketVisit wiring', () => {
  const source = readFileSync(new URL('./use-record-market-visit.ts', import.meta.url), 'utf8');
  const hook = source.slice(source.indexOf('export function useRecordMarketVisit('));

  it('sends from an effect keyed on the account, the market and the session refetch', () => {
    expect(hook).toContain('useEffect(() => {');
    expect(hook).toContain('const body = marketVisitToSend(sentRef.current, accountId, marketId);');
    expect(hook).toContain('sentRef.current = marketVisitKey(body);');
    expect(hook).toContain('void recordMarketVisit(body, () => void refetch());');
    expect(hook).toContain('}, [accountId, marketId, refetch]);');
    // The gate's own predicate on the page's path, the `Me` on screen, the session's refetch.
    expect(hook).toContain('const pathname = usePathname();');
    expect(hook).toContain('const { data: me, isLoggedIn } = useMe();');
    expect(hook).toContain('const { refetch } = useSession();');
    // No client date or "sent today" store, no setting or switch (151-4: on from deploy).
    expect(source).not.toMatch(/Date\.now|new Date\(|localStorage|sessionStorage|release-setting/);
  });

  it('posts to the one route with the market in the body, read off the status (204)', () => {
    expect(source).toContain("api.POST('/api/v1/me/market-visits', { body })");
    expect(source).toContain('if (!result.response.ok) throw new ApiError(');
    expect(source).not.toContain('unwrap(');
  });

  it('is called by the market detail alone (결정 6 "시장 상세만")', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path);
      }
    };
    walk(root);
    const importers = files
      .filter((file) => readFileSync(file, 'utf8').includes('use-record-market-visit'))
      .map((file) => relative(root, file))
      .filter((file) => file !== join('hooks', 'use-record-market-visit.ts'));
    expect(importers).toEqual([join('app', 'markets', '[slug]', 'market-detail.tsx')]);
    const detail = readFileSync(
      join(root, 'app', 'markets', '[slug]', 'market-detail.tsx'),
      'utf8',
    );
    expect(detail.match(/useRecordMarketVisit\(/g)).toHaveLength(1);
    expect(detail).toContain('useRecordMarketVisit(marketId);');
    const dispute = readFileSync(
      join(root, 'app', 'markets', '[slug]', 'dispute', 'dispute-screen.tsx'),
      'utf8',
    );
    expect(dispute).not.toContain('market-visits');
    expect(dispute).not.toContain('useRecordMarketVisit');
  });
});
