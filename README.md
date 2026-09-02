# buddha

한국 사용자를 대상으로, 원화로 충전한 포인트(P)로 미래 사건의 결과(예/아니오)를 예측·거래하는 웹 서비스 MVP. **P는 어떤 경우에도 현금화되지 않는다.**

설계·범위·마일스톤의 단일 진실 원천은 [docs/PLAN.md](docs/PLAN.md)다. 설계 결정은 [docs/DECISIONS.md](docs/DECISIONS.md), 미해결 질문과 가정은 [docs/QUESTIONS.md](docs/QUESTIONS.md)에 기록한다.

## 요구 사항

- Node 24 LTS (`.nvmrc`), pnpm 11 (`packageManager` 필드로 자동 선택)
- Docker Desktop (Compose v2 이상)

## 로컬 실행

```bash
cp .env.example .env
pnpm install
docker compose up -d --wait      # postgres(5432) · redis(6379) · mailpit(1025/8025)
pnpm db:migrate                  # drizzle 마이그레이션 (M0에서는 북키핑 테이블만)
pnpm dev                         # web(3000) · api(4000) · worker + 공유 패키지 watch
```

- 웹: http://localhost:3000
- API 헬스체크: http://localhost:3000/api/health (web rewrite 경유) 또는 http://localhost:4000/api/health
- Mailpit UI: http://localhost:8025

참고:

- 에디터에서 `@buddha/*` 패키지의 타입이 잡히려면 `pnpm build`(또는 `pnpm dev`)를 한 번 실행해야 한다. 공유 패키지는 컴파일된 `dist/`만 export한다.
- `docker/docker-compose.yml`의 자격 증명(postgres/postgres, buddha/buddha, 인증 없는 Redis)은 로컬 개발 전용이며 모든 포트는 `127.0.0.1`에만 열린다. API도 기본적으로 `localhost`에만 바인드한다(`.env`의 `API_HOST`).

## 스크립트

| 명령                                          | 설명                                                       |
| --------------------------------------------- | ---------------------------------------------------------- |
| `pnpm dev`                                    | 모든 앱과 패키지 watch (Turborepo persistent tasks)        |
| `pnpm build`                                  | 전체 빌드. 두 번째 실행은 `>>> FULL TURBO`(전부 캐시 히트) |
| `pnpm typecheck` / `lint` / `test`            | 각 패키지의 tsc / ESLint / Vitest                          |
| `pnpm format` / `format:check`                | Prettier                                                   |
| `pnpm db:generate` / `db:migrate` / `db:seed` | drizzle-kit 생성 / 마이그레이션 적용 / 시드                |
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
