import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Reading what a source file under `src/` can put on a screen, and what it imports (whose screen
 * it is), for the checks that keep a word off every screen: the old currency unit
 * (coin-unit.test.ts, #13) and the excluded features (excluded-features.test.ts, #113). Test
 * support, not screen code: the walk skips this folder.
 */

const TEST_SUPPORT = path.dirname(fileURLToPath(import.meta.url));

/** apps/web/src. */
export const SRC = path.dirname(TEST_SUPPORT);

/**
 * The legal bodies (#137): 이용약관, 개인정보처리방침, 환불정책 and the no-cash sentence the first and
 * the last quote. They keep their wording until their own revision, so the screen walk leaves
 * them out and each check says what it still holds them to. The rest of `legal/` — the business
 * details the footer renders, the document view and its helpers — is screen code like any other.
 */
export const LEGAL_BODIES: readonly string[] = [
  'terms.ts',
  'privacy.ts',
  'refund.ts',
  'cash-notice.ts',
].map((name) => path.join(SRC, 'legal', name));

/**
 * A script: TypeScript or JavaScript, with JSX or not, ES module or CommonJS. Next takes `.js` and
 * `.jsx` pages as well as `.ts` and `.tsx` (`pageExtensions`), and any of them can be imported.
 */
export const SCRIPT = /\.[cm]?[jt]sx?$/;

/** A test or a declaration file: never rendered. */
const NOT_RENDERED = /\.(test|spec|d)\.[cm]?[jt]sx?$/;

/** How to parse a script: with JSX or not, as TypeScript or JavaScript. */
export function scriptKindOf(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/**
 * Every script under `dir` that can render text, TypeScript or JavaScript: not a legal body, not
 * a test, a declaration file or the test support.
 */
export function screenSources(dir: string = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return full === TEST_SUPPORT ? [] : screenSources(full);
    const screen =
      SCRIPT.test(entry.name) && !NOT_RENDERED.test(entry.name) && !LEGAL_BODIES.includes(full);
    return screen ? [full] : [];
  });
}

/**
 * The switch that keeps paid Coin closed (PAID_COIN_SALES_ENABLED, ADR-0049). Code in the branch
 * it opens — `SWITCH ? … : …`, `SWITCH && …`, `if (SWITCH) …` — is drawn only while sales are on.
 */
export const SALES_SWITCH = 'PAID_COIN_SALES_ENABLED';

function isSalesSwitch(node: ts.Node): boolean {
  return ts.isIdentifier(node) && node.text === SALES_SWITCH;
}

/** Whether `node` sits in the branch the sales switch opens. */
function gatedBySalesSwitch(node: ts.Node): boolean {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isConditionalExpression(parent) && isSalesSwitch(parent.condition)) {
      if (child === parent.whenTrue) return true;
    } else if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      isSalesSwitch(parent.left)
    ) {
      if (child === parent.right) return true;
    } else if (ts.isIfStatement(parent) && isSalesSwitch(parent.expression)) {
      if (child === parent.thenStatement) return true;
    }
  }
  return false;
}

/** A place in a source file, and whether only an open sale draws it. */
export interface SourcePlace {
  line: number;
  gated: boolean;
}

/** The screen text a source file can render, one entry per literal. */
export interface Literal extends SourcePlace {
  text: string;
}

/** An interpolated value, read as a number: `${amount}P` must look like '0P'. */
const VALUE = '0';

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(fileName),
  );
}

function placeOf(file: ts.SourceFile, node: ts.Node): SourcePlace {
  const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
  return { line: line + 1, gated: gatedBySalesSwitch(node) };
}

/**
 * Every string literal, template literal (an interpolation read as the digit 0) and run of JSX
 * text (children as they render side by side; a nested element breaks the run). Comments are not
 * screen text.
 */
export function literalsOf(fileName: string, source: string): Literal[] {
  const file = parse(fileName, source);
  const found: Literal[] = [];
  const add = (node: ts.Node, text: string) => found.push({ ...placeOf(file, node), text });
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      add(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      add(node, node.head.text + node.templateSpans.map((s) => VALUE + s.literal.text).join(''));
    } else if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
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

/** A use of `copy.<key>`. */
export interface CopyRef extends SourcePlace {
  key: string;
}

/** Every `copy.<key>` the file reads (the copy object is only ever read by property). */
export function copyRefsOf(fileName: string, source: string): CopyRef[] {
  const file = parse(fileName, source);
  const found: CopyRef[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'copy'
    ) {
      found.push({ ...placeOf(file, node), key: node.name.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const MODULE_FILES = [
  '',
  ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  ...['.ts', '.tsx', '.js', '.jsx'].map((extension) => `/index${extension}`),
];

/**
 * The sources under `src/` a file imports, re-exports from or loads with `import()`, resolved to
 * their files (`@/` is `src/`). Packages and files that are not there are left out.
 */
export function localImportsOf(fileName: string, source: string): string[] {
  const file = parse(fileName, source);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [
    ...new Set(
      specifiers.flatMap((specifier) => {
        const base = specifier.startsWith('@/')
          ? path.join(SRC, specifier.slice(2))
          : specifier.startsWith('.')
            ? path.resolve(path.dirname(fileName), specifier)
            : undefined;
        if (base === undefined) return [];
        const found = MODULE_FILES.map((suffix) => base + suffix).find(
          (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
        );
        return found === undefined ? [] : [found];
      }),
    ),
  ];
}

/**
 * Every use of `names` outside import declarations: the name itself (`formatKrw(…)`,
 * `shared.formatKrw`, `{ formatKrw: won } = shared`), a string key (`shared['formatKrw']`), and
 * the local name an import gives it (`import { formatKrw as money }`, then `money(…)`, reported as
 * `formatKrw as money`).
 */
export function usesOf(
  fileName: string,
  source: string,
  names: readonly string[],
): (SourcePlace & { name: string })[] {
  const file = parse(fileName, source);
  const aliases = new Map<string, string>();
  for (const statement of file.statements) {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (names.includes(imported) && element.name.text !== imported) {
        aliases.set(element.name.text, imported);
      }
    }
  }
  const found: (SourcePlace & { name: string })[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && names.includes(node.text)) {
      found.push({ ...placeOf(file, node), name: node.text });
    } else if (ts.isIdentifier(node) && aliases.has(node.text)) {
      found.push({ ...placeOf(file, node), name: `${aliases.get(node.text)!} as ${node.text}` });
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      names.includes(node.argumentExpression.text)
    ) {
      found.push({ ...placeOf(file, node), name: node.argumentExpression.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
