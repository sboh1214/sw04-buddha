import { Body, Controller, HttpCode, Post, Put, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  confirmPhoneVerificationBodySchema,
  phoneVerificationCodeSentSchema,
  phoneVerificationSchema,
  requestPhoneVerificationCodeBodySchema,
  updateRealNameBodySchema,
  type ConfirmPhoneVerificationBody,
  type PhoneVerification,
  type PhoneVerificationCodeSent,
  type RequestPhoneVerificationCodeBody,
  type UpdateRealNameBody,
} from '@buddha/shared';
import { type SessionUser } from '../auth/auth.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ApiData, ApiErrors } from '../common/openapi/api-response.decorators.js';
import { SESSION_SECURITY_SCHEME } from '../openapi/document.js';
import { RateLimit } from '../rate-limit/rate-limit.decorator.js';
import { PhoneVerificationService } from './phone-verification.service.js';

/**
 * 본인확인 (#183, ADR-0070) under `/api/v1/me`: the SMS code, its confirmation and the real-name
 * change of MY 설정. Owner-only: the session decides whose verification is written, and every
 * write names the account the screen shows (`expectedAccountId`, assertExpectedAccount, as every
 * owner write since A-PG-24) — a window still showing account A after another one signed in as B
 * would otherwise text a code for B, verify B with what A typed, or rename B. The record itself
 * is read on `GET /me` (`verification`), never on a public route.
 */
@ApiTags('me')
@ApiCookieAuth(SESSION_SECURITY_SCHEME)
@Controller('me')
@UseGuards(SessionGuard)
export class PhoneVerificationController {
  constructor(private readonly verification: PhoneVerificationService) {}

  @Post('phone-verification/code')
  @HttpCode(200)
  // Per account on top of the address bucket. The owner's limits (PHONE_VERIFICATION_LIMITED)
  // are what bound the texts; this bounds the refused requests a script can make of them.
  @RateLimit('phoneVerification')
  @ApiOperation({
    operationId: 'requestPhoneVerificationCode',
    summary:
      'Text a six-digit code to the mobile number, keeping the real name for the confirmation',
  })
  @ApiData(phoneVerificationCodeSentSchema)
  // FORBIDDEN: a mutation whose Origin is not ours (SessionGuard's CSRF check), or a body whose
  // `expectedAccountId` is not the cookie's account (details name the field; nothing sent).
  // PHONE_VERIFICATION_NOT_ALLOWED: verified already. SMS_SEND_FAILED: the provider did not
  // confirm the send — a refused one counts for nothing, one whose outcome is unknown counts
  // against the limits and its code can be confirmed (ADR-0070 decision 7-3).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'VALIDATION_ERROR',
    'PHONE_VERIFICATION_NOT_ALLOWED',
    'PHONE_VERIFICATION_LIMITED',
    'RATE_LIMITED',
    'SMS_SEND_FAILED',
  )
  requestCode(
    @CurrentUser() user: SessionUser,
    @Body({ schema: requestPhoneVerificationCodeBodySchema })
    body: RequestPhoneVerificationCodeBody,
  ): Promise<PhoneVerificationCodeSent> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.verification.requestCode(user.id, { realName: body.realName, phone: body.phone });
  }

  @Post('phone-verification/confirm')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'confirmPhoneVerification',
    summary: "Confirm the account's newest code: records the verified number and real name",
  })
  @ApiData(phoneVerificationSchema)
  // VERIFICATION_CODE_REJECTED: no code waiting, expired, discarded, or wrong (a wrong entry is
  // counted). PHONE_VERIFICATION_NOT_ALLOWED: verified already, or the number is another
  // account's (told only once the code matched).
  @ApiErrors(
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'VALIDATION_ERROR',
    'VERIFICATION_CODE_REJECTED',
    'PHONE_VERIFICATION_NOT_ALLOWED',
  )
  confirm(
    @CurrentUser() user: SessionUser,
    @Body({ schema: confirmPhoneVerificationBodySchema }) body: ConfirmPhoneVerificationBody,
  ): Promise<PhoneVerification> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.verification.confirm(user.id, body.code);
  }

  /**
   * The real name of a verified account (MY 설정, ADR-0069 decision 1 #57-3). The number is not
   * changed here or anywhere a member reaches: operators change it in the database.
   */
  @Put('real-name')
  @ApiOperation({ operationId: 'updateMyRealName', summary: 'Change the real name' })
  @ApiData(phoneVerificationSchema)
  // VERIFICATION_REQUIRED: the account has not verified, so it has no real name to change.
  @ApiErrors('UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR', 'VERIFICATION_REQUIRED')
  updateRealName(
    @CurrentUser() user: SessionUser,
    @Body({ schema: updateRealNameBodySchema }) body: UpdateRealNameBody,
  ): Promise<PhoneVerification> {
    assertExpectedAccount(user.id, body.expectedAccountId);
    return this.verification.updateRealName(user.id, body.realName);
  }
}
