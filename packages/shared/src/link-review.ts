import * as z from 'zod';
import { cursorQuerySchema } from './api/pagination.js';
import { commentSegments } from './comment.js';
import { expectedAccountIdSchema } from './expected-account.js';
import {
  POST_LINK_MAX_LENGTH,
  postLinkHref,
  type PostBlock,
  type PostDocument,
  type PostInline,
} from './post-document.js';

/**
 * 반복 링크 탐지 (#187, ADR-0083; ADR-0069 decision 2 #45-15, decision 4 #187 rows, decision 7): a
 * link the same person puts into three or more posts and comments within 24 hours, or that three
 * or more people put in within 24 hours, is put on the operators' review list. Nothing is refused
 * and nothing is hidden: the post stays as it is («글은 그대로 보임»), and what an operator does
 * about it is #50's moderation (hide, warn, restrict).
 *
 * - Links only, never a repeated body (#187 «본문 반복 → 보지 않는다»), and no other automatic
 *   filter — no banned words, no contact patterns (#45-15 «금칙어·연락처 필터 없음»).
 * - Compared by `normaliseLink`'s form (decision 4 #187, decision 7): the scheme and the host in
 *   lower case, the path and the query as written; no trailing slash; no tracking parameters
 *   (TRACKING_PARAMETERS); a shortener's address is not followed — `bit.ly/x` is its own link.
 * - Checked when a post or a comment is written, and when an edit puts in a link the item did not
 *   have (#187 «수정으로 넣거나 바꾼 링크도 본다»).
 * - At most the first LINK_CHECK_MAX links of an item, in body order (owner decision 2026-10-22,
 *   ADR-0083): the rest are not looked at, and the write is never refused for them.
 * - Not checked: an operator's writes (decision 4 #187 «운영 계정 … 적용하지 않는다»), and a link
 *   that is one of the official sources of the item's market (`isOfficialSourceLink`).
 * - Counted by person — the keyed hash of the verified number (ADR-0071), as decision 7 counts
 *   every limit — so a withdrawal and a new account on the same number are one person (owner
 *   decision 2026-10-22, ADR-0083: «같은 계정»·«서로 다른 계정» are verified numbers).
 * - The review list shows the entries grouped by link and rule, and an operator marks a group
 *   '확인함' with what came of it (`LINK_FLAG_REVIEW_OUTCOMES`, owner decision 2026-10-22): the
 *   mark is an `admin_actions` row, and the marked entries leave the default list.
 */

/** How many posts and comments of one person, or how many people, make a link repeated. */
export const LINK_REPEAT_THRESHOLD = 3;

/** The window both rules count in: the last 24 hours, rolling. */
export const LINK_REPEAT_WINDOW_SECONDS = 86_400;

/**
 * How many links of one post or comment the rules look at: the first 20 in body order, each link
 * once (owner decision 2026-10-22, ADR-0083 — «본문 순서로 앞 20개까지»). A link after them is not
 * recorded and counts toward no rule; the write itself is never refused for it.
 */
export const LINK_CHECK_MAX = 20;

/**
 * Why a post or a comment is on the review list:
 * - `same_account`: its author put the link into LINK_REPEAT_THRESHOLD or more posts and comments
 *   within LINK_REPEAT_WINDOW_SECONDS (this one among them);
 * - `many_accounts`: LINK_REPEAT_THRESHOLD or more people put the link in within the window (its
 *   author among them).
 */
export const LINK_FLAG_REASONS = ['same_account', 'many_accounts'] as const;
export type LinkFlagReason = (typeof LINK_FLAG_REASONS)[number];

/** What carries a flagged link: a 근거 글, or a 댓글·대댓글. */
export const LINK_FLAG_TARGET_KINDS = ['post', 'comment'] as const;
export type LinkFlagTargetKind = (typeof LINK_FLAG_TARGET_KINDS)[number];

// ---- the same link ------------------------------------------------------------------------------

/**
 * Query parameters that only say where a click came from («utm 같은 추적용 덧붙임», decision 4 #187):
 * Google Analytics' `utm_*` (any of them, by the prefix) and the click ids the large ad and social
 * platforms append. Matched without regard to case. The list is ADR-0083's from the owner's
 * «utm_*, fbclid, gclid…», which the owner kept (owner decision 2026-10-22).
 */
export const TRACKING_PARAMETER_PREFIXES = ['utm_'] as const;
export const TRACKING_PARAMETERS = [
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'yclid',
  'igshid',
  'twclid',
  'ttclid',
  'mc_cid',
  'mc_eid',
] as const;

/** Whether a query parameter's name is a tracking one (TRACKING_PARAMETERS). */
export function isTrackingParameter(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    TRACKING_PARAMETER_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    (TRACKING_PARAMETERS as readonly string[]).includes(lower)
  );
}

