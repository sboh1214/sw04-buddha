import { type PaymentProvider as PaymentProviderName } from '@buddha/shared';
import { type Env } from '../config/env.js';

/** Injection token for PaymentsConfig. */
export const PAYMENTS_CONFIG = Symbol('PAYMENTS_CONFIG');

export interface PaymentsConfig {
  /** PAYMENT_PROVIDER: which provider takes NEW charges, i.e. which charge flow is open. */
  provider: PaymentProviderName;
}

/** Builds PaymentsConfig from the validated env. */
export function paymentsConfigFromEnv(env: Pick<Env, 'PAYMENT_PROVIDER'>): PaymentsConfig {
  return { provider: env.PAYMENT_PROVIDER };
}
