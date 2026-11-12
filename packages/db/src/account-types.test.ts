import { readFileSync, readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { MARKET_MAKER_ACCOUNT_EMAIL } from '@buddha/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureMarketMakerAccount, isHumanAccount, marketMakerAccountId } from './account-types.js';
import { closeDb, createDb } from './client.js';
import { user } from './schema/index.js';
import { closeAccount, createMarketMakerAccount, createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';

const ROOT = new URL('../../../', import.meta.url);

/**
 * The files that may name an account type itself (#115, ADR-0108): where the types are listed
 * and stored, the one rule, the one maker of the 운영 마켓메이커 account, and the private-data list
 * that names the field to keep it out of public answers. #119 (ADR-0112) records both owners'
 * types on each fill, copied at the write and never compared there: the fill table, the intake
 * that writes the fills (orders.ts, which asks the rule for the self-trade group), and the test
 * helper that writes fill records as the intake does (`createFillRecord`).
 */
const MAY_NAME_THE_TYPE = [
  'packages/shared/src/enums.ts',
  'packages/shared/src/account-types.ts',
  'packages/shared/src/guards/private-data.ts',
  'packages/db/src/schema/enums.ts',
  'packages/db/src/schema/auth.ts',
  'packages/db/src/schema/fills.ts',
  'packages/db/src/account-types.ts',
  'packages/db/src/orders.ts',
  'packages/db/src/test/orders.ts',
];

/** The trees the static guard scans, each `<group>/<name>/src`. */
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

/** A type column handed to the rule, which is how a query reads it. */
const HANDED_TO_THE_RULE = /isHumanAccountTypeSql\(\s*[\w.]+\.accountType\s*\)/g;
/** #129's complete job/setting keys name neither an account type nor its column. */
const MARKET_MAKER_NAMESPACED_KEY =
  /(['"])market_maker\.(?:refresh|scan|reduce_at_bp|halt_at_bp|reduce_ratio_bp)\1/g;
/** The type named as itself: its values, its column, its field. */
const NAMES_THE_TYPE = /\bmarket_maker\b|\baccount_type\b|\baccountType\b/;
/** Exact #72 setting literals do not inspect an account type. No prefix exemption. */
const LIQUIDITY_SETTING_LITERAL =
  /(['"])market_maker\.default_(?:budget_coin|max_loss_coin|b|levels|quantity|safety_ticks)\1/g;
function namesAccountType(text: string): boolean {
  return NAMES_THE_TYPE.test(
    text
      .replace(HANDED_TO_THE_RULE, '')
      .replace(MARKET_MAKER_NAMESPACED_KEY, '')
      .replace(LIQUIDITY_SETTING_LITERAL, ''),
  );
}

describe('the one rule of a person’s account (#115, static)', () => {
  it('reads the source tree (the scan is not empty)', () => {
    const files = sourceFiles();
    expect(files).toEqual(
      expect.arrayContaining([
        ...MAY_NAME_THE_TYPE,
        'apps/api/src/main.ts',
        'apps/web/src/copy.ts',
      ]),
    );
  });

  it('names the type nowhere else: every count and check asks the rule', () => {
    // A consumer compares no type and names no value (ADR-0107 결정 4 #115 '사람 계정 판별 규칙
    // 하나'): it hands an account id to `isHumanAccountSql` or `isHumanAccount`, or a type column
    // to `isHumanAccountTypeSql`, so a type added later (#95) is judged in one place.
    const offenders = sourceFiles()
      .filter((file) => !MAY_NAME_THE_TYPE.includes(file))
      .filter((file) => namesAccountType(readFileSync(new URL(file, ROOT), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('re-runs when any scanned file changes (turbo test inputs cover the trees it reads)', () => {
    // CI replays a cached `@buddha/db#test` when none of its inputs changed, so a comparison added
    // only in apps/* would merge green unless those trees are inputs of this task.
    const turbo = JSON.parse(readFileSync(new URL('packages/db/turbo.json', ROOT), 'utf8')) as {
      tasks: { test: { inputs: string[] } };
    };
    expect(turbo.tasks.test.inputs).toEqual(
      expect.arrayContaining(SCANNED_GROUPS.map((group) => `$TURBO_ROOT$/${group}/*/src/**`)),
    );
  });

  it('lets a type column through only as the rule’s argument', () => {
    const strip = namesAccountType;
    expect(strip('and(isHumanAccountTypeSql(schema.user.accountType), eq(a, b))')).toBe(false);
    expect(strip("eq(schema.user.accountType, 'member')")).toBe(true);
    expect(strip("sql`u.account_type = 'member'`")).toBe(true);
    expect(strip("type === 'market_maker'")).toBe(true);
  });

  it('allows only the six exact liquidity setting literals, not adjacent type uses', () => {
    for (const key of ['budget_coin', 'max_loss_coin', 'b', 'levels', 'quantity', 'safety_ticks']) {
      expect(namesAccountType(`'market_maker.default_${key}'`)).toBe(false);
      expect(namesAccountType(`'market_maker.default_${key}_other'`)).toBe(true);
      expect(namesAccountType(`'market_maker.default_${key}' || type === 'market_maker'`)).toBe(
        true,
      );
    }
    expect(namesAccountType("'market_maker.other'")).toBe(true);
    expect(namesAccountType('market_maker.default_b')).toBe(true);
  });

  it('allows only complete MM job/setting keys, still checking every account comparison beside them', () => {
    for (const key of ['refresh', 'scan', 'reduce_at_bp', 'halt_at_bp', 'reduce_ratio_bp']) {
      const named = `const key = 'market_maker.${key}';`;
      expect(namesAccountType(named)).toBe(false);
      expect(namesAccountType(`${named} type === 'market_maker'`)).toBe(true);
      expect(namesAccountType(`${named} u.account_type === value`)).toBe(true);
      expect(namesAccountType(`${named} u.accountType === value`)).toBe(true);
      expect(namesAccountType(`'market_maker.${key}.other'`)).toBe(true);
    }
  });
});

describe.skipIf(!hasTestDb())('account types (integration, docker test profile)', () => {
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

  it('answers a person for a member, an admin and a closed account, not the 운영 마켓메이커', async () => {
    const { user: member } = await createUser(t.db);
    const { user: admin } = await createUser(t.db, { role: 'admin' });
    const { user: closed } = await createUser(t.db);
    await closeAccount(t.db, closed.id);
    const marketMaker = await createMarketMakerAccount(t.db);
    expect(await isHumanAccount(t.db, member.id)).toBe(true);
    // #177 13항: an admin is a person (the role is not looked at).
    expect(await isHumanAccount(t.db, admin.id)).toBe(true);
    // #177 13항: a closed account stays a person (profiles.closed_at is not looked at).
    expect(await isHumanAccount(t.db, closed.id)).toBe(true);
    expect(await isHumanAccount(t.db, marketMaker)).toBe(false);
    // No account is nobody's person.
    expect(await isHumanAccount(t.db, 'no-such-account')).toBe(false);
  });

  it('finds the 운영 마켓메이커 by its type: none before it is made, then the one', async () => {
    await createUser(t.db);
    expect(await marketMakerAccountId(t.db)).toBeNull();
    const made = await t.db.transaction((tx) => ensureMarketMakerAccount(tx));
    expect(made.created).toBe(true);
    expect(await marketMakerAccountId(t.db)).toBe(made.id);
    // Made once: a second call finds it (the seed's every later run).
    expect(await t.db.transaction((tx) => ensureMarketMakerAccount(tx))).toEqual({
      id: made.id,
      created: false,
    });
    expect(await createMarketMakerAccount(t.db)).toBe(made.id);
    const [row] = await t.db.select().from(user).where(eq(user.id, made.id));
    expect(row).toMatchObject({
      email: MARKET_MAKER_ACCOUNT_EMAIL,
      emailVerified: false,
      name: '',
      image: null,
      accountType: 'market_maker',
    });
  });

  it('makes one when two ask at once: the second waits on the first and finds its row', async () => {
    const other = createDb(testDbUrls()!.appUrl, { max: 1, applicationName: 'buddha-mm-race' });
    try {
      let second: Promise<{ id: string; created: boolean }> | undefined;
      const first = await t.db.transaction(async (tx) => {
        const made = await ensureMarketMakerAccount(tx);
        // The other connection's insert meets this uncommitted row's unique keys and waits.
        second = ensureMarketMakerAccount(other);
        for (let attempt = 0; attempt < 100; attempt++) {
          await tx.execute(sql`select pg_stat_clear_snapshot()`);
          const { rows } = await tx.execute<{ waiting: number }>(sql`
            select count(*)::int as waiting from pg_stat_activity
            where application_name = 'buddha-mm-race' and wait_event_type = 'Lock'`);
          if (rows[0]?.waiting === 1) return made;
          await sleep(50);
        }
        throw new Error('the second call never waited on the first');
      });
      expect(await second).toEqual({ id: first.id, created: false });
      expect(await t.db.select({ id: user.id }).from(user)).toEqual([{ id: first.id }]);
    } finally {
      await closeDb(other);
    }
  });

  it('refuses to name another account the 운영 마켓메이커 when its address is taken', async () => {
    // No sign-up reaches the address (the credential endpoints refuse the domain); a row made
    // around them is not taken for the 운영 마켓메이커.
    await createUser(t.db, { email: MARKET_MAKER_ACCOUNT_EMAIL });
    await expect(t.db.transaction((tx) => ensureMarketMakerAccount(tx))).rejects.toThrow(
      'is held by another account',
    );
    expect(await marketMakerAccountId(t.db)).toBeNull();
  });
});
