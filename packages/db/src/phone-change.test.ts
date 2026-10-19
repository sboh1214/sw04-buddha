/**
 * An operator's change of a member's number (ADR-0069 #57-3, owner decisions 2026-10-18 and
 * 2026-10-19, ADR-0071): the SQL docs/OPERATIONS.md gives, verbatim, and what it does when run as
 * buddha_app the way the doc runs it — psql, BEGIN, the three statements, then the COMMIT or
 * ROLLBACK the doc's result table gives for what they returned, with psql's variables written in.
 * The account lookup that comes before any confirmation SMS (step 1) and the read-only check
 * before a refused change is tried again are run the same way. The keyed hash of the new number
 * comes from the API's phone-hash CLI there; here any 64-hex value stands for it (this package
 * has no key). Skips the database part when TEST_* are unset.
 */
import { readFileSync } from 'node:fs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Client, type DatabaseError, type QueryResult } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OPERATOR_ACCOUNT_LOOKUP_SQL,
  OPERATOR_NUMBER_HOLDER_SQL,
  OPERATOR_PHONE_CHANGE_SQL,
} from './phone-change.js';
import { phoneVerifications, startGrantNumbers } from './schema/index.js';
import { cancelStartGrant, payStartGrant, recordStartGrant } from './start-grants.js';
import {
  createPhoneVerification,
  createStartGrant,
  createUser,
  randomPhone,
  randomPhoneHash,
} from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';

const OPERATIONS = readFileSync(new URL('../../../docs/OPERATIONS.md', import.meta.url), 'utf8');

/** The index a waiting grant of another account refuses the INSERT with (owner, 2026-10-19). */
const LIVE_NUMBER = 'start_grant_numbers_phone_hash_live_idx';

/** The psql variables a statement uses, `:'name'`. */
function variablesOf(text: string): string[] {
  return [...new Set([...text.matchAll(/:'(\w+)'/g)].map((m) => m[1]!))].sort();
}

