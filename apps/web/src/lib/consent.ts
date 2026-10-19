import {
  CONSENT_DOCUMENTS,
  CONSENT_ITEMS,
  currentConsentVersion,
  type ConsentItem,
} from '@buddha/shared';
import { copy } from '@/copy';
import { isApiError, isForAnotherAccount, type ApiError, type RecordConsentsBody } from './api';

/**
 * The consent step of /onboarding (#58, ADR-0069 decision 1 #57-4·#57-5) as the screen reads it:
 * a checkbox per item and '전체 동의' over them, the body `POST /me/consents` takes, and what a
 * refusal of it means. Which items there are, which are required and which version each one is at
 * are @buddha/shared's (`CONSENT_DOCUMENTS`), the same table the server checks the body against.
 *
 * Kept out of the component so vitest can run it under its node environment.
 */

/** Whether each item is checked on screen. */
export type ConsentChoices = Readonly<Record<ConsentItem, boolean>>;

/**
 * Every box empty — how the step always starts, the re-consent after a revision included: an
 * agreement is a box the member checked on this screen, never one the screen checked for them
 * (and a pre-checked optional consent is no consent at all).
 */
export const NO_CONSENTS: ConsentChoices = {
  terms: false,
  privacy: false,
  age: false,
  marketing: false,
};

/** '전체 동의' as a tri-state: all checked, some, or none (Chakra's `indeterminate`). */
export function allConsentState(choices: ConsentChoices): boolean | 'indeterminate' {
  const checked = CONSENT_ITEMS.filter((item) => choices[item]).length;
  if (checked === CONSENT_ITEMS.length) return true;
  return checked === 0 ? false : 'indeterminate';
}

/** '전체 동의' pressed: every item, the optional one included, takes its state (#57-5). */
export function withAllConsents(checked: boolean): ConsentChoices {
  return { terms: checked, privacy: checked, age: checked, marketing: checked };
}

/** Whether `item` must be agreed for the step to go on (#57-5). */
export function isRequiredConsent(item: ConsentItem): boolean {
  return CONSENT_DOCUMENTS[item].required;
}

/** The required items left unchecked, in the order the step lists them. */
export function missingRequiredConsents(choices: ConsentChoices): ConsentItem[] {
  return CONSENT_ITEMS.filter((item) => isRequiredConsent(item) && !choices[item]);
}

/**
 * `POST /me/consents`: every item answered at the version this screen shows (the current one), and
 * the account on screen. Null while a required item is unchecked — the step does not send then
 * (the server would refuse it as well).
 */
export function consentBody(
  choices: ConsentChoices,
  expectedAccountId: string,
): RecordConsentsBody | null {
  if (missingRequiredConsents(choices).length > 0) return null;
  const answer = (item: ConsentItem) => ({
    version: currentConsentVersion(item),
    agreed: choices[item],
  });
  // The generated type pins each version to its literal and a required item's `agreed` to `true`
  // (the body schema's own `z.literal`s): `currentConsentVersion` is that literal, and the check
  // above is what makes every required answer `true`.
  return {
    consents: {
      terms: answer('terms'),
      privacy: answer('privacy'),
      age: answer('age'),
      marketing: answer('marketing'),
    },
    expectedAccountId,
  } as RecordConsentsBody;
}

/** Each item's line beside its checkbox. The age line is the owner's own words (#57-4). */
export const CONSENT_LABELS: Readonly<Record<ConsentItem, string>> = {
  terms: copy.consentTerms,
  privacy: copy.consentPrivacy,
  age: copy.consentAge,
  marketing: copy.consentMarketing,
};

/** '(필수)' or '(선택)' after an item's line. */
export function consentTag(item: ConsentItem): string {
  return isRequiredConsent(item) ? copy.consentRequiredTag : copy.consentOptionalTag;
}

/**
 * What the step does with a refused `POST /me/consents`. A VALIDATION_ERROR naming a version is a
 * screen older than the text the server now asks agreement to (a revision was deployed while it was
 * open): it says to reload rather than record an agreement to words nobody read. Another account's
 * cookie is the session switch every owner write reports; anything else is the generic error.
 */
export function consentFailure(error: unknown): string {
  if (isApiError(error, 'VALIDATION_ERROR') && namesVersion(error)) {
    return copy.errConsentOutdated;
  }
  if (isApiError(error, 'VALIDATION_ERROR')) return copy.errConsentRequired;
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  return copy.errUnknown;
}

/** Whether a VALIDATION_ERROR's issues name an item's `version` (`consents.<item>.version`). */
function namesVersion(error: ApiError): boolean {
  if (!Array.isArray(error.details)) return false;
  return error.details.some((issue: unknown) => {
    if (typeof issue !== 'object' || issue === null || !('path' in issue)) return false;
    const { path } = issue;
    return Array.isArray(path) && path[0] === 'consents' && path[2] === 'version';
  });
}
