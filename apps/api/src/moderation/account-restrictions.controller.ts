import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  accountRestrictionBodySchema,
  accountRestrictionDecisionSchema,
  accountRestrictionRequestQuerySchema,
  accountRestrictionRequestSchema,
  adminAccountIdSchema,
  approvalDecisionBodySchema,
  cancelModerationBodySchema,
  liftRestrictionBodySchema,
  shortenRestrictionBodySchema,
  uuidParamSchema,
  type AccountRestrictionDecision,
  type AccountRestrictionRequest,
  type AccountRestrictionRequestQuery,
  type ParsedAccountRestrictionBody,
  type ParsedApprovalDecisionBody,
  type ParsedCancelModerationBody,
  type ParsedLiftRestrictionBody,
  type ParsedShortenRestrictionBody,
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
import { AccountRestrictionService } from './account-restrictions.service.js';
import { ModerationReadsService } from './moderation-reads.service.js';

/** The errors of a request (#139): an operator action's. */
const REQUEST_ERRORS = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'ONBOARDING_REQUIRED',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'MODERATION_NOT_ALLOWED',
] as const;

/** The errors of a decision: a request's, and the two-person rule's refusal. */
const DECISION_ERRORS = [...REQUEST_ERRORS, 'APPROVAL_NOT_ALLOWED'] as const;

