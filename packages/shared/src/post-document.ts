import * as z from 'zod';
import { uuidSchema } from './api/uuid.js';

/**
 * The body of a 근거 글 (#46, ADR-0069 decision 2 #45-3): a structured document, never HTML. The
 * editor (TipTap/ProseMirror on the web) sends its JSON, the server keeps what the allow-list
 * names and drops everything else (the owner's «허용 목록 밖의 서식은 서버에서 지운다»), stores the
 * result as it is, and the web draws it node by node as React elements — no HTML string is ever
 * parsed or injected, so there is no markup for a script to hide in.
 *
 * What the owner allowed («기본 서식 제목 코드 구분선 이미지 표 글자 색», the basics being
 * 굵게·기울임·취소선·목록·인용·링크):
 *
 * - marks: bold, italic, strike, inline code, a link (http/https only, no user or password in it),
 *   a text colour from POST_TEXT_COLORS (a name, drawn with a value readable in either theme —
 *   owner decision 2026-10-18);
 * - blocks: paragraph, heading (POST_HEADING_LEVELS), blockquote, bullet and ordered lists, code
 *   block, horizontal rule, image (one of our uploads, by its media id — never a URL), table;
 * - inline: text and a hard break.
 *
 * The names are TipTap's (`bulletList`, `textStyle` with `color`, `hardBreak`, …), so the editor's
 * JSON needs no translation; the image node carries `mediaId` in place of TipTap's `src`.
 *
 * Normalising (`sanitizePostDocument`) never fails on formatting: an unknown mark, a link to
 * `javascript:`, a colour outside the palette, a heading level outside the list or an attribute
 * nobody asked for is removed and the text stays; an unknown node is removed with what it holds
 * (only a hand-made request sends one: the editor knows no other node); text put straight into a
 * container of blocks is wrapped in a paragraph; containers left empty are dropped or given an
 * empty paragraph where the editor's schema requires one (a list item, a table cell). It fails
 * only on what cannot be a post: not a document, nested deeper than POST_DOCUMENT_MAX_DEPTH, no
 * text, more than POST_BODY_MAX_LENGTH characters of text, more than POST_IMAGES_MAX images, or a
 * result over POST_DOCUMENT_MAX_BYTES. Whether each image is the author's own upload is the API's
 * to check (it needs the database).
 */

/** The text colours (owner decision 2026-10-18: «빨강·주황·초록·파랑·보라·회색 같은 6가지»). */
export const POST_TEXT_COLORS = ['red', 'orange', 'green', 'blue', 'purple', 'gray'] as const;
export type PostTextColor = (typeof POST_TEXT_COLORS)[number];

/** Heading levels a post may use (ADR-0073: three are enough for a post, and fewer is the safe side). */
export const POST_HEADING_LEVELS = [1, 2, 3] as const;
export type PostHeadingLevel = (typeof POST_HEADING_LEVELS)[number];

/** A post's text, counted without its formatting (#45-3: «근거 글 5,000자», a fixed value). */
export const POST_BODY_MAX_LENGTH = 5_000;
/** Images in one post (#45-3: «글마다 10장»), each image node counted. */
export const POST_IMAGES_MAX = 10;
/** The longest link a post keeps; a longer one loses its link and keeps its text. */
export const POST_LINK_MAX_LENGTH = 2_048;
/**
 * The normalised document, as UTF-8 JSON. Text is bounded by its own limit; this bounds what text
 * cannot — thousands of empty table cells, a link mark on every character — so a post stays a
 * size a list can carry. Generous for any post the editor can make within the text limit.
 */
export const POST_DOCUMENT_MAX_BYTES = 262_144;
/** How deep blocks may nest (a list in a quote in a table cell…); deeper is refused, not cut. */
export const POST_DOCUMENT_MAX_DEPTH = 24;
/** The widest `colspan`/`rowspan` a table cell keeps; larger, or not a whole number, is 1. */
export const POST_TABLE_SPAN_MAX = 20;
/** The largest `start` an ordered list keeps; larger, or not a whole number from 1, is 1. */
export const POST_ORDERED_LIST_START_MAX = 10_000;

// ---- the document's shape ---------------------------------------------------------------------

