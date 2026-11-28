import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  APPEAL_WINDOW_DAYS,
  CONSENT_DOCUMENTS,
  CONTRACT_TERMS,
  LEGAL_FIRST_EFFECTIVE_DATE,
  LINK_REPEAT_WINDOW_SECONDS,
  NICKNAME_HOLD_DAYS,
  PAYMENT_REFUND_WINDOW_DAYS,
  POLICY_RETENTION_DAYS,
  PRIVACY_EXPIRED_SESSIONS_EFFECTIVE_DATE,
  RETENTION_PERIODS,
  type RetentionPeriod,
  WRITE_LIMIT_DAY_SECONDS,
  WRITING_RESTRICTION_DAYS,
  currentConsentVersion,
  findExcludedText,
} from '@buddha/shared';
import type * as SharedModule from '@buddha/shared';
import { describe, expect, it, vi } from 'vitest';
import { copy } from '@/copy';
import {
  BUSINESS_INFO,
  FOOTER_BUSINESS_LINES,
  OWNER_SUPPLIED_KEYS,
  UNDECIDED,
  fillBusinessInfo,
} from './business-info';
import { LEGAL_NO_SALES_NOTICE } from './cash-notice';
import { PRIVACY_CONSENT_TEXT } from './consent-texts';
import {
  type LegalDocument,
  effectiveDateText,
  legalDocumentStrings,
  mapLegalDocument,
  numbered,
  paragraph,
  resolveLegalDocument,
  sectionHeading,
  table,
} from './document';
import { DAILY_BACKUPS_KEPT, PRIVACY } from './privacy';
import { PRIVACY_2026_11_28 } from './privacy-2026-11-28';
import { REFUND } from './refund';
import { SERVICE_FACTS, SERVICE_FACT_LIST } from './service-facts';
import { TERMS } from './terms';
import { UnknownTemplateKeyError, fillTemplate, templateKeys } from './template';
import {
  LEGAL_DOCUMENT_KINDS,
  LEGAL_VERSIONS,
  currentLegalDocument,
  effectiveDateOf,
  legalDocumentOn,
  legalVersionParams,
  legalVersionPath,
} from './versions';

const DOCUMENTS: [string, LegalDocument][] = [
  ['terms', TERMS],
  ['privacy', PRIVACY],
  ['refund', REFUND],
];

const KNOWN_KEYS = new Set(Object.keys(BUSINESS_INFO));

// A particle whose form depends on the preceding syllable, straight after a placeholder:
// `{{companyName}}가` reads "미정가" today and would need 가 or 이 depending on the real 상호.
const PARTICLE_AFTER_PLACEHOLDER = /\}\}(?:이|가|은|는|을|를|과|와|로|으로)/;

