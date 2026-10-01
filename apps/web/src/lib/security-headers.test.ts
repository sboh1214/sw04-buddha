/**
 * PLAN M6 "보안: 헤더(helmet 상당)" for the document tier. The policy lives in `next.config.ts`
 * because that is where Next reads it from, and this pins the two things about it that are easy
 * to break silently: what it lets the app do, and what it stops letting it do in production.
 */
import type { NextConfig } from 'next';
import { afterEach, describe, expect, it, vi } from 'vitest';

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

/**
 * `apiUrl` is stubbed explicitly, in both directions, rather than left to the default: the
 * config loads the repo-root `.env` first (values already in the environment win), so an
 * assertion that relied on the default would be reading whatever the developer's `.env` says.
 */
async function rulesFor(nodeEnv: string, apiUrl = 'http://localhost:4000'): Promise<HeaderRule[]> {
  vi.stubEnv('NODE_ENV', nodeEnv);
  vi.stubEnv('NEXT_PUBLIC_API_URL', apiUrl);
  // The branches are decided when the module is evaluated, so the module has to be evaluated
  // again — a plain second import would hand back the first one's cache.
  vi.resetModules();
  const loaded: { default: NextConfig } = await import('../../next.config.js');
  return (await loaded.default.headers?.()) as unknown as HeaderRule[];
}

function policyOf(rules: HeaderRule[]): string {
  const value = rules[0]?.headers.find((header) => header.key === 'Content-Security-Policy')?.value;
  if (value === undefined) throw new Error('no Content-Security-Policy header');
  return value;
}

/** The policy as directive → source list, so a host is pinned to the directive it belongs to. */
function directivesOf(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const directive of policy.split(';')) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  return directives;
}

/** The SmartroPay hosts (ADR-0042): the PC build and layer, and the mobile build and page. */
const SMARTRO_PC = ['https://tpay.smartropay.co.kr', 'https://pay.smartropay.co.kr'];
const SMARTRO_MOBILE = ['https://tmpay.smartropay.co.kr', 'https://mpay.smartropay.co.kr'];

describe('security headers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('applies to the document and NOT to the proxied API', async () => {
    const rules = await rulesFor('development');
    expect(rules).toHaveLength(1);
    // The API answers with its own headers (apps/api security-headers.ts). Two policies on one
    // response are enforced as their intersection — a rule assembled by accident out of two
    // files — so this pattern has to keep excluding /api.
    expect(rules[0]?.source).toBe('/((?!api/).*)');
    const keys = rules[0]?.headers.map((header) => header.key);
    expect(keys).toEqual([
      'Content-Security-Policy',
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Referrer-Policy',
      'Permissions-Policy',
      'Strict-Transport-Security',
    ]);
  });

  it('allows what Next, Chakra and the socket actually need', async () => {
    const policy = policyOf(await rulesFor('development'));
    // Emotion inserts Chakra's rules into a <style> tag at runtime (ADR-0009).
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    // Since M4 the browser dials the API origin directly and upgrades to a WebSocket
    // (ADR-0017); neither is 'self'.
    expect(policy).toContain('connect-src');
    expect(policy).toMatch(/connect-src [^;]*http:\/\/localhost:4000/);
    expect(policy).toMatch(/connect-src [^;]*ws:\/\/localhost:4000/);
    // A market image is a URL an admin types (PLAN 17 Q5), and the validator takes http(s).
    expect(policy).toContain("img-src 'self' data: https: http:");
  });

  it('lists http: images only for a plain-http API origin, where the document is plain http too', async () => {
    // A TLS page cannot reach a plain-http API (mixed content), so the API scheme is the
    // document's. Behind TLS an http image is upgraded or refused before the CSP is consulted,
    // and a scheme that permits nothing would only read as a policy allowing insecure loads.
    const plain = policyOf(await rulesFor('production', 'http://api.example.com'));
    expect(plain).toMatch(/img-src [^;]* http:/);
    const tls = policyOf(await rulesFor('production', 'https://api.example.com'));
    expect(tls).toMatch(/img-src [^;]*https:/);
    expect(tls).not.toMatch(/img-src [^;]* http:/);
  });

  it('forbids the three redirects an injected tag would otherwise still have', async () => {
    const policy = policyOf(await rulesFor('development'));
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it('lets the SmartroPay window in by exact host, each host only where the SDK needs it', async () => {
    // ADR-0042: the SDK script (both builds: the page loads the one matching the device), the
    // PC layer's iframe (PC hosts only — a phone leaves the page instead of framing it), and
    // the SDK's own form posts (into that iframe on a PC, the whole page on a phone). STG and
    // REAL both, because the mode is the API's runtime setting and this policy is build-time.
    for (const env of ['development', 'production']) {
      const directives = directivesOf(policyOf(await rulesFor(env)));
      expect(directives.get('script-src'), env).toEqual([
        "'self'",
        "'unsafe-inline'",
        ...(env === 'production' ? [] : ["'unsafe-eval'"]),
        ...SMARTRO_PC,
        ...SMARTRO_MOBILE,
      ]);
      expect(directives.get('frame-src'), env).toEqual(SMARTRO_PC);
      expect(directives.get('form-action'), env).toEqual([
        "'self'",
        ...SMARTRO_PC,
        ...SMARTRO_MOBILE,
      ]);
    }
  });

  it('loosens nothing else for the payment window', async () => {
    // The SDK's only XHR is a report of a mode mismatch, which may stay blocked; it loads no
    // images; its stop and our approval post to this origin. So these stay exactly as before,
    // and no wildcard or bare scheme is listed for the PG anywhere.
    const policy = policyOf(await rulesFor('production', 'https://api.example.com'));
    const directives = directivesOf(policy);
    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('connect-src')).toEqual([
      "'self'",
      'https://api.example.com',
      'wss://api.example.com',
    ]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.has('child-src')).toBe(false);
    expect(policy).not.toMatch(/\*/);
    // script-src and form-action name all four hosts, frame-src the two PC ones — and no other
    // directive names any.
    expect(policy.match(/smartropay/g)).toHaveLength(
      3 * SMARTRO_PC.length + 2 * SMARTRO_MOBILE.length,
    );
  });

  it("drops 'unsafe-eval' in production", async () => {
    // React Refresh evaluates the modules it hot-swaps, so development needs it. Shipping it
    // would hand an injected string a way to become code.
    expect(policyOf(await rulesFor('development'))).toContain("'unsafe-eval'");
    expect(policyOf(await rulesFor('production'))).not.toContain("'unsafe-eval'");
  });
});
