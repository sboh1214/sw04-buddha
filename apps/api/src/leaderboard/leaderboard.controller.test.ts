/**
 * `GET /leaderboard` (PLAN M6 선택) against the docker `test` profile. Skips when TEST_* are
 * unset (fails under CI=true, see the harness).
 */
import { schema } from '@buddha/db';
import { createMarket, createPosition } from '@buddha/db/test';
import { LEADERBOARD_LIMIT, type LeaderboardEntry } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

describe.skipIf(!hasTestInfra)('leaderboard (integration)', () => {
  let t: TestApp;
  let marketId: string;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    marketId = (await createMarket(t.db)).id;
  });

  const board = async (): Promise<LeaderboardEntry[]> => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/leaderboard' });
    expect(res.statusCode).toBe(200);
    const body: { data: LeaderboardEntry[] } = res.json();
    return body.data;
  };

  /** A settled position with a realized result, the shape the ranking sums. */
  async function realize(user: TestUser, realizedPnlP: bigint): Promise<void> {
    await createPosition(t.db, {
      userId: user.id,
      marketId,
      outcome: 'YES',
      qty: 0,
      realizedPnlP,
      settled: true,
    });
  }

  async function nicknameOf(user: TestUser): Promise<string> {
    const [row] = await t.db
      .select({ nickname: schema.profiles.nickname })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, user.id));
    return row!.nickname;
  }

  it('is public: an anonymous visitor gets the board', async () => {
    expect(await board()).toEqual([]);
  });

  it('ranks by realized profit and loss, losses included', async () => {
    const winner = await signUpTestUser(t);
    const loser = await signUpTestUser(t);
    await realize(winner, 4_200n);
    await realize(loser, -900n);

    expect(await board()).toEqual([
      { rank: 1, nickname: await nicknameOf(winner), realizedPnlP: '4200' },
      { rank: 2, nickname: await nicknameOf(loser), realizedPnlP: '-900' },
    ]);
  });

  it('sums an account across markets, as a bigint', async () => {
    const trader = await signUpTestUser(t);
    const second = await createMarket(t.db);
    // Two halves that only add up correctly in 64-bit arithmetic: as doubles they would land
    // one P away, which is exactly the class of bug PLAN 0.2 forbids.
    await createPosition(t.db, {
      userId: trader.id,
      marketId,
      outcome: 'YES',
      qty: 0,
      realizedPnlP: 9_007_199_254_740_993n,
    });
    await createPosition(t.db, {
      userId: trader.id,
      marketId: second.id,
      outcome: 'NO',
      qty: 0,
      realizedPnlP: 1n,
    });

    const [top] = await board();
    expect(top?.realizedPnlP).toBe('9007199254740994');
  });

  it('leaves out accounts that have realized nothing', async () => {
    // A position row exists from the first buy, so a board that ranked zeros would be twenty
    // untouched accounts in id order — a ranking that ranks nothing.
    const holder = await signUpTestUser(t);
    const trader = await signUpTestUser(t);
    await realize(holder, 0n);
    await realize(trader, 10n);

    expect((await board()).map((entry) => entry.nickname)).toEqual([await nicknameOf(trader)]);
  });

  it(`returns at most ${String(LEADERBOARD_LIMIT)} accounts`, async () => {
    for (let i = 0; i < LEADERBOARD_LIMIT + 2; i += 1) {
      const user = await signUpTestUser(t);
      await realize(user, BigInt(i + 1));
    }
    const rows = await board();
    expect(rows).toHaveLength(LEADERBOARD_LIMIT);
    expect(rows.map((entry) => entry.rank)).toEqual(
      Array.from({ length: LEADERBOARD_LIMIT }, (_, index) => index + 1),
    );
    // Descending, so the two smallest are the ones left out.
    expect(rows[0]?.realizedPnlP).toBe(String(LEADERBOARD_LIMIT + 2));
  });

  it('orders ties the same way twice, so SSR and a refetch agree', async () => {
    const a = await signUpTestUser(t);
    const b = await signUpTestUser(t);
    await realize(a, 500n);
    await realize(b, 500n);
    expect(await board()).toEqual(await board());
  });

  it('names nobody: the board carries nicknames, never account ids', async () => {
    const trader = await signUpTestUser(t);
    await realize(trader, 77n);
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/leaderboard' });
    expect(res.body).not.toContain(trader.id);
    expect(res.body).not.toContain(trader.email);
  });
});
