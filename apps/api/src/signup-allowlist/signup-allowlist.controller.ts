import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  expectedAccountBodySchema,
  signupAllowlistAddBodySchema,
  signupAllowlistAddResultSchema,
  signupAllowlistClearDecisionBodySchema,
  signupAllowlistClearRequestBodySchema,
  signupAllowlistClearWriteSchema,
  signupAllowlistRemoveBodySchema,
  signupAllowlistSchema,
  uuidParamSchema,
  type ExpectedAccountBody,
  type SignupAllowlist,
  type SignupAllowlistAddBody,
  type SignupAllowlistAddResult,
  type SignupAllowlistClearDecisionBody,
  type SignupAllowlistClearRequestBody,
  type SignupAllowlistClearWrite,
  type SignupAllowlistRemoveBody,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import type { SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { SignupAllowlistService } from './signup-allowlist.service.js';

/**
 * 가입 허용 목록 (#330, ADR-0174). Admins only, as every /admin route: SessionGuard, AdminGuard and
 * OnboardedGuard in that order (403 for a member, 409 for an admin who has not finished the
 * onboarding). Every write names the admin on screen (`expectedAccountId`, ADR-0092) and leaves its
 * admin record in the transaction of its effect; a number travels in a POST body only, never in a
 * path or a query (so no request log line carries one).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/signup-allowlist')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class SignupAllowlistController {
  constructor(private readonly allowlist: SignupAllowlistService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminGetSignupAllowlist',
    summary:
      'The signup allowlist: its entries (id and time added, never a number), how many open accounts verified a number off it, and the clear waiting for a decision',
  })
  @ApiData(signupAllowlistSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED')
  get(): Promise<SignupAllowlist> {
    return this.allowlist.get();
  }

  @Post()
  @ApiOperation({
    operationId: 'adminAddSignupAllowlist',
    summary:
      'Add numbers to the signup allowlist with one reason (recorded); a bad number refuses them all, one already on it is skipped',
  })
  @ApiData(signupAllowlistAddResultSchema, 201)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  add(
    @CurrentUser() admin: SessionUser,
    @Body({ schema: signupAllowlistAddBodySchema }) body: SignupAllowlistAddBody,
  ): Promise<SignupAllowlistAddResult> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.allowlist.add(admin.id, body);
  }

  @Post('remove')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRemoveSignupAllowlist',
    summary:
      'Take one number off the signup allowlist with a reason (recorded); never its last entry, which only an approved clear removes',
  })
  @ApiData(signupAllowlistSchema)
  // SIGNUP_ALLOWLIST_NOT_ALLOWED: `last_entry`. NOT_FOUND: the number is not on the list.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'SIGNUP_ALLOWLIST_NOT_ALLOWED',
  )
  remove(
    @CurrentUser() admin: SessionUser,
    @Body({ schema: signupAllowlistRemoveBodySchema }) body: SignupAllowlistRemoveBody,
  ): Promise<SignupAllowlist> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.allowlist.remove(admin.id, body);
  }

  @Post('clear-requests')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRequestSignupAllowlistClear',
    summary:
      'Ask another admin to approve emptying the signup allowlist (public launch: everyone may then sign up), with a reason and the typed confirmation',
  })
  @ApiData(signupAllowlistClearWriteSchema)
  // SIGNUP_ALLOWLIST_NOT_ALLOWED: `empty` or `clear_pending`. APPROVAL_NOT_ALLOWED: `no_decider`.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'VALIDATION_ERROR',
    'SIGNUP_ALLOWLIST_NOT_ALLOWED',
    'APPROVAL_NOT_ALLOWED',
  )
  requestClear(
    @CurrentUser() admin: SessionUser,
    @Body({ schema: signupAllowlistClearRequestBodySchema }) body: SignupAllowlistClearRequestBody,
  ): Promise<SignupAllowlistClearWrite> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.allowlist.requestClear(admin.id, body.reason);
  }

  @Post('clear-requests/:requestId/approve')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminApproveSignupAllowlistClear',
    summary:
      "Approve another admin's request and delete every entry of the signup allowlist in the same transaction",
  })
  @ApiData(signupAllowlistClearWriteSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  approve(
    @CurrentUser() admin: SessionUser,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: signupAllowlistClearDecisionBodySchema })
    body: SignupAllowlistClearDecisionBody,
  ): Promise<SignupAllowlistClearWrite> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.allowlist.approveClear(admin.id, requestId, body.reason);
  }

  @Post('clear-requests/:requestId/reject')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRejectSignupAllowlistClear',
    summary: "Reject another admin's request to empty the signup allowlist, keeping every entry",
  })
  @ApiData(signupAllowlistClearWriteSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  reject(
    @CurrentUser() admin: SessionUser,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: signupAllowlistClearDecisionBodySchema })
    body: SignupAllowlistClearDecisionBody,
  ): Promise<SignupAllowlistClearWrite> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.allowlist.rejectClear(admin.id, requestId, body.reason);
  }

  @Post('clear-requests/:requestId/retract')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRetractSignupAllowlistClear',
    summary: "Retract the acting admin's own request to empty the signup allowlist",
  })
  @ApiData(signupAllowlistClearWriteSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
  )
  retract(
    @CurrentUser() admin: SessionUser,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: expectedAccountBodySchema }) body: ExpectedAccountBody,
  ): Promise<SignupAllowlistClearWrite> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.allowlist.retractClear(admin.id, requestId);
  }
}
