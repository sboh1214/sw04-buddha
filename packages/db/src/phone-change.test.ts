/**
 * An operator's change of a member's number (ADR-0069 #57-3, owner decisions 2026-10-18,
 * 2026-10-19, 2026-10-19 3차 and 4차, ADR-0071): the SQL docs/OPERATIONS.md gives, verbatim, and
 * what it does when run as buddha_app the way the doc runs it — psql, BEGIN, the statements, then
 * the COMMIT or ROLLBACK the doc's result table gives for what they returned, with psql's variables
 * written in — and what it carries along: the account's likes, its own and those it inherited on
 * its old number, onto the new number (#49, owner decisions 2026-10-20 and 2026-10-21, ADR-0076).
 * The account lookup and the pre-check of the new number that come before any confirmation SMS
 * (step 1), and the read of the old number (step 3), are run the same way. The keyed hashes of
 * the new and the old number and the confirmation code come from the API's phone-hash CLI there
 * (its own tests, apps/api/src/identity/phone-hash-operator.test.ts); here any 64-hex value stands
 * for a hash (this package has no key). Skips the database part when TEST_* are unset.
 */
import { readFileSync } from 'node:fs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Client, type DatabaseError, type QueryResult } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OPERATOR_ACCOUNT_LOOKUP_SQL,
  OPERATOR_CURRENT_NUMBER_SQL,
  OPERATOR_NUMBER_PRECHECK_SQL,
  OPERATOR_PHONE_CHANGE_SQL,
} from './phone-change.js';
import { commentLikes, phoneVerifications, postLikes, startGrantNumbers } from './schema/index.js';
import { cancelStartGrant, payStartGrant, recordStartGrant } from './start-grants.js';
import {
  createComment,
  createCommentLike,
  createMarket,
  createPhoneVerification,
  createPost,
  createPostLike,
  createStartGrant,
  createUser,
  randomPhone,
  randomPhoneHash,
} from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';
import { splitPsqlStatements, writePsqlVariables } from './test/operator.js';

const OPERATIONS = readFileSync(new URL('../../../docs/OPERATIONS.md', import.meta.url), 'utf8');
const DECISIONS = readFileSync(new URL('../../../docs/DECISIONS.md', import.meta.url), 'utf8');

/** The index a waiting grant of another account refuses the INSERT with (owner, 2026-10-19). */
const LIVE_NUMBER = 'start_grant_numbers_phone_hash_live_idx';

/**
 * What the DO block raises for an account with no grant moved onto a number another account's
 * waiting grant holds (owner, 2026-10-19 3차, answer 4).
 */
const DO_REFUSAL = 'refused: a waiting start grant of another account holds the new number';

/**
 * What the same DO block raises first when the UPDATE answered 0 — the account holds no `old_phone`
 * (a mistyped id or old number, or the lines of a change that committed run again): `UPDATE 0`
 * alone does not stop the transaction, and the likes' block after it would carry another number's
 * likes over and delete the new number's (ADR-0076 7-24).
 */
const OLD_NUMBER_REFUSAL = 'refused: the account does not hold old_phone';

/** The owner's one sentence to the member for every refusal (2026-10-19 3차 answer 3, 4차 answer 1). */
const REFUSAL_SENTENCE = '지금은 그 번호로 바꿀 수 없습니다';

/** How the result table's refusal rows say it: that sentence, and nothing more. */
const REFUSAL_REPLY = `'${REFUSAL_SENTENCE}'라고만`;

/** The fixed text of the confirmation SMS (owner, 2026-10-19 4차, answer 2). */
const SMS_BLOCK = '```text\n[buddha] 번호 변경 확인 번호 NNNNNN\n```';

/**
 * How step 1 picks the confirmation code: the API's CLI in the api container, from node:crypto's
 * CSPRNG — not PostgreSQL's random(), which is no CSPRNG (Codex review, ADR-0071 7-29).
 */
const CODE_COMMAND =
  'sudo docker compose -f /data/buddha/compose.yaml exec api node apps/api/dist/identity/phone-hash-cli.js --code';
const CODE_BLOCK = ['```bash', CODE_COMMAND, '```'].join('\n');

/** The psql variables a statement uses, `:'name'`. */
function variablesOf(text: string): string[] {
  return [...new Set([...text.matchAll(/:'(\w+)'/g)].map((m) => m[1]!))].sort();
}

/** A script's statements as psql sends them (`splitPsqlStatements`, which throws on a stray `$$`). */
const statementsIn = (text: string): string[] => splitPsqlStatements(text);

/**
 * The DO blocks' bodies, what psql writes no variable into: the refusal of a waiting grant's number
 * (owner decision 2026-10-19 3차, answer 4), then the move of the account's likes (2026-10-20 and
 * 2026-10-21, ADR-0076).
 */
const [DO_BODY = '', LIKES_BODY = ''] = [
  ...OPERATOR_PHONE_CHANGE_SQL.matchAll(/\$\$([\s\S]*?)\$\$/g),
].map((m) => m[1]!);

