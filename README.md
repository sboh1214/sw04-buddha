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
- 화면: /signup, /login, /set-password, /settings, /reset-password, /wallet(충전 상품·쿠폰·원장), 관리자 /admin/markets(시장 목록·생성·상세: 수정·열기·마감·무효·LMSR 상태·이벤트·체결) · /admin/users · /admin/charge-packages · /admin/coupons · /admin/payments · /admin/audit-failures. 사용자용 시장 목록·상세·매수 패널은 M4.
- 시장 API(M3): `GET /api/v1/markets`(상태·카테고리·정렬·검색, 커서), `GET /api/v1/markets/:idOrSlug`, `/fills`, `/ticks`(범위의 최신 10,000틱에서 약 500점으로 다운샘플), `GET /api/v1/categories`, `POST /api/v1/quotes`(비로그인 견적), `POST /api/v1/trades`(`Idempotency-Key` 헤더 필수, 매수 `maxCostP`/매도 `minProceedsP` 슬리피지 가드), `GET /api/v1/me/positions`, `GET /api/v1/me/orders`. 시드 시장은 rules가 정한 절대 마감 시각(KST)을 가지며 마감이 지나면 M5의 마감 잡이 닫을 때까지 `MARKET_CLOSED`로 거래를 거절한다. LMSR 준비금은 `maxLossP(p0, b)`(ADR-0027).
- 충전은 관리자가 만든 상품 단위다(시드: 4,900원→5,000P부터 90,000원→100,000P까지 2~10% 할인). 가입 시 10,000P가 자동 지급되고, 추가 지급은 쿠폰으로 한다. 시드 관리자: .env의 SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD (기본 admin@buddha.local / admin1234!)
- 통합 테스트(packages/db, apps/api)는 `docker compose --profile test up -d postgres-test redis-test`로 띄운 test 프로필(5433/6380)만 사용한다(`.env`의 `TEST_*`). 기본 `.env`는 `TEST_*`를 설정하므로 `pnpm test`/`pnpm check` 전에 test 프로필이 떠 있어야 한다(없으면 globalSetup에서 연결 오류로 실패). `TEST_*`를 비우면 해당 테스트를 건너뛴다(CI에서는 필수).
- `pnpm db:migrate`/`db:seed`는 `@buddha/shared`를 먼저 빌드한다(Turbo `dependsOn: ^build`)—스키마 enum 값이 공유 패키지에서 오기 때문이다.
- 소셜 로그인(Google/Kakao/Naver)은 `.env`에 프로바이더 키 쌍을 넣을 때만 켜진다(docs/QUESTIONS.md Q-M1-1).

참고:

- 에디터에서 `@buddha/*` 패키지의 타입이 잡히려면 `pnpm build`(또는 `pnpm dev`)를 한 번 실행해야 한다. 공유 패키지는 컴파일된 `dist/`만 export한다.
- `docker/docker-compose.yml`의 자격 증명(postgres/postgres, buddha/buddha, 인증 없는 Redis)은 로컬 개발 전용이며 모든 포트는 `127.0.0.1`에만 열린다. API도 기본적으로 `localhost`에만 바인드한다(`.env`의 `API_HOST`). 웹 dev 서버도 `next dev --hostname localhost`로 루프백에만 바인드한다. Next 기본값(모든 인터페이스)이면 `/api/*` rewrite를 통해 API까지 LAN에 노출되기 때문이다. Next는 주소 하나에만 바인드하므로 Node 24에서는 `::1`만 열린다: `http://localhost:3000`은 브라우저·curl·fetch 모두 정상이고 `http://127.0.0.1:3000`은 거부된다. 다른 기기에서 웹을 열어야 하면 `pnpm --filter web exec next dev --port 3000 -H 0.0.0.0`으로 명시적으로 열고 `next.config.ts`에 `allowedDevOrigins`를 추가한다. 로컬 standalone 실행(`pnpm --filter web start`)은 `WEB_HOST`(기본 `localhost`)를 따른다. 모바일은 ADR-0017대로 API에 직접 붙으므로 그때는 웹 포트가 아니라 `API_HOST=0.0.0.0`이 필요하다.

## 스크립트

| 명령                                          | 설명                                                       |
| --------------------------------------------- | ---------------------------------------------------------- |
| `pnpm dev`                                    | 모든 앱과 패키지 watch (Turborepo persistent tasks)        |
| `pnpm build`                                  | 전체 빌드. 두 번째 실행은 `>>> FULL TURBO`(전부 캐시 히트) |
| `pnpm typecheck` / `lint` / `test`            | 각 패키지의 tsc / ESLint / Vitest                          |
| `pnpm format` / `format:check`                | Prettier                                                   |
| `pnpm db:generate` / `db:migrate` / `db:seed` | drizzle-kit 생성 / 마이그레이션 적용 / 시드                |
| `pnpm --filter worker run job:ledger-audit`   | 원장-잔고 불변식 수동 검증 (불일치 시 종료 코드 1)         |
| `pnpm mobile:doctor`                          | Expo 스캐폴드 점검 (`expo-doctor`)                         |
| `pnpm infra:up` / `infra:down` / `infra:logs` | Docker Compose 단축 명령                                   |
| `pnpm check`                                  | format:check + lint + typecheck + test + build (CI와 동일) |

통합 테스트용 인프라(포트 5433/6380)는 `docker compose --profile test up -d`로 따로 띄운다.

## 구조

```
apps/       web (Next.js) · api (NestJS + Fastify) · worker (BullMQ) · mobile (Expo 스캐폴드)
packages/   shared (순수 도메인 로직) · db (Drizzle) · api-client (OpenAPI 클라이언트) · config-ts · config-eslint
docker/     docker-compose.yml, postgres 롤 초기화 SQL
docs/       PLAN.md · DECISIONS.md · QUESTIONS.md
```

패키지 의존 규칙은 PLAN §4.1을 따른다: 앱은 `packages/*`만 import하고, `shared`는 어떤 프레임워크에도 의존하지 않는다.
