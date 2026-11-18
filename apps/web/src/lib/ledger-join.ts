import { RECENT_PERIOD_HOURS, type RecentPeriod } from '@buddha/shared';
import { type InfiniteData } from '@tanstack/react-query';
import { type LedgerEntry } from './api';

/**
 * The two joins that keep 이용 내역 from losing a row it already drew (#69, ADR-0144 결정 6): the
 * head read of a balance-history round (`mergeLedgerHead`) and every other write of the list
 * (`keepNewerHead`, which query-client.ts registers). Apart from wallet.ts so query-client.ts can
 * register the second without importing the screen rules, as order-join.ts is.
 *
 * What they rest on: a ledger row is immutable and never deleted, and the list is newest first by
 * the unique keyset `(createdAt, id)` its cursor is cut on (ledger-page.ts). But rows are NOT
 * only added on top. `createdAt` is the writing transaction's start (`now()`) and a row is seen
 * from its commit, so a transaction that waited for the account's balance lock — an intake that
 * started before a fill on the same account — commits after a row it is listed BELOW. So a read
 * can lack a row between two it holds, and a later read has it. Both joins therefore take the
 * union by id inside the range both sides cover, each row in its sorted place (`placeRows`),
 * never only "the rows above the top". Only `period` lets a row go, and it lets the oldest go
 * first: a row newer than one still listed has not aged out. And a row's own columns never change,
 * but the market it joins can (an approved supplement retitles it): a row read again replaces the
 * held one, field by field (`sameEntry`).
 */

/** `['ledger']`, `LEDGER_QUERY_KEY` (hooks/use-wallet.ts) named here for query-client.ts. */
export const LEDGER_KEY = ['ledger'] as const;

/** One cursor page of `GET /me/ledger`. */
export interface LedgerPage {
  items: LedgerEntry[];
  nextCursor: string | null;
}

export type LedgerPages = InfiniteData<LedgerPage, string | undefined>;

type LedgerOrder = Pick<LedgerEntry, 'id' | 'createdAt'>;

/** Two decimal ids (bigserial, no leading zero) by value, without a `BigInt` that could throw. */
function compareIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Whether `a` is listed above `b`: a later `createdAt`, or the same one and a larger id — the
 * list's order. `created_at` is stored to the millisecond (`timestampTz`, precision 3), the
 * precision the answer carries, so this is the server's order exactly.
 */
export function ledgerNewer(a: LedgerOrder, b: LedgerOrder): boolean {
  const at = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (at !== 0) return at > 0;
  return compareIds(a.id, b.id) > 0;
}

/** The list as one page, the head alone: what is left when a head read cannot be joined. */
function headAlone(head: LedgerPage): LedgerPages {
  return { pages: [head], pageParams: [undefined] };
}

const rowsOf = (data: LedgerPages) => data.pages.flatMap((page) => page.items);

/**
 * Whether `a` and `b` say the same, every field compared — not the id alone: the ledger columns
 * are immutable, but the joined market's slug and title are read with each answer and can change
 * for a row already held (an approved supplement, a market turned private). Every field of
 * `LedgerEntry` is a string, a number or null.
 */
function sameEntry(a: LedgerEntry, b: LedgerEntry): boolean {
  if (a === b) return true;
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!Object.is(left[key], right[key])) return false;
  }
  return true;
}

/** Whether `a` and `b` list the same rows, field by field, on the same pages and cursors. */
function sameList(a: LedgerPages, b: LedgerPages): boolean {
  return (
    a.pages.length === b.pages.length &&
    a.pages.every((page, at) => {
      const other = b.pages[at];
      return (
        other !== undefined &&
        page.nextCursor === other.nextCursor &&
        page.items.length === other.items.length &&
        page.items.every((item, row) => {
          const same = other.items[row];
          return same !== undefined && sameEntry(item, same);
        })
      );
    })
  );
}

/**
 * `data` with each held row that `fresh` read again replaced by that reading, in place (the id
 * and `createdAt` are the same, so the order and every cursor stay). A page none of whose rows
 * changed is kept as it is, and `data` itself when no row did.
 */
function refreshRows(data: LedgerPages, fresh: LedgerEntry[]): LedgerPages {
  const byId = new Map(fresh.map((row) => [row.id, row]));
  let changed = false;
  const pages = data.pages.map((page) => {
    let pageChanged = false;
    const items = page.items.map((item) => {
      const next = byId.get(item.id);
      if (next === undefined || sameEntry(item, next)) return item;
      pageChanged = true;
      return next;
    });
    if (!pageChanged) return page;
    changed = true;
    return { ...page, items };
  });
  return changed ? { ...data, pages } : data;
}

const HOUR_MS = 3_600_000;

/**
 * How far below the bound a row must be before `expireAged` lets it go. The server keeps a row
 * while `created_at > now() − N h` (api common/period.ts), `now()` being the reading statement's
 * transaction start. The bound takes that `now()` to be at least the newest `created_at` read,
 * which holds but for two slivers: `created_at` is stored rounded to the millisecond, and a row
 * whose transaction began after the reading one's start yet committed before its snapshot is
 * seen with a later `created_at`. Both are milliseconds; a minute covers them many times over,
 * and costs only that a row is shown up to a minute past N × 24 hours.
 */
