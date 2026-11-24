import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordMarketVisit } from './market-visits.js';
import { marketVisitCollection, marketVisits } from './schema/index.js';
import {
  closeAccount,
  createMarket,
  createMarketMakerAccount,
  createModerationAction,
  createUser,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { grantAdminAt, revokeAdminAt } from './test/observation.js';
import { readVisits } from './test/visits.js';
import { clockTimestamp } from './tx-helpers.js';

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
const denied = (error: unknown) => sqlState(error) === '42501';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

describe.skipIf(!hasTestDb())('recordMarketVisit (#151, ADR-0170; integration)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const member = async () => (await createUser(t.db)).user.id;
  const publicMarket = async () => (await createMarket(t.db)).id;
  /** The database clock's Korean date, as the column default takes it. */
  async function today(): Promise<string> {
    const { rows } = await t.db.execute<{ date: string }>(
      sql`SELECT to_char((now() AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AS date`,
    );
    return rows[0]!.date;
  }
  /** buddha_app's own raw insert of a visit's two columns. */
  const rawInsert = (userId: string, marketId: string) =>
    t.db.execute(
      sql`INSERT INTO market_visits (user_id, market_id) VALUES (${userId}, ${marketId})`,
    );

  it('records one row per account, market and Korean date of the database clock (151-3, 95-4)', async () => {
    const id = await member();
    const market = await publicMarket();
    const other = await publicMarket();
    expect(await recordMarketVisit(t.db, { userId: id, marketId: market })).toBe('recorded');
    // A reload, a retry, a second tab: the same day merges.
    expect(await recordMarketVisit(t.db, { userId: id, marketId: market })).toBe('merged');
    expect(await recordMarketVisit(t.db, { userId: id, marketId: market })).toBe('merged');
    expect(await recordMarketVisit(t.db, { userId: id, marketId: other })).toBe('recorded');
    const date = await today();
    expect(await readVisits(t.db)).toEqual(
      [
        { userId: id, marketId: market, date },
        { userId: id, marketId: other, date },
      ].sort((a, b) => a.marketId.localeCompare(b.marketId)),
    );
  });

  it('records nothing for an account admin now by the records, and again once revoked (96-10)', async () => {
    const id = await member();
    const market = await publicMarket();
    const now = await clockTimestamp(t.db);
    await grantAdminAt(t.db, id, new Date(now.getTime() - 2 * MINUTE_MS));
    expect(await recordMarketVisit(t.db, { userId: id, marketId: market })).toBe('excluded');
    expect(await readVisits(t.db)).toEqual([]);
    await revokeAdminAt(t.db, id, new Date(now.getTime() - MINUTE_MS));
    expect(await recordMarketVisit(t.db, { userId: id, marketId: market })).toBe('recorded');
    expect(await readVisits(t.db)).toHaveLength(1);
  });

  it('records an account with the admin role but no grant record: a member by the records', async () => {
    const { user } = await createUser(t.db, { role: 'admin' });
    const market = await publicMarket();
    expect(await recordMarketVisit(t.db, { userId: user.id, marketId: market })).toBe('recorded');
  });

  it('records a restricted member (95-1)', async () => {
    const { user: asking } = await createUser(t.db, { role: 'admin' });
    const { user: approving } = await createUser(t.db, { role: 'admin' });
    const id = await member();
    const takenAt = new Date(Date.now() - DAY_MS);
    await createModerationAction(t.db, {
      userId: id,
      createdBy: asking.id,
      type: 'account_restriction',
      reason: 'multi_account',
      approvedBy: approving.id,
      createdAt: takenAt,
      endsAt: new Date(takenAt.getTime() + 7 * DAY_MS),
    });
    expect(await recordMarketVisit(t.db, { userId: id, marketId: await publicMarket() })).toBe(
      'recorded',
    );
  });

  it('records nothing for the operating account, whose raw row the trigger refuses (#115)', async () => {
    const bot = await createMarketMakerAccount(t.db);
    const market = await publicMarket();
    expect(await recordMarketVisit(t.db, { userId: bot, marketId: market })).toBe('excluded');
    await expect(rawInsert(bot, market)).rejects.toSatisfy(
      refusedBy('market_visits_human_account'),
    );
    // The owner too: the trigger holds for every role.
    await expect(
      t.asOwner('INSERT INTO market_visits (user_id, market_id) VALUES ($1, $2)', [bot, market]),
    ).rejects.toSatisfy(refusedBy('market_visits_human_account'));
    expect(await readVisits(t.db)).toEqual([]);
  });

  it('refuses a closed account a new row with the trigger the API maps (0043 race)', async () => {
    const id = await member();
    const market = await publicMarket();
    expect(await recordMarketVisit(t.db, { userId: id, marketId: market })).toBe('recorded');
    await closeAccount(t.db, id);
    // Closure deletes no visit (151-5).
    expect(await readVisits(t.db)).toHaveLength(1);
    const other = await publicMarket();
    await expect(rawInsert(id, other)).rejects.toSatisfy(refusedBy('market_visits_open_account'));
    await expect(recordMarketVisit(t.db, { userId: id, marketId: other })).rejects.toSatisfy(
      refusedBy('market_visits_open_account'),
    );
    expect(await readVisits(t.db)).toHaveLength(1);
  });

  it('answers not_found for a DRAFT, a REVIEW or an unknown market, and excluded for no account', async () => {
    const id = await member();
    for (const status of ['draft', 'review'] as const) {
      const market = (await createMarket(t.db, { status })).id;
      expect(await recordMarketVisit(t.db, { userId: id, marketId: market }), status).toBe(
        'not_found',
      );
    }
    expect(
      await recordMarketVisit(t.db, {
        userId: id,
        marketId: '00000000-0000-4000-8000-000000000000',
      }),
    ).toBe('not_found');
    expect(
      await recordMarketVisit(t.db, { userId: 'no-such-account', marketId: await publicMarket() }),
    ).toBe('excluded');
    // Every public status takes a row.
    for (const status of ['scheduled', 'closed', 'settled', 'cancelled'] as const) {
      const market = (await createMarket(t.db, { status })).id;
      expect(await recordMarketVisit(t.db, { userId: id, marketId: market }), status).toBe(
        'recorded',
      );
    }
    expect(await readVisits(t.db)).toHaveLength(4);
  });

  it('gives buddha_app INSERT of the account and market only: no date, no change, no lock', async () => {
    const id = await member();
    const market = await publicMarket();
    await expect(
      t.db.execute(
        sql`INSERT INTO market_visits (user_id, market_id, visit_date)
            VALUES (${id}, ${market}, DATE '2026-01-01')`,
      ),
    ).rejects.toSatisfy(denied);
    // Drizzle names every column (a missing one as `default`): refused the same way.
    await expect(
      t.db.insert(marketVisits).values({ userId: id, marketId: market }),
    ).rejects.toSatisfy(denied);
    await rawInsert(id, market);
    await expect(
      t.db.execute(sql`UPDATE market_visits SET visit_date = visit_date - 1`),
    ).rejects.toSatisfy(denied);
    await expect(
      t.db.transaction((tx) => tx.execute(sql`SELECT 1 FROM market_visits FOR UPDATE`)),
    ).rejects.toSatisfy(denied);
    await expect(
      t.db.transaction((tx) => tx.execute(sql`SELECT 1 FROM market_visits FOR KEY SHARE`)),
    ).rejects.toSatisfy(denied);
    // The purge's delete is held.
    await t.db.execute(sql`DELETE FROM market_visits WHERE user_id = ${id}`);
    expect(await readVisits(t.db)).toEqual([]);
  });

  it('lets buddha_app only read the collection start', async () => {
    await t.asOwner('INSERT INTO market_visit_collection DEFAULT VALUES');
    expect(await t.db.select().from(marketVisitCollection)).toHaveLength(1);
    await expect(t.db.insert(marketVisitCollection).values({})).rejects.toSatisfy(denied);
    await expect(
      t.db.execute(sql`UPDATE market_visit_collection SET started_at = now()`),
    ).rejects.toSatisfy(denied);
    await expect(t.db.execute(sql`DELETE FROM market_visit_collection`)).rejects.toSatisfy(denied);
    // One row at most, whoever writes.
    await expect(t.asOwner('INSERT INTO market_visit_collection DEFAULT VALUES')).rejects.toSatisfy(
      (e) => sqlState(e) === '23505',
    );
    await expect(
      t.asOwner('INSERT INTO market_visit_collection (id) VALUES (false)'),
    ).rejects.toSatisfy((e) => sqlState(e) === '23514');
  });
});
