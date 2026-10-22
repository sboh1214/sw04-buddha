import { type BlockList } from 'node:net';
import { Body, Controller, HttpCode, Inject, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  answerInterestsStepBodySchema,
  meSchema,
  recordConsentsBodySchema,
  setInterestCategoriesBodySchema,
  setOnboardingNicknameBodySchema,
  type AnswerInterestsStepBody,
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
import { OnboardingService } from './onboarding.service.js';

/**
 * 가입 직후 온보딩 (#58) under `/api/v1/me`: the consent step, the nickname step (which grants the
 * start Coin), the interests step, and MY 설정's interest categories (#41). The 본인확인 between the
 * first two is #183's (`/me/phone-verification/*`), and where an account stands is `GET /me`'s
 * `onboarding`.
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
   * The interests step (#57-7), from the onboarding's screen: the categories picked, or none — the
   * skip, which the screen also sends when the account leaves it, or the start-Coin notice before
   * it, without an answer, so the server records the skip (owner decision 2026-10-21 (2nd) answer
   * 2, ADR-0078). While the step is unanswered, within 24 hours of the nickname step
   * (INTERESTS_FIRST_ANSWER_WINDOW_HOURS, owner decision 2026-10-21 (3rd) answer 1), this is its
   * first answer: for onboarded accounts only, and let through a writing or an account restriction
   * (a first choice, owner decision 2026-10-21 answer 4). Past those hours the step's picks are a
   * change as in MY 설정 and its skip records the skip. Once answered, a skip changes nothing and
   * picks are a change as in MY 설정 (`PUT /me/interest-categories`). No OnboardedGuard: the service
   * asks the onboarding in its transaction (`assertPublicItemOnboarding`), as for MY 설정's write —
   * or, for the skip past those hours, which gives no public item a value, `assertOnboarded` alone.
   */
  @Post('onboarding/interests')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'answerMyInterestsStep',
    summary: 'Answer the onboarding interests step: categories picked, or none to skip it',
  })
  @ApiData(meSchema)
  // ONBOARDING_REQUIRED: the consent, the verification or the nickname step is not done, and the
  // write answers the step (picks or the skip while it is unanswered) or adds a category.
  // RESTRICTED (with its end): a category added under a writing restriction (#37-9, #185) once the
  // step is answered, or 24 hours after the nickname step while it is not.
  // VALIDATION_ERROR: a category that does not exist or is not active (details name each).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'ONBOARDING_REQUIRED',
    'RESTRICTED',
  )
  answerInterestsStep(
    @CurrentUser() user: SessionUser,
    @Body({ schema: answerInterestsStepBodySchema }) body: AnswerInterestsStepBody,
  ): Promise<Me> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.onboarding.answerInterestsStep(user.id, body.categoryIds);
  }

  /**
   * MY 설정's interest categories (#41): replaced by the list sent. Never the interests step's
   * first answer — an account that left the onboarding's screens skipped the step (owner decision
   * 2026-10-21 (2nd) answer 2), so a first pick here is a change like any later one. A category
   * added is for onboarded accounts only and refused under a restriction (#37-9); dropping picks
   * needs sign-in only, an account held back by a re-consent included (owner decision 2026-10-21
   * answer 2) — so no OnboardedGuard: the service asks the onboarding in its transaction for an
   * addition only (`assertPublicItemOnboarding`).
   */
  @Put('interest-categories')
  @ApiOperation({
    operationId: 'setMyInterestCategories',
    summary: 'Set the interest categories in MY settings (none: drop them all)',
  })
  @ApiData(meSchema)
  // ONBOARDING_REQUIRED: the consent, the verification or the nickname step is not done, and the
  // write adds a category. RESTRICTED (with its end): a category added under a writing
  // restriction (#37-9, #185) — dropping is open. VALIDATION_ERROR: a category that does not exist
  // or is not active (details name each).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION_ERROR',
    'ONBOARDING_REQUIRED',
    'RESTRICTED',
  )
  setInterestCategories(
    @CurrentUser() user: SessionUser,
    @Body({ schema: setInterestCategoriesBodySchema }) body: SetInterestCategoriesBody,
  ): Promise<Me> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.onboarding.setInterests(user.id, body.categoryIds);
  }
}
