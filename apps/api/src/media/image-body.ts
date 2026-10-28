import { Transform, type TransformCallback, finished } from 'node:stream';
import { HttpStatus } from '@nestjs/common';
import { IMAGE_CONTENT_TYPES, IMAGE_MAX_BYTES } from '@buddha/shared';
import { errorCodes, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { type SessionData } from '../auth/auth.js';
import { type AuthenticatedRequest, isTrustedOrigin } from '../auth/session.guard.js';
import { AppError } from '../common/errors/app-error.js';
import { ByteBudget } from './byte-budget.js';
import { IMAGE_BUSY_RETRY_SECONDS } from './image.js';
import { InFlightPerKey } from './in-flight.js';
import { type Release, memoryAdmission, memoryWaits } from './memory-admission.js';

/**
 * The Content-Types an upload route takes its file under: the four image types and the generic
 * `application/octet-stream`. The declared type decides nothing — the bytes are checked by their
 * magic number (image.ts) — it only lets the body through to the handler as bytes.
 */
export const IMAGE_UPLOAD_CONTENT_TYPES: readonly string[] = [
  ...IMAGE_CONTENT_TYPES,
  'application/octet-stream',
];

/**
 * The routes that take a body of those types, by the route pattern Fastify matched: a post's image
 * (#46) and the profile image (#141, ADR-0079). Both are uploads of an account that finished the
 * onboarding, so the gate below asks the same of each; a new upload route joins this list and
 * nothing else of the gate.
 */
export const IMAGE_UPLOAD_ROUTES: readonly { readonly method: string; readonly url: string }[] = [
  { method: 'POST', url: '/api/v1/media/images' },
  { method: 'PUT', url: '/api/v1/me/profile-image' },
];

/**
 * How large a body the parser reads: twice the upload limit, so a file a little over 5MB reaches
 * the handler and is refused with the reason (IMAGE_NOT_ALLOWED `size`) the web can show, while
 * anything absurd is refused by its Content-Length before a byte is read (413, VALIDATION_ERROR —
 * by the gate below, as Fastify itself would at the parser), and a body that declares no length
 * (chunked) is cut by the parser once it passes this (413 as well, mid-body).
 */
export const IMAGE_BODY_LIMIT = IMAGE_MAX_BYTES * 2;

/**
 * The bytes of upload bodies the API receives at once, process-wide: 64MiB (owner decision
 * 2026-10-21, ADR-0073). The gate below lets a body in only for an account that may upload, but
 * one such account could still send many uploads at once, each held up to IMAGE_BODY_LIMIT while
 * it arrives — past the API container's 448MiB (deploy/compose.yaml) beside a conversion's
 * IMAGE_CONVERSION_PEAK_BYTES (144MiB, image.ts) and the reads' 32MiB (image-reads.ts). So an
 * upload takes its declared length (`Content-Length`), or the parser's limit when it declares
 * none, out of this budget before a byte of its body is read, and gives it back once the body is
 * in or the request has ended without it. 64MiB is six bodies at the parser's limit, or a dozen
 * photos near 5MB. The same length is then asked of the API's memory (`memoryAdmission`, owner
 * decision 2026-10-22 answer 3): the body is read only once the process's RSS, the shares out and
 * the room the reads may still take leave room for it under the ceiling (ADR-0073 9-46).
 *
 * The share is taken before a byte of the body has come, so it is a reservation that costs its
 * sender nothing to hold. Three bounds keep one account from holding the budget with bodies that do
 * not come: a body that sends no byte for IMAGE_UPLOAD_IDLE_SECONDS is cut and gives its share back
 * (`BodyCut`), and an account has at most IMAGE_UPLOADS_PER_ACCOUNT uploads in flight — three
 * bodies at the parser's limit are 30MiB, under half the budget (owner decision 2026-10-21 answer
 * 4); and a body not all in within IMAGE_UPLOAD_DEADLINE_SECONDS of its start is cut the same way,
 * however it trickles (owner decision 2026-10-22 (2차) answer 1). The reservation itself is counted
 * as it is, by the declared length, here and by the memory admission (the same answer).
 */
export const IMAGE_UPLOAD_RECEIVING_BYTES = 64 * 1024 * 1024;

/** The API's uploads being received (`installImageBodyParser`): one budget for the process. */
export const imageUploadsReceiving = new ByteBudget(IMAGE_UPLOAD_RECEIVING_BYTES);

/**
 * How long an upload's body may send nothing before it is cut: 30 seconds (owner decision
 * 2026-10-21 answer 4). An idle time, not the deadline below: a body that stops — or never starts —
 * is cut, and its share of the budget comes back at once. Neither the API (Fastify 5's
 * `requestTimeout` and `connectionTimeout` are 0; main.ts sets neither) nor Caddy (no `read_body`)
 * would cut it.
 */
export const IMAGE_UPLOAD_IDLE_SECONDS = 30;

/**
 * How long an upload's whole body may take: 2 minutes from when it starts to be read (owner decision
 * 2026-10-22 (2차) answer 1). The idle time alone let a body that sends a byte every 29 seconds hold
 * its reservation — the declared length, up to the parser's 10MiB — for as long as it liked; past
 * this, such a body is cut as an idle one is (408, its share back at once). Two minutes is the
 * largest photo the API takes (IMAGE_MAX_BYTES, 5MB — 5,242,880 bytes) at about 350kbit/s of
 * payload, a little more once TCP/IP's own bytes are counted — a link slower than that is cut on a
 * photo that size: a slow phone's upload, but not a trickle.
 */
export const IMAGE_UPLOAD_DEADLINE_SECONDS = 120;

/**
 * The idle time the gate gives each upload it lets in, read when the upload's body starts: the
 * owner's 30 seconds. A setting rather than the constant only so the integration test can watch a
 * cut without waiting half a minute; nothing else changes it.
 */
export const imageUploadIdle = { ms: IMAGE_UPLOAD_IDLE_SECONDS * 1000 };

/**
 * The deadline the gate gives each upload's whole body, read when the body starts: the owner's 2
 * minutes. A setting for the integration test's sake, as `imageUploadIdle` is.
 */
export const imageUploadDeadline = { ms: IMAGE_UPLOAD_DEADLINE_SECONDS * 1000 };

/**
 * How many uploads an account may have in flight at once, process-wide: 3 (owner decision
 * 2026-10-21 answer 4). In flight from when the gate lets it in until its answer has ended — or its
 * client has gone — and the handler's work on it has settled (`runUploadWork`): through the body,
 * the conversion queue and the store, a client that hangs up once its whole body is in included
 * (nothing stops that work), so one account holds neither the budget above nor the conversion queue
 * (image.ts: one at a time and eight waiting) alone. The web's editor sends one upload at a time,
 * whatever batches it has going (`createUploadQueue`), so a writer's page holds one of the three;
 * other tabs of the same account hold their own. The fourth is refused unread: RATE_LIMITED with
 * `Retry-After`.
 */
export const IMAGE_UPLOADS_PER_ACCOUNT = 3;

/** Each account's uploads in flight (`installImageBodyParser`), by account id. */
export const imageUploadsInFlight = new InFlightPerKey(IMAGE_UPLOADS_PER_ACCOUNT);

/** Each upload's share of `imageUploadsReceiving`, given back by the parser once its body is in. */
const receiving = new WeakMap<FastifyRequest, () => void>();

/** An upload's place among its account's uploads in flight (`letUploadIn`, `runUploadWork`). */
interface UploadPlace {
  /** The answer has ended, or the client has gone: no work starts for the upload any more. */
  ended: boolean;
  /** The handler's work on the upload once it has started, settled however it ends. */
  work: Promise<void> | undefined;
}

/** Each upload's place, by request. */
const places = new WeakMap<FastifyRequest, UploadPlace>();

/** The length an upload declares, or undefined when it declares none (a chunked body). */
function declaredLength(request: FastifyRequest): number | undefined {
  const header = request.headers['content-length'];
  // Node's HTTP parser has refused a malformed or a doubled one already.
  if (header === undefined || !/^\d+$/.test(header)) return undefined;
  return Number(header);
}

/** An upload refused for the moment: RATE_LIMITED with `Retry-After`, sent again later. */
function uploadBusy(reply: FastifyReply, message: string): AppError {
  void reply.header('retry-after', String(IMAGE_BUSY_RETRY_SECONDS));
  return new AppError('RATE_LIMITED', {
    message,
    details: { retryAfterSeconds: IMAGE_BUSY_RETRY_SECONDS },
  });
}

/**
 * Lets in the upload of `accountId`, a sender who may upload, before its body is read: refused
 * unread with a declared length over the parser's limit (413, VALIDATION_ERROR — Fastify's own
 * answer from its Content-Length, which it would give at the parser), with three of the account's
 * uploads in flight already, or past the budget. Both of those are RATE_LIMITED with `Retry-After`,
 * the upload routes' answer for a full conversion queue (image.ts) — a client may send it again
 * then; the web's editor waits out the wait it names and sends the file again, twice at most,
 * still uploading, and only when the third send is refused too says that file failed and goes on
 * with its batch (owner decisions 2026-10-21, 2026-10-22 (2차) answer 3). A body that declares no
 * length takes the parser's limit, the most it can hold (owner decision 2026-10-21 answer 5), and
 * the parser still cuts it there. Then the same length
 * is asked of the API's memory, holding the place and the share meanwhile: the body waits, unread,
 * up to `memoryWaits.uploadMs` for the RSS, the shares out and the reads' room to leave room for
 * it under the ceiling, and is RATE_LIMITED unread when they did not (owner decision 2026-10-22
 * answer 3) — or simply let go if its client went meanwhile.
 * 429 leaves the connection open: what is still coming of the body is let through unheld (Node's
 * HTTP server), and a browser still sending reads the answer rather than a reset. The shares come
 * back when the parser has the whole body, when the body is cut for idling or for its deadline
 * (`BodyCut`), or when the answer ends without it — refused after this, cut off, or the client gone
 * mid-body or while waiting. The account's place comes back when the answer has ended and the handler's work on the
 * upload, if it started, has settled (`runUploadWork`).
 */
async function letUploadIn(
  request: FastifyRequest,
  reply: FastifyReply,
  accountId: string,
): Promise<void> {
  const length = declaredLength(request) ?? IMAGE_BODY_LIMIT;
  if (length > IMAGE_BODY_LIMIT) {
    // As Fastify answers it: the client would send the rest anyway.
    void reply.header('connection', 'close');
    throw new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE();
  }
  const leave = imageUploadsInFlight.take(accountId);
  if (leave === null) {
    throw uploadBusy(reply, 'Too many uploads of this account are in flight; send it again');
  }
  const giveShare = imageUploadsReceiving.take(length);
  if (giveShare === null) {
    leave();
    throw uploadBusy(reply, 'Too many uploads are being received; send it again');
  }
  let giveMemory: Release | undefined;
  const release = () => {
    giveShare();
    giveMemory?.();
  };
  receiving.set(request, release);
  const place: UploadPlace = { ended: false, work: undefined };
  places.set(request, place);
  const gone = new AbortController();
  finished(reply.raw, () => {
    gone.abort();
    release();
    place.ended = true;
    // A client that hangs up once its whole body is in leaves the handler working on it: the place
    // is the account's again only once that work has settled.
    if (place.work === undefined) leave();
    else void place.work.then(leave);
  });
  // After the account's place and the share of the budget (ADR-0073 9-46): that budget bounds the
  // bodies waiting here, and refusing past it costs no wait.
  const memory = await memoryAdmission.admit(length, {
    kind: 'body',
    waitMs: memoryWaits.uploadMs,
    signal: gone.signal,
  });
  if (memory === null) {
    throw uploadBusy(reply, 'The server is short of memory for uploads; send it again');
  }
  // The client went while it waited (the abort and the room came in one turn): nothing to hold.
  if (gone.signal.aborted) memory();
  else giveMemory = memory;
}

/**
 * Runs the handler's work on an upload the gate let in (`work`: the conversion, the store and the
 * row — MediaService.uploadPostImage) as part of that upload: the account's place comes back only
 * once the work has settled, as well as the answer ended. Nothing stops the work when its client
 * hangs up (the answer ends at once then), so a place given back at the hang-up would let one
 * account keep any number of its uploads in the conversion queue — three at a time, hanging up
 * each once its body is in.
 *
 * Starts nothing, and returns undefined, when the client has gone already — after its body was in,
 * while the guards ran: its id would reach no one, so storing it would only leave an orphan, and
 * its place is back already. The check and the start are one step, so a client that goes after it
 * finds the work started and its place held until the work settles.
 */
export function runUploadWork<T>(
  request: FastifyRequest,
  work: () => Promise<T>,
): Promise<T> | undefined {
  const place = places.get(request);
  if (place?.ended === true) return undefined;
  const running = work();
  if (place !== undefined) {
    place.work = running.then(
      () => undefined,
      () => undefined,
    );
  }
  return running;
}

/**
 * The handler's part of an upload — `POST /media/images` (MediaController) and
 * `PUT /me/profile-image` (ProfileImageController, #141) alike: the body is the file itself (the
 * image parser's Buffer — the gate refused every other type unread, so anything else is a 400),
 * `work` converts and stores it as part of the upload the gate let in (`runUploadWork`), and a
 * RATE_LIMITED from the conversion's turn — too many conversions waiting, or no room in the API's
 * memory for one in time (image.ts) — carries the `Retry-After` every other 429 of the API carries,
 * the same seconds as its `details.retryAfterSeconds`. Undefined when the client has gone already:
 * there is no one to answer.
 */
export async function handleUpload<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  body: unknown,
  work: (bytes: Uint8Array) => Promise<T>,
): Promise<T | undefined> {
  if (!(body instanceof Buffer)) {
    throw new AppError('VALIDATION_ERROR', {
      message: 'The body must be the image file itself',
      details: [{ path: [], message: `send the file as ${IMAGE_UPLOAD_CONTENT_TYPES.join(', ')}` }],
    });
  }
  const running = runUploadWork(request, () => work(new Uint8Array(body)));
  if (running === undefined) return undefined;
  try {
    return await running;
  } catch (error) {
    if (error instanceof AppError && error.code === 'RATE_LIMITED') {
      void reply.header('retry-after', String(IMAGE_BUSY_RETRY_SECONDS));
    }
    throw error;
  }
}

