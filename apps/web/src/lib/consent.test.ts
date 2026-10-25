import { readFileSync } from 'node:fs';
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
  consentStepItems,
  consentTag,
  isRequiredConsent,
  marketingConsentBody,
  marketingConsentOn,
  marketingSwitchOn,
  missingRequiredConsents,
  withAllConsents,
} from './consent';

const ALL = CONSENT_ITEMS;
/** A newest answer as `GET /me` lists it. */
const answer = (item: (typeof CONSENT_ITEMS)[number], agreed = true, version?: string) => ({
  item,
  version: version ?? currentConsentVersion(item),
  agreed,
});

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

describe('the items the step asks (오너 결정 2026-10-19 (2차) 1)', () => {
  it('asks all four the first time', () => {
    expect(consentStepItems([])).toEqual(['terms', 'privacy', 'age', 'marketing']);
  });

  it('asks only what a revision left behind, keeping the marketing answer', () => {
    // The terms agreed to a version the list no longer holds: only the terms, whatever the
    // marketing answer was.
    for (const marketing of [true, false]) {
      const answers = [
        answer('terms', true, 'draft-1999-01-01'),
        answer('privacy'),
        answer('age'),
        answer('marketing', marketing),
      ];
      expect(consentStepItems(answers)).toEqual(['terms']);
      expect(marketingConsentOn(answers)).toBe(marketing);
    }
  });

  it('never shows an empty step: every item if nothing is left to ask', () => {
    expect(consentStepItems(ALL.map((item) => answer(item)))).toEqual(ALL);
  });
});

describe('전체 동의', () => {
  it('starts with every box empty, the optional one included', () => {
    expect(NO_CONSENTS).toEqual({ terms: false, privacy: false, age: false, marketing: false });
    expect(allConsentState(NO_CONSENTS, ALL)).toBe(false);
  });

  it('checks and clears every item shown, and shows the mixed state in between', () => {
    expect(withAllConsents(NO_CONSENTS, ALL, true)).toEqual({
      terms: true,
      privacy: true,
      age: true,
      marketing: true,
    });
    expect(allConsentState(withAllConsents(NO_CONSENTS, ALL, true), ALL)).toBe(true);
    expect(withAllConsents(withAllConsents(NO_CONSENTS, ALL, true), ALL, false)).toEqual(
      NO_CONSENTS,
    );
    expect(allConsentState({ ...NO_CONSENTS, privacy: true }, ALL)).toBe('indeterminate');
    expect(
      allConsentState({ ...withAllConsents(NO_CONSENTS, ALL, true), marketing: false }, ALL),
    ).toBe('indeterminate');
  });

  it('covers only the items shown in a re-consent', () => {
    const items = ['terms'] as const;
    expect(withAllConsents(NO_CONSENTS, items, true)).toEqual({ ...NO_CONSENTS, terms: true });
    expect(allConsentState({ ...NO_CONSENTS, terms: true }, items)).toBe(true);
  });
});

