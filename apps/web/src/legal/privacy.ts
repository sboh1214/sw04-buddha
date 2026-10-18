import { copy } from '@/copy';
import { type LegalDocument, bullets, numbered, paragraph, table } from './document';

/**
 * 개인정보처리방침 (ADR-0044), following the items 「개인정보 보호법」 제30조 asks a policy to
 * state. Original text; business facts are `{{placeholders}}` (business-info.ts). Pending legal
 * review (QUESTIONS.md Q-M2-3).
 *
 * The collected items are what the code actually stores: better-auth's `user`/`account`/
 * `session` rows (email, password hash, the provider's name/image, IP and user agent),
 * `profiles` (nickname), `phone_verifications` (real name and verified mobile, ADR-0070; the
 * policy's wording of it is #137's, D11) and `payments` /
 * `payment_events` (the PG's approval result, whose card number arrives masked — SmartroPay
 * masks digits 7-12). The processors are the PG and AWS (terraform/: ap-northeast-2, SES in the
 * same region). Keep this list in step with the schema when either changes.
 *
 * Access records get no fixed retention period on purpose: the deployment keeps no access log of
 * its own (no Caddy `log`, container logs capped and replaced on every deploy), so the policy
 * says what is true — collected for security and abuse prevention, kept only as long as that
 * needs or a law requires — and the period is an open question (QUESTIONS.md), not a promise.
 */
