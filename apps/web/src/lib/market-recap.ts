import type { MarketResult, MarketStatus, Outcome, PositionStatus } from '@buddha/shared';
import type { QueryClient } from '@tanstack/react-query';
import { copy } from '@/copy';
import type { MySettlement, Position } from './api';
import { myHistoryPath } from './my-history';

/**
 * 종료 시장의 복기 (#34, ADR-0145; ADR-0135 I1·I3, 결과 4): what the detail's 내 포지션 draws once a
 * market has finished, and the ways from the detail to MY's history of this market. Pure functions,
 * kept out of the components so the node test runner reaches them (`lib/my.ts`'s rule).
 *
 * 'recap', not 'review': `market-review.ts` is the admin's opening review in this repo.
 */

/**
 * Which body 내 포지션 draws.
 *
 * - `pending`·`failed`: the positions list's own rungs, and on a paid-out market also the records'
 *   wait — a record list answered from the cache before this mount is not yet a reading;
 * - `recordsFailed`: no read of the records succeeded on this mount — the first read failed, or
 *   the mount's read failed over a list cached before it — so no figure at all rather than a
 *   recap without its payout;
 * - `empty`: nothing held here (`positionEmptyCopy`);
 * - `holding`: the open list's rows (`HoldingRow`), every status before 지급 완료;
 * - `ended`: a cancelled market's rows, if one ever had any — sold-out lines only;
 * - `recap`: 지급 완료, the records with the result beside the rows (`settledRecapOf`).
 */
export type RecapView =
  'pending' | 'failed' | 'recordsFailed' | 'empty' | 'holding' | 'ended' | 'recap';

export interface RecapViewInput {
  status: MarketStatus | undefined;
  /** The positions list the market's status sends its rows to (`positionListStatusFor`). */
  list: PositionStatus;
  /** `sessionListSection`'s body for this market's rows, once the signed-out rung is gone. */
  positions: 'pending' | 'failed' | 'empty' | 'rows';
  /** The account's settlement records of this market (`useMarketSettlements`). */
  records: RecordsReading;
}

/** The settlement records query as `recapViewOf` reads it (`recordsReadingOf`). */
export interface RecordsReading {
  /** The query's `isPending`: a query that is off stays pending, so it is read only when on. */
  pending: boolean;
  /**
   * A read SUCCEEDED on this mount: a list cached by MY's history before the payout is no
   * reading, and neither is a failed read over it (`isFetchedAfterMount` counts failures too).
   */
  readAfterMount: boolean;
  /** No read succeeded on this mount, the last one failed and none is in flight: no list. */
  failed: boolean;
  count: number;
}

/**
 * The body for a market's state and the two lists'. Before 지급 완료 the records are not looked at
 * (the query is off and there can be none: a record is written in the payout's own transaction),
 * so a closed, provisional, resolved or settling market can never read as paid (ADR-0135 F2, N03
 * §5). On a paid-out market nothing is decided before the records were read on this mount, and
 * '없음' needs both lists to have answered.
 */
export function recapViewOf({ status, list, positions, records }: RecapViewInput): RecapView {
  if (positions === 'pending') return 'pending';
  if (positions === 'failed') return 'failed';
  if (status !== 'settled') {
    if (positions === 'empty') return 'empty';
    return list === 'open' ? 'holding' : 'ended';
  }
  if (records.failed) return 'recordsFailed';
  if (records.pending || !records.readAfterMount) return 'pending';
  if (positions === 'empty' && records.count === 0) return 'empty';
  return 'recap';
}

/** The fields of the records query (`useMarketSettlements`) that say what has been read. */
export interface RecordsQueryState {
  isPending: boolean;
  isLoadingError: boolean;
  isRefetchError: boolean;
  /** A read is in flight. The status of a list held through a failed read stays 'error' while
   * the next one runs, so the old failure is not this mount's answer yet. */
  isFetching: boolean;
  /** When the list was last written: a successful read, or a cache write. 0 while there is none. */
  dataUpdatedAt: number;
}

/**
 * The records query as of this card's mount at `mountedAt`. Only a list written at or after the
 * mount is a reading of it (ADR-0145 결정 3-5): `isFetchedAfterMount` also turns true on a FAILED
 * read, so over a list MY's history cached before the payout a failed mount read would have drawn
 * a paid holder's contracts as '보유 없음'. That case is `failed` — 다시 시도, no figure. A read
 * that fails after one succeeded on this mount keeps its list (the card's stale notice). While a
 * read is in flight no failure is reported: an entry cached in 'error' with a list (a failed
 * refetch elsewhere) keeps `isRefetchError` through the mount's own read and the retry, so it
 * waits on the skeleton. A paused read (offline) is not fetching and still shows the failure.
 */
export function recordsReadingOf(
  query: RecordsQueryState,
  mountedAt: number,
  count: number,
): RecordsReading {
  const readAfterMount = query.dataUpdatedAt >= mountedAt;
  return {
    pending: query.isPending,
    readAfterMount,
    failed:
      !query.isFetching && (query.isLoadingError || (query.isRefetchError && !readAfterMount)),
    count,
  };
}

/**
 * The records query's stale time for a card mounted at `mountedAt`: stale until a list was written
 * on this mount, never after (a paid-out market's records neither grow nor change; migration 0064).
 *
 * Not a plain `Infinity`: a query that turns ON (the market paid out while the detail was open)
 * fetches only if its entry is stale, and `refetchOnMount` has already passed. Over a fresh list
 * MY's history cached before the payout, `Infinity` asked nothing and the card waited on its
 * skeleton until a remount — for an account that held nothing there, no `user:position` came to
 * restart it. Before a read on this mount a focus may also ask, which is the retry it needs.
 */
