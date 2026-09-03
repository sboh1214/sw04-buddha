import { describe, expect, it } from 'vitest';
import {
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  cursorQuerySchema,
  decodeKeyset,
  encodeKeyset,
} from './pagination.js';

describe('cursorQuerySchema', () => {
  it('defaults the limit and coerces the query string', () => {
    expect(cursorQuerySchema.parse({})).toEqual({ limit: PAGE_LIMIT_DEFAULT });
    expect(cursorQuerySchema.parse({ limit: '50', cursor: 'abc' })).toEqual({
      limit: 50,
      cursor: 'abc',
    });
  });

  it('rejects a limit outside 1..100 and a non-integer', () => {
    expect(cursorQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(cursorQuerySchema.safeParse({ limit: String(PAGE_LIMIT_MAX + 1) }).success).toBe(false);
    expect(cursorQuerySchema.safeParse({ limit: '1.5' }).success).toBe(false);
    expect(cursorQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
  });
});

describe('keyset cursors', () => {
  it('round-trips a timestamp and an id', () => {
    const keyset = { createdAt: new Date('2026-09-03T04:05:06.789Z'), id: '42' };
    const cursor = encodeKeyset(keyset);
    expect(cursor).toBe('1788408306789_42');
    expect(decodeKeyset(cursor)).toEqual(keyset);
  });

  it('keeps ids that contain the separator (uuids do not, but ids are opaque)', () => {
    const keyset = { createdAt: new Date(0), id: 'a_b_c' };
    expect(decodeKeyset(encodeKeyset(keyset))).toEqual(keyset);
  });

  it('treats a missing or malformed cursor as "start from the first page"', () => {
    expect(decodeKeyset(undefined)).toBeUndefined();
    expect(decodeKeyset('')).toBeUndefined();
    expect(decodeKeyset('no-separator')).toBeUndefined();
    expect(decodeKeyset('_42')).toBeUndefined(); // no timestamp
    expect(decodeKeyset('123_')).toBeUndefined(); // no id
    expect(decodeKeyset('abc_42')).toBeUndefined(); // timestamp is not a number
    expect(decodeKeyset('-1_42')).toBeUndefined();
  });
});
