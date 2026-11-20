/**
 * 제한적 재지급 (#74, ADR-0155; N01 §2·§9, N02 §8, N04 §5; owner answers 2026-11-21) over HTTP,
 * against the docker `test` profile. Pinned: `GET /me/regrant` reads the session's own status —
 * '준비 중' (`not_ready`, every number null) while any of the six release settings is undecided,
 * otherwise every refusal that applies, in order, with its numbers; `POST /me/regrant` grants at
 * once when none does — one REGRANT mint of the setting's amount into the member's own account,
 * its row, the wallet's '재지급' line and a `user:balance` event — and refuses with
 * REGRANT_NOT_ALLOWED and the same status otherwise, writing nothing. One request id grants once
 * (`replayed: true` after, at once or later). The request needs the Idempotency-Key (400), the
 * account on screen (403), no account restriction (403 RESTRICTED, a writing restriction does
 * not stop it), the onboarding done (409) and a session (401); a request that met a closure of
 * its account is answered UNAUTHENTICATED. `GET /admin/regrants` lists every re-grant, newest
 * first, to admins alone. Skips when TEST_* are unset.
 */
import { randomUUID } from 'node:crypto';
import { runAccountReconciliation, schema } from '@buddha/db';
import {
  balanceOf,
  closeAccount,
  completeOnboarding,
  createMarket,
  createModerationAction,
  createOrder,
  createPosition,
  createStartGrant,
  ledgerOf,
  setReleaseSetting,
  withLedgerGuardsOff,
} from '@buddha/db/test';
import {
  REGRANT_SETTINGS,
  adminRegrantSchema,
  applyRegrantResultSchema,
  ledgerEntrySchema,
  regrantStatusSchema,
  type AdminRegrant,
  type ApplyRegrantResult,
  type LedgerEntry,
  type RegrantStatus,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { AppError } from '../common/errors/app-error.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { RegrantService } from './regrant.service.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

type Values = Record<keyof typeof REGRANT_SETTINGS, number>;

/** The values most cases use: a 100-Coin member is exhausted, no wait, room to spare. */
const DEFAULTS: Values = {
  thresholdCoin: 100,
  amountCoin: 500,
  waitHours: 0,
  periodDays: 30,
  periodLimit: 3,
  totalCapCoin: 10_000,
};

/** The status under DEFAULTS of a member nothing refuses and no re-grant reached yet. */
const OPEN_STATUS: RegrantStatus = {
  open: true,
  eligible: true,
  refusals: [],
  amountCoin: '500',
  thresholdCoin: '100',
  waitHours: 0,
  waitUntil: null,
  periodDays: 30,
  periodLimit: 3,
  periodUsed: 0,
  nextPeriodAt: null,
  totalCapCoin: '10000',
  totalGrantedCoin: '0',
  remainingCapCoin: '10000',
};

/** The status while a setting is undecided: '준비 중', and no number known. */
const CLOSED_NUMBERS = {
  open: false,
  eligible: false,
  amountCoin: null,
  thresholdCoin: null,
  waitHours: null,
  waitUntil: null,
  periodDays: null,
  periodLimit: null,
  periodUsed: null,
  nextPeriodAt: null,
  totalCapCoin: null,
  totalGrantedCoin: null,
  remainingCapCoin: null,
} as const;

type Res = { statusCode: number; body: string; json: <T>() => T };

describe.skipIf(!hasTestInfra)('/api/v1/me/regrant, /api/v1/admin/regrants (integration)', () => {
  let t: TestApp;
  let member: TestUser;
  let admin: TestUser;
  let second: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await t.reset();
    admin = await anAdmin();
    second = await anAdmin();
    member = await granted(100n);
  });

  async function onboarded(): Promise<TestUser> {
    const user = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: user.id });
    return user;
  }
  async function anAdmin(): Promise<TestUser> {
    const user = await onboarded();
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, user.id));
    await t.app.get(AdminGuard).invalidate(user.id);
    return user;
  }
  /** An onboarded member whose start grant was paid with `startCoin`. */
  async function granted(startCoin: bigint): Promise<TestUser> {
    const user = await onboarded();
    await createStartGrant(t.db, { userId: user.id, amountCoin: startCoin });
    return user;
  }

  /** The six settings as an admin enters them (a test value each), DEFAULTS where not given. */
  async function settle(values: Partial<Values> = {}, only?: (keyof Values)[]): Promise<void> {
    const all = { ...DEFAULTS, ...values };
    for (const name of only ?? (Object.keys(REGRANT_SETTINGS) as (keyof Values)[])) {
      await setReleaseSetting(t.db, {
        adminId: admin.id,
        key: REGRANT_SETTINGS[name].key,
        status: 'test',
        value: all[name],
      });
    }
  }

  const read = (url: string, who?: TestUser) =>
    t.app.inject({
      method: 'GET',
      url: `/api/v1${url}`,
      headers: who ? { cookie: who.cookie } : {},
    });
  const apply = (
    who: TestUser | undefined,
    options: { key?: string | null; body?: Record<string, unknown>; origin?: string } = {},
  ) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/me/regrant',
      headers: {
        origin: options.origin ?? TRUSTED_ORIGIN,
        'content-type': 'application/json',
        ...(who ? { cookie: who.cookie } : {}),
        ...(options.key === null ? {} : { 'idempotency-key': options.key ?? randomUUID() }),
      },
      payload: JSON.stringify(options.body ?? { expectedAccountId: who?.id ?? randomUUID() }),
    });
  const dataOf = <T>(res: Res, status = 200): T => {
    expect(res.statusCode, res.body).toBe(status);
    return res.json<{ data: T }>().data;
  };
  const errorOf = (res: Res, status: number, code: string) => {
    expect(res.statusCode, res.body).toBe(status);
    const error = res.json<{ error: { code: string; details: unknown } }>().error;
    expect(error.code).toBe(code);
    return error.details;
  };
  const statusOf = async (who: TestUser) =>
    regrantStatusSchema.parse(dataOf<RegrantStatus>(await read('/me/regrant', who)));
  const grantOf = async (who: TestUser, key?: string) =>
    applyRegrantResultSchema.parse(dataOf<ApplyRegrantResult>(await apply(who, { key })));
  /** The refusal's details, which must be the status the same account reads now. */
  async function refusedOf(who: TestUser, key?: string): Promise<RegrantStatus> {
    const details = regrantStatusSchema.parse(
      errorOf(await apply(who, { key }), 409, 'REGRANT_NOT_ALLOWED'),
    );
    expect(await statusOf(who)).toEqual(details);
    return details;
  }

  async function regrantRows() {
    return t.db.select().from(schema.regrants).orderBy(schema.regrants.createdAt);
  }
  async function grantedAtOf(userId: string): Promise<Date> {
    const [grant] = await t.db
      .select({ grantedAt: schema.startGrants.grantedAt })
      .from(schema.startGrants)
      .where(eq(schema.startGrants.userId, userId));
    return grant!.grantedAt!;
  }
  /** Nothing re-granted to anyone, and the member's 100 Coin as it was. */
  async function expectNothingWritten(): Promise<void> {
    expect(await regrantRows()).toEqual([]);
    expect(await balanceOf(t.db, member.id)).toMatchObject({
      availableCoin: 100n,
      ledgerCoin: 100n,
    });
    expect((await ledgerOf(t.db, member.id)).map((row) => row.type)).toEqual(['START_GRANT']);
  }

  describe('준비 중 (owner answer 12)', () => {
    it('reads not_ready with no number and grants nothing while any of the six is undecided', async () => {
      // Nothing decided, then five of six: still 준비 중, as a value nobody decided is no rule.
      const fiveOfSix: (keyof Values)[] = [
        'thresholdCoin',
        'amountCoin',
        'waitHours',
        'periodDays',
        'periodLimit',
      ];
      for (const only of [[], fiveOfSix]) {
        if (only.length > 0) await settle({}, only);
        const status = { ...CLOSED_NUMBERS, refusals: ['not_ready'] };
        expect(await statusOf(member)).toEqual(status);
        expect(await refusedOf(member)).toEqual(status);
        await expectNothingWritten();
      }
      // The sixth decided: open, and the same member is granted.
      await settle({}, ['totalCapCoin']);
      expect(await statusOf(member)).toEqual(OPEN_STATUS);
      expect((await grantOf(member)).replayed).toBe(false);
    });

    it('still names the reasons that need no value while not_ready', async () => {
      const pending = await onboarded();
      await createStartGrant(t.db, { userId: pending.id });
      expect(await statusOf(pending)).toEqual({
        ...CLOSED_NUMBERS,
        refusals: ['not_ready', 'no_start_grant'],
      });
    });
  });

  describe('the grant (owner answer 3)', () => {
    it('grants the amount at once: one REGRANT mint, the balance, the row, the wallet line and the event', async () => {
      await settle();
      expect(await statusOf(member)).toEqual(OPEN_STATUS);
      const publish = vi.spyOn(t.app.get(MarketPublisher), 'publishUser');
      const key = `regrant_${randomUUID()}`;
      const result = await grantOf(member, key);

      const [row] = await regrantRows();
      expect(row).toMatchObject({
        userId: member.id,
        requestId: key,
        amountCoin: 500n,
        availableBeforeCoin: 100n,
      });
      expect(result).toEqual({
        regrant: { id: row!.id, amountCoin: '500', createdAt: row!.createdAt.toISOString() },
        replayed: false,
      });
      // A new issue into the member's own account, never from anyone (ADR-0155, N02 §8).
      const ledger = await ledgerOf(t.db, member.id);
      expect(ledger.map((entry) => [entry.type, entry.amountCoin])).toEqual([
        ['START_GRANT', 100n],
        ['REGRANT', 500n],
      ]);
      const entry = ledger[1]!;
      expect(entry).toMatchObject({
        refType: 'regrant',
        refId: row!.id,
        balanceAfterCoin: 600n,
        createdAt: row!.createdAt,
      });
      expect(row!.ledgerEntryId).toBe(entry.id);
      expect(await balanceOf(t.db, member.id)).toMatchObject({
        availableCoin: 600n,
        lockedCoin: 0n,
        ledgerCoin: 600n,
      });
      // The wallet hears about it without a reload (PLAN 8), as for the start grant.
      expect(publish.mock.calls).toEqual([
        [
          member.id,
          {
            type: 'user:balance',
            availableCoin: '600',
            lockedCoin: '0',
            ledgerEntryId: entry.id.toString(),
            ts: entry.createdAt.toISOString(),
          },
        ],
      ]);
      // The wallet's line: '재지급', its own filter kind, the row's reference.
      const lines = dataOf<LedgerEntry[]>(await read('/me/ledger?kind=REGRANT', member)).map(
        (line) => ledgerEntrySchema.parse(line),
      );
      expect(lines).toEqual([
        expect.objectContaining({
          kind: 'REGRANT',
          amountCoin: '500',
          balanceAfterCoin: '600',
          refType: 'regrant',
          refId: row!.id,
          marketId: null,
          memo: null,
        }),
      ]);

      // Afterwards: 600 Coin is no longer exhausted, and the period and the cap count it.
      expect(await statusOf(member)).toEqual({
        ...OPEN_STATUS,
        eligible: false,
        refusals: ['not_exhausted'],
        periodUsed: 1,
        totalGrantedCoin: '500',
        remainingCapCoin: '9500',
      });
    });

    it('answers the same request id with the same re-grant, granting nothing more (N01 §9)', async () => {
      await settle();
      const key = `regrant_${randomUUID()}`;
      const first = await grantOf(member, key);
      const publish = vi.spyOn(t.app.get(MarketPublisher), 'publishUser');
      // Later, with the account no longer exhausted: the id still names its re-grant.
      const again = await grantOf(member, key);
      expect(again).toEqual({ regrant: first.regrant, replayed: true });
      expect(publish).not.toHaveBeenCalled();
      expect(await regrantRows()).toHaveLength(1);
      expect((await ledgerOf(t.db, member.id)).map((row) => row.type)).toEqual([
        'START_GRANT',
        'REGRANT',
      ]);
      // A new id is a new request: refused now, for the account's own reasons.
      expect((await refusedOf(member)).refusals).toEqual(['not_exhausted']);
    });

    it('grants once for two requests with one id at once (a double click)', async () => {
      await settle();
      const key = randomUUID();
      const answers = await Promise.all([apply(member, { key }), apply(member, { key })]);
      const results = answers.map((res) => applyRegrantResultSchema.parse(dataOf(res)));
      expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(results[0]!.regrant).toEqual(results[1]!.regrant);
      expect(await regrantRows()).toHaveLength(1);
      expect(await balanceOf(t.db, member.id)).toMatchObject({ availableCoin: 600n });
    });
  });

  describe('refusals (owner answers 1·2·4·5·6·7·9)', () => {
    it('refuses an account whose start grant was never paid (4)', async () => {
      await settle();
      const unpaid = await onboarded();
      const pending = await onboarded();
      await createStartGrant(t.db, { userId: pending.id });
      for (const who of [unpaid, pending]) {
        expect(await refusedOf(who)).toEqual({
          ...OPEN_STATUS,
          eligible: false,
          refusals: ['no_start_grant'],
        });
      }
      expect(await regrantRows()).toEqual([]);
    });

    it('refuses available Coin above the threshold (1), and takes it at the threshold', async () => {
      await settle();
      const rich = await granted(101n);
      expect(await refusedOf(rich)).toEqual({
        ...OPEN_STATUS,
        eligible: false,
        refusals: ['not_exhausted'],
      });
      // 100 is the threshold itself: exhausted.
      expect((await grantOf(member)).regrant.amountCoin).toBe('500');
    });

    it('refuses a waiting order (2) and a contract of a market not settled (7), each named', async () => {
      await settle();
      const market = await createMarket(t.db);
      await createOrder(t.db, { marketId: market.id, userId: member.id });
      expect((await refusedOf(member)).refusals).toEqual(['live_orders']);
      const holder = await granted(100n);
      await createPosition(t.db, {
        userId: holder.id,
        marketId: market.id,
        outcome: 'YES',
        qty: 1,
      });
      expect((await refusedOf(holder)).refusals).toEqual(['unsettled_positions']);
      await expectNothingWritten();
    });

    it('refuses an account held for a reconciliation difference (#93), as an order is', async () => {
      await settle();
      const bump = (amount: bigint) =>
        withLedgerGuardsOff((c) =>
          c.query('UPDATE balances SET available_coin = available_coin + $1 WHERE user_id = $2', [
            String(amount),
            member.id,
          ]),
        );
      await bump(1n);
      const failed = await t.db.transaction((tx) =>
        runAccountReconciliation(tx, { userId: member.id }, { source: 'manual' }),
      );
      expect(failed.hold).not.toBeNull();
      await bump(-1n);
      expect((await refusedOf(member)).refusals).toEqual(['held']);
      await expectNothingWritten();
    });

    it('refuses within the wait since the start grant, with when it ends (5)', async () => {
      await settle({ waitHours: 2 });
      const waitUntil = new Date((await grantedAtOf(member.id)).getTime() + 2 * HOUR_MS);
      expect(await refusedOf(member)).toEqual({
        ...OPEN_STATUS,
        eligible: false,
        refusals: ['waiting'],
        waitHours: 2,
        waitUntil: waitUntil.toISOString(),
      });
      await expectNothingWritten();
    });

    it('refuses once the period’s re-grants are used, with when the next frees (5)', async () => {
      await settle({ thresholdCoin: 10_000, periodLimit: 1 });
      const first = await grantOf(member);
      const nextPeriodAt = new Date(new Date(first.regrant.createdAt).getTime() + 30 * DAY_MS);
      expect(await refusedOf(member)).toEqual({
        ...OPEN_STATUS,
        thresholdCoin: '10000',
        periodLimit: 1,
        eligible: false,
        refusals: ['period_limit'],
        periodUsed: 1,
        nextPeriodAt: nextPeriodAt.toISOString(),
        totalGrantedCoin: '500',
        remainingCapCoin: '9500',
      });
      expect(await regrantRows()).toHaveLength(1);
    });

    it('refuses a re-grant past the lifetime cap, never granting what is left (6)', async () => {
      await settle({ thresholdCoin: 10_000, totalCapCoin: 600 });
      await grantOf(member);
      expect(await refusedOf(member)).toEqual({
        ...OPEN_STATUS,
        thresholdCoin: '10000',
        eligible: false,
        refusals: ['total_cap'],
        periodUsed: 1,
        totalCapCoin: '600',
        totalGrantedCoin: '500',
        remainingCapCoin: '100',
      });
      expect(await regrantRows()).toHaveLength(1);
      expect(await balanceOf(t.db, member.id)).toMatchObject({ availableCoin: 600n });
    });

    it('names every reason that applies, in order, with the numbers (9)', async () => {
      await settle({ waitHours: 1, periodLimit: 1, totalCapCoin: 500 });
      const rich = await granted(1_000n);
      const market = await createMarket(t.db);
      await createOrder(t.db, { marketId: market.id, userId: rich.id });
      await createPosition(t.db, { userId: rich.id, marketId: market.id, outcome: 'NO', qty: 2 });
      expect((await refusedOf(rich)).refusals).toEqual([
        'not_exhausted',
        'live_orders',
        'unsettled_positions',
        'waiting',
      ]);
      expect(await regrantRows()).toEqual([]);
    });
  });

  describe('who may ask', () => {
    it('refuses a missing or malformed Idempotency-Key before anything (400)', async () => {
      await settle();
      for (const key of [null, 'short', 'has space in it', 'x'.repeat(129)]) {
        const details = errorOf(await apply(member, { key }), 400, 'VALIDATION_ERROR') as {
          path: string[];
        }[];
        expect(details.map((detail) => detail.path)).toEqual([['Idempotency-Key']]);
      }
      await expectNothingWritten();
    });

    it('refuses a body naming another account (403), whoever that is, and writes nothing', async () => {
      await settle();
      const other = await granted(100n);
      const details = errorOf(
        await apply(other, { body: { expectedAccountId: member.id } }),
        403,
        'FORBIDDEN',
      ) as { path: string[] }[];
      expect(details.map((detail) => detail.path)).toEqual([['expectedAccountId']]);
      expect(await regrantRows()).toEqual([]);
      expect(await balanceOf(t.db, other.id)).toMatchObject({ availableCoin: 100n });
      await expectNothingWritten();
    });

    it('refuses an account restriction with its end (8), and not a writing restriction', async () => {
      await settle();
      const endsAt = new Date(Date.now() + DAY_MS);
      await createModerationAction(t.db, {
        userId: member.id,
        createdBy: admin.id,
        approvedBy: second.id,
        type: 'account_restriction',
        reason: 'multi_account',
        endsAt,
      });
      expect(errorOf(await apply(member), 403, 'RESTRICTED')).toEqual({
        kind: 'account',
        endsAt: endsAt.toISOString(),
      });
      // The status names it among the refusals, the numbers as ever.
      expect(await statusOf(member)).toEqual({
        ...OPEN_STATUS,
        eligible: false,
        refusals: ['restricted'],
      });
      await expectNothingWritten();

      const writer = await granted(100n);
      await createModerationAction(t.db, {
        userId: writer.id,
        createdBy: admin.id,
        type: 'writing_restriction',
        endsAt: null,
      });
      expect((await grantOf(writer)).replayed).toBe(false);
    });

    it('answers no session 401, a foreign Origin 403 and an unfinished onboarding as the guard does', async () => {
      await settle();
      expect((await read('/me/regrant')).statusCode).toBe(401);
      errorOf(await apply(undefined), 401, 'UNAUTHENTICATED');
      expect((await apply(member, { origin: 'https://evil.example' })).statusCode).toBe(403);
      // Signed up, nothing done: the status is a read (no_start_grant — no start grant without
      // the onboarding), the request ONBOARDING_REQUIRED with the steps it misses (#57-8).
      const fresh = await signUpTestUser(t);
      expect(await statusOf(fresh)).toEqual({
        ...OPEN_STATUS,
        eligible: false,
        refusals: ['no_start_grant'],
      });
      expect(errorOf(await apply(fresh), 409, 'ONBOARDING_REQUIRED')).toEqual({
        steps: ['consent', 'verification', 'nickname'],
      });
      await expectNothingWritten();
    });

    it('answers a request that met a closure of its account as the session that ended', async () => {
      await settle();
      await closeAccount(t.db, member.id);
      // As a request that passed SessionGuard before the closure committed: the closure took the
      // Coin, so the account reads exhausted, and the row's trigger refuses it.
      const refused = await t.app
        .get(RegrantService)
        .apply(member.id, randomUUID())
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(AppError);
      expect(refused).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
      expect(await regrantRows()).toEqual([]);
      expect((await ledgerOf(t.db, member.id)).map((row) => row.type)).toEqual([
        'START_GRANT',
        'CLOSURE_FORFEIT',
      ]);
    });
  });

  describe('GET /admin/regrants (owner answer 3: records only)', () => {
    it('answers 401 without a session and 403 to a member', async () => {
      expect((await read('/admin/regrants')).statusCode).toBe(401);
      errorOf(await read('/admin/regrants', member), 403, 'FORBIDDEN');
    });

    it('lists every account’s re-grants to an admin, newest first, a page at a time', async () => {
      await settle({ thresholdCoin: 10_000 });
      const other = await granted(40n);
      const first = await grantOf(member);
      const latest = await grantOf(other);
      const [mine, theirs] = await Promise.all(
        [member, other].map(async (who) => {
          const [profile] = await t.db
            .select({ publicId: schema.profiles.publicId, nickname: schema.profiles.nickname })
            .from(schema.profiles)
            .where(eq(schema.profiles.userId, who.id));
          return profile!;
        }),
      );
      const expected: AdminRegrant[] = [
        {
          id: latest.regrant.id,
          account: { userId: other.id, publicId: theirs!.publicId, nickname: theirs!.nickname },
          amountCoin: '500',
          availableBeforeCoin: '40',
          createdAt: latest.regrant.createdAt,
        },
        {
          id: first.regrant.id,
          account: { userId: member.id, publicId: mine!.publicId, nickname: mine!.nickname },
          amountCoin: '500',
          availableBeforeCoin: '100',
          createdAt: first.regrant.createdAt,
        },
      ];
      const records = async () => (await t.db.select().from(schema.adminActions)).length;
      const before = await records();
      const all = await read('/admin/regrants', admin);
      expect(dataOf<AdminRegrant[]>(all).map((item) => adminRegrantSchema.parse(item))).toEqual(
        expected,
      );
      // One at a time: the newest, then the cursor reaches the older and stops.
      const page = await read('/admin/regrants?limit=1', admin);
      expect(dataOf<AdminRegrant[]>(page)).toEqual([expected[0]]);
      const cursor = page.json<{ meta: { nextCursor: string | null } }>().meta.nextCursor;
      expect(cursor).not.toBeNull();
      const rest = await read(
        `/admin/regrants?limit=1&cursor=${encodeURIComponent(cursor!)}`,
        admin,
      );
      expect(dataOf<AdminRegrant[]>(rest)).toEqual([expected[1]]);
      expect(rest.json<{ meta: { nextCursor: string | null } }>().meta.nextCursor).toBeNull();
      // A read: no operation record (admin-audit.test).
      expect(await records()).toBe(before);
    });
  });
});
