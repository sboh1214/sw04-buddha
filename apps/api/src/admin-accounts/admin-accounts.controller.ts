import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  adminAccountIdSchema,
  adminAccountSchema,
  adminGrantBodySchema,
  adminRevokeBodySchema,
  adminRoleChangeListQuerySchema,
  adminRoleChangeSchema,
  type AdminAccount,
  type AdminGrantBody,
  type AdminRevokeBody,
  type AdminRoleChange,
  type AdminRoleChangeListQuery,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { AdminAccountsService } from './admin-accounts.service.js';

/**
 * Admin accounts (#171): the admins, a grant and a revoke with a reason (recorded), and the
 * record of both. Guards run in order: SessionGuard fills `request.auth` (401 without a session,
 * 403 for a foreign Origin on a mutation), AdminGuard reads the role (403 for a member) — the
 * records included (N04 §6: every admin may read them, owner decision 2026-10-13).
 *
 * A grant and a revoke name the admin the screen shows (`expectedAccountId`,
 * assertExpectedAccount): a mismatch with the cookie is refused before anything is read or
 * written, so a change is never recorded under an admin the user is not looking at, and the
 * answer's actor is the account the screen sent — a revoke is the screen's own exactly when its
 * answer's actor and target are that account.
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/admins')
@UseGuards(SessionGuard, AdminGuard)
export class AdminAccountsController {
  constructor(private readonly accounts: AdminAccountsService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListAdmins',
    summary: 'Every account that holds the admin role now, with its latest grant',
  })
  @ApiData(adminAccountSchema.array())
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN')
  list(): Promise<AdminAccount[]> {
    return this.accounts.list();
  }

  @Get('changes')
  @ApiOperation({
    operationId: 'adminListAdminChanges',
    summary:
      'Admin grants and revokes, newest first: account, admin, reason and time (of one account with `userId`)',
  })
  @ApiPageOf(adminRoleChangeSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR')
  async listChanges(
    @Query({ schema: adminRoleChangeListQuerySchema }) query: AdminRoleChangeListQuery,
  ): Promise<ApiPage<AdminRoleChange>> {
    const { items, nextCursor } = await this.accounts.listChanges(
      query.userId,
      query.cursor,
      query.limit,
    );
    return new ApiPage(items, { nextCursor });
  }

  @Post()
  @ApiOperation({
    operationId: 'adminGrantAdmin',
    summary:
      'Make an account an admin with a reason (recorded); only an account with a verified email and a real name and mobile number on file',
  })
  @ApiData(adminRoleChangeSchema, 201)
  // ROLE_CHANGE_NOT_ALLOWED: details[0].message is `already_admin`, `email_not_verified` or
  // `contact_required` (ADMIN_GRANT_REFUSALS). FORBIDDEN: also an actor revoked meanwhile, or a
  // body whose `expectedAccountId` is not the cookie's account (details name the field).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'ROLE_CHANGE_NOT_ALLOWED',
  )
  grant(
    @CurrentUser() admin: SessionUser,
    @Body({ schema: adminGrantBodySchema }) body: AdminGrantBody,
  ): Promise<AdminRoleChange> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.accounts.grant(admin.id, body.userId, body.reason);
  }

  @Post(':userId/revoke')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'adminRevokeAdmin',
    summary:
      "Take the admin role from an account (one's own included) with a reason (recorded) and sign it out everywhere; refused when fewer than two admins would remain",
  })
  @ApiData(adminRoleChangeSchema)
  // ROLE_CHANGE_NOT_ALLOWED: details[0].message is `not_admin` or `min_admins`
  // (ADMIN_REVOKE_REFUSALS). FORBIDDEN: also an actor revoked meanwhile, or a body whose
  // `expectedAccountId` is not the cookie's account (details name the field).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'ROLE_CHANGE_NOT_ALLOWED',
  )
  revoke(
    @CurrentUser() admin: SessionUser,
    @Param('userId', { schema: adminAccountIdSchema }) userId: string,
    @Body({ schema: adminRevokeBodySchema }) body: AdminRevokeBody,
  ): Promise<AdminRoleChange> {
    assertExpectedAccount(admin.id, body.expectedAccountId);
    return this.accounts.revoke(admin.id, userId, body.reason);
  }
}
