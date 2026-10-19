import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/** A statement's SQL without the `--` comment lines a hand-edited migration opens it with. */
function withoutLeadingComments(statement: string): string {
  const lines = statement.trim().split(/\r?\n/);
  while (lines[0]?.startsWith('--')) lines.shift();
  return lines.join('\n').trim();
}

/**
 * The hand-edited block of migration 0032 that clears the case variants before
 * `profiles_nickname_lower_unique` is built, read from the migration itself: no second copy to
 * drift from what a persistent database (dev, deployed) runs.
 */
function caseVariantBlock(): string {
  const migration = readFileSync(
    new URL('../drizzle/0032_onboarding.sql', import.meta.url),
    'utf8',
  );
  const blocks = migration
    .split(STATEMENT_BREAKPOINT)
    .map(withoutLeadingComments)
    .filter((statement) => statement.startsWith('DO $$'));
  expect(blocks).toHaveLength(1);
  return blocks[0]!;
}

/**
 * Migration 0032's clean-up of the nicknames that differ only in case (#58, ADR-0069 decision 1
 * #57-6: 'Abc' keeps 'abc' out). Migrations run against an empty test database, so the block
 * would otherwise never meet a variant in any test. Recreated as it stood before 0032 — the unique
 * index on lower(nickname) not built yet — in a transaction that is rolled back, as the migrate
 * role (the table's owner: only it may drop the index).
 */
describe.skipIf(!hasTestDb())('migration 0032: the case variants (integration)', () => {
  let t: TestDb;
  let migrate: Client;
  beforeAll(async () => {
    t = await connectTestDb();
    migrate = new Client({ connectionString: testDbUrls()!.migrateUrl });
    await migrate.connect();
  });
  afterAll(async () => {
    await migrate?.end();
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
  });

  /** A user and, through the sign-up trigger, its profile; then the nickname and time given. */
  async function account(id: string, nickname: string, createdAt: string): Promise<void> {
    await migrate.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'x', $2)`, [
      id,
      `${id}@test.local`,
    ]);
    await migrate.query(`UPDATE profiles SET nickname = $2, created_at = $3 WHERE user_id = $1`, [
      id,
      nickname,
      createdAt,
    ]);
  }

  async function nicknames(): Promise<Record<string, string>> {
    const { rows } = await migrate.query<{ user_id: string; nickname: string }>(
      'SELECT user_id, nickname FROM profiles',
    );
    return Object.fromEntries(rows.map((row) => [row.user_id, row.nickname]));
  }

  async function rolledBack(body: () => Promise<void>): Promise<void> {
    await migrate.query('BEGIN');
    try {
      await migrate.query('DROP INDEX profiles_nickname_lower_unique');
      await body();
    } finally {
      await migrate.query('ROLLBACK');
    }
  }

  it('keeps each nickname with its oldest account and gives the later variants auto nicknames', async () => {
    await rolledBack(async () => {
      await account('v-oldest', 'Abc', '2026-01-01T00:00:00Z');
      await account('v-newer', 'abc', '2026-02-01T00:00:00Z');
      await account('v-newest', 'ABC', '2026-03-01T00:00:00Z');
      // Created at the same instant: the smaller user id is the older.
      await account('w-a', '홍길동_X', '2026-01-05T00:00:00Z');
      await account('w-b', '홍길동_x', '2026-01-05T00:00:00Z');
      await account('other', 'other', '2026-04-01T00:00:00Z');

      await migrate.query(caseVariantBlock());

      const after = await nicknames();
      expect(after['v-oldest']).toBe('Abc');
      expect(after['w-a']).toBe('홍길동_X');
      expect(after.other).toBe('other');
      for (const renamed of ['v-newer', 'v-newest', 'w-b']) {
        expect(after[renamed], renamed).toMatch(/^user_[23456789A-HJ-NP-Z]{4}$/);
      }
      // No two left alike in any case, and the index the migration builds next builds.
      const { rows } = await migrate.query<{ distinct: number; total: number }>(
        'SELECT count(DISTINCT lower(nickname))::int AS distinct, count(*)::int AS total FROM profiles',
      );
      expect(rows[0]!.distinct).toBe(rows[0]!.total);
      await migrate.query(
        'CREATE UNIQUE INDEX profiles_nickname_lower_unique ON profiles USING btree (lower(nickname))',
      );
    });
  });

  it('changes nothing where no nickname differs from another only in case', async () => {
    await rolledBack(async () => {
      await account('a', 'Trader_Kim', '2026-01-01T00:00:00Z');
      await account('b', '홍길동', '2026-01-02T00:00:00Z');
      const before = await nicknames();
      await migrate.query(caseVariantBlock());
      expect(await nicknames()).toEqual(before);
    });
  });
});
