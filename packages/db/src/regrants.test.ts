import { randomUUID } from 'node:crypto';
import { REGRANT_REFUSALS, REGRANT_SETTINGS, type RegrantStatusRead } from '@buddha/shared';
import { and, eq, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findLedgerAccount, ledgerKeys, lockLedgerAccounts, recordLedgerEntry } from './ledger.js';
import { runAccountReconciliation } from './reconciliation-audit.js';
import {
  applyRegrant,
  readAdminRegrantPage,
  regrantsOf,
  regrantStatus,
  type ApplyRegrantOutcome,
} from './regrants.js';
import { ledgerEntries, profiles, regrants, startGrants } from './schema/index.js';
import { cancelStartGrant } from './start-grants.js';
import {
  closeAccount,
  createMarket,
  createMarketMakerAccount,
  createModerationAction,
  createPosition,
  createStartGrant,
  createUser,
  setReleaseSetting,
} from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';
import { balanceOf, ledgerOf, ledgerSupply, withLedgerGuardsOff } from './test/ledger.js';
import { createOrder } from './test/orders.js';
import { waitForLockWaiter } from './test/wait.js';

/** Postgres SQLSTATE, wrapped (drizzle) or bare. */
function sqlState(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
}

/** The constraint a refusal names. */
function sqlConstraint(error: unknown): string | undefined {
  const e = error as { constraint?: string; cause?: { constraint?: string } } | null;
  return e?.cause?.constraint ?? e?.constraint;
}

/** Rejects with the trigger `name` (raised with its own name as the constraint, SQLSTATE 23000). */
const refusedBy = (name: string) => (error: unknown) =>
  sqlState(error) === '23000' && sqlConstraint(error) === name;

type Values = Record<keyof typeof REGRANT_SETTINGS, number>;

