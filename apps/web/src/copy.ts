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
} as const;

export type CopyKey = keyof typeof copy;
