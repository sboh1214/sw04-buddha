import {
  IMAGE_MAX_BYTES,
  POST_BODY_MAX_LENGTH,
  POST_IMAGES_MAX,
  POST_TEXT_COLORS,
  POST_TITLE_MAX_LENGTH,
  sanitizePostDocument,
} from '@buddha/shared';
import { describe, expect, it, vi } from 'vitest';
import { copy } from '@/copy';
import { system } from '@/theme/system';
import { ApiError } from './api';
import { postWriteErrorMessage } from './posts';
import {
  IMAGE_UPLOAD_RETRIES,
  IMAGE_UPLOAD_RETRY_DEFAULT_WAIT_MS,
  IMAGE_UPLOAD_RETRY_MAX_WAIT_MS,
  POST_TEXT_COLOR_LABEL,
  UploadAbandoned,
  bodyChangedFrom,
  countEditorDocument,
  countWithUploads,
  createImageSlots,
  createUploadQueue,
  draftChanged,
  editorImageIds,
  imagePrecheck,
  imageRefusalMessage,
  imageUploadErrorMessage,
  isPostTextColor,
  linkInputHref,
  pastedLinkHref,
  postTextColorToken,
  refusesImageBatch,
  sendRetrying,
  takeImageBatch,
  titleTooLong,
  uploadContentType,
  uploadImageBatch,
  uploadRetryWaitMs,
  uploadWithPreview,
} from './post-editor';

/**
 * The editor's decisions (#46, ADR-0073). The server is the judge of every limit; these hold the
 * editor to counting the way it does, so a writer sees a limit before sending rather than after.
 */

const MEDIA = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const paragraph = (text: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});
const image = { type: 'image', attrs: { mediaId: MEDIA } };
const doc = (...content: unknown[]) => ({ type: 'doc', content });

describe('countEditorDocument', () => {
  it('counts code points of text, wherever the text sits, and every image', () => {
    const json = doc(
      paragraph('가a😀'),
      { type: 'heading', attrs: { level: 2, id: null }, content: [{ type: 'text', text: '제목' }] },
      image,
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                attrs: { colspan: 1, rowspan: 1, colwidth: null },
                content: [paragraph('칸')],
              },
            ],
          },
        ],
      },
      { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('항목'), image] }] },
    );
    expect(countEditorDocument(json)).toEqual({
      length: 3 + 2 + 1 + 2,
      images: 2,
      empty: false,
      tooLong: false,
      tooManyImages: false,
    });
  });

  it('counts as the server does for a body within the limits (TipTap’s extra attributes and all)', () => {
    const json = doc(
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: '굵은 링크',
            marks: [
              { type: 'bold' },
              { type: 'link', attrs: { href: 'https://example.com', target: '_blank', rel: 'x' } },
            ],
          },
          { type: 'hardBreak' },
          { type: 'text', text: '빨강', marks: [{ type: 'textStyle', attrs: { color: 'red' } }] },
        ],
      },
      { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'x = 1' }] },
      { type: 'orderedList', attrs: { start: 1, type: null }, content: [] },
    );
    const server = sanitizePostDocument(json);
    expect(server.ok).toBe(true);
    if (server.ok) expect(countEditorDocument(json).length).toBe(server.length);
  });

  it('keeps counting past the limit, and says when it is past', () => {
    const over = countEditorDocument(doc(paragraph('가'.repeat(POST_BODY_MAX_LENGTH + 12))));
    expect(over.length).toBe(POST_BODY_MAX_LENGTH + 12);
    expect(over.tooLong).toBe(true);
    expect(countEditorDocument(doc(paragraph('가'.repeat(POST_BODY_MAX_LENGTH)))).tooLong).toBe(
      false,
    );
    const images = countEditorDocument(
      doc(paragraph('a'), ...Array.from({ length: POST_IMAGES_MAX + 1 }, () => image)),
    );
    expect(images.images).toBe(POST_IMAGES_MAX + 1);
    expect(images.tooManyImages).toBe(true);
  });

  it('calls a body of white space and images empty, as the server refuses it', () => {
    expect(countEditorDocument(doc()).empty).toBe(true);
    expect(countEditorDocument(doc(paragraph('   '), image)).empty).toBe(true);
    expect(countEditorDocument(undefined).empty).toBe(true);
  });
});

describe('the title', () => {
  it('is at most 100 characters, counted as code points after trimming', () => {
    expect(titleTooLong('가'.repeat(100))).toBe(false);
    expect(titleTooLong(`  ${'가'.repeat(100)}  `)).toBe(false);
    expect(titleTooLong('가'.repeat(101))).toBe(true);
    expect(titleTooLong('😀'.repeat(100))).toBe(false);
  });
});

