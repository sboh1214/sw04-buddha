import {
  APPEAL_WINDOW_DAYS,
  LEGAL_FIRST_EFFECTIVE_DATE,
  WRITING_RESTRICTION_DAYS,
} from '@buddha/shared';
import { copy } from '@/copy';
import { LEGAL_NO_SALES_NOTICE } from './cash-notice';
import { type LegalDocument, effectiveDateText, numbered, paragraph } from './document';
import { SERVICE_FACTS as S } from './service-facts';

/**
 * 이용약관 (ADR-0044), revised by #137 (ADR-0176) for the product as it is: free Coin, YES/NO
 * contracts traded on an order book, judging with a provisional result, disputes and VOID, the
 * operating liquidity, the mobile 본인확인, and no paid Coin (N06, D9). Business facts are
 * `{{placeholders}}` (business-info.ts). No external legal review (D11).
 *
 * It only puts decided values and rules into sentences — every member duty and company right in it
 * comes from the plan, an owner decision or a decision issue's answer (#137's 수용 기준); ADR-0176
 * lists the source of each article. What it shares with the service guide (#136) it quotes word for
 * word from service-facts.ts (S01–S32, every one of them is here — legal.test.ts checks), and the
 * guide is a summary whose rights and duties follow this text (owner answer 136-3).
 *
 * Numbers (owner answers 133-2 and 137-6 (a)): the contract's code-fixed values (inside the fact
 * sentences), and the values that set a member's rights and deadlines — the age, the appeal days,
 * the writing restriction's terms — each from its constant. A value an admin changes is
 * '화면에 표시한 값을 따릅니다'; an internal limit is only said to exist (133-30).
 *
 * Changing a word changes what members agreed to: add a version (versions.ts, and the consent
 * version in CONSENT_DOCUMENTS, @buddha/shared) rather than rewriting this one in place.
 */

const writingRestrictionTerms = `${WRITING_RESTRICTION_DAYS.map((days) => `${String(days)}일`).join('·')} 또는 무기한`;

