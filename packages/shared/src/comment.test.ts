import { describe, expect, it } from 'vitest';
import {
  COMMENT_BODY_EMPTY_MESSAGE,
  COMMENT_BODY_MAX_LENGTH,
  COMMENT_NOT_ALLOWED_REASONS,
  COMMENT_PAGE_LIMIT,
  COMMENT_REPLIES_PAGE_SIZE,
  commentBodyInputSchema,
  commentBodyRefusalOf,
  commentBodyTooLongMessage,
  commentDeletionSchema,
  commentNotAllowedDetailsSchema,
  commentNotEditableDetailsSchema,
  commentRepliesQuerySchema,
  commentSegments,
  commentsQuerySchema,
  commentThreadSchema,
  createCommentBodySchema,
  deleteCommentBodySchema,
  normaliseCommentBody,
  postCommentSchema,
  updateCommentBodySchema,
  type CommentSegment,
} from './comment.js';
import { POST_LINK_MAX_LENGTH } from './post-document.js';

const ID = '0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60';
const OTHER = '1c7a7b4f-3d2e-4d9f-8a1b-2c3d4e5f6a71';

/** The issues' messages of a body that is refused. */
function refusals(body: unknown): string[] {
  const result = commentBodyInputSchema.safeParse(body);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('a comment’s body', () => {
  it('is plain text, trimmed, its line breaks kept and written as \\n', () => {
    expect(commentBodyInputSchema.parse('  첫 줄\r\n\r\n셋째 줄\r넷째\n  ')).toBe(
      '첫 줄\n\n셋째 줄\n넷째',
    );
    // Markup is text: nothing is parsed, nothing removed.
    expect(commentBodyInputSchema.parse('<b>굵게</b> **별표**')).toBe('<b>굵게</b> **별표**');
  });

  it('drops control characters but a tab, and turns a lone surrogate into U+FFFD', () => {
    expect(normaliseCommentBody('a\u0000b\u0007c\td\u007fe')).toBe('abc\tde');
    const text = JSON.parse('"a\\ud800b😀"') as string;
    expect(commentBodyInputSchema.parse(text)).toBe('a�b😀');
    // The same text sent again is the same text (an edit that changes nothing stays none).
    expect(commentBodyInputSchema.parse(commentBodyInputSchema.parse(text))).toBe(
      commentBodyInputSchema.parse(text),
    );
  });

  it('has text: blank is refused with the message the web reads', () => {
    for (const body of ['', '   ', '\n\r\n\t', '\u0000']) {
      expect(refusals(body), JSON.stringify(body)).toEqual([COMMENT_BODY_EMPTY_MESSAGE]);
    }
    expect(commentBodyRefusalOf(COMMENT_BODY_EMPTY_MESSAGE)).toEqual({ kind: 'empty' });
  });

  it('is at most 1,000 characters, counted in code points, a line break one', () => {
    expect(COMMENT_BODY_MAX_LENGTH).toBe(1_000);
    expect(commentBodyInputSchema.parse('😀'.repeat(1_000))).toHaveLength(2_000);
    expect(commentBodyInputSchema.parse(`${'가'.repeat(499)}\n${'a'.repeat(500)}`)).toHaveLength(
      1_000,
    );
    // A CR LF from a pasted text is one character once kept.
    expect(commentBodyInputSchema.parse(`a${'\r\n'.repeat(998)}b`)).toHaveLength(1_000);
    expect(refusals('가'.repeat(1_001))).toEqual([commentBodyTooLongMessage(1_001)]);
    expect(refusals('😀'.repeat(1_200))).toEqual([commentBodyTooLongMessage(1_200)]);
    expect(commentBodyRefusalOf(commentBodyTooLongMessage(1_001))).toEqual({
      kind: 'too_long',
      length: 1_001,
    });
    expect(commentBodyRefusalOf('something else')).toBeUndefined();
    expect(refusals(42)).toHaveLength(1);
  });
});

describe('a comment’s links', () => {
  const link = (text: string, href = text): CommentSegment => ({ type: 'link', text, href });
  const words = (text: string): CommentSegment => ({ type: 'text', text });

  it('links an http(s) address in its text and keeps the rest as text', () => {
    expect(
      commentSegments('출처: https://example.com/a?b=1#c 참고\n둘째 줄 http://x.example'),
    ).toEqual([
      words('출처: '),
      link('https://example.com/a?b=1#c'),
      words(' 참고\n둘째 줄 '),
      link('http://x.example', 'http://x.example/'),
    ]);
    expect(commentSegments('주소 없음')).toEqual([words('주소 없음')]);
    expect(commentSegments('')).toEqual([]);
    // Any case, written as typed and linked in the URL parser's spelling.
    expect(commentSegments('HTTPS://Example.COM/Path')).toEqual([
      link('HTTPS://Example.COM/Path', 'https://example.com/Path'),
    ]);
  });

  it('never links another scheme, a bare host or an address glued to a word', () => {
    for (const text of [
      'javascript:alert(1)',
      'JavaScript://example.com/%0Aalert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox',
      'ftp://example.com/file',
      'example.com/a',
      'www.example.com',
      'xhttps://example.com',
      '1http://example.com',
      'https://',
      'https:///',
      'https://.',
    ]) {
      expect(
        commentSegments(text).filter((segment) => segment.type === 'link'),
        text,
      ).toEqual([]);
    }
  });

  it('never links an address with a user or a password, nor one longer than a post’s link may be', () => {
    expect(commentSegments('https://bank.example@evil.example/login')).toEqual([
      words('https://bank.example@evil.example/login'),
    ]);
    expect(commentSegments('https://user:pw@example.com')).toEqual([
      words('https://user:pw@example.com'),
    ]);
    const long = `https://example.com/${'a'.repeat(POST_LINK_MAX_LENGTH)}`;
    expect(commentSegments(long)).toEqual([words(long)]);
    // An '@' in the path is not a user.
    expect(commentSegments('https://example.com/@user')).toEqual([
      link('https://example.com/@user'),
    ]);
  });

  it('leaves a sentence’s punctuation, an unopened bracket and a Korean word after the host out', () => {
    expect(commentSegments('보세요(https://example.com/a).')).toEqual([
      words('보세요('),
      link('https://example.com/a'),
      words(').'),
    ]);
    expect(commentSegments('https://ko.wikipedia.org/wiki/Seoul_(city), 끝')).toEqual([
      link('https://ko.wikipedia.org/wiki/Seoul_(city)'),
      words(', 끝'),
    ]);
    expect(commentSegments('https://example.com에서 봤다')).toEqual([
      link('https://example.com', 'https://example.com/'),
      words('에서 봤다'),
    ]);
    expect(commentSegments('https://example.com/news/123에서 봤다.')).toEqual([
      link('https://example.com/news/123'),
      words('에서 봤다.'),
    ]);
    expect(commentSegments('「https://example.com/a」。')).toEqual([
      words('「'),
      link('https://example.com/a'),
      words('」。'),
    ]);
  });

  it('keeps a Korean path after a delimiter in the address, as the parser spells it', () => {
    expect(commentSegments('https://ko.wikipedia.org/wiki/서울 참고')).toEqual([
      link(
        'https://ko.wikipedia.org/wiki/서울',
        'https://ko.wikipedia.org/wiki/%EC%84%9C%EC%9A%B8',
      ),
      words(' 참고'),
    ]);
  });

  it('finds an address glued behind another, and two in a row', () => {
    expect(commentSegments('https://a.example에서https://b.example/x')).toEqual([
      link('https://a.example', 'https://a.example/'),
      words('에서'),
      link('https://b.example/x'),
    ]);
    expect(commentSegments('https://a.example/1 https://b.example/2')).toEqual([
      link('https://a.example/1'),
      words(' '),
      link('https://b.example/2'),
    ]);
  });

  it('cuts a body built to be slow in linear time per candidate (ADR-0074)', () => {
    // Every candidate but the last is refused (a port that is no number, an empty host) and runs
    // to the same end: hundreds of unopened closers. Counting the address again per dropped closer
    // made one call cost about 75 ms — on the server that draws the post page and in each reader's
    // browser, per comment.
    const bodies = [
      `${'https://x:'.repeat(30)}${')'.repeat(700)}`,
      `${'http://x:'.repeat(40)}${')'.repeat(640)}`,
      `${'http://:'.repeat(50)}${')'.repeat(600)}`,
    ];
    for (const body of bodies) expect(commentBodyInputSchema.parse(body)).toBe(body);
    // The last candidate alone is an address, its closers and colon dropped.
    expect(commentSegments(bodies[0]!)).toEqual([
      words('https://x:'.repeat(29)),
      link('https://x', 'https://x/'),
      words(`:${')'.repeat(700)}`),
    ]);
    expect(commentSegments(bodies[2]!)).toEqual([words(bodies[2]!)]);
    // Timed against a baseline, not the clock: the same bodies with letters for the closers — as
    // long, as many candidates, each running to the end — cost what any body of that length does.
    // Linear, the closers cost about two to three times that; counted again per dropped closer,
    // about 150 times. Each round times both, one after the other, and the fastest round of each
    // is compared: work elsewhere on the machine (other test runs in parallel) only ever adds time,
    // so a wall-clock budget failed under load while the fastest rounds still tell the two apart.
    const plain = bodies.map((body) => body.replaceAll(')', 'a'));
    const timed = (texts: readonly string[]) => {
      const started = performance.now();
      for (const text of texts) commentSegments(text);
      return performance.now() - started;
    };
    const LIMIT = 20;
    let slowest = Infinity;
    let baseline = Infinity;
    for (let round = 0; round < 20; round += 1) {
      slowest = Math.min(slowest, timed(bodies));
      baseline = Math.min(baseline, timed(plain));
      // Quadratic, a round is a second or more: three say so without running into the timeout.
      if (round >= 2 && slowest > LIMIT * baseline) break;
    }
    expect(slowest).toBeLessThan(LIMIT * baseline);
  });

  it('gives back the text it was given, run by run', () => {
    const text = '앞 https://example.com/a. 가운데 javascript:x 뒤 https://b.example에서\n끝';
    expect(
      commentSegments(text)
        .map((segment) => segment.text)
        .join(''),
    ).toBe(text);
  });
});

describe('a comment’s answers and requests', () => {
  const author = {
    kind: 'member',
    publicId: 'abcdefgh23',
    nickname: '예측가',
    imageUrl: null,
    isAdmin: false,
  } as const;
  const createdAt = '2026-10-19T00:00:00.000Z';

  it('draws a comment in each state, a thread as a 댓글 with its 대댓글', () => {
    const published = {
      state: 'published',
      id: ID,
      parentId: null,
      body: '근거',
      author,
      createdAt,
      editedAt: null,
    } as const;
    expect(postCommentSchema.parse(published)).toEqual(published);
    for (const state of ['deleted', 'hidden'] as const) {
      expect(postCommentSchema.parse({ state, id: ID })).toEqual({ state, id: ID });
    }
    const reply = { ...published, id: OTHER, parentId: ID, editedAt: createdAt };
    const thread = {
      comment: { state: 'deleted', id: ID },
      replies: [reply],
      repliesNextCursor: null,
    } as const;
    expect(commentThreadSchema.parse(thread)).toEqual(thread);
    // At most 50 대댓글 ride with their 댓글; the rest are read by the cursor (오너 결정 2026-10-21).
    expect(COMMENT_REPLIES_PAGE_SIZE).toBe(50);
    const full = Array.from({ length: COMMENT_REPLIES_PAGE_SIZE }, () => reply);
    expect(
      commentThreadSchema.parse({ ...thread, replies: full, repliesNextCursor: '1_x' })
        .repliesNextCursor,
    ).toBe('1_x');
    expect(commentThreadSchema.safeParse({ ...thread, replies: [...full, reply] }).success).toBe(
      false,
    );
    expect(commentThreadSchema.safeParse({ comment: thread.comment, replies: [] }).success).toBe(
      false,
    );
  });

  it('pages 댓글 20 at most and 대댓글 by their cursor alone', () => {
    expect(commentsQuerySchema.parse({})).toEqual({ limit: COMMENT_PAGE_LIMIT });
    expect(COMMENT_PAGE_LIMIT).toBe(20);
    expect(commentsQuerySchema.parse({ cursor: 'c', limit: '2' })).toEqual({
      cursor: 'c',
      limit: 2,
    });
    expect(commentsQuerySchema.safeParse({ limit: '21' }).success).toBe(false);
    expect(commentsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(commentRepliesQuerySchema.parse({})).toEqual({});
    expect(commentRepliesQuerySchema.parse({ cursor: 'c' })).toEqual({ cursor: 'c' });
    expect(commentRepliesQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
    expect(commentRepliesQuerySchema.safeParse({ cursor: 'x'.repeat(201) }).success).toBe(false);
  });

  it('writes a 댓글 or, with a parent, a 대댓글, naming the account', () => {
    expect(createCommentBodySchema.parse({ body: ' 근거 ', expectedAccountId: 'acct' })).toEqual({
      parentId: null,
      body: '근거',
      expectedAccountId: 'acct',
    });
    expect(
      createCommentBodySchema.parse({
        parentId: ID.toUpperCase(),
        body: '답',
        expectedAccountId: 'acct',
      }).parentId,
    ).toBe(ID);
    expect(
      createCommentBodySchema.safeParse({ parentId: 'x', body: '답', expectedAccountId: 'a' })
        .success,
    ).toBe(false);
    expect(createCommentBodySchema.safeParse({ body: '답' }).success).toBe(false);
    expect(updateCommentBodySchema.parse({ body: '고친 답\n', expectedAccountId: 'a' })).toEqual({
      body: '고친 답',
      expectedAccountId: 'a',
    });
    expect(deleteCommentBodySchema.parse({ expectedAccountId: 'a' })).toEqual({
      expectedAccountId: 'a',
    });
    expect(commentDeletionSchema.parse({ id: ID, placeholder: true }).placeholder).toBe(true);
  });

  it('names why a comment is refused', () => {
    expect(COMMENT_NOT_ALLOWED_REASONS).toEqual([
      'post_hidden',
      'post_deleted',
      'parent_hidden',
      'parent_deleted',
    ]);
    expect(commentNotAllowedDetailsSchema.parse({ reason: 'parent_hidden' })).toEqual({
      reason: 'parent_hidden',
    });
    expect(commentNotEditableDetailsSchema.parse({ reason: 'hidden' })).toEqual({
      reason: 'hidden',
    });
  });
});
