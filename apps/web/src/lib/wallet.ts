import {
  LEDGER_FILTER_KINDS,
  type LedgerEntryKind,
  type LedgerFilterKind,
  PAID_COIN_SALES_ENABLED,
  type RecentPeriod,
} from '@buddha/shared';
import { type QueryClient, matchQuery } from '@tanstack/react-query';
import { copy } from '@/copy';
import { type LedgerEntry, type Me, type Order } from './api';
import { walletPackageId } from './charge-guide';
import { MY_WALLET_PATH } from './my';
import { firstParam, listFiltersFromSearchParams } from './my-history';
import { ME_KEY } from './query-client';

/**
 * Pure pieces of MY's 지갑 (`/my/wallet`), kept out of `app/my/wallet` so vitest can run them under
 * its node environment — the split lib/my.ts makes for MY's tabs.
 */

/**
 * What 이용 내역 calls each kind of row (#69, ADR-0144; ADR-0135 H1). PLAN Appendix A: never
 * "베팅"; every kind gets plain Korean. A Record over the kinds an answer can carry
 * (LEDGER_ENTRY_KINDS, the stored type and the reader's side of it): a kind added there — 보상
 * (#144) next — without a label fails the typecheck, and the operating treasury's and the
 * 마켓메이커's own types never reach a member's screen.
 *
 * 매수 체결 is the Coin a fill took — a pair mint's collateral and a trade's payment alike, which
 * neither the answer nor this label tells apart (ADR-0135 결과 4); 매도 체결 the Coin a sale
 * brought in. The start Coin (#70) is '시작 지급', its own kind and its own word (ADR-0069 decision
 * 4 #70), never the coupon's '보너스', so the wallet tells the two sources apart (N04 §5); the
 * re-grant a member applied for in the wallet (#74, ADR-0155) is '재지급', a word of its own too. 정산
 * 지급 is every payout, a void market's too — never called a refund. 'Coin 보정' is one name for
 * every correction; what a row did (원장 보충 or the amount) is its effect line.
 */
export const LEDGER_KIND_LABEL: Readonly<Record<LedgerEntryKind, string>> = {
  BUY_FILL: copy.ledgerKindBuyFill,
  SELL_FILL: copy.ledgerKindSellFill,
  SETTLEMENT_PAYOUT: copy.ledgerTypeSettlement,
  START_GRANT: copy.ledgerTypeStartGrant,
  RECONCILIATION_CORRECTION: copy.ledgerTypeReconciliationCorrection,
  REGRANT: copy.ledgerTypeRegrant,
  // 탈퇴 소멸 (#140): written as the account closes, so no member's wallet ever lists it — the
  // label is for completeness of the Record (an operator reads the ledger elsewhere).
  CLOSURE_FORFEIT: copy.ledgerTypeClosureForfeit,
  // The kept paid-Coin and coupon kinds (D9, ADR-0049): rows from before sales closed, under
  // '전체' only — no filter offers them (LEDGER_FILTER_EXCLUDED).
  DEPOSIT: copy.ledgerTypeDeposit,
  BONUS: copy.ledgerTypeBonus,
  PAYMENT_CANCEL: copy.ledgerTypePaymentCancel,
  PAYMENT_CANCEL_REVERSAL: copy.ledgerTypePaymentCancelReversal,
};

/** The kind filter's choices (ADR-0135 H5): '전체' first (no kind), then one per filter kind. */
export const LEDGER_FILTER_OPTIONS: readonly {
  kind: LedgerFilterKind | undefined;
  label: string;
}[] = [
  { kind: undefined, label: copy.ledgerKindAll },
  ...LEDGER_FILTER_KINDS.map((kind) => ({ kind, label: LEDGER_KIND_LABEL[kind] })),
];

/**
 * A filter kind as the address writes it: lower case with hyphens (`buy-fill`), the form of the
 * history's `kind=settlements`. The API's value (`BUY_FILL`) goes only into the request.
 */
export function ledgerKindSlug(kind: LedgerFilterKind): string {
  return kind.toLowerCase().replaceAll('_', '-');
}

/** The wallet ledger's three filters: they are the list's cache key and its request. */
export interface WalletListFilters {
  /** One kind of the filter; absent is '전체' (there is no `all` value). */
  kind?: LedgerFilterKind;
  /** `7d`·`30d`·`90d` by the row's time; absent is the whole ledger. */
  period?: RecentPeriod;
  /** One market's rows: its canonical lower-cased uuid. */
  market?: string;
}

/** The wallet's address, normalised: the ledger's filters and the package `/charge` sent. */
export interface WalletFilters extends WalletListFilters {
  /** `?package=`, kept only while paid Coin is on sale (ADR-0044, ADR-0049). */
  packageId?: string;
}