describe('fillTemplate', () => {
  it('replaces every placeholder, repeated ones included', () => {
    expect(fillTemplate('{{a}} and {{b}}, again {{a}}', { a: 'A', b: 'B' })).toBe(
      'A and B, again A',
    );
  });

  it('tolerates spaces inside the braces', () => {
    expect(fillTemplate('상호: {{ companyName }}', { companyName: '버다' })).toBe('상호: 버다');
  });

  it('leaves text without placeholders, and single braces, alone', () => {
    expect(fillTemplate('no placeholders here', {})).toBe('no placeholders here');
    expect(fillTemplate('{a} {b}', { a: 'x' })).toBe('{a} {b}');
  });

  it('throws on a key the values do not have, naming it', () => {
    expect(() => fillTemplate('상호: {{companyNmae}}', { companyName: 'x' })).toThrow(
      UnknownTemplateKeyError,
    );
    let caught: unknown;
    try {
      fillTemplate('{{ nope }}', {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnknownTemplateKeyError);
    expect((caught as UnknownTemplateKeyError).key).toBe('nope');
    expect((caught as Error).message).toContain('{{nope}}');
    expect(() => fillTemplate('{{}}', {})).toThrow(UnknownTemplateKeyError);
  });

  it('never resolves an inherited property as a key', () => {
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(() => fillTemplate(`{{${key}}}`, { a: 'A' })).toThrow(UnknownTemplateKeyError);
    }
  });

  it('substitutes in one pass: a value that looks like a placeholder is not expanded', () => {
    expect(fillTemplate('{{a}}', { a: '{{b}}', b: 'B' })).toBe('{{b}}');
  });

  it('allows an empty value (the business facts forbid one separately)', () => {
    expect(fillTemplate('[{{a}}]', { a: '' })).toBe('[]');
  });
});

describe('templateKeys', () => {
  it('lists the keys in order of appearance, trimmed, duplicates kept', () => {
    expect(templateKeys('{{a}} {{ b }} {{a}} {c}')).toEqual(['a', 'b', 'a']);
    expect(templateKeys('none')).toEqual([]);
  });
});

describe('BUSINESS_INFO', () => {
  it('gives every fact a non-empty value', () => {
    for (const [key, value] of Object.entries(BUSINESS_INFO)) {
      expect(value.trim(), key).not.toBe('');
      expect(value, key).not.toMatch(/\{\{|\}\}/);
    }
  });

  it('has every fact the owner has to supply, and only those still open (#137, ADR-0176)', () => {
    for (const key of OWNER_SUPPLIED_KEYS) expect(BUSINESS_INFO).toHaveProperty(key);
    expect(UNDECIDED).toBe('미정');
    // The six business facts (Q-PG-2, taken at #149 — owner answer 137-8), the customer centre's
    // address and the privacy officer's title (133-5). The rest went with #137: no expiry (a
    // sentence, #73-16), no paid section (D9), one address for the officer, a 시행일 per document.
    expect([...OWNER_SUPPLIED_KEYS].sort()).toEqual(
      [
        'companyName',
        'ceoName',
        'businessNumber',
        'mailOrderNumber',
        'address',
        'phone',
        'email',
        'privacyOfficer',
      ].sort(),
    );
    for (const gone of [
      'coinExpiry',
      'refundProcessingTime',
      'privacyOfficerEmail',
      'effectiveDate',
      'pgServiceName',
    ]) {
      expect(BUSINESS_INFO, gone).not.toHaveProperty(gone);
    }
  });

  it('takes the decided facts from the code, not from a second copy', () => {
    expect(BUSINESS_INFO.serviceName).toBe(copy.appName);
    // Kept for the charge copy hidden while sales are closed (D9), not for the documents.
    expect(BUSINESS_INFO.refundWindowDays).toBe(String(PAYMENT_REFUND_WINDOW_DAYS));
    expect(BUSINESS_INFO.pgName).toBe('스마트로(주)');
    expect(BUSINESS_INFO.hostingProvider).toContain('Amazon Web Services');
    expect(BUSINESS_INFO.minimumAge).toBe('14');
  });

  it('is shown somewhere: every owner-supplied fact is named by the footer or a document', () => {
    const used = new Set([
      ...FOOTER_BUSINESS_LINES.flatMap(templateKeys),
      ...DOCUMENTS.flatMap(([, doc]) => legalDocumentStrings(doc).flatMap(templateKeys)),
    ]);
    for (const key of OWNER_SUPPLIED_KEYS) expect(used, key).toContain(key);
  });
});

describe.each(DOCUMENTS)('legal document: %s', (name, doc) => {
  const raw = legalDocumentStrings(doc);
  const resolved = legalDocumentStrings(resolveLegalDocument(doc));

  it('names only known business facts', () => {
    for (const text of raw) {
      for (const key of templateKeys(text)) expect(KNOWN_KEYS, `${name}: ${text}`).toContain(key);
    }
  });

  it('never puts a syllable-dependent particle straight after a placeholder', () => {
    for (const text of raw) expect(text, name).not.toMatch(PARTICLE_AFTER_PLACEHOLDER);
  });

  it('resolves fully with the real config: no braces left anywhere', () => {
    expect(resolved).toHaveLength(raw.length);
    for (const text of resolved) {
      expect(text, name).not.toContain('{{');
      expect(text, name).not.toContain('}}');
    }
  });

  it('names no excluded feature but in a negative notice, as the guide (137-4 (a), #113)', () => {
    // The whole list and the #14 term rows (TERM_MEANING_PATTERNS), the gambling words never.
    for (const text of resolved) {
      expect(text.trim(), name).not.toBe('');
      expect(findExcludedText(text, { scope: 'legal-body' }), `${name}: ${text}`).toEqual([]);
    }
  });

  it('has sections with distinct headings and an addendum that says its 시행일', () => {
    expect(doc.sections.length).toBeGreaterThan(0);
    const headings = doc.sections.map((section) => section.heading);
    expect(new Set(headings).size).toBe(headings.length);
    for (const section of doc.sections) expect(section.blocks.length).toBeGreaterThan(0);
    const date = effectiveDateOf(doc);
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const addendum = legalDocumentStrings({ ...doc, title: '', intro: [], sections: [] });
    expect(addendum[1], name).toMatch(
      new RegExp(`^이 .+은 ${effectiveDateText(date)}부터 시행합니다\\.$`),
    );
  });
});

describe('effectiveDateText', () => {
  it('writes a 시행일 the Korean way and refuses anything else', () => {
    expect(effectiveDateText('2026-11-28')).toBe('2026년 11월 28일');
    expect(effectiveDateText('2027-01-05')).toBe('2027년 1월 5일');
    expect(() => effectiveDateText('미정')).toThrow();
    expect(() => effectiveDateText('draft-2026-10-18')).toThrow();
  });
});

function fingerprint(strings: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(strings)).digest('hex').slice(0, 16);
}

/**
 * The words of every listed version, placeholders unfilled (owner answer 137-2c): a version that
 * took effect is never rewritten — not by an edit of its module, nor of a sentence, a constant or a
 * retention figure it reads (service-facts.ts, copy.ts, POLICY_RETENTION_DAYS …). An archived
 * version is a literal copy (versions.ts), so its pin never moves; add one here when a version is
 * archived. #137's three versions took effect on LEGAL_FIRST_EFFECTIVE_DATE: their pins never move,
 * and the next revision of each freezes it (the policy's is in privacy-2026-11-28.ts). #339's
 * (ADR-0181) has not taken effect until its pull request is merged and deployed, and is re-pinned
 * with PINNED if its 시행일 (PRIVACY_EXPIRED_SESSIONS_EFFECTIVE_DATE), which its 부칙 writes out,
 * moves to the deploy day.
 */
const VERSION_FINGERPRINTS: Readonly<Record<string, string>> = {
  [`terms:${LEGAL_FIRST_EFFECTIVE_DATE}`]: '88d1d59a8646b5eb',
  [`privacy:${LEGAL_FIRST_EFFECTIVE_DATE}`]: '2eb446a4f4d62e91',
  [`privacy:${PRIVACY_EXPIRED_SESSIONS_EFFECTIVE_DATE}`]: '037f491e1904d9a6',
  [`refund:${LEGAL_FIRST_EFFECTIVE_DATE}`]: '59a9c170d1ed38da',
};

