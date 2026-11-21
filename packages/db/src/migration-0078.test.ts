import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeAccount,
  createMarket,
  createMarketMakerAccount,
  createUser,
} from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';
import { createTestNotification } from './test/notifications.js';

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

const migration = (file: string) =>
  readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
const MIGRATION = migration('0078_notifications.sql');

/** A migration's statements, in order. */
function statementsOf(text: string): string[] {
  return text
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

/** A statement without its `--` comment lines: what it runs. */
const codeOf = (statement: string) =>
  statement
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

/** The one statement of `text` whose code starts with `start`. */
function statementOf(text: string, start: string): string {
  const found = statementsOf(text)
    .map(codeOf)
    .filter((code) => code.startsWith(start));
  if (found.length !== 1) throw new Error(`${String(found.length)} statements start ${start}`);
  return found[0]!;
}

const STATEMENTS = statementsOf(MIGRATION);
const BACKFILL = statementOf(MIGRATION, 'INSERT INTO notification_inboxes');

/**
 * Migration 0078 (#53, ADR-0157) adds and fills, and changes no row that was there: three new
 * tables, their guards, two functions replaced with one addition each, the purge kinds' CHECK
 * regenerated, privileges, and rows of the new inbox table alone.
 */
describe('migration 0078 shape (static)', () => {
  it('is the generated tables and CHECK, the hand-edited guards, functions, backfill and privileges', () => {
    const leading = STATEMENTS.map(
      (statement) =>
        /^[A-Z]+(?: (?:OR REPLACE|UNIQUE))?(?: (?:TABLE|INDEX|FUNCTION|TRIGGER))?/.exec(
          codeOf(statement),
        )?.[0],
    );
    expect(leading).toEqual([
      'CREATE TABLE',
      'CREATE TABLE',
      'CREATE TABLE',
      'ALTER TABLE',
      'ALTER TABLE',
      'ALTER TABLE',
      'ALTER TABLE',
      'CREATE INDEX',
      'CREATE INDEX',
      'CREATE INDEX',
      'CREATE UNIQUE INDEX',
      'CREATE INDEX',
      'ALTER TABLE',
      'CREATE TRIGGER',
      'CREATE TRIGGER',
      'CREATE TRIGGER',
      'CREATE FUNCTION',
      'CREATE TRIGGER',
      'CREATE OR REPLACE FUNCTION',
      'INSERT',
      'CREATE OR REPLACE FUNCTION',
      'REVOKE',
      'REVOKE',
      'GRANT',
    ]);
    expect(STATEMENTS.slice(-3).map(codeOf)).toEqual([
      'REVOKE UPDATE ON TABLE "notification_keys" FROM buddha_app;',
      'REVOKE UPDATE ON TABLE "notifications" FROM buddha_app;',
      'GRANT UPDATE ("params", "event_count", "occurred_at", "read_at") ON TABLE "notifications" TO buddha_app;',
    ]);
    // 53-5 names the guard; the inbox is the one table the closed-account guard is on.
    for (const [trigger, table, call] of [
      [
        'notification_inboxes_human_account',
        'notification_inboxes',
        "refuse_operating_account_rows('user_id')",
      ],
      ['notifications_human_account', 'notifications', "refuse_operating_account_rows('user_id')"],
      ['notification_inboxes_open_account', 'notification_inboxes', 'refuse_closed_account_rows()'],
    ] as const) {
      expect(statementOf(MIGRATION, `CREATE TRIGGER ${trigger}\n`)).toBe(
        `CREATE TRIGGER ${trigger}\n  BEFORE INSERT ON "${table}"\n  FOR EACH ROW EXECUTE FUNCTION ${call};`,
      );
    }
    expect(MIGRATION).not.toMatch(
      /ON "notifications"\n\s+FOR EACH ROW EXECUTE FUNCTION refuse_closed/,
    );
    // Every new function fixes its search path, with pg_temp last.
    for (const start of [
      'CREATE FUNCTION notifications_kept()',
      'CREATE OR REPLACE FUNCTION create_profile_for_user()',
      'CREATE OR REPLACE FUNCTION profiles_closed_completely()',
    ]) {
      expect(statementOf(MIGRATION, start), start).toContain(
        'SET search_path = pg_catalog, public, pg_temp AS $$',
      );
    }
  });

  it('holds no statement that changes or removes an existing row, and drops only the purge kinds’ CHECK', () => {
    const forbidden: [string, RegExp][] = [
      [
        'UPDATE … SET',
        /\bUPDATE\s+(?:ONLY\s+)?(?:"?\w+"?\.)?"?\w+"?(?:\s+(?:AS\s+)?"?\w+"?)?\s+SET\b/i,
      ],
      ['DO UPDATE', /\bDO\s+UPDATE\b/i],
      ['DELETE FROM', /\bDELETE\s+FROM\b/i],
      ['TRUNCATE', /\bTRUNCATE\b/i],
      ['EXECUTE', /\bEXECUTE\b(?!\s+FUNCTION\b)/i],
    ];
    const tables = new Set(['notification_inboxes', 'notifications', 'notification_keys']);
    const hits = STATEMENTS.map(codeOf).flatMap((code, index) => [
      ...forbidden
        .filter(([, pattern]) => pattern.test(code))
        .map(([name]) => `statement ${String(index)}: ${name}`),
      ...[...code.matchAll(/\bDROP\b.*$/gim)]
        .filter((match) => match[0] !== 'DROP CONSTRAINT "retention_purges_kind_check";')
        .map((match) => `statement ${String(index)}: ${match[0]}`),
      ...[...code.matchAll(/\bALTER\s+TABLE\s+(?:"?public"?\.)?"?(\w+)"?/gi)]
        .filter((match) => !tables.has(match[1]!) && match[1] !== 'retention_purges')
        .map((match) => `statement ${String(index)}: ALTER TABLE ${match[1]!}`),
      ...[...code.matchAll(/\bINSERT\s+INTO\s+(?:"?public"?\.)?"?(\w+)"?/gi)]
        .filter((match) => match[1] !== 'notification_inboxes')
        .filter((match) => !['profiles', 'ledger_accounts'].includes(match[1]!))
        .map((match) => `statement ${String(index)}: INSERT INTO ${match[1]!}`),
    ]);
    expect(hits).toEqual([]);
    // The purge kinds' CHECK: 0056's list with `notifications` last.
    const before = statementOf(
      migration('0056_market_disputes.sql'),
      'ALTER TABLE "retention_purges" ADD CONSTRAINT',
    );
    expect(statementOf(MIGRATION, 'ALTER TABLE "retention_purges" ADD CONSTRAINT')).toBe(
      before.replace("'market_proposals'));", "'market_proposals', 'notifications'));"),
    );
  });

  it('replaces two of 0060’s functions with one addition each', () => {
    const earlier = migration('0060_ledger_accounts.sql');
    const profile = 'CREATE OR REPLACE FUNCTION create_profile_for_user()';
    expect(
      statementOf(MIGRATION, profile).replace(
        '\n  INSERT INTO notification_inboxes (user_id) VALUES (NEW.id);',
        '',
      ),
    ).toBe(statementOf(earlier, profile));
    // The inbox comes after the early return of the operating account, with the ledger account.
    const body = statementOf(MIGRATION, profile);
    expect(body.indexOf('INSERT INTO notification_inboxes')).toBeGreaterThan(
      body.indexOf("INSERT INTO ledger_accounts (kind, owner_id) VALUES ('user', NEW.id);"),
    );
    expect(body.indexOf('RETURN NEW;\n  END IF;')).toBeLessThan(body.indexOf('LOOP'));
    const closed = 'CREATE OR REPLACE FUNCTION profiles_closed_completely()';
    expect(
      statementOf(MIGRATION, closed).replace(
        `\n    WHEN EXISTS (SELECT FROM "notification_inboxes" WHERE "user_id" = NEW.user_id)\n      THEN 'its notifications'`,
        '',
      ),
    ).toBe(statementOf(earlier, closed));
  });

  it('fills the inboxes of the open persons’ accounts only, re-runnably', () => {
    expect(BACKFILL).toBe(
      'INSERT INTO notification_inboxes (user_id)\n' +
        'SELECT p.user_id FROM profiles p JOIN "user" u ON u.id = p.user_id\n' +
        'WHERE p.closed_at IS NULL AND is_human_account_type(u.account_type)\n' +
        'ON CONFLICT (user_id) DO NOTHING;',
    );
    // After the guards it runs through, before the closure check that names the table.
    const index = STATEMENTS.map(codeOf).indexOf(BACKFILL);
    expect(index).toBeGreaterThan(
      STATEMENTS.findIndex((statement) =>
        codeOf(statement).startsWith('CREATE TRIGGER notification_inboxes_open_account'),
      ),
    );
  });
});

/**
 * The migration on accounts made before it (#53): as the migrate role, in a transaction that is
 * rolled back, what 0078 made is removed — its tables, its function, its CHECK's new kind — 0060's
 * two functions are put back, and the whole file is run on the accounts there. Every open person's
 * account gets one inbox; a closed one and the 운영 마켓메이커 none; nothing else changes.
 */
describe.skipIf(!hasTestDb())('migration 0078: inboxes (integration)', () => {
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

  const read = async <Row extends object>(text: string): Promise<Row[]> =>
    (await migrate.query<Row>(text)).rows;

  /** The tables the backfill reads: no row of them may change. */
  const UNTOUCHED = {
    user: 'SELECT * FROM "user" ORDER BY id',
    profiles: 'SELECT * FROM profiles ORDER BY user_id',
    ledger_accounts: 'SELECT * FROM ledger_accounts ORDER BY id',
  } as const;
  /** One connection runs one query at a time: the reads go in turn. */
  const untouched = async () => {
    const rows: Record<string, object[]> = {};
    for (const [table, text] of Object.entries(UNTOUCHED)) rows[table] = await read(text);
    return rows;
  };

  async function beforeMigration<T>(inside: () => Promise<T>): Promise<T> {
    const earlier = migration('0060_ledger_accounts.sql');
    await migrate.query('BEGIN');
    try {
      await migrate.query('DROP TABLE notification_keys, notifications, notification_inboxes');
      await migrate.query('DROP FUNCTION notifications_kept()');
      for (const start of [
        'CREATE OR REPLACE FUNCTION create_profile_for_user()',
        'CREATE OR REPLACE FUNCTION profiles_closed_completely()',
      ]) {
        await migrate.query(statementOf(earlier, start));
      }
      const disputes = migration('0056_market_disputes.sql');
      await migrate.query(
        'ALTER TABLE "retention_purges" DROP CONSTRAINT "retention_purges_kind_check"',
      );
      await migrate.query(statementOf(disputes, 'ALTER TABLE "retention_purges" ADD CONSTRAINT'));
      return await inside();
    } finally {
      await migrate.query('ROLLBACK');
    }
  }

  it('gives every open person’s account one inbox, and none to a closed one or the 운영 마켓메이커', async () => {
    const { user: member } = await createUser(t.db, { balanceCoin: 1_000n });
    const { user: admin } = await createUser(t.db, { role: 'admin' });
    const { user: closed } = await createUser(t.db);
    await closeAccount(t.db, closed.id);
    const marketMaker = await createMarketMakerAccount(t.db);
    const before = await untouched();
    const inboxes = await beforeMigration(async () => {
      // Made before the migration: no inbox anywhere, and the old trigger makes none.
      expect(
        await read<{ n: string }>(
          "SELECT count(*)::text AS n FROM pg_tables WHERE tablename = 'notification_inboxes'",
        ),
      ).toEqual([{ n: '0' }]);
      for (const statement of STATEMENTS) await migrate.query(statement);
      // Re-runnable: the backfill again adds nothing.
      await migrate.query(BACKFILL);
      expect(await untouched()).toEqual(before);
      return read<{ user_id: string }>('SELECT user_id FROM notification_inboxes ORDER BY user_id');
    });
    expect(inboxes.map((row) => row.user_id).sort()).toEqual([member.id, admin.id].sort());
    expect(inboxes.map((row) => row.user_id)).not.toContain(closed.id);
    expect(inboxes.map((row) => row.user_id)).not.toContain(marketMaker);
  });

  it('gives a sign-up after the migration its inbox, and a notification reaches it', async () => {
    const { user: member } = await createUser(t.db);
    const market = await createMarket(t.db);
    expect(
      await read<{ user_id: string }>(
        `SELECT user_id FROM notification_inboxes WHERE user_id = '${member.id}'`,
      ),
    ).toEqual([{ user_id: member.id }]);
    expect(
      (await createTestNotification(t.db, { userId: member.id, slug: market.slug })).kind,
    ).toBe('created');
  });
});
