/**
 * The decisions of one SmartroPay window (ADR-0042): what each signal from the SDK,
 * its layer and the browser means for the buy buttons, and which account's screen the window
 * may stay on. Pure, so they run in this app's node-only test runner; `SmartroCheckout` feeds it
 * the signals and carries out what it answers (the two clocks, the approval post, the layer's
 * close), and `ChargeForm` keeps the phase it reports.
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
 * Whether a payment window may be on this tab's screen: only while the tab still belongs to the
 * account the payment was reserved for — the rule `expectedAccountId` enforces on every body that
 * acts for an account (A-M2-11, Q-M3-5), carried past the one moment the server can check it.
 *
 * `sent` is not a guess. It is what the prepare sent as `expectedAccountId`, and the server
 * compared that with the cookie before it reserved anything (`assertExpectedAccount`), so a 2xx
 * PROVES the payment is that account's — `tradeAnswerScope`'s proof (use-trade.ts). Nothing checks
 * it again afterwards: the window approves at the public ReturnUrl, which finds the payment by its
 * Moid and credits the payment's own account whoever the cookie names by then (a phone's
 * cross-site post carries no cookie at all). So a window still open, or opened by a late answer,
 * after another tab signed this one in as somebody else would take a card payment on B's wallet
 * and credit A, and B would come back to a 결제 완료 notice that B's balance does not bear out.
 *
 * `account` is who the tab belongs to now: `cacheOwnerAccount()` right after the prepare
 * answered (`reservationToOpen` — a render closure freezes on the account that clicked),
 * `useSession()`'s identity while a window is on screen. Both follow better-auth's session atom,
 * so a switch counts from the moment the tab notices it, not from the sign-in in the other tab
 * (ADR-0042's 2026-09-30 addendum: side-by-side windows, the 5 s focus-refetch limit).
 * `undefined` means nobody has said yet — before better-auth's first answer, or a tree without
 * the guard — and is `tradeAnswerScope`'s permissive fallback: nothing of anybody else's is on
 * screen to confuse, and refusing would strand an ordinary payer. A sign-out (`null`) is not the
 * account that opened the window.
 */
export function checkoutBelongsTo(a: {
  sent: string;
  account: string | null | undefined;
}): boolean {
  return a.account === undefined || a.account === a.sent;
}

/**
 * The window a prepare's answer may open: the reservation, while the tab still belongs to the
 * account it was reserved for (`checkoutBelongsTo`); `null` once it does not — the reservation
 * stays unclaimed, nothing charged, and the caller says the session changed.
 *
 * Nothing cancels the POST, so another tab may sign this one in as somebody else while it runs.
 * Hence the owner is read through `readOwner` only AFTER the answer (`ChargeForm` passes
 * `cacheOwnerAccount`, which outlives the render that clicked): a value read at the click, or
 * the clicking render's own session, would always name the account that clicked. A refused or
 * failed prepare rejects as it came, and asks nobody.
 */
export async function reservationToOpen<R extends { account: string }>(
  reserve: Promise<R>,
  readOwner: () => string | null | undefined,
): Promise<R | null> {
  const reservation = await reserve;
  return checkoutBelongsTo({ sent: reservation.account, account: readOwner() })
    ? reservation
    : null;
}

/**
 * What the tab's account does to the window on screen (`ChargeForm`):
 * - `keep`: there is none, or it is still this account's (`checkoutBelongsTo`).
 * - `stop`: another account's, still `loading` or `open`. Taking it off the screen unmounts it,
 *   which is `checkoutStep`'s `unmounted`: a load ends `closed` and opens nothing, an open layer
 *   is closed, and a callback already on its way finds no `approvalForm` to post. Nothing is
 *   approved — the reservation stays unclaimed, nothing charged — and the payer is told why the
 *   window went.
 * - `depart`: another account's and past stopping, its page on the way out — `approving` has
 *   posted to the ReturnUrl, `leaving` is being submitted to tmpay. Dropped silently, but the buy
 *   buttons stay disabled until the page goes or `SMARTRO_APPROVAL_TIMEOUT_MS` passes: given back
 *   at once, they would let the new account reserve and open a window that the old navigation,
 *   landing a moment later, tears down (its payment left 미완료, nothing charged).
 * - `drop`: another account's and already over (`closed`, `failed`). Dropped silently: nothing
 *   was left to stop.
 * Every one but `keep` empties the window — never merely hides it, or a switch back would
 * remount the same window under its old key and open it unasked.
 */
export type CheckoutOnAccount = 'keep' | 'stop' | 'depart' | 'drop';

export function checkoutOnAccount(
  checkout: { account: string; phase: CheckoutPhase } | null,
  account: string | null | undefined,
): CheckoutOnAccount {
  if (checkout === null || checkoutBelongsTo({ sent: checkout.account, account })) return 'keep';
  switch (checkout.phase) {
    case 'loading':
    case 'open':
      return 'stop';
    case 'approving':
    case 'leaving':
      return 'depart';
    case 'closed':
    case 'failed':
      return 'drop';
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
