import {
  MARKET_STATUSES,
  type MarketStatus,
  RELATED_MARKET_STATUSES,
  marketSearchTermSchema,
} from '@buddha/shared';
import { copy } from '@/copy';
import { isApiError, isForAnotherAccount, validationField } from './api';
import { MARKET_RESULT_LABEL, MARKET_STATUS_LABEL } from './market-admin';
import { listSection } from './query-client';

/**
 * 관련 시장 (#65, ADR-0068), the admin half: what the admin detail's 관련 시장 panel decides about
 * the markets it lists and finds, kept out of the component so the node test runner reaches it
 * (vitest runs with no DOM here). The detail's public section is the home's grid as it is and
 * decides nothing of its own.
 *
 * Owner decisions (ADR-0061 decision 1, item 19; decision 3, the #65 rows): a link is two-way and
 * made or removed by an admin in any status of either market, with no reason asked and no second
 * admin; the detail shows every public status but 취소, and never a market whose result is 무효
 * (ADR-0093 decision 3, the #174 row).
 */

/**
 * What the picker offers for one market it found: `self` for the market on screen (the API
 * refuses linking a market to itself), `linked` for one that is linked already, from either side —
 * the API would change nothing — and `linkable` for the rest. Every status and result is
 * linkable, a draft, a cancelled and a 무효 market included (ADR-0061 decision 3, #65): the admin
 * keeps links, and the detail's rule decides what a reader sees.
 */
export type RelatedPickState = 'self' | 'linked' | 'linkable';

export function relatedPickState(
  candidateId: string,
  marketId: string,
  linkedIds: ReadonlySet<string>,
): RelatedPickState {
  const id = candidateId.toLowerCase();
  if (id === marketId.toLowerCase()) return 'self';
  return linkedIds.has(id) ? 'linked' : 'linkable';
}

/**
 * The picker's term as the admin list's `q` takes it (`marketSearchTermSchema`: trimmed, 1 to
 * MARKET_SEARCH_TERM_MAX characters), or `undefined` for one it would refuse — then nothing is
 * searched rather than a 400 shown. The schema is the API's own, so the two cannot disagree.
 *
 * The picker's box holds at most `SEARCH_INPUT_MAX_LENGTH` (lib/market-search.ts), as the search
 * boxes do, so a blank box is the only one that reads as no term: a pasted title runs to
 * MARKET_TITLE_MAX (120), and past the bound it searched nothing and cleared the results without
 * a word (review on #65).
 */
export function relatedSearchTerm(input: string): string | undefined {
  return marketSearchTermSchema.safeParse(input).data;
}

/**
 * What pressing 찾기 does: search the box's term, or ask for it again when it is the term already
 * searched. The search is keyed on its term, so setting the same one changes nothing — a search
 * that failed stayed failed, and pressing 찾기 again sent nothing (review on #65). A blank box
 * leaves no term, which takes the results away.
 */
export function relatedSearchSubmit(
  input: string,
  current: string | undefined,
): { term: string | undefined; refetch: boolean } {
  const term = relatedSearchTerm(input);
  return { term, refetch: term !== undefined && term === current };
}

/** What `relatedSearchSection` reads of the picker's search (`useAdminRelatedSearch`). */
export interface RelatedSearchState {
  isPending: boolean;
  isLoadingError: boolean;
  isRefetchError: boolean;
  /** Tells a refetch after a failed 더 보기 from a failed refresh (`refreshFailed`). */
  error: unknown;
  isPlaceholderData: boolean;
  hasNextPage: boolean;
}

/**
 * What the picker's results area shows: the other lists' rungs (`listSection` — a skeleton, a
 * failure, the empty line, or rows with a notice above them when a refresh failed) and whether
 * 더 보기 is offered, which is only under rows.
 *
 * The rows are the submitted term's own answer and nothing else, because each offers 연결 aimed at
 * its market. A newly submitted term is therefore `pending` — a skeleton, no 연결, no 더 보기 —
 * until that answer arrives. The search holds no previous term's pages for it
 * (`adminRelatedSearchQueryOptions` has no `keepPreviousData`), and pages held as a placeholder
 * would read as pending here all the same: shown as ready, a slow search left the last term's rows
 * under the new term, and 연결 on one linked a market the submitted search had not found (Codex
 * review on #214).
 */
export function relatedSearchSection(
  search: RelatedSearchState,
  rowCount: number,
): { stale: boolean; body: 'pending' | 'failed' | 'empty' | 'rows'; more: boolean } {
  if (search.isPlaceholderData) return { stale: false, body: 'pending', more: false };
  const section = listSection(search, rowCount);
  return { ...section, more: section.body === 'rows' && search.hasNextPage };
}

/** One page of the picker's search, as `GET /admin/markets` takes it: the term, and a cursor. */
export function relatedSearchQuery(q: string, cursor?: string): { q: string; cursor?: string } {
  return cursor === undefined ? { q } : { q, cursor };
}

/**
 * The panel's hint: the two markets see each other, which markets a detail does NOT show, and that
 * a link changes neither market. Since #174 the rule is two halves (ADR-0093 decision 3, the #174
 * row; `isRelatedMarketShown`): a status — every one `RELATED_MARKET_STATUSES` leaves out, the
 * admin's 초안·검수 중 and 취소 — and a result, 무효, in whatever status the market holds it. A
 * list of shown statuses cannot say the second half, and would be eight labels long; the hidden
 * ones are three and a result. Both are named by their labels — the ones the same panel badges
 * each linked and found market with (`MARKET_STATUS_LABEL`), and the result's own word
 * (`MARKET_RESULT_LABEL`) — and the statuses come from the API's own filter rather than a list
 * written out in the copy, so the hint follows the statuses.
 */
export function relatedHint(): string {
  const hidden = MARKET_STATUSES.filter(
    (status) => !(RELATED_MARKET_STATUSES as readonly MarketStatus[]).includes(status),
  )
    .map((status) => MARKET_STATUS_LABEL[status])
    .join('·');
  return [
    copy.adminRelatedHint,
    `${hidden}${copy.adminRelatedHintHiddenStatusTail} ${MARKET_RESULT_LABEL.VOID}` +
      copy.adminRelatedHintHiddenResultTail,
    copy.adminRelatedHintNoEffect,
  ].join(' ');
}

/**
 * A refused link or unlink, in words: the market itself (the API names the field that carried
 * the other market in a VALIDATION_ERROR — the body's `marketId` on a link, the path's
 * `relatedMarketId` on an unlink), a market that is not there any more, the cookie of another
 * account (`copy.sessionChanged` — both name the admin on screen, ADR-0092), or anything else.
 */
export function relatedLinkErrorMessage(error: unknown): string {
  if (isForAnotherAccount(error)) return copy.sessionChanged;
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const field = validationField(error);
    if (field === 'marketId' || field === 'relatedMarketId') return copy.errRelatedSelf;
  }
  if (isApiError(error, 'NOT_FOUND')) return copy.adminMarketNotFound;
  return copy.errUnknown;
}
