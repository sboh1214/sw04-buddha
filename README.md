# buddha

한국 사용자를 대상으로, 원화로 충전한 포인트(P)로 미래 사건의 결과(예/아니오)를 예측·거래하는 웹 서비스 MVP. **P는 어떤 경우에도 현금화되지 않는다.**

이 문서는 **실행과 길찾기**만 다룬다. 나머지는 각자의 자리가 있다.

| 문서                                   | 내용                                                        |
| -------------------------------------- | ----------------------------------------------------------- |
| [docs/PLAN.md](docs/PLAN.md)           | 설계·범위·마일스톤의 단일 진실 원천                         |
| [docs/API.md](docs/API.md)             | HTTP·실시간 API 계약 (OpenAPI에서 생성, 손으로 고치지 않음) |
| [docs/DECISIONS.md](docs/DECISIONS.md) | ADR 로그 — 왜 그렇게 됐는지                                 |
| [docs/QUESTIONS.md](docs/QUESTIONS.md) | 미해결 질문과 그동안의 가정                                 |

## 요구 사항

- **Node 24.** `.nvmrc`가 `24`, `package.json`의 `engines.node`가 `>=24.0.0`이다. nvm-windows는 `nvm install 24 && nvm use 24`, fnm은 `fnm use --install-if-missing`.
- **pnpm 11.** 저장소가 `packageManager: "pnpm@11.10.0"`을 선언하지만, 그 값이 저절로 쓰이는 것은 **Corepack이 켜져 있을 때뿐이다.** 클론 직후 한 번 `corepack enable`을 실행한다(Node 24에 동봉되어 있다). 권한 오류가 나면 관리자 셸에서 한 번 실행하거나, Corepack을 쓰지 않고 `npm i -g pnpm@11`로 직접 설치한다 — `engines.pnpm`이 `>=11.10.0`이라 10.x로는 설치가 거절된다.
- **Docker Desktop 4.22 이상이 실행 중일 것.** 설치되어 있는 것만으로는 부족하다. 엔진이 떠 있어야 `docker compose`가 동작한다(`docker compose version`으로 Compose 2.20.2 이상을 확인). 루트 `compose.yaml`의 `include`가 Compose 2.20.0을, `docker/docker-compose.yml`의 헬스체크 `start_interval`이 2.20.2 스키마를 요구하고, `start_interval`은 Docker Engine 25(Desktop 4.27) 이상에서만 실제로 적용된다(ADR-0014).
- **Windows라면** 아래 [문제 해결](#문제-해결)의 첫 항목(WinNAT 예약 포트)을 기동 전에 먼저 읽는다. 안 읽으면 `docker compose up`이 bind 오류로 멈춘다.

## 로컬 실행

```bash
corepack enable                  # 한 번만. pnpm 11 을 packageManager 필드에서 가져온다
cp .env.example .env             # 기본값 그대로 로컬에서 동작한다
pnpm install

# Windows: 아래 "문제 해결 · WinNAT" 를 읽고 필요하면 먼저
#   cp compose.override.example.yaml compose.override.yaml   (+ .env 의 REDIS_URL/TEST_REDIS_URL)

docker compose up -d --wait      # postgres(5432) · redis(6379) · mailpit(1025/8025)
pnpm db:migrate                  # drizzle 마이그레이션 (스키마 + 롤 권한 + 프로필 트리거)
pnpm db:seed                     # 카테고리 5개(+세부 21개) + 충전 상품 5개 + 관리자 + 시장 14개
pnpm dev                         # web(3000) · api(4000) · worker + 공유 패키지 watch
```

시간의 대부분은 `pnpm install`과 첫 이미지 pull이 쓴다. 나머지는 몇 초씩이다. PowerShell에서도 그대로 붙여 넣으면 된다 — `cp`는 `Copy-Item`의 별칭이다.

기동을 확인하는 자리:

- 웹 <http://localhost:3000>
- API 레디니스 <http://localhost:3000/api/health>(web rewrite 경유) 또는 <http://localhost:4000/api/health>. 워커는 <http://localhost:4100/health>.
- Mailpit UI <http://localhost:8025> — 가입 인증·비밀번호 재설정·이메일 변경 메일이 전부 여기로 온다. 이메일 가입은 **주소만** 입력하고, 메일의 인증 링크를 누르면 로그인된 뒤 `/set-password`에서 첫 비밀번호를 정한다(인증 전에는 비밀번호가 없어 로그인할 수 없다). 운영 메일은 AWS SES(`.env.example`의 `SMTP_*` 주석).
- 관리자 로그인은 `.env`의 `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`(기본 `admin@buddha.local` / `admin1234!`). 이 두 값이 없으면 `pnpm db:seed`가 관리자와 시드 시장을 통째로 건너뛴다.
- 가입하면 10,000P가 자동 지급된다(`SIGNUP_BONUS_P`). 추가 지급은 관리자의 쿠폰으로 한다. 충전은 관리자가 만든 상품 단위다(시드: 4,900원→5,000P부터 90,000원→100,000P까지 2~10% 할인).
- 소셜 로그인(Google/Kakao/Naver)은 `.env`에 그 프로바이더의 키 **쌍**을 넣을 때만 켜진다(Q-M1-1).

화면은 다음과 같다. 모바일 폭에서는 하단 탭(홈·포트폴리오·지갑·설정)이 붙고, 시장 상세에서만 그 자리를 거래 바가 대신한다.

| 경로                                                                                               | 화면                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                                                                                | 홈(Kalshi 형, ADR-0041) — 헤더 2단(시장·랭킹·커뮤니티 / 전체·카테고리)·세부 분류 사이드바·정렬·시장 카드 그리드(카드마다 예/아니오 두 줄과 24시간 스파크라인) |
| `/community`                                                                                       | 커뮤니티 — 자리만 있는 화면(준비 중)                                                                                                                          |
| `/markets/[slug]`                                                                                  | 시장 상세 — 확률 차트·정산 기준·최근 체결·내 포지션·매수/매도 패널. `resolving`이면 제안된 결과와 이의 제기 폼, `settled`면 결과와 실현 손익                  |
| `/portfolio`                                                                                       | 잔고·보유 포지션·정산 이력·주문 이력                                                                                                                          |
| `/wallet`                                                                                          | 충전 상품·쿠폰·원장(정산 지급은 `SETTLEMENT_PAYOUT` 행)                                                                                                       |
| `/leaderboard`                                                                                     | 실현 손익 상위 20 (공개, `LEADERBOARD_LIMIT`)                                                                                                                 |
| `/signup` `/login` `/set-password` `/reset-password` `/settings`                                   | 인증과 계정                                                                                                                                                   |
| `/admin/markets` `/admin/markets/[id]` `/admin/disputes`                                           | 시장 생성·수정·열기·마감·정산 제안·결과 변경·무효, 이의 수용/기각                                                                                             |
| `/admin/users` `/admin/charge-packages` `/admin/coupons` `/admin/payments` `/admin/audit-failures` | 계정·상품·쿠폰·결제·원장 감사 실패                                                                                                                            |

## 문제 해결

### `docker compose up`이 bind 오류로 죽는다 (Windows 전용)

```
bind: An attempt was made to access a socket in a way forbidden by its access permissions
```

Windows는 WinNAT/Hyper-V를 위해 100포트짜리 TCP 범위를 **동적으로** 예약하고, 그 안의 포트는 Docker가 게시할 수 없다. 범위는 부팅마다 옮겨 다니며, `docker/docker-compose.yml`이 쓰는 Redis 6379·6380과 Mailpit 8025가 자주 그 안에 들어간다. 지금 예약된 범위는 이렇게 본다.

```powershell
netsh int ipv4 show excludedportrange protocol=tcp
```

관리자 셸에서 `net stop winnat; net start winnat`으로 한 번 지울 수는 있지만 재부팅하면 다른 위치에 다시 생긴다. 영구적인 해법은 게시 포트를 범위 밖으로 옮기는 것이고, 그 파일이 저장소에 있다.

```bash
cp compose.override.example.yaml compose.override.yaml
```

Compose는 `compose.override.yaml`만 자동으로 읽는다(`.example.` 이름은 읽지 않는다). 복사본은 `.gitignore`에 있어 커밋되지 않으므로 머신마다 마음대로 고쳐도 된다. 옮긴 포트는 **컨테이너 안쪽이 아니라 호스트 쪽뿐**이며, 그만큼 `.env`와 e2e 환경 변수를 맞춰야 한다.

| 서비스     | 기본 | 오버라이드 | 맞춰야 하는 값                                                        |
| ---------- | ---- | ---------- | --------------------------------------------------------------------- |
| redis      | 6379 | 6479       | `.env`의 `REDIS_URL=redis://localhost:6479`                           |
| redis-test | 6380 | 6480       | `.env`의 `TEST_REDIS_URL=redis://localhost:6480`                      |
| mailpit UI | 8025 | 8125       | e2e의 `MAILPIT_URL=http://127.0.0.1:8125` (`apps/web/e2e/helpers.ts`) |

Mailpit UI도 그때부터 <http://localhost:8125>다. Postgres 5432/5433과 SMTP 1025는 예약 범위를 피해 다녀서 그대로 둔다.

### `pnpm install`이 `ERR_PNPM_IGNORED_BUILDS`로 실패한다

pnpm 11은 `strictDepBuilds`가 기본 `true`라, 검토되지 않은 (post)install 스크립트를 가진 의존성이 하나라도 있으면 설치를 실패시킨다. 판단은 `pnpm-workspace.yaml`의 `allowBuilds`에 적혀 있다(`esbuild`·`msgpackr-extract`는 허용, `fsevents`·`@scarf/scarf`는 금지). 새 의존성을 추가하다 이 오류를 만나면 그 항목을 `allowBuilds`에 명시적으로 넣거나 `pnpm approve-builds <pkg>`를 실행하고, 결과를 커밋한다 — 오류를 지우려고 스크립트를 무턱대고 켜지 않는다.

같은 파일 아래쪽의 `minimumReleaseAgeExclude`는 다른 이야기다. pnpm 11은 배포된 지 24시간이 안 된 버전을 기본적으로 경계하는데(`minimumReleaseAge`), 카탈로그가 그런 버전을 고정하고 있으면 설치는 해 주되 이 목록을 파일 끝에 **덧붙인다**. 그 목록은 반드시 커밋한다: 없으면 CI의 `pnpm install --frozen-lockfile`이 락파일을 거절한다.

### 에디터가 `@buddha/*` 타입을 못 찾는다

공유 패키지는 컴파일된 `dist/`만 export한다. `pnpm build`(또는 `pnpm dev`)를 **한 번** 돌리면 잡힌다. 같은 이유로 `pnpm db:migrate`/`db:seed`는 실행 전에 `@buddha/shared`를 먼저 빌드한다(Turbo `dependsOn: ^build`) — 스키마 enum 값이 공유 패키지에서 오기 때문이다.

### `pnpm test` / `pnpm check`가 연결 오류로 실패한다

`packages/db`와 `apps/api`의 통합 테스트는 개발 DB를 절대 건드리지 않고 **test 프로필**(5433/6380)만 쓴다. 기본 `.env`가 `TEST_*`를 채워 두므로, 그 프로필이 떠 있지 않으면 globalSetup이 연결 오류로 죽는다.

```bash
docker compose --profile test up -d postgres-test redis-test
```

`TEST_*`를 비우면 해당 스위트를 건너뛴다(CI에서는 `CI=true`라 건너뛰지 않고 실패한다).

### `pnpm --filter web start`가 BUILD_ID 불일치로 종료한다

```
standalone output is stale (BUILD_ID ... != ...)
```

`.next/standalone/**`은 Turbo 캐시에서 제외되어 있다(ADR-0016 — Windows에서 pnpm 심링크 경로가 캐시 tar에 들어가지 않았다). 그래서 빌드가 캐시 히트하면 `.next/BUILD_ID`만 복원되고 standalone 복사본은 이전 빌드의 것으로 남는다. 안내대로 강제 재빌드한다.

```bash
pnpm turbo run build --filter=web --force
```

### 다른 기기에서 웹이 안 열린다

기본값은 전부 루프백이다. API는 `.env`의 `API_HOST`(기본 `localhost`), 웹 dev 서버는 `next dev --hostname localhost`, 로컬 standalone 실행은 `WEB_HOST`(기본 `localhost`)를 따른다. Next 기본값(모든 인터페이스)이면 `/api/*` rewrite를 통해 API까지 LAN에 노출되기 때문이다(ADR-0015). Next는 주소 하나에만 바인드하므로 Node 24에서는 `::1`만 열린다 — `http://localhost:3000`은 브라우저·curl·fetch 모두 정상이고 `http://127.0.0.1:3000`은 거부된다.

정말 열어야 한다면 웹 포트만으로는 부족하다. M4부터 브라우저가 실시간 소켓 때문에 API에 직접 붙으므로(아래 [아키텍처](#아키텍처)) 그 기기에서 API도 닿아야 한다: `pnpm --filter web exec next dev --port 3000 -H 0.0.0.0` + `next.config.ts`의 `allowedDevOrigins`, `API_HOST=0.0.0.0`, 그리고 빌드 시점에 번들로 들어가는 `NEXT_PUBLIC_API_URL`과 핸드셰이크를 통과시킬 `WEB_ORIGIN`이 실제 주소와 맞아야 한다.

### 시드 시장이 거래를 거절한다 (`MARKET_CLOSED`)

시드 시장은 `rules`가 정한 절대 마감 시각(KST)을 갖는다. 그 시각이 지난 시장은 워커의 `market.close` 잡이 실제로 닫을 때까지(매 분 스캔이므로 1분 안) `MARKET_CLOSED`로 거래를 거절한다. 워커가 떠 있어야 정상으로 돌아온다.

## 아키텍처

```
                                  [Browser]
                                      |
             +------------------------+---------------------+
             | HTML + REST (same-origin /api/*)             | Socket.IO /ws
             v                                              | (NEXT_PUBLIC_API_URL)
   [apps/web  Next.js :3000]                                |
     SSR / RSC                                              |
     rewrite  /api/:path*  -------------------+             |
     src/lib/api.server.ts -------------------+             |
       (bypasses the rewrite)                 |             |
                                              v             v
                             [apps/api  NestJS + Fastify :4000]
                               /api/auth/*   better-auth
                               /api/v1/*     REST + rate limit + security headers
                               /ws           Socket.IO gateway
                               /api/health   readiness    /api/health/live   liveness
                                          |
              +---------------------------+----------------------+
              v                           v                      v
     [Postgres :5432]                    [Redis :6379]    [Mailpit :1025 / :8025]
       Drizzle                             pub/sub        SMTP -> AWS SES
              ^                            BullMQ queues
              |                            rate-limit buckets
              |                           ^
              +-----------+---------------+
                          |
            [apps/worker  BullMQ  /health :4100]
              markets : market.close, market.finalize
              audit   : ledger.audit (04:00 KST)
```

- **브라우저가 API로 가는 길은 두 개다.** REST와 문서는 Next의 서버 사이드 rewrite(`/api/:path*`)를 타서 같은 오리진으로 남고, Socket.IO만 `NEXT_PUBLIC_API_URL`(기본 `http://localhost:4000`)에 **직접** 붙는다. Next rewrite가 WebSocket 업그레이드를 프록시하지 않기 때문이다(Q-M0-2, ADR-0017). `WEB_ORIGIN`이 그 핸드셰이크의 CORS와 Origin 검사를 함께 결정한다.
- **서버 사이드 호출은 rewrite를 타지 않는다.** `apps/web/src/lib/api.server.ts`(공개 읽기 전용)와 `session.server.ts`는 API 오리진을 직접 부른다. 상대 경로는 서버 컴포넌트가 fetch할 수 없고, 세션 쿠키는 의도적으로 전달하지 않는다.
- **Redis는 세 가지 일을 겸한다.** 실시간 pub/sub(API 게이트웨이와 워커가 함께 쓴다), BullMQ 큐와 지연 잡, 레이트 리밋·멱등성 키. 워커는 API와 직접 말하지 않고 Postgres와 Redis만 통해 붙는다(PLAN §9).
- **워커가 발행하면 게이트웨이가 중계한다.** `market.close`·`market.finalize`(API가 마감·이의 마감 시각에 맞춰 예약하는 지연 잡 + 매 분 안전망 스캔)와 `ledger.audit`(매일 04:00 KST). 잡 결과는 Redis로 나가고, `/ws` 게이트웨이가 그것을 브라우저의 방으로 밀어 준다. 이벤트 목록·룸·순서 키는 [docs/API.md](docs/API.md)의 실시간 절.
- **메일은 API만 보낸다.** 워커에는 메일러가 없다.

PLAN 부록 C의 다이어그램은 M4 이전 그림이라 위와 다르다(브라우저가 rewrite로만 API에 닿고, Mailpit이 없다).

### M6에서 들어온 것

- **레이트 리밋** — 한도 표는 `packages/shared/src/rate-limit.ts` 한 곳에 있고(클라이언트도 읽는 계약이다), 구현은 `apps/api/src/rate-limit/`에 있으며 카운터는 Redis에 있다 — 주소별 기본 한도는 파싱·핸들러보다 앞서 도는 Fastify 훅(`address-limit.ts`, 파싱 실패·404까지 센다), 지목한 버킷은 `/api/v1/*`에서는 Nest 가드(`@RateLimit`), `/api/auth/*`에서는 better-auth의 `hooks.before`(`auth.ts`)다. 버킷·헤더·면제는 [docs/API.md](docs/API.md)의 레이트 리밋 절. **주의: 주소별 기본 한도는 클라이언트를 지목할 수 없는 피어에게 적용되지 않는다.** 브라우저 요청은 Next rewrite라는 서버 사이드 프록시를 거쳐 오므로 Fastify가 보는 주소는 방문자가 아니라 웹 서버의 것이고, Next가 채우는 `X-Forwarded-For`는 클라이언트가 덮어쓸 수 있어 `TRUST_PROXY`는 `false`로 둔다(A-M0-13, ADR-0034). 그래서 "클라이언트를 지목할 수 없는 주소는 아예 세지 않는다"가 규칙이다 — 전부 한 통에 넣으면 방문자 전체가 하나의 100/분을 나눠 쓰게 된다. 루프백은 내장이고, **웹 서버를 다른 호스트·컨테이너에 두는 배포는 그 주소를 `RATE_LIMIT_UNCOUNTED_PEERS`에 적어야 한다** — 비워 두면 사이트 전체가 한 통이다. 근거는 `apps/api/src/rate-limit/rate-limit.tracker.ts`에 길게 적혀 있다. 방문자별 한도를 되살리는 것은 웹 서버 **앞**에서 `/api/*`를 API로 바로 넘기며 `X-Forwarded-For`에 방문자를 덧붙이는 리버스 프록시와 그 CIDR을 담은 `TRUST_PROXY`다 — 그래도 웹 호스트는 목록에 남는다(SSR과 서버 컴포넌트의 세션 호출은 여전히 거기서 온다). 계정별·이메일별 버킷은 rewrite 뒤에서도 처음부터 정상 동작한다.
- **요청 로깅** — `LOG_LEVEL`이 이제 `apps/api`에도 적용된다(`apps/api/src/logger.ts`). 워커와 같은 모양의 pino로 요청 한 건이 한 줄의 JSON이 되고(개발에서는 pino-pretty), 요청마다 생성한 id로 도착·완료·핸들러 로그가 한 줄기로 묶인다. 기본값은 개발 `debug` / 운영 `info`. URL은 쿼리 문자열을 떼고 남기고(관리자 검색어가 로그에 남지 않도록) 매칭된 라우트 패턴을 함께 적는다.
- **헬스체크** — `GET /api/health`는 **레디니스**(db·redis를 각각 2초 상한으로 프로브하고, 하나라도 실패하면 같은 본문 모양으로 503), `GET /api/health/live`는 **라이브니스**(아무것도 프로브하지 않는다). 둘을 바꿔 물리면 Redis가 한 번 흔들렸다는 이유로 컨테이너가 재시작된다. 워커의 `GET :4100/health`도 `uptimeSeconds`와 소비 중인 큐 이름을 함께 답한다(200/503의 뜻은 그대로).
- **보안 헤더** — API는 `@fastify/helmet`(`apps/api/src/infra/http/security-headers.ts`), 웹은 `next.config.ts`의 `headers()`가 각자 붙인다. `/api/*`로 프록시되는 응답에는 웹이 헤더를 덧붙이지 않는다 — 한 응답에 CSP가 둘이면 브라우저가 교집합으로 강제해서, 어느 파일에도 적혀 있지 않은 정책이 만들어진다.

## 배포

운영은 **AWS EC2 `t4g.small` 한 대**(`ap-northeast-2`)에 Docker Compose로 올라간다 — Caddy가 `https://buddha.sboh.dev` 하나의 오리진에서 `/api/*`·`/socket.io/*`를 api로, 나머지를 web으로 넘기고, Postgres·Redis는 같은 호스트의 별도 EBS(`/data`, 일일 스냅샷)에 산다. 내부 테스터 3명용 최소 비용 구성(월 ≈ $22)이고, 그렇게 정한 이유와 재검토 조건은 [ADR-0040](docs/DECISIONS.md)에 있다. 앱 코드는 로컬과 같다 — 위 아키텍처 그림에서 브라우저가 API에 닿는 두 길(Next rewrite, `NEXT_PUBLIC_API_URL` 직접 연결)이 운영에서는 둘 다 Caddy를 지난다는 점만 다르다.

- **인프라**는 [terraform/](terraform/README.md)(리소스는 전부 `tf-buddha-` 접두사, 부트스트랩·롤백·복구·시크릿 교체 절차가 그 README에 있다).
- **호스트에서 도는 것**은 [deploy/](deploy/)(`compose.yaml` · `Caddyfile` · `deploy.sh` · `host-setup.sh`) — api 이미지에 동봉되어 배포마다 `/data/buddha`에 풀린다. 이미지는 루트 `Dockerfile`의 세 타깃(`api` / `worker` / `web`)이다.
- **배포**는 `main`에 push하면 [.github/workflows/deploy.yml](.github/workflows/deploy.yml)이 arm64 이미지를 ECR에 밀고 SSM으로 호스트에서 `migrate && seed` → 컨테이너 교체 → `/api/health` 스모크까지 한다. 롤백은 `gh workflow run deploy.yml --ref main -f image_tag=<sha>`. SSH는 없고 셸은 `aws ssm start-session`이다.

## 스크립트

| 명령                                          | 설명                                                                                                                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                    | 모든 앱과 패키지 watch (Turborepo persistent tasks)                                                                                                                                                   |
| `pnpm build`                                  | 전체 빌드. 두 번째 실행은 `>>> FULL TURBO`(전부 캐시 히트)                                                                                                                                            |
| `pnpm typecheck` / `lint` / `test`            | 각 패키지의 tsc / ESLint / Vitest                                                                                                                                                                     |
| `pnpm format` / `format:check`                | Prettier                                                                                                                                                                                              |
| `pnpm db:generate` / `db:migrate` / `db:seed` | drizzle-kit 생성 / 마이그레이션 적용 / 시드                                                                                                                                                           |
| `pnpm api:openapi`                            | OpenAPI 문서 재생성 → api-client 타입 → `docs/API.md`. CI의 `OpenAPI contract check`가 이것을 다시 돌린 뒤 `git diff --exit-code`로 검사하므로, 컨트롤러나 zod 스키마를 고쳤으면 결과를 함께 커밋한다 |
| `pnpm infra:up` / `infra:down` / `infra:logs` | Docker Compose 단축 명령                                                                                                                                                                              |
| `pnpm mobile:doctor`                          | Expo 스캐폴드 점검 (`expo-doctor`)                                                                                                                                                                    |
| `pnpm check`                                  | format:check + lint + typecheck + test + build (CI와 동일)                                                                                                                                            |
| `pnpm --filter worker run job:ledger-audit`   | 원장-잔고 불변식 수동 검증 (불일치 시 종료 코드 1)                                                                                                                                                    |
| `pnpm --filter web test:e2e`                  | Playwright e2e (mobile-375 · desktop-1280)                                                                                                                                                            |
| `pnpm --filter @buddha/db run db:studio`      | drizzle-kit studio                                                                                                                                                                                    |

## 테스트

단위·통합 테스트(`pnpm test`)는 docker의 **test 프로필**(5433/6380)을 쓴다. 위 [문제 해결](#pnpm-test--pnpm-check가-연결-오류로-실패한다) 참고.

e2e는 반대로 **개발 스택 전체**를 쓴다(test 프로필이 아니라 `.env`의 기본 DB다). 준비는 한 번만 하면 된다.

```bash
pnpm --filter web exec playwright install chromium   # 버전은 @playwright/test 와 맞아야 한다
docker compose up -d --wait                          # Mailpit 포함
pnpm db:migrate && pnpm db:seed                      # 스펙이 관리자 API로 시장을 직접 만든다
pnpm dev                                             # 이미 떠 있으면 그대로 쓴다
pnpm --filter web test:e2e
```

- 다른 웹 오리진은 `E2E_BASE_URL`로 가리킨다. 가입 흐름은 `MAILPIT_URL`(기본 `http://127.0.0.1:8025`)의 메일함을 폴링한다.
- 스펙은 매번 자기 계정과 자기 시장을 새로 만들므로 같은 데이터베이스에서 반복 실행해도 된다.
- 정산 스펙(`settlement.spec.ts`)은 워커가 떠 있어야 하고(`pnpm dev`가 띄운다. 없으면 Playwright가 `WORKER_HEALTH_PORT`(기본 4100)의 `/health`를 확인해 직접 띄우고, `0`이면 확인할 포트가 없어 이 스펙만 건너뛴다), API가 `TEST_DISPUTE_WINDOW_SECONDS=8`처럼 짧은 이의 기간으로 떠 있어야 한다 — 기본 24시간이면 이유를 남기고 건너뛴다(CI는 8초로 돈다).

## 구조

```
apps/       web (Next.js) · api (NestJS + Fastify) · worker (BullMQ) · mobile (Expo 스캐폴드)
packages/   shared (순수 도메인 로직) · db (Drizzle) · api-client (OpenAPI 클라이언트) · config-ts · config-eslint
docker/     docker-compose.yml, postgres 롤 초기화 SQL (로컬 개발 스택)
deploy/     운영 compose.yaml · Caddyfile · deploy.sh · host-setup.sh (api 이미지에 동봉)
terraform/  AWS 인프라 (tf-buddha-*), README.md 에 운영 절차
scripts/    generate-api-doc.mjs (pnpm api:openapi 의 마지막 단계)
docs/       PLAN.md · API.md · DECISIONS.md · QUESTIONS.md
```

패키지 의존 규칙은 PLAN §4.1을 따른다: 앱은 `packages/*`만 import하고, `shared`는 어떤 프레임워크에도 의존하지 않는다.

`docker/docker-compose.yml`의 자격 증명(postgres/postgres, buddha/buddha, 인증 없는 Redis)은 로컬 개발 전용이며 모든 포트는 `127.0.0.1`에만 게시된다(A-M0-14). 게시 주소는 IPv4뿐이라 `::1`은 열리지 않는다 — `.env`의 `localhost` URL은 Node의 주소 패밀리 폴백으로 동작하지만, 폴백이 없는 GUI DB 도구 같은 클라이언트는 `127.0.0.1`을 써야 한다.
