import {
  IMAGE_MAX_BYTES,
  POST_BODY_MAX_LENGTH,
  POST_IMAGES_MAX,
  POST_TEXT_COLORS,
  POST_TITLE_MAX_LENGTH,
  sanitizePostDocument,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { system } from '@/theme/system';
import { ApiError } from './api';
import {
  POST_TEXT_COLOR_LABEL,
  countEditorDocument,
  imagePrecheck,
  imageRefusalMessage,
  imageUploadErrorMessage,
  isPostTextColor,
  linkInputHref,
  pastedLinkHref,
  postTextColorToken,
  titleTooLong,
  uploadContentType,
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
    expect(imageUploadErrorMessage(refused('pixels'))).toBe(copy.errImagePixels);
    expect(imageUploadErrorMessage(refused('frames'))).toBe(copy.errImageFrames);
    expect(imageUploadErrorMessage(refused('unreadable'))).toBe(copy.errImageUnreadable);
    expect(imageUploadErrorMessage(refused('empty'))).toBe(copy.errImageEmpty);
    expect(imageUploadErrorMessage(refused('later'))).toBe(copy.errImageUpload);
    expect(imageRefusalMessage('size')).toBe(copy.errImageSize);
    // Fastify's own cut-off, twice the limit.
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