export const TERMS: LegalDocument = {
  title: copy.legalTermsTitle,
  numbering: 'article',
  effectiveDate: LEGAL_FIRST_EFFECTIVE_DATE,
  intro: [],
  sections: [
    {
      heading: '목적',
      blocks: [
        paragraph(
          '이 약관은 회사(상호: {{companyName}}, 이하 "회사")가 제공하는 {{serviceName}} 서비스(이하 "서비스")를 이용하는 조건과 절차, 회사와 회원 사이의 권리·의무 및 책임 사항을 정하는 것을 목적으로 합니다.',
        ),
      ],
    },
    {
      heading: '용어의 정의',
      blocks: [
        paragraph('이 약관에서 쓰는 용어의 뜻은 다음과 같습니다.'),
        numbered(
          '"서비스"란 결과에 따라 지급되는 사건 계약(YES/NO)을 Coin으로 거래하는 예측시장 서비스를 말합니다.',
          '"회원"이란 이 약관에 동의하고 회사와 이용계약을 맺어 계정을 받은 사람을 말합니다.',
          '"계정"이란 회원을 식별하고 서비스를 이용하게 하기 위해 이메일 주소 또는 소셜 로그인 정보로 만든 이용 단위를 말합니다.',
          '"Coin"이란 서비스 안에서만 쓰는 단위로, 회원이 무료로 받아 계약을 거래하는 데 쓰는 것을 말합니다.',
          '"시장"이란 하나의 질문과, 그 결과를 정하는 규칙으로 이루어진 거래 대상을 말합니다.',
          '"규칙"이란 시장마다 결과를 정하는 기준과 출처, 거래 마감과 판정 예정 시각을 적은 것으로, 시장 화면에 표시됩니다.',
          `"계약"이란 시장마다 있는 YES 계약과 NO 계약을 말합니다. ${S.eventContract} ${S.contractChoice}`,
          '"주문"이란 회원이 가격과 수량을 정해 계약을 사거나 팔겠다는 요청을 말하고, "체결"이란 주문이 다른 주문과 만나 거래가 이루어지는 것을 말합니다.',
          `"거래 상대"란 회원의 주문과 체결되는 주문을 낸 다른 계정을 말합니다. ${S.operatingLiquidity} ${S.operatingLiquidityRules} 운영 유동성은 회사가 운영하는 거래 계정입니다.`,
          `"시장가격"은 시장 화면에 표시하는 시장의 가격입니다. ${S.marketPrice}`,
          '"판정"이란 시장의 규칙에 따라 결과를 YES, NO 또는 무효(VOID)로 정하는 일을 말합니다.',
          '"지급(정산)"이란 결과가 확정된 뒤 회원이 보유한 계약에 따라 Coin을 지급하는 일을 말합니다.',
        ),
        paragraph('이 약관에서 정하지 않은 용어는 관계 법령과 일반적인 거래 관행에 따릅니다.'),
      ],
    },
    {
      heading: '약관의 게시와 개정',
      blocks: [
        numbered(
          '회사는 회원이 쉽게 볼 수 있도록 이 약관을 서비스 화면 아래쪽의 이용약관 링크에 게시합니다. 이전에 시행한 약관도 같은 화면에서 볼 수 있습니다.',
          '회사는 「약관의 규제에 관한 법률」, 「전자상거래 등에서의 소비자보호에 관한 법률」 등 관계 법령을 위반하지 않는 범위에서 이 약관을 개정할 수 있습니다.',
          '약관을 개정하면 회사는 개정 내용과 시행일을 시행일 7일 전부터 서비스 화면에 공지합니다. 회원에게 불리한 변경은 시행일 30일 전부터 공지하고, 회원이 등록한 이메일 주소로도 따로 알립니다.',
          '회원의 권리를 바꾸는 개정은 시행일 뒤 다음 로그인 때 바뀐 항목에 다시 동의를 받고, 그 밖의 개정은 공지합니다. 개정 약관에 동의하지 않는 회원은 탈퇴할 수 있습니다.',
        ),
      ],
    },
    {
      heading: '서비스의 내용',
      blocks: [
        numbered(
          {
            text: '회사는 다음 서비스를 제공합니다.',
            items: [
              '시장 목록과, 시장마다의 질문·규칙·시장가격·마감 시각 안내',
              '호가창에서 YES·NO 계약을 사고파는 거래',
              '판정과 지급',
              '시작 Coin과 재지급',
              '공개 프로필과 커뮤니티(근거 글·댓글)',
              '관심 시장과 알림',
              '시장 제안과 판정 이의',
              '이용 내역 조회',
            ],
          },
          `${LEGAL_NO_SALES_NOTICE} ${S.noFee}`,
          '시장의 질문, 규칙, 마감 시각은 시장 화면에 표시됩니다. 회원은 거래하기 전에 이를 확인해야 합니다.',
        ),
      ],
    },
    {
      heading: '이용계약의 성립과 이용 자격',
      blocks: [
        numbered(
          '이용계약은 가입하려는 사람이 가입한 뒤 첫 단계에서 이 약관과 개인정보 수집·이용에 동의하고, 제3항의 본인확인을 마치면 성립합니다.',
          '서비스는 만 {{minimumAge}}세 이상인 사람만 가입할 수 있습니다. 회원은 가입한 뒤 첫 단계에서 만 {{minimumAge}}세 이상임을 확인해야 합니다.',
          '회원은 가입 과정에서 휴대전화로 받은 인증번호로 본인확인을 하고 본인의 실명을 정확하게 입력해야 합니다. 휴대전화 번호 하나로는 계정 하나만 만들 수 있습니다.',
          '폐쇄 테스트 동안에는 회사가 가입 허용 목록에 미리 넣은 휴대전화 번호로만 본인확인을 마칠 수 있습니다.',
          {
            text: '회사는 다음에 해당하는 신청은 승낙하지 않습니다.',
            items: [
              '다른 사람의 이름이나 휴대전화 번호를 쓴 경우',
              '이미 다른 계정이 쓰고 있는 휴대전화 번호인 경우',
              '폐쇄 테스트 동안 가입 허용 목록에 없는 휴대전화 번호인 경우',
              '만 {{minimumAge}}세 미만인 경우',
            ],
          },
        ),
      ],
    },
    {
      heading: '계정 관리',
      blocks: [
        numbered(
          '회원은 자신의 계정과 비밀번호를 스스로 관리해야 하며, 다른 사람이 쓰게 해서는 안 됩니다.',
          '계정이 도용되었거나 다른 사람이 쓰고 있다는 것을 알게 되면 회원은 바로 비밀번호를 바꾸고 회사에 알려야 합니다.',
          '회원이 제1항 또는 제2항을 지키지 않아 생긴 손해에 대해서는, 회사에 고의나 과실이 없는 한 회사가 책임을 지지 않습니다.',
          '이메일 주소와 실명은 MY의 설정 화면에서 고칠 수 있습니다. 휴대전화 번호는 고객센터({{email}})에 문의해야만 바꿀 수 있습니다.',
        ),
      ],
    },
    {
      heading: 'Coin',
      blocks: [
        numbered(
          `${S.startGrant} 같은 번호로 다시 가입해도 시작 Coin은 다시 지급하지 않습니다.`,
          `${S.regrant} ${S.grantsNotProfit}`,
          '판정 오류로 생긴 부족분은 제11조에 따라 보상으로 지급합니다.',
          `${S.noRewardOrTransfer} 회원은 Coin이나 계정을 다른 사람에게 넘기거나 빌려줄 수 없고, Coin이나 계정을 서비스 밖에서 돈이나 재화와 거래할 수 없습니다.`,
          `${S.noCashOut} Coin은 서비스 안에서 계약을 거래하는 데에만 씁니다.`,
          'Coin에는 유효기간이 없습니다.',
          S.lossMoves,
          '탈퇴하면 남은 Coin은 소멸합니다(제15조).',
        ),
      ],
    },
    {
      heading: '계약과 거래',
      blocks: [
        numbered(
          `${S.pairCollateral} ${S.noLeverage}`,
          S.priceRange,
          S.holdingByFill,
          S.immediateOrder,
          S.limitOrderExpiry,
          S.waitingOrdersCancelled,
          S.limitsAndMonitoring,
        ),
      ],
    },
    {
      heading: '시장의 판정과 지급',
      blocks: [
        numbered(
          S.noReopen,
          `${S.judgingPrinciple} ${S.judgingDelay}`,
          S.judgingApproval,
          S.provisionalResult,
          S.provisionalCorrection,
          S.resolvedApartFromPaid,
          S.payout,
          `정상적으로 YES나 NO로 판정할 수 없는 시장은 규칙에 따라 무효(VOID)로 판정합니다. ${S.voidResult}`,
          S.noFillCancel,
        ),
      ],
    },
    {
      heading: '판정 이의',
      blocks: [
        numbered(
          '판정 이의는 그 시장에서 체결한 적이 있는 회원만 낼 수 있고, 계정 제한 중에도 낼 수 있습니다.',
          '판정 이의는 이의 기간 안에 서비스의 제출 화면에서 근거 링크와 사유를 함께 내야 합니다. 판정의 판마다 한 번 낼 수 있고, 이의 기간 안에는 철회할 수 있지만 고칠 수는 없습니다.',
          '판정 이의가 받아들여지면 회사는 제9조 제5항에 따라 잠정 결과를 정정하고 이의 기간을 다시 줍니다.',
          '판정 이의의 처리 결과와 사유는 이의를 낸 회원에게 보입니다. 처리 상태와 기각·수용 사유는 공개 판정 기록에도 실리며, 이의를 낸 사람과 이의 본문은 공개하지 않습니다.',
        ),
      ],
    },
    {
      heading: '결과가 확정된 뒤의 판정 오류',
      blocks: [
        numbered(
          S.resolvedError,
          '보상은 계정마다 부족분을 정하고, 그 보상을 등록한 관리자와 다른 관리자가 승인한 뒤 지급합니다. 계정 제한 중에도 지급하고, 탈퇴한 계정에는 지급하지 않습니다.',
          '판정 오류를 알리거나 보상에 대해 문의하려면 고객센터({{email}})로 연락합니다.',
        ),
      ],
    },
    {
      heading: '회사의 의무',
      blocks: [
        numbered(
          '회사는 관계 법령과 이 약관을 지키며, 서비스를 안정적으로 제공하기 위해 노력합니다.',
          '회사는 회원의 개인정보를 개인정보처리방침에 따라 보호합니다.',
          '회사는 회원의 문의와 불만을 성실하게 처리하고, 처리 결과나 일정을 이메일 등으로 알립니다.',
        ),
      ],
    },
    {
      heading: '금지 행위',
      blocks: [
        paragraph('회원은 다음 행위를 해서는 안 됩니다.'),
        numbered(
          '가입하거나 정보를 바꿀 때 사실과 다른 정보나 다른 사람의 정보를 입력하는 행위',
          '다른 회원의 계정을 쓰거나, 자신의 계정을 다른 사람에게 넘기거나 빌려주는 행위',
          '한 사람이 여러 계정을 만들어 쓰는 행위(다계정)',
          'Coin이나 계정을 돈 또는 재화와 거래하거나, 그런 거래를 알선하거나 광고하는 행위',
          '다른 계정과 짜고 거래하거나 가격을 조작하는 등의 이상 거래, 그리고 다른 회원에게 공모나 조작을 유도하는 행위',
          '시장의 결과에 부당하게 영향을 주거나, 부정한 방법으로 얻은 정보로 거래하는 행위',
          '스팸, 괴롭힘, 다른 사람의 개인정보 노출, 사칭, 시장과 무관한 글, 다른 사람의 권리를 침해하는 글을 올리는 행위',
          '회사가 허용하지 않은 자동화 수단으로 서비스를 이용하거나, 서비스의 정상적인 운영을 방해하는 행위',
          '서비스의 보안 취약점을 악용하거나 시스템에 허락 없이 접근하는 행위',
          '회사의 사전 동의 없이 서비스를 영리 목적으로 이용하는 행위',
          '그 밖에 법령이나 공공질서에 어긋나는 행위',
        ),
        paragraph(copy.reportNotAReason),
      ],
    },
    {
      heading: '운영 조치와 제재 이의',
      blocks: [
        numbered(
          {
            text: '회원이 금지 행위를 하면 회사는 위반의 정도에 따라 다음 조치 가운데 하나를 고릅니다. 조치를 정해진 차례대로 올리지는 않습니다.',
            items: [
              '글·댓글 숨김',
              '경고',
              `작성 제한(${writingRestrictionTerms})`,
              '계정 제한(기간을 정하거나 무기한으로 하며, 다른 운영자가 승인해야 효력이 생깁니다)',
              '프로필 조치(닉네임을 자동 닉네임으로 바꾸기, 소개 비우기, 프로필 이미지 지우기)',
            ],
          },
          '회사는 신고 횟수만으로 자동으로 숨기거나 제재하지 않고, 운영자가 건마다 판단합니다. 같은 IP 주소를 썼다는 것만으로 다계정이나 공모로 단정하지 않습니다.',
          '조치는 정해지는 즉시(계정 제한은 승인되는 즉시) 효력이 있습니다. 회사는 조치를 받은 회원에게 조치의 종류, 사유, 기간, 이의 방법을 알립니다. 제재 상태는 본인에게만 보입니다.',
          `회원은 조치마다 한 번, 조치를 받은 때부터 ${String(APPEAL_WINDOW_DAYS)}일 안에 고객센터 이메일({{email}})로 제재 이의를 낼 수 있습니다. 검토하는 동안 조치는 그대로 유지되고, 결과는 유지·취소·감경 가운데 하나입니다.`,
          '계정 제한 중에는 새 주문(매도 포함), 재지급 신청, 시장 제안, 공개 프로필에 새 값 넣기, 탈퇴를 할 수 없고, 기다리던 주문은 취소됩니다. 잔액과 기록, 보유한 계약의 지급, 판정 오류의 보상, 판정 이의와 제재 이의는 그대로입니다. 글·댓글 쓰기와 좋아요, 신고, 관심 시장 등록은 막지 않습니다.',
          '작성 제한 중에는 글·댓글을 쓰거나 고칠 수 없고, 공개 프로필에 새 값을 넣거나 시장을 제안할 수 없습니다. 자기 글·댓글과 프로필 항목을 지우는 것, 좋아요와 신고는 할 수 있습니다.',
        ),
      ],
    },
    {
      heading: '탈퇴',
      blocks: [
        numbered(
          '회원은 언제든지 MY의 설정 화면에서 직접 탈퇴할 수 있습니다. 탈퇴는 마지막 확인 즉시 처리되며 되돌릴 수 없습니다.',
          {
            text: '다음에 해당하는 동안에는 탈퇴할 수 없습니다.',
            items: [
              '정산되지 않은 계약을 보유하고 있을 때',
              '작성 제한이나 계정 제한을 받고 있을 때',
              '관리자 권한이 있을 때(권한이 회수된 뒤에 탈퇴할 수 있습니다)',
              '원장 장애로 멈춘 시장에서 복구를 기다리는 주문이 있을 때(그 시장이 복구될 때까지)',
            ],
          },
          '탈퇴하면 기다리던 주문은 취소되고 남은 Coin은 소멸합니다.',
          '같은 이메일 주소, 소셜 로그인, 휴대전화 번호로 곧바로 다시 가입할 수 있습니다. 다만 시작 Coin을 이미 받은 번호에는 시작 Coin을 다시 지급하지 않습니다.',
          '탈퇴한 회원이 쓴 글·댓글은 지우지 않고, 작성자를 "탈퇴한 사용자"로 표시합니다.',
          '운영자가 회원을 대신해 탈퇴시키거나 탈퇴한 계정을 되살리지 않습니다.',
          '탈퇴한 뒤에도 남는 기록과 그 보관 기간은 개인정보처리방침에 따릅니다.',
        ),
      ],
    },
    {
      heading: '서비스의 변경과 중단',
      blocks: [
        numbered(
          '회사는 운영상·기술상 필요에 따라 서비스의 전부 또는 일부를 바꿀 수 있으며, 중요한 변경은 미리 공지합니다.',
          '회사는 설비 점검·교체, 장애, 통신 두절 등의 사유로 서비스를 잠시 중단할 수 있습니다. 계획된 중단은 미리 공지하고, 미리 알릴 수 없었던 중단은 사후에 알립니다.',
          '회사가 서비스를 종료하려면 종료일 30일 전까지 서비스 화면에 공지하고 회원에게 이메일로 알립니다.',
        ),
      ],
    },
    {
      heading: '책임의 제한',
      blocks: [
        numbered(
          '회사는 천재지변, 전쟁, 정전, 통신망 장애 등 불가항력으로 서비스를 제공하지 못한 경우에는 책임을 지지 않습니다.',
          '회사는 회원의 귀책 사유로 생긴 서비스 이용 장애에 대해서는 책임을 지지 않습니다.',
          `${S.marketPriceNotProbability} 회원이 시장가격을 근거로 서비스 밖에서 내린 판단의 결과에 대해 회사는 책임을 지지 않습니다.`,
          '이 조는 회사의 고의 또는 과실로 회원에게 생긴 손해에 대한 회사의 책임을 면제하지 않습니다.',
        ),
      ],
    },
    {
      heading: '개인정보의 보호',
      blocks: [
        paragraph(
          '회사는 「개인정보 보호법」 등 관계 법령과 개인정보처리방침에 따라 회원의 개인정보를 처리합니다. 개인정보처리방침은 서비스 화면 아래쪽의 링크에서 볼 수 있습니다.',
        ),
      ],
    },
    {
      heading: '분쟁의 해결과 관할',
      blocks: [
        numbered(
          '회사와 회원은 서비스와 관련해 생긴 분쟁을 원만하게 해결하기 위해 성실하게 협의합니다.',
          '협의로 해결되지 않으면 회원은 한국소비자원 등 관계 법령에 따른 분쟁조정기관에 조정을 신청할 수 있습니다.',
          '이 약관과 서비스 이용에는 대한민국 법을 적용합니다.',
          '회사와 회원 사이의 소송은 「민사소송법」에 따른 관할 법원에 제기합니다.',
        ),
      ],
    },
  ],
  addendum: [
    paragraph(`이 약관은 ${effectiveDateText(LEGAL_FIRST_EFFECTIVE_DATE)}부터 시행합니다.`),
    // The transitional clause of owner answer 137-2a (133-12): the one reset before the first
    // market, which the 제7조 and 제15조 rules above would otherwise forbid.
    paragraph(
      '회사는 첫 시장을 열기 전에 한 번, 모든 계정과 기록을 지우고 다시 시작합니다. 이때 회원은 다시 가입해야 하며, 같은 휴대전화 번호에도 시작 Coin을 다시 지급합니다.',
    ),
  ],
};
