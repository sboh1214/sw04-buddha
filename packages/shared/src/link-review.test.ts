import { describe, expect, it } from 'vitest';
import {
  adminLinkFlagSchema,
  commentLinks,
  isOfficialSourceLink,
  isTrackingParameter,
  normaliseLink,
  officialSourceLinks,
  postDocumentLinks,
} from './link-review.js';
import { type PostDocument } from './post-document.js';

describe('normaliseLink (#187, ADR-0069 decision 4 and decision 7)', () => {
  it.each<[string, string]>([
    // The scheme and the host in lower case; the path and the query as written (decision 7).
    ['HTTPS://Example.COM/News/A?Id=X', 'https://example.com/News/A?Id=X'],
    ['http://EXAMPLE.com/Path', 'http://example.com/Path'],
    // No trailing slash, the root included; several go together.
    ['https://example.com/', 'https://example.com'],
    ['https://example.com', 'https://example.com'],
    ['https://example.com/a/', 'https://example.com/a'],
    ['https://example.com/a//', 'https://example.com/a'],
    ['https://example.com/a/?q=1', 'https://example.com/a?q=1'],
    // Tracking parameters go, any utm_ one and the click ids, whatever their case; the rest stay
    // in their order and spelling.
    ['https://example.com/a?utm_source=x&utm_medium=y', 'https://example.com/a'],
    ['https://example.com/a?id=7&utm_campaign=z&b=Q', 'https://example.com/a?id=7&b=Q'],
    ['https://example.com/a?fbclid=abc', 'https://example.com/a'],
    ['https://example.com/a?gclid=abc&x=1', 'https://example.com/a?x=1'],
    ['https://example.com/a?UTM_Source=x&FBCLID=y&k=v', 'https://example.com/a?k=v'],
    ['https://example.com/a?msclkid=1&igshid=2&yclid=3', 'https://example.com/a'],
    ['https://example.com/a?b=2&a=1', 'https://example.com/a?b=2&a=1'],
    ['https://example.com/a?x=1&&y=2&', 'https://example.com/a?x=1&y=2'],
    ['https://example.com/a?', 'https://example.com/a'],
    // A parameter that only looks like one is kept.
    ['https://example.com/a?utm=1&gclid_x=2', 'https://example.com/a?utm=1&gclid_x=2'],
    // No fragment.
    ['https://example.com/a#section-2', 'https://example.com/a'],
    ['https://example.com/a/?utm_source=x#top', 'https://example.com/a'],
    // The URL parser's spelling: default ports go, other ports stay; a host in punycode.
    ['https://example.com:443/a', 'https://example.com/a'],
    ['http://example.com:80/a', 'http://example.com/a'],
    ['https://example.com:8443/a', 'https://example.com:8443/a'],
    ['https://한국.example/a', 'https://xn--3e0b707e.example/a'],
    // A shortener's address is not followed: it is its own link.
    ['https://bit.ly/3AbCdEf', 'https://bit.ly/3AbCdEf'],
  ])('%s → %s', (href, expected) => {
    expect(normaliseLink(href)).toBe(expected);
  });

  it('keeps http and https, and www and no www, apart', () => {
    expect(normaliseLink('http://example.com/a')).not.toBe(normaliseLink('https://example.com/a'));
    expect(normaliseLink('https://www.example.com/a')).not.toBe(
      normaliseLink('https://example.com/a'),
    );
  });

  it('answers undefined for what is no link', () => {
    for (const href of [
      'javascript:alert(1)',
      'ftp://example.com/a',
      'example.com/a',
      '/relative',
      'https://user:pass@example.com/a',
      `https://example.com/${'a'.repeat(2_100)}`,
    ]) {
      expect(normaliseLink(href), href).toBeUndefined();
    }
  });

  it('tells a tracking parameter by its name', () => {
    expect(isTrackingParameter('utm_source')).toBe(true);
    expect(isTrackingParameter('UTM_TERM')).toBe(true);
    expect(isTrackingParameter('utm_anything')).toBe(true);
    expect(isTrackingParameter('gclid')).toBe(true);
    expect(isTrackingParameter('id')).toBe(false);
    expect(isTrackingParameter('utm')).toBe(false);
  });
});

