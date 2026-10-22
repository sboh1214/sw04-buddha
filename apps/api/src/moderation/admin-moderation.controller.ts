import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  IMAGE_CONTENT_TYPES,
  adminAccountIdSchema,
  adminCommentModerationSchema,
  adminModerationActionSchema,
  adminPostModerationSchema,
  adminReportGroupSchema,
  adminReportQuerySchema,
  adminUserModerationSchema,
  cancelModerationBodySchema,
  cursorQuerySchema,
  dismissReportsBodySchema,
  dismissedReportsSchema,
  moderationActionBodySchema,
  publicIdParamSchema,
  uuidParamSchema,
  warningBodySchema,
  type AdminCommentModeration,
  type AdminModerationAction,
  type AdminPostModeration,
  type AdminReportGroup,
  type AdminReportQuery,
  type AdminUserModeration,
  type CursorQuery,
  type DismissedReports,
  type ParsedCancelModerationBody,
  type ParsedDismissReportsBody,
  type ParsedModerationActionBody,
  type ParsedWarningBody,
} from '@buddha/shared';
import { type FastifyReply } from 'fastify';
import { AdminGuard } from '../auth/admin.guard.js';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { RawResponse } from '../common/decorators/raw-response.decorator.js';
import { AppError } from '../common/errors/app-error.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { MediaService } from '../media/media.service.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { ModerationReadsService } from './moderation-reads.service.js';
import { ModerationService } from './moderation.service.js';

/** The errors of every operator action on an item or a member. */
const ACTION_ERRORS = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'ONBOARDING_REQUIRED',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'MODERATION_NOT_ALLOWED',
] as const;

