import type { AnyCategorySlug } from '@buddha/shared';

/**
 * The seed's market copy, apart from seed.ts so a unit test can read it without running the
 * CLI (seed-markets.test.ts).
 */
export interface SeedMarket {
  /** Almost always a leaf: a card's header names it, and the parent lists it too. */
  category: AnyCategorySlug;
  slug: string;
  title: string;
  description: string;
  rules: string;
  resolutionSource: string;
  /**
   * 태그 (#17, ADR-0093 decision 2 #172 item 2): MARKET_TAGS_MIN..MARKET_TAGS_MAX names in the
   * order the detail shows them, each already as `normalizeTagName` leaves it (what is written
   * here is the spelling stored when the seed makes the tag), no two the same tag. Shared across
   * markets where the subject is ('서울', '기상청', '통계청'): one tag, every market of it.
   */
  tags: readonly string[];
  /**
   * `close_at` as an ISO-8601 instant (UTC; the KST wall-clock time is in the entry's comment).
   * Absolute, never relative to the seed time: each rule names an absolute cutoff, and trading
   * has to stop before the outcome is public (the slug is the idempotency key, so only the
   * first seed counts).
   */
  closeAt: string;
}

/**
 * The clause every seed rule carries: a source that publishes late keeps the market waiting for
 * its judgement, and lateness alone never makes it NO (N03 §4). A NO for an event that did not
 * happen by its deadline is a different thing and stays (N03 §2); where that line falls in
 * general is #172's to decide.
 */
export const SEED_RULE_NO_DELAY_NO = '늦어진 것만으로 NO로 판정하지 않습니다.';

/**
 * 14 markets, 2-3 per top-level category (PLAN 13 M3's 12, plus 주택 and 일자리 with the second
 * level), in the shape of Appendix B: rules that state the YES criterion, its boundary and the
 * NO side, plus a resolution source. The seed inserts them as drafts for a reviewer to check and
 * open (N03 §2, #125). The slug is the idempotency key of the seed: a market whose slug exists is
 * left exactly as it is, copy and tags included — an admin may have edited it, and the seed never
 * overwrites (Q-M3: copy refresh cadence).
 */
