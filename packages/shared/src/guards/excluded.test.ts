import { describe, expect, it } from 'vitest';
import { REPLACED_TERMS } from '../terms.js';
import {
  EXCLUDED_FEATURES,
  EXCLUDED_FEATURE_IDS,
  type ExcludedFeatureId,
  GAMBLING_WORDS,
  TERM_MEANING_PATTERNS,
  TEXT_ALLOWANCES,
  findExcludedIdentifier,
  findExcludedText,
  identifierWords,
  namesPersonalProbability,
  tokenForms,
} from './excluded.js';

const features = (text: string, scope?: 'everywhere' | 'service-guide') => [
  ...new Set(findExcludedText(text, scope ? { scope } : {}).map((hit) => hit.feature)),
];

describe('EXCLUDED_FEATURES (#113)', () => {
  it('lists each feature once, in the order of its ids, with a basis and a way to find it', () => {
    expect(EXCLUDED_FEATURES.map((feature) => feature.id)).toEqual([...EXCLUDED_FEATURE_IDS]);
    for (const feature of EXCLUDED_FEATURES) {
      expect(feature.name.trim(), feature.id).not.toBe('');
      expect(feature.basis.trim(), feature.id).not.toBe('');
      expect(feature.words.length, feature.id).toBeGreaterThan(0);
      for (const word of feature.words) expect(word.flags, feature.id).not.toContain('g');
      for (const token of feature.tokens) {
        expect(token, feature.id).toMatch(/^[a-z]+(?: [a-z]+)?$/);
      }
      // A feature with tokens is looked for beyond the screen, and only one with tokens is.
      expect(
        feature.surfaces.some((surface) => surface !== 'screen'),
        feature.id,
      ).toBe(feature.tokens.length > 0);
    }
  });

  it('looks for paid purchase on screens and public responses only, never in storage (D9)', () => {
    const paid = EXCLUDED_FEATURES.find((feature) => feature.id === 'paid-purchase');
    expect(paid?.surfaces).toEqual(['screen', 'route', 'api']);
  });

  it('looks for the term rows, 예측 and the gambling words in screen text only', () => {
    for (const id of ['replaced-term', 'prediction-word', 'gambling'] as const) {
      expect(EXCLUDED_FEATURES.find((feature) => feature.id === id)?.surfaces, id).toEqual([
        'screen',
      ]);
    }
  });

  it('takes the gambling words from the #14 term table (D21)', () => {
    expect(GAMBLING_WORDS).toEqual(['베팅', '배당', '배당률', '승률', '판돈', '당첨']);
    for (const word of GAMBLING_WORDS) expect(features(word), word).toContain('gambling');
  });

  it('finds every text row of the #14 term table, and knows how to read every meaning row', () => {
    for (const row of REPLACED_TERMS) {
      if (row.match === 'text') {
        expect(findExcludedText(row.unused).length, row.unused).toBeGreaterThan(0);
      } else {
        expect(Object.keys(TERM_MEANING_PATTERNS), row.unused).toContain(row.unused);
      }
    }
    expect(Object.keys(TERM_MEANING_PATTERNS).sort()).toEqual(
      REPLACED_TERMS.filter((row) => row.match === 'meaning')
        .map((row) => row.unused)
        .sort(),
    );
  });

  it('gives every allowance a reason, and clears only features it names', () => {
    for (const allowance of TEXT_ALLOWANCES) {
      expect(allowance.reason.trim()).not.toBe('');
      expect(allowance.features.length).toBeGreaterThan(0);
      for (const id of allowance.features) expect(EXCLUDED_FEATURE_IDS).toContain(id);
    }
  });
});

