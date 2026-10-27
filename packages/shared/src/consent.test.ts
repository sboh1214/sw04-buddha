import { describe, expect, it } from 'vitest';
import {
  CONSENT_DOCUMENTS,
  CONSENT_ITEMS,
  CONSENT_VERSION_MAX_LENGTH,
  REQUIRED_CONSENT_ITEMS,
  consentAgreed,
  consentAnswerStands,
  consentItemsToAsk,
  consentRecordSchema,
  consentVersionHolds,
  currentConsentVersion,
  missingConsents,
  recordConsentsBodySchema,
  type ConsentDocument,
  type ConsentDocuments,
  type ConsentItem,
} from './consent.js';

const current = (item: ConsentItem) => currentConsentVersion(item);

/** A body with every item answered at its current version, the optional ones as given. */
function body(marketing: boolean, overrides: Record<string, unknown> = {}) {
  return {
    consents: {
      terms: { version: current('terms'), agreed: true },
      privacy: { version: current('privacy'), agreed: true },
      age: { version: current('age'), agreed: true },
      marketing: { version: current('marketing'), agreed: marketing },
      ...overrides,
    },
    expectedAccountId: 'u1',
  };
}

describe('consent items (#57-4·#57-5)', () => {
  it('requires the terms, the privacy collection and the age check, and not the marketing', () => {
    expect(CONSENT_ITEMS).toEqual(['terms', 'privacy', 'age', 'marketing']);
    expect(REQUIRED_CONSENT_ITEMS).toEqual(['terms', 'privacy', 'age']);
    expect(CONSENT_DOCUMENTS.marketing.required).toBe(false);
  });

  it('names every version once per item, within the stored width, the current one last', () => {
    for (const item of CONSENT_ITEMS) {
      const versions = CONSENT_DOCUMENTS[item].versions.map((v) => v.version);
      expect(new Set(versions).size, item).toBe(versions.length);
      for (const version of versions) {
        expect(version.length, item).toBeLessThanOrEqual(CONSENT_VERSION_MAX_LENGTH);
        // An effective date, or a draft of the day the text was fixed (decision 4 #58).
        expect(version, item).toMatch(/^(draft-)?\d{4}-\d{2}-\d{2}$/);
      }
      expect(current(item)).toBe(versions[versions.length - 1]);
    }
  });
});

describe('missingConsents', () => {
  it('is empty once every required item is agreed at a version that holds', () => {
    const answers = REQUIRED_CONSENT_ITEMS.map((item) => ({
      item,
      version: current(item),
      agreed: true,
    }));
    expect(missingConsents(answers)).toEqual([]);
    // The marketing answer changes nothing either way.
    expect(
      missingConsents([
        ...answers,
        { item: 'marketing', version: current('marketing'), agreed: false },
      ]),
    ).toEqual([]);
  });

  it('names the required items with no agreement, in order', () => {
    expect(missingConsents([])).toEqual(['terms', 'privacy', 'age']);
    expect(
      missingConsents([{ item: 'privacy', version: current('privacy'), agreed: true }]),
    ).toEqual(['terms', 'age']);
  });

  it('counts neither a refusal, nor a version the list does not know', () => {
    expect(
      missingConsents([
        { item: 'terms', version: current('terms'), agreed: false },
        { item: 'privacy', version: 'draft-1999-01-01', agreed: true },
        { item: 'age', version: current('age'), agreed: true },
      ]),
    ).toEqual(['terms', 'privacy']);
  });
});

