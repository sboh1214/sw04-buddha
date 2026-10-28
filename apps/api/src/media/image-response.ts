import { Readable, finished } from 'node:stream';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { AppError } from '../common/errors/app-error.js';
import { IMAGE_READ_BUSY_RETRY_SECONDS, imageReads, imageReadsBusy } from './image-reads.js';
import { type MediaService, type ShownImage } from './media.service.js';
import { memoryAdmission, memoryWaits } from './memory-admission.js';

/** An image file as the OpenAPI document describes it (an upload's body, or an answer). */
export const IMAGE_BINARY = { schema: { type: 'string', format: 'binary' } } as const;

/**
 * Who may keep a copy of an answered image: `public` for `GET /media/:mediaId` (what a post or a
 * pinned notice shows, the same for everyone), `private` for an admin's read of a notice's images
 * (`GET /admin/notices/:noticeId/images/:mediaId`, #138) and an operator's of any stored image
 * (`GET /admin/media/:mediaId`, #50), which a shared cache must not hand on. Both `no-cache`:
 * kept, but asked again on every use.
 */
export type ImageCacheScope = 'public' | 'private';

/**
 * Answers one image a route found it may show (`image`; null when it may not — NOT_FOUND, the same
 * as for an image that is not there): `Cache-Control: <scope>, no-cache` with a strong ETag (the
 * media id: an image's bytes never change), so a browser keeps the image but asks every time —
 * hiding a post or unpinning a notice stops its images at once — and an image still shown costs a
 * 304. NOT_FOUND too when the object is gone (`MediaService.bytesOf` logs it).
 *
 * An answer with the image holds its bytes from the storage read until the answer has been handed
 * to the socket, or the client has gone — and in either case until the storage read has settled: a
 * share of the process's budget (`imageReads`, ADR-0073 decision 9-36), taken before the store is
 * read. Every route that answers an image takes from the one budget, so none can hold more of the
 * API's memory than it allows. A client that goes gives the read up (an aborted signal), and the share comes back once
 * that read has stopped. Past the budget the read is RATE_LIMITED with `Retry-After`. Within the
 * budget, the image's bytes are then asked of the API's memory (`memoryAdmission`, ADR-0073 owner
 * decision 2026-10-22 answer 3): the read waits up to `memoryWaits.readMs` for the process's RSS and
 * the shares out — a running conversion's aside, which keeps room for the reads instead (9-46) — to
 * leave room for the image under the ceiling, and is RATE_LIMITED with `Retry-After` when they did
 * not; that share comes back once the store's read has settled. A 304 holds nothing.
 *
 * A HEAD (Fastify answers it with the GET's handler) is answered from the row alone: the headers a
 * GET would carry, its length the stored object's (`media_objects.byte_size`, written with the
 * object), and no store read nor share — Fastify would send no body anyway, so reading the image
 * only to drop it would let HEADs fill the budget and refuse the GETs (Codex review of #219,
 * round 2).
 */
export async function answerImage(
  media: MediaService,
  image: ShownImage | null,
  mediaId: string,
  scope: ImageCacheScope,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Buffer | Readable | undefined> {
  if (!image) throw imageNotFound();
  const etag = `"${mediaId}"`;
  const cacheControl = `${scope}, no-cache`;
  if (request.headers['if-none-match'] === etag) {
    void reply.status(304).header('cache-control', cacheControl).header('etag', etag);
    return undefined;
  }
  const answerHeaders = () =>
    reply
      .header('content-type', image.contentType)
      .header('cache-control', cacheControl)
      .header('etag', etag)
      .header('content-disposition', 'inline');
  if (request.method === 'HEAD') {
    void answerHeaders().header('content-length', String(image.byteSize));
    // An empty stream, not undefined: Fastify's hook for the HEAD of a GET route sets the length
    // of an undefined body to 0, and leaves a stream's to the headers.
    return Readable.from([]);
  }
  const giveShare = imageReads.take(image.byteSize);
  if (giveShare === null) {
    void reply.header('retry-after', String(IMAGE_READ_BUSY_RETRY_SECONDS));
    throw imageReadsBusy();
  }
  // The client going gives the store's read up (`gone`) — at once if it went already — but the
  // budget's share is given back only when the answer is out or the client has gone AND the read
  // has settled: a read given up still holds what it has gathered until it stops, so a client
  // that hangs up mid-read cannot hand its share on while its image is still being read into
  // memory.
  const gone = new AbortController();
  const answered = new Promise<void>((resolve) => {
    finished(reply.raw, () => {
      gone.abort();
      resolve();
    });
  });
  const giveMemory = await memoryAdmission.admit(image.byteSize, {
    kind: 'read',
    waitMs: memoryWaits.readMs,
    signal: gone.signal,
  });
  if (giveMemory === null) {
    giveShare();
    // Gone while it waited: there is no one to answer.
    if (gone.signal.aborted) return undefined;
    void reply.header('retry-after', String(IMAGE_READ_BUSY_RETRY_SECONDS));
    throw imageReadsBusy();
  }
  if (gone.signal.aborted) {
    giveShare();
    giveMemory();
    return undefined;
  }
  const reading = media.bytesOf(image, gone.signal);
  // The memory's share only while the store is read: once that read has settled its bytes are in
  // the RSS the admission reads (or gone), and counting them as a share as well would count them
  // twice for as long as a slow client takes. The budget's share still bounds them until the
  // answer is out (ADR-0073 9-46).
  void Promise.allSettled([reading]).then(giveMemory);
  void Promise.allSettled([answered, reading]).then(giveShare);
  let body: Uint8Array | null;
  try {
    body = await reading;
  } catch (error) {
    // Given up because the client went: there is no one to answer.
    if (gone.signal.aborted) return undefined;
    throw error;
  }
  if (body === null) throw imageNotFound();
  void answerHeaders();
  // The store's bytes themselves, not a copy of them.
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
}

function imageNotFound(): AppError {
  return new AppError('NOT_FOUND', { message: 'Image not found' });
}