describe('the versions of the three documents (owner answer 137-2c, #137)', () => {
  it('lists each document oldest first, the module in force last, never the drafts', () => {
    expect(currentLegalDocument('terms')).toBe(TERMS);
    expect(currentLegalDocument('privacy')).toBe(PRIVACY);
    expect(currentLegalDocument('refund')).toBe(REFUND);
    for (const kind of LEGAL_DOCUMENT_KINDS) {
      const dates = LEGAL_VERSIONS[kind].map(effectiveDateOf);
      expect([...dates].sort(), kind).toEqual(dates);
      expect(new Set(dates).size, kind).toBe(dates.length);
      for (const date of dates) {
        expect(date, kind).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(legalDocumentOn(kind, date)?.effectiveDate, kind).toBe(date);
      }
      // The drafts of 2026-10-18 never took effect (their 시행일 was 미정).
      expect(legalDocumentOn(kind, 'draft-2026-10-18'), kind).toBeUndefined();
      expect(legalVersionParams(kind), kind).toEqual(dates.map((date) => ({ date })));
      expect(legalVersionPath(kind, dates.at(-1)!)).toBe(`/${kind}/${dates.at(-1)!}`);
    }
    // #137's revision is the first that takes effect; #339's (ADR-0181) the policy's second, #137's
    // archived before it as a literal copy.
    expect(LEGAL_VERSIONS.terms.map(effectiveDateOf)).toEqual([LEGAL_FIRST_EFFECTIVE_DATE]);
    expect(LEGAL_VERSIONS.privacy.map(effectiveDateOf)).toEqual([
      LEGAL_FIRST_EFFECTIVE_DATE,
      PRIVACY_EXPIRED_SESSIONS_EFFECTIVE_DATE,
    ]);
    expect(LEGAL_VERSIONS.privacy[0]).toBe(PRIVACY_2026_11_28);
    expect(LEGAL_VERSIONS.refund.map(effectiveDateOf)).toEqual([LEGAL_FIRST_EFFECTIVE_DATE]);
  });

  it('is what a consent record names: the 시행일 of the version in force (#57-5)', () => {
    expect(currentConsentVersion('terms')).toBe(effectiveDateOf(currentLegalDocument('terms')));
    expect(currentConsentVersion('privacy')).toBe(effectiveDateOf(currentLegalDocument('privacy')));
    // Every version a terms or privacy record may name from #137 on is a listed version.
    for (const item of ['terms', 'privacy'] as const) {
      const listed = LEGAL_VERSIONS[item].map(effectiveDateOf);
      const named = CONSENT_DOCUMENTS[item].versions
        .map(({ version }) => version)
        .filter((version) => !version.startsWith('draft-'));
      expect(named, item).toEqual(listed);
    }
  });

  it('never rewrites a version: the words of every listed version are pinned', () => {
    const versions = Object.fromEntries(
      LEGAL_DOCUMENT_KINDS.flatMap((kind) =>
        LEGAL_VERSIONS[kind].map((doc) => [
          `${kind}:${effectiveDateOf(doc)}`,
          fingerprint(legalDocumentStrings(doc)),
        ]),
      ),
    );
    expect(versions).toEqual(VERSION_FINGERPRINTS);
  });

  it('prerenders a page per version and nothing else', async () => {
    const pages = {
      terms: await import('@/app/terms/[date]/page'),
      privacy: await import('@/app/privacy/[date]/page'),
      refund: await import('@/app/refund/[date]/page'),
    };
    for (const kind of LEGAL_DOCUMENT_KINDS) {
      expect(pages[kind].dynamicParams, kind).toBe(false);
      expect(pages[kind].generateStaticParams(), kind).toEqual(legalVersionParams(kind));
    }
  });
});

describe('the no-sales sentence (N06, D9)', () => {
  it('is said by the 이용약관 and the 환불정책, never by the fact sentences the guide shares', () => {
    expect(LEGAL_NO_SALES_NOTICE).toBe('지금은 Coin을 판매하지 않고 결제·충전 기능이 없습니다.');
    expect(text(TERMS)).toContain(LEGAL_NO_SALES_NOTICE);
    expect(text(REFUND)).toContain(LEGAL_NO_SALES_NOTICE);
    // The guide says nothing of paid Coin (harmonization C6).
    for (const { id, text: fact } of SERVICE_FACT_LIST) {
      expect(fact, id).not.toContain('판매');
    }
  });
});

/** A document as it renders, every string on a line. */
function text(doc: LegalDocument): string {
  return legalDocumentStrings(resolveLegalDocument(doc)).join('\n');
}

/** The three documents as they render, together. */
const ALL_TEXT = DOCUMENTS.map(([, doc]) => text(doc)).join('\n');

/** The paid words: only in a sentence that says there are none (137-4 (a)). */
const PAID = /충전|결제|쿠폰|청약철회|구매/;

