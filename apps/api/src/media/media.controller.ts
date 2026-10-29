import { type Readable } from 'node:stream';
import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  IMAGE_CONTENT_TYPES,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_DIMENSION,
  ORPHAN_MEDIA_HOURS,
  uploadPostImageQuerySchema,
  uploadedImageSchema,
  uuidParamSchema,
  type UploadPostImageQuery,
  type UploadedImage,
} from '@buddha/shared';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { RawResponse } from '../common/decorators/raw-response.decorator.js';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { IMAGE_UPLOAD_CONTENT_TYPES, handleUpload } from './image-body.js';
import { IMAGE_BINARY, answerImage } from './image-response.js';
import { IMAGE_MAX_SIDE_RATIO, WEBP_ALPHA_MAX_OUTPUT_PIXELS } from './image.js';
import { MediaService } from './media.service.js';

/**
 * `/api/v1/media` (#46, ADR-0073): a post's images in and out. The upload is owner-only and open to
 * accounts that finished the onboarding (#57-8: writing a post is), the read is public — a post's
 * images are as public as the post — and both go through the API: the bucket is private and the
 * browser never touches it (ADR-0069 decision 2 #45-3). The read serves a member's profile image
 * too (#141, ADR-0079 — as public as the profile); its upload is `PUT /me/profile-image`.
 */
