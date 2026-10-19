import * as z from 'zod';

/**
 * 약관 동의 (#58, ADR-0069 decision 1 #57-4·#57-5 and decision 4 #58): what a new account agrees
 * to before its 본인확인, item by item, and the record kept of it.
 *
 * - `terms`: 이용약관 (/terms), required.
 * - `privacy`: 개인정보 수집·이용 — the collection of the mobile number and the SMS delivery
 *   entrusted to the provider included (#57-5) — whose consent text the onboarding shows and which
 *   points at the 개인정보처리방침 (/privacy), required.
 * - `age`: '만 14세 이상입니다' (#57-4), a required self-check: no other verification of age.
 * - `marketing`: 마케팅 정보 수신, optional. Nothing sends marketing yet; the answer is recorded.
 *
 * The refund policy is not a consent item (paid Coin is closed, D9). The order is the order the
 * consent step lists them in.
 */
export const CONSENT_ITEMS = ['terms', 'privacy', 'age', 'marketing'] as const;
export type ConsentItem = (typeof CONSENT_ITEMS)[number];
export const consentItemSchema = z.enum(CONSENT_ITEMS).meta({ id: 'ConsentItem' });

/** `consent_records.version`: a version id is at most this long. */
export const CONSENT_VERSION_MAX_LENGTH = 32;

/**
 * `consent_records.user_agent`: the browser's `User-Agent` as the consent arrived with it (the
 * record's 기기 정보, #57-5), cut to this many characters — a header has no length bound of its
 * own, and the first few hundred characters name the browser and the device.
 */
export const CONSENT_USER_AGENT_MAX_LENGTH = 512;

/** One version of a consent item's text. */
export interface ConsentVersion {
  /**
   * What a consent record names (`consent_records.version`, at most CONSENT_VERSION_MAX_LENGTH):
   * the effective date `YYYY-MM-DD` once the document has one (시행일, #57-5), and while its
   * effective date is undecided (미정 — the documents as they stand before #137 revises them,
   * decision 4 #58), `draft-` and the day this text was fixed. Never reused for another text:
   * changing the words a member agrees to adds a version.
   */
  readonly version: string;
  /**
   * Whether this revision changes members' rights: then an account whose agreement is to an
   * earlier version must agree again at its next sign-in — the onboarding gate sends it to the
   * consent step — while any other revision is only announced (#57-5). The first version of an
   * item needs everybody's agreement whatever this says.
   */
  readonly requiresReconsent: boolean;
}

export interface ConsentDocument {
  /** Whether the consent step can go on without it (#57-5). */
  readonly required: boolean;
  /** Oldest first; the last one is current: the one the consent step shows and records. */
  readonly versions: readonly [ConsentVersion, ...ConsentVersion[]];
}

/**
 * The versions of every consent item. A revision appends a version — never rewrites one, since
 * records name them — with `requiresReconsent` saying whether accounts must agree again.
 *
 * The first versions are the documents as they stand on 2026-10-18 (decision 4 #58): /terms and
 * /privacy with their effective date still 미정, and the 개인정보 수집·이용 and 마케팅 정보 수신
 * consent texts #58 wrote. Each item has a version of its own, so revising one leaves the others'
 * agreements standing — but the consent step a revision sends an account back to still asks every
 * item, from empty boxes, and records each answer that changed: an earlier marketing opt-in left
 * unticked is recorded as withdrawn (ADR-0072 7-7, a question for the owner in 결과 4).
 */
export type ConsentDocuments = Readonly<Record<ConsentItem, ConsentDocument>>;

export const CONSENT_DOCUMENTS: ConsentDocuments = {
  terms: { required: true, versions: [{ version: 'draft-2026-10-18', requiresReconsent: true }] },
  privacy: { required: true, versions: [{ version: 'draft-2026-10-18', requiresReconsent: true }] },
  age: { required: true, versions: [{ version: 'draft-2026-10-18', requiresReconsent: true }] },
  marketing: {
    required: false,
    versions: [{ version: 'draft-2026-10-18', requiresReconsent: true }],
  },
};

/** The items the consent step cannot go on without (#57-5), in CONSENT_ITEMS order. */
export const REQUIRED_CONSENT_ITEMS: readonly ConsentItem[] = CONSENT_ITEMS.filter(
  (item) => CONSENT_DOCUMENTS[item].required,
);