describe('legal document contents (#137, ADR-0176)', () => {
  it('offers no paid Coin: the paid words only where they say there is none (N06, D9)', () => {
    const lines = ALL_TEXT.split('\n').filter((line) => PAID.test(line));
    for (const line of lines) {
      expect(
        findExcludedText(line, { features: ['paid-purchase'], scope: 'legal-body' }),
        line,
      ).toEqual([]);
    }
    expect(ALL_TEXT).not.toMatch(/청약철회|쿠폰|구매|스마트로|카드|PG|결제대행/);
    // The old rules and statutes of the paid sections are gone (D9).
    for (const gone of ['전혀 쓰지 않았을 것', '사용 가능 잔고', '「민법」', '5년', '3년']) {
      expect(ALL_TEXT, gone).not.toContain(gone);
    }
    // The refund window of the paid rule (7 days) is gone with it: no period but the 시행일.
    expect(text(REFUND).replace(effectiveDateText(effectiveDateOf(REFUND)), '')).not.toMatch(
      /\d+일/,
    );
  });

  it('pays VOID 50/50 and calls it no refund of the price paid (N03 §6, D13)', () => {
    expect(text(TERMS)).toContain(SERVICE_FACTS.voidResult);
    expect(text(REFUND)).toContain(SERVICE_FACTS.voidResult);
    expect(SERVICE_FACTS.voidResult).toContain('원금 환불이 아니고 매입가에 따라 손익이 생깁니다');
    expect(ALL_TEXT).not.toMatch(/돌려줍니다|돌려드립니다|원가/);
  });

  it('judges with a provisional result, a dispute window from the screen, no payout under review', () => {
    const terms = text(TERMS);
    for (const fact of [
      SERVICE_FACTS.provisionalResult,
      SERVICE_FACTS.resolvedApartFromPaid,
      SERVICE_FACTS.provisionalCorrection,
      SERVICE_FACTS.resolvedError,
      SERVICE_FACTS.noReopen,
      SERVICE_FACTS.judgingPrinciple,
      SERVICE_FACTS.judgingDelay,
      SERVICE_FACTS.noFillCancel,
    ]) {
      expect(terms).toContain(fact);
    }
    expect(terms).not.toMatch(/바로 확정|즉시 확정/);
  });

  it('refers to its own articles by the numbers they have', () => {
    const article = (heading: string) =>
      sectionHeading(
        'article',
        TERMS.sections.findIndex((section) => section.heading === heading),
        heading,
      );
    expect(article('시장의 판정과 지급')).toBe('제9조(시장의 판정과 지급)');
    expect(article('결과가 확정된 뒤의 판정 오류')).toBe('제11조(결과가 확정된 뒤의 판정 오류)');
    expect(article('탈퇴')).toBe('제15조(탈퇴)');
    // 제9조 제5항 is the correction while the result is provisional.
    const judging = TERMS.sections[8]!.blocks[0]!;
    expect(judging.kind === 'list' && judging.items[4]).toBe(SERVICE_FACTS.provisionalCorrection);
    const terms = text(TERMS);
    expect(terms).toContain('제9조 제5항에 따라 잠정 결과를 정정');
    expect(terms).toContain('제11조에 따라 보상으로 지급합니다');
    expect(terms).toContain('남은 Coin은 소멸합니다(제15조)');
  });

  it('quotes every shared fact sentence word for word: S01–S32 (#136, harmonization)', () => {
    const terms = legalDocumentStrings(TERMS).join('\n');
    for (const { id, text: fact } of SERVICE_FACT_LIST) expect(terms, id).toContain(fact);
  });

  it('never calls the market price a probability, but in the notice that it is no promise of one', () => {
    for (const [name, doc] of DOCUMENTS) {
      const occurrences = text(doc).split('확률').length - 1;
      const notices = text(doc).split(SERVICE_FACTS.marketPriceNotProbability).length - 1;
      expect(occurrences, name).toBe(notices);
    }
    expect(text(TERMS)).toContain(SERVICE_FACTS.marketPriceNotProbability);
  });

  it('names the operating liquidity as a possible counterparty (N01 §5, 136-1)', () => {
    const terms = text(TERMS);
    expect(terms).toContain(SERVICE_FACTS.operatingLiquidity);
    expect(terms.split('운영 유동성(봇)')).toHaveLength(2);
    expect(terms.indexOf('운영 유동성(봇)')).toBe(terms.indexOf('운영 유동성'));
    expect(ALL_TEXT).not.toMatch(/마켓\s*메이커|market\s*maker/i);
  });

  it('says what N01 §2 says of Coin, with no expiry and no fee to come (#73, 137-1)', () => {
    const terms = text(TERMS);
    for (const fact of [
      SERVICE_FACTS.startGrant,
      SERVICE_FACTS.regrant,
      SERVICE_FACTS.noRewardOrTransfer,
      SERVICE_FACTS.noCashOut,
      SERVICE_FACTS.lossMoves,
      SERVICE_FACTS.grantsNotProfit,
    ]) {
      expect(terms).toContain(fact);
    }
    expect(terms).toContain('같은 번호로 다시 가입해도 시작 Coin은 다시 지급하지 않습니다');
    expect(terms).toContain('Coin에는 유효기간이 없습니다.');
    expect(terms).toContain('탈퇴하면 남은 Coin은 소멸합니다');
    // The fee: the code's 0, once, and nothing of a fee to come (137-1).
    expect(ALL_TEXT.split('수수료')).toHaveLength(2);
    expect(terms).toContain(SERVICE_FACTS.noFee);
  });

  it('sends every value an admin sets to the screen (133-2)', () => {
    const terms = text(TERMS);
    const shown = '화면에 표시한 값을 따릅니다';
    // 시작 지급액, 재지급, 이의 기간, 가격 보호 폭.
    expect(terms).toContain(
      `시작 Coin은 본인확인한 휴대전화 번호마다 한 번 받고, 금액은 ${shown}.`,
    );
    expect(terms).toContain(`조건과 금액은 ${shown}.`);
    expect(terms).toContain(`이의 기간(${shown})`);
    expect(terms).toContain(`가격 보호 폭은 ${shown}.`);
    // The internal limits exist, their figures unpublished (133-30).
    expect(terms).toContain(SERVICE_FACTS.limitsAndMonitoring);
  });

  it('writes only the figures its sources allow (133-2, 137-6 (a), 137-7)', () => {
    const allowed = new Set<number>([
      // The contract's code-fixed values and the 0 of the fee and of a losing contract (133-2).
      CONTRACT_TERMS.payoutCoin,
      CONTRACT_TERMS.priceMinCoin,
      CONTRACT_TERMS.priceMaxCoin,
      CONTRACT_TERMS.voidPayoutYesCoin,
      CONTRACT_TERMS.voidPayoutNoCoin,
      0,
      // Rights and deadlines (137-6 (a)).
      Number(BUSINESS_INFO.minimumAge),
      APPEAL_WINDOW_DAYS,
      ...WRITING_RESTRICTION_DAYS,
      NICKNAME_HOLD_DAYS,
      WRITE_LIMIT_DAY_SECONDS / 3_600,
      // The backups the infrastructure keeps now (137-7).
      DAILY_BACKUPS_KEPT,
      // The approved retention periods (133-8).
      ...Object.values(POLICY_RETENTION_DAYS).filter((days) => days !== null),
      // The notice days of a future revision (137-2b) and of the service's end.
      7,
      30,
    ]);
    const stripped = ALL_TEXT
      // The 시행일 (written by effectiveDateText).
      .replaceAll(/\d{4}년 \d{1,2}월 \d{1,2}일/g, '')
      // Statutes' and the documents' own article, paragraph and item numbers.
      .replaceAll(/제\d+(?:조|항|호)/g, '')
      // The 권익침해 구제 기관's numbers (국번 없이).
      .replaceAll(/\(국번 없이\) [\d-]+/g, '')
      // A count of one contract ('계약 1개', 'YES 1개').
      .replaceAll(/(?<!\d)1개/g, '');
    const figures = [...stripped.matchAll(/\d[\d,]*/g)].map((match) =>
      Number(match[0].replaceAll(',', '')),
    );
    expect(figures.length).toBeGreaterThan(0);
    expect(figures.filter((figure) => !allowed.has(figure))).toEqual([]);
    // No tick, no opening 50% and no percentage at all (137-6 (a)).
    expect(ALL_TEXT).not.toMatch(/\d\s*%|1 Coin 단위|틱/);
  });

  it('keeps the notice of a future revision as it stood (137-2b) and dates this one (137-2a)', () => {
    expect(text(TERMS)).toContain(
      '약관을 개정하면 회사는 개정 내용과 시행일을 시행일 7일 전부터 서비스 화면에 공지합니다. 회원에게 불리한 변경은 시행일 30일 전부터 공지하고, 회원이 등록한 이메일 주소로도 따로 알립니다.',
    );
    expect(text(PRIVACY)).toContain(
      '이 개인정보처리방침은 시행일부터 적용됩니다. 내용이 추가·삭제·수정되면 시행 7일 전부터 서비스 화면에 공지하며, 회원의 권리에 중요한 변경이 있으면 시행 30일 전부터 공지합니다.',
    );
    // A revision that changes members' rights is agreed to again at the next sign-in, nothing is
    // taken as agreed by silence, and one who does not agree leaves by 탈퇴 (#57-5).
    expect(text(TERMS)).toContain('다음 로그인 때 바뀐 항목에 다시 동의를 받고');
    expect(text(TERMS)).not.toContain('동의한 것으로 봅니다');
    // The transitional clause: the one reset before the first market (133-12).
    const addendum = legalDocumentStrings({ ...TERMS, intro: [], sections: [] }).join('\n');
    expect(addendum).toContain(
      '첫 시장을 열기 전에 한 번, 모든 계정과 기록을 지우고 다시 시작합니다',
    );
    expect(addendum).toContain('같은 휴대전화 번호에도 시작 Coin을 다시 지급합니다');
  });

  it('gives the company no right the decisions do not (137-3, #57-15·17, #45-13)', () => {
    const terms = text(TERMS);
    // No clawback of what was obtained unfairly (137-3), no termination by the company and no
    // 탈퇴 on a member's behalf (#57-15·17, #37-15), no hearing before an action that takes effect
    // at once (#45-13).
    expect(terms).not.toMatch(/회수하거나 취소|부정한 방법으로 얻은 (?:P|Coin)/);
    expect(terms).not.toMatch(/이용계약을 해지|해지할 수|해지합니다|해지된/);
    expect(terms).not.toContain('소명');
    expect(terms).toContain('운영자가 회원을 대신해 탈퇴시키거나 탈퇴한 계정을 되살리지 않습니다');
  });

  it('keeps the balance, the records and both appeals under an account restriction (N02 §9, N05 §5)', () => {
    const terms = text(TERMS);
    expect(terms).toContain(
      '잔액과 기록, 보유한 계약의 지급, 판정 오류의 보상, 판정 이의와 제재 이의는 그대로입니다',
    );
    expect(terms).toContain('회사는 신고 횟수만으로 자동으로 숨기거나 제재하지 않고');
    expect(terms).toContain('같은 IP 주소를 썼다는 것만으로');
    expect(terms).toContain(
      `작성 제한(${WRITING_RESTRICTION_DAYS.map((days) => `${String(days)}일`).join('·')} 또는 무기한)`,
    );
    expect(terms).toContain(`조치를 받은 때부터 ${String(APPEAL_WINDOW_DAYS)}일 안에`);
    expect(terms).toContain(copy.reportNotAReason);
  });

  it('terms: the age, the 본인확인 and the allowlist, with contact details asked at sign-up', () => {
    const terms = text(TERMS);
    expect(terms).toContain('만 14세 이상');
    expect(terms).toContain('가입 과정에서 휴대전화로 받은 인증번호로 본인확인');
    expect(terms).toContain('가입 허용 목록');
    expect(terms).toContain('휴대전화 번호는 고객센터');
    for (const doc of [terms, text(PRIVACY)]) expect(doc).not.toContain('처음 로그인할 때');
  });

  it('privacy: the items, their purposes and periods, the processors, the officer', () => {
    const privacy = text(PRIVACY);
    for (const item of [
      '실명',
      '휴대전화 번호',
      '인증번호를 보낸 기록',
      '가입 허용 목록',
      '동의 기록',
      '프로필 이미지',
      '시장 방문 기록',
      '검색어',
      'IP 주소',
      '이메일 주소',
    ]) {
      expect(privacy, item).toContain(item);
    }
    expect(privacy).toContain('공개 출시 때 목록을 비우며 모두 지웁니다');
    expect(privacy).toContain('서비스 개선을 위한 통계(관측 지표)');
    expect(privacy).not.toMatch(/순위|랭킹/);
    expect(privacy).toContain('알리고(㈜알리는사람들)');
    expect(privacy).toContain('Amazon Web Services');
    expect(privacy).toContain('서울');
    expect(privacy).toContain('외부 분석 도구를 쓰지 않습니다');
    expect(privacy).toContain('어디에도 공개하지 않는 정보: 이메일 주소, 실명, 휴대전화 번호');
    // Members see their own reports and the actions on them (MY, `GET /me/reports`,
    // `/me/moderation/actions`); a reported member never sees the report nor who made it (#45-13).
    expect(privacy).toContain('자신이 한 신고와 그 처리 결과, 자신이 받은 운영 조치와 그 사유');
    expect(privacy).toContain(
      '탈퇴한 회원의 기록(공개된 글·댓글은 빼고), 회원이 받은 신고와 신고한 사람, 운영 기록은 운영자만 봅니다',
    );
    expect(privacy).toContain(`${String(NICKNAME_HOLD_DAYS)}일 동안 보관한 뒤 지웁니다`);
    // An operator's reset holds the nickname under the action, which names the member.
    expect(privacy).toContain(
      '운영자가 바꿔서 쓰지 않게 된 닉네임은 그 운영 조치와 이어 보관합니다',
    );
    // The rights: refusing a deletion only where a statute keeps the data (제36조), no wider.
    expect(privacy).toContain('법령에서 보존을 요구하는 정보는 삭제를 요구하더라도');
    expect(privacy).not.toContain(
      '이 방침이 탈퇴한 뒤에도 보관한다고 적은 정보는 삭제를 요구하더라도',
    );
  });

  it('privacy: owner answer 2 of 2026-11-27 (#137, ADR-0176)', () => {
    const privacy = text(PRIVACY);
    // No hold for an investigation: nothing can hold one record.
    expect(privacy).not.toMatch(/수사|조사가 (?:진행|끝날)/);
    // The purpose of the 본인확인 기록, and every number hash by its name.
    expect(privacy).toContain('본인확인 기록, 인증번호 발송 한도(부정 이용 방지)');
    expect(privacy).not.toContain('원래 번호를 알아낼 수 없');
    for (const hashed of [
      '시작 Coin을 받은 휴대전화 번호의 키 있는 해시',
      '가입 허용 목록에 넣은 휴대전화 번호의 키 있는 해시',
      '누른 회원의 휴대전화 번호의 키 있는 해시',
      '본인확인한 번호의 키 있는 해시',
      '신고한 회원의 휴대전화 번호의 키 있는 해시',
      '제안한 회원의 휴대전화 번호의 키 있는 해시',
    ]) {
      expect(privacy, hashed).toContain(hashed);
    }
    // The market visits' basis, by notice.
    expect(privacy).toContain(
      '시장 방문 기록은 정당한 이익(「개인정보 보호법」 제15조 제1항 제6호)을 근거로 동의를 받지 않고 처리하며',
    );
    // The manual backups go when their purpose ends (docs/OPERATIONS.md).
    expect(privacy).toContain(
      '운영자가 작업을 위해 따로 만든 백업(데이터베이스 덤프, 서버 디스크의 스냅샷)은 그 목적이 끝나면 지웁니다',
    );
  });

  it('privacy: the write and link records for a day, deleted hourly an hour past it (#187, 137-6)', () => {
    // One window for both: the figure printed is each one's.
    expect(LINK_REPEAT_WINDOW_SECONDS).toBe(WRITE_LIMIT_DAY_SECONDS);
    expect(text(PRIVACY)).toContain(
      `기록한 때부터 ${String(WRITE_LIMIT_DAY_SECONDS / 3_600)}시간 동안 쓰고, 그 뒤 한 시간이 더 지나면 매시간 하는 처리에서 지웁니다`,
    );
  });

  it("privacy: the officer by title, reached at the customer centre's address (133-5)", () => {
    const raw = legalDocumentStrings(PRIVACY);
    expect(raw).toContain('개인정보 보호책임자: {{privacyOfficer}}');
    expect(raw).toContain('이메일: {{email}}(고객센터와 같은 주소입니다)');
    expect(raw.join('\n')).not.toContain('{{phone}}');
    expect(copy.footerPrivacyOfficer).toContain('{{privacyOfficer}}');
    expect(copy.footerPrivacyOfficer).toContain('{{email}}');
  });

  it('privacy: sessions, the request log and the backups as the deployment keeps them (137-7, 339-1)', () => {
    const privacy = text(PRIVACY);
    expect(privacy).toContain('로그아웃하거나 탈퇴할 때 지웁니다');
    expect(privacy).toContain('만료된 세션은 그 쿠키로 다시 접속할 때 지우며');
    // #339 (ADR-0181): the expired sessions nobody returns to are kept for their period no more.
    expect(privacy).not.toContain('계정이 있는 동안 남습니다');
    expect(text(PRIVACY_2026_11_28)).toContain(
      '다시 접속하지 않은 만료 세션은 계정이 있는 동안 남습니다',
    );
    expect(privacy).toContain('서버 로그의 용량 한도 안에서 오래된 것부터 지우며');
    expect(privacy).toContain(`자동 백업은 지금 설정으로 최근 ${String(DAILY_BACKUPS_KEPT)}개까지`);
    // The figure is the infrastructure's current setting: a change there revises the policy.
    const variables = readFileSync(
      new URL('../../../../terraform/variables.tf', import.meta.url),
      'utf8',
    );
    const setting = /variable "snapshot_retention_count" \{[^}]*default\s*=\s*(\d+)/.exec(
      variables,
    );
    expect(Number(setting?.[1])).toBe(DAILY_BACKUPS_KEPT);
    // No statutory period the deployment does not keep (Q-PG-13, closed under D11).
    expect(privacy).not.toContain('3개월');
  });
});