describe('a picked image', () => {
  it('is stopped here only for what the server would refuse anyway', () => {
    expect(imagePrecheck({ type: 'image/png', size: 0 })).toBe('empty');
    expect(imagePrecheck({ type: 'image/png', size: IMAGE_MAX_BYTES + 1 })).toBe('size');
    expect(imagePrecheck({ type: 'image/heic', size: 100 })).toBe('type');
    expect(imagePrecheck({ type: 'image/png', size: IMAGE_MAX_BYTES })).toBeUndefined();
    // No declared type: the server reads the bytes.
    expect(imagePrecheck({ type: '', size: 100 })).toBeUndefined();
  });

  it('goes up under its own type, or as bytes', () => {
    expect(uploadContentType({ type: 'image/webp' })).toBe('image/webp');
    expect(uploadContentType({ type: '' })).toBe('application/octet-stream');
    expect(uploadContentType({ type: 'image/svg+xml' })).toBe('application/octet-stream');
  });

  it('says the server’s reason when it refuses one', () => {
    const refused = (reason: string) =>
      new ApiError(422, { code: 'IMAGE_NOT_ALLOWED', message: 'x', details: { reason } } as never);
    expect(imageUploadErrorMessage(refused('type'), true)).toBe(copy.errImageType);
    expect(imageUploadErrorMessage(refused('size'), true)).toBe(copy.errImageSize);
    // One sentence for a frame too large and for too many frames (owner decision 2026-10-19).
    expect(copy.errImageTooLarge).toBe('이미지가 너무 크거나 프레임이 너무 많습니다.');
    expect(imageUploadErrorMessage(refused('pixels'), true)).toBe(copy.errImageTooLarge);
    expect(imageUploadErrorMessage(refused('frames'), true)).toBe(copy.errImageTooLarge);
    expect(imageUploadErrorMessage(refused('unreadable'), true)).toBe(copy.errImageUnreadable);
    expect(imageUploadErrorMessage(refused('empty'), true)).toBe(copy.errImageEmpty);
    expect(imageUploadErrorMessage(refused('later'), true)).toBe(copy.errImageUpload);
    expect(imageRefusalMessage('size')).toBe(copy.errImageSize);
    // Refused by its length before the route, past twice the limit.
    expect(
      imageUploadErrorMessage(
        new ApiError(413, { code: 'VALIDATION_ERROR', message: 'too large' } as never),
        true,
      ),
    ).toBe(copy.errImageSize);
    expect(
      imageUploadErrorMessage(
        new ApiError(403, {
          code: 'FORBIDDEN',
          message: 'x',
          details: [{ path: ['expectedAccountId'], message: 'other account' }],
        }),
        true,
      ),
    ).toBe(copy.sessionChanged);
    expect(imageUploadErrorMessage(new TypeError('Failed to fetch'), true)).toBe(copy.errNetwork);
  });

  it('says nothing for a refusal for the onboarding while the gate takes the account to its step, and what a refused send says when it stays (owner decisions 2026-10-21)', () => {
    const onboarding = new ApiError(409, {
      code: 'ONBOARDING_REQUIRED',
      message: 'x',
      details: { steps: ['consent'] },
    } as never);
    // `['me']` read again names the step: the gate moves, and a toast would follow it there.
    expect(imageUploadErrorMessage(onboarding, true)).toBeUndefined();
    // That read failed (the address limit's 429, the network): the gate stays, so it is said.
    expect(imageUploadErrorMessage(onboarding, false)).toBe(copy.errPostOnboarding);
    expect(copy.errPostOnboarding).toBe(postWriteErrorMessage(onboarding));
    // Whether the gate moves says nothing about any other refusal.
    expect(imageUploadErrorMessage(new TypeError('Failed to fetch'), false)).toBe(copy.errNetwork);
  });

  it('says that the file failed when the API is still busy after it was sent again, or cut the body for idling or for its deadline (owner decisions 2026-10-21, 2026-10-22 (2차))', () => {
    // 429 with Retry-After, the last of the sends (`sendRetrying`): the uploads being received hold
    // the process's budget, the account has three uploads in flight, the memory has no room or too
    // many conversions wait — that file's failure, nothing about the account.
    expect(
      imageUploadErrorMessage(
        new ApiError(429, {
          code: 'RATE_LIMITED',
          message: 'busy',
          details: { retryAfterSeconds: 2 },
        } as never),
        true,
      ),
    ).toBe(copy.errImageUpload);
    // 408: no byte of the body came for 30 seconds, or the whole body not within 2 minutes.
    expect(
      imageUploadErrorMessage(
        new ApiError(408, { code: 'VALIDATION_ERROR', message: 'idle' } as never),
        true,
      ),
    ).toBe(copy.errImageUpload);
  });

  it('says nothing of an upload given up because the editor went while it waited to be sent again', () => {
    const busy = new ApiError(429, {
      code: 'RATE_LIMITED',
      message: 'busy',
      details: { retryAfterSeconds: 2 },
    } as never);
    expect(imageUploadErrorMessage(new UploadAbandoned(busy), false)).toBeUndefined();
    expect(imageUploadErrorMessage(new UploadAbandoned(busy), true)).toBeUndefined();
    expect(refusesImageBatch(new UploadAbandoned(busy))).toBe(false);
  });
});