describe('re-consent after a revision (#57-5)', () => {
  /** CONSENT_DOCUMENTS with `terms` revised as given. */
  const revised = (versions: ConsentDocument['versions']): ConsentDocuments => ({
    ...CONSENT_DOCUMENTS,
    terms: { required: true, versions },
  });

  it('asks again after a revision that changes members’ rights', () => {
    const before = current('terms');
    const documents = revised([
      { version: before, requiresReconsent: true },
      { version: '2027-01-01', requiresReconsent: true },
    ]);
    expect(currentConsentVersion('terms', documents)).toBe('2027-01-01');
    expect(consentVersionHolds('terms', before, documents)).toBe(false);
    expect(consentVersionHolds('terms', '2027-01-01', documents)).toBe(true);
    const agreedBefore = REQUIRED_CONSENT_ITEMS.map((item) => ({
      item,
      version: current(item),
      agreed: true,
    }));
    expect(missingConsents(agreedBefore, documents)).toEqual(['terms']);
    expect(
      missingConsents(
        [...agreedBefore, { item: 'terms', version: '2027-01-01', agreed: true }],
        documents,
      ),
    ).toEqual([]);
  });

  it('only announces any other revision: the earlier agreement still holds', () => {
    const before = current('terms');
    expect(
      consentVersionHolds(
        'terms',
        before,
        revised([
          { version: before, requiresReconsent: true },
          { version: '2027-01-01', requiresReconsent: false },
        ]),
      ),
    ).toBe(true);
    // The newest revision that changed rights is the floor: one before it does not hold.
    const documents = revised([
      { version: 'draft-2026-01-01', requiresReconsent: true },
      { version: before, requiresReconsent: true },
      { version: '2027-01-01', requiresReconsent: false },
    ]);
    expect(consentVersionHolds('terms', 'draft-2026-01-01', documents)).toBe(false);
    expect(consentVersionHolds('terms', before, documents)).toBe(true);
    expect(consentVersionHolds('terms', '2027-01-01', documents)).toBe(true);
  });

  it('needs everybody’s agreement to an item’s first version whatever its flag says', () => {
    const documents = revised([{ version: 'draft-2030-01-01', requiresReconsent: false }]);
    expect(consentVersionHolds('terms', 'draft-2030-01-01', documents)).toBe(true);
    expect(missingConsents([], documents)).toContain('terms');
  });

  it('never makes an optional item a condition', () => {
    const documents: ConsentDocuments = {
      ...CONSENT_DOCUMENTS,
      marketing: {
        required: false,
        versions: [
          { version: current('marketing'), requiresReconsent: true },
          { version: '2027-01-01', requiresReconsent: true },
        ],
      },
    };
    const agreed = REQUIRED_CONSENT_ITEMS.map((item) => ({
      item,
      version: current(item),
      agreed: true,
    }));
    expect(missingConsents(agreed, documents)).toEqual([]);
    expect(consentVersionHolds('marketing', current('marketing'), documents)).toBe(false);
  });
});

describe('consentItemsToAsk (오너 결정 2026-10-19 (2차) 1)', () => {
  const agreedToAll = CONSENT_ITEMS.map((item) => ({
    item,
    version: current(item),
    agreed: true,
  }));
  /** CONSENT_DOCUMENTS with `item` revised to a version that changes members' rights. */
  const revisedRights = (item: ConsentItem): ConsentDocuments => ({
    ...CONSENT_DOCUMENTS,
    [item]: {
      required: CONSENT_DOCUMENTS[item].required,
      versions: [
        { version: current(item), requiresReconsent: true },
        { version: '2027-01-01', requiresReconsent: true },
      ],
    },
  });

  it('asks every item the first time, the marketing one included', () => {
    expect(consentItemsToAsk([])).toEqual(['terms', 'privacy', 'age', 'marketing']);
    expect(consentAnswerStands('marketing', undefined)).toBe(false);
  });

  it('asks nothing once every answer stands, the marketing refusal included', () => {
    expect(consentItemsToAsk(agreedToAll)).toEqual([]);
    const declined = agreedToAll.map((answer) =>
      answer.item === 'marketing' ? { ...answer, agreed: false } : answer,
    );
    expect(consentItemsToAsk(declined)).toEqual([]);
  });

  it('asks again only the items a revision that changed rights left behind', () => {
    // The terms revised: only the terms, and the marketing answer stays as it was either way.
    for (const marketing of [true, false]) {
      const answers = agreedToAll.map((answer) =>
        answer.item === 'marketing' ? { ...answer, agreed: marketing } : answer,
      );
      expect(consentItemsToAsk(answers, revisedRights('terms'))).toEqual(['terms']);
      expect(consentAgreed('marketing', answers, revisedRights('terms'))).toBe(marketing);
    }
    // A revision that only announces asks nothing.
    const announced: ConsentDocuments = {
      ...CONSENT_DOCUMENTS,
      privacy: {
        required: true,
        versions: [
          { version: current('privacy'), requiresReconsent: true },
          { version: '2027-01-01', requiresReconsent: false },
        ],
      },
    };
    expect(consentItemsToAsk(agreedToAll, announced)).toEqual([]);
  });

  it('asks the marketing item again only for an opt-in its own revision left behind', () => {
    const documents = revisedRights('marketing');
    expect(consentItemsToAsk(agreedToAll, documents)).toEqual(['marketing']);
    expect(consentAgreed('marketing', agreedToAll, documents)).toBe(false);
    // A refusal agrees to nothing a revision could change: it stands.
    const declined = agreedToAll.map((answer) =>
      answer.item === 'marketing' ? { ...answer, agreed: false } : answer,
    );
    expect(consentItemsToAsk(declined, documents)).toEqual([]);
    // Never a condition of the onboarding (`missingConsents`).
    expect(missingConsents(agreedToAll, documents)).toEqual([]);
  });

  it('reads the newest answer to each item: a later entry replaces an earlier one', () => {
    const marketing = (agreed: boolean) => ({
      item: 'marketing' as const,
      version: current('marketing'),
      agreed,
    });
    expect(consentAgreed('marketing', [marketing(true), marketing(false)])).toBe(false);
    expect(consentAgreed('marketing', [marketing(false), marketing(true)])).toBe(true);
    expect(consentAgreed('marketing', [])).toBe(false);
    expect(consentAgreed('marketing', [{ ...marketing(true), version: 'draft-1999-01-01' }])).toBe(
      false,
    );
  });
});

