/**
 * ADR-0043's "real names and phone numbers never reach a log": what a failed contact upsert
 * leaves for ApiExceptionFilter to log. Runs everywhere (no TEST_* infrastructure).
 */
import { DrizzleQueryError } from 'drizzle-orm';
import { stdSerializers } from 'pino';
import { describe, expect, it } from 'vitest';
import { AppError } from '../common/errors/app-error.js';
import { contactWriteFailure } from './me.service.js';

const REAL_NAME = '홍길동';
const PHONE = '01012345678';

/** What drizzle 0.45 throws for a failed statement: the bound values in message and `params`. */
function failedUpsert(cause: unknown): DrizzleQueryError {
  return new DrizzleQueryError(
    'insert into "user_contacts" ("user_id", "real_name", "phone") values ($1, $2, $3)',
    ['user-1', REAL_NAME, PHONE],
    cause as Error,
  );
}

describe('contactWriteFailure', () => {
  it('keeps the SQLSTATE and drops every value, message, detail and cause', () => {
    // node-postgres quotes the row in `detail` for NOT NULL and CHECK violations.
    const driver = Object.assign(new Error('violates check constraint'), {
      code: '23514',
      detail: `Failing row contains (user-1, ${REAL_NAME}, ${PHONE}).`,
    });
    const failure = contactWriteFailure(failedUpsert(driver));

    expect(failure).toBeInstanceOf(AppError);
    expect(failure.code).toBe('INTERNAL');
    expect(failure.message).toBe('Saving the contact failed (SQLSTATE 23514)');
    expect(failure.cause).toBeUndefined();
    // The shape the filter's `request.log.error({ err })` writes, cause chain included.
    const logged = JSON.stringify(stdSerializers.err(failure));
    expect(logged).not.toContain(REAL_NAME);
    expect(logged).not.toContain(PHONE);
  });

  it('says so when there is no Postgres error behind it (a lost connection)', () => {
    const failure = contactWriteFailure(failedUpsert(new Error('Connection terminated')));
    expect(failure.message).toBe('Saving the contact failed (no SQLSTATE)');
    expect(failure.cause).toBeUndefined();
  });
});
