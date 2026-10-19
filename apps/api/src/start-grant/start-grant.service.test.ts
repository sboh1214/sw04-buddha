/**
 * 시작 지급 (#70, ADR-0071) against the docker `test` profile: the start Coin once per verified
 * number, with the amount of the release setting `grant.start_coin`, waiting while it is undecided,
 * never again for a number whose first account got it or still waits for it, and from no route. A
 * waiting grant cancelled by its account's withdrawal frees the number, and a number an operator
 * recorded counts too (owner decisions 2026-10-18). The service is called as the onboarding (#58)
 * will call it, a withdrawal as #140 will take it (`cancelStartGrant` and the 본인확인 record
 * deleted, in one transaction); the worker's payment of waiting grants has its own suite
 * (apps/worker start-grant-pay.test.ts). Skips when TEST_* are unset.
 */
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import { cancelStartGrant, schema } from '@buddha/db';
import { createPhoneVerification, createUser } from '@buddha/db/test';
import {
  START_COIN_SETTING,
  meSchema,
  userChannel,
  type ReleaseSettingStatus,
} from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PhoneHasher } from '../identity/phone-hash.js';
import { ReleaseSettingsService } from '../release-settings/release-settings.service.js';
import { expectLedgerChain } from '../test/ledger.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { discoverRoutes } from '../test/routes.js';
import { hasTestInfra } from '../test/setup-env.js';
import { sleep } from '../test/wait.js';
import { StartGrantModule } from './start-grant.module.js';
import { StartGrantService } from './start-grant.service.js';

describe('the start grant has no route (#70)', () => {
  it('declares no controller, and no route of the app names it', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, StartGrantModule) ?? []).toEqual([]);
    expect(
      discoverRoutes()
        .map((route) => route.key)
        .filter((key) => /start|grant/i.test(key)),
    ).toEqual([]);
  });
});

