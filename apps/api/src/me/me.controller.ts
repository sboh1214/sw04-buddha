import { Body, Controller, Get, HttpCode, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type FastifyRequest } from 'fastify';
import {
  type Me,
  type OkResult,
  type SetPasswordBody,
  type UpdateMeBody,
  type UpdateTimeZoneBody,
  meSchema,
  okResultSchema,
  setPasswordBodySchema,
  updateMeBodySchema,
  updateTimeZoneBodySchema,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { PasswordService } from '../auth/password.service.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { MeService } from './me.service.js';

/** PLAN 7.2: /api/v1/me. */
@ApiTags('me')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me')
@UseGuards(SessionGuard)
export class MeController {
  constructor(
    private readonly me: MeService,
    private readonly password: PasswordService,
  ) {}

  @Get()
  @ApiOperation({ operationId: 'getMe', summary: 'Profile, balance and linked sign-in methods' })
  @ApiData(meSchema)
  @ApiErrors('UNAUTHENTICATED', 'NOT_FOUND')
  getMe(@CurrentUser() user: SessionUser): Promise<Me> {
    return this.me.getMe(user.id);
  }

  @Post('password')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'setMyPassword',
    summary: 'Set the first password (after verification, or for a social-only account)',
  })
  @ApiData(okResultSchema)
  // FORBIDDEN: a mutation whose Origin is not ours (SessionGuard's CSRF check), or a body whose
  // `expectedAccountId` is not the cookie's account (details name the field) — refused before
  // better-auth is asked, so a tab still showing another account sets nobody's password.
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR')
  async setPassword(
    @CurrentUser() user: SessionUser,
    @Req() request: FastifyRequest,
    @Body({ schema: setPasswordBodySchema }) body: SetPasswordBody,
  ): Promise<OkResult> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    await this.password.setPassword(request.headers, body.newPassword);
    return { ok: true };
  }

  @Patch()
  @ApiOperation({ operationId: 'updateMe', summary: 'Change nickname' })
  @ApiData(meSchema)
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR')
  updateMe(
    @CurrentUser() user: SessionUser,
    @Body({ schema: updateMeBodySchema }) body: UpdateMeBody,
  ): Promise<Me> {
    return this.me.updateNickname(user.id, body.nickname);
  }

  /**
   * ADR-0063 (ADR-0061 #60-8): the time zone MY 설정 picked, or `null` to follow the browser
   * again. The web formats every member-screen time in it after hydration; the server only
   * stores it. The name is checked against Node's own Intl (`timeZoneSchema`), so a zone the
   * server cannot read is refused rather than stored.
   *
   * The body names the account the screen shows (`expectedAccountId`, assertExpectedAccount),
   * as the first password and the verification writes do: the cookie decides whose profile is
   * written, and a window still showing account A after another one signed in as B would otherwise
   * change B's zone while A's screen said it was saved — B's times move with nothing on screen to
   * say why.
   * Answers the whole profile like `PATCH /me`; the web takes the profile from it into `['me']`.
   */
  @Put('time-zone')
  @ApiOperation({
    operationId: 'updateMyTimeZone',
    summary: 'Set the time zone times are shown in (null: follow the browser)',
  })
  @ApiData(meSchema)
  // FORBIDDEN: a mutation whose Origin is not ours (SessionGuard's CSRF check), or a body whose
  // `expectedAccountId` is not the cookie's account (details name the field; nothing written).
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR')
  updateTimeZone(
    @CurrentUser() user: SessionUser,
    @Body({ schema: updateTimeZoneBodySchema }) body: UpdateTimeZoneBody,
  ): Promise<Me> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.me.updateTimeZone(user.id, body.timeZone);
  }
}
