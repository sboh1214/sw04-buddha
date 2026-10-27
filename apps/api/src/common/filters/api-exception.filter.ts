import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { errorEnvelope, type ErrorCode } from '@buddha/shared';
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
  /**
   * What the client is NOT told. Set whenever the real message was replaced by the generic
   * one, so the log keeps what the body drops; `undefined` when the body already says it.
   */
  hidden?: string;
  /** The envelope's code; `undefined` for a @RawResponse() body, which has none. */
  code?: ErrorCode;
}

const CODE_BY_STATUS: Readonly<Partial<Record<number, ErrorCode>>> = {
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'NOT_FOUND',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
};

/** The one message a 5xx body ever carries. */
const INTERNAL_MESSAGE = 'Internal server error';

/** Maps an HTTP status from Nest/Fastify built-ins onto the closed PLAN 7.4 code set. */
export function codeForStatus(status: number): ErrorCode {
  const mapped = CODE_BY_STATUS[status];
  if (mapped) return mapped;
  // 400, 413, 415, 422 and any other client error: the request itself is malformed.
  return status >= 400 && status < 500 ? 'VALIDATION_ERROR' : 'INTERNAL';
}

/**
 * What a refused (4xx) request's debug line says about its error: the error itself, except for
 * a SyntaxError — a body that did not parse, and V8 quotes part of that body in the message
 * (`Unexpected token 'x', "x{"realNam"... is not valid JSON`, or all of a short one). That can
 * be a real name, a phone number or a verification code (POST /me/phone-verification/*, PUT
 * /me/real-name, sign-up), which no log may hold (ADR-0042 「payment_events」, ADR-0043,
 * ADR-0070), so of a SyntaxError only its name, the status and the envelope code are logged.
 */
export function refusalLogFields(
  exception: unknown,
  status: number,
  code: ErrorCode | undefined,
): Record<string, unknown> {
  if (exception instanceof SyntaxError) return { status, code, errName: exception.name };
  return { err: exception };
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
 * - AppError: code and status as thrown; message and details only below 500 (see below).
 * - HttpException (guards, Nest 404, the rate limiter's 429): status mapped by codeForStatus.
 * - Fastify errors with statusCode (invalid JSON, body too large): same mapping.
 * - anything else: 500 INTERNAL.
 *
 * NO 5xx BODY CARRIES ITS OWN MESSAGE, whatever threw it (ADR-0020: "5xx는 스택을 로그로 남기되
 * 본문에는 노출하지 않는다"). That used to be true only of an unexpected `Error`, so the
 * thirty-odd `AppError('INTERNAL', { message: 'Ledger insert failed' })` this codebase throws —
 * and any `HttpException(…, 502)` — answered the caller with a sentence written for a developer
 * reading a stack trace: which table was written, which row was missing, which invariant broke.
 * That is a map of the internals handed to whoever asked. The message is not lost: `hidden`
 * below carries it into the log line, next to the request that produced it.
 *
 * Handlers marked @RawResponse() (health) keep the HttpException body verbatim.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const raw = isRawResponse(request);
    const { status, body, hidden, code } = this.render(exception, raw);

    // `request.log`, not a module-level Logger: it is the child bound to this request's `reqId`
    // (main.ts `genReqId`), so the failure and the `request completed` line that follows it can
    // be read as one story. Under `logger: false` — every test — it is a no-op.
    if (raw && exception instanceof HttpException) {
      // A @RawResponse() handler owns its own body, and an HttpException is how it ANSWERS with
      // an error status on purpose: `/api/health`'s 503 is a report (the probe found a
      // dependency down and said so). Logging that at `error` as "unhandled failure" would fill
      // the stream with the loudest line for a routine answer, and describe it wrongly — the
      // handler has already logged what it found.
      request.log.warn(
        { status, route: request.routeOptions.url },
        'raw-response route answered with an error status',
      );
    } else if (raw && status >= 500) {
      // Anything else a raw route throws is a real failure, logged like any other 5xx.
      request.log.error(
        { err: exception, hidden, route: request.routeOptions.url },
        `raw-response route failed: ${hidden ?? INTERNAL_MESSAGE}`,
      );
    } else if (raw) {
      request.log.debug(
        { ...refusalLogFields(exception, status, code), route: request.routeOptions.url },
        'request refused',
      );
    } else if (status >= 500) {
      request.log.error(
        { err: exception, hidden },
        `unhandled failure: ${hidden ?? INTERNAL_MESSAGE}`,
      );
    } else {
      // 4xx at DEBUG, not silence. A refused request is normal traffic and must not fill the
      // stream at info, but "every request from this address is a 401" is a fact an operator
      // needs to be able to see without adding code first.
      request.log.debug(refusalLogFields(exception, status, code), 'request refused');
    }
    void reply.status(status).send(body);
  }

  private render(exception: unknown, raw: boolean): Rendered {
    if (exception instanceof AppError) {
      return this.rendered(exception.status, exception.code, exception.message, exception.details);
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (raw) return { status, body: exception.getResponse() };
      return this.rendered(status, codeForStatus(status), httpExceptionMessage(exception));
    }
    const carried = (exception as StatusCarrier | null)?.statusCode;
    if (typeof carried === 'number' && carried >= 400 && carried < 500) {
      const message = (exception as StatusCarrier).message ?? 'Bad request';
      return this.rendered(carried, codeForStatus(carried), message);
    }
    // The JSON body parser installed by @thallesp/nestjs-better-auth throws a bare
    // SyntaxError (no statusCode) on malformed JSON; that is a client error, not a 500.
    if (exception instanceof SyntaxError) {
      return this.rendered(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Malformed JSON body');
    }
    return this.rendered(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL', INTERNAL_MESSAGE);
  }

  /** Builds the envelope, replacing the message of anything 5xx and remembering the original. */
  private rendered(status: number, code: ErrorCode, message: string, details?: unknown): Rendered {
    if (status < 500) return { status, body: errorEnvelope(code, message, details), code };
    // `details` is dropped with the message: it is authored by the same throw and can name a
    // column, a constraint or a row id just as freely.
    return {
      status,
      body: errorEnvelope(code, INTERNAL_MESSAGE),
      hidden: message === INTERNAL_MESSAGE ? undefined : message,
      code,
    };
  }
}
