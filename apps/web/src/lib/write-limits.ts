import {
  type WriteLimitAction,
  type WriteLimitReason,
  type WriteLimitedDetails,
  writeLimitedDetailsSchema,
} from '@buddha/shared';
import { copy } from '@/copy';
import { isApiError } from './api';

/*
 * 작성 빈도 제한 (#187, ADR-0083; ADR-0069 decision 2 #45-15, decision 4 #187, decision 7) as the
 * writer reads a refusal: the server counts and refuses (WRITE_LIMITED, nothing written — the screen
 * never counts on its own), and the screen says which limit it was and when the person can write
 * again («빈도 제한이면 다시 쓸 수 있는 시각을 보인다»). Every write that counts words its refusal
 * through here: a post and its edit (lib/posts.ts), a comment and its edit (lib/comments.ts), a
 * post's image and the profile image (lib/post-editor.ts, lib/profile.ts).
 */

/** An absolute time in the zone the screen shows times in (`useFormatDateTime`, ADR-0063). */
export type FormatDateTime = (iso: string) => string;

/** What each limit says: the owner's numbers, the same as WRITE_LIMITS (write-limits.test.ts). */
const LIMIT_MESSAGES: Readonly<Record<WriteLimitReason, string>> = {
  posts_10m: copy.errWriteLimitPosts10m,
  posts_24h: copy.errWriteLimitPosts24h,
  comments_1m: copy.errWriteLimitComments1m,
  comments_24h: copy.errWriteLimitComments24h,
  edits_10m: copy.errWriteLimitEdits10m,
  edits_24h: copy.errWriteLimitEdits24h,
  uploads_24h: copy.errWriteLimitUploads24h,
};

/** What a limit holds back, by reason: writing, editing or uploading — the verb after the time. */
const REASON_ACTIONS: Readonly<Record<WriteLimitReason, WriteLimitAction>> = {
  posts_10m: 'post',
  posts_24h: 'post',
  comments_1m: 'comment',
  comments_24h: 'comment',
  edits_10m: 'edit',
  edits_24h: 'edit',
  uploads_24h: 'upload',
};

const RETRY_SUFFIXES: Readonly<Record<WriteLimitAction, string>> = {
  post: copy.writeLimitRetryWrite,
  comment: copy.writeLimitRetryWrite,
  edit: copy.writeLimitRetryEdit,
  upload: copy.writeLimitRetryUpload,
};

/** The sentence of a limit (`errWriteLimitPosts10m` …), without the time. */
export function writeLimitMessage(reason: WriteLimitReason): string {
  return LIMIT_MESSAGES[reason];
}

const MINUTE_MS = 60_000;

/**
 * When the same write passes again, as an instant (ISO): the server's wait (`retryAfterSeconds`,
 * already whole minutes and never sooner than the write passes) counted from when its answer
 * reached the browser (`ApiError.receivedAt`), then rounded UP to the minute — the screen writes
 * the time to the minute (`오후 3:52`), and a time rounded down would name a minute in which the
 * write is still refused. The browser's clock is the one the person reads the time against, so a
 * wrong clock is wrong on both sides alike; only the answer's own trip over the network is not
 * counted, which makes the time later, never sooner.
 */
export function writeRetryAt(details: WriteLimitedDetails, receivedAt: number): string {
  const at = receivedAt + details.retryAfterSeconds * 1_000;
  return new Date(Math.ceil(at / MINUTE_MS) * MINUTE_MS).toISOString();
}

/**
 * What a WRITE_LIMITED refusal tells the writer: the limit's sentence, then the time it can write
 * again in the screen's zone — '근거 글은 10분 동안 3개까지 쓸 수 있습니다. 2026. 10. 21. 오후 3:52부터
 * 다시 쓸 수 있습니다.' A refusal whose details cannot be read (a deploy in between) says to wait
 * and try again (`errWriteLimited`). Undefined for any other answer, which the caller words.
 */
export function writeLimitedMessage(
  error: unknown,
  formatDateTime: FormatDateTime,
): string | undefined {
  if (!isApiError(error, 'WRITE_LIMITED')) return undefined;
  const parsed = writeLimitedDetailsSchema.safeParse(error.details);
  if (!parsed.success) return copy.errWriteLimited;
  const details = parsed.data;
  const time = formatDateTime(writeRetryAt(details, error.receivedAt));
  const suffix = RETRY_SUFFIXES[REASON_ACTIONS[details.reason]];
  return `${writeLimitMessage(details.reason)} ${time}${suffix}`;
}
