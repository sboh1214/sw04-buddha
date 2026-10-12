# 00 경쟁 서비스 비교 · Competitive Benchmark

PRODUCT PLANNING / 00

가상 Coin으로 미래 사건을 거래하고 결과를 확인한다..

통합본 완성 · v1.1 · 2026.10.04

### 문서의 목적과 읽는 법

Kalshi · Polymarket · Metaculus의 기존 비교를 보존하고 Buddha 적용안을 거래 중심으로 개정했다. 직접 확률 입력·Community Forecast는 제외하며 스코어링은 미정이다. 경쟁사 정보는 기존 조사 시점의 비교이며 이번 개정은 경쟁사 전체 기능의 최신 재조사를 의미하지 않는다.

**읽는 기준** — 경쟁사 열은 기능의 역할을 요약한다. “별도 기능 아님”은 해당 서비스의 주된 제품 모델에 해당하지 않는다는 뜻이며, 전체 제품에 대한 부재 단정은 아니다. “확인 필요”는 기존 대화의 내용을 최신 공식 자료로 충분히 확인하지 못한 항목이다. Buddha 열의 MVP·후속 항목은 제안이며 출시 확정 사양이 아니다.

이전 대화의 전체 구조·기능 비교·경제·평가 논의를 통합했다. 핵심 메커니즘은 아래 공식 자료를 다시 확인했고, 지역별 서비스·실험 UI·프로모션 차이는 포괄하지 않는다. Kalshi의 이벤트 계약과 Polymarket의 글로벌 문서상 서비스를 비교 범위로 삼는다.

### 1. 네 서비스의 전체 구조

| 비교 항목 | Kalshi | Polymarket | Metaculus | Buddha · 기획 방향 |
|---|---|---|---|---|
| 서비스 성격 | Prediction Market | Prediction Market | Forecasting Platform | 가상 Coin 기반 Prediction Market |
| 핵심 행동 / 입력 | 계약 매수·매도 / 주문 | 결과 토큰 매수·매도 / 주문 | 확률·분포 직접 제출 | YES/NO 계약 매수·매도 주문 |
| 참여 자원 | 실제 자금 | 실제 자금 / 문서상 pUSD | 기본 예측에 거래 자금 불필요 | 초기 무료 지급·재지급 / 유료 판매는 별도 후속 |
| 집단 판단 | 시장가격 | 시장가격 | Community Prediction | 거래 기반 시장가격만 제공 |
| 개인 성과 | 거래 P&L | 거래 P&L | Forecast Score | 거래 P&L 표시 / 스코어링 미정 |
| 주요 동기 | 거래 수익·시장 참여 | 거래 수익·시장 참여 | 예측 정확도·명성·대회 | 시장 참여·가격 관찰·거래 복기 |
| 보상 성격 | 계약 정산 수익 | 결과에 따른 토큰 상환 | 점수·평판 / 일부 대회 상금 | Coin 정산 / 실력 보상 미정 |
| 핵심 참고 영역 | Market / Trading / Portfolio | Price Discovery / Settlement | Forecast / Scoring / Tournament | 호가창·포트폴리오·판정·운영 유동성 |

