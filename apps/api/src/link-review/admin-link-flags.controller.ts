import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  adminLinkFlagGroupSchema,
  adminLinkFlagItemsQuerySchema,
  adminLinkFlagListQuerySchema,
  adminLinkFlagReviewBodySchema,
  adminLinkFlagSchema,
  type AdminLinkFlag,
  type AdminLinkFlagGroup,
  type AdminLinkFlagItemsQuery,
  type AdminLinkFlagListQuery,
  type AdminLinkFlagReviewBody,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { LinkReviewService } from './link-review.service.js';

/**
 * 반복 링크 검토 목록 (#187, ADR-0083; ADR-0069 decision 2 #45-15, decision 4 #187; owner decision
 * 2026-10-22) for operators: the posts and comments a repetition rule caught, grouped by link and
 * rule — the default list those no operator has marked, the reviewed list the marks — a group's
 * entries (the link, why and when, and the item as it is now), and the mark '확인함' with what came
 * of it ('문제 없음' or '조치함'), recorded in `admin_actions`. Nothing here acts on an item: hiding,
 * warning and restricting are #50's moderation (`/admin/moderation/…`), whose admin area shows this
 * list as one of its pages (ADR-0083 7-12) — the routes stay here, under `/admin/link-flags`.
 * Guards run in order: SessionGuard (401 without a session, 403 for a foreign Origin on a
 * mutation), AdminGuard (403 for a member), then OnboardedGuard (409 for an admin that has not
 * finished the onboarding, ADR-0072). The reads write no admin_actions row; the mark writes one
 * (admin-audit.test). The mark names the admin the screen shows (`expectedAccountId`,
 * assertExpectedAccount, ADR-0092): a mismatch with the cookie is refused before anything is read
 * or locked, so a mark is never recorded under an admin the user is not looking at.
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/link-flags')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminLinkFlagsController {
  constructor(private readonly links: LinkReviewService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListLinkFlags',
    summary:
      'The repeated-link review list grouped by link and rule (the same person put the link in 3 ' +
      'or more posts and comments within 24 hours, or 3 or more people did): `open`, the entries ' +
      'no operator has marked, newest group first; `reviewed`, one row per mark, newest first',
  })
  @ApiPageOf(adminLinkFlagGroupSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async list(
    @Query({ schema: adminLinkFlagListQuerySchema }) query: AdminLinkFlagListQuery,
  ): Promise<ApiPage<AdminLinkFlagGroup>> {
    const { items, nextCursor } = await this.links.list(query);
    return new ApiPage(items, { nextCursor });
  }

  @Get('items')
  @ApiOperation({
    operationId: 'adminListLinkFlagItems',
    summary:
      "A review-list group's entries, newest first: those of the link and rule no operator has " +
      'marked, or with `reviewId` those that mark covered — each with the item as it is now',
  })
  @ApiPageOf(adminLinkFlagSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async items(
    @Query({ schema: adminLinkFlagItemsQuerySchema }) query: AdminLinkFlagItemsQuery,
  ): Promise<ApiPage<AdminLinkFlag>> {
    const { items, nextCursor } = await this.links.items(query);
    return new ApiPage(items, { nextCursor });
  }

  @Post('reviews')
  @ApiOperation({
    operationId: 'adminReviewLinkFlags',
    summary:
      "Mark a review-list group '확인함' with what came of it (no_issue or actioned) and an " +
      'optional note, recorded: its unmarked entries put on the list at or before `through` ' +
      'leave the default list',
  })
  @ApiData(adminLinkFlagGroupSchema, 201)
  // NOT_FOUND: no unmarked entry of the link and rule at or before `through` (another operator
  // marked them meanwhile, or no such group); nothing is written. FORBIDDEN: also a body whose
  // `expectedAccountId` is not the cookie's account (details name the field).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  review(
    @CurrentUser() admin: SessionUser,
    @Body({ schema: adminLinkFlagReviewBodySchema }) body: AdminLinkFlagReviewBody,
  ): Promise<AdminLinkFlagGroup> {
    const { expectedAccountId, ...mark } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.links.review(admin.id, mark);
  }
}