/** The doc's text from one bold heading to the next given one. */
function sectionOf(from: string, to: string): string {
  const start = OPERATIONS.indexOf(from);
  const end = OPERATIONS.indexOf(to, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return OPERATIONS.slice(start, end);
}

interface Held {
  this_account: boolean;
  source: string;
  paid: boolean;
  has_grant: boolean;
}

const STATEMENTS = ['update', 'insert', 'select'] as const;

/** What the three statements returned: a refusal (a statement failed), or the counts and rows. */
type Outcome =
  | {
      refused: {
        at: (typeof STATEMENTS)[number];
        code: string | undefined;
        constraint: string | undefined;
      };
    }
  | { updated: number | null; inserted: number | null; held: Held[] };

/** The rows of step 5's result table: what psql shows, what it means, what the operator does. */
const RESULT_ROWS = (() => {
  const header = /^\| 결과 +\| 뜻 +\| 다음 +\|$/m.exec(OPERATIONS);
  if (header === null) throw new Error('docs/OPERATIONS.md: no result table (결과 | 뜻 | 다음)');
  const rows: { result: string; next: string }[] = [];
  for (const line of OPERATIONS.slice(header.index).split('\n').slice(2)) {
    if (!line.startsWith('|')) break;
    const [result, , next, ...rest] = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (next === undefined || rest.length > 0) throw new Error(`not three cells: ${line}`);
    rows.push({ result: result!, next });
  }
  return rows;
})();

/**
 * Whether a row's 결과 cell describes an outcome: every condition the cell states holds — the
 * failing statement and its constraint, or `UPDATE n`, `INSERT 0 n`, 한 줄 / 줄 없음 and the
 * last row's columns. A condition the cell does not state is not looked at.
 */
function describes(cell: string, outcome: Outcome): boolean {
  const error = /^`(UPDATE|INSERT)`에서 오류\(23505 `(\w+)`\)$/.exec(cell);
  if ('refused' in outcome) {
    const { at, code, constraint } = outcome.refused;
    return (
      error !== null &&
      error[1]!.toLowerCase() === at &&
      code === '23505' &&
      error[2] === constraint
    );
  }
  if (error) return false;
  const count = (pattern: RegExp) => {
    const match = pattern.exec(cell);
    return match ? Number(match[1]) : undefined;
  };
  const updated = count(/`UPDATE (\d+)`/);
  const inserted = count(/`INSERT 0 (\d+)`/);
  const rows = cell.includes('한 줄') ? 1 : cell.includes('줄 없음') ? 0 : undefined;
  if (updated !== undefined && updated !== outcome.updated) return false;
  if (inserted !== undefined && inserted !== outcome.inserted) return false;
  if (rows !== undefined && rows !== outcome.held.length) return false;
  for (const column of ['this_account', 'paid', 'has_grant'] as const) {
    const flag = new RegExp(`\`${column}\` = \`([tf])\``).exec(cell);
    if (flag && outcome.held[0]?.[column] !== (flag[1] === 't')) return false;
  }
  return true;
}

/** The one row of the doc's result table for an outcome, and how it says to end the transaction. */
function docRowFor(outcome: Outcome) {
  const rows = RESULT_ROWS.filter((row) => describes(row.result, outcome));
  expect(rows, `rows of the doc's result table for ${JSON.stringify(outcome)}`).toHaveLength(1);
  const end = /^`(COMMIT|ROLLBACK);`/.exec(rows[0]!.next)?.[1] as 'COMMIT' | 'ROLLBACK' | undefined;
  expect(end, rows[0]!.next).toBeDefined();
  return { next: rows[0]!.next, end: end! };
}

/** What the change returns for the refusal of a number another account's waiting grant holds. */
const REFUSED_WAITING = {
  refused: { at: 'insert', code: '23505', constraint: LIVE_NUMBER },
  commit: 'ROLLBACK',
} as const;

/**
 * What the three statements return for an account with no grant moved onto a number another
 * account's waiting grant holds: the SQL refuses nothing (there is no row to add), the last row
 * shows it.
 */
const NO_GRANT_ON_WAITING = {
  updated: 1,
  inserted: 0,
  held: [{ this_account: false, source: 'grant', paid: false, has_grant: false }],
};

describe('the operator phone change (docs/OPERATIONS.md)', () => {
  it('is the SQL the operations doc gives, verbatim', () => {
    expect(OPERATIONS).toContain(['```sql', 'BEGIN;', OPERATOR_PHONE_CHANGE_SQL].join('\n'));
    expect(OPERATIONS).toContain(
      ['```sql', "\\set sender 'member@example.com'", OPERATOR_ACCOUNT_LOOKUP_SQL, '```'].join(
        '\n',
      ),
    );
    expect(OPERATIONS).toContain(['```sql', OPERATOR_NUMBER_HOLDER_SQL, '```'].join('\n'));
  });

  it('names its psql variables and nothing else', () => {
    expect(variablesOf(OPERATOR_PHONE_CHANGE_SQL)).toEqual(['new_hash', 'new_phone', 'user_id']);
    expect(variablesOf(OPERATOR_ACCOUNT_LOOKUP_SQL)).toEqual(['sender']);
    expect(variablesOf(OPERATOR_NUMBER_HOLDER_SQL)).toEqual(['new_hash']);
  });

  it('looks the sender’s account up in step 1, before the confirmation SMS goes out', () => {
    // Owner decision 2026-10-19 answer 1: only a request from the account's sign-up email. The
    // lookup comes first, so no SMS goes to a number named by an address that is no member's.
    const step1 = sectionOf('**1. 요청 확인.**', '**2. 셸.**');
    const lookup = step1.indexOf(OPERATOR_ACCOUNT_LOOKUP_SQL);
    expect(lookup).toBeGreaterThan(-1);
    expect(step1.indexOf('확인 문자를 보내')).toBeGreaterThan(lookup);
    // Step 4 only connects: the account was found in step 1.
    expect(sectionOf('**4. psql.**', '**5. ')).not.toContain('FROM "user"');
  });

  it('says COMMIT or ROLLBACK on every row of its result table, which states what it matches', () => {
    expect(RESULT_ROWS.length).toBeGreaterThan(0);
    for (const row of RESULT_ROWS) {
      expect(row.next, row.result).toMatch(/^`(COMMIT|ROLLBACK);`/);
      expect(row.result).toMatch(/`(UPDATE|INSERT)( \d+|`에서 오류)/);
    }
  });

  it('rolls back both refusals of a waiting grant’s number, and tries them again from step 1', () => {
    // Owner decision 2026-10-19 answer 2, for an account with a grant (the SQL refuses it) and
    // without one (the operator does, off the last row: ADR-0071 7-26). A retry asks and confirms
    // the number again: the confirmation taken before the refusal is not reused (7-28).
    for (const outcome of [REFUSED_WAITING, NO_GRANT_ON_WAITING]) {
      const row = docRowFor(outcome);
      expect(row.end).toBe('ROLLBACK');
      expect(row.next).toContain('1단계부터 다시');
    }
    expect(sectionOf('**거절된 변경을 다시 할 때.**', '```sql')).toContain('1단계부터 다시');
    expect(sectionOf('**하지 않는 것.**', '**로컬.**')).toContain('1단계부터 다시');
    // The member is told the number got the start Coin only when it did (2026-10-19 answer 3).
    const paid = {
      ...NO_GRANT_ON_WAITING,
      held: [{ ...NO_GRANT_ON_WAITING.held[0]!, paid: true }],
    };
    expect(docRowFor(paid).end).toBe('COMMIT');
    expect(docRowFor(paid).next).toContain('이미 시작 Coin을 받아');
    expect(docRowFor(NO_GRANT_ON_WAITING).next).not.toContain('이미 시작 Coin을 받아');
  });

  it('turns psql’s ON_ERROR_ROLLBACK off just before it, so a refusal aborts it all', () => {
    // The variables' block, one sentence, then the transaction: with ON_ERROR_ROLLBACK on, psql
    // would undo the refused INSERT alone and the COMMIT would keep the number without its record.
    expect(OPERATIONS).toMatch(/\\set ON_ERROR_ROLLBACK off\n```\n\n[^\n]+\n\n```sql\nBEGIN;\n/);
  });
});

