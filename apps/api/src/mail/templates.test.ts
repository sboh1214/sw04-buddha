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
  devVerificationCodeEmail,
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

  it('development SMS mail carries the code in subject, text and html (ADR-0070)', () => {
    const mail = devVerificationCodeEmail({ code: '012345', expiresInMinutes: 3 });
    expect(mail.subject).toContain('012345');
    expect(mail.text).toContain('본인확인 인증번호는 012345입니다. 3분 안에');
    expect(mail.html).toContain('lang="ko"');
    expect(mail.html).toContain('012345');
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
  devVerificationCode: [{ code: '012345', expiresInMinutes: 3 }],
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

/** The text of a string or template literal, an interpolation read as the digit 0. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return ts.isTemplateExpression(node)
    ? node.head.text + node.templateSpans.map((s) => VALUE + s.literal.text).join('')
    : undefined;
}

/** Every string and template literal in `text`, an interpolation read as the digit 0. */
function literalsOf(fileName: string, text: string): { line: number; text: string }[] {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: { line: number; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    const value = literalText(node);
    if (value !== undefined) {
      found.push({
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        text: value,
      });
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

/** The keys of a `MailMessage`: its address and what it says. A send carries these and no other. */
const MESSAGE_KEYS = new Set(['to', ...CONTENT_KEYS]);

/**
 * What a template may take, with what it is. A template's words are written in templates.ts, where
 * every string is read; what it takes is a value the mail carries (a link, an address, a number),
 * never words its caller picks (a title, a body), which would say what the mail says from outside
 * that file. A new input is a new line here, saying why it is no words of a mail.
 */
const MAIL_INPUTS: Readonly<Record<string, { type: 'string' | 'number'; what: string }>> = {
  url: {
    type: 'string',
    what: 'the link better-auth makes and hands the mail hook (verification, reset, change of address)',
  },
  newEmail: {
    type: 'string',
    what: 'the address an account asked to change to, as better-auth hands it to the mail hook',
  },
  expiresInMinutes: { type: 'number', what: 'how long the link (or the code) is valid' },
  code: {
    type: 'string',
    what:
      'the six digits of a phone verification code, which the development SMS sender mails to ' +
      'Mailpit instead of texting (ADR-0070): digits the server drew, no words',
  },
};

/**
 * A module that talks to a mail service: SMTP, a provider's SDK, a mail renderer. Only the
 * transports below may import one, so every mail goes through `Mailer.send`.
 */
const MAIL_PACKAGE = /mail|smtp|^@aws-sdk\/client-ses|^(?:resend|postmark)$/i;

/** Whether an imported module is a mail package (a relative path is one of ours, not a package). */
const isMailPackage = (name: string) => !name.startsWith('.') && MAIL_PACKAGE.test(name);

/**
 * The files that may import a mail package, with why. Each is a transport: it sends what the
 * callers of `Mailer.send` hand it, which the trace below follows back to a template, and the
 * check below holds it to that: it hands the mail package each key of the `MailMessage` its
 * `send` was handed, by name (`subject: message.subject`), beside the sender (`from`) and settings
 * that are no part of a message (`host`), and writes no words of its own nor imports any.
 */
const MAIL_TRANSPORTS: Readonly<Record<string, string>> = {
  'mail/mailer.ts':
    'createMailer: the SMTP transport (nodemailer) behind Mailer.send. It sends the MailMessage ' +
    'its caller passed, key by key, with the From header from the environment, and adds no text ' +
    'of its own.',
};

/** The sender a transport adds to each message (`SMTP_FROM`): an address, not what a mail says. */
const SENDER_KEY = 'from';

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

/** Whether an import or export brings in types only: `import type`, `import { type X }`. */
function typesOnly(node: ts.Node): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause === undefined) return false;
    if (clause.isTypeOnly) return true;
    const bindings = clause.namedBindings;
    return (
      clause.name === undefined &&
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly)
    );
  }
  if (ts.isExportDeclaration(node)) {
    const clause = node.exportClause;
    return (
      node.isTypeOnly ||
      (clause !== undefined &&
        ts.isNamedExports(clause) &&
        clause.elements.length > 0 &&
        clause.elements.every((element) => element.isTypeOnly))
    );
  }
  return false;
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

/** Whether an operator assigns: `=`, `+=`, `??=` and the rest. */
const assigns = (kind: ts.SyntaxKind) =>
  kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

/** An expression whose value is the one inside it: `(x)`, `await x`, `x as T`, `x!`. */
function unwrapped(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) ||
    ts.isAwaitExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
    ? unwrapped(expression.expression)
    : expression;
}

/**
 * Whether an expression is written to: `x = …`, `x += …`, `x++`, the target of a destructuring
 * assignment (`[x] = …`, `({ a: x } = …)`) or of a `for … of`.
 */
function isWritten(node: ts.Expression): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  /** Whether `node` is inside a destructuring pattern, which only a plain `=` writes through. */
  let destructured = false;
  while (
    ts.isParenthesizedExpression(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isObjectLiteralExpression(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isSpreadAssignment(parent) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === child)
  ) {
    destructured ||= ts.isArrayLiteralExpression(parent) || ts.isObjectLiteralExpression(parent);
    child = parent;
    parent = parent.parent;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === child &&
    assigns(parent.operatorToken.kind)
  ) {
    return !destructured || parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  }
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return !destructured;
  }
  return (
    (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === child
  );
}

/** The built-ins that write onto their first argument, by where the library declares them. */
const OBJECT_WRITERS = new Set([
  'ObjectConstructor.assign',
  'ObjectConstructor.defineProperty',
  'ObjectConstructor.defineProperties',
  'Reflect.set',
  'Reflect.defineProperty',
]);

/** What the mail code of a program does, as the checks below read it. */
interface MailCode {
  /** Each template a send reaches, by the name its call uses (`passwordReset`). */
  templates: string[];
  /** Each input a registered template takes, by name (`url`). */
  inputs: string[];
  /** Each place where mail is said or sent in a way that is not a registered template. */
  problems: string[];
}

/**
 * Reads every send in the API's sources and follows what it sends back to where it was written.
 *
 * - The templates: `MAIL_TEMPLATES` names functions declared in mail/templates.ts, each taking at
 *   most one input, an object of `MAIL_INPUTS` (a link, an address, a number; no words). The file
 *   imports nothing but types, so every word a template can say is a string of that file.
 * - A send is an argument handed to a mail-shaped parameter (one whose type has a `subject` and a
 *   `text` or `html`), by the call's resolved signature: `Mailer.send(message)` (mail/mailer.ts)
 *   and anything else that takes a mail, a destructured or renamed `send` and a mailer of another
 *   type included. `Mailer.send` read as a value (handed on, bound) is a problem: what it is
 *   called with cannot be seen.
 * - What a send carries is followed through spreads, `const`s, conditionals, `await` and casts,
 *   and through a function's parameter to every call of that function, under whatever name it is
 *   called (an import's alias, a namespace's member: references are found by symbol). It must end
 *   in a call of a template (a callee declared in mail/templates.ts: `MAIL_TEMPLATES.x`,
 *   `MAIL_TEMPLATES[k]`). A content key (`subject`·`text`·`html`) written on the way, a key a
 *   `MailMessage` does not have (`attachments`, `amp`), a call of anything else and an expression
 *   this cannot follow are problems: a property read, a `let`, the parameter of a function with
 *   no name or of one only a library calls (a better-auth mail hook's own input).
 * - What a template is handed, outside mail/templates.ts: every string it is built from, through
 *   the `const`s, assignments and parameters it reads, is held to the mail's words.
 * - A transport's sends are not traced: they send what the callers of `Mailer.send` handed it.
 *   What a transport hands the mail package as a message (an argument the package types as one)
 *   is each `MailMessage` key under its own name, read off what its `Mailer.send` was handed
 *   (`subject: message.subject`, never off a copy), the sender and settings no message has. What
 *   it was handed is read for nothing else, every string the transport writes is held to the
 *   mail's words, and it imports nothing but mail packages and types.
 * - Apart from the sends, outside templates.ts: an object literal that writes a content key of a
 *   mail-shaped value or of a spread of a template's result (its spreads followed as a send's), a
 *   write of a content key onto what a template built (`m.subject =`, `m['text'] +=`,
 *   `Object.assign(m, …)`), under any name or type it is held by, is a problem, whether or not
 *   it is ever sent.
 * - A template's result, and each `const` and parameter a send's trace went through, goes only to
 *   a send (`Mailer.send`, a parameter the trace went through, a `const` it went through) or is
 *   read for a key. Anything else (an array, `Object(m)`, a generic, `arguments`) is a problem:
 *   it could be changed under a name the trace never sees.
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
  const mailerInterface = (name: string) =>
    mailerFile?.statements
      .filter(ts.isInterfaceDeclaration)
      .find((declaration) => declaration.name.text === name);
  const mailMessage = mailerInterface('MailMessage');
  const mailerSend = mailerInterface('Mailer')?.members.find(
    (member): member is ts.MethodSignature =>
      ts.isMethodSignature(member) && propertyName(member.name) === 'send',
  );
  if (templatesFile === undefined || mailerSend === undefined || mailMessage === undefined) {
    throw new Error('mail/templates.ts or the Mailer interfaces in mail/mailer.ts are missing');
  }

  const templates: string[] = [];
  const inputs: string[] = [];
  const problems = new Set<string>();
  /** What has been followed already: each expression once, whichever send reaches it first. */
  const seen = new Set<ts.Node>();
  /** What has been read for words already, the same way. */
  const read = new Set<ts.Node>();
  /** The object literals a transport hands the mail package, held to their own rule. */
  const transportLiterals = new Set<ts.Node>();
  /** The `const`s and parameters a send's trace went through: each holds a mail. */
  const holders = new Set<ts.Symbol>();
  /** Each call of a template outside templates.ts, which a send's trace must reach. */
  const templateCalls: ts.CallExpression[] = [];
  /** The `MailMessage` each `Mailer.send` a transport implements is handed (`message`). */
  const sendParameters = new Set<ts.Symbol>();
  /** The reads of those a transport hands the mail package: `message` in `message.subject`. */
  const picks = new Set<ts.Node>();
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

  /** Whether an expression is a `MailMessage` (mail/mailer.ts), as a transport is handed one. */
  const isMailMessage = (node: ts.Node) =>
    checker.getTypeAtLocation(node).getSymbol()?.declarations?.includes(mailMessage) === true;

  /** The symbol an expression names: a variable, a parameter, a property, a shorthand's value. */
  function namedSymbol(node: ts.Expression): ts.Symbol | undefined {
    if (ts.isIdentifier(node)) {
      return ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
        ? resolved(checker.getShorthandAssignmentValueSymbol(node.parent))
        : symbolOf(node);
    }
    return ts.isPropertyAccessExpression(node) ? symbolOf(node.name) : undefined;
  }

  let references: Map<ts.Symbol, ts.Identifier[]> | undefined;
  /**
   * Every place a symbol is named, by symbol and not by spelling: under an import's alias
   * (`import { relay as forward }`), as a namespace's member and as a shorthand property's value.
   */
  function referencesOf(symbol: ts.Symbol): ts.Identifier[] {
    if (references === undefined) {
      const index = new Map<ts.Symbol, ts.Identifier[]>();
      const add = (key: ts.Symbol | undefined, node: ts.Identifier) => {
        if (key === undefined) return;
        const named = index.get(key);
        if (named === undefined) index.set(key, [node]);
        else named.push(node);
      };
      for (const file of files) {
        const visit = (node: ts.Node): void => {
          if (ts.isIdentifier(node)) {
            const own = symbolOf(node);
            add(own, node);
            const value = namedSymbol(node);
            if (value !== own) add(value, node);
          }
          ts.forEachChild(node, visit);
        };
        visit(file);
      }
      references = index;
    }
    return references.get(symbol) ?? [];
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

  /** Every place a variable or parameter is used: not its declaration, an import or an export. */
  function usesOf(symbol: ts.Symbol): ts.Identifier[] {
    return referencesOf(symbol).filter(
      ({ parent }) =>
        !(
          ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) &&
            symbol.declarations?.includes(parent) === true) ||
          ts.isImportSpecifier(parent) ||
          ts.isExportSpecifier(parent) ||
          ts.isImportClause(parent) ||
          ts.isImportEqualsDeclaration(parent)
        ),
    );
  }

  /**
   * Each `arguments` a function reads (an arrow function's included, as it reads its parent's):
   * another way to what a parameter holds.
   */
  function argumentsOf(fn: ts.Node): ts.Identifier[] {
    const found: ts.Identifier[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === 'arguments') found.push(node);
      if (node === fn || !ts.isFunctionLike(node) || ts.isArrowFunction(node)) {
        ts.forEachChild(node, visit);
      }
    };
    visit(fn);
    return found;
  }

  /** Every place a function is named but where it is declared, imported or re-exported. */
  function callersOf(name: ts.Node): ts.Identifier[] {
    const symbol = symbolOf(name);
    if (symbol === undefined) return [];
    return referencesOf(symbol).filter(
      (reference) =>
        reference !== name &&
        !ts.isImportSpecifier(reference.parent) &&
        !ts.isExportSpecifier(reference.parent) &&
        !ts.isImportClause(reference.parent) &&
        !ts.isImportEqualsDeclaration(reference.parent) &&
        !ts.isExportAssignment(reference.parent),
    );
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

  /**
   * What a symbol may hold: its declaration's initializer, every value assigned to it and, for a
   * parameter, the argument at its place in every call of its function. Nothing for what this
   * cannot see (a library's callback, a destructured binding).
   */
  function originsOf(symbol: ts.Symbol): ts.Expression[] {
    const found: ts.Expression[] = [];
    for (const declaration of symbol.declarations ?? []) {
      if (
        (ts.isVariableDeclaration(declaration) ||
          ts.isPropertyDeclaration(declaration) ||
          ts.isPropertyAssignment(declaration) ||
          ts.isParameter(declaration) ||
          ts.isBindingElement(declaration)) &&
        declaration.initializer
      ) {
        found.push(declaration.initializer);
      }
      if (ts.isShorthandPropertyAssignment(declaration)) found.push(declaration.name);
      const name = ts.isParameter(declaration) ? nameOfFunction(declaration.parent) : undefined;
      if (ts.isParameter(declaration) && !declaration.dotDotDotToken && name !== undefined) {
        const index = declaration.parent.parameters.indexOf(declaration);
        for (const caller of callersOf(name)) {
          const argument = callOf(caller)?.arguments[index];
          if (argument) found.push(argument);
        }
      }
    }
    for (const reference of referencesOf(symbol)) {
      const target =
        ts.isPropertyAccessExpression(reference.parent) && reference.parent.name === reference
          ? reference.parent
          : reference;
      const { parent } = target;
      if (
        ts.isBinaryExpression(parent) &&
        parent.left === target &&
        assigns(parent.operatorToken.kind)
      ) {
        found.push(parent.right);
      }
    }
    return found;
  }

  /** Whether a call is of a template: a callee declared in templates.ts (`MAIL_TEMPLATES.x`). */
  function isTemplateCall(call: ts.CallExpression): boolean {
    let root: ts.Expression = call.expression;
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
      root = root.expression;
    }
    return symbolOf(root)?.declarations?.some(inTemplates) ?? false;
  }

  /**
   * Whether a value may be what a template built, under whatever name or type it is held: a
   * mail-shaped value, or one whose origins (`originsOf`) reach a template's call.
   */
  function fromTemplate(expression: ts.Expression, followed = new Set<ts.Node>()): boolean {
    if (followed.has(expression)) return false;
    followed.add(expression);
    if (mailShaped(checker.getTypeAtLocation(expression))) return true;
    const value = unwrapped(expression);
    if (value !== expression) return fromTemplate(value, followed);
    if (ts.isConditionalExpression(value)) {
      return fromTemplate(value.whenTrue, followed) || fromTemplate(value.whenFalse, followed);
    }
    if (ts.isBinaryExpression(value)) {
      const kind = value.operatorToken.kind;
      if (kind === ts.SyntaxKind.CommaToken) return fromTemplate(value.right, followed);
      if (
        kind === ts.SyntaxKind.QuestionQuestionToken ||
        kind === ts.SyntaxKind.BarBarToken ||
        kind === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return fromTemplate(value.left, followed) || fromTemplate(value.right, followed);
      }
    }
    if (ts.isCallExpression(value)) return isTemplateCall(value);
    const symbol = namedSymbol(value);
    return (
      symbol !== undefined && originsOf(symbol).some((origin) => fromTemplate(origin, followed))
    );
  }

  /** The keys an element access may name, or undefined when its key says none this can read. */
  function keysOf(argument: ts.Expression): string[] | undefined {
    if (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument)) return [argument.text];
    const type = checker.getTypeAtLocation(argument);
    const members = type.isUnion() ? type.types : [type];
    return members.every((member) => member.isStringLiteral())
      ? members.map((member) => member.value)
      : undefined;
  }

  /** Whether a call is a built-in that writes onto its first argument (`Object.assign`). */
  function writesOnto(call: ts.CallExpression): boolean {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    if (
      declaration === undefined ||
      ts.isJSDocSignature(declaration) ||
      declaration.name === undefined ||
      !program.isSourceFileDefaultLibrary(declaration.getSourceFile())
    ) {
      return false;
    }
    const owner = declaration.parent;
    const ownerName = ts.isInterfaceDeclaration(owner)
      ? owner.name.text
      : ts.isModuleBlock(owner)
        ? owner.parent.name.getText()
        : undefined;
    return OBJECT_WRITERS.has(`${String(ownerName)}.${declaration.name.getText()}`);
  }

  /**
   * What a template is handed, read for the words a mail must not say: every string it is built
   * from, through the `const`s, assignments and parameters it reads.
   */
  function readInput(node: ts.Node): void {
    if (read.has(node)) return;
    read.add(node);
    const text = literalText(node);
    for (const hit of text === undefined ? [] : findExcludedText(text)) {
      problem(node, `${hit.match} (${hit.feature}) in what a template is handed`);
    }
    if (ts.isIdentifier(node)) {
      const symbol = namedSymbol(node);
      for (const origin of symbol === undefined ? [] : originsOf(symbol)) readInput(origin);
    }
    ts.forEachChild(node, readInput);
  }

  /** The template a `MAIL_TEMPLATES` entry names: a function, wherever it is declared. */
  function templateOf(entry: ts.ObjectLiteralElementLike): ts.SignatureDeclaration | undefined {
    if (ts.isMethodDeclaration(entry)) return entry;
    const value = ts.isPropertyAssignment(entry) ? unwrapped(entry.initializer) : undefined;
    if (value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) return value;
    const symbol = ts.isShorthandPropertyAssignment(entry)
      ? resolved(checker.getShorthandAssignmentValueSymbol(entry))
      : value && ts.isIdentifier(value)
        ? symbolOf(value)
        : undefined;
    for (const declaration of symbol?.declarations ?? []) {
      if (ts.isFunctionDeclaration(declaration)) return declaration;
      const initializer =
        ts.isVariableDeclaration(declaration) && declaration.initializer
          ? unwrapped(declaration.initializer)
          : undefined;
      if (
        initializer &&
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
      ) {
        return initializer;
      }
    }
    return undefined;
  }

  /** What a registered template takes: at most one input, an object of `MAIL_INPUTS`. */
  function readInputs(name: string, template: ts.SignatureDeclaration) {
    const [parameter, ...rest] = template.parameters;
    for (const extra of rest) problem(extra, `${name} takes more than one input`);
    if (parameter === undefined) return;
    const type = checker.getNonNullableType(checker.getTypeAtLocation(parameter));
    if (
      parameter.dotDotDotToken ||
      !(type.flags & ts.TypeFlags.Object) ||
      checker.getIndexInfosOfType(type).length > 0
    ) {
      problem(
        parameter,
        `${name} takes ${checker.typeToString(type)}, not an object of mail inputs`,
      );
      return;
    }
    for (const input of checker.getPropertiesOfType(type)) {
      inputs.push(input.name);
      const place = input.declarations?.[0] ?? parameter;
      const allowed = MAIL_INPUTS[input.name];
      const kind = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(input, parameter));
      const flag = allowed?.type === 'number' ? ts.TypeFlags.NumberLike : ts.TypeFlags.StringLike;
      if (allowed === undefined) {
        problem(place, `${name} takes ${input.name}, which is not a mail input (MAIL_INPUTS)`);
      } else if (!(kind.flags & flag)) {
        problem(
          place,
          `${name} takes ${input.name} as ${checker.typeToString(kind)}, not a ${allowed.type}`,
        );
      }
    }
  }

  /** `MAIL_TEMPLATES`: functions templates.ts declares, which imports nothing but types. */
  function readRegistry(file: ts.SourceFile) {
    for (const { name, node } of importsOf(file)) {
      if (!typesOnly(node)) {
        problem(node, `imports ${name}: what a mail says is written in mail/templates.ts`);
      }
    }
    const declaration = file.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find(
        (variable) => ts.isIdentifier(variable.name) && variable.name.text === 'MAIL_TEMPLATES',
      );
    const registry = declaration?.initializer && unwrapped(declaration.initializer);
    if (registry === undefined || !ts.isObjectLiteralExpression(registry)) {
      problem(declaration ?? file, 'MAIL_TEMPLATES is not an object literal this can read');
      return;
    }
    for (const entry of registry.properties) {
      const name = entry.name && propertyName(entry.name);
      const template = templateOf(entry);
      if (name === undefined || template === undefined || !inTemplates(template)) {
        const label = name === undefined ? entry.getText() : `MAIL_TEMPLATES.${name}`;
        problem(entry, `${label} is not a function declared in mail/templates.ts`);
      } else {
        readInputs(name, template);
      }
    }
  }

  /** The keys a mail package reads as a message where it takes `type`: those beside `subject`. */
  function messageKeysOf(type: ts.Type): Set<string> {
    const keys = new Set<string>();
    for (const member of type.isUnion() ? type.types : [type]) {
      for (const declaration of member.getProperty('subject')?.declarations ?? []) {
        const holder = declaration.parent;
        if (!ts.isInterfaceDeclaration(holder) && !ts.isTypeLiteralNode(holder)) continue;
        for (const key of holder.members) {
          const name = key.name && propertyName(key.name);
          if (name !== undefined) keys.add(name);
        }
      }
    }
    return keys;
  }

  /** Whether a function is the `send` of an object literal that is a `Mailer` (mail/mailer.ts). */
  function implementsSend(fn: ts.SignatureDeclaration): boolean {
    const holder = ts.isMethodDeclaration(fn)
      ? fn
      : (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
          ts.isPropertyAssignment(fn.parent)
        ? fn.parent
        : undefined;
    if (holder === undefined || !ts.isObjectLiteralExpression(holder.parent)) return false;
    return (
      propertyName(holder.name) === 'send' &&
      checker
        .getContextualType(holder.parent)
        ?.getProperty('send')
        ?.declarations?.some((declaration) => declaration === mailerSend) === true
    );
  }

  /** Whether an expression names what a transport's `Mailer.send` was handed, as it was handed. */
  const isSendParameter = (node: ts.Expression) => {
    const symbol = ts.isIdentifier(node) ? symbolOf(node) : undefined;
    return symbol !== undefined && sendParameters.has(symbol);
  };

  /**
   * What a transport hands the mail package as a message: each `MailMessage` key under its own
   * name, read off what its `Mailer.send` was handed (`subject: message.subject`), the sender, and
   * settings that are no key of a message (`host`), through `const`s, conditionals and spreads.
   * Never a spread of the `MailMessage` (whatever else its object carries would go too), a key
   * read off a copy (`m.subject` of `{ ...message, ...extra }`), words of its own or another
   * message key.
   */
  function readTransportMessage(expression: ts.Expression, keys: ReadonlySet<string>): void {
    const value = unwrapped(expression);
    if (ts.isConditionalExpression(value)) {
      readTransportMessage(value.whenTrue, keys);
      readTransportMessage(value.whenFalse, keys);
      return;
    }
    const declaration = ts.isIdentifier(value)
      ? symbolOf(value)?.declarations?.find(ts.isVariableDeclaration)
      : undefined;
    if (
      declaration?.initializer &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const
    ) {
      readTransportMessage(declaration.initializer, keys);
      return;
    }
    if (!ts.isObjectLiteralExpression(value)) {
      problem(value, `${value.getText()} is a value this cannot follow`);
      return;
    }
    transportLiterals.add(value);
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) {
        if (isMailMessage(property.expression)) {
          problem(
            property,
            `spreads ${property.expression.getText()}: a transport hands on each MailMessage key by name`,
          );
        } else {
          readTransportMessage(property.expression, keys);
        }
        continue;
      }
      const name = propertyName(property.name);
      const initializer = ts.isPropertyAssignment(property) ? property.initializer : undefined;
      if (name === undefined) {
        problem(property, 'a computed key this cannot read');
      } else if (MESSAGE_KEYS.has(name)) {
        const picked =
          initializer !== undefined &&
          ts.isPropertyAccessExpression(initializer) &&
          initializer.name.text === name &&
          isSendParameter(initializer.expression);
        if (picked) picks.add(initializer.expression);
        else problem(property, `sends ${name} other than as the MailMessage's ${name}`);
      } else if (name !== SENDER_KEY && keys.has(name)) {
        problem(property, `sends ${name}, which a MailMessage does not say`);
      }
    }
  }

  /**
   * A transport: every string it writes, what it hands the mail package as a message, and that it
   * imports nothing but mail packages and types (a footer from another file is words of its own).
   */
  function readTransport(file: ts.SourceFile) {
    for (const { name, node } of importsOf(file)) {
      if (!isMailPackage(name) && !typesOnly(node)) {
        problem(node, `imports ${name}: a transport writes nothing of its own`);
      }
    }
    const implementations = (node: ts.Node): void => {
      const parameter = ts.isFunctionLike(node) && implementsSend(node) && node.parameters[0];
      const symbol = parameter ? symbolOf(parameter.name) : undefined;
      if (symbol) sendParameters.add(symbol);
      ts.forEachChild(node, implementations);
    };
    implementations(file);
    for (const { line, text } of literalsOf(file.fileName, file.text)) {
      for (const hit of findExcludedText(text)) {
        problems.add(
          `${srcPath(file.fileName)}:${String(line)}: ${hit.match} (${hit.feature}) in a transport`,
        );
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        signature?.getParameters().forEach((parameter, index) => {
          const argument = node.arguments[index];
          const type = checker.getTypeOfSymbolAtLocation(parameter, node);
          if (argument && mailShaped(type)) readTransportMessage(argument, messageKeysOf(type));
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  /**
   * The content keys an object literal writes, and the spreads it takes the rest from: each
   * followed as a send's is, sent or not (`{ ...message, ...extra }` takes `extra`'s `text`), but
   * what a transport's `Mailer.send` was handed, which is held to its own rule.
   */
  function readLiteral(literal: ts.ObjectLiteralExpression, follow: boolean) {
    for (const property of literal.properties) {
      if (ts.isSpreadAssignment(property)) {
        if (follow || !isSendParameter(property.expression)) trace(property.expression);
        continue;
      }
      const name = propertyName(property.name);
      if (name === undefined) problem(property, 'a computed key this cannot read');
      else if (CONTENT_KEYS.has(name)) {
        problem(property, `writes ${name} outside mail/templates.ts`);
      } else if (follow && !MESSAGE_KEYS.has(name)) {
        problem(property, `carries ${name}, which a MailMessage does not say`);
      }
    }
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
    const callers = callersOf(name);
    // A hook a library calls (better-auth's mail hooks, a plugin's): what it hands in is unseen.
    if (callers.length === 0) {
      problem(at, `${at.getText()} comes from ${name.getText()}, called from outside the API`);
    }
    for (const reference of callers) {
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
    const value = unwrapped(expression);
    if (value !== expression) {
      trace(value);
    } else if (ts.isConditionalExpression(expression)) {
      trace(expression.whenTrue);
      trace(expression.whenFalse);
    } else if (ts.isObjectLiteralExpression(expression)) {
      readLiteral(expression, true);
    } else if (ts.isCallExpression(expression)) {
      const callee = expression.expression;
      if (isTemplateCall(expression)) {
        templates.push(ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText());
      } else {
        problem(expression, `${callee.getText()}(…) is not a template in mail/templates.ts`);
      }
    } else if (ts.isIdentifier(expression)) {
      if (expression.text === 'undefined') return;
      const symbol = namedSymbol(expression);
      const declaration = symbol?.declarations?.[0];
      if (
        symbol &&
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        ts.isVariableDeclarationList(declaration.parent) &&
        declaration.parent.flags & ts.NodeFlags.Const
      ) {
        holders.add(symbol);
        trace(declaration.initializer);
      } else if (symbol && declaration && ts.isParameter(declaration)) {
        holders.add(symbol);
        traceParameter(declaration, expression);
      } else {
        problem(expression, `${expression.text} is a value this cannot follow`);
      }
    } else {
      problem(expression, `${expression.getText()} is a value this cannot follow`);
    }
  }

  /**
   * Whether a mail goes on to be sent from where it stands: up through casts, `await`, the
   * branches of a conditional and the object literals it is spread into, to the argument of
   * `Mailer.send` or of a parameter a send's trace went through, or to the initializer of a
   * `const` it went through. A mail-shaped parameter no send's trace went through (a generic
   * `<T>(x: T)`, `Object.assign`'s target, an array's `push`) is not a send.
   */
  function sentOn(node: ts.Expression): boolean {
    let child: ts.Node = node;
    let { parent } = node;
    while (
      ts.isParenthesizedExpression(parent) ||
      ts.isAwaitExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      (ts.isConditionalExpression(parent) && parent.condition !== child) ||
      ts.isSpreadAssignment(parent) ||
      (ts.isObjectLiteralExpression(parent) && ts.isSpreadAssignment(child))
    ) {
      child = parent;
      parent = parent.parent;
    }
    const held = (name: ts.Node) => {
      const symbol = symbolOf(name);
      return symbol !== undefined && holders.has(symbol);
    };
    if (ts.isVariableDeclaration(parent)) return parent.initializer === child && held(parent.name);
    if (!ts.isCallExpression(parent)) return false;
    const index = parent.arguments.findIndex((argument) => argument === child);
    const declaration = checker.getResolvedSignature(parent)?.declaration;
    if (index === -1 || declaration === undefined || ts.isJSDocSignature(declaration)) {
      return false;
    }
    if (declaration === mailerSend) return index === 0;
    const parameter = declaration.parameters[index];
    return parameter !== undefined && !parameter.dotDotDotToken && held(parameter.name);
  }

  /**
   * Where a mail goes besides a send. A template's result, and every `const` and parameter a
   * send's trace went through, is only sent (`sentOn`) or read for a key (`content.subject`; a
   * write of one is a problem above). Anything else (an array or a Map, `Object(content)`, a call
   * no send's trace went through, `arguments`) is a way to change it under no name the trace
   * knows. What a transport's `Mailer.send` was handed is only read key by key into what it hands
   * the mail package.
   */
  function readEscapes() {
    for (const call of templateCalls) {
      if (!sentOn(call)) {
        problem(call, `${call.expression.getText()}(…) is used other than to send what it builds`);
      }
    }
    const readsKey = (use: ts.Identifier) => {
      const { parent } = use;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === use) {
        return MESSAGE_KEYS.has(parent.name.text);
      }
      return (
        ts.isElementAccessExpression(parent) &&
        parent.expression === use &&
        keysOf(parent.argumentExpression)?.every((key) => MESSAGE_KEYS.has(key)) === true
      );
    };
    for (const symbol of holders) {
      for (const use of usesOf(symbol)) {
        if (!sentOn(use) && !readsKey(use)) {
          problem(use, `${use.text} holds a mail and is used other than to send it`);
        }
      }
    }
    for (const symbol of sendParameters) {
      for (const use of usesOf(symbol)) {
        if (!picks.has(use)) problem(use, `${use.text} is used other than handed on key by key`);
      }
    }
    for (const symbol of [...holders, ...sendParameters]) {
      const parameter = symbol.declarations?.find(ts.isParameter);
      for (const use of parameter ? argumentsOf(parameter.parent) : []) {
        problem(use, `arguments reaches ${symbol.name}, which holds a mail`);
      }
    }
  }

  readRegistry(templatesFile);
  for (const file of files) {
    if (srcPath(file.fileName) in MAIL_TRANSPORTS) readTransport(file);
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
        if (ts.isCallExpression(node) && isTemplateCall(node)) {
          node.arguments.forEach(readInput);
          templateCalls.push(node);
        }
        if (
          ts.isObjectLiteralExpression(node) &&
          !transportLiterals.has(node) &&
          (mailShaped(checker.getContextualType(node)) ||
            node.properties.some(
              (property) => ts.isSpreadAssignment(property) && fromTemplate(property.expression),
            ))
        ) {
          readLiteral(node, false);
        }
        if (
          (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
          isWritten(node)
        ) {
          const keys = ts.isPropertyAccessExpression(node)
            ? [node.name.text]
            : keysOf(node.argumentExpression);
          const written = keys?.filter((key) => CONTENT_KEYS.has(key));
          if ((written === undefined || written.length > 0) && fromTemplate(node.expression)) {
            for (const key of written ?? [])
              problem(node, `writes ${key} outside mail/templates.ts`);
            if (written === undefined) problem(node, 'writes a key this cannot read onto a mail');
          }
        }
        if (
          ts.isCallExpression(node) &&
          node.arguments[0] !== undefined &&
          writesOnto(node) &&
          fromTemplate(node.arguments[0])
        ) {
          problem(
            node,
            `${node.expression.getText()}(…) writes onto a mail outside mail/templates.ts`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  readEscapes();
  return { templates, inputs, problems: [...problems].sort() };
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

  it('keeps every mail input a template takes, with what it is', () => {
    for (const [name, { what }] of Object.entries(MAIL_INPUTS)) {
      expect(what.trim(), name).not.toBe('');
    }
    // An input no template takes any more fails: its line goes with the last template taking it.
    expect(Object.keys(MAIL_INPUTS).filter((name) => !code.inputs.includes(name))).toEqual([]);
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
    expect(keys).toEqual([...MESSAGE_KEYS].sort());
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
        // A mail package's options are a message too, here taken from outside a transport.
        'markets/__planted__.ts:37: carries host, which a MailMessage does not say',
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

// ---- #113 review: the ways around the trace, each planted ---------------------------------------
// Each plant passed every check above until the check it is named for was added. A planted
// mail/templates.ts or mail/mailer.ts stands in for the real one, so the lines stay pinned.

/** A program of the planted files (path under `src/` → lines), with templates.ts beside them. */
const plantedProgram = (planted: Readonly<Record<string, readonly string[]>>) =>
  programOf(
    [TEMPLATES_FILE],
    Object.fromEntries(
      Object.entries(planted).map(([file, lines]) => [path.join(SRC, file), lines.join('\n')]),
    ),
  );

/** templates.ts as a plant writes it: EmailContent, then `lines`. */
const plantedTemplates = (...lines: string[]) => [
  'export interface EmailContent {',
  '  subject: string;',
  '  text: string;',
  '  html: string;',
  '}',
  ...lines,
];

describe('mail goes through the templates, whatever way it is written (#113 review)', () => {
  it('reads what a caller hands a template, and lets a template take only mail inputs', () => {
    const code = readMailCode(
      plantedProgram({
        'mail/templates.ts': plantedTemplates(
          'export function verificationEmail(input: { url: string; expiresInMinutes?: string }): EmailContent {',
          "  return { subject: '이메일 인증', text: input.url, html: input.url };",
          '}',
          'export function noticeEmail(input: { title: string; body: string; url: string }): EmailContent {',
          '  return { subject: input.title, text: `${input.body}\\n${input.url}`, html: input.body };',
          '}',
          'export function countEmail(count: string): EmailContent {',
          '  return { subject: count, text: count, html: count };',
          '}',
          'export const MAIL_TEMPLATES = {',
          '  verification: verificationEmail,',
          '  notice: noticeEmail,',
          '  count: countEmail,',
          '} as const satisfies Record<string, (input: never) => EmailContent>;',
        ),
        'markets/__planted__.ts': [
          "import { type Mailer } from '../mail/mailer.js';",
          "import { MAIL_TEMPLATES } from '../mail/templates.js';",
          "const HEADLINE = '이번 주 순위';",
          'export const notify = (mailer: Mailer, to: string, url: string) =>',
          '  mailer.send({ to, ...MAIL_TEMPLATES.notice({ title: HEADLINE, body: `${String(3)}위, 베팅 마감`, url }) });',
          'function announce(mailer: Mailer, to: string, title: string) {',
          "  return mailer.send({ to, ...MAIL_TEMPLATES.notice({ title, body: '', url: 'u' }) });",
          '}',
          "export const weekly = (mailer: Mailer) => announce(mailer, 'x', '주간 랭킹');",
          "export const link = (mailer: Mailer) => mailer.send({ to: 'x', ...MAIL_TEMPLATES.verification({ url: '배당 확인' }) });",
        ],
      }),
    );
    expect(code.problems).toEqual(
      [
        'mail/templates.ts:6: verification takes expiresInMinutes as string, not a number',
        'mail/templates.ts:9: notice takes body, which is not a mail input (MAIL_INPUTS)',
        'mail/templates.ts:9: notice takes title, which is not a mail input (MAIL_INPUTS)',
        'mail/templates.ts:12: count takes string, not an object of mail inputs',
        'markets/__planted__.ts:3: 순위 (scoring) in what a template is handed',
        'markets/__planted__.ts:5: 베팅 (gambling) in what a template is handed',
        'markets/__planted__.ts:9: 랭킹 (scoring) in what a template is handed',
        'markets/__planted__.ts:10: 배당 (gambling) in what a template is handed',
      ].sort(),
    );
  });

  it('keeps every template in templates.ts, which imports nothing but types', () => {
    const code = readMailCode(
      plantedProgram({
        'mail/templates.ts': [
          "import { digestEmail } from '../markets/__digest__.js';",
          ...plantedTemplates(
            'export function verificationEmail(input: { url: string }): EmailContent {',
            "  return { subject: '이메일 인증', text: input.url, html: input.url };",
            '}',
            'export const MAIL_TEMPLATES = {',
            '  verification: verificationEmail,',
            '  digest: digestEmail,',
            '} as const satisfies Record<string, (input: never) => EmailContent>;',
          ),
        ],
        'markets/__digest__.ts': [
          'export function digestEmail(input: { url: string }) {',
          "  const note = input.url.length > 99 ? '이번 주 베팅 마감' : '안내';",
          '  return { subject: note, text: note, html: note };',
          '}',
        ],
        'markets/__planted__.ts': [
          "import { type Mailer } from '../mail/mailer.js';",
          "import { MAIL_TEMPLATES } from '../mail/templates.js';",
          "export const digest = (mailer: Mailer) => mailer.send({ to: 'x', ...MAIL_TEMPLATES.digest({ url: 'u' }) });",
        ],
      }),
    );
    expect(code.problems).toEqual(
      [
        'mail/templates.ts:1: imports ../markets/__digest__.js: what a mail says is written in mail/templates.ts',
        'mail/templates.ts:12: MAIL_TEMPLATES.digest is not a function declared in mail/templates.ts',
      ].sort(),
    );
  });

  it('holds a transport to handing on each key of the MailMessage, and nothing of its own', () => {
    const code = readMailCode(
      plantedProgram({
        'mail/mailer.ts': [
          "import { createTransport } from 'nodemailer';",
          'export interface MailMessage { to: string; subject: string; text: string; html?: string }',
          'export interface Mailer { send(message: MailMessage): Promise<void> }',
          'export function createMailer(from: string): Mailer {',
          "  const transporter = createTransport({ host: 'h', port: 25 });",
          "  const footer = '\\n\\n이번 주 순위 보기';",
          '  return {',
          '    async send(message) {',
          '      const withFooter = { ...message, text: message.text + footer };',
          '      await transporter.sendMail({ from, ...withFooter });',
          '    },',
          '  };',
          '}',
          'export function createPlainMailer(from: string): Mailer {',
          "  const transporter = createTransport({ host: 'h', port: 25 }, { text: '광고 문의' });",
          '  return {',
          '    async send(message) {',
          '      await transporter.sendMail({',
          '        from,',
          '        to: message.to,',
          '        subject: message.subject,',
          '        text: `${message.text}\\n\\n광고 문의`,',
          '        html: message.html,',
          '        amp: message.html,',
          "        headers: { 'X-Note': '안내' },",
          '      });',
          '    },',
          '  };',
          '}',
        ],
      }),
    );
    expect(code.problems).toEqual(
      [
        // Words of its own, through a const and a spread of what it was handed.
        'mail/mailer.ts:6: 순위 (scoring) in a transport',
        'mail/mailer.ts:9: message is used other than handed on key by key',
        'mail/mailer.ts:9: spreads message: a transport hands on each MailMessage key by name',
        "mail/mailer.ts:9: sends text other than as the MailMessage's text",
        // Defaults for every message, and keys of the message the MailMessage does not have.
        "mail/mailer.ts:15: sends text other than as the MailMessage's text",
        'mail/mailer.ts:22: message is used other than handed on key by key',
        "mail/mailer.ts:22: sends text other than as the MailMessage's text",
        'mail/mailer.ts:24: message is used other than handed on key by key',
        'mail/mailer.ts:24: sends amp, which a MailMessage does not say',
        'mail/mailer.ts:25: sends headers, which a MailMessage does not say',
      ].sort(),
    );
  });

  it('holds a transport to what its Mailer.send was handed, read key by key', () => {
    const code = readMailCode(
      plantedProgram({
        'mail/mailer.ts': [
          "import { createTransport } from 'nodemailer';",
          "import { MAIL_FOOTER } from '../markets/__footer__.js';",
          'export interface MailMessage { to: string; subject: string; text: string; html?: string }',
          'export interface Mailer { send(message: MailMessage): Promise<void> }',
          'export function createMailer(from: string): Mailer {',
          "  const transporter = createTransport({ host: 'h', port: 25 });",
          '  return {',
          '    async send(message) {',
          '      const extra = { text: `${message.text}${MAIL_FOOTER}` };',
          '      const m: MailMessage = { ...message, ...extra };',
          '      await transporter.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html });',
          '    },',
          '  };',
          '}',
          'export function createBoxedMailer(from: string): Mailer {',
          "  const transporter = createTransport({ host: 'h', port: 25 });",
          '  return {',
          '    async send(message) {',
          '      (Object(message) as { text: string }).text += MAIL_FOOTER;',
          '      (arguments[0] as { html: string }).html = MAIL_FOOTER;',
          '      await transporter.sendMail({ from, to: message.to, subject: message.subject, text: message.text, html: message.html });',
          '    },',
          '  };',
          '}',
        ],
        'markets/__footer__.ts': [
          "export const MAIL_FOOTER = '\\n\\n이번 주 순위와 베팅 결과 보기';",
        ],
      }),
    );
    expect(code.problems).toEqual(
      [
        // Words from another file, which the transport's own strings do not show.
        'mail/mailer.ts:2: imports ../markets/__footer__.js: a transport writes nothing of its own',
        // Its own text spread over a copy, and keys read off the copy.
        'mail/mailer.ts:9: message is used other than handed on key by key',
        'mail/mailer.ts:9: writes text outside mail/templates.ts',
        'mail/mailer.ts:10: extra holds a mail and is used other than to send it',
        'mail/mailer.ts:10: message is used other than handed on key by key',
        "mail/mailer.ts:11: sends html other than as the MailMessage's html",
        "mail/mailer.ts:11: sends subject other than as the MailMessage's subject",
        "mail/mailer.ts:11: sends text other than as the MailMessage's text",
        "mail/mailer.ts:11: sends to other than as the MailMessage's to",
        // What it was handed, changed under no name before it is read key by key.
        'mail/mailer.ts:19: message is used other than handed on key by key',
        'mail/mailer.ts:20: arguments reaches message, which holds a mail',
      ].sort(),
    );
  });

  it('knows a template result handed where no send goes', () => {
    const code = readMailCode(
      plantedProgram({
        'markets/__planted__.ts': [
          "import { type Mailer } from '../mail/mailer.js';",
          "import { type EmailContent, MAIL_TEMPLATES } from '../mail/templates.js';",
          'const same = <T>(value: T): T => value;',
          'export class Planted {',
          '  constructor(private readonly mailer: Mailer) {}',
          '  async boxed(to: string) {',
          "    const content = MAIL_TEMPLATES.verification({ url: 'u' });",
          '    const box: unknown[] = [content];',
          "    (box[0] as { subject: string }).subject = '이번 주 순위';",
          '    await this.mailer.send({ to, ...content });',
          '  }',
          '  async mapped(to: string) {',
          "    const content = MAIL_TEMPLATES.verification({ url: 'u' });",
          "    Object.assign(new Map<string, unknown>([['m', content]]).get('m') as object, { subject: '베팅 마감' });",
          '    await this.mailer.send({ to, ...content });',
          '  }',
          '  async wrapped(to: string) {',
          "    const content = MAIL_TEMPLATES.verification({ url: 'u' });",
          "    (Object(content) as { html: string }).html = '<p>배당</p>';",
          '    await this.mailer.send({ to, ...content });',
          '  }',
          '  async pushed(to: string) {',
          "    const content = MAIL_TEMPLATES.verification({ url: 'u' });",
          '    const box: EmailContent[] = [];',
          '    box.push(same(content));',
          "    (box[0] as { text: string }).text = '베팅';",
          '    await this.mailer.send({ to, ...content });',
          '  }',
          '  async inline(to: string) {',
          "    const box = [MAIL_TEMPLATES.verification({ url: 'u' })];",
          '    await this.mailer.send({ to, ...box[0]! });',
          '  }',
          '  async logged(to: string) {',
          "    const content = MAIL_TEMPLATES.verification({ url: 'u' });",
          '    console.info(content.subject.length);',
          '    await this.mailer.send({ to, ...content });',
          '  }',
          '  relay(to: string, content: object) {',
          "    (arguments[1] as { subject: string }).subject = '순위';",
          '    return this.mailer.send({ to, ...(content as EmailContent) });',
          '  }',
          '  async relayed(to: string) {',
          "    await this.relay(to, MAIL_TEMPLATES.verification({ url: 'u' }));",
          '  }',
          '}',
        ],
      }),
    );
    expect(code.problems).toEqual(
      [
        // An untyped container, Object() and a generic hold it under no name the trace knows.
        'markets/__planted__.ts:8: content holds a mail and is used other than to send it',
        'markets/__planted__.ts:14: content holds a mail and is used other than to send it',
        'markets/__planted__.ts:19: content holds a mail and is used other than to send it',
        'markets/__planted__.ts:25: content holds a mail and is used other than to send it',
        'markets/__planted__.ts:26: writes text outside mail/templates.ts',
        'markets/__planted__.ts:30: MAIL_TEMPLATES.verification(…) is used other than to send what it builds',
        'markets/__planted__.ts:31: box[0] is a value this cannot follow',
        // A parameter that holds a mail, reached through `arguments`.
        'markets/__planted__.ts:39: arguments reaches content, which holds a mail',
      ].sort(),
    );
  });

  it('knows a template result changed after it is built, under any name', () => {
    const code = readMailCode(
      plantedProgram({
        'markets/__planted__.ts': [
          "import { type Mailer } from '../mail/mailer.js';",
          "import { MAIL_TEMPLATES } from '../mail/templates.js';",
          "const KEY = 'html';",
          'function tweak(mail: { text: string }) {',
          "  mail.text += ' 베팅';",
          '}',
          'export class Planted {',
          '  constructor(private readonly mailer: Mailer) {}',
          '  async element(to: string) {',
          "    const content = MAIL_TEMPLATES.verification({ url: 'u' });",
          "    content['subject'] = '순위';",
          "    content[KEY] = '<p>배당</p>';",
          '    await this.mailer.send({ to, ...content });',
          '  }',
          '  async assigned(to: string) {',
          "    const content = MAIL_TEMPLATES.verification({ url: 'u' });",
          "    Object.assign(content, { subject: '순위' });",
          '    await this.mailer.send({ to, ...content });',
          '  }',
          '  async narrowed(to: string) {',
          "    const content = MAIL_TEMPLATES.verification({ url: 'u' });",
          '    const alias: { subject: string } = content;',
          "    alias.subject = '순위';",
          '    await this.mailer.send({ to, ...content });',
          '  }',
          '  async viaParameter(to: string) {',
          "    const content = MAIL_TEMPLATES.verification({ url: 'u' });",
          '    tweak(content);',
          '    await this.mailer.send({ to, ...content });',
          '  }',
          '  copied(): object {',
          "    const content = MAIL_TEMPLATES.verification({ url: 'u' });",
          "    return { ...content, subject: '순위' };",
          '  }',
          '  async destructured(to: string) {',
          "    const content = MAIL_TEMPLATES.verification({ url: 'u' });",
          "    [content.text] = ['베팅'];",
          "    (content.html) += '<p>배당</p>';",
          '    await this.mailer.send({ to, ...content });',
          '  }',
          '}',
        ],
      }),
    );
    expect(code.problems).toEqual(
      [
        'markets/__planted__.ts:5: writes text outside mail/templates.ts',
        'markets/__planted__.ts:11: writes subject outside mail/templates.ts',
        'markets/__planted__.ts:12: writes html outside mail/templates.ts',
        'markets/__planted__.ts:17: Object.assign(…) writes onto a mail outside mail/templates.ts',
        // Handed to what sends nothing: a built-in, another name, a function that only writes.
        'markets/__planted__.ts:17: content holds a mail and is used other than to send it',
        'markets/__planted__.ts:22: content holds a mail and is used other than to send it',
        'markets/__planted__.ts:23: writes subject outside mail/templates.ts',
        'markets/__planted__.ts:28: content holds a mail and is used other than to send it',
        // Copied into a mail that is returned, not sent.
        'markets/__planted__.ts:33: content holds a mail and is used other than to send it',
        'markets/__planted__.ts:33: writes subject outside mail/templates.ts',
        'markets/__planted__.ts:37: writes text outside mail/templates.ts',
        'markets/__planted__.ts:38: writes html outside mail/templates.ts',
      ].sort(),
    );
  });

  it('knows a send that carries more than a MailMessage says', () => {
    const code = readMailCode(
      plantedProgram({
        'markets/__planted__.ts': [
          "import { type Mailer } from '../mail/mailer.js';",
          "import { MAIL_TEMPLATES } from '../mail/templates.js';",
          'export async function extra(mailer: Mailer, to: string) {',
          "  const message = { to, ...MAIL_TEMPLATES.verification({ url: 'u' }), amp: '<p>안내</p>' };",
          '  await mailer.send(message);',
          '}',
          'export async function attached(mailer: Mailer, to: string) {',
          "  const files = { attachments: [{ filename: 'a.txt', content: '안내' }] };",
          "  await mailer.send({ to, ...MAIL_TEMPLATES.verification({ url: 'u' }), ...files });",
          '}',
        ],
      }),
    );
    expect(code.problems).toEqual(
      [
        'markets/__planted__.ts:4: carries amp, which a MailMessage does not say',
        'markets/__planted__.ts:8: carries attachments, which a MailMessage does not say',
      ].sort(),
    );
  });

  it('follows a function to its calls under any name', () => {
    const code = readMailCode(
      plantedProgram({
        'markets/__relay__.ts': [
          "import { type Mailer } from '../mail/mailer.js';",
          "import { type EmailContent, MAIL_TEMPLATES } from '../mail/templates.js';",
          'export function relay(mailer: Mailer, to: string, content: object) {',
          '  return mailer.send({ to, ...(content as EmailContent) });',
          '}',
          "export const welcome = (mailer: Mailer) => relay(mailer, 'x', MAIL_TEMPLATES.verification({ url: 'u' }));",
        ],
        'markets/__planted__.ts': [
          "import { type Mailer } from '../mail/mailer.js';",
          "import { relay as forward } from './__relay__.js';",
          "import * as relays from './__relay__.js';",
          "export const aliased = (mailer: Mailer) => forward(mailer, 'x', { subject: '순위', text: '', html: '' });",
          "export const viaNamespace = (mailer: Mailer) => relays.relay(mailer, 'x', { subject: '배당', text: '', html: '' });",
        ],
      }),
    );
    expect(code.problems).toEqual(
      [
        'markets/__planted__.ts:4: writes html outside mail/templates.ts',
        'markets/__planted__.ts:4: writes subject outside mail/templates.ts',
        'markets/__planted__.ts:4: writes text outside mail/templates.ts',
        'markets/__planted__.ts:5: writes html outside mail/templates.ts',
        'markets/__planted__.ts:5: writes subject outside mail/templates.ts',
        'markets/__planted__.ts:5: writes text outside mail/templates.ts',
      ].sort(),
    );
  });
});
