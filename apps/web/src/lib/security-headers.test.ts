/**
 * PLAN M6 "보안: 헤더(helmet 상당)" for the document tier. The policy lives in `next.config.ts`
 * because that is where Next reads it from, and this pins the two things about it that are easy
 * to break silently: what it lets the app do, and what it stops letting it do in production.
 */
import type { NextConfig } from 'next';
import { afterEach, describe, expect, it, vi } from 'vitest';

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

async function rulesFor(nodeEnv: string): Promise<HeaderRule[]> {
  vi.stubEnv('NODE_ENV', nodeEnv);
  // The branch is decided when the module is evaluated, so the module has to be evaluated
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
    // A market image is a URL an admin types (PLAN 17 Q5).
    expect(policy).toContain("img-src 'self' data: https:");
  });

  it('forbids the three redirects an injected tag would otherwise still have', async () => {
    const policy = policyOf(await rulesFor('development'));
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it("drops 'unsafe-eval' in production", async () => {
    // React Refresh evaluates the modules it hot-swaps, so development needs it. Shipping it
    // would hand an injected string a way to become code.
    expect(policyOf(await rulesFor('development'))).toContain("'unsafe-eval'");
    expect(policyOf(await rulesFor('production'))).not.toContain("'unsafe-eval'");
  });
});