/** Values no owner gave: each period a figure of its own, to find where the documents put it. */
const PROBE_DAYS: Readonly<Record<RetentionPeriod, number>> = {
  consent_records: 9001,
  phone_verification_records: 9002,
  deleted_posts: 9003,
  moderation_records: 9004,
  removed_profile_items: 9005,
  market_proposals: 9006,
  notifications: 9007,
  market_visits: 9008,
  expired_sessions: 9009,
};

/**
 * The periods the owner approved, in days (#137 오너 답 2, 2026-11-27, ADR-0176 결과 3; the
 * expired sessions' #339 오너 답 339-1, ADR-0181).
 */
const APPROVED_RETENTION_DAYS: Readonly<Record<RetentionPeriod, number>> = {
  consent_records: 1_095,
  phone_verification_records: 30,
  deleted_posts: 90,
  moderation_records: 90,
  removed_profile_items: 90,
  market_proposals: 30,
  notifications: 30,
  market_visits: 84,
  expired_sessions: 30,
};

/** Where the policy states each period: the moment it counts from, then the figure. */
const POLICY_SENTENCES: Readonly<Record<RetentionPeriod, readonly string[]>> = {
  consent_records: ['탈퇴한 뒤의 보관 기간은 탈퇴한 때부터 1,095일입니다.'],
  phone_verification_records: ['탈퇴한 뒤의 보관 기간은 탈퇴한 때부터 30일입니다.'],
  deleted_posts: [
    '작성자가 지운 글·댓글의 원문과 이전 수정 이력의 보관 기간은 지운 때(탈퇴한 작성자의 것은 탈퇴한 때, 수정 이력은 바뀐 때)부터 90일입니다.',
  ],
  moderation_records: [
    "반복 링크로 검토 목록에 오른 항목의 보관 기간은 오른 때와 운영자가 '확인함'으로 표시한 때 가운데 늦은 때부터 90일입니다.",
    '탈퇴한 회원의 것은 처리가 끝나야 지우며, 그 보관 기간은 탈퇴한 때와 처리된 때 가운데 늦은 때부터 90일입니다.',
  ],
  removed_profile_items: [
    '운영자가 지운 닉네임·소개·프로필 이미지의 보관 기간은 지운 때부터(탈퇴한 회원은 탈퇴한 때부터) 90일입니다.',
  ],
  market_proposals: [
    '탈퇴한 회원의 것은 처리가 끝나야 지우며, 그 보관 기간은 탈퇴한 때와 처리가 끝난 때 가운데 늦은 때부터 30일입니다.',
  ],
  notifications: ['보관 기간은 알림이 생긴 때부터 30일이며, 읽었는지와 상관없이 지웁니다.'],
  market_visits: [
    '보관 기간은 방문한 날 0시(한국 시각)부터 84일이며, 탈퇴한 뒤에도 그 기간까지 보관합니다.',
  ],
  expired_sessions: ['다시 접속하지 않은 만료 세션의 보관 기간은 만료된 때부터 30일입니다.'],
};

