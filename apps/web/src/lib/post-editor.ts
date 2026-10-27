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
import { type Node as ProseMirrorNode, type NodeType } from '@tiptap/pm/model';
import { NodeSelection, Selection, TextSelection, type Transaction } from '@tiptap/pm/state';
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
  // One sentence for both (owner decision 2026-10-19): a frame too large to decode, or more frames
  // than the decoding budget — the writer picks a smaller or shorter image. `pixels` is also a
  // frame whose long side is more than 32 times its short side (the API's IMAGE_MAX_SIDE_RATIO),
  // and the owner chose this same sentence for it (owner decision 2026-10-21 (2차), answer 1): there
  // a smaller copy of the same shape is refused again — only a less thin one passes
  // (ADR-0073 결과 5).
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
 * is a stale screen; a refusal for the onboarding says nothing while the onboarding gate takes the
 * account to its step (`gateMoves` — `['me']`, read again after the refusal, names a step left) and
 * the form keeps its draft in the tab, as for a refused send (owner decision 2026-10-21), and when
 * the gate stays — that read failed — says what a refused send says (owner decision 2026-10-21
 * answer 6); an upload given up while it waited to be sent again, the editor gone meanwhile
 * (`UploadAbandoned`), says nothing, as the files a batch never sends once the editor sends no
 * more;
 * anything else is a failed upload, said apart from an unreachable server — the API busy (a 429:
 * the uploads it receives, the account's three in flight, its memory, the conversion queue) still
 * after the editor sent it again (`sendRetrying`, owner decision 2026-10-22 (2차) answer 3), and a
 * body cut for idling or for its deadline (408), included: that file failed, the batch goes on.
 */
export function imageUploadErrorMessage(error: unknown, gateMoves: boolean): string | undefined {
  if (error instanceof UploadAbandoned) return undefined;
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  if (isApiError(error, 'IMAGE_NOT_ALLOWED')) {
    const reason = refusalOf(error.details);
    return reason === undefined ? copy.errImageUpload : imageRefusalMessage(reason);
  }
  if (isApiError(error) && error.status === 413) return copy.errImageSize;
  if (isApiError(error, 'ONBOARDING_REQUIRED')) {
    return gateMoves ? undefined : copy.errPostOnboarding;
  }
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
 * How many times the editor sends an upload again after the API refused it with 429 and a wait
 * (`sendRetrying`): two, so three requests in all (owner decision 2026-10-22 (2차) answer 3).
 */
export const IMAGE_UPLOAD_RETRIES = 2;

/**
 * The longest wait the editor takes before sending an upload again: 10 seconds (the owner's bound,
 * 2026-10-22 (2차) answer 3). A 429 asking for longer — the address limit's minute, say — fails the
 * file at once (owner decision 2026-10-22 (3차) answer 2, as built): sending it before the time the
 * API named would only be refused again.
 */
export const IMAGE_UPLOAD_RETRY_MAX_WAIT_MS = 10_000;

/**
 * The wait when a 429 names none (`details.retryAfterSeconds`): the 2 seconds every 429 of the
 * upload route names (the API's IMAGE_BUSY_RETRY_SECONDS).
 */
export const IMAGE_UPLOAD_RETRY_DEFAULT_WAIT_MS = 2_000;

/**
 * How long to wait before sending again an upload refused with `error`, in milliseconds, or
 * undefined when it is not sent again: only a 429 RATE_LIMITED — the API busy for the moment: the
 * uploads it receives (64MiB), the account's three in flight, its memory, the conversion queue
 * (apps/api image-body.ts, image.ts) or the address limit; the web cannot tell them apart and they
 * all mean «send it again later», so every one of them is sent again (owner decision 2026-10-22
 * (3차) answer 1, as built) — and only when the wait it names, `details.retryAfterSeconds`
 * (the same seconds as its `Retry-After`; IMAGE_UPLOAD_RETRY_DEFAULT_WAIT_MS when it names none),
 * is at most IMAGE_UPLOAD_RETRY_MAX_WAIT_MS.
 */
export function uploadRetryWaitMs(error: unknown): number | undefined {
  if (!isApiError(error, 'RATE_LIMITED') || error.status !== 429) return undefined;
  const { details } = error;
  const seconds =
    typeof details === 'object' && details !== null && 'retryAfterSeconds' in details
      ? (details as { retryAfterSeconds?: unknown }).retryAfterSeconds
      : undefined;
  const wait =
    typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1_000
      : IMAGE_UPLOAD_RETRY_DEFAULT_WAIT_MS;
  return wait <= IMAGE_UPLOAD_RETRY_MAX_WAIT_MS ? wait : undefined;
}

/**
 * An upload given up while it waited to be sent again: the editor went meanwhile (the writer left,
 * or the onboarding gate took the form away). It says nothing (`imageUploadErrorMessage`) — as the
 * files a batch never sends then — and `refused` is the 429 it waited on. A form held meanwhile —
 * its post gone, kept read-only (ADR-0073 9-52·9-53) — gives up nothing: the wait is of the upload
 * on its way, sent again and put in as any that lands then (`sendRetrying`).
 */
export class UploadAbandoned extends Error {
  constructor(readonly refused: unknown) {
    super('The editor took no more images while the upload waited to be sent again');
    this.name = 'UploadAbandoned';
  }
}

/** What `sendRetrying` waits with, and asks before sending again. */
export interface UploadRetrySteps {
  /** Resolves after `ms` (`pause` on the page; a fake in the tests). */
  sleep(ms: number): Promise<void>;
  /**
   * False once the editor is gone (`ImageBatchSteps`' `alive`): the file is not sent again. Never
   * whether the form is held — the file waiting is the upload on its way, not a next one.
   */
  alive(): boolean;
}

/** A wait of `ms`. */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * One file's upload (`send`), sent again after a refusal that only asks to wait (owner decision
 * 2026-10-22 (2차) answer 3): a 429 with a wait of at most 10 seconds (`uploadRetryWaitMs`) is
 * waited out and the file sent again, at most IMAGE_UPLOAD_RETRIES times; the answer of the last
 * send is the outcome — the image, or the refusal the editor says as that file's failure
 * (`imageUploadErrorMessage`, as before). The whole of it is one upload to the editor: the file
 * keeps its turn in the editor's line (`createUploadQueue` — the next file waits) and its count
 * among the uploads, so '올리는 중' stays up and the form holds its send meanwhile. An editor gone
 * by the end of a wait sends nothing more (`UploadAbandoned`). A form held by then — its post gone,
 * kept read-only (ADR-0073 9-52) — still sends the file again: it is the upload on its way, which
 * goes into the held form once it lands (오너 결정 2026-10-25 (2차) «남긴 양식에 넣음», 9-53); the
 * files after it are the ones not sent (`uploadImageBatch`). Any other refusal is the outcome at
 * once, as before.
 */
export async function sendRetrying<T>(send: () => Promise<T>, steps: UploadRetrySteps): Promise<T> {
  let retried = 0;
  for (;;) {
    try {
      return await send();
    } catch (error) {
      const wait = retried < IMAGE_UPLOAD_RETRIES ? uploadRetryWaitMs(error) : undefined;
      if (wait === undefined) throw error;
      retried += 1;
      await steps.sleep(wait);
      if (!steps.alive()) throw new UploadAbandoned(error);
    }
  }
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

/** One editor's uploads, sent one at a time (`createUploadQueue`). */
export interface UploadQueue {
  /** Runs `send` once every send queued before it has settled, however it ended: its outcome. */
  run<T>(send: () => Promise<T>): Promise<T>;
}

/**
 * The line every upload of one editor waits in, whatever batch it is of: one send at a time, in the
 * order they came, a failed one letting the next go. A pick or a drop while another batch uploads
 * starts its own batch (the toolbar and the drop target stay open, `createImageSlots`), and each
 * holds one of the account's three uploads in flight on the API until its answer (owner decision
 * 2026-10-21 answer 4, apps/api image-body.ts) — so batches sent side by side, four single picks
 * during one slow photo, had the fourth refused (429) as that file's failure. In this line the
 * writer's page holds one of the three. Slots are taken when a batch starts all the same
 * (`takeImageBatch`): a file waiting its turn is counted ('이미지 n / 10장').
 */
export function createUploadQueue(): UploadQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(send: () => Promise<T>): Promise<T> {
      const result = tail.then(send);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

/** What `uploadImageBatch` does with each file (components/post/post-editor.tsx). */
export interface ImageBatchSteps<F> {
  /**
   * False once the editor is gone (the writer left, or the onboarding gate took the form away):
   * nothing more leaves, and nothing more goes in. Asked as each file's turn comes, and again as
   * each upload lands, before its image would go in (`place`).
   */
  alive(): boolean;
  /**
   * True once the editor's post is gone and the form kept read-only, to be copied and never
   * changed (ADR-0073 9-52): no next file leaves — no file's turn comes — but an upload already on
   * its way goes on, sent again after a 429 as it would be (`sendRetrying` — one upload to the
   * editor), and goes in as it lands, after what is selected rather than over it (`place` hands
   * `insert` true; 오너 결정 2026-10-25 (2차) «남긴 양식에 넣음», 9-53). The held state itself,
   * never the editor's lock of the moment: an editor locked while something is sent is not held,
   * and drops or stops nothing.
   */
  held(): boolean;
  /**
   * Sends one file and has `place` put its image in the document: `place(insert)` runs `insert`
   * only while the editor is there (`alive`) — the document counts the image from then on — and
   * says whether it did; `insert` is told whether the form is held (`held`), so the image goes in
   * after what is selected. Settles when the file is done with.
   */
  send(file: F, place: (insert: (held: boolean) => void) => boolean): Promise<void>;
  /** A send that failed. */
  failed(error: unknown): void;
}

/**
 * Sends the files `takeImageBatch` let through and took the slots for, one file after another in
 * the editor's line (`queue` — behind the sends of its other batches, `createUploadQueue`), and
 * gives each file's slot back however it ends: placed in the document, or failed. A refusal about
 * the account (`refusesImageBatch`) ends the batch — handed to `failed` once (said once; for the
 * onboarding only when the gate stays — `imageUploadErrorMessage`), the account's state already
 * put on screen by the upload (`postImageUploader`) — and so does an editor that sends no more by
 * a file's turn (gone, or held — its post gone, the form kept read-only, ADR-0073 9-53); the files
 * not sent give their slots back at once. Sending on would have every later file refused alike,
 * each refusal reading the account again, on the page the gate moved to. An upload that lands once
 * the form is held still goes in — 오너 결정 2026-10-25 (2차) «남긴 양식에 넣음» (9-53), one sent
 * again after a 429 meanwhile too (`sendRetrying`) — but `insert` is told so, and puts the image
 * after what is selected, never over it: the text is held to be copied (an image over a selected
 * line replaced it, Codex review of #219, round 6). The files after it are not sent (each turn
 * asks). An upload that lands once the editor is gone puts nothing in: its slot comes back, and
 * the upload stays on the API unused, removed after 24 hours as any upload no post took (9-11).
 * Any other failure is that file's alone (a refused image, the network, the API still busy —
 * RATE_LIMITED — after the file was sent again (`sendRetrying`, inside `send`), a body cut for
 * idling or for its deadline): the batch goes on.
 */
export async function uploadImageBatch<F>(
  files: readonly F[],
  slots: ImageSlots,
  queue: UploadQueue,
  steps: ImageBatchSteps<F>,
): Promise<void> {
  // The slots of the files not yet started.
  let unsent = files.length;
  try {
    for (const file of files) {
      const outcome = await queue.run(async (): Promise<'next' | 'stop'> => {
        if (!steps.alive() || steps.held()) return 'stop';
        unsent -= 1;
        let held = true;
        const giveBack = () => {
          if (!held) return;
          held = false;
          slots.give();
        };
        const place = (insert: (held: boolean) => void): boolean => {
          if (!steps.alive()) return false;
          insert(steps.held());
          giveBack();
          return true;
        };
        try {
          await steps.send(file, place);
          return 'next';
        } catch (error) {
          steps.failed(error);
          return refusesImageBatch(error) ? 'stop' : 'next';
        } finally {
          giveBack();
        }
      });
      if (outcome === 'stop') return;
    }
  } finally {
    slots.give(unsent);
  }
}

/**
 * Where an image goes in a form held read-only, its post gone (ADR-0073 9-52·9-53): after what is
 * selected, never over it — the text is held to be copied (오너 결정 2026-10-25 (2차) «남긴 양식에
 * 넣음»). After a selected node (an image that went in before it), as anywhere; otherwise after the
 * block the selection ends in, so no line is split — the innermost place after it where an image
 * may stand (in a list item, a quote or a cell, after the line within it; failing that, after what
 * holds the line). A selection ending at the very start of a block ends with what comes before it:
 * a triple click the browser makes, as it does in the held editor (9-52), selects through to the
 * next line's start.
 */
export function heldImagePosition(selection: Selection, image: NodeType): number {
  if (selection instanceof NodeSelection) return selection.to;
  let end = selection.$to;
  if (!selection.empty && end.depth > 0 && end.parentOffset === 0) {
    const before = Selection.near(end.doc.resolve(end.before()), -1);
    if (before instanceof NodeSelection) return before.to;
    end = before.$to;
  }
  for (let depth = end.depth; depth > 0; depth -= 1) {
    const $after = end.doc.resolve(end.after(depth));
    if ($after.parent.canReplaceWith($after.index(), $after.index(), image)) return $after.pos;
  }
  return end.pos;
}

/**
 * Puts `image` into a held form's document — `tr`, the editor's transaction — where
 * `heldImagePosition` says, and keeps the selection off it (ADR-0073 9-53): the focus is not moved,
 * nor the image selected. ProseMirror maps a selection through what goes in, and an image going in
 * before its end moves the end past it: a selection through to the next line's start — the
 * browser's triple click in the held editor (9-52) — then took the image in, and the view, which
 * writes its selection back to the page read-only or not, showed it over the image and a copy
 * took it. Such a selection ends instead at the last text before the image — the end of the
 * selected line — anchor and head the way round they were: the line stays selected, the image is
 * not. (One run through an earlier image to the next line's start ends before that image too: a
 * text selection ends in text, never between two images.) Any other selection — one ending
 * before the image, a selected node — is left as ProseMirror maps it.
 */
export function insertHeldImage(tr: Transaction, image: ProseMirrorNode): Transaction {
  const { selection } = tr;
  const at = heldImagePosition(selection, image.type);
  tr.insert(at, image);
  if (!(selection instanceof TextSelection) || selection.empty || at > selection.to) return tr;
  // Its start is a text position before `at` (the image goes in between blocks), where the insert
  // left it; its end, the last text position before the image.
  const lineEnd = Selection.findFrom(tr.doc.resolve(at), -1, true);
  const end = Math.max(selection.from, lineEnd === null ? selection.from : lineEnd.from);
  return tr.setSelection(
    selection.head < selection.anchor
      ? TextSelection.create(tr.doc, end, selection.from)
      : TextSelection.create(tr.doc, selection.from, end),
  );
}

/**
 * One file's upload (`send`) and its preview (`draw` — the editor's `boundedPreviewOf`, a copy at
 * most DRAFT_PREVIEW_MAX_SIDE on its longer side), drawn while the file goes up: the upload's
 * answer and the preview the editor keeps for it. The preview is the drawn copy or nothing — never
 * the file itself, which the editor would otherwise hold decoded for its life (Codex review of
 * #219, round 2) — and a copy that could not be drawn fails nothing: the upload stands. An upload
 * that fails fails the whole, as before, but only once the copy has settled too: the editor's line
 * (`createUploadQueue`) starts the next file when this one settles, and a failure said at once — the
 * network gone, the API's 429 — would start the next file's decode while this one's still ran, so a
 * batch of large photos failing fast decoded them all at the same time (a full decode of each,
 * hundreds of MB on a phone). Settling after the copy keeps one decode at a time, success or not.
 */
export async function uploadWithPreview<F, T>(
  file: F,
  send: (file: F) => Promise<T>,
  draw: (file: F) => Promise<string | undefined>,
): Promise<{ uploaded: T; preview: string | undefined }> {
  const drawing = draw(file).catch(() => undefined);
  let uploaded: T;
  try {
    uploaded = await send(file);
  } catch (error) {
    await drawing;
    throw error;
  }
  return { uploaded, preview: await drawing };
}
