/**
 * What docs/DECISIONS.md says of #77's owner decisions and of the line #77 added to #140's closure
 * screen (ADR-0089), held to the tables, the closure check and the copy they name:
 *
 * - a bare '오너 결정 <date> N' in ADR-0089 names an answer of ADR-0089's own table of that date —
 *   so another ADR's answer of a day ADR-0089 also has a table for (ADR-0087's 2026-10-24 11·13)
 *   carries its ADR, and an 'ADR-0089 오너 결정 <date> N' anywhere names an answer that exists;
 * - decision 7's opening names every item chosen since the first build, up to the last one;
 * - wherever ADR-0089 speaks of 결과 4 — the preface, decision 7's opening, 결과 3 — it says what
 *   결과 4 says: no question left, or that the questions are there (the preface with their number);
 * - where ADR-0089 adds `pendingProposals` to `GET /me/closure`'s answer, ADR-0086's status line
 *   names every ADR-0086 decision that lists that answer's fields (3, and 5's registry reason);
 * - ADR-0089 결과 1 repeats, as it stands, each clause ADR-0089 wrote into another ADR's status line;
 * - the 2026-10-24 table, which says its 결정 cell is the owner's words, holds them as the owner gave
 *   them (2026-10-24 20:19), the screen's line in them as copy.ts has it.
 *
 * Static: it reads files, no database.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { accountClosureCheckSchema } from '@buddha/shared';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

const DECISIONS = read('docs/DECISIONS.md');
const COPY = read('apps/web/src/copy.ts');

/** The text from `start` (included) to `end` (excluded) in `text`; throws when either is missing. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from === -1 || to === -1) throw new Error(`no "${start}" … "${end}" in the text`);
  return text.slice(from, to);
}

/** ADR `n` (four digits), to the next ADR or the end of docs/DECISIONS.md. */
function adr(n: string): string {
  const start = DECISIONS.indexOf(`\n## ADR-${n} `);
  if (start === -1) throw new Error(`no ADR-${n} in docs/DECISIONS.md`);
  const end = DECISIONS.indexOf('\n## ADR-', start + 1);
  return DECISIONS.slice(start, end === -1 ? undefined : end);
}

/** The ADR's '- 상태:' line. */
function statusLine(text: string): string {
  const line = text.split('\n').find((l) => l.startsWith('- 상태:'));
  if (line === undefined) throw new Error('no status line');
  return line;
}

/** Every '일부 대체됨(ADR-<by>: …)' clause of a status line, parentheses balanced. */
function clausesBy(line: string, by: string): string[] {
  const head = `일부 대체됨(ADR-${by}:`;
  const clauses: string[] = [];
  for (let at = line.indexOf(head); at !== -1; at = line.indexOf(head, at + 1)) {
    let depth = 0;
    let end = at + '일부 대체됨'.length;
    for (; end < line.length; end += 1) {
      if (line[end] === '(') depth += 1;
      if (line[end] === ')') depth -= 1;
      if (depth === 0) break;
    }
    if (depth !== 0) throw new Error(`unbalanced clause at ${at}: ${line.slice(at, at + 80)}`);
    clauses.push(line.slice(at, end + 1));
  }
  return clauses;
}

/** A '| N | 주제 | 결정 |' row's cells, trimmed. */
function cells(row: string): string[] {
  return row
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/**
 * An ADR's own owner-decision tables, by the name a citation uses: the date, and the round when the
 * table has one ('2026-10-24 (2차)') — a descriptive label ('(첫 구현 뒤 물은 것)') is not part of
 * the name. Each holds its rows by answer number.
 */
function ownerTables(text: string): Map<string, Map<number, string[]>> {
  const tables = new Map<string, Map<number, string[]>>();
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const head = /^\*\*오너 결정 (\d{4}-\d\d-\d\d)(?: (\([^)]*\)))?/.exec(line);
    if (head === null) return;
    const round = head[2] !== undefined && /^\(\d+차\)$/.test(head[2]) ? ` ${head[2]}` : '';
    const rows = new Map<number, string[]>();
    let j = i + 1;
    while (j < lines.length && !lines[j]!.startsWith('|')) j += 1;
    for (; j < lines.length && lines[j]!.startsWith('|'); j += 1) {
      const row = cells(lines[j]!);
      if (/^\d+$/.test(row[0]!)) rows.set(Number(row[0]), row);
    }
    tables.set(`${head[1]}${round}`, rows);
  });
  return tables;
}

