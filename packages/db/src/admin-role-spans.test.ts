import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminSpansCte, wasAdminAtSql } from './admin-role-spans.js';
import { createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { createAdminAt, grantAdminAt, revokeAdminAt } from './test/observation.js';
import { clockTimestamp } from './tx-helpers.js';

const HOUR_MS = 60 * 60 * 1_000;

describe.skipIf(!hasTestDb())('admin spans from the role-change records (#96, ADR-0169)', () => {
  let t: TestDb;
  let now: Date;
  const at = (ms: number) => new Date(now.getTime() + ms);

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    now = await clockTimestamp(t.db);
  });

  /** Whether the records say `userId` was admin at `instant`. */
  async function wasAdmin(userId: string, instant: Date): Promise<boolean> {
    const { rows } = await t.db.execute<{ admin: boolean }>(sql`WITH ${adminSpansCte()}
      SELECT ${wasAdminAtSql(
        sql`${userId}::text`,
        sql`${instant.toISOString()}::timestamptz`,
      )} AS admin`);
    return rows[0]!.admin;
  }
  const member = async () => (await createUser(t.db)).user.id;

  it('is admin from the grant instant on, not a millisecond before', async () => {
    const id = await member();
    await grantAdminAt(t.db, id, at(HOUR_MS));
    expect(await wasAdmin(id, at(HOUR_MS - 1))).toBe(false);
    expect(await wasAdmin(id, at(HOUR_MS))).toBe(true);
    expect(await wasAdmin(id, at(1_000 * HOUR_MS))).toBe(true);
  });

  it('is admin up to the revoke, not at its instant', async () => {
    const id = await member();
    await grantAdminAt(t.db, id, at(HOUR_MS));
    await revokeAdminAt(t.db, id, at(2 * HOUR_MS));
    expect(await wasAdmin(id, at(2 * HOUR_MS - 1))).toBe(true);
    expect(await wasAdmin(id, at(2 * HOUR_MS))).toBe(false);
    expect(await wasAdmin(id, at(3 * HOUR_MS))).toBe(false);
  });

  it('reads grant, revoke, grant as two spans', async () => {
    const id = await member();
    await grantAdminAt(t.db, id, at(HOUR_MS));
    await revokeAdminAt(t.db, id, at(2 * HOUR_MS));
    await grantAdminAt(t.db, id, at(3 * HOUR_MS));
    const points = [0.5, 1, 1.5, 2, 2.5, 3, 4].map((hours) => at(hours * HOUR_MS));
    const admin = await Promise.all(points.map((point) => wasAdmin(id, point)));
    expect(admin).toEqual([false, true, true, false, false, true, true]);
  });

  it('reads only the records: an admin by role with no record was never admin (96-10)', async () => {
    const id = (await createUser(t.db, { role: 'admin' })).user.id;
    expect(await wasAdmin(id, at(-HOUR_MS))).toBe(false);
    expect(await wasAdmin(id, at(HOUR_MS))).toBe(false);
  });

  it('reads an account whose first record is a revoke as not admin before it', async () => {
    const id = await member();
    await revokeAdminAt(t.db, id, at(HOUR_MS));
    expect(await wasAdmin(id, at(HOUR_MS - 1))).toBe(false);
    expect(await wasAdmin(id, at(HOUR_MS))).toBe(false);
  });

  it('keeps each account its own spans', async () => {
    const one = await member();
    const other = await member();
    await grantAdminAt(t.db, one, at(HOUR_MS));
    await grantAdminAt(t.db, other, at(2 * HOUR_MS));
    await revokeAdminAt(t.db, one, at(3 * HOUR_MS));
    expect(await wasAdmin(other, at(3 * HOUR_MS + 1))).toBe(true);
    expect(await wasAdmin(one, at(3 * HOUR_MS + 1))).toBe(false);
    expect(await wasAdmin(other, at(2 * HOUR_MS - 1))).toBe(false);
  });

  it('refuses a role change not later than the last one (test helper)', async () => {
    const id = await createAdminAt(t.db, { at: at(HOUR_MS) });
    await expect(revokeAdminAt(t.db, id, at(HOUR_MS))).rejects.toThrow('not later');
    await expect(grantAdminAt(t.db, await member(), at(HOUR_MS - 1))).rejects.toThrow('not later');
    await revokeAdminAt(t.db, id, at(HOUR_MS + 1));
    expect(await wasAdmin(id, at(HOUR_MS))).toBe(true);
  });
});