export const PERIOD_EXPIRY_MARGIN_MS = 60_000;

/**
 * `data` without the rows that have certainly left `period` — no request (#69, ADR-0144 결정 6).
 * The database clock has passed every `created_at` an answer brought, so it is at least the
 * newest held row's (`data`'s top: every held row came in an answer); a row at or below that
 * time − N × 24 hours − `PERIOD_EXPIRY_MARGIN_MS` is outside the window any read now would use.
 * Never a row the server still lists, then; but a row whose turn came after the newest time held
 * stays until a full read (the caller stops dating the entry fresh, `ledgerHeadDate`).
 *
 * The list is sorted, so what goes is its tail: the pages below are dropped and the last page
 * kept ends the list (`nextCursor` null) — every row below a row that left is older, and has
 * left too. `data` itself when nothing goes, or without `period`.
 */
function expireAged(data: LedgerPages, period: RecentPeriod | undefined): LedgerPages {
  const top = data.pages[0]?.items[0];
  if (period === undefined || top === undefined) return data;
  const cut = Date.parse(top.createdAt) - RECENT_PERIOD_HOURS[period] * HOUR_MS;
  const gone = (row: LedgerEntry) => Date.parse(row.createdAt) <= cut - PERIOD_EXPIRY_MARGIN_MS;
  const at = data.pages.findIndex((page) => page.items.some(gone));
  if (at < 0) return data;
  const kept = data.pages[at]?.items.filter((row) => !gone(row)) ?? [];
  const pages =
    kept.length === 0 && at > 0
      ? data.pages.slice(0, at)
      : [...data.pages.slice(0, at), { items: kept, nextCursor: null }];
  const last = pages.length - 1;
  return {
    pages: pages.map((page, index) =>
      index === last && page.nextCursor !== null ? { ...page, nextCursor: null } : page,
    ),
    pageParams: data.pageParams.slice(0, pages.length),
  };
}

/**
 * `rows` (newest first, none already in `data`) put into `data`, each in its sorted place on the
 * first page whose last row it is listed above — so every page's last row, and the cursor cut on
 * it, stays as it was. A row below the last loaded row goes on the last page only when that page
 * ends the list (`endOpen`, no cursor); otherwise it is left for 더 보기, whose cursor is that
 * row. The rows already held keep their order. `data` itself when nothing is placed.
 */
function placeRows(data: LedgerPages, rows: LedgerEntry[], endOpen: boolean): LedgerPages {
  if (rows.length === 0) return data;
  const pages = data.pages.map((page) => page.items);
  let placed = false;
  for (const row of rows) {
    let at = pages.findIndex((items) => {
      const last = items.at(-1);
      return last !== undefined && ledgerNewer(row, last);
    });
    if (at < 0) {
      if (!endOpen || pages.length === 0) continue;
      at = pages.length - 1;
    }
    const items = [...(pages[at] ?? [])];
    const before = items.findIndex((item) => ledgerNewer(row, item));
    items.splice(before < 0 ? items.length : before, 0, row);
    pages[at] = items;
    placed = true;
  }
  if (!placed) return data;
  return {
    ...data,
    pages: data.pages.map((page, at) =>
      pages[at] === page.items ? page : { ...page, items: pages[at] ?? page.items },
    ),
  };
}

/**
 * A balance-history round's head read (the first page, no cursor, the key's filters) joined into
 * the list held (#69, ADR-0144 결정 6):
 *
 * - the head and the held rows cover a common range: every head row not held goes in its sorted
 *   place (`placeRows`) — on top, or between held rows when it committed late. The later pages'
 *   cursors stay valid (keyset). Below the last loaded row only when the held list is complete;
 * - every head row is newer than the held top — more than a page of new rows, or the held rows
 *   aged out of `period` (the oldest go first, so then every held row has) — or the head is
 *   empty: the head alone, its one page. One read and no gap; the deeper pages loaded are let go;
 * - every head row is older than the last held row: an answer older than what is held. Nothing
 *   changes;
 * - before all of these, a head that ends the list (no cursor) is every row the filters let
 *   through when it was read (rows are never deleted, and one committed late is seen by it): the
 *   list is the head alone, with the held rows it lacks kept only above its last row — committed
 *   after it was read (`keepNewerHead`). A held row below it has aged out of `period`, and goes,
 *   where a merge that only adds would keep it under '최근 7일' while fills keep coming.
 *
 * A held row the head also brings takes the head's reading (`refreshRows`: the market's title or
 * slug may have changed), and counts as a change when any field differs. With `period` (the key's
 * own), what is kept below the head — rows it cannot vouch for — loses the rows that have
 * certainly aged out (`expireAged`); whether the rest is vouched for is `headCoversLedger`.
 *
 * Merging the same head twice changes nothing (the second finds every row held, as it is).
 */
