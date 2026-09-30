import { phoneSchema, realNameSchema } from '@buddha/shared';
import * as z from 'zod';
import { copy } from '@/copy';
import { isApiError, isForAnotherAccount, validationField } from './api';

/**
 * The real-name and mobile-number fields (ADR-0043) as the three forms that ask for them —
 * /onboarding, the sign-up's /set-password step and the settings card — validate them.
 *
 * The RULE is the API's own: `realNameSchema` and `phoneSchema` from @buddha/shared are the
 * schemas `PUT /me/contact` parses its two fields with (`contactFieldsSchema`; the body adds
 * `expectedAccountId`, which the hook fills in, never the form), so a form can neither accept a value the
 * server refuses nor refuse one it accepts (PLAN 11.5: the policy is not re-implemented, only
 * the message is localised — the nickname and coupon fields do the same). The shared schemas'
 * own messages are English and are never shown.
 *
 * What the form hands to `onSubmit` is the shared schema's OUTPUT — the trimmed, NFC-normalised
 * name and the digits-only number — i.e. exactly what the server will store.
 */
function localised<T>(
  schema: z.ZodType<T, string>,
  requiredMessage: string,
  formatMessage: string,
) {
  return z.string().transform((value, ctx) => {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    ctx.addIssue({
      code: 'custom',
      message: value.trim() === '' ? requiredMessage : formatMessage,
    });
    return z.NEVER;
  });
}

export const contactFormShape = {
  realName: localised(realNameSchema, copy.errRealNameRequired, copy.errRealNameFormat),
  phone: localised(phoneSchema, copy.errPhoneRequired, copy.errPhoneFormat),
};

export const contactFormSchema = z.object(contactFormShape);

/** What the inputs hold (the phone as typed); `z.output` is the normalised pair sent to the API. */
export type ContactFormValues = z.input<typeof contactFormSchema>;

/**
 * A stored number (digits only, `PHONE_PATTERN`) the way people write it: 010-1234-5678, or
 * 011-123-4567 for the 10-digit ones. Anything else is returned untouched rather than guessed
 * at — the input it seeds is validated again on submit anyway.
 */
export function formatPhone(digits: string): string {
  if (/^\d{11}$/.test(digits))
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (/^\d{10}$/.test(digits))
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits;
}

/** The inputs' starting values for an account's contact (`Me.contact`), blank when it has none. */
export function contactFormValues(
  contact: { realName: string; phone: string } | null | undefined,
): ContactFormValues {
  return contact
    ? { realName: contact.realName, phone: formatPhone(contact.phone) }
    : { realName: '', phone: '' };
}

/**
 * The field a `VALIDATION_ERROR` from `PUT /me/contact` names (`details[].path`), with the
 * message to show under it. The forms validate with the API's own schemas, so this is a server
 * that disagrees after a deploy — rare, but still worth pinning to the input it is about.
 * Anything else (no field, another code, a network failure) is `undefined`: a toast, not a field.
 */
export function contactFieldError(
  error: unknown,
): { field: keyof ContactFormValues; message: string } | undefined {
  if (!isApiError(error, 'VALIDATION_ERROR')) return undefined;
  const field = validationField(error);
  if (field === 'realName') return { field, message: copy.errRealNameFormat };
  if (field === 'phone') return { field, message: copy.errPhoneFormat };
  return undefined;
}

/**
 * The toast for a contact save that failed with no field to pin it to (`contactFieldError`
 * answered `undefined`). The 403 naming `expectedAccountId` means the cookie now belongs to
 * another account (A-PG-24): nothing was written, the hook has asked the session to refetch,
 * and the generic "try again" would be wrong — the same press would be refused again until the
 * screen shows the account that is really signed in.
 */
export function contactSaveFailureMessage(error: unknown): string {
  return isForAnotherAccount(error) ? copy.sessionChanged : copy.errUnknown;
}
