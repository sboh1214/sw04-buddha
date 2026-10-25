import {
  CONSENT_DOCUMENTS,
  CONSENT_ITEMS,
  consentAgreed,
  consentItemsToAsk,
  currentConsentVersion,
  type ConsentAnswer,
  type ConsentItem,
} from '@buddha/shared';
import { copy } from '@/copy';
import { isApiError, isForAnotherAccount, type ApiError, type RecordConsentsBody } from './api';

/**
 * The consent step of /onboarding (#58, ADR-0069 decision 1 #57-4·#57-5) and MY 설정's marketing
 * switch as the screens read them: a checkbox per item asked and '전체 동의' over them, the bodies
 * `POST /me/consents` takes, and what a refusal of it means. Which items there are, which are
 * required, which version each one is at and which ones the step asks are @buddha/shared's
 * (`CONSENT_DOCUMENTS`, `consentItemsToAsk`), the same table and rule the server checks the body
 * against.
 *
 * Kept out of the components so vitest can run them under its node environment.
 */

/** Whether each item is checked on screen; an item the step does not ask is never read. */
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

/**
 * The items the consent step shows, in order: the ones whose newest answer no longer stands
 * (`consentItemsToAsk` on `GET /me`'s `onboarding.consents`) — every item the first time, after a
 * revision that changed members' rights only the ones it left behind, so the marketing answer is
 * not asked again and stays as it was (오너 결정 2026-10-19 (2차) 1). The server asks the same. None
 * would be a screen the server would not send an account to; it shows every item then rather than
 * an empty step.
 */
export function consentStepItems(answers: readonly ConsentAnswer[]): readonly ConsentItem[] {
  const items = consentItemsToAsk(answers);
  return items.length > 0 ? items : CONSENT_ITEMS;
}

/** '전체 동의' as a tri-state over the items shown: all checked, some, or none. */
export function allConsentState(
  choices: ConsentChoices,
  items: readonly ConsentItem[],
): boolean | 'indeterminate' {
  const checked = items.filter((item) => choices[item]).length;
  if (checked === items.length) return true;
  return checked === 0 ? false : 'indeterminate';
}

/** '전체 동의' pressed: every item shown, the optional one included, takes its state (#57-5). */
export function withAllConsents(
  choices: ConsentChoices,
  items: readonly ConsentItem[],
  checked: boolean,
): ConsentChoices {
  return { ...choices, ...Object.fromEntries(items.map((item) => [item, checked])) };
}

/** Whether `item` must be agreed for the step to go on (#57-5). */
export function isRequiredConsent(item: ConsentItem): boolean {
  return CONSENT_DOCUMENTS[item].required;
}

/** The required items shown and left unchecked, in the order the step lists them. */
export function missingRequiredConsents(
  choices: ConsentChoices,
  items: readonly ConsentItem[],
): ConsentItem[] {
  return items.filter((item) => isRequiredConsent(item) && !choices[item]);
}

/** One item's answer at the version this screen shows (the current one). */
function answer(item: ConsentItem, agreed: boolean) {
  return { version: currentConsentVersion(item), agreed };
}

/**
 * `POST /me/consents` from the consent step: every item shown answered at the version it shows,
 * and the account on screen. Null while a required item is unchecked — the step does not send then
 * (the server would refuse it as well).
 */
export function consentBody(
  choices: ConsentChoices,
  items: readonly ConsentItem[],
  expectedAccountId: string,
): RecordConsentsBody | null {
  if (missingRequiredConsents(choices, items).length > 0) return null;
  // `Object.fromEntries` is typed loosely (any key, any answer). The schema pins each version to
  // its literal and a required item's `agreed` to `true`: `currentConsentVersion` is that literal,
  // and the check above is what makes every required answer `true` (consent.test.ts parses the
  // body with the server's schema).
  return {
    consents: Object.fromEntries(items.map((item) => [item, answer(item, choices[item])])),
    expectedAccountId,
  };
}

/**
 * Whether MY 설정's marketing switch is on: the account's newest marketing answer is an agreement
 * to a version that still holds (`consentAgreed`).
 */
export function marketingConsentOn(answers: readonly ConsentAnswer[]): boolean {
  return consentAgreed('marketing', answers);
}

/**
 * What MY 설정's marketing switch shows (ADR-0090): the answer a press asked (`asked`) from the
 * press until the record it sent settles — kept after a success until the answers it wrote reach
 * the card — and otherwise, after a refusal included, the account's own (`marketingConsentOn`),
 * the server's. The switch's input (zag's hidden checkbox) takes the asked position on the press
 * and follows `checked` only when it changes, so a refusal that left the shown value where it was
 * would leave the input on the asked position: checked although nothing was recorded, and the next
 * press swallowed as no change.
 */
export function marketingSwitchOn(
  answers: readonly ConsentAnswer[],
  asked: boolean | null,
): boolean {
  return asked ?? marketingConsentOn(answers);
}

/**
 * `POST /me/consents` from MY 설정's marketing switch: the marketing answer alone, at the current
 * version (오너 결정 2026-10-19 (2차) 4) — each change a record of its own, with the time, the
 * address and the browser, as the consent step's.
 */
export function marketingConsentBody(
  agreed: boolean,
  expectedAccountId: string,
): RecordConsentsBody {
  // The version literal as in `consentBody`.
  return {
    consents: { marketing: answer('marketing', agreed) },
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
 * What the step (and MY 설정's switch) does with a refused `POST /me/consents`. A VALIDATION_ERROR
 * naming a version, or naming an item the screen did not show, is a screen older than what the
 * server now asks agreement to (a revision was deployed while it was open): it says to reload
 * rather than record an agreement to words nobody read. Another account's cookie is the session
 * switch every owner write reports; the account's `consent` bucket (five a minute) the rate limit's
 * sentence; anything else is the generic error.
 */
export function consentFailure(error: unknown): string {
  if (isApiError(error, 'VALIDATION_ERROR') && namesOutdated(error)) {
    return copy.errConsentOutdated;
  }
  if (isApiError(error, 'VALIDATION_ERROR')) return copy.errConsentRequired;
  if (isApiError(error, 'RATE_LIMITED')) return copy.errConsentTooManyRequests;
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  return copy.errUnknown;
}

/**
 * Whether a VALIDATION_ERROR's issues name an item's `version` (`consents.<item>.version`) or an
 * item the step asks that the body left out (`consents.<item>`: the screen listed fewer items than
 * the server asks — it sends every item it shows).
 */
function namesOutdated(error: ApiError): boolean {
  if (!Array.isArray(error.details)) return false;
  return error.details.some((issue: unknown) => {
    if (typeof issue !== 'object' || issue === null || !('path' in issue)) return false;
    const { path } = issue;
    return (
      Array.isArray(path) && path[0] === 'consents' && (path[2] === 'version' || path.length === 2)
    );
  });
}
