'use client';

import Script from 'next/script';
import { useCallback, useEffect, useRef } from 'react';
import { type SmartroPrepareResult } from '@/lib/api';
import {
  CHECKOUT_START,
  type CheckoutEffect,
  type CheckoutEvent,
  type CheckoutPhase,
  type CheckoutState,
  SMARTRO_APPROVAL_TIMEOUT_MS,
  checkoutStep,
} from '@/lib/smartro-checkout';
import {
  APPROVAL_FIELD_NAMES,
  SMARTRO_CALLBACK_GRACE_MS,
  SMARTRO_FORM_ID,
  SMARTRO_WRAPPER_ID,
  type SmartroCallbackData,
  approvalAction,
  approvalFields,
  smartroFormFields,
} from '@/lib/smartro-sdk';

interface SmartroCheckoutProps {
  prepared: SmartroPrepareResult;
  /** The SDK build for this browser (`smartroScriptUrl`), picked by the caller at click time. */
  scriptUrl: string;
  /** `isSmartroMobile` of the same user agent: the SDK will leave the page instead of layering. */
  mobile: boolean;
  onPhase: (paymentId: string, phase: CheckoutPhase) => void;
}

/**
 * The SmartroPay 일반연동 window for ONE prepared payment (ADR-0042, DESIGN §6.2). The caller
 * mounts it once `/payments/smartro/prepare` has answered and keys it by the payment id, so a
 * new purchase is always a new instance: its `tranMgr` holds that payment's signed request,
 * and its `approvalForm` posts to THAT payment's ReturnUrl — an older window's callback can
 * never reach a newer payment (the verify pass's "one payment's Tid posted to another
 * payment's ReturnUrl").
 *
 * The SDK script loads here, on demand, never with the wallet: `next/script` inserts it once
 * per URL for the page's lifetime and runs `onReady` for every later instance. Then:
 * `smartropay.init({ mode })`, `smartropay.payment({ FormId: 'tranMgr', Callback })`.
 * - PC: the SDK opens its layer (`#smartropay-wrapper`, an iframe onto tpay/pay). When it
 *   closes, the SDK removes the wrapper; on an approval it calls `Callback({ Tid, TrAuthKey,
 *   … })` ~500 ms later, and this posts `approvalForm` — a top-level POST to our ReturnUrl,
 *   which approves, credits and 303s back to `/wallet?payment=&result=`. A wrapper gone with
 *   no callback within the grace is a window the payer closed: the buttons come back. The
 *   SDK's "stop" sends the page to our StopUrl itself.
 * - Mobile: the SDK submits the whole page to tmpay/mpay, and SmartroPay posts the result to
 *   our ReturnUrl or StopUrl, which redirect to the wallet the same way.
 *
 * What each of those signals means is `checkoutStep`'s to decide (lib/smartro-checkout.ts,
 * unit-tested); this component only listens for them, keeps the window's state, reports the
 * phase when it moves, and carries out the step's effect: a clock, or the approval post.
 */