/** A query parameter's name as written before its `=`, percent-decoded when it decodes. */
function parameterName(pair: string): string {
  const raw = pair.split('=', 1)[0] ?? '';
  try {
    return decodeURIComponent(raw.replaceAll('+', ' '));
  } catch {
    return raw;
  }
}

/**
 * The form two links are compared in (decision 4 #187 and decision 7), or undefined for what is no
 * link (`postLinkHref`: an absolute http(s) URL without a user or password, at most
 * POST_LINK_MAX_LENGTH):
 *
 * - the scheme and the host in lower case — the URL parser's own spelling, which also writes an
 *   internationalised host in punycode and drops the scheme's default port; the path and the query
 *   keep their case («경로·쿼리의 대소문자는 그대로»);
 * - no trailing slash on the path (`https://example.com/a/` is `https://example.com/a`, and the
 *   site's root is the bare origin);
 * - no tracking parameter (TRACKING_PARAMETERS), the others as written and in their order, and no
 *   empty `?` or `&&` left behind;
 * - no fragment: the part after `#` never leaves the browser, so it names a place on the same page
 *   (kept by the owner, owner decision 2026-10-22, ADR-0083 — as http and https, and www and no
 *   www, stay apart).
 *
 * A shortener's address is kept as it is, never followed (decision 4 #187 «단축 주소는 풀지 않는다»).
 */
export function normaliseLink(href: string): string | undefined {
  const kept = postLinkHref(href);
  if (kept === undefined) return undefined;
  const url = new URL(kept);
  const path = url.pathname.replace(/\/+$/, '');
  const query = url.search
    .slice(1)
    .split('&')
    .filter((pair) => pair !== '' && !isTrackingParameter(parameterName(pair)))
    .join('&');
  return `${url.protocol}//${url.host}${path}${query === '' ? '' : `?${query}`}`;
}

/**
 * The normalised links of `hrefs`, each once, in the order first met — at most `max` of them, the
 * first ones (what is no link is skipped and takes no place).
 */
function normalisedSet(hrefs: Iterable<string>, max = Infinity): string[] {
  const links = new Set<string>();
  for (const href of hrefs) {
    if (links.size >= max) break;
    const link = normaliseLink(href);
    if (link !== undefined) links.add(link);
  }
  return [...links];
}

/** The web addresses a plain text holds, as a comment draws them as links (`commentSegments`). */
function* textLinks(text: string): Generator<string> {
  for (const segment of commentSegments(text)) if (segment.type === 'link') yield segment.href;
}

/**
 * One block's links in the order they stand in its text: its link marks' addresses, where the
 * marked words begin, and the addresses written out in the text (`commentSegments`), where they
 * begin — a mark first when both begin at one place (the editor's autolink, words that are their
 * own address). The text is the block's as a post's plain text has it (a hard break a line).
 */
function* inlineLinks(content: readonly PostInline[] | undefined): Generator<string> {
  let text = '';
  const marked: { at: number; href: string }[] = [];
  for (const node of content ?? []) {
    if (node.type !== 'text') {
      text += '\n';
      continue;
    }
    for (const mark of node.marks ?? []) {
      if (mark.type === 'link') marked.push({ at: text.length, href: mark.attrs.href });
    }
    text += node.text;
  }
  yield* inTextOrder(text, marked);
}

/** `marked` and the addresses written in `text`, merged by where each begins. */
function* inTextOrder(
  text: string,
  marked: readonly { at: number; href: string }[],
): Generator<string> {
  let next = 0;
  let at = 0;
  for (const segment of commentSegments(text)) {
    if (segment.type === 'link') {
      while (next < marked.length && marked[next]!.at <= at) yield marked[next++]!.href;
      yield segment.href;
    }
    at += segment.text.length;
  }
  while (next < marked.length) yield marked[next++]!.href;
}

/**
 * Every link of a post's blocks in body order: block after block, as the plain text runs (a list
 * item's, a quote's and a table cell's blocks where they stand), each block's marks and written
 * addresses by where they begin. An address is found within one block's text, as in the post's
 * whole plain text, where blocks are apart by a line and cells by a space.
 */
function* blocksLinks(blocks: readonly PostBlock[]): Generator<string> {
  for (const block of blocks) {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
        yield* inlineLinks(block.content);
        break;
      case 'codeBlock':
        yield* inTextOrder(block.content?.[0]?.text ?? '', []);
        break;
      case 'blockquote':
        yield* blocksLinks(block.content);
        break;
      case 'bulletList':
      case 'orderedList':
        for (const item of block.content) yield* blocksLinks(item.content);
        break;
      case 'table':
        for (const row of block.content)
          for (const cell of row.content) yield* blocksLinks(cell.content);
        break;
      default:
        break;
    }
  }
}

