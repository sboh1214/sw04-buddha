import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  accountClosureBodySchema,
  accountClosureCheckSchema,
  accountClosureResultSchema,
  type AccountClosureBody,
  type AccountClosureCheck,
  type AccountClosureResult,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { AccountClosureService } from './account-closure.service.js';

/**
 * `/api/v1/me/closure` (탈퇴, #140, ADR-0086): the member's own closure of the account — the
 * confirmation screen's read and the closure. Owner-only: the session decides whose account, and
 * nothing here takes another one; there is no operator's closure (#57-17). Sign-in only, no
 * OnboardedGuard: an account that never finished the onboarding, or one a re-consent holds back,
 * closes as well — leaving is not a write the onboarding gates (#57-8 names posts, likes, reports,
 * proposals and orders), as deleting one's own posts is not; the web's screen is outside the
 * onboarding gate for the same accounts (owner decision 2026-10-23 (2차) 3, ADR-0086).
 */
@ApiTags('me')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me/closure')
@UseGuards(SessionGuard)
export class MeClosureController {
  constructor(private readonly closure: AccountClosureService) {}

  @Get()
  @ApiOperation({
    operationId: 'getMyClosureCheck',
    summary:
      'What closing the account would do now: the Coin it forfeits, what refuses it, whether ' +
      'the start Coin was paid to it — its number gets none again — and whether a market proposal ' +
      'of it is still being processed (탈퇴, #140; #77)',
  })
  @ApiData(accountClosureCheckSchema)
  @ApiErrors('UNAUTHENTICATED', 'NOT_FOUND')
  check(@CurrentUser() user: SessionUser): Promise<AccountClosureCheck> {
    return this.closure.check(user.id);
  }

  /**
   * Closes the account at once (decision 4 #140: one confirmation, '탈퇴' typed, processed
   * immediately): the Coin left forfeited, the identifying data deleted, the public face
   * anonymised, every session ended. Irreversible (#57-17). The body names the account the screen
   * shows (`expectedAccountId`): a window still showing account A after another one signed in as B
   * must not close B.
   */
  @Post()
  @HttpCode(200)
  @ApiOperation({
    operationId: 'closeMyAccount',
    summary:
      "Close the account (탈퇴, #140): type '탈퇴'; forfeits the Coin left, deletes the identifying data and ends every session",
  })
  @ApiData(accountClosureResultSchema)
  // FORBIDDEN: a mutation whose Origin is not ours (SessionGuard's CSRF check), or a body whose
  // `expectedAccountId` is not the cookie's account (details name the field; nothing done).
  // VALIDATION_ERROR: the confirmation is not '탈퇴'. RESTRICTED: a writing or an account
  // restriction stands (decision 4 #140), with the one that ends later. CLOSURE_NOT_ALLOWED: the
  // admin role, a contract not settled, a payment in progress or an order waiting.
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'RESTRICTED',
    'CLOSURE_NOT_ALLOWED',
  )
  close(
    @CurrentUser() user: SessionUser,
    @Body({ schema: accountClosureBodySchema }) body: AccountClosureBody,
  ): Promise<AccountClosureResult> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.closure.close(user.id);
  }
}
