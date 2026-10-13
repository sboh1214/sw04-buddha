/** User-facing copy (Korean). Keep every UI string here; see PLAN.md Appendix A. */
export const copy = {
  appName: 'buddha',
  appDescription: '예/아니오로 미래를 예측하는 가상 Coin 예측 시장',
  predict: '예측하기',
  yes: '예',
  no: '아니오',
  probability: '확률',
  expectedProfit: '예상 수익',
  settlementRules: '정산 기준',
  settled: '정산 완료',
  lightMode: '라이트 모드',
  darkMode: '다크 모드',
  comingSoon: '준비 중입니다.',
  // 지갑의 고정 안내(N01 §2). 유료 충전을 닫아(ADR-0049) 충전은 말하지 않는다. 약관·환불정책
  // 본문은 이 문장이 아니라 legal/cash-notice.ts의 원래 문장을 인용한다(#137에서 개정).
  walletNotice: 'Coin의 현금 환전·출금은 제공하지 않습니다.',

  // --- navigation / auth buttons (M1) ---
  navHome: '홈',
  navSettings: '설정',
  navWallet: '지갑',
  navAdmin: '관리자',
  balance: '잔고',
  profileMenu: '프로필 메뉴',
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

  // --- validation ---
  errEmailInvalid: '올바른 이메일 주소를 입력해 주세요.',
  errPasswordTooShort: '비밀번호는 8자 이상이어야 합니다.',
  errPasswordTooLong: '비밀번호는 128자 이하여야 합니다.',
  errPasswordMismatch: '비밀번호가 일치하지 않습니다.',
  errNicknameFormat: '닉네임은 2~20자의 한글·영문·숫자·밑줄(_)만 쓸 수 있습니다.',
  errNicknameTaken: '이미 사용 중인 닉네임입니다.',
  errRequired: '필수 항목입니다.',

  // --- login ---
  loginTitle: '로그인',
  loginSubtitle: '예측을 시작하려면 로그인하세요.',
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
  signupNotice: '가입하면 서비스 안내에 동의한 것으로 간주합니다.',

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
  settingsPassword: '비밀번호 변경',
  passwordChanged: '비밀번호를 변경했습니다.',
  passwordWrong: '현재 비밀번호가 올바르지 않습니다.',
  passwordNotSet: '아직 비밀번호가 없습니다. 설정하면 이메일로도 로그인할 수 있습니다.',
  settingsTheme: '테마',
  settingsThemeHint: '라이트/다크 모드를 전환합니다.',
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
  charge: '충전',
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
  // 공개 /charge에서 고르고 온 상품(`/wallet?package=`, ADR-0044).
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
  ledgerTypeTradeBuy: '예측 매수',
  ledgerTypeTradeSell: '예측 매도',
  ledgerTypeFee: '수수료',
  ledgerTypeSettlement: '정산 지급',
  ledgerTypeAdminAdjust: '관리자 조정',
  ledgerTypeBonus: '보너스',
  ledgerTypePaymentCancel: '결제 취소(환불)',
  ledgerTypePaymentCancelReversal: '결제 취소 복원',

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
  // 상태 배지·홈 상태 필터의 라벨 (O-5, ADR-0046). 카운트다운의 marketCloseAt '마감'·marketClosed
  // '마감됨'과는 다른 자리다.
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
  adminMarketRules: '정산 기준',
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
    '이미 예측이 진행 중인 시장입니다. 정산 기준이나 마감 시각을 바꾸면 참여자에게 영향을 줍니다. 계속할까요?',
  adminMarketOpen: '열기',
  adminMarketOpened: '시장을 열었습니다.',
  adminMarketClose: '마감',
  adminMarketCloseTitle: '시장을 마감합니다',
  adminMarketCloseBody: '마감하면 더 이상 예측할 수 없습니다. 계속할까요?',
  adminMarketClosed: '시장을 마감했습니다.',
  // 관리자 상세의 거래 현황: 체결·포지션에서 나온 값만 보인다(직접 AMM 상태는 #125에서 지웠다).
  adminMarketTradeStats: '거래 현황',
  tradeStatsLastPrice: '현재가',
  tradeStatsNetCollected: '순 수취 코인',
  tradeStatsOpenInterestYes: '미결제 예',
  tradeStatsOpenInterestNo: '미결제 아니오',
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
  eventRulesEdited: '정산 기준 수정',
  eventSystem: '시스템',
  eventRulesBefore: '이전',
  eventRulesAfter: '이후',
  payloadUnreadable: '표시할 수 없는 내용',
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
  errMarketRulesRequired: '정산 기준을 채워야 시장을 열 수 있습니다.',
  errMarketRulesOpen: '열린 시장의 정산 기준은 비울 수 없습니다.',
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

  // --- markets (M4) ---
  // 홈 (PLAN 11.3, ADR-0041 Kalshi 형): 헤더 2단의 상위 카테고리 · 왼쪽 세부 분류 · 정렬 · 검색.
  // 카테고리 목록은 API가 주고 '전체'만 붙인다.
  homeTitle: '예측 시장',
  marketsAll: '전체',
  // 세부 분류 사이드바의 첫 줄 — 상위 카테고리 하나의 전체 시장(Kalshi의 "All markets").
  marketsAllInCategory: '전체 시장',
  marketCategories: '카테고리',
  marketSubcategories: '세부 분류',
  marketSort: '정렬',
  sortVolume: '거래량',
  sortClosing: '마감임박',
  sortNewest: '신규',
  marketStatusFilter: '상태',
  searchLabel: '시장 검색',
  // Kalshi의 "Trade on anything". 라벨은 searchLabel이 따로 지므로 자리 표시자는 초대장이어도 된다.
  searchPlaceholder: '무엇이든 예측해 보세요',
  searchSubmit: '검색',
  marketsEmpty: '아직 열린 시장이 없습니다.',
  marketsSearchEmpty: '검색 결과가 없습니다.',
  // 카드의 두 줄(예/아니오) 오른쪽 배수 "2.14x" 앞에 스크린리더에만 읽히는 설명. '배당'은 금지어(부록 A).
  payoutMultiple: '맞히면 투입 대비',
  // 카드 오른쪽 아래 24시간 추이 — 시각적으로는 선 하나, 이름은 여기서 붙인다.
  marketSparkline: '24시간 확률 추이',

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
  marketLoginToSeePosition: '로그인하면 내 포지션을 볼 수 있습니다.',

  // 상태별 안내 (PLAN 11.3). 색과 배지는 MARKET_STATUS_LABEL/PALETTE가 맡고, 이 문구는
  // 그 아래에서 "지금 무엇을 할 수 있는지"를 말한다.
  marketClosedNotice: '마감된 시장입니다. 더 이상 예측할 수 없습니다.',
  marketResolvedNotice: '결과가 판정되었습니다. 정산을 진행하고 있습니다.',
  marketSettledNotice: '정산이 끝난 시장입니다.',
  // 원금 환불을 약속하지 않는다(N03 §6). 무효 지급 방식은 #126이 정한다.
  marketVoidedNotice: '무효 처리된 시장입니다.',

  // 정산 기준 섹션 (PLAN 11.1의 Kalshi 원칙: 상세에서 접지 않는다)
  rulesSectionTitle: '정산 기준',
  rulesSource: '출처',
  rulesCloseAt: '마감',
  rulesNone: '따로 지정된 출처가 없습니다.',

  // 확률 추이 차트
  chartLabel: '확률 추이',
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
  chartTableCaption: '시각별 확률',
  chartTime: '시각',
  chartValue: '확률',
  probabilityChange: '확률 변화',

  // 포지션 한 줄 (상세의 내 포지션과 포트폴리오 목록이 같이 쓴다)
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

  // 포트폴리오 (PLAN 11.3). 합계는 행 라벨과 헷갈리지 않도록 '총'을 붙인다.
  portfolioTitle: '포트폴리오',
  portfolioBalance: '잔고 요약',
  portfolioValue: '총 평가 금액',
  portfolioUnrealizedPnl: '총 평가손익',
  portfolioRealizedPnl: '총 실현 손익',
  portfolioPositions: '보유 포지션',
  portfolioPositionsEmpty: '아직 보유한 포지션이 없습니다.',
  portfolioSettled: '정산 이력',
  portfolioSettledEmpty: '아직 정산된 포지션이 없습니다.',
  portfolioOrders: '주문 이력',
  portfolioOrdersEmpty: '아직 주문 내역이 없습니다.',
  /**
   * Shown when the session ends while a private screen is still mounted — never a load failure,
   * because nothing failed to load. The reader is told what actually happened and given the way
   * back to the same screen.
   */
  portfolioSignedOut: '로그인이 풀렸습니다. 다시 로그인하면 이어서 볼 수 있습니다.',

  // 상단 네비와 모바일 하단 탭. 홈/지갑/설정 라벨은 M1 블록에 이미 있다.
  // 헤더 1단(ADR-0041): 시장 · 랭킹 · 커뮤니티. 2단은 시장의 상위 카테고리다.
  navMarkets: '시장',
  navRanking: '랭킹',
  navCommunity: '커뮤니티',
  navPrimary: '주 메뉴',
  navPortfolio: '포트폴리오',
  navMenu: '메뉴',

  // --- community (placeholder) ---
  // 헤더가 가리키는 자리는 있어야 하므로 화면은 있고, 기능은 아직 없다.
  communityTitle: '커뮤니티',
  communityComingSoon:
    '커뮤니티는 준비 중입니다. 예측을 두고 이야기 나눌 자리가 곧 열립니다. 그때까지는 시장과 랭킹을 둘러봐 주세요.',

  // 관리자 시장 폼의 미리보기 (Q-M3-6): 실제 카드·정산 기준 컴포넌트를 그대로 그린다.
  adminMarketPreview: '미리보기',
  adminMarketPreviewCard: '카드 미리보기',
  adminMarketPreviewDetail: '상세 미리보기',

  // --- markets / 체결 없음 · 거래 공백 (#125) ---
  // 첫 체결 전의 가격 자리(N02 §5): 초기 설정값을 가격처럼 보이지 않는다. 카드·상세·차트·관리자 목록·
  // 포트폴리오가 같은 문구를 쓴다.
  noFills: '체결 없음',
  // 주문 영역 자리의 안내(오너 결정 #125 (a)): CLOB 주문(#119·#66)이 들어올 때까지 거래할 수 없다.
  tradePreparing: '거래 준비 중',
  // 계약 수 단위. 수량은 호출 쪽에서 붙인다.
  unitContracts: '계약',

  // --- 판정 · 정산 (PLAN 5.5 · 11.3 · 12, ADR-0046) ---
  // 관리자 판정 대화상자. 판정은 즉시 확정되고 바로 정산이 시작된다(이의 단계 없음).
  // 확인 버튼 라벨 '정산' → '판정' 변경은 #14 소관이다.
  adminMarketResolve: '정산',
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
  // 정산 완료 안내: 지급은 이미 잔고에 반영됐고 내 손익은 아래 내 포지션이 말한다.
  marketSettledPayout:
    '맞힌 계약은 100 Coin씩 지급되었고, 내 손익은 아래 내 포지션에서 볼 수 있습니다.',
  // 관리자 이벤트 로그의 정산 행: 정산 요약(worker market-finalize).
  eventSettledAccounts: '정산 계정 수',
  eventPaidAccounts: '지급 계정 수',
  eventPaidTotal: '지급 합계',

  // --- leaderboard (M6 선택) ---
  // 순위는 실현 손익 기준이고, 아직 아무것도 실현하지 않은 계정은 목록에 없다.
  leaderboardTitle: '실현 손익 순위',
  leaderboardIntro:
    '정산과 매도로 확정된 손익의 합계 기준 상위 20명입니다. 아직 확정된 손익이 없는 계정은 표시되지 않습니다.',
  leaderboardRank: '순위',
  leaderboardNickname: '닉네임',
  leaderboardRealizedPnl: '실현 손익',
  leaderboardEmpty: '아직 확정된 손익이 있는 계정이 없습니다.',
  errLeaderboardLoad: '순위를 불러오지 못했습니다.',
  leaderboardLink: '전체 순위 보기',

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
    'Coin은 {{serviceName}}의 예측 시장에서 예·아니오 계약을 사고파는 데 쓰는 서비스 전용 재화입니다. 아래 상품 가운데 하나를 골라 충전할 수 있습니다.',
  chargeGuideDelivery:
    '결제는 {{pgName}}의 결제 창에서 카드로 진행되며, 가격에는 부가가치세가 포함되어 있습니다. 결제가 승인되면 Coin이 바로 지갑에 충전됩니다. 충전하려면 로그인이 필요합니다.',
  chargeGuidePrice: '결제 금액',
  chargeGuideNoticeTitle: '충전 전에 확인해 주세요',
  chargeGuideRefundSummary:
    '결제가 승인된 때부터 {{refundWindowDays}}일 이내이고 그 결제로 충전된 Coin을 전혀 쓰지 않았다면 결제 금액 전액을 환불받을 수 있습니다. 쿠폰·정산 등 결제 없이 받은 Coin은 환불되지 않습니다.',
  chargeGuideRefundLink: '환불정책 자세히 보기',
  chargeGuideLoadError: '충전 상품을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',

  // --- 실명·휴대전화와 온보딩 (ADR-0043) ---
  // 결제의 구매자 정보로 쓰려고 받는다(수집 목적 안내는 #58에서 고친다). 본인인증은 아직 없어서
  // 형식만 확인하고 입력한 그대로 저장한다. 규칙은 @buddha/shared의 realNameSchema·phoneSchema(lib/contact-form.ts)다.
  realName: '실명',
  realNameHint: '2~30자의 문자(한글·영문 등). 띄어쓰기와 가운뎃점(·)을 쓸 수 있습니다.',
  phone: '휴대전화 번호',
  phonePlaceholder: '010-1234-5678',
  phoneHint: '하이픈(-)은 넣어도 되고 빼도 됩니다.',
  contactVerificationNotice:
    '본인인증은 추후 도입 예정입니다. 지금은 입력한 실명과 번호를 그대로 저장합니다.',
  contactPrivacyLink: '개인정보처리방침 보기',
  errRealNameRequired: '실명을 입력해 주세요.',
  errRealNameFormat:
    '실명은 2~30자의 문자(한글·영문 등)로 입력해 주세요. 숫자와 기호는 쓸 수 없고, 띄어쓰기와 가운뎃점(·)은 글자 사이에만 쓸 수 있습니다.',
  errPhoneRequired: '휴대전화 번호를 입력해 주세요.',
  errPhoneFormat:
    '010·011·016~019로 시작하는 휴대전화 번호 10~11자리를 입력해 주세요. (예: 010-1234-5678)',
  onboardingTitle: '실명·연락처 입력',
  onboardingSignedOut: '로그인이 풀렸습니다. 다시 로그인하면 이어서 입력할 수 있습니다.',
  onboardingSubtitle:
    '결제에 필요한 실명과 휴대전화 번호를 입력해 주세요. 입력을 마치면 서비스를 계속 이용할 수 있습니다.',
  onboardingSubmit: '저장하고 계속하기',
  contactSaved: '실명과 휴대전화 번호를 저장했습니다.',
  settingsContact: '실명·연락처',
  settingsContactHint: '결제할 때 구매자 정보로 전달됩니다.',
  setPasswordContactHeading: '결제에 쓰일 실명과 휴대전화 번호도 입력해 주세요.',
  // 비밀번호는 이미 저장된 뒤라 이 화면에서 다시 시도할 수 없다(설정 완료 안내로 바뀐다).
  setPasswordContactFailed:
    '비밀번호는 저장했지만 실명·연락처를 저장하지 못했습니다. 다음 화면에서 다시 입력해 주세요.',
  // 비밀번호는 저장한 뒤, 다른 탭이 다른 계정으로 로그인해 연락처 요청이 거절됐을 때(A-PG-24).
  // 지금 쿠키의 계정에 /onboarding을 권하면 안 되므로, 원래 계정으로 다시 로그인하라고만 한다.
  setPasswordContactSessionChanged:
    '비밀번호는 저장했지만, 그사이 로그인한 계정이 바뀌어 실명·연락처는 저장하지 않았습니다. 원래 계정으로 다시 로그인하면 이어서 입력할 수 있습니다.',

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
