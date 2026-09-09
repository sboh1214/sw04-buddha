import { getCookies } from 'better-auth/cookies';
import { describe, expect, it } from 'vitest';
import { crossSubDomainCookies } from './auth.js';

/**
 * What the session cookie is SCOPED to, read back through better-auth's own `getCookies` — the
 * same function the runtime uses to mint it. Pure: no app, no DB, no Redis.
 *
 * This is here because ADR-0017 got it wrong once. It required web and API to be same-SITE,
 * which is necessary for `SameSite=Lax` and says nothing about whether the cookie comes BACK to
 * a different host: a cookie minted with no `Domain` is host-only (RFC 6265 §5.1.3). The login
 * cookie is minted through the web host — the Next rewrite proxies `/api/auth/*` server-side —
 * while the Socket.IO client dials the API host directly, so on an `app.`/`api.` split every
 * signed-in user got an anonymous handshake, no `user:<id>` room, and a balance chip that
 * silently stopped moving. Nothing logged it and local development could not reproduce it,
 * `localhost:3000` and `localhost:4000` being one host.
 */
const options = (domain?: string) => ({
  baseURL: 'https://app.example.com',
  basePath: '/api/auth',
  advanced: { cookiePrefix: 'buddha', ...crossSubDomainCookies(domain) },
});

describe('the session cookie scope', () => {
  it('is host-only while no domain is configured', () => {
    // Every environment the project has today, local included, and the safer default.
    const { attributes } = getCookies(options()).sessionToken;
    expect(attributes).not.toHaveProperty('domain');
  });

  it('carries the configured domain, so both hosts of one deployment share it', () => {
    const { attributes, name } = getCookies(options('example.com')).sessionToken;
    expect(attributes.domain).toBe('example.com');
    // Only the scope moves. `SameSite=Lax` is what ADR-0017 relies on for the handshake, and
    // the `__Secure-` prefix permits a `Domain` — `__Host-` would have forbidden it, which is
    // what makes this fix possible at all.
    expect(attributes.sameSite).toBe('lax');
    expect(attributes.secure).toBe(true);
    expect(name).toBe('__Secure-buddha.session_token');
  });

  it('never lets better-auth pick the domain, because its guess is the wrong host', () => {
    // Enabled without one, better-auth falls back to `new URL(baseURL).hostname` — the WEB
    // host — which no API host domain-matches. The option would read as on and change nothing.
    expect(crossSubDomainCookies(undefined)).toEqual({});
    expect(crossSubDomainCookies('example.com')).toEqual({
      crossSubDomainCookies: { enabled: true, domain: 'example.com' },
    });
  });
});
