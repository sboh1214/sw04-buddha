import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  releaseSettingChangeBodySchema,
  releaseSettingChangeListQuerySchema,
  releaseSettingChangeSchema,
  releaseSettingKeySchema,
  releaseSettingListQuerySchema,
  releaseSettingSchema,
  type ReleaseSetting,
  type ReleaseSettingChange,
  type ReleaseSettingChangeBody,
  type ReleaseSettingChangeListQuery,
  type ReleaseSettingListQuery,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { ReleaseSettingsService } from './release-settings.service.js';

/**
 * Release settings (#170) for admins: the items with their status and value, a change with a
 * reason, and the change records. Guards run in order: SessionGuard fills `request.auth` (401
 * without a session, 403 for a foreign Origin on a mutation), AdminGuard reads the role (403 for
 * a member) — the records included (N04 §6).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/release-settings')
@UseGuards(SessionGuard, AdminGuard)
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
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR')
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
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR')
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

  @Patch(':key')
  @ApiOperation({
    operationId: 'adminChangeReleaseSetting',
    summary:
      'Set the status and value of a release setting with a reason (recorded); `undecided` takes no value, the others require one that fits the item',
  })
  @ApiData(releaseSettingSchema)
  // NOT_FOUND: no registered item has this key. VALIDATION_ERROR: also a value that breaks the
  // status rule or the item's schema (details under `value`).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR')
  change(
    @CurrentUser() admin: SessionUser,
    @Param('key', { schema: releaseSettingKeySchema }) key: string,
    @Body({ schema: releaseSettingChangeBodySchema }) body: ReleaseSettingChangeBody,
  ): Promise<ReleaseSetting> {
    return this.settings.change(admin.id, key, body);
  }
}
