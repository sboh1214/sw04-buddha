import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import type { NextConfig } from 'next';

// Next.js only reads .env* files inside apps/web. The project keeps a single repo-root .env
// (PLAN 15), so load it here first; values already in process.env win. This runs when the
// config loads (next dev startup / next build), so build output is per environment.
loadEnv({ path: path.join(import.meta.dirname, '../../.env'), quiet: true });

const apiUrl = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

const isProduction = process.env.NODE_ENV === 'production';

/**
 * PLAN M6 "보안: 헤더(helmet 상당)" for the web tier.
 *
 * The API sets its own (apps/api security-headers.ts); these are the document's, and the
 * document is where they matter — it is the thing a browser executes.
 *
 * The CSP is honest about what Next and Chakra actually need rather than aspirational:
 *
 * - `script-src` carries `'unsafe-inline'` because the App Router inlines the flight payload
 *   and the bootstrap script into the HTML, and no `next.config` option makes it stop. Doing
 *   better needs a per-request nonce, which needs the proxy to mint one and every inline
 *   `<script>`/`<style>` to carry it — a real change with a real regression surface, recorded
 *   as an open item rather than half-done here. What is left still forbids loading a script
 *   from anywhere but this origin, which is the injection this policy can actually stop.
 * - `'unsafe-eval'` in development ONLY: React Refresh evaluates the modules it hot-swaps.
 *   Shipping it to production would give an injected string a way to become code.
 * - `style-src 'unsafe-inline'` is Emotion: Chakra's runtime inserts rules into a `<style>` tag
 *   it creates (ADR-0009's registry), so a policy without it renders an unstyled page.
 * - `img-src https:` because a market's image is a URL an admin types (PLAN 17 Q5), and `data:`
 *   for the inline placeholders the card uses.
 * - `connect-src` has to name the API origin explicitly, both schemes: since M4 the browser
 *   dials `NEXT_PUBLIC_API_URL` directly for the Socket.IO handshake (ADR-0017) and upgrades it
 *   to a WebSocket, and neither is 'self'.
 * - `frame-ancestors 'none'` replaces `X-Frame-Options` (which is set as well, for browsers
 *   that predate it); `object-src 'none'`, `base-uri 'self'` and `form-action 'self'` close the
 *   three redirects an injected tag would otherwise still have.
 */
const wsUrl = apiUrl.replace(/^http/, 'ws');
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProduction ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  `connect-src 'self' ${apiUrl} ${wsUrl}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Nothing in this app asks for a camera, a microphone or a location, so nothing embedded in
  // it should be able to either.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  // Ignored by browsers over plain HTTP (RFC 6797 §7.2), so development is unaffected and a
  // TLS deployment needs no second configuration path.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  // Next advertises itself in a response header by default; a version number is a shopping list.
  poweredByHeader: false,
  // Trace from the monorepo root so workspace packages are copied into .next/standalone.
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  typedRoutes: true,
  // Do not write AGENTS.md / CLAUDE.md into apps/web on `next dev`.
  agentRules: false,
  experimental: {
    optimizePackageImports: ['@chakra-ui/react'],
  },
  // reactCompiler needs babel-plugin-react-compiler (Babel); intentionally not enabled.
  headers() {
    // Everything EXCEPT the proxied API: those responses already carry the API's own headers
    // (apps/api security-headers.ts), and a second Content-Security-Policy on one response is
    // enforced as the intersection of the two — a rule assembled by accident out of two files.
    return Promise.resolve([{ source: '/((?!api/).*)', headers: securityHeaders }]);
  },
  rewrites() {
    // Same-origin /api/* for the browser; the API server handles /api/auth/* and /api/v1/*.
    // The proxying is server-side, so anyone who can reach this server reaches the API through
    // it: that is why the `dev` script passes `--hostname localhost` (README, ADR-0015).
    return Promise.resolve([{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }]);
  },
};

export default nextConfig;