describe('consentBody', () => {
  it('sends nothing while a required item shown is unchecked, naming them in order', () => {
    const choices = { ...NO_CONSENTS, privacy: true, marketing: true };
    expect(missingRequiredConsents(choices, ALL)).toEqual(['terms', 'age']);
    expect(consentBody(choices, ALL, 'user-1')).toBeNull();
    // An item not shown is not the step's to miss.
    expect(missingRequiredConsents(choices, ['privacy', 'marketing'])).toEqual([]);
  });

  it('answers every item shown at its current version, the optional one either way', () => {
    for (const marketing of [true, false]) {
      const body = consentBody({ terms: true, privacy: true, age: true, marketing }, ALL, 'user-1');
      expect(body).not.toBeNull();
      // Exactly what the server parses the body with.
      expect(recordConsentsBodySchema.parse(body)).toEqual(body);
      for (const item of CONSENT_ITEMS) {
        expect(body?.consents[item]?.version).toBe(currentConsentVersion(item));
      }
      expect(body?.consents.marketing?.agreed).toBe(marketing);
      expect(body?.expectedAccountId).toBe('user-1');
    }
  });

  it('answers only the items a re-consent shows: the marketing answer is left as it was', () => {
    const body = consentBody({ ...NO_CONSENTS, terms: true }, ['terms'], 'user-1');
    expect(body).toEqual({
      consents: { terms: { version: currentConsentVersion('terms'), agreed: true } },
      expectedAccountId: 'user-1',
    });
    expect(recordConsentsBodySchema.parse(body)).toEqual(body);
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

describe('MY 설정의 마케팅 정보 수신 (오너 결정 2026-10-19 (2차) 4)', () => {
  it('is on while the newest marketing answer agrees to a version that holds', () => {
    expect(marketingConsentOn([])).toBe(false);
    expect(marketingConsentOn([answer('marketing')])).toBe(true);
    expect(marketingConsentOn([answer('marketing', false)])).toBe(false);
    expect(marketingConsentOn([answer('marketing', true, 'draft-1999-01-01')])).toBe(false);
  });

  it('sends the marketing answer alone, at the current version', () => {
    for (const agreed of [true, false]) {
      const body = marketingConsentBody(agreed, 'user-1');
      expect(body).toEqual({
        consents: { marketing: { version: currentConsentVersion('marketing'), agreed } },
        expectedAccountId: 'user-1',
      });
      expect(recordConsentsBodySchema.parse(body)).toEqual(body);
    }
  });

  it('shows the answer a press asked while it is out, and the account’s own otherwise — after a refusal too (ADR-0090)', () => {
    const off = [answer('marketing', false)];
    const on = [answer('marketing')];
    // Pressed: the asked answer, whatever the account's is.
    expect(marketingSwitchOn(off, true)).toBe(true);
    expect(marketingSwitchOn(on, false)).toBe(false);
    // Nothing asked — before any press, or a refusal dropped it: the server's answer.
    expect(marketingSwitchOn(off, null)).toBe(false);
    expect(marketingSwitchOn(on, null)).toBe(true);
    expect(marketingSwitchOn([answer('marketing', true, 'draft-1999-01-01')], null)).toBe(false);
  });

  it('drives the card’s switch, which drops the asked answer on every refusal and on new answers (ADR-0090)', () => {
    // No component renders under node: the card's wiring is pinned in its source. The switch is
    // `marketingSwitchOn`'s answer — not the account's alone, which a refusal leaves where it was,
    // so the switch's input stayed on the position the press gave it (checked, nothing recorded,
    // the next press swallowed) — and every refusal drops what was asked before anything else.
    // e2e onboarding.spec.ts and profile.spec.ts press it into a refusal.
    const card = readFileSync(
      new URL('../app/my/settings/marketing-section.tsx', import.meta.url),
      'utf8',
    );
    expect(card).toContain('const on = marketingSwitchOn(consents, asked);');
    expect(card).toContain('checked={on}');
    expect(card).toMatch(/setAsked\(agreed\);\s*try \{/);
    expect(card).toMatch(/\} catch \(error\) \{\s*(?:\/\/[^\n]*\n\s*)*setAsked\(null\);/);
    expect(card).not.toContain('marketingConsentOn(');
    // And once the account's answers change — the success's own record reaching the card, or a
    // refetch bringing another tab's — the asked answer goes too (ADR-0090 결정 4-4): kept, it
    // would show the pressed position over the server's newer one and the next press would send
    // that answer again. e2e onboarding.spec.ts brings another tab's answer in.
    expect(card).toMatch(
      /if \(consents !== shownConsents\) \{\s*setShownConsents\(consents\);\s*setAsked\(null\);\s*\}/,
    );
  });
});

describe('consentFailure', () => {
  it('asks for a reload when the screen showed an older version than the server asks for', () => {
    const outdated = refused(400, 'VALIDATION_ERROR', [
      { path: ['consents', 'terms', 'version'], message: 'Invalid input' },
    ]);
    expect(consentFailure(outdated)).toBe(copy.errConsentOutdated);
  });

  it('asks for a reload when the server asks an item the screen did not show', () => {
    const fewer = refused(400, 'VALIDATION_ERROR', [
      { path: ['consents', 'marketing'], message: 'this item is asked: answer it' },
    ]);
    expect(consentFailure(fewer)).toBe(copy.errConsentOutdated);
  });

  it('says the rate limit when the account answered too often (MY 설정’s switch)', () => {
    expect(consentFailure(refused(429, 'RATE_LIMITED', { retryAfterSeconds: 30 }))).toBe(
      copy.errConsentTooManyRequests,
    );
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
