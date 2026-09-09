import {
  DISPUTE_ADMIN_NOTE_MAX,
  type DisputeStatus,
  type DisputeVerdict,
  type MarketStatus,
  type Outcome,
  type StatusKeyed,
  disputeStatusSchema,
  statusSupersedes,
  uuidSchema,
} from '@buddha/shared';
import type { InfiniteData } from '@tanstack/react-query';
import * as z from 'zod';
import { copy } from '@/copy';
import { type AdminDispute, type ReviewDisputeBody, isApiError, validationField } from './api';

/**
 * Pure helpers behind the admin 이의 목록 (PLAN 12, design 5.6): the URL as a filter set, the
 * flat page rows grouped by market, the review dialog's form and error mapping, and the
 * cache reducer a review writes through. No `'use client'` directive, so the server page can
 * parse `searchParams` from here and hand the client component a prop.
 */

/**
 * The list's filter set, which IS its cache key (`adminDisputesKey`). Keys are present only
 * when set: `hashKey` drops undefined-valued properties, but `normalizeAdminDisputeFilters`
 * is what keeps `{ status: undefined }` from ever being written in the first place, and what
 * lower-cases a `marketId` — the API answers rows with the canonical lower-case id, so an
 * upper-case URL would otherwise key a list nothing invalidates by that id (A-M3-29).
 */
export interface AdminDisputeFilters {
  status?: DisputeStatus;
  marketId?: string;
}

/** Every searchParams value is an array when the parameter repeats; the types must say so. */
export interface AdminDisputeSearchParams {
  status?: string | string[];
  marketId?: string | string[];
}

/** A repeated param arrives as an array; the first value is the one the filter UI wrote. */
function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function normalizeAdminDisputeFilters(filters: AdminDisputeFilters): AdminDisputeFilters {
  return {
    ...(filters.status === undefined ? {} : { status: filters.status }),
    ...(filters.marketId === undefined ? {} : { marketId: filters.marketId.toLowerCase() }),
  };
}

/**
 * The list's cache keys (design 5.2, 5.6), admin-prefixed like `['admin', 'markets']` so the
 * root is private (`PRIVATE_QUERY_ROOTS`) and one invalidation of `ADMIN_DISPUTES_KEY` refreshes
 * every filtered page. The filter set travels as one normalised object rather than positional
 * segments (`marketsKey`'s reasoning): a new filter cannot silently reorder the key, and `{}` /
 * `{ status: undefined }` / an upper-case `marketId` all hash to one entry.
 *
 * Here rather than in `hooks/use-admin-disputes.ts`, which re-exports both: `use-admin-markets.ts`
 * invalidates this root after an admin market write, and the hook module already imports
 * `adminMarketKey` from it — so keeping the key in the hook would close a RUNTIME cycle between
 * two `'use client'` modules. This module imports no hook, which makes the edge one-way. It is
 * the same move `lib/market-keys.ts` made for the keys the server components share, and its
 * header states the rule.
 */
export const ADMIN_DISPUTES_KEY = ['admin', 'disputes'] as const;

export const adminDisputesKey = (filters: AdminDisputeFilters) =>
  [...ADMIN_DISPUTES_KEY, normalizeAdminDisputeFilters(filters)] as const;

/**
 * Normalises the URL into the filter set, once, on the server (the public list's
 * `filtersFromSearchParams` precedent): nothing here throws, a hand-typed `?status=x` or a
 * `marketId` that is not a uuid is dropped rather than sent — the API's query schema refuses
 * both with a 400, which would read as a broken page for what is a wrong address.
 */
export function adminDisputeFiltersFromSearchParams(
  searchParams: AdminDisputeSearchParams,
): AdminDisputeFilters {
  const status = disputeStatusSchema.safeParse(firstValue(searchParams.status));
  const marketId = uuidSchema.safeParse(firstValue(searchParams.marketId));
  return normalizeAdminDisputeFilters({
    ...(status.success ? { status: status.data } : {}),
    ...(marketId.success ? { marketId: marketId.data } : {}),
  });
}

/** One market's disputes, headed by the market as the FRESHEST of its rows describes it. */
export interface DisputeGroup {
  marketId: string;
  marketSlug: string;
  marketTitle: string;
  marketStatus: MarketStatus;
  resolvedResult: Outcome | null;
  /** The order of `marketStatus`/`resolvedResult` above; null for a market with no event. */
  statusEventId: string | null;
  disputes: AdminDispute[];
}

/**
 * `statusSupersedes` reads `{ status, statusEventId }`, and on this row the market's status is
 * spelled `marketStatus` — `status` is the VERDICT. Written once, as a named adapter, because
 * the two enums overlap on `'open'`: TypeScript does refuse `DisputeStatus` where `MarketStatus`
 * is wanted, but a reader skimming an inline object literal would not.
 */
function marketSnapshotOf(row: Pick<DisputeGroup, 'marketStatus' | 'statusEventId'>): StatusKeyed {
  return { status: row.marketStatus, statusEventId: row.statusEventId };
}