export function SmartroCheckout({ prepared, scriptUrl, mobile, onPhase }: SmartroCheckoutProps) {
  const approvalForm = useRef<HTMLFormElement>(null);
  // The callback the SDK was handed is the one from the render that opened the window; it
  // reports through this ref so it always reaches the caller's current handler.
  const report = useRef(onPhase);
  const started = useRef(false);
  const checkout = useRef<CheckoutState>(CHECKOUT_START);
  const paymentId = prepared.paymentId;

  useEffect(() => {
    report.current = onPhase;
  }, [onPhase]);

  /** One event into this window's state: report the phase if it moved, answer the effect. */
  const dispatch = useCallback(
    (event: CheckoutEvent): CheckoutEffect | undefined => {
      const before = checkout.current.phase;
      const { state, effect } = checkoutStep(checkout.current, event);
      checkout.current = state;
      if (state.phase !== before) report.current(paymentId, state.phase);
      return effect;
    },
    [paymentId],
  );

  // A phone that went to tmpay and came BACK (the browser's back button) may be handed this
  // very document from the back/forward cache, buttons still disabled for a window that is
  // gone. A PC page restored after the approval's navigation is the same case.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) dispatch({ type: 'restored' });
    };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, [dispatch]);

  /**
   * The PC `Callback`: post the window's answer to this payment's ReturnUrl. The post is a
   * navigation, so the page normally leaves with it; the approval clock gives the buttons back
   * to a page that is somehow still here.
   */
  const approve = (data: SmartroCallbackData) => {
    const form = approvalForm.current;
    // Unmounted: a newer purchase replaced this one before the SDK's delayed callback ran.
    // Posting would approve a window the payer has already left for another; the payment
    // stays unclaimed and its authentication expires with nothing charged.
    if (!form) return;
    if (dispatch({ type: 'callback' }) !== 'post-approval') return;
    const fields = approvalFields(data);
    for (const name of APPROVAL_FIELD_NAMES) {
      const input = form.elements.namedItem(name);
      if (input instanceof HTMLInputElement) input.value = fields[name];
    }
    form.submit();
    setTimeout(() => dispatch({ type: 'approval-timeout' }), SMARTRO_APPROVAL_TIMEOUT_MS);
  };

  /**
   * The layer is a direct child of `<body>`; the SDK removes it on every close, and the grace
   * clock starts then.
   *
   * The observer ends itself with the layer and is not torn down on unmount; neither are the
   * clocks. On purpose: when the script is already loaded, next/script starts the window from
   * its OWN mount effect, which runs before this component's effects, and a development
   * StrictMode replay of effect cleanups would disconnect a watch that must outlive it. Nothing
   * is lost by letting them run — the layer is modal, so it ends soon, and a report from a
   * window a newer purchase replaced is dropped by the caller (`withCheckoutPhase`).
   */
  const watchLayer = (wrapper: HTMLElement) => {
    const observer = new MutationObserver(() => {
      if (wrapper.isConnected) return;
      observer.disconnect();
      if (dispatch({ type: 'layer-removed' }) === 'await-callback') {
        setTimeout(() => dispatch({ type: 'grace-elapsed' }), SMARTRO_CALLBACK_GRACE_MS);
      }
    });
    observer.observe(document.body, { childList: true });
  };

  /**
   * Once per instance, whichever of `next/script`'s signals comes first: `onReady` on the first
   * load and on every later mount of an already-loaded script, `onLoad` for a mount that joined
   * a load still in flight (next/script calls only `onLoad` then). A failed load resolves that
   * shared promise too, so `window.smartropay` is checked rather than assumed.
   */
  const start = () => {
    if (started.current) return;
    started.current = true;
    const sdk = window.smartropay;
    if (!sdk) {
      dispatch({ type: 'unavailable' });
      return;
    }
    let opened: unknown;
    try {
      sdk.init({ mode: prepared.mode });
      opened = sdk.payment({ FormId: SMARTRO_FORM_ID, Callback: approve });
    } catch {
      dispatch({ type: 'threw' });
      return;
    }
    const wrapper = mobile ? null : document.getElementById(SMARTRO_WRAPPER_ID);
    dispatch({ type: 'payment', wentAhead: Boolean(opened), mobile, layer: wrapper !== null });
    if (wrapper && checkout.current.phase === 'open') watchLayer(wrapper);
  };

  return (
    <>
      <Script
        src={scriptUrl}
        strategy="afterInteractive"
        onReady={start}
        onLoad={start}
        onError={() => dispatch({ type: 'unavailable' })}
      />
      {/* What the SDK reads (`FormId`), id AND name `tranMgr` as the manual requires. The
          inputs carry no ids: the SDK builds its own form with an id per field name. */}
      <form id={SMARTRO_FORM_ID} name={SMARTRO_FORM_ID} hidden>
        {smartroFormFields(prepared.form).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
      </form>
      {/* Root-relative (`approvalAction`): on the page's own origin, which `form-action 'self'`
          always lets through. */}
      <form
        ref={approvalForm}
        name="approvalForm"
        method="post"
        action={approvalAction(prepared.approvalUrl)}
        acceptCharset="UTF-8"
        hidden
      >
        {APPROVAL_FIELD_NAMES.map((name) => (
          <input key={name} type="hidden" name={name} defaultValue="" />
        ))}
      </form>
    </>
  );
}
