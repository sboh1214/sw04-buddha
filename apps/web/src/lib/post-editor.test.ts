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
import {
  POST_TEXT_COLOR_LABEL,
  bodyChangedFrom,
  countEditorDocument,
  countWithUploads,
  createImageSlots,
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
  takeImageBatch,
  titleTooLong,
  uploadContentType,
  uploadImageBatch,
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
    expect(imageUploadErrorMessage(refused('type'))).toBe(copy.errImageType);
    expect(imageUploadErrorMessage(refused('size'))).toBe(copy.errImageSize);
    // One sentence for a frame too large and for too many frames (owner decision 2026-10-19).
    expect(copy.errImageTooLarge).toBe('이미지가 너무 크거나 프레임이 너무 많습니다.');
    expect(imageUploadErrorMessage(refused('pixels'))).toBe(copy.errImageTooLarge);
    expect(imageUploadErrorMessage(refused('frames'))).toBe(copy.errImageTooLarge);
    expect(imageUploadErrorMessage(refused('unreadable'))).toBe(copy.errImageUnreadable);
    expect(imageUploadErrorMessage(refused('empty'))).toBe(copy.errImageEmpty);
    expect(imageUploadErrorMessage(refused('later'))).toBe(copy.errImageUpload);
    expect(imageRefusalMessage('size')).toBe(copy.errImageSize);
    // Refused by its length before the route, past twice the limit.
    expect(
      imageUploadErrorMessage(
        new ApiError(413, { code: 'VALIDATION_ERROR', message: 'too large' } as never),
      ),
    ).toBe(copy.errImageSize);
    expect(
      imageUploadErrorMessage(
        new ApiError(403, {
          code: 'FORBIDDEN',
          message: 'x',
          details: [{ path: ['expectedAccountId'], message: 'other account' }],
        }),
      ),
    ).toBe(copy.sessionChanged);
    expect(imageUploadErrorMessage(new TypeError('Failed to fetch'))).toBe(copy.errNetwork);
  });

  it('says nothing for a refusal for the onboarding: the gate takes the account to its step (owner decision 2026-10-21)', () => {
    expect(
      imageUploadErrorMessage(
        new ApiError(409, {
          code: 'ONBOARDING_REQUIRED',
          message: 'x',
          details: { steps: ['consent'] },
        } as never),
      ),
    ).toBeUndefined();
  });

  it('says that the file failed when the API is busy receiving other uploads (owner decision 2026-10-21)', () => {
    // 429 with Retry-After: the uploads being received hold the process's budget, or too many
    // conversions wait — that file's failure, nothing about the account.
    expect(
      imageUploadErrorMessage(
        new ApiError(429, {
          code: 'RATE_LIMITED',
          message: 'busy',
          details: { retryAfterSeconds: 2 },
        } as never),
      ),
    ).toBe(copy.errImageUpload);
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
    await uploadImageBatch(files, slots, {
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
    // Asked before each file: there for the first, gone before the second.
    let asked = 0;
    const result = await run([file('a'), file('b'), file('c')], () => undefined, {
      alive: () => {
        asked += 1;
        return asked === 1;
      },
    });
    expect(result.sent).toEqual(['a']);
    expect(result.failed).not.toHaveBeenCalled();
    expect(result.slots.inFlight).toBe(0);
  });
});