/** Why an upload's body was cut (`BodyCut`). */
export type BodyCutReason = 'idle' | 'deadline';

/** The two bounds on an upload's body (`BodyCut`), in milliseconds from when it starts. */
export interface BodyCutLimits {
  /** No byte for this long: cut (IMAGE_UPLOAD_IDLE_SECONDS). */
  readonly idleMs: number;
  /**
   * Not all in this long after it started: cut, however it trickles
   * (IMAGE_UPLOAD_DEADLINE_SECONDS).
   */
  readonly deadlineMs: number;
}

/**
 * An upload's body as the parser reads it (the `preParsing` hook below hands it over in place of
 * the request): every byte passed on as it came, and the stream failed — the parser then answers
 * with the error — once no byte has come for `idleMs`, or once `deadlineMs` has gone by without the
 * whole body, both from when the body starts to be read. `onCut` is told which, once, and fails the
 * stream. Its `receivedEncodedLength` is what Fastify counts against the parser's limit, as it would
 * count the request's own bytes. Exported for its unit test (fake timers, image-body.test.ts).
 */
export class BodyCut extends Transform {
  receivedEncodedLength = 0;
  private readonly idle: NodeJS.Timeout;
  private readonly deadline: NodeJS.Timeout;
  private stopped = false;

  constructor(limits: BodyCutLimits, onCut: (body: BodyCut, reason: BodyCutReason) => void) {
    super();
    const cut = (reason: BodyCutReason) => {
      if (this.stopped) return;
      this.stop();
      onCut(this, reason);
    };
    this.idle = setTimeout(() => {
      cut('idle');
    }, limits.idleMs);
    this.deadline = setTimeout(() => {
      cut('deadline');
    }, limits.deadlineMs);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.receivedEncodedLength += chunk.length;
    // A byte came: the idle time starts again. The deadline does not.
    if (!this.stopped) this.idle.refresh();
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    this.stop();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.stop();
    callback(error);
  }