describe('a typed link', () => {
  it('is kept only as an http(s) address the server keeps', () => {
    expect(linkInputHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(linkInputHref(' http://example.com ')).toBe('http://example.com/');
    expect(linkInputHref('example.com/a')).toBe('https://example.com/a');
    expect(linkInputHref('javascript:alert(1)')).toBeUndefined();
    expect(linkInputHref('JaVaScRiPt:alert(1)')).toBeUndefined();
    expect(linkInputHref('data:text/html,<script>')).toBeUndefined();
    expect(linkInputHref('mailto:a@example.com')).toBeUndefined();
    expect(linkInputHref('https://bank.example@evil.example')).toBeUndefined();
    expect(linkInputHref('')).toBeUndefined();
  });
});

describe('a pasted link', () => {
  it('is kept only as the absolute http(s) address the server keeps, never guessed', () => {
    expect(pastedLinkHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(pastedLinkHref('HTTP://Example.com')).toBe('http://example.com/');
    // What the server would drop, the editor does not show as a link either: a page's relative
    // address (which `linkInputHref` would read as https://about/), a bare host, another scheme.
    for (const href of ['/about', 'about', 'example.com', '//cdn.example.com/x', 'javascript:x']) {
      expect(pastedLinkHref(href), href).toBeUndefined();
    }
    expect(linkInputHref('/about')).toBe('https://about/');
    expect(pastedLinkHref('https://bank.example@evil.example')).toBeUndefined();
    expect(pastedLinkHref(null)).toBeUndefined();
  });
});

describe('the text colours', () => {
  it('name all six, each with a label and a theme token', () => {
    for (const color of POST_TEXT_COLORS) {
      expect(POST_TEXT_COLOR_LABEL[color]).not.toBe('');
      expect(isPostTextColor(color)).toBe(true);
      expect(system.tokens.getByName(`colors.${postTextColorToken(color)}`)).toBeDefined();
    }
    expect(isPostTextColor('#ff0000')).toBe(false);
    expect(isPostTextColor('pink')).toBe(false);
  });
});

describe('the copy', () => {
  it('names the limits the shared constants hold (owner decisions, ADR-0069 decision 2 #45-3)', () => {
    const number = (value: number) => value.toLocaleString('ko-KR');
    expect(copy.errPostTitle).toContain(`${number(POST_TITLE_MAX_LENGTH)}자`);
    expect(copy.errPostBodyTooLong).toContain(`${number(POST_BODY_MAX_LENGTH)}자`);
    expect(copy.errPostTooManyImages).toContain(`${number(POST_IMAGES_MAX)}장`);
    expect(copy.errImageSize).toContain(`${String(IMAGE_MAX_BYTES / 1024 / 1024)}MB`);
  });
});

describe('draftChanged', () => {
  // Leaving the write or edit screen asks first while this holds (owner decision 2026-10-19).
  const clean = { title: '', initialTitle: null, bodyChanged: false, uploading: false };

  it('is false for a form as it started', () => {
    expect(draftChanged(clean)).toBe(false);
    expect(draftChanged({ ...clean, title: '그대로', initialTitle: '그대로' })).toBe(false);
    // Spaces at either end are trimmed by the server: nothing to lose.
    expect(draftChanged({ ...clean, title: '  ' })).toBe(false);
    expect(draftChanged({ ...clean, title: ' 그대로 ', initialTitle: '그대로' })).toBe(false);
  });

  it('is true for a changed title or body, and while an image uploads', () => {
    expect(draftChanged({ ...clean, title: '새 제목' })).toBe(true);
    expect(draftChanged({ ...clean, title: '', initialTitle: '지운 제목' })).toBe(true);
    expect(draftChanged({ ...clean, bodyChanged: true })).toBe(true);
    expect(draftChanged({ ...clean, uploading: true })).toBe(true);
  });

  it('asks in the sentence the owner approved (2026-10-20)', () => {
    expect(copy.postLeaveConfirm).toBe('쓰던 내용이 사라집니다. 나갈까요?');
  });
});

describe('editorImageIds', () => {
  const other = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

  it('names each image of the document once, in order, wherever it sits', () => {
    expect(
      editorImageIds({
        type: 'doc',
        content: [
          image,
          paragraph('글'),
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  { type: 'tableCell', content: [{ type: 'image', attrs: { mediaId: other } }] },
                ],
              },
            ],
          },
          image,
        ],
      }),
    ).toEqual([MEDIA, other]);
  });

  it('names nothing for a document without images, or for what is no document', () => {
    expect(editorImageIds({ type: 'doc', content: [paragraph('글')] })).toEqual([]);
    expect(editorImageIds({ type: 'doc', content: [{ type: 'image', attrs: {} }] })).toEqual([]);
    expect(editorImageIds(null)).toEqual([]);
    expect(editorImageIds('doc')).toEqual([]);
  });
});

describe('bodyChangedFrom', () => {
  const made = { type: 'doc', content: [{ type: 'paragraph', attrs: { textAlign: null } }] };
  const typed = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { textAlign: null }, content: [{ type: 'text', text: '근거' }] },
    ],
  };

  it('compares the editor’s document with its own first one, and nothing before there is one', () => {
    expect(bodyChangedFrom(null, typed)).toBe(false);
    const baseline = JSON.stringify(made);
    expect(bodyChangedFrom(baseline, made)).toBe(false);
    expect(bodyChangedFrom(baseline, typed)).toBe(true);
    // Typed and taken out again: nothing to lose.
    expect(bodyChangedFrom(baseline, structuredClone(made))).toBe(false);
  });
});