describe('the links of a post and of a comment', () => {
  const linked = (text: string, href: string) => ({
    type: 'text' as const,
    text,
    marks: [{ type: 'link' as const, attrs: { href } }],
  });

  it('reads a post’s link marks and the addresses written in its text, each once', () => {
    const document: PostDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '보도자료 ' },
            linked('여기', 'https://Example.com/news/1/?utm_source=x'),
            { type: 'text', text: ' 그리고 https://example.com/news/1 다시' },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [linked('목록', 'https://b.example/x')] }],
            },
          ],
        },
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [linked('인용', 'https://c.example/')] }],
        },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 1, rowspan: 1 },
                  content: [{ type: 'paragraph', content: [linked('표', 'https://d.example/T')] }],
                },
              ],
            },
          ],
        },
        { type: 'codeBlock', content: [{ type: 'text', text: 'curl https://e.example/api' }] },
        // A link mark on words in a heading and in a numbered list, as in a paragraph.
        { type: 'heading', attrs: { level: 2 }, content: [linked('제목', 'https://f.example/h')] },
        {
          type: 'orderedList',
          attrs: { start: 1 },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [linked('번호', 'https://g.example/o')] }],
            },
          ],
        },
      ],
    };
    expect(postDocumentLinks(document).sort()).toEqual(
      [
        'https://example.com/news/1',
        'https://b.example/x',
        'https://c.example',
        'https://d.example/T',
        'https://e.example/api',
        'https://f.example/h',
        'https://g.example/o',
      ].sort(),
    );
  });

  it('finds no link in a post without one', () => {
    expect(
      postDocumentLinks({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'example.com 은 링크 아님' }] },
        ],
      }),
    ).toEqual([]);
  });

  it('reads a comment’s autolinked addresses, normalised, each once', () => {
    expect(
      commentLinks(
        '근거: https://Example.com/a/?fbclid=1 와 https://example.com/a, 그리고 (https://b.example/x).',
      ),
    ).toEqual(['https://example.com/a', 'https://b.example/x']);
    expect(commentLinks('주소 없음 www.example.com')).toEqual([]);
  });
});

describe('the official sources of a market (decision 4 #187: 예외)', () => {
  const sources = officialSourceLinks(
    '한국은행 보도자료(통화정책방향) https://www.bok.or.kr 및 https://ecos.bok.or.kr/api/?key=1',
  );

  it('reads the addresses its source names, normalised', () => {
    expect(sources).toEqual(['https://www.bok.or.kr', 'https://ecos.bok.or.kr/api?key=1']);
    expect(officialSourceLinks(null)).toEqual([]);
    expect(officialSourceLinks('통계청 보도자료')).toEqual([]);
  });

  it('covers a source and the pages under it, nothing else', () => {
    expect(isOfficialSourceLink('https://www.bok.or.kr', sources)).toBe(true);
    expect(isOfficialSourceLink('https://www.bok.or.kr/portal/main.do', sources)).toBe(true);
    expect(isOfficialSourceLink('https://www.bok.or.kr?menu=1', sources)).toBe(true);
    expect(isOfficialSourceLink('https://ecos.bok.or.kr/api?key=1', sources)).toBe(true);
    // Another host, scheme or port, a host that only starts the same, another query.
    expect(isOfficialSourceLink('https://www.bok.or.kr.example/a', sources)).toBe(false);
    expect(isOfficialSourceLink('http://www.bok.or.kr/a', sources)).toBe(false);
    expect(isOfficialSourceLink('https://www.bok.or.kr:8443/a', sources)).toBe(false);
    expect(isOfficialSourceLink('https://ecos.bok.or.kr/api?key=2', sources)).toBe(false);
    expect(isOfficialSourceLink('https://ecos.bok.or.kr/api/v2?key=1', sources)).toBe(false);
    // A path covers what continues it after a slash, not a longer name.
    const news = officialSourceLinks('https://kostat.go.kr/news');
    expect(isOfficialSourceLink('https://kostat.go.kr/news/1', news)).toBe(true);
    expect(isOfficialSourceLink('https://kostat.go.kr/newsletter', news)).toBe(false);
    expect(isOfficialSourceLink('https://kostat.go.kr/News/1', news)).toBe(false);
    expect(isOfficialSourceLink('https://kostat.go.kr/news', [])).toBe(false);
  });
});

describe('adminLinkFlagSchema', () => {
  it('takes an entry of the review list', () => {
    const at = new Date().toISOString();
    const entry = {
      id: '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60',
      url: 'https://example.com/a',
      reason: 'same_account',
      flaggedAt: at,
      target: {
        kind: 'comment',
        postId: '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f61',
        commentId: '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f62',
        excerpt: '댓글',
        createdAt: at,
        editedAt: null,
        deletedAt: null,
        hiddenAt: at,
        author: { userId: 'u1', publicId: 'abcdefgh23', nickname: '예측가' },
        market: { id: '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f63', slug: 'm', title: '시장' },
      },
    };
    expect(adminLinkFlagSchema.parse(entry)).toEqual(entry);
    expect(() => adminLinkFlagSchema.parse({ ...entry, reason: 'body_repeat' })).toThrow();
  });
});
