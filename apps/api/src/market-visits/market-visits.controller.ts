import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { recordMarketVisitBodySchema, type RecordMarketVisitBody } from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiErrors } from '../common/openapi/api-response.decorators.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { MarketVisitsService } from './market-visits.service.js';

/**
 * `POST /api/v1/me/market-visits` (#151, ADR-0170; owner answers 151-3, 151-4; ADR-0167 결정 6):
 * the web's market detail tells the API, once per open, that the signed-in member opened it.
 *
 * A write of its own, never a side effect of `GET /markets/:idOrSlug`: a GET writes nothing
 * (RFC 9110, ADR-0169 결정 9), and the detail's server render carries no cookie by design while
 * its background re-reads would fake later opens. The market travels in the body, not the path,
 * so the request log line every call leaves (method, path, address, time — logger.ts) never names
 * the market an account opened (결정 6: no time, address or referrer is kept with a visit; the
 * `POST /me/search-history` precedent, ADR-0066).
 *
 * Owner-only and onboarded (`SessionGuard, OnboardedGuard`): 151-4's only basis is the 처리방침
 * notice the onboarding's consent step carries, and a consent stops counting while a revision
 * that changed members' rights asks for it again. A restricted account is recorded (95-1). The
 * answer is 204 with no body whether or not a row was written — an admin's or an operating
 * account's visit writes nothing (151-3) and the answer does not say so. No bucket of its own:
 * rows are bounded by the primary key (one per account, public market and Korean date), and the
 * per-address bucket every route has applies.
 */
@ApiTags('market-visits')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me/market-visits')
@UseGuards(SessionGuard, OnboardedGuard)
export class MeMarketVisitsController {
  constructor(private readonly visits: MarketVisitsService) {}

  @Post()
  @HttpCode(204)
  @ApiOperation({
    operationId: 'recordMyMarketVisit',
    summary:
      "Record that the account opened a public market's detail today (KST): one row per account, " +
      'market and Korean date, a repeat merged; an admin’s or an operating account’s writes ' +
      'nothing. Answers 204 either way, with no body',
  })
  @ApiResponse({ status: 204, description: 'Recorded, merged into today’s row, or not kept' })
  // FORBIDDEN: a mutation whose Origin is not ours (SessionGuard's CSRF check), or a body whose
  // `expectedAccountId` is not the cookie's account (details name the field; nothing written).
  // NOT_FOUND: no public market with that id (DRAFT and REVIEW included).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR', 'ONBOARDING_REQUIRED')
  async record(
    @CurrentUser() user: SessionUser,
    @Body({ schema: recordMarketVisitBodySchema }) body: RecordMarketVisitBody,
  ): Promise<void> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    await this.visits.record(user.id, body.marketId);
  }
}
