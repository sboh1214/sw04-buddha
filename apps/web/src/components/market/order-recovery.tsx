'use client';

import { type Dispatch, type RefObject, useEffect, useRef } from 'react';
import { copy } from '@/copy';
import { fetchOrderByRequest } from '@/hooks/use-orders-place';
import { type Order, isApiError } from '@/lib/api';
import {
  type OrderAction,
  type OrderFailure,
  type OrderPanelState,
  requestOwnedBy,
} from '@/lib/order-panel';
import {
  cancelReasonText,
  failureText,
  orderStatusLabel,
  rejectReasonText,
} from '@/lib/order-reasons';
import { clearSessionOrderRequest, readSessionOrderRequest } from '@/lib/order-requests';
import { createAccountToast } from './order-toasts';

/**
 * 답을 잃은 주문의 재조회 (#66, ADR-0140 결정 2-6·2-7): reads an order request whose answer was
 * lost back by its id (`GET /me/orders/request/:requestId`) at once, 2 s and 5 s in, whatever the
 * market's status — the provider that calls it wraps the whole detail, so a `market:status` that
 * takes the order area away leaves it running. Found: the result, and its toast where no panel
 * shows it. Three NOT_FOUNDs: the card that offers the same request again (owner answer 66-Q2), or
 * — on a market that takes no order now — a toast that says to look in MY and the kept request
 * dropped. Three failures: it stays, with 다시 확인. It never sends anything.
 *
 * The area going away under a step only the panel can end does the same: the card's request is
 * dropped with that toast, and a read-back whose 다시 확인 has nowhere to be pressed reads once
 * more by itself, then ends in the toast — its request kept, so a reload still reads it back.
 *
 * On a page that opens with a request this tab kept for the account and the market (a reload, the
 * natural answer to a request that never came back), it starts there: a read, never a send.
 */

/** The waits before each read: at once, then 2 s and 3 s more — 0 s, 2 s and 5 s in. */
export const RECOVERY_DELAYS_MS = [0, 2_000, 3_000] as const;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The toast an order's end gets where no panel shows it (결정 2-7): its state and reason, kept
 * until the reader closes it — or `accountId`, whose order it is, leaves the screen (결정 2-25).
 */
export function orderToast(order: Order, accountId: string): void {
  const reason =
    order.rejectReason !== null
      ? rejectReasonText(order.rejectReason)
      : order.cancelReason !== null
        ? cancelReasonText(order.cancelReason)
        : undefined;
  createAccountToast(accountId, {
    type: order.status === 'rejected' ? 'warning' : 'info',
    title: `${copy.orderResultTitle} · ${orderStatusLabel(order.status)}`,
    ...(reason === undefined ? {} : { description: reason }),
    duration: Number.POSITIVE_INFINITY,
    closable: true,
  });
}

/**
 * A refusal that wrote no row, ended where no panel shows it (결정 2-7): its sentence, kept until
 * the reader closes it or `accountId` leaves the screen (결정 2-25). `endsAtText` is a
 * restriction's end as the screen formats it.
 */
export function failureToast(
  failure: OrderFailure,
  endsAtText: string | null,
  accountId: string,
): void {
  createAccountToast(accountId, {
    type: 'warning',
    title: failureText(failure, endsAtText),
    duration: Number.POSITIVE_INFINITY,
    closable: true,
  });
}

/** A request not found, with no panel to offer it again in: MY's lists say what became of it. */
function lookupMissingToast(accountId: string): void {
  createAccountToast(accountId, {
    type: 'warning',
    title: copy.orderLookupMissing,
    duration: Number.POSITIVE_INFINITY,
    closable: true,
  });
}

/** Whether the step's request, if it holds one, is the account's own (결정 2-22). */
function ownedStep(step: OrderPanelState['step'], accountId: string): boolean {
  if (step.name !== 'unsent' && step.name !== 'recovering') return true;
  return requestOwnedBy(step.request, accountId);
}

