import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  type ChargeOutcome,
  type ChargeRequest,
  type PaymentProvider,
} from './payment-provider.js';

/**
 * The MVP's only provider (PLAN 1.2, M2): no money moves, the charge succeeds immediately.
 * It still goes through the PaymentProvider seam so the wallet code does not change when a
 * real gateway arrives.
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  charge(_request: ChargeRequest): Promise<ChargeOutcome> {
    return Promise.resolve({ status: 'succeeded', providerRef: `mock_${randomUUID()}` });
  }
}
