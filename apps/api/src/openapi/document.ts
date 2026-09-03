import { type INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/** Session cookie name: better-auth `advanced.cookiePrefix` 'buddha' + `session_token`. */
export const SESSION_COOKIE = 'buddha.session_token';

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
 * built into @nestjs/swagger 12). Consumed by `openapi:export` and, later, Swagger UI.
 */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('buddha API')
    .setDescription(
      'REST API. Success: `{ data, meta? }`. Failure: `{ error: { code, message, details? } }`. ' +
        'P amounts are decimal strings (bigint). Timestamps are ISO 8601 UTC.',
    )
    .setVersion('1')
    .addCookieAuth(SESSION_COOKIE, { type: 'apiKey', in: 'cookie' }, SESSION_SECURITY_SCHEME)
    .build();
  return SwaggerModule.createDocument(app, config, {
    // getMe / updateMe instead of MeController_getMe_v1: method names are unique per app.
    operationIdFactory: (_controllerKey, methodKey) => methodKey,
  });
}
