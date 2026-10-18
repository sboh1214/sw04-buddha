/**
 * `start_grant.pay` (#70, ADR-0071) against the docker `test` database: the start grants that
 * waited while the amount was undecided are paid once an admin enters one, with that value, once
 * each, and a run while it is undecided pays nothing, nor ever pays an account that withdrew while
 * it waited. The grants are recorded the way the API records them (a pending `start_grants` row of
 * an account with its 본인확인 record) and the release setting is changed the way the admin
 * screen changes it (a row and its record). Publishes go to a recording stub. Skips when TEST_* are
 * unset.
 */
import { schema } from '@buddha/db';
import {
  connectTestDb,
  createStartGrant,
  createUser,
  hasTestDb,
  setReleaseSetting,
  type TestDb,
} from '@buddha/db/test';
import {
  START_COIN_SETTING,
  userChannel,
  type MarketRealtimeEvent,
  type ReleaseSettingStatus,
  type UserRealtimeEvent,
} from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Publish } from '../realtime.js';
import { runLedgerAudit } from './ledger-audit.js';
import { payPendingStartGrants } from './start-grant-pay.js';

describe.skipIf(!hasTestDb())('start_grant.pay (integration)', () => {
  let t: TestDb;
  let published: { channel: string; event: MarketRealtimeEvent | UserRealtimeEvent }[];
  let publish: Publish;
  let admin: string;

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    published = [];
    publish = (channel, event) => {
      published.push({ channel, event });
      return Promise.resolve();
    };
    admin = (await createUser(t.db, { role: 'admin' })).user.id;
  });

  const setAmount = (value: number | null, status: ReleaseSettingStatus = 'test') =>
    setReleaseSetting(t.db, {
      adminId: admin,
      key: START_COIN_SETTING.key,
      status: value === null ? 'undecided' : status,
      value,
    });

  /** An account whose grant was recorded while the amount was undecided. */
  async function waiting() {
    const { user } = await createUser(t.db);
    const grant = await createStartGrant(t.db, { userId: user.id });
    return { userId: user.id, grantId: grant.id };
  }

  async function ledgerOf(userId: string) {
    return t.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.userId, userId))
      .orderBy(asc(schema.ledgerEntries.id));
  }

  it('pays nothing while the amount is undecided, and does not even look', async () => {
    const { userId } = await waiting();
    expect(await payPendingStartGrants(t.db, publish)).toEqual({
      undecided: true,
      paid: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    });
    expect(await ledgerOf(userId)).toEqual([]);
    expect(published).toEqual([]);
  });

  it('pays every waiting grant the value an admin set, once, and tells each wallet', async () => {
    const first = await waiting();
    const second = await waiting();
    const { user: paidBefore } = await createUser(t.db);
    await createStartGrant(t.db, { userId: paidBefore.id, amountCoin: 3_000n });
    await setAmount(10_000, 'proposal');

    const outcome = await payPendingStartGrants(t.db, publish);
    expect(outcome).toEqual({ undecided: false, paid: 2, skipped: 0, failed: 0, failures: [] });
    for (const { userId, grantId } of [first, second]) {
      const ledger = await ledgerOf(userId);
      expect(ledger.map((e) => [e.type, e.amountCoin, e.refType, e.refId])).toEqual([
        ['START_GRANT', 10_000n, 'start_grant', grantId],
      ]);
      const [grant] = await t.db
        .select()
        .from(schema.startGrants)
        .where(eq(schema.startGrants.id, grantId));
      expect(grant).toMatchObject({ amountCoin: 10_000n, ledgerEntryId: ledger[0]!.id });
    }
    expect(published).toEqual(
      [first, second].map(({ userId }) => ({
        channel: userChannel(userId),
        event: expect.objectContaining({
          type: 'user:balance',
          availableCoin: '10000',
          lockedCoin: '0',
        }) as unknown,
      })),
    );
    // The account paid before keeps its own amount; the books still balance.
    expect((await ledgerOf(paidBefore.id)).map((e) => e.amountCoin)).toEqual([3_000n]);
    expect((await runLedgerAudit(t.db)).mismatches).toEqual([]);

    // The next run finds nothing to pay.
    expect(await payPendingStartGrants(t.db, publish)).toMatchObject({ paid: 0, failed: 0 });
    expect(published).toHaveLength(2);
  });

  it('pays once when two runs overlap', async () => {
    const grants = [await waiting(), await waiting(), await waiting()];
    await setAmount(10_000);
    const [one, other] = await Promise.all([
      payPendingStartGrants(t.db, publish),
      payPendingStartGrants(t.db, publish),
    ]);
    expect(one.paid + other.paid).toBe(3);
    for (const { userId } of grants) expect(await ledgerOf(userId)).toHaveLength(1);
  });

  it('pays a later value to the grants still waiting, never again to a paid one', async () => {
    const early = await waiting();
    await setAmount(10_000);
    await payPendingStartGrants(t.db, publish);
    await setAmount(null);
    const late = await waiting();
    await setAmount(4_000, 'approved');
    expect(await payPendingStartGrants(t.db, publish)).toMatchObject({ paid: 1 });
    expect((await ledgerOf(early.userId)).map((e) => e.amountCoin)).toEqual([10_000n]);
    expect((await ledgerOf(late.userId)).map((e) => e.amountCoin)).toEqual([4_000n]);
  });

  it('pays no waiting grant whose account withdrew, and is never held up by one', async () => {
    const gone = await waiting();
    const kept = await waiting();
    // What a withdrawal does to the number (#140) while the grant waits: the 본인확인 record goes.
    await t.db
      .delete(schema.phoneVerifications)
      .where(eq(schema.phoneVerifications.userId, gone.userId));
    await setAmount(10_000);

    expect(await payPendingStartGrants(t.db, publish)).toEqual({
      undecided: false,
      paid: 1,
      skipped: 0,
      failed: 0,
      failures: [],
    });
    expect(await ledgerOf(gone.userId)).toEqual([]);
    expect((await ledgerOf(kept.userId)).map((e) => e.amountCoin)).toEqual([10_000n]);
    expect(published.map((p) => p.channel)).toEqual([userChannel(kept.userId)]);
    // Left pending: the record of its number, nothing paid (ADR-0071 7-11).
    const [left] = await t.db
      .select()
      .from(schema.startGrants)
      .where(eq(schema.startGrants.id, gone.grantId));
    expect(left).toMatchObject({ amountCoin: null, ledgerEntryId: null, grantedAt: null });

    // The oldest waiting row, for good — yet a run of one still reaches a later grant.
    const later = await waiting();
    expect(await payPendingStartGrants(t.db, publish, 1)).toMatchObject({ paid: 1, skipped: 0 });
    expect(await ledgerOf(later.userId)).toHaveLength(1);
    expect(await ledgerOf(gone.userId)).toEqual([]);
  });

  it('goes on past a grant it cannot pay, and pays at most a batch per run', async () => {
    const broken = await waiting();
    // A broken account: no balance row (a fault for the ledger audit to report).
    await t.db.delete(schema.balances).where(eq(schema.balances.userId, broken.userId));
    const healthy = [await waiting(), await waiting(), await waiting()];
    await setAmount(10_000);

    const first = await payPendingStartGrants(t.db, publish, 2);
    expect(first).toMatchObject({
      paid: 1,
      failed: 1,
      failures: [
        {
          grantId: broken.grantId,
          message: expect.stringMatching(/no balance row/) as string,
        },
      ],
    });
    // The failed grant stays waiting, first in line; the rest are paid over the next runs.
    const second = await payPendingStartGrants(t.db, publish, 10);
    expect(second).toMatchObject({ paid: 2, failed: 1 });
    for (const { userId } of healthy) expect(await ledgerOf(userId)).toHaveLength(1);
    expect(await ledgerOf(broken.userId)).toEqual([]);
  });
});
