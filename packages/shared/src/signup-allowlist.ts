import * as z from 'zod';
import { adminAccountActorSchema } from './admin-accounts.js';
import { approvalReasonSchema } from './approvals.js';
import { approvalStatusSchema } from './enums.js';
import { expectedAccountBodySchema } from './expected-account.js';
import { phoneSchema } from './phone-verification.js';

/**
 * 가입 허용 목록 (#330, ADR-0174; owner answers 330-1…330-12): during the closed test only the
 * numbers an admin put on the list complete the 본인확인, whichever way the account signed up
 * (133-7: email and social alike, both of which pass the one confirmation). The list applies
 * exactly while it is not empty (330-3) — there is no setting, flag or environment for it, so
 * every environment runs the same code the same way (not a 배포 등급, ADR-0055 결과 4) — and public
 * launch is one clear of it.
 *
 * - One admin adds numbers or removes one, with a reason (330-1). The last entry is never removed
 *   one by one (I2): only the clear empties the list, because an empty list opens the signup to
 *   everyone.
 * - The clear needs another admin's approval (330-2): one admin asks with a reason and the typed
 *   confirmation, another approves (or rejects) it, and its requester may retract it. Approving
 *   deletes every entry (330-4: the numbers go when the list is cleared at public launch).
 * - Stored as the keyed hash of the number (330-8, ADR-0071): the screen shows an entry's id and
 *   when it was added, and the admin records name entry ids and counts — never a number.
 * - The confirmation refuses a number off a non-empty list after its code matched (330-5,
 *   PHONE_VERIFICATION_NOT_ALLOWED `not_listed`), so only the number's holder learns it, and the
 *   sends are answered the same whatever the list holds. Accounts that verified before are not
 *   looked at again (330-6).
 */

/** approval_requests.kind of a request to empty the list (330-2). */
export const SIGNUP_ALLOWLIST_CLEAR_APPROVAL_KIND = 'signup_allowlist_clear';

/**
 * The numbers one add takes at most: a bound on a request's size, not on the list (I3 — the list
 * itself has no cap in code; the one sourced number is "20명 안팎", ADR-0171).
 */
export const SIGNUP_ALLOWLIST_ADD_MAX = 500;

/** What the requester of a clear types, exactly (I2), as 탈퇴 is typed for a closure. */
export const SIGNUP_ALLOWLIST_CLEAR_CONFIRMATION = '목록 비우기';

/**
 * Why a write of the list is refused (SIGNUP_ALLOWLIST_NOT_ALLOWED, 409, `details.reason`):
 * - `last_entry`: a removal of the list's one entry — only an approved clear empties it (I2);
 * - `empty`: a clear asked of a list with no entry;
 * - `clear_pending`: a clear asked while another waits for its decision.
 */
export const SIGNUP_ALLOWLIST_REFUSALS = ['last_entry', 'empty', 'clear_pending'] as const;
export type SignupAllowlistRefusal = (typeof SIGNUP_ALLOWLIST_REFUSALS)[number];
export const signupAllowlistNotAllowedDetailsSchema = z.object({
  reason: z.enum(SIGNUP_ALLOWLIST_REFUSALS),
});
export type SignupAllowlistNotAllowedDetails = z.infer<
  typeof signupAllowlistNotAllowedDetailsSchema
>;

/**
 * `POST /admin/signup-allowlist`: numbers in any spelling `phoneSchema` takes (I1: the screen sends
 * the lines of what was pasted, blank lines left out), one reason for them all. One bad number
 * refuses the whole add (VALIDATION_ERROR, its path `['phones', index]`); a number already on the
 * list, or twice in the add, is skipped and counted.
 */
export const signupAllowlistAddBodySchema = expectedAccountBodySchema
  .extend({
    phones: z.array(phoneSchema).min(1).max(SIGNUP_ALLOWLIST_ADD_MAX),
    reason: approvalReasonSchema,
  })
  .strict()
  .meta({ id: 'SignupAllowlistAddBody' });
export type SignupAllowlistAddBody = z.infer<typeof signupAllowlistAddBodySchema>;

/**
 * `POST /admin/signup-allowlist/remove`: the number to take off (the screen cannot name an entry
 * by its number — it shows none), with a reason. In the body, never the URL.
 */
export const signupAllowlistRemoveBodySchema = expectedAccountBodySchema
  .extend({ phone: phoneSchema, reason: approvalReasonSchema })
  .strict()
  .meta({ id: 'SignupAllowlistRemoveBody' });
export type SignupAllowlistRemoveBody = z.infer<typeof signupAllowlistRemoveBodySchema>;