describe.skipIf(!hasTestDb())('the operator phone change (integration)', () => {
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

  interface Vars {
    user_id: string;
    new_phone: string;
    new_hash: string;
  }

  /** The connection the operator's psql stands for, named so a test can see it wait. */
  const PSQL = 'buddha-test-psql';

  /** A statement of the doc's with psql's `:'name'` written in as literals (the test's own values). */
  function withVariables(text: string, vars: Record<string, string>): string {
    return text.replace(/:'(\w+)'/g, (_, name: string) => {
      const value = vars[name];
      if (value === undefined) throw new Error(`no value for :'${name}'`);
      return `'${value.replaceAll("'", "''")}'`;
    });
  }

  /** The doc's three statements, the variables written in. */
  function statementsOf(vars: Vars): string[] {
    const text = withVariables(OPERATOR_PHONE_CHANGE_SQL, { ...vars });
    const statements = text
      .split(/;\n/)
      .map((statement) => statement.replace(/;$/, '').trim())
      .filter(Boolean);
    expect(statements).toHaveLength(STATEMENTS.length);
    return statements;
  }

  /** A read-only statement of the doc's, run as the operator does: psql as buddha_app. */
  async function read<Row>(text: string, vars: Record<string, string>): Promise<Row[]> {
    const client = new Client({ connectionString: testDbUrls()!.appUrl });
    await client.connect();
    try {
      return (await client.query(withVariables(text, vars))).rows as Row[];
    } finally {
      await client.end();
    }
  }

  /** Step 1's lookup of the account a request's sender address belongs to. */
  async function lookup(sender: string) {
    return read<{ id: string; verified: boolean }>(OPERATOR_ACCOUNT_LOOKUP_SQL, { sender });
  }

  /** The check before a refused change is tried again: whether the number's grant is settled. */
  async function holderOf(newHash: string) {
    return read<{ paid: boolean }>(OPERATOR_NUMBER_HOLDER_SQL, { new_hash: newHash });
  }

  /**
   * Runs the doc's SQL as the operator does in psql with ON_ERROR_ROLLBACK off: on a connection of
   * its own as buddha_app, BEGIN, the three statements, then what the doc's result table says for
   * what they returned. When they all go through, that is the one row of the table that matches
   * the two row counts and the final query's rows, and its COMMIT or ROLLBACK: it returns those
   * and `next`, the one it ran. When one fails, psql goes on to the next, which the aborted
   * transaction refuses (25P02); the table's row for that failure says ROLLBACK, and a COMMIT
   * typed instead answers ROLLBACK too, which is what it sends: then it returns which statement
   * failed, how, and that ROLLBACK — nothing was kept, whatever the operator typed.
   */
  async function change(vars: Vars) {
    const client = new Client({ connectionString: testDbUrls()!.appUrl, application_name: PSQL });
    await client.connect();
    try {
      await client.query('BEGIN');
      const results: QueryResult[] = [];
      const failures: { at: (typeof STATEMENTS)[number]; error: DatabaseError }[] = [];
      for (const [index, statement] of statementsOf(vars).entries()) {
        try {
          results.push(await client.query(statement));
        } catch (error) {
          failures.push({ at: STATEMENTS[index]!, error: error as DatabaseError });
        }
      }
      const [first, ...rest] = failures;
      if (first === undefined) {
        const [update, insert, held] = results;
        const outcome = {
          updated: update!.rowCount,
          inserted: insert!.rowCount,
          held: held!.rows as Held[],
        };
        const { end } = docRowFor(outcome);
        expect((await client.query(end)).command).toBe(end);
        return { ...outcome, next: end };
      }
      const refused = { at: first.at, code: first.error.code, constraint: first.error.constraint };
      expect(docRowFor({ refused }).end).toBe('ROLLBACK');
      const commit = (await client.query('COMMIT')).command;
      expect(rest.map((failure) => failure.error.code)).toEqual(rest.map(() => '25P02'));
      expect(rest).toHaveLength(STATEMENTS.length - 1 - STATEMENTS.indexOf(first.at));
      return { refused, commit };
    } finally {
      await client.end();
    }
  }

  async function phoneOf(userId: string) {
    const [row] = await t.db
      .select({ phone: phoneVerifications.phone })
      .from(phoneVerifications)
      .where(eq(phoneVerifications.userId, userId));
    return row?.phone;
  }

  /** A later account verifying a number: what recording its grant answers. */
  async function laterAccountOn(phoneHash: string) {
    const { user } = await createUser(t.db);
    await createPhoneVerification(t.db, { userId: user.id });
    return t.db.transaction((tx) => recordStartGrant(tx, user.id, phoneHash));
  }

  /** The live rows holding a number: which grant holds it now, if any. */
  async function liveHolders(phoneHash: string) {
    return t.db
      .select({ grantId: startGrantNumbers.grantId })
      .from(startGrantNumbers)
      .where(and(eq(startGrantNumbers.phoneHash, phoneHash), isNull(startGrantNumbers.releasedAt)));
  }

  /** The hashes recorded for a grant, live or released. */
  async function numbersOf(grantId: string) {
    const rows = await t.db
      .select({ phoneHash: startGrantNumbers.phoneHash })
      .from(startGrantNumbers)
      .where(eq(startGrantNumbers.grantId, grantId));
    return rows.map((row) => row.phoneHash).sort();
  }

  /** What a withdrawal does to the start Coin and the number (#140): cancel, delete the record. */
  async function withdraw(userId: string) {
    return t.db.transaction(async (tx) => {
      const cancelled = await cancelStartGrant(tx, userId);
      await tx.delete(phoneVerifications).where(eq(phoneVerifications.userId, userId));
      return cancelled;
    });
  }

  /** Pays a waiting grant, as the worker does once the amount is set. */
  async function pay(grantId: string) {
    return t.db.transaction((tx) => payStartGrant(tx, grantId, () => Promise.resolve(100n)));
  }

  /**
   * Y's grant waits, holding N; an operator moved Y off N, so N is free in `phone_verifications`
   * but still Y's grant's number (owner decision 2026-10-18, answer 3) — the number a member can
   * then ask for.
   */
  async function waitingHolder() {
    const { user: y } = await createUser(t.db);
    const n = randomPhoneHash();
    const grant = await createStartGrant(t.db, { userId: y.id, phoneHash: n });
    const phone = (await phoneOf(y.id))!;
    expect(
      await change({ user_id: y.id, new_phone: randomPhone(), new_hash: randomPhoneHash() }),
    ).toMatchObject({ updated: 1, inserted: 1 });
    return { y, grant, n, phone };
  }

  it('changes the number of an account that got its start Coin and records the new one too', async () => {
    const { user } = await createUser(t.db);
    const oldHash = randomPhoneHash();
    const grant = await createStartGrant(t.db, {
      userId: user.id,
      phoneHash: oldHash,
      amountCoin: 100n,
    });
    const newPhone = randomPhone();
    const newHash = randomPhoneHash();
    expect(await change({ user_id: user.id, new_phone: newPhone, new_hash: newHash })).toEqual({
      updated: 1,
      inserted: 1,
      held: [{ this_account: true, source: 'operator', paid: true, has_grant: true }],
      next: 'COMMIT',
    });
    expect(await phoneOf(user.id)).toBe(newPhone);
    const numbers = await t.db
      .select()
      .from(startGrantNumbers)
      .where(eq(startGrantNumbers.grantId, grant.id));
    expect(numbers.map((n) => [n.phoneHash, n.source]).sort()).toEqual(
      [
        [oldHash, 'grant'],
        [newHash, 'operator'],
      ].sort(),
    );
    // Neither number gets the start Coin again on a later account.
    expect(await laterAccountOn(newHash)).toEqual({ outcome: 'number_already_used' });
    expect(await laterAccountOn(oldHash)).toEqual({ outcome: 'number_already_used' });
    // Run twice (a retried session): nothing more is recorded.
    expect(
      await change({ user_id: user.id, new_phone: newPhone, new_hash: newHash }),
    ).toMatchObject({ updated: 1, inserted: 0, next: 'COMMIT' });
  });

  it('runs again on, and reverts to, a number its own waiting grant holds: nothing more recorded', async () => {
    // The grant waits for the amount, so `h.granted_at IS NOT NULL` does not skip its own row:
    // only `h.id = g.id` keeps the INSERT from adding the number again (and failing, 23505).
    const { user } = await createUser(t.db);
    const oldHash = randomPhoneHash();
    const grant = await createStartGrant(t.db, { userId: user.id, phoneHash: oldHash });
    const oldPhone = (await phoneOf(user.id))!;
    const newHash = randomPhoneHash();
    const vars = { user_id: user.id, new_phone: randomPhone(), new_hash: newHash };
    expect(await change(vars)).toMatchObject({ updated: 1, inserted: 1, next: 'COMMIT' });
    // The same change again (a dropped session, run once more).
    expect(await change(vars)).toEqual({
      updated: 1,
      inserted: 0,
      held: [{ this_account: true, source: 'operator', paid: false, has_grant: true }],
      next: 'COMMIT',
    });
    expect(await phoneOf(user.id)).toBe(vars.new_phone);
    // The member asks for the old number back: the grant's own number.
    expect(await change({ user_id: user.id, new_phone: oldPhone, new_hash: oldHash })).toEqual({
      updated: 1,
      inserted: 0,
      held: [{ this_account: true, source: 'grant', paid: false, has_grant: true }],
      next: 'COMMIT',
    });
    expect(await phoneOf(user.id)).toBe(oldPhone);
    expect(await numbersOf(grant.id)).toEqual([oldHash, newHash].sort());
  });

  it('records the new number beside a waiting grant, freed with it if the account withdraws', async () => {
    const { user } = await createUser(t.db);
    const oldHash = randomPhoneHash();
    await createStartGrant(t.db, { userId: user.id, phoneHash: oldHash });
    const newHash = randomPhoneHash();
    expect(await change({ user_id: user.id, new_phone: randomPhone(), new_hash: newHash })).toEqual(
      {
        updated: 1,
        inserted: 1,
        held: [{ this_account: true, source: 'operator', paid: false, has_grant: true }],
        next: 'COMMIT',
      },
    );
    await t.db.transaction((tx) => cancelStartGrant(tx, user.id));
    expect((await laterAccountOn(newHash)).outcome).toBe('recorded');
    expect((await laterAccountOn(oldHash)).outcome).toBe('recorded');
  });

  it('records nothing for an account with no grant yet: its grant records the new number', async () => {
    const { user } = await createUser(t.db);
    await createPhoneVerification(t.db, { userId: user.id });
    const newPhone = randomPhone();
    const newHash = randomPhoneHash();
    expect(await change({ user_id: user.id, new_phone: newPhone, new_hash: newHash })).toEqual({
      updated: 1,
      inserted: 0,
      held: [],
      next: 'COMMIT',
    });
    expect(await phoneOf(user.id)).toBe(newPhone);
    const recorded = await t.db.transaction((tx) => recordStartGrant(tx, user.id, newHash));
    expect(recorded.outcome).toBe('recorded');
  });

  it('leaves a number that another, paid grant holds as it is', async () => {
    // The new number got the start Coin with an account that has since withdrawn.
    const { user: earlier } = await createUser(t.db);
    const takenHash = randomPhoneHash();
    await createStartGrant(t.db, { userId: earlier.id, phoneHash: takenHash, amountCoin: 100n });
    await t.db.delete(phoneVerifications).where(eq(phoneVerifications.userId, earlier.id));
    const { user } = await createUser(t.db);
    await createStartGrant(t.db, { userId: user.id, amountCoin: 100n });
    expect(
      await change({ user_id: user.id, new_phone: randomPhone(), new_hash: takenHash }),
    ).toEqual({
      updated: 1,
      inserted: 0,
      held: [{ this_account: false, source: 'grant', paid: true, has_grant: true }],
      next: 'COMMIT',
    });
  });

  it('refuses a number another account’s waiting grant holds, then takes it once that grant is paid', async () => {
    const { grant: yGrant, n, phone } = await waitingHolder();
    // X, who got the start Coin, asks for N: the INSERT fails, and the COMMIT keeps nothing.
    const { user: x } = await createUser(t.db);
    const xGrant = await createStartGrant(t.db, { userId: x.id, amountCoin: 100n });
    const xPhone = await phoneOf(x.id);
    const xNumbers = await numbersOf(xGrant.id);
    const vars = { user_id: x.id, new_phone: phone, new_hash: n };
    expect(await change(vars)).toEqual(REFUSED_WAITING);
    expect(await phoneOf(x.id)).toBe(xPhone);
    expect(await numbersOf(xGrant.id)).toEqual(xNumbers);
    expect(await liveHolders(n)).toEqual([{ grantId: yGrant.id }]);
    // Again while Y's grant waits: the same refusal, nothing changed — the read-only check before
    // a retry says so without trying.
    expect(await holderOf(n)).toEqual([{ paid: false }]);
    expect(await change(vars)).toEqual(REFUSED_WAITING);
    // Once the amount is set and Y's grant is paid, N counts for good: the change goes through
    // and records nothing more (owner decision 2026-10-19, answer 2).
    expect((await pay(yGrant.id)).outcome).toBe('granted');
    expect(await holderOf(n)).toEqual([{ paid: true }]);
    expect(await change(vars)).toEqual({
      updated: 1,
      inserted: 0,
      held: [{ this_account: false, source: 'grant', paid: true, has_grant: true }],
      next: 'COMMIT',
    });
    expect(await phoneOf(x.id)).toBe(phone);
    expect(await liveHolders(n)).toEqual([{ grantId: yGrant.id }]);
  });

  it('takes a refused number once the waiting grant is cancelled, and keeps it held for this account', async () => {
    const { y, n, phone } = await waitingHolder();
    const { user: x } = await createUser(t.db);
    const xGrant = await createStartGrant(t.db, { userId: x.id });
    const vars = { user_id: x.id, new_phone: phone, new_hash: n };
    expect(await change(vars)).toEqual(REFUSED_WAITING);
    // Y withdraws while its grant waits (answer 2 of 2026-10-18): N is free, and the change now
    // records it for X's grant.
    expect((await withdraw(y.id)).outcome).toBe('cancelled');
    expect(await holderOf(n)).toEqual([]);
    expect(await change(vars)).toEqual({
      updated: 1,
      inserted: 1,
      held: [{ this_account: true, source: 'operator', paid: false, has_grant: true }],
      next: 'COMMIT',
    });
    expect(await liveHolders(n)).toEqual([{ grantId: xGrant.id }]);
    // X is paid and withdraws: N stays a number that received the start Coin — the next account
    // on it gets nothing, which the refusal is there for.
    expect((await pay(xGrant.id)).outcome).toBe('granted');
    expect((await withdraw(x.id)).outcome).toBe('granted');
    expect(await laterAccountOn(n)).toEqual({ outcome: 'number_already_used' });
    expect(await liveHolders(n)).toEqual([{ grantId: xGrant.id }]);
  });

  it('waits on a cancellation freeing the number meanwhile, and is refused when it rolls back', async () => {
    const { y, n, phone } = await waitingHolder();
    const { user: x } = await createUser(t.db);
    const xGrant = await createStartGrant(t.db, { userId: x.id, amountCoin: 100n });
    const vars = { user_id: x.id, new_phone: phone, new_hash: n };

    /** Y's withdrawal, cancelled and held open until `end`; then committed or rolled back. */
    function withdrawal(ending: 'commit' | 'rollback') {
      let end!: () => void;
      const ended = new Promise<void>((resolve) => (end = resolve));
      let cancelled!: () => void;
      const held = new Promise<void>((resolve) => (cancelled = resolve));
      const done = t.db
        .transaction(async (tx) => {
          expect((await cancelStartGrant(tx, y.id)).outcome).toBe('cancelled');
          await tx.delete(phoneVerifications).where(eq(phoneVerifications.userId, y.id));
          cancelled();
          await ended;
          if (ending === 'rollback') tx.rollback();
        })
        .then(
          () => 'committed',
          () => 'rolled back',
        );
      return { held, end, done };
    }

    /** Whether the psql connection is waiting on a lock (its INSERT, on the withdrawal's rows). */
    async function psqlWaits() {
      for (let attempt = 0; attempt < 250; attempt++) {
        const { rows } = await t.db.execute<{ waiting: number }>(sql`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE application_name = ${PSQL} AND wait_event_type = 'Lock'`);
        if ((rows[0]?.waiting ?? 0) > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    }

    for (const ending of ['rollback', 'commit'] as const) {
      const meanwhile = withdrawal(ending);
      await Promise.race([meanwhile.held, meanwhile.done]);
      const changing = change(vars);
      try {
        expect(await psqlWaits()).toBe(true);
      } finally {
        meanwhile.end();
      }
      if (ending === 'rollback') {
        expect(await meanwhile.done).toBe('rolled back');
        // The grant still waits: refused, as if the withdrawal never was.
        expect(await changing).toEqual(REFUSED_WAITING);
      } else {
        expect(await meanwhile.done).toBe('committed');
        expect(await changing).toEqual({
          updated: 1,
          inserted: 1,
          held: [{ this_account: true, source: 'operator', paid: true, has_grant: true }],
          next: 'COMMIT',
        });
      }
    }
    expect(await liveHolders(n)).toEqual([{ grantId: xGrant.id }]);
  });

  it('tells an account with no grant moved onto a number that got the start Coin: it will get none', async () => {
    const { user: earlier } = await createUser(t.db);
    const takenHash = randomPhoneHash();
    await createStartGrant(t.db, { userId: earlier.id, phoneHash: takenHash, amountCoin: 100n });
    await t.db.delete(phoneVerifications).where(eq(phoneVerifications.userId, earlier.id));
    // Verified, not onboarded yet: no grant record.
    const { user } = await createUser(t.db);
    await createPhoneVerification(t.db, { userId: user.id });
    expect(
      await change({ user_id: user.id, new_phone: randomPhone(), new_hash: takenHash }),
    ).toEqual({
      updated: 1,
      inserted: 0,
      held: [{ this_account: false, source: 'grant', paid: true, has_grant: false }],
      next: 'COMMIT',
    });
    // Its grant (#58) on the new number records nothing.
    const recorded = await t.db.transaction((tx) => recordStartGrant(tx, user.id, takenHash));
    expect(recorded).toEqual({ outcome: 'number_already_used' });
  });

  it('rolls back an account with no grant moved onto a number a waiting grant holds, until it settles', async () => {
    // Owner decision 2026-10-19 answer 2 (ADR-0071 7-26): nobody got the start Coin on N yet, so
    // answer 3's "already got it" would be untrue. The SQL has no row to add for an account with
    // no grant, so no refusal of its own: the doc's row for the last row's `paid` f, `has_grant` f
    // says ROLLBACK, and `change` runs it.
    for (const settle of ['pay', 'withdraw'] as const) {
      const { y, grant: yGrant, n, phone } = await waitingHolder();
      const { user } = await createUser(t.db);
      const { phone: before } = await createPhoneVerification(t.db, { userId: user.id });
      const vars = { user_id: user.id, new_phone: phone, new_hash: n };
      expect(await change(vars)).toEqual({ ...NO_GRANT_ON_WAITING, next: 'ROLLBACK' });
      expect(await phoneOf(user.id)).toBe(before);
      expect(await liveHolders(n)).toEqual([{ grantId: yGrant.id }]);
      expect(await holderOf(n)).toEqual([{ paid: false }]);
      // Once Y's grant is settled the change, asked and confirmed again from step 1, goes through.
      if (settle === 'pay') {
        // Paid: N got the start Coin, and this account gets none on it (answer 3).
        expect((await pay(yGrant.id)).outcome).toBe('granted');
        expect(await holderOf(n)).toEqual([{ paid: true }]);
        expect(await change(vars)).toEqual({
          updated: 1,
          inserted: 0,
          held: [{ this_account: false, source: 'grant', paid: true, has_grant: false }],
          next: 'COMMIT',
        });
        expect(await t.db.transaction((tx) => recordStartGrant(tx, user.id, n))).toEqual({
          outcome: 'number_already_used',
        });
      } else {
        // Y withdrew while its grant waited: N was never paid and is free, so this account's
        // grant records it.
        expect((await withdraw(y.id)).outcome).toBe('cancelled');
        expect(await holderOf(n)).toEqual([]);
        expect(await change(vars)).toEqual({ updated: 1, inserted: 0, held: [], next: 'COMMIT' });
        const recorded = await t.db.transaction((tx) => recordStartGrant(tx, user.id, n));
        expect(recorded.outcome).toBe('recorded');
      }
      expect(await phoneOf(user.id)).toBe(phone);
    }
  });

  it('finds the account a request’s sender address belongs to, and whether it is verified', async () => {
    // Step 1, before any SMS: no row or `verified` f, and the operator stops there.
    const { user: member } = await createUser(t.db, { email: 'member@test.local' });
    await createPhoneVerification(t.db, { userId: member.id });
    const { user: unverified } = await createUser(t.db, { email: 'new@test.local' });
    expect(await lookup('member@test.local')).toEqual([{ id: member.id, verified: true }]);
    // Account emails are stored lower-case; the address as the mail client shows it still finds it.
    expect(await lookup('Member@Test.Local')).toEqual([{ id: member.id, verified: true }]);
    expect(await lookup('new@test.local')).toEqual([{ id: unverified.id, verified: false }]);
    expect(await lookup('nobody@test.local')).toEqual([]);
    // A withdrawn account (#140 deletes its 본인확인 record) is not one to change either.
    await withdraw(member.id);
    expect(await lookup('member@test.local')).toEqual([{ id: member.id, verified: false }]);
  });

  it('changes nothing for an unknown account, and refuses a number another account verified', async () => {
    expect(
      await change({
        user_id: 'no-such-account',
        new_phone: randomPhone(),
        new_hash: randomPhoneHash(),
      }),
    ).toEqual({ updated: 0, inserted: 0, held: [], next: 'ROLLBACK' });
    const { user: a } = await createUser(t.db);
    const { user: b } = await createUser(t.db);
    const verified = await createPhoneVerification(t.db, { userId: a.id });
    await createStartGrant(t.db, { userId: b.id });
    const bPhone = await phoneOf(b.id);
    expect(
      await change({ user_id: b.id, new_phone: verified.phone, new_hash: randomPhoneHash() }),
    ).toEqual({
      refused: { at: 'update', code: '23505', constraint: 'phone_verifications_phone_unique' },
      commit: 'ROLLBACK',
    });
    expect(await phoneOf(b.id)).toBe(bPhone);
  });
});