export const PRIVACY: LegalDocument = {
  title: copy.legalPrivacyTitle,
  numbering: 'article',
  intro: [
    paragraph(
      '회사(상호: {{companyName}}, 이하 "회사")는 「개인정보 보호법」 등 관계 법령에 따라 {{serviceName}} 서비스 이용자의 개인정보를 보호하고, 이와 관련한 고충을 빠르고 원활하게 처리하기 위해 다음과 같이 개인정보처리방침을 정하여 공개합니다.',
    ),
  ],
  sections: [
    {
      heading: '개인정보의 처리 목적',
      blocks: [
        paragraph(
          '회사는 다음 목적을 위해서만 개인정보를 처리합니다. 목적이 바뀌면 「개인정보 보호법」 제18조에 따라 별도의 동의를 받는 등 필요한 조치를 합니다.',
        ),
        numbered(
          '회원 가입과 관리: 가입 의사 확인, 회원 식별과 로그인, 만 {{minimumAge}}세 미만의 가입 제한, 계정 도용과 부정 이용 방지, 탈퇴 처리',
          '서비스 제공: 예측 거래와 정산, P 충전과 쿠폰 처리, 이용 내역 제공, 순위 화면의 닉네임 표시',
          '결제와 환불: 충전 결제의 승인과 취소, 결제 기록 관리, 환불 처리, 결제 관련 분쟁 대응',
          '고객 지원: 문의와 불만 처리, 약관 변경 등 중요한 사항의 안내',
          '서비스 안정성과 보안: 접속 기록 관리, 부정 이용 탐지, 장애 대응',
        ),
      ],
    },
    {
      heading: '처리하는 개인정보의 항목',
      blocks: [
        table(
          '처리하는 개인정보 항목과 수집 방법',
          ['구분', '항목', '수집 방법'],
          [
            [
              '이메일 가입',
              '이메일 주소, 비밀번호(복원할 수 없는 형태로 암호화하여 저장), 닉네임',
              '회원이 직접 입력',
            ],
            [
              '소셜 로그인 가입',
              '소셜 로그인 제공자(Google, 카카오, 네이버)가 발급한 회원 식별자, 제공자가 전달하는 이메일 주소·이름·프로필 사진 주소, 닉네임',
              '회원의 동의에 따라 제공자로부터 받음',
            ],
            [
              '실명과 연락처',
              '실명, 휴대전화 번호',
              '회원이 가입 과정에서 또는 서비스를 처음 이용하기 전에 직접 입력',
            ],
            [
              '충전 결제',
              '결제 금액과 일시, 결제 수단의 종류, 결제대행사 거래 번호와 승인 번호, 카드사 이름, 일부가 가려진 카드 번호 등 결제 결과 정보',
              '결제대행사로부터 받음',
            ],
            [
              '서비스 이용',
              'IP 주소, 브라우저·기기 정보, 접속 일시, 서비스 이용 기록(거래·정산·P 이용 내역), 쿠키',
              '서비스를 이용하는 과정에서 자동으로 생성·수집',
            ],
          ],
        ),
        paragraph(
          '카드 번호 전체, 유효기간, 비밀번호 등 결제 수단의 정보는 결제대행사가 직접 처리하며, 회사는 이를 받거나 저장하지 않습니다.',
        ),
        paragraph('회사는 주민등록번호를 수집하지 않습니다.'),
      ],
    },
    {
      heading: '개인정보의 처리 및 보유 기간',
      blocks: [
        numbered(
          '회사는 회원이 탈퇴할 때까지 개인정보를 보유하며, 탈퇴하면 지체 없이 파기합니다. 다만 관계 법령에 따라 보존해야 하는 정보는 아래 기간 동안 보관합니다.',
          '관계 법령 위반에 따른 수사나 조사가 진행 중인 경우에는 그 수사나 조사가 끝날 때까지 보유합니다.',
        ),
        table(
          '관계 법령에 따라 보관하는 정보',
          ['보관하는 정보', '보관 기간', '근거 법령'],
          [
            [
              '계약 또는 청약철회 등에 관한 기록',
              '5년',
              '「전자상거래 등에서의 소비자보호에 관한 법률」',
            ],
            [
              '대금결제 및 재화 등의 공급에 관한 기록',
              '5년',
              '「전자상거래 등에서의 소비자보호에 관한 법률」',
            ],
            [
              '소비자의 불만 또는 분쟁처리에 관한 기록',
              '3년',
              '「전자상거래 등에서의 소비자보호에 관한 법률」',
            ],
          ],
        ),
        paragraph(
          '서비스 접속 기록(IP 주소, 접속 일시)은 서비스의 보안을 유지하고 부정 이용을 막기 위해 수집하며, 그 목적에 필요한 기간 동안만 보관합니다. 다만 관계 법령이 보관을 요구하는 경우에는 그 법령이 정한 기간 동안 보관합니다.',
        ),
      ],
    },
    {
      heading: '개인정보의 제3자 제공',
      blocks: [
        paragraph(
          '회사는 회원의 개인정보를 이 방침에서 밝힌 처리 목적의 범위에서만 처리하며, 회원이 동의한 경우나 법률에 특별한 규정이 있는 경우 등 「개인정보 보호법」 제17조와 제18조가 허용하는 경우 외에는 제3자에게 제공하지 않습니다.',
        ),
      ],
    },
    {
      heading: '개인정보 처리의 위탁',
      blocks: [
        paragraph('회사는 서비스 제공을 위해 다음과 같이 개인정보 처리 업무를 위탁합니다.'),
        table(
          '개인정보 처리 업무의 위탁',
          ['수탁자', '위탁 업무', '처리하는 정보'],
          [
            [
              '{{pgName}}',
              '충전 결제의 승인과 취소 등 결제 대행',
              '구매자의 실명·휴대전화 번호·이메일 주소, 결제 금액, 회원을 구별하기 위한 값(원래 값을 알아낼 수 없는 형태)',
            ],
            [
              '{{hostingProvider}}',
              '서버와 데이터베이스 운영(호스팅), 이메일 발송(Amazon SES)',
              '서비스 운영에 필요한 개인정보 전부. 데이터는 {{hostingRegion}}(대한민국)에 보관합니다.',
            ],
          ],
        ),
        paragraph(
          '회사는 위탁 계약을 맺을 때 「개인정보 보호법」 제26조에 따라 위탁 업무 목적 외의 처리 금지, 기술적·관리적 보호조치, 재위탁 제한, 수탁자에 대한 관리·감독, 손해배상 등 책임에 관한 사항을 문서로 정하고, 수탁자가 개인정보를 안전하게 처리하는지 감독합니다.',
        ),
        paragraph('수탁자나 위탁 업무의 내용이 바뀌면 이 개인정보처리방침으로 알립니다.'),
      ],
    },
    {
      heading: '개인정보의 파기 절차와 방법',
      blocks: [
        numbered(
          '회사는 보유 기간이 지났거나 처리 목적을 달성한 개인정보를 지체 없이 파기합니다.',
          '법령에 따라 보존해야 하는 개인정보는 다른 개인정보와 분리하여 저장·관리하고, 보존 기간이 끝나면 파기합니다.',
          '전자 파일 형태의 정보는 복구할 수 없는 방법으로 삭제하고, 종이에 출력한 정보는 분쇄하거나 소각합니다.',
        ),
      ],
    },
    {
      heading: '정보주체와 법정대리인의 권리·의무 및 행사 방법',
      blocks: [
        numbered(
          '회원은 언제든지 자신의 개인정보에 대해 열람, 정정·삭제, 처리정지, 동의 철회를 요구할 수 있습니다.',
          '닉네임, 이메일 주소, 실명, 휴대전화 번호는 설정 화면에서 직접 확인하고 고칠 수 있습니다. 그 밖의 요구는 개인정보 보호책임자에게 이메일({{privacyOfficerEmail}})로 할 수 있으며, 회사는 지체 없이 조치합니다.',
          '권리 행사는 법정대리인이나 회원에게서 위임을 받은 사람을 통해서도 할 수 있습니다. 이 경우 위임장을 제출해야 합니다.',
          '법령에서 보존을 요구하는 정보는 삭제를 요구하더라도 그 기간 동안 보관될 수 있으며, 법령이 정한 경우에는 열람이나 처리정지 요구가 제한될 수 있습니다.',
          '회원은 자신의 개인정보를 정확하고 최신의 상태로 유지해야 하며, 다른 사람의 개인정보를 도용해서는 안 됩니다.',
        ),
      ],
    },
    {
      heading: '쿠키 등 자동 수집 장치의 설치·운영과 거부',
      blocks: [
        numbered(
          '회사는 로그인 상태를 유지하기 위해 세션 쿠키를 사용합니다. 이 쿠키는 서비스 이용에 꼭 필요하며, 회사는 광고나 행태 분석을 위한 쿠키를 사용하지 않습니다.',
          '화면 모드(라이트·다크) 설정은 회원의 브라우저에만 저장되며 회사 서버로 전송되지 않습니다.',
          '회원은 브라우저 설정에서 쿠키 저장을 거부할 수 있습니다. 다만 쿠키를 거부하면 로그인이 필요한 서비스를 이용할 수 없습니다.',
        ),
      ],
    },
    {
      heading: '개인정보의 안전성 확보 조치',
      blocks: [
        paragraph('회사는 개인정보를 안전하게 처리하기 위해 다음 조치를 합니다.'),
        numbered(
          '관리적 조치: 개인정보에 접근할 수 있는 사람을 최소한으로 제한하고, 접근 권한을 업무에 필요한 범위로 관리합니다.',
          '기술적 조치: 비밀번호를 복원할 수 없는 방식으로 암호화하여 저장하고, 모든 통신 구간을 암호화(HTTPS)하며, 데이터베이스 접근 권한을 제한합니다.',
          '물리적 조치: 개인정보를 저장하는 서버를 {{hostingProvider}}의 데이터센터에서 운영하여 물리적 접근을 통제합니다.',
        ),
      ],
    },
    {
      heading: '개인정보 보호책임자',
      blocks: [
        paragraph(
          '회사는 개인정보 처리에 관한 업무를 총괄하여 책임지고, 개인정보 처리와 관련한 회원의 불만 처리와 피해 구제를 위해 다음과 같이 개인정보 보호책임자를 지정합니다.',
        ),
        bullets(
          '개인정보 보호책임자: {{privacyOfficer}}',
          '이메일: {{privacyOfficerEmail}}',
          '전화: {{phone}}',
        ),
        paragraph(
          '회원은 서비스를 이용하면서 생긴 개인정보 보호 관련 문의, 불만 처리, 피해 구제 등을 개인정보 보호책임자에게 문의할 수 있으며, 회사는 지체 없이 답변하고 처리합니다.',
        ),
      ],
    },
    {
      heading: '권익침해 구제 방법',
      blocks: [
        paragraph(
          '개인정보 침해에 대한 구제를 받으려면 다음 기관에 분쟁 해결이나 상담 등을 신청할 수 있습니다.',
        ),
        bullets(
          '개인정보분쟁조정위원회: (국번 없이) 1833-6972',
          '개인정보침해신고센터(한국인터넷진흥원): (국번 없이) 118',
          '대검찰청: (국번 없이) 1301',
          '경찰청: (국번 없이) 182',
        ),
      ],
    },
    {
      heading: '만 {{minimumAge}}세 미만 아동의 개인정보',
      blocks: [
        paragraph(
          '서비스는 만 {{minimumAge}}세 이상만 가입할 수 있으므로, 회사는 만 {{minimumAge}}세 미만 아동의 개인정보를 수집하지 않습니다.',
        ),
      ],
    },
    {
      heading: '개인정보처리방침의 변경',
      blocks: [
        paragraph(
          '이 개인정보처리방침은 시행일부터 적용됩니다. 내용이 추가·삭제·수정되면 시행 7일 전부터 서비스 화면에 공지하며, 회원의 권리에 중요한 변경이 있으면 시행 30일 전부터 공지합니다.',
        ),
      ],
    },
  ],
  addendum: [paragraph('시행일: {{effectiveDate}}')],
};