/**
 * The links of a 근거 글's body the rules look at, normalised and each once: every link mark's
 * address and every address written out in its text (a bare `https://…`, found as a comment's
 * are), so a link put in as text counts as one put in with the editor's link button — in body
 * order, the first LINK_CHECK_MAX of them (owner decision 2026-10-22).
 */
export function postDocumentLinks(document: PostDocument): string[] {
  return normalisedSet(blocksLinks(document.content), LINK_CHECK_MAX);
}

/**
 * The links of a 댓글·대댓글 the rules look at (its autolinked addresses, `commentSegments`),
 * normalised and each once, the first LINK_CHECK_MAX in its text's order.
 */
export function commentLinks(body: string): string[] {
  return normalisedSet(textLinks(body), LINK_CHECK_MAX);
}

/**
 * The official sources of a market as links, from what the market names as its source of
 * judgement (`resolutionSource`, free text today: «한국은행 보도자료 https://www.bok.or.kr»), each
 * address in it normalised. Empty when it names none. When the rules gain their primary and
 * fallback sources as fields (N03 §2, M8), they are read here instead.
 */
export function officialSourceLinks(resolutionSource: string | null): string[] {
  return resolutionSource === null ? [] : normalisedSet(textLinks(resolutionSource));
}

/**
 * Whether a normalised `link` is one of a market's official sources (decision 4 #187 «시장의 공식
 * 출처 주소 … 예외»): a source itself, or a page under one — the same scheme and host, and a path
 * that is the source's or continues it after a `/` (`https://www.bok.or.kr/portal/…` under
 * `https://www.bok.or.kr`, never `https://www.bok.or.kr.example`). A source with a query covers
 * that address only (owner decision 2026-10-22, ADR-0083: «그 주소와 그 아래 페이지»).
 */
export function isOfficialSourceLink(link: string, sources: readonly string[]): boolean {
  return sources.some((source) => {
    if (link === source) return true;
    if (source.includes('?')) return false;
    if (!link.startsWith(source)) return false;
    const next = link.charAt(source.length);
    // The source is the bare origin or a path without its trailing slash: what follows it must
    // start a new segment or the query of the same path.
    return next === '/' || next === '?';
  });
}

// ---- the review list ----------------------------------------------------------------------------

/**
 * What an operator found when marking a group of the review list '확인함' (owner decision
 * 2026-10-22, ADR-0083): `no_issue` '문제 없음', or `actioned` '조치함' — the action itself (hiding,
 * a warning, a restriction) is #50's moderation, taken there; the mark only records that it was.
 */
export const LINK_FLAG_REVIEW_OUTCOMES = ['no_issue', 'actioned'] as const;
export type LinkFlagReviewOutcome = (typeof LINK_FLAG_REVIEW_OUTCOMES)[number];

/** The longest note an operator may leave with a mark (as an admin's reason, ADR-0056). */
export const LINK_FLAG_REVIEW_NOTE_MAX_LENGTH = 500;

/**
 * Which part of the review list `GET /admin/link-flags` shows: `open`, the entries no operator has
 * marked yet (the default list), or `reviewed`, the marks and the entries each covered (the
 * filter that shows what left the default list).
 */
export const LINK_FLAG_LIST_STATUSES = ['open', 'reviewed'] as const;
export type LinkFlagListStatus = (typeof LINK_FLAG_LIST_STATUSES)[number];

/** `GET /admin/link-flags`: which part, a page at a time. */
export const adminLinkFlagListQuerySchema = cursorQuerySchema.extend({
  status: z.enum(LINK_FLAG_LIST_STATUSES).default('open'),
});
export type AdminLinkFlagListQuery = z.infer<typeof adminLinkFlagListQuerySchema>;

/**
 * An operator's mark on a group (an `admin_actions` row of type `link_flag_review`): what came of
 * it, the note when one was left, who marked it and when.
 */
export const adminLinkFlagReviewSchema = z
  .object({
    id: z.uuid(),
    outcome: z.enum(LINK_FLAG_REVIEW_OUTCOMES),
    note: z.string().nullable(),
    reviewedAt: z.iso.datetime(),
    /**
     * The operator who marked it; the nickname is null once that account was closed by its member
     * (#140 — after its admin role was revoked, #57-17), and the screen names it '탈퇴한 사용자'.
     */
    admin: z.object({ userId: z.string(), nickname: z.string().nullable() }),
  })
  .meta({ id: 'AdminLinkFlagReview' });
export type AdminLinkFlagReview = z.infer<typeof adminLinkFlagReviewSchema>;