export type PostMark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'strike' }
  | { type: 'code' }
  | { type: 'link'; attrs: { href: string } }
  | { type: 'textStyle'; attrs: { color: PostTextColor } };

export interface PostText {
  type: 'text';
  text: string;
  marks?: PostMark[];
}
export interface PostHardBreak {
  type: 'hardBreak';
}
export type PostInline = PostText | PostHardBreak;

export interface PostParagraph {
  type: 'paragraph';
  content?: PostInline[];
}
export interface PostHeading {
  type: 'heading';
  attrs: { level: PostHeadingLevel };
  content?: PostInline[];
}
export interface PostBlockquote {
  type: 'blockquote';
  content: PostBlock[];
}
export interface PostListItem {
  type: 'listItem';
  content: PostBlock[];
}
export interface PostBulletList {
  type: 'bulletList';
  content: PostListItem[];
}
export interface PostOrderedList {
  type: 'orderedList';
  attrs: { start: number };
  content: PostListItem[];
}
/** Its text is one unmarked text node, line breaks as `\n`. */
export interface PostCodeBlock {
  type: 'codeBlock';
  content?: { type: 'text'; text: string }[];
}
export interface PostHorizontalRule {
  type: 'horizontalRule';
}
/** One of the author's uploads (`POST /media/images`), by its id; drawn from `GET /media/:id`. */
export interface PostImage {
  type: 'image';
  attrs: { mediaId: string };
}
export interface PostTableCell {
  type: 'tableCell' | 'tableHeader';
  attrs: { colspan: number; rowspan: number };
  content: PostBlock[];
}
export interface PostTableRow {
  type: 'tableRow';
  content: PostTableCell[];
}
export interface PostTable {
  type: 'table';
  content: PostTableRow[];
}
export type PostBlock =
  | PostParagraph
  | PostHeading
  | PostBlockquote
  | PostBulletList
  | PostOrderedList
  | PostCodeBlock
  | PostHorizontalRule
  | PostImage
  | PostTable;

export interface PostDocument {
  type: 'doc';
  content: PostBlock[];
}

// ---- the same shape as zod, for the OpenAPI document and the client ---------------------------

export const postMarkSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('bold') }),
    z.object({ type: z.literal('italic') }),
    z.object({ type: z.literal('strike') }),
    z.object({ type: z.literal('code') }),
    z.object({ type: z.literal('link'), attrs: z.object({ href: z.string() }) }),
    z.object({
      type: z.literal('textStyle'),
      attrs: z.object({ color: z.enum(POST_TEXT_COLORS) }),
    }),
  ])
  .meta({ id: 'PostMark' });

const postTextSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  marks: z.array(postMarkSchema).optional(),
});
const postInlineSchema = z
  .discriminatedUnion('type', [postTextSchema, z.object({ type: z.literal('hardBreak') })])
  .meta({ id: 'PostInline' });

/** A block, recursively: lists, quotes and table cells hold blocks (z.lazy, so it can refer to itself). */
export const postBlockSchema: z.ZodType<PostBlock> = z
  .lazy(() =>
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('paragraph'), content: z.array(postInlineSchema).optional() }),
      z.object({
        type: z.literal('heading'),
        attrs: z.object({ level: z.literal(POST_HEADING_LEVELS) }),
        content: z.array(postInlineSchema).optional(),
      }),
      z.object({ type: z.literal('blockquote'), content: z.array(postBlockSchema) }),
      z.object({ type: z.literal('bulletList'), content: z.array(postListItemSchema) }),
      z.object({
        type: z.literal('orderedList'),
        attrs: z.object({ start: z.number().int() }),
        content: z.array(postListItemSchema),
      }),
      z.object({
        type: z.literal('codeBlock'),
        content: z.array(z.object({ type: z.literal('text'), text: z.string() })).optional(),
      }),
      z.object({ type: z.literal('horizontalRule') }),
      z.object({ type: z.literal('image'), attrs: z.object({ mediaId: z.uuid() }) }),
      z.object({ type: z.literal('table'), content: z.array(postTableRowSchema) }),
    ]),
  )
  .meta({ id: 'PostBlock' });

const postListItemSchema: z.ZodType<PostListItem> = z
  .lazy(() => z.object({ type: z.literal('listItem'), content: z.array(postBlockSchema) }))
  .meta({ id: 'PostListItem' });

