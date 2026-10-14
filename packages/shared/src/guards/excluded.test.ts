import { describe, expect, it } from 'vitest';
import { JOB_NAMES, QUEUE_NAMES } from '../jobs.js';
import { REPLACED_TERMS } from '../terms.js';
import {
  ADMIN_SCREEN_FEATURES,
  EVERY_ROUTE_PATH_FEATURES,
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
      for (const token of [...feature.tokens, ...(feature.pathTokens ?? [])]) {
        expect(token, feature.id).toMatch(/^[a-z]+(?: [a-z]+)?$/);
      }
      // A path token needs a path to be found in: a screen address or an API route.
      if (feature.pathTokens !== undefined) {
        expect(feature.surfaces, feature.id).toEqual(expect.arrayContaining(['route', 'api']));
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

  it('looks for transfers, rewards and cash-out in every route path, and only gambling words on admin screens (owner decision 2026-10-14)', () => {
    expect([...EVERY_ROUTE_PATH_FEATURES].sort()).toEqual([
      'activity-reward',
      'cash-out',
      'coin-transfer',
    ]);
    expect(ADMIN_SCREEN_FEATURES).toEqual(['gambling']);
    for (const id of EVERY_ROUTE_PATH_FEATURES) {
      expect(EXCLUDED_FEATURES.find((feature) => feature.id === id)?.surfaces, id).toContain('api');
    }
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
    ['1만원', 'paid-purchase'],
    ['1만 원', 'paid-purchase'],
    ['5천 원에 100 Coin', 'paid-purchase'],
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
    ['7일 연속 거래 시 보너스', 'activity-reward'],
    ['매일 보너스 받기', 'activity-reward'],
    ['일일 보너스', 'activity-reward'],
    ['로그인 보너스', 'activity-reward'],
    ['첫 거래 보너스', 'activity-reward'],
    ['Coin 송금', 'coin-transfer'],
    ['Coin 이체', 'coin-transfer'],
    ['Coin 선물하기', 'coin-transfer'],
    ['Coin 보내기', 'coin-transfer'],
    ['Coin을 다른 회원에게 보내기', 'coin-transfer'],
    ['친구에게 100 코인 보내기', 'coin-transfer'],
    ['Coin 전송', 'coin-transfer'],
    ['코인을 전송하세요', 'coin-transfer'],
    ['출금하기', 'cash-out'],
    ['현금 환전 신청', 'cash-out'],
    ['현금화', 'cash-out'],
    ['출금 신청은 취소할 수 없습니다.', 'cash-out'],
    ['출금은 영업일에만 처리하며 주말에는 지원하지 않습니다.', 'cash-out'],
    ['출금 내역이 없습니다.', 'cash-out'],
    ['출금되지 않은 금액', 'cash-out'],
    ['출금 불가 기간에는 신청할 수 없습니다.', 'cash-out'],
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
    '첫 가입 보너스',
    '정산 지급',
    '정산하면 이긴 계약마다 100 Coin을 지급합니다.',
    '글자 수는 지급 기준과 무관합니다.',
    '인증 메일을 다시 보내기',
    'Coin의 현금 환전·출금은 제공하지 않습니다.',
    '현금으로 환전하거나 출금할 수 없습니다.',
    '환전이나 출금은 지원하지 않습니다.',
    '현금 환전·출금 기능은 제공하지 않습니다.',
    'Coin은 현금화할 수 없습니다.',
    '현금 환전·출금은 제공되지 않습니다.',
    '환전 및 출금이 불가합니다.',
    'Coin은 현금으로 환전되지 않습니다.',
    '보유 Coin은 출금이 불가능합니다.',
    'Coin 출금 불가',
    '현금 출금 기능은 없습니다.',
    '시장가격은 실제 발생 확률의 보장이 아닙니다.',
    '100 Coin',
    '회원 2명',
    '10원칙',
    '잘못 입력한 내용의 보상은 운영 정책을 따릅니다.',
    // Contest words: the challenges (#81) revisit them (owner decision 2026-10-14 #113).
    '우승 상금과 참가비',
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
    // '없습니다' only for the feature itself: a list of withdrawals is one.
    expect(features('현금 출금 기능은 없습니다.')).toEqual([]);
    // '불가' only at the end of the sentence: a blackout period is a withdrawal's.
    expect(features('출금 불가 기간에는 신청할 수 없습니다.')).toEqual(['cash-out']);
  });

  it('allows other negative notices on the service guide only (owner decision #113)', () => {
    const notice = '점수·순위를 제공하지 않습니다.';
    expect(features(notice)).toEqual(['scoring']);
    expect(features(notice, 'service-guide')).toEqual([]);
    expect(features('활동량 보상과 사용자 간 송금은 제공하지 않습니다.', 'service-guide')).toEqual(
      [],
    );
    expect(features('점수와 순위는 제공되지 않습니다.', 'service-guide')).toEqual([]);
    // The cash-out words too: the guide's notice is no stricter for them than for the rest.
    expect(features('출금 내역이 없습니다.', 'service-guide')).toEqual([]);
    // Not a notice: the guide may not name the feature as something on offer.
    expect(features('점수를 확인하세요.', 'service-guide')).toEqual(['scoring']);
    // Gambling words are never cleared by a notice.
    expect(features('베팅은 할 수 없습니다.', 'service-guide')).toEqual(['gambling']);
  });

  it.each<[string, ExcludedFeatureId[]]>([
    // The negative of a later clause is not the hit's own: the clause ends at a connective
    // ending, a joining word or a comma.
    ['점수와 순위를 제공하며 결제는 지원하지 않습니다.', ['scoring']],
    ['점수를 보여주고 결제는 지원하지 않습니다.', ['scoring']],
    ['순위를 제공하지만 송금은 할 수 없습니다.', ['scoring']],
    ['랭킹은 매일 갱신합니다, 충전은 제공하지 않습니다.', ['scoring']],
    ['배지를 드립니다 그리고 출금은 불가합니다.', ['scoring']],
    // The cash-out words too: on the guide they are cleared by the same clause rule.
    ['환전은 즉시 처리하며 결제는 지원하지 않습니다.', ['cash-out']],
    // A negative before the hit is not its own either.
    ['결제는 지원하지 않습니다 점수는 매일 쌓입니다.', ['scoring']],
    // A list joined by commas, or a modifier clause joined by '…고', is split too: the guide
    // writes '·', '와·과' or '…하거나' instead.
    ['점수, 순위는 제공하지 않습니다.', ['scoring']],
    ['점수를 매기고 순위를 보여주는 기능은 없습니다.', ['scoring']],
  ])('clears a service-guide hit only by a negative in its own clause: %s', (text, named) => {
    expect(features(text, 'service-guide')).toEqual(named);
  });

  it.each([
    '점수를 제공하지 않으며 결제도 지원하지 않습니다.',
    '점수는 없고 순위도 없습니다.',
    '시장가격은 확률이 아니고 거래된 가격입니다.',
    '시장가격은 확률이라고 할 수 없습니다.',
    '점수를 매기거나 순위를 보여주는 기능은 없습니다.',
  ])('keeps a negative notice whose every clause is negative: %s', (notice) => {
    expect(features(notice, 'service-guide')).toEqual([]);
  });

  it.each<[string, ExcludedFeatureId[]]>([
    ['확률 입력이나 투표 기능은 없습니다.', ['probability-input', 'replaced-term']],
    ['시장가격은 확률이 아닙니다.', ['replaced-term']],
    ['이 서비스의 거래는 예측이나 투표가 아닙니다.', ['replaced-term', 'prediction-word']],
    [
      '내 예측을 남기는 기능은 제공하지 않습니다.',
      ['probability-input', 'replaced-term', 'prediction-word'],
    ],
  ])(
    'allows the #14 terms and 예측 in a negative notice on the service guide only: %s',
    (notice, named) => {
      // Owner decision 2026-10-14 #113.
      expect(features(notice).sort()).toEqual([...named].sort());
      expect(features(notice, 'service-guide')).toEqual([]);
    },
  );

  it('clears the #14 terms and 예측 on the service guide in a negative sentence only', () => {
    expect(features('확률이 오르면 투표하세요.', 'service-guide')).toEqual(['replaced-term']);
    expect(features('예측을 남기세요.', 'service-guide')).toEqual(['prediction-word']);
    // One sentence's notice does not clear the next.
    expect(findExcludedText('확률이 아닙니다. 투표하기', { scope: 'service-guide' })).toEqual([
      { feature: 'replaced-term', match: '투표', index: 10 },
    ]);
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
    ['/me/exchange', 'api', 'cash-out'],
    ['COIN_EXCHANGE', 'storage', 'cash-out'],
    ['/me/coins/convert', 'route', 'cash-out'],
    ['/me/conversion', 'api', 'cash-out'],
    ['coinConversion', 'api', 'cash-out'],
    ['CONVERSION_REQUESTS', 'storage', 'cash-out'],
    ['coin-conversions', 'route', 'cash-out'],
    ['/me/daily-bonus', 'route', 'activity-reward'],
    ['DAILY_BONUS', 'storage', 'activity-reward'],
    ['daily_bonuses', 'storage', 'activity-reward'],
    ['loginBonusClaimedAt', 'storage', 'activity-reward'],
    ['/me/coins/tip', 'route', 'coin-transfer'],
    ['/me/coins/give', 'api', 'coin-transfer'],
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

  it('looks for a path token in a path only: a screen address, or an API path when asked', () => {
    const reward = (name: string, surface: 'route' | 'api' | 'storage', path?: boolean) =>
      findExcludedIdentifier(name, surface, path ? { path } : {}).map((hit) => hit.feature);
    expect(reward('/admin/bonuses', 'route')).toEqual(['activity-reward']);
    expect(reward('/admin/bonuses', 'api', true)).toEqual(['activity-reward']);
    // The starting Coin's BONUS, as a field or a stored value.
    expect(reward('/admin/bonuses', 'api')).toEqual([]);
    expect(reward('BONUS', 'storage')).toEqual([]);
    expect(reward('signupBonusCoin', 'api')).toEqual([]);
  });

  it('keeps paid purchase out of storage (D9) and the word lists off identifiers', () => {
    expect(findExcludedIdentifier('charge_packages', 'storage')).toEqual([]);
    expect(findExcludedIdentifier('PAYMENT_CANCEL', 'storage')).toEqual([]);
    expect(findExcludedIdentifier('bet', 'storage')).toEqual([]);
  });

  it.each([
    'realizedPnlCoin',
    'SETTLEMENT_PAYOUT',
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

  it('names no transfer, activity reward or cash-out in a queue or a job name', () => {
    // A daily reward would most likely be a scheduled job crediting a ledger type the storage
    // check allows (BONUS); its name is held like a path, `bonus` included.
    const names = [...QUEUE_NAMES, ...Object.keys(JOB_NAMES), ...Object.values(JOB_NAMES)];
    expect(names).toEqual(expect.arrayContaining(['markets', 'market.close', 'ledgerAudit']));
    const found = (name: string) =>
      findExcludedIdentifier(name, 'api', { features: EVERY_ROUTE_PATH_FEATURES, path: true });
    expect(names.flatMap((name) => found(name).map((hit) => `${name}: ${hit.feature}`))).toEqual(
      [],
    );
    expect(found('ledger.daily_bonus').map((hit) => hit.feature)).toContain('activity-reward');
    expect(found('attendanceBonus').map((hit) => hit.feature)).toContain('activity-reward');
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
