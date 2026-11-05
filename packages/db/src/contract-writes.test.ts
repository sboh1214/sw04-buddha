import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);

/**
 * The one module that makes, moves and removes contracts (#118, ADR-0110; 수용 기준 'YES나 NO 한쪽만
 * 만들거나 없애는 경로가 없다', '보유 없이 계약을 옮기는 경로가 없다'): contracts.ts writes `positions`
 * — a pair mint's two rows, a fill's two, the 운영 마켓메이커's burn, an order's sell lock — and is
 * the only caller that records the three contract events. Every other writer of a holding is one
 * of these, each for its reason.
 */
const CONTRACTS = 'packages/db/src/contracts.ts';

/** Who else writes `positions`, and why. */
const POSITION_WRITERS: Record<string, string> = {
  [CONTRACTS]: 'pair mint, fill, burn and sell lock',
  // Settlement zeroes each row it pays (ADR-0109 12-12 interim, until #126 reworks it); the CHECK
  // `positions_locked_qty_check` fails its qty-0 UPDATE while a sell lock remains.
  'apps/worker/src/jobs/market-finalize.ts': 'settlement',
  // `createPosition`: a holding for reads and settlement inputs, with no ledger (its doc says so).
  'packages/db/src/test/factories.ts': 'test fixture',
};

/** Who else records PAIR_MINT_COLLATERAL, TRADE_FILL or PAIR_BURN_RETURN, and why. */
const CONTRACT_RECORDERS: Record<string, string> = {
  [CONTRACTS]: 'the three contract events',
  // `spendCoin`: one pair-mint leg with no pair — collateral without contracts, a test's alone.
  'packages/db/src/test/ledger.ts': 'test fixture',
};

/**
 * Files that both name a contract type and record ledger events without recording a contract
 * event: the writer itself, whose docs name the types' keys. Its own literal records are still
 * caught by `CONTRACT_RECORDS`.
 */
const NAMING_RECORDERS: Record<string, string> = {
  'packages/db/src/ledger.ts': 'defines recordLedgerEntry; names the types in its key docs',
};

/** The trees the static guard scans, each `<group>/<name>/src` (ledger-writes.test.ts's). */
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
 * A write of a holding: drizzle's `insert`/`update`/`delete` of `positions` (bare or through
 * `schema.`), and the same in raw SQL — the table named in the text (an UPDATE with its SET after
 * an optional alias, so a comment quoting an error's "update "positions" …" is not one, and a
 * MERGE) or interpolated.
 */
