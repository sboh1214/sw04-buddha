import { isHumanAccountTypeSql, schema, type Db } from '@buddha/db';
import { type LedgerAccountKind } from '@buddha/shared';
import { sql } from 'drizzle-orm';

/**
 * One ledger account whose balance does not match its ledger (PLAN 5.6, #116): a person's own,
 * the treasury, a market's collateral or a market's 마켓메이커 자금 — or a person's account that
 * has no ledger account at all. The balance's total (available + locked) and its ledger-total copy
 * (`ledger_coin`, migration 0060) are each held against the ledger sum.
 */
export interface LedgerMismatch {
  /** null when `accountMissing`. */
  ledgerAccountId: number | null;
  kind: LedgerAccountKind;
  /** The person of a `user` account (or of a missing one); null for the other kinds. */
  userId: string | null;
  /** The market of a collateral or a 마켓메이커 자금; null for the other kinds. */
  marketId: string | null;
  /**
   * A person's account with no user ledger account — the "user" trigger makes one with every
   * account (migration 0060), so nothing can be credited to it and every wallet call fails.
   */
  accountMissing: boolean;
  /** No `balances` row for the ledger account (always so when `accountMissing`). */
  balanceMissing: boolean;
  /** 0n when `balanceMissing`. */
  availableCoin: bigint;
  /** 0n when `balanceMissing`. */
  lockedCoin: bigint;
  /** The balance row's copy of its ledger total, `ledger_coin`; 0n when `balanceMissing`. */
  ledgerCoin: bigint;
  /** What came in minus what went out, over every event naming the account. */
  ledgerSumCoin: bigint;
  /** balance − ledger sum, an absent balance read as 0: positive means the balance holds Coin
   *  the ledger never moved there. ADR-0107 결정 2 #73 10항's account mismatch when not 0. */
  differenceCoin: bigint;
  /**
   * `ledgerCoin` is not the ledger sum: the copy every event moves (and the database checks at
   * COMMIT) was changed around it — an owner-level write, a restored dump. Independent of
   * `differenceCoin`, which compares the buckets. Unlike a difference alone, the account takes no
   * event, a payout included, until the owner resets the copy (ADR-0109 결과 5).
   */
  ledgerCoinMismatch: boolean;
}

export interface LedgerAuditResult {
  /** Accounts examined: every ledger account, and every person's account that has none. */
  checked: number;
  mismatches: LedgerMismatch[];
  /** `audit_failures` rows written — one per mismatch. */
  recorded: number;
}

export const LEDGER_AUDIT_FAILURE_KIND = 'ledger_balance_mismatch';

/**
 * Rows per `audit_failures` INSERT. drizzle binds one parameter per written column per row
 * (`kind` and `payload`; id and created_at take their defaults), and the Bind message of the
 * Postgres wire protocol counts parameters in an int16 — node-postgres writes the count with
 * no range check, so at 32,768 rows it wraps to 0 and the server rejects the statement. One
 * multi-row INSERT of every mismatch therefore dies exactly on the run a systemic bug makes
 * worth reading: the job lands in the BullMQ failed set, the per-account detail is lost.
 * 1,000 rows is 2,000 parameters, far inside the limit and still a handful of round trips
 * for anything short of a catastrophe.
 */
export const AUDIT_FAILURE_INSERT_CHUNK = 1_000;

/**
 * Statement timeout for the connection the audit runs on. The check is one grouped SELECT
 * over every ledger row by design (ADR-0025), so its cost grows with the ledger, and under
 * createDb's 30-second default every attempt of the nightly job would die at the same point
 * once the ledger is large enough: a 'job failed' warning and a BullMQ failed-set entry, but
 * no mismatch recorded and nothing that alerts. Ten minutes at 04:00 KST is cheap; the
 * worker's other jobs keep the default guard on their own pool. A separate pool because
 * node-postgres takes a per-query `query_timeout` but drizzle builds the query config itself
 * and exposes no hook for it. The same cap covers the fallback count and the chunked INSERT
 * transaction; `idle_in_transaction_session_timeout` stays at its 30s default, which the
 * inter-chunk gap (one JS round trip) never approaches.
 */
export const LEDGER_AUDIT_QUERY_TIMEOUT_MS = 10 * 60_000;

