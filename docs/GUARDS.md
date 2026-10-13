# 회귀 가드 등록 규칙

기획이 제외한 기능이 화면·API·저장 데이터에 다시 들어오거나, 공개 응답과 공개 실시간 이벤트에 본인 전용·인증·내부 정보가 실리거나, 다른 계정의 비공개 자산·주문을 조회할 수 있게 되면 평소 시험이 실패하게 하는 검사다(#113). 이 문서는 검사가 무엇을 어디서 보는지와 등록 규칙을 적는다. 결정과 근거는 [ADR-0057](DECISIONS.md)에 있다. 기획 인용 표기(NR, N00\~N06 §n)와 오너 결정 D1\~D26은 ADR-0047을 따른다. 뒤 이슈는 공개 API·본인 전용 API·공개 실시간 이벤트·알림 유형을 더할 때 이 문서대로 등록한다.

- 기획: 독립 확률 입력이 어느 화면에도 없고 매수 입력값이 개인 신념 확률로 저장되지 않아야 한다(N02 §10). 계정 이메일·인증 정보·내부 위험 플래그를 노출하지 않고, 초기에는 잔액·주문·미정산 보유 수량·개별 체결·손익이 본인 전용이다(N04 §2). 다른 사용자가 비공개 자산·주문을 조회할 수 없어야 한다(N04 §7). 상대 계정은 익명으로 표시한다(N01 §5).
- 오너 결정(2026-10-13, #113): 등록이 빠진 공개 API·이벤트를 검사가 스스로 찾아내 실패시킨다((a)). '점수·순위를 제공하지 않습니다' 같은 부정 안내는 서비스 안내(#136)에서만 허용하고((b)), 현금 환전·출금을 제공하지 않는다는 안내는 어디서나 허용한다.
- 오너 결정(2026-10-14, #113 추가 답): 서비스 안내의 부정 문장은 #14 용어 표의 낱말('확률'·'투표'·'예측')이 들어 있어도 허용한다. 대회 어휘(상금·참가비·우승)는 제외 목록에 넣지 않는다(챌린지 #81에서 다시 본다). API의 제외 기능 이름 검사는 공개 API만 보고, 송금·활동량 보상·현금 환전·출금은 경로만 모든 API에서 본다. 관리자 화면은 도박 어휘만 검사하고, 메일은 모든 제외 기능 문구를 검사한다.

## 언제 도나

- 평소 시험과 함께 돈다. `pnpm test`(`turbo run test`)와 CI의 `turbo run lint typecheck test build`가 돌리고, 켜고 끄는 설정이나 환경 변수는 없다.
- 대부분은 DB 없이 도는 정적 검사다. 실제 응답을 보는 `apps/api/src/surface/private-data.test.ts`만 test 프로필의 Postgres·Redis가 필요하다. 로컬에서 `TEST_*`가 없으면 그 시험은 건너뛰고(CI에서는 실패한다), 같은 파일의 'private data cases (static)'은 DB 없이도 돈다.
- API의 정적 검사는 커밋된 `apps/api/openapi.json`을 읽는다. 컨트롤러나 응답 스키마를 고쳤으면 `pnpm api:openapi`로 다시 만든 뒤 결과를 믿는다. 문서가 코드와 어긋나면 CI의 `OpenAPI contract check`가 실패한다. 실제 응답의 필드 이름은 런타임 검사가 따로 본다.
- **#149의 출시 점검이 이 검사를 다시 돌린다.** 아래 '검사와 자리' 표의 시험이 모두 대상이다.

## 검사와 자리

| 검사           | 무엇을 보나                                                                                                                                                                                                                                                                                                                                                                                                                  | 시험                                                                                     | DB   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---- |
| 제외 기능 목록 | 항목마다 근거·검사 대상·찾는 법이 있음, #14 대응표의 모든 행을 찾음, 허용 구절이 자기 항목만 지움                                                                                                                                                                                                                                                                                                                            | `packages/shared/src/guards/excluded.test.ts`                                            | 없음 |
| 화면 문구      | `copy.ts`의 값(키마다), `apps/web/src` 아래 문자열·템플릿·JSX 문구(주석은 아니다), 원화 가격 표시(`formatKrw`). 관리자 화면은 도박 어휘만                                                                                                                                                                                                                                                                                    | `apps/web/src/excluded-features.test.ts`(문구 읽기는 `apps/web/src/test/screen-text.ts`) | 없음 |
| 약관 본문      | `apps/web/src/legal/`의 `terms.ts`·`privacy.ts`·`refund.ts`·`cash-notice.ts`. #137이 개정할 때까지 도박 어휘만                                                                                                                                                                                                                                                                                                               | 같은 파일, `apps/web/src/legal/legal.test.ts`                                            | 없음 |
| 화면 주소·메뉴 | `app/`의 라우트 폴더, 메뉴·링크·리디렉트가 적은 내부 경로. 페이지 밖에서 웹이 답하는 것(라우트 핸들러·API 라우트·서버 액션)이 등록 목록과 같음                                                                                                                                                                                                                                                                               | `apps/web/src/excluded-features.test.ts`                                                 | 없음 |
| 메일           | 메일 템플릿의 제목·텍스트·HTML                                                                                                                                                                                                                                                                                                                                                                                               | `apps/api/src/mail/templates.test.ts`                                                    | 없음 |
| 시드 시장 문구 | 시드 시장의 제목·설명·규칙·출처                                                                                                                                                                                                                                                                                                                                                                                              | `packages/db/src/seed-markets.test.ts`                                                   | 없음 |
| 저장 데이터    | Drizzle 스키마의 표·열·제약·색인·enum 이름과 enum 값, 고정 목록을 담는 varchar 열의 값. 보너스를 이름에 담은 값은 `BONUS_VALUES`에 있는 것만. 사람이나 주문에 묶인 표의 이름과 열에 확률·믿음 낱말이 없음                                                                                                                                                                                                                    | `packages/db/src/storage-names.test.ts`                                                  | 없음 |
| 라우트와 문서  | 공개·본인 전용 라우트가 등록 목록과 같음, 보존한 결제 라우트, 공개 라우트 경로, 모든 라우트 경로의 송금·활동량 보상·현금 환전·출금. OpenAPI 문서의 공개 작업의 경로·매개변수·스키마·필드 이름(확률·믿음 낱말 포함), 문서의 공개 작업이 등록한 공개 라우트와 같고 본인 전용 작업에 세션 보안이 있음, 공개 응답 필드에 금지 항목이 없음. 실시간 게이트웨이(네임스페이스·메시지)와 소켓에 이벤트를 보내는 곳이 등록 목록과 같음 | `apps/api/src/surface/registry.test.ts`                                                  | 없음 |
| 실제 응답      | 공개 라우트를 비로그인·다른 계정 B·계정 A로, better-auth의 세션 읽기, 본인 전용 라우트를 B가 A를 겨냥해, 시장 방의 실시간 이벤트                                                                                                                                                                                                                                                                                             | `apps/api/src/surface/private-data.test.ts`                                              | 필요 |
| 공개 금지 항목 | 항목마다 근거와 필드, 아직 없는 항목의 표시                                                                                                                                                                                                                                                                                                                                                                                  | `packages/shared/src/guards/private-data.test.ts`                                        | 없음 |
| 실시간 이벤트  | 유형마다 채널과 사유, 채널이 게이트웨이가 파싱하는 계열과 같음, 시장 채널 스키마의 필드(확률·믿음 낱말 포함), 사용자 이벤트가 시장 채널 이벤트로 읽히지 않음                                                                                                                                                                                                                                                                 | `packages/shared/src/guards/realtime-events.test.ts`                                     | 없음 |
| 알림 유형      | 유형 이름과 사람이 읽는 문구                                                                                                                                                                                                                                                                                                                                                                                                 | `packages/shared/src/guards/notifications.test.ts`                                       | 없음 |

이 문서 밖에서 같은 방식으로 지키는 이웃 검사도 평소 시험과 함께 돈다. 모든 `/admin` 라우트의 `SessionGuard`·`AdminGuard`(`apps/api/src/admin/admin-access.test.ts`, ADR-0056), 상태를 바꾸는 관리자 라우트마다의 작업 유형(`apps/api/src/admin/admin-audit.test.ts`, ADR-0036), 옛 단위 P(`apps/web/src/coin-unit.test.ts`, ADR-0051), 용어 대응표와 상수(`packages/shared/src/terms.test.ts`, ADR-0052), 유료 판매 닫힘(`apps/api/src/payments/paid-coin-sales.test.ts`, `packages/shared/src/constants.test.ts`, ADR-0049)이다.

## 제외 기능 목록

목록은 한곳, `packages/shared/src/guards/excluded.ts`의 `EXCLUDED_FEATURES`(`@buddha/shared`)다. 위의 검사는 모두 이것을 가져다 쓰고 따로 낱말을 적지 않는다. 항목마다 이름·근거(`basis`)·검사 대상(`surfaces`)·화면 낱말(`words`, 정규식)·식별자 토큰(`tokens`)이 있다. 낱말과 토큰은 코드에만 두고 이 문서에 옮겨 적지 않는다.

| id                  | 무엇                                                                           | 근거                       | 검사 대상                                                          |
| ------------------- | ------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------ |
| `probability-input` | 독립 확률 입력·확률 슬라이더·My Forecast·Community Forecast·Forecast 수정 이력 | N02 §1·§10, N00 §5, N04 §5 | 화면 문구, 화면 주소·메뉴, 공개 API, 저장 데이터                   |
| `scoring`           | 점수·평판·카테고리 등급·순위·실력 배지                                         | N04 §4, N00 §3-08, N02 §2  | 화면 문구, 화면 주소·메뉴, 공개 API, 저장 데이터                   |
| `paid-purchase`     | 유료 구매 버튼·가격표·구매 보너스·결제 유도(충전·결제·쿠폰)                    | N06, D9, ADR-0049          | 화면 문구, 화면 주소·메뉴, 공개 API                                |
| `activity-reward`   | 활동량 Coin 보상(출석·거래량·주문 횟수, 글·답글·좋아요 수에 따른 지급)         | N01 §2, N05 §2, D5         | 화면 문구, 화면 주소·메뉴, 공개 API와 모든 API의 경로, 저장 데이터 |
| `coin-transfer`     | 사용자 간 Coin 송금                                                            | N01 §2                     | 화면 문구, 화면 주소·메뉴, 공개 API와 모든 API의 경로, 저장 데이터 |
| `cash-out`          | 현금 환전·출금                                                                 | N01 §2, N00 §5, N06        | 화면 문구, 화면 주소·메뉴, 공개 API와 모든 API의 경로, 저장 데이터 |
| `replaced-term`     | 거래를 '예측'·'투표'로, 시장가격을 '확률'로 부르는 표현                        | [docs/TERMS.md](TERMS.md)  | 화면 문구                                                          |
| `prediction-word`   | 장르명 '예측시장' 밖의 '예측'                                                  | D22                        | 화면 문구                                                          |
| `gambling`          | 도박 어휘(베팅·배당·배당률·승률·판돈·당첨)                                     | D21                        | 화면 문구                                                          |

- **화면 문구**는 사람이 읽는 글이다: 웹 문구, 메일, 시드 시장 문구, 알림 문구. `words`로 찾는다(`findExcludedText`). 관리자 화면은 도박 어휘만 찾고(`ADMIN_SCREEN_FEATURES`), 메일과 회원 화면은 모든 항목으로 찾는다(오너 결정 2026-10-14).
- **화면 주소·메뉴, API, 저장 데이터**는 식별자다. 식별자를 낱말로 나눠(`identifierWords`: `realizedPnlCoin`, `realized_pnl_coin`, `/admin/audit-failures`) 한 낱말이 토큰이나 그 굴절형(`tokenForms`: `rankings`, `scoring`, `withdrawal`)과 같으면 걸린다(`findExcludedIdentifier`). 그래서 `p_yes_bp`나 `priceAvgBp`는 걸리지 않는다. 두 낱말 토큰(`check in`, `send coin`)은 함께일 때만 그 뜻이라, 두 낱말이 잇달아 있거나(`checkIn`, `/me/check-in`, `sendCoins`) 한 낱말로 붙어 있으면(`DAILY_CHECKIN`) 걸린다. 홀로 쓴 `send`(메일·인증 코드 발송)와 `bonus`(시작 Coin의 `BONUS`)는 토큰이 아니다.
- **API**는 공개 API다: 공개 라우트의 경로, OpenAPI 문서의 공개 작업의 경로·매개변수·스키마·필드 이름, 공개 응답의 실제 필드, 시장 채널 이벤트의 필드. 알림 유형 이름도 API 토큰으로 찾는다. 본인 전용·관리자 라우트는 경로만, 그것도 송금·활동량 보상·현금 환전·출금(`EVERY_ROUTE_PATH_FEATURES`)만 찾는다. 송금과 출금은 본인 전용 라우트로, 활동량 보상은 관리자 라우트로 들어올 수 있어서다(오너 결정 2026-10-14). 본인 전용·관리자 응답의 필드와 문서의 작업은 이름으로 보지 않는다. 유료 구매는 공개 라우트와 공개 응답에서만 찾고, 보존한 결제 코드는 뺀다(D9). 결제·쿠폰 코드와 표, 관리자 충전 상품·쿠폰 관리는 남아 있어서다(ADR-0049).
- **용어와 도박 어휘**는 [docs/TERMS.md](TERMS.md)의 대응표(`REPLACED_TERMS`)에서 가져온다. 대응표를 고치면 이 검사도 따라 바뀐다. '뜻' 행은 `TERM_MEANING_PATTERNS`로 찾는다. 읽는 법은 TERMS.md의 '찾는 법'에 있다.
- **개인 확률**: 사람(`user`)이나 주문(`orders`)을 가리키는 표의 이름과 열에 `PERSONAL_PROBABILITY_WORDS`(prob·probability·belief·credence·confidence·forecast 등)의 낱말이 없어야 한다(`namesPersonalProbability`, N02 §10, N04 §5). 시장 단위의 가격(`price_ticks.p_yes_bp`)은 개인 확률이 아니다. 공개 API(공개 라우트 경로, 문서의 공개 작업의 경로·매개변수·스키마·필드 이름, 공개 응답의 실제 필드, 시장 채널 이벤트의 필드)에는 그 낱말이 아예 없어야 한다. 거기서 확률은 누군가의 입력이거나 Community Forecast의 집계이고(N02 §1, N00 §5), 시장가격은 확률이라 부르지 않는다([docs/TERMS.md](TERMS.md)). 본인 전용·관리자 API와 본인 방 이벤트는 이 낱말로 보지 않고(오너 결정 2026-10-14의 API 범위), 웹의 주소도 보지 않는다(ADR-0057 결과 5). 화면 문구의 '확률'은 용어 행이, 주소의 `forecast`·`belief` 등은 `probability-input`의 토큰이 찾는다.
- **목록을 바꾸는 것은 결정이다.** 항목·낱말을 빼거나 넓히는 PR은 기획 절이나 오너 결정을 `basis`에 적는다. 점수·순위를 다시 들이면 #110의 결정이, 유료 Coin 판매를 열면 #111의 결정이, 대회 어휘(상금·참가비·우승)를 넣기로 하면 챌린지(#81)의 결정이 이 목록과 아래 허용을 고친다.

## 공개 금지 항목

공개 응답과 공개 실시간 이벤트에 실리면 안 되는 것은 한곳, `packages/shared/src/guards/private-data.ts`의 `PRIVATE_DATA`(`@buddha/shared`)다. 항목마다 이름·근거·필드(식별자 낱말의 줄)가 있다. 필드 이름을 낱말로 나눠 그 줄을 담고 있으면 걸린다(`findPrivateField`: `['real', 'name']`은 `realName`·`buyerRealName`에 걸리고 `nameKo`에는 걸리지 않는다). 공개된 익명 체결이나 시장가격은 비공개가 아니다. 그것을 누구의 것으로 만드는 것은 옆에 붙은 계정이나 '누구의 것'이라는 이름(`myFills`)이다.

| id                      | 항목                                              | 근거              | 아직 없음                        |
| ----------------------- | ------------------------------------------------- | ----------------- | -------------------------------- |
| `balance`               | 특정 사용자에게 묶인 잔액                         | N04 §2            |                                  |
| `orders`                | 특정 사용자에게 묶인 주문                         | N04 §2·§7, N05 §2 |                                  |
| `holdings`              | 특정 사용자에게 묶인 미정산 보유 수량             | N04 §2            |                                  |
| `pnl`                   | 특정 사용자에게 묶인 손익                         | N04 §2·§3         |                                  |
| `fills`                 | 특정 사용자에게 묶인 체결 내역                    | N04 §2, N01 §5    |                                  |
| `counterparty`          | 체결 당사자 계정(최근 체결은 익명으로만 공개한다) | N01 §5, N04 §2    |                                  |
| `email`                 | 계정 이메일                                       | N04 §2            |                                  |
| `real-name`             | 실명                                              | D8, ADR-0043      |                                  |
| `phone`                 | 휴대전화 번호                                     | D8, ADR-0043      |                                  |
| `identity-verification` | 본인확인 기록                                     | D8                | 휴대폰 SMS OTP 본인확인(#183) 전 |
| `auth-secret`           | 인증 정보(비밀번호·세션·토큰)                     | N04 §2            |                                  |
| `risk-flag`             | 내부 위험 플래그                                  | N04 §2            | 위험 플래그를 두는 기능 전       |
| `author-holding`        | 글 작성자의 보유 방향·주문                        | N04 §2, N05 §2    | 글·댓글(#46) 전                  |

- 아직 아무것도 저장하지 않는 항목도 미리 넣어 두었다(`pending`). 그것을 처음 싣는 라우트나 이벤트가 첫날부터 거절된다.
- 이 목록은 결정 이슈의 답으로 고친다. '인증 정보'·'내부 위험 플래그'의 범위와 본인 전용 목록 밖 항목(판정 담당자 표기, 시장별 관심 등록 수 등)의 공개 여부는 #37, 시장별 봇 설정을 공개 응답에 실을지는 #180, 체결 상대가 운영 유동성인지를 본인 체결이나 공개 최근 체결에 보일지는 #123·#122가 정한다. 답이 나오기 전에는 지금 목록 그대로다.
- 걸린 필드가 정말 공개여야 하면 시험을 느슨하게 하지 않는다. 그 근거가 되는 결정과 함께 이 목록을 고친다. 지금은 라우트별 허용이 없다.

## 허용과 그 이유

허용은 낱말을 느슨하게 하지 않고, 그 뜻이 아닌 자리만 지운다. 모든 허용에는 이유가 있다.

**모든 화면 문구**(`excluded.ts`의 `TEXT_ALLOWANCES`).

| 허용                                                                                                          | 지우는 항목                                                                                                       | 어디서      | 이유                                                      |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------- |
| '예측시장'                                                                                                    | `prediction-word`                                                                                                 | 어디서나    | 장르명(D22, ADR-0052)                                     |
| 시장가격이 확률의 보장이 아니라는 안내                                                                        | `replaced-term`의 '확률'                                                                                          | 어디서나    | N02 §5, TERMS.md의 확률 행                                |
| '상승률'                                                                                                      | `gambling`의 '승률'                                                                                               | 어디서나    | 경제 용어. 시드 시장 제목에 있다                          |
| '우선순위'                                                                                                    | `scoring`의 '순위'                                                                                                | 어디서나    | 주문 체결의 가격·시간 우선순위(N01 §4)                    |
| '미결제'                                                                                                      | `paid-purchase`의 '결제'                                                                                          | 어디서나    | 아직 정산되지 않은 계약 수                                |
| '계좌이체'                                                                                                    | `coin-transfer`의 '이체'                                                                                          | 어디서나    | 보존한 결제 코드(D9)의 결제 수단 이름                     |
| 현금 환전·출금 낱말에 바로 붙은 부정(`CASH_OUT_NOTICE`: '환전·출금은 제공하지 않', '환전하거나 출금할 수 없') | `cash-out`                                                                                                        | 어디서나    | 현금 환전·출금 미제공 안내(N01 §2, 오너 결정)             |
| 부정 안내 문장(`NEGATIVE_NOTICE`: '…(제공·지원·지급)하지 않', '…할 수 없', '…없습니다', '…아닙니다')          | `probability-input`·`scoring`·`paid-purchase`·`activity-reward`·`coin-transfer`·`replaced-term`·`prediction-word` | 서비스 안내 | 오너 결정 (b)와 2026-10-14. 서비스 안내 밖에서는 실패한다 |

현금 환전·출금 안내의 부정은 그 낱말의 것이어야 한다. '출금 신청은 취소할 수 없습니다'처럼 다른 말에 붙은 부정은 출금을 지우지 않는다. 서비스 안내의 부정 문장은 용어 표의 낱말('확률'·'투표'·'예측')도 지운다('확률 입력이나 투표 기능은 없습니다', '시장가격은 확률이 아닙니다', 오너 결정 2026-10-14). 도박 어휘는 서비스 안내의 부정 문장 안에서도 허용하지 않는다.

**웹**(`apps/web/src/excluded-features.test.ts`).

- 관리자 화면: `app/admin` 아래 파일과, `app/` 밖에서 관리자 코드만 가져다 쓰는 컴포넌트·훅·lib(가져오는 곳을 따라 찾는다. 시험 파일은 세지 않고, Next가 직접 부르는 `proxy.ts`는 관리자 것이 되지 않는다), 그리고 그 파일들만 읽는 copy 키다. 문구는 도박 어휘만 검사하고(`ADMIN_SCREEN_FEATURES`), 원화 가격 표시도 찾지 않는다(오너 결정 2026-10-14). 회원 화면도 가져다 쓰는 파일은 회원 화면의 것이다. 주소와 링크는 다른 화면처럼 검사한다.
- `PRESERVED_PAID_SOURCES`: 유료 판매를 끈 동안 회원 화면에 닿지 않는 보존한 결제 코드(공개 `/charge`, 지갑의 충전·쿠폰·결제 내역 컴포넌트, 메뉴에서 뺀 관리자 충전 상품·쿠폰·결제 화면, 그 도우미). 유료 구매만 빠지고 다른 항목은 그대로 검사한다. 관리자 화면의 줄은 그 주소와 링크를 위한 것이다(문구는 관리자 화면이라 도박 어휘만 본다). `PAID_COIN_SALES_ENABLED`가 `false`일 때만 성립하므로 시험이 그 값을 고정하고, 목록의 경로가 모두 있는지도 본다.
- 판매 스위치가 여는 분기(`PAID_COIN_SALES_ENABLED ? … : …`의 참 쪽, `PAID_COIN_SALES_ENABLED && …`, `if (PAID_COIN_SALES_ENABLED) …`) 안의 문구·`copy` 읽기·`formatKrw`도 유료 구매만 빠진다(`screen-text.ts`의 `gated`).
- `COPY_ALLOWANCES`: copy 키별 허용. 지갑 이용 내역의 원장 유형 라벨 `ledgerTypeDeposit`·`ledgerTypePaymentCancel`·`ledgerTypePaymentCancelReversal`(충전·결제, 판매를 닫기 전의 행을 부르는 이름, D9)과 실명·휴대전화 수집 목적 안내 `onboardingSubtitle`·`settingsContactHint`·`setPasswordContactHeading`(결제·구매, #58이 온보딩을 고칠 때까지, ADR-0049). 허용할 낱말이 그 값에서 없어지면 시험이 실패하므로 그때 허용을 지운다.
- `SERVICE_GUIDE_ROOT`(`app/(service-guide)`): 서비스 안내(#136) 화면의 자리. 이 아래 파일과 이 아래에서만 읽는 copy 키는 서비스 안내의 허용을 받는다. 라우트 그룹은 주소에 들어가지 않으므로 주소는 #136이 정한다. 아직 아무것도 없어서 지금은 부정 안내가 어디서나 실패한다.
- `PRICE_FORMATTERS`(`formatKrw`): 원화 가격을 그리는 함수. 보존한 결제 코드와 판매 스위치 분기 밖에서 쓰면 가격표(N06)로 본다.
- `LEGAL_BODIES`(`test/screen-text.ts`): 약관 본문 네 파일. #137이 개정할 때까지 도박 어휘만 검사한다.

**API**(`apps/api/src/surface/registry.ts`). `preservedPaid: true`인 공개 라우트(`GET /charge-packages`, `GET /payments/provider`)만 공개에서 유료 구매를 말할 수 있다. `PaidCoinSalesGuard`가 그 라우트의 첫 가드이고 판매를 끈 동안 404로 답한다. 시험이 스위치가 `false`임과, 그 가드가 막는 라우트와 표시가 서로 맞는지를 고정한다.

**저장 데이터**(`packages/db/src/storage-names.test.ts`). 유료 구매는 찾지 않는다. 결제·충전 상품·쿠폰 표와 그 원장 유형·관리자 작업 유형은 보존한다(D9). `VARCHAR_VALUES`에 넣지 않은 열은 `approval_requests.kind`(작업마다 소비 이슈가 이름을 정하고 아직 목록이 없다, ADR-0056)와 `admin_actions.target_type`(대상 표의 이름)이다. `BONUS_VALUES`: 이름에 보너스를 담은 저장 값 가운데 허용한 것과 이유. 지금은 원장 유형 `BONUS`(인증된 계정에 한 번 주는 시작 Coin, N01 §2, 보존한 쿠폰 사용, D9) 하나다.

**시드 시장 문구**(`packages/db/src/seed-markets.test.ts`). 질문의 대상인 원화 금액('1,400.0원 이상')은 유료 구매의 원화 가격 낱말에서 지운다. 원/달러 환율을 묻는 시장의 주제이지 Coin의 가격이 아니다. 충전·결제·할인·'₩' 같은 다른 낱말은 그대로 찾는다.

## 등록 규칙

### 공개 API

`SessionGuard`가 없는 라우트다. 로그인하지 않은 방문자도 부를 수 있다.

1. `apps/api/src/surface/registry.ts`의 `PUBLIC_ROUTES`에 한 줄을 넣는다. 키는 컨트롤러가 쓴 그대로의 `'METHOD /path'`다(`/api`와 버전 없이, 매개변수는 `:id`). `reason`(한국어)에 왜 공개인지와 그 기획 근거, 무엇을 돌려주는지 적는다. 리뷰어가 읽는 것이 이 사유다.
2. 보존한 결제 코드라면 `preservedPaid: true`를 붙이고 `PaidCoinSalesGuard`를 첫 가드로 건다. `@ApiExcludeController`로 OpenAPI 문서에서 뺀 라우트는 `undocumented: true`를 붙이고 `docs/API.md`의 손으로 쓴 절에 적는다(그 글은 `scripts/generate-api-doc.mjs` 안에 있다).
3. `apps/api/src/surface/private-data.test.ts`에 부르는 법을 넣는다. 경로 매개변수마다 `PUBLIC_PARAMS`에 이름으로 값을 둔다(A의 기록을 가리키게). GET이 아니면 `PUBLIC_BODIES`에 본문을 둔다(A에 대해 가장 많이 말하게 하는 요청).
4. 응답 필드가 `PRIVATE_DATA`나 제외 기능 이름에 걸리면 응답을 고친다(위 '공개 금지 항목').
5. `pnpm api:openapi`를 돌려 결과를 함께 커밋한다.

빠뜨리면: `registry.test.ts`가 모듈 그래프에서 찾은 공개 라우트 가운데 등록이 없는 것과, 등록됐는데 없어졌거나 부류가 바뀐 것을 실패시킨다(오너 결정 (a)). `private-data.test.ts`의 정적 시험이 매개변수 값이나 본문이 없는 라우트를 DB 없이 실패시킨다. 공개 라우트에 `SessionGuard`를 걸거나 빼면 줄을 `PUBLIC_ROUTES`와 `OWNER_ROUTES` 사이에서 옮긴다.

런타임 검사는 계정 A의 이메일·닉네임·실명·휴대전화·비밀번호·세션·잔액·원장 메모·주문과 체결·보유와 손익·결제를 심고, 모든 공개 라우트를 비로그인·B·A로 불러 답에 A의 값, 금지 항목의 필드, 제외 기능 이름의 필드가 없는지 본다. 보존한 결제 라우트는 404, 나머지는 200이어야 한다. A의 닉네임과 계정 id도 찾는 값이다. 지금 사람을 보이는 공개 라우트가 없어서다. 공개 프로필·글(#41·#46)처럼 사람을 보여야 하는 공개 응답을 더할 때 이것을 어떻게 다룰지는 열려 있다(ADR-0057 결과 5).

### 본인 전용 API

`SessionGuard`가 있고 `AdminGuard`가 없는 라우트다. 세션 계정 자신의 것만 답한다.

1. `registry.ts`의 `OWNER_ROUTES`에 한 줄을 넣는다. 키는 공개 API와 같고, `reason`에 누구의 무엇을 돌려주거나 바꾸는지와 기획 근거를 적는다. 보존한 결제 코드는 `preservedPaid: true`.
2. `private-data.test.ts`의 `OWNER_CASES`에 교차 계정 경우를 넣는다. B가 A를 겨냥해 부르는 요청이다.
   - `params`: 경로 매개변수마다 A의 기록을 가리키는 값.
   - `body`: GET이 아니면 본문. 본문이 계정을 받으면(`expectedAccountId` 등) A의 계정.
   - `status`: B가 받아야 하는 답(자기 것만 보이는 목록은 200, A의 기록 하나는 404, A의 계정을 댄 쓰기는 403 등).
   - `own`: 같은 요청을 A가 하면 보이는 A의 값(표지값의 라벨). 검사가 눈먼 것이 아님을 확인한다. A를 바꾸는 쓰기에는 두지 않는다.
3. 새 라우트가 다루는 A의 비공개 기록이 표지값에 없으면 시험의 `seed()`에 그 기록을 심고 표지값을 더한다.

빠뜨리면: `registry.test.ts`가 등록이 없는 본인 전용 라우트를, `private-data.test.ts`의 정적 시험이 `OWNER_CASES`가 `OWNER_ROUTES`와 다르거나 매개변수·본문이 빠진 경우를 실패시킨다. 런타임 검사는 B의 답에 A의 값이 없고 상태가 `status`인지, A의 답에 `own`이 있는지 본다.

이름: 본인 전용 라우트의 경로에 송금·활동량 보상·현금 환전·출금의 토큰이 있으면 `registry.test.ts`가 실패한다(`/me/coins/send`, `/me/withdrawals`). 그 밖의 이름(본인의 점수나 확률을 담은 필드 등)은 보지 않는다(오너 결정 2026-10-14).

### 관리자 API

이 등록 목록에 넣지 않는다. 모든 관리자 라우트는 `/admin` 아래에 두고 `SessionGuard` 다음 `AdminGuard`를 건다. `admin-access.test.ts`가 그것을, `admin-audit.test.ts`가 상태를 바꾸는 라우트마다의 작업 유형을 확인한다(ADR-0036·ADR-0056). 관리자 라우트는 경로만 송금·활동량 보상·현금 환전·출금의 이름 검사를 받는다(`/admin/rewards`는 실패한다, 오너 결정 2026-10-14). 필드와 문서의 작업은 이름으로 보지 않는다.

### Nest 밖의 공개 경로

모듈 그래프에 보이지 않는 경로는 `registry.ts`의 `OUTSIDE_NEST_ROUTES`에 경로와 사유로 적는다. 지금은 better-auth의 `/api/auth/*` 하나다. 계정에 대해 답하는 호출(세션 읽기)을 더하면 `private-data.test.ts`의 'better-auth’s session reads' 시험에 그 호출을 더한다. 지금은 `get-session`·`list-sessions`다.

### 실시간 이벤트

공개 방은 `market:<id>`(누구나 구독), 본인 방은 `user:<id>`(핸드셰이크 세션이 들어간다)다.

1. `packages/shared/src/realtime.ts`의 `REALTIME_EVENT_TYPES`에 유형을 넣고 스키마를 그 계열(`marketRealtimeEventSchema` 또는 `userRealtimeEventSchema`)에 더한다.
2. `packages/shared/src/guards/realtime-events.ts`의 `REALTIME_EVENT_REGISTRY`에 `channel`(`'market'` 또는 `'user'`)과 `reason`(한국어: 무엇을 알리는지와 기획 근거)을 넣는다. 유형을 키로 하므로 빠뜨리면 컴파일이 실패한다.
3. 본인 방 이벤트면 `realtime-events.test.ts`의 `USER_EVENTS`와 `private-data.test.ts` 시장 방 시험의 `own`에 그 이벤트의 예를 하나씩 더한다. 둘 다 유형마다 하나를 요구해서 빠뜨리면 컴파일이 실패한다.
4. `scripts/generate-api-doc.mjs`의 `REALTIME_EVENTS`에 방·설명·순서 키를 넣는다. 없으면 `pnpm api:openapi`가 실패한다.

게이트웨이와 소켓에 이벤트를 보내는 곳도 등록한다(오너 결정 (a)). 소켓은 로그인 없이도 열리므로 공개 표면이다.

- 새 `@WebSocketGateway`, 새 네임스페이스, 클라이언트가 보내는 새 메시지(`@SubscribeMessage`)는 `apps/api/src/surface/registry.ts`의 `REALTIME_GATEWAYS`에 네임스페이스를 키로 메시지 목록과 `reason`(한국어: 누가 무엇을 할 수 있고 무엇을 받는지)을 적는다. 지금은 `/ws`의 `subscribe`·`unsubscribe`다.
- 소켓에 `emit`(`emitWithAck`·`serverSideEmit` 포함)하는 코드를 더하면 `REALTIME_EMITS`에 파일(`src/` 아래 경로)·이벤트(호출에 쓴 그대로)·`reason`을 적는다. 지금 방에 가는 이벤트는 게이트웨이가 채널 계열 스키마로 파싱한 `event.type` 하나뿐이고, 그 밖의 `emit`은 그 소켓에만 가는 거절 봉투와 본문 없는 재동기화 신호다.

빠뜨리면 `registry.test.ts`가 모듈 그래프의 프로바이더에서 찾은 게이트웨이(네임스페이스와 메시지)와, 소스에서 찾은 `emit` 호출이 목록과 다르다고 실패한다.

검사: 등록한 채널이 게이트웨이가 그 이벤트를 파싱하는 계열과 같고, 시장 채널 스키마의 필드에 금지 항목과 제외 기능 이름, 확률·믿음 낱말이 없으며(공개 API, 오너 결정 2026-10-14), 본인 방 이벤트는 시장 채널 이벤트로 읽히지 않는다. 런타임 검사는 비로그인·B로 시장 방을 듣는 동안 A의 이벤트를 A의 방에 발행하고 시장 채널에도 몰래 실은 뒤, 관리자 마감으로 실제 `market:status`를 발행해 시장 방에 그것만 오는지 본다. `market:tick`·`market:trade`는 아직 발행하는 경로가 없다(#119). 공개 이벤트를 실제로 발행하는 경로를 더하는 이슈는 이 시험에서 그 경로로 이벤트를 발행해, 받은 이벤트에도 A의 값과 금지 필드가 없음을 확인하게 한다.

### 웹이 페이지 밖에서 답하는 것

`apps/web`의 라우트 핸들러(`app/` 아래의 `route.ts`), Pages Router의 API 라우트(`pages/api/`), 서버 액션(`'use server'` 파일이나 함수)은 API의 등록 목록 밖에서 요청에 답한다. 지금은 하나도 없다(읽기와 쓰기는 API로 간다). 더하면 `apps/web/src/excluded-features.test.ts`의 `WEB_SERVER_ENDPOINTS`에 `src/` 아래 파일을 키로 무엇을 답하는지와 이유를 적는다. 빠뜨리면 그 시험이 실패한다. 이 검사는 등록과 사유만 요구하고, 답의 내용은 `private-data.test.ts`가 부르지 않는다.

### 알림 유형

알림 기능(#53) 전이라 자리만 있다.

1. `packages/shared/src/guards/notifications.ts`의 `NOTIFICATION_TYPES`에 유형마다 `type`(API와 저장 행이 쓰는 이름), `text`(사람이 읽는 모든 문구: 제목과 본문, 자리표시자는 쓴 그대로), `reason`(무엇을 알리는지와 기획 절)을 넣는다.
2. #53은 알림 유형 목록을 만들 때 이 목록을 그 원천으로 쓰거나 두 목록이 같음을 시험으로 고정해, 등록되지 않은 유형이 생기지 않게 한다. 어느 쪽으로 할지는 #53이 정한다. 뒤에 유형을 더하는 이슈도 같은 목록에 넣는다.

검사: 유형 이름은 API 값이라 공개 API의 토큰(유료 구매 포함, N05 §4)으로, 문구는 화면 문구로 찾는다(`findExcludedNotification`). 점수·순위·Forecast 수정·유료 Coin 구매 유도 알림(N05 §4)과 활동량 보상 알림이 걸린다. 알림 문구는 서비스 안내가 아니므로 현금 환전·출금 미제공 밖의 부정 안내도 걸린다.

### 저장 데이터의 값 목록

Postgres enum의 값은 저절로 검사된다. varchar 열이 고정 목록에서 값을 받으면(`market_events.type` 방식) 그 목록을 `packages/db/src/storage-names.test.ts`의 `VARCHAR_VALUES`에 `'표.열'`로 넣는다. 시험은 그 열이 실제로 있는지도 본다. 활동량 보상이나 송금은 새 원장 유형이나 작업 유형으로 들어올 가능성이 크다. 이름에 보상·출석·체크인·연속 기록·송금의 토큰이 있으면 토큰으로 걸리고, 보너스를 담은 값(`LIKE_BONUS`, `TRADE_VOLUME_BONUS`)은 `BONUS_VALUES`에 이유와 함께 있어야 통과한다. 그 밖의 이름이면 걸리지 않는다(아래 '검사하지 않는 것').

### 화면

- 새 화면 문구는 그냥 검사된다. 제외 기능 낱말이 그 뜻이 아니게 들어가야 하면 위 허용 가운데 맞는 것을 쓰고, 없으면 이유와 함께 가장 좁은 허용(구절, copy 키)을 더한다.
- 관리자 화면은 따로 등록하지 않는다. `app/admin` 아래 두거나 관리자 코드만 가져다 쓰면 도박 어휘만 검사된다. 관리자 전용이던 파일을 회원 화면이 가져다 쓰기 시작하면 그 파일은 회원 화면으로 모든 항목을 검사받는다.
- 보존한 결제 코드를 회원 화면에 다시 그리려면 그것은 유료 판매를 여는 일이다(#111). `PRESERVED_PAID_SOURCES`에 파일을 더해 비켜 가지 않는다.
- 서비스 안내(#136)는 `app/(service-guide)` 아래에 두거나, 다른 자리에 두면 `SERVICE_GUIDE_ROOT`를 그 폴더로 바꾼다. 부정 안내의 모양(`NEGATIVE_NOTICE`)이 #136의 문장에 맞지 않으면 그 이슈가 넓힌다.

## 검사하지 않는 것

- 저장된 행: 관리자가 쓴 시장 문구, 사용자가 고른 닉네임, 이미 DB에 있는 자동 닉네임 `예측가_XXXX`와 시드가 이미 넣은 시장 문구(TERMS.md '범위'). 검사는 코드와 스키마만 읽는다.
- 화면에 그려진 결과(Playwright로 페이지를 훑지 않는다). 화면 수준 확인은 #189다.
- `apps/mobile`(화면이 없는 Expo 스캐폴드), 마이그레이션 SQL의 트리거·함수 이름, 공개 응답의 enum 값(예: 모든 오류 봉투에 붙는 `ErrorCode`의 `PAYMENT_GATEWAY_*`).
- 기록 문서: `docs/PLAN.md`(부록 A의 옛 문구 원칙 포함), `docs/QUESTIONS.md`, ADR 본문, 마이그레이션 주석.
- 대회 어휘(상금·참가비·우승). 제외 목록에 넣지 않았고 챌린지(#81)가 다시 본다(오너 결정 2026-10-14).
- 본인 전용·관리자 API의 경로 밖 이름(응답 필드, 문서의 작업)과 경로의 송금·활동량 보상·현금 환전·출금 밖 항목, 본인 방 이벤트의 필드 이름, 관리자 화면의 도박 어휘 밖 문구(오너 결정 2026-10-14). 비공개 정보 누출과 교차 계정 확인은 그대로 본다.
- 웹 주소의 확률·믿음 낱말(`PERSONAL_PROBABILITY_WORDS`). 확률 입력·Forecast의 토큰(`probability-input`)은 찾는다(ADR-0057 결과 5).
- 사용자에게 Coin이 들어오는 경로를 닫힌 목록으로 고정하는 일(#73). 지금은 이름으로만 찾는다. 낱말을 피한 이름(Coin 없이 `send`만 쓴 `/me/send`, 보상 낱말이 없는 원장 유형)은 걸리지 않는다.
