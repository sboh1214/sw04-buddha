# buddha

한국 사용자를 대상으로, 원화로 충전한 포인트(P)로 미래 사건의 결과(예/아니오)를 예측·거래하는 웹 서비스 MVP. **P는 어떤 경우에도 현금화되지 않는다.**

설계·범위·마일스톤의 단일 진실 원천은 [docs/PLAN.md](docs/PLAN.md)다. 설계 결정은 [docs/DECISIONS.md](docs/DECISIONS.md), 미해결 질문과 가정은 [docs/QUESTIONS.md](docs/QUESTIONS.md)에 기록한다.

## 요구 사항

- Node 24 LTS (`.nvmrc`), pnpm 11 (`packageManager` 필드로 자동 선택)
- Docker Desktop 4.22 이상(Compose 2.20.2 이상, `docker compose version`으로 확인). 루트 `compose.yaml`의 `include`와 `docker/docker-compose.yml`의 헬스체크 `start_interval`이 요구하며, `start_interval`은 Docker Engine 25(Desktop 4.27) 이상에서만 실제로 적용된다.

## 로컬 실행

```bash
cp .env.example .env
pnpm install
docker compose up -d --wait      # postgres(5432) · redis(6379) · mailpit(1025/8025)
pnpm db:migrate                  # drizzle 마이그레이션 (스키마 + 롤 권한 + 프로필 트리거)
pnpm db:seed                     # 카테고리 5개 + 충전 상품 + 관리자(SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD) + 시장 12개
pnpm dev                         # web(3000) · api(4000) · worker + 공유 패키지 watch
```

