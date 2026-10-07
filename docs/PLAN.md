# buddha — 예측시장 MVP 개발 계획서

- 문서 버전: v0.1 (2026-09-02)
- 상태: 확정 결정 기반 초안. §17 "열린 질문"은 사용자 확인 후 반영.
- 대상 독자: Claude Code (구현 에이전트), 프로젝트 오너
> **2026-09-28 — 하이브리드 기획 도입(ADR-0045).** 2026-09-28부터 하이브리드 기획(Trade + Forecast)의 SSOT는 GitHub 이슈(마일스톤 M7~M12, 후속)다. PLAN 조항은 각 이슈의 PR이 개정하거나 ADR로 대체한다. 이슈와 마일스톤: https://github.com/sboh1214/sw04-buddha/milestones · 결정 기록: `docs/DECISIONS.md` ADR-0045. §0의 SSOT 문장과 §0.1-1은 M0\~M6에만 적용된다.
---

## 0. Claude Code 작업 지침

이 문서는 구현의 단일 진실 원천(SSOT)이다. 아래 규칙을 항상 우선한다.

### 0.1 작업 방식
1. **§13 마일스톤 순서대로 진행**한다. 각 마일스톤의 수용 기준(AC)을 전부 통과한 뒤 다음으로 넘어간다.
2. **추측 금지.** 이 문서에 없거나 애매한 사항은 `docs/QUESTIONS.md`에 기록한다.
   - 진행에 영향이 없으면: 가장 보수적인 선택으로 진행하고 QUESTIONS.md에 "가정: …"으로 남긴다.
   - 블로킹이면: 해당 작업을 멈추고 사용자에게 질문한다. 다른 독립 작업은 계속한다.
