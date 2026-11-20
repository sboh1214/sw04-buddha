import { inspect } from 'node:util';
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

/**
 * Drizzle's error for a query that failed (`DrizzleQueryError`): `Failed query: <sql>\nparams:
 * <values>` as its message, the values again as `params`, the driver's error as its `cause`.
 * Recognised by that shape rather than by class, so a second copy of drizzle-orm in the tree
 * cannot slip past it.
 */
interface FailedQuery {
  message: string;
  query: string;
  params: unknown[];
}

function isFailedQuery(value: unknown): value is FailedQuery {
  if (typeof value !== 'object' || value === null) return false;
  const { message, query, params } = value as Partial<Record<keyof FailedQuery, unknown>>;
  return typeof message === 'string' && typeof query === 'string' && Array.isArray(params);
}

/** A failed query's bound values, as the log writes them: how many there were, not what. */
function redactedParams(query: FailedQuery): string {
  return `[${String(query.params.length)} redacted]`;
}

/** Whether pino's serializer treats `value` as an error: anything with a string `message`. */
function isErrorLike(value: unknown): value is { message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

/**
 * Every failed query pino's serializer would write out of `error`: down its causes, and into the
 * fields it serializes as errors of their own — better-call's `APIError.body`, for one, has a
 * string `message` and keeps the same `cause` (not enumerable, so not in the response), so pino
 * writes the cause's message a second time under `body`.
 */
function failedQueriesIn(error: unknown, found = new Set<FailedQuery>(), seen = new Set()) {
  if (!isErrorLike(error) || seen.has(error)) return found;
  seen.add(error);
  if (isFailedQuery(error)) found.add(error);
  failedQueriesIn((error as { cause?: unknown }).cause, found, seen);
  const errors = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors)) for (const each of errors) failedQueriesIn(each, found, seen);
  for (const key in error) failedQueriesIn((error as Record<string, unknown>)[key], found, seen);
  return found;
}

/**
 * The API's `err` serializer: pino's own (`stdSerializers.err`), which writes an error's causes'
 * messages and stacks after its own, with the bound values of every failed query in it taken out.
 * The SQL stays — which statement failed, and why (the driver's error below it), is what an
 * operator reads the line for.
 *
 * Not cosmetic. A query's values are whatever the caller bound, and better-auth's session read
 * binds the session token itself: since better-auth 1.7.12 a failed `getSession` throws a 500
 * whose `cause` is drizzle's error, so every request a database failure stopped at SessionGuard
 * or the upload gate wrote the raw token of the cookie that sent it — in `message`, in `stack`,
 * and again in `body`'s (ADR-0152). Any other failed query wrote its values the same way — an
 * address, a name — which is why this is the serializer's job rather than one call site's.
 *
 * Only what the serializer built is rewritten (the objects on its own prototype); a field it
 * copied as it found it is the caller's object and is never touched.
 */
export function serializeError(error: unknown): unknown {
  const serialized: unknown = stdSerializers.err(error as Error);
  const queries = [...failedQueriesIn(error)];
  if (queries.length === 0 || serialized === error) return serialized;
  // The message drizzle built, swapped whole wherever pino copied it: the values are inside it
  // with nothing marking where they end. A function, so a `$1` in the SQL is not a pattern.
  const redact = (text: string): string =>
    queries.reduce(
      (written, query) =>
        written.replaceAll(
          query.message,
          () => `Failed query: ${query.query}\nparams: ${redactedParams(query)}`,
        ),
      text,
    );
  const built: unknown = Object.getPrototypeOf(serialized);
  const rewrite = (node: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') node[key] = redact(value);
      else if (Array.isArray(value) && key === 'aggregateErrors') value.forEach(rewriteBuilt);
      else rewriteBuilt(value);
    }
    // A failed query's own fields are copied as they are: `params` would carry the values.
    if (isFailedQuery(node)) Object.assign(node, { params: redactedParams(node) });
  };
  const rewriteBuilt = (value: unknown): void => {
    if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === built) {
      rewrite(value as Record<string, unknown>);
    }
  };
  rewrite(serialized as Record<string, unknown>);
  return serialized;
}

/**
 * The words and the stack of one line built from a logging call's arguments — joined as the
 * console joins them, except that an error is written as `serializeError` writes it, its type
 * and message (its causes' after its own), and the stack of the first one is handed back apart.
 * For loggers that take a message, not an error: better-auth's (auth.ts).
 */
export function describeLogArguments(args: readonly unknown[]): {
  message: string;
  stack?: string;
} {
  const words: string[] = [];
  let stack: string | undefined;
  for (const arg of args) {
    if (typeof arg === 'string') {
      words.push(arg);
      continue;
    }
    if (arg instanceof Error) {
      const written = serializeError(arg) as { type: string; message: string; stack: string };
      words.push(`${written.type}: ${written.message}`);
      stack ??= written.stack;
      continue;
    }
    words.push(inspect(arg, { depth: 4, breakLength: Infinity }));
  }
  return { message: words.join(' '), ...(stack === undefined ? {} : { stack }) };
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
      err: serializeError,
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
