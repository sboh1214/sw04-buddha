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
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  adminMarketListQuerySchema,
  adminMarketSchema,
  adminRelatedMarketSchema,
  approveMarketReviewBodySchema,
  changePriceProtectionBodySchema,
  createMarketBodySchema,
  expectedAccountBodySchema,
  expectedAccountQuerySchema,
  linkRelatedMarketBodySchema,
  marketSummarySchema,
  rejectMarketReviewBodySchema,
  rescheduleMarketOpenBodySchema,
  setMarketLiquidityBodySchema,
  revertMarketBodySchema,
  updateMarketBodySchema,
  uuidParamSchema,
  type AdminMarket,
  type AdminMarketListQuery,
  type AdminRelatedMarket,
  type ApproveMarketReviewBody,
  type ChangePriceProtectionBody,
  type CreateMarketBody,
  type ExpectedAccountBody,
  type ExpectedAccountQuery,
  type LinkRelatedMarketBody,
  type MarketSummary,
  type RejectMarketReviewBody,
  type RescheduleMarketOpenBody,
  type SetMarketLiquidityBody,
  type RevertMarketBody,
  type UpdateMarketBody,
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
import { MarketAdminService } from './market-admin.service.js';
import { RelatedMarketsService } from './related-markets.service.js';

/**
 * Admin market CRUD and transitions (PLAN 7.3, 12; M3). Guards run in order: SessionGuard
 * fills `request.auth` (401 without a session, 403 for a foreign Origin on a mutation),
 * AdminGuard reads the role (403 for a member), OnboardedGuard refuses an admin that has not
 * finished the onboarding (409 ONBOARDING_REQUIRED, ADR-0072).
 *
 * Every write names the admin the screen shows (`expectedAccountId` — in the body, or the query
 * of an unlink, whose DELETE has no body; assertExpectedAccount, ADR-0092): a mismatch with the
 * cookie is refused (403 FORBIDDEN naming the field) before anything is read, locked or written,
 * so a market is never created, edited, submitted, approved, rejected, sent back, rescheduled
 * or linked as an admin the user is not looking at. The services are handed the
 * rest of the body: the account is never stored.
 *
 * 개설 검수 (#78, ADR-0099): submit (draft → review), approve (→ scheduled) and reject (→ draft) by
 * another admin, revert (review or scheduled → draft) by any admin with a reason, and a SCHEDULED
 * market's scheduled open moved with a reason (reschedule). An OPEN or PAUSED market's 가격 보호 폭
 * changes with a reason (price-protection, #119, ADR-0112). The queue of pending reviews is
 * AdminMarketReviewsController's. No route opens a market directly (#21, ADR-0100): the worker
 * opens a SCHEDULED one at its scheduled open, and an approval or a reschedule that finds that
 * instant come opens it at once — the interim draft → open route is gone. After the open the
 * PATCH changes an open or paused market's category, tags and image only: its rule version's items
 * change by a supplement (#80, ADR-0101, AdminMarketSupplementsController). No route closes a
 * market directly either (#114, ADR-0102): the worker closes it at its close, and an early close is
 * a paused market's next path another admin approves (AdminMarketPausesController) — the interim
 * one-admin `POST …/close` is gone. Nor does any route judge a market at once (#152, ADR-0103): one
 * admin registers a CLOSED market's judgement and another approves it, publishing the provisional
 * result (AdminMarketJudgementsController), and the worker confirms it once its dispute deadline
 * has passed with no 판정 이의 pending or accepted holding it (#175, ADR-0104) — the interim
 * one-admin `POST …/resolve` is gone.
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/markets')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminMarketsController {
  constructor(
    private readonly markets: MarketAdminService,
    private readonly related: RelatedMarketsService,
  ) {}

  @Post(':id/liquidity-settings')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminSetMarketLiquidity',
    summary: 'Record a draft liquidity version with a reason; review and opening lock it',
  })
  @ApiData(adminMarketSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminSetMarketLiquidity(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: setMarketLiquidityBodySchema }) body: SetMarketLiquidityBody,
  ): Promise<AdminMarket> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.markets.setLiquidity(admin.id, id, body);
  }

  @Get()
  @ApiOperation({
    operationId: 'adminListMarkets',
    summary:
      'Every market, draft and in-review ones included, newest first; q narrows it to titles ' +
      'holding the term (a case-insensitive partial match), as the related-market picker searches',
  })
  // No `@ApiQuery`: `adminMarketListQuerySchema` has no component id, so swagger expands it
  // into the cursor/limit/status/q parameters itself (see markets.controller.ts).
  @ApiPageOf(marketSummarySchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async adminListMarkets(
    @Query({ schema: adminMarketListQuerySchema }) query: AdminMarketListQuery,
  ): Promise<ApiPage<MarketSummary>> {
    const { items, nextCursor } = await this.markets.list(query);
    return new ApiPage(items, { nextCursor });
  }

  /**
   * 관련 시장 (#65, ADR-0068): the market's links, every status of the market at the other end —
   * the admin keeps a link whatever either market's state, and the detail filters what it shows.
   * Unpaginated: it is the list the links are managed from, one market's, made by admins.
   */
  @Get(':id/related')
  @ApiOperation({
    operationId: 'adminListRelatedMarkets',
    summary: 'The markets linked to this one, any status, the latest link first, with who linked',
  })
  @ApiData(adminRelatedMarketSchema.array())
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminListRelatedMarkets(
    @Param('id', { schema: uuidParamSchema }) id: string,
  ): Promise<AdminRelatedMarket[]> {
    return this.related.listAdmin(id);
  }

  @Post(':id/related')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminLinkRelatedMarket',
    summary:
      'Link another market to this one, two-way, in any status of either; linking a linked ' +
      'pair changes nothing. Answers the links as they stand',
  })
  @ApiData(adminRelatedMarketSchema.array())
  // VALIDATION_ERROR names `marketId` for the market itself; NOT_FOUND names it for an unknown
  // one (an unknown market in the path is a plain NOT_FOUND). FORBIDDEN names `expectedAccountId`
  // for another account's (as on every write here).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminLinkRelatedMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: linkRelatedMarketBodySchema }) body: LinkRelatedMarketBody,
  ): Promise<AdminRelatedMarket[]> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.related.link(admin.id, id, body.marketId);
  }

  @Delete(':id/related/:relatedMarketId')
  @ApiOperation({
    operationId: 'adminUnlinkRelatedMarket',
    summary:
      'Unlink two markets; unlinking a pair that is not linked changes nothing. Answers the ' +
      "path market's links as they stand",
  })
  @ApiData(adminRelatedMarketSchema.array())
  // The link's refusals, naming the path's `relatedMarketId` where the link names the body's
  // `marketId`: VALIDATION_ERROR for the market itself, NOT_FOUND for an unknown one (an unknown
  // market in the first path segment is a plain NOT_FOUND).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminUnlinkRelatedMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Param('relatedMarketId', { schema: uuidParamSchema }) relatedMarketId: string,
    @Query({ schema: expectedAccountQuerySchema }) query: ExpectedAccountQuery,
  ): Promise<AdminRelatedMarket[]> {
    assertExpectedAccount(admin.id, query.expectedAccountId);
    return this.related.unlink(admin.id, id, relatedMarketId);
  }

  @Get(':id')
  @ApiOperation({
    operationId: 'adminGetMarket',
    summary:
      'One market with its tags, exposure, settlement steps, event log, what the open-items ' +
      'check finds missing, its review (the pending request, the creator, the editors, the ' +
      'unfinished markets with the same conditions and the review log), its rule versions with ' +
      'who asked for and made each and its supplement requests (the waiting one and the log)',
  })
  @ApiData(adminMarketSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminGetMarket(@Param('id', { schema: uuidParamSchema }) id: string): Promise<AdminMarket> {
    return this.markets.get(id);
  }

  @Post()
  @ApiOperation({
    operationId: 'adminCreateMarket',
    summary:
      'Create a draft market (no price until its first fill) with up to 5 tags in order; a new ' +
      'tag name makes the tag, one differing only in case or spaces links the existing tag; ' +
      'rule items and times not sent start blank; times out of order are refused naming both ends',
  })
  @ApiData(adminMarketSchema, 201)
  // NOT_FOUND names `categoryId`; VALIDATION_ERROR names, in this order, `fallbackCondition` (a
  // switch condition with no fallback source: 'no fallback source'), `closeAt` (not in the future),
  // `categoryId` (one no new market may be filed under: the reason — inactive, parent_inactive,
  // subcategories — is the message), both ends of each broken time order rule (#22: scheduled
  // open < close ≤ scheduled judgement, event deadline ≤ scheduled judgement, in whole minutes;
  // the ends the body sent first, TIME_RULE_MESSAGES) and `slug` (taken, at the insert), besides
  // the body schema's own issues, `tags.N` among them (a duplicate ignoring case and spaces, a bad
  // name), the sources' nested paths (`primarySource.url`, `fallbackSources.N.url`; 'empty source'
  // at the source itself) and `judgementTimeZone` (not an IANA name). The lead close is never
  // refused on a draft: the open-items check names it.
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminCreateMarket(
    @CurrentUser() admin: SessionUser,
    @Body({ schema: createMarketBodySchema }) body: CreateMarketBody,
  ): Promise<AdminMarket> {
    // The fields alone: the `created` event keeps them as sent.
    const { expectedAccountId, ...fields } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.markets.create(admin.id, fields);
  }

  @Patch(':id')
  @ApiOperation({
    operationId: 'adminUpdateMarket',
    summary:
      'Edit a draft (any field) or an open or paused market (its category, tags and image ' +
      'only: slug refused naming the field, no tags refused naming tags, and its title, rule ' +
      'items and times — its rule version’s items — change by a supplement alone, each one ' +
      'changed refused naming it); tags and fallbackSources replace the whole ordered list; ' +
      'other statuses refuse naming status — review and scheduled are locked (send back to a ' +
      'draft to edit; reschedule moves a scheduled open)',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `categoryId` as on create unless it is the market's current one (no
  // change, not checked: a market keeps a category hidden after it was filed), and
  // `fallbackCondition` when a draft's edit of the sources or the condition leaves a switch
  // condition with no fallback source. An open or paused market's edit that changes a version
  // item (#80: the title, a rule item or a time) names each, in RULE_VERSION_ITEMS order,
  // 'supplement only while open' — the stored value again (an instant however spelled, a text
  // however padded) is no change; `POST /admin/markets/{id}/supplements` changes them. A draft's
  // times (#22): `closeAt` 'must be in the future'; a result out of order names both ends of each
  // broken rule, the ends the body sent first; the lead close is never refused on a draft. Order:
  // status, slug, a version item after the open, tags, fallbackCondition, category, closeAt in
  // the future, the order.
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminUpdateMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: updateMarketBodySchema }) body: UpdateMarketBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...fields } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.markets.update(admin.id, id, fields);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminSubmitMarket',
    summary:
      'draft → review (검수 제출): refused with OPEN_ITEMS_MISSING when the open-items check finds ' +
      'the title, a rule item, a time, the time order, the lead close, the category or the tags ' +
      'missing, then with a past closeAt; opens the review request another admin decides, ' +
      'stores the lead-close gap it checked against and locks the content (no edit in review or ' +
      'scheduled)',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `status` (not a draft) or `closeAt` ('must be in the future');
  // OPEN_ITEMS_MISSING names every missing item, in OPEN_ITEMS order, and comes before the close:
  // `timeOrder`'s message the broken order rules, `leadClose`'s 'leadClose', or 'gap undecided'
  // while `market.lead_close_gap` is. The scheduled open is not asked: a market approved after it
  // opens at the approval (#21).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'OPEN_ITEMS_MISSING',
  )
  adminSubmitMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: expectedAccountBodySchema }) body: ExpectedAccountBody,
  ): Promise<AdminMarket> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.markets.submit(admin.id, id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminApproveMarket',
    summary:
      'review → scheduled (승인) by an admin who neither created, edited nor submitted the ' +
      'market, every checklist item confirmed, with a reason; the open-items check and the close ' +
      'are checked again. The market becomes public as scheduled — and opens at once (status ' +
      'open) when its scheduled open has passed; otherwise it opens at its scheduled open',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names, from the body, `requestId`, `checklist` ('every item must be
  // confirmed'; an unknown item at `checklist.N`) or `reason` (blank, over 500), before anything
  // is read; then `status` (not in review), `requestId` 'unknown' (no request of this market's
  // review) and, after the checks below, `closeAt` ('must be in the future').
  // APPROVAL_NOT_ALLOWED's `details[0]` is `{path: ['request'], message}`, the first exclusion
  // that holds: `creator`, `editor` (any market_update or market_reschedule record on it, any
  // time), `requester` (the submitter) — or `retracted`/`decided` when `requestId` names a request
  // no longer pending (a market sent back and submitted again). OPEN_ITEMS_MISSING as on submit,
  // at the gap the submission stored.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
    'OPEN_ITEMS_MISSING',
  )
  adminApproveMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: approveMarketReviewBodySchema }) body: ApproveMarketReviewBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...approval } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.markets.approve(admin.id, id, approval);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRejectMarket',
    summary:
      'review → draft (반려) by an admin who may approve it, with a reason from the list and a ' +
      'description the creator reads in the review log',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `requestId`, `rejectReason` or `reason` from the body, then `status`
  // (not in review), then `requestId` 'unknown' (no request of this market's review).
  // APPROVAL_NOT_ALLOWED as on approve: `retracted`/`decided` for a request no longer pending,
  // then `creator`, `editor` or `requester`.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  adminRejectMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: rejectMarketReviewBodySchema }) body: RejectMarketReviewBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...rejection } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.markets.reject(admin.id, id, rejection);
  }

  @Post(':id/revert')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRevertMarket',
    summary:
      'review or scheduled → draft (되돌리기) by any admin, with a reason, to edit and review ' +
      'again; in review the pending request is retracted when its submitter sends the market ' +
      'back and rejected with the reason when anyone else does',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `reason` from the body, then `status` (neither in review nor
  // scheduled).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminRevertMarket(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: revertMarketBodySchema }) body: RevertMarketBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...revert } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.markets.revert(admin.id, id, revert);
  }

  @Post(':id/reschedule')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRescheduleMarketOpen',
    summary:
      'Move a scheduled market’s scheduled open without a new review, with a reason; it stays ' +
      'before the close in whole minutes, and an instant already passed opens the market at ' +
      'once (status open: there is no early open, move the scheduled open earlier instead); ' +
      'once the close has passed it is refused (closeAt) — send the market back to a draft ' +
      '(revert) to fix its times',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `scheduledOpenAt` (not an instant, or before 1900) or `reason` from the
  // body, then `status` (not scheduled), then `closeAt` 'must be in the future' (the close has
  // passed), then `scheduledOpenAt` 'unchanged' (the stored instant), then the order:
  // `scheduledOpenAt` 'must be before closeAt' and `closeAt` 'must be after scheduledOpenAt', as
  // the PATCH names a broken rule (TIME_RULE_MESSAGES).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminRescheduleMarketOpen(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: rescheduleMarketOpenBodySchema }) body: RescheduleMarketOpenBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...reschedule } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.markets.reschedule(admin.id, id, reschedule);
  }

  @Post(':id/price-protection')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminChangeMarketPriceProtection',
    summary:
      'Change an open or paused market’s price-protection width in ticks (1..98), with a ' +
      'reason, by one admin; recorded with the value before and after, it applies to the ' +
      'immediate orders taken after it and never to resting ones',
  })
  @ApiData(adminMarketSchema)
  // VALIDATION_ERROR names `priceProtectionTicks` (not 1..98) or `reason` from the body, then
  // `status` (not open or paused), then `priceProtectionTicks` 'unchanged' (the stored width).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'NOT_FOUND', 'VALIDATION_ERROR')
  adminChangeMarketPriceProtection(
    @CurrentUser() admin: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: changePriceProtectionBodySchema }) body: ChangePriceProtectionBody,
  ): Promise<AdminMarket> {
    const { expectedAccountId, ...change } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.markets.changePriceProtection(admin.id, id, change);
  }
}
