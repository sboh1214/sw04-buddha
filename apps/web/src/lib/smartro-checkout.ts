/**
 * The decisions of one SmartroPay window (ADR-0042, DESIGN §6.2): what each signal from the SDK,
 * its layer and the browser means for the buy buttons. Pure, so they run in this app's node-only
 * test runner; `SmartroCheckout` feeds it the signals and carries out what it answers (the two
 * clocks, the approval post, the layer's close), and `ChargeForm` keeps the phase it reports.
 */

/**
 * Where one payment window is:
 * - `loading`: the SDK script is on its way (or `init`/`payment` are running).
 * - `open`: the PC layer is up.
 * - `leaving`: a phone — the SDK is submitting the whole page to tmpay/mpay.
 * - `approving`: the PC callback came back; `approvalForm` is posting to our ReturnUrl.
 * - `closed`: the payer closed the layer, or the SDK refused its own form (it has said why in
 *   an `alert`), or the page came back from the back/forward cache, or the approval post was
 *   still here when its clock ran out, or the window unmounted while loading or open.
 * - `failed`: the SDK never became available (blocked, offline, or broken).
 * The first four keep every buy button disabled; the last two give them back.
 */
export type CheckoutPhase = 'loading' | 'open' | 'leaving' | 'approving' | 'closed' | 'failed';

export const ACTIVE_CHECKOUT_PHASES: ReadonlySet<CheckoutPhase> = new Set([
  'loading',
  'open',
  'leaving',
  'approving',
]);

/**
 * How long the page may still be here after the approval post before it gives the buttons back.
 * The post is a top-level navigation, and the page normally goes with it once the ReturnUrl has
 * approved; a page still here has had its post refused (a navigation the browser blocked) or
 * stopped by the payer, and nothing else would ever move it on. The ReturnUrl may make two PG
 * calls in a row before it answers — an approval that goes unanswered for the API's bound on one
 * call (smartro-client `SMARTRO_TIMEOUT_MS`, 25 s), then the result inquiry — so the clock
 * covers both, and a slow approval is not taken for a lost one. Should it still run out while
 * the post is answering (a net cancel after that), the answer still takes the page to the
 * wallet with the result: the buttons only came back early.
 */
export const SMARTRO_APPROVAL_TIMEOUT_MS = 60_000;

/** One window's state: its phase, and the two facts the phase alone does not keep. */
export interface CheckoutState {
  phase: CheckoutPhase;
  /** The SDK has removed the PC layer: an approval callback, if there is one, is on its way. */
  layerGone: boolean;
  /** The PC callback came and its approval was posted: a window approves once. */
  answered: boolean;
}

/** Every window starts here, the phase the caller gives it when it mounts one. */
export const CHECKOUT_START: CheckoutState = {
  phase: 'loading',
  layerGone: false,
  answered: false,
};

/**
 * What the page learns about one window:
 * - `unavailable`: the script failed to load, or loaded without defining `window.smartropay`.
 * - `threw`: `init` or `payment` threw.
 * - `payment`: `payment()` returned. `wentAhead` when it answered the SDK object (nothing means
 *   its own validation refused, after an `alert`); `layer` whether `#smartropay-wrapper` was in
 *   the page right after (read on a PC only).
 * - `layer-removed`: the SDK took the PC layer away — on every close, an approval's included.
 * - `grace-elapsed`: `SMARTRO_CALLBACK_GRACE_MS` after `layer-removed`.
 * - `callback`: the PC `Callback` ran.
 * - `approval-timeout`: `SMARTRO_APPROVAL_TIMEOUT_MS` after the approval post, page still here.
 * - `restored`: `pageshow` with `persisted`: the back/forward cache handed this page back.
 * - `unmounted`: the component went away for good while the page stayed — a client-side
 *   navigation (the browser's back button, a link reached behind the overlay). Not a development
 *   StrictMode replay of its effects, which the component tells apart before it says so.
 */
export type CheckoutEvent =
  | { type: 'unavailable' }
  | { type: 'threw' }
  | { type: 'payment'; wentAhead: boolean; mobile: boolean; layer: boolean }
  | { type: 'layer-removed' }
  | { type: 'grace-elapsed' }
  | { type: 'callback' }
  | { type: 'approval-timeout' }
  | { type: 'restored' }
  | { type: 'unmounted' };

