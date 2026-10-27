import { type BlockList } from 'node:net';
import { Body, Controller, HttpCode, Inject, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  meSchema,
  recordConsentsBodySchema,
  setInterestCategoriesBodySchema,
  setOnboardingNicknameBodySchema,
  type Me,
  type RecordConsentsBody,
  type SetInterestCategoriesBody,
  type SetOnboardingNicknameBody,
} from '@buddha/shared';
import { type FastifyRequest } from 'fastify';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { clientAddress } from '../rate-limit/rate-limit.tracker.js';
import { UNCOUNTED_PEERS } from '../rate-limit/uncounted-peers.js';
import { OnboardedGuard } from './onboarded.guard.js';
import { OnboardingService } from './onboarding.service.js';

/**
 * 가입 직후 온보딩 (#58) under `/api/v1/me`: the consent step, the nickname step (which grants the
 * start Coin) and the interest categories. The 본인확인 between the first two is #183's
 * (`/me/phone-verification/*`), and where an account stands is `GET /me`'s `onboarding`.
 * Owner-only: the session decides whose onboarding is written, and every write names the account
 * the screen shows (`expectedAccountId`, assertExpectedAccount, as every owner write since
 * A-PG-24) — a window still showing account A after another one signed in as B would otherwise
 * record A's answers as B's consent, or spend B's nickname step and start Coin.
 */
@ApiTags('me')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me')
@UseGuards(SessionGuard)
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    @Inject(UNCOUNTED_PEERS) private readonly uncounted: BlockList,
  ) {}

  /**
   * The consent step (ADR-0069 decision 1 #57-4·#57-5): the items it asks answered at their current
   * version, the required ones agreed — every item the first time, and in the re-consent after a
   * revision that changed members' rights only the items it left behind. Also MY 설정's marketing
   * switch, which sends that answer alone (ADR-0072). The record keeps, beside each answer, the
   * time, the client address by the rate limit's rule (`clientAddress`: behind Caddy the visitor,
   * nobody behind loopback or a proxy RATE_LIMIT_UNCOUNTED_PEERS lists) and the browser's
   * `User-Agent`.
   */
  @Post('consents')
  @HttpCode(200)
  // Per account on top of the address bucket: every changed answer is a row that stays (the app
  // cannot rewrite one, and they are kept for the retention period), and the optional marketing
  // answer can be flipped at will (MY 설정's switch) — a scripted client must not grow one account's
  // history at the address bucket's pace times its addresses (ADR-0072 7-26).
  @RateLimit('consent')
  @ApiOperation({
    operationId: 'recordMyConsents',
    summary: 'Record consent answers: the items the consent step asks, or the marketing one alone',
  })
  @ApiData(meSchema)
  // FORBIDDEN: a mutation whose Origin is not ours, or a body whose `expectedAccountId` is not the
  // cookie's account (nothing recorded). VALIDATION_ERROR: no item, an item the account's consent
  // step asks left out, a version that is not the current one, or a required item not agreed.
  // RATE_LIMITED: the account's `consent` bucket.
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR', 'RATE_LIMITED')
  recordConsents(
    @CurrentUser() user: SessionUser,
    @Body({ schema: recordConsentsBodySchema }) body: RecordConsentsBody,
    @Req() request: FastifyRequest,
  ): Promise<Me> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    const userAgent = request.headers['user-agent'];
    return this.onboarding.recordConsents(user.id, body.consents, {
      ip: clientAddress(request.ip, this.uncounted),
      userAgent: typeof userAgent === 'string' && userAgent !== '' ? userAgent : null,
    });
  }

  /**
   * The nickname step (#57-6): the offered nickname unchanged confirms it; another one is held to
   * the rules. With it the server — having read the consent and the 본인확인 — grants the start Coin
   * (#70) or leaves it waiting for the amount; `startGrant` in the answer says which.
   */
  @Post('onboarding/nickname')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'setMyOnboardingNickname',
    summary: 'Set or confirm the nickname in the onboarding, and grant the start Coin',
  })
  @ApiData(meSchema)
  // ONBOARDING_REQUIRED: the consent or the verification is not done. NICKNAME_NOT_ALLOWED: the
  // rules, or another nickname once the step is done (`already_set`). VERIFICATION_REQUIRED: the
  // verification record went away while the step ran (a withdrawal).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'ONBOARDING_REQUIRED',
    'NICKNAME_NOT_ALLOWED',
    'VERIFICATION_REQUIRED',
  )
  setNickname(
    @CurrentUser() user: SessionUser,
    @Body({ schema: setOnboardingNicknameBodySchema }) body: SetOnboardingNicknameBody,
  ): Promise<Me> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.onboarding.setNickname(user.id, body.nickname);
  }

  /**
   * The interest categories (#57-7): after the start Coin, so for onboarded accounts only. An
   * empty list is the skip; either way the step is answered and not asked again.
   */
  @Put('interest-categories')
  @UseGuards(OnboardedGuard)
  @ApiOperation({
    operationId: 'setMyInterestCategories',
    summary: 'Set the interest categories (none: skip the step)',
  })
  @ApiData(meSchema)
  // ONBOARDING_REQUIRED: the consent, the verification or the nickname step is not done.
  // VALIDATION_ERROR: a category that does not exist or is not active (details name each).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR', 'ONBOARDING_REQUIRED')
  setInterestCategories(
    @CurrentUser() user: SessionUser,
    @Body({ schema: setInterestCategoriesBodySchema }) body: SetInterestCategoriesBody,
  ): Promise<Me> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.onboarding.setInterests(user.id, body.categoryIds);
  }
}
