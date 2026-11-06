import { type MarketStatus, priceProtectionTicksSchema } from '@buddha/shared';
import { copy } from '@/copy';
import { isApiError, validationField, validationMessage } from './api';
import { type ReviewFailure, reviewFailure, reviewReasonDraft } from './market-review';

/**
 * The pure half of the admin detail's 가격 보호 폭 (#119, ADR-0112; ADR-0107 결정 1 #177 2항): which
 * markets may change it, what the change dialog may send and what a refusal says. The width
 * itself is shown by `priceProtectionText` (lib/market-admin.ts), which the 이벤트 로그 reads too.
 */

/**
 * Whether the width can be changed: an OPEN or PAUSED market's, by one admin with a reason (the
 * #172 14항 precedent). A draft keeps the width it copied at its creation (one created with none
 * takes the release setting's at the submission), and the review's submission stores it from then
 * on; past the trading period no order is taken.
 */
export function canChangePriceProtection(status: MarketStatus): boolean {
  return status === 'open' || status === 'paused';
}

/**
 * 가격 보호 폭 변경: the new width as typed (a whole number of ticks within
 * `priceProtectionTicksSchema`, the server's own range) and the reason. `ticksError` once the
 * text is something else; `unchanged` (and not ready) while it names the width the market holds.
 */
export function priceProtectionDraft(
  text: string,
  reasonText: string,
  current: number | null,
): {
  ready: boolean;
  ticks: number | null;
  ticksError: string | null;
  unchanged: boolean;
  reason: string;
} {
  const { reason, error } = reviewReasonDraft(reasonText);
  const trimmed = text.trim();
  const parsed = /^\d+$/.test(trimmed)
    ? priceProtectionTicksSchema.safeParse(Number(trimmed))
    : undefined;
  const ticks = parsed?.success === true ? parsed.data : null;
  const ticksError = trimmed !== '' && ticks === null ? copy.errPriceProtectionTicks : null;
  const unchanged = ticks !== null && ticks === current;
  return {
    ready: ticks !== null && !unchanged && error === null,
    ticks,
    ticksError,
    unchanged,
    reason,
  };
}

/** The dialog's fields a refusal can land under. */
export type PriceProtectionField = 'priceProtectionTicks' | 'reason';

export type PriceProtectionFailure =
  | { kind: 'field'; field: PriceProtectionField; message: string; refresh: boolean }
  | Exclude<ReviewFailure, { kind: 'field' }>;

/**
 * Where a refused change is said: under the width ('unchanged' — another admin's change came
 * first, so the detail is read again — or out of range) or under the reason; anything else as the
 * review's dialogs say it (`reviewFailure`: a status another admin moved, the market gone, a
 * session ended or a role revoked, the cookie of another account).
 */
export function priceProtectionFailure(error: unknown): PriceProtectionFailure {
  if (isApiError(error, 'VALIDATION_ERROR')) {
    const field = validationField(error);
    if (field === 'priceProtectionTicks') {
      const unchanged = validationMessage(error) === 'unchanged';
      return {
        kind: 'field',
        field,
        message: unchanged ? copy.errPriceProtectionUnchanged : copy.errPriceProtectionTicks,
        refresh: unchanged,
      };
    }
  }
  const failure = reviewFailure(error);
  if (failure.kind !== 'field') return failure;
  if (failure.field === 'reason') return { ...failure, field: 'reason' };
  return { kind: 'alert', message: failure.message, refresh: failure.refresh };
}
