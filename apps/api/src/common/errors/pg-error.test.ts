import { NotificationWriteError } from '@buddha/db';
import { describe, expect, it } from 'vitest';
import { PG_UNIQUE_VIOLATION, findPgError, isPgError } from './pg-error.js';

describe('findPgError', () => {
  it('reads the SQLSTATE a NotificationWriteError keeps as on a driver error (#54, ADR-0159)', () => {
    // createNotifications drops drizzle's wrapper and the driver's error (they carry the
    // recipients) and keeps their SQLSTATE and constraint on its own error.
    const refused = new NotificationWriteError('notification write failed: duplicate key', {
      code: PG_UNIQUE_VIOLATION,
      constraint: 'notification_keys_pkey',
    });
    expect(findPgError(refused)).toBe(refused);
    expect(isPgError(refused, PG_UNIQUE_VIOLATION, 'notification_keys_pkey')).toBe(true);
    expect(isPgError(refused, PG_UNIQUE_VIOLATION, 'another')).toBe(false);
    // A failure Postgres did not answer (a lost connection) has none.
    expect(findPgError(new NotificationWriteError('notification write failed: lost'))).toBe(
      undefined,
    );
  });
});
