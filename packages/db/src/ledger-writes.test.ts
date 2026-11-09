import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);

/**
 * The one file that writes the books (#116, ADR-0109; 수용 기준 '원장 이벤트 없이 잔액을 바꾸는
 * 경로가 없다'): `recordLedgerEntry`, the ledger accounts it makes, and #118's order locks. Every
 * other writer of Coin calls it.
 */
const WRITES_THE_BOOKS = 'packages/db/src/ledger.ts';
/** Owner-only TEST incident injection, never imported by an application runtime. */
const INCIDENT_FIXTURES = 'packages/db/src/test/ledger.ts';

/** The trees the static guard scans, each `<group>/<name>/src` (account-types.test.ts's). */
const SCANNED_GROUPS = ['apps', 'packages'];

/** Every source file of every app and package, tests aside, relative to the repository root. */
function sourceFiles(): string[] {
  return SCANNED_GROUPS.flatMap((group) =>
    readdirSync(new URL(`${group}/`, ROOT), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const src = `${group}/${entry.name}/src`;
        let files: string[];
        try {
          files = readdirSync(new URL(`${src}/`, ROOT), { recursive: true, encoding: 'utf8' });
        } catch {
          return [];
        }
        return files
          .filter((file) => /\.(ts|tsx|mts)$/.test(file) && !/\.test\.tsx?$/.test(file))
          .map((file) => `${src}/${file.replaceAll('\\', '/')}`);
      }),
  );
}

/**
 * A write of the books: drizzle's `insert(…ledgerEntries)` and `insert`/`update`/`delete` of
 * `balances` or `ledgerAccounts` (bare or through `schema.`), and the same in raw SQL — the table
 * named in the text or interpolated (`${schema.balances}`, the way raw SQL here names a table).
 */
const WRITES = [
  /\.insert\(\s*(?:schema\.)?ledgerEntries\b/,
  /\.(?:insert|update|delete)\(\s*(?:schema\.)?(?:balances|ledgerAccounts)\b/,
  /\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?"?(?:ledger_entries|balances|ledger_accounts)\b/i,
  /\b(?:insert\s+into|update|delete\s+from)\s+\$\{\s*(?:schema\.)?(?:ledgerEntries|balances|ledgerAccounts)\s*\}/i,
];

const writesTheBooks = (text: string) => WRITES.some((pattern) => pattern.test(text));

describe('one writer of the books (#116, static)', () => {
  it('reads the source tree (the scan is not empty)', () => {
    expect(sourceFiles()).toEqual(
      expect.arrayContaining([
        WRITES_THE_BOOKS,
        'packages/db/src/start-grants.ts',
        'apps/api/src/wallet/wallet.service.ts',
        'apps/worker/src/jobs/market-finalize.ts',
      ]),
    );
  });

  it('writes ledger entries, balances and ledger accounts nowhere else', () => {
    // Every Coin writer — the start grant, the closure, the kept payment and coupon paths, the
    // settlement payout, and #118/#119/#126/#93/#129 later — calls `recordLedgerEntry`, which
    // records the event with its balance changes (and the database refuses a balance whose total
    // is not its ledger's at COMMIT, migration 0060). Test files are not scanned: the one door a
    // test has around it is `withLedgerGuardsOff` (test/ledger.ts), on the migrate role.
    const offenders = sourceFiles()
      .filter((file) => file !== WRITES_THE_BOOKS && file !== INCIDENT_FIXTURES)
      .filter((file) => writesTheBooks(readFileSync(new URL(file, ROOT), 'utf8')));
    expect(offenders).toEqual([]);
    expect(writesTheBooks(readFileSync(new URL(WRITES_THE_BOOKS, ROOT), 'utf8'))).toBe(true);
  });

  it('re-runs when any scanned file changes (turbo test inputs cover the trees it reads)', () => {
    const turbo = JSON.parse(readFileSync(new URL('packages/db/turbo.json', ROOT), 'utf8')) as {
      tasks: { test: { inputs: string[] } };
    };
    expect(turbo.tasks.test.inputs).toEqual(
      expect.arrayContaining(SCANNED_GROUPS.map((group) => `$TURBO_ROOT$/${group}/*/src/**`)),
    );
  });

  it('catches each way of writing them', () => {
    for (const text of [
      'tx.insert(schema.ledgerEntries).values(row)',
      'await tx\n  .insert(ledgerEntries)',
      'tx.update(schema.balances).set({ availableCoin })',
      'db.delete(balances).where(x)',
      'tx.insert(ledgerAccounts).values(v)',
      'sql`UPDATE balances SET available_coin = 0`',
      'sql`insert into ledger_entries (type) values ($1)`',
      'sql`DELETE FROM "ledger_accounts"`',
      "client.query('update public.balances set locked_coin = 0')",
      // #118's lock written as raw SQL: the total stays, so only this scan stops it outside.
      'sql`update ${schema.balances} set locked_coin = locked_coin + ${x} where account_id = ${id}`',
      'sql`insert into ${ledgerEntries} (type) values (1)`',
      'sql`DELETE FROM ${ schema.ledgerAccounts }`',
    ]) {
      expect(writesTheBooks(text), text).toBe(true);
    }
    for (const text of [
      'tx.select().from(schema.ledgerEntries)',
      'tx.select().from(balances).for("update")',
      'eq(schema.balances.userId, id)',
      'tx.insert(schema.ledgerEntryTypes)',
      'sql`select * from ${schema.balances} where account_id = ${id}`',
      'sql`update ${schema.markets} set status = ${s}`',
    ]) {
      expect(writesTheBooks(text), text).toBe(false);
    }
  });
});