describe('countWithUploads', () => {
  const doc = (images: number) => ({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '근거' }] },
      ...Array.from({ length: images }, (_, index) => ({
        type: 'image',
        attrs: { mediaId: `m${String(index)}` },
      })),
    ],
  });

  it('counts the uploads on their way with the document’s images (owner decision 2026-10-21)', () => {
    const counted = countWithUploads(countEditorDocument(doc(3)), 4);
    expect(counted.images).toBe(7);
    expect(counted.tooManyImages).toBe(false);
    // The text's count is the document's.
    expect(counted.length).toBe(2);
    expect(counted.empty).toBe(false);
    expect(countWithUploads(countEditorDocument(doc(0)), 0).images).toBe(0);
  });

  it('holds still while an image goes from the uploads into the document', () => {
    expect(countWithUploads(countEditorDocument(doc(6)), 4).images).toBe(POST_IMAGES_MAX);
    expect(countWithUploads(countEditorDocument(doc(7)), 3).images).toBe(POST_IMAGES_MAX);
    expect(countWithUploads(countEditorDocument(doc(7)), 3).tooManyImages).toBe(false);
  });

  it('is past the limit only when the two together are', () => {
    expect(countWithUploads(countEditorDocument(doc(10)), 1).tooManyImages).toBe(true);
    expect(countWithUploads(countEditorDocument(doc(11)), 0).tooManyImages).toBe(true);
  });
});

describe('createImageSlots', () => {
  it('counts the uploads on their way beside the document, so batches together stay within the limit', () => {
    const slots = createImageSlots();
    // A first batch of six leaves; while it uploads, a second of five would pass ten.
    expect(slots.take(0, 6)).toBe(true);
    expect(slots.take(0, 5)).toBe(false);
    expect(slots.inFlight).toBe(6);
    // Four more fit beside them.
    expect(slots.take(0, 4)).toBe(true);
    expect(slots.inFlight).toBe(POST_IMAGES_MAX);
    // Each image landing moves from the uploads to the document: still no room.
    for (let landed = 1; landed <= 3; landed += 1) {
      slots.give();
      expect(slots.take(landed, 1)).toBe(false);
    }
    // An upload that fails gives its slot back for good.
    slots.give();
    expect(slots.take(3, 1)).toBe(true);
    expect(slots.inFlight).toBe(7);
  });

  it('gives back no more than it took', () => {
    const slots = createImageSlots(2);
    slots.give();
    expect(slots.inFlight).toBe(0);
    expect(slots.take(0, 2)).toBe(true);
    expect(slots.take(0, 1)).toBe(false);
    slots.give(5);
    expect(slots.inFlight).toBe(0);
  });

  it('gives several back at once', () => {
    const slots = createImageSlots();
    expect(slots.take(0, 6)).toBe(true);
    slots.give(4);
    expect(slots.inFlight).toBe(2);
    expect(slots.take(2, 6)).toBe(true);
  });

  it('tells every change of the uploads on their way, and nothing else (the form’s count)', () => {
    const heard: number[] = [];
    const slots = createImageSlots(POST_IMAGES_MAX, (inFlight) => heard.push(inFlight));
    expect(slots.take(0, 6)).toBe(true);
    // Refused: nothing taken, nothing told.
    expect(slots.take(0, 5)).toBe(false);
    slots.give();
    slots.give(2);
    // Nothing given back that was not taken, nothing given at all: no change.
    slots.give(0);
    slots.give(5);
    slots.give();
    expect(heard).toEqual([6, 5, 3, 0]);
  });
});

/** An upload refusal the API would answer, as `unwrap` throws it. */
const refusal = (status: number, code: string, details?: unknown) =>
  new ApiError(status, { code, message: code, details } as never);

const ONBOARDING = refusal(409, 'ONBOARDING_REQUIRED', { steps: ['consent'] });
const ANOTHER_ACCOUNT = refusal(403, 'FORBIDDEN', [
  { path: ['expectedAccountId'], message: 'not the signed-in account' },
]);
const SIGNED_OUT = refusal(401, 'UNAUTHENTICATED');
const NOT_AN_IMAGE = refusal(422, 'IMAGE_NOT_ALLOWED', { reason: 'type' });

describe('refusesImageBatch', () => {
  it('is a refusal about the account, not about the file', () => {
    expect(refusesImageBatch(ONBOARDING)).toBe(true);
    expect(refusesImageBatch(ANOTHER_ACCOUNT)).toBe(true);
    expect(refusesImageBatch(SIGNED_OUT)).toBe(true);
    expect(refusesImageBatch(NOT_AN_IMAGE)).toBe(false);
    expect(refusesImageBatch(refusal(413, 'VALIDATION_ERROR'))).toBe(false);
    expect(refusesImageBatch(refusal(429, 'RATE_LIMITED'))).toBe(false);
    // The CSRF refusal names no field: about the request, not the account on screen.
    expect(refusesImageBatch(refusal(403, 'FORBIDDEN'))).toBe(false);
    expect(refusesImageBatch(new TypeError('Failed to fetch'))).toBe(false);
  });
});

const file = (name: string, size = 100, type = 'image/png') => ({ name, size, type });
const photos = (count: number, first = 1) =>
  Array.from({ length: count }, (_, index) => file(`photo-${String(first + index)}`));