3. **결정 기록.** 설계상 선택(라이브러리, 패턴, 트레이드오프)은 `docs/DECISIONS.md`에 ADR 형식(맥락 / 결정 / 결과)으로 남긴다.
4. **버전.** 이 문서의 버전 표기는 참고값이다. 실제로는 각 패키지의 **최신 안정 버전**을 설치한 뒤 `pnpm-workspace.yaml`의 `catalog`에 핀한다. 메이저 버전 차이로 문서 내용과 API가 다르면 실제 패키지 문서를 따르고 DECISIONS.md에 기록한다.
5. **커밋.** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`). 마일스톤별 브랜치 `m0-scaffold`, `m1-auth` … 형태.
6. **언어.** 코드·주석·커밋 메시지는 영어, UI 문자열·문서는 한국어. (가정 — §17 Q10)
7. **시크릿.** `.env`는 커밋하지 않는다. `.env.example`만 커밋한다.

### 0.2 절대 불변식 (위반 시 코드 리뷰 실패)
- **환전·출금 기능을 만들지 않는다.** P → 원화 방향의 코드, 화면, API, DB 컬럼을 어떤 형태로도 추가하지 않는다. "추후 확장" 명목의 스텁도 금지.
- **금액·가격·수량에 부동소수점을 쓰지 않는다.** P 금액은 `bigint`, 가격은 `smallint`(1~99), 수량은 `integer`. LMSR 내부 계산만 double을 쓰고 경계에서 정수로 확정한다.
- **잔고는 원장 없이 바뀌지 않는다.** `balances` 갱신은 반드시 같은 트랜잭션 안의 `ledger_entries` INSERT와 함께 이루어진다.
- **시장당 단일 라이터.** 거래·정산은 `pg_advisory_xact_lock(market_id)`를 잡은 트랜잭션 안에서만 상태를 바꾼다.
- **스포츠·선거 카테고리를 만들지 않는다.** 시드 데이터, 관리자 카테고리 옵션 모두.
- **정산 기준(rules) 없이 시장을 열 수 없다.** `rules`가 비어 있으면 `draft → open` 전이를 거부한다.

---

## 1. 프로젝트 개요

### 1.1 한 줄 정의
한국 사용자를 대상으로, 원화로 충전한 포인트(P)로 미래 사건의 결과(예/아니오)를 예측·거래하는 웹 서비스. Polymarket·Kalshi의 제품 구조를 참고하되, **P는 어떤 경우에도 현금화되지 않는다.**

### 1.2 이번 MVP의 범위
- 웹(Next.js) + API 서버(NestJS) + 워커(BullMQ)
- 모바일(Expo)은 **스캐폴드만** 생성하고 화면 작업은 하지 않는다
- 결제는 **mock** (충전 버튼 → 즉시 성공)
- 시장 메커니즘은 **AMM(LMSR)**. CLOB은 스키마만 준비
- 로컬 docker-compose까지. AWS 배포는 별도 마일스톤

### 1.3 확정 결정 요약

| 항목 | 결정 |
|---|---|
| 포인트 환전/출금 | **영구 불가** |
| 단위 | 1P = 1원. 계약 가격 1~99P 정수. 정산 시 계약당 100P. 최소 주문 1계약 |
| 수수료 | MVP 무수수료. %수수료·테이커 수수료가 가능하도록 스키마 반영 |
| 결제 | 미구현. 충전 화면에서 금액 선택 → 즉시 성공 처리 (어댑터 인터페이스 뒤에 Mock) |
| 시장 메커니즘 | LMSR AMM. CLOB 전환 가능하도록 `orders/fills` 스키마 설계 |
| 시장 생성/정산 | 관리자 전용. 관리자 판정 즉시 확정, 곧바로 정산 (ADR-0046) |
| 카테고리 | 경제·문화·엔터테인먼트·테크·날씨. 스포츠·선거 제외 |
| 인증 | better-auth. 이메일+비밀번호, 구글/카카오/네이버. 한 계정에 여러 로그인 수단 연결 |
| 인프라 | 로컬 docker-compose. Redis 처음부터 사용 |
| 런타임 | Node 24 LTS |
| 향후 | 그룹(사용자끼리 그룹 내 베팅·랭킹) 기능 예정 → 스키마에서 고려 |

---

## 2. 비목표 (MVP에서 하지 않는 것)
- 실제 PG 연동, 환불 처리
- CLOB 매칭 엔진, 지정가 주문
- 그룹, 랭킹/리더보드, 소셜 기능(댓글·공유)
- 푸시/이메일 알림 (이메일은 인증·비밀번호 재설정만)
- 다국어 (한국어 단일)
- 모바일 앱 화면
- AWS 배포, 모니터링 스택
- 다중 결과(3개 이상) 시장 — 이진(예/아니오)만

---

## 3. 기술 스택

| 레이어 | 선택 | 비고 |
|---|---|---|
| 런타임 | Node 24 LTS | `.nvmrc`, `engines` 명시 |
| 패키지 관리 | pnpm workspaces + Turborepo | `catalog:`로 버전 단일화 |
| 웹 | Next.js (App Router) + React + TypeScript | `output: 'standalone'` |
| UI | Chakra UI v3 | 커스텀 테마 시스템(`createSystem`). 라이트/다크 |
| 차트 | Chakra UI Charts (recharts 기반). 부족하면 recharts 직접 | 확률 타임라인 라인차트, 카드 스파크라인 |
| 데이터 페칭 | TanStack Query + `packages/api-client`(openapi-fetch) | |
| 폼 | react-hook-form + zod (`packages/shared` 스키마 재사용) | |
| 실시간(클라) | socket.io-client | |
| API | NestJS + Fastify 어댑터 | `bodyParser: false` (better-auth 요구) |
| ORM | Drizzle ORM + drizzle-kit | 마이그레이션 SQL 커밋 |
| DB | PostgreSQL 16+ | |
| 캐시/버스/큐 | Redis 7 (로컬). AWS에서는 Valkey | ioredis |
| 큐 | BullMQ | `apps/worker`에서 소비 |
| 실시간(서버) | @nestjs/websockets + socket.io + @socket.io/redis-adapter | |
| 인증 | better-auth + `@thallesp/nestjs-better-auth` (Fastify 지원은 베타) | Drizzle 어댑터. 문제 시 §10.6 대안 |
| 검증 | zod (공유), NestJS ZodValidationPipe | class-validator 사용 안 함 |
| API 문서 | @nestjs/swagger → OpenAPI JSON → `openapi-typescript` | |
| 테스트 | Vitest (unit/integration), fast-check (property), Playwright (e2e) | |
| 린트/포맷 | ESLint (flat config) + Prettier | |
| 로컬 인프라 | docker-compose: postgres, redis, mailpit | |
| 모바일(스캐폴드) | Expo (최신 SDK), dev client + CNG 전제 | 화면 작업 없음 |

---

## 4. 리포지토리 구조

```
buddha/
├── apps/
│   ├── web/                # Next.js
│   ├── api/                # NestJS (REST + Socket.IO 게이트웨이 + better-auth)
│   ├── worker/             # BullMQ 소비자 (마감/정산/집계)
│   └── mobile/             # Expo 스캐폴드 (M0에서 생성만)
├── packages/
│   ├── shared/             # 도메인 타입, zod 스키마, LMSR 엔진, P 포맷터, 상수
│   ├── api-client/         # OpenAPI → 생성된 TS 클라이언트 + 타입
│   ├── db/                 # Drizzle 스키마·마이그레이션·시드 (api/worker 공용)
│   ├── config-ts/          # tsconfig base
│   └── config-eslint/      # eslint base
├── docker/
│   └── docker-compose.yml
├── docs/
│   ├── PLAN.md             # 이 문서
│   ├── DECISIONS.md        # ADR 로그
│   ├── QUESTIONS.md        # 미해결 질문/가정
│   └── API.md              # 생성된 OpenAPI 요약 (M3 이후)
├── pnpm-workspace.yaml
├── turbo.json
├── .npmrc
└── package.json
```

### 4.1 패키지 의존 규칙
- `shared`는 React·Nest·Drizzle 어느 것에도 의존하지 않는다 (순수 TS).
- `db`는 `shared`에 의존할 수 있다. 역방향 금지.
- `api-client`는 `shared`의 타입을 re-export 한다.
- 앱은 `packages/*`만 import 한다. 앱 간 import 금지.
- 공유 패키지는 **컴파일 방식**: `tsc -b`로 `dist/` 생성, `exports`는 dist를 가리킨다. `turbo.json`의 `build.dependsOn: ["^build"]`.

### 4.2 핵심 설정 파일

`pnpm-workspace.yaml`
```yaml
packages:
  - "apps/*"
  - "packages/*"
catalog:
  # 최신 안정 버전으로 채운다
  react: ""
  typescript: ""
  zod: ""
```

`.npmrc`
```
strict-peer-dependencies=false
```
(Expo SDK 54+는 pnpm 격리 설치를 지원한다. 네이티브 빌드 문제가 생기면 `node-linker=hoisted`로 전환.)

`turbo.json`
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**", "!.next/cache/**"] },
    "dev": { "cache": false, "persistent": true },
    "typecheck": { "dependsOn": ["^build"] },
    "lint": {},
    "test": { "dependsOn": ["^build"] },
    "db:migrate": { "cache": false },
    "db:seed": { "cache": false }
  }
}
```

---

## 5. 도메인 규칙

### 5.1 포인트 (P)
- 1P = 1원. 모든 금액은 정수 P, DB는 `bigint`.
- 사용자 잔고: `available`(사용 가능), `locked`(지정가 주문 예약 — MVP에서는 항상 0, CLOB 대비).
- P의 유입은 **충전(mock)**, **정산 지급**, **무효 시장 환불**, **관리자 조정**뿐이다.
- P의 유출은 **거래 매수**, **수수료(MVP 0)**, **관리자 조정**뿐이다.
- 환전·출금·타인 이전은 존재하지 않는다.

### 5.2 시장 (Market)
이진 시장만 존재한다. 결과는 `YES` / `NO`.

필수 필드: 질문(`title`), 설명(`description`), **정산 기준(`rules`)**, 정보 출처(`resolution_source`), 카테고리, 마감 시각(`close_at`), 초기 확률(`initial_prob`), 유동성 파라미터(`liquidity_b`).

상태 머신:
```
draft ──(admin open)──▶ open ──(close_at 도달 / admin close)──▶ closed
closed ──(admin resolve: result 판정, 즉시 확정)──▶ resolved
resolved ──(worker finalize: 정산 단계 모두 완료)──▶ settled
open | closed ──(admin void)──▶ voided
```
- `open`에서만 거래 가능.
- `closed`는 거래 불가, 판정 대기.
- `resolved`는 관리자가 결과를 판정한 상태. 결과는 판정 즉시 확정되고 바꿀 수 없다(재판정 여부는 #26). 정산 단계가 진행 중이다. 거래·수정·무효 불가.
- `settled`는 정산 단계(`SETTLEMENT_STEPS`)가 모두 끝난 상태. 불변. 지금 단계는 포지션 정산(`coin`) 하나이고, Forecast 채점(`score`)은 #29가 더한다(O-6).
- `voided`는 전 포지션의 `cost_basis`를 환불. 불변. `open`·`closed`에서만 갈 수 있다.
- 모든 전이는 `market_events`에 기록한다.

### 5.3 LMSR 가격 엔진 (`packages/shared/src/lmsr.ts`)

상태: `qY`, `qN` (발행된 계약 수, 실수), `b` (유동성 파라미터, 양수).

```
C(qY, qN) = b · ln( exp(qY/b) + exp(qN/b) )        // log-sum-exp 트릭으로 계산
pY        = 1 / (1 + exp((qN − qY)/b))              // 확률 ∈ (0,1)
displayPrice = clamp(round(pY · 100), 1, 99)         // 화면 표시용 P

매수 Δ계약 (YES): costP     = ceil ( 100 · (C(qY+Δ, qN) − C(qY, qN)) )
매도 Δ계약 (YES): proceedsP = floor( 100 · (C(qY, qN) − C(qY−Δ, qN)) )
NO는 대칭.

초기화 (p0 = initial_prob): qY = b · ln(p0 / (1−p0)), qN = 0
운영자 최대 손실 = 100 · b · ln 2  (P)  → markets.reserve_p 에 기록
```

구현 요구:
- 순수 함수. 입력/출력 모두 명시적. 부작용 없음.
- `quoteBuy(state, outcome, shares)`, `quoteSell(state, outcome, shares)`, `sharesForSpend(state, outcome, spendP)` (정수 이분탐색으로 `cost ≤ spendP`인 최대 Δ), `priceOf(state)`, `initState(p0, b)`.
- 매도는 보유 수량 이내에서만. `Δ > position.qty`면 거부.
- **불변식 (property test로 검증):**
  1. 매수 후 같은 결과의 가격은 오르고 반대 결과의 가격은 내린다.
  2. `costP ≥ 1` (Δ ≥ 1일 때). `proceedsP ≥ 0`.
  3. 즉시 매수→매도 왕복은 절대 이익이 나지 않는다 (`proceeds ≤ cost`).
  4. 어떤 거래 시퀀스에서도 운영자 누적 손실 ≤ `100·b·ln2 + 거래횟수` (라운딩 오차 상한).
  5. `pY + pN = 1` (double 오차 내).
- 슬리피지 가드: 실행 요청은 `maxCostP`(매수) / `minProceedsP`(매도)를 반드시 포함한다. 서버가 재계산한 값이 이를 벗어나면 `PRICE_MOVED`로 거부.

`liquidity_b` 가이드 (관리자 화면 도움말): b=500 → 최대 손실 ≈ 34,657P, b=1000 → ≈ 69,315P, b=3000 → ≈ 207,944P. 기본값 1000.

### 5.4 거래 흐름 (API `POST /trades`)
하나의 Postgres 트랜잭션. 순서 고정.

```
1. BEGIN
2. SELECT pg_advisory_xact_lock(hashtext(market_id))
3. SELECT market FOR UPDATE  → status='open' AND close_at > now() 검증
4. LMSR 재계산 → cost/proceeds 확정 → 슬리피지 가드 검증
5. [매수] UPDATE balances SET available = available − cost
          WHERE user_id = ? AND available >= cost RETURNING *
          → 0행이면 INSUFFICIENT_BALANCE, ROLLBACK
   [매도] SELECT position FOR UPDATE → qty ≥ Δ 검증
6. INSERT orders (type='market', status='filled', idempotency_key)
7. INSERT fills (counterparty_type='amm', price_avg, qty, amount_p, fee_p=0)
8. INSERT ledger_entries (TRADE_BUY: −cost | TRADE_SELL: +proceeds)
   [매도] UPDATE balances SET available = available + proceeds
9. UPSERT positions (qty, cost_basis_p, realized_pnl_p)
10. UPDATE markets SET q_yes, q_no, last_price, volume_p += amount, trade_count += 1
11. INSERT price_ticks (market_id, ts, p_yes_bp, trigger='trade')
12. COMMIT
13. Redis PUBLISH market:{id} {type:'tick'|'trade', ...}  (§8)
```
멱등성: `Idempotency-Key` 헤더 필수. Redis에 24h 캐시(키 → 응답), DB `orders.idempotency_key UNIQUE`. 같은 키 재요청은 최초 응답을 그대로 반환.

포지션 회계:
- 매수: `qty += Δ`, `cost_basis_p += cost`
- 매도: 해제되는 원가 `released = round(cost_basis_p · Δ / qty)`; `qty −= Δ`; `cost_basis_p −= released`; `realized_pnl_p += proceeds − released`
- 정산: 승리 결과 `payout = qty · 100`; `realized_pnl_p += payout − cost_basis_p`; 패배 결과 `realized_pnl_p −= cost_basis_p`; 이후 `qty = 0, cost_basis_p = 0, settled = true`

### 5.5 마감 · 판정 · 정산
- **마감**: 시장 생성 시 `close_at`에 맞춘 BullMQ delayed job `market.close` 등록. 안전망으로 워커가 매 분 `status='open' AND close_at <= now()`를 스캔한다. 마감 시 `status='closed'`, `market_events` 기록, WS `status` 이벤트.
- **판정(관리자)**: `POST /admin/markets/:id/resolve {result, note, evidence_url}` → `closed`에서만. 한 트랜잭션에서 시장 advisory lock → `market_events(resolved)`, `status='resolved'`, `resolved_result`, `resolved_at`, 정산 단계마다 `market_settlement_steps` 행(`pending`), `admin_actions(market_resolve)`. 결과는 즉시 확정된다 — 바꾸는 경로가 없고, `closed`가 아닌 시장(이미 판정한 시장 포함)은 `VALIDATION_ERROR`. COMMIT 뒤 `market.finalize` job을 지연 없이 등록(실패해도 매 분 스캔이 줍는다).
- **정산(워커)**: `market.finalize` → 시장 advisory lock → `status='resolved'` 재검증 → `SETTLEMENT_STEPS` 순서대로 `done`이 아닌 단계를 실행하고 `completed_at`을 기록 → 모든 단계가 `done`이면 `finalized` 이벤트와 `status='settled'`. 포지션 정산 단계(`coin`)는 모든 미정산 포지션 순회하며 §5.4 정산 회계 + `ledger_entries(SETTLEMENT_PAYOUT)` + `balances` 갱신. 지금은 모든 단계가 시장당 한 트랜잭션이고, **각 사용자의 원장+잔고+포지션은 같은 트랜잭션**에 있어야 한다. 재실행 안전(멱등): `done`인 단계와 `positions.settled=true`인 행은 건너뛴다. 단계가 실패하면 트랜잭션을 되돌리고 별도 트랜잭션에 실패(`status='failed'`, `attempts`, `last_error`)를 남긴다. 시장은 `resolved`로 남고 매 분 스캔(`status='resolved'`)이 횟수 제한 없이 다시 시도한다.
- **무효(관리자)**: `POST /admin/markets/:id/void {reason}` → `open`·`closed`에서만. 모든 포지션에 `cost_basis_p` 환불(`MARKET_VOID_REFUND`), `status='voided'`. 판정한 시장(`resolved`·`settled`)은 무효할 수 없다 — 잘못된 판정은 #26 결정 전까지 계정별 관리자 조정(`ADMIN_ADJUST`)으로 보상한다.

### 5.6 원장 (Ledger)
`ledger_entries`는 append-only. UPDATE/DELETE 금지 (DB 권한으로도 막는다: 앱 롤에 해당 테이블 UPDATE/DELETE 권한 미부여).

| type | 부호 | 참조 |
|---|---|---|
| DEPOSIT | + | payments.id |
| TRADE_BUY | − | fills.id |
| TRADE_SELL | + | fills.id |
| FEE | − | fills.id (MVP 미발생) |
| SETTLEMENT_PAYOUT | + | markets.id |
| MARKET_VOID_REFUND | + | markets.id |
| ADMIN_ADJUST | ± | admin_actions.id |
| BONUS | + | (예약. MVP 미사용) |

불변식: `balances.available + balances.locked = SUM(ledger_entries.amount_p) WHERE user_id`. 워커 `ledger.audit` 잡이 매일 검증하고 불일치를 `audit_failures`에 기록한다.

### 5.7 수수료 (스키마만)
- `markets.taker_fee_bps smallint default 0`, `markets.settlement_fee_bps smallint default 0`
- `fills.fee_p bigint default 0`
- 계산 지점은 §5.4 4단계 직후로 정해두고, MVP에서는 항상 0을 기록한다.

---

## 6. DB 스키마 (Drizzle · PostgreSQL)

`packages/db/src/schema/*.ts`. 아래는 논리 스키마. 타입 표기는 Postgres 기준.

### 6.1 인증 (better-auth 관리)
better-auth Drizzle 어댑터가 생성하는 테이블을 그대로 쓴다: `user`, `session`, `account`, `verification`. 우리 코드는 이 테이블을 직접 수정하지 않는다. better-auth CLI(`npx @better-auth/cli generate`)로 스키마를 생성해 `packages/db`에 포함한다.

### 6.2 애플리케이션 테이블

```
profiles
  user_id        text PK  → user.id
  nickname       varchar(20) UNIQUE NOT NULL
  role           enum('user','admin') default 'user'
  created_at, updated_at

balances
  user_id        text PK → user.id
  available_p    bigint NOT NULL default 0  CHECK (available_p >= 0)
  locked_p       bigint NOT NULL default 0  CHECK (locked_p >= 0)
  updated_at

ledger_entries                       -- append-only
  id             bigserial PK
  user_id        text NOT NULL → user.id
  type           enum(§5.6)
  amount_p       bigint NOT NULL       -- 부호 포함
  balance_after_p bigint NOT NULL      -- 해당 시점 available 스냅샷 (감사용)
  ref_type       varchar(32)           -- 'payment'|'fill'|'market'|'admin_action'
  ref_id         text
  memo           text
  created_at     timestamptz default now()
  INDEX (user_id, created_at DESC), INDEX (ref_type, ref_id)

payments                             -- mock 결제
  id             uuid PK
  user_id        text → user.id
  amount_p       bigint NOT NULL CHECK (amount_p > 0)
  provider       varchar(32) NOT NULL   -- 'mock'
  provider_ref   text
  status         enum('pending','succeeded','failed') 
  created_at, updated_at

categories
  id             serial PK
  slug           varchar(32) UNIQUE   -- economy|culture|entertainment|tech|weather
  name_ko        varchar(32)
  sort_order     int
  is_active      bool default true

markets
  id             uuid PK
  slug           varchar(80) UNIQUE
  title          varchar(120) NOT NULL          -- 질문
  description    text
  rules          text NOT NULL                  -- 정산 기준
  resolution_source text                        -- 정보 출처(URL/설명)
  category_id    int → categories.id
  image_url      text
  mechanism      enum('lmsr','clob') default 'lmsr'
  status         enum('draft','open','closed','resolved','settled','voided')
  visibility     enum('public','group') default 'public'   -- 그룹 대비
  group_id       uuid NULL                                  -- 그룹 대비 (FK는 그룹 테이블 생성 시)
  -- LMSR 상태
  liquidity_b    numeric(18,6) NOT NULL
  q_yes          numeric(24,10) NOT NULL
  q_no           numeric(24,10) NOT NULL
  initial_prob_bp smallint NOT NULL             -- 1..9999 (basis points)
  reserve_p      bigint NOT NULL                -- 100·b·ln2
  -- 시장 통계
  last_price     smallint NOT NULL              -- YES 표시가 1..99
  volume_p       bigint default 0
  trade_count    int default 0
  trader_count   int default 0
  -- 수수료 (MVP 0)
  taker_fee_bps  smallint default 0
  settlement_fee_bps smallint default 0
  -- 일정/정산
  open_at        timestamptz
  close_at       timestamptz NOT NULL
  resolved_result enum('YES','NO') NULL
  resolved_at    timestamptz NULL
  settled_at     timestamptz NULL
  voided_at      timestamptz NULL
  created_by     text → user.id
  created_at, updated_at
  INDEX (status, close_at), INDEX (category_id, status)

orders                               -- CLOB 대비 구조. MVP는 market 주문만
  id             uuid PK
  user_id        text → user.id
  market_id      uuid → markets.id
  outcome        enum('YES','NO')
  side           enum('buy','sell')
  type           enum('market','limit')
  limit_price    smallint NULL                  -- 1..99, limit 전용
  qty            int NOT NULL CHECK (qty > 0)
  filled_qty     int NOT NULL default 0
  status         enum('open','partially_filled','filled','cancelled','rejected')
  time_in_force  enum('ioc','gtc') default 'ioc'
  idempotency_key text UNIQUE NOT NULL
  max_cost_p     bigint NULL                    -- 슬리피지 가드
  min_proceeds_p bigint NULL
  created_at, updated_at
  INDEX (user_id, created_at DESC), INDEX (market_id, status)

fills
  id             bigserial PK
  market_id      uuid → markets.id
  order_id       uuid → orders.id
  counterparty_type enum('amm','order')
  counterparty_order_id uuid NULL → orders.id
  outcome        enum('YES','NO')
  side           enum('buy','sell')
  qty            int NOT NULL
  amount_p       bigint NOT NULL                -- 총 지불/수령 P
  price_avg_bp   int NOT NULL                   -- amount_p·100/qty (bp)
  fee_p          bigint default 0
  created_at
  INDEX (market_id, created_at DESC), INDEX (order_id)

positions
  user_id        text → user.id
  market_id      uuid → markets.id
  outcome        enum('YES','NO')
  qty            int NOT NULL default 0 CHECK (qty >= 0)
  cost_basis_p   bigint NOT NULL default 0
  realized_pnl_p bigint NOT NULL default 0
  settled        bool default false
  updated_at
  PK (user_id, market_id, outcome)
  INDEX (market_id, settled)

price_ticks
  id             bigserial PK
  market_id      uuid → markets.id
  ts             timestamptz NOT NULL
  p_yes_bp       int NOT NULL                   -- 0..10000
  trigger        enum('trade','open','resolve')
  INDEX (market_id, ts)                         -- 월 단위 파티셔닝은 M6에서 검토

market_settlement_steps              -- 판정된 시장의 정산 단계 (ADR-0046). append-only 아님
  market_id      uuid NOT NULL → markets.id
  step           varchar(20) NOT NULL           -- SETTLEMENT_STEPS: 'coin' (#29가 'score' 추가)
  status         varchar(20) default 'pending'  -- 'pending'|'done'|'failed'
  attempts       int NOT NULL default 0         -- CHECK (attempts >= 0)
  completed_at   timestamptz NULL               -- status='done'일 때만 채움 (CHECK)
  last_error     text NULL                      -- 마지막 실패 메시지 앞 1,000자
  created_at, updated_at
  PK (market_id, step)

market_events                        -- append-only 감사 로그
  id             bigserial PK
  market_id      uuid → markets.id
  type           varchar(40)                    -- 'created','opened','closed','resolved','finalized','voided','rules_edited' (legacy: 'resolve_proposed','result_changed'는 과거 행만)
  actor_id       text NULL
  payload        jsonb
  created_at
  INDEX (market_id, created_at)

admin_actions
  id             uuid PK
  admin_id       text → user.id
  type           varchar(40)                    -- 'balance_adjust','market_*'
  target_type    varchar(32)
  target_id      text
  payload        jsonb
  created_at

audit_failures
  id             bigserial PK
  kind           varchar(40)                    -- 'ledger_balance_mismatch'
  payload        jsonb
  created_at
```

### 6.3 그룹 기능 대비 (지금 반영)
- `markets.visibility`, `markets.group_id`는 지금 추가한다 (FK 없이). 그룹 테이블(`groups`, `group_members`)은 만들지 않는다.
- 랭킹은 `positions.realized_pnl_p`, `fills`, `ledger_entries`에서 사용자별로 집계 가능하도록 인덱스를 둔다. 별도 집계 테이블은 그룹 마일스톤에서.
- `profiles.nickname`은 지금부터 필수 (랭킹·향후 댓글에 필요).

### 6.4 DB 권한
- 앱 롤 `buddha_app`: `ledger_entries`, `market_events`, `admin_actions`에 INSERT/SELECT만.
- 마이그레이션 롤 `buddha_migrate`: DDL.
- docker-compose 초기화 SQL에서 두 롤을 만든다.

---

## 7. API 명세 (REST)

- Base: `/api/v1`. 인증: better-auth 세션 쿠키 (`/api/auth/*`는 better-auth가 처리).
- 응답 봉투: 성공 `{ data, meta? }`, 실패 `{ error: { code, message, details? } }`.
- 페이지네이션: cursor 기반 `?cursor=&limit=` (기본 20, 최대 100), `meta.nextCursor`.
- 시각은 ISO 8601 UTC. 클라이언트가 KST로 표시.
- 모든 요청/응답 DTO는 `packages/shared`의 zod 스키마로 정의하고 `@nestjs/swagger`에 반영한다.

### 7.1 공개 (비로그인 가능)
| Method | Path | 설명 |
|---|---|---|
| GET | `/markets` | 목록. `?category=&status=open&sort=volume|closing|newest&q=` |
| GET | `/markets/:idOrSlug` | 상세 (LMSR 상태 포함하지 않음. 가격·통계·rules·status·일정) |
| GET | `/markets/:id/ticks` | `?from=&to=&resolution=raw|1m|1h` — MVP는 raw 반환 + 서버 다운샘플(최대 500포인트) |
| GET | `/markets/:id/fills` | 최근 체결 20건 (익명: 시각·결과·수량·평균가) |
| GET | `/categories` | |
| POST | `/quotes` | `{marketId, outcome, side, mode:'shares'|'spend', value}` → `{shares, amountP, priceAvg, priceAfter, maxPayoutP}` (로그인 불필요, 계산만) |

### 7.2 인증 필요
| Method | Path | 설명 |
|---|---|---|
| GET | `/me` | 프로필 + 잔고 + 연결된 로그인 수단 |
| PATCH | `/me` | 닉네임 변경 |
| POST | `/trades` | §5.4. Body `{marketId, outcome, side, shares, maxCostP?|minProceedsP?}` + `Idempotency-Key` 헤더 |
| GET | `/me/positions` | `?status=open|settled` |
| GET | `/me/orders` | 이력 |
| GET | `/me/ledger` | 원장 (cursor) |
| POST | `/payments/charge` | `{amountP}` → mock 즉시 성공. `PaymentProvider` 인터페이스 경유 |
| GET | `/me/payments` | |

### 7.3 관리자 (`role='admin'`)
| Method | Path | 설명 |
|---|---|---|
| GET/POST | `/admin/markets` | 목록/생성(draft) |
| PATCH | `/admin/markets/:id` | draft/open 상태에서 수정. `rules` 변경은 `market_events(rules_edited)` 기록. open 상태에서는 title·rules·close_at 수정 시 경고 후 허용, `liquidity_b`·`initial_prob`는 draft에서만 |
| POST | `/admin/markets/:id/open` | rules 비어 있으면 거부 |
| POST | `/admin/markets/:id/close` | 즉시 마감 |
| POST | `/admin/markets/:id/resolve` | `{result, note, evidenceUrl}`. `closed`에서만. 판정 즉시 확정 (§5.5) |
| POST | `/admin/markets/:id/void` | `{reason}`. `open`·`closed`에서만 |
| GET | `/admin/users` | 검색 |
| POST | `/admin/users/:id/balance-adjust` | `{amountP(±), memo}` → ADMIN_ADJUST |
| GET | `/admin/payments` | |
| GET | `/admin/audit-failures` | |

### 7.4 에러 코드
`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `MARKET_NOT_OPEN`, `MARKET_CLOSED`, `INSUFFICIENT_BALANCE`, `INSUFFICIENT_POSITION`, `PRICE_MOVED`, `DUPLICATE_REQUEST`(멱등키 충돌·다른 페이로드), `RATE_LIMITED`, `RULES_REQUIRED`, `INTERNAL`.

### 7.5 레이트 리밋
`@nestjs/throttler` + Redis 스토리지. 기본 100req/분/IP. `/trades` 20req/분/사용자. `/payments/charge` 10req/분/사용자.

---

## 8. 실시간 (Socket.IO)

- 네임스페이스 `/ws`. 인증: 연결 시 세션 쿠키로 better-auth 세션 확인. 비로그인도 공개 room 구독 허용.
- Redis 어댑터(`@socket.io/redis-adapter`)로 다중 인스턴스 대비. MVP는 `apps/api` 프로세스 안에 게이트웨이를 둔다.
- Room: `market:{id}` (공개), `user:{id}` (본인만).
- 클라이언트 프로토콜: **REST로 스냅샷 → 구독**. 구독 후 첫 이벤트 전까지의 공백은 스냅샷 값으로 표시.

| 이벤트 (server→client) | room | payload |
|---|---|---|
| `market:tick` | market | `{marketId, pYesBp, lastPrice, volumeP, tradeCount, ts}` |
| `market:trade` | market | `{marketId, outcome, side, qty, priceAvgBp, ts}` (익명) |
| `market:status` | market | `{marketId, status, resolvedResult, statusEventId, ts}` (API가 `resolved`, 워커가 `settled`) |
| `user:balance` | user | `{availableP, lockedP}` |
| `user:position` | user | `{marketId, outcome, qty, costBasisP, realizedPnlP}` |

| 이벤트 (client→server) | payload |
|---|---|
| `subscribe` | `{marketIds: string[]}` |
| `unsubscribe` | `{marketIds: string[]}` |

- 발행 경로: 거래 트랜잭션 COMMIT 후 `RedisPublisher.publish('market:{id}', event)`. 게이트웨이는 Redis 채널을 구독해 room으로 emit. 같은 프로세스여도 이 경로를 거친다 (다중 인스턴스 시 코드 변경 없음).
- 하트비트: socket.io 기본 ping 25s. 클라이언트 재연결 시 스냅샷 재요청.

---

## 9. 백그라운드 잡 (`apps/worker`, BullMQ)

| 큐 | 잡 | 트리거 | 동작 |
|---|---|---|---|
| `markets` | `market.close` | 생성 시 delayed(close_at) + 매 분 스캔 | open→closed |
| `markets` | `market.finalize` | 판정 시 즉시 + 매 분 스캔 | resolved→settled (§5.5) |
| `audit` | `ledger.audit` | 매일 04:00 KST | 원장-잔고 불변식 검증 |
| `stats` | `market.trader_count` | 거래 후 debounce 10s | `trader_count` 재계산 |

- 모든 잡은 멱등. 재시도 3회, 지수 백오프. 실패는 `audit_failures` 또는 BullMQ failed set에 남긴다. 정산 단계의 실패는 `market_settlement_steps`에도 남는다(§5.5).
- 워커는 `packages/db`와 `packages/shared`를 사용하고 API 앱에 의존하지 않는다. 정산 회계 함수는 `packages/shared/src/accounting.ts`에 두고 API와 워커가 공유한다.

---

## 10. 인증 (better-auth)

### 10.1 배치
- better-auth 인스턴스는 `apps/api/src/auth/auth.ts`. Drizzle 어댑터. `@thallesp/nestjs-better-auth`로 마운트 (Fastify 지원 베타). NestJS 부트스트랩에서 `bodyParser: false`.
- Next.js는 `/api/*`를 API 서버로 rewrite 한다 (`next.config`). 브라우저 입장에서 단일 출처 → 쿠키·CORS 문제 없음. 프로덕션도 같은 도메인 경로 라우팅을 전제로 한다.
- 클라이언트: `better-auth/react` 의 `createAuthClient({ baseURL: '/api/auth' })`.

### 10.2 로그인 수단
- 이메일 + 비밀번호 (최소 8자). 이메일 인증 메일은 mailpit으로 발송하되 **인증 강제 여부는 §17 Q1**.
- 소셜: Google, Kakao, Naver. better-auth 내장 프로바이더를 우선 사용하고, 없으면 `genericOAuth` 플러그인으로 구성한다.
- 비밀번호 재설정 이메일.

### 10.3 계정 연결
- `account.accountLinking.enabled = true`, `allowDifferentEmails = true` (카카오는 이메일 미제공 가능).
- 로그인 상태에서 설정 화면의 "연결"로 `linkSocial`. 연결 해제는 로그인 수단이 2개 이상일 때만 허용.
- 카카오/네이버가 이메일을 주지 않는 경우: better-auth의 프로바이더 `mapProfileToUser`에서 `email`을 `{provider}_{id}@noemail.buddha.local` 형태로 채우고 `emailVerified=false`. 이 사용자는 이메일 로그인이 불가하며, 설정에서 실제 이메일을 추가할 수 있다. (이 처리가 better-auth 버전에서 불가능하면 QUESTIONS.md에 기록하고 멈춘다.)

### 10.4 프로필 생성
- better-auth `databaseHooks.user.create.after`에서 `profiles`(닉네임 자동 생성: `예측가_XXXX`, 충돌 시 재시도)와 `balances`(0)를 같은 트랜잭션으로 생성한다.

### 10.5 권한
- `profiles.role`. NestJS `AdminGuard`가 세션 user_id → profiles.role 조회(Redis 캐시 60s).
- 첫 관리자는 `pnpm db:seed`가 `.env`의 `SEED_ADMIN_EMAIL`로 생성한다.

### 10.6 대안
`@thallesp/nestjs-better-auth`의 Fastify 지원이 막히면: better-auth의 Fastify 통합 가이드대로 `auth.handler`를 Fastify 라우트에 직접 마운트하고, 세션 조회 가드만 자체 작성한다. DECISIONS.md에 기록.

---

## 11. 웹 (Next.js + Chakra UI v3)

### 11.1 디자인 방향
참고 모델과 가져올 것:
- **Polymarket**: 카드 기반 탐색. 카드 = 질문 + 큰 확률 % + 미니 스파크라인 + 거래량 + 마감. 뉴스 피드처럼 스크롤.
- **Kalshi**: **정산 기준을 가장 눈에 띄게.** 상세 화면 상단 접기 없이 노출. "무엇이 '예'인가 / 출처는 어디인가 / 마감은 언제인가"를 한눈에.
- **Robinhood(참고)**: 숫자 롤링 애니메이션, 매수 확인의 촉각적 피드백, 카테고리 가로 스크롤.

원칙:
1. **확률(%)이 주, 가격(P)이 보조.** 카드는 "63%"만, 상세는 "63% · 63P".
2. **"맞히면 100P"를 어디서나.** 매수 패널에 "N계약 · 평균 63P · 맞히면 N×100P 지급(수익 +X P)"을 항상 표시.
3. **오더북·뎁스차트 없음.** MVP는 AMM이므로 화면도 Yes/No 두 버튼 + 금액 입력으로 단순화.
4. **모바일 웹 우선.** 매수 패널은 모바일에서 하단 시트. 버튼은 엄지 영역.
5. **실시간은 조용하게.** 확률 변화는 200~300ms 숫자 롤링. 깜빡임·공격적 색 변화 금지.
6. **금전 표기 통일.** `formatP(n)` = `12,345P`. 음수는 `−1,200P`. 천 단위 구분자.
7. **도박 어휘 금지.** "베팅/배당/승률" 대신 "예측/확률/수익". 문구 상수는 `apps/web/src/copy.ts`에 모은다.

### 11.2 테마 토큰 (Chakra `createSystem`)
- 브랜드 컬러: 임시 인디고 계열 (§17 Q7). 
- 결과 색: `yes` = teal/green 계열(채도 낮춤), `no` = rose/red 계열(채도 낮춤). 텍스트는 색만으로 의미를 전달하지 않도록 라벨 병기("예 63%").
- 라이트/다크 모두. `next-themes` 연동.
- 폰트: Pretendard (한글 최적화). 숫자는 `font-variant-numeric: tabular-nums`.

### 11.3 화면 목록

| 경로 | 화면 | 핵심 요소 |
|---|---|---|
| `/` | 홈 | 카테고리 탭(전체/경제/문화/엔터/테크/날씨), 정렬(거래량/마감임박/신규), 마켓 카드 그리드, 검색 |
| `/markets/[slug]` | 시장 상세 | 상단: 질문·카테고리·마감 카운트다운·거래량. 확률 큰 숫자 + 타임라인 차트(1D/1W/전체). **정산 기준 섹션(rules, 출처)**. 매수/매도 패널. 내 포지션. 최근 체결. `resolved`면 결과와 정산 진행 안내. `settled`면 결과·내 손익 |
| `/portfolio` | 포트폴리오 | 잔고 요약, 보유 포지션(현재가 기준 평가손익), 정산 완료 이력, 주문 이력 |
| `/wallet` | 지갑 | 잔고, 충전(프리셋 금액 §17 Q3 + 직접 입력), 원장 내역. 상단 고정 안내: "P는 현금으로 환전·출금할 수 없습니다" |
| `/login`, `/signup` | 인증 | 이메일/비번, 소셜 3종 버튼 |
| `/settings` | 설정 | 닉네임, 연결된 로그인 수단(연결/해제), 비밀번호 변경, 테마 |
| `/about` | 안내 | 서비스 설명, "P는 환전 불가" 고지, 이용약관·개인정보(플레이스홀더 §17 Q6) |
| `/admin/*` | 관리자 | §12 |

### 11.4 핵심 컴포넌트
- `MarketCard`: 질문, 확률 배지, 스파크라인(최근 24h ticks), 거래량, 마감, 카테고리 태그. 클릭 → 상세.
- `ProbabilityDisplay`: 숫자 롤링(`@number-flow/react` 또는 framer-motion), 방향 화살표 + `+2%p` 배지(5초 후 사라짐).
- `ProbabilityChart`: 라인차트, 시간 범위 토글, 호버 툴팁(시각·확률).
- `TradePanel`: 탭(매수/매도) × 결과(예/아니오). 입력 모드 토글(P 금액 / 계약 수). 실시간 견적(`POST /quotes` 디바운스 300ms). 요약(계약 수·평균가·맞히면 지급·예상 수익·가격 변동 후 확률). 확인 버튼 → 성공 토스트 + 잔고/포지션 갱신. 잔고 부족 시 "충전하기" 링크.
- `RulesSection`: 정산 기준·출처·마감. 상세 화면에서 접히지 않음.
- `PositionRow`, `LedgerRow`, `CountdownBadge`, `EmptyState`, `AuthButtons`.
- 레이아웃: 상단 네비(로고, 검색, 카테고리, 잔고 칩, 프로필 메뉴). 모바일 하단 탭(홈/포트폴리오/지갑/설정).

### 11.5 데이터 계층
- `packages/api-client`로 타입 안전 호출. TanStack Query 키 규칙: `['markets', filters]`, `['market', id]`, `['ticks', id, range]`, `['me']`, `['positions']`, `['ledger']`.
- 소켓 훅 `useMarketSocket(marketIds)`: 이벤트 수신 시 해당 Query 캐시를 직접 갱신(`setQueryData`)한다. refetch 남발 금지.
- 서버 컴포넌트로 시장 목록·상세의 초기 데이터를 SSR(SEO). 클라이언트 컴포넌트에서 소켓 구독.
- 확률 계산·P 포맷은 반드시 `packages/shared` 함수를 쓴다. 웹에서 재구현 금지.

---

## 12. 관리자 (`/admin`)

`AdminGuard` 통과 시만 접근. 별도 레이아웃(사이드바).

- **시장 목록**: 상태 필터, 마감 임박, 판정 대기(`closed`)·정산 대기(`resolved`) 배지.
- **시장 생성/수정 폼**: 질문, 설명(마크다운), **정산 기준(필수, 마크다운)**, 출처, 카테고리, 이미지 URL, 마감 시각(KST 입력, UTC 저장), 초기 확률(슬라이더 1~99%), 유동성 b(도움말: 최대 손실 표시), 미리보기(카드·상세 미리보기).
- **시장 상세(관리)**: 상태 전이 버튼(열기/마감/정산/무효), LMSR 상태(q_yes, q_no, 누적 운영 손익), 판정 뒤 정산 단계(단계·상태·시도·완료 시각·마지막 오류, 읽기 전용), 이벤트 로그, 체결 목록.
- **정산 화면**: 결과 선택(예/아니오), 메모, 근거 URL → 확인 모달("판정은 즉시 확정되고 바로 정산이 시작됩니다. 판정한 뒤에는 결과를 바꾸거나 무효로 할 수 없습니다."). `closed`에서만 열린다.
- **사용자**: 검색, 잔고, 포지션, 잔고 조정(사유 필수 → ADMIN_ADJUST).
- **결제 목록**, **감사 실패 목록**.

---

## 13. 마일스톤 & 수용 기준

각 마일스톤은 `pnpm typecheck && pnpm lint && pnpm test`가 통과해야 한다.

### M0 — 스캐폴딩
작업:
- pnpm workspace, Turborepo, `packages/config-*`, `.nvmrc`(24), `.editorconfig`, Prettier/ESLint.
- `apps/web`(Next.js + Chakra v3 + next-themes, 빈 홈), `apps/api`(NestJS + Fastify, `/health`), `apps/worker`(BullMQ 연결 + 빈 큐), `apps/mobile`(Expo 스캐폴드, 실행 확인만).
- `packages/shared`(빈 index + `formatP`), `packages/db`(Drizzle 설정, 빈 스키마), `packages/api-client`(빈 생성 스크립트).
- `docker/docker-compose.yml`: postgres(16, 롤 초기화 SQL), redis(7), mailpit.
- `docs/DECISIONS.md`, `docs/QUESTIONS.md` 생성.
- GitHub Actions: lint/typecheck/test.

AC:
- [ ] `pnpm install && docker compose up -d && pnpm dev` 로 web(3000)/api(4000)/worker 동시 기동.
- [ ] `GET /api/health` → `{status:'ok', db:'ok', redis:'ok'}` (web의 rewrite 경유).
- [ ] `pnpm build` 전체 성공. Turbo 캐시 히트 확인.
- [ ] `apps/mobile`: `pnpm --filter mobile exec expo doctor` 통과 (실행은 하지 않아도 됨).

### M1 — 스키마 · 인증 · 프로필
작업:
- §6 전체 스키마 Drizzle 정의 + 첫 마이그레이션. better-auth 스키마 생성 포함.
- better-auth 구성(§10). 이메일/비번, Google/Kakao/Naver, 계정 연결, 프로필·잔고 자동 생성.
- 웹: 로그인/가입/설정(닉네임·연결 수단) 화면.
- `GET /me`, `PATCH /me`.
- 시드: 카테고리 5개, 관리자 1명.

AC:
- [ ] 이메일 가입 → 로그인 → `/me`가 프로필·잔고(0) 반환.
- [ ] 로그인 상태에서 구글 연결 → `account` 2건. 구글로 로그아웃 후 재로그인 시 같은 user.
- [ ] 마지막 남은 로그인 수단 해제 시도 → 거부.
- [ ] 닉네임 중복 → `VALIDATION_ERROR`.
- [ ] (소셜 프로바이더 실제 키가 없으면) Google만 실제 연동 확인하고 Kakao/Naver는 설정 코드 + QUESTIONS.md에 키 요청.

### M2 — 포인트 · 지갑
작업:
- `PaymentProvider` 인터페이스 + `MockPaymentProvider`. `POST /payments/charge` → payments + ledger(DEPOSIT) + balances 한 트랜잭션.
- `GET /me/ledger`, `GET /me/payments`.
- `ADMIN_ADJUST` API + 관리자 사용자 화면(최소).
- 웹: `/wallet` (충전, 원장). 환전 불가 고지.
- `ledger.audit` 워커 잡.

AC:
- [ ] 10,000P 충전 → `available_p=10000`, ledger 1건, `balance_after_p=10000`.
- [ ] 동시 충전 20건 병렬 → 잔고 = 합계, 원장 20건 (integration test).
- [ ] 관리자 −3,000P 조정(사유 필수) → 잔고 7,000, ledger ADMIN_ADJUST.
- [ ] 잔고를 음수로 만드는 조정 → 거부.
- [ ] `ledger.audit` 수동 실행 시 불일치 0건. 의도적으로 balances를 직접 수정한 뒤 실행하면 `audit_failures` 1건.

### M3 — 시장 · LMSR · 거래 · 관리자 시장 CRUD
작업:
- `packages/shared/src/lmsr.ts`(§5.3) + property tests(fast-check).
- `packages/shared/src/accounting.ts`(포지션 회계 §5.4).
- 시장 CRUD(관리자), 상태 전이(open/close/void), `market_events`.
- `POST /quotes`, `POST /trades`(§5.4 트랜잭션, 멱등키, 슬리피지 가드), `GET /markets*`, `GET /me/positions`, `GET /me/orders`.
- Redis publish(§8 발행 경로만, 게이트웨이는 M4).
- 시드: 카테고리별 2~3개, 총 12개 시장 (부록 C 형태).

AC:
- [ ] LMSR property test 5개 불변식 통과 (각 1,000 케이스).
- [ ] `initState(0.5, 1000)` → `priceOf = 50`. YES 100계약 매수 후 가격 상승, NO 가격 = 100 − YES(표시가 기준 ±1 허용).
- [ ] 잔고 10,000P로 60,000P어치 매수 → `INSUFFICIENT_BALANCE`, 잔고·원장·시장 상태 불변.
- [ ] 같은 `Idempotency-Key`로 2회 요청 → 동일 응답, 거래 1건.
- [ ] `maxCostP`를 실제보다 낮게 → `PRICE_MOVED`.
- [ ] 동시성: 같은 시장에 50개 병렬 매수 → 모두 성공 또는 잔고부족, `q_yes` = 성공 건 합, 각 사용자 잔고 = 원장 합.
- [ ] `closed` 시장 거래 → `MARKET_NOT_OPEN`.
- [ ] rules 없는 시장 open → `RULES_REQUIRED`.
- [ ] 매도: 보유 10계약 중 15계약 매도 → `INSUFFICIENT_POSITION`. 10계약 매도 후 qty 0, `realized_pnl_p` 계산 검증.

### M4 — 웹 UI · 실시간 · 차트
작업:
- 홈, 시장 상세, 포트폴리오, 매수/매도 패널, 확률 차트, 카드 스파크라인.
- Socket.IO 게이트웨이 + Redis 어댑터 + 클라이언트 훅.
- `GET /markets/:id/ticks` 다운샘플.
- 반응형(모바일 하단 시트), 라이트/다크, 숫자 롤링.

AC:
- [ ] 브라우저 A에서 매수 → 브라우저 B의 카드·상세 확률이 1초 내 갱신(리프레시 없이).
- [ ] 상세 화면 첫 페인트에 SSR로 질문·확률·rules 포함 (view-source 확인).
- [ ] 매수 패널: 금액 입력 → 300ms 내 견적 표시. 확인 → 토스트 + 잔고 칩 갱신 + 포지션 표시.
- [ ] 잔고 부족 시 "충전하기" 링크 → `/wallet`.
- [ ] 모바일 뷰포트(375px)에서 상세 화면 스크롤 없이 확률·예/아니오 버튼 보임.
- [ ] Lighthouse 접근성 90+ (홈, 상세). 색 대비 AA.
- [ ] Playwright e2e: 가입 → 충전 → 매수 → 포트폴리오에 포지션 표시.

### M5 — 마감 · 정산 · 이의
작업:
- 워커 `market.close`, `market.finalize` (delayed + 스캔).
- 관리자 정산/무효 화면, 결과 변경 시 dispute_until 리셋.
- 사용자 이의 제기 폼, 관리자 이의 처리.
- 정산 후 포트폴리오 표시(실현 손익), 지갑 원장에 SETTLEMENT_PAYOUT.
- WS `market:status`.

AC:
- [ ] close_at 도달 → 1분 내 `closed` (테스트에서는 close_at을 과거로 두고 스캔 잡 수동 실행).
- [ ] 정산 제안 → `resolving`, dispute_until = +24h. 테스트용으로 `TEST_DISPUTE_WINDOW_SECONDS` env(기본 86400)를 두고 e2e에서 5초로.
- [ ] finalize: YES 승리 시 YES 10계약 보유자 잔고 +1,000P, ledger SETTLEMENT_PAYOUT 1건, NO 보유자 지급 0, 양쪽 `settled=true`. 재실행 시 중복 지급 없음.
- [ ] void: 전 포지션 cost_basis 환불, ledger MARKET_VOID_REFUND.
- [ ] 이의: resolving에서만 접수, 같은 사용자 2회 → 거부, settled 후 → `DISPUTE_WINDOW_CLOSED`.
- [ ] 결과 변경 후 dispute_until이 새로 +24h, 기존 finalize 잡 취소됨.
- [ ] Playwright e2e: 매수 → 관리자 정산 → (5초) → 포트폴리오에 실현 손익 표시 → 지갑 원장에 지급 내역.

(2026-09-28 #19로 이의 단계 폐지)

### M6 — 하드닝 · 문서
작업:
- 레이트 리밋(§7.5), 요청 로깅(pino), 에러 핸들링 통일, 헬스체크 상세.
- `price_ticks` 월 파티셔닝 여부 검토(DECISIONS.md), 인덱스 점검, N+1 제거.
- 시드 데이터 정비, `docs/API.md` 생성(OpenAPI 요약), README(로컬 실행·아키텍처 다이어그램).
- 보안: 헤더(helmet 상당), CSRF(better-auth 기본), 관리자 라우트 감사 로그 완전성 확인.
- 선택: 글로벌 리더보드(실현 손익 상위 20) — 그룹 기능의 전신. 시간이 남을 때만.

AC:
- [ ] `/trades` 21번째 요청/분 → `RATE_LIMITED`.
- [ ] 홈 API p95 < 200ms (시드 12개 + 로컬).
- [ ] README만 보고 신규 개발자가 15분 내 로컬 기동 가능(자체 점검).
- [ ] `docs/QUESTIONS.md`의 미해결 항목이 정리되어 사용자에게 전달됨.

### 이후 (MVP 외)
- 실제 PG 연동(토스페이먼츠/포트원) — `PaymentProvider` 구현 추가
- CLOB — `apps/matching-worker` 신설, `orders.type='limit'` 활성화, `balances.locked_p` 사용
- 그룹 — `groups`, `group_members`, 그룹 스코프 시장, 그룹 랭킹
- Expo 앱 — `packages/api-client` + `shared` 재사용
- AWS — CDK(`infra/`): Fargate 3서비스, RDS, ElastiCache Valkey, ALB(WS idle timeout 상향)

---

## 14. 테스트 전략

| 계층 | 도구 | 대상 |
|---|---|---|
| Unit | Vitest + fast-check | `shared` 전체(LMSR·회계·포맷). 커버리지 90%+ |
| Integration | Vitest + 실제 Postgres/Redis (docker-compose `test` 프로필, 테스트마다 트랜잭션 롤백 또는 스키마 리셋) | 거래 트랜잭션, 동시성, 정산, 원장 불변식, 멱등성 |
| API contract | 생성된 OpenAPI vs zod 스키마 일치 검사 | 배포 전 CI |
| E2E | Playwright (chromium, 375px·1280px) | 가입→충전→매수→정산 흐름, 관리자 시장 생성 |
| 부하(선택, M6) | k6 | `/trades` 동시 50, `/markets` 200 rps |

테스트 데이터는 팩토리 함수(`packages/db/src/test/factories.ts`)로 만든다. 스냅샷 테스트는 쓰지 않는다.

---

## 15. 로컬 개발 환경

`docker/docker-compose.yml` 서비스: `postgres:16`(5432), `redis:7`(6379), `axllent/mailpit`(SMTP 1025, UI 8025).

`.env.example` (apps/api, apps/worker 공용 + apps/web):
```
NODE_ENV=development
DATABASE_URL=postgres://buddha_app:buddha@localhost:5432/buddha
DATABASE_MIGRATE_URL=postgres://buddha_migrate:buddha@localhost:5432/buddha
REDIS_URL=redis://localhost:6379
BETTER_AUTH_SECRET=change-me
BETTER_AUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID= / GOOGLE_CLIENT_SECRET=
KAKAO_CLIENT_ID= / KAKAO_CLIENT_SECRET=
NAVER_CLIENT_ID= / NAVER_CLIENT_SECRET=
SMTP_HOST=localhost SMTP_PORT=1025
SEED_ADMIN_EMAIL=admin@buddha.local
SEED_ADMIN_PASSWORD=admin1234!
API_PORT=4000
NEXT_PUBLIC_API_URL=http://localhost:4000   # web rewrite 대상
```

스크립트(루트 `package.json`):
```
dev            turbo dev
build          turbo build
test           turbo test
typecheck      turbo typecheck
lint           turbo lint
db:generate    drizzle-kit generate (packages/db)
db:migrate     drizzle-kit migrate
db:seed        tsx packages/db/src/seed.ts
api:openapi    apps/api에서 OpenAPI JSON 추출 → packages/api-client 생성
```

---

## 16. 향후 확장을 위해 지금 지키는 것
- **CLOB**: `orders/fills/positions/balances.locked_p` 구조는 CLOB 전제로 이미 설계됨. LMSR 로직은 `MarketMechanism` 인터페이스(`quote`, `execute`) 뒤에 둔다. CLOB 구현체가 들어오면 `markets.mechanism`으로 분기.
- **그룹**: `markets.visibility/group_id`, 사용자별 집계 가능한 인덱스, 닉네임 필수.
- **PG**: `PaymentProvider` 인터페이스. `payments.provider/provider_ref`.
- **앱**: 모든 도메인 로직은 `shared`, 모든 API 호출은 `api-client`. 웹 컴포넌트에 비즈니스 로직 넣지 않기.
- **다중 인스턴스**: WS는 항상 Redis 경유. 프로세스 메모리에 상태 두지 않기(레이트 리밋·멱등 캐시도 Redis).
- **다중 결과 시장**: `outcome` enum을 `YES/NO`로 두되, 테이블 설계에서 outcome을 문자열 컬럼으로 두어 확장 시 enum만 교체.

---

## 17. 열린 질문 (사용자 확인 필요 — 확인 전까지 괄호 안 기본값으로 진행)

1. **이메일 인증 강제** 여부 — 미인증 계정도 충전·거래 가능한가? (기본: 가능. 인증 메일은 발송만)
2. **가입 보너스 P** — 지급하나? 얼마? (기본: 0. `BONUS` 타입만 예약)
3. **충전 프리셋 금액** (기본: 5,000 / 10,000 / 30,000 / 50,000 / 100,000P + 직접 입력, 최소 1,000P, 최대 1회 1,000,000P)
4. **닉네임 정책** — 변경 횟수 제한? 금칙어? (기본: 무제한 변경, 2~20자 한글·영문·숫자, 유일)
5. **시장 이미지** — 관리자가 URL 입력 vs 파일 업로드(S3) (기본: URL 입력)
6. **법적 고지·약관 텍스트** — 이용약관, 개인정보처리방침, "P 환전 불가·환불 정책" 고지문. (기본: 플레이스홀더. **공개 전 법률 검토 필요** — 특히 미사용 P의 환불 요구 가능성은 PG 연동 전에 확인)
7. **브랜드** — 로고, 컬러, 서비스 표시명("buddha" 그대로?) (기본: 텍스트 로고, 인디고)
8. **관리자 정산 SLA** — 마감 후 며칠 내 정산 안내를 화면에 표시할지 (기본: 표시 안 함)
9. **거래 취소** — 매수 직후 취소 기능? (기본: 없음. 매도로 대체)
10. **코드·주석 언어** (기본: 영어)
11. **소셜 로그인 키** — Google/Kakao/Naver 개발자 콘솔 키 발급 필요. 없으면 M1은 Google 또는 이메일만으로 검증.

---

## 부록 A — 사용자 노출 문구 원칙 (`copy.ts`)
- "예측하기" / "예" / "아니오" / "확률" / "맞히면 100P" / "예상 수익" / "정산 기준" / "판정 완료" / "정산 완료"
- 금지: 베팅, 배당, 배당률, 승률, 판돈, 당첨
- 지갑·충전 화면 고정 문구: "충전한 P는 서비스 내에서만 사용할 수 있으며, 현금으로 환전하거나 출금할 수 없습니다."

## 부록 B — 시드 시장 예시 (형태만. 실제 문구는 구현 시 작성. 스포츠·선거 금지)
- 경제: "10월 한국은행 금융통화위원회에서 기준금리가 인하될까?" (출처: 한국은행 보도자료)
- 경제: "9월 소비자물가 상승률(전년 동월 대비)이 2.0% 이상일까?" (출처: 통계청)
- 날씨: "서울의 올해 첫눈이 11월 20일 이전에 관측될까?" (출처: 기상청)
- 날씨: "10월 서울 월 강수량이 50mm를 넘을까?" (출처: 기상청)
- 테크: "○○사가 연내 국내에 신제품 △△를 정식 출시할까?" (출처: 공식 발표)
- 엔터: "○○ 영화가 개봉 2주 내 누적 관객 300만을 넘을까?" (출처: 영화진흥위원회 통합전산망)
- 문화: "○○ 전시회 누적 관람객이 폐막 전 50만을 넘을까?" (출처: 주최 측 발표)

각 시드에는 반드시 `rules`(판정 기준 문장 + 경계 조건: "발표가 없으면 아니오로 정산" 등)와 `resolution_source`를 채운다.

## 부록 C — 아키텍처 요약

```
[Browser] ──HTTP/WS (same-origin /api/*)──▶ [Next.js web] ──rewrite──▶ [NestJS api]
                                                                         ├─ better-auth
                                                                         ├─ REST (markets/trades/...)
                                                                         ├─ Socket.IO gateway ◀─ Redis pub/sub
                                                                         └─ Postgres (Drizzle)
[BullMQ worker] ── Redis 큐 ── Postgres   (market.close / finalize / audit)
```