export function recordsStaleTime(mountedAt: number) {
  return (query: { state: { dataUpdatedAt: number } }): number =>
    query.state.dataUpdatedAt >= mountedAt ? Infinity : 0;
}

/**
 * The step the records hook takes on mount and whenever its query turns on, BEFORE its observer
 * reads (ADR-0145 결정 3-5): cancel a read of the entry that is already in flight. Such a read was
 * begun by someone else before this mount — MY's history, left while its refetch was out — and may
 * be from before the payout. Without this the mount's `refetchOnMount: 'always'` (or the query
 * turning on) JOINS it instead of asking (query-core dedupes on a running fetch), its answer is
 * written after the mount, so `recordsReadingOf` takes it and `recordsStaleTime` keeps it fresh: a
 * paid holder's card said 보유 없음 with no payout and no history link (리뷰가 찾음). A cancel
 * leaves the retryer `rejected`, so the observer's own fetch then starts a request of its own
 * (`cancelFirstFetch`'s note in `query-client.ts`); the default `revert` puts the entry back as it
 * was before that read, never newer. No request is added: the cancelled one had already left.
 *
 * The ask behind this cancel (`cancelFirstFetch`'s warning) is the card's own read, on mount or when
 * the query turns on. Where the query stays off — a market not yet `settled`, or a cancelled one —
 * nothing asks again, by design: the answer thrown away is MY history's, and the entry goes back to
 * the state that read began from (stale by time or flagged, or MY's own retry/page), so `/my/history`
 * reads again on its next mount if it needs to; only that answer is lost. A remount before the
 * card's own first read answers also cancels that read and asks again (one more request), and the
 * query turning off (session lost) cancels the card's own read — both follow from "only a read begun
 * after this mount counts" and are harmless.
 */
export function cancelEarlierRecordReads(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
): void {
  void queryClient.cancelQueries({ queryKey, exact: true });
}

/**
 * One contract's block in the recap: its settlement record with the row's 실현 손익, or — no record
 * (sold out before the payout, or a cancelled market) — the result and the row's 실현 손익 alone,
 * never a 정산 손익 of 0 (ADR-0135 결과 4 '#67·#34 보유 0인 계약').
 */
export type RecapEntry =
  | { kind: 'record'; outcome: Outcome; record: MySettlement; realizedPnlCoin: string | null }
  | { kind: 'soldOut'; outcome: Outcome; result: MarketResult | null; realizedPnlCoin: string };

const OUTCOME_ORDER: readonly Outcome[] = ['YES', 'NO'];

/**
 * This market's contracts as the recap draws them, YES first. Every figure is a column read as it
 * is: the record's for the settlement, `Position.realizedPnlCoin` for 실현 손익 — the cumulative one
 * (실현 + 정산, ADR-0107 결정 1 #177 16항), which ADR-0135 결과 4 keeps as the row's one sum with no
 * total line of its own. Nothing is subtracted here: the 실현 손익 before the payout is what ADR-0143
 * chose not to carry, and it is not rebuilt (ADR-0145 결정 3). A record whose row is missing — not
 * expected — still draws, its 실현 손익 '—'.
 */
export function settledRecapOf(positions: Position[], records: MySettlement[]): RecapEntry[] {
  return OUTCOME_ORDER.flatMap((outcome): RecapEntry[] => {
    const position = positions.find((row) => row.outcome === outcome);
    const record = records.find((row) => row.outcome === outcome);
    if (record !== undefined) {
      return [
        { kind: 'record', outcome, record, realizedPnlCoin: position?.realizedPnlCoin ?? null },
      ];
    }
    if (position === undefined) return [];
    return [
      {
        kind: 'soldOut',
        outcome,
        result: position.resolvedResult,
        realizedPnlCoin: position.realizedPnlCoin,
      },
    ];
  });
}

/** The statuses after trading has ended: 내 포지션's empty line says what is held, not 참여. */
const ENDED_STATUSES: ReadonlySet<MarketStatus> = new Set([
  'closed',
  'provisional',
  'resolved',
  'settling',
  'settled',
  'cancelled',
]);

/**
 * 내 포지션's empty line. On a market whose trading has ended it says only that nothing is held —
 * the positions list is its ground, true also for a moment between a payout's two events; whether
 * the account traded here is 내 거래's to say (`marketMyTradesEmpty`).
 */
export function positionEmptyCopy(status: MarketStatus | undefined): string {
  return status !== undefined && ENDED_STATUSES.has(status)
    ? copy.marketMyPositionEmptyEnded
    : copy.marketMyPositionEmpty;
}

/**
 * The detail's three ways to MY's history of this market (ADR-0135 결과 4 '#34 이력 연결', I3):
 * its fills, its settlement records and its ended orders (the history opens on 주문, whose list is
 * the ended orders) — `myHistoryPath`, the address the history's own controls write.
 */
export function marketHistoryLinks(marketId: string): {
  fills: string;
  settlements: string;
  orders: string;
} {
  return {
    fills: myHistoryPath({ kind: 'fills', market: marketId }),
    settlements: myHistoryPath({ kind: 'settlements', market: marketId }),
    orders: myHistoryPath({ market: marketId }),
  };
}