/**
 * The version the consent step shows and records for `item`. `documents` is CONSENT_DOCUMENTS
 * outside the tests, which revise a copy.
 */
export function currentConsentVersion(
  item: ConsentItem,
  documents: ConsentDocuments = CONSENT_DOCUMENTS,
): string {
  const { versions } = documents[item];
  return versions[versions.length - 1]!.version;
}

/**
 * Where an agreement to `item` must be to count: the index of its newest version that changed
 * members' rights (the first version always counts as one). An agreement to that version or a
 * later one holds; one to an earlier version, or to a version the list does not know, does not.
 */
function floorIndex(item: ConsentItem, documents: ConsentDocuments): number {
  const { versions } = documents[item];
  let floor = 0;
  versions.forEach((version, index) => {
    if (version.requiresReconsent) floor = index;
  });
  return floor;
}

/**
 * Whether an answer to `item` at `version` still holds: the version is known and no later
 * revision that changed members' rights came after it.
 */
export function consentVersionHolds(
  item: ConsentItem,
  version: string,
  documents: ConsentDocuments = CONSENT_DOCUMENTS,
): boolean {
  const index = documents[item].versions.findIndex((v) => v.version === version);
  return index >= 0 && index >= floorIndex(item, documents);
}

/** What `missingConsents` reads of a record. */
export interface ConsentAnswer {
  readonly item: ConsentItem;
  readonly version: string;
  readonly agreed: boolean;
}

/**
 * The required items an account has no standing agreement to — none while every required item
 * has an agreed record whose version still holds (`consentVersionHolds`). Empty means its consent
 * step is done; a revision that changes members' rights puts the item back here for every account
 * that agreed only to earlier versions, which is how the re-consent at the next sign-in comes about
 * (#57-5). Required items cannot be refused (the body refuses that), so any agreed record counts.
 */
export function missingConsents(
  answers: Iterable<ConsentAnswer>,
  documents: ConsentDocuments = CONSENT_DOCUMENTS,
): ConsentItem[] {
  const agreed = new Set<ConsentItem>();
  for (const answer of answers) {
    if (answer.agreed && consentVersionHolds(answer.item, answer.version, documents)) {
      agreed.add(answer.item);
    }
  }
  return CONSENT_ITEMS.filter((item) => documents[item].required && !agreed.has(item));
}

const expectedAccountIdSchema = z.string().min(1).max(255);

/**
 * One item's answer as the consent step sends it: the version it showed — the current one only,
 * so a screen left open across a revision is refused (VALIDATION_ERROR on `version`) and shows the
 * new text rather than recording an agreement to the old — and whether it was checked: a required
 * item only checked (VALIDATION_ERROR on `agreed`: the step cannot go on, #57-5).
 */
function consentAnswerSchema(item: ConsentItem) {
  return z.object({
    version: z.literal(currentConsentVersion(item)),
    agreed: CONSENT_DOCUMENTS[item].required ? z.literal(true) : z.boolean(),
  });
}

/**
 * `POST /me/consents`: every item answered once. The server adds what the record keeps beside the
 * answers — the time (its clock), the client address (the rate limit's rule, TRUST_PROXY) and the
 * browser's User-Agent — and none of those come from the body.
 */
export const recordConsentsBodySchema = z
  .object({
    consents: z.object({
      terms: consentAnswerSchema('terms'),
      privacy: consentAnswerSchema('privacy'),
      age: consentAnswerSchema('age'),
      marketing: consentAnswerSchema('marketing'),
    }),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'RecordConsentsBody' });
export type RecordConsentsBody = z.infer<typeof recordConsentsBodySchema>;

/**
 * The account's newest answer to one item, as `GET /me` shows it to the account itself
 * (`onboarding.consents`). The client address and the User-Agent the record keeps are never
 * answered, the account's own `GET /me` included.
 */
export const consentRecordSchema = z
  .object({
    item: consentItemSchema,
    version: z.string().max(CONSENT_VERSION_MAX_LENGTH),
    agreed: z.boolean(),
    /** When the answer was recorded (the server's clock). */
    recordedAt: z.iso.datetime(),
  })
  .meta({ id: 'ConsentRecord' });
export type ConsentRecord = z.infer<typeof consentRecordSchema>;