/**
 * PLAN 12's 시장별 그룹 over the flat, newest-first page rows. Groups keep the order their
 * first (newest) dispute appears in, so the market with the freshest objection is on top and
 * 더 보기 only ever appends — a group already on screen never moves.
 *
 * ORDER comes from the first row; the market SNAPSHOT does not, and the difference is the whole
 * of this function. Every row of one market was joined to the same market row within ONE
 * response, but the flattened list holds several responses: `listAdmin` orders `(created_at
 * desc, id desc)`, so a LATER page carries OLDER disputes joined to a market row read LATER —
 * and `replaceDisputeRow` seeds a reviewed row whose snapshot was read inside the review
 * transaction, wherever that row happens to sit. So up to three snapshots of one market can be
 * on screen at once, and arrival order does not rank them: it would have let an older page
 * overwrite the seed, which is the freshest thing the cache holds.
 *
 * `statusSupersedes` (@buddha/shared) ranks them instead, the same helper `applyStatus` and
 * `joinMarket` use — total, monotone and order-independent, by `statusEventId` where both rows
 * carry one and by status rank where they do not (migration 0011 backfilled every real market,
 * so the fallback is a factory's concern). The status and the result move TOGETHER, as one
 * snapshot, exactly as `joinMarket` moves them.
 *
 * `marketTitle` and `marketSlug` stay with the first row and are deliberately not reconciled:
 * `MarketAdminService.update` refuses every status past `open` and a dispute exists only from
 * `resolving`, so a market with an objection can no longer be retitled. Ranking a field that
 * cannot change would be a rule with no case behind it.
 */
export function groupDisputesByMarket(rows: readonly AdminDispute[]): DisputeGroup[] {
  const groups = new Map<string, DisputeGroup>();
  for (const row of rows) {
    const group = groups.get(row.marketId);
    if (group) {
      group.disputes.push(row);
      if (statusSupersedes(marketSnapshotOf(row), marketSnapshotOf(group))) {
        group.marketStatus = row.marketStatus;
        group.resolvedResult = row.resolvedResult;
        group.statusEventId = row.statusEventId;
      }
      continue;
    }
    groups.set(row.marketId, {
      marketId: row.marketId,
      marketSlug: row.marketSlug,
      marketTitle: row.marketTitle,
      marketStatus: row.marketStatus,
      resolvedResult: row.resolvedResult,
      statusEventId: row.statusEventId,
      disputes: [row],
    });
  }
  return [...groups.values()];
}

/** The detail's 이의 row: "접수 N · 수용 N · 기각 N". */
export function disputeCountsLabel(counts: {
  open: number;
  accepted: number;
  rejected: number;
}): string {
  return [
    `${copy.adminMarketDisputesOpen} ${String(counts.open)}`,
    `${copy.adminMarketDisputesAccepted} ${String(counts.accepted)}`,
    `${copy.adminMarketDisputesRejected} ${String(counts.rejected)}`,
  ].join(' · ');
}

/**
 * The review dialog's one field. The bound is the API's (`reviewDisputeBodySchema`), and the
 * message is the resolve note's: both notes are 1,000 characters and the wording says so.
 */
export const reviewDisputeFormSchema = z.object({
  adminNote: z.string().trim().max(DISPUTE_ADMIN_NOTE_MAX, copy.errMarketResolveNote),
});
export type ReviewDisputeFormValues = z.infer<typeof reviewDisputeFormSchema>;

/** Only for values `reviewDisputeFormSchema` accepted: a blank note goes as null. */
export function toReviewDisputeBody(
  verdict: DisputeVerdict,
  values: ReviewDisputeFormValues,
): ReviewDisputeBody {
  const note = values.adminNote.trim();
  return { status: verdict, adminNote: note === '' ? null : note };
}

/**
 * The toast for a refused review. NOT_FOUND is the dispute itself (nothing deletes one, so
 * this is a wrong id, not a "try again"); a VALIDATION_ERROR naming the note is the only
 * field the form has. Session refusals and the rest are the generic message, as on every
 * other admin list.
 */
export function reviewErrorMessage(error: unknown): string {
  if (isApiError(error, 'NOT_FOUND')) return copy.adminDisputeNotFound;
  if (isApiError(error, 'VALIDATION_ERROR')) {
    return validationField(error) === 'adminNote'
      ? copy.errMarketResolveNote
      : copy.errMarketInvalid;
  }
  return copy.errUnknown;
}

export interface DisputePage {
  items: AdminDispute[];
  nextCursor: string | null;
}

/**
 * The reviewed row, as the API answered it, written over its copy in every cached page — the
 * seed that keeps the list honest when the invalidation refetch that follows fails
 * (`applyMarket`'s reasoning). The same object comes back when no page holds the row (a list
 * filtered to another status, an empty cache), so react-query sees no change there; a page
 * that does hold it is copied, never mutated.
 */
export function replaceDisputeRow(
  data: InfiniteData<DisputePage> | undefined,
  fresh: AdminDispute,
): InfiniteData<DisputePage> | undefined {
  if (data === undefined) return undefined;
  let changed = false;
  const pages = data.pages.map((page) => {
    if (!page.items.some((row) => row.id === fresh.id)) return page;
    changed = true;
    return { ...page, items: page.items.map((row) => (row.id === fresh.id ? fresh : row)) };
  });
  return changed ? { ...data, pages } : data;
}
