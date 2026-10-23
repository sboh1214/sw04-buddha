/**
 * User-facing copy (Korean). Keep every UI string here. Terms follow docs/TERMS.md (#14,
 * ADR-0052): trading is 거래·매수·매도, the price is 시장가격, deciding a result is 판정 and paying
 * Coin out is 정산, and 예측 only names the genre (예측시장).
 */

/**
 * How a market gets into the watchlist, the sentence both empty watchlists end on: MY's 관심 시장
 * tab and the home's 관심 시장 view (owner decision 2026-10-16, ADR-0065). Held once, so the two
 * cannot drift apart.
 */
const WATCHLIST_HOW_TO_ADD = '시장 상세에서 관심 등록을 누르면 여기에 모입니다.';

export const copy = {
  appName: 'buddha',
  appDescription: '가상 Coin으로 YES/NO 계약을 호가창에서 거래하는 예측시장',
  tradeCta: '거래하기',
  // 계약의 이름(N02 §1·§4, 오너 결정 #14): 의견이나 투표의 선택이 아니라 거래할 계약이다.
  yes: 'YES',
  no: 'NO',
  lightMode: '라이트 모드',
  darkMode: '다크 모드',
  comingSoon: '준비 중입니다.',
  // 지갑의 고정 안내(N01 §2). 유료 충전을 닫아(ADR-0049) 충전은 말하지 않는다. 약관·환불정책
  // 본문은 이 문장이 아니라 legal/cash-notice.ts의 원래 문장을 인용한다(#137에서 개정).
  walletNotice: 'Coin의 현금 환전·출금은 제공하지 않습니다.',

  // --- navigation / auth buttons (M1) ---
  navAdmin: '관리자',
  balance: '잔고',
  login: '로그인',
  signup: '가입하기',
  logout: '로그아웃',
  // Deliberately does not claim the session survived: when the response is lost the sign-out
  // may well have happened server-side. Retrying is safe either way.
  logoutFailed: '로그아웃하지 못했습니다. 다시 시도해 주세요.',
  loading: '불러오는 중',

  // --- forms ---
  email: '이메일',
  emailPlaceholder: 'you@example.com',
  password: '비밀번호',
  passwordConfirm: '비밀번호 확인',
  passwordHint: '8자 이상',
  showPassword: '비밀번호 보기',
  hidePassword: '비밀번호 숨기기',
  currentPassword: '현재 비밀번호',
  newPassword: '새 비밀번호',
  newPasswordConfirm: '새 비밀번호 확인',
  submit: '확인',
  save: '저장',
  cancel: '취소',
  // 시트·대화상자를 닫는 단추의 이름(Chakra의 CloseButton은 영어 'Close'를 단다).
  close: '닫기',

  // --- validation ---
  errEmailInvalid: '올바른 이메일 주소를 입력해 주세요.',
  errPasswordTooShort: '비밀번호는 8자 이상이어야 합니다.',
  errPasswordTooLong: '비밀번호는 128자 이하여야 합니다.',
  errPasswordMismatch: '비밀번호가 일치하지 않습니다.',
  errNicknameFormat: '닉네임은 2~20자의 한글·영문·숫자·밑줄(_)만 쓸 수 있습니다.',
  // 닉네임 규칙(#58, ADR-0069 결정 1 #57-6). 대소문자를 구분하지 않고 겹치는 닉네임과, 다른 계정이 바꾸거나
  // 탈퇴로 비운 지 30일이 안 된 닉네임은 같은 답이다 — 어느 쪽인지 말하면 누가 최근에 닉네임을 바꿨는지
  // 알려 주게 된다(#37-3). 운영자가 강제로 바꾼 옛 닉네임은 그 회원 자신에게서도 30일 보류되므로(#50, 오너 결정
  // 2026-10-21 답 4(나), ADR-0081 7-27) 그 회원도 이 답을 받는다 — 그래서 누가 쓰던 것인지 말하지 않는다.
  // 문장은 오너가 승인했다(오너 결정 2026-10-22 답 3).
  // 30은 NICKNAME_HOLD_DAYS, 간격의 30은 NICKNAME_CHANGE_INTERVAL_DAYS, 예약어 목록은
  // NICKNAME_RESERVED_WORDS와 같아야 한다(lib/nickname.test.ts가 확인한다).
  errNicknameTaken: '이미 사용 중이거나 최근 30일 안에 쓰인 닉네임이라 지금은 쓸 수 없습니다.',
  // 온보딩의 닉네임 단계와 MY 설정이 같이 보인다. MY 설정에는 그대로 쓸 자동 닉네임이 남아 있지 않을 수 있어
  // 규칙만 말한다(자동 닉네임을 그대로 써도 된다는 것은 닉네임 단계의 안내 nicknameStepIntro가 말한다).
  errNicknameAutoPrefix:
    "'user_'로 시작하는 닉네임은 직접 정할 수 없습니다. 다른 닉네임을 입력해 주세요.",
  errNicknameReservedWord:
    '운영자로 오해할 수 있는 낱말(운영자·관리자·운영팀·공식·admin·buddha)이 들어간 닉네임은 쓸 수 없습니다.',
  // 바꾼 지 30일이 안 됐다. 뒤에 다음에 바꿀 수 있는 시각과 nicknameChangeAgainFrom이 붙는다.
  errNicknameChangeInterval: '닉네임은 30일에 한 번 바꿀 수 있습니다.',
  nicknameChangeAgainFrom: '부터 다시 바꿀 수 있습니다.',
  // 온보딩의 닉네임 단계를 다른 탭에서 이미 마쳤다. 화면은 서버를 다시 읽어 다음 단계로 간다.
  errNicknameAlreadySet: '닉네임은 이미 정했습니다.',
  errRequired: '필수 항목입니다.',

  // --- login ---
  loginTitle: '로그인',
  loginSubtitle: '거래를 시작하려면 로그인하세요.',
  loginWithEmail: '이메일로 로그인',
  loginFailed: '이메일 또는 비밀번호가 올바르지 않습니다.',
  emailNotVerified:
    '이메일 인증이 필요합니다. 인증 메일을 다시 보냈으니 받은 편지함을 확인해 주세요.',
  emailNotVerifiedResendFailed:
    '이메일 인증이 필요합니다. 인증 메일을 보내지 못했으니 잠시 후 다시 시도해 주세요.',
  verifyLinkInvalid: '인증 링크가 만료되었거나 올바르지 않습니다. 다시 요청해 주세요.',
  orContinueWith: '또는 다른 방법으로',
  continueWithGoogle: 'Google로 계속하기',
  continueWithKakao: '카카오로 계속하기',
  continueWithNaver: '네이버로 계속하기',
  socialUnavailable: '이 로그인 방법은 현재 사용할 수 없습니다.',
  noAccountYet: '아직 계정이 없나요?',
  forgotPassword: '비밀번호를 잊으셨나요?',

  // --- signup ---
  signupTitle: '가입하기',
  signupSubtitle: '이메일로 가입하거나 소셜 계정으로 시작하세요.',
  signupWithEmail: '이메일로 가입',
  signupEmailHint: '인증 메일을 보낼 주소입니다. 비밀번호는 인증 후에 설정합니다.',
  signupFailed: '가입에 실패했습니다. 잠시 후 다시 시도해 주세요.',
  emailAlreadyUsed: '이미 가입된 이메일입니다.',
  alreadyHaveAccount: '이미 계정이 있나요?',
  signupCheckMailTitle: '받은 편지함을 확인해 주세요',
  signupCheckMailBefore: '다음 주소로 인증 메일을 보냈습니다.',
  signupCheckMailAfter:
    '메일의 링크를 누르면 로그인되고 비밀번호를 설정하는 화면으로 이동합니다. 링크는 1시간 동안 유효합니다.',
  signupCheckMailHint:
    '메일이 오지 않으면 스팸함을 확인해 주세요. 이미 인증을 마친 주소로는 다시 보내지 않으니, 로그인하거나 비밀번호 재설정으로 진행해 주세요.',
  loginResendHint:
    '인증 메일의 링크를 아직 누르지 않았다면, 같은 주소로 다시 가입해 메일을 받으세요.',
  // 인증은 마쳤지만 비밀번호를 정하기 전에 세션이 끊긴 사용자의 유일한 복구 경로다(ADR-0024).
  // 재가입도 재발송도 이미 인증된 주소에는 메일을 보내지 않으므로(열거 방지) 안내가 필요하다.
  loginSetPasswordHint:
    '인증 링크는 눌렀지만 비밀번호를 정하지 못했다면, 아래 「비밀번호를 잊으셨나요?」에서 비밀번호를 설정해 주세요.',
  verificationResent: '인증 메일을 다시 보냈습니다.',
  // 약관 동의는 가입 화면이 아니라 온보딩의 첫 단계에서 항목마다 받는다(#58, ADR-0069 결정 1 #57-5). 가입만으로
  // 동의한 것으로 보지 않는다.
  signupNotice: '약관 동의는 가입한 뒤 첫 단계에서 항목마다 받습니다.',

  // --- reset password ---
  resetTitle: '비밀번호 재설정',
  resetSubtitle: '가입한 이메일로 재설정 링크를 보내 드립니다.',
  resetRequest: '재설정 링크 보내기',
  resetRequested: '이메일이 등록되어 있다면 재설정 링크를 보냈습니다.',
  resetNewTitle: '새 비밀번호 설정',
  resetSubmit: '비밀번호 변경',
  resetDone: '비밀번호가 변경되었습니다. 다시 로그인해 주세요.',
  resetTokenInvalid: '링크가 만료되었거나 올바르지 않습니다. 다시 요청해 주세요.',
  backToLogin: '로그인으로 돌아가기',

  // --- settings ---
  settingsTitle: '설정',
  settingsProfile: '프로필',
  nickname: '닉네임',
  nicknameHint: '2~20자 한글·영문·숫자·밑줄(_)',
  // 직접 입력한 닉네임의 규칙(#57-6). 온보딩의 닉네임 단계와 MY 설정의 닉네임 카드가 같이 보인다.
  nicknameRulesHint:
    "'user_'로 시작하거나 운영자로 오해할 수 있는 낱말이 들어간 닉네임은 쓸 수 없습니다.",
  // 가입 뒤의 변경 간격(#57-6). 온보딩에서 정한 것은 변경으로 세지 않는다.
  nicknameChangeRule: '닉네임은 30일에 한 번 바꿀 수 있습니다.',
  nicknameSaved: '닉네임을 변경했습니다.',
  settingsLinkedAccounts: '연결된 로그인 수단',
  settingsLinkedHint: '로그인 수단이 하나뿐이면 해제할 수 없습니다.',
  providerCredential: '이메일·비밀번호',
  providerGoogle: 'Google',
  providerKakao: '카카오',
  providerNaver: '네이버',
  link: '연결',
  unlink: '해제',
  linked: '연결됨',
  notLinked: '연결 안 됨',
  unlinkDone: '연결을 해제했습니다.',
  unlinkRefused: '마지막 남은 로그인 수단은 해제할 수 없습니다.',
  linkFailed: '로그인 수단을 연결하지 못했습니다. 다시 시도해 주세요.',
  linkAlreadyUsed: '이미 다른 계정에 연결된 로그인 수단입니다.',
  setPasswordTitle: '비밀번호 설정',
  setPasswordSubtitle: '이메일 인증이 끝났습니다. 로그인에 사용할 비밀번호를 정해 주세요.',
  setPasswordSubmit: '비밀번호 저장',
  passwordSet: '비밀번호를 설정했습니다.',
  // Shown to a visitor who already has a session: the link they just clicked is stale, but
  // their address is verified either way, so this must NOT tell them to request another one
  // (re-registering a verified address mails nothing).
  setPasswordLinkStale:
    '이 링크는 이미 사용되었거나 만료되었습니다. 이메일 인증은 끝났으니 그대로 진행하셔도 됩니다.',
  passwordAlreadySet: '비밀번호가 이미 설정되어 있습니다.',
  goHome: '홈으로 가기',
  // 가입하기 전에 보던 화면으로 가는 링크(#58, #57-9). 홈이면 goHome이다.
  continueOn: '계속하기',
  settingsPassword: '비밀번호 변경',
  passwordChanged: '비밀번호를 변경했습니다.',
  passwordWrong: '현재 비밀번호가 올바르지 않습니다.',
  passwordNotSet: '아직 비밀번호가 없습니다. 설정하면 이메일로도 로그인할 수 있습니다.',
  settingsTheme: '테마',
  settingsThemeHint: '라이트/다크 모드를 전환합니다.',
  // 시간대 (ADR-0061 #60-8, ADR-0063). 고르지 않으면 브라우저 시간대를 따르고, 그 선택지 뒤에
  // 지금 브라우저의 시간대를 괄호로 붙인다. 시간대는 선택지마다 IANA 이름과 브라우저가 주는
  // 한국어 이름이다('America/New_York — 미 동부 시간', 오너 결정 2026-10-16, lib/time-zone.ts).
  settingsTimeZone: '시간대',
  // 관리자 화면은 고른 시간대와 상관없이 한국 시간이고 표시가 없다(ADR-0061 #60-8), 그래서 힌트가
  // 회원 화면으로 범위를 좁힌다. 표시는 UTC와의 차이다(`(GMT-4)`, ADR-0063).
  settingsTimeZoneHint:
    '회원 화면의 시각을 이 시간대로 보여 줍니다. Asia/Seoul이 아니면 시각 옆에 UTC와의 차이를 적습니다. 관리자 화면은 한국 시간입니다.',
  timeZoneFollowBrowser: '브라우저 시간대 따르기',
  timeZoneSaved: '시간대를 저장했습니다.',
  errTimeZoneInvalid: '이 시간대는 저장할 수 없습니다. 다른 시간대를 골라 주세요.',
  // 마케팅 정보 수신(#58, 오너 결정 2026-10-19 (2차) 4, ADR-0072): 이메일로만 받고 MY 설정에서 언제든 켜고
  // 끈다. 바꿀 때마다 동의 기록이 하나씩 남는다(동의 단계와 같은 시각·IP·브라우저). 켜는 줄은 동의 단계의
  // consentMarketing이고, 동의문(legal/consent-texts.ts)은 '내용 보기'로 펼친다. 지금은 보내는 기능이 없다.
  settingsMarketing: '마케팅 정보 수신',
  settingsMarketingHint:
    '새 기능과 서비스 소식을 이메일로 받을지 정합니다. 언제든 켜고 끌 수 있습니다.',
  // 바꾼 뒤의 알림과, 마지막으로 바꾼 시각(회원의 시간대) 앞에 붙는 말.
  marketingConsentOn: '마케팅 정보 수신에 동의했습니다.',
  marketingConsentOff: '마케팅 정보 수신 동의를 철회했습니다.',
  marketingConsentChangedAt: '마지막으로 바꾼 때:',
  settingsAccount: '계정',
  settingsAccountHint: '이메일은 인증을 거친 뒤에만 변경됩니다.',
  settingsEmailUnverified: '이메일 인증이 완료되지 않았습니다.',
  resendVerification: '인증 메일 다시 보내기',
  emailVerifiedBadge: '인증됨',
  emailUnverifiedBadge: '미인증',
  noEmail: '이메일 없음',
  noEmailNotice:
    '카카오·네이버에서 이메일을 받지 못했습니다. 아래에서 이메일을 등록하고 인증해 주세요.',
  newEmail: '새 이메일',
  changeEmail: '이메일 변경',
  changeEmailHintVerified:
    '현재 이메일로 확인 메일이 가고, 확인하면 새 이메일로 인증 메일이 갑니다.',
  changeEmailHintUnverified: '새 이메일로 인증 메일이 갑니다. 링크를 누르면 변경이 완료됩니다.',
  changeEmailSentCurrent: '현재 이메일로 확인 메일을 보냈습니다.',
  changeEmailSentNew: '새 이메일로 인증 메일을 보냈습니다.',
  errEmailSame: '현재 이메일과 같습니다.',

  // --- 탈퇴 (#140, ADR-0086) ---
  // ADR-0069 결정 1 #57-15~#57-18, 결정 3 #37-15~#37-17, 결정 4 #140 행. 본인만 하고 확인하는 즉시 처리하며
  // 되돌리지 않는다(대리 탈퇴·복구 없음, #57-17). 마지막 확인은 한 화면이다: 남은 Coin의 소멸과 되돌릴 수
  // 없음을 보이고 '탈퇴'를 직접 입력해 한 번 확인한다(결정 4 #140 «마지막 확인»). MY 설정 맨 끝의 카드에서
  // 연다. 지우는 것과 남는 것의 두 줄은 이 화면의 선택이다(ADR-0086 7-2) — 지우는 것은 #57-18의 '곧바로
  // 지운다', 남는 것은 #37-16·#37-17의 '본문을 남기고 작성자만 익명화, 좋아요는 수에 남는다'이다. 실명·휴대전화
  // 번호는 '곧바로 지워지는' 줄에 없다: 본인확인 발송 기록이 번호·실명을 보존기간 동안 남긴다(ADR-0070 2차 답 1 —
  // #57-18 즉시 삭제의 예외). 그 기록을 화면에 말할지와 문구는 오너에게 물었다(ADR-0086 결과 4).
  closureTitle: '탈퇴',
  closureHint: '계정을 닫습니다. 탈퇴는 되돌릴 수 없습니다.',
  closureOpen: '탈퇴하기',
  closureCoinLabel: '남은 Coin',
  closureForfeit: '탈퇴하면 남은 Coin은 모두 사라지고 돌려받을 수 없습니다.',
  closureIrreversible:
    '탈퇴는 확인하는 즉시 처리되며 되돌릴 수 없습니다. 탈퇴한 계정으로는 다시 로그인할 수 없습니다.',
  closureDeleted:
    '닉네임·프로필 이미지·소개·관심 카테고리와 이메일·로그인 수단은 곧바로 지워집니다.',
  closureKept: "작성한 글·댓글과 누른 좋아요는 남고, 작성자는 '탈퇴한 사용자'로 보입니다.",
  closureConfirmLabel: "확인을 위해 '탈퇴'를 입력해 주세요.",
  closureSubmit: '탈퇴하기',
  closureBack: 'MY 설정으로 돌아가기',
  closureDone: '탈퇴했습니다.',
  closureCheckFailed: '남은 Coin과 지금 탈퇴할 수 있는지를 불러오지 못했습니다.',
  // 지금 막는 것(GET /me/closure)과 탈퇴의 거절(CLOSURE_NOT_ALLOWED)의 까닭. 관리자 권한은 회수받은 뒤에
  // (#57-17), 미정산 계약은 모두 정산될 때까지(#57-16), 진행 중인 결제·환불은 끝날 때까지(ADR-0069 결정 7 —
  // 유료 충전이 닫힌 동안은 생기지 않는다), 대기 주문은 있는 동안(임시 — N02 §9는 대기 주문을 취소하고 탈퇴하며,
  // 그 취소를 #178이 만들면 이 거절과 문장은 빠진다. 주문 접수가 없는 지금은 생기지 않는다, ADR-0086 7-9·결과
  // 4). 작성 제한·계정 제한은 위의 errRestrictedClosure·errRestrictedAccountClosure다.
  closureBlocked: '지금은 탈퇴할 수 없습니다.',
  closureRefusalAdmin: '관리자 권한이 있는 계정은 권한을 회수받은 뒤에 탈퇴할 수 있습니다.',
  closureRefusalUnsettled:
    '정산되지 않은 계약이 있는 동안에는 탈퇴할 수 없습니다. 모두 정산된 뒤에 탈퇴할 수 있습니다.',
  closureRefusalPayment: '진행 중인 결제나 환불이 끝난 뒤에 탈퇴할 수 있습니다.',
  closureRefusalPendingOrders: '대기 주문이 있는 동안에는 탈퇴할 수 없습니다.',
  errClosureConfirmation: "'탈퇴'를 정확히 입력해 주세요.",
  // 탈퇴는 그 계정의 세션을 모두 끝내므로, 답을 받지 못한 탈퇴를 다시 보내면 이 거절(401)을 만난다. 앞은 앱의
  // 다른 로그아웃 문장(portfolioSignedOut·onboardingSignedOut)과 같은 말이다.
  errClosureSignedOut:
    '로그인이 풀렸습니다. 이미 탈퇴한 계정이면 그 계정으로는 다시 로그인할 수 없습니다.',

  // --- wallet (M2) ---
  walletTitle: '지갑',
  walletBalance: '사용 가능 잔고',
  walletLocked: '주문 예약',
  // ADR-0069 decision 4 #70, the owner's words: the start Coin waits for its amount (the release
  // setting 시작 지급액 is undecided) and is paid once an admin enters it (ADR-0071).
  walletStartGrantPending: '시작 Coin은 준비되는 대로 지급됩니다.',
  chargeTitle: '코인 충전',
  chargeHint: '금액이 클수록 할인율이 높습니다.',
  chargeDiscount: '할인',
  chargeSubmit: '충전하기',
  chargeDone: '충전이 완료되었습니다.',
  chargeFailed: '충전에 실패했습니다. 잠시 후 다시 시도해 주세요.',
  chargeUnavailable: '지금은 선택할 수 없는 상품입니다.',
  chargePriceMoved: '상품 내용이 바뀌었습니다. 바뀐 가격을 확인하고 다시 시도해 주세요.',
  chargeDuplicate: '이미 처리된 충전 요청입니다. 잔고와 이용 내역을 확인해 주세요.',
  chargeInProgress: '충전이 아직 처리 중입니다. 잠시 후 다시 눌러 결과를 확인해 주세요.',
  sessionChanged: '로그인한 계정이 바뀌었습니다. 화면을 확인한 뒤 다시 시도해 주세요.',
  chargeNoPackages: '판매 중인 충전 상품이 없습니다.',
  // 공개 /charge에서 고르고 온 상품(`/my/wallet?package=`, ADR-0044).
  chargePackageSelected: '선택한 상품',

  // --- coupons (M2) ---
  couponTitle: '쿠폰 등록',
  couponCode: '쿠폰 코드',
  couponPlaceholder: 'ABCD-1234',
  couponHint: '영문 대문자·숫자·하이픈으로 된 코드를 입력해 주세요.',
  couponSubmit: '등록',
  couponRedeemed: '쿠폰을 사용했습니다.',
  errCouponCode: '쿠폰 코드를 입력해 주세요.',
  errCouponInvalid: '사용할 수 없는 쿠폰입니다.',
  errCouponAlreadyUsed: '이미 사용한 쿠폰입니다.',
  errCouponAmount: '1 Coin 이상 1,000,000 Coin 이하의 정수로 입력해 주세요.',
  errAdminCouponCode: '영문·숫자·하이픈 4~32자로 입력하거나 비워 두세요.',
  loadMore: '더 보기',
  ledgerTitle: '이용 내역',
  ledgerEmpty: '아직 내역이 없습니다.',
  ledgerBalanceAfter: '거래 후 잔고',
  ledgerTypeDeposit: '충전',
  ledgerTypeTradeBuy: '매수',
  ledgerTypeTradeSell: '매도',
  ledgerTypeFee: '수수료',
  ledgerTypeSettlement: '정산 지급',
  ledgerTypeAdminAdjust: '관리자 조정',
  ledgerTypeBonus: '보너스',
  ledgerTypePaymentCancel: '결제 취소(환불)',
  ledgerTypePaymentCancelReversal: '결제 취소 복원',
  // ADR-0069 decision 4 #70: the start Coin's own ledger type, '시작 지급'.
  ledgerTypeStartGrant: '시작 지급',
  /** The forfeiture of the Coin left when a member closes the account (#140, #57-16). */
  ledgerTypeClosureForfeit: '탈퇴 소멸',

  // --- admin (M2 minimum, PLAN 12) ---
  adminTitle: '관리자',
  adminUsers: '사용자',
  adminUserSearch: '이메일 또는 닉네임 검색',
  adminSearch: '검색',
  adminNoUsers: '검색 결과가 없습니다.',
  adminPackages: '충전 상품',
  adminPackageAmount: '코인 금액',
  adminPackagePrice: '가격(원)',
  adminPackageOrder: '정렬',
  adminPackageAdd: '상품 추가',
  adminPackageSave: '저장',
  adminPackageDelete: '삭제',
  adminPackageActive: '판매 중',
  adminPackageInactive: '판매 중지',
  adminPackageDeleted: '상품을 삭제했습니다.',
  adminPackageSaved: '상품을 저장했습니다.',
  errPackagePrice: '가격은 코인 금액을 넘을 수 없습니다.',
  adminCoupons: '쿠폰',
  adminCouponCode: '코드 (비우면 자동 생성)',
  adminCouponAmount: '지급 코인',
  adminCouponMax: '사용 횟수 제한',
  adminCouponExpires: '만료 (KST)',
  adminCouponMemo: '메모',
  adminCouponCreate: '쿠폰 발급',
  adminCouponCreated: '쿠폰을 발급했습니다.',
  adminCouponDisable: '중지',
  adminCouponEnable: '재개',
  adminCouponUnlimited: '무제한',
  adminCouponUsage: '사용',
  adminAdjust: '잔고 조정',
  adminAdjustAmount: '조정 금액 (음수는 차감)',
  adminAdjustMemo: '사유',
  adminAdjustSubmit: '조정 적용',
  adminAdjustDone: '잔고를 조정했습니다.',
  errAdjustRange: '0이 아닌 금액을 1,000,000 Coin 이내로 입력해 주세요.',
  errAdjustMemo: '사유를 입력해 주세요.',
  errAdjustNegative: '잔고가 음수가 되는 조정은 할 수 없습니다.',
  // 탈퇴한 계정(#140, ADR-0086): 탈퇴의 '탈퇴 소멸' 뒤로는 그 원장에 아무것도 쓰지 않으므로(마이그레이션
  // 0041) 잔고 조정을 받지 않는다(ACCOUNT_CLOSED). 카드에는 조정 양식 대신 이 줄이 있고, 목록을 읽은 뒤
  // 탈퇴한 계정의 조정도 이 문장으로 거절된다.
  adminAdjustClosed: '탈퇴한 계정이라 잔고를 조정할 수 없습니다.',
  adminOnly: '관리자만 접근할 수 있습니다.',

  // --- admin: markets (M3, PLAN 12) ---
  adminMarkets: '시장',
  adminPayments: '결제',
  adminAuditFailures: '감사',
  adminMarketCreate: '시장 만들기',
  adminMarketCreated: '시장을 만들었습니다.',
  adminMarketStatusFilter: '상태',
  adminMarketStatusAll: '전체',
  marketStatusDraft: '초안',
  marketStatusOpen: '진행 중',
  // 상태 배지의 라벨 (O-5, ADR-0046). 홈의 상태 필터는 ADR-0065가 없앴고, 다른 상태는 검색(#15)이
  // 고른다. 카운트다운의 marketCloseAt '마감'·marketClosed '마감됨'과는 다른 자리다.
  marketStatusClosed: '거래 마감',
  marketStatusResolved: '판정 완료',
  marketStatusSettled: '정산 완료',
  marketStatusVoided: '무효',
  adminMarketClosingSoon: '마감 임박',
  // 관리자 목록·상세의 보조 배지: closed는 판정을, resolved는 워커의 정산을 기다린다.
  adminMarketAwaitingResolution: '판정 대기',
  adminMarketAwaitingSettlement: '정산 대기',
  adminNoMarkets: '시장이 없습니다.',
  adminMarketNotFound: '시장을 찾을 수 없습니다.',
  adminMarketRefreshFailed:
    '최신 정보를 불러오지 못했습니다. 표시된 값은 마지막으로 불러온 것입니다.',
  adminBackToMarkets: '시장 목록으로',
  adminMarketTitle: '질문',
  adminMarketDescription: '설명',
  // 시장 규칙 영역의 이름(N02 §4, N03 §8, 오너 결정 #14). 출처는 adminMarketSource다.
  adminMarketRules: '규칙',
  adminMarketRulesHint: '비워 두면 초안으로만 저장됩니다. 시장을 열려면 채워야 합니다.',
  adminMarketSource: '출처',
  adminMarketCategory: '카테고리',
  adminMarketCategoryPlaceholder: '카테고리 선택',
  adminMarketImageUrl: '이미지 URL',
  adminMarketImageUrlPlaceholder: 'https://',
  adminMarketCloseAt: '마감 시각 (KST)',
  adminMarketCloseAtShort: '마감 시각',
  adminMarketSlug: '슬러그 (비우면 자동 생성)',
  adminMarketEdit: '수정',
  adminMarketSaved: '시장을 저장했습니다.',
  adminMarketNoChanges: '바뀐 내용이 없습니다.',
  adminMarketEditLocked: '이 상태에서는 수정할 수 없습니다.',
  adminMarketEditOpenTitle: '열린 시장을 수정합니다',
  adminMarketEditOpenBody:
    '이미 거래가 진행 중인 시장입니다. 규칙이나 마감 시각을 바꾸면 참여자에게 영향을 줍니다. 계속할까요?',
  adminMarketOpen: '열기',
  adminMarketOpened: '시장을 열었습니다.',
  adminMarketClose: '마감',
  adminMarketCloseTitle: '시장을 마감합니다',
  adminMarketCloseBody: '마감하면 더 이상 거래할 수 없습니다. 계속할까요?',
  adminMarketClosed: '시장을 마감했습니다.',
  // 관리자 상세의 거래 현황: 체결·포지션에서 나온 값만 보인다(직접 AMM 상태는 #125에서 지웠다).
  adminMarketTradeStats: '거래 현황',
  tradeStatsLastPrice: '현재가',
  tradeStatsNetCollected: '순 수취 코인',
  tradeStatsOpenInterestYes: '미결제 YES',
  tradeStatsOpenInterestNo: '미결제 NO',
  marketTradeCount: '거래 수',
  marketTraderCount: '참여자 수',
  marketVolume: '거래량',
  marketOpenAt: '연 시각',
  marketResolvedResult: '결과',
  marketResolvedAt: '판정 시각',
  marketSettledAt: '정산 시각',
  marketVoidedAt: '무효 시각',
  marketCreatedAt: '생성',
  marketUpdatedAt: '수정',
  marketCreatedBy: '생성자',
  adminMarketEvents: '이벤트 로그',
  adminNoEvents: '기록이 없습니다.',
  eventCreated: '생성',
  eventOpened: '열림',
  eventClosed: '마감',
  // 이의 단계(M5)의 과거 이벤트. 더 이상 쓰지 않지만 옛 시장의 이벤트 로그에 남아 있다.
  eventResolveProposed: '결과 제안',
  eventResultChanged: '결과 변경',
  eventResolved: '판정',
  eventFinalized: '정산 완료',
  eventVoided: '무효',
  eventRulesEdited: '규칙 수정',
  eventSystem: '시스템',
  eventRulesBefore: '이전',
  eventRulesAfter: '이후',
  payloadUnreadable: '표시할 수 없는 내용',
  // 관리자 상세의 관련 시장 (#65, ADR-0068): 지금 연결된 시장(모든 상태)과 해제, 제목으로 찾아 연결.
  // 연결·해제는 담당자와 시각만 기록에 남고 사유는 받지 않는다(ADR-0061 결정 1의 19).
  adminRelatedMarkets: '관련 시장',
  // 안내 한 줄은 세 문장을 잇는다(lib/related-markets.ts `relatedHint`). 둘째 문장의 상태는 화면의
  // 상태 라벨(MARKET_STATUS_LABEL)로 적어 같은 카드의 배지와 같고, #173이 라벨을 바꾸면 따라간다.
  adminRelatedHint: '연결한 두 시장은 서로의 상세에 관련 시장으로 보입니다.',
  adminRelatedHintShownLead: '상세에는',
  adminRelatedHintShownTail: '인 시장만 보입니다.',
  adminRelatedHintNoEffect: '연결은 두 시장의 규칙·거래·판정·정산을 바꾸지 않습니다.',
  adminRelatedEmpty: '연결된 관련 시장이 없습니다.',
  adminRelatedLinkedAt: '연결',
  adminRelatedUnlink: '연결 해제',
  adminRelatedUnlinkTitle: '관련 시장 연결을 해제합니다',
  adminRelatedUnlinkBody: '해제하면 두 시장의 상세에서 서로 보이지 않습니다. 계속할까요?',
  adminRelatedUnlinked: '관련 시장 연결을 해제했습니다.',
  adminRelatedSearchLabel: '연결할 시장 찾기',
  adminRelatedSearchPlaceholder: '시장 제목의 일부',
  adminRelatedSearchSubmit: '찾기',
  adminRelatedSearchEmpty: '제목에 이 글자가 들어간 시장이 없습니다.',
  adminRelatedLink: '연결',
  adminRelatedLinked: '관련 시장을 연결했습니다.',
  adminRelatedAlreadyLinked: '연결됨',
  adminRelatedThisMarket: '이 시장',
  errRelatedSelf: '같은 시장끼리는 연결할 수 없습니다.',
  adminMarketFills: '최근 체결',
  adminNoFills: '아직 체결이 없습니다.',
  buy: '매수',
  sell: '매도',
  fillQty: '수량',
  fillAvgPrice: '평균가',
  errMarketTitle: '질문은 1~120자로 입력해 주세요.',
  errMarketText: '5,000자 이하로 입력해 주세요.',
  errMarketSource: '출처는 500자 이하로 입력해 주세요.',
  errMarketCategory: '카테고리를 선택해 주세요.',
  errMarketCategoryUnavailable: '선택할 수 없는 카테고리입니다.',
  errMarketImageUrl: 'http 또는 https로 시작하는 500자 이하의 URL을 입력해 주세요.',
  errMarketCloseAt: '마감 시각은 현재보다 뒤여야 합니다.',
  errMarketSlug: '슬러그는 영문 소문자·숫자·한글·하이픈 3~80자로 입력하거나 비워 두세요.',
  errMarketSlugTaken: '이미 사용 중인 슬러그입니다.',
  errMarketInvalid: '입력값을 확인해 주세요.',
  errMarketRulesRequired: '규칙을 채워야 시장을 열 수 있습니다.',
  errMarketRulesOpen: '열린 시장의 규칙은 비울 수 없습니다.',
  errMarketNotOpen: '진행 중인 시장이 아닙니다. 화면을 새로 고쳐 주세요.',
  errMarketStatus: '지금 상태에서는 할 수 없는 작업입니다. 화면을 새로 고쳐 주세요.',

  // --- admin: payments / audit (M3) ---
  adminNoPayments: '결제 내역이 없습니다.',
  paymentStatusPending: '처리 중',
  paymentStatusSucceeded: '완료',
  paymentStatusFailed: '실패',
  paymentStatusCancelled: '취소됨',
  paymentStatusRefunding: '환불 처리 중',
  paymentStatusRefunded: '환불됨',
  adminNoAuditFailures: '감사 실패가 없습니다.',
  auditKindLedgerMismatch: '원장·잔고 불일치',

  // --- admin: release settings (#170, ADR-0055, docs/SETTINGS.md) ---
  // 상태 이름(미정·설계 제안·시험값·승인됨)은 @buddha/shared의 RELEASE_SETTING_STATUS_LABELS다.
  // 바꾼 값의 적용 시점은 오너 결정(2026-10-13): 바꾼 뒤 시작하는 일에만.
  adminReleaseSettings: '출시 설정',
  adminReleaseSettingsIntro:
    '시뮬레이션이나 운영 승인으로 정하는 값입니다. 값을 바꾸면 사유·작업자·시각·전후 값이 변경 기록에 남고, 바꾼 값은 바꾼 뒤 시작하는 일에만 적용됩니다.',
  adminReleaseSettingUndecidedHint: '값이 아직 정해지지 않았습니다.',
  adminReleaseSettingProposalHint: '기획의 설계 제안 값입니다. 승인된 값이 아닙니다.',
  adminReleaseSettingTestHint:
    '출시 값이 정해지기 전 내부 시험에 쓰는 값입니다. 출시 값이 아닙니다.',
  adminReleaseSettingApprovedHint: '출시 값으로 승인된 값입니다.',
  adminReleaseSettingsUndecidedOnly: '미정만 보기',
  adminReleaseSettingsTotal: '전체',
  adminReleaseSettingsCountUnit: '개',
  adminReleaseSettingsEmpty: '등록된 항목이 없습니다.',
  adminReleaseSettingsNoUndecided: '미정인 항목이 없습니다.',
  adminReleaseSettingValue: '값',
  adminReleaseSettingUnit: '단위',
  adminReleaseSettingLastChange: '마지막 변경',
  adminReleaseSettingEdit: '변경',
  adminReleaseSettingEditTitle: '출시 설정을 바꿉니다',
  adminReleaseSettingStatus: '상태',
  adminReleaseSettingValueTextHint: '입력한 글자 그대로 저장됩니다.',
  adminReleaseSettingValueJsonHint: '숫자·참거짓·목록은 JSON으로 입력합니다. 예: 24, true, [1, 2]',
  adminReleaseSettingValueFormat: '입력 형식',
  adminReleaseSettingValueUndecided: '미정으로 두면 값을 지웁니다.',
  adminReleaseSettingReason: '변경 사유',
  adminReleaseSettingReasonHint: '변경 기록에 작업자·시각·전후 값과 함께 남습니다.',
  adminReleaseSettingApplyNotice:
    '바꾼 값은 바꾼 뒤 시작하는 일에만 적용됩니다. 이미 진행 중인 일은 시작할 때 읽은 값을 그대로 씁니다.',
  adminReleaseSettingSubmit: '저장',
  adminReleaseSettingSaved: '출시 설정을 바꿨습니다.',
  // 지금 상태·값과 같은 변경은 거절한다(오너 결정 #170). 저장 버튼 옆과 서버 거절의 알림.
  adminReleaseSettingUnchanged: '바뀐 내용이 없습니다.',
  adminReleaseSettingChanges: '변경 기록',
  adminReleaseSettingChangesEmpty: '변경 기록이 없습니다.',
  adminReleaseSettingChangeActor: '작업자',
  adminReleaseSettingChangeReason: '사유',
  adminReleaseSettingUnregistered: '등록되지 않은 항목',
  // RELEASE_SETTING_REASON_MAX_LENGTH와 같아야 한다(release-settings.test.ts가 확인한다).
  errReleaseSettingReason: '변경 사유를 1~500자로 입력해 주세요.',
  errReleaseSettingValueRequired:
    '값을 입력해 주세요. 값을 두지 않으려면 상태를 미정으로 고릅니다.',
  errReleaseSettingValueFormat: 'JSON으로 읽을 수 없는 값입니다.',
  errReleaseSettingValueInvalid: '이 항목의 형식에 맞지 않는 값입니다.',
  errReleaseSettingNotFound: '등록되지 않은 항목입니다. 화면을 새로 고쳐 주세요.',

  // --- admin: admin accounts (#171, ADR-0056) ---
  // 관리자 권한은 하나이고, 관리자가 화면에서 사유를 남기고 다른 관리자의 승인 없이 부여·회수한다.
  // 부여 조건, 2명 하한, 회수 때의 로그아웃은 오너 결정(2026-10-13 #171)이다. 부여 조건의 둘째는
  // 휴대전화 본인확인이다(ADR-0069 결정 4 #58, ADR-0070 — 옛 '실명·휴대전화 입력'을 대신한다). '2명'은
  // MIN_ADMINS와 같아야 하고, 사유 500자는 ADMIN_ROLE_REASON_MAX_LENGTH와 같아야 한다
  // (admin-accounts.test.ts가 확인한다).
  adminAccounts: '운영자 계정',
  adminAccountsIntro:
    '관리자 권한은 하나이며, 관리자가 사유를 남기고 부여·회수합니다. 부여·회수할 때마다 작업자·대상 계정·시각·사유가 권한 변경 기록에 남습니다.',
  adminAccountsGrantRule: '이메일 인증과 휴대전화 본인확인을 마친 계정에만 부여할 수 있습니다.',
  adminAccountsRevokeRule:
    '회수한 뒤에도 관리자가 2명 이상 남아야 합니다. 내 계정의 권한을 회수할 때도 같습니다.',
  adminAccountsRevokeEffect:
    '회수하면 그 계정은 모든 기기에서 로그아웃되고, 바로 관리자 기능을 쓸 수 없습니다.',
  adminAccountsCountUnit: '명',
  adminAccountsSelf: '나',
  adminAccountsGrantedAt: '부여',
  adminAccountsGrantUnknown: '부여 기록 없음',
  adminAccountsRevoke: '회수',
  adminAccountsGrantTitle: '관리자 권한 부여',
  adminAccountsGrantIntro: '이메일 또는 닉네임으로 계정을 찾아 부여합니다.',
  adminAccountsGrant: '부여',
  adminAccountsGrantDialogTitle: '관리자 권한을 부여합니다',
  adminAccountsGrantNotice:
    '이메일 인증과 휴대전화 본인확인을 마친 계정에만 부여할 수 있습니다. 부여하면 이 계정은 다음 요청부터 관리자 기능을 씁니다.',
  adminAccountsGrantDone: '관리자 권한을 부여했습니다.',
  adminAccountsRevokeDialogTitle: '관리자 권한을 회수합니다',
  adminAccountsRevokeNotice:
    '회수하면 이 계정의 모든 세션이 끝나 모든 기기에서 로그아웃되고, 다음 요청부터 관리자 기능을 쓸 수 없습니다. 회수한 뒤에도 관리자가 2명 이상 남아야 합니다.',
  adminAccountsRevokeSelfNotice:
    '내 계정의 권한을 회수합니다. 회수하면 나도 바로 로그아웃되고 첫 화면으로 이동합니다.',
  adminAccountsRevokeDone: '관리자 권한을 회수했습니다.',
  adminAccountsReason: '사유',
  adminAccountsReasonHint: '권한 변경 기록에 작업자·대상 계정·시각과 함께 남습니다.',
  adminAccountsChanges: '권한 변경 기록',
  adminAccountsChangesEmpty: '권한 변경 기록이 없습니다.',
  adminAccountsChangeGrant: '부여',
  adminAccountsChangeRevoke: '회수',
  adminAccountsChangeActor: '작업자',
  adminAccountsChangeReason: '사유',
  adminAccountsTargetGone: '삭제된 계정',
  errAdminRoleReason: '사유를 1~500자로 입력해 주세요.',
  errAdminGrantAlreadyAdmin: '이미 관리자인 계정입니다.',
  errAdminGrantEmailNotVerified:
    '이메일 인증을 마치지 않은 계정입니다. 이메일 인증과 휴대전화 본인확인을 마친 계정에만 관리자 권한을 부여할 수 있습니다.',
  errAdminGrantPhoneNotVerified:
    '휴대전화 본인확인을 마치지 않은 계정입니다. 이메일 인증과 휴대전화 본인확인을 마친 계정에만 관리자 권한을 부여할 수 있습니다.',
  // 탈퇴한 계정(#140, ADR-0086 7-19): 다시 로그인하지 못하고 프로필이 바뀌지 않으므로 부여할 수 없다. 검색의
  // 그 줄에는 '부여' 대신 이 문장이 있고, 검색한 뒤 탈퇴한 계정의 부여도 이 문장으로 거절된다(ACCOUNT_CLOSED).
  adminGrantClosed: '탈퇴한 계정이라 관리자 권한을 부여할 수 없습니다.',
  errAdminRevokeNotAdmin: '관리자가 아닌 계정입니다. 이미 회수되었을 수 있습니다.',
  errAdminRevokeMinAdmins:
    '회수하면 관리자가 2명보다 적어지므로 회수할 수 없습니다. 회수한 뒤에도 관리자가 2명 이상 남아야 하고, 내 계정의 권한을 회수할 때도 같습니다. 다른 계정에 먼저 관리자 권한을 부여해 주세요.',
  errAdminAccountNotFound: '계정을 찾을 수 없습니다. 화면을 새로 고쳐 주세요.',

  // --- admin: SMS 발송 현황 (#183, ADR-0070) ---
  // 본인확인 인증번호 문자의 수만 보인다(오너 결정 2026-10-18 2차: 발송 알림 대신 관리자 화면의 발송 현황).
  // '보낸 문자'는 한도에 드는 발송(결과를 알 수 없는 발송 포함), '보내지 못함'은 사업자가 거절해 한도에 들지
  // 않은 발송이다. 서비스 한도의 수는 API가 준다(serviceLimit = PHONE_VERIFICATION_LIMITS.serviceDailySends).
  adminSms: 'SMS 발송',
  adminSmsIntro:
    '본인확인 인증번호 문자의 발송 수입니다. 번호·실명·계정은 보이지 않고 수만 셉니다. 날짜는 한국 시간입니다.',
  adminSmsLast24Hours: '최근 24시간',
  adminSmsAsOf: '기준 시각',
  adminSmsSent: '보낸 문자',
  adminSmsSentHint:
    '서비스 전체의 24시간 한도에 드는 발송입니다. 결과를 알 수 없는 발송도 듭니다. 한도에 이르면 새 발송이 멈춥니다.',
  adminSmsUnknown: '결과를 알 수 없음',
  adminSmsUnknownHint:
    '문자 발송 사업자의 답을 받지 못한 발송입니다. 문자가 갔을 수 있어 한도에 셉니다.',
  adminSmsRefused: '보내지 못함',
  adminSmsRefusedHint:
    '사업자가 받지 않은 것이 확실한 발송입니다(키 없음, 거절 등). 한도에 세지 않습니다.',
  adminSmsDays: '최근 7일',
  adminSmsDate: '날짜',
  adminSmsToday: '오늘',

  // --- admin: 반복 링크 검토 목록 (#187, ADR-0083) ---
  // 오너 결정(ADR-0069 결정 2 #45-15, 결정 4 #187): 같은 사람이 같은 주소를 24시간에 3개 이상의 글·댓글에
  // 쓰거나, 서로 다른 3명 이상이 24시간에 같은 주소를 쓰면 운영자 검토 목록에 올린다. 글은 그대로 보인다.
  // '사람'은 본인확인한 번호다(결정 7). 시장의 공식 출처 주소와 운영자의 글은 세지 않는다. 수는 시험이
  // LINK_REPEAT_THRESHOLD·LINK_CHECK_MAX와 견준다. 오너 결정 2026-10-22: 같은 주소·규칙끼리 묶어 항목 수를
  // 보이고, 운영자가 '확인함'(문제 없음·조치함)으로 표시하면 운영 기록에 남고 기본 목록에서 빠진다(필터로
  // 본다). 글·댓글마다 본문 순서로 앞의 링크 20개까지 본다. 숨김 같은 조치는 #50의 운영 처리다.
  adminLinkFlags: '반복 링크',
  adminLinkFlagsIntro:
    "같은 사람(본인확인한 번호)이 24시간 안에 같은 주소를 글·댓글 3개 이상에 쓰거나, 서로 다른 3명 이상이 24시간 안에 같은 주소를 쓰면 그 글·댓글이 여기에 올라옵니다. 같은 주소·규칙의 항목은 한 줄로 묶어 항목 수와 최근 탐지 시각을 보입니다. 글은 거절하거나 숨기지 않고 그대로 보입니다. 주소는 견준 모양(scheme·도메인은 소문자, 끝 슬래시·utm 같은 추적용 덧붙임·# 뒤를 뺀 것)으로 보이고, 단축 주소는 풀지 않습니다. 글·댓글마다 본문 순서로 앞의 링크 20개까지 봅니다. 시장의 공식 출처 주소와 운영자의 글은 세지 않습니다. 살펴본 줄을 결과(문제 없음·조치함)와 함께 확인함으로 표시하면 이 목록에서 빠지고 '확인함'에서 볼 수 있습니다. 시각은 한국 시간입니다.",
  adminLinkFlagsOpen: '확인 전',
  adminLinkFlagsReviewed: '확인함',
  adminLinkFlagSameAccount: '한 사람이 3번 이상',
  adminLinkFlagManyAccounts: '3명 이상이 사용',
  adminLinkFlagItems: '항목',
  adminLinkFlagItemsUnit: '개',
  adminLinkFlagLatest: '최근 탐지',
  adminLinkFlagShowItems: '항목 보기',
  adminLinkFlagHideItems: '항목 접기',
  adminLinkFlagFlaggedAt: '탐지',
  adminLinkFlagPost: '근거 글',
  adminLinkFlagComment: '댓글',
  adminLinkFlagAuthor: '작성자',
  adminLinkFlagMarket: '시장',
  adminLinkFlagWrittenAt: '작성',
  adminLinkFlagEdited: '수정됨',
  adminLinkFlagDeleted: '작성자가 삭제',
  adminLinkFlagHidden: '숨김',
  adminNoLinkFlags: '검토할 반복 링크가 없습니다.',
  adminNoReviewedLinkFlags: '확인함으로 표시한 반복 링크가 없습니다.',
  // 펼친 줄에 항목이 없을 때 — 화면이 읽은 뒤 다른 운영자가 표시했거나 항목이 지워졌다(까닭은 가리지 못한다).
  adminLinkFlagItemsGone: '이 줄에 남은 항목이 없습니다. 목록을 다시 불러왔습니다.',
  // '확인함' 표시 (오너 결정 2026-10-22): 결과는 둘, 메모는 고르기. 조치 자체는 #50의 운영 처리에서 한다.
  adminLinkFlagReview: '확인함으로 표시',
  adminLinkFlagReviewTitle: '확인함으로 표시',
  adminLinkFlagReviewBody:
    "이 주소·규칙으로 지금 보이는 항목을 확인함으로 표시합니다. 표시한 항목은 이 목록에서 빠지고 '확인함'에서 볼 수 있습니다. 숨김·경고 같은 조치는 이 표시와 따로 합니다.",
  adminLinkFlagOutcome: '결과',
  adminLinkFlagNoIssue: '문제 없음',
  adminLinkFlagActioned: '조치함',
  adminLinkFlagNote: '메모 (선택)',
  adminLinkFlagReviewDone: '확인함으로 표시했습니다.',
  adminLinkFlagReviewGone:
    '표시할 항목이 남아 있지 않습니다. 다른 운영자가 먼저 표시했을 수 있어 목록을 다시 불러왔습니다.',
  adminLinkFlagReviewedAt: '확인',
  adminLinkFlagReviewer: '운영자',
  adminSmsCountUnit: '건',

  // --- admin: 운영 공지 (#138, ADR-0077) ---
  // 모든 운영자가 쓰고·고치고·고정하고·해제하며 다른 운영자의 승인은 없다(#45-8). 고정은 동시에 3개까지
  // (NOTICE_PIN_LIMIT, notices.test.ts가 같은 수인지 본다)이고 자동 해제는 없다. 해제한 공지는 공지 목록에
  // 남아 다시 고정할 수 있다. 공지는 '운영팀'으로 보이고, 네 작업은 운영자와 시각만 운영 기록에 남는다
  // (사유 없음, #138). 지우는 기능은 없다(ADR-0077 결정 8-7).
  // 안내는 목록 화면과 쓰기 화면에 함께 보이므로 '여기'가 아니라 '공지 목록'이라 쓴다. 고정한 공지만 공개한다
  // (오너 결정 2026-10-21, ADR-0077 — 고정하지 않았거나 푼 공지는 주소로도 없는 공지처럼 보이고 이 화면에만 남는다).
  // 지우는 기능은 없다(같은 날 «이대로»). 이 안내 문장은 오너가 같은 날 2차 답에서 이대로 두었다.
  adminNotices: '공지',
  adminNoticesIntro:
    "공지는 커뮤니티 목록 위의 고정 영역에 보입니다. 동시에 3개까지 고정할 수 있고, 해제한 공지는 공지 목록에 남아 다시 고정할 수 있습니다. 고정한 공지만 누구나 읽을 수 있고, 고정하지 않은 공지는 공지 목록에만 보입니다. 공지는 지울 수 없고 고칠 수만 있습니다. 공지는 '운영팀'의 이름으로 보이고 댓글·좋아요·신고를 받지 않습니다.",
  adminNoticeRecordHint:
    '쓰기·수정·고정·해제는 작업한 운영자와 시각이 운영 기록에 남고, 공지 수정 화면에서 운영 기록과 이전 판을 볼 수 있습니다.',
  adminNoticeWrite: '공지 쓰기',
  adminNoticesPinned: '고정한 공지',
  adminNoticesUnpinned: '고정하지 않은 공지',
  adminNoticesPinnedEmpty: '고정한 공지가 없습니다.',
  adminNoticesUnpinnedEmpty: '고정하지 않은 공지가 없습니다.',
  adminNoticeCreatedAt: '작성',
  adminNoticePinnedAt: '고정',
  adminNoticePin: '고정',
  adminNoticeUnpin: '고정 해제',
  adminNoticeView: '공지 보기',
  adminNoticePinnedToast: '공지를 고정했습니다.',
  adminNoticeUnpinnedToast: '공지 고정을 해제했습니다.',
  adminNoticeCreated: '공지를 썼습니다. 목록에서 고정할 수 있습니다.',
  adminNoticeSaved: '공지를 고쳤습니다.',
  adminNoticeUnchanged: '바뀐 내용이 없습니다.',
  adminNoticeNewTitle: '공지 쓰기',
  adminNoticeEditTitle: '공지 수정',
  adminNoticeSubmit: '올리기',
  adminNoticeSave: '저장',
  adminNoticeStatePinned: '고정 중',
  adminNoticeStateUnpinned: '고정하지 않음',
  adminNoticeBack: '공지 목록으로',
  adminNoticeNotFound: '공지를 찾을 수 없습니다.',
  adminNoticeRefreshFailed:
    '최신 정보를 불러오지 못했습니다. 보이는 내용은 마지막으로 불러온 것입니다.',
  noticeWriteTitleLabel: '제목',
  noticeWriteTitlePlaceholder: '공지 제목',
  noticeWriteBodyPlaceholder: '공지 내용을 적어 주세요. 링크와 이미지를 넣을 수 있습니다.',
  // 고정이 이미 3개일 때(NOTICE_PIN_LIMIT_REACHED). 자동으로 해제하지 않으므로 해제를 먼저 하게 한다.
  errNoticePinLimit:
    '공지는 동시에 3개까지 고정할 수 있습니다. 고정한 공지 하나를 해제한 뒤 다시 고정해 주세요.',
  errNoticeTitle: '제목을 100자 이하의 한 줄로 입력해 주세요.',
  // 수정 화면을 연 뒤 공지가 저장되었을 때(NOTICE_EDIT_CONFLICT). 누가 저장했든 — 같은 운영자의 다른 탭이어도 —
  // 같은 중립 문장이다(오너 결정 2026-10-21 (2차)). 쓰던 내용은 화면에 남고, '최신 내용 불러오기'가 그것을 최신 판으로
  // 바꾼다(ADR-0077).
  errNoticeEditConflict: '그사이 공지가 고쳐졌습니다. 최신 내용을 불러와 주세요.',
  // 거절 안내의 둘째 줄과 단추(묻는 창 없이 다시 연다) — 오너 결정 2026-10-21 (2차) «이대로».
  adminNoticeEditConflictHint: '최신 내용을 불러오면 쓰던 내용은 사라집니다.',
  adminNoticeReloadLatest: '최신 내용 불러오기',
  // 공지 수정 화면의 운영 기록과 이전 판(오너 결정 2026-10-21: 운영자·시각·동작, 이전 판을 보임). 사유는 없다.
  adminNoticeActions: '운영 기록',
  adminNoticeActionsEmpty: '운영 기록이 없습니다.',
  adminNoticeActionCreate: '작성',
  adminNoticeActionUpdate: '수정',
  adminNoticeActionPin: '고정',
  adminNoticeActionUnpin: '고정 해제',
  adminNoticeActionRevision: '바뀌기 전 판',
  adminNoticeActorUnknown: '기록 없음',
  adminNoticeRevisions: '이전 판',
  adminNoticeRevisionsEmpty: '이전 판이 없습니다.',
  adminNoticeRevisionWritten: '작성',
  adminNoticeRevisionReplaced: '바뀜',
  adminNoticeRevisionBadge: '이전 판',
  adminNoticeRevisionNotFound: '이전 판을 찾을 수 없습니다.',
  adminNoticeBackToEdit: '공지 수정으로',

  // --- markets (M4) ---
  // 홈 (PLAN 11.3, ADR-0041 Kalshi 형): 헤더 2단의 상위 카테고리 · 왼쪽 세부 분류 · 정렬 · 검색.
  // 카테고리 목록은 API가 주고 '전체'만 붙인다. 장르 표기는 붙여 쓴다(N01 §1, 오너 결정 #14).
  homeTitle: '예측시장',
  marketsAll: '전체',
  // 세부 분류 사이드바의 첫 줄 — 상위 카테고리 하나의 전체 시장(Kalshi의 "All markets").
  marketsAllInCategory: '전체 시장',
  marketCategories: '카테고리',
  marketSubcategories: '세부 분류',
  marketSort: '정렬',
  // 정렬 (ADR-0061 결정 1의 9~11): 규칙으로 센 추천(최근 24시간 거래량 → 신규)이 처음이고, 거래량 순은
  // #132(비정상 체결 제외) 뒤에 돌아온다. 관심 시장을 켰을 때만 최근 관심 등록 순을 고를 수 있고
  // 켜면 그것이 처음이다(결정 3의 #63). 홈에는 상태 필터가 없고 진행 중 시장만 보인다(결정 1의 13).
  sortRecommended: '추천',
  sortNewest: '신규',
  sortClosing: '마감 임박',
  sortWatched: '최근 관심 등록 순',
  // 분류(결정 1의 12): 전체·카테고리에 겹쳐 고르는 관심 시장. 로그인하지 않았으면 고를 때 로그인으로 간다.
  homeWatchlistToggle: '관심 시장',
  searchLabel: '시장 검색',
  // Kalshi의 "Trade on anything". 라벨은 searchLabel이 따로 지므로 자리 표시자는 초대장이어도 된다.
  searchPlaceholder: '시장을 찾아보세요',
  searchSubmit: '검색',
  marketsEmpty: '아직 열린 시장이 없습니다.',
  // 시장 검색 (#15, ADR-0066): 홈과 다른 결과 화면(ADR-0061 결정 1의 14). 처음에는 공개된 모든 상태를
  // 보이고, 상태 필터는 '모든 상태'와 상태 라벨마다 하나다(결정 1의 13). 제목의 부분 일치로 찾는다
  // (태그는 #17). 결과 없음 · 불러오는 중 · 연결 오류를 서로 다르게 보인다(N02 §3).
  searchTitle: '시장 검색',
  searchStatus: '상태',
  searchStatusAll: '모든 상태',
  searchCategory: '카테고리',
  searchCategoryAll: '모든 카테고리',
  // 검색 화면 안 검색창(과 그 검색 영역)의 접근 이름. 헤더 검색창(searchLabel)은 어디서든 새로 찾고, 이것은
  // 화면에서 고른 상태·카테고리·정렬로 찾는다(ADR-0066). 두 검색 영역이 같은 이름이면 화면 낭독기로 가를 수 없다.
  searchRefineLabel: '고른 조건으로 검색',
  marketsSearchEmpty: '검색 결과가 없습니다.',
  // 검색어 없이 연 화면(결정 3의 #15): 로그인하지 않은 방문자에게는 검색어 입력 안내, 로그인한 회원에게는
  // 본인의 최근 검색 기록(중복 없이 최근 10개, 하나씩·전체 지우기). 최근 검색은 본인에게 보이고 공개 응답에는
  // 싣지 않는다(ADR-0066의 선택). 운영자가 볼 수 있는 범위는 #37 11항이 정한다.
  searchPrompt: '찾을 시장의 검색어를 입력해 주세요.',
  recentSearches: '최근 검색',
  recentSearchesEmpty: '최근 검색 기록이 없습니다.',
  recentSearchDelete: '삭제',
  recentSearchesClear: '전체 삭제',
  recentSearchDeleteFailed: '최근 검색을 지우지 못했습니다. 잠시 후 다시 시도해 주세요.',
  // 관심 시장을 켠 홈: 진행 중인 관심 시장만 보인다(끝난 관심 시장은 MY에 남는다). 뒤 문장은 MY의
  // 빈 관심 시장과 같다(오너 결정 2026-10-16).
  watchlistViewEmpty: `진행 중인 관심 시장이 없습니다. ${WATCHLIST_HOW_TO_ADD}`,
  // 로그인하지 않은 방문자가 관심 시장을 켠 주소를 열었을 때. 목록은 본인에게만 보인다(#37).
  watchlistViewSignedOut: '로그인하면 관심 시장을 볼 수 있습니다.',
  // 카드와 상세 헤더의 짧은 라벨. 숫자·시각은 언제나 호출 쪽에서 붙인다.
  marketCloseAt: '마감',
  marketClosingSoon: '마감 임박',
  marketRemaining: '남은 시간',
  // A-M3-31: 마감 시각이 지난 `open` 시장도 마감 작업이 돌 때까지 목록에 남는다. 카운트다운이
  // 이 문구로 바뀐다. 상태 배지의 marketStatusClosed와는 다른 자리다.
  marketClosed: '마감됨',
  marketTraders: '참여자',
  // formatRemaining(lib/datetime.ts)이 숫자에 붙이는 단위. 문자열은 여기에만 있다.
  unitDay: '일',
  unitHour: '시간',
  unitMinute: '분',
  unitSecond: '초',

  // 상세
  marketDetailTitle: '시장 상세',
  marketNotFound: '시장을 찾을 수 없습니다.',
  marketRefreshFailed: '최신 정보를 불러오지 못했습니다. 표시된 값은 마지막으로 불러온 것입니다.',
  marketRecentFills: '최근 체결',
  marketFillsEmpty: '아직 체결이 없습니다.',
  marketMyPosition: '내 포지션',
  marketMyPositionEmpty: '아직 이 시장에 참여하지 않았습니다.',
  // 상세의 배치 틀 (#122, ADR-0067). 배경은 시장의 설명(description)이다. 나머지는 내용을 아직
  // 만들 수 없어 제목과 comingSoon('준비 중입니다.')으로 보이는 자리다(ADR-0061 결정 3의 #122 행):
  // 호가창(#179), 내 거래(#121), 내 대기 주문(#123), 공개 판정 기록(#24). 자리의 제목은 그 결정의
  // 글 그대로다(오너 결정 2026-10-17). 내 거래와 내 대기 주문은 로그인한 본인에게만 보인다
  // (ADR-0061 결정 1의 18).
  marketBackground: '배경',
  marketOrderBook: '호가창',
  marketMyTrades: '내 거래',
  marketMyOpenOrders: '내 대기 주문',
  marketJudgingRecord: '공개 판정 기록',
  // 토론 (#47, ADR-0075): 이 시장의 근거 글을 시장 줄을 뺀 커뮤니티 목록의 카드로 최신순으로, 상세
  // 안에서 모두(20개씩 더 보기), 글 수와 함께(ADR-0069 결정 4 #47). 모든 공개 상태가 글을 받으므로
  // (#45-6) 글쓰기 진입(copy.communityWrite '글쓰기')은 늘 있다. 글 수는 목록이 보이는 글의 수다
  // (지우거나 숨긴 글은 세지 않는다) — 글 화면의 '댓글 N'과 같은 꼴. 빈 토론의 글은 오너가 그대로
  // 두었다(오너 결정 2026-10-20).
  marketDiscussion: '토론',
  marketDiscussionCount: '글',
  marketDiscussionEmpty: '아직 이 시장의 글이 없습니다. 첫 글을 써 보세요.',
  // 관련 시장 (#65, ADR-0068): 토론 뒤, 운영자가 이 시장과 연결한 시장의 카드(홈의 카드 그대로, 추천
  // 순). 보일 시장이 없으면 섹션을 두고 이 안내를 보인다(ADR-0061 결정 1의 19). 연결은 있어도 보일
  // 상태(진행 중·거래 마감·판정 완료·정산 완료)의 시장이 없을 때도 같은 글이라 '연결된'을 붙이지 않는다.
  marketRelated: '관련 시장',
  marketRelatedEmpty: '관련 시장이 없습니다.',
  // 비로그인 방문자에게 개인 영역(내 포지션·내 대기 주문·내 거래) 대신 그 자리에 하나만 보이는
  // 로그인 안내(오너 결정 2026-10-17, '로그인 안내 하나'). 버튼은 copy.login이고 이 상세로 돌아온다.
  marketPersonalSignedOut: '로그인하면 이 시장의 내 포지션·대기 주문·거래를 볼 수 있습니다.',
  // 모바일의 호가·거래 내역 전환(N02 §4). 거래 내역은 시장의 최근 체결과 내 거래다(ADR-0061 결정 1의
  // 16). 첫 것은 전환 묶음의 이름이고 화면 낭독기에만 들린다. 두 선택지는 N02 §4의 이름 '호가'·'거래
  // 내역'이고, 호가 판의 자리 제목(marketOrderBook '호가창')과 따로 둔다.
  marketDetailViewLabel: '호가와 거래 내역 보기',
  marketDetailViewBook: '호가',
  marketTradeHistory: '거래 내역',
  // 모바일 주문 시트(ADR-0061 결정 3의 #122 행). 진입점 'YES 매수'·'NO 매수'는 copy.yes·copy.no와
  // copy.buy를 잇고(lib/market-detail.ts) 가격을 붙이지 않는다. 시트 안은 회원에게는 주문 패널(#66)
  // 전까지 tradePreparing('거래 준비 중')이고, 비로그인 방문자에게는 아래의 로그인 안내와 copy.login
  // 버튼이다(N02 §2 주문은 로그인 뒤, 오너 결정 2026-10-17). 닫는 단추는 copy.close다.
  orderSheetSignedOut: '거래는 로그인한 뒤에 할 수 있습니다.',
  // 관심 시장 (#89, ADR-0064): 상세 머리의 토글 하나. 라벨은 상태와 상관없이 같고, 등록했는지는
  // 버튼의 눌림(aria-pressed)과 채운 별이 말한다. 로그인하지 않았으면 누를 때 로그인으로 가고,
  // 돌아와서 다시 눌러야 등록된다(ADR-0061 결정 3).
  watchToggle: '관심 등록',
  watchAddFailed: '관심 등록을 하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  watchRemoveFailed: '관심 해제를 하지 못했습니다. 잠시 후 다시 시도해 주세요.',

  // 상태별 안내 (PLAN 11.3). 색과 배지는 MARKET_STATUS_LABEL/PALETTE가 맡고, 이 문구는
  // 그 아래에서 "지금 무엇을 할 수 있는지"를 말한다.
  marketClosedNotice: '마감된 시장입니다. 더 이상 거래할 수 없습니다.',
  marketResolvedNotice: '결과가 판정되었습니다. 정산을 진행하고 있습니다.',
  marketSettledNotice: '정산이 끝난 시장입니다.',
  // 원금 환불을 약속하지 않는다(N03 §6). 무효 지급 방식은 #126이 정한다.
  marketVoidedNotice: '무효 처리된 시장입니다.',

  // 규칙 섹션 (PLAN 11.1의 Kalshi 원칙: 상세에서 접지 않는다). 이름은 기획의 '규칙'·'출처'
  // (N02 §4, N03 §8, 오너 결정 #14).
  rulesSectionTitle: '규칙',
  rulesSource: '출처',
  rulesCloseAt: '마감',
  rulesNone: '따로 지정된 출처가 없습니다.',

  // 시장가격 추이 차트. 값의 이름은 '확률'이 아니라 시장가격이다(N02 §5). 표기 단위 %는 #60.
  chartLabel: '시장가격 추이',
  chartRangeLabel: '기간 선택',
  chartRangeDay: '1일',
  chartRangeWeek: '1주',
  chartRangeAll: '전체',
  chartTruncated: '최근 구간만 표시하고 있습니다.',
  // 스크린 리더용 표의 캡션과 두 열 머리글. 한 쌍으로 읽히므로 차트 라벨 옆에 둔다.
  // 차트의 접근 가능한 이름이 되는 한 문장('시작 61%, 최고 66%, 최저 60%, 현재 63%').
  chartSummaryStart: '시작',
  chartSummaryHigh: '최고',
  chartSummaryLow: '최저',
  chartSummaryCurrent: '현재',
  chartTableCaption: '시각별 시장가격',
  chartTime: '시각',
  chartValue: '시장가격',
  probabilityChange: '시장가격 변화',

  // 포지션 한 줄 (상세의 내 포지션과 MY 목록이 같이 쓴다)
  positionQty: '보유 수량',
  positionAvgPrice: '평단',
  positionCurrentPrice: '현재가',
  positionValue: '평가 금액',
  positionPnl: '평가손익',
  positionRealizedPnl: '실현 손익',

  // 주문 이력 한 줄. 수량·평균가는 체결 쪽 라벨(fillQty/fillAvgPrice)을 그대로 쓴다.
  orderStatus: '상태',
  orderAmount: '금액',
  orderCreatedAt: '주문 시각',
  orderStatusOpen: '대기',
  orderStatusPartiallyFilled: '부분 체결',
  orderStatusFilled: '체결 완료',
  orderStatusCancelled: '취소됨',
  orderStatusRejected: '거절됨',

  // 옛 포트폴리오(PLAN 11.3)의 잔고 요약·목록. #16이 MY 요약과 보유 계약·대기 주문·거래·정산 이력
  // 탭으로 옮겼다. 합계는 행 라벨과 헷갈리지 않도록 '총'을 붙인다.
  portfolioBalance: '잔고 요약',
  portfolioValue: '총 평가 금액',
  portfolioUnrealizedPnl: '총 평가손익',
  portfolioRealizedPnl: '총 실현 손익',
  portfolioPositionsEmpty: '아직 보유한 포지션이 없습니다.',
  portfolioSettled: '정산 이력',
  portfolioSettledEmpty: '아직 정산된 포지션이 없습니다.',
  portfolioOrders: '주문 이력',
  // 옛 주문 이력이 둘로 나뉘었다(대기·부분 체결은 대기 주문, 나머지는 거래·정산 이력). 빈 목록 문구도
  // 제 쪽만 말하고, 거래·정산 이력 쪽은 상황별 둘이다(오너 결정 2026-10-13): 주문이 아예 없으면 '아직 주문
  // 내역이 없습니다.', 대기 주문만 있으면 '끝난 주문이 없습니다.'와 '대기 중인 주문은 [대기 주문]에서 볼 수
  // 있습니다.'(가운데는 대기 주문 탭으로 가는 링크, myOrders). 대기 주문만 있는 계정에 '주문 내역이 없다'고
  // 하지 않는다.
  portfolioPendingOrdersEmpty: '대기 중인 주문이 없습니다.',
  portfolioOrdersEmpty: '아직 주문 내역이 없습니다.',
  portfolioOrderHistoryEmpty: '끝난 주문이 없습니다.',
  portfolioPendingOrdersHintBefore: '대기 중인 주문은',
  portfolioPendingOrdersHintAfter: '에서 볼 수 있습니다.',
  /**
   * Shown when the session ends while a private screen is still mounted — never a load failure,
   * because nothing failed to load. The reader is told what actually happened and given the way
   * back to the same screen.
   */
  portfolioSignedOut: '로그인이 풀렸습니다. 다시 로그인하면 이어서 볼 수 있습니다.',

  // 최상위 세 영역(N02 §2, #16): 데스크톱 헤더 1단과 모바일 하단 탭이 같은 이름으로 보인다.
  // MY는 로그인 뒤에만 보인다. 헤더 2단(전체·상위 카테고리)은 시장 탐색에서만 보인다.
  navExplore: '시장 탐색',
  navCommunity: '커뮤니티',
  navMy: 'MY',
  navPrimary: '주 메뉴',
  navMenu: '메뉴',

  // --- MY (#16, 오너 결정 2026-10-13) ---
  // 첫 화면은 요약(/my), 탭은 N02 §8에 관심 시장을 더하고 알림·설정을 둘로 나눈 여덟이다.
  myTitle: 'MY',
  myMenu: 'MY 메뉴',
  myPositions: '보유 계약',
  myOrders: '대기 주문',
  myHistory: '거래·정산 이력',
  myWallet: '지갑',
  myPosts: '내 글',
  myWatchlist: '관심 시장',
  myNotifications: '알림',
  mySettings: '설정',
  myViewAll: '전체 보기',
  // 관심 시장 탭(#89): 최근 등록 순의 시장 카드. 끝난 시장도 해제할 때까지 상태와 함께 남는다.
  watchlistEmpty: `아직 관심 시장이 없습니다. ${WATCHLIST_HOW_TO_ADD}`,

  // --- community (#46, ADR-0073) ---
  // 근거 글(N05 §2)과 그것을 모은 커뮤니티 목록. 글 하나는 시장 하나에 달리고(#45-1), 목록은 최신순
  // 하나에 시장·카테고리 필터와 제목·본문 검색이 있다(#45-7). 누구나 읽고 온보딩을 마친 계정이 쓴다.
  // 카드의 댓글 수는 #48이(아래 commentsHeading), 좋아요 수는 #49가(아래 likeToggle) 더했다.
  communityTitle: '커뮤니티',
  communityWrite: '글쓰기',
  communityListLabel: '근거 글 목록',
  communityFilterMarket: '시장',
  communityFilterMarketPick: '시장 고르기',
  communityFilterMarketClear: '시장 필터 해제',
  communityFilterMarketUnknown: '고른 시장',
  communityCategory: '카테고리',
  communityCategoryAll: '모든 카테고리',
  communitySearchLabel: '글 검색',
  communitySearchPlaceholder: '제목·본문에서 찾기',
  communitySearchSubmit: '검색',
  communityEmpty: '아직 글이 없습니다. 시장을 골라 첫 글을 써 보세요.',
  communityEmptyFiltered: '조건에 맞는 글이 없습니다.',
  // 작성자 표기(#37-3·#37-6·#45-9): 지금 닉네임과 작은 원형 이미지(없으면 닉네임 첫 글자), 관리자
  // 계정에는 '운영자'(운영 권한만 뜻한다). 탈퇴한 작성자(#140)는 링크 없이 이 이름만.
  postAuthorAdmin: '운영자',
  postAuthorFormer: '탈퇴한 사용자',
  postEdited: '수정됨',
  postImageAlt: '글에 넣은 이미지',
  postThumbnailAlt: '글의 첫 이미지',
  // 자리표시(#45-5): 작성자와 글의 어떤 말도 보이지 않고 시장과 그 아래 댓글만 남는다(#48).
  postDeletedPlaceholder: '삭제된 글입니다.',
  postHiddenPlaceholder: '운영 정책에 따라 숨긴 글입니다.',
  postNotFound: '없거나 삭제된 글입니다.',
  postMarketHeading: '이 글의 시장',
  postMarketPosts: '이 시장의 글 더 보기',
  postBackToCommunity: '커뮤니티로',
  postEdit: '수정',
  postDelete: '삭제',
  postDeleteTitle: '글을 삭제합니다',
  postDeleteBody: '삭제한 글은 되살릴 수 없습니다. 계속할까요?',
  postDeleteConfirm: '삭제하기',
  postDeletedToast: '글을 삭제했습니다.',
  // 쓰기·수정 화면. 시장은 쓸 때 한 번 고르고 바꿀 수 없다(#45-4). 확률을 받는 칸은 없다(N05 §2).
  postWriteTitle: '글쓰기',
  postEditTitle: '글 수정',
  postWriteMarketLabel: '시장',
  postWriteMarketHint: '글은 고른 시장에 달리고, 올린 뒤에는 시장을 바꿀 수 없습니다.',
  postWriteMarketChange: '다른 시장 고르기',
  // 주소의 시장을 읽지 못했을 때(시장이 없다는 답이 아니라 API에 닿지 못하거나 서버 오류 — 그 시장의 글
  // 양식이 이미 있으면 그대로 두고 이 문장은 양식이 아직 없을 때만, '다시 시도'와 함께).
  postWriteMarketLoadError: '시장을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
  postWriteTitleLabel: '제목 (선택)',
  postWriteTitlePlaceholder: '제목 없이 올려도 됩니다',
  postWriteBodyLabel: '본문',
  postWriteBodyPlaceholder: '근거와 출처를 적어 주세요. 링크와 이미지를 넣을 수 있습니다.',
  postWriteLength: '자',
  postWriteImages: '이미지',
  postWriteImagesUnit: '장',
  postWriteSubmit: '올리기',
  postEditSubmit: '저장',
  postWriteSignedOut: '글을 쓰려면 로그인해 주세요.',
  postEditNotYours: '내가 쓴 글만 고칠 수 있습니다.',
  postWriteUploading: '이미지를 올리는 중',
  // 쓰거나 고치던 글을 두고 떠날 때 묻는 말: 묻는 것은 오너 결정 2026-10-19, 문장은 오너가 승인했다(2026-10-20,
  // ADR-0073). 링크(다른 사이트로 가는 것도)·뒤로·앞으로 가기·머리의 검색에서. 탭을 닫거나 새로 고치거나 주소를
  // 입력해 떠날 때는 브라우저가 자기 문구로 묻는다. 온보딩 게이트가 남은 단계로 보낼 때는 묻지 않는다(글은 남는다).
  postLeaveConfirm: '쓰던 내용이 사라집니다. 나갈까요?',
  // 온보딩 게이트가 남은 단계로 보낼 때 이 탭에 잠시(1시간) 둔 쓰던 글을, 단계를 마치고 돌아온 같은 화면에서
  // 되살렸을 때(오너 결정 2026-10-20, ADR-0073). 버리면 화면이 처음 보인 내용(새 글은 빈 양식, 수정은 저장된 글)으로
  // 돌아간다. 버리기는 언제나 먼저 묻고(postDraftDiscard가 그 확인 창의 제목, 단추는 '취소'와 postDraftDiscardConfirm),
  // 버린 뒤에는 postDraftDiscarded를 다른 완료처럼 토스트로 화면에 보이고 화면 읽기 프로그램에는 토스트의 알림
  // 영역이 한 번 읽는다(오너 결정 2026-10-20 3차 답 3·5 — 묻는 문장과 알리는 문장은 오너가 준 것, 창의 제목과
  // 단추는 오너가 그대로 두었다).
  postDraftRestored: '쓰던 내용을 되살렸습니다.',
  postDraftDiscard: '되살린 내용 버리기',
  postDraftDiscardQuestion: '되살린 내용을 버릴까요? 그 뒤에 쓴 내용도 사라집니다.',
  postDraftDiscardConfirm: '버리기',
  postDraftDiscarded: '되살린 내용을 버렸습니다.',
  // 시장 고르기: 공개 상태의 모든 시장(진행 중·거래 마감·판정 완료·정산 완료·무효, #45-6)을 제목으로 찾는다.
  marketPickerLabel: '시장 찾기',
  marketPickerPlaceholder: '시장 제목의 일부',
  marketPickerSubmit: '찾기',
  marketPickerPrompt: '글을 쓸 시장을 제목으로 찾아 고르세요.',
  marketPickerFilterPrompt: '글을 볼 시장을 제목으로 찾아 고르세요.',
  marketPickerEmpty: '제목에 이 글자가 들어간 시장이 없습니다.',
  marketPickerPick: '고르기',
  // 편집기 도구 막대(서식은 #45-3의 허용 목록뿐이다).
  editorToolbar: '서식',
  editorBold: '굵게',
  editorItalic: '기울임',
  editorStrike: '취소선',
  editorCode: '코드',
  editorHeading: '제목',
  editorParagraph: '본문 글자',
  editorBulletList: '글머리 기호 목록',
  editorOrderedList: '번호 목록',
  editorBlockquote: '인용',
  editorCodeBlock: '코드 블록',
  editorHorizontalRule: '구분선',
  editorLink: '링크',
  editorLinkPrompt: '링크 주소(http 또는 https)',
  // 넣지 못한 링크: 서버가 지울 링크는 편집기도 넣지 않는다(http·https, 사용자 정보 없음, 2,048자까지).
  editorLinkInvalid:
    '넣을 수 없는 링크입니다. 사용자 정보가 없는 http·https 주소를 2,048자까지 넣을 수 있습니다.',
  editorLinkApply: '넣기',
  editorUnlink: '링크 해제',
  editorImage: '이미지 넣기',
  editorTable: '표 넣기',
  editorTableAddRow: '행 추가',
  editorTableAddColumn: '열 추가',
  editorTableDeleteRow: '행 삭제',
  editorTableDeleteColumn: '열 삭제',
  editorTableDelete: '표 삭제',
  editorColor: '글자 색',
  editorColorNone: '기본 색',
  editorColorRed: '빨강',
  editorColorOrange: '주황',
  editorColorGreen: '초록',
  editorColorBlue: '파랑',
  editorColorPurple: '보라',
  editorColorGray: '회색',
  editorUndo: '실행 취소',
  editorRedo: '다시 실행',
  // 글을 올리거나 고치거나 지우지 못했을 때. 규칙은 서버가 판단하고 편집기는 같은 방식으로 미리 센다.
  errPostTitle: '제목은 100자 이하의 한 줄로 입력해 주세요.',
  errPostBodyEmpty: '본문을 입력해 주세요.',
  errPostBodyTooLong: '본문은 서식을 뺀 5,000자 이하로 입력해 주세요.',
  errPostTooManyImages: '이미지는 글마다 10장까지 넣을 수 있습니다.',
  // 쓸 수 없는 이미지: 올린 지 오래되어 지워졌거나, 다른 글이 가져갔거나, 내 업로드가 아니다.
  // 편집기는 그 이미지에 테두리를 그린다.
  errPostImageUnusable:
    '다시 넣어야 하는 이미지가 있습니다. 테두리로 표시한 이미지를 지우고 다시 넣어 주세요.',
  errPostInvalid: '입력한 내용을 확인해 주세요.',
  errPostMarketUnavailable: '이 시장에는 글을 쓸 수 없습니다.',
  // 고치는 사이 다른 탭에서 지운 글의 수정 화면이 쓰던 제목·본문을 고칠 수 없게 남길 때 그 위의 까닭도 이 문장이고,
  // 닫는 단추는 copy.close다(오너 결정 2026-10-24, ADR-0073 9-52 — #48의 남긴 댓글 글자와 같은 꼴).
  errPostGone: '없거나 삭제된 글입니다.',
  errPostNotYours: '다른 사람의 글은 고치거나 삭제할 수 없습니다.',
  // 숨긴 글(#45-5): 작성자는 MY '내 글'의 그 항목('숨김' 줄 옆의 '삭제')에서 지운다(오너 결정 2026-10-22,
  // ADR-0080). 이 문장은 숨긴 글의 수정 주소를 연 누구에게나 같아(공개 답에 작성자가 없다) 그 길을 말하지
  // 않는다 — 오너가 이 문장 그대로 두라고 답했다(오너 결정 2026-10-22 2차 답 1, ADR-0080 7-17).
  errPostNotEditable: '운영 정책에 따라 숨긴 글은 고칠 수 없습니다.',
  // 쓰기·수정·이미지 올리기 모두에, 처음 가입한 계정과 약관 개정에 다시 동의해야 하는 계정 모두에 맞는 말.
  // 자기 글 삭제는 로그인만 본다(오너 결정 2026-10-19).
  errPostOnboarding: '약관 동의 등 남은 절차를 마친 뒤에 할 수 있습니다.',
  errImageType: 'JPEG·PNG·WebP·GIF 이미지만 넣을 수 있습니다.',
  errImageSize: '이미지는 한 장에 5MB까지 넣을 수 있습니다.',
  // 한 프레임이 너무 크거나(`pixels`) 모든 프레임을 더해 너무 크면(`frames`) — 둘에 같은 문장(오너 결정 2026-10-19).
  // 긴 변이 짧은 변의 32배를 넘는 아주 가는 이미지도 `pixels`라 이 문장이다(오너 결정 2026-10-21 (2차) 답 1).
  // PNG가 그 종류(채널·비트·인터레이스)마다 잰 한 프레임의 한도를 넘어도 `pixels`라 이 문장이다(오너 결정 2026-10-21 (2차) 답 4).
  // 변환 전체로 잰 한도 — 움직이는 WebP(한 장면은 `pixels`, 모든 장면은 `frames`), 움직이는 GIF의 한 장면,
  // 성분이 넷(CMYK)인 점진적 JPEG — 를 넘어도 이 문장이다(Codex의 세 번째 리뷰, #219). 알파가 있는 정지 WebP는
  // 거절하지 않고 줄여 받는다(오너 결정 2026-10-22 답 1).
  errImageTooLarge: '이미지가 너무 크거나 프레임이 너무 많습니다.',
  errImageUnreadable: '이미지를 읽을 수 없습니다. 다른 파일을 골라 주세요.',
  errImageEmpty: '빈 파일입니다. 다른 파일을 골라 주세요.',
  errImageUpload: '이미지를 올리지 못했습니다. 다시 시도해 주세요.',

  // --- 운영 공지 (#138, ADR-0077) ---
  // 커뮤니티 목록 위의 고정 영역(최대 3개, #45-8)과 공지 화면. 작성자는 '운영팀'이고 운영자의 닉네임은
  // 보이지 않는다. 공지는 읽기만 한다(댓글·좋아요·신고 없음). 고치면 '수정됨'(copy.postEdited)이 붙는다.
  noticeBadge: '공지',
  noticeAuthor: '운영팀',
  noticesLabel: '고정 공지',
  noticesLoadFailed: '공지를 불러오지 못했습니다.',
  noticeNotFound: '없는 공지입니다.',

  // --- comments (#48, ADR-0074) ---
  // 근거 글 아래의 댓글과 그 아래의 답글(대댓글). 두 층뿐이라 답글에 답하면 같은 댓글 아래 답글이 된다
  // (#45-2). 모두 오래된 것부터(작성 순). 평문이고 http·https 주소는 링크로 보이며 1,000자, 줄바꿈은
  // 그대로다(#45-3). 누구나 읽고 온보딩을 마친 계정이 쓴다. 댓글 수는 지우거나 숨기지 않은 댓글과
  // 답글의 수일 뿐이다(ADR-0074).
  commentsHeading: '댓글',
  commentsEmpty: '아직 댓글이 없습니다.',
  commentsRepliesLabel: '답글 목록',
  // 댓글마다 답글은 처음 50개만 보이고 이 단추가 50개씩 더 읽는다(오너 결정 2026-10-21, ADR-0074). 누른
  // 읽기가 실패하면 단추 위에 댓글 목록의 읽기 실패 문구가 보이고 이 단추로 다시 읽는다. 이 브랜치에서는 이
  // 단추만 그렇다 — 댓글 목록의 '더 보기'는 #47이 같은 안내를 붙인다. 단계를 지나 되살린 쓰던 수정을 찾는
  // 읽기는 실패하거나 다시 읽기가 쥐는 300개(처음 50개와 다섯 페이지) 안에서 찾지 못하면 그 글자를 까닭과
  // 함께 따로 보인다(오너 결정 2026-10-21 (2차) 답 2, 2026-10-22 답 5·(2차) 답 1). 그렇게 따로 보이는 수정의
  // 글자는 이 단추가 — 새 답글의 이어 읽기, 댓글 페이지의 다시 읽기, 그 찾기의 읽기도 — 그 답글을 300개
  // 안으로 읽어 오면 그 답글의 수정 상자에 든다(2026-10-22 (2차) 답 2·(3차) 답 1).
  commentRepliesMore: '답글 더 보기',
  commentWriteLabel: '댓글 쓰기',
  commentWritePlaceholder: '댓글을 입력해 주세요. http·https 주소는 링크로 보입니다.',
  commentReplyLabel: '답글 쓰기',
  commentReplyPlaceholder: '답글을 입력해 주세요.',
  commentSubmit: '올리기',
  commentLengthUnit: '자',
  commentReply: '답글',
  commentEdit: '수정',
  commentEditLabel: '댓글 수정',
  commentEditSave: '저장',
  commentDelete: '삭제',
  commentDeleteTitle: '댓글을 삭제합니다',
  commentDeleteBody: '삭제한 댓글은 되살릴 수 없습니다. 계속할까요?',
  commentDeleteConfirm: '삭제하기',
  commentDeletedToast: '댓글을 삭제했습니다.',
  commentSignedOut: '댓글을 쓰려면 로그인해 주세요.',
  // 자리표시(#45-5): 작성자와 댓글의 어떤 말도 보이지 않는다. 글의 자리표시와 같은 말이다.
  commentDeletedPlaceholder: '삭제된 글입니다.',
  commentHiddenPlaceholder: '운영 정책에 따라 숨긴 글입니다.',
  // 숨기거나 지운 글은 새 댓글을, 숨긴 댓글은 새 답글을 받지 않는다(#45-5). 지워 자리표시로 남은 댓글도
  // 새 답글을 받지 않는다(오너 결정 2026-10-20, ADR-0074 7-4).
  commentClosedPostHidden: '운영 정책에 따라 숨긴 글에는 댓글을 달 수 없습니다.',
  commentClosedPostDeleted: '삭제된 글에는 댓글을 달 수 없습니다.',
  errCommentParentHidden: '운영 정책에 따라 숨긴 댓글에는 답글을 달 수 없습니다.',
  errCommentParentDeleted: '삭제된 댓글에는 답글을 달 수 없습니다.',
  errCommentParentGone: '답글을 달 댓글이 없거나 삭제되었습니다.',
  errCommentNotAllowed: '이 글이나 댓글에는 더 달 수 없습니다.',
  // 숨긴 댓글(#45-5): 작성자는 MY '내 글'의 댓글 탭에서 지운다(오너 결정 2026-10-22, ADR-0080). 이 거절은
  // 그 길을 말하지 않는다 — 글과 같은 답이다(오너 결정 2026-10-22 2차 답 1, ADR-0080 7-17).
  errCommentNotEditable: '운영 정책에 따라 숨긴 댓글은 고칠 수 없습니다.',
  errCommentGone: '없거나 삭제된 댓글입니다.',
  // 고치던 답글이 읽은 답글 사이에 없고 그 뒤에 아직 읽지 않은 답글이 있을 때 — 다시 읽기가 스레드를 다섯
  // 페이지까지만 이어 읽어(오너 결정 2026-10-21 (2차) 답 1) 그 밖에 있을 수도, 지워졌을 수도 있어 둘 다 맞는
  // 말이다. 그 수정 상자의 글자를 따로 남길 때(ADR-0074 7-30)와, 단계를 지나 되살린 쓰던 수정을 찾는 읽기가
  // 다시 읽기가 쥐는 300개 안에서 그 답글을 찾지 못해 그 글자를 따로 보일 때(오너 결정 2026-10-22 답 5·
  // (2차) 답 1)의 까닭. 문장은 오너가 주었다(오너 결정 2026-10-22 답 3). 어느 읽기든 그 답글을 300개 안으로
  // 읽어 오면 그 글자는 이 문장과 함께 남지 않고 그 답글의 수정 상자에 든다(2026-10-22 (2차) 답 2·(3차)
  // 답 1). 300개 밖으로 읽어 오면 errCommentEditNotReopened로, 그 스레드를 끝까지 읽어도 그 답글이 없으면
  // errCommentGone으로 바뀐다(ADR-0074 7-30).
  errCommentEditNotRead:
    '고치던 답글을 목록에서 찾지 못했습니다. 지워졌거나 아직 불러오지 않은 답글입니다.',
  // 고치던 답글이 화면에 있는데 다시 읽기가 쥐는 300개(처음 50개와 다섯 페이지) 밖이라 그 수정 상자를 열지
  // 않을 때 — 돌아올 때의 다시 읽기가 들어오지 않아 300개 밖까지 쥔 화면에 되살린 쓰던 수정(오너 결정
  // 2026-10-22 (3차) 답 3), 그리고 따로 보이던 수정의 글자의 답글을 어느 읽기가 300개 밖으로 읽어 왔을 때
  // (3차 답 1, ADR-0074 7-30) — 그 답글 아래 따로 보이는 글자의 까닭. 문장은 오너가 주었다(3차 답 3).
  // 앞선 답글이 지워져 그 답글이 300개 안으로 오면(다시 읽기든, 독자가 앞선 제 답글을 지운 것이든) 그 글자는
  // 그 수정 상자에 든다. 그 수정 상자가 이미 열려 있으면 그 상자는 제 글자를 지키고 이 글자는 이 문장과 함께
  // 남는다(ADR-0074 7-30의 (f)).
  errCommentEditNotReopened: '고치던 답글을 다시 열지 못했습니다. 쓰던 내용을 여기 남겨 둡니다.',
  errCommentNotYours: '다른 사람의 댓글은 고치거나 삭제할 수 없습니다.',
  errCommentBodyEmpty: '댓글을 입력해 주세요.',
  errCommentBodyTooLong: '댓글은 1,000자 이하로 입력해 주세요.',
  // 쓰던 댓글·답글·수정을 두고 떠날 때는 글과 같은 postLeaveConfirm으로 묻는다(오너 결정 2026-10-20 답 1).
  // 재동의로 남은 단계로 갈 때 이 탭에 1시간 둔 쓰던 댓글·답글·수정을, 단계를 마치고 돌아온 글 화면이 그
  // 상자에 되살렸을 때 — 토스트로 한 번, 되살린 상자마다 그 아래에도(오너 결정 2026-10-20 답 2, 글의
  // postDraftRestored와 같은 말). 따로 보이던 수정의 글자가 어느 읽기로든 300개 안으로 읽어 온 그 답글의
  // 수정 상자에 들 때도 같다(오너 결정 2026-10-22 (2차) 답 2·(3차) 답 1) — 그 상자가 그 글자를 받았을 때만:
  // 이미 열린 수정 상자가 제 글자를 지키면 알리지 않는다(ADR-0074 7-30의 (f)).
  commentDraftRestored: '쓰던 내용을 되살렸습니다.',
  // 쓰기가 거절되고 그 상자가 다시 읽은 화면에 없을 때(또는 되살린 쓰던 내용을 받을 상자가 없을 때), 거절의
  // 까닭과 함께 닫을 때까지 보이는 쓰던 글자의 읽기 전용 칸 이름(오너 결정 2026-10-20 답 4). 닫는 단추는 copy.close.
  // 보내지 않은 상자가 다시 읽기로 사라질 때와(2026-10-21 답 2) 글이 모든 화면에서 빠질 때(답 1)도 같은 칸이다.
  commentHeldText: '쓰던 내용',
  // 답글·수정 상자의 '취소'를 누를 때 글자가 처음과 다르면(되살린 상자 포함) 먼저 묻는 확인 창(오너 결정
  // 2026-10-21 답 3): 창의 제목과 단추는 글의 '되살린 내용 버리기'와 같은 꼴, 묻는 문장은 떠날 때의 문장
  // (postLeaveConfirm)의 앞 절 그대로다. 단추는 '취소'(copy.cancel, 상자를 그대로 둔다)와 commentDiscardConfirm.
  commentDiscardTitle: '쓰던 내용 버리기',
  commentDiscardQuestion: '쓰던 내용이 사라집니다. 버릴까요?',
  commentDiscardConfirm: '버리기',

  // --- 작성 빈도 제한 (#187, ADR-0083) ---
  // 오너가 정한 고정 한도(ADR-0069 결정 2 #45-15, 결정 7, @buddha/shared의 WRITE_LIMITS)다. 계정이 아니라
  // 본인확인한 번호마다 세고, 지운 글도 센다. '하루'는 지난 24시간이다. 거절되면 그 한도의 문장 뒤에 다시 쓸
  // 수 있는 시각을 붙인다(결정 4 #187: «다시 쓸 수 있는 시각을 보인다» — lib/write-limits.ts). 수는 시험이
  // WRITE_LIMITS와 견준다.
  errWriteLimitPosts10m: '근거 글은 10분 동안 3개까지 쓸 수 있습니다.',
  errWriteLimitPosts24h: '근거 글은 24시간 동안 20개까지 쓸 수 있습니다.',
  errWriteLimitComments1m: '댓글과 답글은 합해서 1분 동안 5개까지 쓸 수 있습니다.',
  errWriteLimitComments24h: '댓글과 답글은 합해서 24시간 동안 200개까지 쓸 수 있습니다.',
  errWriteLimitEdits10m: '글과 댓글은 합해서 10분 동안 10번까지 고칠 수 있습니다.',
  errWriteLimitEdits24h: '글과 댓글은 합해서 24시간 동안 50번까지 고칠 수 있습니다.',
  errWriteLimitUploads24h:
    '이미지는 글의 이미지와 프로필 이미지를 합해서 24시간 동안 50장까지 올릴 수 있습니다.',
  // 시각 뒤에 붙는다: '2026. 10. 21. 오후 3:52부터 다시 쓸 수 있습니다.'
  writeLimitRetryWrite: '부터 다시 쓸 수 있습니다.',
  writeLimitRetryEdit: '부터 다시 고칠 수 있습니다.',
  writeLimitRetryUpload: '부터 다시 올릴 수 있습니다.',
  // 거절의 자세한 내용을 읽지 못했을 때(배포가 엇갈린 사이 같은 때).
  errWriteLimited: '쓰기 한도에 닿았습니다. 잠시 뒤에 다시 시도해 주세요.',

  // --- likes (#49, ADR-0076) ---
  // 근거 글과 댓글·답글의 좋아요. 수만 보이고 누가 눌렀는지는 보이지 않으며, 본인은 자기가 눌렀는지를
  // 단추의 눌림으로 본다. 자기 글에도 누를 수 있다. 수는 표시일 뿐 점수나 Coin이 되지 않고 목록의
  // 차례도 바꾸지 않는다(D5). 지우거나 숨긴 글·댓글의 자리표시에는 수도 단추도 없다. 로그인하지 않은
  // 방문자가 누르면 곧바로 로그인 화면으로 가고 이 글로 돌아온다(관심 등록과 같다, 오너 결정
  // 2026-10-20) — 그 자리의 안내 문구는 없다.
  likeToggle: '좋아요',
  likeAddFailed: '좋아요를 누르지 못했습니다. 잠시 후 다시 시도해 주세요.',
  likeRemoveFailed: '좋아요를 취소하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  errLikePostDeleted: '삭제된 글에는 좋아요를 누를 수 없습니다.',
  errLikePostHidden: '운영 정책에 따라 숨긴 글에는 좋아요를 누를 수 없습니다.',
  errLikeCommentDeleted: '삭제된 댓글에는 좋아요를 누를 수 없습니다.',
  errLikeCommentHidden: '운영 정책에 따라 숨긴 댓글에는 좋아요를 누를 수 없습니다.',
  // 취소도 같은 거절이다(ADR-0076 7-6). 누른 좋아요는 그대로 남는다.
  errLikePostDeletedRemove: '삭제된 글의 좋아요는 취소할 수 없습니다.',
  errLikePostHiddenRemove: '운영 정책에 따라 숨긴 글의 좋아요는 취소할 수 없습니다.',
  errLikeCommentDeletedRemove: '삭제된 댓글의 좋아요는 취소할 수 없습니다.',
  errLikeCommentHiddenRemove: '운영 정책에 따라 숨긴 댓글의 좋아요는 취소할 수 없습니다.',
  // 내가 누른 것을 처음 읽지 못해 단추를 누를 수 없을 때, 화면에 글로 한 번 보이는 까닭이고 단추마다의
  // 설명·툴팁이다(ADR-0076 7-15, 오너 결정 2026-10-20).
  likeMineUnavailable: '내가 누른 좋아요를 불러오지 못했습니다.',

  // --- 공개 프로필 (#41, ADR-0078) ---
  // /u/<공개 id>: 누구나 보고 검색 엔진에는 노출하지 않는다(#37-1). 지금 닉네임·이미지(회원이 올린 것,
  // #141 — 없으면 닉네임 첫 글자)·관리자 계정의 '운영자'(postAuthorAdmin, 운영 권한만 뜻한다)·소개(평문, 링크 없음)·고른 관심
  // 카테고리(고르지 않았으면 표시 없음)·가입 연·월('2026년 10월 가입', 누구에게나 한국 시간의 달)과 글·댓글 수, 받은 좋아요 합계
  // (#37-4 — 그 회원이 자기 글·댓글에 스스로 누른 것은 빼고, 수일 뿐이고 점수·순위로 부르지 않는다).
  // 글·댓글 목록은 #51이 채웠다(아래 authored*).
  // 작성자 표기(postAuthor*)의 이름과 이미지가 이 화면의 링크다.
  profileYearUnit: '년',
  profileMonthUnit: '월',
  profileJoined: '가입',
  profileBio: '소개',
  profileInterests: '관심 카테고리',
  profileCountsLabel: '글·댓글 수와 받은 좋아요',
  profilePostCount: '글',
  profileCommentCount: '댓글',
  profileReceivedLikes: '받은 좋아요',
  profilePostsHeading: '글·댓글',
  profileNotFound: '없는 프로필입니다.',
  // 본인이 자기 프로필을 볼 때만(오너 결정, ADR-0069 결정 4 #41: «MY 설정에서 고치기» 링크).
  profileEdit: 'MY 설정에서 고치기',
  // 자기 공개 프로필로 가는 길: MY 요약의 맨 위와 MY 설정의 '프로필' 카드(오너 결정 2026-10-21 답 7).
  viewOwnProfile: '내 공개 프로필 보기',
  // 소개(#37-3): 평문 160자(코드 포인트로 센다, 줄바꿈도 한 자), 줄바꿈은 그대로, 주소는 링크가 되지
  // 않는다. 비우고 저장하면 소개가 없어진다.
  settingsBio: '소개',
  settingsBioHint:
    '공개 프로필에 보입니다. 160자까지 쓸 수 있고, 줄바꿈은 그대로 보이며 주소는 링크가 되지 않습니다. 비우고 저장하면 소개가 없어집니다.',
  // 프로필은 로그인하지 않은 방문자도 본다(#37-1): '다른 회원에게'가 아니라 공개 프로필이다.
  bioPlaceholder: '공개 프로필에 보일 소개를 적어 주세요.',
  bioLengthUnit: '자',
  bioSaved: '소개를 저장했습니다.',
  bioCleared: '소개를 비웠습니다.',
  errBioTooLong: '소개는 160자 이하로 입력해 주세요.',
  // 관심 카테고리(#37-5, #57-7): 온보딩에서 고른 것을 여기서 바꾼다. 상위·하위 모두, 몇 개든, 모두 빼도 된다.
  settingsInterests: '관심 카테고리',
  settingsInterestsHint:
    '고른 카테고리는 공개 프로필에 보입니다. 상위·하위 카테고리를 몇 개든 고를 수 있고, 모두 빼도 됩니다.',
  interestsSaved: '관심 카테고리를 저장했습니다.',
  // 재동의만 남은 계정이 MY 설정에서 새 소개·더한 카테고리(또는 닉네임 변경·마케팅 정보 수신)로 남은
  // 단계에 갔다 오면 쓰던 소개·고른 카테고리·쓰던 닉네임을 그 카드에 되살렸을 때 — 토스트로 한 번(오너 결정
  // 2026-10-22 답 3·2026-10-22 (2차) 답 2, 글·댓글의 postDraftRestored·commentDraftRestored와 같은 말).
  profileDraftRestored: '쓰던 내용을 되살렸습니다.',
  // 프로필 이미지(#141, ADR-0079; #37-6): MY 설정에서 직접 올린다(소셜 로그인 사진은 쓰지 않는다).
  // JPEG·PNG·WebP, 5MB. 서버가 가운데를 정사각형(512px까지 줄이고, 작은 것은 제 크기 — 오너 결정
  // 2026-10-22)으로 잘라 촬영 위치·기기 정보 같은 부가 정보를 지우고 둔다. 공개 프로필과 글·댓글의
  // 작성자 표기에 보이고, 없으면 닉네임의 첫 글자다. 바꾸거나 삭제한 이전 이미지는 곧바로 지운다
  // (결정 4 #141) — 삭제는 되살릴 수 없다고 한 번 묻는다.
  settingsProfileImage: '프로필 이미지',
  settingsProfileImageHint:
    '공개 프로필과 글·댓글의 작성자 표기에 보입니다. JPEG·PNG·WebP 이미지를 5MB까지 올릴 수 있고, 가운데를 정사각형으로 잘라 촬영 위치 같은 부가 정보를 지운 뒤 저장합니다. 이미지가 없으면 닉네임의 첫 글자가 보입니다.',
  profileImageUpload: '이미지 올리기',
  profileImageReplace: '이미지 바꾸기',
  profileImageUploading: '올리는 중',
  profileImageSaved: '프로필 이미지를 저장했습니다.',
  profileImageDelete: '이미지 삭제',
  profileImageDeleteTitle: '프로필 이미지를 삭제합니다',
  profileImageDeleteBody: '삭제한 이미지는 되살릴 수 없습니다. 계속할까요?',
  profileImageDeleteConfirm: '삭제하기',
  profileImageDeleted: '프로필 이미지를 삭제했습니다.',
  // 글의 이미지(errImageType·errImageSize)와 형식이 다르다: GIF는 받지 않는다(#37-6).
  errProfileImageType: 'JPEG·PNG·WebP 이미지만 올릴 수 있습니다.',
  errProfileImageSize: '프로필 이미지는 5MB까지 올릴 수 있습니다.',
  errProfileImageDelete: '프로필 이미지를 삭제하지 못했습니다. 다시 시도해 주세요.',

  // --- 작성자별 글·댓글 (#51, ADR-0080) ---
  // 공개 프로필의 '글·댓글'과 MY '내 글': 글과 댓글(대댓글 포함) 두 탭, 최신순, 필터 없음(#37-14, ADR-0069
  // 결정 4 #51). 프로필은 지운 것과 숨긴 것을 빼고, MY는 지운 것만 빼며 숨긴 것에 '숨김'과 사유를 본인에게
  // 보인다(#45-5). 항목마다 그 글 화면과 시장으로 가고, 좋아요 수는 수일 뿐이다(N05 §2).
  authoredTabPosts: '글',
  authoredTabComments: '댓글',
  authoredPostsEmpty: '아직 쓴 글이 없습니다.',
  authoredCommentsEmpty: '아직 쓴 댓글이 없습니다.',
  // 댓글 항목의 종류: 글 화면이 대댓글을 '답글'이라 부른다(commentReply).
  authoredCommentKind: '댓글',
  authoredReplyKind: '답글',
  // 숨긴 것의 표시(본인에게만). 사유는 신고 사유 가운데 하나와 운영자 설명(있으면)이고(오너 결정
  // 2026-10-22), #50의 조치 기록이 남길 때부터 보인다. '숨김' 줄 옆의 '삭제'는 글·댓글 화면의 삭제와
  // 같은 단추·확인 문구(postDelete*·commentDelete*)를 쓰고, 확인 창은 그 문장 위 한 줄에 그 항목(글의
  // 제목이나 본문 첫 줄, 댓글의 첫 줄 — 회원이 쓴 글자라 문구가 아니다)을 말한다(오너 결정 2026-10-22 3차).
  // 사유 아래에 조치·신고 내역으로 가는 링크(myModerationOpen)가 있다 — 이의의 안내와 그 숨김의 이의 기한은
  // 거기에 있다(오너 결정 2026-10-22 답 9, #186).
  authoredHidden: '숨김',
  authoredHiddenReason: '숨김 사유',
  authoredHiddenNote: '운영자 설명',

  // --- 신고 사유 (ADR-0069 결정 2 #45-10) ---
  // 오너가 정한 여덟 가지, 그 차례. 운영자가 숨긴 글·댓글의 사유도 이 가운데 하나다(오너 결정
  // 2026-10-22, ADR-0080). 신고 화면(#50)도 이 이름을 쓴다. 틀린 전망은 신고 사유가 아니다(#45-10).
  reportReasonSpam: '스팸',
  reportReasonHarassment: '괴롭힘',
  reportReasonPersonalInfo: '개인정보 노출',
  reportReasonImpersonation: '사칭',
  reportReasonCollusionManipulation: '공모·조작 유도',
  reportReasonOffTopic: '시장과 무관',
  reportReasonRightsInfringement: '권리 침해',
  reportReasonOther: '기타',
  // 계정 제한(#139, ADR-0069 결정 1 #57-12)만의 사유 둘. 신고 사유는 아니다.
  reportReasonAbnormalTrading: '이상 거래',
  reportReasonMultiAccount: '다계정',

  // --- 신고와 운영 처리 (#50, ADR-0081) ---
  // 신고(ADR-0069 결정 2 #45-10, 결정 3 #37-10, 결정 7): 근거 글·댓글·대댓글과 공개 프로필. 사유는 위의
  // 여덟 가운데 하나이고 '기타'는 설명이 필요하다. 500은 REPORT_DESCRIPTION_MAX_LENGTH, 20·24시간은
  // REPORTS_PER_DAY·REPORT_WINDOW_HOURS와 같아야 한다(lib/moderation.test.ts가 확인한다). 틀린 전망은 신고
  // 사유가 아니라고 신고 화면에서 안내한다(#45-10). 신고만으로는 아무것도 숨기지 않는다(#45-10).
  reportAction: '신고',
  reportPostTitle: '글을 신고합니다',
  reportCommentTitle: '댓글을 신고합니다',
  reportProfileTitle: '프로필을 신고합니다',
  reportNotAReason: '의견이 다르거나 전망이 틀렸다는 것은 신고 사유가 아닙니다.',
  reportProcessNote:
    '운영자가 확인해 처리합니다. 신고한 사람은 신고당한 회원에게 알려지지 않습니다.',
  reportReasonLabel: '신고 사유',
  reportDescriptionLabel: '설명',
  reportDescriptionHint: "'기타'를 고르면 설명이 필요합니다. 500자까지 쓸 수 있습니다.",
  reportDescriptionPlaceholder: '무엇이 문제인지 적어 주세요.',
  reportLengthUnit: '자',
  reportSubmit: '신고하기',
  // 접수 확인(#45-13): 결과는 MY 설정에서 여는 조치·신고 내역에서 본다(알림은 M13).
  reportSubmitted: '신고를 접수했습니다. 처리 결과는 MY 설정의 조치·신고 내역에서 볼 수 있습니다.',
  errReportReasonRequired: '신고 사유를 골라 주세요.',
  errReportDescriptionRequired: "'기타'를 고르면 설명을 적어 주세요.",
  errReportDescriptionTooLong: '설명은 500자 이하로 입력해 주세요.',
  errReportOwn: '내가 쓴 글·댓글과 내 프로필은 신고할 수 없습니다.',
  // 같은 사람이 같은 대상에 낸 신고가 처리 중이다(결정 7: 처리된 뒤에는 다시 신고할 수 있다).
  errReportDuplicate: '이미 신고한 대상입니다. 그 신고가 처리된 뒤에 다시 신고할 수 있습니다.',
  errReportDeleted: '삭제된 글이나 댓글은 신고할 수 없습니다.',
  errReportHidden: '운영 정책에 따라 숨긴 글이나 댓글은 신고할 수 없습니다.',
  // 뒤에 기다릴 시간과 verificationRetryAfter가 붙는다(예: '… 3시간 5분 뒤에 다시 시도해 주세요.').
  errReportLimited: '신고는 24시간 동안 20건까지 할 수 있습니다.',
  errTooManyRequests: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',

  // 조치·신고 내역(ADR-0069 결정 4 #50): MY 아래 별도 화면(탭은 더하지 않고 MY 설정에서 연결). 받은 조치는
  // 종류·사유·기간·이의 방법(#45-13), 낸 신고는 접수와 처리 결과(조치함·기각)다. 신고자와 처리한 운영자는
  // 보이지 않는다. 이의 방법은 '받은 조치' 맨 위의 제재 이의의 안내와 조치마다의 이의 기한이다(아래
  // appealGuidance, #186).
  myModeration: '조치·신고 내역',
  myModerationHint: '운영자가 내 글·댓글이나 프로필에 한 조치와, 내가 한 신고의 처리 결과입니다.',
  myModerationOpen: '조치·신고 내역 보기',
  myModerationActions: '받은 조치',
  myModerationActionsEmpty: '받은 조치가 없습니다.',
  myModerationReports: '내가 한 신고',
  myModerationReportsEmpty: '아직 신고한 것이 없습니다.',
  moderationActionHide: '숨김',
  moderationActionWarning: '경고',
  moderationActionNicknameReset: '닉네임 강제 변경',
  moderationActionBioClear: '소개 비우기',
  moderationActionImageRemove: '프로필 이미지 삭제',
  moderationActionWritingRestriction: '작성 제한',
  moderationActionAccountRestriction: '계정 제한',
  moderationReason: '사유',
  moderationTakenAt: '조치한 때',
  moderationEndsAt: '끝나는 때',
  // 조치 카드의 이의 기한 줄(#186, ADR-0084): 취소되지 않은 조치마다 조치한 때부터 14일(APPEAL_WINDOW_DAYS,
  // 14×24시간) 뒤의 정확한 시각이다(오너 결정 2026-10-22 답 1, 분까지 보인다). 보인 그 분이 끝나면(…:59까지는
  // 기한 안이다, 오너 결정 2026-10-23 답 5) 그 줄은 '이의 기한이 지났습니다.'와 그 기한만이다(답 2). 카드에는 이
  // 줄 말고 이의의 말이 없다(답 4).
  moderationAppealDeadline: '이의 기한',
  moderationAppealDeadlinePassed: '이의 기한이 지났습니다.',
  moderationCancelled: '취소됨',
  moderationCancelledAt: '취소한 때',
  // 제재 이의의 안내(#186, ADR-0084; ADR-0069 결정 2 #45-14): 조치·신고 내역의 '받은 조치' 맨 위에 한 번 —
  // 목록을 읽는 동안·읽지 못했을 때·받은 조치가 없을 때도 — 보인다(오너 결정 2026-10-22 답 4). 경고·제재 띠에는
  // 없다(답 3). 이의는 고객센터 이메일로만 받고 앱에는 접수도 기록도 없다: 어느 조치인지(조치의 종류, 조치한
  // 때, 글이나 댓글이면 카드에 보이는 그 제목이나 첫 줄 — 답 6의 줄에 운영자가 되묻는 글과 같게 대상을 더했다,
  // 오너 결정 2026-10-23 답 1)를 적어 가입한 이메일로(답 6 — 운영자는 그 계정의 지금 이메일에서 발신 인증을
  // 통과한 메일만 받는다, 답 5), 조치마다 한 번·조치한 때부터 14일 안(APPEAL_WINDOW_DAYS — 기한은 카드의 이의 기한
  // 줄), 검토하는 동안 조치는 그대로, 결과는 이메일 회신. 받아들이면 운영자가 조치를 취소하거나 제한을 풀거나
  // 줄이지만(#50·#185·#139) 안내는 결과를 약속하지 않는다. 이메일은 사업자 정보의 고객센터 이메일이다(ADR-0069
  // 결과 3, 오너가 정한다 — 그 전에는 '미정').
  appealGuidance:
    '조치에 대한 이의는 고객센터 이메일({{email}})로 받습니다. 어느 조치인지(조치의 종류, 조치한 때, 글이나 댓글이면 그 제목이나 첫 줄)를 적어 가입한 이메일로 보내 주세요. 조치마다 한 번, 조치한 때부터 14일 안에 보낼 수 있습니다. 검토하는 동안 조치는 그대로 유지되고, 결과는 이메일로 알려 드립니다.',
  // 카카오·네이버가 이메일을 주지 않아 대체 주소(…@noemail.buddha.local)인 계정에게만, 조치·신고 내역의 위 안내
  // 바로 아래에 MY 설정으로 가는 링크와 함께(오너 결정 2026-10-22 (2차) 3, ADR-0084). 운영자는 그 계정의 지금
  // 이메일에서 온 이의만 받는데(답 5) 대체 주소로는 메일을 보낼 수 없다 — 등록은 MY 설정의 '계정' 카드다. 계정의
  // 이메일은 GET /me의 것이고, 그것을 읽기 전이나 읽지 못했을 때는 보이지 않는다.
  appealEmailRequired: '이의를 보내려면 MY 설정에서 이메일을 먼저 등록해 주세요.',
  appealEmailRequiredOpen: 'MY 설정으로 가기',
  // 닉네임 강제 변경에 덧붙이는 줄(오너 결정 2026-10-22 답 3): 취소되지 않았고 강제 변경한 때부터 30일
  // (NICKNAME_HOLD_DAYS)이 지나지 않은 동안만 보인다. 취소되면 그 보류는 본인의 것이라 다시 고를 수 있다(답 2).
  // 옛 닉네임 자체는 보이지 않는다(#37-3).
  moderationNicknameHeld: '이전 닉네임은 30일 동안 다시 쓸 수 없습니다.',
  // 조치가 가리킨 내 글·댓글을 그 뒤 내가 지웠다(MY는 지운 것을 보이지 않는다, #45-5).
  moderationSubjectDeletedPost: '삭제한 글',
  moderationSubjectDeletedComment: '삭제한 댓글',
  moderationSubjectProfile: '내 프로필',
  reportTargetPost: '글',
  reportTargetComment: '댓글',
  reportTargetProfile: '프로필',
  reportStatusPending: '접수',
  reportStatusActioned: '조치함',
  reportStatusDismissed: '기각',
  reportFiledAt: '신고한 때',
  reportResolvedAt: '처리한 때',
  // 작성 제한(#185, ADR-0082; ADR-0069 결정 2 #45-12, 결정 3 #37-9). 진행 중인 제재의 안내 띠(결정 4 #50 —
  // MY 요약과 글쓰기 화면, 그리고 MY 설정)와 막힌 쓰기의 거절이 쓴다. 막는 것은 글·댓글·대댓글 쓰기와 자기
  // 글·댓글 고치기, 공개 프로필 항목(닉네임·소개·이미지·관심 카테고리)의 새 값이다. 내 글·댓글 지우기·좋아요·
  // 신고·관심 등록·읽기와 비공개 설정(시간대)은 그대로다. #50의 조치(숨김·경고·프로필 항목)는 제재가 아니다
  // (#45-11). 띠는 이 제목과 끝나는 때, 조치·신고 내역 링크뿐이다(오너 결정 2026-10-22 저녁, #186 경유: «경고·
  // 제재 띠 → 이의 안내를 빼고 … 끝나는 시각(제한)과 조치·신고 내역 링크만»). 계정 제한(#139)의 문장은 아래
  // restrictionAccountTitle부터다(ADR-0085).
  restrictionWritingTitle: '작성 제한 중입니다.',
  // 끝나는 때: 회원의 시간대로 쓴 시각 뒤에 붙어 '2026. 10. 23. 오후 3:00까지', 운영자가 풀 때까지면
  // '무기한'(#45-12의 기간).
  restrictionUntil: '까지',
  restrictionIndefinite: '무기한',
  // 조치·신고 내역과 관리자 화면의 배지: 취소되지 않았고 끝나는 때가 오지 않은(무기한 포함) 제한.
  restrictionStanding: '진행 중',
  // 조치·신고 내역에서 운영자가 일찍 풀거나 앞당긴(감경) 작성 제한(오너 결정 2026-10-23 답 4: «'조기
  // 해제됨'·'감경됨'과 바뀐 끝, 원래 끝을 보임(사유는 운영자만)»): 배지(마지막 변경의 종류 — 조기 해제는
  // 제한을 끝내므로 그 뒤의 변경은 없다), '끝나는 때'에 바뀐 끝, 그 아래 처음 건 끝(무기한이면 '무기한').
  // 취소된 제한에는 없다('취소됨'과 취소한 때만, 답 10).
  moderationEndLifted: '조기 해제됨',
  moderationEndShortened: '감경됨',
  moderationOriginalEndsAt: '원래 끝나는 때',
  // 거절의 앞 문장(ADR-0078 오너 결정 2026-10-21 답 8 «끝나는 시각과 이의 안내», 그 이의 안내는 오너 결정
  // 2026-10-22 저녁 «끝나는 시각과 조치·신고 내역 링크(기한은 내역에)»): 뒤에 '(…까지).'나 '(무기한).'이 붙고
  // 화면이 그 아래에 조치·신고 내역 링크(myModerationOpen)를 둔다(lib/restriction.ts). 글 이미지 올리기의
  // 거절 토스트(imageUploadToast)만은 이 문장뿐이고 링크가 없다(오너 결정 2026-10-23 답 12 «단추 없이 끝나는
  // 때만»). 이의의 문장과 기한은 거절에 없다 — 조치·신고 내역에 있다.
  errRestrictedWriting: '작성 제한 중에는 글·댓글을 쓰거나 고칠 수 없습니다',
  errRestrictedProfile: '작성 제한 중에는 공개 프로필을 새 값으로 바꿀 수 없습니다',
  errRestrictedNickname: '작성 제한 중에는 닉네임을 바꿀 수 없습니다',
  // 소개·이미지·관심 카테고리는 제한 중에도 비우거나 지울 수 있다(ADR-0069 결정 7). MY 설정의 거절만 —
  // 온보딩의 관심 카테고리 단계에는 비우거나 지울 것이 없다.
  errRestrictedClearAllowed: '비우거나 지우는 것은 할 수 있습니다.',
  // 온보딩의 관심 카테고리 단계에서 24시간이 지난 고르기가 제한으로 거절될 때만 — 작성 제한이든 계정
  // 제한이든(오너 결정 2026-10-23 답 9 — 그 화면에서 열려 있는 것은 건너뛰기다, ADR-0085 7-11).
  errRestrictedSkipAllowed: '건너뛰기는 할 수 있습니다.',
  // 계정 제한(#139, ADR-0085; ADR-0069 결정 1 #57-12·#57-13, 결정 3 #37-9, 결정 4 #139·#140 행). 다른 운영자가
  // 승인한 때부터 효력이 있다(ADR-0056 결정 1-7). 막는 것은 거래(새 주문 — #119가 서버의 확인을 부른다)·시장 제안
  // (#77)·공개 프로필 항목의 새 값·탈퇴(#140)이고, 글·댓글 쓰기·좋아요·신고·관심 등록과 잔액·기록은 그대로다
  // (#57-12 — 커뮤니티 작성은 작성 제한으로 따로 건다). 띠는 작성 제한의 띠와 같은 자리에서 이 제목과 끝나는 때,
  // 조치·신고 내역 링크뿐이다(오너 결정 2026-10-22 저녁). 거절은 작성 제한의 문장과 같은 꼴에 이 제한의 이름이다 —
  // 뒤에 '(…까지).'나 '(무기한).'과 열려 있는 것(errRestrictedClearAllowed·errRestrictedSkipAllowed)이 붙는다.
  // 요청하거나 승인한 운영자는 회원에게 보이지 않는다(#139 «건 운영자는 보이지 않는다»).
  restrictionAccountTitle: '계정 제한 중입니다.',
  errRestrictedAccountProfile: '계정 제한 중에는 공개 프로필을 새 값으로 바꿀 수 없습니다',
  errRestrictedAccountNickname: '계정 제한 중에는 닉네임을 바꿀 수 없습니다',
  // 탈퇴(#140, ADR-0086): 작성 제한·계정 제한이 끝날 때까지 막는다(ADR-0069 결정 4 #140 «제재 중 탈퇴» —
  // 무기한이면 풀릴 때까지). 같은 꼴로 뒤에 '(…까지).'나 '(무기한).'이 붙고 열려 있는 것은 없다.
  errRestrictedClosure: '작성 제한 중에는 탈퇴할 수 없습니다',
  errRestrictedAccountClosure: '계정 제한 중에는 탈퇴할 수 없습니다',
  // 경고의 안내 띠(오너 결정 2026-10-21): 경고한 때부터 이의 기한 14일 동안 MY 요약에만 보이고(글쓰기
  // 화면은 제한만), 조치·신고 내역으로 잇는다. 취소된 경고에는 없다. 이 문장과 링크뿐이고 이의의 안내는
  // 없다(오너 결정 2026-10-22 답 3, #186).
  moderationWarningReceived: '경고를 받았습니다.',
  // 운영자에게만 보이는 공개 화면의 링크(오너 결정 2026-10-21): 글·댓글·대댓글·프로필에서 그 대상의
  // 관리자 운영 화면으로 간다(신고 없는 조치의 입구). 링크 글자는 '운영', 화면 낭독기는 무엇의 화면인지 듣는다.
  operatorModerationLink: '운영',
  operatorModerationPostLabel: '이 글의 운영 화면',
  operatorModerationCommentLabel: '이 댓글의 운영 화면',
  operatorModerationProfileLabel: '이 회원의 운영 화면',

  // --- admin: 신고·조치 (#50, ADR-0081) ---
  // 신고 목록(대상마다 묶음)과 처리, 신고 없이 하는 조치와 취소(결정 4 #50). 운영자는 위반 정도에 맞춰
  // 고른다(#45-11). 모든 조치·취소·기각은 사유·운영자·시각이 남는다. 신고 수는 운영자가 읽을 뿐 아무것도
  // 숨기거나 제재하지 않는다(#45-10). 운영자 자신의 글·댓글·프로필은 다른 운영자가 처리한다(결정 4 #50).
  adminModeration: '신고·조치',
  adminReportQueue: '신고 목록',
  adminModerationActions: '조치 기록',
  adminReportQueueIntro:
    '신고는 대상마다 묶여 있습니다. 처리 대기는 가장 오래 기다린 대상부터, 처리 완료는 최근에 처리한 대상부터 보입니다. 신고 수만으로는 아무것도 숨기거나 제재하지 않습니다.',
  adminReportQueuePending: '처리 대기',
  adminReportQueueResolved: '처리 완료',
  adminReportQueueEmptyPending: '처리를 기다리는 신고가 없습니다.',
  adminReportQueueEmptyResolved: '처리를 마친 신고가 없습니다.',
  adminReportPendingCount: '대기',
  adminReportCount: '신고',
  adminReporterCount: '신고자',
  adminCountUnitReports: '건',
  adminCountUnitPeople: '명',
  adminReportFirstPendingAt: '가장 오래 기다린 신고',
  adminReportLatestAt: '마지막 신고',
  adminReportLastResolvedAt: '마지막 처리',
  adminModerationOpen: '자세히',
  adminModerationNotFound: '대상을 찾을 수 없습니다.',
  adminModerationStatePublished: '공개',
  adminModerationStateHidden: '숨김',
  adminModerationStateDeleted: '삭제됨(자리표시)',
  adminModerationStateGone: '삭제됨',
  adminModerationAuthor: '작성자',
  adminModerationMember: '회원',
  adminModerationMarket: '시장',
  adminModerationPost: '글',
  adminModerationContent: '내용',
  adminModerationUntitled: '제목 없음',
  adminModerationCreatedAt: '작성',
  adminModerationEditedAt: '수정',
  adminModerationDeletedAt: '삭제',
  adminModerationHiddenAt: '숨김',
  adminModerationRevisions: '이전 내용',
  // 글 화면의 댓글 목록: 신고 없는 댓글에도 그 댓글의 운영 화면으로 가는 길(결정 4 #50).
  adminModerationComments: '댓글',
  adminModerationNoComments: '댓글이 없습니다.',
  adminModerationRevisionWrittenAt: '쓴 때',
  adminModerationRevisionReplacedAt: '바뀐 때',
  adminModerationReports: '신고',
  adminModerationNoReports: '신고가 없습니다.',
  adminModerationReporter: '신고자',
  adminModerationReportDescription: '설명',
  adminModerationResolvedBy: '처리한 운영자',
  adminModerationDismissalReason: '기각 사유',
  adminModerationItemActions: '이 대상의 조치',
  adminModerationMemberActions: '이 회원이 받은 조치',
  adminModerationNoActions: '조치가 없습니다.',
  adminModerationCreatedBy: '조치한 운영자',
  adminModerationCancelledBy: '취소한 운영자',
  adminModerationCancelReason: '취소 사유',
  adminModerationResolvedReports: '처리한 신고',
  adminModerationRemovedNickname: '바꾸기 전 닉네임',
  adminModerationRemovedBio: '비우기 전 소개',
  adminModerationRemovedImage: '삭제한 이미지',
  adminModerationBio: '소개',
  adminModerationImage: '프로필 이미지',
  adminModerationNone: '없음',
  adminModerationOwnNotice:
    '내 글·댓글이나 내 프로필입니다. 이 대상의 신고 처리와 조치는 다른 운영자가 합니다.',
  // 운영자 자신에 관한 기록(오너 결정 2026-10-21): 신고자·신고 설명·처리하거나 조치·취소한 운영자는 그
  // 운영자에게도 보이지 않는다. 사유·시각·조치 내용은 보인다.
  adminModerationWithheldReport:
    '내게 들어온 신고라 신고자와 설명, 처리한 운영자는 보이지 않습니다.',
  adminModerationWithheldAction: '내가 받은 조치라 조치하거나 취소한 운영자는 보이지 않습니다.',
  adminModerationOpenPublic: '공개 화면에서 보기',
  adminModerationOpenMember: '회원의 신고·조치 보기',
  adminModerationHidePost: '글 숨기기',
  adminModerationHideComment: '댓글 숨기기',
  adminModerationWarn: '경고',
  adminModerationNicknameReset: '닉네임을 자동 닉네임으로',
  adminModerationBioClear: '소개 비우기',
  adminModerationImageRemove: '프로필 이미지 삭제',
  adminModerationDismiss: '신고 기각',
  adminModerationCancel: '조치 취소',
  adminModerationHidePostTitle: '글을 숨깁니다',
  adminModerationHideCommentTitle: '댓글을 숨깁니다',
  adminModerationHideBody:
    '숨기면 공개 화면에는 자리표시만 남고 목록에서 빠지며, 작성자는 고칠 수 없습니다. 이 대상에 처리를 기다리는 신고는 모두 조치함으로 닫힙니다. 조치는 나중에 취소할 수 있습니다.',
  adminModerationWarnTitle: '회원에게 경고합니다',
  adminModerationWarnBody:
    '경고는 기록과 회원 안내만 남깁니다. 대상을 고르면 그 대상에 처리를 기다리는 신고가 모두 조치함으로 닫힙니다.',
  adminModerationWarnSubject: '경고의 대상',
  adminModerationWarnSubjectThis: '이 글·댓글',
  adminModerationWarnSubjectProfile: '프로필',
  adminModerationWarnSubjectNone: '정한 대상 없음',
  adminModerationNicknameResetTitle: '닉네임을 자동 닉네임으로 바꿉니다',
  adminModerationBioClearTitle: '소개를 비웁니다',
  adminModerationImageRemoveTitle: '프로필 이미지를 삭제합니다',
  adminModerationProfileItemBody:
    '지운 값은 보존기간 동안 운영자만 보게 남고 되살리지 않습니다. 이 프로필에 처리를 기다리는 신고는 모두 조치함으로 닫힙니다.',
  // 닉네임 강제 변경(오너 결정 2026-10-21): 옛 닉네임은 그 회원에게도 30일 보류(NICKNAME_HOLD_DAYS), 회원의
  // 30일 변경 간격은 없어져 곧바로 새 닉네임을 고르고 그때부터 다시 30일이다.
  adminModerationNicknameResetNote:
    '바꾸기 전 닉네임은 30일 동안 이 회원을 포함해 아무도 쓸 수 없습니다. 회원은 기다리지 않고 새 닉네임을 고를 수 있습니다.',
  adminModerationDismissTitle: '신고를 기각합니다',
  adminModerationDismissBody:
    '아래 신고를 조치 없이 닫습니다. 신고한 회원에게는 기각으로 보입니다. 그 사이에 들어온 신고는 그대로 남습니다.',
  // 한 번의 기각은 신고 100건까지(DISMISS_REPORTS_MAX). 그보다 많으면 먼저 들어온 것부터 나눠 기각한다.
  adminModerationDismissPartial:
    '처리를 기다리는 신고가 한 번에 기각할 수 있는 100건보다 많습니다. 먼저 들어온 100건을 기각하고, 남은 신고는 이 화면에서 다시 기각할 수 있습니다.',
  adminModerationCancelTitle: '조치를 취소합니다',
  adminModerationCancelBody:
    '숨김을 취소하면 그 글·댓글이 다시 보입니다. 프로필 항목은 되살리지 않습니다.',
  // 닉네임 강제 변경의 취소(오너 결정 2026-10-22 답 2): 닉네임은 저절로 되살리지 않고, 옛 닉네임의 보류는 그
  // 회원의 것이 되어 다른 회원은 강제 변경한 때부터 30일(NICKNAME_HOLD_DAYS) 동안 못 고른다. 그 보류가 서 있는
  // 동안 그 회원은 강제 변경 뒤 닉네임을 바꿨어도 그 닉네임만은 30일 간격 없이 한 번 고른다(오너 결정 2026-10-22
  // (2차) 1·(4차) 1 — 되찾았다가 다시 바꾸면 간격 그대로, ADR-0081 7-13). 세 문장은 오너가 승인했다(같은 결정 2 — 둘째 문장은 오너가 든 예 그대로다).
  // 보류가 끝난 뒤의 취소에는 이 문장 대신 adminModerationCancelNicknameResetEndedBody를 보인다
  // (cancelDialogBody).
  adminModerationCancelNicknameResetBody:
    '닉네임은 되살리지 않습니다. 이전 닉네임은 이 회원만 다시 고를 수 있습니다. 다른 회원은 강제 변경한 때부터 30일 동안 쓸 수 없습니다.',
  // 강제 변경한 때부터 30일이 지난 닉네임 강제 변경의 취소(오너 결정 2026-10-22 (2차) 3): 보류가 이미 끝나
  // 넘길 것이 없다. 오너가 정한 문장 그대로다.
  adminModerationCancelNicknameResetEndedBody:
    '닉네임은 되살리지 않습니다. 이전 닉네임의 30일 보류는 끝났습니다.',
  // 작성 제한의 취소: 조치가 없던 것이 되고 곧바로 끝난다(회원에게는 '취소됨'). 조기 해제는 기록을 그대로 두고
  // 지금 끝낸다 — 둘은 따로다(#185, ADR-0082 결정 7). 이미 끝난(기간이 지났거나 조기 해제된) 제한도 취소할 수
  // 있다 — 이의를 받아들인 때(#45-14) — 그 창은 끝내는 말도 조기 해제도 말하지 않는다(그 줄에 조기 해제가 없다).
  adminModerationCancelRestrictionBody:
    '작성 제한을 취소하면 곧바로 끝나고 회원의 조치 내역에 취소됨으로 보입니다. 조치는 그대로 두고 지금 끝내려면 조기 해제를 씁니다.',
  adminModerationCancelRestrictionEndedBody:
    '이미 끝난 작성 제한입니다. 취소하면 회원의 조치 내역에 취소됨으로 보입니다.',
  // 작성 제한(#185, ADR-0082; ADR-0069 결정 2 #45-12·#45-14, 결정 4 #185 행): 신고 목록의 대상 화면(그 대상에
  // 처리를 기다리는 신고를 닫는다)이나 회원 화면에서 사유와 기간(1·3·7·30일·무기한)을 골라 건다. 이미 제한
  // 중이어도 걸 수 있고 더 늦게 끝나는 쪽이 회원의 것이다. 서 있는 제한은 조기 해제(지금 끝남)와 감경(끝나는
  // 때를 앞당김 — 무기한을 기간제로 바꾸는 것 포함, 승인 없음)을 운영 기록의 사유와 함께 한다. 회원에게는 바뀐
  // 끝나는 때만 보인다.
  adminModerationRestrict: '작성 제한',
  adminModerationRestrictTitle: '회원의 작성을 제한합니다',
  adminModerationRestrictBody:
    '고른 기간 동안 글·댓글을 쓰거나 고칠 수 없고 공개 프로필을 새 값으로 바꿀 수 없습니다. 지우기·좋아요·신고는 막지 않습니다. 이미 제한 중이면 더 늦게 끝나는 쪽이 적용됩니다. 대상을 고르면 그 대상에 처리를 기다리는 신고가 모두 조치함으로 닫힙니다.',
  adminModerationRestrictSubject: '제한의 대상',
  adminModerationTerm: '기간',
  adminModerationTermDayUnit: '일',
  adminModerationRestricted: '작성을 제한했습니다.',
  adminModerationLift: '조기 해제',
  adminModerationLiftTitle: '작성 제한을 지금 풉니다',
  adminModerationLiftBody:
    '끝나는 때가 지금이 되고 조치는 기록에 그대로 남습니다. 회원에게는 바뀐 끝나는 때만 보입니다. 같은 회원의 다른 작성 제한은 그대로입니다.',
  adminModerationLifted: '작성 제한을 풀었습니다.',
  adminModerationShorten: '감경',
  adminModerationShortenTitle: '작성 제한의 끝나는 때를 앞당깁니다',
  adminModerationShortenBody:
    '지금 끝나는 때보다 앞이고 아직 오지 않은 때를 한국 시간으로 넣습니다. 무기한이면 오지 않은 어느 때든 됩니다. 회원에게는 바뀐 끝나는 때만 보입니다.',
  adminModerationShortenEndLabel: '새로 끝나는 때(한국 시간)',
  adminModerationShortened: '끝나는 때를 앞당겼습니다.',
  adminModerationEndChangeShorten: '감경',
  adminModerationEndChangeLift: '조기 해제',
  adminModerationEndChangeReason: '변경 사유',
  adminModerationChangedBy: '바꾼 운영자',
  adminModerationChangedAt: '바꾼 때',
  errModerationTermRequired: '기간을 골라 주세요.',
  errModerationEndRequired: '새로 끝나는 때를 입력해 주세요.',
  // 계정 제한(#139, ADR-0085; ADR-0069 결정 1 #57-12, 결정 2 #45-11·#45-14, 결정 4 #50·#139 행; ADR-0056 결정
  // 1-7): 한 운영자가 회원 화면이나 신고 목록의 대상 화면에서 요청하고, 요청하지 않은 다른 운영자가 승인해야 효력이
  // 있다 — 걸기·감경·조기 해제·취소 모두. 기간은 승인한 때부터 센다. 사유는 정한 목록(스팸·괴롭힘·개인정보 노출·
  // 사칭·공모·조작 유도·이상 거래·다계정·기타)에서 하나와 필수 설명이다. 요청에는 기한이 없고, 결정 전에는 요청한
  // 운영자가 철회할 수 있다(오너 결정 2026-10-23 — 기록에 남고 철회된 요청은 아무도 결정하지 못한다). 요청한
  // 운영자와 대상 회원 말고는 결정할 운영자가 없으면 요청을 받지 않는다(같은 결정). 걸기 요청에는 운영자만
  // 읽는 선택 메모를 둔다(요청한 운영자도 읽고, 회원과 그 요청의 대상인 운영자에게는 보이지 않는다, 같은 결정).
  adminModerationAccountRestrict: '계정 제한 요청',
  adminModerationAccountRestrictTitle: '회원의 계정 제한을 요청합니다',
  adminModerationAccountRestrictBody:
    '다른 운영자가 승인하면 그때부터 고른 기간 동안 거래(새 주문)와 시장 제안, 공개 프로필의 새 값, 탈퇴를 막습니다. 글·댓글 쓰기·좋아요·신고·관심 등록과 잔액·기록은 그대로입니다. 이미 계정 제한 중이면 더 늦게 끝나는 쪽이 적용됩니다. 대상을 고르면 승인될 때 그 대상에 처리를 기다리는 신고가 모두 조치함으로 닫힙니다.',
  adminModerationAccountNoteHint:
    '꼭 적어야 합니다. 500자까지 쓸 수 있고, 승인하는 운영자도 이 설명을 요청 사유로 읽습니다.',
  adminModerationAccountMemoLabel: '운영자 메모',
  adminModerationAccountMemoHint:
    '적지 않아도 됩니다. 회원에게는 보이지 않고 운영자만 읽습니다. 500자까지 쓸 수 있습니다.',
  errModerationMemoTooLong: '운영자 메모는 500자 이하로 입력해 주세요.',
  adminModerationAccountRequested: '계정 제한을 요청했습니다. 다른 운영자가 승인하면 적용됩니다.',
  adminModerationAccountLift: '조기 해제 요청',
  adminModerationAccountLiftTitle: '계정 제한의 조기 해제를 요청합니다',
  adminModerationAccountLiftBody:
    '다른 운영자가 승인하면 그때 끝나고 조치는 기록에 그대로 남습니다. 사유는 회원에게 보이지 않습니다. 같은 회원의 다른 계정 제한은 그대로입니다.',
  adminModerationAccountLiftRequested:
    '조기 해제를 요청했습니다. 다른 운영자가 승인하면 적용됩니다.',
  adminModerationAccountShorten: '감경 요청',
  adminModerationAccountShortenTitle: '계정 제한의 감경을 요청합니다',
  adminModerationAccountShortenBody:
    '지금 끝나는 때보다 앞이고 아직 오지 않은 때를 한국 시간으로 넣습니다. 무기한이면 오지 않은 어느 때든 됩니다. 승인할 때 그 때가 이미 지났거나 지금 끝나는 때보다 앞이 아니면 승인되지 않습니다. 사유는 회원에게 보이지 않습니다.',
  adminModerationAccountShortenRequested: '감경을 요청했습니다. 다른 운영자가 승인하면 적용됩니다.',
  adminModerationAccountCancel: '취소 요청',
  adminModerationAccountCancelTitle: '계정 제한의 취소를 요청합니다',
  // 서 있는 계정 제한과 이미 끝난(기간이 지났거나 조기 해제된) 계정 제한의 취소 요청 — 작성 제한의 두 창(답 11)과
  // 같은 구분이다. 이미 끝난 것의 취소도 승인을 받는다(ADR-0085 7-4).
  adminModerationAccountCancelBody:
    '다른 운영자가 승인하면 곧바로 끝나고 회원의 조치 내역에 취소됨으로 보입니다. 조치는 그대로 두고 지금 끝내려면 조기 해제를 요청합니다.',
  adminModerationAccountCancelEndedBody:
    '이미 끝난 계정 제한입니다. 다른 운영자가 승인하면 회원의 조치 내역에 취소됨으로 보입니다.',
  adminModerationAccountCancelRequested: '취소를 요청했습니다. 다른 운영자가 승인하면 적용됩니다.',
  // 계정 제한의 줄: 요청한 운영자가 그 조치의 운영자이고(ADR-0085 7-1), 승인한 운영자·사유·시각이 따로 있다.
  // 자기에 관한 기록이면 운영자 없이 시각만(오너 결정 2026-10-21).
  adminModerationRequestedBy: '요청한 운영자',
  adminModerationApprovedBy: '승인한 운영자',
  adminModerationApprovedAt: '승인한 때',
  adminModerationApprovalReason: '승인 사유',
  adminModerationCancelRequestedBy: '취소를 요청한 운영자',
  adminModerationCancelApprovedBy: '취소를 승인한 운영자',
  adminModerationCancelApprovedAt: '취소를 승인한 때',
  adminModerationCancelApprovalReason: '취소 승인 사유',
  errModerationAccountNoteRequired: '회원에게 보일 설명을 적어 주세요.',
  // 계정 제한 요청의 목록(관리자 신고·조치 영역의 '계정 제한 요청')과 회원 화면의 승인 대기 요청.
  adminAccountRequests: '계정 제한 요청',
  adminAccountRequestsIntro:
    '계정 제한과 그 감경·조기 해제·취소는 한 운영자가 요청하고 요청하지 않은 다른 운영자가 승인해야 적용됩니다. 요청에는 기한이 없고, 요청한 운영자는 결정 전에 요청을 철회할 수 있습니다. 요청한 운영자와 대상 회원 말고 결정할 운영자가 없으면 요청할 수 없습니다.',
  adminAccountRequestsPending: '승인 대기',
  adminAccountRequestsDecided: '결정함',
  adminAccountRequestsRetracted: '철회됨',
  adminAccountRequestsEmptyPending: '승인을 기다리는 요청이 없습니다.',
  adminAccountRequestsEmptyDecided: '결정한 요청이 없습니다.',
  adminAccountRequestsEmptyRetracted: '철회한 요청이 없습니다.',
  adminAccountRequestsMember: '승인을 기다리는 계정 제한 요청',
  adminAccountRequestsMemberEmpty: '승인을 기다리는 요청이 없습니다.',
  adminAccountRequestChangeApply: '계정 제한',
  adminAccountRequestChangeShorten: '계정 제한 감경',
  adminAccountRequestChangeLift: '계정 제한 조기 해제',
  adminAccountRequestChangeCancel: '계정 제한 취소',
  approvalStatusPending: '승인 대기',
  approvalStatusApproved: '승인됨',
  approvalStatusRejected: '거절됨',
  approvalStatusRetracted: '철회됨',
  adminAccountRequestReason: '요청 사유',
  adminAccountRequestEndsAt: '요청한 끝나는 때',
  // 감경·조기 해제·취소 요청이 바꿀 계정 제한(지금 모습): 건 때·지금 끝나는 때와 그 사유. 회원에게 계정 제한이
  // 여럿일 수 있어 승인하는 운영자가 어느 것인지 읽는다. 줄은 회원 화면의 그 조치로 잇는다.
  adminAccountRequestTarget: '대상 계정 제한',
  adminAccountRequestTargetReason: '대상 제한의 사유',
  adminAccountRequestRequestedAt: '요청한 때',
  adminAccountRequestDecidedBy: '결정한 운영자',
  adminAccountRequestDecidedAt: '결정한 때',
  adminAccountRequestDecisionReason: '결정 사유',
  // 회원이 탈퇴해 저절로 닫힌 요청(#140, 오너 결정 2026-10-23 — ADR-0085 결과 5 «거절로 기록, 까닭 '탈퇴'»):
  // 결정한 운영자가 없으므로 '결정한 운영자' 대신 이 말과 닫힌 때다. 결정 사유는 '탈퇴'다.
  adminAccountRequestClosedByClosure: '회원 탈퇴로 닫힘',
  adminAccountRequestOwn:
    '내가 한 요청이라 다른 운영자가 승인하거나 거절합니다. 결정 전에는 철회할 수 있습니다.',
  adminAccountRequestMemo: '운영자 메모',
  adminAccountRequestRetractedAt: '철회한 때',
  // 요청한 운영자의 철회(오너 결정 2026-10-23): 사유 없이 확인만, 철회한 운영자와 시각이 기록에 남는다.
  adminAccountRequestRetract: '요청 철회',
  adminAccountRequestRetractTitle: '요청을 철회합니다',
  adminAccountRequestRetractBody:
    '철회하면 아무것도 바뀌지 않고 요청은 철회됨으로 닫혀, 누구도 승인하거나 거절할 수 없습니다. 철회한 운영자와 시각이 기록에 남습니다.',
  adminAccountRequestRetracted: '요청을 철회했습니다.',
  adminAccountRequestAboutMe:
    '나에 관한 요청이라 내가 승인하거나 거절할 수 없고, 요청하거나 결정한 운영자는 보이지 않습니다.',
  // 요청 뒤 제한이 바뀌어 승인이 거절될 요청(`moot`): 승인 단추 없이 까닭과 거절만 둔다(ADR-0085 7-3).
  adminAccountRequestMootCancelled:
    '그 계정 제한이 요청 뒤에 취소되어 승인할 수 없습니다. 거절로 닫아 주세요.',
  adminAccountRequestMootEnded:
    '그 계정 제한이 요청 뒤에 끝나 승인할 수 없습니다. 거절로 닫아 주세요.',
  adminAccountRequestMootNotEarlier:
    '요청한 끝나는 때가 지금 끝나는 때보다 앞이 아니라 승인할 수 없습니다. 거절로 닫아 주세요.',
  adminAccountRequestMootEndPassed:
    '요청한 끝나는 때가 이미 지나 승인할 수 없습니다. 거절로 닫아 주세요.',
  adminAccountRequestApprove: '승인',
  adminAccountRequestReject: '거절',
  adminAccountRequestApproveTitle: '요청을 승인합니다',
  adminAccountRequestApproveBody:
    '승인하면 요청한 일이 곧바로 적용되고, 승인한 운영자·사유·시각이 기록에 남습니다.',
  adminAccountRequestApproveApplyBody:
    '승인하면 그때부터 계정 제한이 적용되고 기간도 그때부터 셉니다. 대상을 정한 요청이면 그 대상에 처리를 기다리는 신고가 모두 조치함으로 닫힙니다. 승인한 운영자·사유·시각이 기록에 남습니다.',
  adminAccountRequestRejectTitle: '요청을 거절합니다',
  adminAccountRequestRejectBody:
    '거절하면 아무것도 바뀌지 않고 요청은 거절됨으로 닫힙니다. 거절한 운영자·사유·시각이 기록에 남습니다.',
  adminAccountRequestApproved: '승인했습니다.',
  adminAccountRequestRejected: '거절했습니다.',
  // 2인 통제의 거절(APPROVAL_NOT_ALLOWED, ADR-0056 결정 4): 요청한 운영자의 결정, 이미 결정된 요청, 철회된
  // 요청, 요청하지 않은 운영자의 철회.
  errApprovalRequester: '요청한 운영자는 승인하거나 거절할 수 없습니다. 다른 운영자가 결정합니다.',
  errApprovalDecided: '이미 결정된 요청입니다. 화면을 새로 고쳐 주세요.',
  errApprovalRetracted: '요청한 운영자가 철회한 요청입니다. 화면을 새로 고쳐 주세요.',
  errApprovalNotRequester: '요청한 운영자만 철회할 수 있습니다. 화면을 새로 고쳐 주세요.',
  adminModerationReasonLabel: '사유',
  adminModerationReasonPlaceholder: '사유 고르기',
  adminModerationNoteLabel: '회원에게 보일 설명',
  adminModerationNoteHint: "'기타'를 고르면 적어야 합니다. 500자까지 쓸 수 있습니다.",
  adminModerationRecordLabel: '운영 기록의 사유',
  adminModerationRecordHint: '회원에게는 보이지 않고 처리 기록에 운영자·시각과 함께 남습니다.',
  adminModerationSubmit: '확인',
  adminModerationHidden: '숨겼습니다.',
  adminModerationWarned: '경고했습니다.',
  adminModerationNicknameResetDone: '닉네임을 자동 닉네임으로 바꿨습니다.',
  adminModerationBioCleared: '소개를 비웠습니다.',
  adminModerationImageRemoved: '프로필 이미지를 삭제했습니다.',
  adminModerationDismissed: '신고를 기각했습니다.',
  adminModerationCancelDone: '조치를 취소했습니다.',
  errModerationReasonRequired: '사유를 골라 주세요.',
  errModerationNoteRequired: "'기타'를 고르면 회원에게 보일 설명을 적어 주세요.",
  errModerationNoteTooLong: '설명은 500자 이하로 입력해 주세요.',
  errModerationRecordRequired: '운영 기록의 사유를 1~500자로 입력해 주세요.',
  errModerationOwn: '내 글·댓글이나 내 프로필의 신고와 조치는 다른 운영자가 처리합니다.',
  errModerationHidden: '이미 숨긴 대상입니다. 화면을 새로 고쳐 주세요.',
  errModerationDeleted: '작성자가 삭제한 대상입니다. 화면을 새로 고쳐 주세요.',
  errModerationNothingToRemove: '지울 것이 없습니다. 화면을 새로 고쳐 주세요.',
  errModerationCancelled: '이미 취소한 조치입니다. 화면을 새로 고쳐 주세요.',
  errModerationResolved: '이미 처리한 신고가 있습니다. 화면을 새로 고쳐 주세요.',
  errModerationNotTheirs: '이 회원의 글·댓글이 아닙니다. 화면을 새로 고쳐 주세요.',
  errModerationNotRestriction: '작성 제한이 아닌 조치입니다. 화면을 새로 고쳐 주세요.',
  errModerationEnded: '이미 끝난 제한입니다. 화면을 새로 고쳐 주세요.',
  errModerationNotEarlier: '새로 끝나는 때는 지금 끝나는 때보다 앞이어야 합니다.',
  errModerationEndPassed: '이미 지난 시각입니다. 지금 끝내려면 해제해 주세요.',
  // 계정 제한(#139)은 다른 운영자의 승인으로만 바뀐다(ADR-0056 결정 1-7).
  errModerationApprovalRequired:
    '계정 제한은 다른 운영자의 승인을 받아 바꾸거나 취소합니다. 화면을 새로 고쳐 주세요.',
  errModerationNotAccountRestriction: '계정 제한이 아닌 조치입니다. 화면을 새로 고쳐 주세요.',
  // 결정할 운영자가 없는 요청(오너 결정 2026-10-23): 요청한 운영자와 대상 회원이 아닌 운영자가 없다.
  errModerationNoDecider:
    '이 요청을 결정할 운영자가 없습니다. 요청한 운영자와 대상 회원이 아닌 운영자가 있어야 요청할 수 있습니다.',
  errModerationReportIds: '한 번에 기각할 수 있는 신고는 100건까지입니다. 화면을 새로 고쳐 주세요.',

  // 관리자 시장 폼의 미리보기 (Q-M3-6): 실제 카드·규칙 컴포넌트를 그대로 그린다.
  adminMarketPreview: '미리보기',
  adminMarketPreviewCard: '카드 미리보기',
  adminMarketPreviewDetail: '상세 미리보기',

  // --- markets / 체결 없음 · 거래 공백 (#125) ---
  // 첫 체결 전의 가격 자리(N02 §5): 초기 설정값을 가격처럼 보이지 않는다. 카드·상세·차트·관리자 목록·
  // MY가 같은 문구를 쓴다.
  noFills: '체결 없음',
  // 주문 영역 자리의 안내(오너 결정 #125 (a)): CLOB 주문(#119·#66)이 들어올 때까지 거래할 수 없다.
  tradePreparing: '거래 준비 중',
  // 계약 수 단위. 수량은 호출 쪽에서 붙인다.
  unitContracts: '계약',

  // --- 판정 · 정산 (PLAN 5.5 · 11.3 · 12, ADR-0046) ---
  // 관리자 판정 대화상자. 판정은 즉시 확정되고 바로 정산이 시작된다(이의 단계 없음).
  // 결과를 정하는 일은 '판정', Coin 지급은 '정산'이다(N03 §5·§7, #14).
  adminMarketResolve: '판정',
  adminMarketResolveTitle: '결과를 판정합니다',
  adminMarketResolveBody:
    '선택한 결과로 판정합니다. 판정은 즉시 확정되고 바로 정산이 시작됩니다. 판정한 뒤에는 결과를 바꾸거나 무효로 할 수 없습니다.',
  adminMarketResolveResult: '결과',
  adminMarketResolveNote: '메모',
  adminMarketResolveEvidence: '근거 URL',
  adminMarketResolveEvidencePlaceholder: 'https://',
  adminMarketResolved: '판정했습니다. 정산을 시작합니다.',
  errMarketResultRequired: '결과를 선택해 주세요.',
  errMarketResolveNote: '메모는 1,000자 이하로 입력해 주세요.',
  errMarketResolveEvidence: 'http 또는 https로 시작하는 500자 이하의 URL을 입력해 주세요.',
  // 관리자 시장 상세의 정산 단계 (ADR-0046): 판정한 시장의 단계별 진행. 읽기 전용이다.
  adminSettlementSteps: '정산 단계',
  adminSettlementStepColumn: '단계',
  adminSettlementStepStatus: '상태',
  adminSettlementStepAttempts: '시도',
  adminSettlementStepCompletedAt: '완료 시각',
  adminSettlementStepLastError: '마지막 오류',
  settlementStepCoin: '포지션 정산',
  settlementStepStatusPending: '대기',
  settlementStepStatusDone: '완료',
  settlementStepStatusFailed: '실패',
  // 정산 완료 안내: 지급은 이미 잔고에 반영됐고 내 손익은 아래 내 포지션이 말한다. '맞힌'이 아니라
  // 기획의 '정답'(N02 §6, 오너 결정 #14).
  marketSettledPayout:
    '정답인 계약은 100 Coin씩 지급되었고, 내 손익은 아래 내 포지션에서 볼 수 있습니다.',
  // 관리자 이벤트 로그의 정산 행: 정산 요약(worker market-finalize).
  eventSettledAccounts: '정산 계정 수',
  eventPaidAccounts: '지급 계정 수',
  eventPaidTotal: '지급 합계',

  // --- 사업자 정보 푸터 · 약관 3종 · 충전 안내 (ADR-0044) ---
  // `{{key}}` is a business fact from src/legal/business-info.ts, substituted by `fillTemplate`
  // at render time (owner decision: the facts live in ONE config). legal.test.ts resolves every
  // string here that carries one.
  legalTermsTitle: '이용약관',
  legalPrivacyTitle: '개인정보처리방침',
  legalRefundTitle: '환불정책',
  legalAddendum: '부칙',
  footerNavLabel: '약관 및 정책',
  footerBusinessInfoLabel: '사업자 정보',
  footerCompany: '상호: {{companyName}}',
  footerCeo: '대표자: {{ceoName}}',
  footerBusinessNumber: '사업자등록번호: {{businessNumber}}',
  footerMailOrderNumber: '통신판매업 신고번호: {{mailOrderNumber}}',
  footerAddress: '주소: {{address}}',
  footerPhone: '고객센터: {{phone}}',
  footerEmail: '이메일: {{email}}',
  footerPrivacyOfficer: '개인정보 보호책임자: {{privacyOfficer}}',
  footerHosting: '호스팅 서비스 제공자: {{hostingProvider}}',
  footerCopyright: '© {{serviceName}}',
  chargeGuideTitle: '충전 안내',
  chargeGuideIntro:
    'Coin은 {{serviceName}}의 예측시장에서 YES·NO 계약을 사고파는 데 쓰는 서비스 전용 Coin입니다. 아래 상품 가운데 하나를 골라 충전할 수 있습니다.',
  chargeGuideDelivery:
    '결제는 {{pgName}}의 결제 창에서 카드로 진행되며, 가격에는 부가가치세가 포함되어 있습니다. 결제가 승인되면 Coin이 바로 지갑에 충전됩니다. 충전하려면 로그인이 필요합니다.',
  chargeGuidePrice: '결제 금액',
  chargeGuideNoticeTitle: '충전 전에 확인해 주세요',
  chargeGuideRefundSummary:
    '결제가 승인된 때부터 {{refundWindowDays}}일 이내이고 그 결제로 충전된 Coin을 전혀 쓰지 않았다면 결제 금액 전액을 환불받을 수 있습니다. 쿠폰·정산 등 결제 없이 받은 Coin은 환불되지 않습니다.',
  chargeGuideRefundLink: '환불정책 자세히 보기',
  chargeGuideLoadError: '충전 상품을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',

  // --- 본인확인과 온보딩 (ADR-0043, ADR-0070) ---
  // 휴대전화 SMS 인증번호 본인확인(#183, ADR-0069 결정 1 #57-1·#57-3). 실명과 번호를 한 화면에서 받고 그 번호로
  // 보낸 6자리 인증번호를 확인한다. 번호 입력은 이 단계 하나뿐이고(확인하지 않은 번호 칸은 없앴다), 확인한 뒤에는
  // 실명만 MY 설정에서 고친다. 규칙은 @buddha/shared의 realNameSchema·phoneSchema·phoneVerificationCodeSchema
  // (lib/phone-verification.ts)이고, 문장 속 수치(3분·1분·5번·10번·3개·50번·500건·24시간)는
  // PHONE_VERIFICATION_LIMITS와 같아야 한다(lib/phone-verification.test.ts가 확인한다). 사용자에게 수집 목적을
  // 말하는 문장은 #58·#137이 쓴다.
  realName: '실명',
  realNameHint: '2~30자의 문자(한글·영문 등). 띄어쓰기와 가운뎃점(·)을 쓸 수 있습니다.',
  phone: '휴대전화 번호',
  phonePlaceholder: '010-1234-5678',
  phoneHint: '하이픈(-)은 넣어도 되고 빼도 됩니다.',
  verificationPrivacyLink: '개인정보처리방침 보기',
  errRealNameRequired: '실명을 입력해 주세요.',
  errRealNameFormat:
    '실명은 2~30자의 문자(한글·영문 등)로 입력해 주세요. 숫자와 기호는 쓸 수 없고, 띄어쓰기와 가운뎃점(·)은 글자 사이에만 쓸 수 있습니다.',
  errPhoneRequired: '휴대전화 번호를 입력해 주세요.',
  errPhoneFormat:
    '010·011·016~019로 시작하는 휴대전화 번호 10~11자리를 입력해 주세요. (예: 010-1234-5678)',
  // 본인확인 단계의 안내(온보딩의 둘째 단계).
  verificationIntro:
    '실명과 휴대전화 번호를 입력하고, 그 번호로 받은 6자리 인증번호를 입력해 주세요.',
  verificationSend: '인증번호 받기',
  verificationResend: '인증번호 다시 받기',
  // 인증번호를 보낸 뒤 실명·번호 칸은 잠긴다. 고치려면 이 단추로 두 칸을 다시 연다(다시 받는 것은 1분 뒤부터).
  verificationEdit: '실명·번호 다시 입력',
  // 이 화면이 보내지 않은 인증번호(새로 고침 전, 다른 탭, 답을 받지 못한 발송)를 넣는 칸을 연다. 서버는
  // 어느 화면이 보냈든 계정의 가장 새 인증번호를 확인한다.
  verificationCodeEnter: '이미 받은 인증번호 입력',
  // 1분 안에 보낸 인증번호가 있어 다시 받기가 거절됐을 때, 인증번호 칸을 열며 앞에 붙는다. 어느 번호로
  // 보냈는지는 말하지 않는다(다른 탭에서 다른 번호로 보냈을 수 있다).
  verificationCodeWaiting: '최근에 보낸 인증번호가 있습니다. 문자로 받았다면 아래에 입력해 주세요.',
  verificationCode: '인증번호',
  verificationCodeHint: '문자로 받은 숫자 6자리를 입력해 주세요.',
  verificationCodeSent: '입력한 번호로 인증번호를 보냈습니다. 3분 안에 입력해 주세요.',
  // 문자 발송 사업자의 답을 받지 못했거나(SMS_SEND_UNCONFIRMED: 시간 초과·5xx·읽을 수 없는 답) 브라우저가
  // API의 답을 받지 못했다(네트워크 끊김·게이트웨이 오류·시간 초과). 문자가 갔을 수 있으므로 그 발송은 한도에
  // 세고 그 인증번호는 확인할 수 있다. 인증번호 칸을 열고, 다시 받기는 1분 뒤부터다. 주의(노란) 모양의
  // 알림이다(오너 결정 2026-10-18, ADR-0070 — 앱의 주의 알림은 모두 노랑이다, 3차).
  verificationMaybeSent:
    '인증번호 문자가 갔을 수 있습니다. 받았다면 그 인증번호를 아래에 입력하고, 받지 못했다면 잠시 뒤 다시 받아 주세요.',
  // 인증번호의 남은 유효시간 앞에 붙는다(예: '남은 시간 2:59').
  verificationExpiresIn: '남은 시간',
  verificationConfirm: '본인확인 완료',
  verificationDone: '본인확인을 마쳤습니다.',
  // 기다려야 하는 시간 뒤에 붙는다(예: '… 42초 뒤에 다시 시도해 주세요.').
  verificationRetryAfter: '뒤에 다시 시도해 주세요.',
  // 틀린 인증번호의 남은 입력 기회(예: '(남은 입력 기회 4번)').
  verificationAttemptsLeft: '남은 입력 기회',
  verificationAttemptsUnit: '번',
  errVerificationCodeRequired: '인증번호를 입력해 주세요.',
  errVerificationCodeFormat: '인증번호는 숫자 6자리입니다.',
  errVerificationCodeMismatch: '인증번호가 맞지 않습니다.',
  errVerificationCodeExpired: '인증번호의 유효시간 3분이 지났습니다. 인증번호를 다시 받아 주세요.',
  errVerificationCodeAttemptsExceeded:
    '인증번호를 5번 잘못 입력해 이 인증번호는 더 쓸 수 없습니다. 인증번호를 다시 받아 주세요.',
  errVerificationCodeNone: '확인할 인증번호가 없습니다. 인증번호를 다시 받아 주세요.',
  // 다시 받은 뒤 그 전에 받은 인증번호를 넣었다(superseded). 가장 새 인증번호만 확인하고, 틀린 입력 기회는
  // 쓰지 않는다(오너 결정 2026-10-18).
  errVerificationCodeSuperseded: '예전에 받은 인증번호입니다. 새로 받은 인증번호를 입력해 주세요.',
  // 결과를 알 수 없는 발송(verificationMaybeSent) 뒤에 그 전의 인증번호를 넣었다(superseded). 새 문자가 오지
  // 않았을 수 있으므로 '새로 받은 인증번호' 대신 이 문장이다(오너 결정 2026-10-18 3차, ADR-0070).
  errVerificationCodeSupersededUncertain:
    '마지막에 받은 문자의 인증번호를 입력해 주세요. 새 문자가 오지 않았다면 잠시 뒤 다시 받아 주세요.',
  errVerificationResendWait: '인증번호는 1분에 한 번 받을 수 있습니다.',
  // 하루 한도는 모두 직전 24시간이다(오너 결정 2026-10-17·18). 계정·번호 쌍의 10번은 계정의 10번과 함께
  // 차므로 화면에는 거의 나오지 않는다(ADR-0070). 다른 계정과 함께 세는 한도(번호의 계정 수·접속 주소·
  // 서비스 전체)의 기다림은 분 단위로 온다(오너 결정 2026-10-18 2차).
  errVerificationAccountDaily: '한 계정은 24시간 동안 인증번호를 10번까지 받을 수 있습니다.',
  errVerificationAccountPhoneDaily:
    '한 계정이 한 번호로 받을 수 있는 인증번호는 24시간 동안 10번까지입니다.',
  errVerificationPhoneAccounts: '한 번호로는 24시간 동안 계정 3개까지 인증번호를 받을 수 있습니다.',
  errVerificationIpDaily:
    '같은 접속 주소(IP)에서는 24시간 동안 인증번호를 50번까지 받을 수 있습니다.',
  errVerificationServiceDaily:
    '서비스 전체의 인증번호 발송이 24시간 동안 보낼 수 있는 500건에 이르렀습니다.',
  errVerificationTooManyRequests: '요청이 너무 많습니다.',
  // 문자 발송 사업자가 받지 않은 것이 확실하다(SMS_SEND_FAILED: 거절, 연결 전 실패). 보낸 것으로 세지 않는다.
  // 결과를 알 수 없는 발송은 verificationMaybeSent다(ADR-0070).
  errVerificationSendFailed: '인증번호를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.',
  errVerificationAlreadyDone: '이미 본인확인을 마친 계정입니다.',
  // 한 번호에는 한 계정만(#57-1). 인증번호가 맞은 뒤에만 알려 준다(번호의 주인만 안다).
  errPhoneInUse:
    '다른 계정이 이미 본인확인에 쓴 번호입니다. 번호 하나로는 계정 하나만 본인확인할 수 있습니다.',
  errRealNameUnverified: '본인확인을 마친 계정만 실명을 고칠 수 있습니다.',
  settingsVerification: '본인확인',
  // 확인하는 것은 번호뿐이다(실명은 형식만 본다). 실명이 확인된 값처럼 읽히지 않게 둘을 나눠 말한다.
  settingsVerificationHint: '본인확인으로 확인한 휴대전화 번호와, 여기서 고칠 수 있는 실명입니다.',
  // 번호는 본인이 바꾸지 못하고 운영 문의로만 처리한다(#57-3, 운영자가 DB에서 바꾼다).
  verifiedPhoneHint: '번호는 직접 바꿀 수 없습니다. 바꾸려면 고객센터로 문의해 주세요.',
  realNameSaved: '실명을 저장했습니다.',
  settingsNotVerified: '아직 휴대전화 본인확인을 하지 않았습니다.',
  settingsVerifyNow: '본인확인하기',

  // --- 온보딩 (#58, ADR-0072) ---
  // 가입 직후 온보딩: 약관 동의 → 본인확인 → 닉네임 설정 → 시작 Coin 안내 → 관심 카테고리(건너뛸 수 있음)
  // → 가입 전에 보던 화면(ADR-0069 결정 4 #58, 결정 1 #57-7~#57-10). 단계의 이름은 진행 표시와 각 단계의
  // 제목이다. 마치지 않은 단계가 있으면 어느 화면에서든 남은 단계로 온다(#57-8, 약관·방침 화면은 예외).
  onboardingTitle: '시작하기',
  onboardingSignedOut: '로그인이 풀렸습니다. 다시 로그인하면 남은 단계부터 이어서 할 수 있습니다.',
  onboardingProgress: '진행 단계',
  onboardingStepConsent: '약관 동의',
  onboardingStepVerification: '본인확인',
  onboardingStepNickname: '닉네임 설정',
  onboardingStepNotice: '시작 Coin 안내',
  onboardingStepInterests: '관심 카테고리',
  // 단계를 마치기 전에 앞 단계가 풀렸다(다른 탭, 재동의를 묻는 개정). 화면은 서버를 다시 읽어 그 단계로 가고
  // 돌아간 단계의 제목 위에 이 문장을 보인다(오너 결정 2026-10-19 (2차) 6, ADR-0072). 다시 읽기가 실패해
  // 화면이 그대로이면 그 단계 안에서 보인다.
  errOnboardingStepsFirst: '앞 단계를 먼저 마쳐 주세요.',
  // 권리를 바꾸는 개정으로 동의를 다시 받는 동의 단계의 제목 위(오너 결정 2026-10-19 (2차) 6). 그 단계는
  // 서지 않게 된 항목만 다시 묻는다(2차 1).
  onboardingReconsentReason: '약관이 바뀌어 다시 동의가 필요합니다.',
  // 온보딩을 한 번 마친 뒤 재동의만 남은 계정의 동의 단계에만(처음 온보딩에는 없다) MY 설정으로 가는 길
  // (오너 결정 2026-10-22 답 2, ADR-0078). 그 계정은 동의하기 전에도 MY 설정에서 공개 프로필의 소개를
  // 비우고 관심 카테고리를 빼며 계정 설정(이메일·비밀번호·로그인 연결·실명·시간대·테마)을 바꾼다 — 새 값과
  // 닉네임 변경은 다시 이 단계로 온다.
  onboardingReconsentSettingsHint:
    '동의하기 전에도 MY 설정에서 공개 프로필의 소개를 비우거나 관심 카테고리를 빼고, 계정 설정을 바꿀 수 있습니다.',
  onboardingReconsentSettingsLink: 'MY 설정으로 가기',

  // 약관 동의(#57-4·#57-5). 항목마다 체크하고 '전체 동의'로 한꺼번에 고른다. 필수는 이용약관·개인정보
  // 수집·이용(휴대전화 번호 수집과 SMS 발송 위탁 포함)·연령 확인이고 선택은 마케팅 정보 수신이다. 연령 확인의
  // 문장은 오너의 글 그대로이고 14는 BUSINESS_INFO.minimumAge와 같아야 한다(lib/consent.test.ts가 확인한다).
  // 동의문 두 개(개인정보 수집·이용, 마케팅 정보 수신)는 legal/consent-texts.ts에 있다. 재동의는 서지 않게
  // 된 항목만 묻고(오너 결정 2026-10-19 (2차) 1), consentAllHint는 마케팅 항목이 있을 때만 보인다.
  consentIntro: '서비스를 이용하려면 아래 필수 항목에 동의해 주세요.',
  consentAll: '전체 동의',
  consentAllHint: '선택 항목인 마케팅 정보 수신까지 모두 동의합니다.',
  consentTerms: '이용약관에 동의합니다',
  consentPrivacy: '개인정보 수집·이용에 동의합니다',
  consentAge: '만 14세 이상입니다',
  consentMarketing: '마케팅 정보 수신에 동의합니다',
  consentRequiredTag: '(필수)',
  consentOptionalTag: '(선택)',
  consentViewTerms: '이용약관 보기',
  consentViewPrivacyPolicy: '개인정보처리방침 보기',
  consentShowText: '내용 보기',
  consentHideText: '내용 접기',
  consentSubmit: '동의하고 계속하기',
  errConsentRequired: '필수 항목에 모두 동의해야 다음 단계로 갈 수 있습니다.',
  // 화면을 연 사이에 동의할 문서가 개정됐다(서버가 지금 판이 아니라고 거절). 다시 읽고 동의하게 한다.
  errConsentOutdated: '동의할 내용이 바뀌었습니다. 화면을 새로 고친 뒤 다시 동의해 주세요.',
  // 계정마다 1분에 5번(동의 기록의 계정 한도, ADR-0072 7-26) — MY 설정의 마케팅 켜고 끄기를 빠르게 되풀이할 때.
  errConsentTooManyRequests: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',

  // 닉네임 설정(#57-6): 자동 닉네임(user_XXXX)을 미리 채우고, 그대로 정해도 닉네임 설정을 마친 것이다.
  nicknameStepIntro: '다른 회원에게 보이는 이름입니다. 자동으로 만든 닉네임을 그대로 써도 됩니다.',
  nicknameStepSubmit: '이 닉네임으로 정하기',

  // 시작 Coin 안내(#57-10): 지급액(미정이면 지급액 자리에 walletStartGrantPending — 오너의 한 문장이 지갑과
  // 같다, 결정 4 #70), Coin은 현금으로 바꿀 수 없다는 것, 운영 유동성(봇)이 거래 상대가 될 수 있다는 것.
  onboardingNoticeGranted: '시작 Coin을 지급했습니다.',
  onboardingNoticeAmount: '지급한 시작 Coin',
  // 본인확인한 번호의 시작 Coin이 다른 계정(예: 탈퇴한 계정)의 것이다(#57-1): 지급액 자리에 오너의 문장
  // (오너 결정 2026-10-19, ADR-0072). '이미 받았습니다'가 아닌 것은 드물게 그 계정의 지급이 아직 기다리는
  // 중일 수도 있어서다(3차 답 5). 나머지 안내와 관심 카테고리 단계는 같다.
  onboardingNoticeNumberUsed: '이 번호로는 시작 Coin을 받을 수 없습니다.',
  onboardingNoticeNoCash: 'Coin은 현금으로 바꿀 수 없습니다.',
  onboardingNoticeCounterparty: '거래할 때 운영 유동성(봇)이 거래 상대가 될 수 있습니다.',
  onboardingNoticeNext: '다음',

  // 관심 카테고리(#57-7): 상위·하위 카테고리 모두, 몇 개든 고르고, 건너뛰면 다시 묻지 않는다. 고른 것은
  // 늘 공개 프로필에 보이므로(#37-5) 고르는 이 자리에서도 MY 설정의 안내와 같은 말로 알린다(ADR-0078 7-21).
  interestsIntro:
    '관심 있는 카테고리를 고르세요. 고른 카테고리는 공개 프로필에 보입니다. 여러 개 고를 수 있고, 건너뛰어도 됩니다.',
  interestsSave: '선택 완료',
  interestsSkip: '건너뛰기',
  interestsLoadError: '카테고리를 불러오지 못했습니다.',
  // 화면을 연 사이 운영자가 카테고리를 닫았다. 목록을 다시 불러온다.
  errInterestsUnavailable:
    '지금은 고를 수 없는 카테고리가 있습니다. 목록을 다시 불러왔으니 다시 골라 주세요.',

  // --- 결제 내역 · 관리자 환불 (ADR-0042) ---
  // 유료 충전을 닫은 동안(ADR-0049) 그리지 않지만 코드와 함께 남긴다. 환불 기한 7일은 @buddha/shared의
  // PAYMENT_REFUND_WINDOW_DAYS와 같아야 한다(payments.test.ts가 확인한다).
  paymentResultReason: '사유:',
  paymentHistoryTitle: '결제 내역',
  paymentHistoryEmpty: '아직 결제 내역이 없습니다.',
  paymentStatusUnfinished: '미완료',
  paymentApprovedAt: '승인',
  paymentRefundedAt: '환불',
  paymentMethodCard: '카드',
  paymentMethodBank: '계좌이체',
  paymentMethodCellphone: '휴대폰',
  paymentMethodKakao: '카카오페이',
  paymentMethodNaver: '네이버페이',
  paymentMethodPayco: '페이코',
  paymentMethodSamsung: '삼성페이',
  paymentMethodApple: '애플페이',
  paymentMethodToss: '토스페이',
  paymentMethodLpay: 'L.PAY',
  paymentMethodPinpay: '핀페이',
  paymentMethodSmile: '스마일페이',
  paymentMethodTmoney: '티머니페이',
  adminPaymentRefund: '환불',
  adminPaymentRefundRetry: '환불 재시도',
  adminPaymentRefundDeadline: '환불 기한',
  adminPaymentRefundTitle: '결제를 환불합니다',
  adminPaymentRefundBody:
    '결제 금액 전액을 결제대행사에서 취소하고, 이 결제로 충전된 Coin을 모두 회수합니다. 승인 후 7일 이내이고 회원이 그 Coin을 전혀 쓰지 않았을 때(사용 가능 잔고가 그 Coin 이상)만 환불됩니다.',
  adminPaymentRefundRetryTitle: '환불을 다시 시도합니다',
  // 「환불 처리 중」은 취소의 답이 없었던 결제만이 아니다: 거절된 재시도도 남는다. 그래서 답이
  // 없었다고 말하지 않는다.
  adminPaymentRefundRetryBody:
    '이전 환불 요청에서 Coin은 이미 회수했고, 카드 취소는 아직 확인되지 않았습니다. 결제대행사에 취소를 다시 요청합니다.',
  adminPaymentRefundReason: '환불 사유',
  adminPaymentRefundReasonHint: '감사 기록에 남고, 결제대행사에 취소 사유로도 전달됩니다.',
  adminPaymentRefundSubmit: '환불하기',
  adminPaymentRefunded: '환불했습니다. 결제를 취소하고 Coin을 회수했습니다.',
  refundGatewayAnswer: '결제대행사 응답:',
  errRefundReason: '환불 사유를 1~500자로 입력해 주세요.',
  errRefundCoinUsed: '이미 사용한 Coin이 있어 환불할 수 없습니다.',
  errRefundWindowClosed: '승인 후 7일이 지나 환불할 수 없습니다.',
  errRefundStatus: '환불할 수 있는 상태의 결제가 아닙니다. 목록에서 현재 상태를 확인해 주세요.',
  errRefundProvider: '이 결제는 결제대행사에서 취소할 수 없습니다.',
  // 거절 뒤 회수했던 Coin을 되돌렸는지는 그때 결제가 어떤 상태였는지에 달려 있다(이미 「환불 처리 중」이
  // 아니었다면 되돌리지 않는다). 그래서 단정하지 않고 목록의 현재 상태를 보게 한다.
  errRefundGatewayRefused: '결제대행사가 취소를 거절했습니다. 목록에서 현재 상태를 확인해 주세요.',
  errRefundGatewayError:
    '결제대행사의 응답을 받지 못했습니다. 결제는 「환불 처리 중」으로 남아 있으니 잠시 뒤 다시 시도해 주세요.',
  errRefundInProgress: '이전 환불 요청이 아직 처리 중입니다. 1분쯤 뒤에 다시 시도해 주세요.',

  // --- generic ---
  errUnknown: '문제가 발생했습니다. 잠시 후 다시 시도해 주세요.',
  errNetwork: '서버에 연결할 수 없습니다.',
  errProfileLoad: '내 정보를 불러오지 못했습니다.',
  errUnauthenticated: '로그인이 필요합니다.',
  retry: '다시 시도',
  // 막아 둔 기능(유료 충전·결제·쿠폰, ADR-0049)의 요청이 거절됐을 때. 기능 이름을 말하지 않는다
  // (오너 결정 2026-10-13).
  unavailable: '이용할 수 없습니다.',
} as const;

export type CopyKey = keyof typeof copy;
