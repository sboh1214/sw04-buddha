import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  RECENT_SEARCHES_LIMIT,
  recentSearchSchema,
  recordSearchBodySchema,
  searchHistoryWriteBodySchema,
  uuidParamSchema,
  type RecentSearch,
  type RecordSearchBody,
  type SearchHistoryWriteBody,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { SearchHistoryService } from './search-history.service.js';

const RECENT = `the newest ${String(RECENT_SEARCHES_LIMIT)} distinct terms, newest first`;

/**
 * `/api/v1/me/search-history` (#15, ADR-0066): the caller's 최근 검색. Owner-only routes: the
 * session decides whose history is read or written, and nothing here takes another account. The
 * search itself is public (`GET /markets?q=`, ADR-0061 decision 1, item 18); what a signed-in
 * member submitted is recorded here by the web, separately — so a signed-out search, a filter, a
 * page or a result count is never recorded (decision 3, the #15 rows). Every route is counted by
 * the per-address bucket every route has; the record is counted per account as well
 * (`searchHistory`), since each one is a row that stays.
 *
 * Every write names the account the screen shows (`expectedAccountId`, assertExpectedAccount), as
 * the time zone and the watch do (ADR-0063·0064): the cookie decides whose history is written, and
 * a window still showing account A after another one signed in as B would otherwise record A's
 * search into B's history, or clear B's. The deletes are POSTs with that body: the account id kept
 * out of the address, and OpenAPI 3.0 leaves a DELETE's body undefined (ADR-0064). Each write
 * answers the list as it is afterwards.
 */
@ApiTags('search-history')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me/search-history')
@UseGuards(SessionGuard)
export class MeSearchHistoryController {
  constructor(private readonly history: SearchHistoryService) {}

  @Get()
  @ApiOperation({
    operationId: 'getMySearchHistory',
    summary: `The account's recent searches: ${RECENT}`,
  })
  @ApiData(recentSearchSchema.array().max(RECENT_SEARCHES_LIMIT))
  @ApiErrors('UNAUTHENTICATED')
  getHistory(@CurrentUser() user: SessionUser): Promise<RecentSearch[]> {
    return this.history.list(user.id);
  }

  @Post()
  @HttpCode(200)
  // Per account on top of the address bucket: each record is a row that stays (no retention
  // limit), and a scripted client must not grow one account's history at the address bucket's
  // pace times its addresses. The web drops a refused record; the search goes ahead.
  @RateLimit('searchHistory')
  @ApiOperation({
    operationId: 'recordMySearch',
    summary: `Record one submitted search of the account; answers its recent searches (${RECENT})`,
  })
  @ApiData(recentSearchSchema.array().max(RECENT_SEARCHES_LIMIT))
  // FORBIDDEN: a mutation whose Origin is not ours (SessionGuard's CSRF check), or a body whose
  // `expectedAccountId` is not the cookie's account (details name the field; nothing written).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR', 'RATE_LIMITED')
  record(
    @CurrentUser() user: SessionUser,
    @Body({ schema: recordSearchBodySchema }) body: RecordSearchBody,
  ): Promise<RecentSearch[]> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.history.record(user.id, body.query);
  }

  /**
   * Deletes one entry of the recent list — every recorded search of its term, so no older search
   * of it takes its place. An id the account has no row for deletes nothing (a second press, or
   * an entry another tab deleted) and still answers the list.
   */
  @Post(':id/delete')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'deleteMySearch',
    summary:
      "Delete one recent search: every recorded search of the entry's term (an id the account " +
      `has none of deletes nothing); answers the recent searches (${RECENT})`,
  })
  @ApiData(recentSearchSchema.array().max(RECENT_SEARCHES_LIMIT))
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR')
  delete(
    @CurrentUser() user: SessionUser,
    @Param('id', { schema: uuidParamSchema }) id: string,
    @Body({ schema: searchHistoryWriteBodySchema }) body: SearchHistoryWriteBody,
  ): Promise<RecentSearch[]> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.history.delete(user.id, id);
  }

  @Post('clear')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'clearMySearchHistory',
    summary: 'Delete every recorded search of the account; answers the (empty) recent searches',
  })
  @ApiData(recentSearchSchema.array().max(RECENT_SEARCHES_LIMIT))
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR')
  clear(
    @CurrentUser() user: SessionUser,
    @Body({ schema: searchHistoryWriteBodySchema }) body: SearchHistoryWriteBody,
  ): Promise<RecentSearch[]> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.history.clear(user.id);
  }
}