/** The doc's text from one bold heading to the next given one. */
function sectionOf(from: string, to: string): string {
  const start = OPERATIONS.indexOf(from);
  const end = OPERATIONS.indexOf(to, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return OPERATIONS.slice(start, end);
}

/** Step 1 of the doc: everything before the shell is opened for the change itself. */
const step1 = () => sectionOf('**1. 요청 확인.**', '**2. 셸.**');

interface Held {
  this_account: boolean;
  source: string;
  paid: boolean;
  has_grant: boolean;
}

/** The change's statements in order: the three SET LOCAL lines hand the DO blocks their values. */
const STATEMENTS = ['update', 'insert', 'set', 'set', 'set', 'do', 'do', 'select'] as const;

/**
 * Which statement failed first and how: the constraint for the UPDATE and the INSERT, the message
 * the DO block raises.
 */
type Refusal =
  | { at: 'update' | 'insert'; code: string | undefined; constraint: string | undefined }
  | { at: 'do'; code: string | undefined; message: string };

/**
 * What the statements returned: the UPDATE's count (null when it failed), then a refusal (a
 * statement failed) or the INSERT's count and the last statement's rows.
 */
type Outcome =
  | { updated: number | null; refused: Refusal }
  | { updated: number | null; inserted: number | null; held: Held[] };

/** The rows of step 5's result table: what psql shows, what it means, what the operator does. */
const RESULT_ROWS = (() => {
  const header = /^\| 결과 +\| 뜻 +\| 다음 +\|$/m.exec(OPERATIONS);
  if (header === null) throw new Error('docs/OPERATIONS.md: no result table (결과 | 뜻 | 다음)');
  const rows: { result: string; meaning: string; next: string }[] = [];
  for (const line of OPERATIONS.slice(header.index).split('\n').slice(2)) {
    if (!line.startsWith('|')) break;
    const [result, meaning, next, ...rest] = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (next === undefined || rest.length > 0) throw new Error(`not three cells: ${line}`);
    rows.push({ result: result!, meaning: meaning!, next });
  }
  return rows;
})();

/**
 * Whether a row's 결과 cell describes an outcome: every condition the cell states holds — the
 * failing statement, its SQLSTATE and its constraint (or, for the DO block, its message), or
 * `UPDATE n`, `INSERT 0 n`, 한 줄 / 줄 없음 and the last row's columns. A condition the cell does
 * not state is not looked at. An `UPDATE 0` comes first and is the `UPDATE 0` row whatever follows
 * it — the DO block's refusal of it, or an error of the INSERT before that (the doc's reading rule,
 * ADR-0076 7-24).
 */
function describes(cell: string, outcome: Outcome): boolean {
  const error = /^`(UPDATE|INSERT|DO)`에서 오류\((\w+) `([^`]+)`\)$/.exec(cell);
  if (outcome.updated === 0) return error === null && /`UPDATE 0`/.test(cell);
  if ('refused' in outcome) {
    const refused = outcome.refused;
    if (error === null || error[1]!.toLowerCase() !== refused.at || error[2] !== refused.code) {
      return false;
    }
    return error[3] === (refused.at === 'do' ? refused.message : refused.constraint);
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
  updated: 1,
  refused: { at: 'insert', code: '23505', constraint: LIVE_NUMBER },
  commit: 'ROLLBACK',
} as const;

/**
 * The same refusal for an account with no grant, which the INSERT has no row to refuse with: the
 * DO block raises it (owner decision 2026-10-19 3차, answer 4).
 */
const REFUSED_NO_GRANT = {
  updated: 1,
  refused: { at: 'do', code: 'P0001', message: DO_REFUSAL },
  commit: 'ROLLBACK',
} as const;

/** What the change returns for a number another account verified (its UNIQUE, on the UPDATE). */
const REFUSED_VERIFIED = {
  updated: null,
  refused: { at: 'update', code: '23505', constraint: 'phone_verifications_phone_unique' },
  commit: 'ROLLBACK',
} as const;

/**
 * What the change returns for an account that holds no `old_phone` — a mistyped id or old number,
 * or the lines of a change that committed run again: `UPDATE 0`, then the DO block's refusal of it,
 * so a COMMIT typed after it answers ROLLBACK (ADR-0076 7-24).
 */
const REFUSED_OLD_NUMBER = {
  updated: 0,
  refused: { at: 'do', code: 'P0001', message: OLD_NUMBER_REFUSAL },
  commit: 'ROLLBACK',
} as const;

/**
 * An account with no grant on a number another account got the start Coin with: the change goes
 * through, and the member is told so (owner decision 2026-10-19, answer 3).
 */
const NO_GRANT_ON_PAID = {
  updated: 1,
  inserted: 0,
  held: [{ this_account: false, source: 'grant', paid: true, has_grant: false }],
};

describe('the operator phone change (docs/OPERATIONS.md)', () => {
  it('is the SQL the operations doc gives, verbatim', () => {
    expect(OPERATIONS).toContain(['```sql', 'BEGIN;', OPERATOR_PHONE_CHANGE_SQL].join('\n'));
    expect(OPERATIONS).toContain(
      ['```sql', "\\set sender 'member@example.com'", OPERATOR_ACCOUNT_LOOKUP_SQL, '```'].join(
        '\n',
      ),
    );
    expect(OPERATIONS).toContain(
      ['```sql', "\\set user_id '<찾은 계정 id>'", OPERATOR_NUMBER_PRECHECK_SQL, '```'].join('\n'),
    );
    expect(OPERATIONS).toContain(
      ['```sql', "\\set user_id '<계정 id>'", OPERATOR_CURRENT_NUMBER_SQL, '```'].join('\n'),
    );
    expect(OPERATIONS).toContain(CODE_BLOCK);
  });

  it('names its psql variables and nothing else, and none inside the DO blocks', () => {
    // The old number's two (owner decision 2026-10-21, ADR-0076) beside the new number's.
    expect(variablesOf(OPERATOR_PHONE_CHANGE_SQL)).toEqual([
      'new_hash',
      'new_phone',
      'old_hash',
      'old_phone',
      'user_id',
    ]);
    expect(variablesOf(OPERATOR_ACCOUNT_LOOKUP_SQL)).toEqual(['sender']);
    expect(variablesOf(OPERATOR_CURRENT_NUMBER_SQL)).toEqual(['user_id']);
    // The pre-check takes what the change takes: the lookup's id and the CLI's two lines.
    expect(variablesOf(OPERATOR_NUMBER_PRECHECK_SQL)).toEqual(['new_hash', 'new_phone', 'user_id']);
    // psql writes no variable into a dollar-quoted body: each DO block reads the values the SET
    // LOCAL lines before them hand over, and nothing else.
    expect(DO_BODY).toContain('RAISE EXCEPTION');
    expect(variablesOf(DO_BODY)).toEqual([]);
    expect(
      new Set([...DO_BODY.matchAll(/current_setting\('([\w.]+)'\)/g)].map((m) => m[1])),
    ).toEqual(new Set(['phone_change.new_hash', 'phone_change.user_id']));
    // It refuses an `UPDATE 0` first (ADR-0076 7-24), by what the UPDATE writes: the account's
    // row changed in this transaction carries its start time, `now()`, to the millisecond the
    // column keeps. Then the waiting grant's number (owner decision 2026-10-19 3차, answer 4).
    const changedHere = DO_BODY.indexOf('updated_at = now()::timestamptz(3)');
    const oldNumber = DO_BODY.indexOf(`RAISE EXCEPTION '${OLD_NUMBER_REFUSAL}'`);
    expect(changedHere).toBeGreaterThan(-1);
    expect(oldNumber).toBeGreaterThan(changedHere);
    expect(DO_BODY.indexOf(`RAISE EXCEPTION '${DO_REFUSAL}'`)).toBeGreaterThan(oldNumber);
    // The likes' block (owner decisions 2026-10-20 and 2026-10-21, ADR-0076) raises nothing of its
    // own: it gives no result to read, so the result table is the same with it. It alone reads the
    // old number's hash.
    expect(LIKES_BODY).toContain('post_likes');
    expect(LIKES_BODY).toContain('comment_likes');
    expect(LIKES_BODY).not.toContain('RAISE');
    expect(variablesOf(LIKES_BODY)).toEqual([]);
    expect(
      new Set([...LIKES_BODY.matchAll(/current_setting\('([\w.]+)'\)/g)].map((m) => m[1])),
    ).toEqual(new Set(['phone_change.new_hash', 'phone_change.old_hash', 'phone_change.user_id']));
    const statements = statementsIn(OPERATOR_PHONE_CHANGE_SQL);
    expect(statements.map((s) => /^\w+/.exec(s)![0].toLowerCase())).toEqual([...STATEMENTS]);
    expect(statements.slice(2, 5)).toEqual([
      "SET LOCAL phone_change.user_id = :'user_id'",
      "SET LOCAL phone_change.new_hash = :'new_hash'",
      "SET LOCAL phone_change.old_hash = :'old_hash'",
    ]);
    // The UPDATE changes only an account still on the old number the CLI hashed, and marks the
    // row it changed with the transaction's start time, which the DO block looks for.
    expect(statements[0]).toContain("WHERE user_id = :'user_id' AND phone = :'old_phone'");
    expect(statements[0]).toContain('updated_at = now()');
    // The two statements of step 1 and the read of step 3 only read.
    for (const text of [
      OPERATOR_ACCOUNT_LOOKUP_SQL,
      OPERATOR_NUMBER_PRECHECK_SQL,
      OPERATOR_CURRENT_NUMBER_SQL,
    ]) {
      expect(statementsIn(text)).toHaveLength(1);
      expect(text).toMatch(/^SELECT /);
    }
  });

  it('checks the request in step 1, before the confirmation SMS goes out, and how', () => {
    // Owner decisions 2026-10-19 answer 1 and 3차 answers 1–2: only a request from the account's
    // current email that passed sender authentication; the lookup comes first, so no SMS goes to a
    // number named by an address that is no member's; then the pre-check (4차 answer 1); then a
    // code texted to the new number, which the member sends back from that email.
    const text = step1();
    const authenticated = text.indexOf('그 판정이 다음 둘 가운데 하나이면 통과다');
    const lookup = text.indexOf(OPERATOR_ACCOUNT_LOOKUP_SQL);
    const precheck = text.indexOf(OPERATOR_NUMBER_PRECHECK_SQL);
    const code = text.indexOf(CODE_BLOCK);
    const sms = text.indexOf(SMS_BLOCK);
    expect(authenticated).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(authenticated);
    expect(precheck).toBeGreaterThan(lookup);
    expect(code).toBeGreaterThan(precheck);
    expect(sms).toBeGreaterThan(code);
    expect(text).toContain('지금 이메일(`user.email`)');
    expect(text).toContain('`…@noemail.buddha.local`');
    expect(text).toContain('MY 설정');
    // The code goes by SMS only: in the mail, a reply would prove the mailbox, not the number.
    expect(text).toContain('확인 번호는 문자로만 보내고 메일에는 적지 않는다');
    // The member's reply: from the 가입 이메일, authenticated like the request, the code matching.
    const replied = text.indexOf(
      '회원이 가입 이메일(요청을 보낸 그 주소)에서 답장으로 보낸 번호가 마지막으로 보낸 확인 번호와 같고',
    );
    expect(replied).toBeGreaterThan(sms);
    expect(text).toContain('답장도 요청 메일처럼 발신 인증을 본다');
    // Step 4 only connects: the account was found in step 1.
    expect(sectionOf('**4. psql.**', '**5. ')).not.toContain('FROM "user"');
  });

  it('checks before any SMS whatever step 5 would refuse, and sends none when it would', () => {
    // Owner decision 2026-10-19 4차, answer 1: another account's verified number and a number a
    // waiting grant of another account holds are seen before the code, not at step 5.
    const text = step1();
    const precheck = text.indexOf(OPERATOR_NUMBER_PRECHECK_SQL);
    const before = text.indexOf('확인 문자를 보내기 전에 새 번호를 5단계가 거절할지 미리 본다');
    expect(before).toBeGreaterThan(text.indexOf(OPERATOR_ACCOUNT_LOOKUP_SQL));
    expect(before).toBeLessThan(precheck);
    // The CLI (step 3) gives it the two lines, on the number the request names.
    expect(text.slice(before, precheck)).toContain(
      '3단계의 해시 CLI를 띄워 요청 메일의 새 번호를 넣고',
    );
    const after = text.slice(precheck);
    expect(after).toContain('하나라도 `t`이면 거절한다 — 문자를 보내지 않고 거절의 문장만 알린다');
    expect(after).toContain('둘 다 `f`일 때만 확인 번호를 뽑는다');
    expect(after.indexOf('둘 다 `f`일 때만 확인 번호를 뽑는다')).toBeLessThan(
      after.indexOf(CODE_BLOCK),
    );
    // Each column names the step 5 refusal it stands for.
    expect(after).toContain('`other_verified`는 새 번호가 다른 계정이 본인확인한 번호인지');
    expect(after).toContain(
      '`other_waiting`은 새 번호를 금액을 기다리는 다른 계정의 지급이 붙들고 있는지',
    );
    // The SMS goes to the digits the CLI printed for the pre-check.
    expect(after).toContain('찍힌 `\\set new_phone` 줄의 번호로 보낸다');
    // Before every new code too, and on a request asked again after a refusal.
    expect(text).toContain('사전 확인을 다시 돌리고, 둘 다 `f`이면 새 확인 번호를 뽑아');
    expect(sectionOf('**거절한 뒤에 다시 요청받았을 때.**', '**하지 않는 것.**')).toContain(
      '사전 확인의 `other_waiting`이 `t`이므로 문자를 보내지 않고',
    );
    // The step 5 rows of those refusals say they come only from what changed after it.
    for (const outcome of [REFUSED_VERIFIED, REFUSED_WAITING, REFUSED_NO_GRANT]) {
      const [row, ...others] = RESULT_ROWS.filter((r) => describes(r.result, outcome));
      expect(others).toEqual([]);
      expect(row!.meaning, row!.result).toContain('1단계의 사전 확인이 거르므로, 그 뒤에');
    }
  });

  it('keeps a code 30 minutes, sends a new one on a wrong reply, three at most, in a fixed text', () => {
    // Owner decision 2026-10-19 4차, answer 2.
    const text = step1();
    expect(text).toContain('문구는 이것으로 정해져 있고(오너 결정 2026-10-19 4차의 답 2)');
    expect(text).toContain(SMS_BLOCK);
    expect(text).toContain('확인 번호는 문자를 보낸 때부터 30분 동안 유효하고');
    expect(text).toContain('새 확인 번호를 보내면 앞의 번호는 더 쓰지 않는다');
    expect(text).toContain('확인 번호를 30분 안에 이 메일의 답장으로 보내 달라고 알린다');
    // What is noted for each code: what the reply is matched against.
    expect(text).toContain(
      '보낸 확인 번호와 그 번호를 보낸 휴대전화 번호(숫자만), 문자를 보낸 시각, 이 요청의 몇 번째 확인 번호인지를 함께 적어 둔다',
    );
    // The reply: the last code, received within 30 minutes of its SMS.
    expect(text).toContain(
      '고객센터 메일함이 그 답장을 받은 때가 그 번호의 문자를 보낸 때부터 30분 안일 때만 다음 단계로 간다',
    );
    // A wrong or late reply: a new code while fewer than three were sent, then the refusal.
    const wrong = text.indexOf('번호가 다르거나 30분이 지났으면 바꾸지 않는다');
    expect(wrong).toBeGreaterThan(text.indexOf(SMS_BLOCK));
    const after = text.slice(wrong);
    expect(after).toContain('이 요청에 보낸 확인 번호가 셋보다 적으면 새 확인 번호를 보낼 수 있다');
    expect(after).toContain(
      '한 요청에 확인 번호는 모두 세 번까지다(오너 결정 2026-10-19 4차의 답 2)',
    );
    expect(after).toContain('셋째 확인 번호에도 맞는 답이 오지 않으면');
    expect(after).toContain('그 요청은 거절한다');
    expect(sectionOf('**거절의 문장.**', '```text')).toContain(
      '확인 번호를 세 번 보내도 맞는 답이 오지 않을 때',
    );
  });

  it('picks the confirmation code with the CLI’s CSPRNG, not PostgreSQL random()', () => {
    // Codex review (ADR-0071 7-29): the code is the only proof the requester holds the new number,
    // so it comes from node:crypto's randomInt (the CLI's own tests check the draw), and no step
    // of the doc picks it in psql.
    const text = step1();
    const code = text.indexOf(CODE_BLOCK);
    expect(code).toBeGreaterThan(-1);
    expect(text.lastIndexOf(CODE_BLOCK)).toBe(code);
    const before = text.slice(0, code);
    expect(before).toContain(
      '확인 번호는 3단계의 CLI를 `--code`로 띄워 뽑은 무작위 6자리 숫자다(앞의 0도 자리다)',
    );
    expect(before).toContain('CLI는 Node의 암호용 난수(`crypto.randomInt`)로 뽑는다');
    expect(before).toContain('PostgreSQL의 `random()`은 암호용 난수가 아니어서 쓰지 않는다');
    const sqlBlocks = [...OPERATIONS.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(sqlBlocks.length).toBeGreaterThan(0);
    for (const block of sqlBlocks) expect(block).not.toMatch(/random\s*\(/i);
  });

  it('passes sender authentication on SPF and DKIM for the sender’s domain, or on DMARC, read from the operator’s own provider', () => {
    // Any sender can plant an Authentication-Results line; the receiving server strips only the
    // ones claiming its own authserv-id. So the verdict read is the topmost line that provider
    // added (or its own display of it), and every line below is ignored (ADR-0071 7-30). Within it,
    // SPF and DKIM both passing for the From domain, or DMARC passing (4차 answer 2).
    const text = step1();
    const verdict = text.indexOf(
      '고객센터 메일함의 메일 서비스가 그 메일을 받으며 스스로 매긴 판정 하나다',
    );
    const passes = text.indexOf(
      '그 판정이 다음 둘 가운데 하나이면 통과다(오너 결정 2026-10-19 4차의 답 2)',
    );
    expect(verdict).toBeGreaterThan(-1);
    expect(passes).toBeGreaterThan(verdict);
    expect(text).toContain(
      '메일 원본의 맨 위 `Authentication-Results` 줄(그 서비스의 받는 서버가 자기 이름, 곧 authserv-id를 맨 앞에 적어 더한 줄)',
    );
    expect(text).toContain(
      '그 아래에 있는 다른 `Authentication-Results` 줄과 `ARC-Authentication-Results` 줄은 보낸 쪽이나 거쳐 온 서버가 써 넣을 수 있으므로 보지 않는다',
    );
    // The support mailbox is undecided, so its authserv-id is not written yet.
    expect(text).toContain('authserv-id를 적지 못했다 — 정해지면 여기에 적는다');
    const both = text.indexOf(
      '하나는 SPF와 DKIM이 모두 `pass`이고 통과한 도메인이 둘 다 보낸 주소(From)의 도메인과 같은 것이다',
    );
    const dmarc = text.indexOf(
      '다른 하나는 DMARC가 `pass`인 것이다(`dmarc=pass`, 그 판정의 `header.from`이 보낸 주소의 도메인)',
    );
    expect(both).toBeGreaterThan(passes);
    expect(dmarc).toBeGreaterThan(both);
    expect(text.slice(dmarc)).toMatch(/^[^\n]*어느 쪽도 아니면 여기서 그만둔다/);
    // Gmail writes DKIM's domain as header.i=@domain and smtp.mailfrom as a whole address.
    expect(text).toContain(
      '`smtp.mailfrom`의 도메인이고(서비스에 따라 주소 전체로 적으니 `@` 뒤를 본다)',
    );
    expect(text).toContain('(`header.d=도메인`, Gmail은 `header.i=@도메인`)');
  });

  it('mails the account’s own address, not Reply-To, and checks that address again on every reply', () => {
    // A spoofed request's Reply-To would take the operator's mail away from the real member; the
    // 가입 이메일 is the account's current email (3차 answer 2), which may change before the reply.
    const text = step1();
    const sms = text.indexOf(SMS_BLOCK);
    const mailed = text.indexOf(
      '이 메일의 받는 사람은 위에서 계정을 찾은 주소(`sender`에 넣은 주소, 곧 그 계정의 `user.email`)를 손으로 적거나',
    );
    expect(mailed).toBeGreaterThan(sms);
    expect(text).toContain('요청 메일의 답장 버튼으로 받는 사람을 정하지 않는다');
    expect(text).toContain('`Reply-To`');
    // Every other mail of the request too: the refusal, the reply that the number was changed.
    expect(text).toContain(
      '이 요청에서 회원에게 보내는 다른 메일(거절의 문장, 번호를 바꿨다는 회신)도 받는 사람을 같은 주소로 적는다',
    );
    expect(sectionOf('**거절의 문장.**', '```text')).toContain(
      '받는 사람은 1단계에서 계정을 찾은 주소다',
    );
    // On an authenticated reply: the same lookup (not a second copy of it) with the reply's
    // sender, the same id still verified, or the refusal — before the code is compared, so that a
    // new code goes out only to an account still found — and that id is step 5's.
    const again = text.indexOf('위의 계정 찾기를 답장을 보낸 주소로 다시 돌린다');
    const compared = text.indexOf('같으면 답장의 번호를 마지막으로 보낸 확인 번호와 견준다');
    expect(again).toBeGreaterThan(sms);
    expect(compared).toBeGreaterThan(again);
    expect(text.indexOf(OPERATOR_ACCOUNT_LOOKUP_SQL)).toBe(
      text.lastIndexOf(OPERATOR_ACCOUNT_LOOKUP_SQL),
    );
    expect(text.slice(again, compared)).toContain(
      '처음에 찾은 것과 같은 `id`에 `verified` = `t`가 아니면 거절한다',
    );
    expect(text.slice(compared)).toContain('5단계의 `user_id`는 이 다시 찾은 `id`다');
    expect(text).not.toContain('찾아 둔 `id`');
    expect(sectionOf('**5. 바꾸고 기록하기.**', '```sql')).toContain(
      '1단계에서 답장의 주소로 다시 찾은 계정의 id',
    );
  });

  it('changes only to the number the code was texted to', () => {
    // A mistyped number in step 3 would end in COMMIT like any other and could never be told
    // apart: the number is noted with the code, entered alone, and the CLI's line checked.
    const text = step1();
    expect(text).toContain('3단계에서는 그 휴대전화 번호만 넣는다');
    expect(text).toContain('새 요청으로 보고 1단계부터 한다(그 번호로 새 확인 번호를 보낸다)');
    const step3 = sectionOf('**3. 새 번호와 옛 번호의 해시.**', '**4. psql.**');
    expect(step3).toContain('1단계에서 확인 번호를 보내고 적어 둔 그 번호를 입력한 뒤');
    expect(step3).toContain('1단계의 사전 확인에서 처음 띄울 때는 요청 메일의 번호를 넣는다');
    const printed = step3.indexOf("```text\n\\set new_phone '");
    const checked = step3.indexOf(
      '찍힌 `\\set new_phone` 줄의 숫자가 1단계에서 적어 둔 번호(확인 번호를 보낸 번호)와 한 자리도 빠짐없이 같은지 본다',
    );
    expect(printed).toBeGreaterThan(-1);
    expect(checked).toBeGreaterThan(printed);
    expect(step3.slice(checked)).toContain('다르면 붙여 넣지 않고 CLI를 다시 띄워');
    expect(sectionOf('**5. 바꾸고 기록하기.**', '```sql')).toContain(
      '`new_phone`이 확인 번호를 보낸 번호와 같은지 본 것',
    );
  });

  it('tells the member the same one sentence on every refusal, and nothing more', () => {
    // Owner decision 2026-10-19 4차, answer 1 (3차 answer 3 gave the sentence for the refusals
    // of a waiting grant's number): one text, no reason, every refusal — and it is the doc's own
    // text block, which the result table quotes.
    const intro = sectionOf('**거절의 문장.**', '**바뀌는 것.**');
    expect(intro).toContain(`\`\`\`text\n${REFUSAL_SENTENCE}\n\`\`\``);
    expect(intro).toContain(
      '언제나 회원에게 까닭 없이 이 한 문장만 알린다(오너 결정 2026-10-19 4차의 답 1)',
    );
    for (const when of [
      '1단계에서 찾은 계정에 본인확인 기록이 없을 때',
      '사전 확인이 새 번호를 거를 때',
      '답장의 주소로 다시 찾은 계정이 처음과 다를 때(그 사이에 이메일을 바꿨다)',
      '5단계가 거절할 때(결과 표의 `ROLLBACK` 줄)',
    ]) {
      expect(intro).toContain(when);
    }
    // Every ROLLBACK row of the result table — the refusals of step 5, UPDATE 0 included — says
    // the sentence and only that; no COMMIT row says it.
    for (const row of RESULT_ROWS) {
      if (row.next.startsWith('`ROLLBACK;`')) expect(row.next, row.result).toContain(REFUSAL_REPLY);
      else expect(row.next, row.result).not.toContain(REFUSAL_SENTENCE);
    }
    for (const outcome of [REFUSED_VERIFIED, REFUSED_WAITING, REFUSED_NO_GRANT]) {
      expect(docRowFor(outcome).end).toBe('ROLLBACK');
    }
    const gone = docRowFor(REFUSED_OLD_NUMBER);
    expect(gone.end).toBe('ROLLBACK');
    expect(gone.next).toContain('1단계의 계정 찾기를 답장의 주소로 다시 돌린다');
    // A mistyped id or old number is the one ROLLBACK that is no refusal: step 5 again with the
    // right id, or with the old number read and hashed again (owner decision 2026-10-21).
    expect(gone.next).toContain('그 `id`로 5단계를 다시 하고');
    expect(gone.next).toContain('3단계의 옛 번호를 다시 읽고 세어 그 두 줄로 5단계를 다시 하며');
    expect(OPERATIONS).toContain(
      '`UPDATE 0`에서 id나 옛 번호를 잘못 넣은 것이 드러나 5단계를 다시 할 때만 빼고',
    );
    // Step 1's refusals before any SMS: no 본인확인 record, the pre-check, the reply's account.
    const text = step1();
    expect(text.match(/거절한다 — 문자를 보내지 않고 거절의 문장만 알린다/g)).toHaveLength(2);
    expect(OPERATIONS).toContain(
      '여기서 실패하면 회원에게 거절의 문장만 알린다(오너 결정 2026-10-19 4차의 답 1)',
    );
    // Nothing the owner has answered is left undecided; what is left is a request from an address
    // that is no member's or not authenticated, which is not known to be the member's.
    expect(OPERATIONS).not.toContain('무엇을 알릴지는 정하지 않았다');
    expect(intro).toContain(
      '어느 계정의 가입 이메일도 아닌 주소에서 왔거나 발신 인증을 통과하지 못한 요청에 회신할지는 정하지 않았다(ADR-0071 결과 4)',
    );
  });

  it('leaves the onboarding notice of an account on a number a waiting grant holds to #58', () => {
    // Owner decision 2026-10-19 4차, answer 3: not "already received" — nobody got the start Coin
    // on that number yet — but that the number cannot get it; #58 draws it (ADR-0071 결과 5).
    const head = sectionOf('## 회원의 휴대전화 번호 바꾸기', '**거절의 문장.**');
    expect(head).toContain(
      "그 계정에 보일 안내는 '이미 받았다'가 아니라 '이 번호로는 시작 Coin을 받을 수 없습니다'이고, 그 안내는 온보딩(#58)이 그린다(오너 결정 2026-10-19 4차의 답 3, ADR-0071 결과 5)",
    );
    expect(OPERATIONS).not.toContain('무엇을 보일지는 정하지 않았다');
  });

  it('says COMMIT or ROLLBACK on every row of its result table, which states what it matches', () => {
    expect(RESULT_ROWS.length).toBeGreaterThan(0);
    for (const row of RESULT_ROWS) {
      expect(row.next, row.result).toMatch(/^`(COMMIT|ROLLBACK);`/);
      expect(row.result).toMatch(/`(UPDATE|INSERT|DO)( \d+|`에서 오류)/);
    }
  });

  it('rolls back both refusals of a waiting grant’s number, and waits to be asked again', () => {
    // Owner decision 2026-10-19 answer 2, and 3차 answers 3–4: refused for an account with a grant
    // (the INSERT) and without one (the DO block); the member asks again later — handled from
    // step 1, the confirmation taken before the refusal not reused (ADR-0071 7-28).
    for (const outcome of [REFUSED_WAITING, REFUSED_NO_GRANT]) {
      const row = docRowFor(outcome);
      expect(row.end).toBe('ROLLBACK');
      expect(row.next).toContain(REFUSAL_REPLY);
      expect(row.next).toContain('회원이 나중에 다시 요청하면 1단계부터');
    }
    // The member asks again; the operator does not retry once the grant settles (3차 answer 3).
    expect(docRowFor(REFUSED_WAITING).next).toContain('운영자가 먼저 다시 하지 않는다');
    const again = sectionOf('**거절한 뒤에 다시 요청받았을 때.**', '**하지 않는 것.**');
    expect(again).toContain('운영자가 먼저 다시 하지 않고');
    expect(again).toContain('1단계부터');
    expect(again).toContain("다시 '지금은 그 번호로 바꿀 수 없습니다'라고만 알린다");
    expect(sectionOf('**하지 않는 것.**', '**로컬.**')).toContain('1단계부터 다시');
    // No row is left for the last row showing a waiting grant of another account: the SQL refuses
    // every such change now.
    const waiting = { ...NO_GRANT_ON_PAID, held: [{ ...NO_GRANT_ON_PAID.held[0]!, paid: false }] };
    expect(RESULT_ROWS.filter((row) => describes(row.result, waiting))).toEqual([]);
    // The member is told the number got the start Coin only when it did (2026-10-19 answer 3).
    expect(docRowFor(NO_GRANT_ON_PAID).end).toBe('COMMIT');
    expect(docRowFor(NO_GRANT_ON_PAID).next).toContain('이미 시작 Coin을 받아');
    for (const outcome of [REFUSED_WAITING, REFUSED_NO_GRANT]) {
      expect(docRowFor(outcome).next).not.toContain('이미 시작 Coin을 받아');
    }
  });

  it('says the change carries the account’s likes to the new number, and the table reads the same', () => {
    // Owner decisions 2026-10-20 and 2026-10-21 (ADR-0076): «좋아요 한 번» counts per number, so
    // the account's likes go with it — those it inherited on the old number too — one stays where
    // the new number liked the same target, and the next holder of the old number likes freely.
    const changes = sectionOf('**바뀌는 것.**', '**1. 요청 확인.**');
    expect(changes).toContain(
      '그 계정의 좋아요(`post_likes`·`comment_likes`, #49)가 새 번호의 해시로 옮겨진다(오너 결정 2026-10-20·21, ADR-0076)',
    );
    expect(changes).toContain(
      '그 계정이 같은 번호의 탈퇴한 계정에게서 이어받아 자기 것으로 보던 것(옛 번호의 해시를 싣고 행의 계정에 본인확인 기록이 없는 좋아요, ADR-0076 결정 7-3) 모두다',
    );
    expect(changes).toContain('뒤에 옛 번호로 본인확인한 다른 계정은 그 글·댓글에 자유롭게 누른다');
    expect(changes).toContain('하나만 남긴다 — 옮겨 오는 것이고');
    // A live account's like on the new number stays: never deleted for another's (ADR-0076 7-26,
    // Codex review on PR #222).
    expect(changes).toContain(
      '새 번호로 이미 누른 좋아요가 살아 있는(본인확인 기록이 있는) 다른 계정의 것이면',
    );
    expect(changes).toContain('그 좋아요가 남고 옮겨 오는 것이 빠진다');
    expect(changes).toContain('다른 계정의 좋아요를 옮기려고 지우지 않는다(ADR-0076 결정 7-26)');
    expect(changes).toContain('3단계에서 옛 번호의 해시도 센다');
    expect(changes).toContain('5단계의 둘째 `DO`가 하고, 결과는 `DO` 한 줄이라 읽을 것이 없다');
    expect(OPERATIONS).toContain('표의 줄을 가르지 않으니 표는 그 줄을 빼고 읽는다');
    expect(OPERATIONS).toContain('표의 `DO`에서 오류는 첫 `DO`(거절)의 것이다');
    expect(sectionOf('**하지 않는 것.**', '**로컬.**')).toContain(
      '좋아요를 옮기는 둘째 `DO`를 빼면',
    );
    // What the first commit said — the likes stay under the old number — is gone, and so is what
    // the second said — the inherited likes stay there (owner decision 2026-10-21).
    expect(OPERATIONS).not.toContain('좋아요의 해시를 손으로 고치지 않는다');
    expect(OPERATIONS).not.toContain('#49)는 바뀌지 않는다');
    expect(OPERATIONS).not.toContain(
      '자기 것으로 보던 좋아요(행의 계정이 그 탈퇴한 계정이다)는 옮기지 않는다',
    );
  });

  it('hashes the old number in step 3, as the account holds it, for every run of step 5', () => {
    // Owner decision 2026-10-21 (ADR-0076): the likes the account inherited on its old number are
    // found by that number's hash, which SQL cannot compute — the CLI does, from the number read.
    const step3 = sectionOf('**3. 새 번호와 옛 번호의 해시.**', '**4. psql.**');
    const read = step3.indexOf(OPERATOR_CURRENT_NUMBER_SQL);
    const cli = step3.indexOf(
      'sudo docker compose -f /data/buddha/compose.yaml exec api node apps/api/dist/identity/phone-hash-cli.js --psql-old',
    );
    const printed = step3.indexOf("```text\n\\set old_phone '");
    expect(read).toBeGreaterThan(
      step3.indexOf('그다음 옛 번호, 곧 그 계정이 지금 가진 번호의 해시를 센다'),
    );
    expect(cli).toBeGreaterThan(read);
    expect(printed).toBeGreaterThan(cli);
    expect(step3).toContain("\\set old_hash '<소문자 16진 64자>'");
    expect(step3.slice(printed)).toContain(
      '찍힌 `\\set old_phone` 줄의 숫자가 psql이 읽은 번호와 같은지 본다',
    );
    expect(step3).toContain(
      '5단계를 다시 할 때마다(`UPDATE 0` 뒤나, 끊긴 세션 뒤에 같은 일을 다시 할 때) 옛 번호는 다시 읽고 다시 센다',
    );
    // Step 5 takes the four lines; the UPDATE guards a wrong old number, and nothing is guessed.
    expect(sectionOf('**5. 바꾸고 기록하기.**', '```sql')).toContain('3단계의 네 줄');
    expect(OPERATIONS).toContain(
      "\\set old_phone '01012345678'\n\\set old_hash '<3단계가 옛 번호로 찍은 값>'\n\\set ON_ERROR_ROLLBACK off",
    );
    expect(OPERATIONS).toContain('`UPDATE`는 그 계정이 옛 번호(`old_phone`)를 가졌을 때만 바꾼다');
    expect(docRowFor(REFUSED_OLD_NUMBER).next).not.toContain('`COMMIT;`');
    expect(sectionOf('**하지 않는 것.**', '**로컬.**')).toContain(
      '옛 번호의 두 줄은 짐작하거나 앞서 찍은 것을 다시 쓰지 않는다',
    );
    expect(OPERATIONS.slice(OPERATIONS.indexOf('**로컬.**'))).toContain(
      'corepack pnpm --filter api run phone-hash --psql-old',
    );
  });

  it('refuses an UPDATE 0 in the SQL itself, so a COMMIT typed after it keeps nothing, and reads it first', () => {
    // ADR-0076 7-24: `UPDATE 0` only says the account holds no `old_phone`; the transaction goes
    // on, and the likes' block would carry another number's likes over and delete the new
    // number's. The DO block refuses it, and the doc names that refusal — not the UPDATE — as what
    // keeps them.
    const row = docRowFor(REFUSED_OLD_NUMBER);
    expect(row.end).toBe('ROLLBACK');
    expect(row.next).toMatch(/^`ROLLBACK;`\(`COMMIT`해도 `ROLLBACK`이 된다\)/);
    // Whatever follows `UPDATE 0` — that refusal, or an error of the INSERT before it — the row is
    // `UPDATE 0`'s, never the waiting grant's refusals', which tell the member to ask again.
    for (const { refused } of [REFUSED_WAITING, REFUSED_NO_GRANT]) {
      expect(docRowFor({ updated: 0, refused })).toEqual(row);
    }
    expect(RESULT_ROWS.find((r) => r.result === '`UPDATE 0`')?.meaning).toContain(
      `첫 \`DO\`가 거절해(P0001 \`${OLD_NUMBER_REFUSAL}\``,
    );
    expect(OPERATIONS).toContain(
      '첫 줄이 `UPDATE 0`이면 그 뒤에 무엇이 찍히든(위의 거절이나 `INSERT`의 오류도) 표의 `UPDATE 0` 줄이다',
    );
    expect(OPERATIONS).toContain(
      '`UPDATE 0`은 그것을 알릴 뿐 트랜잭션을 멈추지 않아 뒤의 문장도 돈다',
    );
    expect(sectionOf('**3. 새 번호와 옛 번호의 해시.**', '**4. psql.**')).toContain(
      '첫 `DO`가 트랜잭션을 거절하므로, 다른 번호의 좋아요는 옮겨지지 않는다 — `COMMIT`해도 `ROLLBACK`이 된다',
    );
    expect(sectionOf('**하지 않는 것.**', '**로컬.**')).toContain(
      '`UPDATE 0`은 알림일 뿐이고, 막는 것은 그 거절이다',
    );
    // What said the UPDATE itself keeps another number's likes where they are is gone.
    expect(OPERATIONS).not.toContain('다른 번호의 좋아요를 옮기지 않는다');
    expect(OPERATIONS).not.toContain('`UPDATE`가 `old_phone`으로 막는다');
  });

  it('is recorded on the status line of ADR-0071, which owns it, as eight statements now', () => {
    // ADR-0071 says step 5 is six statements (7-20, decision 8). ADR-0076 added the likes' DO
    // block, the old number's SET LOCAL line, the UPDATE's check of the old number and the first DO
    // block's refusal of an `UPDATE 0`, and records
    // so on ADR-0071's status line rather than rewriting it (ADR-0047 결과 1), so that a reader of
    // ADR-0071 learns of the move of the likes and of the old number's two lines.
    const start = DECISIONS.indexOf('\n## ADR-0071 ');
    const adr = DECISIONS.slice(start, DECISIONS.indexOf('\n## ADR-0072 ', start));
    const status = /^- 상태: (.+)$/m.exec(adr)?.[1] ?? '';
    expect(statementsIn(OPERATOR_PHONE_CHANGE_SQL)).toHaveLength(8);
    expect(status).toContain('일부 대체됨(ADR-0076: 결정 7-20의 5단계 한 트랜잭션');
    expect(status).toContain('둘째 `DO`');
    expect(status).toContain("'여섯 문장'은 여덟 문장이다");
    expect(status).toContain('`old_phone`·`old_hash`');
    expect(status).toContain('`--psql-old`');
    // And that ADR-0071's DO block (7-26) refuses an `UPDATE 0` first now, read first (7-24).
    expect(status).toContain('결정 7-26의 `DO`가 그 앞에서 `UPDATE 0`도 거절하고');
    expect(status).toContain(
      "표를 읽는 법에 '첫 줄이 `UPDATE 0`이면 뒤에 무엇이 찍히든 그 줄'이 더해졌다",
    );
  });

  it('turns psql’s ON_ERROR_ROLLBACK off just before it, so a refusal aborts it all', () => {
    // The variables' block, one sentence, then the transaction: with ON_ERROR_ROLLBACK on, psql
    // would undo the refused INSERT or DO block alone, and the COMMIT would keep the number.
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

  /**
   * The psql variables of step 5. The old number's two (owner decision 2026-10-21) are read as step
   * 3 reads them when a test leaves them out: `old_phone` the number the account holds now (any
   * number for an account with none), and `old_hash` a hash nothing carries — the test's own
   * values where the likes it inherited are the subject.
   */
  interface Vars {
    user_id: string;
    new_phone: string;
    new_hash: string;
    old_phone?: string;
    old_hash?: string;
  }

  /** The connection the operator's psql stands for, named so a test can see it wait. */
  const PSQL = 'buddha-test-psql';

  /** A statement of the doc's with psql's `:'name'` written in as literals (the test's own values). */
  const withVariables = writePsqlVariables;

  /** The doc's statements, the variables written in. */
  function statementsOf(vars: Required<Vars>): string[] {
    const statements = statementsIn(withVariables(OPERATOR_PHONE_CHANGE_SQL, { ...vars }));
    expect(statements).toHaveLength(STATEMENTS.length);
    return statements;
  }

  /** Step 5's variables, the old number's read as step 3 reads them where the test gives none. */
  async function withOldNumber(vars: Vars): Promise<Required<Vars>> {
    const [current] = await read<{ phone: string }>(OPERATOR_CURRENT_NUMBER_SQL, {
      user_id: vars.user_id,
    });
    return {
      old_phone: current?.phone ?? randomPhone(),
      old_hash: randomPhoneHash(),
      ...vars,
    };
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

  /** Step 1's pre-check of the new number, before every confirmation code (4차 answer 1). */
  async function precheck(vars: Vars) {
    const { user_id, new_phone, new_hash } = vars;
    const rows = await read<{ other_verified: boolean; other_waiting: boolean }>(
      OPERATOR_NUMBER_PRECHECK_SQL,
      { user_id, new_phone, new_hash },
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  const FREE = { other_verified: false, other_waiting: false };
  const WAITING_ELSEWHERE = { other_verified: false, other_waiting: true };

  /**
   * Runs the doc's SQL as the operator does in psql with ON_ERROR_ROLLBACK off: on a connection of
   * its own as buddha_app, BEGIN, the statements, then what the doc's result table says for what
   * they returned. When they all go through, that is the one row of the table that matches the two
   * row counts and the final query's rows, and its COMMIT or ROLLBACK: it returns those and
   * `next`, the one it ran. When one fails, psql goes on to the next, which the aborted
   * transaction refuses (25P02); the table's row for that failure — or `UPDATE 0`'s, when the
   * UPDATE answered 0 before it — says ROLLBACK, and a COMMIT typed instead answers ROLLBACK too,
   * which is what it sends: then it returns the UPDATE's count, which statement failed, how, and
   * that ROLLBACK — nothing was kept, whatever the operator typed. Either way the values the SET
   * LOCAL lines handed the DO block are gone once the transaction ends.
   */
  async function change(given: Vars) {
    const vars = await withOldNumber(given);
    const client = new Client({ connectionString: testDbUrls()!.appUrl, application_name: PSQL });
    await client.connect();
    try {
      await client.query('BEGIN');
      const results: (QueryResult | undefined)[] = [];
      const failures: { index: number; error: DatabaseError }[] = [];
      for (const [index, statement] of statementsOf(vars).entries()) {
        try {
          results.push(await client.query(statement));
        } catch (error) {
          results.push(undefined);
          failures.push({ index, error: error as DatabaseError });
        }
      }
      const [first, ...rest] = failures;
      let outcome;
      if (first === undefined) {
        const resultOf = (at: (typeof STATEMENTS)[number]) => results[STATEMENTS.indexOf(at)]!;
        const held = {
          updated: resultOf('update').rowCount,
          inserted: resultOf('insert').rowCount,
          held: resultOf('select').rows as Held[],
        };
        const { end } = docRowFor(held);
        expect((await client.query(end)).command).toBe(end);
        outcome = { ...held, next: end };
      } else {
        const at = STATEMENTS[first.index]!;
        const { code, constraint, message } = first.error;
        if (at !== 'update' && at !== 'insert' && at !== 'do') throw first.error;
        const refused: Refusal = at === 'do' ? { at, code, message } : { at, code, constraint };
        const updated = at === 'update' ? null : results[0]!.rowCount;
        expect(docRowFor({ updated, refused }).end).toBe('ROLLBACK');
        // The COMMIT a misreading operator would type: the aborted transaction answers ROLLBACK.
        const commit = (await client.query('COMMIT')).command;
        expect(rest.map((failure) => failure.error.code)).toEqual(rest.map(() => '25P02'));
        expect(rest).toHaveLength(STATEMENTS.length - 1 - first.index);
        outcome = { updated, refused, commit };
      }
      const { rows } = await client.query<{
        user_id: string | null;
        new_hash: string | null;
        old_hash: string | null;
      }>(
        `SELECT current_setting('phone_change.user_id', true) AS user_id,
           current_setting('phone_change.new_hash', true) AS new_hash,
           current_setting('phone_change.old_hash', true) AS old_hash`,
      );
      // NULL when the SET LOCAL lines never ran (an earlier statement failed), '' after they did.
      expect(
        rows.map((row) => [row.user_id ?? '', row.new_hash ?? '', row.old_hash ?? '']),
      ).toEqual([['', '', '']]);
      return outcome;
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

  /**
   * A withdrawal (#140) cancelled and held open until `end`, then committed or rolled back: `held`
   * once it has cancelled the grant and deleted the 본인확인 record.
   */
  function withdrawal(userId: string, ending: 'commit' | 'rollback') {
    let end!: () => void;
    const ended = new Promise<void>((resolve) => (end = resolve));
    let cancelled!: () => void;
    const held = new Promise<void>((resolve) => (cancelled = resolve));
    const done = t.db
      .transaction(async (tx) => {
        expect((await cancelStartGrant(tx, userId)).outcome).toBe('cancelled');
        await tx.delete(phoneVerifications).where(eq(phoneVerifications.userId, userId));
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
    // The pre-check sees it before any SMS (4차 answer 1); step 5's SQL refuses it on its own too.
    expect(await precheck(vars)).toEqual(WAITING_ELSEWHERE);
    expect(await change(vars)).toEqual(REFUSED_WAITING);
    expect(await phoneOf(x.id)).toBe(xPhone);
    expect(await numbersOf(xGrant.id)).toEqual(xNumbers);
    expect(await liveHolders(n)).toEqual([{ grantId: yGrant.id }]);
    // Asked again while Y's grant waits: the pre-check still flags it, and the change would be
    // the same refusal, nothing changed.
    expect(await precheck(vars)).toEqual(WAITING_ELSEWHERE);
    expect(await change(vars)).toEqual(REFUSED_WAITING);
    // Once the amount is set and Y's grant is paid, N counts for good: the change goes through
    // and records nothing more (owner decision 2026-10-19, answer 2).
    expect((await pay(yGrant.id)).outcome).toBe('granted');
    expect(await precheck(vars)).toEqual(FREE);
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
    expect(await precheck(vars)).toEqual(FREE);
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
    for (const ending of ['rollback', 'commit'] as const) {
      const meanwhile = withdrawal(y.id, ending);
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

  it('refuses an account with no grant while the waiting grant’s cancellation is in flight, without waiting', async () => {
    // ADR-0071 7-26: the DO block reads what is committed and takes no lock, so a withdrawal not
    // yet committed still counts as the grant waiting — refused at once, on the refusal side only:
    // asked again after the withdrawal commits, the change goes through.
    const { y, n, phone } = await waitingHolder();
    const { user } = await createUser(t.db);
    const { phone: before } = await createPhoneVerification(t.db, { userId: user.id });
    const vars = { user_id: user.id, new_phone: phone, new_hash: n };
    const meanwhile = withdrawal(y.id, 'commit');
    await Promise.race([meanwhile.held, meanwhile.done]);
    let refused;
    try {
      // The pre-check reads what is committed too, without waiting: still flagged, so no SMS.
      expect(await precheck(vars)).toEqual(WAITING_ELSEWHERE);
      refused = await Promise.race([
        change(vars),
        new Promise((resolve) => setTimeout(() => resolve('waited'), 5_000)),
      ]);
    } finally {
      meanwhile.end();
    }
    expect(refused).toEqual(REFUSED_NO_GRANT);
    expect(await meanwhile.done).toBe('committed');
    expect(await phoneOf(user.id)).toBe(before);
    expect(await precheck(vars)).toEqual(FREE);
    expect(await change(vars)).toEqual({ updated: 1, inserted: 0, held: [], next: 'COMMIT' });
    expect(await phoneOf(user.id)).toBe(phone);
    expect((await t.db.transaction((tx) => recordStartGrant(tx, user.id, n))).outcome).toBe(
      'recorded',
    );
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
    ).toEqual({ ...NO_GRANT_ON_PAID, next: 'COMMIT' });
    // Its grant (#58) on the new number records nothing.
    const recorded = await t.db.transaction((tx) => recordStartGrant(tx, user.id, takenHash));
    expect(recorded).toEqual({ outcome: 'number_already_used' });
  });

  it('refuses an account with no grant moved onto a number a waiting grant holds, until it settles', async () => {
    // Owner decision 2026-10-19 3차 answer 4 (ADR-0071 7-26): refused like an account with a
    // grant — nobody got the start Coin on N yet, so answer 3's "already got it" would be untrue.
    // The INSERT has no row to add for an account with no grant; the DO block raises, the
    // transaction is aborted, and the operator's COMMIT answers ROLLBACK.
    for (const settle of ['pay', 'withdraw'] as const) {
      const { y, grant: yGrant, n, phone } = await waitingHolder();
      const { user } = await createUser(t.db);
      const { phone: before } = await createPhoneVerification(t.db, { userId: user.id });
      const vars = { user_id: user.id, new_phone: phone, new_hash: n };
      // The pre-check sees it before any SMS (4차 answer 1); step 5's SQL refuses it on its own.
      expect(await precheck(vars)).toEqual(WAITING_ELSEWHERE);
      expect(await change(vars)).toEqual(REFUSED_NO_GRANT);
      expect(await phoneOf(user.id)).toBe(before);
      expect(await liveHolders(n)).toEqual([{ grantId: yGrant.id }]);
      // Asked again while Y's grant waits: the pre-check still flags it, and the change would be
      // the same refusal.
      expect(await precheck(vars)).toEqual(WAITING_ELSEWHERE);
      expect(await change(vars)).toEqual(REFUSED_NO_GRANT);
      expect(await phoneOf(user.id)).toBe(before);
      // Once Y's grant is settled the change, asked and confirmed again from step 1, goes through.
      if (settle === 'pay') {
        // Paid: N got the start Coin, and this account gets none on it (answer 3).
        expect((await pay(yGrant.id)).outcome).toBe('granted');
        expect(await precheck(vars)).toEqual(FREE);
        expect(await change(vars)).toEqual({ ...NO_GRANT_ON_PAID, next: 'COMMIT' });
        expect(await t.db.transaction((tx) => recordStartGrant(tx, user.id, n))).toEqual({
          outcome: 'number_already_used',
        });
      } else {
        // Y withdrew while its grant waited: N was never paid and is free, so this account's
        // grant records it.
        expect((await withdraw(y.id)).outcome).toBe('cancelled');
        expect(await precheck(vars)).toEqual(FREE);
        expect(await change(vars)).toEqual({ updated: 1, inserted: 0, held: [], next: 'COMMIT' });
        const recorded = await t.db.transaction((tx) => recordStartGrant(tx, user.id, n));
        expect(recorded.outcome).toBe('recorded');
      }
      expect(await phoneOf(user.id)).toBe(phone);
    }
  });

  it('pre-checks the new number before any SMS: flags exactly what step 5 would refuse', async () => {
    // Owner decision 2026-10-19 4차, answer 1 (ADR-0071 7-31): another account's verified number
    // and a number a waiting grant of another account holds are refused before the code goes out.
    // Each case is pre-checked and then changed as step 5 would: flagged exactly when refused.
    async function checkedThenChanged(vars: Vars) {
      const pre = await precheck(vars);
      const outcome = await change(vars);
      const flagged = pre.other_verified || pre.other_waiting;
      expect('refused' in outcome, JSON.stringify({ pre, outcome })).toBe(flagged);
      return { pre, outcome };
    }
    const { user: x } = await createUser(t.db);
    const xGrant = await createStartGrant(t.db, { userId: x.id });
    const xPhone = (await phoneOf(x.id))!;
    const xHash = (await numbersOf(xGrant.id))[0]!;
    const { user: fresh } = await createUser(t.db);
    await createPhoneVerification(t.db, { userId: fresh.id });

    // Verified by another account (no grant there): flagged, and step 5's UPDATE refuses it.
    const { user: other } = await createUser(t.db);
    const { phone: taken } = await createPhoneVerification(t.db, { userId: other.id });
    for (const account of [x, fresh]) {
      expect(
        await checkedThenChanged({
          user_id: account.id,
          new_phone: taken,
          new_hash: randomPhoneHash(),
        }),
      ).toEqual({ pre: { other_verified: true, other_waiting: false }, outcome: REFUSED_VERIFIED });
    }
    // Verified by an account whose grant waits and holds that number's hash: both flagged; the
    // UPDATE refuses first.
    const { user: z } = await createUser(t.db);
    const { phone: zPhone } = await createPhoneVerification(t.db, { userId: z.id });
    const zHash = randomPhoneHash();
    await createStartGrant(t.db, { userId: z.id, phoneHash: zHash });
    expect(await checkedThenChanged({ user_id: x.id, new_phone: zPhone, new_hash: zHash })).toEqual(
      { pre: { other_verified: true, other_waiting: true }, outcome: REFUSED_VERIFIED },
    );

    // Held by another account's waiting grant, verified by nobody: flagged, and step 5 refuses it
    // with the INSERT (an account with a grant) or the DO block (one without).
    const { n, phone } = await waitingHolder();
    expect(await checkedThenChanged({ user_id: x.id, new_phone: phone, new_hash: n })).toEqual({
      pre: WAITING_ELSEWHERE,
      outcome: REFUSED_WAITING,
    });
    expect(await checkedThenChanged({ user_id: fresh.id, new_phone: phone, new_hash: n })).toEqual({
      pre: WAITING_ELSEWHERE,
      outcome: REFUSED_NO_GRANT,
    });

    // Not flagged, and step 5 takes it: a paid grant's number of an account that withdrew…
    const { user: earlier } = await createUser(t.db);
    const paidHash = randomPhoneHash();
    await createStartGrant(t.db, { userId: earlier.id, phoneHash: paidHash, amountCoin: 100n });
    await t.db.delete(phoneVerifications).where(eq(phoneVerifications.userId, earlier.id));
    expect(
      await checkedThenChanged({ user_id: fresh.id, new_phone: randomPhone(), new_hash: paidHash }),
    ).toEqual({ pre: FREE, outcome: { ...NO_GRANT_ON_PAID, next: 'COMMIT' } });
    // …a free number…
    const freePhone = randomPhone();
    const freeHash = randomPhoneHash();
    expect(
      await checkedThenChanged({ user_id: x.id, new_phone: freePhone, new_hash: freeHash }),
    ).toMatchObject({ pre: FREE, outcome: { updated: 1, inserted: 1, next: 'COMMIT' } });
    // …the account's own number, and a number its own waiting grant holds (back to the old one).
    expect(
      await checkedThenChanged({ user_id: x.id, new_phone: freePhone, new_hash: freeHash }),
    ).toMatchObject({ pre: FREE, outcome: { updated: 1, inserted: 0, next: 'COMMIT' } });
    expect(
      await checkedThenChanged({ user_id: x.id, new_phone: xPhone, new_hash: xHash }),
    ).toMatchObject({ pre: FREE, outcome: { updated: 1, inserted: 0, next: 'COMMIT' } });
    expect(await phoneOf(x.id)).toBe(xPhone);
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
    ).toEqual(REFUSED_OLD_NUMBER);
    // A mistyped id on a number a waiting grant holds is still `UPDATE 0`'s row: the DO block
    // refuses the `UPDATE 0` before it looks at the waiting grant, whose refusal speaks only for an
    // account with a 본인확인 record — nothing to tell a member.
    const { y, n, phone } = await waitingHolder();
    expect(await change({ user_id: 'no-such-account', new_phone: phone, new_hash: n })).toEqual(
      REFUSED_OLD_NUMBER,
    );
    // Nor for the holder itself, whose number it is.
    expect(await change({ user_id: y.id, new_phone: phone, new_hash: n })).toMatchObject({
      updated: 1,
      inserted: 0,
      held: [{ this_account: true, source: 'grant', paid: false, has_grant: true }],
      next: 'COMMIT',
    });
    const { user: a } = await createUser(t.db);
    const { user: b } = await createUser(t.db);
    const verified = await createPhoneVerification(t.db, { userId: a.id });
    await createStartGrant(t.db, { userId: b.id });
    const bPhone = await phoneOf(b.id);
    expect(
      await change({ user_id: b.id, new_phone: verified.phone, new_hash: randomPhoneHash() }),
    ).toEqual(REFUSED_VERIFIED);
    expect(await phoneOf(b.id)).toBe(bPhone);
  });
  // ---- the likes (#49, owner decisions 2026-10-20 and 2026-10-21, ADR-0076) ---------------------

  /** Every like row, as (account, target, hash) and its time, ordered for comparing. */
  async function likeRows() {
    const onPosts = await t.db.select().from(postLikes);
    const onComments = await t.db.select().from(commentLikes);
    return [
      ...onPosts.map((row) => ({ ...row, target: row.postId })),
      ...onComments.map((row) => ({ ...row, target: row.commentId })),
    ]
      .map(({ userId, target, phoneHash, createdAt }) => ({ userId, target, phoneHash, createdAt }))
      .sort((a, b) => `${a.userId}${a.target}`.localeCompare(`${b.userId}${b.target}`));
  }

  /** A post and a 댓글 under it, by an author of their own, for likes to land on. */
  async function targets() {
    const { user: author } = await createUser(t.db);
    const market = await createMarket(t.db);
    const post = await createPost(t.db, { marketId: market.id, authorId: author.id });
    const comment = await createComment(t.db, { postId: post.id, authorId: author.id });
    return { post, comment };
  }

  /** An account with a 본인확인 record whose likes carry `phoneHash`, as LikesService writes them. */
  async function liker(phoneHash: string) {
    const { user } = await createUser(t.db);
    await createPhoneVerification(t.db, { userId: user.id });
    return { user, phoneHash };
  }

  it('moves the account’s likes to the new number, keeping its own where the new number liked the same target', async () => {
    const one = await targets();
    const two = await targets();
    const three = await targets();
    const oldHash = randomPhoneHash();
    const newHash = randomPhoneHash();
    const a = await liker(oldHash);
    const yesterday = new Date(Date.now() - 86_400_000);
    for (const { post, comment } of [one, two]) {
      await createPostLike(t.db, { userId: a.user.id, postId: post.id, phoneHash: oldHash });
      await createCommentLike(t.db, {
        userId: a.user.id,
        commentId: comment.id,
        phoneHash: oldHash,
        createdAt: yesterday,
      });
    }
    // A withdrawn account held the new number and liked `one` (as A did) and `three` (A did not).
    const { user: v } = await createUser(t.db);
    for (const { post, comment } of [one, three]) {
      await createPostLike(t.db, { userId: v.id, postId: post.id, phoneHash: newHash });
      await createCommentLike(t.db, { userId: v.id, commentId: comment.id, phoneHash: newHash });
    }
    // Somebody else's likes, on a number of their own: of `one`'s post, and of `three`'s post and
    // comment, which the withdrawn account liked under the new number and A did not. Those of the
    // withdrawn account stay beside W's: the first DELETE looks only at the targets A liked, not
    // at every target another account liked too (ADR-0076 7-18).
    const w = await liker(randomPhoneHash());
    await createPostLike(t.db, { userId: w.user.id, postId: one.post.id, phoneHash: w.phoneHash });
    await createPostLike(t.db, {
      userId: w.user.id,
      postId: three.post.id,
      phoneHash: w.phoneHash,
    });
    await createCommentLike(t.db, {
      userId: w.user.id,
      commentId: three.comment.id,
      phoneHash: w.phoneHash,
    });
    const before = await likeRows();
    const at = (userId: string, target: string) =>
      before.find((row) => row.userId === userId && row.target === target)!.createdAt;

    const vars = { user_id: a.user.id, new_phone: randomPhone(), new_hash: newHash };
    // The likes give the result table nothing to read: the same row, the same COMMIT.
    expect(await change(vars)).toEqual({ updated: 1, inserted: 0, held: [], next: 'COMMIT' });
    const expected = [
      // A's, under the new number's hash, with their account, target and time.
      ...[one, two].flatMap(({ post, comment }) => [
        {
          userId: a.user.id,
          target: post.id,
          phoneHash: newHash,
          createdAt: at(a.user.id, post.id),
        },
        {
          userId: a.user.id,
          target: comment.id,
          phoneHash: newHash,
          createdAt: yesterday,
        },
      ]),
      // The withdrawn account's like of `one` was the new number's second like there: one stays,
      // A's. Its like of `three` stays the new number's (A now sees it as its own, decision 7-3).
      {
        userId: v.id,
        target: three.post.id,
        phoneHash: newHash,
        createdAt: at(v.id, three.post.id),
      },
      {
        userId: v.id,
        target: three.comment.id,
        phoneHash: newHash,
        createdAt: at(v.id, three.comment.id),
      },
      ...[one.post, three.post, three.comment].map(({ id }) => ({
        userId: w.user.id,
        target: id,
        phoneHash: w.phoneHash,
        createdAt: at(w.user.id, id),
      })),
    ].sort((x, y) => `${x.userId}${x.target}`.localeCompare(`${y.userId}${y.target}`));
    expect(await likeRows()).toEqual(expected);
    // Nothing of A's is left under the old number (it inherited none there): whoever verifies it
    // next likes what A liked.
    const b = await liker(oldHash);
    for (const { post, comment } of [one, two]) {
      await createPostLike(t.db, { userId: b.user.id, postId: post.id, phoneHash: oldHash });
      await createCommentLike(t.db, {
        userId: b.user.id,
        commentId: comment.id,
        phoneHash: oldHash,
      });
    }
    // Run again (a retried session): nothing more moves, B's likes stay B's.
    expect(await change(vars)).toMatchObject({ updated: 1, next: 'COMMIT' });
    const after = await likeRows();
    expect(after.filter((row) => row.userId !== b.user.id)).toEqual(expected);
    expect(after.filter((row) => row.userId === b.user.id).map((row) => row.phoneHash)).toEqual(
      Array(4).fill(oldHash),
    );
  });

  it('moves the likes the account inherited on its old number too, the one coming with it staying where the new number liked the same target', async () => {
    // Owner decision 2026-10-21 (ADR-0076): a withdrawn account W held A's old number, and its
    // likes, which A saw as its own (decision 7-3), go with A to the new number.
    const one = await targets();
    const two = await targets();
    const three = await targets();
    const oldHash = randomPhoneHash();
    const newHash = randomPhoneHash();
    const a = await liker(oldHash);
    const oldPhone = (await phoneOf(a.user.id))!;
    const lastWeek = new Date(Date.now() - 7 * 86_400_000);
    const { user: w } = await createUser(t.db);
    await createPostLike(t.db, {
      userId: w.id,
      postId: one.post.id,
      phoneHash: oldHash,
      createdAt: lastWeek,
    });
    await createCommentLike(t.db, { userId: w.id, commentId: one.comment.id, phoneHash: oldHash });
    await createPostLike(t.db, { userId: w.id, postId: two.post.id, phoneHash: oldHash });
    // A's own like, under the old number too.
    await createPostLike(t.db, { userId: a.user.id, postId: three.post.id, phoneHash: oldHash });
    // V, withdrawn, held the new number: it liked `one`'s post and 댓글 (as W did — on both
    // tables, an inherited like meets the new number's) and `three`'s 댓글 (which nothing of A's
    // liked).
    const { user: v } = await createUser(t.db);
    await createPostLike(t.db, { userId: v.id, postId: one.post.id, phoneHash: newHash });
    await createCommentLike(t.db, { userId: v.id, commentId: one.comment.id, phoneHash: newHash });
    await createCommentLike(t.db, {
      userId: v.id,
      commentId: three.comment.id,
      phoneHash: newHash,
    });
    // Untouched: a live account's like on a number of its own, and a withdrawn account's on
    // another number than the old one.
    const y = await liker(randomPhoneHash());
    await createPostLike(t.db, { userId: y.user.id, postId: one.post.id, phoneHash: y.phoneHash });
    const { user: u } = await createUser(t.db);
    const otherHash = randomPhoneHash();
    await createCommentLike(t.db, {
      userId: u.id,
      commentId: two.comment.id,
      phoneHash: otherHash,
    });
    // And a live account's like under the old number — only a number changed outside the procedure
    // leaves one there (ADR-0076 7-19): a live account's like is its own, never inherited.
    const l = await liker(oldHash);
    await createCommentLike(t.db, {
      userId: l.user.id,
      commentId: three.comment.id,
      phoneHash: oldHash,
    });
    const before = await likeRows();
    const at = (userId: string, target: string) =>
      before.find((row) => row.userId === userId && row.target === target)!.createdAt;

    const newPhone = randomPhone();
    const vars = { user_id: a.user.id, new_phone: newPhone, new_hash: newHash };
    expect(await change({ ...vars, old_phone: oldPhone, old_hash: oldHash })).toEqual({
      updated: 1,
      inserted: 0,
      held: [],
      next: 'COMMIT',
    });
    const row = (userId: string, target: string, phoneHash: string) => ({
      userId,
      target,
      phoneHash,
      createdAt: at(userId, target),
    });
    const expected = [
      // W's three likes under the new number, still W's, with their time; V's likes of `one`'s post
      // and 댓글 were the new number's second likes there: the ones coming with A stay, and V has
      // none left on `one` (ADR-0076 7-23).
      row(w.id, one.post.id, newHash),
      row(w.id, one.comment.id, newHash),
      row(w.id, two.post.id, newHash),
      row(a.user.id, three.post.id, newHash),
      // V's like of a target nothing of A's liked stays the new number's (A sees it as its own).
      row(v.id, three.comment.id, newHash),
      row(y.user.id, one.post.id, y.phoneHash),
      row(u.id, two.comment.id, otherHash),
      row(l.user.id, three.comment.id, oldHash),
    ].sort((x, z) => `${x.userId}${x.target}`.localeCompare(`${z.userId}${z.target}`));
    expect(await likeRows()).toEqual(expected);
    expect(at(w.id, one.post.id)).toEqual(lastWeek);
    // Nothing is left under the old number: B, its next holder, likes every one of those targets.
    const b = await liker(oldHash);
    const freed = [one.post.id, two.post.id, three.post.id];
    for (const postId of freed) {
      await createPostLike(t.db, { userId: b.user.id, postId, phoneHash: oldHash });
    }
    await createCommentLike(t.db, {
      userId: b.user.id,
      commentId: one.comment.id,
      phoneHash: oldHash,
    });
    // B withdraws: its likes are now a withdrawn account's under the old number. The same lines run
    // again — the old number not read again — are `UPDATE 0`, and the DO block refuses them: they
    // would carry B's likes to A and delete W's, now the new number's, on the same targets. The
    // COMMIT a misreading operator types answers ROLLBACK, and nothing moved. Read again (step 3),
    // the old number is the new one, and nothing more moves.
    await withdraw(b.user.id);
    const withB = await likeRows();
    expect(await change({ ...vars, old_phone: oldPhone, old_hash: oldHash })).toEqual(
      REFUSED_OLD_NUMBER,
    );
    expect(await likeRows()).toEqual(withB);
    expect(await change({ ...vars, old_phone: newPhone, old_hash: newHash })).toMatchObject({
      updated: 1,
      next: 'COMMIT',
    });
    expect(await likeRows()).toEqual(withB);
    expect(withB.filter((like) => like.userId === b.user.id)).toHaveLength(4);
  });

  it('keeps the account’s own like where one it inherited stood on the same target', async () => {
    // Only a number changed outside the procedure (ADR-0076 7-3, 7-19) leaves the account's own
    // like of a target under another hash than the old one — or under the new one already — beside
    // a withdrawn account's under the old number: one like per number, the account's (7-23).
    const { post, comment } = await targets();
    const oldHash = randomPhoneHash();
    const newHash = randomPhoneHash();
    const a = await liker(oldHash);
    await createPostLike(t.db, {
      userId: a.user.id,
      postId: post.id,
      phoneHash: randomPhoneHash(),
    });
    await createCommentLike(t.db, { userId: a.user.id, commentId: comment.id, phoneHash: newHash });
    const { user: w } = await createUser(t.db);
    await createPostLike(t.db, { userId: w.id, postId: post.id, phoneHash: oldHash });
    await createCommentLike(t.db, { userId: w.id, commentId: comment.id, phoneHash: oldHash });
    const before = await likeRows();
    const vars = { user_id: a.user.id, new_phone: randomPhone(), new_hash: newHash };
    expect(await change({ ...vars, old_hash: oldHash })).toMatchObject({
      updated: 1,
      next: 'COMMIT',
    });
    expect(await likeRows()).toEqual(
      before
        .filter((like) => like.userId === a.user.id)
        .map((like) => ({ ...like, phoneHash: newHash })),
    );
  });

  it('keeps a live account’s likes on the new number: the ones coming with the account give way to them, and a withdrawn account’s still to those', async () => {
    // Codex review on PR #222 (ADR-0076 7-26): B's number was changed outside the procedure, so its
    // likes still carry the hash of the number it held — A's new one (7-19). B is live: its likes
    // are its own (7-3), and the change deletes none of them. Where B liked a target A's own like
    // or one A inherited is on, B's stays and the one coming with A gives way — one like per
    // number. A withdrawn account's like on the new number still gives way to the ones coming with
    // A (7-18, 7-23).
    const one = await targets(); // A's own like, and B's
    const two = await targets(); // inherited from W, and B's
    const three = await targets(); // A's own like, and V's
    const four = await targets(); // inherited from W, and V's
    const five = await targets(); // B's alone
    const oldHash = randomPhoneHash();
    const newHash = randomPhoneHash();
    const a = await liker(oldHash);
    const oldPhone = (await phoneOf(a.user.id))!;
    // Live, on a number of its own now; its likes carry the new number's hash.
    const b = await liker(newHash);
    // Withdrawn: W held A's old number, V the new one.
    const { user: w } = await createUser(t.db);
    const { user: v } = await createUser(t.db);
    const like = async (userId: string, phoneHash: string, ...on: (typeof one)[]) => {
      for (const { post, comment } of on) {
        await createPostLike(t.db, { userId, postId: post.id, phoneHash });
        await createCommentLike(t.db, { userId, commentId: comment.id, phoneHash });
      }
    };
    await like(a.user.id, oldHash, one, three);
    await like(w.id, oldHash, two, four);
    await like(b.user.id, newHash, one, two, five);
    await like(v.id, newHash, three, four);
    const before = await likeRows();
    const at = (userId: string, target: string) =>
      before.find((row) => row.userId === userId && row.target === target)!.createdAt;
    const row = (userId: string, target: string) => ({
      userId,
      target,
      phoneHash: newHash,
      createdAt: at(userId, target),
    });

    const vars = { user_id: a.user.id, new_phone: randomPhone(), new_hash: newHash };
    // The pre-check flags nothing: B verified another number.
    expect(await precheck(vars)).toEqual(FREE);
    expect(await change({ ...vars, old_phone: oldPhone, old_hash: oldHash })).toEqual({
      updated: 1,
      inserted: 0,
      held: [],
      next: 'COMMIT',
    });
    const expected = [
      // B's, every one, as they were.
      ...[one, two, five].flatMap(({ post, comment }) => [
        row(b.user.id, post.id),
        row(b.user.id, comment.id),
      ]),
      // On `three` and `four` the ones coming with A stay, V's are deleted.
      row(a.user.id, three.post.id),
      row(a.user.id, three.comment.id),
      row(w.id, four.post.id),
      row(w.id, four.comment.id),
    ].sort((x, y) => `${x.userId}${x.target}`.localeCompare(`${y.userId}${y.target}`));
    expect(await likeRows()).toEqual(expected);
    // A's and W's likes of `one` and `two` gave way to B's: none is left under the old number, so
    // its next holder likes all four targets.
    expect(
      (await likeRows()).filter((like) => like.phoneHash === oldHash || like.userId === v.id),
    ).toEqual([]);
    const next = await liker(oldHash);
    await like(next.user.id, oldHash, one, two, three, four);
    // Run again with the old number read again — the new one — and nothing more moves.
    expect(
      await change({ ...vars, old_phone: (await phoneOf(a.user.id))!, old_hash: newHash }),
    ).toMatchObject({ updated: 1, next: 'COMMIT' });
    expect((await likeRows()).filter((like) => like.userId !== next.user.id)).toEqual(expected);
  });

  it('reads the number the account holds for step 3: none once it has no 본인확인 record', async () => {
    const { user } = await createUser(t.db);
    const { phone } = await createPhoneVerification(t.db, { userId: user.id });
    expect(await read(OPERATOR_CURRENT_NUMBER_SQL, { user_id: user.id })).toEqual([{ phone }]);
    expect(await read(OPERATOR_CURRENT_NUMBER_SQL, { user_id: 'no-such-account' })).toEqual([]);
    await withdraw(user.id);
    expect(await read(OPERATOR_CURRENT_NUMBER_SQL, { user_id: user.id })).toEqual([]);
  });

  /**
   * Step 5 typed through to a COMMIT whatever it printed — an operator who reads an `UPDATE 0` as
   * a COMMIT row: BEGIN, the doc's statements (psql going on past a failed one), COMMIT. What the
   * UPDATE and the COMMIT answered.
   */
  async function committedAnyway(vars: Required<Vars>) {
    const client = new Client({ connectionString: testDbUrls()!.appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      const counts: (number | null)[] = [];
      for (const statement of statementsOf(vars)) {
        counts.push(
          await client.query(statement).then(
            (result) => result.rowCount,
            () => null,
          ),
        );
      }
      return { updated: counts[0], commit: (await client.query('COMMIT')).command };
    } finally {
      await client.end();
    }
  }

  it('keeps nothing of a change from an old number the account does not hold, a COMMIT typed after it included', async () => {
    // A number typed wrong into the CLI's --psql-old, or the lines of a change that committed run
    // again: the hash is another number's. The likes' block would carry its withdrawn account's
    // likes to the account and delete the new number's likes of the same targets — for good, as
    // they are deleted, not changed — and the INSERT would record the new number beside the
    // account's grant. `UPDATE 0` says so, and the DO block refuses it: even the COMMIT of an
    // operator who did not read it answers ROLLBACK (ADR-0076 7-24).
    const one = await targets();
    const two = await targets();
    const { user } = await createUser(t.db);
    const grant = await createStartGrant(t.db, { userId: user.id, amountCoin: 100n });
    const phone = (await phoneOf(user.id))!;
    const numbers = await numbersOf(grant.id);
    const elsewhere = randomPhoneHash();
    const newHash = randomPhoneHash();
    // W withdrew on that other number after liking both targets; V withdrew on the new number
    // after liking `one`'s post and 댓글.
    const { user: w } = await createUser(t.db);
    for (const { post, comment } of [one, two]) {
      await createPostLike(t.db, { userId: w.id, postId: post.id, phoneHash: elsewhere });
      await createCommentLike(t.db, { userId: w.id, commentId: comment.id, phoneHash: elsewhere });
    }
    const { user: v } = await createUser(t.db);
    await createPostLike(t.db, { userId: v.id, postId: one.post.id, phoneHash: newHash });
    await createCommentLike(t.db, { userId: v.id, commentId: one.comment.id, phoneHash: newHash });
    const before = await likeRows();
    const vars = {
      user_id: user.id,
      new_phone: randomPhone(),
      new_hash: newHash,
      old_phone: randomPhone(),
      old_hash: elsewhere,
    };
    // As the doc has it: the `UPDATE 0` row, whose ROLLBACK a COMMIT would answer too.
    expect(await change(vars)).toEqual(REFUSED_OLD_NUMBER);
    // Typed through to a COMMIT, with nothing read: ROLLBACK, and nothing kept.
    expect(await committedAnyway(vars)).toEqual({ updated: 0, commit: 'ROLLBACK' });
    expect(await phoneOf(user.id)).toBe(phone);
    expect(await numbersOf(grant.id)).toEqual(numbers);
    expect(await likeRows()).toEqual(before);
    // The number the account holds, read and hashed as step 3 does, goes through.
    expect(await change({ ...vars, old_phone: phone, old_hash: randomPhoneHash() })).toMatchObject({
      updated: 1,
      inserted: 1,
      next: 'COMMIT',
    });
    expect(await likeRows()).toEqual(before);
  });

  it('moves no like when the change is refused', async () => {
    const { post, comment } = await targets();
    const oldHash = randomPhoneHash();
    // On another account's verified number (the UPDATE) and on a waiting grant's (the DO block,
    // which comes before the likes' block): neither its own likes nor those it inherited move.
    const a = await liker(oldHash);
    await createPostLike(t.db, { userId: a.user.id, postId: post.id, phoneHash: oldHash });
    const { user: w } = await createUser(t.db);
    await createCommentLike(t.db, { userId: w.id, commentId: comment.id, phoneHash: oldHash });
    const before = await likeRows();
    const { user: other } = await createUser(t.db);
    const { phone: taken } = await createPhoneVerification(t.db, { userId: other.id });
    expect(
      await change({
        user_id: a.user.id,
        new_phone: taken,
        new_hash: randomPhoneHash(),
        old_hash: oldHash,
      }),
    ).toEqual(REFUSED_VERIFIED);
    const { n, phone } = await waitingHolder();
    expect(
      await change({ user_id: a.user.id, new_phone: phone, new_hash: n, old_hash: oldHash }),
    ).toEqual(REFUSED_NO_GRANT);
    expect(await likeRows()).toEqual(before);
  });

  it('moves a like the account committed while the change waited on its record', async () => {
    // LikesService holds the liker's 본인확인 row FOR KEY SHARE and writes the like under the hash
    // of the number it read: the change's UPDATE waits for it, and the likes' block, a later
    // statement, sees the like and moves it.
    const { post } = await targets();
    const oldHash = randomPhoneHash();
    const newHash = randomPhoneHash();
    const a = await liker(oldHash);
    const holder = await t.db.$client.connect();
    let changed;
    let committed = false;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM phone_verifications WHERE user_id = $1 FOR KEY SHARE', [
        a.user.id,
      ]);
      await holder.query(
        'INSERT INTO post_likes (post_id, user_id, phone_hash) VALUES ($1, $2, $3)',
        [post.id, a.user.id, oldHash],
      );
      changed = change({ user_id: a.user.id, new_phone: randomPhone(), new_hash: newHash });
      expect(await psqlWaits()).toBe(true);
      await holder.query('COMMIT');
      committed = true;
    } finally {
      if (!committed) await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await changed).toEqual({ updated: 1, inserted: 0, held: [], next: 'COMMIT' });
    expect((await likeRows()).map((row) => [row.userId, row.phoneHash])).toEqual([
      [a.user.id, newHash],
    ]);
  });
});