/** What Next hands the page: a repeated parameter arrives as an array. */
export interface WalletSearchParams {
  kind?: string | string[];
  period?: string | string[];
  market?: string | string[];
  package?: string | string[];
}

/**
 * The address as the wallet's filters. A value the API would refuse is dropped, never sent: an
 * unknown `kind` is '전체', and `period` and `market` as every MY list reads them
 * (`listFiltersFromSearchParams`) — so a hand-edited link opens a list rather than a 400. The
 * package is read only while sales are on, as the page always read it.
 */
export function walletFiltersFromSearchParams(
  searchParams: WalletSearchParams,
  salesEnabled: boolean = PAID_COIN_SALES_ENABLED,
): WalletFilters {
  const slug = firstParam(searchParams.kind);
  const kind = LEDGER_FILTER_KINDS.find((known) => ledgerKindSlug(known) === slug);
  const packageId = salesEnabled ? walletPackageId(searchParams.package) : undefined;
  return {
    ...(kind === undefined ? {} : { kind }),
    ...listFiltersFromSearchParams(searchParams),
    ...(packageId === undefined ? {} : { packageId }),
  };
}

/**
 * The filters as a path, with what is set only: `/my/wallet`, or `/my/wallet?…`. Every way the
 * wallet's filters move writes it — the kind, the period, a market picked or let go, a row's
 * '이 시장만 보기' — and the package `/charge` sent rides along while sales are on.
 */
export function myWalletPath(
  filters: WalletFilters,
  salesEnabled: boolean = PAID_COIN_SALES_ENABLED,
): string {
  const query = new URLSearchParams();
  if (filters.kind !== undefined) query.set('kind', ledgerKindSlug(filters.kind));
  if (filters.period !== undefined) query.set('period', filters.period);
  if (filters.market !== undefined) query.set('market', filters.market.toLowerCase());
  if (salesEnabled && filters.packageId !== undefined) query.set('package', filters.packageId);
  const search = query.toString();
  return search === '' ? MY_WALLET_PATH : `${MY_WALLET_PATH}?${search}`;
}

/**
 * Whether a filter is on: an empty list then says no row matched, not that none exists, and the
 * 반영 후 코인 합계 of one row no longer follows from the next (ADR-0144 결정 2-6).
 */
export function isWalletFiltered(filters: WalletListFilters): boolean {
  return filters.kind !== undefined || filters.period !== undefined || filters.market !== undefined;
}

/** The three filters alone, as the ledger's key and request take them. */
export function walletListFilters(filters: WalletListFilters): WalletListFilters {
  return {
    ...(filters.kind === undefined ? {} : { kind: filters.kind }),
    ...(filters.period === undefined ? {} : { period: filters.period }),
    ...(filters.market === undefined ? {} : { market: filters.market.toLowerCase() }),
  };
}

/**
 * Where a row's '이 시장만 보기' goes (ADR-0144 결정 2; the history's rule, ADR-0143 결정 11-9): the
 * wallet with the same filters and the row's market. None for a row with no market, and none once
 * the list is narrowed to that market.
 */
export function onlyMarketPath(
  entry: Pick<LedgerEntry, 'marketId'>,
  filters: WalletFilters,
): string | undefined {
  if (entry.marketId === null) return undefined;
  if (filters.market?.toLowerCase() === entry.marketId.toLowerCase()) return undefined;
  return myWalletPath({ ...filters, market: entry.marketId });
}

/** What an empty list says: that no row matched while a filter is on, that none exists if not. */
export function ledgerEmptyText(filters: WalletListFilters): string {
  return isWalletFiltered(filters) ? copy.historyFilteredEmpty : copy.ledgerEmpty;
}

/**
 * The line over the rows: what '반영 후 코인 합계' is (ADR-0135 H4), and while a filter is on that
 * the figures no longer follow from one row to the next (ADR-0144 결정 2-6).
 */
export function ledgerBalanceNote(filters: WalletListFilters): string {
  return isWalletFiltered(filters)
    ? `${copy.ledgerBalanceAfterNote} ${copy.ledgerBalanceAfterFilteredNote}`
    : copy.ledgerBalanceAfterNote;
}

/**
 * Whether the list says where the corrections with no ledger row are (ADR-0144 결정 2-8): only
 * under 'Coin 보정', the one filter that would otherwise seem to leave them out.
 */
export function showsCorrectionNote(filters: WalletListFilters): boolean {
  return filters.kind === 'RECONCILIATION_CORRECTION';
}

/**
 * The account's live buys as the wallet compares them (#69, ADR-0144 결정 2-11): their ids,
 * sorted — a buy that left (cancelled, expired, filled whole) or came changes it, and with it 주문
 * 잠금 코인. Not what each still holds: an order's size is fixed at intake (no route changes it),
 * so a remaining quantity moves only by a fill, and the fill's `user:balance` carries the lock
 * (`lockedCoin`) already. A sell locks contracts, not Coin, so sells are not in it.
 */
