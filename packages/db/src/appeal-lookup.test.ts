/**
 * Step 2 of the operator's handling of a sanction appeal (#186, ADR-0084): the read-only lookup
 * docs/OPERATIONS.md gives, verbatim, what the doc says to do with what it returns, and what it
 * returns when run as buddha_app the way the doc runs it — psql, the `sender` variable written in.
 * The account is the one whose current email is exactly the sender's address (owner decision
 * 2026-10-22 답 5, the phone change's lookup), never a card picked out of `/admin/users`' substring
 * search; each action comes with its time and its appeal deadline in KST to the second, which the
 * operator compares with the mailbox's arrival time (답 10) — the screens show the minute only
 * (ADR-0084 6-8). Skips the database part when TEST_* are unset.
 */
import { readFileSync } from 'node:fs';
import {
  adminUserQuerySchema,
  APPEAL_WINDOW_DAYS,
  appealDeadlineOf,
  PAGE_LIMIT_DEFAULT,
} from '@buddha/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OPERATOR_APPEAL_LOOKUP_SQL } from './appeal-lookup.js';
import { OPERATOR_ACCOUNT_LOOKUP_SQL } from './phone-change.js';
import { createModerationAction, createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';
import { splitPsqlStatements, writePsqlVariables } from './test/operator.js';

const OPERATIONS = readFileSync(new URL('../../../docs/OPERATIONS.md', import.meta.url), 'utf8');

/** The doc's text from one marker to the next given one, inside the appeal section. */
function sectionOf(from: string, to: string): string {
  const appeal = OPERATIONS.indexOf('## 제재 이의 처리');
  const start = OPERATIONS.indexOf(from, appeal);
  const end = OPERATIONS.indexOf(to, start);
  expect(appeal).toBeGreaterThan(-1);
  expect(start).toBeGreaterThan(appeal);
  expect(end).toBeGreaterThan(start);
  return OPERATIONS.slice(start, end);
}

const appealSection = () => OPERATIONS.slice(OPERATIONS.indexOf('## 제재 이의 처리'));
const step2 = () => sectionOf('2. **보낸 사람.**', '3. **기한과 횟수.**');
const step3 = () => sectionOf('3. **기한과 횟수.**', '4. **검토.**');

/** A block as the doc writes it inside a list item: every line indented five spaces. */
function inListItem(lines: string[]): string {
  return lines
    .join('\n')
    .split('\n')
    .map((line) => (line === '' ? '' : `     ${line}`))
    .join('\n');
}

/** The psql variables a statement uses, `:'name'`. */
function variablesOf(text: string): string[] {
  return [...new Set([...text.matchAll(/:'(\w+)'/g)].map((m) => m[1]!))].sort();
}

/** An instant as the lookup writes it: KST, to the second, the fraction cut (`to_char`). */
function kstToSecond(at: Date): string {
  const kst = new Date(Math.floor(at.getTime() / 1_000) * 1_000 + 9 * 60 * 60 * 1_000);
  return kst.toISOString().slice(0, 19).replace('T', ' ');
}

interface Row {
  user_id: string;
  action_id: string | null;
  type: string | null;
  acted_kst: string | null;
  deadline_kst: string | null;
  cancelled: boolean;
}

describe('the operator appeal lookup (docs/OPERATIONS.md)', () => {
  it('is the SQL step 2 gives, verbatim', () => {
    expect(step2()).toContain(
      inListItem([
        '```sql',
        "\\set sender 'member@example.com'",
        OPERATOR_APPEAL_LOOKUP_SQL,
        '```',
      ]),
    );
  });

  it('only reads, takes the sender alone, and matches it as the phone change does', () => {
    const statements = splitPsqlStatements(OPERATOR_APPEAL_LOOKUP_SQL);
    expect(statements).toHaveLength(1);
    expect(OPERATOR_APPEAL_LOOKUP_SQL).toMatch(/^SELECT /);
    expect(variablesOf(OPERATOR_APPEAL_LOOKUP_SQL)).toEqual(['sender']);
    // The same judgement as the phone change's step 1 (owner decision 2026-10-22 답 5): the
    // account whose current email is exactly the sender's address, never a substring of it.
    const exact = "WHERE u.email = lower(:'sender')";
    expect(OPERATOR_ACCOUNT_LOOKUP_SQL).toContain(exact);
    expect(OPERATOR_APPEAL_LOOKUP_SQL).toContain(exact);
    expect(OPERATOR_APPEAL_LOOKUP_SQL).not.toMatch(/like/i);
    // The window in hours, not days: exactly APPEAL_WINDOW_DAYS × 24 hours whatever the session's
    // time zone (`interval '14 days'` would follow a daylight-saving change in it).
    expect(OPERATOR_APPEAL_LOOKUP_SQL).toContain(
      `interval '${String(APPEAL_WINDOW_DAYS * 24)} hours'`,
    );
  });

  it('decides the member by that lookup, never by /admin/users’ search', () => {
    const text = step2();
    expect(text).toContain(
      '줄이 없으면 그 주소는 어느 계정의 지금 이메일도 아니므로 확인되지 않은 메일이다',
    );
    expect(text).toContain('`/admin/moderation/users/<user_id>`');
    // Why not the search: the doc gives the reasons, and they are the code's.
    expect(text).toContain('`/admin/users`의 찾기로는 계정을 정하지 않는다');
    expect(text).toContain(`한 번에 ${String(PAGE_LIMIT_DEFAULT)}개씩 최신 계정부터`);
    expect(text).toContain('찾는 말은 100자까지');
    expect(adminUserQuerySchema.safeParse({ q: 'x'.repeat(100) }).success).toBe(true);
    expect(adminUserQuerySchema.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
    // No step looks the account up there.
    expect(appealSection()).not.toMatch(/`\/admin\/users`에서[^.]*찾는다/);
  });

  it('takes the deadline from the lookup to the second, not from a screen’s minute', () => {
    const text = step3();
    expect(text).toContain('2의 조회에서 그 조치의 `deadline_kst`(한국 시간, 초까지)다');
    expect(text).toContain('분까지만 보이고 초를 버린다');
    expect(text).toContain('`Received` 줄');
    // What cannot be told apart goes to the owner, not to a rule of the doc's.
    expect(text).toContain('같은 초라 앞뒤를 정할 수 없으면 어떻게 볼지는 정하지 않았다');
    expect(text).toContain('결과 4의 4');
    // The claim this replaced: the admin card's minute + 14 days as «the same instant».
    expect(appealSection()).not.toContain('같은 순간이다');
  });

  it('turns the member’s 조치한 때 into KST before matching it', () => {
    const text = sectionOf('   - 어느 조치인지:', '   - 기한:');
    expect(text).toContain('회원이 MY 설정에서 고른 시간대');
    expect(text).toContain("'(GMT-4)'처럼 붙는다");
    expect(text).toContain('차이가 붙은 시각은 한국 시간으로 바꿔 견준다');
    expect(text).toContain("'2026. 10. 21. 오전 2:00 (GMT-4)'는 한국 시간 2026-10-21 15:00이다");
    // A time with no marker that pins no single action is the open question, not a guess.
    expect(text).toContain('어느 조치인지 정할 수 없는 이의다');
  });
});

describe.skipIf(!hasTestDb())('the operator appeal lookup (integration)', () => {
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

  /**
   * The lookup as the operator runs it: psql as buddha_app, `sender` written in. `timeZone` sets
   * the session's zone first, which the doc's psql does not — a check that nothing depends on it.
   */
  async function lookup(sender: string, timeZone?: string): Promise<Row[]> {
    const client = new Client({ connectionString: testDbUrls()!.appUrl });
    await client.connect();
    try {
      if (timeZone !== undefined) await client.query(`SET TIME ZONE '${timeZone}'`);
      const result = await client.query(writePsqlVariables(OPERATOR_APPEAL_LOOKUP_SQL, { sender }));
      return result.rows as Row[];
    } finally {
      await client.end();
    }
  }

  it('finds only the account whose current email is the sender, however many contain it', async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const email = `kim-${tag}@example.com`;
    const { user: member } = await createUser(t.db, { email });
    // More newer accounts whose emails contain the address than /admin/users' first page holds.
    for (let i = 0; i <= PAGE_LIMIT_DEFAULT; i++) {
      await createUser(t.db, { email: `a${String(i)}kim-${tag}@example.com` });
    }
    const none = {
      user_id: member.id,
      action_id: null,
      type: null,
      acted_kst: null,
      deadline_kst: null,
      cancelled: false,
    };
    expect(await lookup(email)).toEqual([none]);
    // Account emails are stored lower-case; the sender's address is matched lower-cased.
    expect(await lookup(email.toUpperCase())).toEqual([none]);
    // No account's current email: no row — the mail is unconfirmed.
    expect(await lookup(`im-${tag}@example.com`)).toEqual([]);
    expect(await lookup(`nobody-${tag}@example.com`)).toEqual([]);
  });

  it('finds an address longer than /admin/users’ search takes', async () => {
    const email = `${'x'.repeat(120)}@example.com`;
    expect(adminUserQuerySchema.safeParse({ q: email }).success).toBe(false);
    const { user: member } = await createUser(t.db, { email });
    const rows = await lookup(email);
    expect(rows.map((row) => row.user_id)).toEqual([member.id]);
  });

  it('gives each action its time and deadline in KST to the second, newest first', async () => {
    const { user: operator } = await createUser(t.db, { role: 'admin' });
    const { user: member } = await createUser(t.db, { email: 'member@example.com' });
    const { user: other } = await createUser(t.db);
    // 15:00:45.600 KST: every screen shows 오후 3:00, and the member's card turns at 15:00:45.600
    // fourteen days on.
    const warnedAt = new Date('2026-10-08T06:00:45.600Z');
    const warning = await createModerationAction(t.db, {
      userId: member.id,
      createdBy: operator.id,
      type: 'warning',
      createdAt: warnedAt,
    });
    const clearedAt = new Date('2026-10-09T01:02:03.000Z');
    const cleared = await createModerationAction(t.db, {
      userId: member.id,
      createdBy: operator.id,
      type: 'bio_clear',
      createdAt: clearedAt,
      cancelled: {
        at: new Date('2026-10-10T00:00:00Z'),
        by: operator.id,
        reason: '이의를 받아들임',
      },
    });
    // Another member's action is not this member's.
    await createModerationAction(t.db, { userId: other.id, createdBy: operator.id });

    const rows = await lookup('Member@Example.com');
    expect(rows).toEqual([
      {
        user_id: member.id,
        action_id: cleared.id,
        type: 'bio_clear',
        acted_kst: '2026-10-09 10:02:03',
        deadline_kst: '2026-10-23 10:02:03',
        cancelled: true,
      },
      {
        user_id: member.id,
        action_id: warning.id,
        type: 'warning',
        acted_kst: '2026-10-08 15:00:45',
        deadline_kst: '2026-10-22 15:00:45',
        cancelled: false,
      },
    ]);
    // The deadline the member's card turns at (appealDeadlineOf), to the second.
    expect(rows[1]!.acted_kst).toBe(kstToSecond(warnedAt));
    expect(rows[1]!.deadline_kst).toBe(kstToSecond(appealDeadlineOf(warnedAt)));
    // A mail the mailbox received at 15:00:30 on the last day is in time, though the screens'
    // minute + 14 days (15:00) is already behind it.
    expect('2026-10-22 15:00:30' < rows[1]!.deadline_kst!).toBe(true);
    expect('2026-10-22 15:00:46' > rows[1]!.deadline_kst!).toBe(true);
  });

  it('counts the window in hours, whatever the session’s time zone', async () => {
    const { user: operator } = await createUser(t.db, { role: 'admin' });
    const { user: member } = await createUser(t.db, { email: 'dst@example.com' });
    // New York leaves daylight saving on 2026-11-01, inside this window: 14 days there are 337
    // hours, and the member's card turns after 336.
    const at = new Date('2026-10-25T12:00:00Z');
    await createModerationAction(t.db, {
      userId: member.id,
      createdBy: operator.id,
      createdAt: at,
    });
    const [row] = await lookup('dst@example.com', 'America/New_York');
    expect(row!.acted_kst).toBe('2026-10-25 21:00:00');
    expect(row!.deadline_kst).toBe(kstToSecond(appealDeadlineOf(at)));
    expect(row!.deadline_kst).toBe('2026-11-08 21:00:00');
  });
});
