import { Body, Controller, HttpCode, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IMAGE_MAX_BYTES,
  PROFILE_IMAGE_SIZE,
  deleteProfileImageBodySchema,
  meSchema,
  uploadImageQuerySchema,
  type DeleteProfileImageBody,
  type Me,
  type UploadImageQuery,
} from '@buddha/shared';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { MeService } from '../me/me.service.js';
import { IMAGE_UPLOAD_CONTENT_TYPES, handleUpload } from '../media/image-body.js';
import { IMAGE_BINARY } from '../media/image-response.js';
import { IMAGE_MAX_SIDE_RATIO } from '../media/image.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { ProfileImageService } from './profile-image.service.js';

/**
 * `/api/v1/me/profile-image` (#141, ADR-0079): the member's profile image, uploaded and deleted in
 * MY 설정 (ADR-0069 decision 3 #37-6). Both answer the whole profile (`Me`, whose `imageUrl` is the
 * new address), as `PUT /me/bio` does. The image itself is read through `GET /media/:mediaId`, as a
 * post's image is.
 */
@ApiTags('me')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me/profile-image')
@UseGuards(SessionGuard)
export class ProfileImageController {
  constructor(
    private readonly images: ProfileImageService,
    private readonly me: MeService,
  ) {}

  /**
   * The file itself as the body, as a post's image is uploaded (`POST /media/images`, the same
   * body parser and gate — image-body.ts's IMAGE_UPLOAD_ROUTES), with the account the screen shows
   * in the query (`expectedAccountId`): the body is the file, and the cookie alone would put the
   * image on whichever account signed in last in another tab. A new public item: for accounts that
   * finished the onboarding (the gate before the body, OnboardedGuard after it), and refused during
   * a writing or an account restriction (#37-9, decision 7 — the service asks).
   *
   * The conversion and the store run as part of the upload the gate let in (`handleUpload` —
   * `runUploadWork`), as a post's image's do (MediaController.upload): the account's place among
   * its three uploads in flight — a post's images and its profile image counted together — is held
   * until they settle, even when the client has hung up meanwhile, and a client gone before they
   * start has nothing stored: there is no one to answer.
   */
  @Put()
  @UseGuards(OnboardedGuard)
  @ApiOperation({
    operationId: 'uploadMyProfileImage',
    summary:
      `Set the public profile’s image: JPEG, PNG or WebP by its content, at most ` +
      `${String(IMAGE_MAX_BYTES)} bytes, its long side at most ${String(IMAGE_MAX_SIDE_RATIO)} ` +
      `times its short side. Stored without its metadata as the square cropped from its middle, ` +
      `scaled down to ${String(PROFILE_IMAGE_SIZE)}px when larger (never enlarged); the earlier ` +
      'image is removed',
  })
  @ApiConsumes(...IMAGE_UPLOAD_CONTENT_TYPES)
  @ApiBody(IMAGE_BINARY)
  @ApiData(meSchema)
  // FORBIDDEN: a mutation whose Origin is not ours (SessionGuard's CSRF check, or the body parser's
  // hook before the body is read — image-body.ts), a query whose `expectedAccountId` is not the
  // cookie's account (details name the field; nothing stored), or a new image under a writing or an
  // account restriction (no field named). UNAUTHENTICATED and ONBOARDING_REQUIRED are answered by
  // that hook too, before the body is read — whatever its Content-Type — and so are a body of a
  // type the route does not take (415, VALIDATION_ERROR) and one declared over the parser's limit
  // (413, VALIDATION_ERROR); a body that sends no byte for 30 seconds, or is not all in 2 minutes
  // after it started, is cut (408, VALIDATION_ERROR — image-body.ts). RATE_LIMITED (every route
  // documents it) is also the answer, with `Retry-After`, when the account has three uploads in
  // flight — its post images' and this one together — the uploads being received hold the
  // process's budget or the API's memory had no room for the body in time (that hook again,
  // unread — image-body.ts), and when too many conversions are waiting or the memory had no room
  // for the conversion in time (image.ts), as for a post's image.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'ONBOARDING_REQUIRED',
    'IMAGE_NOT_ALLOWED',
  )
  async upload(
    @CurrentUser() user: SessionUser,
    @Query({ schema: uploadImageQuerySchema }) query: UploadImageQuery,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Me | undefined> {
    assertExpectedAccount(user.id, query.expectedAccountId);
    const stored = await handleUpload(request, reply, body, async (bytes) => {
      await this.images.replace(user.id, bytes);
      return true;
    });
    // The client has gone already: there is no one to answer.
    if (stored === undefined) return undefined;
    return this.me.getMe(user.id);
  }

  /**
   * Deletes the profile image: the profile and the bylines draw the nickname's first letter again.
   * Clearing a public item needs sign-in only — no OnboardedGuard, so an account held back by a
   * re-consent takes its image down too (owner decision 2026-10-22: «재동의만 남은 계정의 프로필
   * 이미지 지우기 → 로그인만으로», as for the 소개 on #41) — and is open during a restriction
   * (#37-9, decision 7). With no image it changes nothing. A POST rather than a DELETE, as a post's
   * deletion: the body names the account the screen shows, and OpenAPI 3.0 leaves a DELETE's body
   * undefined.
   */
  @Post('delete')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'deleteMyProfileImage',
    summary:
      'Delete the public profile’s image (the nickname’s first letter is shown instead); removed at once',
  })
  @ApiData(meSchema)
  // FORBIDDEN: a mutation whose Origin is not ours, or a body whose `expectedAccountId` is not the
  // cookie's account (details name the field; nothing deleted).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR')
  async remove(
    @CurrentUser() user: SessionUser,
    @Body({ schema: deleteProfileImageBodySchema }) body: DeleteProfileImageBody,
  ): Promise<Me> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    await this.images.remove(user.id);
    return this.me.getMe(user.id);
  }
}
