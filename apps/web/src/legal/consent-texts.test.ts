import { createHash } from 'node:crypto';
import {
  CONSENT_DOCUMENTS,
  CONSENT_ITEMS,
  currentConsentVersion,
  findExcludedText,
  type ConsentItem,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { CONSENT_LABELS } from '@/lib/consent';
import { BUSINESS_INFO } from './business-info';
import { MARKETING_CONSENT_TEXT, PRIVACY_CONSENT_TEXT } from './consent-texts';
import { type LegalDocument, legalDocumentStrings, resolveLegalDocument } from './document';
import { PRIVACY } from './privacy';
import { TERMS } from './terms';
import { templateKeys } from './template';

/**
 * The onboarding's consent texts (#58, ADR-0072): written for the consent step, resolved like the
 * legal documents, held to the screen rules, and saying what the code collects and keeps. Last, the
 * guard that keeps a consent record honest: what each item's agreement is to is pinned to the
 * version it is recorded under.
 */

const TEXTS: [string, LegalDocument][] = [
  ['privacy', PRIVACY_CONSENT_TEXT],
  ['marketing', MARKETING_CONSENT_TEXT],
];

const KNOWN_KEYS = new Set(Object.keys(BUSINESS_INFO));
const PARTICLE_AFTER_PLACEHOLDER = /\}\}(?:이|가|은|는|을|를|과|와|로|으로)/;

describe.each(TEXTS)('consent text: %s', (name, text) => {
  const raw = legalDocumentStrings(text);
  const resolved = legalDocumentStrings(resolveLegalDocument(text));

  it('names only known business facts and resolves fully', () => {
    for (const string of raw) {
      for (const key of templateKeys(string))
        expect(KNOWN_KEYS, `${name}: ${string}`).toContain(key);
      expect(string, name).not.toMatch(PARTICLE_AFTER_PLACEHOLDER);
    }
    for (const string of resolved) {
      expect(string, name).not.toContain('{{');
      expect(string.trim(), name).not.toBe('');
    }
  });

  it('is screen text: nothing the plan leaves out (#113)', () => {
    for (const string of resolved) {
      expect(findExcludedText(string), `${name}: ${string}`).toEqual([]);
    }
  });

  it('is an intro only, under the title the step shows', () => {
    expect(text.sections).toEqual([]);
    expect(text.addendum).toEqual([]);
    expect(text.intro.length).toBeGreaterThan(0);
  });
});

describe('개인정보 수집·이용 동의 (the brief and ADR-0069 decision 1 #57-3·#57-5·#57-18)', () => {
  const privacy = legalDocumentStrings(resolveLegalDocument(PRIVACY_CONSENT_TEXT)).join('\n');

  it('names the items collected', () => {
    for (const item of ['실명', '휴대전화 번호', '이메일 주소', 'IP 주소', '브라우저 정보']) {
      expect(privacy).toContain(item);
    }
  });

  it('names what a social sign-up keeps: the provider’s member id, the name and the picture', () => {
    // better-auth keeps them for Google, Kakao and Naver (`account.account_id`, `user.name`,
    // `user.image`), and /privacy lists them; the consent to collection must not leave them out.
    expect(privacy).toContain('소셜 로그인 제공자(Google, 카카오, 네이버)가 발급한 회원 식별자');
    expect(privacy).toContain('이름(닉네임)과 프로필 사진 주소');
  });

  it('names the purposes: 본인확인, the start Coin once per number, 문의 대응', () => {
    expect(privacy).toContain('본인확인');
    expect(privacy).toContain('휴대전화 번호마다 한 번인 시작 Coin 지급의 확인');
    expect(privacy).toContain('문의 대응');
  });

  it('names the SMS processor (알리고) and what it receives', () => {
    expect(privacy).toContain('알리고(㈜알리는사람들)');
    expect(privacy).toContain('휴대전화 번호와 문자의 내용');
  });

  it('says how long: until withdrawal, the retention-period records after it, the number hash', () => {
    expect(privacy).toContain('탈퇴하면 위 개인정보를 지체 없이 파기합니다');
    expect(privacy).toContain('운영 정책으로 정한 보존기간');
    expect(privacy).toContain('원래 번호를 알아낼 수 없는 형태');
  });

  it('says it may be refused, and that refusing it ends the sign-up', () => {
    expect(privacy).toContain('동의하지 않을 수 있습니다');
    expect(privacy).toContain('동의하지 않으면 회원 가입을 마칠 수 없습니다');
  });
});

