import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  NOTICE_PIN_LIMIT,
  POST_BODY_MAX_LENGTH,
  POST_IMAGES_MAX,
  adminNoticeListQuerySchema,
  adminNoticeSchema,
  adminNoticeSummarySchema,
  adminNoticeUpdateResultSchema,
  createNoticeBodySchema,
  noticeSchema,
  noticeSummarySchema,
  updateNoticeBodySchema,
  uuidParamSchema,
  type AdminNotice,
  type AdminNoticeListQuery,
  type AdminNoticeSummary,
  type AdminNoticeUpdateResult,
  type Notice,
  type NoticeContent,
  type NoticeSummary,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { NoticesService } from './notices.service.js';

/**
 * `/api/v1/notices` (#138): the operators' notices, public — anyone reads, signed in or not (#138's
 * acceptance criteria). The pinned ones for the fixed area above the community list, and one
 * notice's page. No person in either: a notice is shown as 운영팀's (#45-8), which the web writes.
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
    summary: 'A notice page, pinned or not: its title, body and dates',
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
 * admin-audit.test.ts's AUDITED). Guards run in order, as on every admin route: SessionGuard (401,
 * and 403 for a foreign Origin on a mutation), AdminGuard (403 for a member), OnboardedGuard (409
 * for an admin that has not finished the onboarding, ADR-0072).
 *
 * `adminNoticeListQuerySchema` carries no `.meta({ id })`, so swagger expands it into one
 * parameter per field by itself (markets.controller.ts says why no `@ApiQuery` sits beside it).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/notices')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminNoticesController {
  constructor(private readonly notices: NoticesService) {}

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
  @ApiOperation({ operationId: 'adminGetNotice', summary: 'One notice, as the editor loads it' })
  @ApiData(adminNoticeSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  get(@Param('noticeId', { schema: uuidParamSchema }) noticeId: string): Promise<AdminNotice> {
    return this.notices.adminGet(noticeId);
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
      'stays pinned. The later of two saves wins; no version is checked',
  })
  @ApiData(adminNoticeUpdateResultSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  update(
    @CurrentUser() admin: SessionUser,
    @Param('noticeId', { schema: uuidParamSchema }) noticeId: string,
    @Body({ schema: updateNoticeBodySchema }) body: NoticeContent,
  ): Promise<AdminNoticeUpdateResult> {
    return this.notices.update(admin.id, noticeId, { title: body.title, body: body.body });
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
      'Unpin a notice: out of the fixed area, kept on the admin screen and at its address, and ' +
      'may be pinned again. One not pinned changes nothing',
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
