import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  adminThemeMarketSchema,
  adminThemeSchema,
  adminThemeSummarySchema,
  createThemeBodySchema,
  createThemeNoticeBodySchema,
  cursorQuerySchema,
  expectedAccountBodySchema,
  expectedAccountQuerySchema,
  linkThemeMarketBodySchema,
  updateThemeBodySchema,
  updateThemeNoticeBodySchema,
  uuidParamSchema,
  type AdminTheme,
  type AdminThemeMarket,
  type AdminThemeSummary,
  type CreateThemeBody,
  type CreateThemeNoticeBody,
  type CursorQuery,
  type ExpectedAccountBody,
  type ExpectedAccountQuery,
  type LinkThemeMarketBody,
  type UpdateThemeBody,
  type UpdateThemeNoticeBody,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { ThemeAdminService } from './theme-admin.service.js';

/**
 * 테마 (#81) for admins. Guards run in order, as on every admin route: SessionGuard (401 without a
 * session, 403 for a foreign Origin on a mutation), AdminGuard (403 for a member), then
 * OnboardedGuard (409 for an admin that has not finished the onboarding, ADR-0072). Every
 * write records the admin and the time in `admin_actions` when it changes something
 * (admin-audit.test.ts's AUDITED); none asks a reason or a second admin (ADR-0069 decision 4).
 * There is no DELETE of a theme or a notice: a theme is unpublished, a notice hidden.
 *
 * Every write names the admin the screen shows (`expectedAccountId` — in the body, or the query
 * of a market's removal, whose DELETE has no body; assertExpectedAccount, ADR-0092): a mismatch
 * with the cookie is refused (403 FORBIDDEN naming the field) before anything is read, locked or
 * written, so a theme is never changed as an admin the user is not looking at. The services are
 * handed the rest of the body.
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/themes')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminThemesController {
  constructor(private readonly themes: ThemeAdminService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListThemes',
    summary: 'Every theme, published or not, newest first',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(adminThemeSummarySchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async adminListThemes(
    @Query({ schema: cursorQuerySchema }) query: CursorQuery,
  ): Promise<ApiPage<AdminThemeSummary>> {
    const { items, nextCursor } = await this.themes.list(query);
    return new ApiPage(items, { nextCursor });
  }

  @Post()
  @ApiOperation({
    operationId: 'adminCreateTheme',
    summary:
      'Create an unpublished theme: slug, name, introduction and Korean period, all required, ' +
      'dates from 2000-01-01 to 2100-12-31; a slug another theme has is refused naming slug',
  })
  @ApiData(adminThemeSchema, 201)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  adminCreateTheme(
    @CurrentUser() admin: SessionUser,
    @Body({ schema: createThemeBodySchema }) body: CreateThemeBody,
  ): Promise<AdminTheme> {
    const { expectedAccountId, ...fields } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.themes.create(admin.id, fields);
  }

  @Get(':id')
  @ApiOperation({
    operationId: 'adminGetTheme',
    summary: 'One theme with who made it and every notice, hidden ones too',
  })
  @ApiData(adminThemeSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminGetTheme(@Param('id', { schema: uuidParamSchema }) id: string): Promise<AdminTheme> {
    return this.themes.get(id);
  }

  @Patch(':id')
  @ApiOperation({
    operationId: 'adminUpdateTheme',
    summary:
      'Edit the name, introduction or period at any time, and the slug until the theme is first ' +
      'published (refused naming slug after that, unpublished or not); an end before the start ' +
      'is refused naming the half the body sent (start == end is a one-day theme), and a date ' +
      'outside 2000-01-01 to 2100-12-31 naming its field',
  })
  @ApiData(adminThemeSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminUpdateTheme(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: updateThemeBodySchema }) body: UpdateThemeBody,
  ): Promise<AdminTheme> {
    const { expectedAccountId, ...fields } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.themes.update(admin.id, id, fields);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminPublishTheme',
    summary:
      'Make the theme public; refused naming markets while it has no market that is not a ' +
      'draft (drafts do not count); a published theme stays as it is',
  })
  @ApiData(adminThemeSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminPublishTheme(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: expectedAccountBodySchema }) body: ExpectedAccountBody,
  ): Promise<AdminTheme> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.themes.publish(admin.id, id);
  }

  @Post(':id/unpublish')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminUnpublishTheme',
    summary: 'Take the theme off every public answer (it is never deleted)',
  })
  @ApiData(adminThemeSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminUnpublishTheme(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: expectedAccountBodySchema }) body: ExpectedAccountBody,
  ): Promise<AdminTheme> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.themes.unpublish(admin.id, id);
  }

  /**
   * The theme's markets in every status, drafts too — the admin keeps them and the public answers
   * leave the drafts out. Unpaginated: it is the list they are managed from, one theme's.
   */
  @Get(':id/markets')
  @ApiOperation({
    operationId: 'adminListThemeMarkets',
    summary: "The theme's markets, any status, the latest put in first, with who put it in",
  })
  @ApiData(adminThemeMarketSchema.array())
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminListThemeMarkets(
    @Param('id', { schema: uuidParamSchema }) id: string,
  ): Promise<AdminThemeMarket[]> {
    return this.themes.listMarkets(id);
  }

  @Post(':id/markets')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminLinkThemeMarket',
    summary:
      'Put a market in the theme, in any status; a market already in changes nothing. Answers ' +
      "the theme's markets as they stand",
  })
  @ApiData(adminThemeMarketSchema.array())
  // NOT_FOUND names `marketId` for an unknown market (an unknown theme is a plain NOT_FOUND).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminLinkThemeMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: linkThemeMarketBodySchema }) body: LinkThemeMarketBody,
  ): Promise<AdminThemeMarket[]> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.themes.link(admin.id, id, body.marketId);
  }

  @Delete(':id/markets/:marketId')
  @ApiOperation({
    operationId: 'adminUnlinkThemeMarket',
    summary:
      "Take a market out of the theme; a market not in changes nothing. Answers the theme's " +
      'markets as they stand',
  })
  @ApiData(adminThemeMarketSchema.array())
  // NOT_FOUND names the path's `marketId` for an unknown market, as the link names the body's.
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminUnlinkThemeMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('marketId', { schema: uuidParamSchema }) marketId: string,
    @Query({ schema: expectedAccountQuerySchema }) query: ExpectedAccountQuery,
  ): Promise<AdminThemeMarket[]> {
    assertExpectedAccount(admin.id, query.expectedAccountId);
    return this.themes.unlink(admin.id, id, marketId);
  }

  @Post(':id/notices')
  @ApiOperation({
    operationId: 'adminCreateThemeNotice',
    summary: "Write a notice on the theme's page, plain text, shown at once. Answers the theme",
  })
  @ApiData(adminThemeSchema, 201)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminCreateThemeNotice(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: createThemeNoticeBodySchema }) body: CreateThemeNoticeBody,
  ): Promise<AdminTheme> {
    const { expectedAccountId, ...notice } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.themes.createNotice(admin.id, id, notice);
  }

  @Patch(':id/notices/:noticeId')
  @ApiOperation({
    operationId: 'adminUpdateThemeNotice',
    summary:
      "Edit a notice's title or body; the earlier text stays in the admin record. Answers the theme",
  })
  @ApiData(adminThemeSchema)
  // NOT_FOUND names `noticeId` for a notice that is not this theme's.
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminUpdateThemeNotice(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('noticeId', { schema: uuidParamSchema }) noticeId: string,
    @Body({ schema: updateThemeNoticeBodySchema }) body: UpdateThemeNoticeBody,
  ): Promise<AdminTheme> {
    const { expectedAccountId, ...edit } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.themes.updateNotice(admin.id, id, noticeId, edit);
  }

  @Post(':id/notices/:noticeId/hide')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminHideThemeNotice',
    summary: 'Take a notice off the public page (it is never deleted). Answers the theme',
  })
  @ApiData(adminThemeSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminHideThemeNotice(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('noticeId', { schema: uuidParamSchema }) noticeId: string,
    @Body({ schema: expectedAccountBodySchema }) body: ExpectedAccountBody,
  ): Promise<AdminTheme> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.themes.hideNotice(admin.id, id, noticeId);
  }

  @Post(':id/notices/:noticeId/show')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminShowThemeNotice',
    summary: 'Show a hidden notice on the page again. Answers the theme',
  })
  @ApiData(adminThemeSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminShowThemeNotice(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('noticeId', { schema: uuidParamSchema }) noticeId: string,
    @Body({ schema: expectedAccountBodySchema }) body: ExpectedAccountBody,
  ): Promise<AdminTheme> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.themes.showNotice(admin.id, id, noticeId);
  }
}
