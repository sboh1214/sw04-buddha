import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { type ErrorCode, type ErrorEnvelope } from '@buddha/shared';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { isRawResponse } from '../decorators/raw-response.decorator.js';
import { AppError } from '../errors/app-error.js';

/** Errors Fastify raises itself (JSON parse, payload too large) carry a statusCode. */
interface StatusCarrier {
  statusCode?: number;
  message?: string;
}

interface Rendered {
  status: number;
  body: unknown;
}

const CODE_BY_STATUS: Readonly<Partial<Record<number, ErrorCode>>> = {
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'NOT_FOUND',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
};

/** Maps an HTTP status from Nest/Fastify built-ins onto the closed PLAN 7.4 code set. */
export function codeForStatus(status: number): ErrorCode {
  const mapped = CODE_BY_STATUS[status];
  if (mapped) return mapped;
  // 400, 413, 415, 422 and any other client error: the request itself is malformed.
  return status >= 400 && status < 500 ? 'VALIDATION_ERROR' : 'INTERNAL';
}

function envelope(code: ErrorCode, message: string, details?: unknown): ErrorEnvelope {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/** Nest's built-in exceptions store `{ statusCode, message, error }`; extract the message. */
function httpExceptionMessage(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  const message = (response as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.map(String).join('; ');
  return exception.message;
}

/**
 * Catch-all filter: every failure leaves the API as the PLAN 7 error envelope
 * `{ error: { code, message, details? } }` with a documented code.
 *
 * - AppError: code/status/details as thrown.
 * - HttpException (guards, Nest 404, throttler 429): status mapped by codeForStatus.
 * - Fastify errors with statusCode (invalid JSON, body too large): same mapping.
 * - anything else: 500 INTERNAL, logged with the stack; the body never leaks the message.
 *
 * Handlers marked @RawResponse() (health) keep the HttpException body verbatim.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const { status, body } = this.render(exception, isRawResponse(request));

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${String(status)}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }
    void reply.status(status).send(body);
  }

  private render(exception: unknown, raw: boolean): Rendered {
    if (exception instanceof AppError) {
      return {
        status: exception.status,
        body: envelope(exception.code, exception.message, exception.details),
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (raw) return { status, body: exception.getResponse() };
      return { status, body: envelope(codeForStatus(status), httpExceptionMessage(exception)) };
    }
    const carried = (exception as StatusCarrier | null)?.statusCode;
    if (typeof carried === 'number' && carried >= 400 && carried < 500) {
      const message = (exception as StatusCarrier).message ?? 'Bad request';
      return { status: carried, body: envelope(codeForStatus(carried), message) };
    }
    // The JSON body parser installed by @thallesp/nestjs-better-auth throws a bare
    // SyntaxError (no statusCode) on malformed JSON; that is a client error, not a 500.
    if (exception instanceof SyntaxError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: envelope('VALIDATION_ERROR', 'Malformed JSON body'),
      };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: envelope('INTERNAL', 'Internal server error'),
    };
  }
}
