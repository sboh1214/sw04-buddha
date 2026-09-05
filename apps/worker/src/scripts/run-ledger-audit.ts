/**
 * Runs the ledger audit once, right here, and prints the result (PLAN M2 AC 5:
 * "manual run reports zero mismatches"). Same code path as the scheduled job, so it is the
 * quickest way to check the PLAN 5.6 invariant on a live database.
 *
 *   pnpm --filter worker run job:ledger-audit
 */
import { closeDb, createDb } from '@buddha/db';
import { getEnv } from '../env.js';
import { LEDGER_AUDIT_QUERY_TIMEOUT_MS, runLedgerAudit } from '../jobs/ledger-audit.js';

const env = getEnv();
// Same timeout as the scheduled job: the one statement scans the whole ledger.
const db = createDb(env.DATABASE_URL, {
  max: 1,
  applicationName: 'buddha-worker-audit',
  queryTimeoutMs: LEDGER_AUDIT_QUERY_TIMEOUT_MS,
});

try {
  const result = await runLedgerAudit(db);
  const summary = {
    checked: result.checked,
    mismatches: result.mismatches.length,
    recorded: result.recorded,
  };
  console.log(JSON.stringify(summary));
  for (const mismatch of result.mismatches) {
    console.error(
      `mismatch user=${mismatch.userId} balance=${(mismatch.availableP + mismatch.lockedP).toString()} ledger=${mismatch.ledgerSumP.toString()} diff=${mismatch.differenceP.toString()}`,
    );
  }
  // A mismatch is a real accounting failure: exit non-zero so a cron/CI caller notices.
  process.exitCode = result.mismatches.length === 0 ? 0 : 1;
} finally {
  await closeDb(db);
}