export interface LedgerAuditOptions {
  /** Overrides AUDIT_FAILURE_INSERT_CHUNK; the test drives the chunking with a few rows. */
  insertChunkSize?: number;
}

/**
 * Compatibility check for the pre-#93 regression fixtures. The scheduled job and manual CLI
 * now use reconciliation.ts, whose DB operations also check locks, supply and persistent holds.
 * This older balance-only checker remains available for tests that deliberately construct
 * incomplete order/contract books while proving a ledger invariant in isolation.
 *
 * Verifies the PLAN 5.6 invariant for every ledger account (#116, ADR-0109) — every person's
 * own, the treasury, every market's collateral and every market's 마켓메이커 자금:
 *
 *   balances.available_coin + balances.locked_coin
 *     == SUM(amount_coin of events into it) − SUM(amount_coin of events out of it)
 *     == balances.ledger_coin
 *
 * Per-account equality is also the books' total: every event moves one amount out of one account
 * and into another, or mints into one, or burns from one, so the accounts together hold exactly
 * what was minted minus what was burned. The totals themselves, collateral = unsettled pairs ×
 * 100, locked = the live orders' locks, a run every minute and the automatic pause are #93's.
 *
 * The check runs entirely in Postgres (one grouped query), so it stays a single pass over the
 * ledger no matter how many accounts exist, and it never mutates money — a mismatch is only ever
 * *recorded* in `audit_failures`, because the ledger is the source of truth and silently "fixing"
 * a balance would destroy the evidence (a gap is closed by #93's 대사 정정, an event of its own).
 * Since migration 0060 the database refuses at COMMIT a `ledger_coin` that is not its ledger's,
 * and at every UPDATE a total that moves apart from it, and buddha_app holds no INSERT or DELETE of
 * `balances`; this job is the backstop for what goes around that — an owner-level change, a
 * restored dump. Such an account keeps its gap while it takes its events (ADR-0107 결정 2 #73
 * 10항), so the run reports it every day until the gap is closed — unless its `ledger_coin` copy
 * left the ledger too (`ledgerCoinMismatch`): that one takes no event until the copy is reset.
 *
 * Driven from `ledger_accounts`, not from `balances`, so an account that lost its balance row is
 * reported instead of vanishing from the result; and every person's account (`is_human_account`
 * — the 운영 마켓메이커 has no ledger account of its own) without a user ledger account is
 * reported too, so `checked` counts the ledger accounts plus those.
 *
 * Idempotent by design: re-running writes one more failure row per still-broken account and
 * changes nothing else, which is what a daily job needs (PLAN 9).
 */
