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
const DECISIONS = readFileSync(new URL('../../../docs/DECISIONS.md', import.meta.url), 'utf8');

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

  it('answers unconfirmed mail with the owner’s one sentence, the same whoever sent it', () => {
    // Owner decision 2026-10-22 (2차) 1: the sentence that names neither the account nor an action,
    // to the sender's address — it replaced the first draft's proposal.
    const text = step2();
    expect(text).toContain(
      inListItem(['```text', '이의는 가입한 이메일로 보낸 메일만 받습니다.', '```']),
    );
    expect(text).toContain('오너 결정 2026-10-22 (2차) 1');
    expect(appealSection()).not.toContain('이 메일로는 이의를 받을 수 없습니다');
    // The same sentence whoever sent it (답 5): no second reply that would tell an account's own
    // address from another, so step 2 gives one text and says it is the one in every case.
    expect(text).toContain(
      '회신은 계정이 있는지(그리고 조치가 있는지) 드러내지 않는 아래의 한 문장만이고, 어느 경우든 같다',
    );
    expect(text.match(/```text/g)).toHaveLength(1);
  });

  it('leaves to the owner the member whose own address fails the sender check', () => {
    // From the account's current email yet failing authentication, a resend fails the same way:
    // the sentence tells that member nothing to do, and what may be done is the owner's to say.
    const text = sectionOf('   - 확인되지 않은 메일:', '3. **기한과 횟수.**');
    expect(text).toContain(
      '그 계정의 지금 이메일에서 왔는데 발신 인증을 통과하지 못한 메일도 이 문장을 받는다',
    );
    expect(text).toContain('이 문장으로는 달리 할 것을 알 수 없다');
    expect(text).toContain('오너에게 묻는다(ADR-0084 결과 4의 8). 그 답 전에는 위 그대로다.');
  });

  it('asks back an appeal whose action it cannot tell, without using up that action’s one', () => {
    // (2차) 2: asking back is no appeal received; the member resends within the deadline, and the
    // mail that comes back is a new one, from step 2 and by its own arrival time.
    const text = sectionOf('   - 되묻기:', '   - 기한:');
    expect(text).toContain('어느 조치인지 정할 수 없는 이의는 검토하지 않고 아래의 글로 되묻는다');
    expect(text).toContain('되묻는 것은 그 조치의 한 번을 쓰지 않는다');
    expect(text).toContain('그 조치의 기한 안에 다시 보내야');
    expect(text).toContain('그 메일이 메일함에 도착한 시각으로 본다');
    expect(text).toContain(
      inListItem([
        '```text',
        '어느 조치인지(조치의 종류와 조치한 때)를 적어 그 조치의 이의 기한 안에 다시 보내 주세요.',
        '```',
      ]),
    );
  });

  it('takes to the owner, rather than asking back again, a resend that still names no one action', () => {
    // The ask-back takes only the type and the time the member already gave: several actions of a
    // type in one minute (hides of a member's posts and comments — all '숨김' at the same minute on
    // the card), or a time copied without its '(GMT…)', come back the same. Asked back again, the
    // member loops until the deadline; the doc sends that to the owner instead (ADR-0084 결과 4의 6).
    const text = sectionOf('   - 되묻기:', '   - 기한:');
    expect(text).toContain('같은 종류의 조치를 같은 분에 여럿 받은 경우다');
    expect(text).toContain("차이('(GMT…)')를 빼고 옮긴 시각도 그렇다");
    expect(text).toContain(
      '되물은 뒤 다시 온 메일이 이렇게 여전히 조치 하나를 정하지 못하면, 같은 글로 다시 되묻지 않고 오너에게 묻는다',
    );
    expect(text).toContain('그 조치의 대상(글의 제목이나 댓글의 첫 줄)');
    expect(text).toContain('(ADR-0084 결과 4의 6)');
    // An ask-back sent at or after the deadline leaves no resend on time: the owner's to say.
    expect(text).toContain('기한 가까이 온 메일을 기한이 지난 뒤에 되물으면');
    expect(text).toContain('(ADR-0084 결과 4의 7)');
  });

  it('answers an appeal it does not take with its reason, one sentence, and counts only the ones taken', () => {
    // (2차) 2: a cancelled action, a passed deadline, one appealed already — that reason alone, in
    // the order the member's card speaks (취소됨 with no deadline, then 이의 기한이 지났습니다.).
    const text = sectionOf('   - 받지 않는 것:', '4. **검토.**');
    const sentences = [
      '이 조치는 이미 취소되었습니다.',
      '이의 기한이 지났습니다.',
      '이 조치에는 이미 이의를 받았습니다.',
    ];
    expect(text).toContain('받지 않고, 그 까닭을 아래의 한 문장으로 회신한다');
    const at = sentences.map((sentence) => text.indexOf(inListItem(['```text', sentence, '```'])));
    for (const index of at) expect(index).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain('여럿에 해당하면 이 차례에서 앞의 것 하나다');
    // What counts as the action's one appeal: taken for review — never the mail step 2 could not
    // confirm, nor the one asked back.
    expect(text).toContain('4의 검토로 넘긴 이의만 센다');
    expect(text).toContain('확인되지 않은 메일(2), 되물은 메일(위)');
    // Nothing about these replies is left undecided in the doc.
    expect(appealSection()).not.toContain('무엇을 회신할지는 정하지 않았다');
  });

  it('marks an appeal taken by its account and action, and looks for that mark, not the sender', () => {
    // The app keeps no appeal, and a mail under review looks like one nobody has read: the mark
    // goes on before the review, and the next appeal is checked by `user_id` and `action_id` —
    // the account's email changes in MY 설정 and the database keeps no earlier one.
    const text = sectionOf('   - 받지 않는 것:', '4. **검토.**');
    expect(text).toContain(
      '검토를 시작하기 전에 그 메일에 2의 조회의 `user_id`와 `action_id`를 함께 적은 표시',
    );
    expect(text).toContain(
      '`user_id`와 `action_id`로 메일함에서 그 표시를 찾는다 — 보낸 주소로 찾지 않는다',
    );
    expect(text).toContain('계정의 이메일은 MY 설정에서 바뀌고(ADR-0023)');
    expect(text).toContain('표시가 있으면 6의 회신이 아직 없어도 받은 이의다');
    expect(text).toContain('이 표시와 찾기는 설계 제안이다(ADR-0084 6-8, 결과 4의 9)');
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

/** ADR-0084, from its heading to the next ADR's or the end of the file. */
function adr0084(): string {
  const start = DECISIONS.indexOf('\n## ADR-0084 ');
  expect(start).toBeGreaterThan(-1);
  const end = DECISIONS.indexOf('\n## ADR-', start + 1);
  return DECISIONS.slice(start, end === -1 ? undefined : end);
}

/** ADR-0084's 결과 4 — what is asked of the owner — item by item, by its number. */
function ownerQuestions(): Map<number, string> {
  const adr = adr0084();
  const start = adr.indexOf('**4. 오너에게 물을 것.**');
  const end = adr.indexOf('**5. 알려진 한계', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Map(
    [...adr.slice(start, end).matchAll(/^(\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]!]),
  );
}

describe('what the appeal procedure leaves to the owner (ADR-0084 결과 4)', () => {
  it('asks the owner each question the procedure sends there, under the number it cites', () => {
    const questions = ownerQuestions();
    const cited = [...appealSection().matchAll(/ADR-0084 (?:6-8, )?결과 4의 (\d+)/g)].map((m) =>
      Number(m[1]),
    );
    // The open cases: the deadline's same second (4), the ask-back that cannot help (6), the
    // ask-back sent after the deadline (7), the own address failing the sender check (8), and how
    // an appeal taken is found again (9).
    expect([...new Set(cited)].sort((a, b) => a - b)).toEqual([4, 6, 7, 8, 9]);
    const about: Record<number, string> = {
      4: '같은 초라 앞뒤를 정할 수 없는 메일',
      6: '같은 종류의 조치 여럿이 같은 분에 있으면',
      7: '기한 뒤에 되물은 메일',
      8: '지금 이메일에서 보냈는데 발신 인증을 통과하지 못하는 회원',
      9: '`user_id`·`action_id`를 함께 적은 표시',
    };
    for (const n of cited) expect(questions.get(n)).toContain(about[n]);
  });

  it('cites the second round’s answer 3 as (2차) and the second commit’s item 3 as its', () => {
    const adr = adr0084();
    // '그 계정의 내역에만' is (2차) 답 3, the placeholder-email line; a bare 답 3 is the first
    // round's, the banners.
    const quoted = [...adr.matchAll(/답 3 '그 계정의 내역에만'/g)].map((m) => m.index);
    expect(quoted.length).toBeGreaterThan(0);
    for (const at of quoted) expect(adr.slice(at - '(2차) '.length, at)).toBe('(2차) ');
    // The item that asked for the line '안내 아래에' was da19ec8's; this ADR's 결과 4 starts at 4.
    expect(adr).toContain("둘째 커밋(da19ec8) 결과 4의 3이 '안내 아래에'로 물은 자리");
    expect(adr).not.toContain("(결과 4의 3이 '안내 아래에'");
    expect(ownerQuestions().has(3)).toBe(false);
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