describe('findExcludedText', () => {
  it.each<[string, ExcludedFeatureId]>([
    ['확률 슬라이더를 움직여 보세요', 'probability-input'],
    ['My Forecast', 'probability-input'],
    ['Community Forecast', 'probability-input'],
    ['커뮤니티 예측', 'probability-input'],
    ['예측 수정 이력', 'probability-input'],
    ['내 점수', 'scoring'],
    ['평판', 'scoring'],
    ['카테고리 등급', 'scoring'],
    ['전체 순위 보기', 'scoring'],
    ['랭킹', 'scoring'],
    ['실력 배지', 'scoring'],
    ['Leaderboard', 'scoring'],
    ['Brier score', 'scoring'],
    ['코인 충전', 'paid-purchase'],
    ['결제하기', 'paid-purchase'],
    ['Coin 구매', 'paid-purchase'],
    ['구매 보너스', 'paid-purchase'],
    ['쿠폰 등록', 'paid-purchase'],
    ['가격표', 'paid-purchase'],
    ['1,000원', 'paid-purchase'],
    ['₩1,000', 'paid-purchase'],
    ['출석 체크', 'activity-reward'],
    ['매일 체크인', 'activity-reward'],
    ['거래량 보상', 'activity-reward'],
    ['좋아요 수에 따른 보상', 'activity-reward'],
    ['리워드 받기', 'activity-reward'],
    ['거래량 보너스 100 Coin', 'activity-reward'],
    ['글 작성 보너스', 'activity-reward'],
    ['게시글을 쓰면 보너스', 'activity-reward'],
    ['좋아요 10개마다 Coin 지급', 'activity-reward'],
    ['매일 접속하면 Coin 지급', 'activity-reward'],
    ['연속 접속 보너스', 'activity-reward'],
    ['Coin 송금', 'coin-transfer'],
    ['Coin 이체', 'coin-transfer'],
    ['Coin 선물하기', 'coin-transfer'],
    ['Coin 보내기', 'coin-transfer'],
    ['Coin을 다른 회원에게 보내기', 'coin-transfer'],
    ['친구에게 100 코인 보내기', 'coin-transfer'],
    ['출금하기', 'cash-out'],
    ['현금 환전 신청', 'cash-out'],
    ['현금화', 'cash-out'],
    ['출금 신청은 취소할 수 없습니다.', 'cash-out'],
    ['출금은 영업일에만 처리하며 주말에는 지원하지 않습니다.', 'cash-out'],
    ['예측하기', 'replaced-term'],
    ['투표', 'replaced-term'],
    ['확률 추이', 'replaced-term'],
    ['YES 확률 63%', 'replaced-term'],
    ['예', 'replaced-term'],
    ['예 63%', 'replaced-term'],
    ['정산 기준', 'replaced-term'],
    ['맞히면 100 Coin', 'replaced-term'],
    ['예측 시장', 'replaced-term'],
    ['예측가_7K2Q', 'prediction-word'],
    ['내 예측을 남기세요', 'prediction-word'],
    ['베팅', 'gambling'],
    ['배당률', 'gambling'],
    ['당첨', 'gambling'],
  ])('finds %s (%s)', (text, feature) => {
    expect(features(text)).toContain(feature);
  });

  it.each([
    '가상 Coin으로 YES/NO 계약을 호가창에서 거래하는 예측시장',
    '거래하기',
    '시장가격 추이',
    'YES 63%',
    '(예: 010-1234-5678)',
    '예약',
    '예상 체결가',
    '미결제 YES',
    '가격·시간 우선순위로 체결합니다',
    'KOSPI 상승률',
    '계좌이체',
    '보너스',
    '가입 보너스 10,000 Coin',
    '정산 지급',
    '정산하면 이긴 계약마다 100 Coin을 지급합니다.',
    '글자 수는 지급 기준과 무관합니다.',
    '인증 메일을 다시 보내기',
    'Coin의 현금 환전·출금은 제공하지 않습니다.',
    '현금으로 환전하거나 출금할 수 없습니다.',
    '환전이나 출금은 지원하지 않습니다.',
    '현금 환전·출금 기능은 제공하지 않습니다.',
    'Coin은 현금화할 수 없습니다.',
    '시장가격은 실제 발생 확률의 보장이 아닙니다.',
    '100 Coin',
    '회원 2명',
    '10원칙',
    '잘못 입력한 내용의 보상은 운영 정책을 따릅니다.',
    'underscore',
    'market-status-badge',
  ])('lets %s through', (text) => {
    expect(findExcludedText(text)).toEqual([]);
  });

  it('reports each match with its feature, text and position', () => {
    expect(findExcludedText('순위와 점수', { features: ['scoring'] })).toEqual([
      { feature: 'scoring', match: '점수', index: 4 },
      { feature: 'scoring', match: '순위', index: 0 },
    ]);
  });

  it('looks only for the features asked for', () => {
    expect(features('베팅으로 충전')).toEqual(['paid-purchase', 'gambling']);
    expect(findExcludedText('베팅으로 충전', { features: ['gambling'] })).toEqual([
      { feature: 'gambling', match: '베팅', index: 0 },
    ]);
  });

  it('clears a word only inside the phrase that allows it', () => {
    expect(features('상승률과 승률')).toEqual(['gambling']);
    expect(findExcludedText('상승률과 승률')).toEqual([
      { feature: 'gambling', match: '승률', index: 5 },
    ]);
    expect(features('우선순위와 순위')).toEqual(['scoring']);
  });

  it('allows the no-cash notice everywhere, and only as a notice', () => {
    expect(features('출금 내역이 없습니다.')).toEqual(['cash-out']);
    // One sentence's notice does not clear the next sentence.
    expect(findExcludedText('출금은 제공하지 않습니다. 출금하기')).toEqual([
      { feature: 'cash-out', match: '출금', index: 15 },
    ]);
    // The negative has to be the cash-out word's own, not another clause's.
    expect(features('출금 신청은 취소할 수 없습니다.')).toEqual(['cash-out']);
    expect(findExcludedText('환전은 수수료 없이 즉시 처리하며 출금할 수 없습니다.')).toEqual([
      { feature: 'cash-out', match: '환전', index: 0 },
    ]);
  });

  it('allows other negative notices on the service guide only (owner decision #113)', () => {
    const notice = '점수·순위를 제공하지 않습니다.';
    expect(features(notice)).toEqual(['scoring']);
    expect(features(notice, 'service-guide')).toEqual([]);
    expect(features('활동량 보상과 사용자 간 송금은 제공하지 않습니다.', 'service-guide')).toEqual(
      [],
    );
    // Not a notice: the guide may not name the feature as something on offer.
    expect(features('점수를 확인하세요.', 'service-guide')).toEqual(['scoring']);
    // Words are never cleared by a notice.
    expect(features('베팅은 할 수 없습니다.', 'service-guide')).toEqual(['gambling']);
  });
});

