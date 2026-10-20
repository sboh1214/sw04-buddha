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

/**
 * The count the form shows and judges ('이미지 n / 10장'): the document's images and the uploads
 * still on their way (`ImageSlots.inFlight` — a batch's files the precheck let through, from when
 * it is picked until each is in the document or has failed, `takeImageBatch`), as a batch picked
 * past the limit is refused by (owner decision 2026-10-21). A file the precheck refuses is never
 * on its way, so never counted. An upload going into the document moves from one to the other, so
 * the number holds still while a batch lands and falls only for a file that fails or is refused.
 */
export function countWithUploads(count: EditorCount, uploading: number): EditorCount {
  const images = count.images + uploading;
  return { ...count, images, tooManyImages: images > POST_IMAGES_MAX };
}

/**
 * The media ids of the editor's image nodes, in the order they appear (each once): the uploads a
 * kept draft holds previews for (lib/post-drafts.ts).
 */
export function editorImageIds(json: unknown): string[] {
  const ids = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (typeof node !== 'object' || node === null || depth > 64) return;
    const { type, content } = node as EditorNode;
    const attrs = (node as { attrs?: unknown }).attrs;
    if (type === 'image' && typeof attrs === 'object' && attrs !== null) {
      const mediaId = (attrs as { mediaId?: unknown }).mediaId;
      if (typeof mediaId === 'string') ids.add(mediaId);
    }
    if (Array.isArray(content)) for (const child of content) walk(child, depth + 1);
  };
  walk(json, 0);
  return [...ids];
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
  // One sentence for both (owner decision 2026-10-19): a frame too large to decode, or more
  // frames than the decoding budget — the writer picks a smaller or shorter image either way.
  pixels: copy.errImageTooLarge,
  frames: copy.errImageTooLarge,
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
 * What a refused upload says, or nothing: the server's reason (IMAGE_NOT_ALLOWED); a body refused
 * by its length before the route (413, twice the limit) is the size; the cookie as another account
 * is a stale screen; a refusal for the onboarding says nothing — the gate takes the account to its
 * step and the form keeps its draft in the tab, as for a refused send (owner decision 2026-10-21);
 * anything else is a failed upload, said apart from an unreachable server — the API busy receiving
 * other uploads (RATE_LIMITED) included: that file failed, the batch goes on.
 */
