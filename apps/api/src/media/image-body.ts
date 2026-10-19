import { IMAGE_CONTENT_TYPES, IMAGE_MAX_BYTES } from '@buddha/shared';
import { errorCodes, type FastifyInstance, type FastifyRequest } from 'fastify';
import { isTrustedOrigin } from '../auth/session.guard.js';
import { AppError } from '../common/errors/app-error.js';
import { SESSION_COOKIE } from '../openapi/document.js';

/**
 * The Content-Types `POST /media/images` takes its file under: the four image types and the
 * generic `application/octet-stream`. The declared type decides nothing — the bytes are checked
 * by their magic number (image.ts) — it only lets the body through to the handler as bytes.
 */
export const IMAGE_UPLOAD_CONTENT_TYPES: readonly string[] = [
  ...IMAGE_CONTENT_TYPES,
  'application/octet-stream',
];

/** The one route that takes a body of those types: the route pattern Fastify matched. */
export const IMAGE_UPLOAD_ROUTE = { method: 'POST', url: '/api/v1/media/images' } as const;

/**
 * How large a body the parser reads: twice the upload limit, so a file a little over 5MB reaches
 * the handler and is refused with the reason (IMAGE_NOT_ALLOWED `size`) the web can show, while
 * anything absurd is cut off by Fastify itself (413, VALIDATION_ERROR) — from its Content-Length
 * before a byte is read, or as soon as a body without one goes past it.
 */
export const IMAGE_BODY_LIMIT = IMAGE_MAX_BYTES * 2;

/** The media type of a request's body (`image/png; x=y` → `image/png`), or undefined. */
function mediaTypeOf(request: FastifyRequest): string | undefined {
  const header = request.headers['content-type'];
  if (header === undefined) return undefined;
  return header.split(';', 1)[0]?.trim().toLowerCase();
}

/** Why the gate below refuses `request` before its body is read, or undefined to let it through. */
function imageBodyRefusal(
  request: FastifyRequest,
  trustedOrigins: ReadonlySet<string>,
): Error | undefined {
  const type = mediaTypeOf(request);
  if (type === undefined || !IMAGE_UPLOAD_CONTENT_TYPES.includes(type)) return undefined;
  // A GET or a HEAD has its body ignored, never parsed: nothing to keep from it.
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  if (
    request.method !== IMAGE_UPLOAD_ROUTE.method ||
    request.routeOptions.url !== IMAGE_UPLOAD_ROUTE.url
  ) {
    return new errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE();
  }
  if (!(request.headers.cookie ?? '').includes(`${SESSION_COOKIE}=`)) {
    return new AppError('UNAUTHENTICATED', { message: 'Sign in required' });
  }
  if (!isTrustedOrigin(request, trustedOrigins)) {
    return new AppError('FORBIDDEN', { message: 'Cross-origin request refused' });
  }
  return undefined;
}

/**
 * Lets an upload's raw bytes through as the request body (a Buffer). The API takes JSON everywhere
 * else (the main.ts note on `bodyParser: false`); an image is sent as the file itself — `fetch` with
 * the File as its body — rather than multipart, so no form parser and no field names come into it.
 * Registered on the app's Fastify instance before it starts (MediaModule.onModuleInit), so
 * main.ts and the test app get the same parser from the module graph.
 *
 * A content-type parser belongs to the whole instance, and Nest puts every route on that one
 * instance; Fastify reads the body before any Nest guard runs. So a gate (`onRequest`, ahead of
 * the parser) keeps the parser to the upload route and keeps an anonymous caller from making the
 * API hold 10MiB for nothing:
 *
 * - a body of these types on any other route is refused unread, 415 — what it was before this
 *   parser existed (no other route takes one);
 * - on the upload route, a request without a session cookie is refused unread (401), and one from
 *   a foreign page (403, SessionGuard's Origin check, `isTrustedOrigin`). A cookie is easy to make
 *   up, so this only stops the casual case; SessionGuard and OnboardedGuard still decide.
 */
export function installImageBodyParser(
  fastify: FastifyInstance,
  trustedOrigins: ReadonlySet<string>,
): void {
  fastify.addHook('onRequest', (request, _reply, done) => {
    done(imageBodyRefusal(request, trustedOrigins));
  });
  fastify.addContentTypeParser(
    [...IMAGE_UPLOAD_CONTENT_TYPES],
    { parseAs: 'buffer', bodyLimit: IMAGE_BODY_LIMIT },
    (_request, body, done) => {
      done(null, body);
    },
  );
}
