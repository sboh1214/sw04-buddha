import * as z from 'zod';

/**
 * The two-person rule (2인 통제, #171): work that needs another admin's approval is first recorded
 * as a request (`approval_requests`), and only an admin other than the one who requested it may
 * approve or reject it — in every environment, with no bypass (owner decision 2026-10-13: local,
 * automated tests and internal deploys use two distinct admins too). Each decision is made once
 * and keeps who decided, when and why; the database refuses a decision by the requester and any
 * change to a decided request.
 *
 * The rule is shared; applying it is each consumer's issue — market review (#78), judgement
 * approval (#152), post-settlement compensation (#144), bot control (#130), account restriction
 * (#139) and the rest. So is the rest of a request's life: whether it expires, whether its
 * requester can retract it, what a requester who lost the admin role means for it, and which
 * work runs on approval. A consumer names its `kind` and decides inside the transaction that does
 * the approved work (ApprovalService in apps/api). A retraction, where a consumer allows one (#139
 * does), is the requester's own and closes the request as `retracted` — no decision, decided by no
 * one — with its instant (`retracted_at`, migration 0042).
 */

/** Lower-case words joined by `_` (`market_open`); approval_requests.kind is varchar(40). */
export const APPROVAL_KIND_PATTERN = /^[a-z][a-z0-9_]*$/;
export const APPROVAL_KIND_MAX_LENGTH = 40;

/** A request's or a decision's reason: required, stored in approval_requests. */
export const APPROVAL_REASON_MAX_LENGTH = 500;
export const approvalReasonSchema = z.string().trim().min(1).max(APPROVAL_REASON_MAX_LENGTH);

/**
 * Why a decision or a retraction is refused (APPROVAL_NOT_ALLOWED, `details[0].message`):
 * - `requester`: the decider is the requester;
 * - `decided`: the request was decided already;
 * - `retracted`: its requester retracted it — it is decided by no one, and retracted once (#139,
 *   ADR-0085: a consumer that lets its requests be retracted);
 * - `not_requester`: a retraction by anyone but the requester.
 * A decider (or a retracting requester) who is not an admin now gets FORBIDDEN.
 */
export const APPROVAL_REFUSALS = ['requester', 'decided', 'retracted', 'not_requester'] as const;
export type ApprovalRefusal = (typeof APPROVAL_REFUSALS)[number];