  /** No cut any more: the body is in, the request has ended, or it was cut. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.idle);
    clearTimeout(this.deadline);
  }
}

/** The 408 an upload's body is cut with (`watchUploadBody`), saying which bound it passed. */
function bodyCutError(reason: BodyCutReason, limits: BodyCutLimits): AppError {
  const message =
    reason === 'idle'
      ? `No byte of the file came for ${String(limits.idleMs / 1000)} seconds; send it again`
      : `The whole file did not come within ${String(limits.deadlineMs / 1000)} seconds; send it again`;
  return new AppError('VALIDATION_ERROR', { status: HttpStatus.REQUEST_TIMEOUT, message });
}

/**
 * Watches the body of an upload the gate let in (`BodyCut`): once it sends no byte for the idle
 * time (owner decision 2026-10-21 answer 4), or is not all in by its deadline (owner decision
 * 2026-10-22 (2차) answer 1), it is cut — its share back at once, answered 408 VALIDATION_ERROR (the
 * code ApiExceptionFilter gives any other 4xx it has no code for, `codeForStatus`, as for the 413)
 * and its connection closed, so nothing more of it is waited for. The two cuts differ only in their
 * `message`. The request's own stream is piped, not wrapped in a pipeline: a pipeline would destroy
 * it with the cut, and with it the socket the answer goes out on.
 */
function watchUploadBody(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: NodeJS.ReadableStream,
): BodyCut {
  const limits: BodyCutLimits = { idleMs: imageUploadIdle.ms, deadlineMs: imageUploadDeadline.ms };
  const body = new BodyCut(limits, (cut, reason) => {
    receiving.get(request)?.();
    void reply.header('connection', 'close');
    cut.destroy(bodyCutError(reason, limits));
  });
  // The request failing (a client gone mid-body) fails the body, as it would fail the parser.
  const fail = (error: Error) => body.destroy(error);
  payload.on('error', fail);
  // The parser listens while it reads; an error after that (the client gone while the handler
  // works) has no one left to tell, and must not be thrown as an unheard 'error' event.
  body.on('error', () => undefined);
  // Answered (or the client gone): no cut to come, nothing more to pass on.
  finished(reply.raw, () => {
    body.stop();
    payload.removeListener('error', fail);
  });
  payload.pipe(body);
  return body;
}

/** The media type of a request's body (`image/png; x=y` → `image/png`), or undefined. */
function mediaTypeOf(request: FastifyRequest): string | undefined {
  const header = request.headers['content-type'];
  if (header === undefined) return undefined;
  return header.split(';', 1)[0]?.trim().toLowerCase();
}

/** Whether `request` is to one of IMAGE_UPLOAD_ROUTES (the route pattern Fastify matched). */
function isUploadRoute(request: FastifyRequest): boolean {
  return IMAGE_UPLOAD_ROUTES.some(
    (route) => request.method === route.method && request.routeOptions.url === route.url,
  );
}

/**
 * What the gate below makes of `request` before its body is read: `pass` for a request that is not
 * an upload's and carries no body of this parser's types (another type, or a GET or HEAD), a
 * refusal, or `upload` — a request to an upload route (IMAGE_UPLOAD_ROUTES) from one of our pages,
 * whatever its type, whose sender is checked next (`installImageBodyParser`).
 *
 * The route comes before the type: every request to an upload route goes through the gate, so a body
 * of another type — JSON or text, which Fastify's own parsers would read, or one no parser reads —
 * is not read before its sender is known either (Codex review of #219, round 2: the first gate
 * looked at the type first and let those through to the parsers, outside the budget and the
 * account's three).
 */
function imageBodyStep(
  request: FastifyRequest,
  trustedOrigins: ReadonlySet<string>,
): 'pass' | 'upload' | Error {
  if (!isUploadRoute(request)) {
    // A GET or a HEAD has its body ignored, never parsed: nothing to keep from it.
    if (request.method === 'GET' || request.method === 'HEAD') return 'pass';
    const type = mediaTypeOf(request);
    if (type === undefined || !IMAGE_UPLOAD_CONTENT_TYPES.includes(type)) return 'pass';
    return new errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE();
  }
  // SessionGuard's order: the Origin first, which costs no lookup.
  if (!isTrustedOrigin(request, trustedOrigins)) {
    return new AppError('FORBIDDEN', { message: 'Cross-origin request refused' });
  }
  return 'upload';
}

/**
 * Refuses, unread, an upload whose body is not of a type the route takes (another type or none):
 * 415 VALIDATION_ERROR, after its sender has been let through, before it takes anything of the
 * account's three or the budget. Only the image parser reads a body on an upload route — the
 * handler would refuse anything else it was handed (`The body must be the image file itself`), so
 * reading one first would only hold it.
 */
function assertUploadType(request: FastifyRequest): void {
  const type = mediaTypeOf(request);
  if (type !== undefined && IMAGE_UPLOAD_CONTENT_TYPES.includes(type)) return;
  throw new AppError('VALIDATION_ERROR', {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    message: 'The body must be the image file itself',
    details: [{ path: [], message: `send the file as ${IMAGE_UPLOAD_CONTENT_TYPES.join(', ')}` }],
  });
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
 * keeps the parser to the upload routes and to the accounts that may upload, so no one else can
 * make the API hold up to 10MiB per request:
 *
 * - a body of these types on any other route is refused unread, 415 — what it was before this
 *   parser existed (no other route takes one);
 * - every request to an upload route (IMAGE_UPLOAD_ROUTES: a post's image and the profile image),
 *   whatever its Content-Type (one of the route's, JSON or text that Fastify's own parsers read,
 *   another or none), goes through the rest before any parser reads its body: a request from a foreign page is refused unread (403, SessionGuard's Origin
 *   check, `isTrustedOrigin`); then the cookie's session is resolved through better-auth, as
 *   SessionGuard resolves it — a cookie that names no session (none, made up, expired, signed out)
 *   is refused unread (401) — and the account must have finished the onboarding
 *   (ONBOARDING_REQUIRED unread, OnboardedGuard's answer). The session is left on the request, so
 *   SessionGuard does not read it again; SessionGuard and OnboardedGuard still run after the body;
 * - a body of a type the route does not take is then refused unread (415, `assertUploadType`);
 * - and then the body is let in (`letUploadIn`) only as one of the account's three uploads in
 *   flight — a post's image and the profile image (#141) counted together — and within the bytes
 *   the API receives at once (owner decisions 2026-10-21), and once
 *   the API's memory has room for it (owner decision 2026-10-22 answer 3 — it waits up to
 *   `memoryWaits.uploadMs` for that): one declared over the limit is refused unread, and one past
 *   any of those bounds is RATE_LIMITED unread. Its body is cut once it sends no byte for 30
 *   seconds, or is not all in 2 minutes after it started (`watchUploadBody`, a `preParsing` hook —
 *   the parser reads the stream it returns). The
 *   handler runs its work on the upload through `runUploadWork`, so the account's place is held
 *   until that work has settled.
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
    assertUploadType(request);
    await letUploadIn(request, reply, session.user.id);
  });
  fastify.addHook('preParsing', async (request, reply, payload) =>
    receiving.has(request) ? watchUploadBody(request, reply, payload) : payload,
  );
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
