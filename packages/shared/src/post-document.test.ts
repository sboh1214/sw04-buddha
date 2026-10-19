import { describe, expect, it } from 'vitest';
import {
  POST_BODY_MAX_LENGTH,
  POST_DOCUMENT_MAX_BYTES,
  POST_DOCUMENT_MAX_DEPTH,
  POST_EXCERPT_MAX_LENGTH,
  POST_IMAGES_MAX,
  POST_LINK_MAX_LENGTH,
  POST_BODY_EMPTY_MESSAGE,
  POST_TEXT_COLORS,
  canonicalJson,
  codePointLength,
  postBlockSchema,
  postBodyRefusalOf,
  postBodyTooLongMessage,
  postDocumentInputSchema,
  postDocumentSchema,
  postExcerpt,
  postImageNotUsableMessage,
  postLinkHref,
  postTooManyImagesMessage,
  readPostDocument,
  sanitizePostDocument,
  type PostDocument,
} from './post-document.js';

const MEDIA = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';
const MEDIA_2 = '1c7f7b4f-3d2e-4d9f-8a1b-2c3d4e5f6071';

const doc = (...content: unknown[]) => ({ type: 'doc', content });
const p = (...content: unknown[]) =>
  content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
const t = (text: string, marks?: unknown[]) =>
  marks ? { type: 'text', text, marks } : { type: 'text', text };

/** The stored document of an input the sanitizer accepts. */
function kept(input: unknown): PostDocument {
  const result = sanitizePostDocument(input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.document;
}

/** The issues of an input the sanitizer refuses. */
function refused(input: unknown) {
  const result = sanitizePostDocument(input);
  if (result.ok) throw new Error('accepted');
  return result.issues;
}

describe('sanitizePostDocument: what the allow-list keeps', () => {
  it('keeps every allowed node and mark as the editor sends it', () => {
    const input = doc(
      { type: 'heading', attrs: { level: 2 }, content: [t('제목')] },
      p(
        t('굵게', [{ type: 'bold' }]),
        t('기울임', [{ type: 'italic' }]),
        t('취소', [{ type: 'strike' }]),
        t('코드', [{ type: 'code' }]),
        { type: 'hardBreak' },
        t('링크', [{ type: 'link', attrs: { href: 'https://example.com/a?b=1#c' } }]),
        t('빨강', [{ type: 'textStyle', attrs: { color: 'red' } }]),
      ),
      { type: 'blockquote', content: [p(t('인용'))] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('하나'))] }] },
      {
        type: 'orderedList',
        attrs: { start: 3 },
        content: [{ type: 'listItem', content: [p(t('셋'))] }],
      },
      { type: 'codeBlock', content: [t('let a = 1;\nlet b = 2;')] },
      { type: 'horizontalRule' },
      { type: 'image', attrs: { mediaId: MEDIA } },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', attrs: { colspan: 1, rowspan: 1 }, content: [p(t('머리'))] },
              { type: 'tableCell', attrs: { colspan: 2, rowspan: 1 }, content: [p(t('칸'))] },
            ],
          },
        ],
      },
    );
    const result = sanitizePostDocument(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document).toEqual(input);
    // The stored shape is the documented one.
    expect(postDocumentSchema.safeParse(result.document).success).toBe(true);
    expect(result.imageIds).toEqual([MEDIA]);
    expect(result.text).toBe(
      [
        '제목',
        '굵게기울임취소코드\n링크빨강',
        '인용',
        '하나',
        '셋',
        'let a = 1;\nlet b = 2;',
        '머리 칸',
      ].join('\n'),
    );
    // The text nodes only: 15 in the heading and the paragraph, 2 + 2 + 1 in the quote and the
    // lists, 21 in the code block (its spaces and line break are its text) and 3 in the table.
    expect(result.length).toBe(44);
  });

  it('keeps every colour of the palette', () => {
    for (const color of POST_TEXT_COLORS) {
      expect(kept(doc(p(t('x', [{ type: 'textStyle', attrs: { color } }]))))).toEqual(
        doc(p(t('x', [{ type: 'textStyle', attrs: { color } }]))),
      );
    }
  });

  it('is deterministic: marks in one order, each once, the same JSON every time', () => {
    const input = doc(
      p(
        t('x', [
          { type: 'textStyle', attrs: { color: 'blue' } },
          { type: 'link', attrs: { href: 'http://example.com' } },
          { type: 'italic' },
          { type: 'bold' },
          { type: 'bold' },
        ]),
      ),
    );
    const first = kept(input);
    expect(first).toEqual(
      doc(
        p(
          t('x', [
            { type: 'bold' },
            { type: 'italic' },
            { type: 'link', attrs: { href: 'http://example.com/' } },
            { type: 'textStyle', attrs: { color: 'blue' } },
          ]),
        ),
      ),
    );
    // A stored document normalises to itself.
    expect(kept(first)).toEqual(first);
  });
});

