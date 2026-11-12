import { describe, expect, it } from 'vitest';
import { cursorQuerySchema, decodeTupleCursor, encodeTupleCursor } from '@buddha/shared';
import { rankingCursorCodec } from './market-ranking-cursor.js';

const codec = rankingCursorCodec('test-only-ranking-cursor-key');
const raw = encodeTupleCursor(
  ['0', '253402300799999', '9223372036854775806', '9223372036854775807', '253402300799999'],
  '11111111-1111-4111-8111-111111111111',
);

describe('private market ranking cursors', () => {
  it('round trips the largest keyset within the public cursor bound without exposing its fields', () => {
    const sealed = codec.seal('recommended', raw);
    expect(cursorQuerySchema.safeParse({ cursor: sealed }).success).toBe(true);
    expect(codec.open('recommended', sealed)).toBe(raw);
    expect(sealed).not.toContain('9223372036854775806');
    expect(Buffer.from(sealed, 'base64url').toString()).not.toContain(raw);
    expect(
      decodeTupleCursor(sealed, ['group', 'millis', 'int', 'int', 'nullableMillis'], 'uuid'),
    ).toBeUndefined();
    expect(codec.seal('recommended', raw)).toBe(sealed);
  });

  it('binds authenticated contents to the sort and configured secret', () => {
    const sealed = codec.seal('recommended', raw);
    expect(codec.open('volume', sealed)).toBeUndefined();
    expect(rankingCursorCodec('another-key').open('recommended', sealed)).toBeUndefined();
    const bytes = Buffer.from(sealed, 'base64url');
    bytes[14] = bytes[14]! ^ 1;
    expect(codec.open('recommended', bytes.toString('base64url'))).toBeUndefined();
  });

  it.each([undefined, '', raw, 'a'.repeat(201), '%%%invalid', 'AQ', 'AAAA='])(
    'treats malformed or old plaintext %s as a first page',
    (input) => {
      expect(codec.open('recommended', input)).toBeUndefined();
    },
  );
});
