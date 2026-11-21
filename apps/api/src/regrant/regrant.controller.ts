import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  IDEMPOTENCY_KEY_HEADER,
  adminRegrantListQuerySchema,
  adminRegrantSchema,
  applyRegrantBodySchema,
  applyRegrantResultSchema,
  regrantStatusSchema,
  type AdminRegrant,
  type AdminRegrantListQuery,
  type ApplyRegrantBody,
  type ApplyRegrantResult,
  type RegrantStatus,
} from '@buddha/shared';
import { AdminGuard } from '../auth/admin.guard.js';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import {
  IDEMPOTENCY_KEY_SCHEMA,
  IdempotencyKey,
} from '../common/decorators/idempotency-key.decorator.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { CURSOR_QUERY_PARAMS } from '../common/openapi/cursor-query.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { RegrantService } from './regrant.service.js';

/**
 * `/api/v1/me/regrant` (제한적 재지급, #74, ADR-0155): the member's own re-grant — the wallet card's
 * status and the request. Owner-only: the session decides whose account, and nothing here takes
 * another one. The status is a read, signed in is enough (as `GET /me/closure`): an account that
 * never finished the onboarding reads it too — it never got the start grant, so it reads
 * `no_start_grant`. One that only owes a re-consent (#57-5) did finish it once and may hold its
 * start grant: it reads its real status, `eligible` included. The request is behind
 * OnboardedGuard (409 ONBOARDING_REQUIRED, #57-8), like an order: Coin for trading, given to an
 * account that trades — the guard, outside the transaction, is what refuses that re-consent case.
 */
@ApiTags('wallet')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me/regrant')
@UseGuards(SessionGuard)
export class MeRegrantController {
  constructor(private readonly regrants: RegrantService) {}

  @Get()
  @ApiOperation({
    operationId: 'getMyRegrant',
    summary:
      'Whether a re-grant (재지급, #74) would be given now: open (every release setting of the ' +
      'six decided), eligible, every refusal that applies, in order, and the numbers the wallet ' +
      'shows — the amount, the threshold, the wait and when it ends, the period, its limit, the ' +
      're-grants used in it and when the next frees, the lifetime cap, what was given and what ' +
      'it leaves. Every number is null while not open',
  })
  @ApiData(regrantStatusSchema)
  @ApiErrors('UNAUTHENTICATED')
  status(@CurrentUser() user: SessionUser): Promise<RegrantStatus> {
    return this.regrants.status(user.id);
  }

  /**
   * Asks for the re-grant (owner answers 2026-11-21): given at once when every condition holds,
   * refused with every reason otherwise — nothing waits, and a refused request id may be sent
   * again. The body names the account the screen shows (`expectedAccountId`, ADR-0092), refused
   * before anything is read when it is not the cookie's.
   */
  @Post()
  @HttpCode(200)
  @UseGuards(OnboardedGuard)
  @ApiOperation({
    operationId: 'applyRegrant',
    summary:
      'Ask for a re-grant (재지급, #74): when the available Coin is at or below the threshold, no ' +
      'order waits, no contract of an unsettled market is held, the wait has passed and the ' +
      'period and the lifetime cap leave room, the release setting’s amount is issued to the ' +
      'account at once (ledger kind REGRANT). The same Idempotency-Key answers the re-grant it ' +
      'gave (replayed); a refusal writes nothing',
  })
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description:
      'The request id: client-generated, unique per account. Re-sending one that was granted ' +
      'answers that re-grant (replayed: true) and grants nothing more. A refusal records ' +
      'nothing, so its id may be sent again once the reasons are gone.',
    schema: IDEMPOTENCY_KEY_SCHEMA,
  })
  @ApiData(applyRegrantResultSchema)
  // VALIDATION_ERROR: the Idempotency-Key header, or the body (expectedAccountId and nothing
  // else). FORBIDDEN: a foreign Origin, or `expectedAccountId` not the cookie's. RESTRICTED: an
  // account restriction stands (#139), with its end. REGRANT_NOT_ALLOWED: the settings are not
  // all decided, or a condition fails — details are the status with every reason.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'RESTRICTED',
    'ONBOARDING_REQUIRED',
    'VALIDATION_ERROR',
    'REGRANT_NOT_ALLOWED',
  )
  apply(
    @CurrentUser() user: SessionUser,
    @IdempotencyKey() requestId: string,
    @Body({ schema: applyRegrantBodySchema }) body: ApplyRegrantBody,
  ): Promise<ApplyRegrantResult> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.regrants.apply(user.id, requestId);
  }
}

/**
 * 재지급 기록 (#74, ADR-0155; owner answer 3: the admin screen reads the records, nothing more —
 * no admin grants, adjusts or takes back Coin, ADR-0107) for admins: every account's re-grants,
 * newest first. Every admin reads them (ADR-0056 decision 1-2). Guards run in order: SessionGuard
 * (401 without a session), AdminGuard (403 for a member), then OnboardedGuard (409 for an admin
 * that has not finished the onboarding, ADR-0072). A read: no admin_actions row (admin-audit.test).
 */
@ApiTags('admin')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('admin/regrants')
@UseGuards(SessionGuard, AdminGuard, OnboardedGuard)
export class AdminRegrantsController {
  constructor(private readonly regrants: RegrantService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminListRegrants',
    summary:
      'Every re-grant given (재지급, #74), newest first: the account (id, public id, nickname — ' +
      'null once closed), the Coin given, the available Coin read when it was given and when',
  })
  @ApiQuery(CURSOR_QUERY_PARAMS[0])
  @ApiQuery(CURSOR_QUERY_PARAMS[1])
  @ApiPageOf(adminRegrantSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'ONBOARDING_REQUIRED', 'VALIDATION_ERROR')
  async list(
    @Query({ schema: adminRegrantListQuerySchema }) query: AdminRegrantListQuery,
  ): Promise<ApiPage<AdminRegrant>> {
    const page = await this.regrants.list(query);
    return new ApiPage(page.data, { nextCursor: page.meta.nextCursor });
  }
}
