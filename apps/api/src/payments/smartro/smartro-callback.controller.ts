import {
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  type RawBodyRequest,
  Redirect,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { type FastifyRequest } from 'fastify';
import { RawResponse } from '../../common/decorators/raw-response.decorator.js';
import { readCallback } from './callback-form.js';
import { SmartroPayService } from './smartro-pay.service.js';

interface SeeOther {
  url: string;
  statusCode: 303;
}

/** 303, so the browser follows a POST with a GET of the wallet page (no resubmit on reload). */
function seeOther(url: string): SeeOther {
  return { url, statusCode: 303 };
}

/**
 * The three URLs SmartroPay calls (ADR-0042): `/api/v1/payments/smartro/{return,stop,notify}`,
 * mirrored in smartro-protocol.ts's SMARTRO_CALLBACK_PATH.
 *
 * PUBLIC on purpose — no SessionGuard: the mobile window's ReturnUrl POST comes from the
 * SmartroPay site, cross-site, without our cookie and with a foreign Origin, and the 재통보 is
 * server to server. Each finds its payment by Moid and trusts nothing a session would say.
 *
 * Outside the PLAN 7 envelope (@RawResponse: a redirect, or the plain `OK` SmartroPay reads) and
 * outside the OpenAPI document: this is the PG's contract, not the client's, and docs/API.md
 * describes it by hand (scripts/generate-api-doc.mjs).
 */
@ApiExcludeController()
@RawResponse()
@Controller('payments/smartro')
export class SmartroCallbackController {
  constructor(private readonly smartro: SmartroPayService) {}

  /** ReturnUrl: PC `approvalForm` (same-origin) or the mobile window (cross-site). */
  @Post('return')
  @Redirect()
  async smartroReturn(@Req() request: RawBodyRequest<FastifyRequest>): Promise<SeeOther> {
    return seeOther(await this.smartro.handleReturn(readCallback(request)));
  }

  /** StopUrl, as the SDK submits it (a POST form). */
  @Post('stop')
  @Redirect()
  async smartroStop(@Req() request: RawBodyRequest<FastifyRequest>): Promise<SeeOther> {
    return seeOther(await this.smartro.handleStop(readCallback(request)));
  }

  /** StopUrl followed as a link. */
  @Get('stop')
  @Redirect()
  async smartroStopLink(@Req() request: RawBodyRequest<FastifyRequest>): Promise<SeeOther> {
    // Fastify answers HEAD with this GET handler; a link checker or prefetcher is not the payer
    // closing the window, so HEAD changes nothing.
    if (request.method === 'HEAD') return seeOther(this.smartro.walletUrl(null, 'stopped'));
    return seeOther(await this.smartro.handleStop(readCallback(request)));
  }

  /**
   * 재통보 (신통보 parameters), registered by the operator in the merchant admin. Accepted only
   * from the mode's SmartroPay servers: `request.ip` is the visitor Caddy names in
   * X-Forwarded-For (main.ts `trustProxy`, TRUST_PROXY = Caddy alone), else the socket peer.
   */
  @Post('notify')
  @HttpCode(200)
  @Header('Content-Type', 'text/plain; charset=utf-8')
  smartroNotify(@Req() request: RawBodyRequest<FastifyRequest>): Promise<string> {
    return this.smartro.handleNotify(readCallback(request).fields, request.ip);
  }
}
