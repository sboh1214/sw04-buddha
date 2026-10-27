import { describe, expect, it } from 'vitest';
import {
  aligoCredentials,
  DEV_PHONE_HASH_KEY,
  envSchema,
  parseTrustProxy,
  phoneHashKey,
  smsProvider,
  uncountedPeers,
  webOrigins,
} from './env.js';

/**
 * The env schema is pure (no DB, no Redis), so this suite runs with the docker test profile
 * down. Each case overrides the one key it is about.
 */
const base = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@localhost:5432/buddha',
  REDIS_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  PHONE_HASH_KEY: 'h'.repeat(32),
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

describe('TRUST_PROXY', () => {
  it('defaults to trusting nobody, so a client cannot name its own address', () => {
    const parsed = envSchema.parse(base);
    expect(parsed.TRUST_PROXY).toBe('false');
    expect(parseTrustProxy(parsed.TRUST_PROXY)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy(' FALSE ')).toBe(false);
  });

  it('reads `true` as every hop (never the deployed value) and a list as those hops only', () => {
    expect(parseTrustProxy('true')).toBe(true);
    // The deployment's value (terraform env.tftpl): Caddy's fixed address on the compose network.
    expect(parseTrustProxy('172.28.0.10/32')).toEqual(['172.28.0.10/32']);
    expect(parseTrustProxy(' 10.0.0.1 , 10.0.0.2/32 ,')).toEqual(['10.0.0.1', '10.0.0.2/32']);
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

describe('payments (ADR-0042)', () => {
  it('defaults to the mock provider', () => {
    // Production included: nothing has to be set.
    expect(envSchema.parse(base).PAYMENT_PROVIDER).toBe('mock');
    // compose renders an unset `${PAYMENT_PROVIDER}` as ''.
    expect(envSchema.parse({ ...base, PAYMENT_PROVIDER: ' ' }).PAYMENT_PROVIDER).toBe('mock');
  });

  it('refuses a provider nothing registers, SmartroPay included (ADR-0049)', () => {
    for (const value of ['smartro', 'toss']) {
      const result = envSchema.safeParse({ ...base, PAYMENT_PROVIDER: value });
      expect(result.success, value).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toEqual([['PAYMENT_PROVIDER']]);
      }
    }
  });

  it('ignores the SmartroPay keys an .env rendered before ADR-0049 still carries', () => {
    const parsed = envSchema.parse({
      ...base,
      SMARTRO_MODE: 'STG',
      SMARTRO_MID: 't_2409001m',
      SMARTRO_MERCHANT_KEY: 'k'.repeat(64),
      SMARTRO_CANCEL_PASSWORD: 'cancel-pw',
    });
    expect(parsed.PAYMENT_PROVIDER).toBe('mock');
    expect(parsed).not.toHaveProperty('SMARTRO_MID');
  });
});

describe('SMS (#183, ADR-0070)', () => {
  const aligo = { ALIGO_API_KEY: 'key', ALIGO_USER_ID: 'buddha', ALIGO_SENDER: '0212345678' };

  it('sends through aligo in production and through the dev sender elsewhere, unless told', () => {
    expect(smsProvider(envSchema.parse(base))).toBe('aligo');
    for (const NODE_ENV of ['development', 'test'] as const) {
      expect(smsProvider(envSchema.parse({ ...base, NODE_ENV }))).toBe('dev');
      // compose renders an unset `${SMS_PROVIDER}` as ''.
      expect(smsProvider(envSchema.parse({ ...base, NODE_ENV, SMS_PROVIDER: ' ' }))).toBe('dev');
      expect(smsProvider(envSchema.parse({ ...base, NODE_ENV, SMS_PROVIDER: 'aligo' }))).toBe(
        'aligo',
      );
    }
  });

  it('refuses the dev sender in production, and a provider it does not know', () => {
    for (const [env, path] of [
      [{ ...base, SMS_PROVIDER: 'dev' }, 'SMS_PROVIDER'],
      [{ ...base, NODE_ENV: 'development', SMS_PROVIDER: 'twilio' }, 'SMS_PROVIDER'],
    ] as const) {
      const result = envSchema.safeParse(env);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toEqual([[path]]);
    }
  });

  it('boots without the aligo keys, which then refuse every send (no credentials)', () => {
    const env = envSchema.parse(base);
    expect(aligoCredentials(env)).toBeUndefined();
    expect(env.ALIGO_TEST_MODE).toBe(false);
    expect(aligoCredentials(envSchema.parse({ ...base, ...aligo }))).toEqual({
      apiKey: 'key',
      userId: 'buddha',
      sender: '0212345678',
    });
    expect(envSchema.parse({ ...base, ...aligo, ALIGO_TEST_MODE: 'true' }).ALIGO_TEST_MODE).toBe(
      true,
    );
  });

  it('takes the three aligo keys together or not at all, and a sender of digits', () => {
    for (const [env, path] of [
      [{ ...base, ALIGO_API_KEY: 'key' }, 'ALIGO_API_KEY'],
      [{ ...base, ...aligo, ALIGO_USER_ID: '' }, 'ALIGO_API_KEY'],
      [{ ...base, ...aligo, ALIGO_SENDER: '02-1234-5678' }, 'ALIGO_SENDER'],
      [{ ...base, ...aligo, ALIGO_SENDER: '1234567' }, 'ALIGO_SENDER'],
    ] as const) {
      const result = envSchema.safeParse(env);
      expect(result.success, JSON.stringify(env)).toBe(false);
      if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toEqual([[path]]);
    }
  });
});

describe('PHONE_HASH_KEY (#70, ADR-0071)', () => {
  const { PHONE_HASH_KEY: _key, ...withoutKey } = base;

  it('is required in production, at least 32 characters, not a repository key and not the session secret', () => {
    for (const env of [
      withoutKey,
      { ...base, PHONE_HASH_KEY: '' },
      { ...base, PHONE_HASH_KEY: 'h'.repeat(31) },
      { ...base, PHONE_HASH_KEY: base.BETTER_AUTH_SECRET },
      // Long enough, but public: the code's development key, and another value carrying its mark
      // — a production .env given either would hash with a key anyone has.
      { ...base, PHONE_HASH_KEY: DEV_PHONE_HASH_KEY },
      { ...base, PHONE_HASH_KEY: 'development-only-phone-hash-key-change-in-production' },
    ]) {
      const result = envSchema.safeParse(env);
      expect(result.success, JSON.stringify(env)).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toEqual([['PHONE_HASH_KEY']]);
      }
    }
    expect(phoneHashKey(envSchema.parse(base))).toBe('h'.repeat(32));
  });

  it('falls back to the development key outside production only', () => {
    for (const NODE_ENV of ['development', 'test'] as const) {
      const env = envSchema.parse({ ...withoutKey, NODE_ENV });
      expect(phoneHashKey(env)).toBe(DEV_PHONE_HASH_KEY);
      // Left empty, as .env.example has it: the same fallback.
      expect(phoneHashKey(envSchema.parse({ ...base, NODE_ENV, PHONE_HASH_KEY: '' }))).toBe(
        DEV_PHONE_HASH_KEY,
      );
      // A development key is fine outside production.
      expect(
        envSchema.safeParse({ ...base, NODE_ENV, PHONE_HASH_KEY: DEV_PHONE_HASH_KEY }).success,
      ).toBe(true);
      expect(phoneHashKey(envSchema.parse({ ...base, NODE_ENV }))).toBe('h'.repeat(32));
    }
    // Should a production env ever get past the schema without it, the key is not invented.
    expect(() => phoneHashKey({ NODE_ENV: 'production', PHONE_HASH_KEY: undefined })).toThrow(
      /required in production/,
    );
  });
});

describe('media storage (#46, ADR-0073)', () => {
  it('boots in production without a bucket (every upload then fails) and refuses the local directory', () => {
    const env = envSchema.parse(base);
    expect(env.MEDIA_STORAGE).toBeUndefined();
    expect(env.MEDIA_S3_BUCKET).toBeUndefined();
    for (const [values, path] of [
      [{ MEDIA_STORAGE: 'local' }, 'MEDIA_STORAGE'],
      [{ MEDIA_S3_ACCESS_KEY_ID: 'AKIA' }, 'MEDIA_S3_ACCESS_KEY_ID'],
      [{ MEDIA_S3_BUCKET: 'Not A Bucket' }, 'MEDIA_S3_BUCKET'],
    ] as const) {
      const result = envSchema.safeParse({ ...base, ...values });
      expect(result.success, JSON.stringify(values)).toBe(false);
      if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toEqual([[path]]);
    }
    expect(
      envSchema.parse({
        ...base,
        MEDIA_S3_BUCKET: 'tf-buddha-prod-media',
        MEDIA_S3_ACCESS_KEY_ID: 'AKIA',
        MEDIA_S3_SECRET_ACCESS_KEY: 'secret',
      }).MEDIA_S3_BUCKET,
    ).toBe('tf-buddha-prod-media');
    expect(
      envSchema.safeParse({ ...base, NODE_ENV: 'development', MEDIA_STORAGE: 'local' }).success,
    ).toBe(true);
  });
});

describe('API_MEMORY_CEILING_MIB (#46, owner decision 2026-10-22 answer 3, ADR-0073 9-46)', () => {
  it('is unset by default and when left empty: the ceiling then comes from the memory limit', () => {
    expect(envSchema.parse(base).API_MEMORY_CEILING_MIB).toBeUndefined();
    expect(envSchema.parse({ ...base, API_MEMORY_CEILING_MIB: '' }).API_MEMORY_CEILING_MIB).toBe(
      undefined,
    );
    expect(envSchema.parse({ ...base, API_MEMORY_CEILING_MIB: ' ' }).API_MEMORY_CEILING_MIB).toBe(
      undefined,
    );
  });

  it('takes a whole number of MiB, and refuses anything else under its own name', () => {
    expect(envSchema.parse({ ...base, API_MEMORY_CEILING_MIB: '400' }).API_MEMORY_CEILING_MIB).toBe(
      400,
    );
    for (const value of ['0', '-1', '400.5', 'lots', '416MiB']) {
      const result = envSchema.safeParse({ ...base, API_MEMORY_CEILING_MIB: value });
      expect(result.success, value).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path)).toEqual([
          ['API_MEMORY_CEILING_MIB'],
        ]);
      }
    }
  });
});
