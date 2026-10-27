import { readFileSync } from 'node:fs';
import { PUBLIC_ID_PATTERN } from '@buddha/shared';
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
 * Migration 0033's statements on `profiles.public_id`, read from the migration itself: the column
 * whose default draws an id for every row already there, then its unique constraint and its CHECK.
 */
function publicIdStatements(): string[] {
  const migration = readFileSync(new URL('../drizzle/0033_posts.sql', import.meta.url), 'utf8');
  const statements = migration
    .split(STATEMENT_BREAKPOINT)
    .map(withoutLeadingComments)
    .filter((statement) => statement.includes('"public_id"'));
  expect(
    statements.map((statement) => /ADD (?:COLUMN|CONSTRAINT) "[a-z_]+"/.exec(statement)?.[0]),
  ).toEqual([
    'ADD COLUMN "public_id"',
    'ADD CONSTRAINT "profiles_public_id_unique"',
    'ADD CONSTRAINT "profiles_public_id_check"',
  ]);
  return statements;
}

/**
 * Migration 0033 gives the profiles already there a public id each (#46, ADR-0069 decision 5): the
 * column's default is VOLATILE, so adding it draws one per row rather than one for all — which a
 * migration run against the empty test database never shows. Recreated as it stood before 0033 —
 * no column — in a transaction that is rolled back, as the migrate role (the table's owner).
 */
describe.skipIf(!hasTestDb())(
  'migration 0033: public ids of existing profiles (integration)',
  () => {
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

    it('draws a distinct id of the public shape for every profile already there', async () => {
      const statements = publicIdStatements();
      await migrate.query('BEGIN');
      try {
        await migrate.query('ALTER TABLE profiles DROP COLUMN public_id');
        for (let i = 0; i < 50; i += 1) {
          await migrate.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'x', $2)`, [
            `before-0033-${String(i)}`,
            `before-0033-${String(i)}@test.local`,
          ]);
        }
        for (const statement of statements) await migrate.query(statement);
        const { rows } = await migrate.query<{ public_id: string }>(
          'SELECT public_id FROM profiles',
        );
        expect(rows).toHaveLength(50);
        for (const { public_id: id } of rows) expect(id).toMatch(PUBLIC_ID_PATTERN);
        expect(new Set(rows.map((row) => row.public_id)).size).toBe(50);
      } finally {
        await migrate.query('ROLLBACK');
      }
    });
  },
);
