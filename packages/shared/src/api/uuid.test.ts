import { describe, expect, it } from 'vitest';
import { uuidParamSchema } from './path-param.js';
import { uuidSchema } from './uuid.js';

describe('uuidSchema', () => {
  const lower = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  it('accepts either case and answers the lower-case form Postgres returns', () => {
    expect(uuidSchema.parse(lower)).toBe(lower);
    expect(uuidSchema.parse(lower.toUpperCase())).toBe(lower);
    expect(uuidParamSchema.parse(lower.toUpperCase())).toBe(lower);
  });

  it('refuses anything that is not a uuid, naming the shape', () => {
    const result = uuidSchema.safeParse('not-a-uuid');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('must be a uuid');
    expect(uuidSchema.safeParse(lower.slice(1)).success).toBe(false);
    expect(uuidSchema.safeParse(`${lower} `).success).toBe(false);
  });
});