describe('takeImageBatch', () => {
  it('says the precheck’s refusals at once and takes slots for the files it lets through alone', () => {
    const slots = createImageSlots();
    const files = [
      file('first'),
      file('empty', 0),
      file('too-large', IMAGE_MAX_BYTES + 1),
      file('a-pdf', 100, 'application/pdf'),
      file('second'),
    ];
    const batch = takeImageBatch(files, 0, slots);
    expect(batch.sending.map(({ name }) => name)).toEqual(['first', 'second']);
    expect(batch.refusals).toEqual(['empty', 'size', 'type']);
    expect(batch.taken).toBe(true);
    // Two on their way, not five: the count shows two (owner decision 2026-10-21 answer 2).
    expect(slots.inFlight).toBe(2);
  });

  it('takes one slot fewer for a file over 5MB: eleven with one too large are ten, within the limit', () => {
    const slots = createImageSlots();
    const files = [...photos(5), file('too-large', IMAGE_MAX_BYTES + 1), ...photos(5, 6)];
    const batch = takeImageBatch(files, 0, slots);
    expect(batch.taken).toBe(true);
    expect(batch.sending).toHaveLength(POST_IMAGES_MAX);
    expect(batch.refusals).toEqual(['size']);
    expect(slots.inFlight).toBe(POST_IMAGES_MAX);
  });

  it('refuses a batch whose sendable files would pass the limit, taking nothing — the refusals still said', () => {
    const slots = createImageSlots();
    expect(slots.take(0, 6)).toBe(true);
    // Three fit beside the document's one and the six on their way: ten. The PDF the precheck
    // refuses is not counted — a slot for every file would have made it eleven, refused whole.
    const fits = takeImageBatch([...photos(3), file('a-pdf', 100, 'application/pdf')], 1, slots);
    expect(fits.taken).toBe(true);
    expect(slots.inFlight).toBe(9);
    // Two more that would be sent pass the limit: nothing taken, the empty file still said.
    const over = takeImageBatch([...photos(2), file('empty', 0)], 1, slots);
    expect(over.taken).toBe(false);
    expect(over.refusals).toEqual(['empty']);
    expect(slots.inFlight).toBe(9);
  });

  it('takes nothing for a batch the precheck refuses whole, and calls it no batch past the limit', () => {
    const slots = createImageSlots();
    expect(slots.take(0, POST_IMAGES_MAX)).toBe(true);
    const batch = takeImageBatch([file('a-pdf', 100, 'application/pdf')], 0, slots);
    expect(batch).toEqual({ sending: [], refusals: ['type'], taken: true });
    expect(slots.inFlight).toBe(POST_IMAGES_MAX);
  });
});

