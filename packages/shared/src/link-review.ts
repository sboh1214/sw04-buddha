import * as z from 'zod';
import { commentSegments } from './comment.js';
import {
  postLinkHref,
  readPostDocument,
  type PostBlock,
  type PostDocument,
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
 * - Not checked: an operator's writes (decision 4 #187 «운영 계정 … 적용하지 않는다»), and a link
 *   that is one of the official sources of the item's market (`isOfficialSourceLink`).
 * - Counted by person — the keyed hash of the verified number (ADR-0071), as decision 7 counts
 *   every limit — so a withdrawal and a new account on the same number are one person (ADR-0083's
 *   reading of «같은 계정»·«서로 다른 계정», an owner question there).
 */

/** How many posts and comments of one person, or how many people, make a link repeated. */
export const LINK_REPEAT_THRESHOLD = 3;

/** The window both rules count in: the last 24 hours, rolling. */
export const LINK_REPEAT_WINDOW_SECONDS = 86_400;

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
 * platforms append. Matched without regard to case. The list is ADR-0083's choice from the owner's
 * «utm_*, fbclid, gclid…».
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
 *   (ADR-0083's choice — an owner question there).
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

/** The normalised links of `hrefs`, each once, in the order first met. */
function normalisedSet(hrefs: Iterable<string>): string[] {
  const links = new Set<string>();
  for (const href of hrefs) {
    const link = normaliseLink(href);
    if (link !== undefined) links.add(link);
  }
  return [...links];
}

/** Every link mark's address in a post's blocks, in order. */
function* markedLinks(blocks: readonly PostBlock[]): Generator<string> {
  for (const block of blocks) {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
        for (const node of block.content ?? []) {
          if (node.type !== 'text') continue;
          for (const mark of node.marks ?? []) if (mark.type === 'link') yield mark.attrs.href;
        }
        break;
      case 'blockquote':
        yield* markedLinks(block.content);
        break;
      case 'bulletList':
      case 'orderedList':
        for (const item of block.content) yield* markedLinks(item.content);
        break;
      case 'table':
        for (const row of block.content)
          for (const cell of row.content) yield* markedLinks(cell.content);
        break;
      default:
        break;
    }
  }
}

/** The web addresses a plain text holds, as a comment draws them as links (`commentSegments`). */
function* textLinks(text: string): Generator<string> {
  for (const segment of commentSegments(text)) if (segment.type === 'link') yield segment.href;
}

/**
 * The links of a 근거 글's body, normalised and each once: every link mark's address, and every
 * address written out in its text (a bare `https://…`, found as a comment's are), so a link put in
 * as text counts as one put in with the editor's link button.
 */
export function postDocumentLinks(document: PostDocument): string[] {
  const { text } = readPostDocument(document);
  return normalisedSet([...markedLinks(document.content), ...textLinks(text)]);
}

/** The links of a 댓글·대댓글 (its autolinked addresses, `commentSegments`), normalised, each once. */
export function commentLinks(body: string): string[] {
  return normalisedSet(textLinks(body));
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
 * that address only. ADR-0083's reading of «출처 주소» (an owner question there).
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
 * One entry of the operators' review list (`GET /admin/link-flags`): a post or a comment whose link
 * met a rule, the link (normalised), why (`reason`) and when it was put on the list — with what an
 * operator needs to look at it: where it is, its author, and what became of it since (edited,
 * deleted by its author, hidden by an operator). An item that met both rules, or two links, is on
 * the list once for each.
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
      author: z.object({
        userId: z.string(),
        publicId: z.string(),
        nickname: z.string(),
      }),
      market: z.object({ id: z.uuid(), slug: z.string(), title: z.string() }),
    }),
  })
  .meta({ id: 'AdminLinkFlag' });
export type AdminLinkFlag = z.infer<typeof adminLinkFlagSchema>;
