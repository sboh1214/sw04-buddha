import { type LegalDocument, paragraph, table } from './document';

/**
 * The two consent texts the onboarding's consent step shows (#58, ADR-0069 decision 4 #58: they
 * did not exist and #58 writes them; pending the owner's review, ADR-0072): 개인정보 수집·이용 (the
 * required item `privacy`, which also links the 개인정보처리방침) and 마케팅 정보 수신 (the optional
 * item `marketing`). 이용약관 and the age check have none of their own: the first is /terms, the
 * second is the one sentence the owner wrote (#57-4).
 *
 * Shaped as a `LegalDocument` with an intro only, so the legal pages' resolver (business facts as
 * `{{placeholders}}`, business-info.ts) and renderer (`LegalBlocks`) serve them as well, and the
 * tests walk their strings the same way (consent-texts.test.ts, which also pins each text to the
 * consent version it is recorded under — changing a word here means a new version in
 * CONSENT_DOCUMENTS, @buddha/shared).
 *
 * What the privacy text says is what the code collects and keeps (ADR-0069 decision 1 #57-1·#57-3·
 * #57-5·#57-18, ADR-0070, ADR-0071): the email (better-auth `user`); for a sign-up or a link
 * through Google, Kakao or Naver, the provider's member id (better-auth `account.account_id`) —
 * not the name nor the profile photo, which are neither asked of the provider (Google's and Kakao's
 * scopes, `OAUTH_SCOPES`; Naver's developer console) nor stored (`user.name` and `user.image` hold
 * nothing and the provider's ID token, which carries both, is not kept: the API's auth hooks,
 * 오너 결정 2026-10-19 (2차) 3, ADR-0072 7-30·7-40); the
 * real name and the verified number (`phone_verifications`), every code sent with its number, real
 * name, time and client IP
 * (`phone_verification_codes`, the 본인확인 기록 kept for #184's retention period, past a
 * withdrawal), each consent answer with its version, time, client IP and User-Agent
 * (`consent_records`, kept for the retention period), and the keyed hash of a number that received
 * the start Coin (`start_grants`, kept without a period so the number never receives it twice).
 * The SMS goes through 알리고 (ADR-0069 decision 1 #57-3). Unlike the 개인정보처리방침 (/privacy,
 * #137's to revise, D11) these are screen text: excluded-features.test.ts holds them to the whole
 * excluded list.
 */

/** 개인정보 수집·이용 동의 (필수): the required item `privacy` (#57-5). */
export const PRIVACY_CONSENT_TEXT: LegalDocument = {
  title: '개인정보 수집·이용 동의(필수)',
  numbering: 'decimal',
  intro: [
    paragraph(
      '회사(상호: {{companyName}}, 이하 "회사")는 {{serviceName}} 회원 가입과 본인확인을 위해 아래와 같이 개인정보를 수집·이용합니다.',
    ),
    table(
      '수집·이용하는 개인정보',
      ['수집·이용 목적', '수집 항목', '보유·이용 기간'],
      [
        ['회원 식별과 로그인, 문의 대응', '이메일 주소', '탈퇴할 때까지'],
        [
          '회원 식별과 로그인(소셜 로그인으로 가입하거나 연결한 경우)',
          '소셜 로그인 제공자(Google, 카카오, 네이버)가 발급한 회원 식별자',
          '탈퇴할 때까지',
        ],
        [
          '본인확인(입력한 휴대전화 번호로 보낸 인증번호의 확인), 휴대전화 번호마다 한 번인 시작 Coin 지급의 확인, 문의 대응',
          '실명, 휴대전화 번호, 인증번호를 보낸 기록(보낸 번호와 실명, 시각, 요청한 IP 주소)',
          '탈퇴할 때까지. 인증번호를 보낸 기록은 본인확인 기록으로 탈퇴한 뒤에도 운영 정책으로 정한 보존기간 동안 보관합니다.',
        ],
        [
          '동의 기록의 관리',
          '동의한 항목과 문서의 판, 동의 시각, 동의할 때의 IP 주소와 브라우저 정보',
          '운영 정책으로 정한 보존기간 동안(탈퇴한 경우 탈퇴한 때부터 셉니다)',
        ],
      ],
    ),
    paragraph(
      '탈퇴하면 위 개인정보를 지체 없이 파기합니다. 다만 운영 정책으로 정한 보존기간의 대상인 기록은 그 기간이 지난 뒤 파기합니다. 시작 Coin을 받은 휴대전화 번호는 같은 번호로 다시 받지 않도록 원래 번호를 알아낼 수 없는 형태로 바꾼 값만 탈퇴한 뒤에도 보관합니다.',
    ),
    paragraph(
      '본인확인 인증번호 문자(SMS)를 보내는 업무는 알리고(㈜알리는사람들)에 맡기며, 이때 휴대전화 번호와 문자의 내용이 전달됩니다.',
    ),
    paragraph(
      '위 개인정보 수집·이용에 동의하지 않을 수 있습니다. 다만 이 동의는 서비스 이용에 꼭 필요하므로, 동의하지 않으면 회원 가입을 마칠 수 없습니다. 자세한 내용은 개인정보처리방침에서 볼 수 있습니다.',
    ),
  ],
  sections: [],
  addendum: [],
};

/**
 * 마케팅 정보 수신 동의 (선택): the optional item `marketing` (#57-5) — by email only, and turned on
 * and off in MY 설정 at any time (오너 결정 2026-10-19 (2차) 4, ADR-0072). Nothing sends any yet.
 */
export const MARKETING_CONSENT_TEXT: LegalDocument = {
  title: '마케팅 정보 수신 동의(선택)',
  numbering: 'decimal',
  intro: [
    paragraph(
      '회사는 {{serviceName}}의 새 기능과 서비스 소식을 이메일로 알리기 위해, 동의한 회원의 개인정보를 아래와 같이 이용합니다.',
    ),
    table(
      '마케팅 정보 수신을 위해 이용하는 개인정보',
      ['이용 목적', '이용 항목', '보유·이용 기간'],
      [['새 기능과 서비스 소식의 이메일 안내', '이메일 주소', '동의를 철회하거나 탈퇴할 때까지']],
    ),
    paragraph(
      '지금은 마케팅 정보를 보내지 않습니다. 보내기 시작하면 동의한 회원에게만 이메일로 보냅니다.',
    ),
    paragraph(
      '이 동의는 선택이며, 동의하지 않아도 서비스를 이용할 수 있습니다. 동의는 언제든지 MY의 설정 화면에서 철회하거나 다시 할 수 있습니다.',
    ),
  ],
  sections: [],
  addendum: [],
};