@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /**
   * One image file as the body, sent as itself (`fetch(url, { body: file })`) with its own type
   * or `application/octet-stream`; the type decides nothing, the bytes are checked. The account the
   * screen shows rides in the query (`expectedAccountId`): the body is the file, and the cookie
   * alone would put the upload on whichever account signed in last in another tab.
   *
   * The conversion and the store run as part of the upload the body parser's gate let in
   * (`handleUpload` — `runUploadWork`, image-body.ts, the profile image's upload's too): the
   * account's place among its three uploads in flight is held until they settle, even when the
   * client has hung up meanwhile, and a client gone before they start has nothing stored — there is
   * no one to answer.
   */
  @Post('images')
  @UseGuards(SessionGuard, OnboardedGuard)
  @ApiCookieAuth(SESSION_SECURITY_SCHEME)
  @ApiOperation({
    operationId: 'uploadImage',
    summary:
      `An image for a post (or an admin’s notice): JPEG, PNG, WebP or GIF by its content, at most ${String(IMAGE_MAX_BYTES)} ` +
      `bytes, its long side at most ${String(IMAGE_MAX_SIDE_RATIO)} times its short side. Stored ` +
      `without its metadata, the long side at most ${String(IMAGE_MAX_DIMENSION)}px (a still WebP ` +
      `with alpha at most ${String(WEBP_ALPHA_MAX_OUTPUT_PIXELS)} pixels), a GIF still moving. Its ` +
      'id goes into the post’s image node; it is served once a post shows it, and ' +
      `removed if nothing takes it within ${String(ORPHAN_MEDIA_HOURS)} hours. Refused under a ` +
      'writing restriction (RESTRICTED, with its end), which no post of the account gets past — ' +
      'but for an admin’s notice (`purpose=notice`, an admin’s alone): a writing restriction ' +
      'refuses no notice, its images included',
  })
  @ApiConsumes(...IMAGE_UPLOAD_CONTENT_TYPES)
  @ApiBody(IMAGE_BINARY)
  @ApiData(uploadedImageSchema, 201)
  // FORBIDDEN: a mutation whose Origin is not ours (SessionGuard's CSRF check, or the body
  // parser's hook before the body is read — image-body.ts), a query whose `expectedAccountId`
  // is not the cookie's account, or `purpose=notice` from an account that is no admin (details
  // name the field; nothing stored). RESTRICTED: a post's image under a writing restriction, with
  // its end — refused before the conversion; never a notice's (owner decision 2026-10-23 answer
  // 13, ADR-0082). UNAUTHENTICATED and
  // ONBOARDING_REQUIRED are answered by that hook too, before the body is read — whatever its
  // Content-Type — and so are a body of a type the route does not take (415, VALIDATION_ERROR)
  // and one declared over the parser's limit (413, VALIDATION_ERROR); a body that sends no byte
  // for 30 seconds, or is not all in 2 minutes after it started, is cut (408, VALIDATION_ERROR —
  // image-body.ts). RATE_LIMITED (every route
  // documents it) is also the answer, with `Retry-After`, when the account has three uploads in
  // flight, the uploads being received hold the process's budget or the API's memory had no room
  // for the body in time (that hook again, unread — image-body.ts), and when too many conversions
  // are waiting or the memory had no room for the conversion in time (image.ts).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'VALIDATION_ERROR',
    'ONBOARDING_REQUIRED',
    'IMAGE_NOT_ALLOWED',
    'RESTRICTED',
  )
  async upload(
    @CurrentUser() user: SessionUser,
    @Query({ schema: uploadPostImageQuerySchema }) query: UploadPostImageQuery,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<UploadedImage | undefined> {
    assertExpectedAccount(user.id, query.expectedAccountId);
    return handleUpload(request, reply, body, (bytes) =>
      this.media.uploadPostImage(user.id, bytes, query.purpose),
    );
  }

  /**
   * The image itself, while a post or a pinned notice (#138) shows it, or it is a member's profile
   * image (#141; MediaService.findShown): otherwise NOT_FOUND — an upload nothing took, an image an
   * edit removed, every image of a deleted or hidden post (#45-5) and of a notice that is not
   * pinned (owner decision 2026-10-21), and a profile image replaced, deleted or kept for operators
   * (#37-10).
   *
   * `Cache-Control: public, no-cache` with a strong ETag (`answerImage`): a browser keeps the image
   * but asks every time, so hiding or deleting a post, or unpinning a notice, stops its images at
   * once, and an image still shown costs a 304.
   *
   * An answer with the image holds its bytes from the storage read until the answer has been handed
   * to the socket, or the client has gone — and in either case until the storage read has settled:
   * a share of the process's budget (`imageReads`), taken before the store is read (`answerImage`,
   * which the admin's notice image route shares). A client that goes gives the read up (an aborted
   * signal), and the share comes back once that read has stopped. Past the budget the read is
   * RATE_LIMITED with `Retry-After`, as a full conversion queue is for an upload — so clients that
   * read slowly, or not at all, or hang up mid-read, fill the budget and not the API's memory
   * (ADR-0073 decision 9-36). Within the budget, the image's bytes are then asked of the API's
   * memory (`memoryAdmission`, owner decision 2026-10-22 answer 3): the read waits up to
   * `memoryWaits.readMs` for the process's RSS and the shares out — a running conversion's aside,
   * which keeps room for the reads instead (9-46) — to leave room for the image under the ceiling,
   * and is RATE_LIMITED with `Retry-After` when they did not; that share comes back once the store's
   * read has settled. A 304 holds nothing.
   *
   * A HEAD (Fastify answers it with this handler, the GET's) is answered from the row alone: the
   * headers a GET would carry, its length the stored object's (`media_objects.byte_size`, written
   * with the object), and no store read nor share — Fastify would send no body anyway, so reading
   * the image only to drop it would let HEADs fill the budget and refuse the GETs (Codex review of
   * #219, round 2).
   */
  @Get(':mediaId')
  @RawResponse()
  @ApiOperation({
    operationId: 'getImage',
    summary:
      'An image a post or a pinned notice shows, or a member’s profile image (NOT_FOUND for any ' +
      'other: not attached, removed by an edit, of a deleted or hidden post, of a notice not ' +
      'pinned, or no profile’s image now). Revalidated on every use (ETag)',
  })
  @ApiProduces(...IMAGE_CONTENT_TYPES)
  @ApiResponse({
    status: 200,
    description: 'The image',
    content: Object.fromEntries(IMAGE_CONTENT_TYPES.map((type) => [type, IMAGE_BINARY])),
  })
  @ApiResponse({ status: 304, description: 'Not modified (If-None-Match)' })
  // RATE_LIMITED (every route documents it) is also the answer while the images being sent hold
  // the process's budget (image-reads.ts) or the API's memory has no room for the image.
  @ApiErrors('NOT_FOUND', 'VALIDATION_ERROR')
  async read(
    @Param('mediaId', { schema: uuidParamSchema }) mediaId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer | Readable | undefined> {
    const image = await this.media.findShown(mediaId);
    return answerImage(this.media, image, mediaId, 'public', request, reply);
  }
}
