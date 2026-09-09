import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type RegisterBody,
  type RegisterResult,
  registerBodySchema,
  registerResultSchema,
} from '@buddha/shared';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
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
  // Keyed on the ADDRESS in the body, not on the caller (A-M2-10): this route puts mail in
  // somebody's inbox and hands out a sign-up bonus, so what has to be bounded is how often one
  // mailbox can be written to, however many clients ask. An unparseable body falls back to the
  // address bucket and is refused by the pipe a moment later.
  @RateLimit('email')
  @ApiOperation({
    operationId: 'register',
    summary: 'Start an email sign-up: mails the verification link',
  })
  @ApiData(registerResultSchema)
  @ApiErrors('VALIDATION_ERROR', 'RATE_LIMITED')
  async register(
    @Body({ schema: registerBodySchema }) body: RegisterBody,
  ): Promise<RegisterResult> {
    await this.registration.register(body.email);
    return { status: 'sent' };
  }
}
