import { setTimeout } from 'node:timers/promises';
import type { Db } from './client.js';
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** A busy resource means rollback the whole transaction, never wait with a partial lock set. */
export class TransactionBusyError extends Error {
  constructor() {
    super('Transaction resources are busy; retry the complete operation');
    this.name = 'TransactionBusyError';
  }
}
function retryable(error: unknown): boolean {
  if (error instanceof TransactionBusyError) return true;
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && ['55P03', '40P01', '40001'].includes(String(error.code))) return true;
  return 'cause' in error && error.cause !== error && retryable(error.cause);
}

/** Only known rolled-back failures retry. Unknown COMMIT/connection outcomes never do. */
export async function withTransactionRetry<T>(
  db: Db,
  run: (tx: Tx) => Promise<T>,
  options: { attempts?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 8;
  if (!Number.isSafeInteger(attempts) || attempts < 1)
    throw new RangeError('attempts must be positive');
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await db.transaction(run);
    } catch (error) {
      if (!retryable(error)) throw error;
      if (attempt + 1 === attempts) throw new TransactionBusyError();
    }
    await setTimeout(Math.min(5 * 2 ** attempt, 100) + Math.floor(Math.random() * 5));
  }
  throw new TransactionBusyError();
}
