/**
 * The comment lists' sealed cursors (#48, ADR-0074, 오너 결정 2026-10-22 답 3) without Postgres: a
 * cursor opens to the keyset it was sealed with, for its own list only, and says nothing of the
 * time it holds; one changed anywhere, of another list, of another secret (the session secret
 * rotated) or of another shape does not open — and the service's `open` turns that into a
 * VALIDATION_ERROR naming `cursor`. Runs everywhere.
 */
import { encodeKeyset } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { AppError } from '../common/errors/app-error.js';
import {
  CommentCursors,
  type CommentCursorScope,
  deriveCommentCursorKeys,
  openCommentCursor,
  sealCommentCursor,
} from './comment-cursor.js';

const keys = deriveCommentCursorKeys('vitest-only-secret-0123456789abcdef0123456789');
const POST = '3f2b8c1e-9d4a-4e6b-8f7c-1a2b3c4d5e6f';
const THREAD = '6f9619ff-8b86-d011-b42d-00c04fc964ff';
const OTHER_THREAD = 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** `cursor` with its last character's unused low bit flipped: the same bytes, spelled otherwise. */
const malformedSpelling = (cursor: string) =>
  cursor.slice(0, -1) + (BASE64URL[BASE64URL.indexOf(cursor.at(-1) ?? 'A') ^ 1] ?? '');
const comments: CommentCursorScope = { list: 'comments', postId: POST };
const replies: CommentCursorScope = { list: 'replies', commentId: THREAD };
/** A deleted 댓글's keyset, its time to the millisecond: what a page ending on it used to show. */
const keyset = {
  createdAt: new Date('2026-10-19T03:04:05.678Z'),
  id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
};

