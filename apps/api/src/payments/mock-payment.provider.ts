import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  type CancelOutcome,
  type CancelRequest,
  type ChargeOutcome,
  type ChargeRequest,
  type PaymentProvider,
} from './payment-provider.js';

/**
 * The MVP's provider (PLAN 1.2, M2): no money moves, the charge succeeds immediately and so
 * does its cancel. It still goes through the PaymentProvider seam so the wallet code is the one
 * a real gateway uses; CI and e2e run on it (PAYMENT_PROVIDER defaults to `mock`).
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  charge(_request: ChargeRequest): Promise<ChargeOutcome> {
    return Promise.resolve({ status: 'succeeded', providerRef: `mock_${randomUUID()}` });
  }

  cancel(_request: CancelRequest): Promise<CancelOutcome> {
    return Promise.resolve({ status: 'cancelled' });
  }
}