describe.skipIf(!hasTestInfra)('StartGrantService (integration)', () => {
  let t: TestApp;
  let grants: StartGrantService;
  let operator: string;

  beforeAll(async () => {
    t = await createTestApp();
    grants = t.app.get(StartGrantService);
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    // The admin whose changes of the release setting are recorded (release_settings.updated_by).
    operator = (await createUser(t.db, { role: 'admin' })).user.id;
  });

  /** The release setting `grant.start_coin`, changed as an admin does it, with a reason. */
  async function setAmount(value: number | null, status: ReleaseSettingStatus = 'test') {
    await t.app
      .get(ReleaseSettingsService)
      .change(
        operator,
        START_COIN_SETTING.key,
        value === null
          ? { status: 'undecided', reason: '미정으로 되돌림' }
          : { status, value, reason: '시험' },
      );
  }

  /** A signed-up account with a verified number (#183's record). */
  async function verified(phone?: string): Promise<TestUser> {
    const user = await signUpTestUser(t);
    await createPhoneVerification(t.db, { userId: user.id, ...(phone ? { phone } : {}) });
    return user;
  }

  async function ledgerOf(userId: string) {
    return t.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.userId, userId))
      .orderBy(asc(schema.ledgerEntries.id));
  }

  async function balanceOf(userId: string) {
    const [row] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, userId));
    return row!.availableCoin;
  }

  /**
   * What a withdrawal does for the start Coin and the number (#140, owner decision 2026-10-18):
   * the waiting grant cancelled and the 본인확인 record deleted, in one transaction.
   */
  async function withdraw(userId: string) {
    return t.db.transaction(async (tx) => {
      const cancelled = await cancelStartGrant(tx, userId);
      await tx
        .delete(schema.phoneVerifications)
        .where(eq(schema.phoneVerifications.userId, userId));
      return cancelled;
    });
  }

  async function numbersOf(userId: string) {
    return t.db
      .select({
        phoneHash: schema.startGrantNumbers.phoneHash,
        source: schema.startGrantNumbers.source,
        releasedAt: schema.startGrantNumbers.releasedAt,
      })
      .from(schema.startGrantNumbers)
      .innerJoin(schema.startGrants, eq(schema.startGrants.id, schema.startGrantNumbers.grantId))
      .where(eq(schema.startGrants.userId, userId))
      .orderBy(asc(schema.startGrantNumbers.createdAt));
  }

  async function startGrantOnMe(user: TestUser) {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    return meSchema.parse(res.json<{ data: unknown }>().data).startGrant;
  }

  it('refuses an account with no 본인확인, recording nothing', async () => {
    await setAmount(10_000);
    const user = await signUpTestUser(t);
    await expect(grants.grant(user.id)).rejects.toMatchObject({ code: 'VERIFICATION_REQUIRED' });
    expect(await t.db.select().from(schema.startGrants)).toEqual([]);
    expect(await ledgerOf(user.id)).toEqual([]);
    expect(await balanceOf(user.id)).toBe(0n);
  });

  it('grants the set amount once: the balance, one START_GRANT entry, the record and the event', async () => {
    await setAmount(10_000);
    const user = await verified('01011112222');
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    subscriber.on('message', (_channel: string, message: string) => received.push(message));
    await subscriber.subscribe(userChannel(user.id));
    let result: Awaited<ReturnType<StartGrantService['grant']>>;
    try {
      result = await grants.grant(user.id);
      const started = Date.now();
      while (received.length < 1 && Date.now() - started < 5_000) await sleep(20);
    } finally {
      await subscriber.quit();
    }

    const ledger = await ledgerOf(user.id);
    expect(ledger).toHaveLength(1);
    const [record] = await t.db.select().from(schema.startGrants);
    expect(ledger[0]).toMatchObject({
      type: 'START_GRANT',
      amountCoin: 10_000n,
      balanceAfterCoin: 10_000n,
      refType: 'start_grant',
      refId: record!.id,
    });
    expectLedgerChain(ledger, 10_000n);
    expect(record).toMatchObject({
      userId: user.id,
      amountCoin: 10_000n,
      ledgerEntryId: ledger[0]!.id,
      grantedAt: ledger[0]!.createdAt,
      cancelledAt: null,
    });
    // The record of its number holds the keyed hash of the number, never the number.
    const numbers = await numbersOf(user.id);
    expect(numbers).toEqual([
      {
        phoneHash: t.app.get(PhoneHasher).hash('01011112222'),
        source: 'grant',
        releasedAt: null,
      },
    ]);
    const stored = [...Object.values(record!), ...numbers.flatMap((n) => Object.values(n))];
    expect(stored.map(String).join(' ')).not.toContain('01011112222');
    const startGrant = {
      status: 'granted',
      amountCoin: '10000',
      grantedAt: ledger[0]!.createdAt.toISOString(),
    };
    expect(result).toEqual({ outcome: 'granted', startGrant });
    expect(await startGrantOnMe(user)).toEqual(startGrant);
    // The wallet hears about it without a reload (PLAN 8).
    expect(received.map((message) => JSON.parse(message) as unknown)).toEqual([
      {
        type: 'user:balance',
        availableCoin: '10000',
        lockedCoin: '0',
        ledgerEntryId: ledger[0]!.id.toString(),
        ts: ledger[0]!.createdAt.toISOString(),
      },
    ]);

    // Asked again: already granted, nothing written.
    expect(await grants.grant(user.id)).toEqual({ outcome: 'already_granted', startGrant });
    expect(await ledgerOf(user.id)).toHaveLength(1);
  });

  it('grants once when calls for one account come at the same time', async () => {
    await setAmount(10_000);
    const user = await verified();
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => grants.grant(user.id)));
    expect(outcomes.map((result) => result.outcome).sort()).toEqual([
      'already_granted',
      'already_granted',
      'already_granted',
      'already_granted',
      'already_granted',
      'granted',
    ]);
    expect((await ledgerOf(user.id)).map((entry) => entry.type)).toEqual(['START_GRANT']);
    expect(await balanceOf(user.id)).toBe(10_000n);
    expect(await t.db.select().from(schema.startGrants)).toHaveLength(1);
    expect(await t.db.select().from(schema.startGrantNumbers)).toHaveLength(1);
  });

  it('waits while the amount is undecided, then pays the value an admin sets', async () => {
    const user = await verified();
    const pending = { status: 'pending', amountCoin: null, grantedAt: null } as const;
    expect(await grants.grant(user.id)).toEqual({ outcome: 'pending', startGrant: pending });
    expect(await ledgerOf(user.id)).toEqual([]);
    expect(await balanceOf(user.id)).toBe(0n);
    // The wallet shows it is waiting.
    expect(await startGrantOnMe(user)).toEqual(pending);
    // Asked again while still undecided: still waiting, still one record.
    expect((await grants.grant(user.id)).outcome).toBe('pending');
    expect(await t.db.select().from(schema.startGrants)).toHaveLength(1);

    await setAmount(7_000);
    const paid = await grants.grant(user.id);
    expect(paid).toMatchObject({ outcome: 'granted', startGrant: { amountCoin: '7000' } });
    expect(await balanceOf(user.id)).toBe(7_000n);
    expect((await startGrantOnMe(user))?.status).toBe('granted');
  });

  it('pays a value whatever its status: a proposal, a test value or an approved one', async () => {
    for (const [status, value] of [
      ['proposal', 1_000],
      ['test', 2_000],
      ['approved', 3_000],
    ] as const) {
      await setAmount(value, status);
      const user = await verified();
      expect(await grants.grant(user.id), status).toMatchObject({
        outcome: 'granted',
        startGrant: { amountCoin: String(value) },
      });
    }
  });

  it('applies a changed amount to the grants paid after it only', async () => {
    await setAmount(10_000);
    const first = await verified();
    await grants.grant(first.id);
    await setAmount(5_000);
    const second = await verified();
    expect(await grants.grant(second.id)).toMatchObject({ startGrant: { amountCoin: '5000' } });
    // The first account keeps what it got, asked again or not.
    expect(await grants.grant(first.id)).toMatchObject({
      outcome: 'already_granted',
      startGrant: { amountCoin: '10000' },
    });
    expect(await balanceOf(first.id)).toBe(10_000n);
    expect(await balanceOf(second.id)).toBe(5_000n);
  });

  it('never grants a number again: a new account on the number of one that withdrew gets nothing', async () => {
    await setAmount(10_000);
    const phone = '01033334444';
    const first = await verified(phone);
    await grants.grant(first.id);
    // The withdrawal (#140): a paid grant is not cancelled, and the record of its number stays.
    expect((await withdraw(first.id)).outcome).toBe('granted');
    const again = await verified(phone);
    expect(await grants.grant(again.id)).toEqual({ outcome: 'number_already_used' });
    expect(await ledgerOf(again.id)).toEqual([]);
    expect(await balanceOf(again.id)).toBe(0n);
    expect(await startGrantOnMe(again)).toBeNull();
    const records = await t.db.select().from(schema.startGrants);
    expect(records.map((record) => record.userId)).toEqual([first.id]);
  });

  it('cancels a waiting grant when its account withdraws: the next account on the number gets the start Coin', async () => {
    const phone = '01055556666';
    const first = await verified(phone);
    expect((await grants.grant(first.id)).outcome).toBe('pending');
    // The withdrawal while it waits: cancelled, its number free again (owner decision 2026-10-18).
    const cancelled = await withdraw(first.id);
    expect(cancelled.outcome).toBe('cancelled');
    expect((await numbersOf(first.id)).map((n) => n.releasedAt)).toEqual([
      cancelled.outcome === 'cancelled' ? cancelled.grant.cancelledAt : 'not cancelled',
    ]);
    const again = await verified(phone);
    expect((await grants.grant(again.id)).outcome).toBe('pending');
    await setAmount(10_000);
    expect(await grants.grant(again.id)).toMatchObject({
      outcome: 'granted',
      startGrant: { amountCoin: '10000' },
    });
    expect(await balanceOf(again.id)).toBe(10_000n);
    // The cancelled grant is never paid, by the API or otherwise, and stays as history.
    expect(await ledgerOf(first.id)).toEqual([]);
    expect(await balanceOf(first.id)).toBe(0n);
    const [kept] = await t.db
      .select()
      .from(schema.startGrants)
      .where(eq(schema.startGrants.userId, first.id));
    expect(kept).toMatchObject({ grantedAt: null, cancelledAt: expect.any(Date) as Date });
  });

  it('counts a waiting grant as the number’s while it is not cancelled', async () => {
    const phone = '01077778888';
    const first = await verified(phone);
    expect((await grants.grant(first.id)).outcome).toBe('pending');
    // The 본인확인 record gone with no cancellation (by hand, not a withdrawal): still held.
    await t.db
      .delete(schema.phoneVerifications)
      .where(eq(schema.phoneVerifications.userId, first.id));
    const again = await verified(phone);
    await setAmount(10_000);
    expect(await grants.grant(again.id)).toEqual({ outcome: 'number_already_used' });
    expect(await balanceOf(again.id)).toBe(0n);
  });

  it('counts a number an operator recorded for the account: a later account on it gets nothing', async () => {
    await setAmount(10_000);
    const first = await verified('01012121212');
    await grants.grant(first.id);
    // The operator's change of the number (docs/OPERATIONS.md): the number, and its record beside
    // the grant (the SQL itself is pinned by @buddha/db phone-change.test.ts).
    const newPhone = '01034343434';
    const [grant] = await t.db
      .select()
      .from(schema.startGrants)
      .where(eq(schema.startGrants.userId, first.id));
    await t.db.transaction(async (tx) => {
      await tx
        .update(schema.phoneVerifications)
        .set({ phone: newPhone })
        .where(eq(schema.phoneVerifications.userId, first.id));
      await tx.insert(schema.startGrantNumbers).values({
        grantId: grant!.id,
        phoneHash: t.app.get(PhoneHasher).hash(newPhone),
        source: 'operator',
      });
    });
    // Asked again with the new number: the account's one grant, paid already.
    expect((await grants.grant(first.id)).outcome).toBe('already_granted');
    expect((await numbersOf(first.id)).map((n) => n.source)).toEqual(['grant', 'operator']);
    await withdraw(first.id);
    for (const phone of ['01012121212', newPhone]) {
      const later = await verified(phone);
      expect(await grants.grant(later.id), phone).toEqual({ outcome: 'number_already_used' });
    }
    expect(await t.db.select().from(schema.startGrants)).toHaveLength(1);
  });

  it('gives an account whose grant was cancelled nothing more, and shows it no grant', async () => {
    const user = await verified('01056565656');
    expect((await grants.grant(user.id)).outcome).toBe('pending');
    await withdraw(user.id);
    // Only by hand could the account have a 본인확인 record again (a withdrawal deleted it).
    await createPhoneVerification(t.db, { userId: user.id, phone: '01056565656' });
    await setAmount(10_000);
    expect(await grants.grant(user.id)).toEqual({ outcome: 'cancelled' });
    expect(await balanceOf(user.id)).toBe(0n);
    expect(await startGrantOnMe(user)).toBeNull();
  });

  it('grants an operator account under the same conditions as any account', async () => {
    await setAmount(10_000);
    const admin = await verified();
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, admin.id));
    expect((await grants.grant(admin.id)).outcome).toBe('granted');
    expect(await balanceOf(admin.id)).toBe(10_000n);
  });

  it('is not trading profit: no position or PnL moves with it (N02 §8)', async () => {
    await setAmount(10_000);
    const user = await verified();
    await grants.grant(user.id);
    expect(
      await t.db.select().from(schema.positions).where(eq(schema.positions.userId, user.id)),
    ).toEqual([]);
  });
});
