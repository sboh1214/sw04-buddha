import { finished } from 'node:stream';
import { HttpStatus } from '@nestjs/common';
import { IMAGE_CONTENT_TYPES, IMAGE_MAX_BYTES } from '@buddha/shared';
import { errorCodes, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { type SessionData } from '../auth/auth.js';
import { type AuthenticatedRequest, isTrustedOrigin } from '../auth/session.guard.js';
import { AppError } from '../common/errors/app-error.js';
import { ByteBudget } from './byte-budget.js';
import { IMAGE_BUSY_RETRY_SECONDS } from './image.js';

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
 * anything absurd is refused by its Content-Length before a byte is read (413, VALIDATION_ERROR —
 * by the gate below, as Fastify itself would at the parser; a body without one is not let in).
 */
export const IMAGE_BODY_LIMIT = IMAGE_MAX_BYTES * 2;

/**
 * The bytes of upload bodies the API receives at once, process-wide: 64MiB (owner decision
 * 2026-10-21, ADR-0073). The gate below lets a body in only for an account that may upload, but
 * one such account could still send many uploads at once, each held up to IMAGE_BODY_LIMIT while
 * it arrives — past the API container's 448MiB (deploy/compose.yaml) beside a conversion's
 * 128MiB (image.ts) and the reads' 32MiB (image-reads.ts). So an upload takes its declared length
 * (`Content-Length`) out of this budget before a byte of its body is read, and gives it back once
 * the body is in or the request has ended without it. 64MiB is six bodies at the parser's limit,
 * or a dozen photos near 5MB.
 *
 * The share is the declared length, held from before a byte of the body has come, and nothing
 * times it out: neither the API (Fastify 5's `requestTimeout`/`connectionTimeout` are 0, main.ts
 * sets neither) nor Caddy (no `read_body`) cuts a body that stops arriving. So holding a share
 * costs its sender no body byte — an onboarded account's seven uploads that send nothing hold the
 * whole budget, every other upload 429, for as long as their connections stay open. Before the
 * budget, such requests held nothing. Whether to give a body being received a deadline is the
 * owner's question (ADR-0073 결과 4); `media.controller.test.ts` pins today's behaviour.
 */
export const IMAGE_UPLOAD_RECEIVING_BYTES = 64 * 1024 * 1024;

/** The API's uploads being received (`installImageBodyParser`): one budget for the process. */
export const imageUploadsReceiving = new ByteBudget(IMAGE_UPLOAD_RECEIVING_BYTES);

/** Each upload's share of `imageUploadsReceiving`, given back by the parser once its body is in. */
const receiving = new WeakMap<FastifyRequest, () => void>();

/** The length an upload declares, or undefined when it declares none (a chunked body). */
function declaredLength(request: FastifyRequest): number | undefined {
  const header = request.headers['content-length'];
  // Node's HTTP parser has refused a malformed or a doubled one already.
  if (header === undefined || !/^\d+$/.test(header)) return undefined;
  return Number(header);
}

/**
 * Takes the share of an upload whose sender may upload, before its body is read: refused unread
 * with no declared length (411, VALIDATION_ERROR — what it would hold is not known before it has
 * come), with one over the parser's limit (413, VALIDATION_ERROR — Fastify's own answer from its
 * Content-Length, which it would give at the parser), or past the budget: RATE_LIMITED with
 * `Retry-After`, the upload route's answer for a full conversion queue (image.ts) — a client may
 * send it again then; the web's editor says that file failed and goes on with its batch (owner
 * decision 2026-10-21). 411 and 429 leave the connection open: what is still coming of the body is
 * let through unheld (Node's HTTP server), and a browser still sending reads the answer rather
 * than a reset. The share comes back when the parser has the whole body, or when the answer ends
 * without it — refused after this, cut off, or the client gone mid-body.
 */
function receiveWithinBudget(request: FastifyRequest, reply: FastifyReply): void {
  const length = declaredLength(request);
  if (length === undefined) {
    throw new AppError('VALIDATION_ERROR', {
      status: HttpStatus.LENGTH_REQUIRED,
      message: 'Send the file with its Content-Length',
    });
  }
  if (length > IMAGE_BODY_LIMIT) {
    // As Fastify answers it: the client would send the rest anyway.
    void reply.header('connection', 'close');
    throw new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE();
  }
  const release = imageUploadsReceiving.take(length);
  if (release === null) {
    void reply.header('retry-after', String(IMAGE_BUSY_RETRY_SECONDS));
    throw new AppError('RATE_LIMITED', {
      message: 'Too many uploads are being received; send it again',
      details: { retryAfterSeconds: IMAGE_BUSY_RETRY_SECONDS },
    });
  }
  receiving.set(request, release);
  finished(reply.raw, release);
}

/** The media type of a request's body (`image/png; x=y` → `image/png`), or undefined. */
function mediaTypeOf(request: FastifyRequest): string | undefined {
  const header = request.headers['content-type'];
  if (header === undefined) return undefined;
  return header.split(';', 1)[0]?.trim().toLowerCase();
}

/**
 * What the gate below makes of `request` before its body is read: `pass` for a request whose body
 * is not this parser's (another type, or a GET or HEAD), a refusal, or `upload` — the upload route
 * from one of our pages, whose sender is checked next (`installImageBodyParser`).
 */
function imageBodyStep(
  request: FastifyRequest,
  trustedOrigins: ReadonlySet<string>,
): 'pass' | 'upload' | Error {
  const type = mediaTypeOf(request);
  if (type === undefined || !IMAGE_UPLOAD_CONTENT_TYPES.includes(type)) return 'pass';
  // A GET or a HEAD has its body ignored, never parsed: nothing to keep from it.
  if (request.method === 'GET' || request.method === 'HEAD') return 'pass';
  if (
    request.method !== IMAGE_UPLOAD_ROUTE.method ||
    request.routeOptions.url !== IMAGE_UPLOAD_ROUTE.url
  ) {
    return new errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE();
  }
  // SessionGuard's order: the Origin first, which costs no lookup.
  if (!isTrustedOrigin(request, trustedOrigins)) {
    return new AppError('FORBIDDEN', { message: 'Cross-origin request refused' });
  }
  return 'upload';
}

/** Who may send an upload's body, as the gate asks before reading it. */
export interface ImageBodySenders {
  /** The origins SessionGuard trusts. */
  readonly trustedOrigins: ReadonlySet<string>;
  /** The better-auth session of the request's cookie, or null — what SessionGuard reads. */
  sessionOf(request: FastifyRequest): Promise<SessionData | null>;
  /** Refuses (ONBOARDING_REQUIRED) an account with a step of the onboarding left. */
  assertOnboarded(userId: string): Promise<void>;
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
 * the parser, after the address limit's hook — address-limit.ts, installed before the app's init)
 * keeps the parser to the upload route and to the accounts that may upload, so no one else can make
 * the API hold up to 10MiB per request:
 *
 * - a body of these types on any other route is refused unread, 415 — what it was before this
 *   parser existed (no other route takes one);
 * - on the upload route, a request from a foreign page is refused unread (403, SessionGuard's
 *   Origin check, `isTrustedOrigin`); then the cookie's session is resolved through better-auth, as
 *   SessionGuard resolves it — a cookie that names no session (none, made up, expired, signed out)
 *   is refused unread (401) — and the account must have finished the onboarding
 *   (ONBOARDING_REQUIRED unread, OnboardedGuard's answer). The session is left on the request, so
 *   SessionGuard does not read it again; SessionGuard and OnboardedGuard still run after the body;
 * - and then the body is let in only within the bytes the API receives at once
 *   (`receiveWithinBudget`, owner decision 2026-10-21): an upload with no length or one over the
 *   limit is refused unread, and one past the budget is RATE_LIMITED unread.
 */
export function installImageBodyParser(fastify: FastifyInstance, senders: ImageBodySenders): void {
  fastify.addHook('onRequest', async (request, reply) => {
    const step = imageBodyStep(request, senders.trustedOrigins);
    if (step === 'pass') return;
    if (step instanceof Error) throw step;
    const authenticated = request as AuthenticatedRequest;
    const session = authenticated.auth ?? (await senders.sessionOf(request));
    if (!session) throw new AppError('UNAUTHENTICATED', { message: 'Sign in required' });
    authenticated.auth = session;
    await senders.assertOnboarded(session.user.id);
    receiveWithinBudget(request, reply);
  });
  fastify.addContentTypeParser(
    [...IMAGE_UPLOAD_CONTENT_TYPES],
    { parseAs: 'buffer', bodyLimit: IMAGE_BODY_LIMIT },
    (request, body, done) => {
      // The body is in: received, it is the handler's now (a body over 5MB is refused at once, and
      // the conversion queue bounds the rest — image.ts).
      receiving.get(request)?.();
      done(null, body);
    },
  );
}
