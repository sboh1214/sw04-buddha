import { describe, expect, it } from 'vitest';
import {
  expectedAccountBodySchema,
  expectedAccountIdSchema,
  expectedAccountQuerySchema,
  namesAFieldBesideAccount,
} from './expected-account.js';

describe('the account a write names (ADR-0092)', () => {
  it('is a better-auth user id: text of 1 to 255 characters', () => {
    expect(expectedAccountIdSchema.parse('u1')).toBe('u1');
    for (const id of ['', 'x'.repeat(256), 7, null, undefined]) {
      expect(expectedAccountIdSchema.safeParse(id).success, String(id)).toBe(false);
    }
  });

  it('is the whole body of a transition and the whole query of a removal', () => {
    expect(expectedAccountBodySchema.parse({ expectedAccountId: 'u1', extra: 1 })).toEqual({
      expectedAccountId: 'u1',
    });
    expect(expectedAccountQuerySchema.parse({ expectedAccountId: 'u1' })).toEqual({
      expectedAccountId: 'u1',
    });
    for (const schema of [expectedAccountBodySchema, expectedAccountQuerySchema]) {
      const missing = schema.safeParse({});
      expect(missing.error?.issues.map((issue) => issue.path)).toEqual([['expectedAccountId']]);
    }
  });

  it('is no field of a patch: only another defined field is', () => {
    expect(namesAFieldBesideAccount({ expectedAccountId: 'u1' })).toBe(false);
    expect(namesAFieldBesideAccount({ expectedAccountId: 'u1', title: undefined })).toBe(false);
    expect(namesAFieldBesideAccount({ expectedAccountId: 'u1', title: 'a' })).toBe(true);
    expect(namesAFieldBesideAccount({ expectedAccountId: 'u1', description: null })).toBe(true);
    expect(namesAFieldBesideAccount({})).toBe(false);
  });
});
