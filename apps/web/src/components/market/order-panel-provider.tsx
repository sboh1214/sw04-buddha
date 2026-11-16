'use client';

import {
  type MarketStatusRejectReason,
  type MyRestriction,
  type Outcome,
  type RestrictionKind,
} from '@buddha/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { useInstantReached } from '@/hooks/use-instant-reached';
import { useOrderBook } from '@/hooks/use-markets';
import { ME_QUERY_KEY, refreshOwnMe, useMe } from '@/hooks/use-me';
import {
  quoteKey,
  quoteQueryOptions,
  useDebounced,
  usePlaceOrder,
  useQuote,
  useSellable,
} from '@/hooks/use-orders-place';
import { useMyRestriction } from '@/hooks/use-reports';
import {
  type Market,
  type Me,
  type Order,
  type OrderBook,
  type OrderQuote,
  type SellableContract,
} from '@/lib/api';
import { tickingNow } from '@/lib/datetime';
import {
  MD_UP_MEDIA_QUERY,
  type OrderSheetState,
  type PersonalAreaView,
  orderInputClosedReason,
  showsOrderArea,
} from '@/lib/market-detail';
import { ORDERS_KEY, POSITIONS_KEY, marketBookKey, marketSellableKey } from '@/lib/market-keys';
import { myRestrictionKey } from '@/lib/moderation';
import {
  clearSessionOrderDraft,
  keepSessionOrderDraft,
  orderDraftFate,
  readSessionOrderDraft,
} from '@/lib/order-drafts';
import {
  INITIAL_ORDER_PANEL,
  type OrderBlockReason,
  type OrderInput,
  type OrderPanelState,
  type OrderTerms,
  type PendingOrderRequest,
  type SendLock,
  type TermsCheck,
  accountReadView,
  authRefreshOf,
  bestPriceOf,
  bookSideOf,
  bookWatch,
  coinShortfall,
  noWidthRefusal,
  orderBlock,
  orderPanelReducer,
  orderTermsOf,
  panelOwnerChanged,
  panelSignedIn,
  placeBodyOf,
  placeOutcomeOf,
  quoteRefused,
  quoteStatusReason,
  requestOwnedBy,
  requoteNext,
  sameTerms,
  sendLocked,
  sendUnlocked,
  sideMovedSinceQuote,
  stepBusy,
} from '@/lib/order-panel';
import {
  clearSessionOrderRequest,
  keepSessionOrderRequest,
  settleSessionOrderRequest,
  updateSessionOrderRequest,
} from '@/lib/order-requests';
import { restartQueries } from '@/lib/query-client';
import { restrictionsShown } from '@/lib/restriction';
import { useSession } from '@/lib/use-session';
import { failureToast, orderToast, useOrderRecovery } from './order-recovery';
import { dismissAccountToasts } from './order-toasts';

/**
 * 주문 패널의 상태 (#66, ADR-0140 결정 2): one panel for the detail, whichever place draws it — the
 * column from md up, the bottom sheet below — so a width that crosses md keeps what was typed. It
 * wraps the detail's body (`children`), which it never re-renders: an edit here changes this
 * context's consumers only, not the chart, the book or the discussion.
 *
 * It holds the input and the steps (`orderPanelReducer`), the sheet, the quote and the book it
 * reads once for both places, the member's `me`, restriction and 매도 가능액, and every request:
 * the quote, the order with its request id, and the read-back of a lost answer. It wraps the
 * detail whatever the market's status, so the read-back (`useOrderRecovery`) runs on when a
 * `market:status` takes the area away, and a request sent before it still ends — in a toast.
 */

export type AccountBlock = 'admin' | 'restricted' | null;