const POSITION_WRITES = [
  /\.(?:insert|update|delete)\(\s*(?:schema\.)?positions\b/,
  /\b(?:insert\s+into|delete\s+from|merge\s+into)\s+(?:public\.)?"?positions\b/i,
  /\bupdate\s+(?:only\s+)?(?:public\.)?"?positions"?(?:\s+(?:as\s+)?"?\w+"?)?\s+set\b/i,
  /\b(?:insert\s+into|update|delete\s+from|merge\s+into)\s+\$\{\s*(?:schema\.)?positions\s*\}/i,
];

/** A record of a contract event: its type written as the input's literal. */
const CONTRACT_RECORDS = /\btype:\s*['"`](?:PAIR_MINT_COLLATERAL|TRADE_FILL|PAIR_BURN_RETURN)['"`]/;

/**
 * A contract type named anywhere (quoted, or a key such as `TYPES.TRADE_FILL`), and a ledger
 * record built anywhere in the same file. Together they catch a record whose type is not the
 * literal right after `type:` — a ternary, a shorthand `type` from a const, a helper's parameter
 * given the name in the same file. A helper in one file that records whatever type another file
 * passes it is the limit of a scan by file: that is a second `recordLedgerEntry`, left to review.
 */
const NAMES_CONTRACT_TYPE = /\b(?:PAIR_MINT_COLLATERAL|TRADE_FILL|PAIR_BURN_RETURN)\b/;
const RECORDS_LEDGER = /\brecordLedgerEntry\s*\(|\bLedgerEntryInput\b/;

const writesPositions = (text: string) => POSITION_WRITES.some((pattern) => pattern.test(text));
const recordsContracts = (text: string) => CONTRACT_RECORDS.test(text);
const mayRecordContracts = (text: string) =>
  NAMES_CONTRACT_TYPE.test(text) && RECORDS_LEDGER.test(text);

const read = (file: string) => readFileSync(new URL(file, ROOT), 'utf8');

describe('one writer of contracts (#118, static)', () => {
  it('reads the source tree (the scan is not empty)', () => {
    expect(sourceFiles()).toEqual(
      expect.arrayContaining([
        CONTRACTS,
        ...Object.keys(POSITION_WRITERS),
        ...Object.keys(CONTRACT_RECORDERS),
        'packages/db/src/ledger.ts',
      ]),
    );
  });

  it('writes positions nowhere else', () => {
    // A pair is made by `applyPairMintFill`, changes owner by `applyTradeFill`, and goes by
    // `burnMarketMakerPairs` or settlement — no path makes or removes one side alone. Test files
    // are not scanned: a test's own rows go through `createPosition` or raw SQL on purpose.
    const writers = sourceFiles().filter((file) => writesPositions(read(file)));
    expect(writers.sort()).toEqual(Object.keys(POSITION_WRITERS).sort());
  });

  it('records the three contract events nowhere else', () => {
    // `recordLedgerEntry` takes any type; the shape rules let a person pay collateral or a fill.
    // So that no Coin moves for a contract without the contract moving with it, only contracts.ts
    // writes these types — always `debitFrom: 'locked'` for the two a lock pays.
    const recorders = sourceFiles().filter((file) => recordsContracts(read(file)));
    expect(recorders.sort()).toEqual(Object.keys(CONTRACT_RECORDERS).sort());
    // However the type is written: a file that names one of the three and records anything.
    const naming = sourceFiles().filter((file) => mayRecordContracts(read(file)));
    expect(naming.sort()).toEqual(
      [...Object.keys(CONTRACT_RECORDERS), ...Object.keys(NAMING_RECORDERS)].sort(),
    );
  });

  it('re-runs when any scanned file changes (turbo test inputs cover the trees it reads)', () => {
    const turbo = JSON.parse(read('packages/db/turbo.json')) as {
      tasks: { test: { inputs: string[] } };
    };
    expect(turbo.tasks.test.inputs).toEqual(
      expect.arrayContaining(SCANNED_GROUPS.map((group) => `$TURBO_ROOT$/${group}/*/src/**`)),
    );
  });

  it('catches each way of writing them, and no read', () => {
    for (const text of [
      'tx.insert(schema.positions).values(row)',
      'await tx\n  .update(positions)',
      'db.delete(positions).where(x)',
      'sql`UPDATE positions SET qty = 0`',
      'sql`insert into "positions" (user_id) values ($1)`',
      "client.query('delete from public.positions')",
      'sql`update ${schema.positions} set locked_qty = 0`',
      'sql`INSERT INTO ${ positions } (qty) values (1)`',
      'sql`UPDATE positions p SET locked_qty = 0 FROM orders o WHERE o.id = p.id`',
      'sql`UPDATE positions AS p SET qty = 0`',
      'sql`update public.positions as p set qty = 0`',
      'sql`UPDATE ONLY "positions" "p" SET qty = 0`',
      'sql`MERGE INTO positions p USING fills f ON true WHEN MATCHED THEN DELETE`',
      'sql`merge into ${schema.positions} as p using x on true when matched then do nothing`',
    ]) {
      expect(writesPositions(text), text).toBe(true);
    }
    for (const text of [
      'tx.select().from(positions).for("update")',
      'eq(schema.positions.userId, id)',
      '`40P01 deadlock detected — Failed query: update "positions" …`',
      '// an update of positions settles them later',
      'sql`select * from ${schema.positions}`',
      'tx.update(schema.positionsView)',
    ]) {
      expect(writesPositions(text), text).toBe(false);
    }
    expect(recordsContracts("recordLedgerEntry(tx, { type: 'TRADE_FILL', amountCoin })")).toBe(
      true,
    );
    expect(recordsContracts("{\n    type: 'PAIR_BURN_RETURN',")).toBe(true);
    expect(recordsContracts('recordLedgerEntry(tx, { type: `TRADE_FILL`, amountCoin })')).toBe(
      true,
    );
    for (const text of [
      "recordLedgerEntry(tx, { type: isMint ? 'PAIR_MINT_COLLATERAL' : 'TRADE_FILL', from, to })",
      "const type = 'TRADE_FILL' as const;\nawait recordLedgerEntry(tx, { type, from, to })",
      'const pay = (type: LedgerEntryType) => recordLedgerEntry(tx, { type, from, to });\n' +
        "await pay('PAIR_BURN_RETURN');",
      'const entry: LedgerEntryInput = { type: TYPES.TRADE_FILL, from, to };',
      'recordLedgerEntry(tx, { type: "PAIR_MINT_COLLATERAL", from, to })',
    ]) {
      expect(mayRecordContracts(text), text).toBe(true);
    }
    for (const text of [
      "recordLedgerEntry(tx, { type: 'START_GRANT', from, to })",
      "eq(ledgerEntries.type, 'TRADE_FILL')",
      "findLedgerEntry(tx, 'PAIR_BURN_RETURN', key)",
    ]) {
      expect(mayRecordContracts(text), text).toBe(false);
    }
    for (const text of [
      "PAIR_MINT_COLLATERAL: '쌍 발행 담보'",
      "eq(ledgerEntries.type, 'TRADE_FILL')",
      "findLedgerEntry(tx, 'PAIR_BURN_RETURN', key)",
    ]) {
      expect(recordsContracts(text), text).toBe(false);
    }
  });
});
