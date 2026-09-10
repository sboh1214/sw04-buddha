import helmet, { type FastifyHelmetOptions } from '@fastify/helmet';
import { type NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * PLAN M6 "보안: 헤더(helmet 상당)" for the API.
 *
 * This server answers JSON and nothing else — no HTML, no scripts, no images — so most of
 * helmet's defaults are aimed at a document that does not exist here. What is left is worth
 * having anyway, and the two that are actively wrong are turned off rather than left to a
 * default that would break a working path.
 *
 * Everything below is per-response and cheap; there is no allow-list to keep in sync with a
 * deployment, which is why this is a constant rather than a factory over `Env`.
 */
export const helmetOptions: FastifyHelmetOptions = {
  /**
   * A policy for a resource that can never load a subresource: refuse everything, and refuse to
   * be framed. `useDefaults: false` because helmet's default policy is a page's — `script-src`,
   * `style-src`, `img-src`, `upgrade-insecure-requests` — and a JSON body has no use for any of
   * it. `frame-ancestors` is the one directive that does real work here: it is the header form
   * of `X-Frame-Options` and it is honoured on any response, so an error body cannot be framed
   * and read by a page that guesses at its shape.
   */
  contentSecurityPolicy: {
    useDefaults: false,
    directives: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] },
  },
  /**
   * `same-site`, not helmet's `same-origin`. ADR-0017 puts the web and the API on sibling hosts
   * of one site on purpose — the browser dials the API origin directly for the Socket.IO
   * handshake, and the Expo app dials it for everything — so `same-origin` would be a rule this
   * architecture is designed to violate. Same-site keeps an unrelated origin from pulling a
   * response into itself while leaving our own hosts alone.
   */
  crossOriginResourcePolicy: { policy: 'same-site' },
  /**
   * OFF. `Cross-Origin-Embedder-Policy: require-corp` constrains what a DOCUMENT may embed, and
   * this server serves no document; what it would do is make every response of ours unusable to
   * a page that has not opted into the same policy, for no benefit here.
   */
  crossOriginEmbedderPolicy: false,
  /**
   * Sent on every response, including over plain HTTP in development, and that is deliberate:
   * a browser IGNORES this header unless the response came over HTTPS (RFC 6797 §7.2), so the
   * dev stack is unaffected and a TLS deployment is protected without a second configuration
   * path that only production exercises. Two years, subdomains included; no `preload`, which is
   * a submission to a browser vendor's list and not a decision a header should make silently.
   */
  hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: false },
  /**
   * `DENY`, not helmet's `SAMEORIGIN`. It is the legacy twin of the CSP above, and leaving the
   * two disagreeing — `frame-ancestors 'none'` beside `X-Frame-Options: SAMEORIGIN` — means a
   * browser that reads only one of them gets a different answer from the one that reads both.
   */
  frameguard: { action: 'deny' },
  /**
   * `no-referrer`: this API is never a document, so the only way its URL becomes a `Referer` is
   * if something goes wrong, and the URLs here carry ids and search terms.
   */
  referrerPolicy: { policy: 'no-referrer' },
};

/**
 * Registers the headers on the Fastify instance behind a Nest app.
 *
 * Called from BOTH main.ts and test/app.ts, and it exists so those two cannot drift: a header
 * that only production sends is a header no test can prove, and the realtime adapter beside it
 * has already had to learn that lesson (`useWebSocketAdapter` carries the same warning). Must
 * run before `init()`/`listen()` — a Fastify plugin cannot be added to a started instance.
 *
 * The Socket.IO handshake is deliberately untouched by it: engine.io attaches to the raw HTTP
 * server on its own path and never enters Fastify's request lifecycle, so no hook here can add
 * or remove a header on it.
 */
export async function registerSecurityHeaders(app: NestFastifyApplication): Promise<void> {
  await app.register(helmet, helmetOptions);
}
