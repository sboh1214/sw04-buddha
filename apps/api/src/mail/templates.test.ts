import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { findExcludedText } from '@buddha/shared';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { SRC, programOf, sources, srcPath } from '../test/program.js';
import * as templates from './templates.js';
import {
  type EmailContent,
  MAIL_TEMPLATES,
  changeEmailConfirmationEmail,
  passwordResetEmail,
  verificationEmail,
} from './templates.js';

const url = 'http://localhost:3000/api/auth/verify-email?token=abc&callbackURL=%2F';

describe('mail templates', () => {
  it('verification email is Korean, carries the link in text and html', () => {
    const mail = verificationEmail({ url });
    expect(mail.subject).toContain('이메일 주소를 인증');
    expect(mail.text).toContain(url);
    expect(mail.html).toContain('lang="ko"');
    expect(mail.html).toContain(
      'href="http://localhost:3000/api/auth/verify-email?token=abc&amp;callbackURL=%2F"',
    );
  });

  it('password reset email states the default 60 minute validity', () => {
    const mail = passwordResetEmail({ url });
    expect(mail.subject).toContain('비밀번호 재설정');
    expect(mail.text).toContain('60분');
    expect(passwordResetEmail({ url, expiresInMinutes: 15 }).text).toContain('15분');
  });

  it('change-email confirmation names the new address', () => {
    const mail = changeEmailConfirmationEmail({ url, newEmail: 'new@example.com' });
    expect(mail.subject).toContain('이메일 변경');
    expect(mail.text).toContain('new@example.com');
    expect(mail.html).toContain('new@example.com');
  });

  it('escapes html in interpolated values', () => {
    const mail = verificationEmail({ url: 'http://x/?a=<b>&c="d"' });
    expect(mail.html).not.toContain('<b>');
    expect(mail.html).toContain('&lt;b&gt;&amp;c=&quot;d&quot;');
  });
});

// ---- #113: every mail is a registered template, and no template names an excluded feature ----

/**
 * Example inputs for every registered template, each optional input given at least once. The type
 * asks for a line per template, so a template registered without examples does not compile.
 */
const EXAMPLES: {
  [K in keyof typeof MAIL_TEMPLATES]: readonly [
    Parameters<(typeof MAIL_TEMPLATES)[K]>[0],
    ...Parameters<(typeof MAIL_TEMPLATES)[K]>[0][],
  ];
} = {
  verification: [{ url }, { url, expiresInMinutes: 15 }],
  passwordReset: [{ url }, { url, expiresInMinutes: 15 }],
  changeEmailConfirmation: [{ url, newEmail: 'new@example.com' }],
};

/** Every mail each registered template builds from its examples. */
function renderedMails(): { name: string; mail: EmailContent }[] {
  return Object.entries(MAIL_TEMPLATES).flatMap(([name, build]) =>
    (EXAMPLES[name as keyof typeof MAIL_TEMPLATES] as readonly unknown[]).map((input) => ({
      name,
      mail: (build as (input: unknown) => EmailContent)(input),
    })),
  );
}

const TEMPLATES_FILE = path.join(SRC, 'mail', 'templates.ts');
const MAILER_FILE = path.join(SRC, 'mail', 'mailer.ts');

/** An interpolated value, read as a number, as the web reads its screen text: `${n}분` is '0분'. */
const VALUE = '0';

