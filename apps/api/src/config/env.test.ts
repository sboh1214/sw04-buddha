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

describe('AUTH_COOKIE_DOMAIN', () => {
  it('is unset by default, which keeps the session cookie host-only', () => {
    // Every environment the project has today. Locally the web and the API differ only by
    // port, and a port is no part of a cookie's identity, so nothing has to be shared.
    const parsed = envSchema.parse(base);
    expect(parsed.AUTH_COOKIE_DOMAIN).toBeUndefined();
  });

  it('takes the registrable domain two hosts of one deployment share', () => {
    // The auth host must be UNDER it — this pairing used to be written against the defaulted
    // `http://localhost:3000`, which is a cookie no browser would ever send back.
    expect(
      envSchema.parse({
        ...base,
        BETTER_AUTH_URL: 'https://app.example.com',
        AUTH_COOKIE_DOMAIN: 'example.com',
      }).AUTH_COOKIE_DOMAIN,
    ).toBe('example.com');
    // Equality counts too: a domain that IS the auth host is sent back to it.
    expect(
      envSchema.parse({
        ...base,
        BETTER_AUTH_URL: 'https://buddha.co.kr',
        AUTH_COOKIE_DOMAIN: 'buddha.co.kr',
      }).AUTH_COOKIE_DOMAIN,
    ).toBe('buddha.co.kr');
  });

  it('leaves an unparseable BETTER_AUTH_URL to its own error instead of throwing', () => {
    // A superRefine runs even when a FIELD failed, so the body sees the raw string. Reading the
    // host with `new URL` threw a bare TypeError straight through `safeParse` — the readable boot
    // error naming BETTER_AUTH_URL became a stack trace naming nothing, and only for deployments
    // that set AUTH_COOKIE_DOMAIN, which is to say the ones that split hosts.
    for (const bad of ['not-a-url', '']) {
      const run = () =>
        envSchema.safeParse({ ...base, BETTER_AUTH_URL: bad, AUTH_COOKIE_DOMAIN: 'example.com' });
      expect(run, JSON.stringify(bad)).not.toThrow();
      const result = run();
      expect(result.success).toBe(false);
      if (!result.success) {
        // Only BETTER_AUTH_URL is named: one value must not raise two issues, and the cookie
        // domain is not what is wrong here.
        expect(result.error.issues.map((issue) => issue.path)).toEqual([['BETTER_AUTH_URL']]);
      }
    }
  });

  it('refuses a well-formed domain the auth host is not under', () => {
    // THE HAZARD: shape was the only test, so an unrelated hostname started the API cleanly and
    // then emitted `Domain=example.net` from `app.example.com`. RFC 6265 domain-matching requires
    // the Domain to be the host or a parent of it, so the browser DROPS the Set-Cookie: sign-in
    // never persists and nothing is logged — the exact silent death this variable exists to
    // convert into a boot failure.
    for (const [authUrl, bad] of [
      ['https://app.example.com', 'example.net'],
      // Label-wise, so a plain `endsWith` cannot be mistaken for domain-matching.
      ['https://badexample.com', 'example.com'],
      // A localhost deployment has no parent domain to share, which is why the default is unset.
      ['http://localhost:3000', 'example.com'],
      // A CHILD of the auth host is not a parent of it, so the cookie would not come back either.
      ['https://example.com', 'app.example.com'],
    ] as const) {
      const result = envSchema.safeParse({
        ...base,
        BETTER_AUTH_URL: authUrl,
        AUTH_COOKIE_DOMAIN: bad,
      });
      expect(result.success, `${authUrl} / ${bad}`).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(['AUTH_COOKIE_DOMAIN']);
    }
  });

  it('refuses everything better-auth would accept and silently scope to nothing', () => {
    // The whole point of the variable is that a wrong value fails LOUDLY: better-auth takes
    // any string, and a cookie scoped to a domain that matches no host is indistinguishable
    // at runtime from the bug this closes — realtime dead, nothing logged.
    for (const bad of [
      'https://example.com',
      '.example.com',
      'example.com/',
      'localhost',
      'app example.com',
      'example.com:443',
    ]) {
      const result = envSchema.safeParse({ ...base, AUTH_COOKIE_DOMAIN: bad });
      expect(result.success, bad).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(['AUTH_COOKIE_DOMAIN']);
    }
  });
});
