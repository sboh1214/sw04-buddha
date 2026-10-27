import { type LedgerEntryType } from '@buddha/shared';
import { copy } from '@/copy';
import { type Me } from './api';

/**
 * Pure pieces of MY's 지갑 (`/my/wallet`), kept out of `app/my/wallet` so vitest can run them under
 * its node environment — the split lib/my.ts makes for MY's tabs.
 */

/**
 * What 이용 내역 calls each ledger type. PLAN Appendix A: never "베팅"; every type gets plain Korean.
 * A Record, so a type added to LEDGER_ENTRY_TYPES without a label fails the typecheck.
 *
 * The start Coin (#70) is `START_GRANT`, '시작 지급' — its own type and its own word (ADR-0069
 * decision 4 #70), never the coupon's `BONUS` '보너스', so the wallet tells the two sources apart
 * (N04 §5). Accounts created before #70 still show their old sign-up grant as '보너스' (D4: not
 * migrated).
 */
export const LEDGER_TYPE_LABEL: Readonly<Record<LedgerEntryType, string>> = {
  DEPOSIT: copy.ledgerTypeDeposit,
  TRADE_BUY: copy.ledgerTypeTradeBuy,
  TRADE_SELL: copy.ledgerTypeTradeSell,
  FEE: copy.ledgerTypeFee,
  SETTLEMENT_PAYOUT: copy.ledgerTypeSettlement,
  ADMIN_ADJUST: copy.ledgerTypeAdminAdjust,
  BONUS: copy.ledgerTypeBonus,
  PAYMENT_CANCEL: copy.ledgerTypePaymentCancel,
  PAYMENT_CANCEL_REVERSAL: copy.ledgerTypePaymentCancelReversal,
  START_GRANT: copy.ledgerTypeStartGrant,
};

/**
 * Whether the wallet says the start Coin is on its way (#70, ADR-0071): only while the account's
 * grant is recorded and waits for the amount — the release setting `grant.start_coin` is undecided
 * (ADR-0069 decision 4 #70: '지갑에도 지급 대기 중임을 보인다'). Nothing once it is paid (the
 * ledger's 시작 지급 row says so), and nothing for an account with no grant record: one that has
 * not finished the onboarding (#58), or verified a number whose start Coin went to an earlier
 * account (#57-1·#57-17) — the wallet promises Coin only where a grant is waiting.
 *
 * `undefined` is a profile not loaded yet: no notice until it is known.
 */
export function startGrantPending(me: Pick<Me, 'startGrant'> | undefined): boolean {
  return me?.startGrant?.status === 'pending';
}