const postTableRowSchema: z.ZodType<PostTableRow> = z
  .lazy(() =>
    z.object({
      type: z.literal('tableRow'),
      content: z.array(
        z.object({
          type: z.enum(['tableCell', 'tableHeader']),
          attrs: z.object({ colspan: z.number().int(), rowspan: z.number().int() }),
          content: z.array(postBlockSchema),
        }),
      ),
    }),
  )
  .meta({ id: 'PostTableRow' });

/** A stored, normalised document (what `sanitizePostDocument` returns). */
export const postDocumentSchema: z.ZodType<PostDocument> = z
  .object({ type: z.literal('doc'), content: z.array(postBlockSchema) })
  .meta({ id: 'PostDocument' });

// ---- counting -----------------------------------------------------------------------------------

/**
 * Characters as a person counts them, near enough and the same on every machine: Unicode code
 * points, so '가', 'a' and '😀' are one each (a JS string's `length` counts the emoji twice). The
 * title's 100 and the body's 5,000 are counted this way, as Postgres counts a `varchar(n)`.
 */
export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** The first `max` code points of `text`. */
function codePointSlice(text: string, max: number): string {
  let out = '';
  let count = 0;
  for (const char of text) {
    if (count === max) break;
    out += char;
    count += 1;
  }
  return out;
}

/** UTF-8 size of a string (TextEncoder, so it runs in the browser too). */
const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/**
 * The control characters a post's text drops: C0 and DEL, but not a tab or a line feed (a code
 * block's lines). NUL among them — Postgres can store it in neither `text` nor `jsonb`.
 */
// eslint-disable-next-line no-control-regex -- the control characters are what it matches
const DROPPED_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

// ---- the refusals' messages ----------------------------------------------------------------------

/*
 * A body's refusals all come back as a VALIDATION_ERROR naming `body`, told apart by their
 * message. The messages are written here and read here (`postBodyRefusalOf`), and both the API
 * (the sanitiser below, PostsService's image check) and the web (which says each in Korean) use
 * these, so rewording one cannot leave the web matching words the server no longer sends.
 */

/** The body has no text (an image alone is no post, ADR-0073 9-6). */
export const POST_BODY_EMPTY_MESSAGE = 'must have some text';

const BODY_TOO_LONG_HEAD = `at most ${String(POST_BODY_MAX_LENGTH)} characters of text, not `;
const TOO_MANY_IMAGES_HEAD = `at most ${String(POST_IMAGES_MAX)} images, not `;
const IMAGE_NOT_USABLE_HEAD = 'image ';
const IMAGE_NOT_USABLE_TAIL =
  ' is not an upload of yours that no other post has taken (upload it again)';

/** More than POST_BODY_MAX_LENGTH characters of text. */
export function postBodyTooLongMessage(length: number): string {
  return `${BODY_TOO_LONG_HEAD}${String(length)}`;
}

/** More than POST_IMAGES_MAX images. */
export function postTooManyImagesMessage(images: number): string {
  return `${TOO_MANY_IMAGES_HEAD}${String(images)}`;
}

/**
 * An image the writer cannot use (the API's check, which needs the database): not an upload of
 * theirs, an upload the clean-up removed after ORPHAN_MEDIA_HOURS, or one another post has taken
 * — one issue per image, naming its media id, so the editor can point at it.
 */
export function postImageNotUsableMessage(mediaId: string): string {
  return `${IMAGE_NOT_USABLE_HEAD}${mediaId}${IMAGE_NOT_USABLE_TAIL}`;
}

/** Which refusal a body issue's message is (`postBodyRefusalOf`). */
export type PostBodyRefusal =
  | { readonly kind: 'empty' }
  | { readonly kind: 'too_long' }
  | { readonly kind: 'too_many_images' }
  | { readonly kind: 'image_not_usable'; readonly mediaId: string };

