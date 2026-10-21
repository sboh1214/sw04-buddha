import * as z from 'zod';

/**
 * 작성 빈도 제한 (#187, ADR-0083): how often a person writes in the community — the owner's fixed
 * numbers (ADR-0069 decision 2 #45-15 and decision 7), not a release setting and not a deployment's
 * choice, so they live here beside the error that refuses them and docs/API.md renders them.
 *
 * - 근거 글: 3 in 10 minutes and 20 in a day; 댓글·대댓글 together: 5 a minute and 200 a day.
 * - Edits of posts and comments together: 10 in 10 minutes and 50 in a day (decision 7). An edit
 *   that changes nothing is no edit (no revision is written) and is not counted.
 * - Image uploads: 50 a day, a post's image and a profile image together (decision 7; owner
 *   decision 2026-10-22, ADR-0079: «프로필 이미지도 함께 셈»). Counted when the image is stored, so a
 *   file the image rules refuse is not an upload.
 *
 * Who is counted: the person, by the keyed hash of the verified number (ADR-0071), not the account
 * — a withdrawal and a new account on the same number carry on the count (decision 7). What is
 * counted: every write that was taken, whatever became of it since — a deleted post or comment
 * counts (#45-15), and so does an upload no post took. A new account is not treated differently
 * (#45-15). An operator's account is exempt (ADR-0069 decision 4 #187); what it writes is recorded
 * all the same, so a number whose account loses the role carries on from its operator writes, as
 * #77's proposals do (owner decision 2026-10-20, ADR-0089).
 *
 * 'A day' is the last 24 hours, a rolling window like every other window here, and like the
 * 본인확인's and the proposals' daily limits (ADR-0070, ADR-0089) — never a calendar day, whose
 * midnight would let 40 posts through in an hour around it (ADR-0083 7-1, kept by the owner: owner
 * decision 2026-10-22 answer 1).
 */

/** What a limit counts: a new post, a new comment, an edit, a stored image. */
export const WRITE_LIMIT_ACTIONS = ['post', 'comment', 'edit', 'upload'] as const;
export type WriteLimitAction = (typeof WRITE_LIMIT_ACTIONS)[number];

/**
 * Which limit refused, one name per action and window — the window in the name, so a screen's
 * sentence and a log line say the same thing.
 */
export const WRITE_LIMIT_REASONS = [
  'posts_10m',
  'posts_24h',
  'comments_1m',
  'comments_24h',
  'edits_10m',
  'edits_24h',
  'uploads_24h',
] as const;
export type WriteLimitReason = (typeof WRITE_LIMIT_REASONS)[number];

export interface WriteLimitWindow {
  readonly reason: WriteLimitReason;
  /** The length of the rolling window. */
  readonly seconds: number;
  /** The writes the window takes: the next one is refused. */
  readonly limit: number;
}

/** The longest window: older records count for nothing (the worker's purge keeps no more). */
export const WRITE_LIMIT_DAY_SECONDS = 86_400;

/** The owner's numbers (ADR-0069 decision 2 #45-15, decision 7), each action's windows. */
export const WRITE_LIMITS: Readonly<Record<WriteLimitAction, readonly WriteLimitWindow[]>> = {
  post: [
    { reason: 'posts_10m', seconds: 600, limit: 3 },
    { reason: 'posts_24h', seconds: WRITE_LIMIT_DAY_SECONDS, limit: 20 },
  ],
  comment: [
    { reason: 'comments_1m', seconds: 60, limit: 5 },
    { reason: 'comments_24h', seconds: WRITE_LIMIT_DAY_SECONDS, limit: 200 },
  ],
  edit: [
    { reason: 'edits_10m', seconds: 600, limit: 10 },
    { reason: 'edits_24h', seconds: WRITE_LIMIT_DAY_SECONDS, limit: 50 },
  ],
  upload: [{ reason: 'uploads_24h', seconds: WRITE_LIMIT_DAY_SECONDS, limit: 50 }],
};

/** The window a reason names. */
export function writeLimitWindow(reason: WriteLimitReason): WriteLimitWindow {
  for (const windows of Object.values(WRITE_LIMITS)) {
    const found = windows.find((window) => window.reason === reason);
    if (found) return found;
  }
  throw new Error(`no write limit named ${reason}`);
}

/**
 * WRITE_LIMITED (429): nothing was written, because the person's writes of that kind reached a
 * limit of WRITE_LIMITS (`reason`, with its `limit`). `retryAfterSeconds` is when the same write
 * passes every limit of its kind again — when enough of the counted writes have left their windows
 * (the longest wait when two refuse) — counted from the answer and rounded up to whole minutes, as
 * the proposals' daily limit answers (ADR-0089): the count takes in every account that verified the
 * number, so the answer never tells another account's write time to the second. The screen shows
 * the time the person can write again from it (ADR-0069 decision 4 #187: «다시 쓸 수 있는 시각을
 * 보인다»).
 */
export const writeLimitedDetailsSchema = z.object({
  reason: z.enum(WRITE_LIMIT_REASONS),
  limit: z.number().int().min(1),
  retryAfterSeconds: z.number().int().min(60).multipleOf(60),
});
export type WriteLimitedDetails = z.infer<typeof writeLimitedDetailsSchema>;
