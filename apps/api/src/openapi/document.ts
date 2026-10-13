import { type INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { errorEnvelopeSchema } from '@buddha/shared';

/** Session cookie over plain HTTP: better-auth `advanced.cookiePrefix` 'buddha' + `session_token`. */
export const SESSION_COOKIE = 'buddha.session_token';

/**
 * The same cookie over HTTPS. better-auth prepends `__Secure-` whenever
 * `advanced.useSecureCookies` is unset and `baseURL` is https (cookies/index.mjs), which is
 * every real deployment since auth.ts leaves that option alone. The document is exported with
 * the dev `BETTER_AUTH_URL`, so the scheme carries the plain name and the description carries
 * this one: deriving it would make the committed artifact depend on the exporting machine.
 */
const SECURE_SESSION_COOKIE = `__Secure-${SESSION_COOKIE}`;

/**
 * `components.securitySchemes` key for the session cookie. `@ApiCookieAuth()` takes this
 * KEY, not the cookie name — the cookie name travels inside the scheme's own `name` field
 * (`addCookieAuth`'s first argument), and a requirement naming an undeclared scheme makes
 * the document invalid.
 */
export const SESSION_SECURITY_SCHEME = 'session';

/**
 * Builds the OpenAPI 3.0 document for the running app. Request/response shapes come from
 * the zod schemas attached with `@Body({ schema })`, `@Query({ schema })` and the
 * `@ApiData` / `@ApiPageOf` / `@ApiErrors` decorators (Standard JSON Schema conversion is
 * built into @nestjs/swagger 12), plus the one response every operation shares, declared
 * here (`addGlobalResponse`). Consumed by `openapi:export` and, later, Swagger UI.
 */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('buddha API')
    .setDescription(
      'REST API. Success: `{ data, meta? }`. Failure: `{ error: { code, message, details? } }`. ' +
        'P amounts are decimal strings (bigint). Timestamps are ISO 8601 UTC.',
    )
    .setVersion('1')
    .addCookieAuth(
      SESSION_COOKIE,
      {
        type: 'apiKey',
        in: 'cookie',
        description:
          `better-auth session cookie: \`${SESSION_COOKIE}\` when the API is served over HTTP, ` +
          `\`${SECURE_SESSION_COOKIE}\` when BETTER_AUTH_URL is HTTPS. Browsers send it ` +
          'automatically with `credentials: "include"`.',
      },
      SESSION_SECURITY_SCHEME,
    )
    /**
     * 429 on EVERY operation, not only the three with a named `@RateLimit` bucket (register,
     * charge, redeemCoupon): the address bucket is a Fastify hook
     * ahead of parsing that counts every request (address-limit.ts, PLAN 7.5's default row),
     * so `GET /markets` can be refused exactly as `POST /payments/charge` can. The first
     * document listed 429 only where a handler wrote `@ApiErrors('RATE_LIMITED')`, and a
     * generated client had no such response for 37 of 42 operations (PR #8 review). The
     * explicit entries stay — on those three, where `RATE_LIMITED` reads next to the `@RateLimit`
     * that makes it likely, and on `updateMyContact` — and a method-level response of the same
     * status replaces this one byte for byte (`ApiErrors` emits the same shape), so the document
     * is unchanged there. `/api/health` is `@ApiExcludeController()` and exempt in the hook's
     * route list, so it is neither documented nor limited.
     */
    .addGlobalResponse({
      status: 429,
      description: 'RATE_LIMITED',
      standardSchema: errorEnvelopeSchema,
    })
    .build();
  return SwaggerModule.createDocument(app, config, {
    // getMe / updateMe instead of MeController_getMe_v1: method names are unique per app.
    operationIdFactory: (_controllerKey, methodKey) => methodKey,
  });
}
