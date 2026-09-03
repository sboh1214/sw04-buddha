import { describe, expect, it } from 'vitest';
import { envSchema } from './env.js';

/**
 * The env schema is pure (no DB, no Redis), so this suite runs with the docker test profile
 * down. Each case overrides the one key it is about.
 */
const base = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@localhost:5432/buddha',
  REDIS_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
} as const;

const parseFrom = (SMTP_FROM: string) => envSchema.safeParse({ ...base, SMTP_FROM });

describe('SMTP_FROM', () => {
  it.each([
    'noreply@buddha.local',
    '<noreply@buddha.local>',
    'buddha <noreply@buddha.local>',
    '부처 <noreply@buddha.local>',
    '"Buddha, Inc." <noreply@buddha.local>',
    'no.reply+verify@mail.buddha.kr',
    '  buddha  <no-reply@mail.buddha.kr>  ',
  ])('accepts %j', (value) => {
    expect(parseFrom(value).success).toBe(true);
  });

  it.each(['foo', 'not an email at all', '<>', 'foo@', '@buddha.local', 'buddha <foo>'])(
    'rejects %j so a dead mail pipeline cannot reach production',
    (value) => {
      const result = parseFrom(value);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['SMTP_FROM']);
    },
  );

  it('defaults to the Mailpit sender when unset', () => {
    expect(envSchema.parse(base).SMTP_FROM).toBe('noreply@buddha.local');
  });
});
