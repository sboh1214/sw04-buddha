import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { notificationCategoriesOff, setNotificationCategory } from './notifications.js';
import { notificationInboxes } from './schema/index.js';
import { createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

const MIGRATION = readFileSync(
  new URL('../drizzle/0079_notification_settings.sql', import.meta.url),
  'utf8',
);

/** A statement without its `--` comment lines: what it runs. */
const codeOf = (statement: string) =>
  statement
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

/** The SQLSTATE of a refusal, through drizzle's wrapper. */
function stateOf(error: unknown): string | undefined {
  for (let link = error; typeof link === 'object' && link !== null;) {
    const { code, cause } = link as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') return code;
    link = cause;
  }
  return undefined;
}

/** The migration's statements, in order, without their comments. */
const STATEMENTS = MIGRATION.split(STATEMENT_BREAKPOINT)
  .map(codeOf)
  .filter((statement) => statement !== '');

/**
 * Migration 0079 (#56, ADR-0162) adds the member's 수신 설정 and changes no row that was there:
 * one column with a constant default (no row rewritten: every member reads every category on),
 * its CHECK, and buddha_app's UPDATE of the inbox narrowed to that column.
 */
describe('migration 0079 shape (static)', () => {
  it('is the generated column and CHECK, then the hand-edited privilege narrowing', () => {
    expect(STATEMENTS).toEqual([
      `ALTER TABLE "notification_inboxes" ADD COLUMN "categories_off" text[] DEFAULT '{}'::text[] NOT NULL;`,
      `ALTER TABLE "notification_inboxes" ADD CONSTRAINT "notification_inboxes_categories_off_check" CHECK ("notification_inboxes"."categories_off" <@ ARRAY['trade', 'market', 'community']::text[]);`,
      'REVOKE UPDATE ON TABLE "notification_inboxes" FROM buddha_app;',
      'GRANT UPDATE ("categories_off") ON TABLE "notification_inboxes" TO buddha_app;',
    ]);
  });

  it('holds no statement that changes or removes a row, and touches the inbox table only', () => {
    const forbidden: [string, RegExp][] = [
      ['UPDATE … SET', /\bUPDATE\b[^;]*\bSET\b/i],
      ['INSERT', /\bINSERT\b/i],
      ['DELETE', /\bDELETE\b/i],
      ['TRUNCATE', /\bTRUNCATE\b/i],
      ['DROP', /\bDROP\b/i],
      ['NOT VALID', /\bNOT\s+VALID\b/i],
    ];
    const hits = STATEMENTS.flatMap((code, index) => [
      ...forbidden
        .filter(([, pattern]) => pattern.test(code))
        .map(([name]) => `statement ${String(index)}: ${name}`),
      ...[...code.matchAll(/\bTABLE\s+"?(\w+)"?/g)]
        .filter((match) => match[1] !== 'notification_inboxes')
        .map((match) => `statement ${String(index)}: ${match[1]!}`),
    ]);
    expect(hits).toEqual([]);
  });
});

/**
 * The migration on inboxes made before it (#56): as the migrate role, in a transaction that is
 * rolled back, what 0079 made is removed — the CHECK, the column, the narrowing — and the file is
 * run on the inboxes there. Every inbox reads every category on, a sign-up after it too, and the
 * privileges are 0079's. The rest runs on the migrated test database as buddha_app.
 */
describe.skipIf(!hasTestDb())('migration 0079: the 수신 설정 (integration)', () => {
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

  const read = async <Row extends object>(text: string, values: unknown[] = []): Promise<Row[]> =>
    (await migrate.query<Row>(text, values)).rows;

  /** buddha_app's UPDATE privilege on the inbox table and on each of its columns. */
  const privileges = () =>
    read<{ table: boolean; user_id: boolean; created_at: boolean; categories_off: boolean | null }>(
      `SELECT has_table_privilege('buddha_app', 'notification_inboxes', 'UPDATE') AS "table",
         has_column_privilege('buddha_app', 'notification_inboxes', 'user_id', 'UPDATE') AS user_id,
         has_column_privilege('buddha_app', 'notification_inboxes', 'created_at', 'UPDATE')
           AS created_at,
         CASE WHEN EXISTS (SELECT FROM information_schema.columns
                            WHERE table_name = 'notification_inboxes'
                              AND column_name = 'categories_off')
           THEN has_column_privilege('buddha_app', 'notification_inboxes', 'categories_off',
                                     'UPDATE') END AS categories_off`,
    );

  async function beforeMigration<T>(inside: () => Promise<T>): Promise<T> {
    await migrate.query('BEGIN');
    try {
      await migrate.query(
        'ALTER TABLE notification_inboxes DROP CONSTRAINT notification_inboxes_categories_off_check',
      );
      await migrate.query('ALTER TABLE notification_inboxes DROP COLUMN categories_off');
      await migrate.query('GRANT UPDATE ON TABLE notification_inboxes TO buddha_app');
      return await inside();
    } finally {
      await migrate.query('ROLLBACK');
    }
  }

  it('reads every category on for an inbox made before it and a sign-up after it (52-21)', async () => {
    const { user: member } = await createUser(t.db);
    const { user: admin } = await createUser(t.db, { role: 'admin' });
    const after = await beforeMigration(async () => {
      // Before: no setting, and buddha_app may update the whole row.
      expect(await privileges()).toEqual([
        { table: true, user_id: true, created_at: true, categories_off: null },
      ]);
      const before = await read<{ user_id: string; created_at: Date }>(
        'SELECT * FROM notification_inboxes ORDER BY user_id',
      );
      for (const statement of STATEMENTS) await migrate.query(statement);
      // The rows as they were, with every category on — no backfill, no rewrite.
      expect(
        await read<{ user_id: string; created_at: Date; categories_off: string[] }>(
          'SELECT * FROM notification_inboxes ORDER BY user_id',
        ),
      ).toEqual(before.map((row) => ({ ...row, categories_off: [] })));
      expect(await privileges()).toEqual([
        { table: false, user_id: false, created_at: false, categories_off: true },
      ]);
      // A sign-up after it: the trigger's inbox takes the default.
      await migrate.query(
        `INSERT INTO "user" (id, name, email, email_verified)
         VALUES ('signed-up-after-0079', 'after', 'after-0079@test.local', true)`,
      );
      return read<{ user_id: string; categories_off: string[] }>(
        'SELECT user_id, categories_off FROM notification_inboxes ORDER BY user_id',
      );
    });
    expect(after).toEqual(
      [member.id, admin.id, 'signed-up-after-0079']
        .sort()
        .map((user_id) => ({ user_id, categories_off: [] })),
    );
  });

  it('lets buddha_app lock an inbox and set its categories, and move nothing else', async () => {
    const { user: member } = await createUser(t.db);
    expect(await notificationCategoriesOff(t.db, member.id)).toEqual([]);
    // The gate's KEY SHARE and the closure's FOR UPDATE under the column grant.
    await t.db.transaction(async (tx) => {
      for (const lock of ['FOR KEY SHARE SKIP LOCKED', 'FOR UPDATE'] as const) {
        const { rows } = await tx.execute(
          sql`SELECT user_id FROM notification_inboxes WHERE user_id = ${member.id} ${sql.raw(lock)}`,
        );
        expect(rows, lock).toHaveLength(1);
      }
    });
    expect(await setNotificationCategory(t.db, member.id, 'community', false)).toEqual([
      'community',
    ]);
    const where = eq(notificationInboxes.userId, member.id);
    for (const change of [{ userId: 'moved' }, { createdAt: new Date() }]) {
      const error = await t.db
        .update(notificationInboxes)
        .set(change)
        .where(where)
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(stateOf(error), Object.keys(change).join()).toBe('42501');
    }
  });
});