/** Every '[ADR-NNNN(의) ]오너 결정 <date>[ (N차)][ 답] N[·N…]' in `text`. */
function numberedCitations(text: string) {
  const pattern =
    /(?:ADR-(\d{4})의? )?오너 결정 (\d{4}-\d\d-\d\d)(?: (\(\d+차\)))?(?: 답)? (\d+(?:·\d+)*)/g;
  return [...text.matchAll(pattern)].map((match) => ({
    text: match[0],
    adr: match[1],
    table: `${match[2]}${match[3] === undefined ? '' : ` ${match[3]}`}`,
    answers: match[4]!.split('·').map(Number),
  }));
}

const ADR_0086 = adr('0086');
const ADR_0089 = adr('0089');
const OWN_TABLES = ownerTables(ADR_0089);

/** The `closureProposals` line of copy.ts. */
const CLOSURE_PROPOSALS = (() => {
  const match = /\bclosureProposals:\s*'([^']*)'/.exec(COPY);
  if (match === null) throw new Error('no closureProposals in copy.ts');
  return match[1]!;
})();

describe('#77’s owner decisions in ADR-0089', () => {
  it('reads ADR-0089’s own tables: 2026-10-19 (15 answers), 2026-10-20 (4) and 2026-10-24 (1)', () => {
    expect([...OWN_TABLES.keys()]).toEqual(['2026-10-19', '2026-10-20', '2026-10-24']);
    expect([...OWN_TABLES.get('2026-10-19')!.keys()]).toEqual(
      Array.from({ length: 15 }, (_, i) => i + 1),
    );
    expect([...OWN_TABLES.get('2026-10-20')!.keys()]).toEqual([1, 2, 3, 4]);
    expect([...OWN_TABLES.get('2026-10-24')!.keys()]).toEqual([1]);
  });

  it('cites another ADR’s answer of a day ADR-0089 has its own table for with that ADR’s name: a bare citation names an answer of ADR-0089’s own table', () => {
    const bare = numberedCitations(ADR_0089).filter(
      (citation) => citation.adr === undefined && OWN_TABLES.has(citation.table),
    );
    // The ADR cites its own answers bare throughout (2026-10-19 3, 8, 13, 15, 2026-10-20 4, …).
    expect(bare.length).toBeGreaterThan(30);
    for (const citation of bare) {
      const rows = OWN_TABLES.get(citation.table)!;
      for (const answer of citation.answers) {
        expect(rows.has(answer), `"${citation.text}" — ADR-0089 has no such answer`).toBe(true);
      }
    }
    // ADR-0087's 2026-10-24 answers that #77 builds on (#184's retention) carry ADR-0087's name.
    const adr0087 = numberedCitations(ADR_0089).filter((citation) => citation.adr === '0087');
    expect(adr0087.map((citation) => citation.text)).toEqual(
      expect.arrayContaining([
        'ADR-0087 오너 결정 2026-10-24 11·13',
        'ADR-0087 오너 결정 2026-10-24 13',
      ]),
    );
    for (const citation of adr0087) {
      const rows = ownerTables(adr('0087')).get(citation.table);
      for (const answer of citation.answers) expect(rows?.has(answer)).toBe(true);
    }
  });

  it('names an existing answer wherever docs/DECISIONS.md cites ADR-0089’s owner decisions by number', () => {
    const cited = numberedCitations(DECISIONS).filter((citation) => citation.adr === '0089');
    expect(cited.length).toBeGreaterThan(0);
    for (const citation of cited) {
      const rows = OWN_TABLES.get(citation.table);
      for (const answer of citation.answers) {
        expect(rows?.has(answer), `"${citation.text}" — ADR-0089 has no such answer`).toBe(true);
      }
    }
  });

  it('holds in the 2026-10-24 table the owner’s words as given, the screen’s line as copy.ts has it', () => {
    const head = ADR_0089.split('\n').find((line) => line.startsWith('**오너 결정 2026-10-24'));
    // The table says its 결정 cell is the owner's words…
    expect(head).toContain('결정 칸은 오너의 글 그대로다');
    // …so it holds the answer of 2026-10-24 20:19 as written (only its issue tag, '[#77·#140]', is
    // left out): the screen, '→', which accounts, the line in quotes, '보임' and the parenthesis.
    const [answer, topic, decision] = OWN_TABLES.get('2026-10-24')!.get(1)!;
    expect(answer).toBe('1');
    expect(topic).toBe('탈퇴 확인 화면의 시장 제안');
    expect(decision).toBe(
      `탈퇴 확인 화면 → 접수·검토 중인 시장 제안이 있는 계정에만 '${CLOSURE_PROPOSALS}'를 보임(시작 Coin 줄처럼)`,
    );
    expect(CLOSURE_PROPOSALS).toBe(
      '낸 시장 제안은 운영자가 그대로 처리하며, 탈퇴한 뒤에는 볼 수 없습니다.',
    );
  });

  it('opens decision 7 with every item chosen since the first build, the last one included', () => {
    const section = between(ADR_0089, '**7. 구현의 선택.**', '**8. 시험.**');
    const opening = section.split('\n')[0]!;
    const items = section
      .split('\n')
      .map((line) => /^(\d+)\. \*\*/.exec(line))
      .filter((match) => match !== null)
      .map((match) => Number(match[1]));
    const last = Math.max(...items);
    expect(items).toEqual(Array.from({ length: last }, (_, i) => i + 1));

    // '7-a\~7-b' ranges and single '7-n's the opening names.
    const named = new Set<number>();
    const rangeStarts: number[] = [];
    for (const match of opening.matchAll(/7-(\d+)(?:\\~7-(\d+))?/g)) {
      const from = Number(match[1]);
      const to = match[2] === undefined ? from : Number(match[2]);
      if (match[2] !== undefined) rangeStarts.push(from);
      for (let n = from; n <= to; n += 1) named.add(n);
    }
    // The items the first build chose are not listed; from the first range on, every one is —
    // up to the last (7-34, chosen building the 2026-10-24 answer).
    const firstRange = Math.min(...rangeStarts);
    for (let n = firstRange; n <= last; n += 1) {
      expect(named.has(n), `decision 7's opening does not name 7-${n}`).toBe(true);
    }
    expect(opening).toContain('오너 결정 2026-10-24를 구현하며 고른 것은 7-34다');
  });

  it('says what 결과 4 says wherever it speaks of 결과 4: the preface, decision 7’s opening and 결과 3', () => {
    const lines = ADR_0089.split('\n');
    const lineStarting = (start: string) => {
      const found = lines.filter((line) => line.startsWith(start));
      expect(found, `one line starting "${start}"`).toHaveLength(1);
      return found[0]!;
    };
    const result4 = between(ADR_0089, '**4. 오너에게 물을 것.**', '**5. 알려진 한계');
    const questions = result4.split('\n').filter((line) => /^\d+\. \*\*/.test(line));
    const preface = lineStarting('이슈 번호와 기획 인용 표기는');
    const opening = lineStarting('**7. 구현의 선택.**');
    const result3 = lineStarting('**3. 오너가 할 일.**');

    if (result4.startsWith('**4. 오너에게 물을 것.** 없다.')) {
      expect(questions).toEqual([]);
      expect(preface).toContain('물을 것은 결과 4에 남긴다(지금은 없다)');
      for (const text of [opening, result3]) {
        expect(text).toContain('결과 4에 남은 질문은 없다');
        expect(text).not.toMatch(/물을 것은 결과 4에 있다|결과 4의 질문에 답한다/);
      }
      return;
    }
    // Questions left (2026-10-25: the operator's number change and the proposals' hash): each is
    // numbered and ends with what is done now, and every place sends the reader there.
    expect(result4).toContain('지금 동작은 질문의 마지막 문장이다.');
    expect(questions.length).toBeGreaterThan(0);
    for (const question of questions) expect(question).toMatch(/ — 지금은 [^—]+다\.$/);
    const count = ['하나', '둘', '셋', '넷', '다섯'][questions.length - 1];
    expect(preface).toContain(`물을 것은 결과 4에 남긴다(지금은 ${count} — `);
    expect(opening).toContain('아직 물을 것은 결과 4에 있다');
    expect(result3).toContain('결과 4의 질문에 답한다');
    for (const text of [preface, opening, result3]) expect(text).not.toContain('남은 질문은 없다');
  });
});

