import {
  type ArgumentsHost,
  Catch,
  HttpException,
  Logger,
  type WsExceptionFilter,
} from '@nestjs/common';
import { REALTIME_EXCEPTION_EVENT, errorEnvelope, type ErrorEnvelope } from '@buddha/shared';
import { type Socket } from 'socket.io';
import { AppError } from '../common/errors/app-error.js';
import { codeForStatus } from '../common/filters/api-exception.filter.js';

export { REALTIME_EXCEPTION_EVENT };

/** The socket's `socket.data`, as MarketGateway fills it; only the account is of interest here. */
interface SocketWithUser {
  data?: { userId?: string };
}

/**
 * PLAN 7's error envelope for the socket. Applied gateway-scoped with `@UseFilters(...)`,
 * because the WS chain has no global filter to extend: @nestjs/websockets overrides
 * `ExceptionFiltersContext.getGlobalMetadata()` to return `[]`, so the global APP_FILTER
 * never sees a `@SubscribeMessage` handler. What would see it is the default
 * BaseWsExceptionFilter, which flattens everything into
 * `{ status: 'error', message: 'Internal server error' }` and loses the PLAN 7.4 `code` the
 * client maps to Korean copy.
 *
 * Three things reach it: the handler's own `AppError` for a payload the protocol rejects, the
 * global pipe's NUL sweep — which runs on `@MessageBody()` even with no schema attached
 * (validation.pipe.ts) and is therefore the one throw a handler's `safeParse` cannot pre-empt —
 * and an `HttpException` from anything shared with the HTTP chain.
 *
 * It renders through the SAME `errorEnvelope` and the SAME status→code mapping as
 * ApiExceptionFilter. They used to build the envelope by hand in two files with two different
 * ideas of an absent `details`, and this filter had no mapping at all, so an `HttpException` a
 * shared guard or pipe threw arrived at the client as a bare `INTERNAL` with its 401 or 403
 * meaning erased.
 */
@Catch()
export class RealtimeExceptionFilter implements WsExceptionFilter {
  private readonly logger = new Logger(RealtimeExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const client = host.switchToWs().getClient<Socket>();
    const { envelope, internal } = render(exception);
    if (internal) {
      // The socket id and the account go in the MESSAGE, the stack in the stack slot. Nest's
      // `Logger.error(message, stack, context)` is positional, so passing the identity third
      // labels it as the context and passing the stack first makes the stack the message —
      // which is what the first version of this did, and it read as a stack trace belonging to
      // nobody. A WS failure has no `request completed` line beside it to say who was asking.
      const userId = (client as SocketWithUser).data?.userId ?? 'anonymous';
      this.logger.error(
        `socket=${client.id} user=${userId}`,
        exception instanceof Error ? exception.stack : String(exception),
        RealtimeExceptionFilter.name,
      );
    }
    client.emit(REALTIME_EXCEPTION_EVENT, envelope);
  }
}

/** The envelope, and whether the real cause was withheld from it (and so must be logged). */
function render(exception: unknown): { envelope: ErrorEnvelope; internal: boolean } {
  if (exception instanceof AppError) {
    return {
      envelope: errorEnvelope(exception.code, exception.message, exception.details),
      internal: false,
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    // Same rule as the REST filter: a 5xx never explains itself to the client.
    if (status < 500) {
      return { envelope: errorEnvelope(codeForStatus(status), exception.message), internal: false };
    }
  }
  return { envelope: errorEnvelope('INTERNAL', 'Internal server error'), internal: true };
}
