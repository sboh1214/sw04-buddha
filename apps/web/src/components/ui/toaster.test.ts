import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SRC, scriptKindOf, screenSources } from '@/test/screen-text';
import { toastAfterCommit, toaster } from './toaster';

/**
 * ADR-0092 8-37: the toast group stores its toasts with React's `flushSync`, which React cannot run
 * while it runs effects — a toast raised there logged 'flushSync was called from inside a lifecycle
 * method' in development, once for each subscriber of the store — four on the post page an account
 * switch takes the comment drafts back on, eight in the mixed order, whose second raise updates the
 * toast. A toast raised there goes through `toastAfterCommit`, which stores it a microtask later. No
 * component renders under node (vitest's `environment: 'node'`), so the call sites are pinned in
 * the sources; e2e comments.spec.ts watches the console through the account switches.
 */

const EFFECTS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect']);

/** Whether `fn` is an effect's callback: the first argument of `useEffect(…)` or its kin. */
function isEffectCallback(fn: ts.Node, tree: ts.SourceFile): boolean {
  const call = fn.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== fn) return false;
  return EFFECTS.has(call.expression.getText(tree).replace(/^React\./, ''));
}

/** The function `node` runs in, if any. */
function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let at = node.parent;
  while (!ts.isSourceFile(at) && !ts.isFunctionLike(at)) at = at.parent;
  return ts.isSourceFile(at) ? undefined : at;
}

/** What holds `node`, past any parentheses around it. */
function holderOf(node: ts.Node): ts.Node {
  let at = node.parent;
  while (ts.isParenthesizedExpression(at)) at = at.parent;
  return at;
}

/** Array, `Map` and `Set` methods that call the function they are given before they return. */
const CALLS_NOW = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
  'sort',
  'toSorted',
]);

/**
 * Whether `fn` runs while React runs effects: an effect's callback; the cleanup it returns, from
 * its body (`return () => …`) or as its expression (`() => () => …`); or a function either of them
 * hands to `forEach` and its kin, which call it there and then.
 */
function runsInEffects(fn: ts.Node, tree: ts.SourceFile): boolean {
  if (isEffectCallback(fn, tree)) return true;
  const holder = holderOf(fn);
  const returnedBy = ts.isReturnStatement(holder)
    ? enclosingFunction(holder)
    : ts.isArrowFunction(holder)
      ? holder
      : undefined;
  if (returnedBy !== undefined && isEffectCallback(returnedBy, tree)) return true;
  if (
    ts.isCallExpression(holder) &&
    ts.isPropertyAccessExpression(holder.expression) &&
    CALLS_NOW.has(holder.expression.name.text)
  ) {
    const caller = enclosingFunction(holder);
    return caller !== undefined && runsInEffects(caller, tree);
  }
  return false;
}

/**
 * The calls of `toaster` that run while React runs effects (`runsInEffects`). A function made in
 * them for later — an event listener, a timer, a promise's `then` — runs outside them. One the
 * effect calls by name (a prop, a hook's argument, a `const` of its body) is not followed: those
 * are pinned by name below.
 */
