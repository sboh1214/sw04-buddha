import { copy } from '@/copy';
import { LEGAL_CASH_NOTICE } from './cash-notice';
import { type LegalDocument, bullets, numbered, paragraph } from './document';

/**
 * 환불정책 (ADR-0042/0044). States the owner's refund rule (2026-09-28 §5) exactly as the API's
 * admin refund enforces it (ADR-0042 「관리자 환불」):
 *
 * - within `PAYMENT_REFUND_WINDOW_DAYS` × 24 h of the approval, AND
 * - the account's AVAILABLE balance is at least that payment's P ("unused" — P reserved by open
 *   orders is not available),
 * - both judged on the DB clock when the admin PROCESSES the refund, not when the member asks —
 *   so the policy says so, asks members to leave time, and states the processing time
 *   (`refundProcessingTime`, owner to supply),
 * - then the whole amount actually paid (the discounted price) is card-cancelled and the whole P
 *   is taken back; otherwise no refund. No partial refunds, no other channel than the card.
 *
 * P obtained without paying (쿠폰 BONUS, 정산 지급, 관리자 조정) is never refundable, and P never
 * converts to cash (PLAN Appendix A — `LEGAL_CASH_NOTICE` is quoted verbatim). The 기타 section
 * points at the statutory right to cancel a minor's payment made without a guardian's consent
 * (민법 제5조) — a statute, not a case this rule adds — and defers to statute wherever statute
 * gives the member more.
 */
export const REFUND: LegalDocument = {
  title: copy.legalRefundTitle,
  numbering: 'decimal',
  intro: [
    paragraph(
      '이 환불정책은 회사(상호: {{companyName}}, 이하 "회사")가 운영하는 {{serviceName}}에서 P를 충전한 결제의 청약철회와 환불 기준을 정합니다.',
    ),
    paragraph(LEGAL_CASH_NOTICE),
  ],
  sections: [
    {
      heading: '환불받을 수 있는 경우',
      blocks: [
        paragraph('다음 두 조건을 모두 충족하는 결제는 환불받을 수 있습니다.'),
        numbered(
          '결제가 승인된 때부터 {{refundWindowDays}}일이 지나지 않았을 것',
          '그 결제로 충전된 P를 전혀 쓰지 않았을 것',
        ),
        paragraph(
          '두 조건은 모두 회원이 요청한 시점이 아니라 회사가 환불을 처리하는 시점을 기준으로 판단합니다.',
        ),
        bullets(
          '기간은 날짜 단위가 아니라 결제가 승인된 시각부터 계산합니다. 예를 들어 오후 3시에 승인된 결제는 {{refundWindowDays}}일 뒤 오후 3시에 기간이 끝납니다.',
          '"전혀 쓰지 않았다"는 것은 환불을 처리하는 시점에 회원의 사용 가능 잔고가 그 결제로 충전된 P 이상이라는 뜻입니다. 주문 예약으로 묶여 있는 P는 사용 가능 잔고에 들어가지 않습니다.',
        ),
      ],
    },
    {
      heading: '환불 금액과 방법',
      blocks: [
        bullets(
          '그 결제에서 실제로 결제한 금액 전액을 환불합니다. 할인된 가격으로 결제했다면 할인된 결제 금액이 환불됩니다.',
          '환불과 함께 그 결제로 충전된 P 전부가 잔고에서 차감됩니다.',
          '결제 금액의 일부만 돌려받는 부분 환불은 하지 않습니다.',
          '환불은 원래 결제 수단의 결제를 취소하는 방식으로만 이루어지며, 현금이나 다른 수단으로 돌려드리지 않습니다.',
          '결제 취소가 카드 명세서 등에 반영되기까지는 카드사나 결제 수단 제공자의 처리 일정에 따라 영업일 기준으로 며칠이 걸릴 수 있습니다.',
        ),
      ],
    },
    {
      heading: '환불받을 수 없는 경우',
      blocks: [
        bullets(
          '환불을 처리하는 시점에 결제가 승인된 때부터 {{refundWindowDays}}일이 지난 결제',
          '그 결제로 충전된 P를 조금이라도 쓴 결제',
          '쿠폰, 이벤트, 보너스로 받은 P와 예측 정산으로 지급된 P 등 결제 없이 받은 P',
          '이미 환불되었거나 취소된 결제',
        ),
        paragraph(
          'P는 어떤 경우에도 현금으로 바꾸거나 출금할 수 없습니다. 돌려받을 수 있는 것은 위 조건을 충족한 결제의 취소뿐입니다.',
        ),
      ],
    },
    {
      heading: '환불 요청 방법',
      blocks: [
        numbered(
          '고객센터 이메일({{email}}) 또는 전화({{phone}})로 환불을 요청해 주세요.',
          '요청할 때 가입한 계정의 이메일 주소, 결제 일시, 결제 금액을 알려 주세요. 회사는 카드 번호나 비밀번호를 묻지 않습니다.',
          '회사는 요청을 받으면 지체 없이 조건을 확인하고, 조건을 충족하면 결제를 취소합니다. 요청의 처리 기한은 {{refundProcessingTime}}입니다. 처리 결과는 이메일로 알려 드립니다.',
          '환불 조건은 회사가 처리하는 시점을 기준으로 판단하므로, 기간이 끝나기 직전에 요청하면 처리하는 사이에 기간이 지나 환불되지 않을 수 있습니다. 기간이 끝나기 전에 처리될 수 있도록 여유를 두고 요청해 주세요.',
          '요청한 뒤 처리되기 전에 그 결제로 충전된 P를 쓰면 조건을 충족하지 못해 환불되지 않을 수 있습니다.',
        ),
      ],
    },
    {
      heading: '결제 오류',
      blocks: [
        paragraph(
          '결제는 승인되었지만 P를 충전하지 못한 경우 그 결제는 원칙적으로 자동으로 취소됩니다. 자동으로 취소되지 않은 경우에는 회사가 확인한 뒤 P를 충전하거나 결제를 취소하여 바로잡습니다. 결제 내역이 남아 있는데 P가 충전되지 않았다면 고객센터로 알려 주세요.',
        ),
      ],
    },
    {
      heading: '회원 탈퇴와 서비스 종료',
      blocks: [
        bullets(
          '회원이 탈퇴하면 남은 P는 소멸하며 환불되지 않습니다. 환불 조건을 충족하는 결제가 있다면 탈퇴하기 전에 환불을 요청해 주세요.',
          '서비스를 종료하는 경우의 처리는 이용약관과 관계 법령에 따릅니다.',
        ),
      ],
    },
    {
      heading: '기타',
      blocks: [
        paragraph(
          '미성년자가 법정대리인의 동의 없이 한 결제는 「민법」 제5조에 따라 미성년자 본인이나 법정대리인이 취소할 수 있으며, 취소는 환불 요청과 같은 방법으로 고객센터 이메일({{email}}) 또는 전화({{phone}})로 요청하면 됩니다.',
        ),
        paragraph(
          '이 정책에서 정하지 않은 사항이나, 관계 법령이 회원에게 이 정책보다 유리하게 정한 사항은 그 법령에 따릅니다.',
        ),
      ],
    },
  ],
  addendum: [paragraph('시행일: {{effectiveDate}}')],
};
