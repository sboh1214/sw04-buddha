import {
  IMAGE_CONTENT_TYPES,
  IMAGE_MAX_BYTES,
  IMAGE_REFUSALS,
  POST_BODY_MAX_LENGTH,
  POST_IMAGES_MAX,
  POST_TEXT_COLORS,
  POST_TITLE_MAX_LENGTH,
  codePointLength,
  postLinkHref,
  type ImageRefusal,
  type PostTextColor,
} from '@buddha/shared';
import { copy } from '@/copy';
import { isApiError, isApiUnreachable, isForAnotherAccount } from './api';

/**
 * The post editor's decisions (#46, ADR-0073), as pure functions the node test runner reaches: what
 * the editor's document counts, which file is worth sending, what a refused upload says, how a typed
 * link becomes an address, and the six text colours.
 *
 * The editor is TipTap (components/post/post-editor.tsx) and its JSON is what the server stores —
 * the node and mark names are TipTap's, the image node carries our `mediaId` instead of a `src`.
 * Nothing the editor decides is trusted: the server keeps what its allow-list names
 * (`sanitizePostDocument`, @buddha/shared post-document.ts) and is the judge of every limit. The
 * editor counts the same way beforehand so a writer sees the limit before sending, not after.
 */

/** A node of the editor's JSON as far as counting goes. */
interface EditorNode {
  type?: unknown;
  text?: unknown;
  content?: unknown;
}

/** What the editor holds, measured as the server will measure it (#45-3, fixed values). */
export interface EditorCount {
  /** Characters of text without the formatting: every text node's code points. */
  length: number;
  /** Image nodes, each one counted (the server refuses more than POST_IMAGES_MAX). */
  images: number;
  /** No character but white space: the server refuses a post with no text. */
  empty: boolean;
  tooLong: boolean;
  tooManyImages: boolean;
}

/**
 * Counts the editor's JSON (`editor.getJSON()`) as `sanitizePostDocument` does: the text nodes'
 * code points (`codePointLength`, so '가', 'a' and '😀' are one each) and every image node. Walked
 * over the raw JSON rather than through the cleaner, because the cleaner refuses a body over the
 * limit and the counter must keep counting past it ('5,012 / 5,000자').
 */
export function countEditorDocument(json: unknown): EditorCount {
  let length = 0;
  let images = 0;
  let empty = true;
  const walk = (node: unknown, depth: number) => {
    if (typeof node !== 'object' || node === null || depth > 64) return;
    const { type, text, content } = node as EditorNode;
    if (type === 'image') images += 1;
    if (type === 'text' && typeof text === 'string') {
      length += codePointLength(text);
      if (text.trim() !== '') empty = false;
    }
    if (Array.isArray(content)) for (const child of content) walk(child, depth + 1);
  };
  walk(json, 0);
  return {
    length,
    images,
    empty,
    tooLong: length > POST_BODY_MAX_LENGTH,
    tooManyImages: images > POST_IMAGES_MAX,
  };
}

/** Whether a title fits (#45-1 optional; 100 characters at most, owner decision 2026-10-18). */
export function titleTooLong(title: string): boolean {
  return codePointLength(title.trim()) > POST_TITLE_MAX_LENGTH;
}

/**
 * Whether a picked file is worth sending: an empty file, one over IMAGE_MAX_BYTES, or one whose
 * declared type is a type the server never takes is refused here, with the server's own reason —
 * a 6MB photo would otherwise travel all the way up to be refused. Anything else goes up and the
 * server decides by the bytes (a file with no declared type included), so this never lets a file
 * through that the server would not check, and never refuses one it would take.
 */