/** The refusal a message of the functions above says, or undefined for any other message. */
export function postBodyRefusalOf(message: string): PostBodyRefusal | undefined {
  if (message === POST_BODY_EMPTY_MESSAGE) return { kind: 'empty' };
  if (message.startsWith(BODY_TOO_LONG_HEAD)) return { kind: 'too_long' };
  if (message.startsWith(TOO_MANY_IMAGES_HEAD)) return { kind: 'too_many_images' };
  if (message.startsWith(IMAGE_NOT_USABLE_HEAD) && message.endsWith(IMAGE_NOT_USABLE_TAIL)) {
    const mediaId = uuidSchema.safeParse(
      message.slice(IMAGE_NOT_USABLE_HEAD.length, -IMAGE_NOT_USABLE_TAIL.length),
    );
    if (mediaId.success) return { kind: 'image_not_usable', mediaId: mediaId.data };
  }
  return undefined;
}

// ---- normalising ---------------------------------------------------------------------------------

/** One reason a body cannot be a post, where it is (relative to the body). */
export interface PostDocumentIssue {
  readonly path: (string | number)[];
  readonly message: string;
}

/** What a body becomes: the stored document and what the server derives from it. */
export interface SanitizedPostDocument {
  readonly document: PostDocument;
  /**
   * The text without formatting: blocks on lines of their own, a table's cells side by side.
   * What the community list searches (with the title) and previews.
   */
  readonly text: string;
  /** Characters of text, the text nodes' only (POST_BODY_MAX_LENGTH counts these). */
  readonly length: number;
  /** The images' media ids in the order they appear, each once: the first is the list's thumbnail. */
  readonly imageIds: string[];
}

export type SanitizePostDocumentResult =
  | ({ readonly ok: true } & SanitizedPostDocument)
  | { readonly ok: false; readonly issues: PostDocumentIssue[] };

/** Thrown inside the walk for what cannot be a post at all; caught by `sanitizePostDocument`. */
class Refusal extends Error {
  readonly path: (string | number)[];