describe('recordConsentsBodySchema', () => {
  it('takes every item at its current version, the optional one either way', () => {
    expect(recordConsentsBodySchema.parse(body(false))).toEqual(body(false));
    expect(recordConsentsBodySchema.parse(body(true))).toEqual(body(true));
  });

  it('refuses a required item unchecked: the step cannot go on (#57-5)', () => {
    for (const item of REQUIRED_CONSENT_ITEMS) {
      const result = recordConsentsBodySchema.safeParse(
        body(true, { [item]: { version: current(item), agreed: false } }),
      );
      expect(result.success, item).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['consents', item, 'agreed']);
    }
  });

  it('refuses a version that is not the current one, and a body that answers nothing', () => {
    const stale = recordConsentsBodySchema.safeParse(
      body(true, { terms: { version: 'draft-1999-01-01', agreed: true } }),
    );
    expect(stale.success).toBe(false);
    expect(stale.error?.issues[0]?.path).toEqual(['consents', 'terms', 'version']);
    expect(
      recordConsentsBodySchema.safeParse({ consents: {}, expectedAccountId: 'u1' }).success,
    ).toBe(false);
    expect(
      recordConsentsBodySchema.safeParse({ ...body(true), expectedAccountId: '' }).success,
    ).toBe(false);
  });

  it('takes some items only: a re-consent’s, or MY 설정’s marketing answer alone', () => {
    // Which items a submission must answer is the server's to say (`consentItemsToAsk`).
    const reconsent = {
      consents: { terms: { version: current('terms'), agreed: true } },
      expectedAccountId: 'u1',
    };
    expect(recordConsentsBodySchema.parse(reconsent)).toEqual(reconsent);
    for (const agreed of [true, false]) {
      const marketing = {
        consents: { marketing: { version: current('marketing'), agreed } },
        expectedAccountId: 'u1',
      };
      expect(recordConsentsBodySchema.parse(marketing)).toEqual(marketing);
    }
  });

  it('describes a record as the account reads it, without the address or the browser', () => {
    const record = {
      item: 'marketing',
      version: current('marketing'),
      agreed: false,
      recordedAt: '2026-10-18T00:00:00.000Z',
    };
    expect(consentRecordSchema.parse(record)).toEqual(record);
    expect(Object.keys(consentRecordSchema.shape)).toEqual([
      'item',
      'version',
      'agreed',
      'recordedAt',
    ]);
  });
});
