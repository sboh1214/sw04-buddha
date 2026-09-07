import { type ArgumentsHost, Catch, Logger, type WsExceptionFilter } from '@nestjs/common';
import { type ErrorEnvelope } from '@buddha/shared';
import { type Socket } from 'socket.io';
import { AppError } from '../common/errors/app-error.js';

/**
 * Event a gateway failure is delivered on. Nest's own BaseWsExceptionFilter uses this name,
 * so a client that listens for it keeps working whatever raises.
 */
export const REALTIME_EXCEPTION_EVENT = 'exception';

/**
 * PLAN 7's error envelope for the socket. Applied gateway-scoped with `@UseFilters(...)`,
 * because the WS chain has no global filter to extend: @nestjs/websockets overrides
 * `ExceptionFiltersContext.getGlobalMetadata()` to return `[]`, so the global APP_FILTER
 * never sees a `@SubscribeMessage` handler. What would see it is the default
 * BaseWsExceptionFilter, which flattens everything into
 * `{ status: 'error', message: 'Internal server error' }` and loses the PLAN 7.4 `code` the
 * client maps to Korean copy.
 *
 * Two things reach it: the handler's own `AppError` for a payload the protocol rejects, and
 * the global pipe's NUL sweep, which runs on `@MessageBody()` even with no schema attached
 * (validation.pipe.ts) and is therefore the one throw a handler's `safeParse` cannot
 * pre-empt.
 */
@Catch()
export class RealtimeExceptionFilter implements WsExceptionFilter {
  private readonly logger = new Logger(RealtimeExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const client = host.switchToWs().getClient<Socket>();
    const envelope: ErrorEnvelope =
      exception instanceof AppError
        ? {
            error: {
              code: exception.code,
              message: exception.message,
              details: exception.details,
            },
          }
        : { error: { code: 'INTERNAL', message: 'Internal server error' } };
    if (!(exception instanceof AppError)) {
      // Same policy as ApiExceptionFilter: the body never leaks an unexpected message.
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    client.emit(REALTIME_EXCEPTION_EVENT, envelope);
  }
}