export const SEED_MARKETS: readonly SeedMarket[] = [
  {
    category: 'rates',
    slug: 'bok-october-rate-cut-2026',
    title: '10월 한국은행 금융통화위원회에서 기준금리가 인하될까?',
    description: '한국은행 금융통화위원회의 10월 통화정책방향 결정회의 결과를 묻는 시장입니다.',
    rules:
      '2026년 10월 정례 통화정책방향 결정회의에서 한국은행 기준금리가 직전 결정 대비 인하되면 YES로 판정합니다. 동결이나 인상은 NO입니다. 2026년 10월 31일(KST)까지 10월 결정회의가 열리지 않으면 NO로 판정합니다. 결정 결과의 발표가 늦어지면 발표를 기다려 판정하며, 발표가 늦어진 것만으로 NO로 판정하지 않습니다.',
    resolutionSource: '한국은행 보도자료(통화정책방향) https://www.bok.or.kr',
    tags: ['기준금리', '한국은행', '금통위'],
    // 2026-10-21 23:59:59 KST: the October MPC meeting is on 2026-10-22 (BOK 2026 schedule).
    closeAt: '2026-10-21T14:59:59Z',
  },
  {
    category: 'prices',
    slug: 'cpi-september-2026-above-2pct',
    title: '9월 소비자물가 상승률(전년 동월 대비)이 2.0% 이상으로 발표될까?',
    description: '통계청이 발표하는 2026년 9월 소비자물가 동향을 묻는 시장입니다.',
    rules:
      "통계청 '2026년 9월 소비자물가동향'의 소비자물가지수 전년동월비 상승률이 2.0% 이상이면 YES로 판정합니다. 1.9% 이하는 NO입니다. 공표가 늦어지면 공표를 기다려 판정하며, 공표가 늦어진 것만으로 NO로 판정하지 않습니다. 이후 정정치는 반영하지 않습니다.",
    resolutionSource: '통계청 소비자물가동향 보도자료 https://kostat.go.kr',
    tags: ['물가', 'CPI', '통계청'],
    // 2026-09-30 23:59:59 KST: the September CPI release lands in the first days of October.
    closeAt: '2026-09-30T14:59:59Z',
  },
  {
    category: 'fx',
    slug: 'krw-usd-yearend-2026-above-1400',
    title: '올해 마지막 거래일 원/달러 환율 종가가 1,400원 이상일까?',
    description: '2026년 서울외환시장 마지막 거래일의 원/달러 환율 종가를 묻는 시장입니다.',
    rules:
      '2026년 서울외환시장 마지막 거래일 원/달러 환율 종가(15:30 기준 종가, 매매기준율 아님)가 1,400.0원 이상이면 YES로 판정합니다. 1,399.9원 이하는 NO입니다. 종가가 확인되지 않으면 서울외국환중개 고시 종가로 판정합니다. 고시가 늦어지면 고시를 기다려 판정하며, 고시가 늦어진 것만으로 NO로 판정하지 않습니다.',
    resolutionSource: '서울외국환중개 환율 고시 https://www.smbs.biz',
    tags: ['환율', '원·달러', '외환시장'],
    // 2026-12-29 23:59:59 KST: 2026-12-31 is the year-end market holiday, so the last trading
    // day is 2026-12-30 and trading here stops before it opens.
    closeAt: '2026-12-29T14:59:59Z',
  },
  {
    category: 'housing',
    slug: 'seoul-apartment-price-november-2026-up',
    title: '11월 서울 아파트 매매가격지수가 전월 대비 상승할까?',
    description:
      '한국부동산원이 발표하는 2026년 11월 전국주택가격동향의 서울 아파트 매매가격지수를 묻는 시장입니다.',
    rules:
      "한국부동산원 '2026년 11월 전국주택가격동향조사'에서 서울 아파트 매매가격지수의 전월 대비 변동률이 0.00%를 초과하면 YES로 판정합니다. 0.00% 이하(보합·하락)는 NO입니다. 공표가 늦어지면 공표를 기다려 판정하며, 공표가 늦어진 것만으로 NO로 판정하지 않습니다. 이후 정정치는 반영하지 않습니다.",
    resolutionSource: '한국부동산원 전국주택가격동향조사 https://www.reb.or.kr',
    tags: ['아파트', '부동산', '서울', '한국부동산원'],
    // 2026-11-30 23:59:59 KST: the November survey is published in mid-December.
    closeAt: '2026-11-30T14:59:59Z',
  },
  {
    category: 'jobs',
    slug: 'unemployment-october-2026-below-3pct',
    title: '10월 실업률(계절조정)이 3.0% 미만으로 발표될까?',
    description: '통계청이 발표하는 2026년 10월 고용동향의 계절조정 실업률을 묻는 시장입니다.',
    rules:
      "통계청 '2026년 10월 고용동향'의 계절조정 실업률이 3.0% 미만이면 YES로 판정합니다. 3.0% 이상은 NO입니다. 공표가 늦어지면 공표를 기다려 판정하며, 공표가 늦어진 것만으로 NO로 판정하지 않습니다. 이후 정정치는 반영하지 않습니다.",
    resolutionSource: '통계청 고용동향 보도자료 https://kostat.go.kr',
    tags: ['실업률', '고용', '통계청'],
    // 2026-10-31 23:59:59 KST: the October release lands in the second week of November.
    closeAt: '2026-10-31T14:59:59Z',
  },
  {
    category: 'rain',
    slug: 'seoul-first-snow-before-nov-20-2026',
    title: '서울의 올해 첫눈이 11월 20일 이전에 관측될까?',
    description: '기상청 서울 관측소 기준 올해 첫눈 관측일을 묻는 시장입니다.',
    rules:
      '기상청이 발표하는 2026년 서울(종로구 송월동 관측소) 첫눈 관측일이 11월 19일 이전(19일 포함)이면 YES로 판정합니다. 2026년 11월 19일(KST)까지 서울에서 첫눈이 관측되지 않으면 NO로 판정합니다. 진눈깨비도 기상청이 첫눈으로 발표하면 인정합니다. 판정은 관측일 기준이며, 관측 발표가 늦어진 것만으로 NO로 판정하지 않습니다.',
    resolutionSource: '기상청 보도자료·기상자료개방포털 https://data.kma.go.kr',
    tags: ['첫눈', '서울', '기상청'],
    // 2026-11-20 00:00 KST: the rule's own cutoff.
    closeAt: '2026-11-19T15:00:00Z',
  },
  {
    category: 'rain',
    slug: 'seoul-october-2026-rain-above-50mm',
    title: '10월 서울 월 강수량이 50mm를 넘을까?',
    description: '기상청 서울 관측소의 2026년 10월 월 강수량을 묻는 시장입니다.',
    rules:
      '기상자료개방포털의 서울(108) 관측소 2026년 10월 월합계 강수량이 50.0mm를 초과하면 YES로 판정합니다. 정확히 50.0mm 이하는 NO입니다. 11월 15일까지 월자료가 공개되지 않으면 일자료 합계로 판정합니다. 자료 공개가 늦어지면 공개를 기다려 판정하며, 공개가 늦어진 것만으로 NO로 판정하지 않습니다.',
    resolutionSource: '기상자료개방포털 월자료 https://data.kma.go.kr',
    tags: ['강수량', '서울', '기상청'],
    // 2026-10-31 23:59:59 KST: end of the month being measured.
    closeAt: '2026-10-31T14:59:59Z',
  },
  {
    category: 'temperature',
    slug: 'seoul-november-2026-below-minus-5',
    title: '11월 중 서울 일 최저기온이 영하 5도 이하로 내려가는 날이 있을까?',
    description: '2026년 11월 서울의 일 최저기온을 묻는 시장입니다.',
    rules:
      '기상자료개방포털의 서울(108) 관측소 2026년 11월 1일~30일 일 최저기온 중 영하 5.0℃ 이하인 날이 하루라도 있으면 YES로 판정합니다. 모든 날이 영하 4.9℃ 이상이면 NO입니다. 자료 공개가 늦어지면 공개를 기다려 판정하며, 공개가 늦어진 것만으로 NO로 판정하지 않습니다.',
    resolutionSource: '기상자료개방포털 일자료 https://data.kma.go.kr',
    tags: ['한파', '기온', '서울', '기상청'],
    // 2026-11-30 23:59:59 KST: end of the month being measured.
    closeAt: '2026-11-30T14:59:59Z',
  },
  {
    category: 'devices',
    slug: 'korea-telco-6g-trial-2026',
    title: '연내 국내 통신 3사 중 한 곳이라도 6G 시범 서비스 개시를 공식 발표할까?',
    description: '국내 통신 3사의 6G 시범 서비스 발표 여부를 묻는 시장입니다.',
    rules:
      "2026년 12월 31일(KST)까지 SK텔레콤·KT·LG유플러스 중 한 곳이라도 자사 공식 뉴스룸 또는 보도자료로 일반 이용자 대상 '6G 시범 서비스' 개시를 발표하면 YES로 판정합니다. 기술 시연, 연구 성과 발표, 표준화 참여 발표는 제외합니다. 이 기한까지 그런 발표가 나오지 않으면 NO로 판정합니다. 기한 안에 게시된 발표는 확인이 늦어져도 인정하며, 확인이 늦어진 것만으로 NO로 판정하지 않습니다.",
    resolutionSource: '각사 공식 뉴스룸(SK텔레콤·KT·LG유플러스)',
    tags: ['6G', '통신사', 'SK텔레콤', 'KT', 'LG유플러스'],
    // 2026-12-31 23:59:59 KST: the rule's own cutoff.
    closeAt: '2026-12-31T14:59:59Z',
  },
  {
    category: 'devices',
    slug: 'samsung-trifold-korea-launch-2026',
    title: '삼성전자가 연내 국내에 3단 접이식(트라이폴드) 스마트폰을 정식 출시할까?',
    description: '삼성전자의 3단 접이식 스마트폰 국내 정식 출시 여부를 묻는 시장입니다.',
    rules:
      '2026년 12월 31일(KST)까지 삼성전자 뉴스룸이 3단 접이식(트라이폴드) 스마트폰의 국내 정식 판매 개시를 발표하면 YES로 판정합니다. 사전 예약 개시, 해외 출시, 콘셉트 공개만으로는 NO입니다. 이 기한까지 그런 발표가 나오지 않으면 NO로 판정합니다. 기한 안에 게시된 발표는 확인이 늦어져도 인정하며, 확인이 늦어진 것만으로 NO로 판정하지 않습니다.',
    resolutionSource: '삼성전자 뉴스룸 https://news.samsung.com/kr',
    tags: ['삼성전자', '스마트폰', '폴더블'],
    // 2026-12-31 23:59:59 KST: the rule's own cutoff.
    closeAt: '2026-12-31T14:59:59Z',
  },
  {
    category: 'movies',
    slug: 'november-2026-korean-film-3m-in-2-weeks',
    title: '11월 개봉 한국 영화 중 개봉 2주 안에 누적 관객 300만을 넘는 작품이 나올까?',
    description: '2026년 11월 개봉 한국 영화의 초반 흥행을 묻는 시장입니다.',
    rules:
      '영화진흥위원회 통합전산망(KOBIS) 기준으로 2026년 11월 1일~30일에 국내 개봉한 한국 영화 중 개봉일을 포함한 14일 안에 누적 관객 300만 명 이상을 기록한 작품이 하나라도 있으면 YES로 판정합니다. 해당 작품이 없으면 NO입니다. 재개봉작은 제외합니다. 집계 공개가 늦어지면 공개를 기다려 판정하며, 공개가 늦어진 것만으로 NO로 판정하지 않습니다.',
    resolutionSource: '영화진흥위원회 통합전산망 https://www.kobis.or.kr',
    tags: ['한국 영화', '박스오피스', 'KOBIS'],
    // 2026-12-13 23:59:59 KST: day 14 of a film released on 2026-11-30, the last window.
    closeAt: '2026-12-13T14:59:59Z',
  },
  {
    category: 'music',
    slug: 'melon-last-week-2026-domestic-no1',
    title: '12월 마지막 주 멜론 주간 차트 1위가 국내 아티스트의 곡일까?',
    description: '2026년 마지막 멜론 주간 차트 1위 곡을 묻는 시장입니다.',
    rules:
      '2026년 12월에 시작해 12월 안에 끝나는 마지막 멜론 주간 차트(월요일~일요일)에서 1위 곡의 아티스트가 국내 소속사 아티스트이면 YES로 판정합니다. 국내 소속사 아티스트가 아니면 NO입니다. 국내외 아티스트 합작곡은 대표 아티스트 기준으로 판정합니다. 차트 발표가 늦어지면 발표를 기다려 판정하며, 발표가 늦어진 것만으로 NO로 판정하지 않습니다.',
    resolutionSource: '멜론 차트 https://www.melon.com/chart',
    tags: ['멜론', '음원 차트', 'K-팝'],
    // 2026-12-27 23:59:59 KST: the last Mon-Sun chart week inside December is 12-21..12-27.
    closeAt: '2026-12-27T14:59:59Z',
  },
  {
    category: 'exhibitions',
    slug: 'national-museum-2026-visitors-above-4m',
    title: '국립중앙박물관의 2026년 연간 관람객이 400만 명을 넘을까?',
    description: '국립중앙박물관의 2026년 연간 관람객 수를 묻는 시장입니다.',
    rules:
      '국립중앙박물관이 공식 발표하는 2026년 연간 관람객 수(본관 기준, 특별전 포함)가 400만 명을 초과하면 YES로 판정합니다. 400만 명 이하는 NO입니다. 발표가 늦어지면 발표를 기다려 판정하며, 발표가 늦어진 것만으로 NO로 판정하지 않습니다.',
    resolutionSource: '국립중앙박물관 보도자료 https://www.museum.go.kr',
    tags: ['국립중앙박물관', '박물관', '관람객'],
    // 2026-12-31 23:59:59 KST: end of the year being counted; the announcement comes later.
    closeAt: '2026-12-31T14:59:59Z',
  },
  {
    category: 'books',
    slug: 'korea-new-books-2026-more-than-2025',
    title: '2026년 국내 신간 발행 종수가 2025년보다 많을까?',
    description: '2026년 국내 출판 신간 발행 종수를 묻는 시장입니다.',
    rules:
      '대한출판문화협회가 발표하는 2026년 신간 발행 종수(납본 기준)가 같은 기준의 2025년 종수보다 많으면 YES로 판정합니다. 같거나 적으면 NO입니다. 발표가 늦어지면 발표를 기다려 판정하며, 발표가 늦어진 것만으로 NO로 판정하지 않습니다.',
    resolutionSource: '대한출판문화협회 출판통계 https://www.kpa21.or.kr',
    tags: ['출판', '신간', '대한출판문화협회'],
    // 2026-12-31 23:59:59 KST: end of the year being counted; the announcement comes later.
    closeAt: '2026-12-31T14:59:59Z',
  },
];
