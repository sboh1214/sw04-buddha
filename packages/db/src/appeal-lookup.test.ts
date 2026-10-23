/**
 * Step 2 of the operator's handling of a sanction appeal (#186, ADR-0084): the read-only lookup
 * docs/OPERATIONS.md gives, verbatim, what the doc says to do with what it returns, and what it
 * returns when run as buddha_app the way the doc runs it — psql, the `sender` variable written in.
 * The account is the one whose current email is exactly the sender's address (owner decision
 * 2026-10-22 답 5, the phone change's lookup), never a card picked out of `/admin/users`' substring
 * search; each action comes with its time in KST to the second and the last second an appeal of it
 * is in time — the end of the minute its deadline shows in, …:59 (owner decision 2026-10-23 답 5) —
 * which the operator compares with the mailbox's arrival time (답 10): the screens show the minute
 * only (ADR-0084 6-8). The doc's replies and what it still leaves to the owner are read here too
 * (오너 결정 2026-10-22 (2차), 2026-10-23). Skips the database part when TEST_* are unset.
 */
import { readFileSync } from 'node:fs';
import {
  adminUserQuerySchema,
  APPEAL_WINDOW_DAYS,
  appealWindowEndOf,
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
const SETTINGS = readFileSync(new URL('../../../docs/SETTINGS.md', import.meta.url), 'utf8');

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

/** The second just before `end`, as the lookup writes it. */
function lastSecondBefore(end: Date): string {
  return kstToSecond(new Date(end.getTime() - 1));
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
    // The deadline to its minute's last second (owner decision 2026-10-23 답 5).
    expect(OPERATOR_APPEAL_LOOKUP_SQL).toContain("'YYYY-MM-DD HH24:MI') || ':59' AS deadline_kst");
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

  it('keeps an appeal in time to the end of the minute its deadline shows, by the lookup’s deadline', () => {
    // Owner decision 2026-10-23 답 5: mail the mailbox receives up to the displayed minute's last
    // second (…:59) is in time. The lookup's `deadline_kst` is that second, so the operator neither
    // adds 14 days to a screen's minute nor reads a `Received` line for the seconds.
    const text = step3();
    expect(text).toContain(
      '회원에게 보인 기한의 그 분이 끝날 때(…:59)까지 메일함에 도착한 메일은 기한 안이다(오너 결정 2026-10-23 답 5)',
    );
    expect(text).toContain('그 마지막 초가 2의 조회에서 그 조치의 `deadline_kst`(한국 시간)다');
    expect(text).toContain('받은 시각이 `deadline_kst`와 같거나 앞이면 기한 안이고, 뒤면 지났다');
    expect(text).toContain(
      '메일함이 받은 시각을 분까지만 보이면 그 분이 `deadline_kst`의 분과 같거나 앞이면 기한 안이다',
    );
    expect(text).toContain('분까지만 보이고 초를 버리므로');
    expect(text).toContain("회원의 카드도 그 분이 끝날 때 '이의 기한이 지났습니다.'로 바뀐다");
    // The same second is no question any more, and no screen's minute is «the same instant».
    expect(appealSection()).not.toContain('같은 초라 앞뒤를 정할 수 없으면');
    expect(appealSection()).not.toContain('같은 순간이다');
    expect(step2()).toContain('`deadline_kst`는 그 조치의 이의가 기한 안인 마지막 초');
  });

  it('answers unconfirmed mail with the owner’s one sentence, the same whoever sent it', () => {
    // Owner decision 2026-10-22 (2차) 1: the sentence that names neither the account nor an action,
    // to the sender's address — it replaced the first draft's proposal.
    const text = sectionOf('   - 확인되지 않은 메일:', '   - 가입한 이메일인데');
    expect(text).toContain(
      inListItem(['```text', '이의는 가입한 이메일로 보낸 메일만 받습니다.', '```']),
    );
    expect(text).toContain('오너 결정 2026-10-22 (2차) 1');
    expect(appealSection()).not.toContain('이 메일로는 이의를 받을 수 없습니다');
    // The same sentence whether an account has the address or not (답 5): no second reply that
    // would tell an account's own address from another to whoever sent the mail.
    expect(text).toContain(
      '회신은 계정이 있는지(그리고 조치가 있는지) 드러내지 않는 아래의 한 문장만이고, 계정이 있든 없든 어느 경우든 같다',
    );
    expect(text.match(/```text/g)).toHaveLength(1);
    // The one exception goes to the account's own address alone.
    expect(text).toContain('그 글은 그 계정의 주소로만 간다');
  });

  it('tells a member whose own address keeps failing the sender check to change it, at that address (owner decision 2026-10-23 답 3)', () => {
    // From the account's current email yet failing authentication, a resend fails the same way:
    // the first such mail has the neutral sentence, and the next one from that address the owner's
    // text, sent by hand to the account's current email — never to a Reply-To — so whoever forged
    // the mail learns nothing. It uses up no appeal either.
    const text = sectionOf(
      '   - 가입한 이메일인데 발신 인증에 계속 실패하는 메일:',
      '3. **기한과 횟수.**',
    );
    expect(text).toContain('처음 온 그런 메일은 위의 한 문장을 받는다');
    // The owner gave the text and its recipient; reading '계속' as the second failure is this
    // ADR's, put to the owner (결과 4의 12) — never credited to 답 3 alone.
    expect(text).toContain(
      "같은 주소에서 온 메일이 위의 한 문장을 받은 뒤에도 다시 발신 인증을 통과하지 못하면 — 계속 실패하면 — 그 메일에는 위의 한 문장 대신 아래의 글을 보낸다(글과 받는 사람은 오너 결정 2026-10-23 답 3, '계속'을 두 번째부터로 읽은 것은 ADR-0084 6-8, 결과 4의 12)",
    );
    expect(text).not.toContain('아래의 글을 보낸다(오너 결정 2026-10-23 답 3)');
    // The mail resent from the changed address is a new appeal, timed by its own arrival until the
    // owner answers: two replies can carry an in-time first mail past the deadline (결과 4의 12).
    expect(text).toContain(
      '그 뒤 회원이 MY 설정에서 바꾼 이메일로 다시 보낸 메일은 새 이의로 2의 확인부터 보고, 기한 안인지는 3대로 그 메일이 메일함에 도착한 시각으로 본다',
    );
    expect(text).toContain(
      '처음 메일이 기한 안에 왔어도 위의 두 회신을 거치는 동안 기한이 지날 수 있다',
    );
    expect(text).toContain(
      '(ADR-0084 결과 4의 12, 그 답 전에는 다시 온 메일이 도착한 시각으로 본다)',
    );
    expect(step3()).toContain(
      '2의 발신 인증에 계속 실패한 가입한 이메일의 회원이 바꾼 이메일로 다시 보낸 메일은 그 메일의 도착 시각으로 본다 — ADR-0084 결과 4의 12',
    );
    expect(text).toContain(
      '받는 사람은 2의 조회로 정한 그 계정의 지금 이메일을 손으로 적은 것이다',
    );
    expect(text).toContain('이 메일도 검토하지 않고 어느 조치의 한 번도 쓰지 않는다');
    expect(text).toContain(
      inListItem([
        '```text',
        '이 주소에서 온 메일은 보낸 사람을 확인할 수 없습니다. MY 설정에서 다른 이메일로 바꾼 뒤 그 주소로 보내 주세요.',
        '```',
      ]),
    );
    // Step 2 holds the two texts, and the case is the owner's no more.
    expect(step2().match(/```text/g)).toHaveLength(2);
    expect(appealSection()).not.toContain('결과 4의 8');
    expect(appealSection()).not.toContain('이 문장으로는 달리 할 것을 알 수 없다');
  });

  it('asks back an appeal whose action it cannot tell, in the owner’s words, without using up that action’s one', () => {
    // (2차) 2: asking back is no appeal received; the member resends within the deadline, and the
    // mail that comes back is a new one, from step 2. The text is the owner's (2026-10-23 답 1),
    // asking for the post's or comment's title or first line too.
    const text = sectionOf('   - 되묻기:', '   - 기한:');
    expect(text).toContain('어느 조치인지 정할 수 없는 이의는 검토하지 않고 아래의 글로 되묻는다');
    expect(text).toContain('글은 오너 결정 2026-10-23 답 1');
    expect(text).toContain('되묻는 것은 그 조치의 한 번을 쓰지 않는다');
    expect(text).toContain('그 조치의 기한 안에 다시 보내야');
    expect(text).toContain(
      inListItem([
        '```text',
        '어느 조치인지(조치의 종류, 조치한 때, 글이나 댓글이면 그 제목이나 첫 줄)를 적어 그 조치의 이의 기한 안에 다시 보내 주세요.',
        '```',
      ]),
    );
    expect(appealSection()).not.toContain('어느 조치인지(조치의 종류와 조치한 때)를 적어 그 조치');
    // The asked-back mail is marked by the member, never by the sender — and counts as no appeal.
    expect(text).toContain("2의 조회의 `user_id`와 '되물음'을 함께 적은 표시");
    expect(text).toContain('`action_id`가 없어 받은 이의로 세지 않는다');
  });

  it('times a resend within 3 days of a late ask-back by the first mail (owner decision 2026-10-23 답 2)', () => {
    const text = sectionOf('   - 되묻기:', '   - 기한:');
    expect(text).toContain('다시 온 메일이 기한 안인지는 그 메일이 메일함에 도착한 시각으로 본다');
    // The 3 days are the owner's; counting them as 3×24 hours and using them after every ask-back
    // are this ADR's reading, put to the owner (결과 4의 10) — never credited to 답 2 alone.
    expect(text).toContain(
      '되묻는 메일을 보낸 때부터 3×24시간 안에 도착한 메일은 첫 메일 — 그 되묻기를 받은 메일 — 이 메일함에 도착한 시각으로 본다(3일은 오너 결정 2026-10-23 답 2, 3×24시간으로 세고 모든 되묻기에 쓰는 것은 ADR-0084 6-8, 결과 4의 10)',
    );
    expect(text).not.toContain('시각으로 본다(오너 결정 2026-10-23 답 2)');
    // It changes nothing for an ask-back more than 3 days before the deadline: the doc says so,
    // and the deadline step points back to it.
    expect(text).toContain('오너의 답은 기한 무렵이나 그 뒤에 되물은 경우를 말했는데');
    expect(text).toContain('기한 무렵(기한 전 3일 안)이나 그 뒤에 되물은 경우뿐이다');
    expect(step3()).toContain(
      '되물은 뒤 3×24시간 안에 다시 온 메일은 위의 되묻기대로 첫 메일의 도착 시각으로 본다 — 되묻기 하나에 조치 하나다',
    );
    // One ask-back lends the first mail's arrival to one action: the first appeal within the 3 days
    // that passes step 2 and names one action. Unconfirmed mail does not use it; other actions, in
    // that mail or later ones, keep their own arrival; the mark says it is used, with no action_id
    // (that would read as an appeal taken). Whether it reaches further is the owner's (결과 4의 13).
    expect(text).toContain(
      '첫 메일의 도착 시각으로 보는 것은 되묻기 하나에 조치 하나다 — 그 3×24시간 안에 다시 온 메일 가운데 2의 확인을 마치고 어느 조치인지 정해진 첫 이의의 그 조치뿐이다',
    );
    expect(text).toContain(
      '2의 확인을 마치지 못한 메일(확인되지 않은 메일)은 그것을 쓰지 않으므로',
    );
    expect(text).toContain(
      '같은 메일이나 그 뒤의 메일이 말하는 다른 조치는 그 메일이 도착한 시각으로 본다',
    );
    expect(text).toContain(
      "그 '되물음'의 표시에 '3일 씀'을 더해 다른 운영자도 알게 한다 — `action_id`는 적지 않는다",
    );
    expect(text).toContain(
      '되묻기 하나가 조치 여럿이나 메일 여럿에 쓰이는지는 정하지 않았다(ADR-0084 6-8, 결과 4의 13 — 그 답 전에는 이대로 조치 하나다)',
    );
    // The deadline-free text sent late is the owner's to judge (결과 4의 10).
    expect(text).toContain('기한 무렵이나 그 뒤에 되물을 때도 글은 위 그대로다');
    expect(text).toContain('(그때 이 글이 회원에게 맞는지는 ADR-0084 결과 4의 10)');
    expect(appealSection()).not.toContain(
      '그 답 전에는 위 그대로 다시 온 메일이 도착한 시각으로 본다',
    );
  });

  it('takes to the owner, rather than asking back again, a resend that still names no one action', () => {
    // Even with the title or first line, several actions of a type in one minute on items of the
    // same title, or a time copied without its '(GMT…)', can come back naming none or several.
    // Asked back again, the member loops until the deadline; the doc sends that to the owner.
    const text = sectionOf('   - 되묻기:', '   - 기한:');
    expect(text).toContain(
      '같은 종류의 조치를 같은 분에 여럿 받았고 그 제목이나 첫 줄도 같은 경우',
    );
    expect(text).toContain("회원이 차이('(GMT…)')를 빼고 옮긴 시각이 어느 조치와도 맞지 않는 경우");
    expect(text).toContain(
      '그러면 같은 글로 다시 되묻지 않고 오너에게 묻는다(ADR-0084 결과 4의 11)',
    );
  });

  it('answers an appeal it does not take with its reason, one sentence, and counts only the ones taken', () => {
    // (2차) 2: a cancelled action, a passed deadline, one appealed already — that reason alone, in
    // the order the member's card speaks (취소됨 with no deadline, then 이의 기한이 지났습니다.). The
    // three sentences and the order are the owner's (2026-10-23 답 1).
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
    expect(text).toContain('세 문장과 이 차례는 오너가 정한 것이다(오너 결정 2026-10-23 답 1)');
    // What counts as the action's one appeal: taken for review — never the mail step 2 could not
    // confirm, nor the one asked back.
    expect(text).toContain('4의 검토로 넘긴 이의만 센다');
    expect(text).toContain('확인되지 않은 메일(2), 되물은 메일(위)');
    // Nothing about these replies is left undecided, nor called a proposal, in the doc.
    expect(appealSection()).not.toContain('무엇을 회신할지는 정하지 않았다');
    expect(appealSection()).not.toContain('설계 제안');
  });

  it('marks an appeal taken by its account and action, and looks for that mark, not the sender', () => {
    // The app keeps no appeal, and a mail under review looks like one nobody has read: the mark
    // goes on before the review, and the next appeal is checked by `user_id` and `action_id` —
    // the account's email changes in MY 설정 and the database keeps no earlier one. The owner
    // approved it (2026-10-23 답 4), a marked mail with no reply yet counting as taken.
    const text = sectionOf('   - 받지 않는 것:', '4. **검토.**');
    expect(text).toContain(
      '검토를 시작하기 전에 그 메일에 2의 조회의 `user_id`와 `action_id`를 함께 적은 표시',
    );
    expect(text).toContain(
      '`user_id`와 `action_id`로 메일함에서 그 표시를 찾는다 — 보낸 주소로 찾지 않는다',
    );
    expect(text).toContain('계정의 이메일은 MY 설정에서 바뀌고(ADR-0023)');
    expect(text).toContain('표시가 있으면 6의 회신이 아직 없어도 받은 이의다');
    expect(text).toContain('이 표시와 찾기는 오너가 정한 것이다(오너 결정 2026-10-23 답 4)');
  });

  it('finds the action by what the member wrote — its title or first line too — turning the time into KST', () => {
    const text = sectionOf('   - 어느 조치인지:', '   - 되묻기:');
    expect(text).toContain(
      '회원이 적은 종류와 조치한 때, 글이나 댓글이면 그 제목이나 첫 줄로 찾는다',
    );
    expect(text).toContain("그 조치의 카드의 '글'·'댓글' 링크로 가는 화면에서 본다");
    expect(text).toContain('회원이 MY 설정에서 고른 시간대');
    expect(text).toContain("'(GMT-4)'처럼 붙는다");
    expect(text).toContain('차이가 붙은 시각은 한국 시간으로 바꿔 견준다');
    expect(text).toContain("'2026. 10. 21. 오전 2:00 (GMT-4)'는 한국 시간 2026-10-21 15:00이다");
    // What fits no single action is the ask-back, not a guess.
    expect(text).toContain(
      '회원이 적은 것에 맞는 조치가 하나가 아니면 어느 조치인지 정할 수 없는 이의다',
    );
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
    // The open cases: the deadline-free ask-back sent near or after the deadline (10), the resend
    // that still names no one action (11), the own address that keeps failing the sender check —
    // what '계속' means and when the mail from the changed address is due (12) — and how far one
    // ask-back's first-mail timing reaches (13).
    expect([...new Set(cited)].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
    const about: Record<number, string> = {
      10: '기한 무렵이나 그 뒤에 되묻는 글',
      11: '제목이나 첫 줄을 받은 뒤에도 조치 하나를 정하지 못하는 메일',
      12: "가입한 이메일에서 발신 인증에 계속 실패하는 메일의 '계속'과 그 뒤 다시 온 메일의 기한",
      13: '되묻기 하나가 첫 메일의 도착 시각을 주는 조치의 수',
    };
    for (const n of cited) expect(questions.get(n)).toContain(about[n]);
    // Each asks the owner rather than settling it, with the case that lost an in-time appeal.
    expect(questions.get(12)).toContain("(a) '계속'은 같은 주소에서 두 번째로 실패한 메일부터인가");
    expect(questions.get(12)).toContain('15일째에 바꾼 이메일에서 보내면');
    expect(questions.get(12)).toContain('위조일 수도 있어');
    expect(questions.get(13)).toContain('조치 A·B·C의 기한이 10·11·12일째인 회원');
    expect(questions.get(13)).toContain('이 읽기가 맞는가');
    // The counts that name these questions agree.
    const adr = adr0084();
    expect(adr).toContain('남은 것은 그 답을 따르며 새로 생긴 넷이다');
    expect(adr).toContain('새로 생긴 네 질문(');
    expect(adr).toContain('오너에게 묻는 경우(결과 4의 10\\~13)');
    // Decision 6-8 names both readings as this PR's and sends them there.
    expect(adr).toContain("'계속'의 읽기와 이 기한은 오너에게 묻는다(결과 4의 12)");
    expect(adr).toContain('이 PR은 좁게 읽었다 — 되묻기 하나에 조치 하나');
    expect(adr).toContain('이 읽기는 오너에게 묻는다(결과 4의 13)');
  });

  it('records in the settings only the 3 days as the owner’s, the rest as this ADR’s reading', () => {
    // docs/SETTINGS.md registers fixed values; the owner's 답 2 gave 3 days after an ask-back near
    // or after the deadline. Counting them as 3×24 hours, using them after every ask-back and for
    // one action are ADR-0084's readings, still asked (결과 4의 10·13).
    const line = SETTINGS.split('\n').find((l) =>
      l.startsWith('- 제재 이의의 안내(#186, ADR-0084)'),
    );
    expect(line).toBeDefined();
    expect(line).toContain(
      '운영자가 기한 무렵이나 그 뒤에 되물었으면 되묻는 메일을 보낸 때부터 3일 안에 다시 온 메일은 첫 메일이 도착한 시각으로 기한을 본다 — 3일은 오너가 정한 고정값이다(오너 결정 2026-10-23 답 2)',
    );
    expect(line).toContain(
      '그 3일을 3×24시간으로 세고 모든 되묻기에 쓰는 것은 ADR-0084의 읽기이고 오너에게 묻고 있다(ADR-0084 6-8, 결과 4의 10)',
    );
    expect(line).toContain('되묻기 하나에 조치 하나만 그렇게 보는 것도 그렇다(결과 4의 13)');
    expect(line).not.toContain('3일(3×24시간)');
    expect(line).not.toContain('오너가 정한 고정값이고 운영자의 절차');
  });

  it('asks nothing the owner answered on 2026-10-23, and records those answers', () => {
    // 결과 4의 4~9 were answered (오너 결정 2026-10-23 답 1~6): none is asked any more.
    const questions = ownerQuestions();
    for (const n of [4, 5, 6, 7, 8, 9]) expect(questions.has(n)).toBe(false);
    const adr = adr0084();
    for (const n of [1, 2, 3, 4, 5, 6])
      expect(adr).toContain(`| 오너 결정 2026-10-23 답 ${String(n)} `);
  });

  it('cites the second round’s answer 3 as (2차) and the second commit’s item 3 as its', () => {
    const adr = adr0084();
    // '그 계정의 내역에만' is (2차) 답 3, the placeholder-email line; a bare 답 3 is the first
    // round's, the banners.
    const quoted = [...adr.matchAll(/답 3 '그 계정의 내역에만'/g)].map((m) => m.index);
    expect(quoted.length).toBeGreaterThan(0);
    for (const at of quoted) expect(adr.slice(at - '(2차) '.length, at)).toBe('(2차) ');
    // The item that asked for the line '안내 아래에' was da19ec8's; this ADR's 결과 4 starts later.
    expect(adr).toContain("둘째 커밋(da19ec8) 결과 4의 3이 '안내 아래에'로 물은 자리");
    expect(adr).not.toContain("(결과 4의 3이 '안내 아래에'");
    expect(ownerQuestions().has(3)).toBe(false);
  });
});