export function imageUploadErrorMessage(error: unknown): string | undefined {
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  if (isApiError(error, 'IMAGE_NOT_ALLOWED')) {
    const reason = refusalOf(error.details);
    return reason === undefined ? copy.errImageUpload : imageRefusalMessage(reason);
  }
  if (isApiError(error) && error.status === 413) return copy.errImageSize;
  if (isApiError(error, 'ONBOARDING_REQUIRED')) return undefined;
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

/**
 * Whether the write or edit form holds something leaving would lose (owner decision 2026-10-19,
 * ADR-0073: leaving with a draft asks first): a title other than the one it started with (spaces
 * at either end aside — the server trims them), a body the editor changed from the document it
 * started with (`bodyChanged`: the editor's JSON compared with its own JSON when it was made), or
 * an image still uploading.
 */
export function draftChanged(draft: {
  title: string;
  initialTitle: string | null;
  bodyChanged: boolean;
  uploading: boolean;
}): boolean {
  return (
    draft.uploading || draft.bodyChanged || draft.title.trim() !== (draft.initialTitle ?? '').trim()
  );
}

/**
 * Whether the editor's document `json` differs from `baseline`, the editor's own JSON when it was
 * made (`PostEditor`'s `onReady`, serialised): false while there is no baseline yet. The stored
 * body is no baseline — the editor fills in attributes it leaves out — so an edit screen nobody
 * typed in would always differ from it.
 */
export function bodyChangedFrom(baseline: string | null, json: unknown): boolean {
  return baseline !== null && JSON.stringify(json) !== baseline;
}

/** The editor's image slots (`createImageSlots`). */
export interface ImageSlots {
  /** Uploads taken and not yet in the document, nor given up. */
  readonly inFlight: number;
  /**
   * Takes a slot for each of `count` files beside the document's `held` images, or nothing — and
   * false — when the document, the uploads on their way and these would pass the limit.
   */
  take(held: number, count: number): boolean;
  /**
   * Gives `count` slots back (one by default): their images are in the document now (counted
   * there), or never will be.
   */
  give(count?: number): void;
}

/**
 * The images a post may still take (#45-3: POST_IMAGES_MAX): those in the document and the uploads
 * still on their way. The toolbar and the drop target stay open while uploads run, so a second
 * batch picked or dropped meanwhile counts the first one's files too — counting the document alone,
 * two batches could each pass and land more images than a post holds, the form unsendable and the
 * surplus uploads orphans. A batch takes its slots before its first file leaves — one for each file
 * the precheck lets through (`takeImageBatch`) — and gives each back as its image goes into the
 * document or fails, and those of the files a stopped batch never sent at once (`uploadImageBatch`).
 * `onChange` hears every change of `inFlight`: the form's count shows the uploads too
 * (`countWithUploads`).
 */
export function createImageSlots(
  max: number = POST_IMAGES_MAX,
  onChange?: (inFlight: number) => void,
): ImageSlots {
  let inFlight = 0;
  const set = (next: number) => {
    if (next === inFlight) return;
    inFlight = next;
    onChange?.(inFlight);
  };
  return {
    get inFlight() {
      return inFlight;
    },
    take(held, count) {
      if (held + inFlight + count > max) return false;
      set(inFlight + count);
      return true;
    },
    give(count = 1) {
      set(Math.max(0, inFlight - count));
    },
  };
}

/**
 * Whether an upload's refusal is about the account rather than the file: no session
 * (UNAUTHENTICATED), the cookie as another account (`isForAnotherAccount`), or a step of the
 * onboarding left (ONBOARDING_REQUIRED). Every file after it would be refused the same way.
 */
export function refusesImageBatch(error: unknown): boolean {
  return (
    isApiError(error, 'ONBOARDING_REQUIRED') ||
    isApiError(error, 'UNAUTHENTICATED') ||
    isForAnotherAccount(error)
  );
}

/** A picked or dropped batch as `takeImageBatch` starts it. */
export interface ImageBatchStart<F> {
  /** The files the precheck let through, in the order picked: the ones the batch sends. */
  readonly sending: readonly F[];
  /** The precheck's reason for each file it refused (`imagePrecheck`), in order: never sent. */
  readonly refusals: readonly ImageRefusal[];
  /**
   * Whether `sending` holds its slots now: false when the document's images, the uploads on their
   * way and these would pass the limit — then none of the batch is sent. True for a batch the
   * precheck refused whole (nothing to take).
   */
  readonly taken: boolean;
}

/**
 * Starts a batch: the precheck over every file first (`imagePrecheck`), then the slots
 * (`ImageSlots.take`) for the files it let through, and for those alone. A file refused here never
 * leaves, so it is never one of the uploads on their way — not in the count ('이미지 n / 10장'),
 * nor in the number a batch past the limit is refused by (owner decision 2026-10-21 answer 2) —
 * and its refusal is said at once, not after every upload ahead of it. Taking first, a batch's
 * 6MB photo held a slot until its turn came, and eleven files with one of them over 5MB were
 * refused whole although ten would have been sent.
 */
export function takeImageBatch<F extends { type: string; size: number }>(
  files: readonly F[],
  held: number,
  slots: ImageSlots,
): ImageBatchStart<F> {
  const sending: F[] = [];
  const refusals: ImageRefusal[] = [];
  for (const file of files) {
    const refusal = imagePrecheck(file);
    if (refusal === undefined) sending.push(file);
    else refusals.push(refusal);
  }
  const taken = sending.length === 0 || slots.take(held, sending.length);
  return { sending, refusals, taken };
}

/** What `uploadImageBatch` does with each file (components/post/post-editor.tsx). */
export interface ImageBatchSteps<F> {
  /** False once the editor is gone (the onboarding gate took the form away): nothing more leaves. */
  alive(): boolean;
  /**
   * Sends one file and puts its image in the document, calling `placed` once the image is there
   * (the document counts it from then on); settles when the file is done with.
   */
  send(file: F, placed: () => void): Promise<void>;
  /** A send that failed. */
  failed(error: unknown): void;
}

/**
 * Sends the files `takeImageBatch` let through and took the slots for, one file after another, and
 * gives each file's slot back however it ends: placed in the document, or failed. A refusal about
 * the account (`refusesImageBatch`) ends the batch — handed to `failed` once (said once, or for the
 * onboarding not at all — `imageUploadErrorMessage`), the account's state already put on screen by
 * the upload (`postImageUploader`) — and so does an editor gone; the files not sent give their
 * slots back at once. Sending on would have every later file refused alike, each refusal reading
 * the account again, on the page the gate moved to. Any other failure is that file's alone (a
 * refused image, the network, the API busy receiving — RATE_LIMITED): the batch goes on.
 */
export async function uploadImageBatch<F>(
  files: readonly F[],
  slots: ImageSlots,
  steps: ImageBatchSteps<F>,
): Promise<void> {
  // The slots of the files not yet started.
  let unsent = files.length;
  try {
    for (const file of files) {
      if (!steps.alive()) return;
      unsent -= 1;
      let held = true;
      const giveBack = () => {
        if (!held) return;
        held = false;
        slots.give();
      };
      try {
        await steps.send(file, giveBack);
      } catch (error) {
        steps.failed(error);
        if (refusesImageBatch(error)) return;
      } finally {
        giveBack();
      }
    }
  } finally {
    slots.give(unsent);
  }
}
