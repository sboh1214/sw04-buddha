import {
  CONSENT_DOCUMENTS,
  CONSENT_ITEMS,
  currentConsentVersion,
  recordConsentsBodySchema,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { BUSINESS_INFO } from '@/legal/business-info';
import { E2E_CONSENT_VERSIONS } from '../../e2e/consent-versions';
import { ApiError } from './api';
import {
  CONSENT_LABELS,
  NO_CONSENTS,
  allConsentState,
  consentBody,
  consentFailure,
  consentTag,
  isRequiredConsent,
  missingRequiredConsents,
  withAllConsents,
} from './consent';

/**
 * The consent step's rules (#58, ADR-0069 decision 1 #57-4·#57-5) as the screen applies them, held
 * to the shared table the server checks the body against (`CONSENT_DOCUMENTS`,
 * `recordConsentsBodySchema`): which items there are, which are required, which version is sent.
 */

const refused = (status: number, code: string, details?: unknown) =>
  new ApiError(status, {
    code: code as never,
    message: 'x',
    ...(details === undefined ? {} : { details }),
  });

describe('the consent items', () => {
  it("are the owner's four: three required, the marketing one optional (#57-5)", () => {
    expect([...CONSENT_ITEMS]).toEqual(['terms', 'privacy', 'age', 'marketing']);
    expect(CONSENT_ITEMS.filter(isRequiredConsent)).toEqual(['terms', 'privacy', 'age']);
    expect(consentTag('terms')).toBe(copy.consentRequiredTag);
    expect(consentTag('marketing')).toBe(copy.consentOptionalTag);
  });

  it("say the age check in the owner's words, the age the legal documents name (#57-4)", () => {
    expect(CONSENT_LABELS.age).toBe('만 14세 이상입니다');
    expect(CONSENT_LABELS.age).toContain(`만 ${BUSINESS_INFO.minimumAge}세`);
  });

  it('give every item its own line and no refund policy item (D9)', () => {
    const labels = CONSENT_ITEMS.map((item) => CONSENT_LABELS[item]);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label).not.toContain('환불');
  });
});

describe('전체 동의', () => {
  it('starts with every box empty, the optional one included', () => {
    expect(NO_CONSENTS).toEqual({ terms: false, privacy: false, age: false, marketing: false });
    expect(allConsentState(NO_CONSENTS)).toBe(false);
  });

  it('checks and clears all four, and shows the mixed state in between', () => {
    expect(withAllConsents(true)).toEqual({
      terms: true,
      privacy: true,
      age: true,
      marketing: true,
    });
    expect(allConsentState(withAllConsents(true))).toBe(true);
    expect(withAllConsents(false)).toEqual(NO_CONSENTS);
    expect(allConsentState({ ...NO_CONSENTS, privacy: true })).toBe('indeterminate');
    expect(allConsentState({ ...withAllConsents(true), marketing: false })).toBe('indeterminate');
  });
});

describe('consentBody', () => {
  it('sends nothing while a required item is unchecked, naming them in order', () => {
    const choices = { ...NO_CONSENTS, privacy: true, marketing: true };
    expect(missingRequiredConsents(choices)).toEqual(['terms', 'age']);
    expect(consentBody(choices, 'user-1')).toBeNull();
  });

  it('answers every item at its current version, the optional one either way', () => {
    for (const marketing of [true, false]) {
      const body = consentBody({ terms: true, privacy: true, age: true, marketing }, 'user-1');
      expect(body).not.toBeNull();
      // Exactly what the server parses the body with.
      expect(recordConsentsBodySchema.parse(body)).toEqual(body);
      for (const item of CONSENT_ITEMS) {
        expect(body?.consents[item].version).toBe(currentConsentVersion(item));
      }
      expect(body?.consents.marketing.agreed).toBe(marketing);
      expect(body?.expectedAccountId).toBe('user-1');
    }
  });

  it("is what the e2e specs' API-level onboarding sends (e2e/consent-versions.ts)", () => {
    for (const item of CONSENT_ITEMS) {
      expect(E2E_CONSENT_VERSIONS[item], item).toBe(currentConsentVersion(item));
    }
  });

  it('follows the shared table: a required item is one CONSENT_DOCUMENTS requires', () => {
    for (const item of CONSENT_ITEMS) {
      expect(isRequiredConsent(item)).toBe(CONSENT_DOCUMENTS[item].required);
    }
  });
});

describe('consentFailure', () => {
  it('asks for a reload when the screen showed an older version than the server asks for', () => {
    const outdated = refused(400, 'VALIDATION_ERROR', [
      { path: ['consents', 'terms', 'version'], message: 'Invalid input' },
    ]);
    expect(consentFailure(outdated)).toBe(copy.errConsentOutdated);
  });

  it('says the required items for any other validation refusal, the session switch, the rest', () => {
    const notAgreed = refused(400, 'VALIDATION_ERROR', [
      { path: ['consents', 'age', 'agreed'], message: 'Invalid input' },
    ]);
    expect(consentFailure(notAgreed)).toBe(copy.errConsentRequired);
    const another = refused(403, 'FORBIDDEN', [
      { path: ['expectedAccountId'], message: 'session belongs to another account' },
    ]);
    expect(consentFailure(another)).toBe(copy.sessionChanged);
    expect(consentFailure(refused(500, 'INTERNAL'))).toBe(copy.errUnknown);
    expect(consentFailure(new TypeError('Failed to fetch'))).toBe(copy.errUnknown);
  });
});
