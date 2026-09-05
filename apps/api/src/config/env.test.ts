import { describe, expect, it } from 'vitest';
import { envSchema, webOrigins } from './env.js';

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

describe('webOrigins', () => {
  const BETTER_AUTH_URL = 'http://localhost:3000';

  it('reduces every configured entry to the origin a browser would send', () => {
    // SessionGuard matches the `Origin` header exactly; a trailing slash, a path, an upper-case
    // host or a default port in .env must not turn into a 403 on every write.
    expect(
      webOrigins({
        WEB_ORIGIN:
          'https://App.Example.com/, https://example.com:443/wallet ,http://localhost:3000',
        BETTER_AUTH_URL,
      }),
    ).toEqual(['https://app.example.com', 'https://example.com', 'http://localhost:3000']);
    expect(
      webOrigins({ WEB_ORIGIN: 'https://a.example, https://a.example/', BETTER_AUTH_URL }),
    ).toEqual(['https://a.example']);
  });

  it('falls back to the BETTER_AUTH_URL origin when nothing is configured', () => {
    expect(webOrigins({ WEB_ORIGIN: undefined, BETTER_AUTH_URL })).toEqual([
      'http://localhost:3000',
    ]);
    expect(webOrigins({ WEB_ORIGIN: ' , ', BETTER_AUTH_URL })).toEqual(['http://localhost:3000']);
  });

  it('refuses what a browser could never send as Origin, wildcard patterns included', () => {
    // Failing at startup beats refusing every cookie-authenticated mutation at runtime. Node
    // parses `https://*.example.com` and yields "null" for `mailto:`/`myapp://`/`localhost:3000`
    // rather than throwing, so the URL parser alone would let these into the trusted set.
    for (const bad of [
      'app.example.com',
      'localhost:3000',
      'https://*.example.com',
      'https://preview-*.example.com',
      'mailto:x@example.com',
      'myapp://callback',
    ]) {
      expect(() => webOrigins({ WEB_ORIGIN: bad, BETTER_AUTH_URL }), bad).toThrow(/WEB_ORIGIN/);
    }
  });

  it('is enforced by the env schema, naming WEB_ORIGIN', () => {
    const result = envSchema.safeParse({ ...base, WEB_ORIGIN: 'https://ok.example, *.example' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['WEB_ORIGIN']);
    expect(envSchema.safeParse({ ...base, WEB_ORIGIN: 'https://App.Example.com/' }).success).toBe(
      true,
    );
  });
});