export function mergeLedgerHead(
  held: LedgerPages,
  head: LedgerPage,
  period?: RecentPeriod,
): LedgerPages {
  const rows = rowsOf(held);
  const top = rows[0];
  const bottom = rows.at(-1);
  if (top === undefined || bottom === undefined) {
    return head.items.length === 0 ? held : headAlone(head);
  }
  const headTop = head.items[0];
  const headBottom = head.items.at(-1);
  if (headTop === undefined || headBottom === undefined) return headAlone(head);
  if (head.nextCursor === null) {
    const whole = keepNewerHead(held, headAlone(head));
    return sameList(whole, held) ? held : whole;
  }
  if (ledgerNewer(headBottom, top)) return headAlone(head);
  if (ledgerNewer(bottom, headTop)) return expireAged(held, period);
  const ids = new Set(rows.map((row) => row.id));
  const endOpen = held.pages.at(-1)?.nextCursor === null;
  return expireAged(
    placeRows(
      refreshRows(held, head.items),
      head.items.filter((row) => !ids.has(row.id)),
      endOpen,
    ),
    period,
  );
}

/**
 * Whether `head` vouches for every row of `merged` (`mergeLedgerHead`'s answer for it) as of its
 * read, so the entry may be dated fresh (`ledgerHeadDate`). Always without `period`: rows never
 * leave then, and the ones below the head are as they were read. With it, only when the head is
 * the whole list (no cursor) or nothing is kept below its last row: a row there may have left the
 * window since its own read, and only a full read can tell (`expireAged` drops the certain ones).
 */
export function headCoversLedger(
  merged: LedgerPages,
  head: LedgerPage,
  period: RecentPeriod | undefined,
): boolean {
  if (period === undefined || head.nextCursor === null) return true;
  const bottom = rowsOf(merged).at(-1);
  const headBottom = head.items.at(-1);
  if (bottom === undefined || headBottom === undefined) return true;
  return !ledgerNewer(headBottom, bottom);
}

/**
 * How long after the last read that vouched for every row of a `period` entry (a full read, or a
 * head `headCoversLedger` passed) its head reads may still date it fresh though rows are kept
 * below the head (#69, ADR-0144 결정 6 (나)). Holding the date at every such read would make each
 * focus past `staleTime` read the entry whole while fills go on — one new row grows the first page
 * past the head, so that is the usual state, not a rare one — up to three times a minute. Held
 * only past this, the whole read that settles what `expireAged` cannot is one in five minutes, at
 * most one in any 60 s window; the cost is that such a row stays up to five minutes longer.
 */
export const PERIOD_REVALIDATE_MS = 5 * 60_000;

/**
 * The `dataUpdatedAt` a head read gives its entry (`readLedgerHead`): when the request left
 * (`requestStart`), never earlier than what the entry holds (`heldAt` — a full read may have
 * landed meanwhile), if the head vouches for the list (`covered`) or the last read that did
 * (`vouchedAt`) is less than `PERIOD_REVALIDATE_MS` before it; otherwise `heldAt`, so the next
 * focus, mount or reconnect past `staleTime` reads the entry whole. Measured from `vouchedAt`, not
 * from `heldAt`: a fresh date given under the cap must not push the cap itself on.
 */
export function ledgerHeadDate(head: {
  covered: boolean;
  requestStart: number;
  heldAt: number;
  vouchedAt: number;
}): number {
  const { covered, requestStart, heldAt, vouchedAt } = head;
  return covered || requestStart - vouchedAt < PERIOD_REVALIDATE_MS
    ? Math.max(requestStart, heldAt)
    : heldAt;
}

/**
 * Every write of a ledger entry (query-client.ts's `structuralSharing`): `incoming`, with the held
 * rows it lacks put back in their places. A read that left before a head merge — a 더 보기 built
 * from the pages held then, a focus or a reconnect's read — lands after it without the merged
 * rows; this keeps them, so no late answer drops a row a head read drew, and head reads landing
 * in any order agree.
 *
 * - Only held rows listed above `incoming`'s last row: a row below it may have aged out of
 *   `period`, and is not brought back (a 더 보기 reads it again if not);
 * - every held row newer than `incoming`'s top: the answer left before a round that kept the head
 *   alone, and taking it would leave a gap of rows neither side holds. The held list stays, and
 *   the answer is dropped (a 더 보기 is asked again from the held pages);
 * - an empty `incoming` is taken as it is (nothing to order by); the next round reads the head.
 */
export function keepNewerHead(held: LedgerPages | undefined, incoming: LedgerPages): LedgerPages {
  // Defensive: query-client.ts hands this whatever is written under `['ledger']`.
  if (!Array.isArray(held?.pages) || !Array.isArray(incoming.pages)) return incoming;
  const heldRows = rowsOf(held);
  const incomingRows = rowsOf(incoming);
  const top = incomingRows[0];
  const bottom = incomingRows.at(-1);
  const heldBottom = heldRows.at(-1);
  if (top === undefined || bottom === undefined || heldBottom === undefined) return incoming;
  if (ledgerNewer(heldBottom, top)) return held;
  const ids = new Set(incomingRows.map((row) => row.id));
  return placeRows(
    incoming,
    heldRows.filter((row) => !ids.has(row.id) && ledgerNewer(row, bottom)),
    false,
  );
}