describe('uploadImageBatch', () => {
  /**
   * A batch over `files` whose slots were taken, each send answered by `answer` (a thrown error, or
   * nothing for an upload that lands and is placed): what each step saw, and the slots it holds
   * while each file is sent.
   */
  async function run(
    files: { name: string; size: number; type: string }[],
    answer: (name: string) => Error | undefined,
    options: { alive?: () => boolean } = {},
  ) {
    const slots = createImageSlots();
    expect(slots.take(0, files.length)).toBe(true);
    const sent: string[] = [];
    const heldWhileSending: number[] = [];
    const failed = vi.fn();
    await uploadImageBatch(files, slots, createUploadQueue(), {
      alive: options.alive ?? (() => true),
      send: async (sending, placed) => {
        sent.push(sending.name);
        heldWhileSending.push(slots.inFlight);
        await Promise.resolve();
        const error = answer(sending.name);
        if (error !== undefined) throw error;
        placed();
        // Placed: the document counts it, the slot is back before the send settles.
        heldWhileSending.push(slots.inFlight);
      },
      failed,
    });
    return { slots, sent, heldWhileSending, failed };
  }

  it('gives each file’s slot back however it ends: placed, or failed', async () => {
    const files = [file('placed'), file('not-an-image'), file('down'), file('last')];
    const result = await run(files, (name) =>
      name === 'not-an-image'
        ? NOT_AN_IMAGE
        : name === 'down'
          ? new TypeError('Failed to fetch')
          : undefined,
    );
    // A refusal about the file, or the network, leaves the rest of the batch going.
    expect(result.sent).toEqual(['placed', 'not-an-image', 'down', 'last']);
    expect(result.failed.mock.calls).toEqual([[NOT_AN_IMAGE], [expect.any(TypeError)]]);
    // Four taken; the first placed gives one back at once, each failure its own before the next.
    expect(result.heldWhileSending).toEqual([4, 3, 3, 2, 1, 0]);
    expect(result.slots.inFlight).toBe(0);
    // All ten are free again.
    expect(result.slots.take(0, POST_IMAGES_MAX)).toBe(true);
  });

  it('goes on past a file refused because the API is busy receiving uploads (owner decision 2026-10-21)', async () => {
    const BUSY = refusal(429, 'RATE_LIMITED', { retryAfterSeconds: 2 });
    const result = await run([file('a'), file('b'), file('c')], (name) =>
      name === 'b' ? BUSY : undefined,
    );
    // That file's failure alone: the others are sent and placed, every slot back.
    expect(result.sent).toEqual(['a', 'b', 'c']);
    expect(result.failed.mock.calls).toEqual([[BUSY]]);
    expect(result.slots.inFlight).toBe(0);
    expect(result.slots.take(2, POST_IMAGES_MAX - 2)).toBe(true);
  });

  it.each([
    ['for the onboarding', ONBOARDING],
    ['as another account', ANOTHER_ACCOUNT],
    ['for no session', SIGNED_OUT],
  ])(
    'ends the batch at an upload refused %s: said once, nothing more sent, every slot back',
    async (_name, error) => {
      const result = await run(
        [file('first'), file('second'), file('third'), file('fourth')],
        () => error,
      );
      expect(result.sent).toEqual(['first']);
      expect(result.failed.mock.calls).toEqual([[error]]);
      expect(result.slots.inFlight).toBe(0);
      expect(result.slots.take(0, POST_IMAGES_MAX)).toBe(true);
    },
  );

  it('ends the batch at an account refusal after files that went in, and gives the rest back', async () => {
    const result = await run([file('a'), file('b'), file('c'), file('d')], (name) =>
      name === 'b' ? ONBOARDING : undefined,
    );
    expect(result.sent).toEqual(['a', 'b']);
    // One image in the document; the other three slots are free.
    expect(result.slots.inFlight).toBe(0);
    expect(result.slots.take(1, POST_IMAGES_MAX - 1)).toBe(true);
  });

  it('sends nothing more once the editor is gone, and gives the unsent files’ slots back', async () => {
    // Asked as each file's turn comes: there for the first, gone before the second.
    let asked = 0;
    const result = await run([file('a'), file('b'), file('c')], () => undefined, {
      alive: () => {
        asked += 1;
        return asked === 1;
      },
    });
    expect(result.sent).toEqual(['a']);
    expect(asked).toBe(2);
    expect(result.failed).not.toHaveBeenCalled();
    expect(result.slots.inFlight).toBe(0);
  });

  /** A send that waits until let go: the sends in flight, and the most there were at once. */
  function heldSends() {
    const waiting: (() => void)[] = [];
    let inFlight = 0;
    let most = 0;
    const sent: string[] = [];
    const send = async (sending: { name: string }, placed: () => void) => {
      sent.push(sending.name);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise<void>((resolve) => waiting.push(resolve));
      inFlight -= 1;
      placed();
    };
    return {
      send,
      sent,
      waiting,
      get most() {
        return most;
      },
    };
  }

  /** Lets the sends go one after another until every batch has ended. */
  async function letEachGo(sends: ReturnType<typeof heldSends>, batches: Promise<void>[]) {
    let done = false;
    void Promise.all(batches).then(() => {
      done = true;
    });
    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      sends.waiting.shift()?.();
    }
  }

  it('sends one file at a time from one editor, whatever batches it has going (the account’s three in flight, owner decision 2026-10-21 answer 4)', async () => {
    // Three single picks and a pair while the first is still on its way: each its own batch, all
    // in the editor's one line.
    const slots = createImageSlots();
    const queue = createUploadQueue();
    const sends = heldSends();
    const failed = vi.fn();
    const batches = [['a'], ['b'], ['c', 'd'], ['e']].map((names) => {
      expect(slots.take(0, names.length)).toBe(true);
      return uploadImageBatch(
        names.map((name) => file(name)),
        slots,
        queue,
        { alive: () => true, send: sends.send, failed },
      );
    });
    await letEachGo(sends, batches);
    expect(sends.most).toBe(1);
    // In the order they came: a batch's next file queues behind the files picked meanwhile.
    expect(sends.sent).toEqual(['a', 'b', 'c', 'e', 'd']);
    expect(failed).not.toHaveBeenCalled();
    expect(slots.inFlight).toBe(0);
  });

  it('lets the next file go after one that failed, and sends nothing of a waiting batch once the editor is gone', async () => {
    const slots = createImageSlots();
    const queue = createUploadQueue();
    const failed = vi.fn();
    let alive = true;
    const sent: string[] = [];
    const steps = {
      alive: () => alive,
      send: async (sending: { name: string }, placed: () => void) => {
        sent.push(sending.name);
        await Promise.resolve();
        if (sending.name === 'refused') throw NOT_AN_IMAGE;
        if (sending.name === 'last') alive = false;
        placed();
      },
      failed,
    };
    expect(slots.take(0, 5)).toBe(true);
    const first = uploadImageBatch([file('refused'), file('last')], slots, queue, steps);
    const waiting = uploadImageBatch(
      [file('next'), file('never'), file('nor')],
      slots,
      queue,
      steps,
    );
    await Promise.all([first, waiting]);
    // The failure is that file's alone; once the editor is gone, the waiting batch's turn comes and
    // sends nothing more — every slot back.
    expect(sent).toEqual(['refused', 'next', 'last']);
    expect(failed.mock.calls).toEqual([[NOT_AN_IMAGE]]);
    expect(slots.inFlight).toBe(0);
  });
});

describe('createUploadQueue', () => {
  it('runs one send at a time, in the order they came, each with its own outcome', async () => {
    const queue = createUploadQueue();
    const order: string[] = [];
    let running = 0;
    const send = (name: string, fail = false) =>
      queue.run(async () => {
        running += 1;
        expect(running).toBe(1);
        order.push(`${name} starts`);
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push(`${name} ends`);
        running -= 1;
        if (fail) throw new Error(name);
        return name;
      });
    const outcomes = await Promise.allSettled([send('a'), send('b', true), send('c')]);
    expect(outcomes).toEqual([
      { status: 'fulfilled', value: 'a' },
      { status: 'rejected', reason: new Error('b') },
      { status: 'fulfilled', value: 'c' },
    ]);
    expect(order).toEqual(['a starts', 'a ends', 'b starts', 'b ends', 'c starts', 'c ends']);
  });
});

