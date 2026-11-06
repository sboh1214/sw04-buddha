import { type MemberLedgerEntryType } from '@buddha/shared';
import { copy } from '@/copy';
import { type Me } from './api';

/**
 * Pure pieces of MY's 지갑 (`/my/wallet`), kept out of `app/my/wallet` so vitest can run them under
 * its node environment — the split lib/my.ts makes for MY's tabs.
 */

/**
 * What 이용 내역 calls each ledger type. PLAN Appendix A: never "베팅"; every type gets plain Korean.
 * A Record over the types a person's ledger can hold (MEMBER_LEDGER_ENTRY_TYPES, #116, ADR-0109):
 * a type added there without a label fails the typecheck, and the operating treasury's and the
 * 마켓메이커's own types (TREASURY_MINT, BOT_*, PAIR_BURN_RETURN) never reach a member's screen.
 *
 * The start Coin (#70) is `START_GRANT`, '시작 지급' — its own type and its own word (ADR-0069
 * decision 4 #70), never the coupon's `BONUS` '보너스', so the wallet tells the two sources apart
 * (N04 §5). The 담보, 체결 and 대사 정정 words are provisional until the wallet screens (#69) name
 * them; fills write 담보 and 체결 since #119, and 대사 정정 waits for #93.
 */
export const LEDGER_TYPE_LABEL: Readonly<Record<MemberLedgerEntryType, string>> = {
  START_GRANT: copy.ledgerTypeStartGrant,
  PAIR_MINT_COLLATERAL: copy.ledgerTypePairMintCollateral,
  TRADE_FILL: copy.ledgerTypeTradeFill,
  SETTLEMENT_PAYOUT: copy.ledgerTypeSettlement,
  // 탈퇴 소멸 (#140): written as the account closes, so no member's wallet ever lists it — the
  // label is for completeness of the Record (an operator reads the ledger elsewhere).
  CLOSURE_FORFEIT: copy.ledgerTypeClosureForfeit,
  RECONCILIATION_CORRECTION: copy.ledgerTypeReconciliationCorrection,
  DEPOSIT: copy.ledgerTypeDeposit,
  BONUS: copy.ledgerTypeBonus,
  PAYMENT_CANCEL: copy.ledgerTypePaymentCancel,
  PAYMENT_CANCEL_REVERSAL: copy.ledgerTypePaymentCancelReversal,
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