describe('ADR-0084’s dates (날짜 정오표, owner decision 2026-10-23 00:50)', () => {
  it('corrects, after 결과 6, the cited answer received a day before its table’s name', () => {
    // Table names stay as identifiers; the erratum after 결과 6 says when the answer really came.
    // ADR-0078's «오너 결정 2026-10-21 답 1~9» — 답 8 is the refusal 결과 5 points to — were
    // received on 2026-10-20 (KST), as ADR-0078's own erratum on #41 says.
    const adr = adr0084();
    const files = adr.indexOf('**6. 파일.**');
    const erratum = adr.indexOf('**날짜 정오표(2026-10-23).**');
    expect(files).toBeGreaterThan(-1);
    expect(erratum).toBeGreaterThan(files);
    const text = adr.slice(erratum);
    expect(text).toContain(
      "'ADR-0078 오너 결정 2026-10-21 답 8'(제재 중 거절의 글)은 ADR-0078의 «오너 결정 2026-10-21 답 1\\~9»의 행이고, 실제로 2026-10-20(KST)에 받았다",
    );
    // The 결과 5 bullet no longer counts that answer among those with no date to fix.
    const bullet = adr.slice(adr.indexOf('- 날짜 바로잡기(m12의 규칙):'));
    const line = bullet.slice(0, bullet.indexOf('\n'));
    expect(line).toContain(
      "ADR-0078의 '2026-10-21 답 8'은 실제로 2026-10-20에 받은 답이다(결과 6 뒤의 날짜 정오표)",
    );
    const noFix = line.indexOf('고칠 날짜가 없다');
    expect(noFix).toBeGreaterThan(-1);
    const sentence = line.slice(line.lastIndexOf('. ', noFix) + 1, noFix);
    expect(sentence).toContain('ADR-0081의 2026-10-21 답 5');
    expect(sentence).not.toContain('ADR-0078');
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

  it('gives each action its time and the end of its deadline’s minute in KST, newest first', async () => {
    const { user: operator } = await createUser(t.db, { role: 'admin' });
    const { user: member } = await createUser(t.db, { email: 'member@example.com' });
    const { user: other } = await createUser(t.db);
    // 15:00:45.600 KST: every screen shows 오후 3:00, fourteen days on too, and mail is in time to
    // that minute's last second (owner decision 2026-10-23 답 5).
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
        deadline_kst: '2026-10-23 10:02:59',
        cancelled: true,
      },
      {
        user_id: member.id,
        action_id: warning.id,
        type: 'warning',
        acted_kst: '2026-10-08 15:00:45',
        deadline_kst: '2026-10-22 15:00:59',
        cancelled: false,
      },
    ]);
    // The last second before the member's card turns (appealWindowEndOf).
    expect(rows[1]!.acted_kst).toBe(kstToSecond(warnedAt));
    expect(rows[1]!.deadline_kst).toBe(lastSecondBefore(appealWindowEndOf(warnedAt)));
    // Mail the mailbox received on the last day up to 15:00:59 is in time — past the exact
    // 15:00:45.600 inside the minute — and from 15:01 late; a mailbox showing the minute alone
    // compares the same way.
    for (const received of ['2026-10-22 15:00:30', '2026-10-22 15:00:46', '2026-10-22 15:00:59']) {
      expect(received <= rows[1]!.deadline_kst!).toBe(true);
    }
    expect('2026-10-22 15:01:00' <= rows[1]!.deadline_kst!).toBe(false);
    expect('2026-10-22 15:00' <= rows[1]!.deadline_kst!).toBe(true);
    expect('2026-10-22 15:01' <= rows[1]!.deadline_kst!).toBe(false);
  });

  it('counts the window in hours, whatever the session’s time zone', async () => {
    const { user: operator } = await createUser(t.db, { role: 'admin' });
    const { user: member } = await createUser(t.db, { email: 'dst@example.com' });
    // New York leaves daylight saving on 2026-11-01, inside this window: 14 days there are 337
    // hours, and the member's card turns at the end of the minute 336 hours on.
    const at = new Date('2026-10-25T12:00:00Z');
    await createModerationAction(t.db, {
      userId: member.id,
      createdBy: operator.id,
      createdAt: at,
    });
    const [row] = await lookup('dst@example.com', 'America/New_York');
    expect(row!.acted_kst).toBe('2026-10-25 21:00:00');
    expect(row!.deadline_kst).toBe(lastSecondBefore(appealWindowEndOf(at)));
    expect(row!.deadline_kst).toBe('2026-11-08 21:00:59');
  });
});
