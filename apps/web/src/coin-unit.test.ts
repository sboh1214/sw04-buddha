import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { copy } from './copy';

/**
 * The old currency unit must not come back into screen text (#13, ADR-0051). Amounts read
 * '12,345 Coin' (`formatCoin`), labels say '코인' or 'Coin', and the unit 'P' and the word '포인트'
 * are gone from everything a page renders: the copy, and every string literal, template literal
 * and JSX text under `src/`. Two kinds of file are left out on purpose: the legal bodies
 * (`LEGAL_BODIES`), which keep their wording until their own revision (#137), and test files,
 * which are not screen text.
 *
 * The old unit is
 * - an amount followed by P — '100P', '1,000,000P', '1 P', and `${amount}P` in a template or
 *   `{amount}P` in JSX (an interpolation is read as the digit 0);
 * - P written as a word beside Korean — 'P 충전', '지급 P', 'P는';
 * - P in parentheses, as a label's unit — '금액(P)', '금액 (P)';
 * - a text that is the letter P alone: the old mark on the coin drawing (JSX text) and the old
 *   trade panel's unit, a string drawn after the field (`const unit = … ? 'P' : …`);
 * - 포인트, except inside 엔드포인트.
 *
 * It is not '%p' (a change in percentage points, N02 §5), 'P&L', 'PG', 'PLAN', 'L.PAY' or a
 * SQLSTATE such as '22P02'. Only an ASCII letter, digit, '_' or '&' after the P clears it, so a
 * Korean particle does not: '100P씩' is still caught.
 */
const OLD_UNIT: readonly RegExp[] = [
  /\d ?P(?![A-Za-z0-9_&])/,
  /(?<![A-Za-z0-9_%&.])P(?= ?\p{Script=Hangul})/u,
  /\p{Script=Hangul} ?P(?![A-Za-z0-9_&])/u,
  /\(\s*P\s*\)/,
  /^\s*P\s*$/,
  /(?<!엔드)포인트/,
];

function hasOldUnit(text: string): boolean {
  return OLD_UNIT.some((pattern) => pattern.test(text));
}

/** The screen text a source file can render, one entry per literal, with its line. */
interface Literal {
  line: number;
  text: string;
}

/** An interpolated value, read as a number: `${amount}P` must look like '0P'. */
const VALUE = '0';

function literalsOf(fileName: string, source: string): Literal[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: Literal[] = [];
  const add = (node: ts.Node, text: string) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    found.push({ line: line + 1, text });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      add(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      add(node, node.head.text + node.templateSpans.map((s) => VALUE + s.literal.text).join(''));
    } else if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      // The children as they render side by side; a nested element breaks the run.
      const run = node.children
        .map((child) =>
          ts.isJsxText(child)
            ? child.text
            : ts.isJsxExpression(child)
              ? child.expression === undefined
                ? ''
                : VALUE
              : '\n',
        )
        .join('')
        .replace(/[ \t]*\n[ \t\n]*/g, '\n');
      for (const piece of run.split('\n')) {
        if (piece.trim() !== '') add(node, piece.trim());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const SRC = path.dirname(fileURLToPath(import.meta.url));

/**
 * The legal bodies (#137): 이용약관, 개인정보처리방침, 환불정책 and the no-cash sentence the first and
 * the last quote. The rest of `legal/` — the business details the footer renders, the document
 * view and its helpers — is screen code like any other and is read.
 */
const LEGAL_BODIES: readonly string[] = [
  'terms.ts',
  'privacy.ts',
  'refund.ts',
  'cash-notice.ts',
].map((name) => path.join(SRC, 'legal', name));

/** Every .ts/.tsx under src/ that can render text: not a legal body (#137), not a test. */
function screenSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return screenSources(full);
    const screen =
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|d)\.tsx?$/.test(entry.name) &&
      !LEGAL_BODIES.includes(full);
    return screen ? [full] : [];
  });
}

describe('the old currency unit (#13)', () => {
  it('recognises the old unit in every form it took', () => {
    for (const text of [
      '12,345P',
      '−1,200P',
      '맞히면 100P',
      '1P 이상 1,000,000P 이하',
      '100P씩 지급',
      '10,000P가',
      '1 P',
      'P 충전',
      '지급 P',
      '순 수취 P',
      'P는 서비스 전용',
      '이미 사용한 P가 있어',
      '금액(P)',
      '금액 (P)',
      'P',
      '서비스 전용 포인트입니다',
    ]) {
      expect(hasOldUnit(text), text).toBe(true);
    }
  });

  it('leaves %p, P&L and other capital Ps alone', () => {
    for (const text of [
      '+2%p',
      '−0.5%p',
      'P&L',
      'PG',
      'PLAN 11.4',
      'L.PAY',
      'SQLSTATE 22P02',
      'PATCH',
      '12,345 Coin',
      '−1,200 Coin',
      '63.00 Coin',
      '가용 코인',
      '코인 충전',
      'API 엔드포인트',
    ]) {
      expect(hasOldUnit(text), text).toBe(false);
    }
  });

  it('reads interpolations as amounts and JSX text as it renders', () => {
    const planted = [
      'const a = `${(bp / 100).toFixed(2)}P`;',
      'const b = <Text>{amount}P</Text>;',
      'const c = <text>P</text>;',
      "const d = '1,000P';",
      "const unit = spend ? 'P' : copy.tradeUnitContracts;",
      'const f = <Field label="금액 (P)" />;',
    ].join('\n');
    expect(
      literalsOf('planted.tsx', planted)
        .filter(({ text }) => hasOldUnit(text))
        .map((l) => l.line),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    const clean = [
      'const a = `${(bp / 100).toFixed(2)} Coin`;',
      'const b = <Text>{amount} Coin</Text>;',
      'const c = `${sign}${points}%p`;',
      '// 100P in a comment is not screen text',
    ].join('\n');
    expect(literalsOf('clean.tsx', clean).filter(({ text }) => hasOldUnit(text))).toEqual([]);
  });

  it('is not in any copy value', () => {
    const hits = Object.entries(copy).filter(([, text]) => hasOldUnit(text));
    expect(hits).toEqual([]);
  });

  it('is not in any string or JSX text under src/ outside the legal bodies', () => {
    const files = screenSources(SRC);
    // The walk reached the screens and the rest of legal/, and skipped only the legal bodies.
    expect(files.some((file) => file.endsWith(path.join('auth', 'auth-buttons.tsx')))).toBe(true);
    expect(files.some((file) => file.endsWith(path.join('legal', 'business-info.ts')))).toBe(true);
    expect(files.filter((file) => LEGAL_BODIES.includes(file))).toEqual([]);
    const hits = files.flatMap((file) =>
      literalsOf(file, readFileSync(file, 'utf8'))
        .filter(({ text }) => hasOldUnit(text))
        .map((literal) => `${path.relative(SRC, file)}:${String(literal.line)}: ${literal.text}`),
    );
    expect(hits).toEqual([]);
  });
});
