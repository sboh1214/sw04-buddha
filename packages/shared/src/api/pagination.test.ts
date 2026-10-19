import { describe, expect, it } from 'vitest';
import {
  CURSOR_NULL,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  cursorQuerySchema,
  decodeKeyset,
  decodeTupleCursor,
  encodeKeyset,
  encodeTupleCursor,
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
  });

  it('rejects a timestamp past year 9999, whose ISO form Postgres refuses (ADR-0065)', () => {
    // From year 10000 `toISOString()` writes '+010000-01-01T00:00:00.000Z', and `::timestamptz`
    // answers 22009 — a 500. The bound used to be the Date range's end, 8.64e15, which let every
    // value between the two through.
    expect(new Date(253402300800000).toISOString()).toBe('+010000-01-01T00:00:00.000Z');
    expect(decodeKeyset('253402300800000_x', 'text')).toBeUndefined();
    expect(decodeKeyset('8640000000000000_x', 'text')).toBeUndefined();
    // The last millisecond of 9999 is valid: a four-digit year, which Postgres parses.
    expect(decodeKeyset('253402300799999_x', 'text')).toEqual({
      createdAt: new Date('9999-12-31T23:59:59.999Z'),
      id: 'x',
    });
  });
});

describe('tuple cursors (ADR-0065)', () => {
  const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  /** `GET /markets?sort=recommended`: window end, 24-hour volume, open time, id. */
  const RECOMMENDED = ['millis', 'int', 'nullableMillis'] as const;

  it('round-trips several values and the id, NULL as its own word', () => {
    const cursor = encodeTupleCursor(['1788408306789', '125000', '1788300000000'], uuid);
    expect(cursor).toBe(`1788408306789_125000_1788300000000_${uuid}`);
    expect(decodeTupleCursor(cursor, RECOMMENDED, 'uuid')).toEqual({
      values: ['1788408306789', '125000', '1788300000000'],
      id: uuid,
    });
    // A market with no open time yet sorts after every opened one on the open-time key; its
    // cursor says so rather than inventing one.
    const unopened = encodeTupleCursor([CURSOR_NULL], uuid);
    expect(unopened).toBe(`null_${uuid}`);
    expect(decodeTupleCursor(unopened, ['nullableMillis'], 'uuid')).toEqual({
      values: [CURSOR_NULL],
      id: uuid,
    });
  });

  it('round-trips one bigint value and a uuid id, the shape a volume order pages on', () => {
    // What `encodeSortCursor` wrote for the volume order until ADR-0065; #132 brings it back.
    const cursor = encodeTupleCursor(['1234567890123456789'], uuid);
    expect(cursor).toBe(`1234567890123456789_${uuid}`);
    expect(decodeTupleCursor(cursor, ['int'], 'uuid')).toEqual({
      values: ['1234567890123456789'],
      id: uuid,
    });
    expect(decodeTupleCursor(encodeTupleCursor(['0'], uuid), ['int'], 'uuid')).toEqual({
      values: ['0'],
      id: uuid,
    });
    expect(decodeTupleCursor(`9223372036854775807_${uuid}`, ['int'], 'uuid')).toBeDefined();
    // Past int8: Postgres would answer 22003, a 500.
    expect(decodeTupleCursor(`9223372036854775808_${uuid}`, ['int'], 'uuid')).toBeUndefined();
    expect(decodeTupleCursor(`1.5_${uuid}`, ['int'], 'uuid')).toBeUndefined();
    expect(decodeTupleCursor(`abc_${uuid}`, ['int'], 'uuid')).toBeUndefined();
  });

  it('bounds a time value at the last millisecond of year 9999, like decodeKeyset', () => {
    for (const shape of ['millis', 'nullableMillis'] as const) {
      expect(decodeTupleCursor(`1788408306789_${uuid}`, [shape], 'uuid')).toEqual({
        values: ['1788408306789'],
        id: uuid,
      });
      expect(decodeTupleCursor(`253402300799999_${uuid}`, [shape], 'uuid')).toBeDefined();
      // Year 10000: an ISO string Postgres refuses as a timestamptz (22009), so a 500.
      expect(decodeTupleCursor(`253402300800000_${uuid}`, [shape], 'uuid')).toBeUndefined();
      expect(decodeTupleCursor(`8640000000000000_${uuid}`, [shape], 'uuid')).toBeUndefined();
      expect(decodeTupleCursor(`9007199254740993_${uuid}`, [shape], 'uuid')).toBeUndefined();
    }
    // In each time part of 추천's cursor: the window end and the open time.
    expect(
      decodeTupleCursor(`253402300800000_0_null_${uuid}`, RECOMMENDED, 'uuid'),
    ).toBeUndefined();
    expect(decodeTupleCursor(`1_0_253402300800000_${uuid}`, RECOMMENDED, 'uuid')).toBeUndefined();
  });

  it('applies the id shape like decodeKeyset', () => {
    expect(decodeTupleCursor('0_not-a-uuid', ['int'], 'uuid')).toBeUndefined();
    expect(decodeTupleCursor('0_not-a-uuid', ['int'], 'text')).toBeDefined();
    expect(decodeTupleCursor('0_42', ['int'], 'int')).toEqual({ values: ['0'], id: '42' });
    expect(decodeTupleCursor('0_0.5', ['int'], 'int')).toBeUndefined();
  });

  it('reads a group as 0 or 1 and nothing else (마감 임박 over ended markets, ADR-0066)', () => {
    const CLOSING = ['group', 'millis'] as const;
    for (const group of ['0', '1']) {
      const cursor = encodeTupleCursor([group, '1788408306789'], uuid);
      expect(decodeTupleCursor(cursor, CLOSING, 'uuid')).toEqual({
        values: [group, '1788408306789'],
        id: uuid,
      });
    }
    for (const group of ['2', '01', '-1', 'null', '']) {
      expect(
        decodeTupleCursor(`${group}_1788408306789_${uuid}`, CLOSING, 'uuid'),
        group,
      ).toBeUndefined();
    }
    // The close time is bounded like every time part, and the home's `<millis>_<uuid>` is a part
    // short.
    expect(decodeTupleCursor(`0_253402300800000_${uuid}`, CLOSING, 'uuid')).toBeUndefined();
    expect(decodeTupleCursor(`1_${uuid}`, CLOSING, 'uuid')).toBeUndefined();
    expect(decodeTupleCursor(`1788408306789_${uuid}`, CLOSING, 'uuid')).toBeUndefined();
  });

  it('reads the public theme order: a day, a rank of three, a signed day (#81, ADR-0088)', () => {
    const THEMES = ['epochDay', 'themeRank', 'signedEpochDay'] as const;
    for (const [rank, key] of [
      ['0', '20760'],
      ['1', '20761'],
      ['2', '-20750'],
      // A period's date may be any up to 9999-12-31: its key then has seven digits.
      ['0', '2932896'],
      ['1', '2932532'],
      ['2', '719162'],
    ] as const) {
      const cursor = encodeTupleCursor(['20745', rank, key], uuid);
      expect(decodeTupleCursor(cursor, THEMES, 'uuid')).toEqual({
        values: ['20745', rank, key],
        id: uuid,
      });
    }
    for (const bad of [
      `-1_0_20760_${uuid}`,
      `1234567_0_20760_${uuid}`,
      `20745_3_20760_${uuid}`,
      `20745_0_1.5_${uuid}`,
      `20745_0_12345678_${uuid}`,
      `20745_0_--1_${uuid}`,
      `20745_0_${uuid}`,
    ]) {
      expect(decodeTupleCursor(bad, THEMES, 'uuid'), bad).toBeUndefined();
    }
  });

  it('accepts NULL only where the caller named a nullable time', () => {
    expect(decodeTupleCursor(`null_${uuid}`, ['millis'], 'uuid')).toBeUndefined();
    expect(decodeTupleCursor(`null_${uuid}`, ['int'], 'uuid')).toBeUndefined();
    expect(decodeTupleCursor(`0_0_null_${uuid}`, RECOMMENDED, 'uuid')).toBeDefined();
    expect(decodeTupleCursor(`null_0_0_${uuid}`, RECOMMENDED, 'uuid')).toBeUndefined();
  });

  it('serves the first page for a part missing, a part too many or a part of the wrong shape', () => {
    expect(decodeTupleCursor(undefined, RECOMMENDED, 'uuid')).toBeUndefined();
    expect(decodeTupleCursor('', RECOMMENDED, 'uuid')).toBeUndefined();
    expect(decodeTupleCursor('no-separator', ['int'], 'uuid')).toBeUndefined();
    expect(decodeTupleCursor(`_${uuid}`, ['int'], 'uuid')).toBeUndefined();
    expect(decodeTupleCursor('123_', ['int'], 'uuid')).toBeUndefined();
    expect(decodeTupleCursor(`-1_${uuid}`, ['int'], 'uuid')).toBeUndefined();
    // Another order's cursor: `<millis>_<uuid>` (closing) is a part short for 추천.
    expect(decodeTupleCursor(`1788408306789_${uuid}`, RECOMMENDED, 'uuid')).toBeUndefined();
    // And 추천's is parts too many for 신규: the id half is not a uuid.
    expect(decodeTupleCursor(`1_2_3_${uuid}`, ['nullableMillis'], 'uuid')).toBeUndefined();
    expect(decodeTupleCursor(`1__3_${uuid}`, RECOMMENDED, 'uuid')).toBeUndefined();
    expect(decodeTupleCursor(`1_2_3_`, RECOMMENDED, 'uuid')).toBeUndefined();
    expect(decodeTupleCursor(`1_-2_3_${uuid}`, RECOMMENDED, 'uuid')).toBeUndefined();
    expect(decodeTupleCursor(`1_2_8640000000000001_${uuid}`, RECOMMENDED, 'uuid')).toBeUndefined();
    expect(decodeTupleCursor(`8640000000000001_2_3_${uuid}`, RECOMMENDED, 'uuid')).toBeUndefined();
    expect(
      decodeTupleCursor(`1_9223372036854775808_3_${uuid}`, RECOMMENDED, 'uuid'),
    ).toBeUndefined();
    expect(decodeTupleCursor('1_2_3_not-a-uuid', RECOMMENDED, 'uuid')).toBeUndefined();
  });

  it('leaves the id whole after the values, so a text id may hold the separator', () => {
    expect(decodeTupleCursor('5_user_with_underscores', ['int'], 'text')).toEqual({
      values: ['5'],
      id: 'user_with_underscores',
    });
  });
});