/** `POST /admin/signup-allowlist/clear-requests`: the reason and the typed confirmation. */
export const signupAllowlistClearRequestBodySchema = expectedAccountBodySchema
  .extend({
    reason: approvalReasonSchema,
    confirmation: z.string().trim().pipe(z.literal(SIGNUP_ALLOWLIST_CLEAR_CONFIRMATION)),
  })
  .strict()
  .meta({ id: 'SignupAllowlistClearRequestBody' });
export type SignupAllowlistClearRequestBody = z.infer<typeof signupAllowlistClearRequestBodySchema>;

/** Another admin's approval or rejection of a clear, with a reason. */
export const signupAllowlistClearDecisionBodySchema = expectedAccountBodySchema
  .extend({ reason: approvalReasonSchema })
  .strict()
  .meta({ id: 'SignupAllowlistClearDecisionBody' });
export type SignupAllowlistClearDecisionBody = z.infer<
  typeof signupAllowlistClearDecisionBodySchema
>;

/** An entry as the screen shows it (330-8): its id and when it was added — never the number. */
export const signupAllowlistEntrySchema = z
  .object({ id: z.uuid(), createdAt: z.iso.datetime() })
  .meta({ id: 'SignupAllowlistEntry' });
export type SignupAllowlistEntry = z.infer<typeof signupAllowlistEntrySchema>;

/**
 * What #149's check reads (330-9): how many entries, and how many open accounts hold a verified
 * number that is not on the list — members and admins apart, as the check wants the members'
 * count at 0 before testers are told the address. With an empty list every verified account is
 * counted (none is on it).
 */
export const signupAllowlistSummarySchema = z
  .object({
    entryCount: z.int().nonnegative(),
    outsideVerifiedMembers: z.int().nonnegative(),
    outsideVerifiedAdmins: z.int().nonnegative(),
  })
  .meta({ id: 'SignupAllowlistSummary' });
export type SignupAllowlistSummary = z.infer<typeof signupAllowlistSummarySchema>;

/** A request to empty the list: who asked, why and when, and its decision once there is one. */
export const signupAllowlistClearRequestSchema = z
  .object({
    id: z.uuid(),
    requestedBy: adminAccountActorSchema,
    reason: z.string(),
    requestedAt: z.iso.datetime(),
    status: approvalStatusSchema,
    decidedBy: adminAccountActorSchema.nullable(),
    decisionReason: z.string().nullable(),
    decidedAt: z.iso.datetime().nullable(),
    retractedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'SignupAllowlistClearRequest' });
export type SignupAllowlistClearRequest = z.infer<typeof signupAllowlistClearRequestSchema>;

/**
 * `GET /admin/signup-allowlist`: every entry, newest first, the summary and the clear request that
 * waits for a decision (at most one), or null.
 */
export const signupAllowlistSchema = z
  .object({
    entries: signupAllowlistEntrySchema.array(),
    summary: signupAllowlistSummarySchema,
    pendingClear: signupAllowlistClearRequestSchema.nullable(),
  })
  .meta({ id: 'SignupAllowlist' });
export type SignupAllowlist = z.infer<typeof signupAllowlistSchema>;

/** An add's answer: how many numbers went on, how many were on already (or twice), and the list. */
export const signupAllowlistAddResultSchema = z
  .object({
    addedCount: z.int().nonnegative(),
    skippedCount: z.int().nonnegative(),
    allowlist: signupAllowlistSchema,
  })
  .meta({ id: 'SignupAllowlistAddResult' });
export type SignupAllowlistAddResult = z.infer<typeof signupAllowlistAddResultSchema>;

/** A clear's request, decision or retraction: the request as it is now, and the list after it. */
export const signupAllowlistClearWriteSchema = z
  .object({ request: signupAllowlistClearRequestSchema, allowlist: signupAllowlistSchema })
  .meta({ id: 'SignupAllowlistClearWrite' });
export type SignupAllowlistClearWrite = z.infer<typeof signupAllowlistClearWriteSchema>;

/** The payload of a clear's approval request: nothing but the count it saw (no number). */
export const signupAllowlistClearPayloadSchema = z
  .object({ entryCount: z.int().nonnegative() })
  .strict();

/**
 * The pasted lines of an add (I1), for the screen: every non-blank line must be a number
 * `phoneSchema` takes. Answers the digits of each in order, or the 1-based numbers of the lines
 * that are not one — then nothing is sent.
 */
export function parseSignupAllowlistLines(
  text: string,
): { ok: true; phones: string[] } | { ok: false; badLines: number[] } {
  const phones: string[] = [];
  const badLines: number[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return;
    const parsed = phoneSchema.safeParse(line);
    if (parsed.success) phones.push(parsed.data);
    else badLines.push(index + 1);
  });
  return badLines.length > 0 ? { ok: false, badLines } : { ok: true, phones };
}
