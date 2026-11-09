import { uuidSchema } from '@buddha/shared';
import type { ReconciliationTarget } from '../jobs/reconciliation.js';

export type LedgerAuditSelection = { scope: 'all' } | ReconciliationTarget;

export const LEDGER_AUDIT_USAGE =
  'Usage: job:ledger-audit [--market-id UUID | --user-id ID | --account-id NUMBER | --supply]';

/** A missing selector means the full manual audit. Reject typos before opening any connection. */
export function parseLedgerAuditArgs(args: readonly string[]): LedgerAuditSelection {
  if (args.length === 0) return { scope: 'all' };
  if (args.length === 1 && args[0] === '--supply') return { scope: 'supply' };
  if (args.length !== 2) throw new Error(LEDGER_AUDIT_USAGE);
  const [flag, value] = args;
  if (flag === '--market-id') {
    const parsed = uuidSchema.safeParse(value);
    if (parsed.success) return { scope: 'market', marketId: parsed.data };
  }
  if (flag === '--user-id' && value?.trim() !== '' && value !== undefined) {
    return { scope: 'account', userId: value };
  }
  if (flag === '--account-id' && value !== undefined && /^[1-9]\d*$/.test(value)) {
    const accountId = Number(value);
    if (Number.isSafeInteger(accountId)) return { scope: 'account', accountId };
  }
  throw new Error(LEDGER_AUDIT_USAGE);
}