export function useOrderRecovery({
  state,
  stateRef,
  dispatch,
  owner,
  accountId,
  marketId,
  area,
  areaRef,
  settled,
  refreshAuth,
  newAttempt,
}: {
  state: OrderPanelState;
  stateRef: RefObject<OrderPanelState>;
  dispatch: Dispatch<OrderAction>;
  /**
   * The account on screen as the provider holds it (결정 2-22): `Me`'s id, null for a visitor,
   * undefined while either is still answering.
   */
  owner: string | null | undefined;
  /** The `Me` on screen's id; nothing is read before it. */
  accountId: string | undefined;
  marketId: string;
  /** Whether the market has its order area now (`showsOrderArea`), as rendered and as a ref. */
  area: boolean;
  areaRef: RefObject<boolean>;
  /** What follows a settled order: the reads again, and the toast where no panel shows it. */
  settled: (order: Order, accountId: string) => void;
  /** Reads the session and `me` again where a refusal says they are out of date (`authRefreshOf`). */
  refreshAuth: (error: unknown, account: string) => Promise<void>;
  newAttempt: () => string;
}): void {
  const recovering =
    state.step.name === 'recovering' && !state.step.exhausted ? state.step.attempt : null;
  useEffect(() => {
    if (recovering === null || accountId === undefined) return;
    const { step } = stateRef.current;
    // Only the sender reads its request back: another account's cookie answers 404 for it.
    if (step.name !== 'recovering' || !requestOwnedBy(step.request, accountId)) return;
    const { requestId } = step.request;
    let cancelled = false;
    void (async () => {
      let misses = 0;
      for (const delay of RECOVERY_DELAYS_MS) {
        await wait(delay);
        if (cancelled) return;
        try {
          const order = await fetchOrderByRequest(requestId);
          if (cancelled) return;
          clearSessionOrderRequest(accountId, marketId, requestId);
          dispatch({ type: 'recovered', attempt: recovering, order });
          settled(order, accountId);
          return;
        } catch (error) {
          if (isApiError(error, 'NOT_FOUND')) misses += 1;
          // A cookie run out (401) or refused (403) says nothing of the order — never '못 찾음' —
          // and the session is read again: 결정 2-22 then decides whose screen it is.
          else void refreshAuth(error, accountId);
        }
      }
      if (cancelled) return;
      if (misses < RECOVERY_DELAYS_MS.length) {
        // Not three answers that it is not there: the reads failed, and 다시 확인 asks again.
        dispatch({ type: 'recoverExhausted', attempt: recovering });
        return;
      }
      dispatch({ type: 'recoverMissed', attempt: recovering });
      if (!areaRef.current) {
        // A market that takes no order now has no reason to send it again (결정 2-7).
        clearSessionOrderRequest(accountId, marketId, requestId);
        dispatch({ type: 'discard' });
        lookupMissingToast(accountId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recovering, accountId, marketId, settled, refreshAuth, dispatch, stateRef, areaRef]);

  // The area gone under a step only the panel can end: the card of a request not found, or a
  // read-back whose 다시 확인 cannot be pressed (결정 2-7).
  const shown = state.step;
  const stranded =
    area || accountId === undefined || !ownedStep(shown, accountId)
      ? null
      : shown.name === 'unsent'
        ? { request: shown.request, exhausted: false }
        : shown.name === 'recovering' && shown.exhausted
          ? { request: shown.request, exhausted: true }
          : null;
  const strandedId = stranded?.request.requestId ?? null;
  const strandedExhausted = stranded?.exhausted ?? false;
  const rereadAlone = useRef<string | null>(null);
  useEffect(() => {
    if (strandedId === null || accountId === undefined) return;
    if (strandedExhausted && rereadAlone.current !== strandedId) {
      // Once more by itself: three NOT_FOUNDs then end in the loop above, the toast included.
      rereadAlone.current = strandedId;
      dispatch({ type: 'recheck', attempt: newAttempt() });
      return;
    }
    // Not found: dropped. Reads that failed twice: kept, so a reload reads it back.
    if (!strandedExhausted) clearSessionOrderRequest(accountId, marketId, strandedId);
    dispatch({ type: 'discard' });
    lookupMissingToast(accountId);
  }, [strandedId, strandedExhausted, accountId, marketId, dispatch, newAttempt]);

  // A request this tab kept for this market and account: read back, never sent (결정 2-6).
  const started = useRef<string | null>(null);
  useEffect(() => {
    // No account on screen (a sign-out, here or in another tab): the panel was reset
    // (`accountChanged`) and the slot kept, so whoever signs in next — the same account
    // included — reads its own slot again (결정 2-22). Another account's own key differs anyway.
    if (owner === null) started.current = null;
    if (accountId === undefined) return;
    const key = `${accountId}:${marketId}`;
    if (started.current === key) return;
    started.current = key;
    const kept = readSessionOrderRequest(accountId, marketId);
    if (kept !== null) dispatch({ type: 'recoverStart', request: kept, attempt: newAttempt() });
  }, [owner, accountId, marketId, dispatch, newAttempt]);
}
