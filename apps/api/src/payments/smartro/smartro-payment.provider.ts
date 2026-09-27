import { Logger } from '@nestjs/common';
import { vatSplit } from '@buddha/shared';
import { sanitizePayload } from '../payment-events.js';
import {
  type CancelOutcome,
  type CancelRequest,
  type PaymentProvider,
} from '../payment-provider.js';
import { type SmartroConfig } from '../payments-config.js';
import { type SmartroClient, SmartroUnreachableError } from './smartro-client.js';
import {
  cancelHashData,
  encryptCancelPayload,
  isCancelSuccess,
  truncateChars,
} from './smartro-protocol.js';

/** CancelMsg is at most 100 characters (the manual's length column). */
const CANCEL_MESSAGE_MAX = 100;

/** A full cancel is the only kind we send (owner decision 5): PartialCancelCode 0, first sequence. */
const FULL_CANCEL = '0';
const FIRST_CANCEL_SEQ = '1';

/**
 * SmartroPay behind the PaymentProvider seam (ADR-0042). No `charge`: its money arrives through
 * the payment window and the callbacks (SmartroPayService), not in one call. `cancel` serves
 * both the net cancel of an approval we could not credit and the admin refund.
 */
export class SmartroPaymentProvider implements PaymentProvider {
  readonly name = 'smartro';
  private readonly logger = new Logger(SmartroPaymentProvider.name);

  constructor(
    private readonly config: SmartroConfig,
    private readonly client: SmartroClient,
  ) {}

  async cancel(request: CancelRequest): Promise<CancelOutcome> {
    const { mid, merchantKey } = this.config;
    const cancelAmt = String(request.priceKrw);
    // The same split as the payment (부가세 직접계산 MID): a cancel of a VAT-inclusive amount
    // must say how much of it was tax, or the PG refuses it (W055).
    const vat = vatSplit(request.priceKrw);
    const param = {
      Tid: request.providerRef,
      Mid: mid,
      CancelAmt: cancelAmt,
      CancelPwd: this.config.cancelPassword,
      CancelMsg: truncateChars(request.reason, CANCEL_MESSAGE_MAX),
      CancelSeq: FIRST_CANCEL_SEQ,
      PartialCancelCode: FULL_CANCEL,
      HashData: cancelHashData(request.providerRef, merchantKey, cancelAmt, FULL_CANCEL),
      CancelTaxAmt: String(vat.taxAmt),
      CancelTaxFreeAmt: String(vat.taxFreeAmt),
      CancelVatAmt: String(vat.vatAmt),
    };
    let answer: Record<string, unknown>;
    try {
      answer = await this.client.cancel({
        EncData: encryptCancelPayload(JSON.stringify(param), merchantKey),
        Mid: mid,
      });
    } catch (error) {
      if (!(error instanceof SmartroUnreachableError)) throw error;
      this.logger.warn(`cancel of payment ${request.paymentId}: ${error.message}`);
      return { status: 'unknown', payload: { error: error.message } };
    }
    const resultCode = stringField(answer, 'ResultCode');
    const resultMessage = stringField(answer, 'ResultMsg');
    const payload = sanitizePayload(answer);
    // An answer without a ResultCode says nothing about the card: unknown, not refused, so a
    // refund stays `refunding` for a retry instead of restoring P for a card that was cancelled.
    if (resultCode === undefined) return { status: 'unknown', resultMessage, payload };
    return {
      status: isCancelSuccess(resultCode) ? 'cancelled' : 'refused',
      resultCode,
      resultMessage,
      payload,
    };
  }
}

/** A field of a PG answer as a string: numbers are accepted (JSON may carry codes as numbers). */
export function stringField(answer: Record<string, unknown>, key: string): string | undefined {
  const value = answer[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}
