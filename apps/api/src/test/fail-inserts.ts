// The upload suites' failing row: an upload whose object is stored but whose row cannot be written
// (ADR-0073 9-45, `removeUnrecordedUpload`) — a post's image (#46) and a profile image (#141).

import { schema, type Db } from '@buddha/db';
import { vi } from 'vitest';

/**
 * From now on until `restore`, an upload's row cannot be written (`media_objects`) — nor, with
 * `queueFails`, a key queued for removal (`media_deletions`), whether in a transaction or not: a
 * post's image writes its row in the write limits' transaction with its counted upload (#187,
 * `WriteLimitsService.take`), a profile image in the profile's transaction, and
 * `removeUnrecordedUpload` queues the key in a transaction of its own. Every other insert goes
 * through.
 */
export function failInserts(db: Db, queueFails = false): { restore: () => void } {
  const failure = (table: unknown) =>
    table === schema.mediaObjects
      ? new Error('row insert failed')
      : queueFails && table === schema.mediaDeletions
        ? new Error('queue insert failed')
        : null;
  const insert = db.insert.bind(db);
  const inserts = vi.spyOn(db, 'insert').mockImplementation((table) => {
    const error = failure(table);
    if (error) throw error;
    return insert(table);
  });
  const transaction = db.transaction.bind(db);
  const transactions = vi.spyOn(db, 'transaction').mockImplementation((work, config) =>
    transaction((tx) => {
      const txInsert = tx.insert.bind(tx);
      vi.spyOn(tx, 'insert').mockImplementation((table) => {
        const error = failure(table);
        if (error) throw error;
        return txInsert(table);
      });
      return work(tx);
    }, config),
  );
  return {
    restore: () => {
      inserts.mockRestore();
      transactions.mockRestore();
    },
  };
}
