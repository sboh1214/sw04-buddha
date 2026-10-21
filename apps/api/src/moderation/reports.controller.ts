import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  REPORTS_PER_DAY,
  REPORT_WINDOW_HOURS,
  createReportBodySchema,
  cursorQuerySchema,
  myModerationActionSchema,
  myReportSchema,
  publicIdParamSchema,
  uuidParamSchema,
  type CursorQuery,
  type MyModerationAction,
  type MyReport,
  type ParsedReportBody,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { ModerationReadsService } from './moderation-reads.service.js';
import { ReportsService } from './reports.service.js';

/*
 * 신고 (#50, ADR-0081). A report is one route per target, as a like is (`PUT …/like`): a 근거 글, a
 * 댓글 or 대댓글, a profile (#45-10, #37-10). Open to accounts that finished the onboarding (#57-8,
 * OnboardedGuard), each naming the account the screen shows (`expectedAccountId`). Counted like
 * every route (the per-address bucket) and by the person's fixed daily limit (REPORT_LIMITED).
 * Nothing about a report rides on a public answer: whether or how often anything was reported is
 * operators' (PRIVATE_DATA `reports`).
 */

/**
 * The summaries' common tail. `placeholders`: whether the target can show as a placeholder — a
 * post or a comment can (`deleted`, `hidden`), a profile cannot, so its route never answers them.
 */
function reportSummaryTail(placeholders: boolean): string {
  return (
    'One reason (기타 needs a description). Refused: one’s own (own), the same person’s report ' +
    'on it still pending (duplicate), ' +
    (placeholders ? 'a deleted placeholder or a hidden item (deleted, hidden), ' : '') +
    `and more than ${String(REPORTS_PER_DAY)} in ${String(REPORT_WINDOW_HOURS)} hours per ` +
    'person (REPORT_LIMITED, none for an operator). Nothing is hidden by a report; an operator ' +
    'decides. Answers the report as the reporter’s list shows it'
  );
}

/** `POST /api/v1/posts/:postId/reports`. */
@ApiTags('reports')
@Controller('posts')
export class PostReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post(':postId/reports')
  @UseGuards(SessionGuard, OnboardedGuard)
  @ApiCookieAuth(SESSION_SECURITY_SCHEME)
  @ApiOperation({
    operationId: 'reportPost',
    summary: `Report a 근거 글. ${reportSummaryTail(true)}`,
  })
  @ApiData(myReportSchema, 201)
  // FORBIDDEN: a mutation whose Origin is not ours (SessionGuard's CSRF check), or a body whose
  // `expectedAccountId` is not the cookie's account (details name the field; nothing written).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'ONBOARDING_REQUIRED',
    'REPORT_NOT_ALLOWED',
    // Both 429: the address bucket every route has, and the person's daily count of reports.
    'RATE_LIMITED',
    'REPORT_LIMITED',
  )
  create(
    @CurrentUser() user: SessionUser,
    @Param('postId', { schema: uuidParamSchema }) postId: string,
    @Body({ schema: createReportBodySchema }) body: ParsedReportBody,
  ): Promise<MyReport> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.reports.reportPost(user.id, postId, body);
  }
}

/** `POST /api/v1/comments/:commentId/reports`: a 댓글 or a 대댓글. */
@ApiTags('reports')
@Controller('comments')
export class CommentReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post(':commentId/reports')
  @UseGuards(SessionGuard, OnboardedGuard)
  @ApiCookieAuth(SESSION_SECURITY_SCHEME)
  @ApiOperation({
    operationId: 'reportComment',
    summary: `Report a 댓글 or a 대댓글. ${reportSummaryTail(true)}`,
  })
  @ApiData(myReportSchema, 201)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'ONBOARDING_REQUIRED',
    'REPORT_NOT_ALLOWED',
    // Both 429: the address bucket every route has, and the person's daily count of reports.
    'RATE_LIMITED',
    'REPORT_LIMITED',
  )
  create(
    @CurrentUser() user: SessionUser,
    @Param('commentId', { schema: uuidParamSchema }) commentId: string,
    @Body({ schema: createReportBodySchema }) body: ParsedReportBody,
  ): Promise<MyReport> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.reports.reportComment(user.id, commentId, body);
  }
}

/** `POST /api/v1/profiles/:publicId/reports`: the profile — nickname, image and 소개 (#37-10). */
@ApiTags('reports')
@Controller('profiles')
export class ProfileReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post(':publicId/reports')
  @UseGuards(SessionGuard, OnboardedGuard)
  @ApiCookieAuth(SESSION_SECURITY_SCHEME)
  @ApiOperation({
    operationId: 'reportProfile',
    summary:
      'Report a member’s public profile (its nickname, image and 소개). An unknown public id is ' +
      `NOT_FOUND, as the profile. ${reportSummaryTail(false)}`,
  })
  @ApiData(myReportSchema, 201)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'ONBOARDING_REQUIRED',
    'REPORT_NOT_ALLOWED',
    // Both 429: the address bucket every route has, and the person's daily count of reports.
    'RATE_LIMITED',
    'REPORT_LIMITED',
  )
  create(
    @CurrentUser() user: SessionUser,
    @Param('publicId', { schema: publicIdParamSchema }) publicId: string,
    @Body({ schema: createReportBodySchema }) body: ParsedReportBody,
  ): Promise<MyReport> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.reports.reportProfile(user.id, publicId, body);
  }
}

/**
 * `/api/v1/me/reports` and `/me/moderation/actions` (#50, ADR-0069 decision 4 #50: the MY page of
 * the actions received and the reports filed). Owner-only: the session decides whose records are
 * read, and nothing here takes another account. Signed in is enough.
 */
@ApiTags('me')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me')
@UseGuards(SessionGuard)
export class MyModerationController {
  constructor(
    private readonly reports: ReportsService,
    private readonly reads: ModerationReadsService,
  ) {}

  @Get('reports')
  @ApiOperation({
    operationId: 'listMyReports',
    summary:
      'The account’s own reports, newest first: what each was about as the public sees it now ' +
      '(a placeholder by its id alone), the reason and description sent, and the result — ' +
      'pending, actioned (조치함) or dismissed (기각) — with when. Never the action taken nor who ' +
      'took it',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(myReportSchema)
  @ApiErrors('UNAUTHENTICATED', 'VALIDATION_ERROR')
  async listReports(
    @CurrentUser() user: SessionUser,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<MyReport>> {
    const { items, nextCursor } = await this.reports.myReports(user.id, query);
    return new ApiPage(items, { nextCursor });
  }

  @Get('moderation/actions')
  @ApiOperation({
    operationId: 'listMyModerationActions',
    summary:
      'The actions operators took on the account, newest first: the type, the reason (a report ' +
      'reason and the operator’s explanation), what it was about (the account’s own item, ' +
      'nothing of it once deleted), its end when it has one and its cancellation. Never the ' +
      'operator, a report or a reporter',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(myModerationActionSchema)
  @ApiErrors('UNAUTHENTICATED', 'VALIDATION_ERROR')
  async listActions(
    @CurrentUser() user: SessionUser,
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<MyModerationAction>> {
    const { items, nextCursor } = await this.reads.myActions(user.id, query);
    return new ApiPage(items, { nextCursor });
  }
}
