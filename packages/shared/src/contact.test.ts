import { describe, expect, it } from 'vitest';
import {
  REAL_NAME_MAX_LENGTH,
  contactBodySchema,
  contactFieldsSchema,
  contactSchema,
  phoneSchema,
  realNameSchema,
} from './contact.js';

describe('realNameSchema', () => {
  it('accepts Hangul, Latin and other letters with spaces and ·, trimmed', () => {
    for (const [input, stored] of [
      ['홍길동', '홍길동'],
      ['  김 철수  ', '김 철수'],
      ['남궁민', '남궁민'],
      ['John Smith', 'John Smith'],
      ['José Müller', 'José Müller'],
      ['아이유·이지은', '아이유·이지은'],
      ['王小明', '王小明'],
      ['이', undefined],
    ] as const) {
      const result = realNameSchema.safeParse(input);
      if (stored === undefined) {
        expect(result.success, input).toBe(false);
      } else {
        expect(result.success, input).toBe(true);
        expect(result.data).toBe(stored);
      }
    }
  });

  it('stores decomposed Hangul (NFD) as the composed syllables and counts syllables', () => {
    const nfd = '홍길동'.normalize('NFD');
    expect(nfd.length).toBeGreaterThan(3);
    expect(realNameSchema.parse(nfd)).toBe('홍길동');
    // Thirty syllables fit even though their NFD form is ninety code units long.
    const thirty = '가'.repeat(REAL_NAME_MAX_LENGTH);
    expect(realNameSchema.parse(thirty.normalize('NFD'))).toBe(thirty);
  });

  it('refuses digits, symbols, edge separators and out-of-range lengths', () => {
    for (const bad of [
      '',
      '   ',
      '홍',
      '홍길동1',
      'hong_gildong',
      '홍길동!',
      'a@b',
      '·홍길동',
      '홍길동·',
      ' 홍길동 ·',
      '홍\t길동',
      '가'.repeat(REAL_NAME_MAX_LENGTH + 1),
    ]) {
      expect(realNameSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('phoneSchema', () => {
  it('normalises the usual spellings of a mobile number to digits', () => {
    for (const [input, digits] of [
      ['01012345678', '01012345678'],
      ['010-1234-5678', '01012345678'],
      [' 010 1234 5678 ', '01012345678'],
      ['011-123-4567', '0111234567'],
      ['016-1234-5678', '01612345678'],
      ['019 123 4567', '0191234567'],
    ] as const) {
      expect(phoneSchema.parse(input), input).toBe(digits);
    }
  });

  it('refuses landlines, foreign formats, letters and the wrong digit count', () => {
    for (const bad of [
      '',
      '02-123-4567',
      '012-1234-5678',
      '015-1234-5678',
      '+82-10-1234-5678',
      '(010) 1234-5678',
      '010-123-456',
      '010-12345-67890',
      '010-abcd-5678',
      '010.1234.5678',
      '0'.repeat(21),
    ]) {
      expect(phoneSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('contact bodies and DTOs', () => {
  it('validates and normalises PUT /me/contact', () => {
    expect(
      contactBodySchema.parse({
        realName: ' 홍길동 ',
        phone: '010-1234-5678',
        expectedAccountId: 'user-1',
      }),
    ).toEqual({ realName: '홍길동', phone: '01012345678', expectedAccountId: 'user-1' });
    const account = { expectedAccountId: 'user-1' };
    expect(contactBodySchema.safeParse({ realName: '홍길동', ...account }).success).toBe(false);
    expect(contactBodySchema.safeParse({ phone: '01012345678', ...account }).success).toBe(false);
  });

  it('requires the account the screen is showing on PUT /me/contact', () => {
    // A stale tab must not be able to write whoever the cookie now belongs to.
    const fields = { realName: '홍길동', phone: '01012345678' };
    expect(contactBodySchema.safeParse(fields).success).toBe(false);
    expect(contactBodySchema.safeParse({ ...fields, expectedAccountId: '' }).success).toBe(false);
    expect(
      contactBodySchema.safeParse({ ...fields, expectedAccountId: 'u'.repeat(256) }).success,
    ).toBe(false);
    expect(contactBodySchema.safeParse({ ...fields, expectedAccountId: undefined }).success).toBe(
      false,
    );
  });

  it('takes the two fields alone as the forms do, normalised the same way', () => {
    expect(contactFieldsSchema.parse({ realName: ' 홍길동 ', phone: '010-1234-5678' })).toEqual({
      realName: '홍길동',
      phone: '01012345678',
    });
    expect(contactFieldsSchema.safeParse({ realName: '홍길동' }).success).toBe(false);
  });

  it('describes a stored contact with digits-only phone', () => {
    const contact = { realName: '홍길동', phone: '01012345678' };
    expect(contactSchema.parse(contact)).toEqual(contact);
    expect(contactSchema.safeParse({ ...contact, phone: '010-1234-5678' }).success).toBe(false);
  });
});
