import { randomUUID } from 'node:crypto';
import {
  paymentIdToMoid,
  type PaymentProvider as PaymentProviderName,
  type SmartroMode,
} from '@buddha/shared';
import { type Env } from '../config/env.js';
import {
  SMARTRO_APPROVAL_HOSTS,
  SMARTRO_CALLBACK_URL_MAX,
  SMARTRO_NOTIFY_IPS,
  smartroCallbackUrl,
} from './smartro/smartro-protocol.js';

/** Injection token for PaymentsConfig; tests override it to switch SmartroPay on. */
export const PAYMENTS_CONFIG = Symbol('PAYMENTS_CONFIG');

/** SmartroPay credentials and hosts (secrets: never logged, never stored in payment_events). */
export interface SmartroConfig {
  mode: SmartroMode;
  /** Merchant id, ≤ 10 characters. */
  mid: string;
  /**
   * ≥ 32 characters, the first 32 ASCII: signs requests and results, and its first 32 key the
   * cancel payload (cancelPayloadKey).
   */
  merchantKey: string;
  cancelPassword: string;
  /** Where approval, inquiry and cancel go: the mode's host unless overridden (never in production). */
  approvalBaseUrl: string;
  /**
   * The addresses a 재통보 is accepted from: the mode's SmartroPay servers (SMARTRO_NOTIFY_IPS).
   * `null` turns the check off, which happens only with SMARTRO_APPROVAL_BASE_URL set — a local
   * fake PG posts its notices from wherever it runs, and config/env.ts refuses that override in
   * production.
   */
  notifyIps: readonly string[] | null;
}

export interface PaymentsConfig {
  /** PAYMENT_PROVIDER: which provider takes NEW charges, i.e. which charge flow is open. */
  provider: PaymentProviderName;
  /**
   * SmartroPay when its three credentials are set, whatever PAYMENT_PROVIDER says: the
   * callbacks and refunds of SmartroPay payments keep working after a switch back to `mock`.
   */
  smartro: SmartroConfig | null;
  /**
   * The public web origin (the origin of BETTER_AUTH_URL): where the callbacks redirect the
   * browser, and the base of ReturnUrl/StopUrl — `/api/*` on it reaches this API (the Next
   * rewrite in dev, Caddy in production).
   */
  webOrigin: string;
}

type PaymentsEnv = Pick<
  Env,
  | 'PAYMENT_PROVIDER'
  | 'SMARTRO_MODE'
  | 'SMARTRO_MID'
  | 'SMARTRO_MERCHANT_KEY'
  | 'SMARTRO_CANCEL_PASSWORD'
  | 'SMARTRO_APPROVAL_BASE_URL'
  | 'BETTER_AUTH_URL'
>;

/**
 * Builds PaymentsConfig from the validated env (config/env.ts already enforced the pairings).
 * Throws — the boot fails — when SmartroPay is configured on a web origin too long for its
 * ReturnUrl: found on the first prepare instead, every charge would reserve a payment and 500.
 */
export function paymentsConfigFromEnv(env: PaymentsEnv): PaymentsConfig {
  const { SMARTRO_MID: mid, SMARTRO_MERCHANT_KEY: merchantKey } = env;
  const webOrigin = new URL(env.BETTER_AUTH_URL).origin;
  const cancelPassword = env.SMARTRO_CANCEL_PASSWORD;
  const smartro =
    mid !== undefined && merchantKey !== undefined && cancelPassword !== undefined
      ? {
          mode: env.SMARTRO_MODE,
          mid,
          merchantKey,
          cancelPassword,
          approvalBaseUrl:
            env.SMARTRO_APPROVAL_BASE_URL ?? SMARTRO_APPROVAL_HOSTS[env.SMARTRO_MODE],
          notifyIps:
            env.SMARTRO_APPROVAL_BASE_URL === undefined
              ? SMARTRO_NOTIFY_IPS[env.SMARTRO_MODE]
              : null,
        }
      : null;
  if (smartro) {
    // Every Moid has the same length, so any payment's URL stands for all of them.
    const moid = paymentIdToMoid(randomUUID());
    for (const kind of ['return', 'stop'] as const) {
      const length = smartroCallbackUrl(webOrigin, kind, moid).length;
      if (length > SMARTRO_CALLBACK_URL_MAX) {
        throw new Error(
          `The SmartroPay ${kind} URL would be ${String(length)} characters (max ${String(SMARTRO_CALLBACK_URL_MAX)}): the origin of BETTER_AUTH_URL is too long`,
        );
      }
    }
  }
  return { provider: env.PAYMENT_PROVIDER, smartro, webOrigin };
}