/**
 * The table rows that state each period, by the start of the row's first cell (the policy's 항목,
 * the consent text's 목적). Several periods share a figure (30 and 90 days) and the verification
 * and consent records share a sentence, so a figure in the text does not say which row reads which
 * period: these rows do, with PROBE_DAYS giving each period a figure of its own.
 */
const POLICY_ROWS: Readonly<Record<RetentionPeriod, readonly string[]>> = {
  consent_records: ['동의 기록('],
  phone_verification_records: ['인증번호를 보낸 기록('],
  deleted_posts: ['근거 글, 댓글과 그 수정 이력'],
  moderation_records: ['작성 빈도와 링크 사용 기록(', '신고('],
  removed_profile_items: ['닉네임, 소개, 프로필 이미지'],
  market_proposals: ['시장 제안('],
  notifications: ['알림'],
  market_visits: ['시장 방문 기록('],
  expired_sessions: ['세션 정보('],
};
const CONSENT_ROWS: Readonly<Partial<Record<RetentionPeriod, readonly string[]>>> = {
  phone_verification_records: ['본인확인('],
  consent_records: ['동의 기록의 관리'],
};

/** Each listed row states its own period's probe figure in its last cell, and no other period's. */
function expectPeriodRows(
  name: string,
  doc: LegalDocument,
  rows: Readonly<Partial<Record<RetentionPeriod, readonly string[]>>>,
): void {
  const blocks = [
    ...doc.intro,
    ...doc.sections.flatMap((section) => section.blocks),
    ...doc.addendum,
  ];
  const all = blocks.flatMap((block) => (block.kind === 'table' ? block.rows : []));
  for (const period of RETENTION_PERIODS) {
    for (const start of rows[period] ?? []) {
      const matching = all.filter((row) => row[0]?.startsWith(start));
      expect(matching, `${name}: ${start}`).toHaveLength(1);
      const kept = matching[0]?.at(-1) ?? '';
      const stated = RETENTION_PERIODS.filter((other) =>
        kept.includes(`${PROBE_DAYS[other].toLocaleString('ko-KR')}일`),
      );
      expect(stated, `${name}: ${start}`).toEqual([period]);
    }
  }
}

