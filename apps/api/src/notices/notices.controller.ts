import { type Readable } from 'node:stream';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
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
  NOTICE_PIN_LIMIT,
  POST_BODY_MAX_LENGTH,
  POST_IMAGES_MAX,
  adminNoticeActionSchema,
  adminNoticeListQuerySchema,
  adminNoticeRevisionSchema,
  adminNoticeRevisionSummarySchema,
  adminNoticeSchema,
  adminNoticeSummarySchema,
  adminNoticeUpdateResultSchema,
  createNoticeBodySchema,
  cursorQuerySchema,
  noticeRevisionIdParamSchema,
  noticeSchema,
  noticeSummarySchema,
  updateNoticeBodySchema,
  uuidParamSchema,
  type AdminNotice,
  type AdminNoticeAction,
  type AdminNoticeListQuery,
  type AdminNoticeRevision,
  type AdminNoticeRevisionSummary,
  type AdminNoticeSummary,
  type AdminNoticeUpdateResult,
  type CursorQuery,
  type Notice,
  type NoticeContent,
  type NoticeEdit,
  type NoticeSummary,
} from '@buddha/shared';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { AdminGuard } from '../auth/admin.guard.js';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { RawResponse } from '../common/decorators/raw-response.decorator.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { IMAGE_BINARY, answerImage } from '../media/image-response.js';
import { MediaService } from '../media/media.service.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { NoticesService } from './notices.service.js';

/**
 * `/api/v1/notices` (#138): the operators' pinned notices, public — anyone reads, signed in or not
 * (#138's acceptance criteria). The pinned ones for the fixed area above the community list, and
 * one pinned notice's page; a notice that is not pinned is not public (owner decision 2026-10-21).
 * No person in either: a notice is shown as 운영팀's (#45-8), which the web writes.
 */
@ApiTags('notices')
@Controller('notices')
export class NoticesController {
  constructor(private readonly notices: NoticesService) {}

  @Get()
  @ApiOperation({
    operationId: 'listPinnedNotices',
    summary:
      `The pinned notices (at most ${String(NOTICE_PIN_LIMIT)}), the latest pinned first: the ` +
      'fixed area above the community list',
  })
  @ApiData(noticeSummarySchema.array())
  listPinned(): Promise<NoticeSummary[]> {
    return this.notices.listPinned();
  }

  @Get(':noticeId')
  @ApiOperation({
    operationId: 'getNotice',
    summary:
      'A pinned notice’s page: its title, body and dates (NOT_FOUND for a notice not pinned, as ' +
      'for an unknown one)',
  })
  @ApiData(noticeSchema)
  @ApiErrors('NOT_FOUND', 'VALIDATION_ERROR')
  get(@Param('noticeId', { schema: uuidParamSchema }) noticeId: string): Promise<Notice> {
    return this.notices.get(noticeId);
  }
}