/**
 * One row of the review list (owner decision 2026-10-22: «같은 주소·규칙끼리 묶어 항목 수 보임»):
 * the entries of one link and rule — how many and when the latest was put on the list. In the
 * default list (`open`) they are the group's entries no operator has marked, and `review` is null;
 * in the reviewed list, one row is one mark, with the entries it covered and the mark itself.
 * Its entries are read a page at a time from `GET /admin/link-flags/items`.
 */
export const adminLinkFlagGroupSchema = z
  .object({
    url: z.string(),
    reason: z.enum(LINK_FLAG_REASONS),
    itemCount: z.number().int().positive(),
    latestFlaggedAt: z.iso.datetime(),
    review: adminLinkFlagReviewSchema.nullable(),
  })
  .meta({ id: 'AdminLinkFlagGroup' });
export type AdminLinkFlagGroup = z.infer<typeof adminLinkFlagGroupSchema>;

/**
 * `GET /admin/link-flags/items`: a group's entries — the ones not marked yet of `url` and `reason`,
 * or with `reviewId`, the ones that mark covered — newest first, a page at a time.
 */
export const adminLinkFlagItemsQuerySchema = cursorQuerySchema.extend({
  url: z.string().min(1).max(POST_LINK_MAX_LENGTH),
  reason: z.enum(LINK_FLAG_REASONS),
  reviewId: z.uuid().optional(),
});
export type AdminLinkFlagItemsQuery = z.infer<typeof adminLinkFlagItemsQuerySchema>;

/**
 * `POST /admin/link-flags/reviews`: mark a group of the default list '확인함' — its entries of
 * `url` and `reason` not marked yet that were put on the list at or before `through` (the group's
 * latest time as the screen showed it, so an entry that arrives after the operator looked stays
 * on the default list) — with what came of it and an optional note, as the admin on screen
 * (`expectedAccountId`, ADR-0092).
 */
export const adminLinkFlagReviewBodySchema = z
  .object({
    url: z.string().min(1).max(POST_LINK_MAX_LENGTH),
    reason: z.enum(LINK_FLAG_REASONS),
    outcome: z.enum(LINK_FLAG_REVIEW_OUTCOMES),
    /** Optional; blank is none. */
    note: z.string().trim().max(LINK_FLAG_REVIEW_NOTE_MAX_LENGTH).optional(),
    through: z.iso.datetime(),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'AdminLinkFlagReviewBody' });
export type AdminLinkFlagReviewBody = z.infer<typeof adminLinkFlagReviewBodySchema>;

/**
 * The payload of a `link_flag_review` row of `admin_actions` (target `link` / the normalised url):
 * the rule, what came of it, the note (null when none), how many entries the mark covered and the
 * `through` it was asked with. The entries name the row themselves (`link_flags.review_action_id`).
 */
export const linkFlagReviewPayloadSchema = z.object({
  reason: z.enum(LINK_FLAG_REASONS),
  outcome: z.enum(LINK_FLAG_REVIEW_OUTCOMES),
  note: z.string().nullable(),
  itemCount: z.number().int().positive(),
  through: z.iso.datetime(),
});
export type LinkFlagReviewPayload = z.infer<typeof linkFlagReviewPayloadSchema>;

/**
 * One entry of the operators' review list (`GET /admin/link-flags/items`, a group's entries): a
 * post or a comment whose link met a rule, the link (normalised), why (`reason`) and when it was
 * put on the list — with what an operator needs to look at it: where it is, its author, and what
 * became of it since (edited, deleted by its author, hidden by an operator). An item that met both
 * rules, or two links, is on the list once for each.
 */
export const adminLinkFlagSchema = z
  .object({
    id: z.uuid(),
    url: z.string(),
    reason: z.enum(LINK_FLAG_REASONS),
    flaggedAt: z.iso.datetime(),
    target: z.object({
      kind: z.enum(LINK_FLAG_TARGET_KINDS),
      postId: z.uuid(),
      /** The comment, for a comment; null for a post. */
      commentId: z.uuid().nullable(),
      /**
       * The post's title, or the start of its text when it has none; the start of a comment's text
       * (`postExcerpt`, a card's preview).
       */
      excerpt: z.string(),
      createdAt: z.iso.datetime(),
      editedAt: z.iso.datetime().nullable(),
      deletedAt: z.iso.datetime().nullable(),
      hiddenAt: z.iso.datetime().nullable(),
      /**
       * The item's author; the nickname is null once the member closed the account (#140, #37-16:
       * the public items went with it) — the item stays, and the screen names it '탈퇴한 사용자'.
       */
      author: z.object({
        userId: z.string(),
        publicId: z.string(),
        nickname: z.string().nullable(),
      }),
      market: z.object({ id: z.uuid(), slug: z.string(), title: z.string() }),
    }),
  })
  .meta({ id: 'AdminLinkFlag' });
export type AdminLinkFlag = z.infer<typeof adminLinkFlagSchema>;
