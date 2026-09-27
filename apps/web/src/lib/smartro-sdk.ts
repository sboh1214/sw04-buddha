import {
  smartroPaymentFormSchema,
  type SmartroMode,
  type SmartroPaymentForm,
} from '@buddha/shared';

/**
 * The page's side of the SmartroPay SDK (`SmartroPAY-1.0.min.js`, ADR-0042): which build to
 * load, what the SDK reads from the page, and what its PC callback hands back. Pure, so the
 * decisions run in this app's node-only test runner; `SmartroCheckout` is the component that
 * acts on them.
 */

/**
 * The SDK's own phone test, verbatim (`smartropay.common.isMobile` for the 일반연동 action URI).
 * The page must agree with it EXACTLY. Each of the two builds carries its own flow code and its
 * own mode check, which reads the host of the `<script src>` the build came from (`tpay`/`pay`
 * for the PC build, `tmpay`/`mpay` for the mobile one); the SDK picks the flow it runs — the PC
 * layer or the mobile full-page submit — with this regex. Testing the same user agent the same
 * way, the page loads the build whose checks and code are the ones for the flow the SDK will run.
 * iPadOS Safari reports a desktop user agent, so it gets the PC build — as the SDK expects.
 */
export const SMARTRO_MOBILE_UA = /iPhone|iPad|iPod|Android/i;

export function isSmartroMobile(userAgent: string): boolean {
  return SMARTRO_MOBILE_UA.test(userAgent);
}

/** The build of the SDK this browser must load, from the URLs the API handed out. */
export function smartroScriptUrl(
  scriptUrl: { pc: string; mobile: string },
  userAgent: string,
): string {
  return isSmartroMobile(userAgent) ? scriptUrl.mobile : scriptUrl.pc;
}

/**
 * The form the SDK reads the request from. `payment({ FormId })` looks it up with
 * `getElementById`, and the manual requires its `name` to be the same, so both are this.
 */
export const SMARTRO_FORM_ID = 'tranMgr';

/**
 * The PC layer: the SDK appends `<div id="smartropay-wrapper">` (overlay + iframe) to `<body>`
 * when the window opens and removes it on every way it closes — the payer's own close
 * (`end`), and an approval, whose callback runs ~500 ms AFTER the removal.
 */
export const SMARTRO_WRAPPER_ID = 'smartropay-wrapper';

/**
 * How long after the layer disappears the page waits for the approval callback before it
 * calls the window closed. The SDK schedules the callback 500 ms after the removal; three
 * times that covers a busy main thread, and a click in this gap would only have to wait.
 */
export const SMARTRO_CALLBACK_GRACE_MS = 1_500;

/**
 * What the PC `Callback` receives: the `approval` message of the payment window, as posted by
 * SmartroPay (Tid, TrAuthKey, ResultCode, ResultMsg, …). Typed loosely on purpose — it crosses
 * a frame boundary, and nothing about it is ours.
 */
export type SmartroCallbackData = Readonly<Record<string, unknown>>;

/** The two calls the page makes (`window.smartropay`, set by the SDK script). */
export interface SmartroPaySdk {
  init(options: { mode: SmartroMode }): void;
  /**
   * Reads the form, validates it and opens the window: the PC layer, or on a phone a
   * full-page submit to tmpay/mpay. Answers the SDK object when it went ahead, and nothing
   * when its own validation refused (it has already shown an `alert` saying why).
   */
  payment(options: {
    FormId: string;
    Callback: (data: SmartroCallbackData) => void;
  }): SmartroPaySdk | undefined;
}

declare global {
  interface Window {
    /** Present once the SmartroPay SDK script has run (`SmartroCheckout` loads it on demand). */
    smartropay?: SmartroPaySdk;
  }
}

/**
 * The hidden inputs of `tranMgr`, in the contract's order: exactly the request fields the
 * shared schema names, never whatever else an answer might grow — the SDK posts every input
 * of the form to SmartroPay, signed or not.
 */
export function smartroFormFields(form: SmartroPaymentForm): [name: string, value: string][] {
  return (Object.keys(smartroPaymentFormSchema.shape) as (keyof SmartroPaymentForm)[]).map(
    (name) => [name, form[name]],
  );
}

/**
 * The action of `approvalForm`: our ReturnUrl's path and query, root-relative, so the browser
 * resolves it against the page's OWN origin. The API spells the ReturnUrl with its configured web
 * origin (the one SmartroPay posts back to); a page opened under another name for the same site
 * (`127.0.0.1` for `localhost`, say) would have `form-action 'self'` refuse an absolute post
 * there — silently, and the approval would never leave. The same route answers on this origin
 * (`/api/*` is proxied to the API). Leading slashes are folded into one: `//host/…` would be a
 * scheme-relative URL, another origin again. A value that parses as no URL at all is left as it
 * is, and the approval clock gives the buttons back if it goes nowhere.
 */
export function approvalAction(approvalUrl: string): string {
  let url: URL;
  try {
    // The base only anchors a value that is already relative; its origin is dropped below.
    url = new URL(approvalUrl, 'https://origin.invalid');
  } catch {
    return approvalUrl;
  }
  return `/${url.pathname.replace(/^[/\\]+/, '')}${url.search}`;
}

/** The inputs of `approvalForm`, which posts the PC callback's answer to our ReturnUrl. */
export const APPROVAL_FIELD_NAMES = ['Tid', 'TrAuthKey', 'ResultCode', 'ResultMsg'] as const;
export type ApprovalFields = Record<(typeof APPROVAL_FIELD_NAMES)[number], string>;

/**
 * The callback's answer as the ReturnUrl expects it (the same names the mobile flow posts).
 * `Tid` and `TrAuthKey` are what the API approves with; `ResultCode`/`ResultMsg` ride along so
 * a window that came back WITHOUT an authentication is closed with the PG's own reason — the
 * API marks such a payment failed and keeps `ResultMsg`, which the wallet then shows. A field
 * the answer does not carry is posted empty, which the API reads as absent.
 */
export function approvalFields(data: unknown): ApprovalFields {
  const record = typeof data === 'object' && data !== null ? (data as SmartroCallbackData) : {};
  const text = (value: unknown): string =>
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  return {
    Tid: text(record.Tid),
    TrAuthKey: text(record.TrAuthKey),
    ResultCode: text(record.ResultCode),
    ResultMsg: text(record.ResultMsg),
  };
}
