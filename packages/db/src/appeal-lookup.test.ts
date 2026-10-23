/**
 * Step 2 of the operator's handling of a sanction appeal (#186, ADR-0084): the read-only lookup
 * docs/OPERATIONS.md gives, verbatim, what the doc says to do with what it returns, and what it
 * returns when run as buddha_app the way the doc runs it — psql, the `sender` variable written in.
 * The account is the one whose current email is exactly the sender's address (owner decision
 * 2026-10-22 답 5, the phone change's lookup), never a card picked out of `/admin/users`' substring
 * search; each action comes with its time in KST to the second and the last second an appeal of it
 * is in time — the end of the minute its deadline shows in, …:59 (owner decision 2026-10-23 답 5) —
 * which the operator compares with the mailbox's arrival time (답 10): the screens show the minute
 * only (ADR-0084 6-8). The doc's replies, its two ask-backs and the rare cases it leaves to the
 * operator's judgement in the member's favour are read here too (오너 결정 2026-10-22 (2차),
 * 2026-10-23, 2026-10-23 (2차), 2026-10-23 (3차)), with the lookup's part in telling a late
 * ask-back. Skips the database part when TEST_* are unset.
 */
import { readFileSync } from 'node:fs';
import {
  adminUserQuerySchema,
  APPEAL_WINDOW_DAYS,
  appealWindowEndOf,
  MODERATION_ACTION_TYPES,
  PAGE_LIMIT_DEFAULT,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OPERATOR_APPEAL_LOOKUP_SQL } from './appeal-lookup.js';
import { OPERATOR_ACCOUNT_LOOKUP_SQL } from './phone-change.js';
import { moderationActions, restrictionEndChanges } from './schema/index.js';
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

/** The owner's ask-back (2026-10-23 답 1), and the late one's (2026-10-23 (2차) 답 1). */
const ASK_BACK =
  '어느 조치인지(조치의 종류, 조치한 때, 글이나 댓글이면 그 제목이나 첫 줄)를 적어 그 조치의 이의 기한 안에 다시 보내 주세요.';
