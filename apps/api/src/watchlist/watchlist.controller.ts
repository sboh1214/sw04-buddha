import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  marketSummarySchema,
  updateWatchBodySchema,
  uuidParamSchema,
  watchStateSchema,
  watchlistQuerySchema,
  type MarketSummary,
  type UpdateWatchBody,
  type WatchState,
  type WatchlistQuery,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiPage } from '../common/interceptors/response-envelope.interceptor.js';
import { ApiData, ApiErrors, ApiPageOf } from '../common/openapi/api-response.decorators.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { WatchlistService } from './watchlist.service.js';

/**
 * `/api/v1/me/watchlist` (#89, ADR-0064): the caller's 관심 시장. Owner-only routes: the session
 * decides whose watchlist is read or written and nothing here takes another account (#37). The
 * server checks the session only, never the account's verification (ADR-0061 decision 3, #57);
 * the web's onboarding gate (ADR-0043, keyed on the verification since ADR-0070) is unchanged.
 * Counted like `PATCH /me`: the per-address bucket every route has, no named one.
 *
 * `watchlistQuerySchema` carries no `.meta({ id })`, so swagger expands it into one parameter per
 * field by itself (markets.controller.ts says why no `@ApiQuery` sits beside it).
 */
@ApiTags('watchlist')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me')
@UseGuards(SessionGuard)
export class MeWatchlistController {
  constructor(private readonly watchlist: WatchlistService) {}

  @Get('watchlist')
  @ApiOperation({
    operationId: 'getMyWatchlist',
    summary:
      'Markets the account watches, every public status unless status narrows it (an ended ' +
      'market stays until unwatched); category takes either level like GET /markets; sorted ' +
      'watched (most recently watched first, the default) or by the GET /markets orders',
  })
  @ApiPageOf(marketSummarySchema)
  @ApiErrors('UNAUTHENTICATED', 'VALIDATION_ERROR')
  async getWatchlist(
    @CurrentUser() user: SessionUser,
    @Query({ schema: watchlistQuerySchema }) query: WatchlistQuery,
  ): Promise<ApiPage<MarketSummary>> {
    const { items, nextCursor } = await this.watchlist.list(user.id, query);
    return new ApiPage(items, { nextCursor });
  }

  @Get('watchlist/:marketId')
  @ApiOperation({
    operationId: 'getMyWatch',
    summary: 'Whether the account watches one market (a draft or in-review one is NOT_FOUND)',
  })
  @ApiData(watchStateSchema)
  @ApiErrors('UNAUTHENTICATED', 'NOT_FOUND', 'VALIDATION_ERROR')
  getWatch(
    @CurrentUser() user: SessionUser,
    @Param('marketId', { schema: uuidParamSchema }) marketId: string,
  ): Promise<WatchState> {
    return this.watchlist.state(user.id, marketId);
  }

  /**
   * Watch (`watched: true`) or unwatch (`false`) one market, idempotently; only a change is
   * recorded (#95). One route with the state in the body rather than a PUT and a DELETE: the body
   * carries `expectedAccountId`, and OpenAPI 3.0 leaves a DELETE's body undefined.
   *
   * The body names the account the screen shows (`expectedAccountId`, assertExpectedAccount), as
   * the verification and the time zone do (ADR-0063): the cookie decides whose watchlist is
   * written, and a window still showing account A after another one signed in as B would otherwise
   * put the market on B's list — or take it off — while A's button said it was A's.
   */
  @Put('watchlist/:marketId')
  @ApiOperation({
    operationId: 'updateMyWatch',
    summary:
      'Watch or unwatch one market in any public status; repeating either changes nothing (a ' +
      'draft or in-review one is NOT_FOUND)',
  })
  @ApiData(watchStateSchema)
  // FORBIDDEN: a mutation whose Origin is not ours (SessionGuard's CSRF check), or a body whose
  // `expectedAccountId` is not the cookie's account (details name the field; nothing written).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR')
  updateWatch(
    @CurrentUser() user: SessionUser,
    @Param('marketId', { schema: uuidParamSchema }) marketId: string,
    @Body({ schema: updateWatchBodySchema }) body: UpdateWatchBody,
  ): Promise<WatchState> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.watchlist.set(user.id, marketId, body.watched);
  }
}
