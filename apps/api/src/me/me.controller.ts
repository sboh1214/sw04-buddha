import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Me, type UpdateMeBody, meSchema, updateMeBodySchema } from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { SESSION_COOKIE } from '../openapi/document.js';
import { MeService } from './me.service.js';

/** PLAN 7.2: /api/v1/me. */
@ApiTags('me')
@ApiCookieAuth(SESSION_COOKIE)
@Controller('me')
@UseGuards(SessionGuard)
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get()
  @ApiOperation({ operationId: 'getMe', summary: 'Profile, balance and linked sign-in methods' })
  @ApiData(meSchema)
  @ApiErrors('UNAUTHENTICATED', 'NOT_FOUND')
  getMe(@CurrentUser() user: SessionUser): Promise<Me> {
    return this.me.getMe(user.id);
  }

  @Patch()
  @ApiOperation({ operationId: 'updateMe', summary: 'Change nickname' })
  @ApiData(meSchema)
  @ApiErrors('UNAUTHENTICATED', 'NOT_FOUND', 'VALIDATION_ERROR')
  updateMe(
    @CurrentUser() user: SessionUser,
    @Body({ schema: updateMeBodySchema }) body: UpdateMeBody,
  ): Promise<Me> {
    return this.me.updateNickname(user.id, body.nickname);
  }
}