  constructor(path: (string | number)[], message: string) {
    super(message);
    this.path = path;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const attrsOf = (node: Record<string, unknown>): Record<string, unknown> =>
  isRecord(node.attrs) ? node.attrs : {};

/** A whole number in 1..max, or 1. */
function boundedInt(value: unknown, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max
    ? value
    : 1;
}

/** The order marks are kept in, so the same formatting is always the same JSON. */
const MARK_ORDER: Record<PostMark['type'], number> = {
  bold: 0,
  italic: 1,
  strike: 2,
  code: 3,
  link: 4,
  textStyle: 5,
};

/**
 * A link's address as it is kept: an absolute http(s) URL, no user or password in it (a
 * `https://bank.example@evil.example` reads as one site and goes to another), at most
 * POST_LINK_MAX_LENGTH long, in the URL parser's own spelling (no spaces or control characters
 * left in it). Anything else is no link.
 */
export function postLinkHref(href: unknown): string | undefined {
  if (typeof href !== 'string' || href.length > POST_LINK_MAX_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  return url.href.length > POST_LINK_MAX_LENGTH ? undefined : url.href;
}

function marksOf(value: unknown): PostMark[] {
  if (!Array.isArray(value)) return [];
  const kept = new Map<PostMark['type'], PostMark>();
  for (const mark of value) {
    if (!isRecord(mark) || typeof mark.type !== 'string') continue;
    const type = mark.type;
    if (kept.has(type as PostMark['type'])) continue;
    switch (type) {
      case 'bold':
      case 'italic':
      case 'strike':
      case 'code':
        kept.set(type, { type });
        break;
      case 'link': {
        const href = postLinkHref(attrsOf(mark).href);
        if (href !== undefined) kept.set('link', { type: 'link', attrs: { href } });
        break;
      }
      case 'textStyle': {
        const color = attrsOf(mark).color;
        if ((POST_TEXT_COLORS as readonly unknown[]).includes(color)) {
          kept.set('textStyle', { type: 'textStyle', attrs: { color: color as PostTextColor } });
        }
        break;
      }
      default:
        break;
    }
  }
  // Inline code takes no other mark (TipTap's `code` excludes every other one).
  if (kept.has('code')) return [{ type: 'code' }];
  return [...kept.values()].sort((a, b) => MARK_ORDER[a.type] - MARK_ORDER[b.type]);
}

/**
 * A UTF-16 surrogate with no partner (a pair is one code point in unicode mode, so only a lone
 * half matches). JSON may carry one (`"\ud800"`), and jsonb refuses it on the write (22P02, the
 * same failure `jsonbTextProblem` in release-settings.ts guards against), so it would fail the
 * insert as INTERNAL rather than be a post.
 */
const LONE_SURROGATE = /\p{Cs}/gu;

/**
 * A text node's text as kept: the dropped control characters gone, and a lone surrogate turned
 * into U+FFFD — what Postgres itself makes of one in the title and `body_text` (text columns), so
 * the stored document and the text derived from it say the same thing.
 */
const cleanText = (value: unknown): string =>
  typeof value === 'string' ? value.replace(DROPPED_CONTROLS, '').replace(LONE_SURROGATE, '�') : '';

/** The inline node `node` is, or undefined when it is not one a paragraph keeps. */
function inlineOf(node: Record<string, unknown>): PostInline | undefined {
  if (node.type === 'hardBreak') return { type: 'hardBreak' };
  if (node.type !== 'text') return undefined;
  const text = cleanText(node.text);
  if (text === '') return undefined;
  const marks = marksOf(node.marks);
  return marks.length > 0 ? { type: 'text', text, marks } : { type: 'text', text };
}

function inlinesOf(value: unknown): PostInline[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((node) => {
    const inline = isRecord(node) ? inlineOf(node) : undefined;
    return inline ? [inline] : [];
  });
}

const paragraph = (content: PostInline[]): PostParagraph =>
  content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };

/** Blocks a list item or a table cell holds: at least one, a paragraph first in a list item. */
function withLeadingParagraph(blocks: PostBlock[]): PostBlock[] {
  return blocks[0]?.type === 'paragraph' ? blocks : [paragraph([]), ...blocks];
}

/** Normalises one document, counting images as it goes. */
class Normaliser {
  images = 0;

  blocksOf(value: unknown, depth: number, path: (string | number)[]): PostBlock[] {
    if (!Array.isArray(value)) return [];
    if (depth > POST_DOCUMENT_MAX_DEPTH) {
      throw new Refusal(path, `nested deeper than ${String(POST_DOCUMENT_MAX_DEPTH)} levels`);
    }
    const blocks: PostBlock[] = [];
    let loose: PostInline[] = [];
    const flush = () => {
      if (loose.length > 0) blocks.push(paragraph(loose));
      loose = [];
    };
    value.forEach((node, index) => {
      if (!isRecord(node)) return;
      if (node.type === 'text' || node.type === 'hardBreak') {
        // Text where blocks belong: wrapped in a paragraph with its neighbours.
        const inline = inlineOf(node);
        if (inline) loose.push(inline);
        return;
      }
      flush();
      const block = this.blockOf(node, depth, [...path, index]);
      if (block) blocks.push(block);
    });
    flush();
    return blocks;
  }

  private blockOf(
    node: Record<string, unknown>,
    depth: number,
    path: (string | number)[],
  ): PostBlock | undefined {
    const inner = [...path, 'content'];
    switch (node.type) {
      case 'paragraph':
        return paragraph(inlinesOf(node.content));
      case 'heading': {
        const level = attrsOf(node).level;
        const content = inlinesOf(node.content);
        // A level outside the list is formatting the server removes: the text stays a paragraph.
        if (!(POST_HEADING_LEVELS as readonly unknown[]).includes(level)) return paragraph(content);
        return content.length > 0
          ? { type: 'heading', attrs: { level: level as PostHeadingLevel }, content }
          : { type: 'heading', attrs: { level: level as PostHeadingLevel } };
      }
      case 'blockquote': {
        const content = this.blocksOf(node.content, depth + 1, inner);
        return content.length > 0 ? { type: 'blockquote', content } : undefined;
      }
      case 'bulletList':
      case 'orderedList': {
        const items = this.listItemsOf(node.content, depth + 1, inner);
        if (items.length === 0) return undefined;
        return node.type === 'bulletList'
          ? { type: 'bulletList', content: items }
          : {
              type: 'orderedList',
              attrs: { start: boundedInt(attrsOf(node).start, POST_ORDERED_LIST_START_MAX) },
              content: items,
            };
      }
      case 'codeBlock': {
        const text = (Array.isArray(node.content) ? node.content : [])
          .map((child) => {
            if (!isRecord(child)) return '';
            if (child.type === 'hardBreak') return '\n';
            return child.type === 'text' ? cleanText(child.text) : '';
          })
          .join('');
        return text === ''
          ? { type: 'codeBlock' }
          : { type: 'codeBlock', content: [{ type: 'text', text }] };
      }
      case 'horizontalRule':
        return { type: 'horizontalRule' };
      case 'image': {
        const parsed = uuidSchema.safeParse(attrsOf(node).mediaId);
        if (!parsed.success) return undefined;
        this.images += 1;
        return { type: 'image', attrs: { mediaId: parsed.data } };
      }
      case 'table': {
        const rows = this.rowsOf(node.content, depth + 1, inner);
        return rows.length > 0 ? { type: 'table', content: rows } : undefined;
      }
      default:
        // Not on the list (or a list item, a row or a cell out of place): gone with what it holds.
        return undefined;
    }
  }

  private listItemsOf(value: unknown, depth: number, path: (string | number)[]): PostListItem[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((node, index) => {
      if (!isRecord(node) || node.type !== 'listItem') return [];
      const content = this.blocksOf(node.content, depth + 1, [...path, index, 'content']);
      return [{ type: 'listItem' as const, content: withLeadingParagraph(content) }];
    });
  }

  private rowsOf(value: unknown, depth: number, path: (string | number)[]): PostTableRow[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((row, rowIndex) => {
      if (!isRecord(row) || row.type !== 'tableRow' || !Array.isArray(row.content)) return [];
      const cells = row.content.flatMap((cell, cellIndex): PostTableCell[] => {
        if (!isRecord(cell) || (cell.type !== 'tableCell' && cell.type !== 'tableHeader')) {
          return [];
        }
        const attrs = attrsOf(cell);
        const content = this.blocksOf(cell.content, depth + 1, [
          ...path,
          rowIndex,
          'content',
          cellIndex,
          'content',
        ]);
        return [
          {
            type: cell.type,
            attrs: {
              colspan: boundedInt(attrs.colspan, POST_TABLE_SPAN_MAX),
              rowspan: boundedInt(attrs.rowspan, POST_TABLE_SPAN_MAX),
            },
            content: content.length > 0 ? content : [paragraph([])],
          },
        ];
      });
      return cells.length > 0 ? [{ type: 'tableRow' as const, content: cells }] : [];
    });
  }
}

// ---- reading a normalised document ---------------------------------------------------------------

/** The text of inline content: text as it is, a hard break as a line break. */
const inlineText = (content: PostInline[] | undefined): string =>
  (content ?? []).map((node) => (node.type === 'text' ? node.text : '\n')).join('');

/** One block's text without formatting; '' for an image or a rule. */
function blockText(block: PostBlock): string {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return inlineText(block.content);
    case 'codeBlock':
      return block.content?.[0]?.text ?? '';
    case 'blockquote':
      return blocksText(block.content);
    case 'bulletList':
    case 'orderedList':
      return block.content.map((item) => blocksText(item.content)).join('\n');
    case 'table':
      return block.content
        .map((row) => row.content.map((cell) => blocksText(cell.content)).join(' '))
        .join('\n');
    case 'horizontalRule':
    case 'image':
      return '';
  }
}

function blocksText(blocks: PostBlock[]): string {
  return blocks
    .map(blockText)
    .filter((text) => text !== '')
    .join('\n');
}

/** Every text node of a document, in order (what the length counts). */
function* textNodes(blocks: PostBlock[]): Generator<string> {
  for (const block of blocks) {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
        for (const node of block.content ?? []) if (node.type === 'text') yield node.text;
        break;
      case 'codeBlock':
        for (const node of block.content ?? []) yield node.text;
        break;
      case 'blockquote':
        yield* textNodes(block.content);
        break;
      case 'bulletList':
      case 'orderedList':
        for (const item of block.content) yield* textNodes(item.content);
        break;
      case 'table':
        for (const row of block.content)
          for (const cell of row.content) yield* textNodes(cell.content);
        break;
      case 'horizontalRule':
      case 'image':
        break;
    }
  }
}