function toastsInEffects(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(tree) === 'toaster'
    ) {
      const fn = enclosingFunction(node);
      if (fn !== undefined && runsInEffects(fn, tree)) {
        const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
        found.push(`${path.relative(SRC, file).split(path.sep).join('/')}:${String(line)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** The text of the function or `const` named `name` in `file` (under src/). */
function declarationOf(file: string, name: string): string {
  const full = path.join(SRC, file);
  const tree = ts.createSourceFile(
    full,
    readFileSync(full, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(full),
  );
  let text: string | undefined;
  const visit = (node: ts.Node) => {
    if (
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name?.getText(tree) === name
    ) {
      text = node.getText(tree);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (text === undefined) throw new Error(`no declaration ${name} in ${file}`);
  return text;
}

describe('toastAfterCommit (ADR-0092 8-37)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores the toast a microtask later, as given, and in the order raised', async () => {
    const create = vi.spyOn(toaster, 'create').mockReturnValue('');
    toastAfterCommit({ id: 'kept:1', type: 'info', title: '첫째' });
    toastAfterCommit({ id: 'kept:1', type: 'info', title: '둘째' });
    expect(create).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(create.mock.calls).toEqual([
      [{ id: 'kept:1', type: 'info', title: '첫째' }],
      [{ id: 'kept:1', type: 'info', title: '둘째' }],
    ]);
  });

  it('stores it in the same task: before a timer, an event or a network callback', async () => {
    const order: string[] = [];
    vi.spyOn(toaster, 'create').mockImplementation(() => {
      order.push('toast');
      return '';
    });
    setTimeout(() => order.push('next task'), 0);
    toastAfterCommit({ type: 'info', title: '알림' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['toast', 'next task']);
  });
});

describe('a toast raised while React runs effects waits for them to end (ADR-0092 8-37)', () => {
  it('raises none from an effect, its cleanup or what they hand to forEach and its kin', () => {
    const found = screenSources()
      .map((file) => [file, readFileSync(file, 'utf8')] as const)
      .filter(([, source]) => source.includes('toaster'))
      .flatMap(([file, source]) => toastsInEffects(file, source));
    expect(found).toEqual([]);
  });

  it('raises the comment drafts and the profile draft taken back through toastAfterCommit', () => {
    // The two effects, and the callback `useReopened`'s effect calls when a box took a held text.
    const raising: readonly (readonly [file: string, name: string, toast: string])[] = [
      ['hooks/use-comment-draft.ts', 'useCommentDraftsTakenBack', 'toastAfterCommit({'],
      ['hooks/use-profile-draft.ts', 'useProfileDraftTakenBack', 'toastAfterCommit({'],
      [
        'components/post/comments-section.tsx',
        'onReopened',
        "toastAfterCommit({ type: 'info', title: copy.commentDraftRestored });",
      ],
    ];
    for (const [file, name, toast] of raising) {
      const declaration = declarationOf(file, name);
      expect(declaration, `${file} ${name}`).toContain(toast);
      expect(declaration, `${file} ${name}`).not.toContain('toaster.');
    }
    expect(declarationOf('components/post/comments-section.tsx', 'useReopened')).toContain(
      '(decided.opened ? onReopened : onSkipped)(commentId, decided.one);',
    );
  });

  it('would catch a toast raised in an effect, and let one raised later through', () => {
    const file = path.join(SRC, 'app', 'example.tsx');
    const found = (body: string) =>
      toastsInEffects(file, `export function C() {\n  ${body}\n  return null;\n}\n`);
    expect(found("useEffect(() => { toaster.create({ title: 'a' }); }, []);")).toEqual([
      'app/example.tsx:2',
    ]);
    expect(found("useLayoutEffect(() => toaster.create({ title: 'a' }));")).toEqual([
      'app/example.tsx:2',
    ]);
    expect(
      found("React.useEffect(() => {\n    return () => toaster.create({ title: 'a' });\n  });"),
    ).toEqual(['app/example.tsx:3']);
    // The cleanup as the effect's expression, as post-form.tsx returns one.
    expect(found("useEffect(() => () => toaster.create({ title: 'a' }), []);")).toEqual([
      'app/example.tsx:2',
    ]);
    expect(found("useEffect(() => (() => toaster.create({ title: 'a' })), []);")).toEqual([
      'app/example.tsx:2',
    ]);
    // A function the effect or its cleanup hands to `forEach` and its kin runs there and then.
    expect(
      found('useEffect(() => {\n    xs.forEach((x) => toaster.create({ title: x }));\n  }, [xs]);'),
    ).toEqual(['app/example.tsx:3']);
    expect(
      found('useEffect(() => () => xs.map((x) => toaster.create({ title: x })), [xs]);'),
    ).toEqual(['app/example.tsx:2']);
    expect(found("useEffect(() => { toastAfterCommit({ title: 'a' }); }, []);")).toEqual([]);
    expect(
      found("useEffect(() => { void load().then(() => toaster.create({ title: 'a' })); }, []);"),
    ).toEqual([]);
    expect(
      found(
        "useEffect(() => {\n    const t = setTimeout(() => toaster.create({ title: 'a' }));\n    return () => clearTimeout(t);\n  }, []);",
      ),
    ).toEqual([]);
    // A function a `forEach` callback returns is not called.
    expect(
      found("useEffect(() => { xs.forEach(() => () => toaster.create({ title: 'a' })); }, [xs]);"),
    ).toEqual([]);
    expect(found("const onClick = () => toaster.create({ title: 'a' });")).toEqual([]);
    expect(found('const onClick = () => xs.forEach((x) => toaster.create({ title: x }));')).toEqual(
      [],
    );
  });
});
