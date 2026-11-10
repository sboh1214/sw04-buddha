import { copy } from '@/copy';
import { marketMakerReason } from './market-maker';

/** Wire counts remain exact beyond Number.MAX_SAFE_INTEGER. */
export const metricsCount = (value: string) => BigInt(value).toLocaleString('ko-KR');
export function metricsPercent(bp: string) {
  const value = BigInt(bp);
  return `${(value / 100n).toLocaleString('ko-KR')}.${String(value % 100n).padStart(2, '0')}%`;
}

/** Database failure strings are never rendered as operator-facing diagnostics. */
export function metricsReason(reason: string): string {
  const labels: Record<string, string> = {
    missing_balance: copy.makerMetricsMissingBalance,
    owner_mismatch: copy.makerMetricsOwnerMismatch,
    coin_gap: copy.makerMetricsCoinGap,
    coin_lock: copy.makerMetricsCoinLock,
    contract_lock: copy.makerMetricsContractLock,
    settlement_books: copy.makerMetricsSettlementBooks,
    cancelled_books: copy.makerMetricsCancelledBooks,
  };
  return Object.hasOwn(labels, reason)
    ? labels[reason]!
    : marketMakerReason(reason, copy.makerMetricsUnknownReason);
}
