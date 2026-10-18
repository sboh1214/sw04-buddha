import { getReleaseSetting, payStartGrant, pendingStartGrantIds, type Db } from '@buddha/db';
import {
  RELEASE_SETTINGS,
  START_COIN_SETTING,
  serializeCoinAmount,
  userChannel,
} from '@buddha/shared';
import { type Publish } from '../realtime.js';
import { messageOf } from './scan.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * At most this many waiting grants per run. Every grant is one short transaction; a backlog larger
 * than this (more accounts finished the onboarding while the amount was undecided) is paid over the
 * next runs, a minute apart, so one run never holds the queue long.
 */
export const START_GRANT_PAY_BATCH = 500;

/** One waiting grant the run gave up on: its transaction rejected, and the loop moved on. */
export interface StartGrantPayFailure {
  grantId: string;
  /** `messageOf(err)`: the job result is JSON. */
  message: string;
  /** The thrown value itself, for the log line. */
  err: unknown;
}

export interface StartGrantPayOutcome {
  /** Whether the release setting `grant.start_coin` had no value: then nothing was looked at. */
  undecided: boolean;
  /** Grants this run paid. */
  paid: number;
  /**
   * Grants another payer paid first, that found the amount undecided inside their transaction, or
   * whose account lost its 본인확인 record (a withdrawal, #140) between the scan and the payment.
   */
  skipped: number;
  failed: number;
  failures: StartGrantPayFailure[];
}

/** The amount, read inside the paying transaction (ADR-0055), or null while it is undecided. */
async function amountIn(tx: Tx): Promise<bigint | null> {
  const reading = await getReleaseSetting(tx, RELEASE_SETTINGS, START_COIN_SETTING);
  return reading.status === 'undecided' ? null : BigInt(reading.value);
}

/**
 * `start_grant.pay` (#70, ADR-0071): pays the start grants that waited because the amount was
 * undecided when their accounts finished the onboarding (ADR-0069 decision 4 #70) — once an admin
 * enters a value, every waiting account gets that value, within a minute (the job runs every
 * minute, JOB_SCHEDULES). A value of any status is paid (decision 7).
 *
 * The release setting is read first, outside any transaction, only to skip the scan while it is
 * undecided — the common case before launch, every minute. Each grant is then paid in a
 * transaction of its own by `payStartGrant` (@buddha/db), the same function the API's grant uses,
 * which locks the grant, reads the amount once inside that transaction and pays a pending grant
 * only: a grant the API paid meanwhile, or two runs at once, still give one ledger entry. A grant
 * whose account withdrew while it waited (its 본인확인 record gone, #140) is neither scanned nor
 * paid: it stays pending as the record of its number (ADR-0071 7-11, an owner question). One
 * grant's failure is recorded and the loop goes on, so a broken account (no balance row) does not
 * hold every grant behind it — the scans' rule (scan.ts).
 *
 * Every payment publishes `user:balance` after its COMMIT, like every balance change (PLAN 8).
 */
export async function payPendingStartGrants(
  db: Db,
  publish: Publish,
  batch: number = START_GRANT_PAY_BATCH,
): Promise<StartGrantPayOutcome> {
  const reading = await getReleaseSetting(db, RELEASE_SETTINGS, START_COIN_SETTING);
  if (reading.status === 'undecided') {
    return { undecided: true, paid: 0, skipped: 0, failed: 0, failures: [] };
  }
  const outcome: StartGrantPayOutcome = {
    undecided: false,
    paid: 0,
    skipped: 0,
    failed: 0,
    failures: [],
  };
  for (const grantId of await pendingStartGrantIds(db, batch)) {
    try {
      const result = await db.transaction((tx) => payStartGrant(tx, grantId, amountIn));
      if (result.outcome !== 'granted') {
        outcome.skipped += 1;
        continue;
      }
      outcome.paid += 1;
      const { grant, balance, ledgerEntry } = result;
      await publish(userChannel(grant.userId), {
        type: 'user:balance',
        availableCoin: serializeCoinAmount(balance.availableCoin),
        lockedCoin: serializeCoinAmount(balance.lockedCoin),
        ledgerEntryId: String(ledgerEntry.id),
        ts: ledgerEntry.createdAt.toISOString(),
      });
    } catch (err) {
      outcome.failures.push({ grantId, message: messageOf(err), err });
    }
  }
  outcome.failed = outcome.failures.length;
  return outcome;
}