/**
 * The report queue and its processing (#50, ADR-0081): `/api/v1/admin/reports`. Guards run in
 * order — SessionGuard (401; 403 for a foreign Origin on a mutation), AdminGuard (403 for a
 * member: every admin reads the reports, ADR-0056 1-2), OnboardedGuard (409) — as on every admin
 * route (admin-access.test.ts). A mutation names the admin the screen shows (`expectedAccountId`).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/reports')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminReportsController {
  constructor(
    private readonly moderation: ModerationService,
    private readonly reads: ModerationReadsService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListReportGroups',
    summary:
      'The report queue, grouped by target: `pending` (default) — targets with a pending report, ' +
      'the one waiting longest first — or `resolved` — targets whose reports were all processed, ' +
      'the latest first. Each with the target now, its member, the counts per reason and times',
  })
  @ApiPageOf(adminReportGroupSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async list(
    @Query({ schema: adminReportQuerySchema }) query: AdminReportQuery,
  ): Promise<ApiPage<AdminReportGroup>> {
    const { items, nextCursor } = await this.reads.queue(query);
    return new ApiPage(items, { nextCursor });
  }

  @Post('dismiss')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminDismissReports',
    summary:
      'Dismiss (기각) the reports named, each pending, with a reason (recorded): nothing is done ' +
      'to anyone and the reporters read 기각. A report on the acting admin’s own item or profile ' +
      'is another admin’s (own); one processed already is `resolved`',
  })
  @ApiData(dismissedReportsSchema)
  @ApiErrors(...ACTION_ERRORS)
  async dismiss(
    @CurrentUser() admin: SessionUser,
    @Body({ schema: dismissReportsBodySchema }) body: ParsedDismissReportsBody,
  ): Promise<DismissedReports> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return { reports: await this.moderation.dismiss(admin.id, body.reportIds, body.reason) };
  }
}

/**
 * Operator actions and the pages they are taken from (#50, ADR-0081): `/api/v1/admin/moderation`.
 * An item's and a member's moderation pages (the content whatever its state, its earlier versions,
 * the reports, the actions), every action, and the actions themselves: hiding a post or a comment,
 * a warning, the three profile items (#37-10) and a cancellation — each with its reason (a report
 * reason and the explanation the member reads), operator and time recorded, taken from the queue or
 * without a report (decision 4 #50). An operator never acts on themselves (`own`), and reads the
 * records about themselves without the reporters, the report descriptions and the operators' names
 * (owner decision 2026-10-21, `aboutViewer`). A member's page is found by the account id or, from a
 * public profile's '운영' link, by the public id.
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/moderation')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminModerationController {
  constructor(
    private readonly moderation: ModerationService,
    private readonly reads: ModerationReadsService,
  ) {}

  @Get('actions')
  @ApiOperation({
    operationId: 'adminListModerationActions',
    summary:
      'Every moderation action, newest first, with its reason, operator, time and cancellation — ' +
      'no operator on an action taken on the admin reading it (`aboutViewer`)',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(adminModerationActionSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async listActions(
    @CurrentUser() admin: SessionUser,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<AdminModerationAction>> {
    const { items, nextCursor } = await this.reads.allActions(query, admin.id);
    return new ApiPage(items, { nextCursor });
  }

  @Post('actions/:actionId/cancel')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminCancelModerationAction',
    summary:
      'Cancel an action with a reason (recorded): a hidden item shows again; a profile item is ' +
      'not restored. A nickname reset’s cancellation restores no nickname but hands the hold of ' +
      'the nickname taken away to the member: other accounts stay held for the rest of the 30 ' +
      'days from the reset, and while that hold stands the member picks that nickname, exactly ' +
      'as it was taken away, with no change interval, even after a pick since the reset, once ' +
      '(taken back and given up again, it keeps the interval, as any other nickname does). One ' +
      'cancelled already is `cancelled`; one on the ' +
      'acting admin is `own`',
  })
  @ApiData(adminModerationActionSchema)
  @ApiErrors(...ACTION_ERRORS)
  cancel(
    @CurrentUser() admin: SessionUser,
    @Param('actionId', { schema: uuidParamSchema }) actionId: string,
    @Body({ schema: cancelModerationBodySchema }) body: ParsedCancelModerationBody,
  ): Promise<AdminModerationAction> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.moderation.cancel(admin.id, actionId, body.reason);
  }

  @Get('posts/:postId')
  @ApiOperation({
    operationId: 'adminGetPostModeration',
    summary:
      'A post whatever its state (the deleted original too), its earlier versions, the reports on ' +
      'it with their reporters, its actions and its author’s record of actions. On a record about ' +
      'the admin reading it, no reporter, report description or operator (`aboutViewer`)',
  })
  @ApiData(adminPostModerationSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  postPage(
    @CurrentUser() admin: SessionUser,
    @Param('postId', { schema: uuidParamSchema }) postId: string,
  ): Promise<AdminPostModeration> {
    return this.reads.postPage(postId, admin.id);
  }

  @Post('posts/:postId/hide')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminHidePost',
    summary:
      'Hide a post with a reason: out of every list, its placeholder on its page, no new comment, ' +
      'no edit by its author. Resolves the pending reports on it (조치함). A deleted post is ' +
      '`deleted`, a hidden one `hidden`, the acting admin’s own `own`',
  })
  @ApiData(adminModerationActionSchema)
  @ApiErrors(...ACTION_ERRORS)
  hidePost(
    @CurrentUser() admin: SessionUser,
    @Param('postId', { schema: uuidParamSchema }) postId: string,
    @Body({ schema: moderationActionBodySchema }) body: ParsedModerationActionBody,
  ): Promise<AdminModerationAction> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.moderation.hidePost(admin.id, postId, body);
  }

  @Get('comments/:commentId')
  @ApiOperation({
    operationId: 'adminGetCommentModeration',
    summary:
      'A 댓글 or 대댓글 whatever its state, its earlier versions, its post, the reports on it, its ' +
      'actions and its author’s record of actions',
  })
  @ApiData(adminCommentModerationSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  commentPage(
    @CurrentUser() admin: SessionUser,
    @Param('commentId', { schema: uuidParamSchema }) commentId: string,
  ): Promise<AdminCommentModeration> {
    return this.reads.commentPage(commentId, admin.id);
  }

  @Post('comments/:commentId/hide')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminHideComment',
    summary:
      'Hide a 댓글 or 대댓글 with a reason, as a post. Resolves the pending reports on it (조치함)',
  })
  @ApiData(adminModerationActionSchema)
  @ApiErrors(...ACTION_ERRORS)
  hideComment(
    @CurrentUser() admin: SessionUser,
    @Param('commentId', { schema: uuidParamSchema }) commentId: string,
    @Body({ schema: moderationActionBodySchema }) body: ParsedModerationActionBody,
  ): Promise<AdminModerationAction> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.moderation.hideComment(admin.id, commentId, body);
  }

  @Get('users/:userId')
  @ApiOperation({
    operationId: 'adminGetUserModeration',
    summary:
      'A member’s public profile now (its image at its operator address), the reports on it and ' +
      'every action on the member, with what profile actions took away',
  })
  @ApiData(adminUserModerationSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  userPage(
    @CurrentUser() admin: SessionUser,
    @Param('userId', { schema: adminAccountIdSchema }) userId: string,
  ): Promise<AdminUserModeration> {
    return this.reads.userPage(userId, admin.id);
  }

  @Get('profiles/:publicId')
  @ApiOperation({
    operationId: 'adminGetProfileModeration',
    summary:
      'The same page as `GET /admin/moderation/users/{userId}`, found by the public id of the ' +
      'profile’s address — the way from a public profile’s operator link',
  })
  @ApiData(adminUserModerationSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  profilePage(
    @CurrentUser() admin: SessionUser,
    @Param('publicId', { schema: publicIdParamSchema }) publicId: string,
  ): Promise<AdminUserModeration> {
    return this.reads.profilePage(publicId, admin.id);
  }

  @Post('users/:userId/warn')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminWarnUser',
    summary:
      'Warn a member with a reason: a record and the member’s notice only. With a subject (the ' +
      'member’s post, comment or profile) its pending reports are resolved (조치함); one not the ' +
      'member’s is `not_theirs`',
  })
  @ApiData(adminModerationActionSchema)
  @ApiErrors(...ACTION_ERRORS)
  warn(
    @CurrentUser() admin: SessionUser,
    @Param('userId', { schema: adminAccountIdSchema }) userId: string,
    @Body({ schema: warningBodySchema }) body: ParsedWarningBody,
  ): Promise<AdminModerationAction> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.moderation.warn(admin.id, userId, body);
  }

  @Post('users/:userId/nickname-reset')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminResetNickname',
    summary:
      'Give a member’s nickname back to an auto nickname with a reason; the nickname taken away ' +
      'is kept for operators and held from every account for 30 days (from the member too, until ' +
      'the reset is cancelled), and the member’s 30-day change interval is waived (they pick a ' +
      'new one at once). An auto nickname already is `nothing_to_remove`. Resolves the pending ' +
      'reports on the profile (조치함)',
  })
  @ApiData(adminModerationActionSchema)
  @ApiErrors(...ACTION_ERRORS)
  resetNickname(
    @CurrentUser() admin: SessionUser,
    @Param('userId', { schema: adminAccountIdSchema }) userId: string,
    @Body({ schema: moderationActionBodySchema }) body: ParsedModerationActionBody,
  ): Promise<AdminModerationAction> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.moderation.resetNickname(admin.id, userId, body);
  }

  @Post('users/:userId/bio-clear')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminClearBio',
    summary:
      'Empty a member’s 소개 with a reason; it is kept for operators. None is ' +
      '`nothing_to_remove`. Resolves the pending reports on the profile (조치함)',
  })
  @ApiData(adminModerationActionSchema)
  @ApiErrors(...ACTION_ERRORS)
  clearBio(
    @CurrentUser() admin: SessionUser,
    @Param('userId', { schema: adminAccountIdSchema }) userId: string,
    @Body({ schema: moderationActionBodySchema }) body: ParsedModerationActionBody,
  ): Promise<AdminModerationAction> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.moderation.clearBio(admin.id, userId, body);
  }

  @Post('users/:userId/image-remove')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRemoveProfileImage',
    summary:
      'Remove a member’s profile image with a reason: served to nobody from then on and kept for ' +
      'operators. None is `nothing_to_remove`. Resolves the pending reports on the profile (조치함)',
  })
  @ApiData(adminModerationActionSchema)
  @ApiErrors(...ACTION_ERRORS)
  removeImage(
    @CurrentUser() admin: SessionUser,
    @Param('userId', { schema: adminAccountIdSchema }) userId: string,
    @Body({ schema: moderationActionBodySchema }) body: ParsedModerationActionBody,
  ): Promise<AdminModerationAction> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.moderation.removeImage(admin.id, userId, body);
  }
}

/**
 * `/api/v1/admin/media/:mediaId` (#50): any stored image for operators — a deleted or hidden post's,
 * an earlier version's, a profile image an operator removed and keeps (#37-10) — which the public
 * `GET /media/:mediaId` serves to nobody. Never cached by anything but the operator's browser.
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/media')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMediaController {
  constructor(private readonly media: MediaService) {}

  @Get(':mediaId')
  @RawResponse()
  @ApiOperation({
    operationId: 'adminGetImage',
    summary: 'Any stored image, whatever shows it, for operators',
  })
  @ApiProduces(...IMAGE_CONTENT_TYPES)
  @ApiResponse({
    status: 200,
    description: 'The image',
    content: Object.fromEntries(
      IMAGE_CONTENT_TYPES.map((type) => [type, { schema: { type: 'string', format: 'binary' } }]),
    ),
  })
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  async read(
    @Param('mediaId', { schema: uuidParamSchema }) mediaId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const image = await this.media.findStored(mediaId);
    const body = image === null ? null : await this.media.bytesOf(image);
    if (image === null || body === null) {
      throw new AppError('NOT_FOUND', { message: 'Image not found' });
    }
    void reply
      .header('content-type', image.contentType)
      .header('cache-control', 'private, no-store')
      .header('content-disposition', 'inline');
    return Buffer.from(body);
  }
}
