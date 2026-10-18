/**
 * #113 for SMS (ADR-0070): every text the API sends is a registered template of sms/templates.ts,
 * whose words are held to every excluded feature as mail's are (outbound copy a member reads, not
 * the service guide), and each fits one short SMS. The senders write no words of their own.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { findExcludedText, PHONE_VERIFICATION_LIMITS } from '@buddha/shared';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { SRC } from '../test/program.js';
import * as templates from './templates.js';
import { SMS_TEMPLATES, type SmsContent, verificationCodeSms } from './templates.js';

/**
 * Example inputs for every registered template, the widest values included. The type asks for a
 * line per template, so a template registered without examples does not compile.
 */
const EXAMPLES: {
  [K in keyof typeof SMS_TEMPLATES]: readonly [
    Parameters<(typeof SMS_TEMPLATES)[K]>[0],
    ...Parameters<(typeof SMS_TEMPLATES)[K]>[0][],
  ];
} = {
  verificationCode: [
    { code: '012345', expiresInMinutes: PHONE_VERIFICATION_LIMITS.codeTtlSeconds / 60 },
    { code: '999999', expiresInMinutes: 99 },
  ],
};

/** One short SMS (알리고 `msg_type=SMS`): 90 bytes in EUC-KR. */
const SMS_MAX_BYTES = 90;

/**
 * The characters of KS X 1001 (EUC-KR's two-byte set: Hangul syllables, symbols, Hanja), decoded
 * from every two-byte code it has. A character outside it and outside printable ASCII would reach
 * the phone as '?' (the carriers' web systems encode in EUC-KR).
 */
const KS_X_1001: ReadonlySet<string> = (() => {
  const decoder = new TextDecoder('euc-kr');
  const set = new Set<string>();
  for (let lead = 0xa1; lead <= 0xfe; lead += 1) {
    for (let trail = 0xa1; trail <= 0xfe; trail += 1) {
      const char = decoder.decode(new Uint8Array([lead, trail]));
      if (char.length === 1 && char !== '�') set.add(char);
    }
  }
  return set;
})();

/** The EUC-KR length of `text`, or undefined when a character has no EUC-KR form. */
function eucKrBytes(text: string): number | undefined {
  let bytes = 0;
  for (const char of text) {
    if (/^[\x20-\x7E]$/.test(char)) bytes += 1;
    else if (KS_X_1001.has(char)) bytes += 2;
    else return undefined;
  }
  return bytes;
}

function renderedTexts(): { name: string; sms: SmsContent }[] {
  return Object.entries(SMS_TEMPLATES).flatMap(([name, build]) =>
    (EXAMPLES[name as keyof typeof SMS_TEMPLATES] as readonly unknown[]).map((input) => ({
      name,
      sms: (build as (input: unknown) => SmsContent)(input),
    })),
  );
}

/** Every string and template literal in a file, an interpolation read as the digit 0. */
function literalsOf(fileName: string): { line: number; text: string }[] {
  const file = ts.createSourceFile(
    fileName,
    readFileSync(fileName, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: { line: number; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    const text =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? node.text
        : ts.isTemplateExpression(node)
          ? node.head.text + node.templateSpans.map((span) => '0' + span.literal.text).join('')
          : undefined;
    if (text !== undefined) {
      found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const excludedIn = (fileName: string) =>
  literalsOf(fileName).flatMap(({ line, text }) =>
    findExcludedText(text).map((hit) => `${String(line)}: ${hit.match} (${hit.feature})`),
  );

const TEMPLATES_FILE = path.join(SRC, 'sms', 'templates.ts');
/** The files that send what a template built, and so must write no words of their own. */
const SENDERS = ['sms/aligo-sms-sender.ts', 'sms/dev-sms-sender.ts'];

describe('SMS templates (ADR-0070)', () => {
  it('texts the code and how long it is valid, in Korean', () => {
    expect(verificationCodeSms({ code: '012345', expiresInMinutes: 3 }).text).toBe(
      '[buddha] 본인확인 인증번호는 012345입니다. 3분 안에 입력해 주세요.',
    );
  });

  it('registers every template the module exports', () => {
    const registered = new Set<unknown>(Object.values(SMS_TEMPLATES));
    const unregistered = Object.entries(templates)
      .filter(([, value]) => typeof value === 'function' && !registered.has(value))
      .map(([name]) => name);
    expect(unregistered).toEqual([]);
  });

  it('imports nothing but types, so every word is a string of the file', () => {
    const file = ts.createSourceFile(
      TEMPLATES_FILE,
      readFileSync(TEMPLATES_FILE, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const valueImports = file.statements
      .filter(ts.isImportDeclaration)
      .filter((statement) => statement.importClause?.isTypeOnly !== true)
      .map((statement) => statement.getText(file));
    expect(valueImports).toEqual([]);
  });

  it('fits each text in one short SMS, every character in EUC-KR', () => {
    expect(KS_X_1001.has('인')).toBe(true);
    expect(eucKrBytes('[buddha] 인증')).toBe(13);
    expect(eucKrBytes('똠')).toBeUndefined(); // not one of KS X 1001's 2,350 syllables
    for (const { name, sms } of renderedTexts()) {
      const bytes = eucKrBytes(sms.text);
      expect(bytes, `${name}: ${sms.text}`).toBeDefined();
      expect(bytes, `${name}: ${sms.text}`).toBeLessThanOrEqual(SMS_MAX_BYTES);
    }
  });

  it('names nothing the plan leaves out, in the texts and in every string of the file', () => {
    const texts = renderedTexts();
    expect(new Set(texts.map(({ name }) => name))).toEqual(new Set(Object.keys(SMS_TEMPLATES)));
    for (const { name, sms } of texts) {
      expect(findExcludedText(sms.text), `${name}: ${sms.text}`).toEqual([]);
    }
    expect(excludedIn(TEMPLATES_FILE)).toEqual([]);
  });

  it('holds the senders’ own strings to the same words', () => {
    for (const sender of SENDERS) expect(excludedIn(path.join(SRC, sender)), sender).toEqual([]);
  });
});