/** The media ids of a document's images, in order, each once. */
function imageIdsOf(blocks: PostBlock[], into: string[] = []): string[] {
  for (const block of blocks) {
    switch (block.type) {
      case 'image':
        if (!into.includes(block.attrs.mediaId)) into.push(block.attrs.mediaId);
        break;
      case 'blockquote':
        imageIdsOf(block.content, into);
        break;
      case 'bulletList':
      case 'orderedList':
        for (const item of block.content) imageIdsOf(item.content, into);
        break;
      case 'table':
        for (const row of block.content)
          for (const cell of row.content) imageIdsOf(cell.content, into);
        break;
      default:
        break;
    }
  }
  return into;
}

/**
 * What a document says without formatting, its length and its images — read again from a stored
 * document (the API derives the same values it stored, and the web counts what the editor holds
 * with the same function before it sends).
 */
export function readPostDocument(document: PostDocument): Omit<SanitizedPostDocument, 'document'> {
  let length = 0;
  for (const text of textNodes(document.content)) length += codePointLength(text);
  return { text: blocksText(document.content), length, imageIds: imageIdsOf(document.content) };
}

/**
 * Normalises a body the client sent into a stored document (see the head of this file): what the
 * allow-list does not name is removed, and a body that cannot be a post is refused with where and
 * why. Deterministic: the same input gives the same JSON, so an edit that changes nothing is seen
 * as such.
 */
