/**
 * Manual #93 reconciliation. With no arguments every account, market and total supply is checked;
 * selectors use the same transaction/hold rules as the scheduled checks. This records results
 * and may pause a broken market; it never corrects money or releases an existing hold.
 *
 *   pnpm --filter worker run job:ledger-audit [--market-id UUID | --user-id ID | --account-id N | --supply]
 */
import { closeDb, createDb } from '@buddha/db';
import { pino } from 'pino';
import { getEnv } from '../env.js';
import { LEDGER_AUDIT_QUERY_TIMEOUT_MS } from '../jobs/ledger-audit.js';
import {
  reconcileLedger,
  reconcileTarget,
  reconciliationBatchSummary,
} from '../jobs/reconciliation.js';
import { createPublisher, createPublisherRedis } from '../realtime.js';
import { parseLedgerAuditArgs } from './ledger-audit-args.js';

const selection = parseLedgerAuditArgs(process.argv.slice(2));
const env = getEnv();
const logger = pino({ name: 'worker-audit-manual', level: env.LOG_LEVEL ?? 'warn' });
const db = createDb(env.DATABASE_URL, {
  max: 1,
  applicationName: 'buddha-worker-audit',
  queryTimeoutMs: LEDGER_AUDIT_QUERY_TIMEOUT_MS,
});
const redis = createPublisherRedis(env.REDIS_URL, logger);
const publish = createPublisher(redis, logger);

try {
  if (selection.scope === 'all') {
    const result = await reconcileLedger(db, publish, { source: 'manual', allMarkets: true });
    console.log(JSON.stringify(reconciliationBatchSummary(result)));
    for (const mismatch of result.mismatches) console.error(JSON.stringify(mismatch));
    for (const failure of result.failures) {
      console.error(JSON.stringify({ target: failure.target, error: failure.message }));
    }
    process.exitCode = result.mismatched === 0 && result.failed === 0 ? 0 : 1;
  } else {
    const result = await reconcileTarget(db, selection, publish, 'manual');
    console.log(JSON.stringify(result));
    process.exitCode = result.passed ? 0 : 1;
  }
} finally {
  // Publishes have completed or reached their bound. Do not park CLI shutdown on a disconnected
  // Redis: the committed results and holds already live in Postgres.
  redis.disconnect();
  await closeDb(db);
}