describe('sanitizePostDocument: what the server removes (XSS and the rest of the world)', () => {
  it('drops a link that is not http(s), has a user or password, or is too long — the text stays', () => {
    for (const href of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'mailto:a@b.c',
      '/relative/path',
      '//evil.example/x',
      'https://bank.example@evil.example/',
      'https://user:pass@example.com/',
      `https://example.com/${'a'.repeat(POST_LINK_MAX_LENGTH)}`,
      42,
      null,
    ]) {
      expect(kept(doc(p(t('click', [{ type: 'link', attrs: { href } }]))))).toEqual(
        doc(p(t('click'))),
      );
    }
  });

  it('keeps a link in the URL parser’s spelling, so no space or control character survives in it', () => {
    expect(postLinkHref('https://Example.com/a b')).toBe('https://example.com/a%20b');
    expect(postLinkHref('  https://example.com  ')).toBe('https://example.com/');
    expect(postLinkHref('https://example.com/a\u0000b')).toBe('https://example.com/a%00b');
    expect(postLinkHref('https://exa\tmple.com/\n')).toBe('https://example.com/');
  });

  it('drops unknown marks, a colour outside the palette and attributes nobody asked for', () => {
    expect(
      kept(
        doc(
          p(
            t('x', [
              { type: 'underline' },
              { type: 'textStyle', attrs: { color: '#ff0000' } },
              { type: 'textStyle', attrs: { color: 'red; background: url(x)' } },
              { type: 'highlight', attrs: { color: 'yellow' } },
              {
                type: 'link',
                attrs: { href: 'https://example.com/', target: '_self', onclick: 'x' },
              },
              'bold',
              null,
              { notype: true },
            ]),
          ),
        ),
      ),
    ).toEqual(doc(p(t('x', [{ type: 'link', attrs: { href: 'https://example.com/' } }]))));
    expect(
      kept(doc(p(t('x', [{ type: 'textStyle', attrs: { color: 'red', fontFamily: 'x' } }])))),
    ).toEqual(doc(p(t('x', [{ type: 'textStyle', attrs: { color: 'red' } }]))));
    expect(
      kept(
        doc({ type: 'paragraph', attrs: { textAlign: 'center', style: 'x' }, content: [t('x')] }),
      ),
    ).toEqual(doc(p(t('x'))));
  });

  it('keeps inline code alone: TipTap’s code mark excludes every other one', () => {
    expect(kept(doc(p(t('x', [{ type: 'bold' }, { type: 'code' }]))))).toEqual(
      doc(p(t('x', [{ type: 'code' }]))),
    );
  });

  it('drops unknown nodes with what they hold, never as HTML', () => {
    expect(
      kept(
        doc(
          { type: 'html', content: [t('<script>alert(1)</script>')] },
          { type: 'iframe', attrs: { src: 'https://evil.example' } },
          { type: 'script', text: 'alert(1)' },
          p(
            t('남는 글'),
            { type: 'mention', attrs: { id: 'x' } },
            { type: 'image', attrs: { mediaId: MEDIA } },
          ),
          { type: 'listItem', content: [p(t('밖의 항목'))] },
          { type: 'tableRow', content: [] },
          'a string',
          null,
          [p(t('배열'))],
        ),
      ),
    ).toEqual(doc(p(t('남는 글'))));
  });

  it('keeps text that looks like markup as text: it is never parsed', () => {
    const text = '<img src=x onerror=alert(1)> <script>alert(1)</script> &lt;';
    expect(kept(doc(p(t(text))))).toEqual(doc(p(t(text))));
  });

  it('keeps an image only by a media id, never by a URL', () => {
    expect(
      kept(
        doc(
          p(t('글')),
          { type: 'image', attrs: { src: 'https://evil.example/x.png' } },
          { type: 'image', attrs: { mediaId: 'not-a-uuid', src: 'x' } },
          {
            type: 'image',
            attrs: { mediaId: MEDIA.toUpperCase(), src: 'blob:x', alt: 'a', title: 't' },
          },
        ),
      ),
    ).toEqual(doc(p(t('글')), { type: 'image', attrs: { mediaId: MEDIA } }));
  });

  it('turns a heading of another level into a paragraph, and keeps an empty heading', () => {
    expect(kept(doc({ type: 'heading', attrs: { level: 1 } }, p(t('x'))))).toEqual(
      doc({ type: 'heading', attrs: { level: 1 } }, p(t('x'))),
    );
    for (const level of [0, 4, 6, '2', null]) {
      expect(kept(doc({ type: 'heading', attrs: { level }, content: [t('x')] }))).toEqual(
        doc(p(t('x'))),
      );
    }
  });

  it('drops the control characters of text, keeping tabs and line breaks', () => {
    expect(kept(doc(p(t('a\u0000b\u0007c\td\u001fe\u007f')), p(t('\u0000'))))).toEqual(
      doc(p(t('abc\tde')), p()),
    );
    expect(kept(doc({ type: 'codeBlock', content: [t('a\r\nb')] }))).toEqual(
      doc({ type: 'codeBlock', content: [t('a\nb')] }),
    );
  });

  it('turns a lone surrogate into U+FFFD, in text and in a code block, and keeps a pair', () => {
    // As JSON carries them: Fastify's JSON.parse makes `"\ud800"` a lone surrogate, which
    // jsonb refuses (22P02) — the write would fail as INTERNAL instead of storing the post.
    const input = JSON.parse(
      '{"type":"doc","content":[' +
        '{"type":"paragraph","content":[{"type":"text","text":"a\\ud800b\\udc00c😀"}]},' +
        '{"type":"codeBlock","content":[{"type":"text","text":"x\\udbffy"}]}]}',
    ) as unknown;
    const result = sanitizePostDocument(input);
    expect(result.ok && result.document).toEqual(
      doc(p(t('a�b�c😀')), { type: 'codeBlock', content: [t('x�y')] }),
    );
    expect(result.ok && result.text).toBe('a�b�c😀\nx�y');
    // Nothing left that jsonb refuses: the stored JSON has no `\udXXX` escape.
    expect(JSON.stringify(result.ok && result.document)).not.toMatch(/\\ud[89a-f]/i);
  });
});

