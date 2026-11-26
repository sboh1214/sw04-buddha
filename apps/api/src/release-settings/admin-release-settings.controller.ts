import {
  Body,
  Controller,
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
  expectedAccountBodySchema,
  releaseSettingChangeBodySchema,
  releaseSettingChangeListQuerySchema,
  releaseSettingChangeRequestListQuerySchema,
  releaseSettingChangeRequestSchema,
  releaseSettingChangeRequestWriteSchema,
  releaseSettingChangeResultSchema,
  releaseSettingChangeSchema,
  releaseSettingDecisionBodySchema,
  releaseSettingKeySchema,
  releaseSettingListQuerySchema,
  releaseSettingSchema,
  uuidParamSchema,
  type ExpectedAccountBody,
  type ReleaseSetting,
  type ReleaseSettingChange,
  type ReleaseSettingChangeBody,
  type ReleaseSettingChangeListQuery,
  type ReleaseSettingChangeRequest,
  type ReleaseSettingChangeRequestListQuery,
  type ReleaseSettingChangeRequestWrite,
  type ReleaseSettingChangeResult,
  type ReleaseSettingDecisionBody,
  type ReleaseSettingListQuery,
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
import { ReleaseSettingsService } from './release-settings.service.js';

/**
 * Release settings (#170) for admins: the items with their status and value, a change with a
 * reason — one admin's at once or another admin's approval, as the item's rule says (#331,
 * ADR-0175) — the change requests and their decisions, and the change records. Guards run in order: SessionGuard fills `request.auth` (401
 * without a session, 403 for a foreign Origin on a mutation), AdminGuard reads the role (403 for
 * a member) — the records included (N04 §6) — and OnboardedGuard refuses an admin that has not
 * finished the onboarding (409 ONBOARDING_REQUIRED, ADR-0072).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/release-settings')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminReleaseSettingsController {
  constructor(private readonly settings: ReleaseSettingsService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListReleaseSettings',
    summary:
      'Every registered release setting with its status and value, in registry order; `status=undecided` lists the ones with no value',
  })
  // No `@ApiQuery`: the query schema has no component id, so swagger expands it itself.
  @ApiData(releaseSettingSchema.array())
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  list(
    @Query({ schema: releaseSettingListQuerySchema }) query: ReleaseSettingListQuery,
  ): Promise<ReleaseSetting[]> {
    return this.settings.list(query.status);
  }

  @Get('changes')
  @ApiOperation({
    operationId: 'adminListReleaseSettingChanges',
    summary:
      'Release setting changes, newest first: before and after, reason, admin and time (of one key with `key`)',
  })
  @ApiPageOf(releaseSettingChangeSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async listChanges(
    @Query({ schema: releaseSettingChangeListQuerySchema }) query: ReleaseSettingChangeListQuery,
  ): Promise<ApiPage<ReleaseSettingChange>> {
    const { items, nextCursor } = await this.settings.listChanges(
      query.key,
      query.cursor,
      query.limit,
    );
    return new ApiPage(items, { nextCursor });
  }

  @Get('change-requests')
  @ApiOperation({
    operationId: 'adminListReleaseSettingChangeRequests',
    summary:
      'Two-admin release setting change requests, newest first: before and after, why, who asked and the decision (of one status or key when given); a waiting one is `stale` once its item changed since',
  })
  @ApiPageOf(releaseSettingChangeRequestSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async listRequests(
    @Query({ schema: releaseSettingChangeRequestListQuerySchema })
    query: ReleaseSettingChangeRequestListQuery,
  ): Promise<ApiPage<ReleaseSettingChangeRequest>> {
    const { items, nextCursor } = await this.settings.listRequests(
      query.status,
      query.key,
      query.cursor,
      query.limit,
    );
    return new ApiPage(items, { nextCursor });
  }

  @Patch(':key')
  @ApiOperation({
    operationId: 'adminChangeReleaseSetting',
    summary:
      "Change a release setting's status and value with a reason: applied at once when the item's approval rule lets one admin (a reduction or stop, an observation value, closing order intake), otherwise recorded as a request another admin approves; `undecided` takes no value, the others require one that fits the item, and a change to the current status and value is refused",
  })
  @ApiData(releaseSettingChangeResultSchema)
  // NOT_FOUND: no registered item has this key. VALIDATION_ERROR: also a value that breaks the
  // status rule or the item's schema (details under `value`), and a change that keeps the
  // current status and value (path `[]`, RELEASE_SETTING_UNCHANGED_MESSAGE). FORBIDDEN: also a
  // body whose `expectedAccountId` is not the cookie's account (details name the field) — refused
  // before the key is looked up or locked (ADR-0092). RELEASE_SETTING_NOT_ALLOWED:
  // `request_pending` (a two-admin change of a key whose request waits). APPROVAL_NOT_ALLOWED:
  // `no_decider` (a two-admin change no other admin could decide).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'RELEASE_SETTING_NOT_ALLOWED',
    'APPROVAL_NOT_ALLOWED',
  )
  change(
    @CurrentUser() admin: SessionUser,
    @Param('key', { schema: releaseSettingKeySchema }) key: string,
    @Body({ schema: releaseSettingChangeBodySchema }) body: ReleaseSettingChangeBody,
  ): Promise<ReleaseSettingChangeResult> {
    const { expectedAccountId, ...change } = body;
    assertExpectedAccount(admin.id, expectedAccountId);
    return this.settings.submit(admin.id, key, change);
  }

  @Post('change-requests/:requestId/approve')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminApproveReleaseSettingChange',
    summary:
      "Approve another admin's release setting change request, writing the change in the same transaction (refused when the item changed since or the requester is no longer an admin)",
  })
  @ApiData(releaseSettingChangeRequestWriteSchema)
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ONBOARDING_REQUIRED',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'APPROVAL_NOT_ALLOWED',
    'RELEASE_SETTING_NOT_ALLOWED',
  )
  approve(
    @CurrentUser() admin: SessionUser,
    @Param('requestId', { schema: uuidParamSchema }) requestId: string,
    @Body({ schema: releaseSettingDecisionBodySchema }) body: ReleaseSettingDecisionBody,
  ): Promise<ReleaseSettingChangeRequestWrite> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.settings.approve(admin.id, requestId, body.reason);
  }

  @Post('change-requests/:requestId/reject')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRejectReleaseSettingChange',
    summary: "Reject another admin's release setting change request, changing nothing",
  })
  @ApiData(releaseSettingChangeRequestWriteSchema)
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
    @Body({ schema: releaseSettingDecisionBodySchema }) body: ReleaseSettingDecisionBody,
  ): Promise<ReleaseSettingChangeRequestWrite> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.settings.reject(admin.id, requestId, body.reason);
  }

  @Post('change-requests/:requestId/retract')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRetractReleaseSettingChange',
    summary: "Retract the acting admin's own waiting release setting change request",
  })
  @ApiData(releaseSettingChangeRequestWriteSchema)
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
  ): Promise<ReleaseSettingChangeRequestWrite> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.settings.retract(admin.id, requestId);
  }
}
