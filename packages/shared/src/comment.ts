import * as z from 'zod';
import { uuidSchema } from './api/uuid.js';
import { postAuthorSchema } from './post.js';
import { codePointLength, postLinkHref } from './post-document.js';

/**
 * 댓글·대댓글 (#48, ADR-0074). Owner decisions (ADR-0069 decision 2, #45): under a post hang 댓글 and
 * under a 댓글 hang 대댓글 — two layers, no more (#45-2: a reply to a 대댓글 is another 대댓글 of the
 * same 댓글), both oldest first (작성 순). A comment is plain text whose web addresses show as
 * links, at most 1,000 characters, without formatting or images (#45-3). Its author edits it at any
 * time ('수정됨', earlier versions for operators only, #45-4) and deletes it: a 댓글 with 대댓글
 * under it stays as '삭제된 글입니다' with the author hidden, anything else leaves every view
 * (#45-5). An operator hides one (#50): '운영 정책에 따라 숨긴 글입니다', no new 대댓글 under it, no
 * edits. A hidden or deleted post takes no new comment. Anyone reads, an account that finished the
 * onboarding writes (#57-8), and a comment never carries its author's position, order or balance
 * (N05 §2), nor any score.
 */

/** A comment's characters at most (#45-3: «댓글 1,000자»), code points as `codePointLength`. */
export const COMMENT_BODY_MAX_LENGTH = 1_000;

/**
 * The control characters a comment drops: C0 and DEL, but not a tab or a line feed — the same as
 * a post's text (post-document.ts), and NUL among them, which Postgres cannot store in `text`.
 */
// eslint-disable-next-line no-control-regex -- the control characters are what it matches
const DROPPED_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * A comment's text as it is kept: line breaks as `\n` (a CR LF or a lone CR from a pasted text is
 * one break), a lone UTF-16 surrogate as U+FFFD (as Postgres would store it, so that resending the
 * same text is the same text and an edit that changes nothing stays none), the control characters
 * above dropped, and the whole trimmed. The lines themselves are kept as written (#45-3: «줄바꿈
 * 유지»), blank ones too.
 */
export function normaliseCommentBody(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\p{Cs}/gu, '�')
    .replace(DROPPED_CONTROLS, '')
    .trim();
}

// ---- the refusals' messages ---------------------------------------------------------------------

/*
 * A body's refusals come back as a VALIDATION_ERROR naming `body`, told apart by their message —
 * written and read here (`commentBodyRefusalOf`), as a post's are in post-document.ts, so the web
 * says each in Korean without matching words the server no longer sends.
 */

/** The comment has no text. */
export const COMMENT_BODY_EMPTY_MESSAGE = 'must have some text';

const COMMENT_TOO_LONG_HEAD = `at most ${String(COMMENT_BODY_MAX_LENGTH)} characters, not `;

/** More than COMMENT_BODY_MAX_LENGTH characters. */
export function commentBodyTooLongMessage(length: number): string {
  return `${COMMENT_TOO_LONG_HEAD}${String(length)}`;
}

/** Which refusal a body issue's message is. */
export type CommentBodyRefusal = { kind: 'empty' } | { kind: 'too_long'; length: number };

export function commentBodyRefusalOf(message: string): CommentBodyRefusal | undefined {
  if (message === COMMENT_BODY_EMPTY_MESSAGE) return { kind: 'empty' };
  if (message.startsWith(COMMENT_TOO_LONG_HEAD)) {
    const length = Number(message.slice(COMMENT_TOO_LONG_HEAD.length));
    if (Number.isSafeInteger(length)) return { kind: 'too_long', length };
  }
  return undefined;
}

/**
 * A comment's body as a request sends it: normalised (`normaliseCommentBody`), then refused when
 * nothing is left or more than COMMENT_BODY_MAX_LENGTH characters are, counted in code points as a
 * post's are ('가', 'a' and '😀' are one each; a line break is one).
 */
export const commentBodyInputSchema = z
  .string()
  .overwrite(normaliseCommentBody)
  .superRefine((text, ctx) => {
    if (text === '') {
      ctx.addIssue({ code: 'custom', message: COMMENT_BODY_EMPTY_MESSAGE });
      return;
    }
    const length = codePointLength(text);
    if (length > COMMENT_BODY_MAX_LENGTH) {
      ctx.addIssue({ code: 'custom', message: commentBodyTooLongMessage(length) });
    }
  })
  .describe(
    `Plain text, line breaks kept, at most ${String(COMMENT_BODY_MAX_LENGTH)} characters after ` +
      'trimming; web addresses show as links',
  );

// ---- links --------------------------------------------------------------------------------------

/** A run of a comment's text, as the web draws it: words, or a web address drawn as a link. */
export type CommentSegment =
  { type: 'text'; text: string } | { type: 'link'; text: string; href: string };

