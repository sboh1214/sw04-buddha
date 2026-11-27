/**
 * The no-sales sentence the 이용약관 and the 환불정책 both say (#137, ADR-0176): no Coin is sold
 * today, so neither document offers a payment or a charge (N06, D9). It lives here, apart from the
 * fact sentences the 이용약관 shares with the service guide (service-facts.ts), because the guide
 * says nothing of paid Coin: the switch that closes sales may one day open it (harmonization C6).
 * When sales open, both documents are revised first — this sentence with them.
 */
export const LEGAL_NO_SALES_NOTICE = '지금은 Coin을 판매하지 않고 결제·충전 기능이 없습니다.';
