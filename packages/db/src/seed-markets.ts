import type { AnyCategorySlug, MarketSource } from '@buddha/shared';

/**
 * The seed's market copy, apart from seed.ts so a unit test can read it without running the
 * CLI (seed-markets.test.ts).
 */
export interface SeedMarket {
  /** Almost always a leaf: a card's header names it, and the parent lists it too. */
  category: AnyCategorySlug;
  slug: string;
  title: string;
  /**
   * The rule items (#23, ADR-0097; RULE_ITEMS of @buddha/shared, in its order), each written the
   * way the admin entry would store it (trimmed, within its limits) and together passing the
   * open-items check: a reviewer checks them and opens the draft (N03 §2). 배경: two or three
   * sentences on what the question is about.
   */
  description: string;
  /** YES 조건: the YES criterion and its boundary. */
  yesCondition: string;
  /** NO 조건: the NO side, and what not happening by the event deadline means. */
  noCondition: string;
  /**
   * 사건 기한 (#172 item 8) as an ISO-8601 instant (UTC; the KST wall-clock time is in the entry's
   * comment): the deadline the rule names, or the end of the period it measures.
   */
  eventDeadline: string;
  /** 1차 출처: one official source, a name and an https address. */
  primarySource: MarketSource;
  /** 대체 출처 in priority order, only where the rule names one; none reads '없음'. */
  fallbackSources: readonly MarketSource[];
  /** 전환 조건: when the judgement moves to a 대체 출처; blank while there is none. */
  fallbackCondition: string;
  /** 장기 지연 기한 in days after the scheduled judgement: 14, or 30 for a source that is slow. */
  longDelayDays: number;
  /**
   * 지연·취소·무효 처리: waiting for a late source with SEED_RULE_NO_DELAY_NO, what happens at the
   * long-delay deadline, the VOID switch criteria, and an event cancelled or postponed (N03 §4).
   * VOID's payout is not here: one rule for every market (#173 item 9).
   */
  delayHandling: string;
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
 * The clause every seed market's 지연·취소·무효 처리 carries: a source that publishes late keeps
 * the market waiting for its judgement, and lateness alone never makes it NO (N03 §4). A NO for an
 * event that did not happen by its deadline is a different thing and stays (N03 §2): the NO
 * condition says it against the 사건 기한 (#172 item 8).
 */
export const SEED_RULE_NO_DELAY_NO = '늦어진 것만으로 NO로 판정하지 않습니다.';

/**
 * 14 markets, 2-3 per top-level category (PLAN 13 M3's 12, plus 주택 and 일자리 with the second
 * level), each with every rule item (#23, ADR-0097): the YES criterion and its boundary, the NO
 * side against the event deadline, one official source (and a fallback only where the rule names
 * one), the long-delay deadline and what a delay, a VOID and a cancelled event mean. The seed
 * inserts them as drafts for a reviewer to check and open (N03 §2, #125). The slug is the
 * idempotency key of the seed: a market whose slug exists is left exactly as it is, copy and tags
 * included — an admin may have edited it, and the seed never overwrites (Q-M3: copy refresh
 * cadence) — except for the items it never had (`seedMarkets` in seed.ts: tags, #17; the rule
 * items, #23).
 */
export const SEED_MARKETS: readonly SeedMarket[] = [
  {
    category: 'rates',
    slug: 'bok-october-rate-cut-2026',
    title: '10월 한국은행 금융통화위원회에서 기준금리가 인하될까?',
    description:
      '한국은행 금융통화위원회는 한 해에 여덟 번 통화정책방향 결정회의를 열어 기준금리를 정합니다. 2026년 10월 회의는 10월 22일로 잡혀 있습니다. 이 시장은 그 회의에서 기준금리가 내려갈지를 묻습니다.',
    yesCondition:
      '2026년 10월 정례 통화정책방향 결정회의에서 한국은행 기준금리가 직전 결정 대비 인하되면 YES로 판정합니다.',
    noCondition:
      '동결이나 인상은 NO입니다. 사건 기한(2026년 10월 31일, KST)까지 10월 결정회의가 열리지 않으면 NO로 판정합니다.',
    // 2026-10-31 23:59:59 KST: the rule's own deadline.
    eventDeadline: '2026-10-31T14:59:59Z',
    primarySource: { name: '한국은행 보도자료(통화정책방향)', url: 'https://www.bok.or.kr' },
    fallbackSources: [],
    fallbackCondition: '',
    longDelayDays: 14,
    delayHandling:
      '결정 결과의 발표가 늦어지면 발표를 기다려 판정하며, 발표가 늦어진 것만으로 NO로 판정하지 않습니다. 예정 판정 시각부터 장기 지연 기한이 지나도 10월 결정회의의 결과를 확인할 수 없으면 무효(VOID)로 판정합니다. 결정회의가 연기되어도 사건 기한 안에 열리면 그 회의의 결정으로 판정합니다.',
    tags: ['기준금리', '한국은행', '금통위'],
    // 2026-10-21 23:59:59 KST: the October MPC meeting is on 2026-10-22 (BOK 2026 schedule).
    closeAt: '2026-10-21T14:59:59Z',
  },
  {
    category: 'prices',
    slug: 'cpi-september-2026-above-2pct',
    title: '9월 소비자물가 상승률(전년 동월 대비)이 2.0% 이상으로 발표될까?',
    description:
      '통계청은 매달 초 전달의 소비자물가동향을 발표합니다. 소비자물가지수의 전년동월비 상승률은 물가가 1년 전 같은 달보다 얼마나 올랐는지를 보여 줍니다. 이 시장은 2026년 9월의 상승률이 2.0% 이상인지를 묻습니다.',
    yesCondition:
      "통계청 '2026년 9월 소비자물가동향'의 소비자물가지수 전년동월비 상승률이 2.0% 이상이면 YES로 판정합니다. 처음 공표된 값으로 판정하며 이후 정정치는 반영하지 않습니다.",
    noCondition: '사건 기한(2026년 9월 30일, KST)까지인 9월의 상승률이 1.9% 이하이면 NO입니다.',
    // 2026-09-30 23:59:59 KST: end of the month being measured.
    eventDeadline: '2026-09-30T14:59:59Z',
    primarySource: { name: '통계청 소비자물가동향 보도자료', url: 'https://kostat.go.kr' },
    fallbackSources: [],
    fallbackCondition: '',
    longDelayDays: 14,
    delayHandling:
      '공표가 늦어지면 공표를 기다려 판정하며, 공표가 늦어진 것만으로 NO로 판정하지 않습니다. 9월 물가는 그달의 조사로 정해지며 공표는 사건 기한 뒤에 나옵니다. 예정 판정 시각부터 장기 지연 기한이 지나도 9월 소비자물가동향을 확인할 수 없거나, 지수 개편 등으로 전년동월비 상승률이 나오지 않으면 무효(VOID)로 판정합니다.',
    tags: ['물가', 'CPI', '통계청'],
    // 2026-09-30 23:59:59 KST: the September CPI release lands in the first days of October.
    closeAt: '2026-09-30T14:59:59Z',
  },
  {
    category: 'fx',
    slug: 'krw-usd-yearend-2026-above-1400',
    title: '올해 마지막 거래일 원/달러 환율 종가가 1,400원 이상일까?',
    description:
      '원/달러 환율 종가는 서울외환시장의 주간 거래가 끝나는 15:30의 환율입니다. 2026년 서울외환시장의 마지막 거래일은 12월 30일입니다(12월 31일은 연말 휴장). 이 시장은 한 해를 마치는 그날의 종가를 묻습니다.',
    yesCondition:
      '2026년 서울외환시장 마지막 거래일의 원/달러 환율 종가(15:30 기준 종가, 매매기준율 아님)가 1,400.0원 이상이면 YES로 판정합니다.',
    noCondition:
      '사건 기한(2026년 12월 30일 15:30, KST)인 마지막 거래일의 종가가 1,399.9원 이하이면 NO입니다.',
    // 2026-12-30 15:30 KST: the last trading day's close.
    eventDeadline: '2026-12-30T06:30:00Z',
    primarySource: {
      name: '한국은행 경제통계시스템(ECOS) 원/달러 환율 종가',
      url: 'https://ecos.bok.or.kr',
    },
    fallbackSources: [{ name: '서울외국환중개 환율 고시', url: 'https://www.smbs.biz' }],
    fallbackCondition:
      '1차 출처에서 마지막 거래일의 15:30 종가를 확인할 수 없으면 서울외국환중개가 고시한 그날 종가로 판정합니다.',
    longDelayDays: 14,
    delayHandling:
      '종가 게시가 늦어지면 게시를 기다려 판정하며, 게시가 늦어진 것만으로 NO로 판정하지 않습니다. 예정 판정 시각부터 장기 지연 기한이 지나도 1차 출처와 대체 출처 어디에서도 그날 종가를 확인할 수 없으면 무효(VOID)로 판정합니다. 휴장일이 바뀌어 마지막 거래일이 앞당겨지면 그날의 종가로 판정하고, 사건 기한 뒤로 바뀌면 무효로 판정합니다.',
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
      '한국부동산원은 매달 전국주택가격동향조사를 발표하며, 지역별 아파트 매매가격지수의 전월 대비 변동률을 싣습니다. 2026년 11월 조사 결과는 12월 중순에 나올 예정입니다. 이 시장은 11월 서울 아파트 매매가격지수가 10월보다 올랐는지를 묻습니다.',
    yesCondition:
      "한국부동산원 '2026년 11월 전국주택가격동향조사'에서 서울 아파트 매매가격지수의 전월 대비 변동률이 0.00%를 초과하면 YES로 판정합니다. 처음 공표된 값으로 판정하며 이후 정정치는 반영하지 않습니다.",
    noCondition:
      '사건 기한(2026년 11월 30일, KST)까지인 11월의 변동률이 0.00% 이하(보합·하락)이면 NO입니다.',
    // 2026-11-30 23:59:59 KST: end of the month being measured.
    eventDeadline: '2026-11-30T14:59:59Z',
    primarySource: { name: '한국부동산원 전국주택가격동향조사', url: 'https://www.reb.or.kr' },
    fallbackSources: [],
    fallbackCondition: '',
    longDelayDays: 14,
    delayHandling:
      '공표가 늦어지면 공표를 기다려 판정하며, 공표가 늦어진 것만으로 NO로 판정하지 않습니다. 11월 변동률은 그달의 조사로 정해지며 공표는 사건 기한 뒤에 나옵니다. 예정 판정 시각부터 장기 지연 기한이 지나도 11월 조사 결과를 확인할 수 없거나, 조사 방식이 바뀌어 서울 아파트 매매가격지수의 전월 대비 변동률이 나오지 않으면 무효(VOID)로 판정합니다.',
    tags: ['아파트', '부동산', '서울', '한국부동산원'],
    // 2026-11-30 23:59:59 KST: the November survey is published in mid-December.
    closeAt: '2026-11-30T14:59:59Z',
  },
  {
    category: 'jobs',
    slug: 'unemployment-october-2026-below-3pct',
    title: '10월 실업률(계절조정)이 3.0% 미만으로 발표될까?',
    description:
      '통계청은 매달 전달의 고용동향을 발표하며, 10월 고용동향은 11월 둘째 주쯤 나옵니다. 계절조정 실업률은 계절마다 되풀이되는 변동을 덜어 낸 실업률이라 달마다 견주기 좋습니다. 이 시장은 2026년 10월의 계절조정 실업률이 3.0% 미만인지를 묻습니다.',
    yesCondition:
      "통계청 '2026년 10월 고용동향'의 계절조정 실업률이 3.0% 미만이면 YES로 판정합니다. 처음 공표된 값으로 판정하며 이후 정정치는 반영하지 않습니다.",
    noCondition:
      '사건 기한(2026년 10월 31일, KST)까지인 10월의 계절조정 실업률이 3.0% 이상이면 NO입니다.',
    // 2026-10-31 23:59:59 KST: end of the month being measured.
    eventDeadline: '2026-10-31T14:59:59Z',
    primarySource: { name: '통계청 고용동향 보도자료', url: 'https://kostat.go.kr' },
    fallbackSources: [],
    fallbackCondition: '',
    longDelayDays: 14,
    delayHandling:
      '공표가 늦어지면 공표를 기다려 판정하며, 공표가 늦어진 것만으로 NO로 판정하지 않습니다. 10월 실업률은 그달의 조사로 정해지며 공표는 사건 기한 뒤에 나옵니다. 예정 판정 시각부터 장기 지연 기한이 지나도 10월 고용동향을 확인할 수 없거나, 계절조정 실업률이 나오지 않으면 무효(VOID)로 판정합니다.',
    tags: ['실업률', '고용', '통계청'],
    // 2026-10-31 23:59:59 KST: the October release lands in the second week of November.
    closeAt: '2026-10-31T14:59:59Z',
  },
  {
    category: 'rain',
    slug: 'seoul-first-snow-before-nov-20-2026',
    title: '서울의 올해 첫눈이 11월 20일 이전에 관측될까?',
    description:
      '서울의 첫눈은 겨울을 앞두고 기상청 서울 관측소(종로구 송월동)에서 처음 관측된 눈입니다. 쌓이지 않고 녹아도 관측되면 첫눈으로 기록됩니다. 이 시장은 2026년 서울의 첫눈이 11월 20일 전에 관측될지를 묻습니다.',
    yesCondition:
      '기상청이 발표하는 2026년 서울(종로구 송월동 관측소) 첫눈 관측일이 11월 19일 이전(19일 포함)이면 YES로 판정합니다. 진눈깨비도 기상청이 첫눈으로 발표하면 인정하며, 판정은 관측일 기준입니다.',
    noCondition:
      '사건 기한(2026년 11월 19일, KST)까지 서울에서 첫눈이 관측되지 않으면 NO로 판정합니다.',
    // 2026-11-19 23:59:59 KST: the rule's own deadline, the 19th included.
    eventDeadline: '2026-11-19T14:59:59Z',
    primarySource: { name: '기상청 기상자료개방포털', url: 'https://data.kma.go.kr' },
    fallbackSources: [],
    fallbackCondition: '',
    longDelayDays: 14,
    delayHandling:
      '관측 발표가 늦어지면 발표를 기다려 판정하며, 관측 발표가 늦어진 것만으로 NO로 판정하지 않습니다. 사건 기한 안에 관측된 첫눈은 발표가 기한 뒤에 나와도 인정합니다. 예정 판정 시각부터 장기 지연 기한이 지나도 기상청의 첫눈 관측 기록을 확인할 수 없거나, 관측이 중단되어 사건 기한까지의 첫눈 여부를 정할 수 없으면 무효(VOID)로 판정합니다.',
    tags: ['첫눈', '서울', '기상청'],
    // 2026-11-20 00:00 KST: the rule's own cutoff.
    closeAt: '2026-11-19T15:00:00Z',
  },
  {
    category: 'rain',
    slug: 'seoul-october-2026-rain-above-50mm',
    title: '10월 서울 월 강수량이 50mm를 넘을까?',
    description:
      '기상청은 서울 관측소(지점 번호 108)의 강수량을 기상자료개방포털에 날마다, 달마다 공개합니다. 10월의 월합계 강수량은 그달 1일부터 31일까지 내린 비와 눈의 합계입니다. 이 시장은 2026년 10월 서울의 월합계 강수량이 50mm를 넘을지를 묻습니다.',
    yesCondition:
      '기상자료개방포털의 서울(108) 관측소 2026년 10월 월합계 강수량이 50.0mm를 초과하면 YES로 판정합니다.',
    noCondition:
      '사건 기한(2026년 10월 31일, KST)까지인 10월의 월합계 강수량이 50.0mm 이하이면 NO입니다.',
    // 2026-10-31 23:59:59 KST: end of the month being measured.
    eventDeadline: '2026-10-31T14:59:59Z',
    primarySource: { name: '기상자료개방포털 월자료', url: 'https://data.kma.go.kr' },
    fallbackSources: [{ name: '기상자료개방포털 일자료', url: 'https://data.kma.go.kr' }],
    fallbackCondition:
      '2026년 11월 15일(KST)이 지나도 1차 출처에서 10월 월자료를 확인할 수 없으면 대체 출처의 10월 1일~31일 일강수량 합계로 판정합니다.',
    longDelayDays: 30,
    delayHandling:
      '자료 공개가 늦어지면 공개를 기다려 판정하며, 공개가 늦어진 것만으로 NO로 판정하지 않습니다. 예정 판정 시각부터 장기 지연 기한이 지나도 월자료와 일자료 어느 쪽으로도 10월 강수량을 확인할 수 없거나, 관측이 빠진 날 때문에 50.0mm 초과 여부를 정할 수 없으면 무효(VOID)로 판정합니다.',
    tags: ['강수량', '서울', '기상청'],
    // 2026-10-31 23:59:59 KST: end of the month being measured.
    closeAt: '2026-10-31T14:59:59Z',
  },
  {
    category: 'temperature',
    slug: 'seoul-november-2026-below-minus-5',
    title: '11월 중 서울 일 최저기온이 영하 5도 이하로 내려가는 날이 있을까?',
    description:
      '기상청은 서울 관측소(지점 번호 108)의 일 최저기온을 기상자료개방포털에 날마다 공개합니다. 11월은 가을에서 겨울로 넘어가는 달이라 첫 추위가 오기도 합니다. 이 시장은 2026년 11월 중 서울 일 최저기온이 영하 5도 이하로 내려가는 날이 있을지를 묻습니다.',
    yesCondition:
      '기상자료개방포털의 서울(108) 관측소 2026년 11월 1일~30일 일 최저기온 중 영하 5.0℃ 이하인 날이 하루라도 있으면 YES로 판정합니다.',
    noCondition:
      '사건 기한(2026년 11월 30일, KST)까지 일 최저기온이 모두 영하 4.9℃ 이상이어서 영하 5.0℃ 이하인 날이 하루도 없으면 NO입니다.',
    // 2026-11-30 23:59:59 KST: end of the month being measured.
    eventDeadline: '2026-11-30T14:59:59Z',
    primarySource: { name: '기상자료개방포털 일자료', url: 'https://data.kma.go.kr' },
    fallbackSources: [],
    fallbackCondition: '',
    longDelayDays: 14,
    delayHandling:
      '자료 공개가 늦어지면 공개를 기다려 판정하며, 공개가 늦어진 것만으로 NO로 판정하지 않습니다. 예정 판정 시각부터 장기 지연 기한이 지나도 11월 일자료를 확인할 수 없거나, 관측이 빠진 날 때문에 영하 5.0℃ 이하인 날이 있었는지를 정할 수 없으면 무효(VOID)로 판정합니다.',
    tags: ['한파', '기온', '서울', '기상청'],
    // 2026-11-30 23:59:59 KST: end of the month being measured.
    closeAt: '2026-11-30T14:59:59Z',
  },
  {
    category: 'devices',
    slug: 'korea-telco-6g-trial-2026',
    title: '연내 국내 통신 3사 중 한 곳이라도 6G 시범 서비스 개시를 공식 발표할까?',
    description:
      '6G는 5G 다음 세대의 이동통신으로, 2030년 무렵의 상용화를 목표로 국제 표준이 만들어지고 있습니다. 국내 통신 3사는 그동안 6G 기술 시연과 연구 성과를 발표해 왔습니다. 이 시장은 2026년 안에 세 회사 중 한 곳이라도 일반 이용자 대상 6G 시범 서비스의 개시를 공식 발표할지를 묻습니다.',
    yesCondition:
      "2026년 12월 31일(KST)까지 SK텔레콤·KT·LG유플러스 중 한 곳이라도 자사 공식 뉴스룸 또는 보도자료로 일반 이용자 대상 '6G 시범 서비스' 개시를 발표하면 YES로 판정합니다. 기술 시연, 연구 성과 발표, 표준화 참여 발표는 제외합니다.",
    noCondition:
      '사건 기한(2026년 12월 31일, KST)까지 그런 발표가 나오지 않으면 NO로 판정합니다. 기술 시연, 연구 성과, 표준화 참여의 발표만 있었다면 NO입니다.',
    // 2026-12-31 23:59:59 KST: the rule's own deadline.
    eventDeadline: '2026-12-31T14:59:59Z',
    // Three newsrooms count alike; one is the primary and the other two its fallbacks in a fixed
    // order (#172 item 9), so the judgement names the one it used (#152).
    primarySource: { name: 'SK텔레콤 뉴스룸', url: 'https://news.sktelecom.com' },
    fallbackSources: [
      { name: 'KT 보도자료', url: 'https://corp.kt.com' },
      { name: 'LG유플러스 뉴스룸', url: 'https://news.lguplus.com' },
    ],
    fallbackCondition: '1차 출처에 해당 발표가 없으면 대체 출처를 순서대로 확인합니다.',
    longDelayDays: 14,
    delayHandling:
      '사건 기한 안에 게시된 발표는 확인이 늦어져도 인정하며, 확인이 늦어진 것만으로 NO로 판정하지 않습니다. 예정 판정 시각부터 장기 지연 기한이 지나도 1차 출처와 대체 출처를 확인할 수 없으면 무효(VOID)로 판정합니다. 개시 예정일만 밝힌 발표는 개시 발표가 아니며, 개시를 발표한 서비스가 그 뒤 중단되어도 판정은 바뀌지 않습니다.',
    tags: ['6G', '통신사', 'SK텔레콤', 'KT', 'LG유플러스'],
    // 2026-12-31 23:59:59 KST: the rule's own cutoff.
    closeAt: '2026-12-31T14:59:59Z',
  },
  {
    category: 'devices',
    slug: 'samsung-trifold-korea-launch-2026',
    title: '삼성전자가 연내 국내에 3단 접이식(트라이폴드) 스마트폰을 정식 출시할까?',
    description:
      '3단 접이식(트라이폴드) 스마트폰은 화면을 두 번 접었다 펼쳐 태블릿만 한 화면으로 쓰는 제품입니다. 정식 판매는 국내 매장과 온라인에서 판매가 시작되는 것으로, 사전 예약·해외 출시·콘셉트 공개와 다릅니다. 이 시장은 삼성전자가 2026년 안에 그런 제품의 국내 정식 판매 개시를 발표할지를 묻습니다.',
    yesCondition:
      '2026년 12월 31일(KST)까지 삼성전자 뉴스룸이 3단 접이식(트라이폴드) 스마트폰의 국내 정식 판매 개시를 발표하면 YES로 판정합니다.',
    noCondition:
      '사전 예약 개시, 해외 출시, 콘셉트 공개만으로는 NO입니다. 사건 기한(2026년 12월 31일, KST)까지 그런 발표가 나오지 않으면 NO로 판정합니다.',
    // 2026-12-31 23:59:59 KST: the rule's own deadline.
    eventDeadline: '2026-12-31T14:59:59Z',
    primarySource: { name: '삼성전자 뉴스룸', url: 'https://news.samsung.com/kr' },
    fallbackSources: [],
    fallbackCondition: '',
    longDelayDays: 14,
    delayHandling:
      '사건 기한 안에 게시된 발표는 확인이 늦어져도 인정하며, 확인이 늦어진 것만으로 NO로 판정하지 않습니다. 예정 판정 시각부터 장기 지연 기한이 지나도 삼성전자 뉴스룸을 확인할 수 없으면 무효(VOID)로 판정합니다. 판매 개시 예정일만 밝힌 발표는 판매 개시 발표가 아니며, 출시가 취소되거나 사건 기한 뒤로 연기된 것은 사건이 기한 안에 일어나지 않은 것으로 봅니다.',
    tags: ['삼성전자', '스마트폰', '폴더블'],
    // 2026-12-31 23:59:59 KST: the rule's own cutoff.
    closeAt: '2026-12-31T14:59:59Z',
  },
  {
    category: 'movies',
    slug: 'november-2026-korean-film-3m-in-2-weeks',
    title: '11월 개봉 한국 영화 중 개봉 2주 안에 누적 관객 300만을 넘는 작품이 나올까?',
    description:
      '영화진흥위원회 통합전산망(KOBIS)은 전국 영화관의 관객 수를 날마다 집계해 공개합니다. 개봉 2주 안에 누적 관객 300만 명을 넘으면 초반 흥행이 매우 빠른 편입니다. 이 시장은 2026년 11월에 개봉하는 한국 영화 가운데 그런 작품이 나올지를 묻습니다.',
    yesCondition:
      '영화진흥위원회 통합전산망(KOBIS) 기준으로 2026년 11월 1일~30일에 국내 개봉한 한국 영화 중 개봉일을 포함한 14일 안에 누적 관객 300만 명 이상을 기록한 작품이 하나라도 있으면 YES로 판정합니다. 재개봉작은 제외합니다.',
    noCondition:
      '사건 기한(2026년 12월 13일, KST)까지 그런 작품이 없으면 NO입니다. 사건 기한은 11월 30일에 개봉한 작품의 14일째입니다.',
    // 2026-12-13 23:59:59 KST: day 14 of a film released on 2026-11-30.
    eventDeadline: '2026-12-13T14:59:59Z',
    primarySource: { name: '영화진흥위원회 통합전산망(KOBIS)', url: 'https://www.kobis.or.kr' },
    fallbackSources: [],
    fallbackCondition: '',
    longDelayDays: 14,
    delayHandling:
      '집계 공개가 늦어지면 공개를 기다려 판정하며, 공개가 늦어진 것만으로 NO로 판정하지 않습니다. 예정 판정 시각부터 장기 지연 기한이 지나도 통합전산망의 집계를 확인할 수 없으면 무효(VOID)로 판정합니다. 개봉이 12월 이후로 연기된 작품은 11월 개봉작이 아니며, 11월에 개봉한 뒤 상영이 중단된 작품은 개봉일을 포함한 14일 안의 누적 관객으로 판정합니다.',
    tags: ['한국 영화', '박스오피스', 'KOBIS'],
    // 2026-12-13 23:59:59 KST: day 14 of a film released on 2026-11-30, the last window.
    closeAt: '2026-12-13T14:59:59Z',
  },
  {
    category: 'music',
    slug: 'melon-last-week-2026-domestic-no1',
    title: '12월 마지막 주 멜론 주간 차트 1위가 국내 아티스트의 곡일까?',
    description:
      '멜론 주간 차트는 월요일부터 일요일까지 한 주 동안의 이용량을 모아 매주 공개됩니다. 2026년 12월에 시작해 12월 안에 끝나는 마지막 차트 주간은 12월 21일부터 27일까지입니다. 이 시장은 그 주 1위 곡이 국내 아티스트의 곡일지를 묻습니다.',
    yesCondition:
      '2026년 12월에 시작해 12월 안에 끝나는 마지막 멜론 주간 차트(월요일~일요일)에서 1위 곡의 아티스트가 국내 소속사 아티스트이면 YES로 판정합니다. 국내외 아티스트 합작곡은 대표 아티스트 기준으로 판정합니다.',
    noCondition:
      '사건 기한(2026년 12월 27일, KST)에 끝나는 그 주 차트의 1위 곡 아티스트가 국내 소속사 아티스트가 아니면 NO입니다.',
    // 2026-12-27 23:59:59 KST: the end of that chart week.
    eventDeadline: '2026-12-27T14:59:59Z',
    primarySource: { name: '멜론 주간 차트', url: 'https://www.melon.com/chart/week/index.htm' },
    fallbackSources: [],
    fallbackCondition: '',
    longDelayDays: 14,
    delayHandling:
      '차트 발표가 늦어지면 발표를 기다려 판정하며, 발표가 늦어진 것만으로 NO로 판정하지 않습니다. 예정 판정 시각부터 장기 지연 기한이 지나도 그 주 주간 차트를 확인할 수 없거나, 멜론이 그 주 차트를 내지 않으면 무효(VOID)로 판정합니다. 집계 방식이 바뀌어도 멜론이 그 주의 주간 차트로 공개한 1위 곡으로 판정합니다.',
    tags: ['멜론', '음원 차트', 'K-팝'],
    // 2026-12-27 23:59:59 KST: the last Mon-Sun chart week inside December is 12-21..12-27.
    closeAt: '2026-12-27T14:59:59Z',
  },
  {
    category: 'exhibitions',
    slug: 'national-museum-2026-visitors-above-4m',
    title: '국립중앙박물관의 2026년 연간 관람객이 400만 명을 넘을까?',
    description:
      '국립중앙박물관은 해마다 그해의 관람객 수를 발표합니다. 이 시장의 관람객 수는 본관 기준이며 특별전 관람객도 셉니다. 이 시장은 2026년 한 해의 관람객이 400만 명을 넘을지를 묻습니다.',
    yesCondition:
      '국립중앙박물관이 공식 발표하는 2026년 연간 관람객 수(본관 기준, 특별전 포함)가 400만 명을 초과하면 YES로 판정합니다.',
    noCondition:
      '사건 기한(2026년 12월 31일, KST)까지인 2026년 한 해의 관람객 수가 400만 명 이하이면 NO입니다.',
    // 2026-12-31 23:59:59 KST: end of the year being counted.
    eventDeadline: '2026-12-31T14:59:59Z',
    primarySource: { name: '국립중앙박물관 보도자료', url: 'https://www.museum.go.kr' },
    fallbackSources: [],
    fallbackCondition: '',
    longDelayDays: 30,
    delayHandling:
      '발표가 늦어지면 발표를 기다려 판정하며, 발표가 늦어진 것만으로 NO로 판정하지 않습니다. 2026년 관람객 수는 사건 기한에 정해지며 발표는 그 뒤에 나올 수 있습니다. 예정 판정 시각부터 장기 지연 기한이 지나도 연간 관람객 수를 확인할 수 없거나, 본관 기준의 수를 밝히지 않아 기준과 견줄 수 없으면 무효(VOID)로 판정합니다. 휴관한 기간이 있어도 그해의 관람객 수로 판정합니다.',
    tags: ['국립중앙박물관', '박물관', '관람객'],
    // 2026-12-31 23:59:59 KST: end of the year being counted; the announcement comes later.
    closeAt: '2026-12-31T14:59:59Z',
  },
  {
    category: 'books',
    slug: 'korea-new-books-2026-more-than-2025',
    title: '2026년 국내 신간 발행 종수가 2025년보다 많을까?',
    description:
      '대한출판문화협회는 해마다 납본된 책을 바탕으로 한 해의 신간 발행 종수를 집계해 발표합니다. 발행 종수는 그해에 새로 나온 책의 가짓수입니다. 이 시장은 2026년의 신간 발행 종수가 2025년보다 많을지를 묻습니다.',
    yesCondition:
      '대한출판문화협회가 발표하는 2026년 신간 발행 종수(납본 기준)가 같은 기준의 2025년 종수보다 많으면 YES로 판정합니다.',
    noCondition:
      '사건 기한(2026년 12월 31일, KST)까지인 2026년 한 해의 신간 발행 종수가 2025년과 같거나 적으면 NO입니다.',
    // 2026-12-31 23:59:59 KST: end of the year being counted.
    eventDeadline: '2026-12-31T14:59:59Z',
    primarySource: { name: '대한출판문화협회 출판통계', url: 'https://www.kpa21.or.kr' },
    fallbackSources: [],
    fallbackCondition: '',
    longDelayDays: 30,
    delayHandling:
      '발표가 늦어지면 발표를 기다려 판정하며, 발표가 늦어진 것만으로 NO로 판정하지 않습니다. 2026년 발행 종수는 사건 기한에 정해지며 발표는 그 뒤에 나옵니다. 예정 판정 시각부터 장기 지연 기한이 지나도 2026년 신간 발행 종수를 확인할 수 없거나, 집계 기준이 바뀌어 2025년과 같은 기준으로 견줄 수 없으면 무효(VOID)로 판정합니다.',
    tags: ['출판', '신간', '대한출판문화협회'],
    // 2026-12-31 23:59:59 KST: end of the year being counted; the announcement comes later.
    closeAt: '2026-12-31T14:59:59Z',
  },
];