export function imagePrecheck(file: { type: string; size: number }): ImageRefusal | undefined {
  if (file.size === 0) return 'empty';
  if (file.size > IMAGE_MAX_BYTES) return 'size';
  if (file.type !== '' && !(IMAGE_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    return 'type';
  }
  return undefined;
}

/**
 * The `Content-Type` the upload goes under: the file's own when it is one of the four the route
 * takes, `application/octet-stream` otherwise (the route's parser takes those five only). The
 * declared type decides nothing on the server — the bytes do.
 */
export function uploadContentType(file: { type: string }): string {
  return (IMAGE_CONTENT_TYPES as readonly string[]).includes(file.type)
    ? file.type
    : 'application/octet-stream';
}

const IMAGE_REFUSAL_MESSAGE: Record<ImageRefusal, string> = {
  type: copy.errImageType,
  size: copy.errImageSize,
  pixels: copy.errImagePixels,
  frames: copy.errImageFrames,
  unreadable: copy.errImageUnreadable,
  empty: copy.errImageEmpty,
};

export function imageRefusalMessage(reason: ImageRefusal): string {
  return IMAGE_REFUSAL_MESSAGE[reason];
}

/** IMAGE_NOT_ALLOWED's `details.reason`, when it is one of the reasons the route names. */
function refusalOf(details: unknown): ImageRefusal | undefined {
  if (typeof details !== 'object' || details === null || !('reason' in details)) return undefined;
  const reason: unknown = (details as { reason?: unknown }).reason;
  return (IMAGE_REFUSALS as readonly unknown[]).includes(reason)
    ? (reason as ImageRefusal)
    : undefined;
}

/**
 * What a refused upload says: the server's reason (IMAGE_NOT_ALLOWED); a body Fastify cut off
 * before the route (413, twice the limit) is the size; the cookie as another account is a stale
 * screen; anything else is a failed upload, said apart from an unreachable server.
 */
export function imageUploadErrorMessage(error: unknown): string {
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  if (isApiError(error, 'IMAGE_NOT_ALLOWED')) {
    const reason = refusalOf(error.details);
    return reason === undefined ? copy.errImageUpload : imageRefusalMessage(reason);
  }
  if (isApiError(error) && error.status === 413) return copy.errImageSize;
  if (isApiError(error, 'ONBOARDING_REQUIRED')) return copy.errPostOnboarding;
  return isApiUnreachable(error) ? copy.errNetwork : copy.errImageUpload;
}

/**
 * A link the writer typed, as the post will keep it (`postLinkHref`: http or https, no user or
 * password, at most POST_LINK_MAX_LENGTH), or undefined for one the server would drop. An address
 * typed without a scheme ('example.com/a') is read as https — what a browser's address bar does.
 */
export function linkInputHref(raw: string): string | undefined {
  const typed = raw.trim();
  if (typed === '') return undefined;
  return postLinkHref(/^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`);
}

/**
 * The address a link pasted or dropped as HTML keeps (`<a href>` from another page or app): the
 * server's own reading (`postLinkHref` — an absolute http(s) address, in the URL parser's
 * spelling), or none, and then the link's text is pasted as plain text. Never `linkInputHref`'s
 * reading: that one is for an address the writer typed, and it would turn a page's relative
 * `/about` into `https://about/` — a link to somewhere else. So the editor shows a link only where
 * the saved post will have one.
 */
export function pastedLinkHref(href: string | null): string | undefined {
  return href === null ? undefined : postLinkHref(href);
}

/**
 * The six text colours (owner decision 2026-10-18: «빨강·주황·초록·파랑·보라·회색»). The document
 * stores the name; the screen paints the theme's `postText.<name>` token, a value readable on the
 * page in either theme (theme/system.ts, measured in contrast.test.ts).
 */
export const POST_TEXT_COLOR_LABEL: Readonly<Record<PostTextColor, string>> = {
  red: copy.editorColorRed,
  orange: copy.editorColorOrange,
  green: copy.editorColorGreen,
  blue: copy.editorColorBlue,
  purple: copy.editorColorPurple,
  gray: copy.editorColorGray,
};

export function postTextColorToken(color: PostTextColor): string {
  return `postText.${color}`;
}

/** The palette in its order, for the toolbar. */
export const POST_TEXT_COLOR_OPTIONS: readonly PostTextColor[] = POST_TEXT_COLORS;

/** Whether a stored colour name is one of the six (a document from the API always is). */
export function isPostTextColor(value: unknown): value is PostTextColor {
  return (POST_TEXT_COLORS as readonly unknown[]).includes(value);
}
