import { type MarketResult, formatCoin, parseCoinAmount } from '@buddha/shared';
import { copy } from '@/copy';
import { type LedgerEntry, type PublicMarketJudgementCorrection } from './api';
import { MARKET_RESULT_LABEL } from './market-admin';

/**
 * The member side of a 판정 오류 보상 (#144 part 2, ADR-0166; owner answers 144-6, 144-11, 144-15,
 * 144-17, 144-19): how the public 판정 정정 words its compensation (counts and totals alone —
 * never an account, a nickname or one account's amount), what the detail's recap says the account
 * itself got, and the mark MY 정산 이력 puts on a corrected market's rows. Pure, so node runs it;
 * the screens (market-judging-record.tsx, correction-recap.tsx, settlement-history-list.tsx) draw
 * it. Nothing of the admin side (lib/market-judgement-compensation.ts) is imported here.
 */

/** The public 판정 정정's compensation (`correction.compensation`). */
export type PublicCompensation = PublicMarketJudgementCorrection['compensation'];

const countOf = (n: number | null) => (n ?? 0).toLocaleString('ko-KR');

/**
 * The 보상 line of the public 판정 정정 (144-6, 144-15 "두 상태를 더하고 탈퇴 대상을 따로 센다"):
 * '보상 준비 중' (no request yet, or the last was rejected or retracted), '보상 대상 없음' (no account
 * is owed anything), '승인 대기 · 대상 계정 {n}개', '지급 완료 · 대상 계정 {n}개 · 총 {coin}', and —
 * when closed targets were recorded '탈퇴로 지급 못 함' (`paidCount` below `accountCount`) — '지급
 * 완료 · 대상 계정 {n}개 중 {m}개 지급 · 총 {coin}'. Every target closed reads '… 중 0개 지급 · 총 0
 * Coin', never a bare 0 Coin without the 대상 count.
 */
export function publicCompensationText(compensation: PublicCompensation): string {
  switch (compensation.status) {
    case 'preparing':
      return copy.judgingCompensationPreparing;
    case 'none':
      return copy.judgingCompensationNone;
    case 'pending':
      return copy.judgingCompensationPending.replace('{n}', countOf(compensation.accountCount));
    case 'paid': {
      const coin = formatCoin(parseCoinAmount(compensation.totalCoin ?? '0'));
      const all = compensation.accountCount ?? 0;
      const paid = compensation.paidCount ?? 0;
      const template =
        paid < all ? copy.judgingCompensationPaidPartly : copy.judgingCompensationPaid;
      return template
        .replace('{n}', countOf(all))
        .replace('{m}', countOf(paid))
        .replace('{coin}', coin);
    }
  }
}

/**
 * What the recap's 판정 정정 says of the account's own compensation (144-11, 144-19):
 * - `amount`: paid, and the account got this much (its JUDGEMENT_COMPENSATION entries of the
 *   market — one per account, ADR-0166 — summed);
 * - `none`: '보상 없음' — paid and the account got nothing, or no account is owed anything;
 * - `pending` / `preparing`: '보상 승인 대기' / '보상 준비 중' — never '보상 없음' before the payout;
 * - `reading` / `failed`: paid, and the account's entries are being read or could not be.
 */
export type RecapCompensation =
  | { kind: 'amount'; coin: bigint }
  | { kind: 'none' | 'pending' | 'preparing' | 'reading' | 'failed' };

/**
 * The recap's compensation from the public status and, once paid, the account's own ledger entries
 * of the market (`GET /me/ledger?marketId=&kind=JUDGEMENT_COMPENSATION`; `entries` undefined while
 * unread, `failed` when the read failed with nothing to show).
 */
export function recapCompensationOf(
  status: PublicCompensation['status'],
  ledger: {
    entries: readonly Pick<LedgerEntry, 'kind' | 'amountCoin'>[] | undefined;
    failed: boolean;
  },
): RecapCompensation {
  if (status === 'preparing' || status === 'pending' || status === 'none') return { kind: status };
  if (ledger.entries === undefined) return { kind: ledger.failed ? 'failed' : 'reading' };
  const coin = ledger.entries
    .filter((entry) => entry.kind === 'JUDGEMENT_COMPENSATION')
    .reduce((sum, entry) => sum + parseCoinAmount(entry.amountCoin), 0n);
  return coin > 0n ? { kind: 'amount', coin } : { kind: 'none' };
}

/** The recap's compensation line; '—' while the account's entries are read. */
export function recapCompensationText(compensation: RecapCompensation): string {
  switch (compensation.kind) {
    case 'amount':
      return copy.recapCompensationAmount.replace('{coin}', formatCoin(compensation.coin));
    case 'none':
      return copy.recapCompensationNone;
    case 'pending':
      return copy.recapCompensationPending;
    case 'preparing':
      return copy.recapCompensationPreparing;
    case 'reading':
      return '—';
    case 'failed':
      return copy.errUnknown;
  }
}

/** '정정된 결과 {result}' (144-11). */
export function recapCorrectedResultText(result: MarketResult): string {
  return copy.recapCorrectedResult.replace('{result}', MARKET_RESULT_LABEL[result]);
}

/**
 * MY 정산 이력's mark on a corrected market's row (144-17 "'판정 정정 · 결과 {정정된 결과}' 표시만 —
 * 금액은 더하지 않는다"): the row's own result and payout stay the paid ones.
 */
export function settlementCorrectedText(result: MarketResult): string {
  return copy.historySettlementCorrected.replace('{result}', MARKET_RESULT_LABEL[result]);
}
