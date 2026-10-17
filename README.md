# buddha

한국 사용자를 대상으로, 가상 Coin으로 미래 사건의 YES/NO 계약을 매수·매도하는 예측시장 웹 서비스 MVP. **Coin의 현금 환전·출금은 제공하지 않는다.**

이 문서는 **실행과 길찾기**만 다룬다. 나머지는 각자의 자리가 있다.

| 문서                                                                       | 내용                                                                                                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [docs/plan/](docs/plan/)                                                   | 기획서 v0.2(거래 중심) 원문 — 제품·정책·화면 설계의 기준(SSOT). Notion에서 내보낸 8개 파일(2026-10-06)을 고치지 않고 두며, Notion을 고치면 다시 내보낸다(ADR-0047) |
| [GitHub 이슈·마일스톤](https://github.com/sboh1214/sw04-buddha/milestones) | 작업 명세 — 기획 근거·목표·범위·수용 기준·의존 관계. 기획에 없는 결정은 '오너 결정 필요'로 남는다(ADR-0047)                                                        |
| [docs/PLAN.md](docs/PLAN.md)                                               | M0\~M6의 설계·범위·마일스톤 기록. 지금 기준은 `docs/plan/`이고 새 기준에 맞춰 고치지 않는다(ADR-0047)                                                              |
| [docs/API.md](docs/API.md)                                                 | HTTP·실시간 API 계약 (OpenAPI에서 생성, 손으로 고치지 않음)                                                                                                        |
| [docs/DECISIONS.md](docs/DECISIONS.md)                                     | ADR 로그 — 왜 그렇게 됐는지. 오너 결정 D1\~D26, 초기 출시 범위, 설계 제안 값의 승인 담당은 ADR-0047                                                                |
| [docs/QUESTIONS.md](docs/QUESTIONS.md)                                     | M0\~M6과 #19까지의 질문·가정 기록. 새 오너 질문은 각 이슈의 '오너 결정 필요'와 결정 이슈에 둔다                                                                    |
| [docs/RESET.md](docs/RESET.md)                                             | 운영 DB 초기화 절차 — 무엇을 지우고 남기는지, `deploy/reset-db.sh` 실행과 확인(#149가 쓴다, ADR-0048)                                                              |
| [docs/TERMS.md](docs/TERMS.md)                                             | 화면 용어 대응표 — 쓰지 않는 표현과 그 자리의 기획 용어(#14, ADR-0052). 같은 목록이 `@buddha/shared`의 `REPLACED_TERMS`다                                          |
| [docs/SETTINGS.md](docs/SETTINGS.md)                                       | 출시 설정 등록 규칙 — 항목 정의를 두는 곳, 상태(미정·설계 제안·시험값·승인됨), 바꾼 뒤 시작하는 일에만 적용, 변경 기록, 예상 항목과 담당 이슈(#170, ADR-0055)      |
| [docs/GUARDS.md](docs/GUARDS.md)                                           | 회귀 가드 등록 규칙 — 제외 기능 목록과 공개 금지 항목, 검사가 보는 곳과 허용, 공개·본인 전용 API·실시간 이벤트·알림 유형의 등록(#113, ADR-0057)                    |

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
pnpm db:seed                     # 카테고리 5개(+세부 21개) + 판매 중지 충전 상품 5개 + 관리자 둘(관리자가 없을 때만) + 초안 시장 14개
pnpm dev                         # web(3000) · api(4000) · worker + 공유 패키지 watch
```

시간의 대부분은 `pnpm install`과 첫 이미지 pull이 쓴다. 나머지는 몇 초씩이다. PowerShell에서도 그대로 붙여 넣으면 된다 — `cp`는 `Copy-Item`의 별칭이다.

기동을 확인하는 자리:

- 웹 <http://localhost:3000>
- API 레디니스 <http://localhost:3000/api/health>(web rewrite 경유) 또는 <http://localhost:4000/api/health>. 워커는 <http://localhost:4100/health>.
- Mailpit UI <http://localhost:8025> — 가입 인증·비밀번호 재설정·이메일 변경 메일이 전부 여기로 온다. 이메일 가입은 **주소만** 입력하고, 메일의 인증 링크를 누르면 로그인된 뒤 `/set-password`에서 첫 비밀번호를 정한다(인증 전에는 비밀번호가 없어 로그인할 수 없다). 운영 메일은 AWS SES(`.env.example`의 `SMTP_*` 주석).
- 관리자 로그인은 `.env`의 `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`(기본 `admin@buddha.local` / `admin1234!`). 이 두 값이 둘 다 없으면 `pnpm db:seed`가 관리자와 시드 시장을 통째로 건너뛴다. 2인 통제(같은 사람이 요청하고 승인하지 못한다)는 로컬에서도 서로 다른 관리자 둘이 필요하므로 둘째 관리자 `SEED_SECOND_ADMIN_EMAIL` / `SEED_SECOND_ADMIN_PASSWORD`(`.env.example` 기본 `admin2@buddha.local` / `admin5678!`)도 둔다. 첫째·둘째 모두 두 값을 함께 채우거나 함께 비운다 — 한 쌍에서 하나만 있거나(공백만 있는 값은 빈 값) 첫째 없이 둘째만 있으면 시드가 아무것도 넣지 않고 실패한다. 시드는 **관리자가 한 명도 없을 때만** 두 관리자를 만들고 부여 기록(사유 '시드')을 남긴다. 그 뒤에는 아무 계정도 만들거나 올리지 않고, 회수된 계정을 되돌리지도 않는다 — 관리자는 관리자 화면 `/admin/admins`에서 사유와 함께 부여·회수한다(아래 [관리자 계정과 2인 통제](#관리자-계정과-2인-통제)). 이미 관리자가 있는 DB에 둘째를 더하려면 그 화면에서 부여하거나 DB를 비우고 다시 시드한다. 시드 관리자는 화면의 부여 조건(이메일 인증과 실명·휴대전화)의 예외다: 시드가 이메일을 인증해 두고 실명·휴대전화는 넣지 않으므로, 관리자도 **첫 로그인에서 `/onboarding`을 만나** 한 번 입력한다 — 로컬에서도 운영에서도 같다(`/admin`도 게이트 예외가 아니다, ADR-0043). e2e는 `admin`·`secondAdmin` 픽스처가 로그인 직후 `PUT /api/v1/me/contact`로 두 관리자의 연락처를 넣는다.
- 가입하면 시작 Coin이 자동 지급된다. 금액은 아직 정하지 않았고 시뮬레이션 뒤 출시 설정으로 확정한다(N01 §10, #71·#133). 지금 들어가는 값은 `SIGNUP_BONUS_COIN`과 가입 트리거의 리터럴에 있다. 유료 충전·결제·쿠폰은 초기 제품에서 닫혀 있다(ADR-0049) — 아래 [유료 충전·결제·쿠폰(닫힘)](#유료-충전결제쿠폰닫힘).
- 소셜 로그인(Google/Kakao/Naver)은 `.env`에 그 프로바이더의 키 **쌍**을 넣을 때만 켜진다(Q-M1-1).

화면은 다음과 같다. 최상위는 시장 탐색(`/`)·커뮤니티(`/community`)·MY(`/my`) 세 영역이고(#16), 데스크톱은 헤더 1단의 메뉴로, 모바일 폭은 하단 탭으로 같은 세 영역에 간다. MY는 로그인 뒤에만 메뉴에 보인다. 헤더에는 시장만 찾는 검색과 가용 Coin 잔고 칩(→ `/my/wallet`)이 있고 프로필 메뉴는 없다(관리자 진입·로그아웃은 MY 안에 있고, 온보딩 게이트에 묶여 MY에 못 가는 계정에게는 `/onboarding`·`/set-password`에 로그아웃이 있다). 사용자가 거래하는 경로는 지금 없다 — 직접 AMM 거래를 지웠고 CLOB 주문·체결은 아직 없다(ADR-0048). 체결이 없는 시장의 가격은 어디서나 '체결 없음'이다.

| 경로                                                                                               | 화면                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                                                                                | 시장 탐색 홈(Kalshi 형, ADR-0041) — 헤더 2단(전체·카테고리, 시장 탐색인 `/`와 `/markets/[slug]`에서만)·세부 분류 사이드바·정렬·시장 카드 그리드(카드마다 YES/NO 두 줄과 참여자 수, 체결 전에는 '—'와 '체결 없음')                                                                                       |
| `/community`                                                                                       | 커뮤니티 — 자리만 있는 화면(준비 중, 내용은 #46)                                                                                                                                                                                                                                                        |
| `/markets/[slug]`                                                                                  | 시장 상세 — 시장가격 차트·규칙·최근 체결·내 포지션·주문 영역(열린 시장에만, '거래 준비 중'). `resolved`면 판정된 결과와 정산 진행 안내, `settled`면 결과와 실현 손익                                                                                                                                    |
| `/my`                                                                                              | MY 요약 — 잔고 요약(가용·잠금·총 평가 금액·총 평가손익·총 실현 손익)과 탭별 미리보기(설정을 뺀 각 탭의 몇 줄과 '전체 보기', 내용이 없는 탭은 '준비 중'). MY의 모든 주소는 로그인한 본인만 보고, 세션이 없으면 서버가 `/login?next=<그 주소>`로 보낸다(#16)                                              |
| `/my/positions` `/my/orders` `/my/history`                                                         | 보유 계약·대기 주문(대기·부분 체결 주문)·거래·정산 이력(정산 이력과 나머지 주문 이력). 옛 포트폴리오의 목록을 그대로 옮겼다                                                                                                                                                                             |
| `/my/wallet`                                                                                       | 지갑 — 현금 환전·출금이 없다는 고지·잔고·원장(정산 지급은 `SETTLEMENT_PAYOUT` 행). 충전·쿠폰·결제 내역은 유료 충전이 닫힌 동안 그리지 않는다(ADR-0049)                                                                                                                                                  |
| `/my/posts` `/my/watchlist` `/my/notifications`                                                    | 내 글·관심 시장·알림 — 준비 중(내용은 #51·#89·#53)                                                                                                                                                                                                                                                      |
| `/my/settings`                                                                                     | 설정 — 닉네임·이메일·실명·연락처·연결된 로그인 수단·비밀번호·시간대·테마. 인증 메일과 소셜 연결은 이 주소로 돌아온다(실패는 `?error=`). 회원 화면의 절대 시각은 고른 시간대(고르지 않으면 브라우저 시간대)로 보이고 Asia/Seoul이 아니면 옆에 시간대를 적는다. 관리자 화면은 한국 시간이다(ADR-0063)     |
| `/charge`                                                                                          | 없는 페이지(404). 공개 충전 안내(ADR-0044)는 유료 충전이 닫힌 동안 열리지 않는다(ADR-0049)                                                                                                                                                                                                              |
| `/signup` `/login` `/set-password` `/reset-password`                                               | 인증과 계정. 이메일 가입은 `/set-password` 단계에서 실명·휴대전화도 받고, MY 설정(`/my/settings`)에서 고친다(ADR-0043)                                                                                                                                                                                  |
| `/onboarding`                                                                                      | 실명·휴대전화 입력(ADR-0043). 로그인했는데 아직 입력하지 않은 계정(소셜 로그인·기존 계정·시드 관리자)은 인증·약관을 뺀 어느 화면에서든(관리자 화면 포함) 여기로 온다                                                                                                                                    |
| `/terms` `/privacy` `/refund`                                                                      | 이용약관·개인정보처리방침·환불정책(공개, ADR-0044). 사업자 정보는 `apps/web/src/legal/business-info.ts` 한 곳에 있고(지금은 `미정`), 모든 화면 아래의 푸터가 이 셋을 건다(충전 안내 링크는 유료 충전이 닫힌 동안 없다)                                                                                  |
| `/admin/markets` `/admin/markets/[id]`                                                             | 시장 생성(초안)·수정·열기·마감·판정(즉시 확정, 곧바로 정산), 거래 현황, 판정 뒤 정산 단계(읽기 전용, ADR-0046). 무효 처리는 없다(ADR-0048)                                                                                                                                                              |
| `/admin/users` `/admin/charge-packages` `/admin/coupons` `/admin/payments` `/admin/audit-failures` | 계정(잔고 조정)·충전 상품·쿠폰·결제·원장 감사 실패. 유료 충전이 닫힌 동안 충전 상품·쿠폰·결제는 메뉴에 없고 주소로만 열린다 — 상품·쿠폰 관리는 되고, 결제는 목록만 본다(환불은 API가 막는다, ADR-0049)                                                                                                  |
| `/admin/admins`                                                                                    | 운영자 계정 — 지금 관리자 목록(부여 시각·작업자), 이메일·닉네임으로 찾은 계정에 사유와 함께 부여(이메일 인증과 실명·휴대전화를 마친 계정만), 사유와 함께 회수(관리자가 2명 미만이 되면 자기 회수까지 거절, 회수된 계정은 모든 기기에서 로그아웃), 권한 변경 기록(작업자·대상·시각·사유)(#171, ADR-0056) |
| `/admin/settings`                                                                                  | 출시 설정 — 항목마다 이름·단위·뜻·값·상태, 미정만 보기, 사유 필수 변경, 변경 기록(작업자·시각·전후 값·사유). 레지스트리가 비어 있어 지금은 '등록된 항목이 없습니다.'다. 항목 등록은 [docs/SETTINGS.md](docs/SETTINGS.md)(#170, ADR-0055)                                                                |

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

### 시드 시장을 열 수 없다 (`VALIDATION_ERROR`, `closeAt`)

시드 시장은 검수 전 초안(`draft`)이고 `rules`가 정한 절대 마감 시각(KST)을 갖는다. 그 시각이 지난 초안은 관리자 열기가 `closeAt`을 지목한 400(`VALIDATION_ERROR`)으로 거절된다. 관리자 시장 상세의 수정에서 마감 시각을 미래로 옮긴 뒤 연다. `pnpm db:seed`는 실행마다 마감이 지났거나 14일 안에 마감되는 시드 시장을 경고한다 — 근본 해법은 새 slug로 시드 문안을 바꾸는 것이다.

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
- **워커가 발행하면 게이트웨이가 중계한다.** `market.close`·`market.finalize`(API가 마감 시각에 맞춰 예약하는 지연 잡과 판정 직후 바로 넣는 잡 + 매 분 안전망 스캔)와 `ledger.audit`(매일 04:00 KST). 잡 결과는 Redis로 나가고, `/ws` 게이트웨이가 그것을 브라우저의 방으로 밀어 준다. 이벤트 목록·룸·순서 키는 [docs/API.md](docs/API.md)의 실시간 절.
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
- **호스트에서 도는 것**은 [deploy/](deploy/)(`compose.yaml` · `Caddyfile` · `deploy.sh` · `host-setup.sh` · `reset-db.sh`) — api 이미지에 동봉되어 배포마다 `/data/buddha`에 풀린다. 이미지는 루트 `Dockerfile`의 세 타깃(`api` / `worker` / `web`)이다.
- **배포**는 `main`에 push하면 [.github/workflows/deploy.yml](.github/workflows/deploy.yml)이 arm64 이미지를 ECR에 밀고 SSM으로 호스트에서 `migrate && seed` → 컨테이너 교체 → `/api/health` 스모크까지 한다. 롤백은 `gh workflow run deploy.yml --ref main -f image_tag=<sha>`. SSH는 없고 셸은 `aws ssm start-session`이다.
- **운영 DB 초기화**는 [docs/RESET.md](docs/RESET.md). #125의 배포가 마이그레이션 0017로 계정까지 한 번 비우고 시드로 다시 채웠다. 다시 비울 때는 호스트에서 `deploy/reset-db.sh`가 같은 문장을 돌리고 Redis도 비운다(계정까지 모두). #149의 출시 전 재초기화가 이 절차를 쓰고, 다시 할지와 남길 데이터는 #133이 정한다 — 무엇이든 남기기로 하면 그 전에 이 절차를 좁힌다. 지금은 출시 설정의 값과 변경 기록(`release_settings`, `admin_actions`)도 함께 비운다.

## 유료 충전·결제·쿠폰(닫힘)

초기 제품은 유료 충전·결제·쿠폰을 쓰지 않는다(N06, D9, [ADR-0049](docs/DECISIONS.md)). 코드와 테이블은 남아 있고, 스위치는 `packages/shared/src/constants.ts`의 `PAID_COIN_SALES_ENABLED`(지금 `false`) 하나다 — env나 DB 값이 아니라 API와 웹이 같은 빌드에서 읽는 상수다.

- **API.** 공개 `GET /api/v1/charge-packages`·`GET /api/v1/payments/provider`, `POST /api/v1/payments/charge`, `POST /api/v1/coupons/redeem`, 관리자 `POST /api/v1/admin/payments/:id/refund`가 무엇을 읽거나 쓰기 전에 `404 NOT_FOUND`(`Not available`, 기능 이름 없음)로 답한다(`PaidCoinSalesGuard`). 관리자 충전 상품·쿠폰 관리와 결제 목록, 본인 결제 내역 `GET /api/v1/me/payments`는 열려 있다.
- **웹.** 지갑의 충전·쿠폰·결제 내역, 공개 `/charge`(404)와 푸터의 충전 안내 링크, 관리자 메뉴의 충전 상품·쿠폰·결제, `/admin/payments`의 환불 버튼을 그리지 않는다. 컴포넌트 파일은 남아 있다. 막힌 응답을 만나는 화면은 '이용할 수 없습니다.'만 보인다.
- **결제 프로바이더는 mock 하나다**(`PAYMENT_PROVIDER=mock`, 돈이 움직이지 않고 바로 충전). 스마트로페이 연동(ADR-0042)은 다른 PG를 쓰기로 해 지웠고, `PAYMENT_PROVIDER=smartro`면 API가 기동하지 않는다. 운영 compose는 api에 `mock`을 그대로 준다.
- **시험.** 보존한 충전·쿠폰·환불의 API 시험은 `createTestApp({ paidCoinSales: true })`로 판매를 켠 앱에서 돌고, `apps/api/src/payments/paid-coin-sales.test.ts`와 e2e `payment.spec.ts`가 닫힌 상태를 고정한다.
- **다시 열기**(#111이 정한다). 상수를 `true`로 바꾸고, 닫힌 상태를 고정한 시험(`packages/shared/src/constants.test.ts`, 위 두 시험)을 고친 뒤 main에 머지한다(자동 배포). env·terraform·DB는 바꿀 것이 없다. 그대로 열면 충전은 mock이므로 실제 판매에는 다음 PG 연동이 먼저다.

## 관리자 계정과 2인 통제

관리자 권한은 `profiles.role = 'admin'` 하나이고, 같은 사람이 요청하고 승인하지 못하게 하는 2인 통제 규칙을 공용으로 둔다(#171, [ADR-0056](docs/DECISIONS.md)).

- **부여·회수.** 기존 관리자가 `/admin/admins`에서 사유와 함께 하고, 다른 관리자의 승인은 받지 않는다. 부여는 이메일 인증과 실명·휴대전화 입력을 마친 계정에만 된다. 회수는 관리자가 2명 미만이 되면 자기 회수까지 거절되고, 회수된 계정은 모든 세션이 지워져 모든 기기에서 로그아웃되며 다음 요청부터 관리자 기능을 쓰지 못한다. 부여·회수마다 작업자·대상 계정·시각·사유가 `admin_actions`(`admin_grant`·`admin_revoke`)에 남고, 같은 화면의 권한 변경 기록에서 본다. API는 `GET`·`POST /api/v1/admin/admins`, `POST /api/v1/admin/admins/{userId}/revoke`, `GET /api/v1/admin/admins/changes`([docs/API.md](docs/API.md)).
- **기록 접근.** 운영 기록(원장 감사 실패, 출시 설정 변경 기록, 권한 변경 기록, 앞으로의 신고·작업 기록)은 모두 `/admin` 아래에 있고 관리자라면 누구나 본다. 모든 `/admin` 라우트가 `SessionGuard`·`AdminGuard`를 거는지 `apps/api/src/admin/admin-access.test.ts`가 확인한다.
- **2인 통제.** `ApprovalService`(`apps/api/src/approvals`)와 `approval_requests` 표: 요청을 남기고, 요청한 계정이 아닌 관리자만 한 번 승인·거절한다. 로컬·CI·내부 배포·출시 어디서도 끌 수 없다. 아직 이 규칙을 쓰는 작업은 없고, 개설 검수(#78)·판정 승인(#152)·보상 승인(#144)·봇 통제(#130)·계정 제한(#139) 등이 각자 붙인다.
- **시드의 관리자 둘.** `pnpm db:seed`는 관리자가 한 명도 없을 때만 `SEED_ADMIN_*`와 `SEED_SECOND_ADMIN_*`(선택. 각 쌍의 두 값을 함께 채우거나 함께 비우고, 하나만 있거나 첫째 없이 둘째만 있으면 시드가 실패한다)로 관리자 둘을 만들고 각자 부여 기록(사유 '시드')을 남긴다. 화면의 부여 조건을 거치지 않는 유일한 길이다. 관리자가 이미 있는 DB에는 아무도 만들거나 올리지 않으므로, 둘째를 더하려면 화면에서 부여하거나 DB를 비우고 다시 시드한다. 운영은 terraform의 `seed_second_admin_*`가 호스트 `.env`의 `SEED_SECOND_ADMIN_*`가 된다([terraform/README.md](terraform/README.md)).

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
- 관리자 계정 스펙(`admin-accounts.spec.ts`)은 시드한 관리자 둘이 필요하다 — `.env`에 `SEED_SECOND_ADMIN_*`를 두고 빈 DB에 시드한다(관리자가 이미 있으면 시드가 둘째를 만들지 않는다). 2명 하한을 시드한 두 관리자만 있는 상태에서 확인하므로, 역할을 바꾸는 시험은 데스크톱 프로젝트에서만 순서대로 돌고 셋째 관리자가 남아 있으면 그 `e2e-` 계정부터 회수한다.
- 정산 스펙(`settlement.spec.ts`)은 워커가 떠 있어야 한다(`pnpm dev`가 띄운다. 없으면 Playwright가 `WORKER_HEALTH_PORT`(기본 4100)의 `/health`를 확인해 직접 띄우고, `0`이면 확인할 포트가 없어 이 스펙만 건너뛴다). 관리자가 판정하면 워커가 곧바로 정산하므로 기다리는 기간은 없다(ADR-0046).

## 구조

```
apps/       web (Next.js) · api (NestJS + Fastify) · worker (BullMQ) · mobile (Expo 스캐폴드)
packages/   shared (순수 도메인 로직) · db (Drizzle) · api-client (OpenAPI 클라이언트) · config-ts · config-eslint
docker/     docker-compose.yml, postgres 롤 초기화 SQL (로컬 개발 스택)
deploy/     운영 compose.yaml · Caddyfile · deploy.sh · host-setup.sh · reset-db.sh (api 이미지에 동봉)
terraform/  AWS 인프라 (tf-buddha-*), README.md 에 운영 절차
scripts/    generate-api-doc.mjs (pnpm api:openapi 의 마지막 단계)
docs/       plan/(기획서 v0.2 원문) · PLAN.md · API.md · DECISIONS.md · QUESTIONS.md · RESET.md(운영 DB 초기화) · TERMS.md(용어 대응표) · SETTINGS.md(출시 설정 등록 규칙) · GUARDS.md(회귀 가드 등록 규칙)
```

패키지 의존 규칙은 PLAN §4.1을 따른다: 앱은 `packages/*`만 import하고, `shared`는 어떤 프레임워크에도 의존하지 않는다.

`docker/docker-compose.yml`의 자격 증명(postgres/postgres, buddha/buddha, 인증 없는 Redis)은 로컬 개발 전용이며 모든 포트는 `127.0.0.1`에만 게시된다(A-M0-14). 게시 주소는 IPv4뿐이라 `::1`은 열리지 않는다 — `.env`의 `localhost` URL은 Node의 주소 패밀리 폴백으로 동작하지만, 폴백이 없는 GUI DB 도구 같은 클라이언트는 `127.0.0.1`을 써야 한다.
