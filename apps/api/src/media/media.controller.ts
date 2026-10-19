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
  uploadImageQuerySchema,
  uploadedImageSchema,
  uuidParamSchema,
  type UploadImageQuery,
  type UploadedImage,
} from '@buddha/shared';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { RawResponse } from '../common/decorators/raw-response.decorator.js';
import { AppError } from '../common/errors/app-error.js';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { IMAGE_UPLOAD_CONTENT_TYPES } from './image-body.js';
import { IMAGE_BUSY_RETRY_SECONDS } from './image.js';
import { MediaService } from './media.service.js';

const BINARY = { schema: { type: 'string', format: 'binary' } } as const;

/**
 * `/api/v1/media` (#46, ADR-0073): a post's images in and out. The upload is owner-only and open to
 * accounts that finished the onboarding (#57-8: writing a post is), the read is public — a post's
 * images are as public as the post — and both go through the API: the bucket is private and the
 * browser never touches it (ADR-0069 decision 2 #45-3).
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
   */
  @Post('images')
  @UseGuards(SessionGuard, OnboardedGuard)
  @ApiCookieAuth(SESSION_SECURITY_SCHEME)
  @ApiOperation({
    operationId: 'uploadImage',
    summary:
      `An image for a post: JPEG, PNG, WebP or GIF by its content, at most ${String(IMAGE_MAX_BYTES)} ` +
      `bytes. Stored without its metadata, the long side at most ${String(IMAGE_MAX_DIMENSION)}px, a GIF ` +
      'still moving. Its id goes into the post’s image node; it is served once a post shows it, and ' +
      `removed if no post takes it within ${String(ORPHAN_MEDIA_HOURS)} hours`,
  })
  @ApiConsumes(...IMAGE_UPLOAD_CONTENT_TYPES)
  @ApiBody(BINARY)
  @ApiData(uploadedImageSchema, 201)
  // FORBIDDEN: a mutation whose Origin is not ours (SessionGuard's CSRF check, or the body
  // parser's hook before the body is read — image-body.ts), or a query whose `expectedAccountId`
  // is not the cookie's account (details name the field; nothing stored). RATE_LIMITED (every
  // route documents it) is also the answer when too many conversions are waiting (image.ts).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'VALIDATION_ERROR',
    'ONBOARDING_REQUIRED',
    'IMAGE_NOT_ALLOWED',
  )
  async upload(
    @CurrentUser() user: SessionUser,
    @Query({ schema: uploadImageQuerySchema }) query: UploadImageQuery,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<UploadedImage> {
    assertExpectedAccount(user.id, query.expectedAccountId);
    if (!(body instanceof Buffer)) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'The body must be the image file itself',
        details: [
          { path: [], message: `send the file as ${IMAGE_UPLOAD_CONTENT_TYPES.join(', ')}` },
        ],
      });
    }
    try {
      return await this.media.uploadPostImage(user.id, new Uint8Array(body));
    } catch (error) {
      // Too many conversions waiting (image.ts `imageConversions`): the header every other 429
      // of the API carries, with the same seconds as `details.retryAfterSeconds`.
      if (error instanceof AppError && error.code === 'RATE_LIMITED') {
        void reply.header('retry-after', String(IMAGE_BUSY_RETRY_SECONDS));
      }
      throw error;
    }
  }

  /**
   * The image itself, while a post shows it (MediaService.findShown): otherwise NOT_FOUND — an upload no
   * post took, an image an edit removed, and every image of a deleted or hidden post (#45-5).
   *
   * `Cache-Control: no-cache` with a strong ETag (the id: an image's bytes never change): a browser
   * keeps the image but asks every time, so hiding or deleting a post stops its images at once,
   * and an image still shown costs a 304.
   */
  @Get(':mediaId')
  @RawResponse()
  @ApiOperation({
    operationId: 'getImage',
    summary:
      'An image a post shows (NOT_FOUND for any other: not attached, removed by an edit, or of a ' +
      'deleted or hidden post). Revalidated on every use (ETag)',
  })
  @ApiProduces(...IMAGE_CONTENT_TYPES)
  @ApiResponse({
    status: 200,
    description: 'The image',
    content: Object.fromEntries(IMAGE_CONTENT_TYPES.map((type) => [type, BINARY])),
  })
  @ApiResponse({ status: 304, description: 'Not modified (If-None-Match)' })
  @ApiErrors('NOT_FOUND', 'VALIDATION_ERROR')
  async read(
    @Param('mediaId', { schema: uuidParamSchema }) mediaId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer | undefined> {
    const image = await this.media.findShown(mediaId);
    if (!image) throw imageNotFound();
    const etag = `"${mediaId}"`;
    if (request.headers['if-none-match'] === etag) {
      void reply.status(304).header('cache-control', 'public, no-cache').header('etag', etag);
      return undefined;
    }
    const body = await this.media.bytesOf(image);
    if (body === null) throw imageNotFound();
    void reply
      .header('content-type', image.contentType)
      .header('cache-control', 'public, no-cache')
      .header('etag', etag)
      .header('content-disposition', 'inline');
    return Buffer.from(body);
  }
}

function imageNotFound(): AppError {
  return new AppError('NOT_FOUND', { message: 'Image not found' });
}
