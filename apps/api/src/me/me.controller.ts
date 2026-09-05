import { Body, Controller, Get, HttpCode, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type FastifyRequest } from 'fastify';
import {
  type Me,
  type OkResult,
  type SetPasswordBody,
  type UpdateMeBody,
  meSchema,
  okResultSchema,
  setPasswordBodySchema,
  updateMeBodySchema,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
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
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR')
  async setPassword(
    @Req() request: FastifyRequest,
    @Body({ schema: setPasswordBodySchema }) body: SetPasswordBody,
  ): Promise<OkResult> {
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
}