export interface OrderPanelContextValue {
  marketId: string;
  market: Market | undefined;
  viewer: PersonalAreaView;
  /** Whether the market has an order area (`showsOrderArea`, D1). */
  orderArea: boolean;
  state: OrderPanelState;
  book: OrderBook | undefined;
  /** Whether the viewport is md and up; null before the first commit (SSR, hydration). */
  mdUp: boolean | null;
  sheet: OrderSheetState;
  openSheet: (contract: Outcome) => void;
  closeSheet: () => void;
  me: Me | undefined;
  /** For a member: `me` and the restriction have answered. Always true for a visitor. */
  accountKnown: boolean;
  /** For a member: `GET /me` failed without ever answering, and is not being asked again. */
  accountFailed: boolean;
  /** Reads `me` again after `accountFailed`. */
  retryAccount: () => void;
  account: AccountBlock;
  restrictionEndsAt: string | null;
  /** The chosen contract's 매도 가능액, for a member once read. */
  sellable: SellableContract | undefined;
  check: TermsCheck;
  /** The quote of the input as it is now, once one answered for exactly these terms. */
  quote: OrderQuote | undefined;
  quoteLoading: boolean;
  quoteFailed: boolean;
  /** Reads the quote of the input again, after one that failed. */
  retryQuote: () => void;
  /** 주문 확인's own re-read of the quote and `me` is running. */
  opening: boolean;
  inputClosed: MarketStatusRejectReason | null;
  block: OrderBlockReason | null;
  shortfall: { availableCoin: bigint; needCoin: bigint } | null;
  edit: (patch: Partial<OrderInput>) => void;
  openConfirm: () => Promise<void>;
  back: () => void;
  requote: () => Promise<void>;
  submit: () => Promise<void>;
  resend: () => Promise<void>;
  discard: () => void;
  recheck: () => void;
  newOrder: () => void;
}

const OrderPanelContext = createContext<OrderPanelContextValue | null>(null);

export function useOrderPanel(): OrderPanelContextValue {
  const value = useContext(OrderPanelContext);
  if (value === null) throw new Error('useOrderPanel outside OrderPanelProvider');
  return value;
}

function newId(): string {
  return crypto.randomUUID();
}

/** The viewport at md and up, as an external store: null on the server and through hydration. */
function subscribeMdUp(onChange: () => void): () => void {
  const wide = window.matchMedia(MD_UP_MEDIA_QUERY);
  wide.addEventListener('change', onChange);
  return () => {
    wide.removeEventListener('change', onChange);
  };
}
const mdUpNow = () => window.matchMedia(MD_UP_MEDIA_QUERY).matches;
const mdUpOnServer = () => null;

/** D13's restriction: the account restriction alone (the writing restriction takes no order). */
const ACCOUNT_RESTRICTION_KIND: readonly RestrictionKind[] = ['account'];