describe('the retention periods the documents state (133-8, 137-5)', () => {
  it('states every period in the policy, and the two the consent text names there too', async () => {
    vi.resetModules();
    vi.doMock('@buddha/shared', async (importOriginal) => ({
      ...(await importOriginal<typeof SharedModule>()),
      POLICY_RETENTION_DAYS: PROBE_DAYS,
    }));
    try {
      const { PRIVACY: privacy } = await import('./privacy');
      const { PRIVACY_CONSENT_TEXT: consent } = await import('./consent-texts');
      const policy = text(privacy);
      for (const period of RETENTION_PERIODS) {
        // In its own rows and nowhere else.
        const days = `${PROBE_DAYS[period].toLocaleString('ko-KR')}일`;
        expect(policy.split(days).length - 1, period).toBe(POLICY_ROWS[period].length);
      }
      expectPeriodRows('policy', privacy, POLICY_ROWS);
      expectPeriodRows('consent', consent, CONSENT_ROWS);
      const consentText = text(consent);
      for (const period of ['phone_verification_records', 'consent_records'] as const) {
        const days = `탈퇴한 때부터 ${PROBE_DAYS[period].toLocaleString('ko-KR')}일`;
        expect(consentText, period).toContain(days);
        expect(policy, period).toContain(days);
      }
      expect(consentText).not.toContain(`보관 기간은 ${UNDECIDED}`);
      // With every period a figure, the raw strings hold no 미정 (asserted of the approved values below).
      expect(legalDocumentStrings(privacy).join('\n')).not.toContain(UNDECIDED);
      expect(legalDocumentStrings(consent).join('\n')).not.toContain(UNDECIDED);
      // A deleted post's period counts from the withdrawal for a withdrawn author, as the purge.
      expect(policy).toContain(
        `지운 때(탈퇴한 작성자의 것은 탈퇴한 때, 수정 이력은 바뀐 때)부터 ${PROBE_DAYS.deleted_posts.toLocaleString('ko-KR')}일`,
      );
    } finally {
      vi.doUnmock('@buddha/shared');
      vi.resetModules();
    }
  });

  it('reads 미정 in a whole sentence while a period is not approved', () => {
    const undecided = RETENTION_PERIODS.filter((period) => POLICY_RETENTION_DAYS[period] === null);
    // '보관 기간은 미정입니다.' or, in the notifications' and the visits' rows, '보관 기간은 미정이며, …'.
    if (undecided.length > 0) {
      expect(text(PRIVACY)).toMatch(new RegExp(`보관 기간은 ${UNDECIDED}(?:입니다|이며)`));
    }
    expect(text(PRIVACY_CONSENT_TEXT)).not.toContain('운영 정책으로 정한 보존기간');
  });

  it('보존기간에 미정이 없다', () => {
    // The owner-approved values (#137 오너 답 2, 2026-11-27, ADR-0176 결과 3), every period a figure.
    expect(Object.values(POLICY_RETENTION_DAYS)).not.toContain(null);
    expect(POLICY_RETENTION_DAYS).toEqual(APPROVED_RETENTION_DAYS);
    // No 미정 where a document speaks of how long it keeps a record. The raw strings: the business
    // facts not given yet (상호, the officer — 137-8, 133-5) still render 미정.
    const documents: [string, LegalDocument][] = [
      ...DOCUMENTS,
      ['privacy consent', PRIVACY_CONSENT_TEXT],
    ];
    for (const [name, doc] of documents) {
      const retention = legalDocumentStrings(doc).filter((string) =>
        /보관|보유 기간|보존/.test(string),
      );
      // The 환불정책 keeps no record of its own; the other three say how long theirs are kept.
      if (name !== 'refund') expect(retention.length, name).toBeGreaterThan(0);
      for (const string of retention) expect(string, name).not.toContain(UNDECIDED);
    }
    expect(legalDocumentStrings(PRIVACY).join('\n')).not.toContain(UNDECIDED);
    expect(legalDocumentStrings(PRIVACY_CONSENT_TEXT).join('\n')).not.toContain(UNDECIDED);
    // Each figure in the policy, after the moment it counts from, as members read it.
    const policy = text(PRIVACY);
    for (const period of RETENTION_PERIODS) {
      const days = `${APPROVED_RETENTION_DAYS[period].toLocaleString('ko-KR')}일`;
      expect(POLICY_SENTENCES[period].length, period).toBeGreaterThan(0);
      for (const sentence of POLICY_SENTENCES[period]) {
        expect(sentence, period).toContain(days);
        expect(policy, period).toContain(sentence);
      }
    }
    // The two the consent text names, in the policy's words.
    const consent = text(PRIVACY_CONSENT_TEXT);
    expect(consent).toContain('그 보관 기간은 탈퇴한 때부터 30일입니다.');
    expect(consent).toContain('탈퇴한 뒤의 보관 기간은 탈퇴한 때부터 1,095일입니다.');
  });
});