const LATE_ASK_BACK =
  '어느 조치인지(조치의 종류, 조치한 때, 글이나 댓글이면 그 제목이나 첫 줄)를 적어 3일 안에 다시 보내 주세요.';

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

  it('names every type of action the lookup returns, the writing restriction too', () => {
    // The lookup filters no type (ADR-0084 결과 5): step 2 reads each one the operator may see —
    // #185's `writing_restriction` joined at the restack, and a type #139 adds must join it here.
    const text = step2();
    const list = text.slice(text.indexOf('`type`은 조치의 종류('));
    const named = list.slice(0, list.indexOf('), `acted_kst`'));
    for (const type of MODERATION_ACTION_TYPES) expect(named).toContain(`\`${type}\``);
    // Lifted early or shortened, a writing restriction stands: not `cancelled`, its deadline kept.
    expect(text).toContain('조기 해제하거나 감경한 작성 제한은 취소가 아니라 `f`다(1)');
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
    // procedure's choice, which the brief kept without asking the owner (ADR-0084 6-8, the fifth
    // table's head) — never credited to 답 3 alone, nor sent to 결과 4 any more.
    expect(text).toContain(
      "같은 주소에서 온 메일이 위의 한 문장을 받은 뒤에도 다시 발신 인증을 통과하지 못하면 — 계속 실패하면 — 그 메일에는 위의 한 문장 대신 아래의 글을 보낸다(글과 받는 사람은 오너 결정 2026-10-23 답 3, '계속'을 두 번째부터로 읽은 것은 이 절차의 선택이다 — ADR-0084 6-8)",
    );
    expect(text).not.toContain('아래의 글을 보낸다(오너 결정 2026-10-23 답 3)');
    expect(text).not.toContain("'계속'을 두 번째부터로 읽은 것은 ADR-0084 6-8, 결과 4의 12");
    // The mail resent from the changed address is a new appeal, timed by its own arrival; when two
    // replies carried an in-time first mail past the deadline, the rare case is step 7's — the
    // operator's judgement in the member's favour (owner decision 2026-10-23 (3차)).
    expect(text).toContain(
      '그 뒤 회원이 MY 설정에서 바꾼 이메일로 다시 보낸 메일은 새 이의로 2의 확인부터 보고, 기한 안인지는 3대로 그 메일이 메일함에 도착한 시각으로 본다',
    );
    expect(text).toContain(
      '처음 메일이 기한 안에 왔어도 위의 두 회신을 거치는 동안 기한이 지날 수 있다',
    );
    expect(text).toContain(
      '그런 드문 경우에 그 메일을 되묻기의 3일(3)처럼 처음 메일의 도착 시각으로 볼지는 7대로 판단한다(오너 결정 2026-10-23 (3차))',
    );
    expect(step3()).toContain(
      '2의 발신 인증에 계속 실패한 가입한 이메일의 회원이 바꾼 이메일로 다시 보낸 메일은 그 메일의 도착 시각으로 보고, 두 회신을 거치는 동안 기한이 지났으면 7대로 판단한다',
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
    // (2차) 2: asking back is no appeal received; the member resends, and the mail that comes back
    // is a new one, from step 2. The texts are the owner's: the usual one (2026-10-23 답 1, asking
    // for the post's or comment's title or first line too) and, for a late ask-back, the same with
    // '3일 안에' for its ending (2026-10-23 (2차) 답 1) — in that order.
    const text = sectionOf('   - 되묻기:', '   - 기한:');
    expect(text).toContain(
      '어느 조치인지 정할 수 없는 이의는 검토하지 않고 아래의 두 글 가운데 하나로 되묻는다',
    );
    expect(text).toContain('글은 오너 결정 2026-10-23 답 1과 2026-10-23 (2차) 답 1');
    expect(text).toContain('되묻는 것은 그 조치의 한 번을 쓰지 않는다');
    expect(text).toContain('회원은 글이 말하는 때(그 조치의 기한이나 3일) 안에 다시 보내야');
    const usual = inListItem(['```text', ASK_BACK, '```']);
    const late = inListItem(['```text', LATE_ASK_BACK, '```']);
    expect(text).toContain(usual);
    expect(text).toContain(late);
    expect(text.indexOf(usual)).toBeLessThan(text.indexOf(late));
    expect(text.match(/```text/g)).toHaveLength(2);
    // The late one differs in its ending alone.
    expect(LATE_ASK_BACK).toBe(
      ASK_BACK.replace('그 조치의 이의 기한 안에 다시 보내 주세요.', '3일 안에 다시 보내 주세요.'),
    );
    expect(appealSection()).not.toContain('어느 조치인지(조치의 종류와 조치한 때)를 적어 그 조치');
    // The asked-back mail is marked by the member, never by the sender — and counts as no appeal.
    expect(text).toContain("2의 조회의 `user_id`와 '되물음'을 함께 적은 표시");
    expect(text).toContain('`action_id`가 없어 받은 이의로 세지 않는다');
  });

  it('ends a late ask-back with 3 days, by the deadlines the asked-back mail came in time for (owner decision 2026-10-23 (2차) 답 1)', () => {
    const text = sectionOf('   - 되묻기:', '   - 기한:');
    // The usual ask-back is the first text; the late one, the second.
    expect(text).toContain('\n     글은 보통 첫째 것이다. 늦은 되묻기 — ');
    // Late: under 3×24 hours left before the deadline, or past it, when the ask-back goes out.
    expect(text).toContain(
      "늦은 되묻기 — 되묻는 메일을 보내는 때에 기한까지 3×24시간보다 적게 남았거나 기한이 지난 되묻기 — 에는 끝이 '3일 안에'인 둘째 것이다(오너 결정 2026-10-23 (2차) 답 1)",
    );
    // Which deadline, with the action unknown, is this ADR's reading (6-8), the rare cases it splits
    // left to step 7: any action taken by the time the asked-back mail came — it could not speak of
    // a later one — that the mail came in time for, by the lookup's columns (the integration part
    // runs it).
    expect(text).toContain(
      '2의 조회에서 취소되지 않았고, 그 메일이 온 때까지 받았으며(`acted_kst`가 그 메일이 도착한 시각과 같거나 앞), `deadline_kst`가 그 메일이 그 조치에 기한을 보는 시각(첫 메일이면 그 메일이 도착한 시각, 아래)과 같거나 뒤인 조치',
    );
    expect(text).toContain(
      '그 가운데 하나라도 `deadline_kst`가 되묻는 메일을 보내는 때부터 3×24시간 뒤보다 앞이면 늦은 되묻기다(ADR-0084 6-8 — 드문 경우는 7)',
    );
    expect(text).toContain(
      '그 메일이 온 뒤에 받은 조치는 그 메일이 말할 수 없었으므로 넣지 않는다',
    );
    expect(text).toContain(
      '그 메일이 모든 조치에 이미 늦었거나, 기한 안에 온 조치마다 3×24시간 이상 남았으면 — 첫째 글이다',
    );
  });

  it('times a resend within 3×24 hours of a late ask-back by the first mail (owner decision 2026-10-23 답 2, (2차) 답 1)', () => {
    const text = sectionOf('   - 되묻기:', '   - 기한:');
    expect(text).toContain('다시 온 메일이 기한 안인지는 그 메일이 메일함에 도착한 시각으로 본다');
    // The 3 days are 답 2's; 3×24 hours from the ask-back's sending, and the late ask-back they
    // follow, are the owner's since 2026-10-23 (2차) 답 1 — no more this ADR's reading for every
    // ask-back, nor 결과 4의 10.
    expect(text).toContain(
      '다만 늦은 되묻기를 보낸 때부터 3×24시간 안에 도착한 메일은 첫 메일 — 그 되묻기를 받은 메일 — 이 메일함에 도착한 시각으로 본다(3일은 오너 결정 2026-10-23 답 2, 3×24시간과 늦은 되묻기는 오너 결정 2026-10-23 (2차) 답 1)',
    );
    expect(text).toContain("둘째 글의 '3일'이 이것이다");
    expect(text).toContain(
      '첫째 글로 되물었으면 그 메일이 기한 안에 온 조치마다 3×24시간 이상 남았으므로, 3×24시간 안에 다시 온 메일은 그 메일이 도착한 시각으로도 기한 안이다',
    );
    expect(appealSection()).not.toContain('모든 되묻기');
    expect(appealSection()).not.toContain('결과 4의 10');
    expect(step3()).toContain(
      '늦은 되묻기 뒤 3×24시간 안에 다시 온 메일은 위의 되묻기대로 첫 메일의 도착 시각으로 본다 — 되묻기 하나에 다시 온 이의 하나이고, 첫 메일이 온 때까지 받은 조치에만이다',
    );
    // One ask-back lends the first mail's arrival to one appeal that comes back: the first within
    // the 3×24 hours that passes step 2 and matches actions — one action's description, the one
    // written first when a mail names several apart, all it fits when it fits several (2026-10-23
    // (2차) 답 2) — and only actions taken by the time the first mail came. Unconfirmed mail does
    // not use it; another action in the same mail or a later one keeps that mail's arrival. Several
    // appeals after one ask-back, and the acted-by reading's rare cases, are step 7's — this reading
    // the operator's start (owner decision 2026-10-23 (3차)).
    expect(text).toContain(
      '첫 메일의 도착 시각으로 보는 것은 되묻기 하나에 다시 온 이의 하나다 — 그 3×24시간 안에 다시 온 메일 가운데 2의 확인을 마치고 맞는 조치가 정해진 첫 이의(한 메일이 조치 여럿을 따로 적었으면 그 가운데 먼저 적은 것)의 그 조치(그 이의가 여러 조치에 맞으면 그 모두, 아래)뿐이고',
    );
    expect(text).toContain(
      '그 조치도 첫 메일이 온 때까지 받은 것(`acted_kst`가 첫 메일의 도착 시각과 같거나 앞)이어야 한다 — 그 뒤에 받은 조치는 첫 메일이 말할 수 없었으므로 첫 메일의 도착 시각을 받지 않고 그 조치를 말한 메일이 도착한 시각으로 본다(한 번 더 되물은 뒤는 아래, ADR-0084 6-8 — 드문 경우는 7)',
    );
    expect(text).toContain(
      '2의 확인을 마치지 못한 메일(확인되지 않은 메일)은 그것을 쓰지 않으므로',
    );
    expect(text).toContain(
      '같은 메일이나 그 뒤의 메일이 말하는 다른 조치는 그 메일이 도착한 시각으로 본다',
    );
    // The first mail's mark says the lent time is used — whichever time a late ask-back lent, a
    // once-more-asked mail's own arrival too — with no action_id (that would read as an appeal
    // taken).
    expect(text).toContain(
      "늦은 되묻기로 — 첫 메일의 도착 시각이나, 한 번 더 되물었으면 그 메일이 기한을 보는 시각(아래)으로 — 다시 온 메일을 보았으면 첫 메일의 '되물음'의 표시에 '3일 씀'을 더해 다른 운영자도 알게 한다 — `action_id`는 적지 않는다",
    );
    expect(text).toContain(
      '처음 되묻기는 늦지 않았고 한 번 더 되묻기만 늦어 한 번 더 되물은 메일이 도착한 시각으로 본 것도 그렇다',
    );
    expect(text).not.toContain("첫 메일의 도착 시각으로 보았으면 첫 메일의 '되물음'의 표시에");
    expect(text).toContain(
      '되묻기 하나에 다시 온 이의가 여럿인 것 — 한 메일이 따로 적은 조치 여럿이나 메일 여럿 — 은 드문 경우라 7대로 판단한다(이 절차의 읽기로는 위대로 이의 하나, 곧 먼저 적은 조치 하나이고 그 이의가 여러 조치에 맞을 때만 그 모두다, ADR-0084 6-8)',
    );
    expect(text).not.toContain('되묻기 하나가 다시 온 이의 여럿(메일 여럿)');
    expect(appealSection()).not.toContain('되묻기 하나에 조치 하나');
  });

  it('takes a resend matching several actions as one appeal of them all, and asks back once more one matching none (owner decision 2026-10-23 (2차) 답 2)', () => {
    const text = sectionOf('   - 되묻기:', '   - 기한:');
    // Several are taken together only when the resend wrote all the ask-back asked for and still
    // fits them — the case 답 2 answered.
    expect(text).toContain(
      "되물은 뒤 다시 온 이의가 되묻는 글이 적으라고 한 것 — 종류, 조치한 때, 글이나 댓글이면 그 제목이나 첫 줄(회원의 카드에 '삭제한 글'·'삭제한 댓글'뿐이면 그것) — 을 모두 적고도 여러 조치에 맞으면",
    );
    expect(text).toContain(
      '맞는 조치 모두를 한 이의로 함께 받아 검토하고, 맞는 조치마다 그 한 번을 쓴다(오너 결정 2026-10-23 (2차) 답 2)',
    );
    // One that left out an item fits several only for what it left out: it is asked back once
    // more, which uses up no action's one appeal (6-8; the rare case is step 7's).
    expect(text).toContain(
      "적으라고 한 것 가운데 무엇을 빼고 적어 여러 조치에 맞으면 — '숨김 조치에 이의합니다'처럼 — 함께 받지 않고 하나도 맞지 않는 것처럼 한 번 더 되묻는다",
    );
    expect(text).toContain(
      '되묻는 것은 어느 조치의 한 번도 쓰지 않는다(ADR-0084 6-8 — 드문 경우는 7)',
    );
    // Each action it matches is checked, and marked, as an appeal of its own would be; the reply
    // says one sentence while their reason is the same. When the reasons differ, what it says of
    // those not taken, and whether a cancelled action counts beside a standing one, are step 7's —
    // the operator's judgement, this procedure's reading its start (owner decision 2026-10-23 (3차)).
    expect(text).toContain(
      "아래 '받지 않는 것'은 맞는 조치마다 보고, 받는 조치마다 받은 이의의 표시를 단다",
    );
    expect(text).toContain('모두 받지 않는 것이고 그 까닭이 같으면 그 까닭의 한 문장만 회신한다');
    expect(text).toContain(
      '까닭이 조치마다 다르면 — 하나는 취소되었고 다른 하나는 기한이 지난 것처럼 — 어느 까닭을 회신할지는 드문 경우라 7대로 판단한다(이 절차의 읽기로는 아래 차례의 앞의 것 하나다',
    );
    expect(text).toContain(
      '서 있는 조치와 함께 맞은 취소된 조치를 맞는 조치로 셀지도 7대로 판단한다(이 절차의 읽기로는 센다)',
    );
    expect(text).not.toContain(
      '모두 받지 않는 것이면 그 까닭의 한 문장만 회신한다(여럿이면 그 차례의 앞의 것 하나)',
    );
    expect(text).toContain('6의 회신은 그 이의에 하나로 받은 조치마다 결과를 적는다');
    expect(text).toContain(
      '받지 않은 조치의 까닭을 그 회신에 함께 적을지도 7대로 판단한다(이 절차의 읽기로는 적지 않는다)',
    );
    // Matching none — a time copied without its '(GMT…)' among them — is asked back once more,
    // late or not by the same rule, and timed as the mail it asks back was for each action: the
    // first mail's arrival only for one taken by the time that mail came.
    expect(text).toContain(
      "다시 온 메일에 맞는 조치가 하나도 없으면 — 회원이 차이('(GMT…)')를 빼고 옮긴 시각이 어느 조치와도 맞지 않는 경우처럼 — 한 번 더 되묻는다(같은 답 2)",
    );
    expect(text).toContain('그 글도 그때 늦은 되묻기인지로 고르고');
    expect(text).toContain(
      '한 번 더 되물은 메일이 그 조치에 기한을 보는 시각은, 그 메일이 앞의 늦은 되묻기 뒤 3×24시간 안에 왔고 그 조치가 첫 메일이 온 때까지 받은 것이면 첫 메일의 도착 시각이고, 아니면 그 메일이 도착한 시각이다(ADR-0084 6-8 — 드문 경우는 7)',
    );
    expect(text).toContain('한 번 더 되물은 것(아래)도 같은 첫 메일의 되묻기로 센다');
    // After that, step 7's: no third ask-back, and 결과 4의 11 is answered.
    expect(text).toContain(
      '한 번 더 되물은 뒤에도 맞는 조치가 없으면 다시 되묻지 않고 7대로 판단한다',
    );
    expect(appealSection()).not.toContain('결과 4의 11');
    expect(appealSection()).not.toContain('같은 글로 다시 되묻지 않고');
    // The appeal taken for several counts, and is marked, once for each of them.
    const notTaken = sectionOf('   - 받지 않는 것:', '4. **검토.**');
    expect(notTaken).toContain(
      '되물은 뒤 다시 온 이의를 여러 조치에 함께 받았으면 받은 조치마다 센다(위의 되묻기)',
    );
    expect(notTaken).toContain('여러 조치에 함께 받았으면 조치마다 단다');
    // The owner's order is for one action's reasons.
    expect(notTaken).toContain(
      '한 조치가 여럿에 해당하면 이 차례에서 앞의 것 하나다 — 그 조치의 카드가 보이는 것',
    );
    expect(notTaken).toContain('(함께 맞은 조치마다 까닭이 다른 것은 위의 되묻기와 7)');
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
    // A mail that names several actions apart is several appeals, one for each action — matched
    // each on its own, never as one description all of them fit (ADR-0084 6-8, the rare case step
    // 7's).
    expect(text).toContain(
      '한 메일이 조치 여럿을 따로 적었으면 회원이 적은 것을 조치마다 따로 보고, 그 하나하나가 따로 된 이의다 — 조치마다 한 번이라서다(ADR-0084 6-8 — 드문 경우는 7)',
    );
    // An action fits when it fits all the member wrote for that appeal — a matching type and
    // title with a time that fits no action is none (ADR-0084 6-8, the case 2026-10-23 (2차) 답 2
    // asks back again; the rare case step 7's).
    expect(text).toContain(
      '맞는 조치는 회원이 그 이의에 적은 것 — 종류, 조치한 때, 글이나 댓글이면 그 제목이나 첫 줄 — 에 모두 맞는 조치다(종류와 제목이나 첫 줄이 맞아도 조치한 때가 맞지 않으면 맞지 않는다, ADR-0084 6-8 — 드문 경우는 7)',
    );
    // What fits no single action is the ask-back, not a guess; the resend that wrote all it was
    // asked for is taken for several; in a mail partly identified, only the rest is asked back.
    expect(text).toContain(
      '회원이 적은 것에 맞는 조치가 하나가 아니면 어느 조치인지 정할 수 없는 이의다(아래의 되묻기 — 되물은 뒤 다시 온 이의가 되묻는 글이 적으라고 한 것을 모두 적고도 여러 조치에 맞으면 함께 받는다)',
    );
    expect(text).toContain(
      '한 메일의 이의 가운데 일부만 정해지면 정해진 이의는 아래대로 받거나 받지 않고, 정할 수 없는 이의만 되묻는다',
    );
    expect(appealSection()).not.toContain('적은 것만');
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

/** The owner's principle for what the procedure's rules leave open (2026-10-23 (3차)). */
const PRINCIPLE =
  '이 절차의 규칙이 정하지 않은 드문 경우에는 운영자가 회원에게 유리하게 판단해 처리하고, 그 판단과 까닭을 그 메일의 메일함 메모(3의 표시를 다는 곳)에 적는다(오너 결정 2026-10-23 (3차))';

/** Step 7 of the appeal procedure: its one line. */
function step7(): string {
  const text = appealSection();
  const start = text.indexOf('\n7. **절차가 정하지 않은 경우.** ');
  expect(start).toBeGreaterThan(-1);
  const end = text.indexOf('\n', start + 1);
  return text.slice(start + 1, end === -1 ? undefined : end);
}

describe('what the appeal procedure leaves to the operator (owner decision 2026-10-23 (3차))', () => {
  it('states the owner’s principle in a line of its own, with the five cases once asked as its examples', () => {
    // The rare cases ADR-0084 결과 4의 12~16 asked are the operator's judgement: in a case the
    // rules don't cover, decide in the member's favour, handle it, and write the decision and why
    // in the mailbox note. Step 7 says so in one line, after the reply (6).
    const text = appealSection();
    const line = step7();
    expect(text.indexOf('\n6. **회신.**')).toBeGreaterThan(-1);
    expect(text.indexOf('\n6. **회신.**')).toBeLessThan(text.indexOf(line));
    expect(line).toContain(PRINCIPLE);
    // One example for each case, in the order they were asked (12 to 16).
    const examples = [
      '발신 인증에 계속 실패해 바꾼 이메일로 다시 보낸 메일이 두 회신 동안 기한을 넘긴 것(2)',
      '늦은 되묻기 하나에 다시 온 이의가 여럿인 것',
      '한 번 더 되물은 뒤에도 맞는 조치가 없거나 함께 맞은 조치 가운데 받지 않는 것이 있는 것',
      '기한이 모두 지난 뒤의 되묻기나 첫 메일 뒤에 받은 조치처럼 늦은 되묻기인지가 갈리는 것',
      '다시 온 메일이 적으라고 한 것을 빼고 적었거나 조치한 때만 맞지 않아 어느 조치인지 분명하지 않은 것(3',
    ];
    const at = examples.map((example) => line.indexOf(example));
    for (const index of at) expect(index).toBeGreaterThan(line.indexOf(' — 예: '));
    expect(line.indexOf(' — 예: ')).toBeGreaterThan(line.indexOf(PRINCIPLE));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // What step 3 wrote as this procedure's reading is where that judgement starts.
    expect(line).toContain("그 자리에 적은 'ADR-0084 6-8'의 읽기는 이 판단의 출발점이다");
  });

  it('sends those cases to step 7, never to the owner any more', () => {
    const text = appealSection();
    // No '결과 4의 N' is cited, nothing waits for the owner's answer, and nothing is left undecided.
    expect([...text.matchAll(/결과 4의 \d+/g)]).toHaveLength(0);
    for (const old of ['오너에게 묻는다', '그 답 전에는', '정하지 않았다(']) {
      expect(text).not.toContain(old);
    }
    // The readings step 3 keeps point at step 7 for their rare cases, and the cases once left
    // undecided are judged by it.
    expect(text).toContain('(ADR-0084 6-8 — 드문 경우는 7)');
    expect(text).toContain('7대로 판단한다(오너 결정 2026-10-23 (3차))');
  });

  it('records the owner’s answer as a table of its own, apart from the implementation’s choices', () => {
    const adr = adr0084();
    // The tables keep their names; the sixth is the third round of 2026-10-23 — one row, the
    // owner's answer.
    const tables = [
      '**오너 결정 2026-10-22.**',
      '**오너 결정 2026-10-22 (2차).**',
      '**오너 결정 2026-10-23.**',
      '**오너 결정 2026-10-23 (2차).**',
      '**오너 결정 2026-10-23 (3차).**',
    ].map((name) => adr.indexOf(name));
    for (const index of tables) expect(index).toBeGreaterThan(-1);
    expect([...tables].sort((a, b) => a - b)).toEqual(tables);
    const third = tables[4]!;
    const table = adr.slice(third, adr.indexOf('\n\n브리프가 정한 것:', third));
    expect(table.match(/^\| 오너 결정 2026-10-23 \(3차\) +\|/gm)).toHaveLength(1);
    expect(table).toContain(
      '남은 드문 경우(결과 4의 12\\~16)는 운영자의 판단에 맡김 — 규칙이 정하지 않은 경우 운영자가 회원에게 유리하게 판단해 처리하고, 그 판단과 까닭을 메일함 메모에 남김.',
    );
    // How the principle went into the procedure is this PR's choice, in 6-8 — not in the table.
    expect(table).toContain('그 원칙을 절차에 옮긴 방법은 오너의 답이 아니라 구현의 선택이다(6-8)');
    expect(adr.indexOf('**6. 구현의 선택.**')).toBeGreaterThan(third);
    expect(adr).toContain('·2026-10-23 (2차)·2026-10-23 (3차))\n');
  });

  it('asks the owner nothing more: 결과 4 is none, the five once asked answered by the principle', () => {
    expect(ownerQuestions().size).toBe(0);
    const adr = adr0084();
    expect(adr).toContain('**4. 오너에게 물을 것.** 없다.');
    expect(adr).toContain(
      '에는 오너가 원칙 하나로 답했다: 규칙이 정하지 않은 드문 경우는 운영자가 회원에게 유리하게 판단해 처리하고 그 판단과 까닭을 메일함 메모에 남긴다(결정 1의 여섯째 표, 오너 결정 2026-10-23 (3차))',
    );
    // The words that counted the open questions say there are none left.
    expect(adr).toContain('결과 4에 남은 질문은 없다 — 남았던 다섯 질문(');
    expect(adr).not.toContain('결과 4에는 남은 다섯 질문(');
    expect(adr).toContain(
      '절차가 정하지 않은 드문 경우의 원칙(7, 오너 결정 2026-10-23 (3차) — 결과 4의 12\\~16이던 다섯 경우를 예로)',
    );
    expect(adr).not.toContain('오너에게 묻는 경우(결과 4의 12\\~16)');
    expect(adr).toContain('어느 조치의 기한으로 보는지는 6-8 — 드문 경우는 여섯째 표');
    expect(adr).not.toMatch(/오너에게 묻는다\(결과 4의/);
    expect(adr).not.toMatch(/\(6-8, 결과 4의 1[2-6]/);
    expect(adr).not.toContain("'계속'의 읽기와 이 기한은 오너에게 묻는다");
  });

  it('records in decision 6-8 the readings step 7 starts from, and how the principle went in', () => {
    const adr = adr0084();
    const start = adr.indexOf('8. 운영자의 절차에서 오너가 정하지 않은 것.');
    const end = adr.indexOf('\n9. 서버는 바꾸지 않았다.', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const choices = adr.slice(start, end);
    // Which actions make an ask-back late: those taken by the time the asked-back mail came that
    // it came in time for — and why a later one is left out.
    expect(choices).toContain(
      '이 PR은 되묻기를 받은 메일이 온 때까지 받았고(`acted_kst`가 그 메일이 도착한 시각과 같거나 앞) 그 메일이 기한 안에 온 그 회원의 조치',
    );
    expect(choices).toContain(
      '그 메일이 온 뒤에 받은 조치는 넣지 않았고, 3일 규칙도 첫 메일이 온 때까지 받은 조치에만 쓴다',
    );
    expect(choices).not.toContain("둘째 글('3일 안에')은 어느 조치의 회원에게도 틀리지 않는다");
    // One appeal is one action's description: a mail naming several apart is several, (2차) 답 2
    // being the answer for one description that fits several it cannot tell apart.
    expect(choices).toContain('이 PR은 좁게 읽었다 — 되묻기 하나에 다시 온 이의 하나');
    expect(choices).toContain(
      '이의 하나는 회원이 적은 조치 하나의 설명이다 — 한 메일이 조치 여럿을 따로 적었으면 조치마다 따로 된 이의라(조치마다 한 번) 먼저 적은 것이 첫 이의이고',
    );
    expect(choices).toContain(
      '한 메일이 조치 여럿을 따로 적었으면 조치마다 따로 견주고 그 하나하나가 따로 된 이의다',
    );
    expect(choices).toContain('처음 메일의 이의 하나(조치 하나의 설명)가 여럿에 맞으면 되묻는다');
    expect(choices).not.toContain('처음 메일은 여럿에 맞아도 되묻는다');
    // A resend that left out what it was asked for is asked back once more, never taken for all
    // the actions it then fits.
    expect(choices).toContain(
      "다시 온 이의가 되묻는 글이 적으라고 한 것(종류, 조치한 때, 글이나 댓글이면 그 제목이나 첫 줄 — 회원의 카드에 '삭제한 글'·'삭제한 댓글'뿐이면 그것) 가운데 무엇을 빼고 적어 여러 조치에 맞으면 함께 받지 않고 하나도 맞지 않는 것처럼 한 번 더 되묻는다",
    );
    expect(adr).not.toContain('적은 것만');
    // '3일 씀' goes on whenever a late ask-back's time is lent, a once-more-asked mail's own
    // arrival too.
    expect(choices).toContain(
      '처음 되묻기는 늦지 않았고 한 번 더 되묻기만 늦으면 한 번 더 되물은 메일이 도착한 시각이다',
    );
    // The owner's order of reasons is one action's.
    expect(choices).toContain(
      '오너가 승인한 차례(취소 → 기한 → 이미 받음)는 한 조치의 까닭 여럿에 대한 것이라',
    );
    // '계속' stays this PR's, as the brief said; what was asked of the owner is the operator's now,
    // these readings its start.
    expect(choices).toContain(
      "'계속'의 읽기는 오너에게 묻지 않고 이 PR의 선택으로 둔다(브리프, 다섯째 표의 머리)",
    );
    expect(choices).toContain('이 기한은 오너가 운영자의 판단에 맡겼다');
    expect(choices).toContain(
      '셀지는 오너가 운영자의 판단에 맡겼다(오너 결정 2026-10-23 (3차)) — 위의 읽기(차례의 앞의 것 하나, 적지 않음, 취소된 조치도 셈)는 그 판단의 출발점이다',
    );
    expect(choices).not.toMatch(/\(결과 4의 1[2-6]\)/);
    expect(choices).not.toMatch(/오너에게 묻는다\(/);
    // How the principle went into the procedure: the places that waited for the owner point at
    // step 7, the readings stay as its start, the note is that mail's own, and 'in the member's
    // favour' stays the owner's words.
    const at = choices.indexOf('   - 드문 경우의 판단(오너 결정 2026-10-23 (3차)).');
    expect(at).toBeGreaterThan(-1);
    const rare = choices.slice(at);
    expect(rare).toContain(
      '운영자 절차에는 그 원칙을 7에 한 줄로 두고 다섯 경우를 짧은 예로 들었다',
    );
    expect(rare).toContain(
      "(1) 2·3에서 그 다섯을 '정하지 않았다'·'오너에게 묻는다'·'그 답 전에는'으로 가리키던 곳은 모두 7을 가리키게 했고",
    );
    expect(rare).toContain(
      "(2) '메일함 메모'는 3의 받은 이의·'되물음'의 표시를 다는 그 메일의 라벨이나 메모로 읽었다",
    );
    expect(rare).toContain("(3) '회원에게 유리하게'는 오너의 말 그대로 두고");
  });

  it('says in decision 5 what the procedure does, the rare cases sent to its step 7', () => {
    const adr = adr0084();
    const procedure = adr.indexOf('**5. 운영자의 절차');
    expect(procedure).toBeGreaterThan(-1);
    /** Decision 5's step n, to the next step. */
    const step = (n: number): string => {
      const from = adr.indexOf(`\n${String(n)}. `, procedure);
      const to = adr.indexOf(`\n${String(n + 1)}. `, from);
      expect(from).toBeGreaterThan(procedure);
      expect(to).toBeGreaterThan(from);
      return adr.slice(from, to);
    };
    // Step 2: '계속' is this PR's, as the brief said; the deadline after a changed address, when
    // two replies carried it past, is step 7's.
    const sender = step(2);
    expect(sender).toContain(
      "처음 메일이 기한 안에 왔는데 두 회신 동안 기한이 지났으면 7의 판단이다(오너 결정 2026-10-23 (3차)). '계속'의 읽기는 브리프대로 이 PR의 선택이다(6-8)",
    );
    expect(adr).not.toContain("이 읽기와 '계속'의 읽기는 오너에게 묻는다");
    expect(sender).not.toContain("'계속'의 읽기는 오너에게 묻는다");
    // Step 3: the late ask-back's 3 days, one appeal of a description, several taken only when
    // the resend wrote all asked for, a time that fits nothing as none — the rare cases step 7's.
    const deadline = step(3);
    expect(deadline).toContain(
      '늦은 되묻기를 보낸 때부터 3×24시간 안에 도착한 메일은 첫 메일이 도착한 시각으로 본다',
    );
    expect(deadline).toContain(
      '한 메일이 조치 여럿을 따로 적었으면 조치마다 따로 된 이의이고, 회원이 그 이의에 적은 것에 모두 맞는 조치가 하나가 아니면 어느 조치인지 정할 수 없는 이의다(6-8 — 드문 경우는 7)',
    );
    expect(deadline).toContain(
      '첫 이의(한 메일이 따로 적은 조치 여럿이면 먼저 적은 것)의 그 조치(그 설명 하나가 여러 조치에 맞으면 그 모두, 첫 메일이 온 뒤에 받은 조치는 빼고)',
    );
    expect(deadline).toContain(
      '같은 메일이나 그 뒤의 메일이 말하는 다른 조치는 그 메일이 도착한 시각으로 보며',
    );
    expect(deadline).toContain(
      "늦은 되묻기로 빌린 시각(첫 메일의 도착 시각이나, 한 번 더 되물었으면 그 메일이 기한을 보는 시각)을 쓰면 첫 메일의 '되물음'의 표시에 '3일 씀'을 더한다(이 PR의 읽기, 6-8 — 드문 경우는 7)",
    );
    expect(deadline).toContain(
      '다시 온 이의가 되묻는 글이 적으라고 한 것을 모두 적고도 여러 조치에 맞으면 맞는 조치 모두를 한 이의로 함께 받아 검토하고 조치마다 그 한 번을 쓰며',
    );
    expect(deadline).toContain('하나도 맞지 않으면(조치한 때가 맞지 않는 것도) 한 번 더 되묻는다');
    expect(deadline).toContain(
      '적으라고 한 것을 빼고 적어 여러 조치에 맞는 이의도 함께 받지 않고 한 번 더 되묻는다(6-8 — 드문 경우는 7)',
    );
    expect(deadline).toContain(
      '그 회신 — 일부만이면 그 까닭을 적을지, 모두 받지 않는 것인데 까닭이 조치마다 다르면 어느 까닭인지 — 은 7의 판단이며(이 PR의 읽기로는 일부만이면 적지 않고, 모두 받지 않는 것이면 아래의 한 문장 — 까닭이 다르면 차례의 앞의 것 하나다, 6-8)',
    );
    expect(deadline).toContain('그 뒤에도 맞는 조치가 없으면 다시 되묻지 않고 7의 판단이다(6-8)');
    expect(deadline).toContain('함께 받은 조치 여럿이면 조치마다');
    expect(deadline).toContain(
      '되묻기를 받은 메일이 온 때까지 받았고 그 메일이 기한 안에 온 조치 가운데 하나라도 그러면 늦은 되묻기로 보는 것은 6-8 — 드문 경우는 7',
    );
    expect(deadline).not.toMatch(/결과 4의 \d/);
    for (const old of ['되묻기 하나에 조치 하나', '모든 되묻기', '오너에게 묻는다']) {
      expect(deadline).not.toContain(old);
    }
    // Step 7: the owner's principle, in the procedure's one line with the five cases as examples.
    const from = adr.indexOf(
      '\n7. 절차가 정하지 않은 경우(오너 결정 2026-10-23 (3차), 새): ',
      procedure,
    );
    expect(from).toBeGreaterThan(adr.indexOf('\n6. ', procedure));
    const rare = adr.slice(from, adr.indexOf('\n\n운영자의 기능 이름은', from));
    expect(rare).toContain(
      '규칙이 정하지 않은 드문 경우에는 운영자가 회원에게 유리하게 판단해 처리하고 그 판단과 까닭을 그 메일의 메일함 메모(3의 표시를 다는 곳)에 적는다',
    );
    expect(rare).toContain('결과 4에 물었던 다섯 경우(12\\~16)를 예로 든다');
  });

  it('records in the settings the late ask-back’s 3 days as the owner’s, one appeal as this ADR’s reading', () => {
    // docs/SETTINGS.md registers fixed values: the 3 days after a late ask-back are the owner's
    // (2026-10-23 답 2), and so, since 2026-10-23 (2차) 답 1, are their 3×24 hours and what makes
    // an ask-back late. That one ask-back lends them to one appeal is ADR-0084's reading; its rare
    // cases are no fixed value but the operator's judgement (2026-10-23 (3차)).
    const line = SETTINGS.split('\n').find((l) =>
      l.startsWith('- 제재 이의의 안내(#186, ADR-0084)'),
    );
    expect(line).toBeDefined();
    expect(line).toContain(
      "운영자가 기한까지 3일보다 적게 남았거나 기한이 지난 뒤에 되물었으면(늦은 되묻기) 되묻는 글은 '…를 적어 3일 안에 다시 보내 주세요.'로 끝나고",
    );
    expect(line).toContain(
      '3일은 오너가 정한 고정값이고(오너 결정 2026-10-23 답 2), 그 3일을 3×24시간으로 세는 것과 늦은 되묻기의 경계도 오너가 정했다(오너 결정 2026-10-23 (2차) 답 1)',
    );
    expect(line).toContain(
      '되묻기 하나에 다시 온 이의 하나만 그렇게 보는 것은 ADR-0084의 읽기다(ADR-0084 6-8)',
    );
    expect(line).toContain(
      '어느 조치가 늦은 되묻기를 정하고 그 3일을 받는지 — 되묻기를 받은 메일이 온 때까지 받았고 그 메일이 기한 안에 온 조치 — 도 그렇다',
    );
    expect(line).toContain(
      '그 읽기가 닿는 드문 경우 — 늦은 되묻기 하나에 다시 온 이의가 여럿이거나 늦은 되묻기인지가 갈리는 것 — 는 고정값이 아니라 운영자가 회원에게 유리하게 판단한다(오너 결정 2026-10-23 (3차), 운영자의 절차 7)',
    );
    expect(line).not.toContain('모든 되묻기');
    expect(line).not.toMatch(/결과 4의 \d/);
    expect(line).not.toContain('오너에게 묻고 있다');
  });

  it('asks nothing the owner answered on 2026-10-23, (2차) and (3차), and records those answers', () => {
    // 결과 4의 4~9 were answered (오너 결정 2026-10-23 답 1~6), 10·11 (2026-10-23 (2차) 답 1·2)
    // and 12~16 (2026-10-23 (3차)): none is asked any more.
    const questions = ownerQuestions();
    for (const n of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
      expect(questions.has(n)).toBe(false);
    const adr = adr0084();
    for (const n of [1, 2, 3, 4, 5, 6])
      expect(adr).toContain(`| 오너 결정 2026-10-23 답 ${String(n)} `);
    for (const n of [1, 2]) expect(adr).toContain(`| 오너 결정 2026-10-23 (2차) 답 ${String(n)} `);
    expect(adr).toContain('| 오너 결정 2026-10-23 (3차) ');
    // The fifth table's answers are the owner's words, the late ask-back's ending among them.
    expect(adr).toContain(
      "기한까지 3일보다 적게 남았거나 지난 뒤 되물을 때 → 되묻기 끝을 '…를 적어 3일 안에 다시 보내 주세요.'로(3일 = 되물은 때부터 3×24시간)",
    );
    expect(adr).toContain(
      '다시 보낸 이의가 여러 조치에 맞으면 → 맞는 조치 모두를 한 이의로 함께 검토(각 조치의 한 번을 씀), 하나도 맞지 않으면 한 번 더 되물음',
    );
    // What the brief kept as this PR's choices, unasked, is said with the table.
    expect(adr).toContain('을 오너에게 묻지 않고 구현의 선택으로 두게 했다(6-8·6-3·6-2)');
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

  /**
   * Step 3's ask-back (owner decision 2026-10-23 (2차) 답 1, ADR-0084 6-8 — rare cases, step 7): a first
   * mail's ask-back is late when an action the mail came in time for — not cancelled, taken by the
   * time the mail came (`acted_kst` at or before it), `deadline_kst` at or after it — has its
   * `deadline_kst` before the ask-back's sending + 3×24 hours. The lookup's own columns decide it,
   * compared as the KST text the doc compares.
   */
  const isLate = (rows: Row[], mailAt: Date, askedAt: Date): boolean => {
    const mail = kstToSecond(mailAt);
    const limit = kstToSecond(new Date(askedAt.getTime() + 3 * 24 * 60 * 60 * 1_000));
    return rows.some(
      (row) =>
        row.action_id !== null &&
        !row.cancelled &&
        row.acted_kst! <= mail &&
        row.deadline_kst! >= mail &&
        row.deadline_kst! < limit,
    );
  };
  const window = APPEAL_WINDOW_DAYS * 24 * 60 * 60 * 1_000;
  const actedFor = (deadline: string) => new Date(new Date(deadline).getTime() - window);

  it('gives what tells a late ask-back: the standing actions’ deadline_kst against the mails’ times', async () => {
    const { user: operator } = await createUser(t.db, { role: 'admin' });
    const { user: member } = await createUser(t.db, { email: 'late@example.com' });
    const mailAt = new Date('2026-10-20T03:00:00Z'); // 2026-10-20 12:00:00 KST
    const askedAt = new Date('2026-10-21T03:00:59Z'); // 2026-10-21 12:00:59 KST, + 3×24 h
    // Exactly 3×24 hours left: a resend within them is in time anyway — not late.
    await createModerationAction(t.db, {
      userId: member.id,
      createdBy: operator.id,
      createdAt: actedFor('2026-10-24T03:00:59Z'),
    });
    // Late already when the mail came: 3×24 hours change nothing — not counted.
    await createModerationAction(t.db, {
      userId: member.id,
      createdBy: operator.id,
      createdAt: actedFor('2026-10-20T02:00:00Z'),
    });
    // Cancelled: nothing to appeal — not counted.
    await createModerationAction(t.db, {
      userId: member.id,
      createdBy: operator.id,
      createdAt: actedFor('2026-10-22T03:00:00Z'),
      cancelled: { at: new Date('2026-10-19T00:00:00Z'), by: operator.id, reason: '취소' },
    });
    const before = await lookup('late@example.com');
    expect(before.map((row) => row.deadline_kst)).toEqual([
      '2026-10-24 12:00:59',
      '2026-10-22 12:00:59',
      '2026-10-20 11:00:59',
    ]);
    expect(isLate(before, mailAt, askedAt)).toBe(false);
    // A second later the first one has less than 3×24 hours left to its last second in time: a
    // resend arriving at the end of the 3×24 hours, 12:01:00 on the 24th, would be late by its own
    // arrival — so the ask-back is late.
    expect(isLate(before, mailAt, new Date(askedAt.getTime() + 1_000))).toBe(true);
    // A standing action like the cancelled one makes it late at once.
    await createModerationAction(t.db, {
      userId: member.id,
      createdBy: operator.id,
      createdAt: actedFor('2026-10-22T03:00:00Z'),
    });
    const after = await lookup('late@example.com');
    expect(after.filter((row) => row.deadline_kst === '2026-10-22 12:00:59')).toHaveLength(2);
    expect(isLate(after, mailAt, askedAt)).toBe(true);
  });

  it('gives a writing restriction shortened since as the action it is: taken when it was, not cancelled', async () => {
    // A 감경 or an early lift brings a writing restriction's end forward and keeps the action
    // (ADR-0082 7-3): its appeal deadline runs from when it was taken, as the member's card keeps
    // it, and the lookup does not read it as cancelled (docs/OPERATIONS.md steps 1, 2 and 5).
    const { user: operator } = await createUser(t.db, { role: 'admin' });
    const { user: member } = await createUser(t.db, { email: 'restricted@example.com' });
    const DAY = 24 * 60 * 60 * 1_000;
    const takenAt = new Date(Date.now() - 2 * DAY);
    const restriction = await createModerationAction(t.db, {
      userId: member.id,
      createdBy: operator.id,
      type: 'writing_restriction',
      createdAt: takenAt,
      endsAt: new Date(takenAt.getTime() + 7 * DAY),
    });
    const shortenedTo = new Date(takenAt.getTime() + 3 * DAY);
    await t.db
      .update(moderationActions)
      .set({ endsAt: shortenedTo })
      .where(eq(moderationActions.id, restriction.id));
    await t.db.insert(restrictionEndChanges).values({
      actionId: restriction.id,
      kind: 'shorten',
      previousEndsAt: restriction.endsAt,
      endsAt: shortenedTo,
      reason: '이의를 일부 받아들임',
      createdBy: operator.id,
    });
    expect(await lookup('restricted@example.com')).toEqual([
      {
        user_id: member.id,
        action_id: restriction.id,
        type: 'writing_restriction',
        acted_kst: kstToSecond(takenAt),
        deadline_kst: lastSecondBefore(appealWindowEndOf(takenAt)),
        cancelled: false,
      },
    ]);
  });

  it('leaves out of a late ask-back an action taken after the asked-back mail came', async () => {
    // A vague mail at noon on day 0, a hide half a day later, the ask-back on day 12 after a
    // backlog: the hide's deadline (day 14.5) falls inside the ask-back's 3×24 hours, yet the
    // mail could not speak of it — it neither makes the ask-back late nor gets the mail's time
    // (ADR-0084 6-8; the rare case is step 7's).
    const { user: operator } = await createUser(t.db, { role: 'admin' });
    const { user: member } = await createUser(t.db, { email: 'after@example.com' });
    const mailAt = new Date('2026-10-01T03:00:00Z'); // 2026-10-01 12:00:00 KST
    const askedAt = new Date('2026-10-13T03:00:00Z'); // 2026-10-13 12:00:00 KST, + 3×24 h
    const hiddenAt = new Date('2026-10-01T15:00:00Z'); // 2026-10-02 00:00:00 KST
    await createModerationAction(t.db, {
      userId: member.id,
      createdBy: operator.id,
      createdAt: hiddenAt,
    });
    const before = await lookup('after@example.com');
    expect(before.map((row) => [row.acted_kst, row.deadline_kst])).toEqual([
      ['2026-10-02 00:00:00', '2026-10-16 00:00:59'],
    ]);
    // In time for the mail and inside the 3×24 hours — late, but for the acted-by condition.
    const limit = kstToSecond(new Date(askedAt.getTime() + 3 * 24 * 60 * 60 * 1_000));
    expect(before[0]!.deadline_kst! >= kstToSecond(mailAt)).toBe(true);
    expect(before[0]!.deadline_kst! < limit).toBe(true);
    expect(isLate(before, mailAt, askedAt)).toBe(false);
    // An action taken by the time the mail came — at its very second — makes it late.
    await createModerationAction(t.db, {
      userId: member.id,
      createdBy: operator.id,
      createdAt: mailAt,
    });
    const after = await lookup('after@example.com');
    expect(after.map((row) => row.acted_kst)).toEqual([
      '2026-10-02 00:00:00',
      '2026-10-01 12:00:00',
    ]);
    expect(after[1]!.deadline_kst).toBe(lastSecondBefore(appealWindowEndOf(mailAt)));
    expect(isLate(after, mailAt, askedAt)).toBe(true);
    expect(isLate(after, new Date(mailAt.getTime() - 1_000), askedAt)).toBe(false);
  });
});
