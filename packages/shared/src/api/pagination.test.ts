import { describe, expect, it } from 'vitest';
import {
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  cursorQuerySchema,
  decodeKeyset,
  decodeSortCursor,
  encodeKeyset,
  encodeSortCursor,
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
    expect(decodeKeyset(cursor, 'int')).toEqual(keyset);
  });

  it('keeps ids that contain the separator (uuids do not, but ids are opaque)', () => {
    const keyset = { createdAt: new Date(0), id: 'a_b_c' };
    expect(decodeKeyset(encodeKeyset(keyset), 'text')).toEqual(keyset);
  });

  it('treats a missing or malformed cursor as "start from the first page"', () => {
    expect(decodeKeyset(undefined, 'text')).toBeUndefined();
    expect(decodeKeyset('', 'text')).toBeUndefined();
    expect(decodeKeyset('no-separator', 'text')).toBeUndefined();
    expect(decodeKeyset('_42', 'text')).toBeUndefined(); // no timestamp
    expect(decodeKeyset('123_', 'text')).toBeUndefined(); // no id
    expect(decodeKeyset('abc_42', 'text')).toBeUndefined(); // timestamp is not a number
    expect(decodeKeyset('-1_42', 'text')).toBeUndefined();
  });

  it('rejects an id that cannot be compared against its column', () => {
    // Each of these reached `id < $1` on a typed column and came back as a 500: a bad uuid and
    // 'NaN'/'0.5' are 22P02, and a huge integer is 22003.
    expect(decodeKeyset('0_not-a-uuid', 'uuid')).toBeUndefined();
    expect(decodeKeyset('0_not-a-number', 'int')).toBeUndefined();
    expect(decodeKeyset('0_99999999999999999999', 'int')).toBeUndefined();
    expect(decodeKeyset('0_0.5', 'int')).toBeUndefined();
    expect(decodeKeyset('0_-1', 'int')).toBeUndefined();
    // `user.id` is text, so nothing about its shape is illegal.
    expect(decodeKeyset('0_not-a-uuid', 'text')).toBeDefined();
  });

  it('accepts the cursors the server actually mints', () => {
    // A rule that is too strict would be invisible: every page-2 request would silently serve
    // page 1 again. `gen_random_uuid()` is v4, and bigserial ids are plain digits.
    const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const at = new Date('2026-09-03T04:05:06.789Z');
    expect(decodeKeyset(encodeKeyset({ createdAt: at, id: uuid }), 'uuid')).toEqual({
      createdAt: at,
      id: uuid,
    });
    expect(decodeKeyset(encodeKeyset({ createdAt: at, id: '1' }), 'int')).toBeDefined();
  });

  it('rejects a timestamp past the Date range, which drizzle cannot encode', () => {
    // Between 8.64e15 and Number.MAX_SAFE_INTEGER the old guard let the value through, and
    // `new Date(ms).toISOString()` inside drizzle's timestamp encoder threw RangeError.
    expect(decodeKeyset('8640000000000001_x', 'text')).toBeUndefined();
    expect(decodeKeyset('9007199254740991_x', 'text')).toBeUndefined();
    expect(decodeKeyset('8640000000000000_x', 'text')).toBeDefined(); // the boundary is valid
  });
});

describe('sort cursors', () => {
  const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  it('round-trips a bigint sort value and a uuid id', () => {
    const cursor = encodeSortCursor('1234567890123456789', uuid);
    expect(cursor).toBe(`1234567890123456789_${uuid}`);
    expect(decodeSortCursor(cursor, 'int', 'uuid')).toEqual({
      value: '1234567890123456789',
      id: uuid,
    });
    // The value half is what `GET /markets?sort=volume` compares against volume_coin.
    expect(decodeSortCursor(encodeSortCursor('0', uuid), 'int', 'uuid')).toEqual({
      value: '0',
      id: uuid,
    });
    expect(
      decodeSortCursor(encodeSortCursor('9223372036854775807', uuid), 'int', 'uuid'),
    ).toBeDefined();
  });

  it('accepts epoch milliseconds under the millis shape with the Date range', () => {
    expect(decodeSortCursor(`1788408306789_${uuid}`, 'millis', 'uuid')).toEqual({
      value: '1788408306789',
      id: uuid,
    });
    expect(decodeSortCursor(`8640000000000000_${uuid}`, 'millis', 'uuid')).toBeDefined();
    expect(decodeSortCursor(`8640000000000001_${uuid}`, 'millis', 'uuid')).toBeUndefined();
    expect(decodeSortCursor(`9007199254740993_${uuid}`, 'millis', 'uuid')).toBeUndefined();
  });

  it('treats a missing or malformed cursor as the first page', () => {
    expect(decodeSortCursor(undefined, 'int', 'uuid')).toBeUndefined();
    expect(decodeSortCursor('', 'int', 'uuid')).toBeUndefined();
    expect(decodeSortCursor('no-separator', 'int', 'uuid')).toBeUndefined();
    expect(decodeSortCursor(`_${uuid}`, 'int', 'uuid')).toBeUndefined();
    expect(decodeSortCursor('123_', 'int', 'uuid')).toBeUndefined();
    expect(decodeSortCursor(`-1_${uuid}`, 'int', 'uuid')).toBeUndefined();
    expect(decodeSortCursor(`1.5_${uuid}`, 'int', 'uuid')).toBeUndefined();
    expect(decodeSortCursor(`abc_${uuid}`, 'int', 'uuid')).toBeUndefined();
    // Past int8: Postgres would answer 22003, a 500.
    expect(decodeSortCursor(`9223372036854775808_${uuid}`, 'int', 'uuid')).toBeUndefined();
  });

  it('applies the id shape like decodeKeyset', () => {
    expect(decodeSortCursor('0_not-a-uuid', 'int', 'uuid')).toBeUndefined();
    expect(decodeSortCursor('0_not-a-uuid', 'int', 'text')).toBeDefined();
    expect(decodeSortCursor('0_42', 'int', 'int')).toEqual({ value: '0', id: '42' });
    expect(decodeSortCursor('0_0.5', 'int', 'int')).toBeUndefined();
  });
});