describe('sanitizePostDocument: the structure the editor needs', () => {
  it('wraps text put among blocks in a paragraph', () => {
    expect(kept(doc(t('a'), { type: 'hardBreak' }, t('b'), p(t('c')), t('d')))).toEqual(
      doc(p(t('a'), { type: 'hardBreak' }, t('b')), p(t('c')), p(t('d'))),
    );
    expect(kept(doc({ type: 'blockquote', content: [t('q')] }))).toEqual(
      doc({ type: 'blockquote', content: [p(t('q'))] }),
    );
  });

  it('drops empty quotes, lists and tables, and gives an empty list item or cell its paragraph', () => {
    expect(
      kept(
        doc(
          p(t('x')),
          { type: 'blockquote', content: [] },
          { type: 'bulletList', content: [p(t('not an item'))] },
          { type: 'orderedList' },
          { type: 'table', content: [{ type: 'tableRow', content: [p(t('not a cell'))] }] },
          { type: 'table' },
        ),
      ),
    ).toEqual(doc(p(t('x'))));
    expect(
      kept(
        doc(
          p(t('x')),
          {
            type: 'bulletList',
            content: [
              { type: 'listItem' },
              { type: 'listItem', content: [{ type: 'horizontalRule' }] },
            ],
          },
          { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell' }] }] },
        ),
      ),
    ).toEqual(
      doc(
        p(t('x')),
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [p()] },
            { type: 'listItem', content: [p(), { type: 'horizontalRule' }] },
          ],
        },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [p()] }],
            },
          ],
        },
      ),
    );
  });

  it('bounds a list’s start and a cell’s spans, and drops what else they carry', () => {
    const item = { type: 'listItem', content: [p(t('x'))] };
    for (const [start, kept_] of [
      [5, 5],
      [0, 1],
      [-3, 1],
      [1.5, 1],
      ['7', 1],
      [10_001, 1],
    ] as const) {
      expect(
        kept(doc({ type: 'orderedList', attrs: { start, type: 'a' }, content: [item] })),
      ).toEqual(doc({ type: 'orderedList', attrs: { start: kept_ }, content: [item] }));
    }
    expect(
      kept(
        doc({
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 21, rowspan: 2, colwidth: [100], style: 'x' },
                  content: [p(t('x'))],
                },
              ],
            },
          ],
        }),
      ),
    ).toEqual(
      doc({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', attrs: { colspan: 1, rowspan: 2 }, content: [p(t('x'))] },
            ],
          },
        ],
      }),
    );
  });

  it('merges a code block’s text into one unmarked node, line breaks kept', () => {
    expect(
      kept(
        doc(
          p(t('x')),
          {
            type: 'codeBlock',
            attrs: { language: 'js' },
            content: [
              t('a', [{ type: 'bold' }]),
              { type: 'hardBreak' },
              t('b'),
              { type: 'image' },
              'z',
            ],
          },
          { type: 'codeBlock', content: [] },
        ),
      ),
    ).toEqual(doc(p(t('x')), { type: 'codeBlock', content: [t('a\nb')] }, { type: 'codeBlock' }));
  });
});

