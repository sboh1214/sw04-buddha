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
  // 알려 주게 된다(#37-3). 30은 NICKNAME_HOLD_DAYS, 간격의 30은 NICKNAME_CHANGE_INTERVAL_DAYS, 예약어 목록은
  // NICKNAME_RESERVED_WORDS와 같아야 한다(lib/nickname.test.ts가 확인한다).
  errNicknameTaken: '이미 사용 중이거나, 다른 회원이 쓰다가 30일이 지나지 않은 닉네임입니다.',
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
  adminSmsCountUnit: '건',

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
  // 호가창(#179), 내 거래(#121), 내 대기 주문(#123), 공개 판정 기록(#24), 토론(#47). 자리의 제목은
  // 그 결정의 글 그대로다(오너 결정 2026-10-17). 내 거래와 내 대기 주문은 로그인한 본인에게만 보인다
  // (ADR-0061 결정 1의 18).
  marketBackground: '배경',
  marketOrderBook: '호가창',
  marketMyTrades: '내 거래',
  marketMyOpenOrders: '내 대기 주문',
  marketJudgingRecord: '공개 판정 기록',
  marketDiscussion: '토론',
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
  // 카드의 댓글 수는 #48이 더했고(아래 commentsHeading), 좋아요 수는 #49가 더한다(없는 수를 그리지 않는다).
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
  // 숨긴 글(#45-5): 작성자가 지울 수는 있지만 그 단추는 #50·#51이 붙인다 — 그때까지 삭제를 약속하지 않는다.
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

  // --- comments (#48, ADR-0074) ---
  // 근거 글 아래의 댓글과 그 아래의 답글(대댓글). 두 층뿐이라 답글에 답하면 같은 댓글 아래 답글이 된다
  // (#45-2). 모두 오래된 것부터(작성 순). 평문이고 http·https 주소는 링크로 보이며 1,000자, 줄바꿈은
  // 그대로다(#45-3). 누구나 읽고 온보딩을 마친 계정이 쓴다. 댓글 수는 지우거나 숨기지 않은 댓글과
  // 답글의 수일 뿐이다(ADR-0074).
  commentsHeading: '댓글',
  commentsEmpty: '아직 댓글이 없습니다.',
  commentsRepliesLabel: '답글 목록',
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
  // 새 답글을 받지 않는다(ADR-0074 7-4, 오너에게 묻는 중).
  commentClosedPostHidden: '운영 정책에 따라 숨긴 글에는 댓글을 달 수 없습니다.',
  commentClosedPostDeleted: '삭제된 글에는 댓글을 달 수 없습니다.',
  errCommentParentHidden: '운영 정책에 따라 숨긴 댓글에는 답글을 달 수 없습니다.',
  errCommentParentDeleted: '삭제된 댓글에는 답글을 달 수 없습니다.',
  errCommentParentGone: '답글을 달 댓글이 없거나 삭제되었습니다.',
  errCommentNotAllowed: '이 글이나 댓글에는 더 달 수 없습니다.',
  // 숨긴 댓글(#45-5): 작성자가 지울 수는 있지만 그 단추는 #50·#51이 붙인다 — 글과 같다.
  errCommentNotEditable: '운영 정책에 따라 숨긴 댓글은 고칠 수 없습니다.',
  errCommentGone: '없거나 삭제된 댓글입니다.',
  errCommentNotYours: '다른 사람의 댓글은 고치거나 삭제할 수 없습니다.',
  errCommentBodyEmpty: '댓글을 입력해 주세요.',
  errCommentBodyTooLong: '댓글은 1,000자 이하로 입력해 주세요.',

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

  // 관심 카테고리(#57-7): 상위·하위 카테고리 모두, 몇 개든 고르고, 건너뛰면 다시 묻지 않는다.
  interestsIntro: '관심 있는 카테고리를 고르세요. 여러 개 고를 수 있고, 건너뛰어도 됩니다.',
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
