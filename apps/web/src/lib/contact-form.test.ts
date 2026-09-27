import { contactBodySchema } from '@buddha/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import {
  contactFormSchema,
  contactFormValues,
  contactFieldError,
  formatPhone,
} from './contact-form';
import { ApiError } from './api';

/** The message the form shows for one field, or undefined when that field is accepted. */
function messageFor(field: 'realName' | 'phone', value: string): string | undefined {
  const values = { realName: '홍길동', phone: '010-1234-5678', [field]: value };
  const parsed = contactFormSchema.safeParse(values);
  if (parsed.success) return undefined;
  return parsed.error.issues.find((issue) => issue.path[0] === field)?.message;
}

describe('contactFormSchema', () => {
  it('outputs what the API stores: a trimmed NFC name and a digits-only phone', () => {
    expect(contactFormSchema.parse({ realName: '  홍길동 ', phone: ' 010-1234-5678 ' })).toEqual({
      realName: '홍길동',
      phone: '01012345678',
    });
    expect(contactFormSchema.parse({ realName: ' Kim Min su', phone: '016 123 4567' })).toEqual({
      realName: 'Kim Min su',
      phone: '0161234567',
    });
    // Decomposed Hangul (macOS input) is stored as syllables.
    expect(
      contactFormSchema.parse({ realName: '홍길동'.normalize('NFD'), phone: '01012345678' })
        .realName,
    ).toBe('홍길동');
    expect(contactFormSchema.parse({ realName: '남궁·민수', phone: '01912345678' }).realName).toBe(
      '남궁·민수',
    );
  });

  it('says "required" for a blank field and names the rule otherwise, in Korean', () => {
    expect(messageFor('realName', '')).toBe(copy.errRealNameRequired);
    expect(messageFor('realName', '   ')).toBe(copy.errRealNameRequired);
    expect(messageFor('phone', '')).toBe(copy.errPhoneRequired);
    for (const name of ['김', '홍길동1', 'Kim_Minsu', '·홍길동', '홍길동·', 'a'.repeat(31)]) {
      expect(messageFor('realName', name), name).toBe(copy.errRealNameFormat);
    }
    for (const phone of [
      '02-123-4567',
      '010-123-456',
      '010-1234-56789',
      '0101234567a',
      '+82 10 1234 5678',
      '01212345678',
    ]) {
      expect(messageFor('phone', phone), phone).toBe(copy.errPhoneFormat);
    }
  });

  it('accepts and refuses exactly what the API body schema does (the rule is shared)', () => {
    const candidate = fc.oneof(
      fc.string({ maxLength: 40 }),
      fc.constantFrom(
        '홍길동',
        ' 홍 길동 ',
        'Kim',
        '김',
        '홍·',
        '010-1234-5678',
        '0101234567',
        '010 1234 5678',
        '01912345678',
      ),
    );
    fc.assert(
      fc.property(candidate, candidate, (realName, phone) => {
        const form = contactFormSchema.safeParse({ realName, phone });
        const api = contactBodySchema.safeParse({ realName, phone });
        expect(form.success).toBe(api.success);
        if (form.success && api.success) expect(form.data).toEqual(api.data);
      }),
    );
  });
});

describe('formatPhone', () => {
  it('hyphenates 11- and 10-digit numbers the usual way', () => {
    expect(formatPhone('01012345678')).toBe('010-1234-5678');
    expect(formatPhone('0111234567')).toBe('011-123-4567');
  });

  it('leaves anything else alone', () => {
    expect(formatPhone('')).toBe('');
    expect(formatPhone('010-1234-5678')).toBe('010-1234-5678');
    expect(formatPhone('123')).toBe('123');
  });

  it('round-trips through the form schema to the stored digits', () => {
    for (const digits of ['01012345678', '0111234567', '01998765432']) {
      expect(
        contactFormSchema.parse({ realName: '홍길동', phone: formatPhone(digits) }).phone,
      ).toBe(digits);
    }
  });
});

describe('contactFormValues', () => {
  it('seeds blank inputs for an account without a contact', () => {
    expect(contactFormValues(null)).toEqual({ realName: '', phone: '' });
    expect(contactFormValues(undefined)).toEqual({ realName: '', phone: '' });
  });

  it('seeds the stored name and the formatted number', () => {
    expect(contactFormValues({ realName: '홍길동', phone: '01012345678' })).toEqual({
      realName: '홍길동',
      phone: '010-1234-5678',
    });
  });
});

describe('contactFieldError', () => {
  const refusal = (path: string[]) =>
    new ApiError(400, {
      code: 'VALIDATION_ERROR',
      message: 'Invalid body',
      details: [{ path, message: 'x' }],
    });

  it('pins a refusal to the field the server names, with the Korean rule', () => {
    expect(contactFieldError(refusal(['realName']))).toEqual({
      field: 'realName',
      message: copy.errRealNameFormat,
    });
    expect(contactFieldError(refusal(['phone']))).toEqual({
      field: 'phone',
      message: copy.errPhoneFormat,
    });
  });

  it('leaves everything else to a toast', () => {
    expect(contactFieldError(refusal(['nickname']))).toBeUndefined();
    expect(
      contactFieldError(new ApiError(400, { code: 'VALIDATION_ERROR', message: 'x' })),
    ).toBeUndefined();
    expect(contactFieldError(new ApiError(401, undefined))).toBeUndefined();
    expect(
      contactFieldError(new ApiError(500, { code: 'INTERNAL', message: 'x' })),
    ).toBeUndefined();
    expect(contactFieldError(new Error('network'))).toBeUndefined();
  });
});