describe('sanitizePostDocument: what cannot be a post', () => {
  it('refuses what is not a document', () => {
    for (const input of [
      null,
      'text',
      [],
      {},
      { type: 'paragraph', content: [] },
      { type: 'doc' },
      { type: 'doc', content: 'x' },
    ]) {
      expect(refused(input)).toEqual([
        { path: [], message: expect.stringContaining('document') as unknown },
      ]);
    }
  });

  it('refuses a body with no text, an image alone included', () => {
    for (const input of [
      doc(),
      doc(p()),
      doc(p(t('   ')), { type: 'horizontalRule' }),
      doc({ type: 'image', attrs: { mediaId: MEDIA } }),
    ]) {
      expect(refused(input)).toEqual([{ path: [], message: 'must have some text' }]);
    }
  });

  it('counts the text without formatting, in code points, up to the limit', () => {
    const max = '가'.repeat(POST_BODY_MAX_LENGTH - 1);
    const at = sanitizePostDocument(doc(p(t(max, [{ type: 'bold' }])), p(t('😀'))));
    expect(at.ok && at.length).toBe(POST_BODY_MAX_LENGTH);
    expect(refused(doc(p(t(max)), p(t('😀a'))))).toEqual([
      { path: [], message: `at most ${String(POST_BODY_MAX_LENGTH)} characters of text, not 5001` },
    ]);
  });

  it('counts image nodes up to the limit', () => {
    const image = { type: 'image', attrs: { mediaId: MEDIA } };
    const atMax = sanitizePostDocument(
      doc(p(t('x')), ...Array.from({ length: POST_IMAGES_MAX }, () => image)),
    );
    expect(atMax.ok && atMax.imageIds).toEqual([MEDIA]);
    expect(
      refused(doc(p(t('x')), ...Array.from({ length: POST_IMAGES_MAX + 1 }, () => image))),
    ).toEqual([{ path: [], message: `at most ${String(POST_IMAGES_MAX)} images, not 11` }]);
  });

  it('refuses nesting deeper than the limit, where it happens', () => {
    let node: unknown = p(t('deep'));
    for (let i = 0; i < POST_DOCUMENT_MAX_DEPTH; i += 1)
      node = { type: 'blockquote', content: [node] };
    const issues = refused(doc(node));
    expect(issues).toEqual([
      {
        path: expect.arrayContaining(['content', 0]) as unknown,
        message: expect.stringContaining('nested') as unknown,
      },
    ]);
    let shallow: unknown = p(t('ok'));
    for (let i = 0; i < POST_DOCUMENT_MAX_DEPTH - 1; i += 1) {
      shallow = { type: 'blockquote', content: [shallow] };
    }
    expect(sanitizePostDocument(doc(shallow)).ok).toBe(true);
  });

  it('refuses a document over the byte limit that the text limit cannot see', () => {
    const cell = { type: 'tableCell', content: [p()] };
    const row = { type: 'tableRow', content: Array.from({ length: 100 }, () => cell) };
    const table = { type: 'table', content: Array.from({ length: 100 }, () => row) };
    expect(refused(doc(p(t('x')), table))).toEqual([
      { path: [], message: `larger than ${String(POST_DOCUMENT_MAX_BYTES)} bytes` },
    ]);
  });
});

