/**
 * The API's `err` serializer and the line builder better-auth's logger goes through (ADR-0152):
 * a failed query's bound values never reach the log; its SQL, its type and its causes do. The
 * whole path, with the real better-auth and a failing database, is session-read-log.test.ts's.
 */
import { APIError } from 'better-auth/api';
import { DrizzleQueryError } from 'drizzle-orm';
import { pino, stdSerializers } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { betterAuthLog } from './auth/auth.js';
import { createLoggerOptions, describeLogArguments, serializeError } from './logger.js';

const TOKEN = 'Xy7secretSessionToken0123456789AB';
const SQL = 'select "id", "token" from "session" where "session"."token" = $1';
const REDACTED = `Failed query: ${SQL}\nparams: [1 redacted]`;

/** drizzle's error for the session read, over the driver's. */
const failedRead = () =>
  new DrizzleQueryError(SQL, [TOKEN], new Error('Connection terminated unexpectedly'));

/** better-auth 1.7.26's `getSession` failure: its 500, drizzle's error as `cause`. */
const failedGetSession = () =>
  APIError.from(
    'INTERNAL_SERVER_ERROR',
    { message: 'Failed to get session', code: 'FAILED_TO_GET_SESSION' },
    { cause: failedRead() },
  );

describe('serializeError', () => {
  it('keeps the SQL, the causes and the error’s own fields, and drops the bound values', () => {
    const written = serializeError(failedGetSession()) as Record<string, unknown>;
    const text = JSON.stringify(written);
    expect(text).not.toContain(TOKEN);
    expect(written.type).toBe('APIError');
    expect(written.message).toBe(
      `Failed to get session: ${REDACTED}: Connection terminated unexpectedly`,
    );
    expect(written.stack).toContain(`caused by: Error: ${REDACTED}\n    at `);
    expect(written.stack).toContain('caused by: Error: Connection terminated unexpectedly');
    expect(written.statusCode).toBe(500);
    // better-call's `body` carries the same cause (unenumerable, so not in the response), and
    // pino writes it as an error of its own.
    expect(written.body).toMatchObject({
      message: `Failed to get session: ${REDACTED}: Connection terminated unexpectedly`,
      code: 'FAILED_TO_GET_SESSION',
    });
  });

  it('writes drizzle’s error itself with its query and the count of its values', () => {
    const written = serializeError(
      new DrizzleQueryError(
        'insert into "t" values ($1, $2)',
        ['someone@example.com', 'Hong'],
        undefined,
      ),
    ) as Record<string, unknown>;
    expect(JSON.stringify(written)).not.toMatch(/someone@example\.com|Hong/);
    expect(written).toMatchObject({
      type: 'DrizzleQueryError',
      message: 'Failed query: insert into "t" values ($1, $2)\nparams: [2 redacted]',
      query: 'insert into "t" values ($1, $2)',
      params: '[2 redacted]',
    });
  });

  it('takes a `$` in the SQL literally', () => {
    const query = `select '$&', '$$', $1`;
    const written = serializeError(new DrizzleQueryError(query, [TOKEN], undefined)) as {
      message: string;
    };
    expect(written.message).toBe(`Failed query: ${query}\nparams: [1 redacted]`);
  });

  it('reaches a failed query inside an AggregateError', () => {
    const written = serializeError(new AggregateError([failedRead()], 'both failed'));
    expect(JSON.stringify(written)).not.toContain(TOKEN);
    expect(JSON.stringify(written)).toContain('params: [1 redacted]');
  });

  it('leaves the error it was given as it was', () => {
    const error = failedGetSession();
    serializeError(error);
    const cause = error.cause as DrizzleQueryError;
    expect(cause.params).toEqual([TOKEN]);
    expect(cause.message).toContain(TOKEN);
    expect(cause.stack).toContain(TOKEN);
  });

  it('is pino’s own serializer for an error with no failed query in it', () => {
    const error = new Error('outer', { cause: new Error('inner') });
    expect(JSON.stringify(serializeError(error))).toBe(JSON.stringify(stdSerializers.err(error)));
    expect(serializeError('not an error')).toBe('not an error');
  });

  it('is the `err` serializer of the API’s logger', () => {
    const lines: string[] = [];
    const logger = pino(createLoggerOptions({ NODE_ENV: 'production' }), {
      write: (line: string) => void lines.push(line),
    });
    logger.error({ err: failedGetSession() }, 'unhandled failure');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(TOKEN);
    expect(lines[0]).toContain('params: [1 redacted]');
  });
});

describe('describeLogArguments', () => {
  it('joins the words, writes an error as its type and message, and hands its stack back apart', () => {
    const line = describeLogArguments(['INTERNAL_SERVER_ERROR', failedRead()]);
    expect(line.message).toBe(
      `INTERNAL_SERVER_ERROR DrizzleQueryError: ${REDACTED}: Connection terminated unexpectedly`,
    );
    expect(line.stack).toContain(`Error: ${REDACTED}\n    at `);
    expect(JSON.stringify(line)).not.toContain(TOKEN);
  });

  it('writes anything else as the console would, and no stack when there is no error', () => {
    expect(describeLogArguments(['Invalid id token', { provider: 'kakao' }])).toEqual({
      message: "Invalid id token { provider: 'kakao' }",
    });
  });
});

describe('betterAuthLog', () => {
  it('writes each of better-auth’s levels with the API’s logger, an error’s stack with it', () => {
    const logger = { debug: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const log = betterAuthLog(logger);
    log('error', 'INTERNAL_SERVER_ERROR', failedRead());
    log('warn', 'Invalid id token', { provider: 'kakao' });
    log('info', 'started');
    log('debug', 'detail');
    expect(logger.error).toHaveBeenCalledWith(
      `INTERNAL_SERVER_ERROR DrizzleQueryError: ${REDACTED}: Connection terminated unexpectedly`,
      expect.stringContaining(`Error: ${REDACTED}\n`),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(TOKEN);
    expect(logger.warn).toHaveBeenCalledWith("Invalid id token { provider: 'kakao' }");
    expect(logger.log).toHaveBeenCalledWith('started');
    expect(logger.debug).toHaveBeenCalledWith('detail');
  });
});