describe('identifiers', () => {
  it('splits an identifier into lower-case words', () => {
    expect(identifierWords('realized_pnl_coin')).toEqual(['realized', 'pnl', 'coin']);
    expect(identifierWords('realizedPnlCoin')).toEqual(['realized', 'pnl', 'coin']);
    expect(identifierWords('SETTLEMENT_PAYOUT')).toEqual(['settlement', 'payout']);
    expect(identifierWords('/admin/audit-failures')).toEqual(['admin', 'audit', 'failures']);
    expect(identifierWords('pYesBp')).toEqual(['p', 'yes', 'bp']);
    expect(identifierWords('APIKey')).toEqual(['api', 'key']);
    expect(identifierWords('[slug]')).toEqual(['slug']);
    expect(identifierWords('')).toEqual([]);
  });

  it('inflects a token', () => {
    expect(tokenForms('rank')).toEqual(
      expect.arrayContaining(['rank', 'ranks', 'ranking', 'rankings', 'ranked']),
    );
    expect(tokenForms('score')).toEqual(expect.arrayContaining(['scores', 'scoring', 'scored']));
    expect(tokenForms('withdraw')).toContain('withdrawal');
    expect(tokenForms('transfer')).toEqual(expect.arrayContaining(['transferred', 'transferring']));
    expect(new Set(tokenForms('charge')).size).toBe(tokenForms('charge').length);
  });

  it.each<[string, 'route' | 'api' | 'storage', ExcludedFeatureId]>([
    ['leaderboard', 'route', 'scoring'],
    ['/api/v1/rankings', 'api', 'scoring'],
    ['forecast_scores', 'storage', 'probability-input'],
    ['forecast_scores', 'storage', 'scoring'],
    ['userBadges', 'api', 'scoring'],
    ['ATTENDANCE_REWARD', 'storage', 'activity-reward'],
    ['coin-transfer', 'route', 'coin-transfer'],
    ['transferredCoin', 'storage', 'coin-transfer'],
    ['WITHDRAWAL', 'storage', 'cash-out'],
    ['charge-packages', 'route', 'paid-purchase'],
    ['priceKrw', 'api', 'paid-purchase'],
    ['DAILY_CHECKIN', 'storage', 'activity-reward'],
    ['/me/check-in', 'api', 'activity-reward'],
    ['checkedIn', 'api', 'activity-reward'],
    ['login_streaks', 'storage', 'activity-reward'],
    ['COIN_SEND', 'storage', 'coin-transfer'],
    ['sendCoins', 'api', 'coin-transfer'],
    ['/me/coins/send', 'route', 'coin-transfer'],
    ['probabilitySlider', 'api', 'probability-input'],
  ])('finds %s on %s (%s)', (name, surface, feature) => {
    expect(findExcludedIdentifier(name, surface).map((hit) => hit.feature)).toContain(feature);
  });

  it('reports the word and the token it matched', () => {
    expect(findExcludedIdentifier('/my/rankings', 'route')).toEqual([
      { feature: 'scoring', word: 'rankings', token: 'rank' },
    ]);
    // A two-word token: its words in a row, or the two as one.
    expect(findExcludedIdentifier('/me/check-in', 'api')).toEqual([
      { feature: 'activity-reward', word: 'check in', token: 'check in' },
    ]);
    expect(findExcludedIdentifier('CHECKINS', 'storage')).toEqual([
      { feature: 'activity-reward', word: 'checkins', token: 'check in' },
    ]);
  });

  it('keeps paid purchase out of storage (D9) and the word lists off identifiers', () => {
    expect(findExcludedIdentifier('charge_packages', 'storage')).toEqual([]);
    expect(findExcludedIdentifier('PAYMENT_CANCEL', 'storage')).toEqual([]);
    expect(findExcludedIdentifier('bet', 'storage')).toEqual([]);
  });

  it.each([
    'realizedPnlCoin',
    'SETTLEMENT_PAYOUT',
    'BONUS',
    'scope',
    'upgrade',
    'audit-failures',
    'release_setting_change',
    'my/watchlist',
    '/me/phone/send-code',
    'resendVerification',
    'coin_balance',
    'sign-in',
    'orders_qty_check',
    'checkIndex',
  ])('lets %s through', (name) => {
    for (const surface of ['route', 'api', 'storage'] as const) {
      expect(findExcludedIdentifier(name, surface), `${name} on ${surface}`).toEqual([]);
    }
  });

  it('looks only for the features asked for', () => {
    expect(findExcludedIdentifier('forecast_scores', 'storage', { features: ['scoring'] })).toEqual(
      [{ feature: 'scoring', word: 'scores', token: 'score' }],
    );
  });

  it('knows a personal probability by its words (N02 §10, N04 §5)', () => {
    for (const name of [
      'initial_prob_bp',
      'beliefBp',
      'forecastProbability',
      'CONFIDENCE',
      'user_probabilities',
      'myProbabilityBp',
      '/my/probability',
    ]) {
      expect(namesPersonalProbability(name), name).toBe(true);
    }
    for (const name of ['pYesBp', 'priceAvgBp', 'limitPrice', 'probe', 'cost_basis_coin']) {
      expect(namesPersonalProbability(name), name).toBe(false);
    }
  });
});