describe('footer and copy templates', () => {
  it('resolves every footer line', () => {
    expect(FOOTER_BUSINESS_LINES.length).toBeGreaterThan(0);
    for (const template of FOOTER_BUSINESS_LINES) {
      expect(templateKeys(template).length, template).toBeGreaterThan(0);
      expect(fillBusinessInfo(template)).not.toContain('{{');
    }
    expect(fillBusinessInfo(copy.footerCompany)).toBe(`상호: ${BUSINESS_INFO.companyName}`);
  });

  it('every copy string with a placeholder names a business fact', () => {
    const templated = Object.entries(copy).filter(([, value]) => value.includes('{{'));
    expect(templated.length).toBeGreaterThan(0);
    for (const [key, value] of templated) {
      expect(() => fillBusinessInfo(value), key).not.toThrow();
      expect(fillBusinessInfo(value), key).not.toContain('{{');
      expect(value, key).not.toMatch(PARTICLE_AFTER_PLACEHOLDER);
    }
  });
});

describe('sectionHeading', () => {
  it('numbers articles the 약관 way and policy sections with a decimal', () => {
    expect(sectionHeading('article', 0, '목적')).toBe('제1조(목적)');
    expect(sectionHeading('article', 11, '회사의 의무')).toBe('제12조(회사의 의무)');
    expect(sectionHeading('decimal', 2, '환불 요청 방법')).toBe('3. 환불 요청 방법');
  });
});

describe('mapLegalDocument', () => {
  it('reaches every string, nested list items and table cells included', () => {
    const doc: LegalDocument = {
      title: 't',
      numbering: 'decimal',
      intro: [paragraph('i')],
      sections: [
        {
          heading: 'h',
          blocks: [
            numbered('a', { text: 'b', items: ['b1', 'b2'] }),
            table('c', ['h1', 'h2'], [['r1', 'r2']]),
          ],
        },
      ],
      addendum: [paragraph('z')],
    };
    expect(legalDocumentStrings(doc)).toEqual([
      't',
      'i',
      'h',
      'a',
      'b',
      'b1',
      'b2',
      'c',
      'h1',
      'h2',
      'r1',
      'r2',
      'z',
    ]);
    const upper = mapLegalDocument(doc, (s) => s.toUpperCase());
    expect(upper.numbering).toBe('decimal');
    expect(upper.sections[0]?.blocks[0]).toEqual({
      kind: 'list',
      ordered: true,
      items: ['A', { text: 'B', items: ['B1', 'B2'] }],
    });
    expect(upper.sections[0]?.blocks[1]).toEqual({
      kind: 'table',
      caption: 'C',
      head: ['H1', 'H2'],
      rows: [['R1', 'R2']],
    });
  });

  it('resolves placeholders with values given explicitly', () => {
    const doc: LegalDocument = {
      title: '{{x}}',
      numbering: 'article',
      intro: [],
      sections: [],
      addendum: [],
    };
    expect(resolveLegalDocument(doc, { x: 'X' }).title).toBe('X');
    expect(() => resolveLegalDocument(doc)).toThrow(UnknownTemplateKeyError);
  });
});