describe('마케팅 정보 수신 동의', () => {
  const marketing = legalDocumentStrings(resolveLegalDocument(MARKETING_CONSENT_TEXT)).join('\n');

  it('is optional, says nothing is sent yet, and how to withdraw it', () => {
    expect(marketing).toContain('선택');
    expect(marketing).toContain('동의하지 않아도 서비스를 이용할 수 있습니다');
    expect(marketing).toContain('지금은 마케팅 정보를 보내지 않습니다');
    expect(marketing).toContain('철회');
  });
});

/**
 * What an agreement to each item is an agreement to: its line on the consent step and its text —
 * /terms for the terms, the consent text and /privacy for the privacy item, the consent text for
 * the marketing item, the line alone for the age check. The raw strings, placeholders unfilled:
 * entering a business fact the owner supplies (상호, 시행일) is no new wording.
 */
const AGREED_TO: Readonly<Record<ConsentItem, readonly string[]>> = {
  terms: [CONSENT_LABELS.terms, ...legalDocumentStrings(TERMS)],
  privacy: [
    CONSENT_LABELS.privacy,
    ...legalDocumentStrings(PRIVACY_CONSENT_TEXT),
    ...legalDocumentStrings(PRIVACY),
  ],
  age: [CONSENT_LABELS.age],
  marketing: [CONSENT_LABELS.marketing, ...legalDocumentStrings(MARKETING_CONSENT_TEXT)],
};

function fingerprint(strings: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(strings)).digest('hex').slice(0, 16);
}

/**
 * Each item's current version and the fingerprint of the words it stands for. A consent record
 * names a version and never the words, so the words of a version must never change (consent.ts
 * `ConsentVersion.version`). When this fails, the text an item's agreement covers was edited: add a
 * version to that item in CONSENT_DOCUMENTS (@buddha/shared) — `requiresReconsent: true` if the
 * revision changes members' rights, which sends every account back to the consent step at its next
 * sign-in (#57-5) — then pin the new version and fingerprint here.
 */
const PINNED: Readonly<Record<ConsentItem, { version: string; fingerprint: string }>> = {
  terms: { version: 'draft-2026-10-18', fingerprint: '345fbea9be0f9e51' },
  privacy: { version: 'draft-2026-10-18', fingerprint: 'dd3b9600ec3fb20e' },
  age: { version: 'draft-2026-10-18', fingerprint: '2b86fed295e0c120' },
  marketing: { version: 'draft-2026-10-18', fingerprint: 'edfc60bf8b245a0a' },
};

describe('the consent versions (#57-5)', () => {
  it.each(CONSENT_ITEMS)(
    '%s: the words agreed to are the ones its current version stands for',
    (item) => {
      expect({
        version: currentConsentVersion(item),
        fingerprint: fingerprint(AGREED_TO[item]),
      }).toEqual(PINNED[item]);
    },
  );

  it('records the documents as they stand while their effective date is undecided (decision 4 #58)', () => {
    // `draft-` and the day the text was fixed until #137 sets a 시행일; then `YYYY-MM-DD`.
    expect(BUSINESS_INFO.effectiveDate).toBe('미정');
    for (const item of CONSENT_ITEMS) {
      for (const { version } of CONSENT_DOCUMENTS[item].versions) {
        expect(version).toMatch(/^(?:draft-)?\d{4}-\d{2}-\d{2}$/);
      }
    }
  });
});