describe('uploadWithPreview', () => {
  const file = { name: 'photo.jpg', original: 'data:image/jpeg;base64,THE-WHOLE-FILE' };
  const small = 'data:image/webp;base64,640px';

  it('keeps the drawn copy as the preview, never the file (Codex review of #219, round 2)', async () => {
    const send = vi.fn(() => Promise.resolve({ id: 'm-1' }));
    const draw = vi.fn(() => Promise.resolve(small));
    const result = await uploadWithPreview(file, send, draw);
    expect(result).toEqual({ uploaded: { id: 'm-1' }, preview: small });
    expect(JSON.stringify(result)).not.toContain(file.original);
    expect(send).toHaveBeenCalledWith(file);
    expect(draw).toHaveBeenCalledWith(file);
  });

  it('draws the copy while the file goes up', async () => {
    let answer!: (value: { id: string }) => void;
    const send = () =>
      new Promise<{ id: string }>((resolve) => {
        answer = resolve;
      });
    const draw = vi.fn(() => Promise.resolve(small));
    const result = uploadWithPreview(file, send, draw);
    // The upload has not answered, and the copy is being drawn already.
    expect(draw).toHaveBeenCalledTimes(1);
    answer({ id: 'm-2' });
    await expect(result).resolves.toEqual({ uploaded: { id: 'm-2' }, preview: small });
  });

  it('has no preview, rather than the file, when the copy cannot be drawn; an upload that fails fails it', async () => {
    const send = () => Promise.resolve({ id: 'm-3' });
    await expect(
      uploadWithPreview(file, send, () => Promise.reject(new Error('undecodable'))),
    ).resolves.toEqual({ uploaded: { id: 'm-3' }, preview: undefined });
    await expect(uploadWithPreview(file, send, () => Promise.resolve(undefined))).resolves.toEqual({
      uploaded: { id: 'm-3' },
      preview: undefined,
    });
    await expect(
      uploadWithPreview(
        file,
        () => Promise.reject(new Error('refused')),
        () => Promise.resolve(small),
      ),
    ).rejects.toThrow('refused');
  });

  it('fails an upload that fails at once only when its copy has settled too', async () => {
    let drawn!: (value: string | undefined) => void;
    const draw = () =>
      new Promise<string | undefined>((resolve) => {
        drawn = resolve;
      });
    const offline = new TypeError('Failed to fetch');
    const result = uploadWithPreview(file, () => Promise.reject(offline), draw);
    let settled = false;
    void result.then(
      () => (settled = true),
      () => (settled = true),
    );
    // The upload has failed; the copy is still being drawn, and the file is not done with.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    drawn(small);
    await expect(result).rejects.toBe(offline);
    // A copy that cannot be drawn either: the upload's failure, still once the copy has settled.
    await expect(
      uploadWithPreview(
        file,
        () => Promise.reject(offline),
        () => Promise.reject(new Error('undecodable')),
      ),
    ).rejects.toBe(offline);
  });
});

describe('the editor’s line, each file sent with its copy (uploadImageBatch over uploadWithPreview)', () => {
  it('draws one copy at a time even when every upload fails at once, so a batch never decodes its photos side by side', async () => {
    const files = [file('a'), file('b'), file('c')];
    const slots = createImageSlots();
    expect(slots.take(0, files.length)).toBe(true);
    const drawing: string[] = [];
    let running = 0;
    let most = 0;
    const draw = async ({ name }: { name: string }) => {
      running += 1;
      most = Math.max(most, running);
      drawing.push(`${name} starts`);
      // A large photo's decode, which outlasts an upload refused at once.
      await new Promise((resolve) => setTimeout(resolve, 5));
      drawing.push(`${name} ends`);
      running -= 1;
      return 'data:image/webp;base64,640px';
    };
    const failed = vi.fn();
    await uploadImageBatch(files, slots, createUploadQueue(), {
      alive: () => true,
      send: async (sending) => {
        // The network gone: every upload fails before its copy is drawn.
        await uploadWithPreview(
          sending,
          () => Promise.reject(new TypeError('Failed to fetch')),
          draw,
        );
      },
      failed,
    });
    expect(most).toBe(1);
    expect(drawing).toEqual(['a starts', 'a ends', 'b starts', 'b ends', 'c starts', 'c ends']);
    // Each file's failure alone: the batch went on, and every slot is back.
    expect(failed).toHaveBeenCalledTimes(3);
    expect(slots.inFlight).toBe(0);
  });
});

