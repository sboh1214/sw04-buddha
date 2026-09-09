import { type LoggerService } from '@nestjs/common';
import { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
import { pino, stdSerializers, type Logger, type LoggerOptions } from 'pino';
import { type Env } from './config/env.js';

/**
 * PLAN M6 "요청 로깅(pino)" for apps/api.
 *
 * Deliberately the same shape as `apps/worker/src/logger.ts`: same level defaults, the same
 * `LOG_LEVEL` override, the same dev-only pino-pretty transport. Two services of one system
 * whose logs are read side by side should not need two mental models, and the only difference
 * that earns itself is `name`.
 */
const defaultLevel: Record<Env['NODE_ENV'], string> = {
  development: 'debug',
  test: 'silent',
  production: 'info',
};

/**
 * The path of a request URL, without the query string.
 *
 * Not cosmetic. `GET /api/v1/admin/users?q=someone@example.com` is a real request this API
 * serves, and its query carries the address an admin searched for; logging it would put
 * personal data in a file that outlives the request and is shipped somewhere else. The route
 * pattern beside it (`/api/v1/admin/users`) is what an operator actually groups by, and the
 * parameters that matter for debugging are already in the handler's own log lines.
 *
 * A URL that does not parse is logged as-is rather than dropped: it is a request that really
 * arrived, and losing the line would lose the evidence.
 */
export function pathOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

export function createLoggerOptions(env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL'>): LoggerOptions {
  const options: LoggerOptions = {
    name: 'api',
    level: env.LOG_LEVEL ?? defaultLevel[env.NODE_ENV],
    /**
     * Fastify merges these over its own (`logger-factory.js` reads the instance's serializer
     * symbol), so `req`/`res` here replace the defaults it imported from pino-http. `req` is
     * the one that matters: the default logs `req.url` with its query string.
     */
    serializers: {
      req: (request: FastifyRequest) => ({
        method: request.method,
        url: pathOf(request.url),
        // The matched route, so 10,000 lines for 10,000 market ids still group into one.
        route: request.routeOptions.url,
        remoteAddress: request.ip,
      }),
      res: (reply: FastifyReply) => ({ statusCode: reply.statusCode }),
      err: stdSerializers.err,
    },
    /**
     * Defence in depth. Nothing above puts headers in a line, but a `logger.info({ req })` at
     * a call site that does would otherwise ship the session cookie — the credential itself —
     * to wherever these logs are collected.
     */
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'res.headers["set-cookie"]',
        'headers.cookie',
      ],
      remove: true,
    },
  };
  if (env.NODE_ENV === 'development') {
    // pino-pretty runs in a worker thread (pino.transport). It is a devDependency, so this
    // branch must never be taken outside development.
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
    };
  }
  return options;
}

export function createLogger(env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL'>): Logger {
  return pino(createLoggerOptions(env));
}

/**
 * Fastify logs a request twice by default — once on arrival, once on completion. Only the
 * second carries the status and `responseTime`, which is what the M6 acceptance criterion
 * ("홈 API p95 < 200ms") is measured from and what an operator reads, so the first is demoted
 * to `debug` rather than removed: on a request that never completes — a handler that hangs, a
 * client that disappears — the arrival line is the only evidence the request existed at all.
 *
 * `logController` rather than `disableRequestLogging`, which Fastify 5 deprecated in favour of
 * exactly this and will remove in 6.
 */
export class ApiLogController extends LogController {
  override incomingRequest(request: FastifyRequest): void {
    if (this.isLogDisabled(request)) return;
    request.log.debug({ req: request }, 'incoming request');
  }

  /**
   * Fastify's own completion line carries `{ res, responseTime }` and nothing else, because it
   * assumes the arrival line above it named the request. With that one at `debug` the info
   * stream would be a list of statuses and durations belonging to no route at all — unreadable,
   * and useless for the p95 the acceptance criterion asks for. So the request is repeated here:
   * one line per request, complete on its own.
   */
  override requestCompleted(
    error: Error | null | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    if (this.isLogDisabled(request)) return;
    const fields = { req: request, res: reply, responseTime: reply.elapsedTime };
    if (error) {
      reply.log.error({ ...fields, err: error }, 'request errored');
    } else {
      reply.log.info(fields, 'request completed');
    }
  }
}

/**
 * Nest's `Logger` on top of the pino instance, handed to `NestFactory.create` as its `logger`
 * option (main.ts) rather than installed afterwards with `app.useLogger`: everything Nest says
 * while it builds the container is emitted during `create`.
 *
 * Without it the API would print in two formats at once: pino JSON for requests and Nest's
 * own coloured console lines for everything a service logs (`ApiExceptionFilter`, `AdminGuard`,
 * `MarketGateway`, the bootstrap banner). One of the two would be unparseable wherever the
 * logs are collected, and it would be the half that says why a request failed.
 *
 * Nest's contract is loose — `error(message, stack?, context?)`, `log(message, context?)` — and
 * every variant arrives here as trailing parameters. The last string is taken as the context
 * (that is what `Logger` appends) and, for `error`, anything before it as the stack.
 */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  private write(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: unknown,
    params: unknown[],
  ): void {
    const rest = [...params];
    const context = typeof rest.at(-1) === 'string' ? (rest.pop() as string) : undefined;
    const stack = rest.length > 0 && typeof rest[0] === 'string' ? rest[0] : undefined;
    this.logger[level](
      { context, ...(stack === undefined ? {} : { stack }) },
      typeof message === 'string' ? message : JSON.stringify(message),
    );
  }
}