근거: [K1](https://help.kalshi.com/en/articles/13823828-the-orderbook) · [K2](https://help.kalshi.com/en/articles/13823821-market-faqs) · [P1](https://docs.polymarket.com/trading/overview) · [P2](https://docs.polymarket.com/concepts/resolution) · [M1](https://www.metaculus.com/faq/) · [M2](https://www.metaculus.com/help/scores-faq/)

### 2. 벤치마크의 역할 구분

| 참고 서비스 | 가져올 설계 역량 | Buddha에서의 적용 |
|---|---|---|
| Kalshi · Polymarket | Market / Trading / Portfolio / Price Discovery / Settlement | 거래 비용·호가·수량·주문 상태·정산 설계의 주된 참고 |
| Metaculus | Forecast / Scoring / Reputation / Tournament | 질문 품질·토론·운영 참고. 확률 입력·점수는 현재 제품에 적용하지 않음 |

거래 수익은 자산·진입 가격·유동성의 영향을 받는다. 스코어링은 별도 미정이며 P&L을 예측 실력으로 단정하지 않는다. Metaculus는 거래소가 아니므로 거래 기능 부재를 열세로 해석하지 않는다.

### 3. 페이지·주요 기능 비교

각 표는 화면의 목적 → 서비스별 구현 성격 → Buddha 적용 순으로 읽는다. 경쟁사의 세부 Social·알림·순위 UI는 확인되지 않은 부분을 표시했다.

01 Home / Market Discovery · 02 Market Detail / Question Detail · 03 Forecasting · 04 Trading · 05 Portfolio / My Predictions · 06 Resolution · 07 Scoring · 08 Leaderboard · 09 Profile · 10 Community · 11 Tournament / Challenge · 12 Notification / Retention · 13 Market / Question Creation

#### 01 Home / Market Discovery

무엇에 참여할지 찾는다.

| 비교 항목 | Kalshi | Polymarket | Metaculus | Buddha · 기획 방향 |
|---|---|---|---|---|
| 콘텐츠 탐색 | 시장·이벤트 탐색 | 시장·이벤트 탐색 | 질문·시리즈·대회 탐색 | Binary 시장 목록 |
| 카드의 핵심 정보 | 가격·마감·시장 정보 | 가격·거래 활동·시장 정보 | 집단 예측·질문 상태 | 최근 체결 기준 가격·시각·마감·상태 |
| 검색·분류·정렬 | 시장 탐색 기능 | 시장 탐색 기능 | 질문 필터·검색 | 검색·카테고리·상태 / 개인화 후속 |
| 활동 신호 | 거래 중심 | 거래 중심 | 예측 참여 중심 | 실제 거래량·사용자 참여자 수. 봇은 사용자 수 제외 |

**Buddha 적용** 시장가격의 기준과 시각을 함께 표시한다. 개인 확률과 집단 Forecast는 제공하지 않는다.

근거: [K3](https://help.kalshi.com/en/) · [P1](https://docs.polymarket.com/trading/overview) · [M1](https://www.metaculus.com/faq/)

#### 02 Market Detail / Question Detail

질문을 이해하고 계약 매수·매도로 참여한다.

| 비교 항목 | Kalshi | Polymarket | Metaculus | Buddha · 기획 방향 |
|---|---|---|---|---|
| 질문과 판단 기준 | 계약 규칙·시장 설명 | 사전 Resolution 규칙 | 질문·배경·판정 기준 | 제목·조건·출처·시간대·예외 규칙 |
| 현재 값과 이력 | 거래 가격 | 거래 가격 | Community Prediction | 최근 체결가·호가·평균 체결가 구분 |
| 주요 행동 | 매수·매도 | 매수·매도 | 예측 제출·수정 | YES/NO 계약 매수·매도, 지정가·즉시 거래 |
| 상태와 시각 | 시장 마감·판정 | 종료·판정·상환 | Close와 Resolve 구분 | 개장·거래 마감·잠정 판정·확정·지급 완료 구분 |

**Buddha 적용** 주문 체결로 포지션을 만든다. 별도 확률 입력 없이 거래와 규칙 이해에 집중한다.

근거: [K2](https://help.kalshi.com/en/articles/13823821-market-faqs) · [P2](https://docs.polymarket.com/concepts/resolution) · [M1](https://www.metaculus.com/faq/)

#### 03 Forecasting

자신이 생각하는 발생 확률을 직접 기록한다.

| 비교 항목 | Kalshi | Polymarket | Metaculus | Buddha · 기획 방향 |
|---|---|---|---|---|
| 확률 입력 | 주문으로 간접 표현 | 주문으로 간접 표현 | 직접 확률·분포 입력 | 별도 입력 없음. YES/NO는 거래 계약 선택 |
| 업데이트 이력 | 거래 이력 | 거래 이력 | 예측 업데이트·시간 평가 | 주문·체결·취소 이력 보존 |
| 질문 유형 | 계약 구조로 결과 표현 | 결과 토큰 구조 | Binary·객관식·수치 등 | Binary 계약 우선 |
| 집단 예측 | 별도 Forecast 집계 아님 | 별도 Forecast 집계 아님 | 최근성 등을 반영한 집계 | Community Forecast 집계 없음 |

**Buddha 적용** 독립적인 확률 제출은 현재 범위에서 제외한다.

근거: [M1](https://www.metaculus.com/faq/) · [M2](https://www.metaculus.com/help/scores-faq/)

#### 04 Trading

가격과 수량을 확인하고 Coin을 거래에 사용한다.

| 비교 항목 | Kalshi | Polymarket | Metaculus | Buddha · 기획 방향 |
|---|---|---|---|---|
| 매수·매도 | 이벤트 계약 거래 | 결과 토큰 거래 | 해당 없음 | 보유 계약의 일부·전량 매도 |
| 가격 형성 | 주문장·호가 | CLOB 주문 매칭 | Forecast aggregation | CLOB + LMSR 곡선 기반 운영 마켓메이커 |
| 주문 관리 | 대기 주문·가격·수량 | 체결·취소·포지션 관리 | 해당 없음 | 지정가 GTC·가격 보호 IOC·부분 체결·취소 |
| 체결 전 정보 | 주문 가격·수량 | 주문 가격·수량·시장 제약 | 해당 없음 | 실제 호가 기반 예상 수량·평균가·가격 한도·수수료 |

**Buddha 적용** 호가창에서 사용자와 봇 주문을 같은 규칙으로 체결한다. 즉시 거래도 부분 체결될 수 있다.

근거: [K1](https://help.kalshi.com/en/articles/13823828-the-orderbook) · [P1](https://docs.polymarket.com/trading/overview)

#### 05 Portfolio / My Predictions

내 자산과 내 예측의 진행 상태를 확인한다.

| 비교 항목 | Kalshi | Polymarket | Metaculus | Buddha · 기획 방향 |
|---|---|---|---|---|
| 자산·포지션 | 잔액·거래 포트폴리오 | 잔액·결과 토큰 포지션 | 거래 포트폴리오 아님 | 가용·주문 잠금 코인과 보유 계약 구분 |
| 손익과 이력 | 거래 성과·내역 | 거래 성과·내역 | 예측·평가 기록 | 실현/미실현 손익·주문·체결·정산 내역 |
| 예측 관리 | 직접 Forecast와 구분 | 직접 Forecast와 구분 | 내 예측·해결된 질문 | 별도 Forecast 관리 없음 |
| 화면 구성 | 거래 중심 | 거래 중심 | 예측 중심 | MY: 보유 계약·대기 주문·이력·지갑 |

**Buddha 적용** MY에서 보유·주문·지갑·이력을 관리한다.

근거: [K3](https://help.kalshi.com/en/) · [P1](https://docs.polymarket.com/trading/overview) · [M1](https://www.metaculus.com/faq/)

#### 06 Resolution

질문 결과를 확정하고 두 시스템에 같은 결과를 전달한다.

| 비교 항목 | Kalshi | Polymarket | Metaculus | Buddha · 기획 방향 |
|---|---|---|---|---|
| 판정 기준 | 시장별 공식 규칙·출처 | 사전 규칙·출처·예외 | 질문별 기준·운영 판정 | 개설 전 기준·출처·예외 고정 |
| 이의 제기 | 세부 절차 추가 확인 필요 | UMA 제안·이의 제기 절차 | 운영·커뮤니티의 판정 논의 | 잠정 결과 후 24시간 이의 기간 제안 |
| 판정 이후 | 계약 정산 | 승리 토큰 상환 | Forecast 평가 | 확정 결과에 따른 Coin 지급. 점수 처리 제외 |
| 예외 처리 | 계약 규칙에 따름 | 규칙·오라클 절차에 따름 | Ambiguous / Annulled 등 | VOID 50/50 지급 제안·지연·정정 이력 |

**Buddha 적용** 정산과 스코어링을 분리하고 점수 계산을 지급 완료 조건으로 두지 않는다.

근거: [K2](https://help.kalshi.com/en/articles/13823821-market-faqs) · [P2](https://docs.polymarket.com/concepts/resolution) · [M1](https://www.metaculus.com/faq/)

#### 07 Scoring

확률 예측의 질을 결과와 비교해 평가한다.

| 비교 항목 | Kalshi | Polymarket | Metaculus | Buddha · 기획 방향 |
|---|---|---|---|---|
| 기본 성과 | 거래 P&L | 거래 P&L | Log 기반 Baseline / Peer Score | 미정 / 이번 설계 제외 |
| 시간 반영 | 진입·청산 가격에 반영 | 진입·청산 가격에 반영 | 유지된 예측 구간의 시간 평균 | 미정 / 별도 확률 입력 없음 |
| 참여량과 평가 | 거래량·자산은 별도 지표 | 거래량·자산은 별도 지표 | Coverage 및 대회 점수 체계 | 거래 기록 보존. 평가 기준 미정 |
| 개인 실력 추정 | 전용 Forecast Rating과 구분 | 전용 Forecast Rating과 구분 | 누적 예측 성과 평가 | 미정 / 거래 수익을 실력으로 단정하지 않음 |

**Buddha 적용** 스코어링은 이번 범위에서 제외한다. 기존 확률 입력 평가식을 그대로 채택하지 않는다.

근거: [M2](https://www.metaculus.com/help/scores-faq/)

#### 08 Leaderboard

무엇을 잘한 사람인지 같은 기준으로 비교한다.

| 비교 항목 | Kalshi | Polymarket | Metaculus | Buddha · 기획 방향 |
|---|---|---|---|---|
| 주요 비교 대상 | 거래 성과 중심 / 현행 세부 확인 필요 | 거래 성과 중심 / 현행 세부 확인 필요 | 예측 성과·기여 영역 | 스코어링 결정 전 랭킹 미노출 |
| 범위 | 기간·필터 현행 확인 필요 | 기간·필터 현행 확인 필요 | 대회별 성과 비교 | 평가 범위 미정 |
| 참가 자격 | 현행 규칙 확인 필요 | 현행 규칙 확인 필요 | 점수·Coverage 관련 규칙 | 자격·집계 규칙 미정 |
| 인정 방식 | 거래 성과 노출 | 거래 성과 노출 | 예측·기여 인정 | 실력 배지·등급 보류 |

**Buddha 적용** 순위·실력 등급은 평가 정책 결정 전 숨긴다.

근거: [M1](https://www.metaculus.com/faq/) · [M2](https://www.metaculus.com/help/scores-faq/)

#### 09 Profile

이 사람이 무엇을 얼마나 잘 예측하는지 이해한다.

| 비교 항목 | Kalshi | Polymarket | Metaculus | Buddha · 기획 방향 |
|---|---|---|---|---|
| 정체성과 활동 | Social 프로필 | 거래 프로필 / 공개 범위 확인 필요 | 예측·기여 활동 | 소개·관심 분야·공개 글 |
| 핵심 성과 | 거래 기록 중심 | 거래 기록 중심 | 예측 성과 중심 | 거래 손익은 본인 MY / 실력 등급 보류 |
| 공개 범위 | 개별 거래 공개 범위 확인 필요 | 개별 거래 공개 범위 확인 필요 | 예측 공개 정책에 따름 | 잔액·주문·보유량·체결은 본인 전용 |
| 성장 기록 | 세부 UI 확인 필요 | 세부 UI 확인 필요 | 예측·댓글·질문 기여 | 공개 토론 활동·본인 거래 기록 |

**Buddha 적용** 공개 프로필과 비공개 MY를 분리한다.

근거: [K3](https://help.kalshi.com/en/) · [M1](https://www.metaculus.com/faq/)

#### 10 Community

예측 근거를 공유하고 질문의 품질을 높인다.

| 비교 항목 | Kalshi | Polymarket | Metaculus | Buddha · 기획 방향 |
|---|---|---|---|---|
| 토론 접점 | Social·Live Chat | 댓글 UI 현행 확인 필요 | 질문별 토론·분석 | 시장별 근거 댓글·답글 |
| 관계·반응 | Social 기능 / 세부 확인 필요 | Follow·반응 범위 확인 필요 | 토론·커뮤니티 참여 | 사용자 Follow·반응은 후속 |
| 기여 보상 | 예측 실력 점수와 구분 | 예측 실력 점수와 구분 | 예측 이외 기여도 인정 | 행동량 코인 보상·실력 환산 제외 |
| 운영 | 커뮤니티 가이드·신고 | 구체 운영 UI 확인 필요 | 토론 가이드·운영 검수 | 신고·검토·제재·이의 접수 |

**Buddha 적용** 댓글 수·인기도를 실력으로 환산하지 않고 행동량 보상을 제공하지 않는다.

근거: [K3](https://help.kalshi.com/en/) · [M1](https://www.metaculus.com/faq/)

#### 11 Tournament / Challenge

여러 질문에서 일정 기간 예측 실력을 겨룬다.

| 비교 항목 | Kalshi | Polymarket | Metaculus | Buddha · 기획 방향 |
|---|---|---|---|---|
| 질문 묶음 | 이벤트·시장 묶음 | 이벤트·시장 묶음 | Tournament / Question Series | 주제별 시장 묶음은 지원 |
| 경쟁 기준 | 거래 수익 / 프로모션별 상이 | 거래 수익 / 프로모션별 상이 | 대회 Forecast 점수 | 스코어링 미정으로 순위 경쟁 보류 |
| 보상 | 거래 정산과 별도 행사 구분 | 거래 정산과 별도 행사 구분 | 일부 대회 상금 | 참가비·상금·코인 보상 초기 제외 |
| 확장 | 전용 Forecast 대회와 구분 | 전용 Forecast 대회와 구분 | 기관·주제별 대회 | 팀·기관·비공개 대회 후속 |

**Buddha 적용** 주제별 묶음과 순위 대회를 구분한다. 대회 평가는 보류한다.

근거: [P1](https://docs.polymarket.com/trading/overview) · [M1](https://www.metaculus.com/faq/) · [M2](https://www.metaculus.com/help/scores-faq/)

#### 12 Notification / Retention

필요한 시점에 돌아와 예측을 갱신하고 결과를 배운다.

| 비교 항목 | Kalshi | Polymarket | Metaculus | Buddha · 기획 방향 |
|---|---|---|---|---|
| 거래 사건 | 체결·시장 관련 / 채널 확인 필요 | 주문 상태 / 알림 채널 확인 필요 | 해당 없음 | 체결·취소·만료·정산 |
| 예측 사건 | 전용 Forecast 흐름과 구분 | 전용 Forecast 흐름과 구분 | 질문·예측 관련 / 채널 확인 필요 | 별도 Forecast 알림 없음. 시장 마감·판정 알림 |
| 구독 | 현행 세부 확인 필요 | 현행 세부 확인 필요 | 질문·대회 관련 참여 | 관심 시장 등록·해제 |
| 재방문 유도 | 시장 활동 중심 | 시장 활동 중심 | 예측 갱신·평가 중심 | 시장 결과 → 거래 복기 → 다음 시장 |

**Buddha 적용** 거래·판정 알림 중심으로 운영한다. 점수·Forecast 수정 알림은 없다.

근거: [P1](https://docs.polymarket.com/trading/overview) · [M1](https://www.metaculus.com/faq/)

#### 13 Market / Question Creation

판정 가능한 질문을 만들고 검수한다.

| 비교 항목 | Kalshi | Polymarket | Metaculus | Buddha · 기획 방향 |
|---|---|---|---|---|
| 개설 주체 | 시장 상장과 운영 절차 | 시장 생성·운영 정책 / 제안 경로 확인 필요 | 사용자 질문 제출·검수 | 운영 개설 + 사용자 제안 |
| 필수 입력 | 계약 규칙·판정 출처 | 판정 규칙·출처 | 질문 유형·기준·일정 | 제목·배경·판정 기준·출처·마감·예외 |
| 공개 전 검수 | 시장 운영 | 시장 운영 | 질문 검수 | 중복·모호함·선공개 검사 |
| 공개 후 변경 | 규칙·운영 절차에 따름 | 규칙 의도와 추가 설명 구분 | 수정·판정 정책 | 규칙 버전·변경 공지·정산 영향 검토 |

**Buddha 적용** 거래와 정산은 동일 시장 규칙 버전과 결과를 참조한다.

근거: [K2](https://help.kalshi.com/en/articles/13823821-market-faqs) · [P2](https://docs.polymarket.com/concepts/resolution) · [M1](https://www.metaculus.com/faq/)

### 4. Buddha의 현재 제품 구조

하나의 시장, 계약 거래, 하나의 결과 정산으로 통일한다. 과거 Hybrid(Trade + 직접 Forecast) 방향은 현재안에서 대체되었다.

시장 발견 → 규칙·가격·호가 확인 → YES/NO 계약 매수·매도 → 주문·포지션 관리 → 매도 또는 정산 → 복기.

Coin 경제와 거래 원장을 구축하며, 스코어·평판·순위는 별도 후속 결정이다. 거래 가격은 개인의 명시적 신념 확률이 아니다.

### 5. 구현 범위

- 초기: Binary 시장, 탐색·검색·카테고리, 차트·호가·최근 체결, 지정가·가격 보호 즉시 거래, 부분 체결·취소, MY·지갑, 운영 마켓메이커, 판정·이의·정산, 댓글·신고·관심 시장·앱 내 알림.
- 후속: 개인화, Follow, 뉴스 타임라인, 고급 주문, 다중 선택, 팀·기관 대회.
- 별도 검토: 스코어링·순위·실력 배지, 유료 코인 판매.
- 제외: 독립 확률 입력·Community Forecast 집계, 현금 출금, 무담보 공매도·레버리지, 가상 사용자로 거래량 연출.

### 6. 후속 문서

- 01 경제 시스템 · Economy System: Coin·담보·호가봇·손실 한도·대량 주문·검증.
- 02 거래와 화면 · Trading & Product UX: 화면과 주문·MY·온보딩.
- 03 마켓과 판정 · Market & Resolution: 개설·마감·이의·VOID·정산.
- 04 프로필과 활동 기록 · 스코어링 보류: 프로필·공개 범위·평가 보류.
- 05 소셜과 챌린지 · Social & Challenge: 토론·알림·시장 묶음.
- 06 유료 코인 판매 · 도입 전 검토사항: 유료 코인 판매 도입 전 검토.

### 7. 설계에서 유지할 구분

거래 손실은 자동 소각이 아니다. AMM 곡선도 큰손을 자동 차단하지 않는다. 호가창 가격과 객관적 실제 확률은 다르다. LMSR 곡선 호가봇에는 직접 AMM의 손실 보장이 자동 적용되지 않는다.

실험용 지급액·봇 예산·가격 민감도는 시뮬레이션 후 결정한다. 문서 작성 완료와 실제 구현·성능 검증 완료는 구분한다.

### 8. 출처와 문서 이력

기획 원문: 사용자가 참조한 「기능 비교표 및 경제 설계」 대화. 비교 개요·세부 기능·페이지 비교·경제 및 점수 논의를 통합했다. 외부 자료 확인일: 2026-09-17. 아래 링크는 핵심 메커니즘 근거이며, 표의 모든 UI 세부를 확인했다는 의미는 아니다.

- [K1 · Kalshi · The Orderbook](https://help.kalshi.com/en/articles/13823828-the-orderbook)
- [K2 · Kalshi · Market FAQs](https://help.kalshi.com/en/articles/13823821-market-faqs)
- [K3 · Kalshi · Help Center / 기능 분류](https://help.kalshi.com/en/)
- [P1 · Polymarket · Trading overview](https://docs.polymarket.com/trading/overview)
- [P2 · Polymarket · Resolution](https://docs.polymarket.com/concepts/resolution)
- [M1 · Metaculus · FAQ](https://www.metaculus.com/faq/)
- [M2 · Metaculus · Scores FAQ](https://www.metaculus.com/help/scores-faq/)

v1.1 · 2026-10-04: Buddha 적용안을 호가창 거래 중심으로 개정. 경쟁사 비교 원문 보존. 스코어링 보류, 후속 문서 연결 갱신.
