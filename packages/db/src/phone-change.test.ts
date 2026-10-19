/**
 * An operator's change of a member's number (ADR-0069 #57-3, owner decision 2026-10-18, ADR-0071):
 * the SQL docs/OPERATIONS.md gives, verbatim, and what it does when run as buddha_app — the role
 * the doc runs it as — with psql's variables written in. The keyed hash of the new number comes
 * from the API's phone-hash CLI there; here any 64-hex value stands for it (this package has no
 * key). Skips the database part when TEST_* are unset.
 */
import { readFileSync } from 'node:fs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OPERATOR_PHONE_CHANGE_SQL } from './phone-change.js';
import { phoneVerifications, startGrantNumbers } from './schema/index.js';
import { cancelStartGrant, recordStartGrant } from './start-grants.js';
import {
  createPhoneVerification,
  createStartGrant,
  createUser,
  randomPhone,
  randomPhoneHash,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';

const OPERATIONS = readFileSync(new URL('../../../docs/OPERATIONS.md', import.meta.url), 'utf8');

describe('the operator phone change (docs/OPERATIONS.md)', () => {
  it('is the SQL the operations doc gives, verbatim', () => {
    expect(OPERATIONS).toContain(['```sql', 'BEGIN;', OPERATOR_PHONE_CHANGE_SQL].join('\n'));
  });

  it('names its three psql variables and nothing else', () => {
    const names = new Set([...OPERATOR_PHONE_CHANGE_SQL.matchAll(/:'(\w+)'/g)].map((m) => m[1]));
    expect([...names].sort()).toEqual(['new_hash', 'new_phone', 'user_id']);
  });
});

describe.skipIf(!hasTestDb())('the operator phone change (integration)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
  });

  interface Held {
    this_account: boolean;
    source: string;
    paid: boolean;
    has_grant: boolean;
  }

  /**
   * Runs the doc's SQL in one transaction, as the operator does between BEGIN and COMMIT, with
   * psql's `:'name'` written in as literals (the values here are the test's own), and returns
   * what psql would show: the two row counts and the final query's rows.
   */
  async function change(vars: { user_id: string; new_phone: string; new_hash: string }) {
    const text = OPERATOR_PHONE_CHANGE_SQL.replace(/:'(\w+)'/g, (_, name: keyof typeof vars) => {
      return `'${vars[name].replaceAll("'", "''")}'`;
    });
    const statements = text
      .split(/;\n/)
      .map((statement) => statement.replace(/;$/, '').trim())
      .filter(Boolean);
    expect(statements).toHaveLength(3);
    return t.db.transaction(async (tx) => {
      const [update, insert, held] = [
        await tx.execute(sql.raw(statements[0]!)),
        await tx.execute(sql.raw(statements[1]!)),
        await tx.execute<Record<string, unknown>>(sql.raw(statements[2]!)),
      ];
      return {
        updated: update.rowCount,
        inserted: insert.rowCount,
        held: held.rows as unknown as Held[],
      };
    });
  }

  async function phoneOf(userId: string) {
    const [row] = await t.db
      .select({ phone: phoneVerifications.phone })
      .from(phoneVerifications)
      .where(eq(phoneVerifications.userId, userId));
    return row?.phone;
  }

  /** A later account verifying a number: what recording its grant answers. */
  async function laterAccountOn(phoneHash: string) {
    const { user } = await createUser(t.db);
    await createPhoneVerification(t.db, { userId: user.id });
    return t.db.transaction((tx) => recordStartGrant(tx, user.id, phoneHash));
  }

  /** The live rows holding a number: which grant holds it now, if any. */
  async function liveHolders(phoneHash: string) {
    return t.db
      .select({ grantId: startGrantNumbers.grantId })
      .from(startGrantNumbers)
      .where(and(eq(startGrantNumbers.phoneHash, phoneHash), isNull(startGrantNumbers.releasedAt)));
  }

  /** What a withdrawal does to the start Coin and the number (#140): cancel, delete the record. */
  async function withdraw(userId: string) {
    return t.db.transaction(async (tx) => {
      const cancelled = await cancelStartGrant(tx, userId);
      await tx.delete(phoneVerifications).where(eq(phoneVerifications.userId, userId));
      return cancelled;
    });
  }

  it('changes the number of an account that got its start Coin and records the new one too', async () => {
    const { user } = await createUser(t.db);
    const oldHash = randomPhoneHash();
    const grant = await createStartGrant(t.db, {
      userId: user.id,
      phoneHash: oldHash,
      amountCoin: 100n,
    });
    const newPhone = randomPhone();
    const newHash = randomPhoneHash();
    expect(await change({ user_id: user.id, new_phone: newPhone, new_hash: newHash })).toEqual({
      updated: 1,
      inserted: 1,
      held: [{ this_account: true, source: 'operator', paid: true, has_grant: true }],
    });
    expect(await phoneOf(user.id)).toBe(newPhone);
    const numbers = await t.db
      .select()
      .from(startGrantNumbers)
      .where(eq(startGrantNumbers.grantId, grant.id));
    expect(numbers.map((n) => [n.phoneHash, n.source]).sort()).toEqual(
      [
        [oldHash, 'grant'],
        [newHash, 'operator'],
      ].sort(),
    );
    // Neither number gets the start Coin again on a later account.
    expect(await laterAccountOn(newHash)).toEqual({ outcome: 'number_already_used' });
    expect(await laterAccountOn(oldHash)).toEqual({ outcome: 'number_already_used' });
    // Run twice (a retried session): nothing more is recorded.
    expect(
      await change({ user_id: user.id, new_phone: newPhone, new_hash: newHash }),
    ).toMatchObject({ updated: 1, inserted: 0 });
  });

  it('records the new number beside a waiting grant, freed with it if the account withdraws', async () => {
    const { user } = await createUser(t.db);
    const oldHash = randomPhoneHash();
    await createStartGrant(t.db, { userId: user.id, phoneHash: oldHash });
    const newHash = randomPhoneHash();
    expect(await change({ user_id: user.id, new_phone: randomPhone(), new_hash: newHash })).toEqual(
      {
        updated: 1,
        inserted: 1,
        held: [{ this_account: true, source: 'operator', paid: false, has_grant: true }],
      },
    );
    await t.db.transaction((tx) => cancelStartGrant(tx, user.id));
    expect((await laterAccountOn(newHash)).outcome).toBe('recorded');
    expect((await laterAccountOn(oldHash)).outcome).toBe('recorded');
  });

  it('records nothing for an account with no grant yet: its grant records the new number', async () => {
    const { user } = await createUser(t.db);
    await createPhoneVerification(t.db, { userId: user.id });
    const newPhone = randomPhone();
    const newHash = randomPhoneHash();
    expect(await change({ user_id: user.id, new_phone: newPhone, new_hash: newHash })).toEqual({
      updated: 1,
      inserted: 0,
      held: [],
    });
    expect(await phoneOf(user.id)).toBe(newPhone);
    const recorded = await t.db.transaction((tx) => recordStartGrant(tx, user.id, newHash));
    expect(recorded.outcome).toBe('recorded');
  });

  it('leaves a number that counts for another grant as it is', async () => {
    // The new number got the start Coin with an account that has since withdrawn.
    const { user: earlier } = await createUser(t.db);
    const takenHash = randomPhoneHash();
    await createStartGrant(t.db, { userId: earlier.id, phoneHash: takenHash, amountCoin: 100n });
    await t.db.delete(phoneVerifications).where(eq(phoneVerifications.userId, earlier.id));
    const { user } = await createUser(t.db);
    await createStartGrant(t.db, { userId: user.id, amountCoin: 100n });
    expect(
      await change({ user_id: user.id, new_phone: randomPhone(), new_hash: takenHash }),
    ).toEqual({
      updated: 1,
      inserted: 0,
      held: [{ this_account: false, source: 'grant', paid: true, has_grant: true }],
    });
  });

  it('records nothing for a number another account’s waiting grant holds, which its cancellation frees', async () => {
    // Y's grant waits, holding N; an operator moves Y off N (N stays Y's grant's number, answer 3).
    const { user: y } = await createUser(t.db);
    const n = randomPhoneHash();
    const yGrant = await createStartGrant(t.db, { userId: y.id, phoneHash: n });
    const yOldPhone = await phoneOf(y.id);
    expect(
      await change({ user_id: y.id, new_phone: randomPhone(), new_hash: randomPhoneHash() }),
    ).toMatchObject({ updated: 1, inserted: 1 });
    // An operator then moves X, who has a grant, onto N: nothing is recorded for X — the row the
    // doc's table says not to COMMIT before the owner answers (ADR-0071 결과 4).
    const { user: x } = await createUser(t.db);
    const xGrant = await createStartGrant(t.db, { userId: x.id, amountCoin: 100n });
    expect(await change({ user_id: x.id, new_phone: yOldPhone!, new_hash: n })).toEqual({
      updated: 1,
      inserted: 0,
      held: [{ this_account: false, source: 'grant', paid: false, has_grant: true }],
    });
    expect(await liveHolders(n)).toEqual([{ grantId: yGrant.id }]);
    const xNumbers = await t.db
      .select({ phoneHash: startGrantNumbers.phoneHash })
      .from(startGrantNumbers)
      .where(eq(startGrantNumbers.grantId, xGrant.id));
    expect(xNumbers.map((row) => row.phoneHash)).not.toContain(n);
    // Y withdraws while its grant waits (answer 2): the cancellation frees N, and X's grant holds
    // it nowhere — so, X gone too, the next account on N is recorded and would be paid. This pins
    // today's behaviour; whether it should stay is the owner's question.
    expect((await withdraw(y.id)).outcome).toBe('cancelled');
    expect(await liveHolders(n)).toEqual([]);
    expect((await withdraw(x.id)).outcome).toBe('granted');
    expect((await laterAccountOn(n)).outcome).toBe('recorded');
  });

  it('tells an account with no grant moved onto a number another grant holds: it will get none', async () => {
    const { user: earlier } = await createUser(t.db);
    const takenHash = randomPhoneHash();
    await createStartGrant(t.db, { userId: earlier.id, phoneHash: takenHash, amountCoin: 100n });
    await t.db.delete(phoneVerifications).where(eq(phoneVerifications.userId, earlier.id));
    // Verified, not onboarded yet: no grant record.
    const { user } = await createUser(t.db);
    await createPhoneVerification(t.db, { userId: user.id });
    expect(
      await change({ user_id: user.id, new_phone: randomPhone(), new_hash: takenHash }),
    ).toEqual({
      updated: 1,
      inserted: 0,
      held: [{ this_account: false, source: 'grant', paid: true, has_grant: false }],
    });
    // Its grant (#58) on the new number records nothing.
    const recorded = await t.db.transaction((tx) => recordStartGrant(tx, user.id, takenHash));
    expect(recorded).toEqual({ outcome: 'number_already_used' });
  });

  it('changes nothing for an unknown account, and refuses a number another account verified', async () => {
    expect(
      await change({
        user_id: 'no-such-account',
        new_phone: randomPhone(),
        new_hash: randomPhoneHash(),
      }),
    ).toEqual({ updated: 0, inserted: 0, held: [] });
    const { user: a } = await createUser(t.db);
    const { user: b } = await createUser(t.db);
    const verified = await createPhoneVerification(t.db, { userId: a.id });
    await createStartGrant(t.db, { userId: b.id });
    await expect(
      change({ user_id: b.id, new_phone: verified.phone, new_hash: randomPhoneHash() }),
    ).rejects.toSatisfy((e) => {
      const error = e as { code?: string; cause?: { code?: string } };
      return (error.cause?.code ?? error.code) === '23505';
    });
  });
});