- 웹: http://localhost:3000
- API 헬스체크: http://localhost:3000/api/health (web rewrite 경유) 또는 http://localhost:4000/api/health
- Mailpit UI: http://localhost:8025 (가입 인증·비밀번호 재설정·이메일 변경 메일이 여기로 온다). 이메일 가입은 주소만 입력하고, 메일의 인증 링크를 누르면 로그인된 뒤 /set-password에서 첫 비밀번호를 정한다(인증 전에는 비밀번호가 없어 로그인 불가). 운영 메일은 AWS SES(`.env.example`의 SMTP_* 주석).
- 화면: `/`(홈: 카테고리 탭·정렬·검색·시장 카드 그리드), `/markets/[slug]`(상세: 확률 차트·정산 기준·최근 체결·내 포지션·매수/매도 패널. `resolving`이면 제안된 결과·이의 마감 시각·이의 제기 폼, `settled`면 결과와 내 실현 손익), `/portfolio`(잔고·보유 포지션·정산 이력·주문 이력), /signup, /login, /set-password, /settings, /reset-password, /wallet(충전 상품·쿠폰·원장 — 정산 지급은 `SETTLEMENT_PAYOUT` 행으로 온다), 관리자 /admin/markets(시장 목록·생성·상세: 수정·열기·마감·정산 제안·결과 변경·무효·LMSR 상태·이의 건수·이벤트·체결·카드/상세 미리보기) · /admin/disputes(시장별 이의 목록·수용/기각) · /admin/users · /admin/charge-packages · /admin/coupons · /admin/payments · /admin/audit-failures. 모바일에서는 하단 탭(홈·포트폴리오·지갑·설정)이 붙고, 시장 상세에서만 그 자리를 거래 바가 대신한다.
- 시장 API: `GET /api/v1/markets`(상태·카테고리·정렬·검색, 커서. 카드마다 최근 24시간을 1시간 간격으로 뽑은 확률 표본 최대 25점이 `sparkline`으로 함께 온다), `GET /api/v1/markets/:idOrSlug`, `/fills`, `/ticks`(응답은 `{ resolution, bucketSeconds, from, to, truncated, points }`인 `PriceSeries`다. `raw`는 범위의 최신 10,000틱에서 최대 500점으로 다운샘플하고 첫·끝점을 유지하며 더 오래된 틱을 뺐으면 `truncated`로 알린다. `1m`/`1h`는 절대 격자 위의 표본이고 — 경계마다 그 시각 이하의 마지막 틱 — 창이 넓으면 stride를 굵게 바꿔 실제 값을 `bucketSeconds`로 돌려준다), `GET /api/v1/categories`, `POST /api/v1/quotes`(비로그인 견적), `POST /api/v1/trades`(`Idempotency-Key` 헤더 필수, 매수 `maxCostP`/매도 `minProceedsP` 슬리피지 가드), `GET /api/v1/me/positions`, `GET /api/v1/me/orders`. 시드 시장은 rules가 정한 절대 마감 시각(KST)을 가지며 마감이 지나면 워커의 `market.close` 잡이 닫을 때까지(1분 안) `MARKET_CLOSED`로 거래를 거절한다. LMSR 준비금은 `maxLossP(p0, b)`(ADR-0027), 틱·스파크라인은 ADR-0029·ADR-0030.
- 정산·이의(M5, ADR-0033): 관리자가 `POST /api/v1/admin/markets/:id/resolve {result, note?, evidenceUrl?}`로 `closed` 시장에 결과를 제안하면 `resolving`이 되고 `disputeUntil = 제안 시각 + TEST_DISPUTE_WINDOW_SECONDS`(기본 86,400초)다. 같은 라우트를 `resolving`에서 다른 결과로 부르면 결과가 바뀌고 이의 기간이 처음부터 다시 시작된다(같은 결과는 거절). 사용자는 `POST /api/v1/markets/:id/disputes {reason, evidenceUrl?}`로 시장당 한 번 이의를 내고(`resolving`이고 마감 전일 때만 — 지났거나 끝난 시장은 `DISPUTE_WINDOW_CLOSED`, 두 번째는 `DUPLICATE_REQUEST`), `GET /api/v1/me/disputes`로 본다. 관리자는 `GET /api/v1/admin/disputes?status=&marketId=`와 `PATCH /api/v1/admin/disputes/:id {status: accepted|rejected, adminNote?}`로 처리하되, 수용해도 결과는 자동으로 바뀌지 않는다(시장 상세에서 결과 변경을 따로 누른다). 확정은 워커가 한다: `market.finalize`가 `disputeUntil`에 맞춰 예약된 지연 잡으로, 그리고 매 분 스캔으로 돌아 맞힌 계약에 100P씩 지급하고(`SETTLEMENT_PAYOUT`) 포지션을 닫는다. 모든 시장 DTO와 `market:status` 이벤트는 마지막 전이의 `market_events.id`를 `statusEventId`로 실어 클라이언트가 상태 순위 대신 그 키로 순서를 정한다(같은 상태의 결과 변경도 구분된다).
- 워커(`apps/worker`): 큐 `markets`의 `market.close`·`market.finalize`(API가 마감·이의 마감 시각에 맞춰 예약하는 지연 잡 + 매 분 안전망 스캔), `audit`의 `ledger.audit`(매일 04:00 KST). `GET http://localhost:4100/health`(`WORKER_HOST`/`WORKER_HEALTH_PORT`, 0이면 끔)가 준비 상태를 답한다.
- 실시간(M4): Socket.IO 네임스페이스 `/ws`. 방은 `market:{시장 id}`와 `user:{계정 id}`이고 클라이언트는 `subscribe`/`unsubscribe`에 `{ marketIds }`만 보낸다(계정 방은 핸드셰이크 세션을 보고 서버가 넣는다). 이벤트는 PLAN §8의 다섯 가지(`market:tick`·`market:trade`·`market:status`·`user:balance`·`user:position`)와 게이트웨이가 Redis 구독을 다시 걸었을 때의 `realtime:resync`이며, ack는 없고 거절만 `exception`에 `{ error: { code, message, details } }`로 온다. **브라우저는 `/api/*` rewrite가 아니라 `NEXT_PUBLIC_API_URL`(기본 http://localhost:4000)에 직접 붙는다** — Next rewrite는 WebSocket 업그레이드를 프록시하지 않기 때문이다(Q-M0-2, ADR-0017). `WEB_ORIGIN`이 그 핸드셰이크의 CORS와 Origin 검사를 함께 결정한다(ADR-0028).
- 충전은 관리자가 만든 상품 단위다(시드: 4,900원→5,000P부터 90,000원→100,000P까지 2~10% 할인). 가입 시 10,000P가 자동 지급되고, 추가 지급은 쿠폰으로 한다. 시드 관리자: .env의 SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD (기본 admin@buddha.local / admin1234!)
- 통합 테스트(packages/db, apps/api)는 `docker compose --profile test up -d postgres-test redis-test`로 띄운 test 프로필(5433/6380)만 사용한다(`.env`의 `TEST_*`). 기본 `.env`는 `TEST_*`를 설정하므로 `pnpm test`/`pnpm check` 전에 test 프로필이 떠 있어야 한다(없으면 globalSetup에서 연결 오류로 실패). `TEST_*`를 비우면 해당 테스트를 건너뛴다(CI에서는 필수).
- `pnpm db:migrate`/`db:seed`는 `@buddha/shared`를 먼저 빌드한다(Turbo `dependsOn: ^build`)—스키마 enum 값이 공유 패키지에서 오기 때문이다.
- 소셜 로그인(Google/Kakao/Naver)은 `.env`에 프로바이더 키 쌍을 넣을 때만 켜진다(docs/QUESTIONS.md Q-M1-1).

참고:

- 에디터에서 `@buddha/*` 패키지의 타입이 잡히려면 `pnpm build`(또는 `pnpm dev`)를 한 번 실행해야 한다. 공유 패키지는 컴파일된 `dist/`만 export한다.
- `docker/docker-compose.yml`의 자격 증명(postgres/postgres, buddha/buddha, 인증 없는 Redis)은 로컬 개발 전용이며 모든 포트는 `127.0.0.1`에만 열린다. API도 기본적으로 `localhost`에만 바인드한다(`.env`의 `API_HOST`). 웹 dev 서버도 `next dev --hostname localhost`로 루프백에만 바인드한다. Next 기본값(모든 인터페이스)이면 `/api/*` rewrite를 통해 API까지 LAN에 노출되기 때문이다. Next는 주소 하나에만 바인드하므로 Node 24에서는 `::1`만 열린다: `http://localhost:3000`은 브라우저·curl·fetch 모두 정상이고 `http://127.0.0.1:3000`은 거부된다. 다른 기기에서 웹을 열어야 하면 `pnpm --filter web exec next dev --port 3000 -H 0.0.0.0`으로 명시적으로 열고 `next.config.ts`에 `allowedDevOrigins`를 추가한다. 로컬 standalone 실행(`pnpm --filter web start`)은 `WEB_HOST`(기본 `localhost`)를 따른다. 모바일은 ADR-0017대로 API에 직접 붙으므로 그때는 웹 포트가 아니라 `API_HOST=0.0.0.0`이 필요하다. M4부터는 브라우저도 실시간 소켓 때문에 `localhost:4000`에 직접 붙는다: 다른 기기에서 웹을 열려면 웹 포트를 여는 것만으로 부족하고 그 기기에서 API가 닿아야 하며(`API_HOST=0.0.0.0`), 빌드 시점에 번들로 들어가는 `NEXT_PUBLIC_API_URL`과 핸드셰이크를 통과시킬 `WEB_ORIGIN`이 실제 주소와 맞아야 한다.

## 스크립트

| 명령                                          | 설명                                                       |
| --------------------------------------------- | ---------------------------------------------------------- |
| `pnpm dev`                                    | 모든 앱과 패키지 watch (Turborepo persistent tasks)        |
| `pnpm build`                                  | 전체 빌드. 두 번째 실행은 `>>> FULL TURBO`(전부 캐시 히트) |
| `pnpm typecheck` / `lint` / `test`            | 각 패키지의 tsc / ESLint / Vitest                          |
| `pnpm format` / `format:check`                | Prettier                                                   |
| `pnpm db:generate` / `db:migrate` / `db:seed` | drizzle-kit 생성 / 마이그레이션 적용 / 시드                |
| `pnpm --filter worker run job:ledger-audit`   | 원장-잔고 불변식 수동 검증 (불일치 시 종료 코드 1)         |
| `pnpm --filter web test:e2e`                  | Playwright e2e (mobile-375 · desktop-1280)                 |
| `pnpm mobile:doctor`                          | Expo 스캐폴드 점검 (`expo-doctor`)                         |
| `pnpm infra:up` / `infra:down` / `infra:logs` | Docker Compose 단축 명령                                   |
| `pnpm check`                                  | format:check + lint + typecheck + test + build (CI와 동일) |

통합 테스트용 인프라(포트 5433/6380)는 `docker compose --profile test up -d`로 따로 띄운다.

e2e는 개발 스택 전체를 쓴다(test 프로필이 아니라 `.env`의 기본 DB다). 한 번만 `pnpm --filter web exec playwright install chromium`으로 브라우저를 받고(버전은 `@playwright/test`와 맞춰야 한다), `docker compose up -d --wait`(Mailpit 포함) → `pnpm db:migrate` → `pnpm db:seed`(스펙이 관리자 API로 시장을 직접 만들므로 `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` 계정이 필요하다) → `pnpm dev`를 띄운 뒤 `pnpm --filter web test:e2e`를 돌린다. 이미 떠 있는 서버는 그대로 쓰고 다른 웹 오리진은 `E2E_BASE_URL`로 가리킬 수 있으며, 가입 흐름은 `MAILPIT_URL`(기본 http://127.0.0.1:8025)의 메일함을 폴링한다. 스펙은 자기 계정과 자기 시장을 매번 새로 만들므로 같은 데이터베이스에서 반복 실행해도 된다. 정산 스펙(`settlement.spec.ts`)은 워커가 떠 있어야 하고(`pnpm dev`가 띄운다; 없으면 Playwright가 `.env`의 `WORKER_HEALTH_PORT`(기본 4100)로 `/health`를 확인하며 직접 띄운다; `0`이면 확인할 포트가 없어 정산 스펙만 건너뛴다) API가 `TEST_DISPUTE_WINDOW_SECONDS=8`처럼 짧은 이의 기간으로 떠 있어야 한다 — 기본 24시간이면 그 스펙만 이유를 남기고 건너뛴다(CI는 8초로 돈다).

## 구조

```
apps/       web (Next.js) · api (NestJS + Fastify) · worker (BullMQ) · mobile (Expo 스캐폴드)
packages/   shared (순수 도메인 로직) · db (Drizzle) · api-client (OpenAPI 클라이언트) · config-ts · config-eslint
docker/     docker-compose.yml, postgres 롤 초기화 SQL
docs/       PLAN.md · DECISIONS.md · QUESTIONS.md
```

패키지 의존 규칙은 PLAN §4.1을 따른다: 앱은 `packages/*`만 import하고, `shared`는 어떤 프레임워크에도 의존하지 않는다.
