import { LEGAL_FIRST_EFFECTIVE_DATE } from '@buddha/shared';
import { copy } from '@/copy';
import { LEGAL_NO_SALES_NOTICE } from './cash-notice';
import { type LegalDocument, effectiveDateText, paragraph } from './document';
import { SERVICE_FACTS as S } from './service-facts';

/**
 * 환불정책 (ADR-0042/0044), rewritten short by #137 (ADR-0176) for the product with no paid Coin
 * (N06, D9): no Coin is sold and there is nothing to refund; free Coin is neither cash nor
 * refundable (N01 §2); the VOID payout is no refund of the price paid (N03 §6). It sets no rule
 * for paid Coin — that is for when sales open, which revises this policy first (N06 '도입 전 검토',
 * #111). The page and the footer link stay (ADR-0049, e2e/payment.spec.ts).
 *
 * The rule of ADR-0042 (7 days, unused only, full cancel) is not here any more: the kept charge
 * screens (`copy.chargeGuide…`, shown only while sales are open) still say it, as code kept for
 * paid Coin (D9).
 */
export const REFUND: LegalDocument = {
  title: copy.legalRefundTitle,
  numbering: 'decimal',
  effectiveDate: LEGAL_FIRST_EFFECTIVE_DATE,
  intro: [
    paragraph(
      '이 환불정책은 회사(상호: {{companyName}}, 이하 "회사")가 운영하는 {{serviceName}}에서 쓰는 Coin의 환불에 관한 기준을 정합니다.',
    ),
  ],
  sections: [
    {
      heading: '환불할 결제가 없습니다',
      blocks: [paragraph(`${LEGAL_NO_SALES_NOTICE} 그래서 지금은 환불할 결제가 없습니다.`)],
    },
    {
      heading: '무료로 받은 Coin',
      blocks: [
        paragraph(
          `시작 Coin, 재지급, 판정 오류 보상으로 받은 Coin은 모두 무료로 받은 것이며, 현금으로 바꾸거나 환불할 수 없습니다. ${S.noCashOut}`,
        ),
      ],
    },
    {
      heading: '무효(VOID)의 지급',
      blocks: [paragraph(S.voidResult)],
    },
    {
      heading: '탈퇴',
      blocks: [paragraph('탈퇴하면 남은 Coin은 소멸하며 환불되지 않습니다.')],
    },
    {
      heading: 'Coin 판매를 시작할 때',
      blocks: [paragraph('회사가 Coin 판매를 시작하려면 그 전에 이 환불정책을 개정합니다.')],
    },
    {
      heading: '문의',
      blocks: [paragraph('환불정책에 관한 문의는 고객센터 이메일({{email}})로 받습니다.')],
    },
  ],
  addendum: [
    paragraph(`이 환불정책은 ${effectiveDateText(LEGAL_FIRST_EFFECTIVE_DATE)}부터 시행합니다.`),
  ],
};