describe('the refusals’ messages', () => {
  it('tells apart every refusal the sanitizer and the image check write, by their own words', () => {
    const message = (input: unknown) => refused(input)[0]?.message ?? '';
    const image = { type: 'image', attrs: { mediaId: MEDIA } };
    expect(postBodyRefusalOf(message(doc(p())))).toEqual({ kind: 'empty' });
    expect(postBodyRefusalOf(message(doc(p(t('a'.repeat(POST_BODY_MAX_LENGTH + 1))))))).toEqual({
      kind: 'too_long',
    });
    expect(
      postBodyRefusalOf(
        message(doc(p(t('x')), ...Array.from({ length: POST_IMAGES_MAX + 1 }, () => image))),
      ),
    ).toEqual({ kind: 'too_many_images' });
    expect(postBodyRefusalOf(postImageNotUsableMessage(MEDIA))).toEqual({
      kind: 'image_not_usable',
      mediaId: MEDIA,
    });
    expect(postBodyRefusalOf(POST_BODY_EMPTY_MESSAGE)).toEqual({ kind: 'empty' });
    expect(postBodyRefusalOf(postBodyTooLongMessage(5_001))).toEqual({ kind: 'too_long' });
    expect(postBodyRefusalOf(postTooManyImagesMessage(11))).toEqual({ kind: 'too_many_images' });
  });

  it('reads no refusal into any other message', () => {
    for (const other of [
      '',
      'must be a document: { type: "doc", content: [...] }',
      `nested deeper than ${String(POST_DOCUMENT_MAX_DEPTH)} levels`,
      `larger than ${String(POST_DOCUMENT_MAX_BYTES)} bytes`,
      postImageNotUsableMessage('not-a-uuid'),
    ]) {
      expect(postBodyRefusalOf(other)).toBeUndefined();
    }
  });
});

describe('reading a document', () => {
  it('lists each image once, in order, wherever it is', () => {
    const image = (mediaId: string) => ({ type: 'image', attrs: { mediaId } });
    const result = sanitizePostDocument(
      doc(
        p(t('x')),
        { type: 'blockquote', content: [image(MEDIA_2)] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [p(), image(MEDIA)] }] },
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [{ type: 'tableCell', content: [image(MEDIA_2)] }] },
          ],
        },
      ),
    );
    expect(result.ok && result.imageIds).toEqual([MEDIA_2, MEDIA]);
  });

  it('reads a stored document again to the same values', () => {
    const result = sanitizePostDocument(
      doc(p(t('a')), {
        type: 'orderedList',
        content: [{ type: 'listItem', content: [p(t('b'))] }],
      }),
    );
    if (!result.ok) throw new Error('refused');
    expect(readPostDocument(result.document)).toEqual({
      text: result.text,
      length: result.length,
      imageIds: result.imageIds,
    });
    expect(result.text).toBe('a\nb');
  });

  it('previews the non-empty lines, trimmed, up to the excerpt length', () => {
    expect(postExcerpt('  첫 줄  \n\n\n  둘째 줄\n')).toBe('첫 줄\n둘째 줄');
    expect(codePointLength(postExcerpt('😀'.repeat(POST_EXCERPT_MAX_LENGTH + 5)))).toBe(
      POST_EXCERPT_MAX_LENGTH,
    );
  });

  it('counts code points', () => {
    expect(codePointLength('')).toBe(0);
    expect(codePointLength('가a😀')).toBe(3);
    expect('😀'.length).toBe(2);
  });

  it('compares JSON whatever the order of its keys', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { f: 1, e: 2 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { e: 2, f: 1 }] }, b: 1 }),
    );
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});

describe('the request’s body field', () => {
  it('normalises a body and names what it refuses under the field', () => {
    expect(postDocumentInputSchema.parse(doc(p(t('x', [{ type: 'unknown' }]))))).toEqual({
      document: doc(p(t('x'))),
      text: 'x',
      length: 1,
      imageIds: [],
    });
    const failed = postDocumentInputSchema.safeParse(doc(p()));
    expect(failed.success).toBe(false);
    expect(failed.error?.issues.map((issue) => issue.message)).toEqual(['must have some text']);
  });

  it('documents the stored blocks as a schema', () => {
    expect(postBlockSchema.safeParse({ type: 'paragraph' }).success).toBe(true);
    expect(postBlockSchema.safeParse({ type: 'iframe' }).success).toBe(false);
  });
});