/** Every string and template literal in `text`, an interpolation read as the digit 0. */
function literalsOf(fileName: string, text: string): { line: number; text: string }[] {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: { line: number; text: string }[] = [];
  const add = (node: ts.Node, value: string) =>
    found.push({
      line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      text: value,
    });
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateExpression(node)) {
      add(node, node.head.text + node.templateSpans.map((s) => VALUE + s.literal.text).join(''));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** What `findExcludedText` finds in each literal of `text`, as `line: match (feature)`. */
const excludedLiterals = (fileName: string, text: string) =>
  literalsOf(fileName, text).flatMap(({ line, text: value }) =>
    findExcludedText(value).map((hit) => `${String(line)}: ${hit.match} (${hit.feature})`),
  );

describe('mail copy (#113, owner decision 2026-10-14)', () => {
  it('registers every template the module exports', () => {
    const registered = new Set<unknown>(Object.values(MAIL_TEMPLATES));
    const unregistered = Object.entries(templates)
      .filter(([, value]) => typeof value === 'function' && !registered.has(value))
      .map(([name]) => name);
    expect(unregistered).toEqual([]);
  });

  it('names nothing the plan leaves out, not only the gambling words', () => {
    const mails = renderedMails();
    expect(new Set(mails.map(({ name }) => name))).toEqual(new Set(Object.keys(MAIL_TEMPLATES)));
    for (const { name, mail } of mails) {
      for (const text of [mail.subject, mail.text, mail.html]) {
        expect(findExcludedText(text), `${name}: ${text}`).toEqual([]);
      }
    }
  });

  it('holds every string in templates.ts to the same words, branches the examples miss included', () => {
    expect(excludedLiterals(TEMPLATES_FILE, readFileSync(TEMPLATES_FILE, 'utf8'))).toEqual([]);
  });

  it('reads a word wherever the file writes it', () => {
    const planted = [
      "import { SERVICE_NAME } from './planted.js';",
      'export function digestEmail(input: { rank: number; late?: boolean }) {',
      "  const note = input.late ? '이번 주 베팅 마감' : '';",
      '  return { subject: `${SERVICE_NAME} 이번 주 순위 ${input.rank}`, text: note, html: note };',
      '}',
    ].join('\n');
    expect(excludedLiterals('planted.ts', planted)).toEqual([
      '3: 베팅 (gambling)',
      '4: 순위 (scoring)',
    ]);
  });
});

// ---- #113: nothing outside templates.ts writes what a mail says ----------------------------------

/** The keys of a message that are what it says. The rest of a `MailMessage` is its address. */
const CONTENT_KEYS = new Set(['subject', 'text', 'html']);

/**
 * A module that talks to a mail service: SMTP, a provider's SDK, a mail renderer. Only the
 * transports below may import one, so every mail goes through `Mailer.send`.
 */
const MAIL_PACKAGE = /mail|smtp|^@aws-sdk\/client-ses|^(?:resend|postmark)$/i;

/** Whether an imported module is a mail package (a relative path is one of ours, not a package). */
const isMailPackage = (name: string) => !name.startsWith('.') && MAIL_PACKAGE.test(name);

/**
 * The files that may import a mail package, with why. Each is a transport: it sends what the
 * callers of `Mailer.send` hand it, which the trace below follows back to a template.
 */
const MAIL_TRANSPORTS: Readonly<Record<string, string>> = {
  'mail/mailer.ts':
    'createMailer: the SMTP transport (nodemailer) behind Mailer.send. It sends the MailMessage ' +
    'its caller passed, with the From header from the environment, and adds no text of its own.',
};

/**
 * The module names a file imports: `import`, `export … from`, `import x = require()`, `require()`
 * and `import()`.
 */
function importsOf(file: ts.SourceFile): { name: string; node: ts.Node }[] {
  const found: { name: string; node: ts.Node }[] = [];
  const visit = (node: ts.Node): void => {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
          ? node.moduleReference.expression
          : ts.isCallExpression(node) &&
              (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
            ? node.arguments[0]
            : undefined;
    if (specifier && ts.isStringLiteralLike(specifier)) found.push({ name: specifier.text, node });
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** A place in the API's sources: `auth/auth.ts:258`. */
const placeOf = (node: ts.Node) => {
  const file = node.getSourceFile();
  const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
  return `${srcPath(file.fileName)}:${String(line + 1)}`;
};

/** The written name of a property, or undefined for a computed one this cannot read. */
function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isPrivateIdentifier(name)) return name.text;
  return ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)
    ? name.expression.text
    : undefined;
}

/** What the mail code of a program does, as the checks below read it. */
interface MailCode {
  /** Each template a send reaches, by the name its call uses (`passwordReset`). */
  templates: string[];
  /** Each place where mail is said or sent in a way that is not a registered template. */
  problems: string[];
}

/**
 * Reads every send in the API's sources and follows what it sends back to where it was written.
 *
 * - A send is an argument handed to a mail-shaped parameter (one whose type has a `subject` and a
 *   `text` or `html`), by the call's resolved signature: `Mailer.send(message)` (mail/mailer.ts)
 *   and anything else that takes a mail, a destructured or renamed `send` and a mailer of another
 *   type included. `Mailer.send` read as a value (handed on, bound) is a problem: what it is
 *   called with cannot be seen.
 * - What a send carries is followed through spreads, `const`s, conditionals, `await` and casts,
 *   and through a function's parameter to every call of that function. It must end in a call of
 *   a template (a callee declared in mail/templates.ts: `MAIL_TEMPLATES.x`, `MAIL_TEMPLATES[k]`).
 *   A content key (`subject`·`text`·`html`) written on the way, a call of anything else and an
 *   expression this cannot follow are problems: a property read, a `let`, the parameter of a
 *   function with no name or of one only a library calls (a better-auth mail hook's own input).
 *   A transport's sends are not traced: they send what the callers of `Mailer.send` handed it.
 * - Apart from the sends, an object literal or an assignment outside templates.ts that writes a
 *   content key of a mail-shaped value is a problem, whether or not it is ever sent.
 * - A mail package imported anywhere but a transport (MAIL_TRANSPORTS) is a problem.
 */
function readMailCode(program: ts.Program): MailCode {
  const checker = program.getTypeChecker();
  const files = program
    .getSourceFiles()
    .filter(
      (file) =>
        file.fileName.startsWith(SRC + path.sep) &&
        !file.fileName.startsWith(path.join(SRC, 'test') + path.sep) &&
        !/\.(test|d)\.ts$/.test(file.fileName),
    );
  const templatesFile = program.getSourceFile(TEMPLATES_FILE);
  const mailerFile = program.getSourceFile(MAILER_FILE);
  const mailerSend = mailerFile?.statements
    .filter(ts.isInterfaceDeclaration)
    .find((declaration) => declaration.name.text === 'Mailer')
    ?.members.find(
      (member): member is ts.MethodSignature =>
        ts.isMethodSignature(member) && propertyName(member.name) === 'send',
    );
  if (templatesFile === undefined || mailerSend === undefined) {
    throw new Error('mail/templates.ts or the Mailer interface in mail/mailer.ts is missing');
  }

  const templates: string[] = [];
  const problems = new Set<string>();
  /** What has been followed already: each expression once, whichever send reaches it first. */
  const seen = new Set<ts.Node>();
  const problem = (node: ts.Node, what: string) => problems.add(`${placeOf(node)}: ${what}`);
  const inTemplates = (node: ts.Node) => node.getSourceFile() === templatesFile;

  const resolved = (symbol: ts.Symbol | undefined) =>
    symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const symbolOf = (node: ts.Node) => resolved(checker.getSymbolAtLocation(node));

  /** Whether a value of this type is a mail's content: a `subject` and a `text` or `html`. */
  const mailShaped = (type: ts.Type | undefined): boolean =>
    type !== undefined &&
    (type.isUnion()
      ? type.types.some(mailShaped)
      : type.getProperty('subject') !== undefined &&
        (type.getProperty('text') !== undefined || type.getProperty('html') !== undefined));

  /** The content keys an object literal writes, and the spreads it takes the rest from. */
  function readLiteral(literal: ts.ObjectLiteralExpression, follow: boolean) {
    for (const property of literal.properties) {
      if (ts.isSpreadAssignment(property)) {
        if (follow) trace(property.expression);
        continue;
      }
      const name = propertyName(property.name);
      if (name === undefined) problem(property, 'a computed key this cannot read');
      else if (CONTENT_KEYS.has(name))
        problem(property, `writes ${name} outside mail/templates.ts`);
    }
  }

  /** The function a parameter belongs to, by the name its calls use. */
  function nameOfFunction(fn: ts.SignatureDeclaration): ts.Node | undefined {
    if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return fn.name;
    if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
      const holder = fn.parent;
      if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) return holder.name;
      if (ts.isPropertyAssignment(holder) || ts.isPropertyDeclaration(holder)) return holder.name;
    }
    return undefined;
  }

  /** Every place a function is named, by its symbol: calls, and reads that hand it on. */
  function referencesOf(name: ts.Node): ts.Identifier[] {
    const symbol = symbolOf(name);
    const text = name.getText();
    const found: ts.Identifier[] = [];
    for (const file of files) {
      const visit = (node: ts.Node): void => {
        if (
          ts.isIdentifier(node) &&
          node.text === text &&
          node !== name &&
          symbolOf(node) === symbol
        ) {
          found.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    return found;
  }

  /** The call a reference is the callee of: `f(…)`, `this.f(…)`, `obj.f(…)`. */
  function callOf(reference: ts.Identifier): ts.CallExpression | undefined {
    const callee =
      ts.isPropertyAccessExpression(reference.parent) && reference.parent.name === reference
        ? reference.parent
        : reference;
    return ts.isCallExpression(callee.parent) && callee.parent.expression === callee
      ? callee.parent
      : undefined;
  }

  /** What a parameter receives: the argument at its place in every call of its function. */
  function traceParameter(parameter: ts.ParameterDeclaration, at: ts.Node) {
    const fn = parameter.parent;
    const name = nameOfFunction(fn);
    if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken || name === undefined) {
      problem(at, `${at.getText()} comes from a parameter this cannot follow`);
      return;
    }
    const index = fn.parameters.indexOf(parameter);
    const references = referencesOf(name).filter(
      ({ parent }) => !ts.isImportSpecifier(parent) && !ts.isExportSpecifier(parent),
    );
    // A hook a library calls (better-auth's mail hooks, a plugin's): what it hands in is unseen.
    if (references.length === 0) {
      problem(at, `${at.getText()} comes from ${name.getText()}, called from outside the API`);
    }
    for (const reference of references) {
      const call = callOf(reference);
      if (call === undefined) {
        problem(reference, `${name.getText()} is handed on; what it is called with cannot be seen`);
        continue;
      }
      const spread = call.arguments.findIndex(ts.isSpreadElement);
      if (spread !== -1 && spread <= index) problem(call, 'a spread argument this cannot follow');
      else if (call.arguments[index]) trace(call.arguments[index]);
    }
  }

  /** Follows what a send carries back to where it was written. */
  function trace(expression: ts.Expression): void {
    if (seen.has(expression)) return;
    seen.add(expression);
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAwaitExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isTypeAssertionExpression(expression)
    ) {
      trace(expression.expression);
    } else if (ts.isConditionalExpression(expression)) {
      trace(expression.whenTrue);
      trace(expression.whenFalse);
    } else if (ts.isObjectLiteralExpression(expression)) {
      readLiteral(expression, true);
    } else if (ts.isCallExpression(expression)) {
      const callee = expression.expression;
      let root: ts.Expression = callee;
      while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
        root = root.expression;
      }
      const declared = symbolOf(root)?.declarations?.some(inTemplates) ?? false;
      if (declared) {
        templates.push(ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText());
      } else {
        problem(expression, `${callee.getText()}(…) is not a template in mail/templates.ts`);
      }
    } else if (ts.isIdentifier(expression)) {
      if (expression.text === 'undefined') return;
      const declaration = symbolOf(expression)?.declarations?.[0];
      if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        ts.isVariableDeclarationList(declaration.parent) &&
        declaration.parent.flags & ts.NodeFlags.Const
      ) {
        trace(declaration.initializer);
      } else if (declaration && ts.isParameter(declaration)) {
        traceParameter(declaration, expression);
      } else {
        problem(expression, `${expression.text} is a value this cannot follow`);
      }
    } else {
      problem(expression, `${expression.getText()} is a value this cannot follow`);
    }
  }

  for (const file of files) {
    const transport = srcPath(file.fileName) in MAIL_TRANSPORTS;
    for (const { name, node } of importsOf(file)) {
      if (isMailPackage(name) && !transport) {
        problem(node, `imports ${name}: mail goes through Mailer.send`);
      }
    }
    const visit = (node: ts.Node): void => {
      // A transport sends what the callers of Mailer.send hand it, and they are traced.
      if (ts.isCallExpression(node) && !transport) {
        const signature = checker.getResolvedSignature(node);
        signature?.getParameters().forEach((parameter, index) => {
          const argument = node.arguments[index];
          if (argument && mailShaped(checker.getTypeOfSymbolAtLocation(parameter, node))) {
            trace(argument);
          }
        });
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        checker.getSymbolAtLocation(node.name)?.declarations?.includes(mailerSend) === true &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)
      ) {
        problem(node, 'Mailer.send is handed on; what it sends cannot be seen');
      }
      if (file !== templatesFile) {
        if (ts.isObjectLiteralExpression(node) && mailShaped(checker.getContextualType(node))) {
          readLiteral(node, false);
        }
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          ts.isPropertyAccessExpression(node.left) &&
          CONTENT_KEYS.has(node.left.name.text) &&
          mailShaped(checker.getTypeAtLocation(node.left.expression))
        ) {
          problem(node, `writes ${node.left.name.text} outside mail/templates.ts`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { templates, problems: [...problems].sort() };
}

/** The workspace's packages: the root and each of `apps/*` and `packages/*`. */
const ROOT = path.resolve(SRC, '../../..');
const PACKAGE_DIRS = [
  '.',
  ...['apps', 'packages'].flatMap((group) =>
    readdirSync(path.join(ROOT, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${group}/${entry.name}`),
  ),
];

describe('mail goes through the templates (#113)', () => {
  const code = readMailCode(programOf(sources()));

  it('every send carries a registered template, and nothing else says what a mail says', () => {
    expect(code.problems).toEqual([]);
  });

  it('finds the sends at all: each registered template reaches the mailer', () => {
    // A guard on the trace, as for the route discovery: a trace that finds nothing passes.
    const byFunction = new Map<string, string>(
      Object.entries(MAIL_TEMPLATES).map(([name, build]) => [build.name, name]),
    );
    expect(new Set(code.templates.map((name) => byFunction.get(name) ?? name))).toEqual(
      new Set(Object.keys(MAIL_TEMPLATES)),
    );
  });

  it('keeps the content keys to what a MailMessage says beside its address', () => {
    const mailer = ts.createSourceFile(
      MAILER_FILE,
      readFileSync(MAILER_FILE, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const message = mailer.statements
      .filter(ts.isInterfaceDeclaration)
      .find((declaration) => declaration.name.text === 'MailMessage')!;
    const keys = message.members.map((member) => member.name!.getText()).sort();
    expect(keys).toEqual(['to', ...CONTENT_KEYS].sort());
  });

  it('keeps every transport registered with a reason, and mail packages in the API only', () => {
    for (const [file, reason] of Object.entries(MAIL_TRANSPORTS)) {
      const full = path.join(SRC, file);
      expect(sources(), file).toContain(full);
      expect(reason.trim(), file).not.toBe('');
      // An allowance nobody needs any more fails: the transport still imports a mail package.
      const source = ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest);
      expect(
        importsOf(source).some(({ name }) => isMailPackage(name)),
        file,
      ).toBe(true);
    }
    const mailPackages = PACKAGE_DIRS.flatMap((dir) => {
      const manifest = JSON.parse(readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8')) as {
        [field: string]: unknown;
      };
      return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
        .flatMap((field) => Object.keys((manifest[field] as object | undefined) ?? {}))
        .filter((name) => MAIL_PACKAGE.test(name))
        .map((name) => `${dir}: ${name}`);
    });
    expect(mailPackages.length).toBeGreaterThan(0);
    expect(mailPackages.filter((entry) => !entry.startsWith('apps/api: '))).toEqual([]);
  });

  it('knows mail said outside the templates when it reads it', () => {
    const file = path.join(SRC, 'markets', '__planted__.ts');
    const planted = [
      "import { createTransport } from 'nodemailer';",
      "import { type Mailer } from '../mail/mailer.js';",
      "import { type EmailContent, MAIL_TEMPLATES } from '../mail/templates.js';",
      'function digest(): EmailContent {',
      "  return { subject: '이번 주 순위', text: '1위', html: '<p>1위</p>' };",
      '}',
      'export class Planted {',
      '  constructor(private readonly mailer: Mailer) {}',
      '  async inline(to: string) {',
      "    await this.mailer.send({ to, subject: '이번 주 베팅', text: '배당' });",
      '  }',
      '  async fromConstant(to: string) {',
      "    const content: EmailContent = { subject: 's', text: 't', html: 'h' };",
      '    await this.mailer.send({ to, ...content });',
      '  }',
      '  async fromHelper(to: string) {',
      '    await this.mailer.send({ to, ...digest() });',
      '  }',
      '  async wrapped(to: string, late: boolean) {',
      "    await this.deliver(to, late ? MAIL_TEMPLATES.verification({ url: 'u' }) : { subject: 'a', text: 'b', html: 'c' });",
      "    await this.deliver(to, MAIL_TEMPLATES.passwordReset({ url: 'u' }));",
      '  }',
      '  private async deliver(to: string, content: EmailContent) {',
      '    await this.mailer.send({ to, ...content });',
      '  }',
      '  async overwritten(to: string) {',
      "    const content = MAIL_TEMPLATES.verification({ url: 'u' });",
      "    content.subject = '순위';",
      '    await this.mailer.send({ to, ...content });',
      '  }',
      '  handedOn() {',
      '    const { send } = this.mailer;',
      "    void send({ to: 'x', ...digest() });",
      '    return this.mailer.send;',
      '  }',
      '  smtp() {',
      "    return createTransport({ host: 'h' });",
      '  }',
      '}',
      // A mailer of its own type, and content from a function that declares no type.
      'class HttpMailer {',
      '  async send(message: { to: string; subject: string; text: string }) {',
      "    await fetch('https://mail.example', { method: 'POST', body: JSON.stringify(message) });",
      '  }',
      '}',
      'function untyped() {',
      "  return { subject: '순위', text: '1위' };",
      '}',
      'export const viaHttp = (to: string) => new HttpMailer().send({ to, ...untyped() });',
      // Through a parameter that takes no mail: to every call of its function.
      'function relay(mailer: Mailer, to: string, content: object) {',
      '  return mailer.send({ to, ...(content as EmailContent) });',
      '}',
      "export const relayed = (mailer: Mailer) => relay(mailer, 'x', { subject: '순위', text: '', html: '' });",
      'export const handed = [relay];',
      // A hook a library calls, with what the library hands it.
      'export const hooks = (mailer: Mailer) => ({',
      '  sendMagicLink: async (message: { to: string; subject: string; text: string }) => {',
      '    await mailer.send(message);',
      '  },',
      '});',
    ].join('\n');
    const code = readMailCode(programOf([], { [file]: planted }));
    expect(code.problems).toEqual(
      [
        'markets/__planted__.ts:1: imports nodemailer: mail goes through Mailer.send',
        // The literal returned as an EmailContent is said outside the templates, sent or not.
        'markets/__planted__.ts:13: writes html outside mail/templates.ts',
        'markets/__planted__.ts:13: writes subject outside mail/templates.ts',
        'markets/__planted__.ts:13: writes text outside mail/templates.ts',
        'markets/__planted__.ts:17: digest(…) is not a template in mail/templates.ts',
        // The ternary's literal, handed to a function that takes a mail.
        'markets/__planted__.ts:20: writes html outside mail/templates.ts',
        'markets/__planted__.ts:20: writes subject outside mail/templates.ts',
        'markets/__planted__.ts:20: writes text outside mail/templates.ts',
        'markets/__planted__.ts:28: writes subject outside mail/templates.ts',
        // A destructured `send` is a send too.
        'markets/__planted__.ts:33: digest(…) is not a template in mail/templates.ts',
        'markets/__planted__.ts:34: Mailer.send is handed on; what it sends cannot be seen',
        'markets/__planted__.ts:48: untyped(…) is not a template in mail/templates.ts',
        'markets/__planted__.ts:52: writes html outside mail/templates.ts',
        'markets/__planted__.ts:52: writes subject outside mail/templates.ts',
        'markets/__planted__.ts:52: writes text outside mail/templates.ts',
        'markets/__planted__.ts:53: relay is handed on; what it is called with cannot be seen',
        'markets/__planted__.ts:56: message comes from sendMagicLink, called from outside the API',
        'markets/__planted__.ts:5: writes html outside mail/templates.ts',
        'markets/__planted__.ts:5: writes subject outside mail/templates.ts',
        'markets/__planted__.ts:5: writes text outside mail/templates.ts',
        'markets/__planted__.ts:10: writes subject outside mail/templates.ts',
        'markets/__planted__.ts:10: writes text outside mail/templates.ts',
      ].sort(),
    );
    expect(code.templates.sort()).toEqual(['passwordReset', 'verification', 'verification']);
  });
});
