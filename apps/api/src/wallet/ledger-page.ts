import { schema } from '@buddha/db';
import {
  ledgerKindBranch,
  type Keyset,
  type LedgerAccountSide,
  type LedgerFilterKind,
  type MemberLedgerEntryType,
  type RecentPeriod,
} from '@buddha/shared';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { keysetPredicate } from '../common/keyset.js';
import { recentPeriodPredicate } from '../common/period.js';

/** What `GET /me/ledger` narrows by (`myLedgerQuerySchema`): each one a predicate, AND-ed. */
export interface LedgerPageFilter {
  kind?: LedgerFilterKind | undefined;
  period?: RecentPeriod | undefined;
  marketId?: string | undefined;
}

/** One walk down one side of the account: its side, and its types (undefined: every type). */
interface LedgerBranch {
  side: LedgerAccountSide;
  types: readonly MemberLedgerEntryType[] | undefined;
}

/**
 * Which sides a page walks (#69, ADR-0144 결정 2-3): a kind stands on one side (`ledgerKindBranch`,
 * from the one table of kinds), so it walks that one with its types; no kind walks both, every
 * type.
 */
export function ledgerBranches(kind: LedgerFilterKind | undefined): LedgerBranch[] {
  if (kind === undefined) {
    return [
      { side: 'from', types: undefined },
      { side: 'to', types: undefined },
    ];
  }
  return [ledgerKindBranch(kind)];
}

/**
 * One side's newest `limit` events after the cursor: `<side>_account_id = $account` and the
 * filter's predicates, ordered as the list is. One descent of that side's
 * `(account, created_at, id)` index (migration 0060), stopped by the LIMIT.
 */
function branchSql(
  accountId: number,
  branch: LedgerBranch,
  filter: LedgerPageFilter,
  keyset: Keyset | undefined,
  limit: number,
): SQL {
  const entries = schema.ledgerEntries;
  const account = branch.side === 'from' ? entries.fromAccountId : entries.toAccountId;
  const where = and(
    eq(account, accountId),
    branch.types === undefined ? undefined : inArray(entries.type, [...branch.types]),
    filter.marketId === undefined ? undefined : eq(entries.marketId, filter.marketId),
    recentPeriodPredicate(entries.createdAt, filter.period),
    keyset === undefined
      ? undefined
      : keysetPredicate(entries.createdAt, entries.id, keyset, 'bigint'),
  )!;
  return sql`SELECT ${entries.createdAt} AS created_at, ${entries.id} AS id
      FROM ${entries}
     WHERE ${where}
     ORDER BY ${entries.createdAt} DESC, ${entries.id} DESC
     LIMIT ${limit}::int`;
}

/**
 * The ids of a page of one account's events, newest first, `limit` at most, as an array the
 * outer read looks its rows up by (`id = ANY (…)`, the primary key) — the comments' page shape
 * (comment-queries.ts).
 *
 * Each side is its own walk (`branchSql`), and with no kind the two are put together with UNION
 * ALL and ordered again: an event never stands on both sides of one account
 * (`ledger_entries_sides_check`: from ≠ to), so the two never share a row and nothing needs
 * removing. Every filter is an AND-ed predicate of each walk and the order is the unique
 * `(created_at, id)` the cursor is cut on, so pages neither overlap nor skip a row (ADR-0144).
 * Before this the page read `from = $a OR to = $a`, a BitmapOr over both indexes that sorted every
 * row of the account on every page.
 */
export function ledgerPageIdsSql(
  accountId: number,
  filter: LedgerPageFilter,
  keyset: Keyset | undefined,
  limit: number,
): SQL {
  const walks = ledgerBranches(filter.kind).map(
    (branch) => sql`(${branchSql(accountId, branch, filter, keyset, limit)})`,
  );
  return sql`ARRAY(
    SELECT page.id
      FROM (${sql.join(walks, sql` UNION ALL `)}) AS page
     ORDER BY page.created_at DESC, page.id DESC
     LIMIT ${limit}::int
  )`;
}

/**
 * The fills whose orders a page's fill events name, by id (#69, ADR-0144 결정 2-4): `ref_id` is
 * text and holds a grant's uuid, a market's, a payment's, a correction's audit id as well as a
 * fill's id, and PostgreSQL does not promise the order its predicates run in — a cast in a JOIN
 * may meet a uuid and fail (22P02, a 500). So the ids are picked here, out of the page's rows:
 * a `fill` reference shaped as a positive bigint that is a safe integer, the shape migration
 * 0062's trigger checks before its own cast.
 */
const FILL_ID = /^[1-9][0-9]{0,17}$/;

export function fillIdsOf(rows: readonly { refType: string; refId: string }[]): number[] {
  const ids = new Set<number>();
  for (const row of rows) {
    if (row.refType !== 'fill' || !FILL_ID.test(row.refId)) continue;
    const id = Number(row.refId);
    if (Number.isSafeInteger(id)) ids.add(id);
  }
  return [...ids];
}
