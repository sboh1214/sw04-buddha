import { PAYMENT_REFUND_WINDOW_DAYS } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  BUSINESS_INFO,
  FOOTER_BUSINESS_LINES,
  OWNER_SUPPLIED_KEYS,
  UNDECIDED,
  fillBusinessInfo,
} from './business-info';
import {
  type LegalDocument,
  legalDocumentStrings,
  mapLegalDocument,
  numbered,
  paragraph,
  resolveLegalDocument,
  sectionHeading,
  table,
} from './document';
import { LEGAL_CASH_NOTICE } from './cash-notice';
import { PRIVACY } from './privacy';
import { REFUND } from './refund';
import { TERMS } from './terms';
import { UnknownTemplateKeyError, fillTemplate, templateKeys } from './template';

// PLAN Appendix A, the same list copy.test.ts enforces on `copy`.
const FORBIDDEN_WORDS = ['베팅', '배당', '배당률', '승률', '판돈', '당첨'];

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

  it('has every fact the owner has to supply', () => {
    for (const key of OWNER_SUPPLIED_KEYS) expect(BUSINESS_INFO).toHaveProperty(key);
    expect(UNDECIDED).toBe('미정');
  });

  it('takes the decided facts from the code, not from a second copy', () => {
    expect(BUSINESS_INFO.serviceName).toBe(copy.appName);
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

  it('has no empty strings and no gambling vocabulary (PLAN Appendix A)', () => {
    for (const text of resolved) {
      expect(text.trim(), name).not.toBe('');
      for (const word of FORBIDDEN_WORDS) expect(text, name).not.toContain(word);
    }
  });

  it('has sections with distinct headings and a dated addendum', () => {
    expect(doc.sections.length).toBeGreaterThan(0);
    const headings = doc.sections.map((section) => section.heading);
    expect(new Set(headings).size).toBe(headings.length);
    for (const section of doc.sections) expect(section.blocks.length).toBeGreaterThan(0);
    expect(legalDocumentStrings({ ...doc, intro: [], sections: [] })).toContain(
      '시행일: {{effectiveDate}}',
    );
  });
});

describe('LEGAL_CASH_NOTICE', () => {
  it('keeps the sentence the documents were written with, apart from the wallet notice', () => {
    // The 이용약관 and the 환불정책 change only with their own revision (#137); the wallet's
    // notice no longer speaks of charging (#112, ADR-0049).
    expect(LEGAL_CASH_NOTICE).toBe(
      '충전한 P는 서비스 내에서만 사용할 수 있으며, 현금으로 환전하거나 출금할 수 없습니다.',
    );
    expect(copy.walletNotice).not.toBe(LEGAL_CASH_NOTICE);
  });
});

describe('legal document contents (owner decisions 2026-09-28)', () => {
  const text = (doc: LegalDocument) => legalDocumentStrings(resolveLegalDocument(doc)).join('\n');

  it('refund: the 7-day, unused-only, full-cancel rule and the non-refundable P', () => {
    const refund = text(REFUND);
    expect(refund).toContain(`${String(PAYMENT_REFUND_WINDOW_DAYS)}일`);
    expect(refund).toContain('전혀 쓰지 않았을 것');
    expect(refund).toContain('사용 가능 잔고');
    expect(refund).toContain('실제로 결제한 금액 전액');
    expect(refund).toContain('P 전부가 잔고에서 차감');
    expect(refund).toContain('부분 환불은 하지 않습니다');
    expect(refund).toContain('쿠폰');
    expect(refund).toContain('정산');
    // The no-cash sentence, verbatim (PLAN Appendix A) — the one the document was written with,
    // whatever the wallet now says (#112: the documents change only with #137).
    expect(refund).toContain(LEGAL_CASH_NOTICE);
    expect(refund).toContain('원래 결제 수단');
  });

  it('refund: both conditions judged when the refund is processed, with the processing time', () => {
    const refund = text(REFUND);
    // The admin refund checks the window on the DB clock at processing time
    // (ADR-0042 「관리자 환불」).
    expect(refund).toContain('회사가 환불을 처리하는 시점을 기준으로 판단');
    expect(refund).toContain('결제가 승인된 시각부터 계산');
    expect(refund).toContain('여유를 두고 요청해 주세요');
    expect(refund).toContain(`요청의 처리 기한은 ${BUSINESS_INFO.refundProcessingTime}입니다`);
  });

  it("refund: payment errors and a minor's payment", () => {
    const refund = text(REFUND);
    // An unknown outcome or a failed net cancel is left for the 재통보 or an admin (ADR-0042
    // 「ReturnUrl」 step 4, 「망취소」), so not "always".
    expect(refund).toContain('원칙적으로 자동으로 취소됩니다');
    expect(refund).toContain('P를 충전하거나 결제를 취소하여 바로잡습니다');
    expect(refund).toContain('「민법」 제5조');
    expect(refund).toContain('법정대리인');
  });

  it('terms: age limit, contact details, PG, no cash value, expiry placeholder filled', () => {
    const terms = text(TERMS);
    expect(terms).toContain('만 14세 이상');
    expect(terms).toContain('실명과 휴대전화 번호');
    expect(terms).toContain('스마트로(주)');
    expect(terms).toContain(`${LEGAL_CASH_NOTICE} 결제 없이 받은 P도 같습니다.`);
    expect(terms).toContain(`P의 유효기간: ${BUSINESS_INFO.pointExpiry}`);
    expect(terms).toContain('환불정책');
    expect(terms).toContain('회사가 환불을 처리하는 시점을 기준으로 판단');
  });

  it('terms and privacy agree on card data and on when contact details are entered', () => {
    for (const doc of [text(TERMS), text(PRIVACY)]) {
      // The PG hands over a masked card number; the full number, expiry and password never.
      expect(doc).toContain('카드 번호 전체');
      expect(doc).toContain('회사는 이를 받거나 저장하지 않습니다');
      expect(doc).toContain('가입 과정에서 또는 서비스를 처음 이용하기 전에');
      expect(doc).not.toContain('처음 로그인할 때');
    }
    expect(text(TERMS)).toContain('일부가 가려진 번호뿐');
    expect(text(PRIVACY)).toContain('일부가 가려진 카드 번호');
  });

  it('privacy: items, statutory retention, processors, officer', () => {
    const privacy = text(PRIVACY);
    for (const item of ['실명', '휴대전화 번호', 'IP 주소', '닉네임', '이메일 주소']) {
      expect(privacy).toContain(item);
    }
    expect(privacy).toContain('회사는 이를 받거나 저장하지 않습니다');
    expect(privacy).toContain('5년');
    expect(privacy).toContain('3년');
    // Access records: why and for how long, with no period the deployment does not keep.
    expect(privacy).toContain('서비스 접속 기록(IP 주소, 접속 일시)');
    expect(privacy).toContain('그 목적에 필요한 기간 동안만 보관합니다');
    expect(privacy).not.toContain('3개월');
    expect(privacy).not.toContain('접속 기록을 보관합니다');
    expect(privacy).toContain('스마트로(주)');
    expect(privacy).toContain('Amazon Web Services');
    expect(privacy).toContain('서울');
    expect(privacy).toContain(`개인정보 보호책임자: ${BUSINESS_INFO.privacyOfficer}`);
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
