import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type RegisterBody,
  type RegisterResult,
  registerBodySchema,
  registerResultSchema,
} from '@buddha/shared';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { RegistrationService } from './registration.service.js';

/**
 * PLAN 7.1 public route. Sign-up takes the email only; the password is set after the
 * verification link proves the mailbox (ADR-0024). better-auth owns /api/auth/*, so this
 * lives under the versioned prefix at /api/v1/auth/register.
 */
@ApiTags('auth')
@Controller('auth')
export class RegisterController {
  constructor(private readonly registration: RegistrationService) {}

  @Post('register')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'register',
    summary: 'Start an email sign-up: mails the verification link',
  })
  @ApiData(registerResultSchema)
  @ApiErrors('VALIDATION_ERROR')
  async register(
    @Body({ schema: registerBodySchema }) body: RegisterBody,
  ): Promise<RegisterResult> {
    await this.registration.register(body.email);
    return { status: 'sent' };
  }
}
