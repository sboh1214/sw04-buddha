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
 * and JSX text under `src/`. Two places are left out on purpose: `legal/`, whose bodies keep
 * their wording until their own revision (#137), and test files, which are not screen text.
 *
 * The old unit is
 * - an amount followed by P — '100P', '1,000,000P', '1 P', and `${amount}P` in a template or
 *   `{amount}P` in JSX (an interpolation is read as the digit 0);
 * - P written as a word beside Korean — 'P 충전', '지급 P', 'P는';
 * - 포인트, anywhere;
 * - a JSX text that is the letter P alone (the old mark on the coin drawing).
 *
 * It is not '%p' (a change in percentage points, N02 §5), 'P&L', 'PG', 'PLAN', 'L.PAY' or a
 * SQLSTATE such as '22P02'. Only an ASCII letter, digit, '_' or '&' after the P clears it, so a
 * Korean particle does not: '100P씩' is still caught.
 */
const OLD_UNIT: readonly RegExp[] = [
  /\d ?P(?![A-Za-z0-9_&])/,
  /(?<![A-Za-z0-9_%&.])P(?= ?\p{Script=Hangul})/u,
  /\p{Script=Hangul} ?P(?![A-Za-z0-9_&])/u,
  /포인트/,
];

function hasOldUnit(text: string): boolean {
  return OLD_UNIT.some((pattern) => pattern.test(text));
}

/** The screen text a source file can render, one entry per literal, with its line. */
interface Literal {
  line: number;
  text: string;
  /** JSX text, where a lone 'P' is the old mark rather than an identifier or a key. */
  jsx: boolean;
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
  const add = (node: ts.Node, text: string, jsx = false) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    found.push({ line: line + 1, text, jsx });
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
        if (piece.trim() !== '') add(node, piece.trim(), true);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function isOldUnit(literal: Literal): boolean {
  return hasOldUnit(literal.text) || (literal.jsx && literal.text === 'P');
}

const SRC = path.dirname(fileURLToPath(import.meta.url));

/** Every .ts/.tsx under src/ that can render text: not legal/ (#137), not a test. */
function screenSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return full === path.join(SRC, 'legal') ? [] : screenSources(full);
    }
    const screen = /\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name);
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
    ].join('\n');
    expect(
      literalsOf('planted.tsx', planted)
        .filter(isOldUnit)
        .map((l) => l.line),
    ).toEqual([1, 2, 3, 4]);
    const clean = [
      'const a = `${(bp / 100).toFixed(2)} Coin`;',
      'const b = <Text>{amount} Coin</Text>;',
      'const c = `${sign}${points}%p`;',
      '// 100P in a comment is not screen text',
    ].join('\n');
    expect(literalsOf('clean.tsx', clean).filter(isOldUnit)).toEqual([]);
  });

  it('is not in any copy value', () => {
    const hits = Object.entries(copy).filter(([, text]) => hasOldUnit(text));
    expect(hits).toEqual([]);
  });

  it('is not in any string or JSX text under src/ outside legal/', () => {
    const files = screenSources(SRC);
    // The walk reached the screens, and legal/ is the one directory it skipped.
    expect(files.some((file) => file.endsWith(path.join('auth', 'auth-buttons.tsx')))).toBe(true);
    expect(files.some((file) => file.includes(`${path.sep}legal${path.sep}`))).toBe(false);
    const hits = files.flatMap((file) =>
      literalsOf(file, readFileSync(file, 'utf8'))
        .filter(isOldUnit)
        .map((literal) => `${path.relative(SRC, file)}:${String(literal.line)}: ${literal.text}`),
    );
    expect(hits).toEqual([]);
  });
});
