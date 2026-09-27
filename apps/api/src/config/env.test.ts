import { describe, expect, it } from 'vitest';
import { envSchema, uncountedPeers, webOrigins } from './env.js';

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

describe('RATE_LIMIT_UNCOUNTED_PEERS', () => {
  it('is optional, and empty means nobody', () => {
    expect(envSchema.safeParse(base).success).toBe(true);
    const list = uncountedPeers({ RATE_LIMIT_UNCOUNTED_PEERS: ' , ' });
    expect(list.check('10.0.0.1')).toBe(false);
  });

  it('accepts addresses and CIDRs of both families, with the family passed to BlockList', () => {
    const list = uncountedPeers({
      RATE_LIMIT_UNCOUNTED_PEERS: '10.0.0.5, 172.18.0.0/16, fd00::5, 2001:db8::/32',
    });
    expect(list.check('10.0.0.5')).toBe(true);
    expect(list.check('172.18.200.1')).toBe(true);
    // `BlockList.check` defaults to IPv4 and answers `false` for an IPv6 address checked as
    // such — the caller passes the family; these prove the entries were ADDED as IPv6.
    expect(list.check('fd00::5', 'ipv6')).toBe(true);
    expect(list.check('2001:db8:1::1', 'ipv6')).toBe(true);
    expect(list.check('2001:db9::1', 'ipv6')).toBe(false);
  });

  it('reads an IPv4-mapped entry as the IPv4 it is, prefix included', () => {
    // `::ffff:172.18.0.0/16` taken as IPv6 is `::/16`, which matches every IPv4 address there
    // is — the per-address limit switched off for everyone, with nothing to say so.
    const list = uncountedPeers({ RATE_LIMIT_UNCOUNTED_PEERS: '::ffff:172.18.0.0/16' });
    expect(list.check('172.18.9.9')).toBe(true);
    expect(list.check('203.0.113.9')).toBe(false);
    expect(list.check('8.8.8.8')).toBe(false);
  });

  it.each([
    'not-an-address',
    '10.0.0.5/33',
    'fd00::/129',
    '10.0.0.0/8/1',
    '10.0.0.0/x',
    '10.0.0.0/-1',
  ])('refuses %j under its own name, at load time', (bad) => {
    expect(() => uncountedPeers({ RATE_LIMIT_UNCOUNTED_PEERS: bad })).toThrow(
      /RATE_LIMIT_UNCOUNTED_PEERS/,
    );
    const result = envSchema.safeParse({ ...base, RATE_LIMIT_UNCOUNTED_PEERS: bad });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['RATE_LIMIT_UNCOUNTED_PEERS']);
    }
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

describe('TEST_DISPUTE_WINDOW_SECONDS', () => {
  it('defaults to PLAN 5.5 (24 hours) and coerces a whole number of seconds', () => {
    expect(envSchema.parse(base).TEST_DISPUTE_WINDOW_SECONDS).toBe(86_400);
    expect(
      envSchema.parse({ ...base, TEST_DISPUTE_WINDOW_SECONDS: '5' }).TEST_DISPUTE_WINDOW_SECONDS,
    ).toBe(5);
  });

  it('refuses zero, a fraction and text: a window of 0 would finalize before anyone could dispute', () => {
    for (const bad of ['0', '-1', '1.5', 'day']) {
      const result = envSchema.safeParse({ ...base, TEST_DISPUTE_WINDOW_SECONDS: bad });
      expect(result.success, bad).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual(['TEST_DISPUTE_WINDOW_SECONDS']);
      }
    }
  });
});

describe('payments (ADR-0042)', () => {
  const smartro = {
    PAYMENT_PROVIDER: 'smartro',
    SMARTRO_MID: 't_2409001m',
    SMARTRO_MERCHANT_KEY: 'k'.repeat(64),
    SMARTRO_CANCEL_PASSWORD: 'cancel-pw',
  } as const;

  it('defaults to the mock provider on STG with no SmartroPay credentials', () => {
    // Production included: nothing has to be set until the owner switches to SmartroPay.
    const parsed = envSchema.parse(base);
    expect(parsed.PAYMENT_PROVIDER).toBe('mock');
    expect(parsed.SMARTRO_MODE).toBe('STG');
    expect(parsed.SMARTRO_MID).toBeUndefined();
    expect(parsed.SMARTRO_MERCHANT_KEY).toBeUndefined();
    expect(parsed.SMARTRO_CANCEL_PASSWORD).toBeUndefined();
    expect(parsed.SMARTRO_APPROVAL_BASE_URL).toBeUndefined();
    // Empty values (the .env.example lines) mean unset, as for the OAuth keys.
    expect(
      envSchema.parse({ ...base, SMARTRO_MID: '', SMARTRO_APPROVAL_BASE_URL: '' }).SMARTRO_MID,
    ).toBeUndefined();
    // So do the provider and mode: compose renders an unset `${PAYMENT_PROVIDER}` as ''.
    expect(envSchema.parse({ ...base, PAYMENT_PROVIDER: '', SMARTRO_MODE: ' ' })).toMatchObject({
      PAYMENT_PROVIDER: 'mock',
      SMARTRO_MODE: 'STG',
    });
  });

  it('accepts SmartroPay with all three credentials, in either mode', () => {
    const parsed = envSchema.parse({ ...base, ...smartro, SMARTRO_MODE: 'REAL' });
    expect(parsed).toMatchObject({ ...smartro, SMARTRO_MODE: 'REAL' });
  });

  it('refuses an unknown provider or mode', () => {
    for (const [key, value] of [
      ['PAYMENT_PROVIDER', 'toss'],
      ['SMARTRO_MODE', 'DEV'],
      ['SMARTRO_MODE', 'stg'],
    ] as const) {
      const result = envSchema.safeParse({ ...base, [key]: value });
      expect(result.success, `${key}=${value}`).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual([key]);
    }
  });

  it.each(['SMARTRO_MID', 'SMARTRO_MERCHANT_KEY', 'SMARTRO_CANCEL_PASSWORD'] as const)(
    'requires %s when PAYMENT_PROVIDER=smartro, naming it',
    (key) => {
      const result = envSchema.safeParse({ ...base, ...smartro, [key]: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toEqual([[key]]);
      }
    },
  );

  it('checks the credential shapes whenever they are set', () => {
    // The key's first 32 characters are the AES-256 key of the cancel payload.
    for (const [key, value] of [
      ['SMARTRO_MERCHANT_KEY', 'k'.repeat(31)],
      ['SMARTRO_MID', 'x'.repeat(11)],
    ] as const) {
      for (const provider of ['mock', 'smartro'] as const) {
        const result = envSchema.safeParse({
          ...base,
          ...smartro,
          PAYMENT_PROVIDER: provider,
          [key]: value,
        });
        expect(result.success, `${provider} ${key}`).toBe(false);
        if (!result.success) expect(result.error.issues.map((i) => i.path)).toEqual([[key]]);
      }
    }
    expect(
      envSchema.safeParse({ ...base, ...smartro, SMARTRO_MERCHANT_KEY: 'k'.repeat(32) }).success,
    ).toBe(true);
  });

  it('takes an approval host override for a local fake PG, but never in production', () => {
    const override = { ...smartro, SMARTRO_APPROVAL_BASE_URL: 'http://localhost:4010' };
    expect(
      envSchema.parse({ ...base, ...override, NODE_ENV: 'development' }).SMARTRO_APPROVAL_BASE_URL,
    ).toBe('http://localhost:4010');
    expect(envSchema.safeParse({ ...base, ...override, NODE_ENV: 'test' }).success).toBe(true);

    const production = envSchema.safeParse({ ...base, ...override });
    expect(production.success).toBe(false);
    if (!production.success) {
      expect(production.error.issues.map((issue) => issue.path)).toEqual([
        ['SMARTRO_APPROVAL_BASE_URL'],
      ]);
    }
  });

  it('refuses an approval host override that is not an http(s) URL, with one issue', () => {
    for (const NODE_ENV of ['development', 'production'] as const) {
      for (const bad of ['localhost:4010', 'ftp://fake-pg.local', 'not a url']) {
        const result = envSchema.safeParse({
          ...base,
          NODE_ENV,
          SMARTRO_APPROVAL_BASE_URL: bad,
        });
        expect(result.success, `${NODE_ENV} ${bad}`).toBe(false);
        if (!result.success) {
          expect(result.error.issues.map((issue) => issue.path)).toEqual([
            ['SMARTRO_APPROVAL_BASE_URL'],
          ]);
        }
      }
    }
  });
});