/**
 * What the component must do after a step, besides reporting a phase that moved:
 * - `await-callback`: start the grace clock, which ends in `grace-elapsed`.
 * - `post-approval`: fill and submit `approvalForm`, then start the approval clock, which ends
 *   in `approval-timeout`.
 * - `close-layer`: take the PC layer down (the SDK's `end`, or `#smartropay-wrapper` itself).
 */
export type CheckoutEffect = 'await-callback' | 'post-approval' | 'close-layer';

export interface CheckoutStep {
  state: CheckoutState;
  effect?: CheckoutEffect;
}

/**
 * One window's answer to one event.
 *
 * - The opening moves only a window still `loading` — a defensive guard, so that however the
 *   load reports itself, one failure is one toast.
 *   A throw is `failed` rather than `closed`: unlike the SDK's refusal, it came with no `alert`,
 *   so the caller's toast is the only word the payer gets.
 * - The layer's removal alone cannot tell a close from an approval, whose callback runs ~500 ms
 *   AFTER it; the grace does. A callback is the payer's approval whatever the page concluded in
 *   the meantime — a main thread so busy that the grace ran out first still posts it — but only
 *   once.
 * - The approval clock and the back/forward cache end the window only where it still holds the
 *   buttons: a page restored after the approval's navigation is the same page, buttons disabled
 *   for a window that is gone.
 * - A layer still up when its window unmounts is closed with it. The SDK put the layer straight
 *   into `<body>`, outside React, so it would stay over the next page and keep working; an
 *   approval there would call back into a window with no `approvalForm` left, and the payer
 *   would have authenticated a payment that is never approved — no P, no word. Closed, it is an
 *   abandoned window like any other: nothing charged, the payment left unclaimed. A layer
 *   already gone is past saving this way (its callback is on its way) and is left alone.
 *   A window still `loading` when it unmounts is over too, with nothing to take down: a load
 *   that finishes or fails after that finds it `closed`, so it neither opens a layer over the
 *   next page nor has the payer told there that a window they left failed to open.
 */
export function checkoutStep(state: CheckoutState, event: CheckoutEvent): CheckoutStep {
  const to = (phase: CheckoutPhase): CheckoutStep =>
    phase === state.phase ? { state } : { state: { ...state, phase } };
  switch (event.type) {
    case 'unavailable':
    case 'threw':
      return state.phase === 'loading' ? to('failed') : { state };
    case 'payment':
      if (state.phase !== 'loading') return { state };
      if (!event.wentAhead) return to('closed');
      if (event.mobile) return to('leaving');
      return to(event.layer ? 'open' : 'closed');
    case 'layer-removed': {
      if (state.layerGone) return { state };
      const next = { ...state, layerGone: true };
      return state.phase === 'open' ? { state: next, effect: 'await-callback' } : { state: next };
    }
    case 'grace-elapsed':
      return state.phase === 'open' && state.layerGone && !state.answered
        ? to('closed')
        : { state };
    case 'callback':
      if (state.answered) return { state };
      return { state: { ...state, phase: 'approving', answered: true }, effect: 'post-approval' };
    case 'approval-timeout':
      return state.phase === 'approving' ? to('closed') : { state };
    case 'restored':
      return ACTIVE_CHECKOUT_PHASES.has(state.phase) ? to('closed') : { state };
    case 'unmounted':
      if (state.phase === 'loading') return to('closed');
      return state.phase === 'open' && !state.layerGone
        ? { state: { ...state, phase: 'closed' }, effect: 'close-layer' }
        : { state };
  }
}

/**
 * The caller's side: a phase reported for `paymentId` moves the window on screen only when it is
 * that payment's. A window a newer purchase replaced may still be winding down — its grace clock,
 * its approval clock, its back/forward-cache listener — and must not hand the newer window's
 * buttons back. An unchanged phase answers `current` itself, so nothing re-renders.
 */
export function withCheckoutPhase<
  T extends { prepared: { paymentId: string }; phase: CheckoutPhase },
>(current: T | null, paymentId: string, phase: CheckoutPhase): T | null {
  if (current === null || current.prepared.paymentId !== paymentId) return current;
  return current.phase === phase ? current : { ...current, phase };
}