describe('a comment list’s cursor (오너 결정 2026-10-22 답 3)', () => {
  it('opens to the keyset it was sealed with, for its own list', () => {
    for (const scope of [comments, replies]) {
      const cursor = sealCommentCursor(keys, scope, keyset);
      expect(openCommentCursor(keys, scope, cursor)).toEqual(keyset);
    }
    // The ends of the range a cursor may name, and an id in capitals (read back as stored).
    for (const createdAt of [new Date(0), new Date(Date.UTC(9999, 11, 31, 23, 59, 59, 999))]) {
      const edge = { createdAt, id: keyset.id };
      expect(openCommentCursor(keys, replies, sealCommentCursor(keys, replies, edge))).toEqual(
        edge,
      );
    }
    const upper = sealCommentCursor(keys, replies, { ...keyset, id: keyset.id.toUpperCase() });
    expect(openCommentCursor(keys, replies, upper)).toEqual(keyset);
  });

  it('tells nothing of the time: base64url of a random-looking 53 bytes, and no part of the plain cursor', () => {
    const cursor = sealCommentCursor(keys, comments, keyset);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]{71}$/);
    const millis = String(keyset.createdAt.getTime());
    expect(cursor).not.toContain(millis);
    expect(Buffer.from(cursor, 'base64url').toString('latin1')).not.toContain(millis);
    expect(Buffer.from(cursor, 'base64url').toString('hex')).not.toContain(
      keyset.createdAt.getTime().toString(16),
    );
    expect(cursor).not.toContain(keyset.id);
    // The next millisecond seals to another cursor altogether, not one a character away.
    const next = sealCommentCursor(keys, comments, {
      ...keyset,
      createdAt: new Date(keyset.createdAt.getTime() + 1),
    });
    const same = [...cursor].filter((char, index) => next[index] === char).length;
    expect(same).toBeLessThan(20);
  });

  it('is one cursor for one position of one list: the web compares them', () => {
    expect(sealCommentCursor(keys, replies, keyset)).toBe(sealCommentCursor(keys, replies, keyset));
    // The same row in another list is another cursor.
    expect(sealCommentCursor(keys, replies, keyset)).not.toBe(
      sealCommentCursor(keys, { list: 'replies', commentId: OTHER_THREAD }, keyset),
    );
    expect(sealCommentCursor(keys, replies, keyset)).not.toBe(
      sealCommentCursor(keys, comments, keyset),
    );
  });

  it('does not open in another list: another thread, the other route, another post', () => {
    const cursor = sealCommentCursor(keys, replies, keyset);
    expect(openCommentCursor(keys, { list: 'replies', commentId: OTHER_THREAD }, cursor)).toBe(
      undefined,
    );
    expect(openCommentCursor(keys, { list: 'comments', postId: THREAD }, cursor)).toBeUndefined();
    const page = sealCommentCursor(keys, comments, keyset);
    expect(openCommentCursor(keys, { list: 'comments', postId: OTHER_THREAD }, page)).toBe(
      undefined,
    );
    expect(openCommentCursor(keys, { list: 'replies', commentId: POST }, page)).toBeUndefined();
  });

  it('does not open once changed anywhere: every bit of every byte', () => {
    const cursor = sealCommentCursor(keys, replies, keyset);
    const bytes = Buffer.from(cursor, 'base64url');
    for (let index = 0; index < bytes.length; index += 1) {
      for (let bit = 0; bit < 8; bit += 1) {
        const changed = Buffer.from(bytes);
        changed[index] = (changed[index] ?? 0) ^ (1 << bit);
        expect(openCommentCursor(keys, replies, changed.toString('base64url'))).toBeUndefined();
      }
    }
  });

  it('does not open under another secret: rotating BETTER_AUTH_SECRET retires every cursor held', () => {
    const rotated = deriveCommentCursorKeys('vitest-only-rotated-secret-0123456789abcdef');
    const cursor = sealCommentCursor(keys, replies, keyset);
    expect(openCommentCursor(rotated, replies, cursor)).toBeUndefined();
    // A screen holding it reads its pages again from the first and gets the new key's cursors.
    const fresh = sealCommentCursor(rotated, replies, keyset);
    expect(openCommentCursor(rotated, replies, fresh)).toEqual(keyset);
  });

  it('does not open in another shape: the plain cursor, not base64url, too short or long, another spelling or version', () => {
    const cursor = sealCommentCursor(keys, replies, keyset);
    const bytes = Buffer.from(cursor, 'base64url');
    expect(Buffer.from(malformedSpelling(cursor), 'base64url')).toEqual(bytes);
    const malformed = [
      // The plain cursor these lists gave before (and every other list still gives).
      encodeKeyset(keyset),
      'garbage',
      `${cursor}=`,
      cursor.replaceAll('-', '+').replaceAll('_', '/'),
      cursor.slice(0, -1),
      `${cursor}A`,
      bytes.subarray(0, -1).toString('base64url'),
      Buffer.concat([bytes, Buffer.of(0)]).toString('base64url'),
      // The same bytes in another spelling: the last character's unused low bit flipped.
      malformedSpelling(cursor),
      // Another version byte.
      Buffer.concat([Buffer.of(2), bytes.subarray(1)]).toString('base64url'),
    ];
    for (const value of malformed) {
      if (value === cursor) continue;
      expect(openCommentCursor(keys, replies, value), value).toBeUndefined();
    }
  });

  it('is refused by the service as a VALIDATION_ERROR naming cursor; no cursor is the first page', () => {
    // Only `get('BETTER_AUTH_SECRET')` is asked of the ConfigService.
    const service = new CommentCursors({
      get: () => 'vitest-only-secret-0123456789abcdef0123456789',
    } as never);
    expect(service.open(replies, undefined)).toBeUndefined();
    const cursor = service.seal(replies, keyset);
    expect(cursor).toBe(sealCommentCursor(keys, replies, keyset));
    expect(service.open(replies, cursor)).toEqual(keyset);
    let refusal: unknown;
    try {
      service.open({ list: 'replies', commentId: OTHER_THREAD }, cursor);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(AppError);
    expect(refusal).toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
      details: [{ path: ['cursor'] }],
    });
  });
});