export function OrderPanelProvider({
  marketId,
  market,
  now,
  viewer,
  children,
}: {
  marketId: string;
  market: Market | undefined;
  now?: number;
  viewer: PersonalAreaView;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const session = useSession();
  const [state, dispatch] = useReducer(orderPanelReducer, INITIAL_ORDER_PANEL);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  const orderArea = showsOrderArea(market?.status);
  const member = viewer === 'member';

  // ---- the place it is drawn in ----
  const mdUp = useSyncExternalStore<boolean | null>(subscribeMdUp, mdUpNow, mdUpOnServer);
  const { sheet } = state;
  // From md up the column draws the panel and the sheet closes (ADR-0067), from the media
  // query's callback; back below md it stays closed: nobody pressed anything.
  useEffect(() => {
    if (!sheet.open) return;
    const wide = window.matchMedia(MD_UP_MEDIA_QUERY);
    const close = (event: MediaQueryListEvent) => {
      if (event.matches) dispatch({ type: 'closeSheet' });
    };
    wide.addEventListener('change', close);
    return () => {
      wide.removeEventListener('change', close);
    };
  }, [sheet.open]);
  // A market that stops taking orders under the panel (ADR-0140 결정 2-7): what was typed or
  // frozen goes and the sheet closes, decided while rendering (react.dev, "Storing information
  // from previous renders"), as time-zone-provider.tsx does — no effect commits once more for it.
  // A request it leaves without a place to end in is the read-back's (`useOrderRecovery`).
  const [heldArea, setHeldArea] = useState(orderArea);
  if (heldArea !== orderArea) {
    setHeldArea(orderArea);
    if (!orderArea) dispatch({ type: 'areaGone' });
  }
  const panelVisible = orderArea && (mdUp === true || sheet.open);
  const visibleRef = useRef(panelVisible);
  const areaRef = useRef(orderArea);
  useEffect(() => {
    visibleRef.current = panelVisible;
    areaRef.current = orderArea;
  });

  // ---- what it reads ----
  // One observer of the book for both places: the panel bodies take it from here, so opening the
  // sheet starts no `/book` read of its own (`refetchOnMount: 'always'`, ADR-0138).
  const bookQuery = useOrderBook(marketId);
  const book = bookQuery.data;
  const meQuery = useMe();
  const me = member ? meQuery.data : undefined;
  // The restriction of the account on screen, under its id: `me` can name another account before
  // the session does, and the last account's restriction is never read as this one's (결정 2-26).
  const restrictionOwner = me?.id ?? null;
  const restriction = useMyRestriction(restrictionOwner);
  // The holding of the account on screen, under its id: never another account's (결정 2-22).
  const sellableQuery = useSellable(marketId, me?.id);
  // A restriction read that failed does not hold the panel: the server refuses for it anyway.
  const accountView = accountReadView({
    member,
    meAnswered: meQuery.data !== undefined,
    meFailed: meQuery.isError,
    meFetching: meQuery.isFetching,
    restrictionSettled: restriction.data !== undefined || restriction.isError,
  });
  const accountKnown = accountView === 'ready';
  // `GET /me` failed without ever answering: said, with 다시 시도, never a skeleton for good.
  const accountFailed = accountView === 'failed';
  const refetchMe = meQuery.refetch;
  const retryAccount = useCallback(() => {
    void refetchMe();
  }, [refetchMe]);
  const admin = me?.profile.role === 'admin';
  // A term account restriction ends by itself at its `endsAt` (#45-12), on the server's clock
  // (`now`) as the close below: from that instant it holds nothing, and the restriction is read
  // again — nothing is published when a term runs out (결정 2-11).
  const heldRestriction = member ? (restriction.data?.accountRestriction ?? null) : null;
  const refreshRestriction = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: myRestrictionKey(restrictionOwner),
      exact: true,
    });
  }, [queryClient, restrictionOwner]);
  const restrictionEnded = useInstantReached(
    heldRestriction?.endsAt ?? null,
    now,
    refreshRestriction,
  );
  const restrictedDetails = restrictionEnded ? null : heldRestriction;
  const account: AccountBlock = admin ? 'admin' : restrictedDetails !== null ? 'restricted' : null;
  // 확인's own check reads the restriction from the cache, after its await: judged on the same
  // clock — the server's `now` plus the time since this screen took it (`tickingNow`).
  const [clockAnchor] = useState(now);
  const clockOrigin = useRef<number | undefined>(undefined);
  useEffect(() => {
    clockOrigin.current ??= performance.now();
  }, []);
  const serverNow = useCallback(() => {
    const origin = clockOrigin.current ?? performance.now();
    return tickingNow(clockAnchor, performance.now() - origin, Date.now());
  }, [clockAnchor]);
  // 주문 제출 reads it at the press as well (D13, owner answer 66-Q3).
  const accountBlockRef = useRef(account);
  useEffect(() => {
    accountBlockRef.current = account;
  });

  // ---- whose panel it is (결정 2-22) ----
  // The account on screen: `me`'s id for a member, null for a visitor, undefined while either is
  // still answering. When it turns into another account or none — a sign-out or another sign-in
  // in another tab (SessionCacheGuard, ADR-0090) — what was typed, frozen, sent or ended goes,
  // decided while rendering as the area below is: nothing of one account is shown to the next
  // or sent in its name. A request in flight stays in its sender's slot (order-requests.ts). The
  // one step that stays is 로그인 안내 turning to no one: a session run out at 주문 제출 (401),
  // whose input is already the draft for the sign-in's return (`accountChanged`'s `to`).
  const owner = member ? meQuery.data?.id : viewer === 'visitor' ? null : undefined;
  const [heldOwner, setHeldOwner] = useState(owner);
  if (owner !== undefined && owner !== heldOwner) {
    setHeldOwner(owner);
    if (panelOwnerChanged(heldOwner, owner)) dispatch({ type: 'accountChanged', to: owner });
    // The sign-in 로그인 안내 asked for, here or in another tab: 입력 again with what was typed,
    // whether or not a draft comes back below (D3·D4) — nothing is sent.
    else if (panelSignedIn(heldOwner, owner)) dispatch({ type: 'signedIn' });
  }
  // The toasts an account's orders left where no panel showed them (결정 2-7) go when it leaves
  // the screen — another account or none — so the next one never reads them (결정 2-25). An
  // effect, after the render that saw the turn; the dismissal itself waits a microtask more.
  const toastOwner = useRef(owner);
  useEffect(() => {
    if (owner === undefined) return;
    const before = toastOwner.current;
    toastOwner.current = owner;
    if (typeof before === 'string' && before !== owner) dismissAccountToasts(before);
  }, [owner]);
  // The account a late answer may still speak to: the one on screen while this provider is
  // mounted, and none once it is not — a send that outlives the detail (the sheet closed, the
  // page left, another account signed in elsewhere) settles its sender's slot and shows nothing:
  // no dispatch, and no toast in whoever's session the global toaster now serves (결정 2-22).
  const ownerRef = useRef(owner);
  useEffect(() => {
    ownerRef.current = owner;
  });
  useEffect(
    () => () => {
      ownerRef.current = undefined;
    },
    [],
  );

  // The close comes on the server's clock (`now`): input and 주문 제출 go off at that instant,
  // ahead of the book's own re-read a second later (ADR-0135 결과 4, ADR-0138).
  const closeAt = orderArea ? (market?.closeAt ?? null) : null;
  const closeReached = useInstantReached(closeAt, now);
  const gap = orderInputClosedReason(market?.status, book, closeReached);
  // 주문 제출 reads it at the press: past the close it sends nothing (결정 2-16).
  const gapRef = useRef(gap);
  useEffect(() => {
    gapRef.current = gap;
  });

  // ---- the quote of the input as it is ----
  const check = orderTermsOf(state.input);
  const terms = check.ok ? check.terms : null;
  const termsKey = terms === null ? null : JSON.stringify(terms);
  const settledKey = useDebounced(termsKey);
  const settledTerms = useMemo(
    () => (settledKey === null ? null : (JSON.parse(settledKey) as OrderTerms)),
    [settledKey],
  );
  const editing = state.step.name === 'editing' || state.step.name === 'signIn';
  const quoteQuery = useQuote(marketId, settledTerms, orderArea && gap === null && editing);
  const current = settledKey !== null && settledKey === termsKey;
  const quote = current ? quoteQuery.data : undefined;
  const noWidth = current && noWidthRefusal(quoteQuery.error);
  const quoteFailed = current && quoteQuery.isError && !noWidth;
  const quoteLoading = terms !== null && (!current || quoteQuery.isFetching) && gap === null;
  const refetchQuote = quoteQuery.refetch;
  const retryQuote = useCallback(() => {
    void refetchQuote();
  }, [refetchQuote]);
  const inputClosed = gap ?? quoteStatusReason(quote);
  const sellable = member
    ? sellableQuery.data?.contracts.find((c) => c.outcome === state.input.outcome)
    : undefined;
  const block = orderBlock({
    input: state.input,
    quote,
    noWidth,
    bestOpposite: bestPriceOf(book, state.input.outcome, state.input.side),
    account,
    unlockedQty: sellable?.unlockedQty,
  });
  const shortfall =
    member && state.input.side === 'buy' ? coinShortfall(quote, me?.balance.availableCoin) : null;

  // ---- 입력: a book move reads the quote again, within limits (requoteNext) ----
  // The chosen side of the book as it is now, from the cache.
  const sideNow = useCallback(
    () =>
      bookSideOf(
        queryClient.getQueryData<OrderBook>(marketBookKey(marketId)),
        stateRef.current.input.outcome,
        stateRef.current.input.side,
      ),
    [queryClient, marketId],
  );
  // What a book move is compared with: the side as it stood when the last read that ended —
  // answered or failed — STARTED; not when it ended, or a move while it was in flight would be
  // taken as quoted and the read it held back dropped. A read started before the book was known
  // leaves it unknown, never the side at its end: that quote may predate the liquidity there now,
  // so the first book known reads it again once (`sideMovedSinceQuote`), and that read takes the
  // side it started on. A failed read takes its start too, so a quote that keeps failing is asked
  // again by a book move or 다시 견적, not by every book that answers.
  const quotedLevels = useRef<ReturnType<typeof bookSideOf>>(undefined);
  const requestedLevels = useRef<ReturnType<typeof bookSideOf>>(undefined);
  const quoteEndedAt = Math.max(quoteQuery.dataUpdatedAt, quoteQuery.errorUpdatedAt);
  useEffect(() => {
    if (quoteEndedAt === 0) return;
    quotedLevels.current = requestedLevels.current;
  }, [quoteEndedAt]);
  // When the last quote read STARTED, a keystroke's or a book move's: the gap counts from it, so
  // a read that failed or is still running spaces the next as much as one that answered.
  const quoteFetching = quoteQuery.isFetching;
  const lastQuoteAttempt = useRef<number | undefined>(undefined);
  const noteQuoteStart = useCallback(() => {
    lastQuoteAttempt.current = Date.now();
    requestedLevels.current = sideNow();
  }, [sideNow]);
  // A new key's read that starts while the last one runs is a start too (`settledKey`).
  useEffect(() => {
    if (quoteFetching) noteQuoteStart();
  }, [quoteFetching, settledKey, noteQuoteStart]);
  // What a book move is decided on as it stands when it is decided — a new book, the gap's end or
  // a read's end — kept here so those run on that alone.
  const requoteFacts = useRef({ editing, inputValid: false, panelVisible, inFlight: false });
  useEffect(() => {
    requoteFacts.current = {
      editing,
      inputValid: terms !== null && current,
      panelVisible,
      inFlight: quoteFetching,
    };
  });
  // A move the gap or a read in flight holds back is pending, not dropped: a trailing read at the
  // gap's end (the timer) or the read's end (below) decides it again (결정 2-13).
  const requoteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requotePending = useRef(false);
  const cancelRequote = useCallback(() => {
    clearTimeout(requoteTimer.current);
    requoteTimer.current = undefined;
    requotePending.current = false;
  }, []);
  const requoteOnBook = useCallback(
    function requoteOnBook() {
      cancelRequote();
      const facts = requoteFacts.current;
      if (!facts.editing) return;
      const levels = sideNow();
      const before = quotedLevels.current;
      const decision = requoteNext({
        sideChanged: sideMovedSinceQuote(before, levels),
        lastAttemptAt: lastQuoteAttempt.current,
        inFlight: facts.inFlight,
        now: Date.now(),
        panelVisible: facts.panelVisible,
        tabVisible: document.visibilityState === 'visible',
        inputValid: facts.inputValid,
      });
      if (decision.next === 'now') {
        noteQuoteStart();
        // Never cancels a read already running (a keystroke's), which would start it over.
        void refetchQuote({ cancelRefetch: false });
      } else if (decision.next === 'afterFetch') {
        requotePending.current = true;
      } else if (decision.next === 'wait') {
        requotePending.current = true;
        requoteTimer.current = setTimeout(requoteOnBook, decision.ms);
      }
    },
    [cancelRequote, sideNow, noteQuoteStart, refetchQuote],
  );
  useEffect(() => {
    if (book !== undefined) requoteOnBook();
  }, [book, requoteOnBook]);
  // A read's end decides a move it held back.
  useEffect(() => {
    if (!quoteFetching && requotePending.current) requoteOnBook();
  }, [quoteFetching, requoteOnBook]);
  // Back in 입력 on screen — the sheet opened again, '수정' from 확인 — a move the panel could not
  // read on while away is decided now, by the same rules; out of it, off screen or unmounted,
  // nothing waits to read.
  useEffect(() => {
    if (editing && panelVisible) requoteOnBook();
    else cancelRequote();
  }, [editing, panelVisible, requoteOnBook, cancelRequote]);
  // The tab shown again: likewise ((d) held the move back while it was hidden).
  useEffect(() => {
    const onShown = () => {
      if (document.visibilityState === 'visible') requoteOnBook();
    };
    document.addEventListener('visibilitychange', onShown);
    return () => {
      document.removeEventListener('visibilitychange', onShown);
    };
  }, [requoteOnBook]);
  useEffect(() => cancelRequote, [cancelRequote]);

  // ---- 확인: the book moving under a frozen quote is told, never blocks (D7) ----
  // Decided while rendering, like the area above: `bookWatch` answers null once its answer is in.
  const watched = bookWatch(state.step, book, bookQuery.dataUpdatedAt);
  if (watched !== null) dispatch(watched);

  // ---- what follows a settled order: the balance and holdings that moved (결정 2-15) ----
  // Restarted, not merely invalidated (`restartQueries`): a FIRST read still in flight left
  // before the order settled, and an invalidation would only wait on it — its pre-order answer
  // landing as fresh (매도 가능 0 after a buy). `me` always holds data here (no order goes
  // before it answers), so its invalidation restarts a running read by itself (`cancelRefetch`).
  const afterOrder = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY, exact: true });
    void restartQueries(queryClient, marketSellableKey(marketId));
    void restartQueries(queryClient, POSITIONS_KEY);
    void restartQueries(queryClient, ORDERS_KEY);
    void restartQueries(queryClient, marketBookKey(marketId));
  }, [queryClient, marketId]);

  // The toast an order's end gets where no panel shows it (결정 2-7).
  const toldWhereHidden = useCallback((order: Order, account: string) => {
    if (!areaRef.current || !visibleRef.current) orderToast(order, account);
  }, []);
  const settled = useCallback(
    (order: Order, account: string) => {
      afterOrder();
      toldWhereHidden(order, account);
    },
    [afterOrder, toldWhereHidden],
  );

  // ---- sending ----
  const place = usePlaceOrder();
  const placeOrder = place.mutateAsync;
  const sending = useRef<SendLock | null>(null);
  const accountId = me?.id;
  const format = useFormatDateTime();

  // Whether this sign-in cycle's draft was looked for (로그인 뒤 복원, below): once per cycle.
  const restoreChecked = useRef(false);

  // The session and `me` a refusal says are out of date (`authRefreshOf`), read again.
  const refetchSession = session.refetch;
  const refreshAuth = useCallback(
    async (error: unknown, account: string): Promise<void> => {
      const auth = authRefreshOf(error);
      // Settled, not all: a read that fails leaves the read-back to its own answers.
      await Promise.allSettled([
        auth.session ? refetchSession() : undefined,
        auth.me ? refreshOwnMe(queryClient, account) : undefined,
      ]);
    },
    [refetchSession, queryClient],
  );

  // The sender's slot is settled as the answer says; the screen hears of it only while the sender
  // is still the account on it (결정 2-22): another account sees nothing of it. Settled by this
  // send alone (`request.sendId`, 결정 2-5): this POST can outlive its page and end after the same
  // id went again from the page come back to, whose record a reload reads back by — an older
  // send's order, refusal or lost answer leaves it (order-requests.ts).
  const send = useCallback(
    async (request: PendingOrderRequest, account: string) => {
      try {
        const result = await placeOrder({
          marketId,
          requestId: request.requestId,
          body: request.body,
        });
        settleSessionOrderRequest(account, marketId, request);
        // The reads it moved are asked again whoever is on screen now — a cache, never a screen.
        afterOrder();
        if (ownerRef.current !== account) return;
        dispatch({
          type: 'placed',
          requestId: request.requestId,
          order: result.order,
          replayed: result.replayed,
        });
        toldWhereHidden(result.order, account);
      } catch (error) {
        const outcome = placeOutcomeOf(error, request.phase);
        if (outcome.next === 'failed') {
          settleSessionOrderRequest(account, marketId, request);
        } else {
          // Only while the slot still holds this id and this send: a newer request kept since,
          // or this one sent again since, stays.
          updateSessionOrderRequest(account, marketId, { ...request, phase: 'unknown' });
        }
        // Whatever became of the order, a run-out session, another account's cookie, the gate or
        // an admin's FORBIDDEN (`me` read again says whether it was that, D13) is read again
        // (`authRefreshOf`). A resend's 401 or 403 leaves the order unknown and its request in
        // the sender's slot: its read-back waits for the session read again, so it never asks
        // with a cookie run out or another account's, and 결정 2-22 decides whose screen it is.
        const refreshed = refreshAuth(error, account);
        if (outcome.next === 'recover' && authRefreshOf(error).session) await refreshed;
        if (ownerRef.current !== account) return;
        if (outcome.next === 'failed') {
          const { failure } = outcome;
          if (failure.code === 'UNAUTHENTICATED' || failure.code === 'ONBOARDING_REQUIRED') {
            // Kept like a visitor's input: the sign-in or the gate comes back to this market.
            if (market !== undefined) {
              keepSessionOrderDraft(market, stateRef.current.input);
              // A new sign-in cycle: the draft is given back on the return (결정 2-12).
              restoreChecked.current = false;
            }
          }
          if (failure.code === 'NOT_FOUND') afterOrder();
        } else if (outcome.next === 'lookup') {
          // A request id this tab made, met with other terms: a bug, never a user's doing.
          console.error('DUPLICATE_REQUEST for order request', request.requestId);
        }
        dispatch({
          type: 'placeFailed',
          requestId: request.requestId,
          outcome,
          attempt: newId(),
        });
        if (outcome.next === 'failed' && (!areaRef.current || !visibleRef.current)) {
          // A refusal that ends where no panel shows it is told as a success is (결정 2-7), and
          // no stale card waits for the next 'YES 매수': the area's own reset where it is gone,
          // 입력 with what was typed (D12) where the sheet was closed.
          const endsAt = outcome.failure.restrictedEndsAt;
          failureToast(outcome.failure, endsAt == null ? null : format(endsAt), account);
          dispatch(areaRef.current ? { type: 'newOrder' } : { type: 'areaGone' });
        }
      }
    },
    [placeOrder, marketId, toldWhereHidden, market, refreshAuth, afterOrder, format],
  );

  const submit = useCallback(async () => {
    // Locked before anything renders: a second press in the same frame sends nothing. The lock is
    // this account's own (`sendLocked`): another account's request still waiting holds nothing.
    if (accountId === undefined || sendLocked(sending.current, accountId)) return;
    // D13 learned while 확인 was open: its line says why, and nothing goes (owner answer 66-Q3).
    if (accountBlockRef.current !== null) return;
    const { step } = stateRef.current;
    if (step.name !== 'confirm' || step.requote !== null || gapRef.current !== null) return;
    // The account 확인 was opened for, and no other: the body names it (결정 2-4·2-22).
    if (step.accountId !== accountId) return;
    let body;
    try {
      body = placeBodyOf(step.frozen, step.accountId);
    } catch {
      return;
    }
    sending.current = { account: accountId, requestId: step.requestId };
    const request: PendingOrderRequest = {
      requestId: step.requestId,
      sendId: newId(),
      body,
      savedAt: Date.now(),
      phase: 'first',
    };
    keepSessionOrderRequest(accountId, marketId, request);
    dispatch({ type: 'submit', request });
    try {
      await send(request, accountId);
    } finally {
      // Only this request's lock: a newer one taken since (another account's) stays.
      sending.current = sendUnlocked(sending.current, request.requestId);
    }
  }, [accountId, marketId, send]);

  const resend = useCallback(async () => {
    if (accountId === undefined || sendLocked(sending.current, accountId)) return;
    const { step } = stateRef.current;
    // Another account's request is never sent again, nor kept, in this one's name (결정 2-22).
    if (step.name !== 'unsent' || !requestOwnedBy(step.request, accountId)) return;
    sending.current = { account: accountId, requestId: step.request.requestId };
    // The same id and body as a send of its own: the slot is this send's from here, and the end
    // of the one before it — still in flight from a page that was left — no longer settles it.
    const request: PendingOrderRequest = { ...step.request, phase: 'unknown', sendId: newId() };
    keepSessionOrderRequest(accountId, marketId, request);
    dispatch({ type: 'resend', request });
    try {
      await send(request, accountId);
    } finally {
      // Only this request's lock: a newer one taken since (another account's) stays.
      sending.current = sendUnlocked(sending.current, request.requestId);
    }
  }, [accountId, marketId, send]);

  // ---- reading a lost answer back by its id (결정 2-6, order-recovery.tsx) ----
  useOrderRecovery({
    state,
    stateRef,
    dispatch,
    owner,
    accountId,
    marketId,
    area: orderArea,
    areaRef,
    settled,
    refreshAuth,
    newAttempt: newId,
  });

  // ---- 로그인 뒤 복원 (D3·D4, owner answer 66-Q4) ----
  useEffect(() => {
    // Signed out (here, in another tab, or a session run out): the next sign-in is a cycle of its
    // own, whose draft is given back once — on this detail still mounted, with no reload.
    if (viewer === 'visitor') restoreChecked.current = false;
    if (restoreChecked.current || viewer === 'unknown') return;
    // A visitor's input waits for the sign-in; the width decides whether the sheet opens.
    if (viewer === 'visitor' || mdUp === null) return;
    const fate = orderDraftFate({
      signedIn: true,
      accountKnown,
      status: market?.status,
      mayOrder: account === null,
    });
    if (fate === 'wait') return;
    restoreChecked.current = true;
    const input = readSessionOrderDraft(marketId);
    if (input === null) return;
    clearSessionOrderDraft(marketId);
    if (fate === 'drop' || stepBusy(stateRef.current.step)) return;
    // Below md the sheet opens on the restored contract, so its 'YES 매수' takes the focus back.
    dispatch({ type: 'restore', input, openSheet: mdUp === false });
  }, [viewer, accountKnown, market?.status, account, marketId, mdUp]);

  // ---- actions ----
  const edit = useCallback((patch: Partial<OrderInput>) => {
    dispatch({ type: 'edit', patch });
  }, []);
  const openSheet = useCallback((contract: Outcome) => {
    dispatch({ type: 'openSheet', outcome: contract });
  }, []);
  const closeSheet = useCallback(() => {
    dispatch({ type: 'closeSheet' });
  }, []);

  const rereadBook = useCallback(() => {
    void queryClient.refetchQueries({ queryKey: marketBookKey(marketId), exact: true });
  }, [queryClient, marketId]);

  const [opening, setOpening] = useState(false);
  const openConfirm = useCallback(async () => {
    const { step, input } = stateRef.current;
    if (step.name !== 'editing' || terms === null || block !== null || inputClosed !== null) {
      return;
    }
    if (viewer === 'visitor') {
      if (market !== undefined) keepSessionOrderDraft(market, input);
      dispatch({ type: 'signIn' });
      return;
    }
    if (accountId === undefined) return;
    setOpening(true);
    try {
      // 확인 shows a quote read now and the balance read now (결정 2-3), frozen with the terms.
      const [fresh] = await Promise.all([
        queryClient.fetchQuery(quoteQueryOptions(marketId, terms, true)),
        queryClient.refetchQueries({ queryKey: ME_QUERY_KEY, exact: true }),
      ]);
      const now = stateRef.current;
      const nowCheck = orderTermsOf(now.input);
      if (now.step.name !== 'editing' || !nowCheck.ok || !sameTerms(nowCheck.terms, terms)) return;
      // A refused quote stays in 입력, where its line says why.
      if (quoteRefused(terms, fresh) || quoteStatusReason(fresh) !== null) return;
      // D13 from the `me` read just now and the restriction as it stands: an account that turned
      // admin or restricted, or another account, stays in 입력 under its line (owner answer 66-Q3).
      const freshMe = queryClient.getQueryData<Me>(ME_QUERY_KEY);
      // The restriction of the account 확인 opens for, under its id (결정 2-26).
      const freshRestriction = queryClient.getQueryData<MyRestriction>(
        myRestrictionKey(accountId ?? null),
      );
      // Only one that stands now: a term past its end holds nothing, as on the screen (결정 2-11).
      const freshRestricted =
        restrictionsShown(freshRestriction, serverNow(), ACCOUNT_RESTRICTION_KIND).length > 0;
      if (
        freshMe?.id !== accountId ||
        freshMe.profile.role === 'admin' ||
        freshRestricted ||
        accountBlockRef.current !== null
      ) {
        return;
      }
      dispatch({
        type: 'openConfirm',
        frozen: { terms, quote: fresh, quotedAt: Date.now() },
        requestId: newId(),
        accountId,
      });
      // D7's baseline: a book read that starts after the quote answered (`bookWatch`).
      rereadBook();
    } catch {
      // The quote's error is in its query now, and the panel says it there.
    } finally {
      setOpening(false);
    }
  }, [
    terms,
    block,
    inputClosed,
    viewer,
    market,
    accountId,
    queryClient,
    marketId,
    rereadBook,
    serverNow,
  ]);

  const back = useCallback(() => {
    dispatch({ type: 'back' });
  }, []);

  const requote = useCallback(async () => {
    const { step } = stateRef.current;
    if (step.name !== 'confirm' || step.requote !== null) return;
    const token = newId();
    const frozenTerms = step.frozen.terms;
    dispatch({ type: 'requoteStart', token });
    try {
      const fresh = await queryClient.fetchQuery(quoteQueryOptions(marketId, frozenTerms, true));
      if (quoteRefused(frozenTerms, fresh) || quoteStatusReason(fresh) !== null) {
        // Nothing can be sent on it: back to 입력, where the quote's line says why.
        queryClient.setQueryData(quoteKey(marketId, frozenTerms), fresh);
        dispatch({ type: 'requoteRefused', token });
        return;
      }
      dispatch({
        type: 'requoteDone',
        token,
        frozen: { terms: frozenTerms, quote: fresh, quotedAt: Date.now() },
        requestId: newId(),
      });
      rereadBook();
    } catch {
      dispatch({ type: 'requoteFailed', token });
    }
  }, [queryClient, marketId, rereadBook]);

  const discard = useCallback(() => {
    const { step } = stateRef.current;
    // Another account's request stays in its own slot, for that account's return (결정 2-22).
    if (
      accountId !== undefined &&
      step.name === 'unsent' &&
      requestOwnedBy(step.request, accountId)
    ) {
      clearSessionOrderRequest(accountId, marketId, step.request.requestId);
    }
    dispatch({ type: 'discard' });
  }, [accountId, marketId]);
  const recheck = useCallback(() => {
    dispatch({ type: 'recheck', attempt: newId() });
  }, []);
  const newOrder = useCallback(() => {
    dispatch({ type: 'newOrder' });
  }, []);

  const value: OrderPanelContextValue = {
    marketId,
    market,
    viewer,
    orderArea,
    state,
    book,
    mdUp,
    sheet,
    openSheet,
    closeSheet,
    me,
    accountKnown,
    accountFailed,
    retryAccount,
    account,
    restrictionEndsAt: restrictedDetails?.endsAt ?? null,
    sellable,
    check,
    quote,
    quoteLoading,
    quoteFailed,
    retryQuote,
    opening,
    inputClosed,
    block,
    shortfall,
    edit,
    openConfirm,
    back,
    requote,
    submit,
    resend,
    discard,
    recheck,
    newOrder,
  };
  return <OrderPanelContext value={value}>{children}</OrderPanelContext>;
}
