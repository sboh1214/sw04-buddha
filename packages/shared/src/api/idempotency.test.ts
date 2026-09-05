import { describe, expect, it } from 'vitest';
import { IDEMPOTENCY_KEY_HEADER, idempotencyKeySchema } from './idempotency.js';

describe('idempotencyKeySchema', () => {
  it('accepts the UUID the web client sends and other URL-safe tokens', () => {
    expect(idempotencyKeySchema.parse('3f1a5b6c-1111-4222-8333-444455556666')).toBe(
      '3f1a5b6c-1111-4222-8333-444455556666',
    );
    expect(idempotencyKeySchema.parse('  charge_2026-09-05_A  ')).toBe('charge_2026-09-05_A');
  });

  it('refuses a missing, short, long or non-token value', () => {
    for (const value of [undefined, '', 'short', 'x'.repeat(129), 'has space', 'semi;colon']) {
      expect(idempotencyKeySchema.safeParse(value).success).toBe(false);
    }
  });

  it('names the header PLAN 5.4 uses', () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe('Idempotency-Key');
  });
});