export function sanitizePostDocument(input: unknown): SanitizePostDocumentResult {
  if (!isRecord(input) || input.type !== 'doc' || !Array.isArray(input.content)) {
    return {
      ok: false,
      issues: [{ path: [], message: 'must be a document: { type: "doc", content: [...] }' }],
    };
  }
  const normaliser = new Normaliser();
  let content: PostBlock[];
  try {
    content = normaliser.blocksOf(input.content, 1, ['content']);
  } catch (error) {
    if (error instanceof Refusal)
      return { ok: false, issues: [{ path: error.path, message: error.message }] };
    throw error;
  }
  const document: PostDocument = { type: 'doc', content };
  const read = readPostDocument(document);
  const issues: PostDocumentIssue[] = [];
  if (read.text.trim() === '') issues.push({ path: [], message: POST_BODY_EMPTY_MESSAGE });
  if (read.length > POST_BODY_MAX_LENGTH) {
    issues.push({ path: [], message: postBodyTooLongMessage(read.length) });
  }
  if (normaliser.images > POST_IMAGES_MAX) {
    issues.push({ path: [], message: postTooManyImagesMessage(normaliser.images) });
  }
  if (issues.length === 0 && utf8Length(JSON.stringify(document)) > POST_DOCUMENT_MAX_BYTES) {
    issues.push({ path: [], message: `larger than ${String(POST_DOCUMENT_MAX_BYTES)} bytes` });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, document, ...read };
}

/**
 * A request's body: any JSON, normalised by `sanitizePostDocument` (a refusal is a
 * VALIDATION_ERROR naming `body` and where in it). Documented as a PostDocument, which is what it
 * should be; the server keeps the allowed part of anything else.
 */
export const postDocumentInputSchema = z
  .unknown()
  .transform((value, ctx): SanitizedPostDocument => {
    const result = sanitizePostDocument(value);
    if (!result.ok) {
      for (const issue of result.issues) {
        ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      }
      return z.NEVER;
    }
    return {
      document: result.document,
      text: result.text,
      length: result.length,
      imageIds: result.imageIds,
    };
  })
  .meta({
    description:
      'A PostDocument (the editor’s JSON). Formatting outside the allow-list is removed; ' +
      `at most ${String(POST_BODY_MAX_LENGTH)} characters of text and ${String(POST_IMAGES_MAX)} images, each an upload of the author's own.`,
  });

/** The start of a post's text for a card: its non-empty lines, at most this many characters. */
export const POST_EXCERPT_MAX_LENGTH = 300;

/**
 * A card's preview (owner decision 2026-10-18: «서식 뺀 앞부분 두 줄»): the text's non-empty lines,
 * trimmed, at most POST_EXCERPT_MAX_LENGTH characters. The web clamps it to two lines; the server
 * sends enough to fill them.
 */
export function postExcerpt(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return codePointSlice(lines.join('\n'), POST_EXCERPT_MAX_LENGTH);
}

/**
 * Canonical JSON (keys sorted at every level): Postgres's `jsonb` hands a document back with its
 * keys in its own order, so a stored document and a new one are compared in this form.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}