/**
 * 계정 제한 (#139, ADR-0085): `/api/v1/admin/moderation` — the requests to restrict a member's
 * account, to bring a restriction's end forward (감경), to lift it early (조기 해제) and to cancel
 * it, and their decisions by another admin (ADR-0056 decision 1-7: nothing is done until an admin
 * who neither asked nor is the member approves). Guards as on every admin route: SessionGuard,
 * AdminGuard, OnboardedGuard. A mutation names the admin the screen shows (`expectedAccountId`).
 * The restrictions themselves are read with every other action (`AdminModerationAction`, its
 * `approval` and `cancelApproval`).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/moderation')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminAccountRestrictionsController {
  constructor(
    private readonly restrictions: AccountRestrictionService,
    private readonly reads: ModerationReadsService,
  ) {}

  @Get('account-restriction-requests')
  @ApiOperation({
    operationId: 'adminListAccountRestrictionRequests',
    summary:
      'The account restriction requests: `pending` (default) — those waiting for another admin’s ' +
      'decision, the one waiting longest first, each with what approving it would be refused for ' +
      'now (`moot`) — or `decided` — the latest decision first. No asking or deciding admin on a ' +
      'request about the admin reading it (`aboutViewer`)',
  })
  @ApiPageOf(accountRestrictionRequestSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async listRequests(
    @CurrentUser() admin: SessionUser,
    @Query({ schema: accountRestrictionRequestQuerySchema }) query: AccountRestrictionRequestQuery,
  ): Promise<ApiPage<AccountRestrictionRequest>> {
    const { items, nextCursor } = await this.reads.requestQueue(query, admin.id);
    return new ApiPage(items, { nextCursor });
  }

  @Post('users/:userId/account-restriction')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRequestAccountRestriction',
    summary:
      'Ask for a member’s account to be restricted (계정 제한) for `days` (1, 3, 7 or 30) or with ' +
      'no end (`null`), with a reason and the explanation the member will read (required). ' +
      'Nothing is in force until another admin approves the request: then no new order, market ' +
      'proposal, public profile item’s new value or account closing (RESTRICTED, with the end) — ' +
      'writing, likes, reports and the watchlist stay open, and the term counts from the ' +
      'approval. With a subject (the member’s post, comment or profile) its pending reports are ' +
      'resolved on approval (조치함); one not the member’s is `not_theirs`; the acting admin is ' +
      '`own`',
  })
  @ApiData(accountRestrictionRequestSchema)
  @ApiErrors(...REQUEST_ERRORS)
  requestApply(
    @CurrentUser() admin: SessionUser,
    @Param('userId', { schema: adminAccountIdSchema }) userId: string,
    @Body({ schema: accountRestrictionBodySchema }) body: ParsedAccountRestrictionBody,
  ): Promise<AccountRestrictionRequest> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.restrictions.requestApply(admin.id, userId, body);
  }

  @Post('actions/:actionId/account-restriction/shorten')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRequestAccountRestrictionShorten',
    summary:
      'Ask for a standing account restriction’s end to be brought forward (감경) to `endsAt`, ' +
      'with a reason (operators only), done once another admin approves: still to come ' +
      '(`end_passed`) and earlier than its end now (`not_earlier`; any is, for one with no end). ' +
      'Not an account restriction is `not_account_restriction`, a cancelled one `cancelled`, one ' +
      'ended `ended`, one on the acting admin `own` — each asked again on approval',
  })
  @ApiData(accountRestrictionRequestSchema)
  @ApiErrors(...REQUEST_ERRORS)
  requestShorten(
    @CurrentUser() admin: SessionUser,
    @Param('actionId', { schema: uuidParamSchema }) actionId: string,
    @Body({ schema: shortenRestrictionBodySchema }) body: ParsedShortenRestrictionBody,
  ): Promise<AccountRestrictionRequest> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.restrictions.requestChange(
      admin.id,
      actionId,
      'shorten',
      body.reason,
      new Date(body.endsAt),
    );
  }

  @Post('actions/:actionId/account-restriction/lift')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRequestAccountRestrictionLift',
    summary:
      'Ask for a standing account restriction to be lifted early (조기 해제), with a reason ' +
      '(operators only): once another admin approves, it ends then and stays on the record as ' +
      'given. Refused as a shortening is (`not_account_restriction`, `cancelled`, `ended`, `own`)',
  })
  @ApiData(accountRestrictionRequestSchema)
  @ApiErrors(...REQUEST_ERRORS)
  requestLift(
    @CurrentUser() admin: SessionUser,
    @Param('actionId', { schema: uuidParamSchema }) actionId: string,
    @Body({ schema: liftRestrictionBodySchema }) body: ParsedLiftRestrictionBody,
  ): Promise<AccountRestrictionRequest> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.restrictions.requestChange(admin.id, actionId, 'lift', body.reason);
  }

  @Post('actions/:actionId/account-restriction/cancel')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRequestAccountRestrictionCancel',
    summary:
      'Ask for an account restriction to be cancelled (취소), with a reason (operators only): ' +
      'once another admin approves, it ends at once and the member reads it cancelled — an ended ' +
      'one too. Not an account restriction is `not_account_restriction`, a cancelled one ' +
      '`cancelled`, one on the acting admin `own`',
  })
  @ApiData(accountRestrictionRequestSchema)
  @ApiErrors(...REQUEST_ERRORS)
  requestCancel(
    @CurrentUser() admin: SessionUser,
    @Param('actionId', { schema: uuidParamSchema }) actionId: string,
    @Body({ schema: cancelModerationBodySchema }) body: ParsedCancelModerationBody,
  ): Promise<AccountRestrictionRequest> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.restrictions.requestChange(admin.id, actionId, 'cancel', body.reason);
  }

  @Post('account-restriction-requests/:requestId/approve')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminApproveAccountRestrictionRequest',
    summary:
      'Approve an account restriction request, with a reason, and do what it asks in the same ' +
      'transaction: restrict the account from now (its term counted from now), bring its end ' +
      'forward, lift it or cancel it. The admin who asked cannot (`APPROVAL_NOT_ALLOWED` ' +
      '`requester`), nor the member (`own`); a decided request is `decided`; what the restriction ' +
      'outgrew since the request is refused (`cancelled`, `ended`, `not_earlier`, `end_passed`) — ' +
      'reject it instead. Answers the request and the restriction as it stands',
  })
  @ApiData(accountRestrictionDecisionSchema)
  @ApiErrors(...DECISION_ERRORS)
  approve(
    @CurrentUser() admin: SessionUser,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: approvalDecisionBodySchema }) body: ParsedApprovalDecisionBody,
  ): Promise<AccountRestrictionDecision> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.restrictions.approve(admin.id, requestId, body.reason);
  }

  @Post('account-restriction-requests/:requestId/reject')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRejectAccountRestrictionRequest',
    summary:
      'Reject an account restriction request, with a reason: nothing is done. The way a request ' +
      'not wanted any more is closed — requests do not expire and the admin who asked cannot ' +
      'take one back. The admin who asked cannot (`requester`), nor the member (`own`); a ' +
      'decided request is `decided`',
  })
  @ApiData(accountRestrictionDecisionSchema)
  @ApiErrors(...DECISION_ERRORS)
  reject(
    @CurrentUser() admin: SessionUser,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: approvalDecisionBodySchema }) body: ParsedApprovalDecisionBody,
  ): Promise<AccountRestrictionDecision> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.restrictions.reject(admin.id, requestId, body.reason);
  }
}
