import * as z from 'zod';

/** PLAN 7.4 error codes. The API never emits a code outside this list. */
export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'MARKET_NOT_OPEN',
  'INSUFFICIENT_BALANCE',
  'PRICE_MOVED',
  'DUPLICATE_REQUEST',
  'RATE_LIMITED',
  'RULES_REQUIRED',
  // No brackets or quotes in the comments of this list: scripts/generate-api-doc.mjs reads it
  // with a regex. The detail shapes of the codes below are in its ERROR_NOTES.
  /**
   * The account has not completed the SMS verification yet, and the action needs it. Took the
   * place of the contact-required code when the verified number replaced the unverified contact.
   */
  'VERIFICATION_REQUIRED',
  /** An admin refund outside the policy; the first detail names why (ADR-0042). */
  'REFUND_NOT_ALLOWED',
  /**
   * The PG answered and said no; the first detail carries its result code and message. A
   * retried refund it refuses stays `refunding`: the first attempt may have cancelled the card.
   */
  'PAYMENT_GATEWAY_REFUSED',
  /** The PG could not be reached, or its answer is unknown (502). */
  'PAYMENT_GATEWAY_ERROR',
  /**
   * An admin grant or revoke the rules refuse; the first detail names why, one of
   * ADMIN_GRANT_REFUSALS or ADMIN_REVOKE_REFUSALS in admin-accounts.ts.
   */
  'ROLE_CHANGE_NOT_ALLOWED',
  /**
   * A decision on a two-person request the rule refuses: the decider requested it, it is decided
   * already, or its requester retracted it; or a retraction by anyone but the requester, or of one
   * no longer pending. The first detail names which, one of APPROVAL_REFUSALS in approvals.ts.
   */
  'APPROVAL_NOT_ALLOWED',
  /**
   * A verification the rules refuse: the account verified already, or the number is the verified
   * number of another account. Details carry the reason, phoneVerificationNotAllowedDetailsSchema.
   */
  'PHONE_VERIFICATION_NOT_ALLOWED',
  /**
   * No code was sent: the resend interval, or a daily send limit of the account, of the account
   * at the number, of the accounts at the number, of the client address or of the service.
   * Details carry the reason and retryAfterSeconds, phoneVerificationLimitedDetailsSchema.
   */
  'PHONE_VERIFICATION_LIMITED',
  /**
   * A typed code that verifies nothing: none waiting, expired, discarded after its wrong entries,
   * an older code a newer send replaced, or wrong with entries left. Details carry the reason,
   * verificationCodeRejectedDetailsSchema.
   */
  'VERIFICATION_CODE_REJECTED',
  /**
   * The SMS provider certainly did not take the text (502): it refused it or could not be reached
   * before the request left. Nothing was sent and this send is not counted, so it left no code to
   * confirm. A code the account was sent earlier, still within its three minutes, can still be
   * confirmed: it is the newest code again.
   */
  'SMS_SEND_FAILED',
  /**
   * The answer of the SMS provider was lost (502): a timeout, a connection cut after the request
   * left, a 5xx or an unreadable answer. The text may have gone, so the send counts against the
   * limits and its code can be confirmed (ADR-0070). Its own code as a 5xx body has no details.
   */
  'SMS_SEND_UNCONFIRMED',
  /**
   * The account has not done the onboarding steps this action needs: the consent, the
   * verification or the nickname step (#58). Details carry the missing steps in order,
   * onboardingRequiredDetailsSchema. An account that has not done all three only browses.
   */
  'ONBOARDING_REQUIRED',
  /**
   * A nickname the rules refuse: the auto nickname prefix or a reserved word in a typed one, one
   * another account has or gave up less than 30 days ago (or one an operator reset took from the
   * member, held from them too until the reset is cancelled — ADR-0081), a change within 30 days of
   * the last (but for the nickname handed back, exactly as it was taken away, when an operator
   * cancels a reset, while its hold stands, once — ADR-0081), or another nickname once the onboarding
   * step is done. Details carry the reason and, for the interval, when the next change is allowed,
   * nicknameNotAllowedDetailsSchema.
   */
  'NICKNAME_NOT_ALLOWED',
  /**
   * The author cannot edit this post now: an operator hid it. A hidden post can still be deleted.
   * Details carry the reason, postNotEditableDetailsSchema.
   */
  'POST_NOT_EDITABLE',
  /**
   * An upload the image rules refuse: its content is not a JPEG, PNG, WebP or GIF (a profile image:
   * not a JPEG, PNG or WebP), it is too large, a frame is too large to decode (or too thin: its long
   * side over 32 times its short side) or an animation has too many frames, it does not decode, or
   * it is empty. Details carry the reason,
   * imageNotAllowedDetailsSchema.
   */
  'IMAGE_NOT_ALLOWED',
  /**
   * A new comment where none is taken: the post is hidden or deleted, or the comment it would
   * hang under is. Details carry the reason, commentNotAllowedDetailsSchema.
   */
  'COMMENT_NOT_ALLOWED',
  /**
   * The author cannot edit this comment now: an operator hid it. A hidden comment can still be
   * deleted. Details carry the reason, commentNotEditableDetailsSchema.
   */
  'COMMENT_NOT_EDITABLE',
  /**
   * The post or comment takes no like now, nor the taking back of one: its author deleted it and
   * it stays as its placeholder, or an operator hid it (#49). Details carry the reason,
   * likeNotAllowedDetailsSchema.
   */
  'LIKE_NOT_ALLOWED',
  /**
   * A pin while as many notices as the limit allows are pinned already: one must be unpinned
   * first, nothing unpins itself. Details carry the limit, noticePinLimitDetailsSchema.
   */
  'NOTICE_PIN_LIMIT_REACHED',
  /**
   * An edit of a notice opened from a version that a save has replaced since, whoever made it
   * (another admin, or the same one from another tab): nothing was written. Details carry the
   * version of the notice now, noticeEditConflictDetailsSchema.
   */
  'NOTICE_EDIT_CONFLICT',
  /**
   * Nothing was reported: the reporter wrote the target or owns the profile, the same person has
   * a report on it that is still waiting, or the target shows only its placeholder, deleted or
   * hidden. Details carry the reason, reportNotAllowedDetailsSchema.
   */
  'REPORT_NOT_ALLOWED',
  /**
   * Nothing was reported: the person filed the fixed number of reports of the last 24 hours,
   * counted by the keyed hash of the verified number and not by account; an operator account has
   * no limit. Details carry the limit and retryAfterSeconds, reportLimitedDetailsSchema.
   */
  'REPORT_LIMITED',
  /**
   * An operator action or a processing of reports the rules refuse: the target is the acting
   * operator, the item is hidden already or deleted, there is nothing to take away, the action
   * was cancelled already, a report was processed already, a warning or a restriction names a
   * post or a comment of another member, or a shortening or a lift is not of a writing
   * restriction, of one that ended already, or not to an earlier end still to come — or an account
   * restriction request no admin could decide (none but the one asking and the member), or a new
   * warning, writing restriction or account restriction request, or the approval of one, against
   * an account its member closed (#140). Details carry the reason,
   * moderationNotAllowedDetailsSchema.
   */
  'MODERATION_NOT_ALLOWED',
  /**
   * An operator restriction on the account refuses the action until it ends: a writing
   * restriction keeps the account from new posts, comments and replies, from editing its own and
   * from new values of its public profile items, while deleting its own, likes and reports stay
   * open; an account restriction keeps it from new orders, market proposals, new values of its
   * public profile items and closing the account, while writing, likes, reports and the watchlist
   * stay open. Details carry the kind and the end, null for one with no end — the later of the two
   * when both refuse — restrictedDetailsSchema: the end the account also reads at
   * GET /me/moderation/restriction.
   */
  'RESTRICTED',
  /**
   * Nothing was written: the posts, comments, edits or image uploads of the person reached one of
   * the fixed limits of the owner, counted by the keyed hash of the verified number and not by
   * account; an operator account has none. Details carry the reason, the limit and
   * retryAfterSeconds, writeLimitedDetailsSchema.
   */
  'WRITE_LIMITED',
  /**
   * A closure of the account by its member, 탈퇴 #140, that the rules refuse: the account holds
   * the admin role and closes once the role is revoked, it holds contracts not settled yet, a
   * payment of it is pending or refunding, or it has orders waiting. Details carry the reason,
   * accountClosureNotAllowedDetailsSchema. A restriction refuses it as RESTRICTED.
   */
  'CLOSURE_NOT_ALLOWED',
  /**
   * The account was closed by its member, #140: an operator write that would give it Coin or take
   * Coin from it is refused, as the ledger of a closed account takes no entry after the closure,
   * and so is an admin grant, as a closed account signs in no more and its profile never changes.
   */
  'ACCOUNT_CLOSED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const errorCodeSchema = z.enum(ERROR_CODES).meta({ id: 'ErrorCode' });

/** One entry of `error.details` for VALIDATION_ERROR: which field and why. */
export const validationIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string(),
  })
  .meta({ id: 'ValidationIssue' });
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

/** PLAN 7 failure envelope `{ error: { code, message, details? } }`. */
export const errorEnvelopeSchema = z
  .object({
    error: z.object({
      code: errorCodeSchema,
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .meta({ id: 'ErrorEnvelope' });
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/**
 * The PLAN 7 failure envelope, built in one place.
 *
 * `details` is OMITTED rather than set to `undefined` when there is none: the REST filter and
 * the realtime filter used to build this object by hand in two files, and the socket's copy
 * always carried the key. JSON drops an `undefined` value, so the wire bytes agreed and the
 * drift was invisible until something serialised the envelope some other way.
 */
export function errorEnvelope(code: ErrorCode, message: string, details?: unknown): ErrorEnvelope {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}