export function liveBuysReading(orders: readonly Pick<Order, 'id' | 'side'>[]): string {
  return orders
    .filter((order) => order.side === 'buy')
    .map((order) => order.id)
    .sort()
    .join(',');
}

/** The live buys of the last reading the wallet watched, and whose. */
export interface LockBaseline {
  accountId: string;
  buys: string;
}

/**
 * One reading of the live orders, as the wallet's watch takes it: whether `['me']` is read again,
 * and the baseline after. None before a baseline — made from the first reading the screen watches
 * (`watchedReading`, ADR-0141 결정 6's rule), so a change from before the wallet was opened reads
 * nothing — and none when the account changed, where the old baseline is dropped and the new one
 * waits for the new account's first watched reading too. After that, a read whenever the buys
 * differ.
 */
export function lockWatchStep(
  baseline: LockBaseline | undefined,
  accountId: string,
  buys: string,
  watched: boolean,
): { baseline: LockBaseline | undefined; read: boolean } {
  const next = { accountId, buys };
  if (baseline === undefined || baseline.accountId !== accountId) {
    return { baseline: watched ? next : undefined, read: false };
  }
  return { baseline: next, read: baseline.buys !== buys };
}

/** What a `refreshLockedBalance` watch saw of `['me']` by the time its read settled. */
export interface MeReadSeen {
  /** The read was put back to idle (`cancelQueries`, a `user:balance` on its way). */
  cancelled: boolean;
  /** A `GET /me` answered (a cache write — `setQueryData` — is not an answer). */
  answered: boolean;
  /** A `GET /me` failed. */
  failed: boolean;
  /** A newer `GET /me` is on its way at the end. */
  running: boolean;
}

/** Whether the read is still owed: it was cancelled, and nothing brought or refused the balance. */
export function meReadOwed(seen: MeReadSeen): boolean {
  return seen.cancelled && !seen.answered && !seen.failed && !seen.running;
}

/**
 * `['me']` read again for a lock that moved (#69, ADR-0144 결정 2-11): restarted exactly, as the
 * cancel's bundle reads it (`refreshAfterOwnCancel`) — never `['me', …]` below it.
 *
 * Once more if `user:balance` cancelled it (`storeBalanceEvent` cancels a `GET /me` on its way, so
 * an older answer cannot land over the event's balance): the event may carry the balance of a fill
 * committed before this lock moved, so the read it cancelled is still owed. The cancel is seen in
 * the cache, not in the read's promise — query-core answers a cancelled read that had data with
 * that data — as the state put back (`setState` to idle) with no answer of `GET /me` after it (a
 * `success` that is not a cache write). Not once more when a newer `GET /me` is already on its way
 * at the end, or the read failed: the first brings the balance, and a failure is not a cancel
 * (`meReadOwed`). Two lock changes close together watch one read, and one cancel asks once more,
 * not once for each: the watch that ends second finds the first one's read on its way.
 */
export function refreshLockedBalance(queryClient: QueryClient, again = 1): void {
  const filters = { queryKey: ME_KEY, exact: true };
  const seen = { answered: false, cancelled: false, failed: false };
  const stop = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || !matchQuery(filters, event.query)) return;
    const { action } = event;
    if (action.type === 'success' && action.manual !== true) seen.answered = true;
    if (action.type === 'error') seen.failed = true;
    if (action.type === 'setState' && action.state.fetchStatus === 'idle') seen.cancelled = true;
  });
  void queryClient.invalidateQueries(filters).finally(() => {
    stop();
    const running = queryClient.getQueryCache().find(filters)?.state.fetchStatus === 'fetching';
    if (again > 0 && meReadOwed({ ...seen, running })) {
      refreshLockedBalance(queryClient, again - 1);
    }
  });
}

/**
 * Whether the wallet says the start Coin is on its way (#70, ADR-0071): only while the account's
 * grant is recorded and waits for the amount — the release setting `grant.start_coin` is undecided
 * (ADR-0069 decision 4 #70: '지갑에도 지급 대기 중임을 보인다'). Nothing once it is paid (the
 * ledger's 시작 지급 row says so), and nothing for an account with no grant record: one that has
 * not finished the onboarding (#58), or verified a number whose start Coin went to an earlier
 * account (#57-1·#57-17) — the wallet promises Coin only where a grant is waiting.
 *
 * `undefined` is a profile not loaded yet: no notice until it is known.
 */
export function startGrantPending(me: Pick<Me, 'startGrant'> | undefined): boolean {
  return me?.startGrant?.status === 'pending';
}