/**
 * Where an address may be: `http://` or `https://`, any case, and what follows up to a space, a
 * quote or an angle bracket. Everything else is no address.
 */
const ADDRESS_CANDIDATE = /https?:\/\/[^\s<>"]+/i;

/** An ASCII letter or digit: never right before an address, and what a non-ASCII end follows. */
const ASCII_WORD = /[A-Za-z0-9]/;

/** Punctuation that ends a sentence rather than an address, when it is last. */
const TRAILING_PUNCTUATION = new Set([
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  "'",
  '。',
  '、',
  '，',
  '．',
  '！',
  '？',
  '」',
  '』',
  '》',
  '〉',
  '】',
  '”',
  '’',
]);

/** Closing brackets dropped from the end while the address does not open as many. */
const CLOSERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{', '）': '（' };

/** The closing brackets and their openers: the only characters the end's trimming counts. */
const BRACKETS = new Set([...Object.keys(CLOSERS), ...Object.values(CLOSERS)]);

/**
 * How many of each bracket `text` holds, counted in one pass. The trimming below lowers a count as
 * it drops a bracket rather than counting the address again per dropped character: counting afresh
 * made a long run of closers quadratic, and a 1,000-character comment of rejected candidates that
 * all run into one such run cost about 75 ms of CPU to draw — in every reader's browser, and then
 * on the server that rendered the post page too, before the comments became the browser's alone
 * to read (ADR-0074, 오너 결정 2026-10-21).
 */
function bracketCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const char of text) {
    if (BRACKETS.has(char)) counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  return counts;
}

/**
 * The address a candidate holds, as written, or undefined. The host is ASCII (a Korean word right
 * after it — 'https://example.com에서' — is the sentence's, not the host's; an internationalised
 * host is written in its punycode form, as browsers copy it), and after the host the address ends
 * at a non-ASCII character that follows an ASCII letter or digit ('…/news/123에서'), while one
 * after a delimiter belongs to it ('…/wiki/서울'). A sentence's punctuation and an unopened closing
 * bracket at the end are dropped. A user or password before the host is no address at all
 * ('https://bank.example@evil.example' reads as one site and goes to another).
 */
function addressIn(candidate: string): string | undefined {
  const schemeEnd = candidate.indexOf('//') + 2;
  let end = candidate.length;
  let inHost = true;
  for (let i = schemeEnd; i < candidate.length; i += 1) {
    const char = candidate[i]!;
    if (inHost && '/?#'.includes(char)) inHost = false;
    if (char.charCodeAt(0) > 0x7f && (inHost || ASCII_WORD.test(candidate[i - 1] ?? ''))) {
      end = i;
      break;
    }
  }
  const address = candidate.slice(0, end);
  const host = address.slice(schemeEnd).split(/[/?#]/, 1)[0] ?? '';
  if (host.includes('@')) return undefined;
  // Every character trimmed here is in the BMP (TRAILING_PUNCTUATION, CLOSERS), so a UTF-16 unit
  // is a whole character, and the scheme's '/' stops the loop before it reaches the start.
  const counts = bracketCounts(address);
  const countOf = (char: string) => counts.get(char) ?? 0;
  let length = address.length;
  for (;;) {
    const last = address[length - 1] ?? '';
    const opener = CLOSERS[last];
    if (TRAILING_PUNCTUATION.has(last)) length -= 1;
    else if (opener !== undefined && countOf(opener) < countOf(last)) {
      counts.set(last, countOf(last) - 1);
      length -= 1;
    } else break;
  }
  return length > schemeEnd ? address.slice(0, length) : undefined;
}

/**
 * A comment's text in runs, its web addresses as links (#45-3: «본문 속 주소는 링크로 보인다»).
 * An address starts with `http://` or `https://` (any case) not glued to a letter or digit before
 * it, and is a link only as `postLinkHref` keeps one — http(s), no user or password, at most
 * POST_LINK_MAX_LENGTH — with that spelling as its `href`; the run keeps the text as written.
 * Nothing else is ever a link: no `javascript:` or `data:` address, no bare 'example.com'. The
 * text is never parsed as markup, so the web draws every run as text or as one link element.
 */
export function commentSegments(text: string): CommentSegment[] {
  const segments: CommentSegment[] = [];
  let from = 0;
  const pushText = (to: number) => {
    if (to > from) segments.push({ type: 'text', text: text.slice(from, to) });
    from = to;
  };
  // A fresh expression per call: `lastIndex` is this call's cursor. A candidate that holds no
  // address, or more than its address, is searched again from just after where it was tried, so
  // an address glued behind another ('https://a.example에서https://b.example') is still found.
  const candidates = new RegExp(ADDRESS_CANDIDATE.source, 'gi');
  for (let match = candidates.exec(text); match !== null; match = candidates.exec(text)) {
    const start = match.index;
    const address = ASCII_WORD.test(text[start - 1] ?? '') ? undefined : addressIn(match[0]);
    const href = address === undefined ? undefined : postLinkHref(address);
    if (address === undefined || href === undefined) {
      candidates.lastIndex = start + 1;
      continue;
    }
    pushText(start);
    segments.push({ type: 'link', text: address, href });
    from = start + address.length;
    candidates.lastIndex = from;
  }
  pushText(text.length);
  return segments;
}

// ---- answers ------------------------------------------------------------------------------------

/**
 * A comment the public reads: its text, its author (the same public face as a post's, ADR-0069
 * decision 5: public id, current nickname, image, 운영자 mark), when it was written and last edited
 * ('수정됨'). `parentId` is the 댓글 a 대댓글 hangs under, null for a 댓글.
 */
export const publishedCommentSchema = z
  .object({
    state: z.literal('published'),
    id: z.uuid(),
    parentId: z.uuid().nullable(),
    body: z.string(),
    author: postAuthorSchema,
    createdAt: z.iso.datetime(),
    editedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'PublishedComment' });
export type PublishedComment = z.infer<typeof publishedCommentSchema>;

/**
 * A comment as a thread shows it. `published`: the comment. `deleted`: a 댓글 its author deleted
 * while 대댓글 hang under it — '삭제된 글입니다', the author hidden, never restored (#45-5); a deleted
 * 대댓글, and a deleted 댓글 with none, are in no answer. `hidden`: an operator hid it —
 * '운영 정책에 따라 숨긴 글입니다'. Neither placeholder names the author or keeps a word of the
 * comment; the original stays for operators only.
 */
export const postCommentSchema = z
  .discriminatedUnion('state', [
    publishedCommentSchema,
    z.object({ state: z.literal('deleted'), id: z.uuid() }).meta({ id: 'DeletedComment' }),
    z.object({ state: z.literal('hidden'), id: z.uuid() }).meta({ id: 'HiddenComment' }),
  ])
  .meta({ id: 'PostComment' });
export type PostComment = z.infer<typeof postCommentSchema>;

// ---- pages --------------------------------------------------------------------------------------

/**
 * 댓글 a page of `GET /posts/:postId/comments` holds at most — and by default (ADR-0074 7-1: 20개씩,
 * 오너가 2026-10-20 그대로 두었다). Below PLAN 7's 100 for this list alone: each 댓글 brings up to
 * COMMENT_REPLIES_PAGE_SIZE 대댓글, so one answer is bounded by both (Codex review on PR #220).
 */
export const COMMENT_PAGE_LIMIT = 20;

/**
 * 대댓글 a 댓글 carries in a page of its post's comments, and a page of `GET /comments/:commentId/
 * replies` holds (오너 결정 2026-10-21, ADR-0074: «댓글마다 처음 50개, '답글 더 보기'로 50개씩»).
 */
export const COMMENT_REPLIES_PAGE_SIZE = 50;

/**
 * The cursor of a comment page or a reply page, bounded as `cursorQuerySchema`'s. Opaque, and more
 * than the other lists' (오너 결정 2026-10-21 (2차), ADR-0074): the API seals the keyset of the
 * page's last row for its list — the post's 댓글, or one 댓글's 대댓글 — so a page ending on a
 * placeholder does not tell its time; one the API did not seal for that list is a VALIDATION_ERROR
 * naming `cursor` (apps/api comment-cursor.ts).
 */
const commentCursorSchema = z.string().min(1).max(200).optional();

/**
 * `GET /posts/:postId/comments`: the cursor of `meta.nextCursor`, and up to COMMENT_PAGE_LIMIT 댓글
 * a page (PLAN 7's query, its bound lowered for this list). No component id, so the OpenAPI
 * document spells both parameters out.
 */
export const commentsQuerySchema = z.object({
  cursor: commentCursorSchema.describe(
    'Opaque, sealed for this post’s list; `meta.nextCursor` of the previous page.',
  ),
  limit: z.coerce.number().int().min(1).max(COMMENT_PAGE_LIMIT).default(COMMENT_PAGE_LIMIT),
});
export type CommentsQuery = z.infer<typeof commentsQuerySchema>;

/**
 * `GET /comments/:commentId/replies`: the cursor of the thread's `repliesNextCursor`, or of the
 * previous reply page's `meta.nextCursor`. The page is always COMMENT_REPLIES_PAGE_SIZE.
 */
export const commentRepliesQuerySchema = z.object({
  cursor: commentCursorSchema.describe(
    'Opaque, sealed for this 댓글’s list; the thread’s `repliesNextCursor`, or `meta.nextCursor` ' +
      'of the previous page.',
  ),
});
export type CommentRepliesQuery = z.infer<typeof commentRepliesQuerySchema>;

/**
 * One 댓글 of `GET /posts/:postId/comments` with its first COMMENT_REPLIES_PAGE_SIZE 대댓글, both
 * oldest first (#45-2: 작성 순). A deleted 대댓글 is not among `replies`; a hidden one is, as its
 * placeholder. `repliesNextCursor` reads the 대댓글 after these (`GET /comments/:commentId/replies`,
 * '답글 더 보기'), null once every one is here (오너 결정 2026-10-21, ADR-0074).
 */
export const commentThreadSchema = z
  .object({
    comment: postCommentSchema,
    replies: z.array(postCommentSchema).max(COMMENT_REPLIES_PAGE_SIZE),
    repliesNextCursor: z
      .string()
      .nullable()
      .describe(
        'The cursor of GET /comments/:commentId/replies for the 대댓글 after these (opaque, ' +
          'sealed for this 댓글’s list); null when every one is here',
      ),
  })
  .meta({ id: 'CommentThread' });
export type CommentThread = z.infer<typeof commentThreadSchema>;

// ---- requests -----------------------------------------------------------------------------------

/** The account the screen shows, which the cookie must be (A-PG-24, as every owner write). */
const expectedAccountIdSchema = z.string().min(1).max(255);

/**
 * `POST /posts/:postId/comments`: a 댓글, or with `parentId` a 대댓글. `parentId` may name a 대댓글:
 * the new one then hangs under that 대댓글's 댓글 (#45-2), so a reply to a reply stays in its thread.
 * No position, order or probability rides with it (N05 §2).
 */
export const createCommentBodySchema = z
  .object({
    parentId: uuidSchema.nullish().transform((id) => id ?? null),
    body: commentBodyInputSchema,
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'CreateCommentBody' });
export type CreateCommentBody = z.input<typeof createCommentBodySchema>;

/**
 * `PUT /comments/:commentId`: the body that replaces the comment's (#45-4). Sending what the
 * comment already says changes nothing and marks nothing edited.
 */
export const updateCommentBodySchema = z
  .object({ body: commentBodyInputSchema, expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'UpdateCommentBody' });
export type UpdateCommentBody = z.input<typeof updateCommentBodySchema>;

/** `POST /comments/:commentId/delete`: only the account the screen shows. */
export const deleteCommentBodySchema = z
  .object({ expectedAccountId: expectedAccountIdSchema })
  .meta({ id: 'DeleteCommentBody' });
export type DeleteCommentBody = z.infer<typeof deleteCommentBodySchema>;

/**
 * The answer of a deletion: whether the comment stays as the placeholder '삭제된 글입니다' (a 댓글
 * with 대댓글 under it, #45-5) or is gone from every view.
 */
export const commentDeletionSchema = z
  .object({ id: z.uuid(), placeholder: z.boolean() })
  .meta({ id: 'CommentDeletion' });
export type CommentDeletion = z.infer<typeof commentDeletionSchema>;

// ---- refusals -----------------------------------------------------------------------------------

/**
 * Why a new comment is refused for where it goes (COMMENT_NOT_ALLOWED): the post is hidden
 * (#45-5: no new comment) or deleted, its placeholder showing (as a hidden one); the 댓글 it would
 * hang under is hidden (#45-5: no new 대댓글) or deleted, its placeholder showing. A post or a
 * comment that left every view is NOT_FOUND instead, as it is to the public.
 */
export const COMMENT_NOT_ALLOWED_REASONS = [
  'post_hidden',
  'post_deleted',
  'parent_hidden',
  'parent_deleted',
] as const;
export type CommentNotAllowedReason = (typeof COMMENT_NOT_ALLOWED_REASONS)[number];
export const commentNotAllowedDetailsSchema = z
  .object({ reason: z.enum(COMMENT_NOT_ALLOWED_REASONS) })
  .meta({ id: 'CommentNotAllowedDetails' });
export type CommentNotAllowedDetails = z.infer<typeof commentNotAllowedDetailsSchema>;

/**
 * Why the author cannot edit the comment (COMMENT_NOT_EDITABLE): an operator hid it (#45-5: a
 * hidden comment cannot be edited, it can be deleted).
 */
export const COMMENT_NOT_EDITABLE_REASONS = ['hidden'] as const;
export type CommentNotEditableReason = (typeof COMMENT_NOT_EDITABLE_REASONS)[number];
export const commentNotEditableDetailsSchema = z
  .object({ reason: z.enum(COMMENT_NOT_EDITABLE_REASONS) })
  .meta({ id: 'CommentNotEditableDetails' });
export type CommentNotEditableDetails = z.infer<typeof commentNotEditableDetailsSchema>;
