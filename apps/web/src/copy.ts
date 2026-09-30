/** User-facing copy (Korean). Keep every UI string here; see PLAN.md Appendix A. */
export const copy = {
  appName: 'buddha',
  appDescription: '예/아니오로 미래를 예측하는 포인트 예측 시장',
  predict: '예측하기',
  yes: '예',
  no: '아니오',
  probability: '확률',
  payoutIfCorrect: '맞히면 100P',
  expectedProfit: '예상 수익',
  settlementRules: '정산 기준',
  settled: '정산 완료',
  dispute: '이의 제기',
  lightMode: '라이트 모드',
  darkMode: '다크 모드',
  comingSoon: '준비 중입니다.',
  walletNotice:
    '충전한 P는 서비스 내에서만 사용할 수 있으며, 현금으로 환전하거나 출금할 수 없습니다.',

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
  chargeTitle: 'P 충전',
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
  errCouponAmount: '1P 이상 1,000,000P 이하의 정수로 입력해 주세요.',
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
  ledgerTypeVoidRefund: '무효 환불',
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
  adminPackageAmount: 'P 금액',
  adminPackagePrice: '가격(원)',
  adminPackageOrder: '정렬',
  adminPackageAdd: '상품 추가',
  adminPackageSave: '저장',
  adminPackageDelete: '삭제',
  adminPackageActive: '판매 중',
  adminPackageInactive: '판매 중지',
  adminPackageDeleted: '상품을 삭제했습니다.',
  adminPackageSaved: '상품을 저장했습니다.',
  errPackagePrice: '가격은 P 금액을 넘을 수 없습니다.',
  adminCoupons: '쿠폰',
  adminCouponCode: '코드 (비우면 자동 생성)',
  adminCouponAmount: '지급 P',
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
  errAdjustRange: '0이 아닌 금액을 1,000,000P 이내로 입력해 주세요.',
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
  marketStatusClosed: '마감',
  marketStatusResolving: '정산 중',
  marketStatusSettled: '정산 완료',
  marketStatusVoided: '무효',
  adminMarketClosingSoon: '마감 임박',
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
  adminMarketInitialProb: '초기 확률',
  adminMarketLiquidity: '유동성 b',
  adminMarketMaxLoss: '최대 손실 ≈',
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
  adminMarketVoid: '무효',
  adminMarketVoidTitle: '시장을 무효 처리합니다',
  adminMarketVoidBody:
    '모든 참여자에게 매수 원가를 환불하고 시장을 종료합니다. 되돌릴 수 없습니다.',
  adminMarketVoidReason: '무효 사유',
  adminMarketVoided: '시장을 무효 처리했습니다.',
  adminMarketLmsr: 'LMSR 상태',
  lmsrQYes: 'q(예)',
  lmsrQNo: 'q(아니오)',
  lmsrReserve: '준비금 (최대 손실)',
  lmsrPrice: '현재가',
  lmsrNetCollected: '순 수취 P',
  lmsrOpenInterestYes: '미결제 예',
  lmsrOpenInterestNo: '미결제 아니오',
  marketTradeCount: '거래 수',
  marketTraderCount: '참여자 수',
  marketVolume: '거래량',
  marketOpenAt: '연 시각',
  marketResolvedResult: '결과',
  marketResolvedAt: '결과 확정',
  marketDisputeUntil: '이의 마감',
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
  eventResolveProposed: '결과 제안',
  eventResultChanged: '결과 변경',
  eventFinalized: '확정',
  eventVoided: '무효',
  eventRulesEdited: '정산 기준 수정',
  eventSystem: '시스템',
  eventVoidReason: '사유',
  eventRefundedAccounts: '환불 계정 수',
  eventRefundedTotal: '환불 합계',
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
  errMarketLiquidity: '유동성 b는 1 이상 1,000,000 이하, 소수점 6자리까지 입력해 주세요.',
  errMarketSlug: '슬러그는 영문 소문자·숫자·한글·하이픈 3~80자로 입력하거나 비워 두세요.',
  errMarketSlugTaken: '이미 사용 중인 슬러그입니다.',
  errMarketInvalid: '입력값을 확인해 주세요.',
  errMarketVoidReason: '사유를 1~500자로 입력해 주세요.',
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
  // A-M3-31: 마감 시각이 지난 `open` 시장도 목록에 남는다. 카운트다운이 이 문구로 바뀌고,
  // 거래는 서버가 MARKET_CLOSED로 거절한다. 상태 배지의 marketStatusClosed와는 다른 자리다.
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
  marketResolvingNotice: '결과를 확인하는 중입니다. 이의 기간이 끝나면 정산됩니다.',
  marketSettledNotice: '정산이 끝난 시장입니다.',
  marketVoidedNotice: '무효 처리된 시장입니다. 매수에 쓴 P는 모두 환불했습니다.',

  // 정산 기준 섹션 (PLAN 11.1의 Kalshi 원칙: 상세에서 접지 않는다)
  rulesSectionTitle: '정산 기준',
  rulesSource: '출처',
  rulesCloseAt: '마감',
  rulesSettlement: '정산 예정',
  rulesNone: '따로 지정된 출처가 없습니다.',

  // 확률 추이 차트
  chartLabel: '확률 추이',
  chartRangeLabel: '기간 선택',
  chartRangeDay: '1일',
  chartRangeWeek: '1주',
  chartRangeAll: '전체',
  chartEmpty: '아직 확률 기록이 없습니다.',
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

  // --- markets / trade (M4) ---
  // 매수/매도 패널. 계약 수·P·확률은 전부 호출 쪽에서 붙인다 — 값은 평범한 문자열이어야 한다.
  tradeBuy: '매수',
  tradeSell: '매도',
  // SegmentGroup의 접근 가능한 이름. 라디오 그룹은 이름이 없으면 스크린 리더가 무엇을
  // 고르는 것인지 말해 주지 못한다(chartRangeLabel과 같은 자리).
  tradeModeLabel: '입력 방식',
  tradeSideLabel: '매수 · 매도',
  tradeOutcomeLabel: '예 · 아니오',
  tradeModeAmount: 'P 금액',
  tradeModeShares: '계약 수',
  tradeUnitContracts: '계약',
  tradeAmountLabel: '금액',
  tradeMax: '최대',
  tradeHolding: '보유',
  // 견적 요약 (PLAN 11.1-2): "N계약 · 평균 63P · 맞히면 N×100P (수익 +X P)".
  tradeContracts: '계약 수',
  tradeAvgPrice: '평균가',
  tradePayout: '맞히면 지급',
  tradeProfit: '예상 수익',
  tradeAfterProb: '거래 후 확률',
  // 슬리피지 허용치는 숨기지 않고 절대 금액으로 보여 준다.
  tradeMaxCost: '최대 지불',
  tradeMinProceeds: '최소 수령',
  tradeLoginToTrade: '로그인하고 예측하기',
  tradeCharge: '충전하기',
  tradeBought: '매수가 완료되었습니다.',
  tradeSold: '매도가 완료되었습니다.',
  // PRICE_MOVED(409) 뒤의 재확인 단계. 새 견적을 보고 한 번 더 눌러야 주문이 나간다.
  tradePrevious: '이전',
  tradeReconfirm: '가격이 바뀌었습니다. 새 견적으로 다시 눌러 주세요.',
  errTradeTooSmall: '한 계약도 살 수 없는 금액입니다.',
  errTradeAmount: '금액은 1P 이상으로 입력해 주세요.',
  errTradeShares: '계약 수는 1 이상 1,000,000 이하로 입력해 주세요.',
  errTradeSharesMax: '보유할 수 있는 계약 수를 넘습니다.',
  errTradeNoPosition: '보유한 계약이 없습니다.',
  errTradePosition: '보유한 계약보다 많이 팔 수 없습니다.',
  errTradeBalance: '잔고가 부족합니다.',
  errTradeClosed: '마감된 시장입니다.',
  errTradeDuplicate: '이미 처리된 주문입니다. 잔고와 포지션을 확인해 주세요.',
  errTradeNotFound: '시장을 찾을 수 없습니다.',
  errTradeQuote: '견적을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',

  // --- settlement · disputes (M5, PLAN 5.5 · 11.3 · 12) ---
  // 관리자 정산 제안·결과 변경 대화상자. "이의 기간 후 자동 확정"이 PLAN §12가 요구하는 확인 문구다.
  adminMarketResolve: '정산',
  adminMarketResolveTitle: '결과를 제안합니다',
  adminMarketResolveBody:
    '선택한 결과로 정산을 제안합니다. 이의 기간(24시간)이 끝나면 자동으로 확정되고 맞힌 계약에 100P씩 지급됩니다.',
  adminMarketResolveResult: '결과',
  adminMarketResolveNote: '메모',
  adminMarketResolveEvidence: '근거 URL',
  adminMarketResolveEvidencePlaceholder: 'https://',
  adminMarketResolved: '정산을 제안했습니다.',
  adminMarketResolvedUntil: '이의 마감',
  adminMarketChangeResult: '결과 변경',
  adminMarketChangeResultTitle: '결과를 변경합니다',
  adminMarketChangeResultBody:
    '결과를 바꾸면 이의 기간이 처음부터 다시 시작됩니다. 이미 접수된 이의는 그대로 남습니다. 계속할까요?',
  adminMarketResultChanged: '결과를 변경했습니다.',
  errMarketResultRequired: '결과를 선택해 주세요.',
  errMarketResultUnchanged: '현재 결과와 같습니다. 다른 결과를 선택해 주세요.',
  errMarketResolveNote: '메모는 1,000자 이하로 입력해 주세요.',
  errMarketResolveEvidence: 'http 또는 https로 시작하는 500자 이하의 URL을 입력해 주세요.',
  // 이의 기간이 끝나 확정을 기다리는 시장의 결과는 바꿀 수 없다(무효만 가능).
  errMarketDisputeWindowOver: '이의 기간이 끝나 확정을 기다리는 중입니다. 결과를 바꿀 수 없습니다.',
  adminMarketDisputes: '이의',
  adminMarketDisputesOpen: '접수',
  adminMarketDisputesAccepted: '수용',
  adminMarketDisputesRejected: '기각',
  adminMarketDisputesLink: '이의 목록 보기',
  // 관리자 이의 목록 (PLAN 12): 시장별 그룹, 수용·기각 + 메모. 수용해도 결과는 자동으로 바뀌지 않는다.
  adminDisputes: '이의',
  adminDisputesTitle: '이의 목록',
  adminNoDisputes: '이의가 없습니다.',
  adminDisputeStatusFilter: '상태',
  adminDisputeStatusAll: '전체',
  adminDisputeMarketFilter: '시장',
  adminDisputeAllMarkets: '전체 시장',
  adminDisputeFiledBy: '제기자',
  adminDisputeFiledAt: '접수 시각',
  adminDisputeReviewedAt: '처리 시각',
  adminDisputeAccept: '수용',
  adminDisputeReject: '기각',
  adminDisputeAcceptTitle: '이의를 수용합니다',
  adminDisputeAcceptBody:
    '이의를 수용으로 표시합니다. 결과를 실제로 바꾸려면 시장 상세에서 「결과 변경」을 따로 눌러야 합니다. 메모는 제기자에게 보입니다.',
  adminDisputeRejectTitle: '이의를 기각합니다',
  adminDisputeRejectBody: '이의를 기각으로 표시합니다. 메모는 제기자에게 보입니다.',
  adminDisputeReviewNote: '처리 메모 (제기자에게 보입니다)',
  adminDisputeReviewed: '이의를 처리했습니다.',
  disputeStatusOpen: '접수',
  disputeStatusAccepted: '수용',
  disputeStatusRejected: '기각',
  // 사용자 이의 제기 (PLAN 11.3): resolving 상태에서만, 시장당 한 번.
  disputeTitle: '이의 제기',
  disputeOpen: '이의 제기',
  disputeIntro: '제안된 결과가 정산 기준과 다르다고 생각하면 이의 마감 전에 알려 주세요.',
  disputeReason: '사유',
  disputeReasonHint: '어떤 근거로 결과가 잘못되었는지 적어 주세요.',
  disputeEvidence: '근거 URL (선택)',
  disputeSubmit: '이의 제기',
  disputeFiled: '이의를 접수했습니다. 관리자가 확인한 뒤 결과가 바뀔 수 있습니다.',
  disputeFiledState: '이의 접수됨',
  disputeFiledAt: '접수 시각',
  disputeAlreadyFiled: '이미 이의를 제기했습니다.',
  disputeWindowClosed: '이의 기간이 끝났습니다.',
  disputeNotResolving: '지금은 이의를 제기할 수 없습니다.',
  disputeLoginToFile: '로그인하면 이의를 제기할 수 있습니다.',
  disputeWindowUntil: '이의 마감',
  disputeAdminNote: '관리자 메모',
  disputeStatus: '처리 상태',
  errDisputeReason: '사유를 1~2,000자로 입력해 주세요.',
  errDisputeEvidence: 'http 또는 https로 시작하는 500자 이하의 URL을 입력해 주세요.',
  // 정산 완료 안내: 지급은 이미 잔고에 반영됐고 내 손익은 아래 내 포지션이 말한다.
  marketSettledPayout:
    '맞힌 계약은 100P씩 지급되었고, 내 손익은 아래 내 포지션에서 볼 수 있습니다.',
  // 관리자 이벤트 로그의 정산 행: 확정 요약(worker market-finalize)과 무효가 버린 제안(A-M3-23).
  eventSettledAccounts: '정산 계정 수',
  eventPaidAccounts: '지급 계정 수',
  eventPaidTotal: '지급 합계',
  eventDiscardedResult: '취소된 제안 결과',
  adminDisputeNotFound: '이의를 찾을 수 없습니다.',

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
    'P는 {{serviceName}}의 예측 시장에서 예·아니오 계약을 사고파는 데 쓰는 서비스 전용 포인트입니다. 아래 상품 가운데 하나를 골라 충전할 수 있습니다.',
  chargeGuideDelivery:
    '결제는 {{pgName}}의 결제 창에서 카드로 진행되며, 가격에는 부가가치세가 포함되어 있습니다. 결제가 승인되면 P가 바로 지갑에 충전됩니다. 충전하려면 로그인이 필요합니다.',
  chargeGuidePrice: '결제 금액',
  chargeGuideNoticeTitle: '충전 전에 확인해 주세요',
  chargeGuideRefundSummary:
    '결제가 승인된 때부터 {{refundWindowDays}}일 이내이고 그 결제로 충전된 P를 전혀 쓰지 않았다면 결제 금액 전액을 환불받을 수 있습니다. 쿠폰·정산 등 결제 없이 받은 P는 환불되지 않습니다.',
  chargeGuideRefundLink: '환불정책 자세히 보기',
  chargeGuideLoadError: '충전 상품을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',

  // --- 실명·휴대전화와 온보딩 (ADR-0043) ---
  // 결제 창의 구매자 정보(BuyerName/BuyerTel)로 쓰인다. 본인인증은 아직 없어서 형식만 확인하고
  // 입력한 그대로 저장한다. 규칙은 @buddha/shared의 realNameSchema·phoneSchema(lib/contact-form.ts)다.
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

  // --- 스마트로페이 결제 창 · 결제 결과 · 결제 내역 · 관리자 환불 (ADR-0042) ---
  // 결제 창(PC 레이어, 모바일 페이지 이동)에서 돌아온 지갑의 안내와, 관리자의 청약철회 환불.
  // 기한 7일과 최소 1,000원은 @buddha/shared의 PAYMENT_REFUND_WINDOW_DAYS·CARD_MIN_PRICE_KRW와
  // 같아야 한다(smartro-payments.test.ts가 확인한다).
  chargeApproving: '결제를 승인하고 있습니다. 잠시만 기다려 주세요.',
  chargeWindowFailed: '결제 창을 열지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.',
  chargeContactRequired: '결제하려면 실명과 휴대전화 번호를 먼저 등록해 주세요.',
  chargeBelowCardMinimum: '1,000원 미만 상품은 결제 창에서 결제할 수 없습니다.',
  chargePackageSelected: '선택한 상품',
  paymentResultSucceeded: '결제가 완료되어 P가 충전되었습니다.',
  // 실패는 대개 청구가 없지만, 승인이 PG 오류 코드(9999 등)로 답한 결제는 카드가 청구됐을 수 있어
  // 관리자가 확인한다(「확인 필요」). 그래서 청구가 없다고 단정하지 않고, 보이면 알려 달라고 한다.
  // 결제창은 카드 말고도 간편결제·계좌이체·휴대폰을 보이고 실패한 결제에는 수단이 없으므로 수단을
  // 가리지 않고, 몇 주 뒤의 명세서가 아니라 곧바로 오는 승인 알림·이용 내역을 가리킨다.
  paymentResultFailed:
    '결제가 완료되지 않았습니다. 카드나 결제 수단의 승인·이용 내역에 이 결제가 보이면 고객센터로 알려 주세요.',
  paymentResultStopped: '결제를 취소했습니다. 청구된 금액은 없습니다.',
  paymentResultPending:
    '결제 결과를 확인하고 있습니다. 확인되면 이 화면과 결제 내역에 반영되며, 오래 걸리면 고객센터로 문의해 주세요.',
  // 취소가 확인된 결제에만 보인다(확인 전의 `cancelled`는 「확인 중」 안내를 쓴다). 우리 망취소뿐
  // 아니라 결제대행사의 취소 통보, 관리자의 수동 정리로 닫힌 결제도 있어 누가 취소했는지는 말하지
  // 않는다 — 그 까닭은 아래 「사유」 줄이 말한다(망취소·취소 통보·수동 정리가 저마다의 사유를 적는다).
  paymentResultCancelled:
    '결제가 승인된 뒤 취소되어 P는 충전되지 않았습니다. 카드사에 따라 취소가 반영되기까지 며칠이 걸릴 수 있습니다.',
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
    '결제 금액 전액을 결제대행사에서 취소하고, 이 결제로 충전된 P를 모두 회수합니다. 승인 후 7일 이내이고 회원이 그 P를 전혀 쓰지 않았을 때(사용 가능 잔고가 그 P 이상)만 환불됩니다.',
  adminPaymentRefundRetryTitle: '환불을 다시 시도합니다',
  // 「환불 처리 중」은 취소의 답이 없었던 결제만이 아니다: 거절된 재시도, 재시도가 넘겨받은 첫 시도,
  // 부분 취소가 기록된 결제도 남는다(`settle_required`). 그래서 답이 없었다고 말하지 않는다.
  adminPaymentRefundRetryBody:
    '이전 환불 요청에서 P는 이미 회수했고, 카드 취소는 아직 확인되지 않았습니다. 결제대행사에 취소를 다시 요청합니다(거절되면 가맹점 관리자에서 확인한 뒤 「수동 정리」로 정리합니다).',
  adminPaymentRefundReason: '환불 사유',
  adminPaymentRefundReasonHint: '감사 기록에 남고, 결제대행사에 취소 사유로도 전달됩니다.',
  adminPaymentRefundSubmit: '환불하기',
  adminPaymentRefunded: '환불했습니다. 결제를 취소하고 P를 회수했습니다.',
  refundGatewayAnswer: '결제대행사 응답:',
  errRefundReason: '환불 사유를 1~500자로 입력해 주세요.',
  errRefundPUsed: '이미 사용한 P가 있어 환불할 수 없습니다.',
  errRefundWindowClosed: '승인 후 7일이 지나 환불할 수 없습니다.',
  errRefundStatus: '환불할 수 있는 상태의 결제가 아닙니다. 목록에서 현재 상태를 확인해 주세요.',
  errRefundProvider: '이 결제는 결제대행사에서 취소할 수 없습니다.',
  // 거절 뒤 회수했던 P를 되돌렸는지는 그때 결제가 어떤 상태였는지에 달려 있다(이미 「환불 처리 중」이
  // 아니었다면 되돌리지 않는다). 그래서 단정하지 않고 목록의 현재 상태를 보게 한다.
  errRefundGatewayRefused: '결제대행사가 취소를 거절했습니다. 목록에서 현재 상태를 확인해 주세요.',
  errRefundGatewayError:
    '결제대행사의 응답을 받지 못했습니다. 결제는 「환불 처리 중」으로 남아 있으니 잠시 뒤 다시 시도해 주세요.',
  errRefundInProgress: '이전 환불 요청이 아직 처리 중입니다. 1분쯤 뒤에 다시 시도해 주세요.',
  errRefundNotFound: '결제를 찾을 수 없습니다.',
  // 거절된 재시도(또는 재시도가 넘겨받은 첫 시도, 부분 취소가 기록된 결제)는 P를 되돌리지 않고
  // 「환불 처리 중」으로 남는다(`settle_required`). 카드가 실제로 취소됐는지는 가맹점 관리자만 안다.
  errRefundSettleRequired:
    '결제대행사가 카드 취소를 거절했습니다. 회수한 P는 돌려주지 않았고, 결제는 「환불 처리 중」으로 남아 있습니다.',
  // 거절된 환불이 방금 결제를 건드렸으니 수동 정리는 2분 동안 `in_progress`로 거절된다.
  errRefundSettleRequiredHint:
    '가맹점 관리자에서 카드가 취소되었는지 확인하고, 2분쯤 지난 뒤 「수동 정리」로 정리해 주세요.',

  // --- 관리자 수동 정리 (ADR-0042) ---
  // 승인 응답·재통보·망취소·환불 취소의 결과를 API가 스스로 알 수 없어 「확인 필요」로 표시된
  // 스마트로페이 결제를, 관리자가 가맹점 관리자(스마일비즈)에서 카드 거래를 확인한 뒤 정리한다.
  adminPaymentNeedsReview: '확인 필요',
  adminPaymentSettle: '수동 정리',
  adminPaymentSettleTitle: '결제를 수동 정리합니다',
  adminPaymentSettleBody:
    '먼저 스마트로페이 가맹점 관리자(스마일비즈)에서 이 결제의 카드 거래를 주문번호로 찾아 승인·취소 여부를 확인해 주세요. 그다음 확인한 결과를 고릅니다. 정리한 결과는 감사 기록에 남고 되돌릴 수 없습니다.',
  adminPaymentSettleSites: '가맹점 관리자',
  adminPaymentSettleSiteStg: '테스트(STG)',
  adminPaymentSettleSiteReal: '운영(REAL)',
  // 가맹점 관리자 링크는 새 탭에서 열린다. 링크 이름에 붙여 미리 알린다.
  adminPaymentSettleSiteNewTab: '(새 창)',
  adminPaymentSettleMoid: '주문번호',
  adminPaymentSettleOutcome: '확인한 결과',
  adminPaymentSettleCredit: '승인 확인 · P 충전',
  adminPaymentSettleCreditHint: '승인이 확인되어 P를 충전합니다. 결제는 완료로 바뀝니다.',
  adminPaymentSettleCancelled: '취소 확인',
  adminPaymentSettleCancelledHint:
    '카드 결제가 취소된 것을 확인했습니다. P는 충전하지 않고 결제를 취소됨으로 둡니다.',
  adminPaymentSettleFailed: '실패로 닫기',
  adminPaymentSettleFailedHint: '승인되지 않은 결제로 닫습니다. P는 충전하지 않습니다.',
  adminPaymentSettleRefunded: '환불 완료',
  adminPaymentSettleRefundedHint:
    '카드 취소가 확인되어 환불을 완료합니다. 회수한 P는 돌려주지 않습니다.',
  adminPaymentSettleRestore: 'P 복원',
  adminPaymentSettleRestoreHint:
    '카드가 취소되지 않아 회수한 P를 돌려줍니다. 결제는 완료로 돌아갑니다.',
  adminPaymentSettleTid: '승인 거래번호(TID)',
  // errSettleTidRequired와 같은 조건: 성공한 승인이 기록돼 있지 않을 때다. 승인이 PG 오류 코드로
  // 답한 실패 결제(「확인 필요」의 흔한 경우)에는 응답이 기록돼 있어도 필요하다.
  adminPaymentSettleTidHint:
    '가맹점 관리자에서 확인한 승인 거래번호(TID) — 결제 기록에 성공한 승인 응답이 없을 때(응답이 없었거나 PG 오류 코드로 답한 경우) 필요',
  adminPaymentSettleReason: '정리 사유',
  adminPaymentSettleReasonHint:
    '감사 기록에 남습니다. 가맹점 관리자에서 확인한 내용을 적어 주세요.',
  adminPaymentSettleNone:
    '지금 상태에서는 정리할 결과가 없습니다. 목록에서 현재 상태를 확인해 주세요.',
  adminPaymentSettleNext: '다음',
  adminPaymentSettleBack: '뒤로',
  adminPaymentSettleConfirmBody: '아래 내용으로 정리합니다. 정리한 결과는 되돌릴 수 없습니다.',
  adminPaymentSettleSubmit: '정리하기',
  adminPaymentSettled: '수동 정리했습니다.',
  errSettleOutcome: '확인한 결과를 골라 주세요.',
  errSettleTid: '승인 거래번호(TID)는 공백 없이 영문·숫자·기호 64자 이내로 입력해 주세요.',
  // API는 성공한 승인이 기록돼 있지 않으면 tid를 요구한다: 승인 응답이 없었던 결제뿐 아니라 승인이
  // PG 오류 코드(9999, W999 …)로 답해 「확인 필요」가 된 실패 결제도(그 응답은 행에 사유로 보인다).
  errSettleTidRequired:
    '결제 기록에 성공한 승인 응답이 없어 승인 거래번호(TID)가 필요합니다. 가맹점 관리자에서 확인한 TID를 입력해 주세요.',
  errSettleReason: '정리 사유를 1~500자로 입력해 주세요.',
  // `status`는 상태가 그 결과를 허용하지 않을 때와, 결제대행사의 취소 재통보가 이 카드의 취소를
  // 알려 와 충전·P 복원을 거절할 때 모두 온다. 둘을 가르는 값이 없어 두 경우를 함께 안내한다.
  errSettleStatus:
    '지금 상태에서는 이 결과로 정리할 수 없습니다. 목록에서 현재 상태를 확인해 주세요.',
  errSettleStatusHint:
    '결제대행사의 취소 재통보가 카드 취소를 알려 온 결제는 P를 충전하거나 돌려줄 수 없으니 「취소 확인」 또는 「환불 완료」로 정리해 주세요.',
  errSettleProvider: '스마트로페이 결제만 수동 정리할 수 있습니다.',
  errSettleInProgress: '방금 처리 중인 결제입니다. 2분 뒤에 다시 시도해 주세요.',
  errSettleApprovalMismatch: '기록된 승인과 맞지 않아 P를 충전할 수 없습니다.',
  errSettleApprovalMismatchHint:
    '기록된 승인의 금액·가맹점 번호(MID)·주문번호가 이 결제와 다르거나, 기록된 승인끼리 서로 어긋나거나, 입력한 TID가 기록된 승인과 다르거나 이미 다른 결제의 것입니다. TID를 다시 확인하고, 이 결제의 승인이 아니라면 가맹점 관리자에서 카드 결제를 취소한 뒤 「취소 확인」으로 정리해 주세요.',
  errSettlePartialCancel: '부분 취소가 기록된 결제라 P를 충전하거나 돌려줄 수 없습니다.',
  errSettlePartialCancelHint:
    '결제대행사가 이 카드의 부분 취소를 알려 왔습니다. 「취소 확인」 또는 「환불 완료」로 정리한 뒤, 회원의 잔고는 「사용자」 화면의 「잔고 조정」으로 맞춰 주세요.',

  // --- generic ---
  errUnknown: '문제가 발생했습니다. 잠시 후 다시 시도해 주세요.',
  errNetwork: '서버에 연결할 수 없습니다.',
  errProfileLoad: '내 정보를 불러오지 못했습니다.',
  errUnauthenticated: '로그인이 필요합니다.',
  retry: '다시 시도',
} as const;

export type CopyKey = keyof typeof copy;