/** The values most cases use: a fresh 100-Coin member is exhausted; no wait; room to spare. */
const DEFAULTS: Values = {
  thresholdCoin: 100,
  amountCoin: 500,
  waitHours: 0,
  periodDays: 30,
  periodLimit: 3,
  totalCapCoin: 10_000,
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * 제한적 재지급 (#74, ADR-0155; owner answers 2026-11-21): `applyRegrant` and `regrantStatus` on the
 * docker test profile — every refusal with its numbers, the grant and its ledger entry, a request
 * id's replay, two requests at once, a role grant at once (ADR-0156), and migration 0077's guards
 * (keep-record, the human and open account, the row and the entry naming each other).
 */
describe.skipIf(!hasTestDb())('the re-grant (#74, docker test profile)', () => {
  let t: TestDb;
  let admin: string;

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = (await createUser(t.db, { role: 'admin' })).user.id;
  });

  /** Sets the six settings (a test value each), `DEFAULTS` for the ones not given. */
  async function settle(values: Partial<Values> = {}, only?: (keyof Values)[]): Promise<void> {
    const all = { ...DEFAULTS, ...values };
    for (const name of only ?? (Object.keys(REGRANT_SETTINGS) as (keyof Values)[])) {
      await setReleaseSetting(t.db, {
        adminId: admin,
        key: REGRANT_SETTINGS[name].key,
        status: 'test',
        value: all[name],
      });
    }
  }

  /** Every one of the six back to undecided, as an admin may set it. */
  async function unsettle(): Promise<void> {
    for (const definition of Object.values(REGRANT_SETTINGS)) {
      await setReleaseSetting(t.db, {
        adminId: admin,
        key: definition.key,
        status: 'undecided',
        value: null,
      });
    }
  }

  /** A member whose start grant was paid with `startCoin` (100: exhausted under DEFAULTS). */
  async function member(startCoin = 100n): Promise<string> {
    return (await createUser(t.db, { balanceCoin: startCoin })).user.id;
  }

  const apply = (userId: string, requestId: string = randomUUID()) =>
    t.db.transaction((tx) => applyRegrant(tx, { userId, requestId }));

  async function granted(userId: string, requestId?: string) {
    const done = await apply(userId, requestId);
    if (done.outcome !== 'granted') throw new Error(`not granted: ${JSON.stringify(done)}`);
    return done;
  }

  async function refused(userId: string): Promise<RegrantStatusRead> {
    const done = await apply(userId);
    if (done.outcome !== 'refused') throw new Error(`not refused: ${done.outcome}`);
    // The status read says the same as the request did, with nothing written meanwhile.
    expect(await regrantStatus(t.db, userId)).toEqual(done.status);
    return done.status;
  }

  /** The role as the test fixtures write it (no grant record: the role alone is read). */
  const setRole = (userId: string, role: 'admin' | 'user') =>
    t.db.update(profiles).set({ role }).where(eq(profiles.userId, userId));

  const grantedAtOf = async (userId: string) =>
    (await t.db.select().from(startGrants).where(eq(startGrants.userId, userId)))[0]!.grantedAt!;

  const closedNumbers = {
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
  };

  describe('granting', () => {
    it('grants at once when every condition holds: one REGRANT mint, the balance, the row', async () => {
      await settle();
      const userId = await member();
      const requestId = `req_${randomUUID()}`;
      expect(await regrantStatus(t.db, userId)).toEqual({
        open: true,
        eligible: true,
        refusals: [],
        amountCoin: 500n,
        thresholdCoin: 100n,
        waitHours: 0,
        waitUntil: null,
        periodDays: 30,
        periodLimit: 3,
        periodUsed: 0,
        nextPeriodAt: null,
        totalCapCoin: 10_000n,
        totalGrantedCoin: 0n,
        remainingCapCoin: 10_000n,
      });
      const done = await granted(userId, requestId);
      const account = await findLedgerAccount(t.db, { kind: 'user', userId });
      expect(done.replayed).toBe(false);
      // ADR-0155: a new issue straight into the member's own account, referring to its row.
      expect(done.entry).toMatchObject({
        type: 'REGRANT',
        amountCoin: 500n,
        fromAccountId: null,
        toAccountId: account!.id,
        fromBalanceAfterCoin: null,
        toBalanceAfterCoin: 600n,
        marketId: null,
        refType: 'regrant',
        refId: done.regrant.id,
        idempotencyKey: ledgerKeys.regrant(done.regrant.id),
        memo: null,
      });
      expect(done.regrant).toEqual({
        id: done.regrant.id,
        userId,
        requestId,
        amountCoin: 500n,
        availableBeforeCoin: 100n,
        ledgerEntryId: done.entry.id,
        createdAt: done.entry.createdAt,
      });
      expect(done.balance).toMatchObject({ availableCoin: 600n, lockedCoin: 0n, ledgerCoin: 600n });
      expect(await balanceOf(t.db, userId)).toMatchObject({
        availableCoin: 600n,
        ledgerCoin: 600n,
      });
      expect((await ledgerOf(t.db, userId)).map((row) => [row.type, row.amountCoin])).toEqual([
        ['START_GRANT', 100n],
        ['REGRANT', 500n],
      ]);
      expect(await regrantsOf(t.db, userId)).toEqual([done.regrant]);
      // A mint: what is held is what was minted, every account's total its ledger's.
      const supply = await ledgerSupply(t.db);
      expect(supply.mintedCoin).toBe(600n);
      expect([supply.heldCoin, supply.carriedCoin]).toEqual([600n, 600n]);
      // Its effect on the next status: one of the period used, the cap counted, not exhausted.
      expect(await regrantStatus(t.db, userId)).toMatchObject({
        eligible: false,
        refusals: ['not_exhausted'],
        periodUsed: 1,
        totalGrantedCoin: 500n,
        remainingCapCoin: 9_500n,
      });
    });

    it('counts available Coin at the threshold as exhausted, and one Coin more as not', async () => {
      await settle({ thresholdCoin: 100 });
      expect((await apply(await member(100n))).outcome).toBe('granted');
      const above = await member(101n);
      expect(await refused(above)).toMatchObject({
        open: true,
        eligible: false,
        refusals: ['not_exhausted'],
        thresholdCoin: 100n,
      });
      // A threshold of 0: only an account with nothing available.
      await settle({ thresholdCoin: 0 });
      expect((await refused(await member(1n))).refusals).toEqual(['not_exhausted']);
    });

    it('replays a request id: the same row, nothing granted twice, however things stand', async () => {
      await settle();
      const userId = await member();
      const requestId = randomUUID();
      const first = await granted(userId, requestId);
      // Not exhausted any more: a new request is refused, the same one reads its grant back.
      const again = await apply(userId, requestId);
      expect(again).toEqual({ outcome: 'replayed', regrant: first.regrant, replayed: true });
      // Even with the settings undecided again (the replay comes before any condition).
      await unsettle();
      expect(await apply(userId, requestId)).toMatchObject({ outcome: 'replayed' });
      expect((await ledgerOf(t.db, userId)).filter((row) => row.type === 'REGRANT')).toHaveLength(
        1,
      );
      expect((await balanceOf(t.db, userId))!.availableCoin).toBe(600n);
      // A request id is one account's: another account's same id grants its own.
      await settle();
      const other = await member();
      const theirs = await granted(other, requestId);
      expect(theirs.regrant.id).not.toBe(first.regrant.id);
    });

    it('takes only a request id as the header carries it', async () => {
      await settle();
      const userId = await member();
      for (const requestId of [
        '',
        'short',
        ' padded-request-id ',
        'has space in it',
        'é'.repeat(9),
      ]) {
        await expect(apply(userId, requestId), JSON.stringify(requestId)).rejects.toThrow(
          RangeError,
        );
      }
      expect(await regrantsOf(t.db, userId)).toEqual([]);
    });
  });

  describe('refusals', () => {
    it('refuses everything while any setting is undecided (준비 중), with no numbers', async () => {
      const userId = await member();
      expect(await refused(userId)).toEqual({
        open: false,
        eligible: false,
        refusals: ['not_ready'],
        ...closedNumbers,
      });
      // Five of six decided is still not ready (owner answer 12).
      await settle({}, ['thresholdCoin', 'amountCoin', 'waitHours', 'periodDays', 'periodLimit']);
      expect((await refused(userId)).refusals).toEqual(['not_ready']);
      await settle({}, ['totalCapCoin']);
      expect((await apply(userId)).outcome).toBe('granted');
    });

    it('refuses an account whose start grant was not paid: none, waiting, cancelled', async () => {
      await settle();
      const none = (await createUser(t.db)).user.id;
      const waiting = (await createUser(t.db)).user.id;
      await createStartGrant(t.db, { userId: waiting });
      const cancelled = (await createUser(t.db)).user.id;
      await createStartGrant(t.db, { userId: cancelled });
      await t.db.transaction((tx) => cancelStartGrant(tx, cancelled));
      for (const userId of [none, waiting, cancelled]) {
        expect(await refused(userId)).toEqual({
          open: true,
          eligible: false,
          refusals: ['no_start_grant'],
          amountCoin: 500n,
          thresholdCoin: 100n,
          waitHours: 0,
          waitUntil: null,
          periodDays: 30,
          periodLimit: 3,
          periodUsed: 0,
          nextPeriodAt: null,
          totalCapCoin: 10_000n,
          totalGrantedCoin: 0n,
          remainingCapCoin: 10_000n,
        });
      }
      // Undecided too: both reasons that need no value.
      await unsettle();
      expect((await refused(none)).refusals).toEqual(['not_ready', 'no_start_grant']);
    });

    it('refuses with a waiting order, and with a contract of a market not settled', async () => {
      await settle();
      const market = await createMarket(t.db, { status: 'open' });
      const ordering = await member();
      const order = await createOrder(t.db, { marketId: market.id, userId: ordering });
      expect((await refused(ordering)).refusals).toEqual(['live_orders']);
      // A partly filled order still waits; an ended one does not.
      const partly = await member();
      await createOrder(t.db, {
        marketId: market.id,
        userId: partly,
        qty: 2,
        filledQty: 1,
        status: 'partially_filled',
      });
      expect((await refused(partly)).refusals).toEqual(['live_orders']);
      const ended = await member();
      await createOrder(t.db, { marketId: market.id, userId: ended, status: 'cancelled' });
      expect((await apply(ended)).outcome).toBe('granted');

      const holding = await member();
      await createPosition(t.db, { userId: holding, marketId: market.id, outcome: 'YES', qty: 1 });
      expect((await refused(holding)).refusals).toEqual(['unsettled_positions']);
      // Sold out (qty 0) or settled is no holding (owner answer 7).
      const soldOut = await member();
      await createPosition(t.db, { userId: soldOut, marketId: market.id, outcome: 'NO', qty: 0 });
      expect((await apply(soldOut)).outcome).toBe('granted');
      const settled = await member();
      await createPosition(t.db, {
        userId: settled,
        marketId: (await createMarket(t.db, { status: 'settled' })).id,
        outcome: 'YES',
        qty: 0,
        settled: true,
      });
      expect((await apply(settled)).outcome).toBe('granted');
      expect(order.status).toBe('open');
    });

    it('refuses under an account restriction, not under a writing restriction', async () => {
      await settle();
      const approver = (await createUser(t.db, { role: 'admin' })).user.id;
      const restricted = await member();
      await createModerationAction(t.db, {
        userId: restricted,
        createdBy: admin,
        approvedBy: approver,
        type: 'account_restriction',
        reason: 'multi_account',
        endsAt: new Date(Date.now() + DAY_MS),
      });
      expect((await refused(restricted)).refusals).toEqual(['restricted']);
      const writing = await member();
      await createModerationAction(t.db, {
        userId: writing,
        createdBy: admin,
        type: 'writing_restriction',
        endsAt: null,
      });
      expect((await apply(writing)).outcome).toBe('granted');
    });

    it('refuses an admin while it holds the role, and grants once it is revoked', async () => {
      // ADR-0156 (owner answer 2026-11-21): no re-grant while the role is held, as no order.
      await settle();
      const userId = await member();
      const before = randomUUID();
      await granted(userId, before);
      await settle({ thresholdCoin: 10_000 });
      await setRole(userId, 'admin');
      expect(await refused(userId)).toMatchObject({
        open: true,
        eligible: false,
        refusals: ['admin'],
        periodUsed: 1,
        totalGrantedCoin: 500n,
      });
      // A request id granted before the role still answers its re-grant (before any condition).
      expect(await apply(userId, before)).toMatchObject({ outcome: 'replayed', replayed: true });
      // While not ready it is named with the other reasons that need no value.
      await unsettle();
      expect(await refused(userId)).toEqual({
        open: false,
        eligible: false,
        refusals: ['not_ready', 'admin'],
        ...closedNumbers,
      });
      expect(await regrantsOf(t.db, userId)).toHaveLength(1);
      // Revoked: a member again, on the members' terms.
      await settle({ thresholdCoin: 10_000 });
      await setRole(userId, 'user');
      expect(await regrantStatus(t.db, userId)).toMatchObject({ eligible: true, refusals: [] });
      expect((await apply(userId)).outcome).toBe('granted');
      expect(await regrantsOf(t.db, userId)).toHaveLength(2);
    });

    it('refuses an account held for a reconciliation difference (#93), as an order is', async () => {
      await settle();
      const userId = await member();
      const bump = (amount: bigint) =>
        withLedgerGuardsOff((c) =>
          c.query('UPDATE balances SET available_coin = available_coin + $1 WHERE user_id = $2', [
            String(amount),
            userId,
          ]),
        );
      await bump(1n);
      const failed = await t.db.transaction((tx) =>
        runAccountReconciliation(tx, { userId }, { source: 'manual' }),
      );
      expect(failed.hold).not.toBeNull();
      // Back in agreement, but the hold stands until an approved recovery.
      await bump(-1n);
      expect((await refused(userId)).refusals).toEqual(['held']);
    });

    it('counts the wait from the start grant, then from the last re-grant', async () => {
      await settle({ waitHours: 1 });
      const userId = await member();
      const status = await refused(userId);
      expect(status.refusals).toEqual(['waiting']);
      expect(status.waitHours).toBe(1);
      expect(status.waitUntil).toEqual(new Date((await grantedAtOf(userId)).getTime() + HOUR_MS));

      await settle({ waitHours: 0, thresholdCoin: 10_000 });
      const first = await granted(userId);
      await settle({ waitHours: 2, thresholdCoin: 10_000 });
      expect(await refused(userId)).toMatchObject({
        refusals: ['waiting'],
        waitHours: 2,
        waitUntil: new Date(first.regrant.createdAt.getTime() + 2 * HOUR_MS),
      });
    });

    it('allows the period’s limit of re-grants, then says when the oldest frees one', async () => {
      await settle({ thresholdCoin: 10_000, periodLimit: 2, periodDays: 30 });
      const userId = await member();
      const first = await granted(userId);
      await granted(userId);
      expect(await refused(userId)).toMatchObject({
        refusals: ['period_limit'],
        periodLimit: 2,
        periodUsed: 2,
        nextPeriodAt: new Date(first.regrant.createdAt.getTime() + 30 * DAY_MS),
      });
      // The limit lowered to 1 since: the second-oldest has to leave too.
      await settle({ thresholdCoin: 10_000, periodLimit: 1, periodDays: 30 });
      const [newest] = await regrantsOf(t.db, userId);
      expect(await refused(userId)).toMatchObject({
        refusals: ['period_limit'],
        periodUsed: 2,
        nextPeriodAt: new Date(newest!.createdAt.getTime() + 30 * DAY_MS),
      });
      // A longer limit frees it again; nextPeriodAt says nothing while one is free.
      await settle({ thresholdCoin: 10_000, periodLimit: 3, periodDays: 30 });
      expect(await regrantStatus(t.db, userId)).toMatchObject({
        eligible: true,
        periodUsed: 2,
        nextPeriodAt: null,
      });
    });

    it('never grants past the lifetime cap, nor the part that would fit (owner answer 6)', async () => {
      await settle({ thresholdCoin: 10_000, totalCapCoin: 1_200, periodLimit: 10 });
      const userId = await member();
      await granted(userId);
      await granted(userId);
      // 1,000 given, 200 left: a 500 grant is refused whole.
      expect(await refused(userId)).toMatchObject({
        refusals: ['total_cap'],
        totalCapCoin: 1_200n,
        totalGrantedCoin: 1_000n,
        remainingCapCoin: 200n,
      });
      // The cap lowered below what was given: nothing is left, never below 0.
      await settle({ thresholdCoin: 10_000, totalCapCoin: 600, periodLimit: 10 });
      expect(await refused(userId)).toMatchObject({
        refusals: ['total_cap'],
        remainingCapCoin: 0n,
      });
      // Exactly the cap is within it.
      await settle({ thresholdCoin: 10_000, totalCapCoin: 1_500, periodLimit: 10 });
      expect((await apply(userId)).outcome).toBe('granted');
      expect((await refused(userId)).refusals).toEqual(['total_cap']);
    });

    it('names every reason that applies, in REGRANT_REFUSALS’ order', async () => {
      await settle({ thresholdCoin: 10_000, periodLimit: 2, totalCapCoin: 1_000 });
      const userId = await member();
      await granted(userId);
      await granted(userId);
      await settle({ thresholdCoin: 100, periodLimit: 2, totalCapCoin: 1_000, waitHours: 1 });
      const market = await createMarket(t.db, { status: 'open' });
      await createOrder(t.db, { marketId: market.id, userId });
      await createPosition(t.db, { userId, marketId: market.id, outcome: 'YES', qty: 3 });
      await createModerationAction(t.db, {
        userId,
        createdBy: admin,
        approvedBy: (await createUser(t.db, { role: 'admin' })).user.id,
        type: 'account_restriction',
        reason: 'multi_account',
        endsAt: null,
      });
      await withLedgerGuardsOff((c) =>
        c.query('UPDATE balances SET available_coin = available_coin + 1 WHERE user_id = $1', [
          userId,
        ]),
      );
      await t.db.transaction((tx) =>
        runAccountReconciliation(tx, { userId }, { source: 'manual' }),
      );
      // Made an admin after its order (`orders_refuse_admin_owner` refuses one placed after).
      await setRole(userId, 'admin');
      const status = await refused(userId);
      expect(status.refusals).toEqual([
        'restricted',
        'admin',
        'held',
        'not_exhausted',
        'live_orders',
        'unsettled_positions',
        'waiting',
        'period_limit',
        'total_cap',
      ]);
      // The order is REGRANT_REFUSALS' own.
      expect(status.refusals).toEqual(
        REGRANT_REFUSALS.filter((reason) => status.refusals.includes(reason)),
      );
      expect(status).toMatchObject({ open: true, eligible: false, periodUsed: 2 });
    });

    it('refuses the 운영 마켓메이커 (no start grant), and its row at the table (#115)', async () => {
      await settle();
      const marketMaker = await createMarketMakerAccount(t.db);
      expect(await refused(marketMaker)).toMatchObject({
        open: true,
        eligible: false,
        refusals: ['no_start_grant'],
        periodUsed: 0,
        totalGrantedCoin: 0n,
      });
      const anyEntry = (await t.db.select().from(ledgerEntries).limit(1))[0];
      const entryId = anyEntry?.id ?? (await ledgerOf(t.db, await member()))[0]!.id;
      await expect(
        t.db.insert(regrants).values({
          userId: marketMaker,
          requestId: randomUUID(),
          amountCoin: 500n,
          availableBeforeCoin: 0n,
          ledgerEntryId: entryId,
        }),
      ).rejects.toSatisfy(refusedBy('regrants_human_account'));
    });
  });

  describe('reading the status', () => {
    it('takes no lock: it answers while the balance row is held', async () => {
      await settle();
      const userId = await member();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const lockedNow = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = t.db.transaction(async (tx) => {
        await lockLedgerAccounts(tx, [{ kind: 'user', userId }]);
        locked();
        await held;
      });
      await lockedNow;
      expect(await regrantStatus(t.db, userId)).toMatchObject({ eligible: true });
      release();
      await holder;
    });
  });

  describe('two requests at once', () => {
    /** Holds the account's re-grant lock on a client of its own until `free` is called. */
    async function holdRegrantLock(userId: string) {
      const client = new Client({ connectionString: testDbUrls()!.appUrl });
      await client.connect();
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('buddha:regrant'), hashtext($1))", [
        userId,
      ]);
      return {
        client,
        async free() {
          await client.query('COMMIT');
          await client.end();
        },
      };
    }

    async function race(userId: string, ids: [string, string]): Promise<ApplyRegrantOutcome[]> {
      const lock = await holdRegrantLock(userId);
      const both = Promise.all(ids.map((id) => apply(userId, id)));
      await waitForLockWaiter(lock.client, 'both requests wait on the account', 2);
      await lock.free();
      return both;
    }

    it('grants one of two request ids when the first leaves the account not exhausted', async () => {
      await settle();
      const userId = await member();
      const outcomes = await race(userId, [randomUUID(), randomUUID()]);
      expect(outcomes.map((done) => done.outcome).sort()).toEqual(['granted', 'refused']);
      const refusal = outcomes.find((done) => done.outcome === 'refused');
      expect(refusal).toMatchObject({ status: { refusals: ['not_exhausted'], periodUsed: 1 } });
      expect(await regrantsOf(t.db, userId)).toHaveLength(1);
      expect((await balanceOf(t.db, userId))!.availableCoin).toBe(600n);
    });

    it('grants no more than the period allows, however many ids race', async () => {
      await settle({ thresholdCoin: 10_000, periodLimit: 1 });
      const userId = await member();
      const outcomes = await race(userId, [randomUUID(), randomUUID()]);
      expect(outcomes.map((done) => done.outcome).sort()).toEqual(['granted', 'refused']);
      expect(outcomes.find((done) => done.outcome === 'refused')).toMatchObject({
        status: { refusals: ['period_limit'] },
      });
      expect(await regrantsOf(t.db, userId)).toHaveLength(1);
    });

    it('grants one request id once: the twin that waited reads the same row', async () => {
      await settle({ thresholdCoin: 10_000 });
      const userId = await member();
      const requestId = randomUUID();
      const outcomes = await race(userId, [requestId, requestId]);
      expect(outcomes.map((done) => done.outcome).sort()).toEqual(['granted', 'replayed']);
      const [row] = await regrantsOf(t.db, userId);
      for (const done of outcomes) {
        if (done.outcome !== 'refused') expect(done.regrant).toEqual(row);
      }
      expect((await ledgerOf(t.db, userId)).filter((e) => e.type === 'REGRANT')).toHaveLength(1);
      expect((await balanceOf(t.db, userId))!.availableCoin).toBe(600n);
    });
  });

  describe('a role grant at once (ADR-0156)', () => {
    /**
     * A role grant on a client of its own, holding its locks as AdminAccountsService.grant takes
     * them — the admin-roles lock, then the grantee's profile FOR UPDATE NOWAIT — with `admin`
     * written and not yet committed.
     */
    async function grantInFlight(userId: string) {
      const client = new Client({ connectionString: testDbUrls()!.appUrl });
      await client.connect();
      await client.query('BEGIN');
      await client.query("SELECT pg_try_advisory_xact_lock(hashtext('buddha:admin_roles'))");
      await client.query('SELECT 1 FROM profiles WHERE user_id = $1 FOR UPDATE NOWAIT', [userId]);
      await client.query("UPDATE profiles SET role = 'admin' WHERE user_id = $1", [userId]);
      return {
        client,
        async commit() {
          await client.query('COMMIT');
          await client.end();
        },
      };
    }

    it('waits for a grant in flight and refuses with the role it wrote', async () => {
      await settle();
      const userId = await member();
      const grant = await grantInFlight(userId);
      const request = apply(userId);
      await waitForLockWaiter(grant.client, 'the re-grant waits on the profile');
      await grant.commit();
      expect(await request).toMatchObject({ outcome: 'refused', status: { refusals: ['admin'] } });
      expect(await regrantsOf(t.db, userId)).toEqual([]);
      expect((await balanceOf(t.db, userId))!.availableCoin).toBe(100n);
    });

    it('keeps a grant off the profile until a re-grant in flight commits', async () => {
      await settle({ thresholdCoin: 10_000 });
      const userId = await member();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let applied!: () => void;
      const appliedNow = new Promise<void>((resolve) => {
        applied = resolve;
      });
      const request = t.db.transaction(async (tx) => {
        const done = await applyRegrant(tx, { userId, requestId: randomUUID() });
        applied();
        await held;
        return done;
      });
      await appliedNow;
      // The grant's own lock, NOWAIT: refused while the re-grant holds the profile (55P03).
      const client = new Client({ connectionString: testDbUrls()!.appUrl });
      await client.connect();
      try {
        await client.query('BEGIN');
        await expect(
          client.query('SELECT 1 FROM profiles WHERE user_id = $1 FOR UPDATE NOWAIT', [userId]),
        ).rejects.toMatchObject({ code: '55P03' });
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
      release();
      expect((await request).outcome).toBe('granted');
      // Committed: the grant goes through now, after the re-grant, and the next request is refused.
      const grant = await grantInFlight(userId);
      await grant.commit();
      expect((await refused(userId)).refusals).toEqual(['admin']);
      expect(await regrantsOf(t.db, userId)).toHaveLength(1);
    });
  });

  describe('migration 0077', () => {
    it('keeps a re-grant for good: no UPDATE or DELETE, by the app or the owner', async () => {
      await settle();
      const userId = await member();
      const { regrant } = await granted(userId);
      await expect(
        t.db.update(regrants).set({ amountCoin: 1n }).where(eq(regrants.id, regrant.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      await expect(t.db.delete(regrants).where(eq(regrants.id, regrant.id))).rejects.toSatisfy(
        (e) => sqlState(e) === '42501',
      );
      const owner = new Client({ connectionString: testDbUrls()!.migrateUrl });
      await owner.connect();
      try {
        for (const statement of [
          'UPDATE regrants SET amount_coin = 1 WHERE id = $1',
          'DELETE FROM regrants WHERE id = $1',
        ]) {
          await expect(owner.query(statement, [regrant.id]), statement).rejects.toSatisfy(
            refusedBy('regrants_keep_record'),
          );
        }
      } finally {
        await owner.end();
      }
      expect(await regrantsOf(t.db, userId)).toEqual([regrant]);
    });

    it('records a row only with its own REGRANT entry, and an entry only with its row', async () => {
      await settle();
      const userId = await member();
      const { regrant, entry } = await granted(userId);
      const startEntry = (await ledgerOf(t.db, userId))[0]!;
      const row = {
        userId,
        requestId: randomUUID(),
        amountCoin: 500n,
        availableBeforeCoin: 0n,
        ledgerEntryId: startEntry.id,
      };
      // Another type's entry, or this grant's entry claimed by another row.
      await expect(t.db.insert(regrants).values(row)).rejects.toSatisfy(
        refusedBy('regrants_own_entry'),
      );
      await expect(
        t.db
          .insert(regrants)
          .values({ ...row, ledgerEntryId: entry.id, createdAt: entry.createdAt }),
      ).rejects.toSatisfy(refusedBy('regrants_own_entry'));
      // Its own entry with another amount or another instant.
      for (const change of [{ amountCoin: 499n }, { createdAt: new Date() }]) {
        await expect(
          t.db.insert(regrants).values({
            ...row,
            id: regrant.id,
            ledgerEntryId: entry.id,
            createdAt: entry.createdAt,
            ...change,
          }),
        ).rejects.toSatisfy(refusedBy('regrants_own_entry'));
      }
      // Another account's REGRANT entry.
      const other = await member();
      const theirs = await granted(other);
      await expect(
        t.db.insert(regrants).values({
          ...row,
          id: randomUUID(),
          ledgerEntryId: theirs.entry.id,
          createdAt: theirs.entry.createdAt,
        }),
      ).rejects.toSatisfy(refusedBy('regrants_own_entry'));

      // A REGRANT recorded without its row never commits, nor one naming another source.
      const mint = (refType: 'regrant' | 'coupon', type: 'REGRANT' | 'BONUS') =>
        t.db.transaction((tx) => {
          const id = randomUUID();
          return recordLedgerEntry(tx, {
            type,
            amountCoin: 5n,
            from: null,
            to: { kind: 'user', userId },
            refType,
            refId: id,
            idempotencyKey: id,
          });
        });
      await expect(mint('regrant', 'REGRANT')).rejects.toSatisfy(
        refusedBy('ledger_entries_regrant_record'),
      );
      await expect(mint('coupon', 'REGRANT')).rejects.toSatisfy(
        refusedBy('ledger_entries_regrant_record'),
      );
      await expect(mint('regrant', 'BONUS')).rejects.toSatisfy(
        refusedBy('ledger_entries_regrant_record'),
      );
      expect(await regrantsOf(t.db, userId)).toEqual([regrant]);
      expect((await balanceOf(t.db, userId))!.availableCoin).toBe(600n);
    });

    it('refuses a closed account’s re-grant at its row, before the ledger', async () => {
      await settle();
      const userId = await member();
      await closeAccount(t.db, userId);
      // The start grant stays paid and the balance went with the closure: only the row refuses.
      await expect(apply(userId)).rejects.toSatisfy(refusedBy('regrants_open_account'));
      expect(await regrantsOf(t.db, userId)).toEqual([]);
      expect((await ledgerOf(t.db, userId)).map((row) => row.type)).toEqual([
        'START_GRANT',
        'CLOSURE_FORFEIT',
      ]);
    });

    it('fixes the search path of its functions, and appends REGRANT to the enum', async () => {
      const { rows } = await t.db.execute<{ name: string; config: string[] | null }>(sql`
        SELECT proname AS name, proconfig AS config FROM pg_proc
        WHERE proname IN ('regrants_own_entry', 'ledger_entries_regrant_record',
          'regrants_keep_record')
        ORDER BY proname`);
      expect(rows).toEqual(
        ['ledger_entries_regrant_record', 'regrants_keep_record', 'regrants_own_entry'].map(
          (name) => ({ name, config: ['search_path=pg_catalog, public, pg_temp'] }),
        ),
      );
      const { rows: labels } = await t.db.execute<{ label: string }>(sql`
        SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
        WHERE ty.typname = 'ledger_entry_type' ORDER BY e.enumsortorder DESC LIMIT 2`);
      // Appended after the fifteenth; #144's JUDGEMENT_COMPENSATION came after it (migration 0081).
      expect(labels).toEqual([{ label: 'JUDGEMENT_COMPENSATION' }, { label: 'REGRANT' }]);
      const { rows: allowed } = await t.db.execute<{ ok: boolean; other: boolean }>(sql`
        SELECT ledger_entry_direction_allowed('REGRANT', NULL, 'user') AS ok,
          ledger_entry_direction_allowed('REGRANT', 'treasury', 'user') AS other`);
      expect(allowed).toEqual([{ ok: true, other: false }]);
    });
  });

  describe('the admin records', () => {
    it('lists every account’s re-grants newest first, by a cursor, a closed account’s too', async () => {
      await settle({ thresholdCoin: 10_000 });
      const a = await member();
      const b = await member();
      await granted(a);
      await granted(b);
      await granted(a);
      await closeAccount(t.db, a);
      const rows = await t.db.select().from(regrants);
      const expected = [...rows].sort(
        (x, y) =>
          y.createdAt.getTime() - x.createdAt.getTime() || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0),
      );
      const page = await readAdminRegrantPage(t.db);
      expect(page.meta.nextCursor).toBeNull();
      expect(page.data.map((item) => item.id)).toEqual(expected.map((row) => row.id));
      // The closed account's records stay, under its public id with no nickname (#140); the
      // available Coin each found under its lock — 100 at the first, 600 at the second.
      const ofA = page.data.filter((item) => item.account.userId === a);
      expect(ofA.map((item) => [item.amountCoin, item.availableBeforeCoin])).toEqual([
        ['500', '600'],
        ['500', '100'],
      ]);
      expect(ofA[0]!.account.nickname).toBeNull();
      expect(ofA[0]!.account.publicId).toMatch(/^[2-9a-hj-np-z]{10}$/);
      expect(page.data.find((item) => item.account.userId === b)!.account.nickname).toMatch(
        /^user_/,
      );
      // One at a time, by the cursor: the same three, in the same order.
      const seen: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const one = await readAdminRegrantPage(t.db, { limit: 1, ...(cursor ? { cursor } : {}) });
        seen.push(...one.data.map((item) => item.id));
        if (one.meta.nextCursor === null) break;
        cursor = one.meta.nextCursor;
      }
      expect(seen).toEqual(expected.map((row) => row.id));
      // A malformed cursor reads the first page.
      expect((await readAdminRegrantPage(t.db, { cursor: 'nope', limit: 1 })).data[0]!.id).toBe(
        expected[0]!.id,
      );
      expect(
        await t.db
          .select({ n: sql<number>`count(*)::int` })
          .from(regrants)
          .where(and(eq(regrants.userId, a))),
      ).toEqual([{ n: 2 }]);
    });
  });
});
