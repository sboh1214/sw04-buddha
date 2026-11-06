import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);

/**
 * The one writer of orders and fills (#119, ADR-0112; ADR-0111 '주문을 쓰는 모든 곳이 lockMarket을
 * 잡는 것은 #119가 지킨다'): orders.ts takes every order and writes every fill under the market's
 * `lockMarket` — the arrival key is drawn under it, and `fills_check` (migration 0062) reads both
 * orders by key trusting it. Every other writer is listed with its reason; the cancel (#178) and
 * the expiry (#120) join here, holding the same lock.
 */
const ORDER_WRITERS: Record<string, string> = {
  'packages/db/src/orders.ts': 'the intake: the order, its fills and the resting orders they fill',
  // `createOrder`, `createFillRecord`: rows as the intake leaves them, under `lockMarket`, for
  // reads and fixtures with no intake (their docs say so).
  'packages/db/src/test/orders.ts': 'test fixture',
};

/** The trees the static guard scans, each `<group>/<name>/src` (contract-writes.test.ts's). */
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
 * A write of an order or a fill: drizzle's `insert`/`update`/`delete` of `orders` or `fills` (bare
 * or through `schema.`), and the same in raw SQL — the table named in the text (an UPDATE with its
 * SET after an optional alias, so a comment quoting an error is not one, and a MERGE) or
 * interpolated.
 */
const TABLES = '(?:orders|fills)';
const ORDER_WRITES = [
  new RegExp(`\\.(?:insert|update|delete)\\(\\s*(?:schema\\.)?${TABLES}\\b`),
  new RegExp(
    `\\b(?:insert\\s+into|delete\\s+from|merge\\s+into)\\s+(?:public\\.)?"?${TABLES}\\b`,
    'i',
  ),
  new RegExp(
    `\\bupdate\\s+(?:only\\s+)?(?:public\\.)?"?${TABLES}"?(?:\\s+(?:as\\s+)?"?\\w+"?)?\\s+set\\b`,
    'i',
  ),
  new RegExp(
    `\\b(?:insert\\s+into|update|delete\\s+from|merge\\s+into)\\s+\\$\\{\\s*(?:schema\\.)?${TABLES}\\s*\\}`,
    'i',
  ),
];

const writesOrders = (text: string) => ORDER_WRITES.some((pattern) => pattern.test(text));

const read = (file: string) => readFileSync(new URL(file, ROOT), 'utf8');

describe('one writer of orders and fills (#119, static)', () => {
  it('reads the source tree (the scan is not empty)', () => {
    expect(sourceFiles()).toEqual(expect.arrayContaining(Object.keys(ORDER_WRITERS)));
  });

  it('writes orders and fills nowhere else', () => {
    // Test files are not scanned: a test's own rows go through the helpers or raw SQL on purpose.
    const writers = sourceFiles().filter((file) => writesOrders(read(file)));
    expect(writers.sort()).toEqual(Object.keys(ORDER_WRITERS).sort());
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
      'tx.insert(schema.orders).values(row)',
      'await tx\n  .update(orders)',
      'db.delete(fills).where(x)',
      "sql`UPDATE orders SET status = 'cancelled'`",
      'sql`insert into "fills" (qty) values ($1)`',
      "client.query('delete from public.orders')",
      'sql`update ${schema.orders} set status = 1`',
      'sql`INSERT INTO ${ fills } (qty) values (1)`',
      'sql`UPDATE orders o SET status = 1 FROM markets m WHERE m.id = o.market_id`',
      'sql`UPDATE ONLY "orders" "o" SET qty = 0`',
      'sql`MERGE INTO fills f USING x ON true WHEN MATCHED THEN DELETE`',
    ]) {
      expect(writesOrders(text), text).toBe(true);
    }
    for (const text of [
      'tx.select().from(orders).for("update")',
      'eq(schema.orders.userId, id)',
      '`23514 — Failed query: update "orders" …`',
      '// an update of orders cancels them later',
      'sql`select * from ${schema.fills}`',
      'tx.update(schema.ordersView)',
      'tx.insert(orderBooks)',
    ]) {
      expect(writesOrders(text), text).toBe(false);
    }
  });
});