describe('the closure check’s new field in ADR-0086’s status line (ADR-0089)', () => {
  it('names every ADR-0086 decision that lists `GET /me/closure`’s fields where ADR-0089 adds `pendingProposals`, decision 5’s registry reason included', () => {
    const fields = Object.keys(accountClosureCheckSchema.shape);
    const clause = clausesBy(statusLine(ADR_0086), '0089').find((c) =>
      c.includes('`pendingProposals`'),
    );
    expect(clause).toBeDefined();
    const added = fields.filter((field) => clause!.includes(`\`${field}\``));
    expect(added).toEqual(['pendingProposals']);
    // The fields ADR-0086 knew; a decision of it that names them all lists the answer's fields.
    const known = fields.filter((field) => !added.includes(field));
    expect(known).toEqual(['availableCoin', 'refusals', 'restriction', 'startGrantReceived']);

    const decided = between(ADR_0086, '\n### 결정', '\n### 결과');
    const listing = decided
      .split(/\n(?=\*\*\d+\. )/)
      .map((section) => ({ n: /^\*\*(\d+)\. /.exec(section)?.[1], section }))
      .filter(
        ({ n, section }) => n !== undefined && known.every((f) => section.includes(`\`${f}\``)),
      )
      .map(({ n }) => Number(n));
    // 3 (the shared answer) and 5 (the registry reason, '…만' — a field more is a word more).
    expect(listing).toEqual([3, 5]);

    const replaced = /결정 ([\d·]+)의/.exec(clause!);
    expect(replaced).not.toBeNull();
    const numbers = replaced![1]!.split('·').map(Number);
    for (const n of listing) {
      expect(numbers, `ADR-0086's status line leaves out decision ${n}`).toContain(n);
    }
    expect(clause).toContain('등록 이유(`registry.ts`');
  });

  it('repeats in ADR-0089 결과 1, as it stands, every clause ADR-0089 wrote into another ADR’s status line', () => {
    const result1 = between(ADR_0089, '**1. 상태 줄.**', '**2. 문서.**');
    const bullets = result1.split('\n').filter((line) => /^- ADR-\d{4}: /.test(line));
    const others = [...DECISIONS.matchAll(/\n## ADR-(\d{4}) /g)]
      .map((match) => match[1]!)
      .filter((n) => n !== '0089');
    let seen = 0;
    for (const n of others) {
      const status = adr(n)
        .split('\n')
        .find((line) => line.startsWith('- 상태:'));
      if (status === undefined) continue;
      for (const clause of clausesBy(status, '0089')) {
        seen += 1;
        expect(
          bullets.some((bullet) => bullet.startsWith(`- ADR-${n}: ${clause}`)),
          `ADR-0089 결과 1 does not repeat ADR-${n}'s "${clause.slice(0, 60)}…"`,
        ).toBe(true);
      }
    }
    // ADR-0054, ADR-0043, ADR-0085, ADR-0086 (two) and ADR-0087.
    expect(seen).toBe(6);
  });
});