describe('an upload the API asks to send again later (owner decision 2026-10-22 (2차) answer 3)', () => {
  const busy = (retryAfterSeconds?: number) =>
    refusal(
      429,
      'RATE_LIMITED',
      retryAfterSeconds === undefined ? undefined : { retryAfterSeconds },
    );

  it('is sent again twice at most, after a wait of at most 10 seconds', () => {
    expect(IMAGE_UPLOAD_RETRIES).toBe(2);
    expect(IMAGE_UPLOAD_RETRY_MAX_WAIT_MS).toBe(10_000);
    // The upload route's own 2 seconds, for a 429 naming none.
    expect(IMAGE_UPLOAD_RETRY_DEFAULT_WAIT_MS).toBe(2_000);
  });

  it('waits what the 429 names, up to the bound, and is not sent again for anything else', () => {
    expect(uploadRetryWaitMs(busy(2))).toBe(2_000);
    expect(uploadRetryWaitMs(busy(0))).toBe(0);
    expect(uploadRetryWaitMs(busy(10))).toBe(10_000);
    expect(uploadRetryWaitMs(busy())).toBe(IMAGE_UPLOAD_RETRY_DEFAULT_WAIT_MS);
    // Longer than the bound (the address limit's minute): it would be refused again — failed now.
    expect(uploadRetryWaitMs(busy(11))).toBeUndefined();
    expect(uploadRetryWaitMs(busy(60))).toBeUndefined();
    // Anything but the API's own 429 is the outcome at once.
    expect(uploadRetryWaitMs(NOT_AN_IMAGE)).toBeUndefined();
    expect(uploadRetryWaitMs(ONBOARDING)).toBeUndefined();
    expect(uploadRetryWaitMs(ANOTHER_ACCOUNT)).toBeUndefined();
    expect(uploadRetryWaitMs(refusal(408, 'VALIDATION_ERROR'))).toBeUndefined();
    expect(uploadRetryWaitMs(refusal(413, 'VALIDATION_ERROR'))).toBeUndefined();
    expect(uploadRetryWaitMs(new TypeError('Failed to fetch'))).toBeUndefined();
    // A 429 something between wrote (no envelope): not the API asking.
    expect(uploadRetryWaitMs(new ApiError(429, undefined))).toBeUndefined();
  });

  /** `sendRetrying` over answers given in turn, its waits recorded rather than slept. */
  async function retrying(answers: (Error | string)[], alive: () => boolean = () => true) {
    const waits: number[] = [];
    let sends = 0;
    const outcome = await sendRetrying(
      () => {
        const answer = answers[sends];
        sends += 1;
        if (answer === undefined) return Promise.reject(new Error('sent more often than answered'));
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
      {
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
        alive,
      },
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    return { outcome, waits, sends };
  }

  it('is the image after two 429s, each waited out', async () => {
    const result = await retrying([busy(2), busy(1), 'uploaded']);
    expect(result.outcome).toEqual({ value: 'uploaded' });
    expect(result.sends).toBe(3);
    expect(result.waits).toEqual([2_000, 1_000]);
  });

  it('fails with the third 429: three sends in all', async () => {
    const third = busy(2);
    const result = await retrying([busy(2), busy(2), third, 'never sent']);
    expect(result.outcome).toEqual({ error: third });
    expect(result.sends).toBe(3);
    expect(result.waits).toEqual([2_000, 2_000]);
  });

  it('fails at once for a 429 asking for more than the bound, and for any other refusal', async () => {
    const long = busy(30);
    expect(await retrying([long, 'never sent'])).toEqual({
      outcome: { error: long },
      sends: 1,
      waits: [],
    });
    expect(await retrying([NOT_AN_IMAGE, 'never sent'])).toEqual({
      outcome: { error: NOT_AN_IMAGE },
      sends: 1,
      waits: [],
    });
    // After a 429 waited out, a refusal of the file is the outcome as it comes.
    expect(await retrying([busy(2), NOT_AN_IMAGE, 'never sent'])).toEqual({
      outcome: { error: NOT_AN_IMAGE },
      sends: 2,
      waits: [2_000],
    });
  });

  it('sends nothing more once the editor has gone during the wait', async () => {
    const first = busy(2);
    const result = await retrying([first, 'never sent'], () => false);
    expect(result.sends).toBe(1);
    expect(result.waits).toEqual([2_000]);
    const { error } = result.outcome as { error: unknown };
    expect(error).toBeInstanceOf(UploadAbandoned);
    expect((error as UploadAbandoned).refused).toBe(first);
  });

  it('keeps the file uploading, its slot held and the next file waiting its turn, through the waits', async () => {
    vi.useFakeTimers();
    try {
      const slots = createImageSlots();
      expect(slots.take(0, 2)).toBe(true);
      const sent: string[] = [];
      const failed = vi.fn();
      let refusals = 2;
      const batch = uploadImageBatch([file('busy'), file('next')], slots, createUploadQueue(), {
        alive: () => true,
        send: async (sending, placed) => {
          await sendRetrying(
            () => {
              sent.push(sending.name);
              if (sending.name === 'busy' && refusals > 0) {
                refusals -= 1;
                return Promise.reject(busy(2));
              }
              return Promise.resolve();
            },
            {
              sleep: (ms) =>
                new Promise((resolve) => {
                  setTimeout(resolve, ms);
                }),
              alive: () => true,
            },
          );
          placed();
        },
        failed,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toEqual(['busy']);
      // Waiting out the first 429: both files still on their way, the next not sent.
      await vi.advanceTimersByTimeAsync(1_999);
      expect(sent).toEqual(['busy']);
      expect(slots.inFlight).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toEqual(['busy', 'busy']);
      await vi.advanceTimersByTimeAsync(2_000);
      await batch;
      // The third send took it, then the next file went.
      expect(sent).toEqual(['busy', 'busy', 'busy', 'next']);
      expect(failed).not.toHaveBeenCalled();
      expect(slots.inFlight).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