export async function runLedgerAudit(
  db: Db,
  options: LedgerAuditOptions = {},
): Promise<LedgerAuditResult> {
  const chunkSize = options.insertChunkSize ?? AUDIT_FAILURE_INSERT_CHUNK;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError(`insertChunkSize must be a positive integer, got ${String(chunkSize)}`);
  }

  const { rows } = await db.execute<{
    ledger_account_id: string | null;
    kind: LedgerAccountKind;
    user_id: string | null;
    market_id: string | null;
    account_missing: boolean;
    balance_missing: boolean;
    available_coin: string;
    locked_coin: string;
    ledger_coin: string;
    ledger_sum_coin: string;
    checked: string;
  }>(sql`
    with moves as (
      select to_account_id as account_id, amount_coin as delta_coin
      from ledger_entries
      where to_account_id is not null
      union all
      select from_account_id, -amount_coin
      from ledger_entries
      where from_account_id is not null
    ),
    ledger as (
      select account_id, sum(delta_coin) as ledger_sum_coin
      from moves
      group by account_id
    ),
    accounts as (
      select
        a.id as ledger_account_id,
        a.kind,
        case when a.kind = 'user' then a.owner_id end as user_id,
        a.market_id,
        false as account_missing,
        (b.account_id is null) as balance_missing,
        coalesce(b.available_coin, 0) as available_coin,
        coalesce(b.locked_coin, 0) as locked_coin,
        coalesce(b.ledger_coin, 0) as ledger_coin,
        coalesce(g.ledger_sum_coin, 0) as ledger_sum_coin
      from ledger_accounts a
      left join balances b on b.account_id = a.id
      left join ledger g on g.account_id = a.id
      union all
      select
        null,
        'user'::ledger_account_kind,
        ${schema.user.id},
        null,
        true,
        true,
        0,
        0,
        0,
        0
      from ${schema.user}
      where ${isHumanAccountTypeSql(schema.user.accountType)}
        and not exists (
          select 1 from ledger_accounts a where a.kind = 'user' and a.owner_id = ${schema.user.id}
        )
    )
    select
      ledger_account_id,
      kind,
      user_id,
      market_id,
      account_missing,
      balance_missing,
      available_coin,
      locked_coin,
      ledger_coin,
      ledger_sum_coin,
      (select count(*) from accounts) as checked
    from accounts
    -- balance_missing needs its own disjunct. With no balance row AND no ledger entries the
    -- arithmetic below is 0 <> 0, so the broken account would still pass -- and every account
    -- starts with no ledger entry until its start grant is paid (#70). One of those losing its
    -- balance row, or having no ledger account at all, is exactly the silent case this job
    -- exists to catch.
    where balance_missing
      or available_coin + locked_coin <> ledger_sum_coin
      or ledger_coin <> ledger_sum_coin
    order by ledger_account_id nulls last, user_id
  `);

  // `checked` rides along on every row; with no mismatch the count needs its own query.
  const checked = rows[0]
    ? Number(rows[0].checked)
    : Number(
        (await db.execute<{ count: string }>(sql`select count(*) as count from ledger_accounts`))
          .rows[0]?.count ?? '0',
      );

  const mismatches = rows.map((row) => {
    // `coalesce(..., 0)` above keeps these non-null: `BigInt(null)` throws, which would turn a
    // detected orphan into a crashed job.
    const availableCoin = BigInt(row.available_coin);
    const lockedCoin = BigInt(row.locked_coin);
    const ledgerCoin = BigInt(row.ledger_coin);
    const ledgerSumCoin = BigInt(row.ledger_sum_coin);
    return {
      // bigserial in `{ mode: 'number' }` (schema/ledger-accounts.ts): the raw row brings text.
      ledgerAccountId: row.ledger_account_id === null ? null : Number(row.ledger_account_id),
      kind: row.kind,
      userId: row.user_id,
      marketId: row.market_id,
      accountMissing: row.account_missing,
      balanceMissing: row.balance_missing,
      availableCoin,
      lockedCoin,
      ledgerCoin,
      ledgerSumCoin,
      differenceCoin: availableCoin + lockedCoin - ledgerSumCoin,
      ledgerCoinMismatch: ledgerCoin !== ledgerSumCoin,
    };
  });

  if (mismatches.length > 0) {
    const rows = mismatches.map((mismatch) => ({
      kind: LEDGER_AUDIT_FAILURE_KIND,
      // One kind, as AUDIT_FAILURE_KINDS declares; the failures are told apart by
      // `accountMissing`, `balanceMissing`, `differenceCoin` and `ledgerCoinMismatch` in the
      // free-form jsonb payload.
      payload: {
        ledgerAccountId: mismatch.ledgerAccountId,
        kind: mismatch.kind,
        userId: mismatch.userId,
        marketId: mismatch.marketId,
        accountMissing: mismatch.accountMissing,
        balanceMissing: mismatch.balanceMissing,
        availableCoin: mismatch.availableCoin.toString(),
        lockedCoin: mismatch.lockedCoin.toString(),
        ledgerCoin: mismatch.ledgerCoin.toString(),
        ledgerSumCoin: mismatch.ledgerSumCoin.toString(),
        differenceCoin: mismatch.differenceCoin.toString(),
        ledgerCoinMismatch: mismatch.ledgerCoinMismatch,
      },
    }));
    // Chunked (see AUDIT_FAILURE_INSERT_CHUNK) but one transaction, so every row of a run
    // still carries the same `created_at` — `now()` is fixed per transaction — exactly as the
    // single statement gave them. That shared timestamp is what tells one run's rows from the
    // next day's (re-running appends, by design), and a chunk that fails takes the run's
    // earlier chunks down with it instead of leaving a half-written report.
    await db.transaction(async (tx) => {
      for (let start = 0; start < rows.length; start += chunkSize) {
        await tx.insert(schema.auditFailures).values(rows.slice(start, start + chunkSize));
      }
    });
  }

  return { checked, mismatches, recorded: mismatches.length };
}