/**
 * `/api/v1/admin/notices` (#138): every admin writes, edits, pins and unpins notices, with no
 * second admin's approval (#45-8), and each change records its admin and time (`admin_actions`,
 * admin-audit.test.ts's AUDITED). The notice screen reads every notice, pinned or not, its
 * operation records and its earlier versions, and the images of both (owner decision 2026-10-21).
 * Guards run in order, as on every admin route: SessionGuard (401, and 403 for a foreign Origin on
 * a mutation), AdminGuard (403 for a member), OnboardedGuard (409 for an admin that has not
 * finished the onboarding, ADR-0072).
 *
 * `adminNoticeListQuerySchema` carries no `.meta({ id })`, so swagger expands it into one
 * parameter per field by itself (markets.controller.ts says why no `@ApiQuery` sits beside it).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/notices')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminNoticesController {
  constructor(
    private readonly notices: NoticesService,
    private readonly media: MediaService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListNotices',
    summary:
      'The notices of one state: pinned (the fixed area, the latest pinned first) or unpinned ' +
      '(every other notice, the newest first — each may be pinned again)',
  })
  @ApiPageOf(adminNoticeSummarySchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async list(
    @Query({ schema: adminNoticeListQuerySchema }) query: AdminNoticeListQuery,
  ): Promise<ApiPage<AdminNoticeSummary>> {
    const { items, nextCursor } = await this.notices.adminList(query);
    return new ApiPage(items, { nextCursor });
  }

  @Get(':noticeId')
  @ApiOperation({
    operationId: 'adminGetNotice',
    summary: 'One notice, pinned or not, as the editor loads it',
  })
  @ApiData(adminNoticeSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  get(@Param('noticeId', { schema: uuidParamSchema }) noticeId: string): Promise<AdminNotice> {
    return this.notices.adminGet(noticeId);
  }

  @Get(':noticeId/actions')
  @ApiOperation({
    operationId: 'adminListNoticeActions',
    summary:
      'A notice’s operation records, newest first: who wrote, edited, pinned or unpinned it and ' +
      'when (an edit names the version it replaced). An unknown notice has none',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(adminNoticeActionSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async listActions(
    @Param('noticeId', { schema: uuidParamSchema }) noticeId: string,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<AdminNoticeAction>> {
    const { items, nextCursor } = await this.notices.adminActions(noticeId, query);
    return new ApiPage(items, { nextCursor });
  }

  @Get(':noticeId/revisions')
  @ApiOperation({
    operationId: 'adminListNoticeRevisions',
    summary:
      'A notice’s earlier versions, newest first: each title, when and by whom it was written and ' +
      'replaced. An unknown notice has none',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(adminNoticeRevisionSummarySchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async listRevisions(
    @Param('noticeId', { schema: uuidParamSchema }) noticeId: string,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<AdminNoticeRevisionSummary>> {
    const { items, nextCursor } = await this.notices.adminRevisions(noticeId, query);
    return new ApiPage(items, { nextCursor });
  }

  @Get(':noticeId/revisions/:revisionId')
  @ApiOperation({
    operationId: 'adminGetNoticeRevision',
    summary: 'One earlier version of a notice, whole, to read (NOT_FOUND if not this notice’s)',
  })
  @ApiData(adminNoticeRevisionSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  getRevision(
    @Param('noticeId', { schema: uuidParamSchema }) noticeId: string,
    @Param('revisionId', { schema: noticeRevisionIdParamSchema }) revisionId: string,
  ): Promise<AdminNoticeRevision> {
    return this.notices.adminRevision(noticeId, Number(revisionId));
  }

  /**
   * An image of the notice, for the admin screens: any image it holds, in its current body or in
   * an earlier version only, pinned or not (MediaService.findNoticeImage) — the public
   * `GET /media/:mediaId` serves a pinned notice's current images alone. `Cache-Control: private,
   * no-cache` with the media id as its ETag (`answerImage`), and the same hold on the process's
   * image-read budget and on the API's memory as the public read (`imageReads` and
   * `memoryAdmission`, ADR-0073 decisions 9-36 and 9-46): an admin's reads take from that one
   * budget, and a HEAD is answered from the row alone. The address limit is the default's, not the
   * public read's `mediaRead` — only admins call it.
   */
  @Get(':noticeId/images/:mediaId')
  @RawResponse()
  @ApiOperation({
    operationId: 'adminGetNoticeImage',
    summary:
      'An image the notice holds, now or in an earlier version, pinned or not (NOT_FOUND for ' +
      'any other). Revalidated on every use (ETag)',
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
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  async image(
    @Param('noticeId', { schema: uuidParamSchema }) noticeId: string,
    @Param('mediaId', { schema: uuidParamSchema }) mediaId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer | Readable | undefined> {
    const image = await this.media.findNoticeImage(noticeId, mediaId);
    return answerImage(this.media, image, mediaId, 'private', request, reply);
  }

  @Post()
  @ApiOperation({
    operationId: 'adminCreateNotice',
    summary:
      'Write a notice, not pinned: a required title and a formatted body as a post’s (at most ' +
      `${String(POST_BODY_MAX_LENGTH)} characters of text and ${String(POST_IMAGES_MAX)} images, ` +
      'each an upload of the admin’s own that no post or notice has taken)',
  })
  @ApiData(adminNoticeSchema, 201)
  // VALIDATION_ERROR names `title` or `body` (the body schema's issues, and an image the admin
  // cannot use — one issue per image, as a post's).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  create(
    @CurrentUser() admin: SessionUser,
    @Body({ schema: createNoticeBodySchema }) body: NoticeContent,
  ): Promise<AdminNotice> {
    return this.notices.create(admin.id, { title: body.title, body: body.body });
  }

  @Put(':noticeId')
  @ApiOperation({
    operationId: 'adminUpdateNotice',
    summary:
      'Replace a notice’s title and body: it shows as edited and the earlier version is kept ' +
      'for operators. The same content changes nothing (`changed: false`). A pinned notice ' +
      'stays pinned. Refused when another admin saved since the version the edit was opened from ' +
      '(`expectedEditedAt`, NOTICE_EDIT_CONFLICT)',
  })
  @ApiData(adminNoticeUpdateResultSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'NOTICE_EDIT_CONFLICT',
  )
  update(
    @CurrentUser() admin: SessionUser,
    @Param('noticeId', { schema: uuidParamSchema }) noticeId: string,
    @Body({ schema: updateNoticeBodySchema }) body: NoticeEdit,
  ): Promise<AdminNoticeUpdateResult> {
    return this.notices.update(admin.id, noticeId, {
      title: body.title,
      body: body.body,
      expectedEditedAt: body.expectedEditedAt,
    });
  }

  @Post(':noticeId/pin')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminPinNotice',
    summary:
      `Pin a notice above the community list, on top; refused while ${String(NOTICE_PIN_LIMIT)} ` +
      'are pinned (NOTICE_PIN_LIMIT_REACHED — none is unpinned to make room). A pinned one ' +
      'changes nothing',
  })
  @ApiData(adminNoticeSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'NOTICE_PIN_LIMIT_REACHED',
  )
  pin(
    @CurrentUser() admin: SessionUser,
    @Param('noticeId', { schema: uuidParamSchema }) noticeId: string,
  ): Promise<AdminNotice> {
    return this.notices.pin(admin.id, noticeId);
  }

  @Post(':noticeId/unpin')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminUnpinNotice',
    summary:
      'Unpin a notice: out of the fixed area and out of the public (its page and images answer ' +
      'NOT_FOUND), kept on the admin screen, and may be pinned again. One not pinned changes ' +
      'nothing',
  })
  @ApiData(adminNoticeSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  unpin(
    @CurrentUser() admin: SessionUser,
    @Param('noticeId', { schema: uuidParamSchema }) noticeId: string,
  ): Promise<AdminNotice> {
    return this.notices.unpin(admin.id, noticeId);
  }
}
