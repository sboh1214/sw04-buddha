# 결정 기록 (ADR)

형식: 맥락 / 결정 / 결과. 최신 항목이 아래에 온다. 번호는 재사용하지 않는다.

---

## ADR-0001 — git 저장소 초기화와 브랜치 전략

- 날짜: 2026-09-02
- 상태: 채택

### 맥락

작업 시작 시점에 `buddha/` 디렉터리는 git 저장소가 아니었다(`docs/PLAN.md`만 존재). PLAN §0.1-5는 마일스톤별 브랜치(`m0-scaffold`, `m1-auth` …)와 Conventional Commits를 요구한다.

### 결정

- 로컬에서 `git init -b main` 후 문서만 담은 첫 커밋을 `main`에 만들고, `m0-scaffold` 브랜치에서 M0 작업을 진행한다.
- 줄바꿈은 저장소 전체에서 LF로 고정한다(`.gitattributes: * text=auto eol=lf`, 저장소 로컬 `core.autocrlf=false`). Windows에서 작업하더라도 Docker/CI(Linux)와 셸 스크립트, SQL 초기화 파일이 CRLF로 깨지지 않게 하기 위함이다.
- 원격 저장소(GitHub 등)는 아직 연결하지 않는다. 사용자가 원격 URL을 제공하면 `origin`으로 추가한다.

### 결과

- 이후 모든 마일스톤은 `main`에서 분기한 `m{N}-*` 브랜치에서 진행하고, 완료 후 `main`에 머지한다.
- 원격 미연결 상태이므로 GitHub Actions 워크플로는 작성만 하고 실제 실행은 원격 연결 뒤 확인한다.

---

## ADR-0002 — TypeScript 6.0.3 고정 (7.x 미사용)

- 날짜: 2026-09-02
- 상태: 채택

### 맥락

npm `latest`는 TypeScript 7.0.2다. 7.0은 Go로 재작성된 네이티브 컴파일러이며 7.1까지 JS 컴파일러 API가 없다. `@nestjs/cli` 12는 `typescript ~6.0.2`에 의존하고 `nest build`가 컴파일러 API를 호출한다. `typescript-eslint` 8.69의 peer 범위는 `>=4.8.4 <6.1.0`이다. Expo SDK 57 템플릿과 RN 0.87 템플릿은 `~6.0.3`을 고정한다.

### 결정

- 카탈로그에 `typescript: 6.0.3`을 캐럿 없이 고정한다(6.1도 typescript-eslint 범위 밖).
- TS 6.0의 새 기본값에 맞춰 `packages/config-ts`를 작성한다: `types: []` 기본값이므로 Node 프로젝트는 `types: ["node"]`를 명시, `rootDir`을 `src`로 명시, `baseUrl` 미사용, `esModuleInterop: true`.
- 모든 tsconfig는 TS 7.0.2에서도 경고 없이 통과하도록 작성했으므로 생태계가 따라오면 한 줄 변경으로 전환한다.

### 결과

- `pnpm install`이 `typescript 6.0.3 (7.0.2 is available)`를 출력하는 것은 의도된 상태다.
- TS 7을 같은 패키지에 별칭으로 병행 설치하지 않는다(`bin/tsc` 충돌).

---

## ADR-0003 — 전부 ESM, 공유 패키지는 컴파일 후 `exports`로 노출

- 날짜: 2026-09-02
- 상태: 채택

### 맥락

NestJS 12 패키지 자체가 `"type": "module"`로 배포되고 `nest new` 기본값이 ESM 템플릿이다. better-auth 1.7과 `@thallesp/nestjs-better-auth` 2.7은 ESM 전용이다. PLAN §4.1은 공유 패키지를 `tsc -b`로 컴파일해 `dist/`를 `exports`로 노출하라고 요구한다.

### 결정

- `apps/api`, `apps/worker`, `packages/*` 모두 `"type": "module"`, `module/moduleResolution: nodenext`, 상대 import는 `.js` 확장자 사용.
- 공유 패키지 `exports`는 `{ ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }`만 둔다(`main`/`module`/`require` 분기 없음). Node 24의 `require(esm)`로 CJS 소비자도 로드 가능하다.
- 각 패키지는 `tsconfig.json`(noEmit, 테스트와 패키지 루트의 `*.config.ts`까지 포함, typecheck·ESLint용)과 `tsconfig.build.json`(composite, 테스트 제외, emit용) 한 쌍을 가진다. `tsc -b` 패키지의 `.tsbuildinfo`는 `dist/` 안에 두어 Turbo 캐시와 함께 움직인다. Nest 앱은 `nest build`가 `deleteOutDir`로 매번 새로 내보내므로 `incremental`을 쓰지 않는다(리뷰 반영: 패키지 루트에 남던 300KB tsbuildinfo 제거).
- `apps/web`은 Next 규칙(`module: esnext`, `moduleResolution: bundler`, `jsx: react-jsx`)을 따르고 `"type": "module"`을 두지 않는다(standalone `server.js`가 CJS).
- `apps/mobile`은 `expo/tsconfig.base`를 확장하고 `@buddha/config-ts/react-native.json`으로 엄격성만 덧씌운다.

### 결과

- NestJS는 레거시 데코레이터(`experimentalDecorators` + `emitDecoratorMetadata`)를 유지한다. `verbatimModuleSyntax`와 함께 쓰므로 DI에 쓰는 클래스는 값 import, 인터페이스는 `import type`이어야 한다.
- 순수 패키지(`node.json`)는 `erasableSyntaxOnly: true`라 enum·namespace·생성자 파라미터 프로퍼티를 쓸 수 없다(`as const` 객체와 유니온으로 대체). Nest 앱은 이 옵션을 끈다.

---

## ADR-0004 — pnpm 11 설정 위치, 빌드 스크립트 승인, 릴리스 연령 정책

- 날짜: 2026-09-02
- 상태: 채택

### 맥락

pnpm 11은 `.npmrc`에서 인증/레지스트리 설정만 읽는다. PLAN §4.2의 `.npmrc: strict-peer-dependencies=false`는 무시된다(기본값도 false). 의존성 설치 스크립트는 기본적으로 차단되고(`strictDepBuilds`), 발행 24시간 미만 버전은 `minimumReleaseAge`(기본 1440분, 비엄격) 정책의 대상이다.

### 결정

- 모든 pnpm 설정은 `pnpm-workspace.yaml`에 둔다. `.npmrc`는 주석만 남긴다.
- `allowBuilds`에 `esbuild: true`(tsx/vitest/drizzle-kit), `msgpackr-extract: true`(bullmq 선택 네이티브), `fsevents: false`(macOS 전용 선택 의존성, 프리빌트 바이너리 동봉이라 node-gyp 불필요), `@scarf/scarf: false`(텔레메트리)를 명시한다. 새 네이티브 패키지가 들어오면 `pnpm approve-builds <pkg>`로 추가한다. 이 목록은 Windows/Linux에서는 설치되지 않는 플랫폼 전용 선택 의존성(darwin)까지 덮어야 한다. 그렇지 않으면 macOS의 첫 `pnpm install`이 `ERR_PNPM_IGNORED_BUILDS`로 실패한다(리뷰 반영).
- `minimumReleaseAge`는 기본값(24h, 비엄격)을 유지한다. pnpm이 설치 중 자동으로 덧붙이는 `minimumReleaseAgeExclude` 목록은 그대로 커밋한다(CI의 `--frozen-lockfile`이 이 목록 없이는 실패). 공급망 보호 기본값을 끄지 않기 위한 보수적 선택이다.
- 카탈로그에는 현재 마일스톤이 실제로 사용하는 패키지만 넣는다. 이후 마일스톤은 그 시점의 최신 안정 버전을 추가한다(PLAN §0.1-4).
- `packageManager`는 설치된 `pnpm@11.10.0`으로 고정한다(`pmOnFail: download` 기본값이라 버전이 달라도 자동 사용).

### 결과

- `pnpm-workspace.yaml`은 pnpm이 설치 중 재작성할 수 있어 `.prettierignore`에 넣는다.
- `.npmrc`가 사실상 빈 파일인 점은 PLAN §4.2와 다르다(QUESTIONS.md에 기록).

---

## ADR-0005 — Postgres 드라이버는 `pg`(node-postgres), API는 M0부터 `@buddha/db` 사용

- 날짜: 2026-09-02
- 상태: 채택

### 맥락

PLAN은 드라이버를 지정하지 않는다. 후보는 `postgres`(postgres.js)와 `pg`. drizzle-kit 0.31은 `pg`를 먼저 탐색하고, Drizzle 문서의 기본 예제도 node-postgres다. `pg`는 명시적 Pool 제어(`pool.on('error')`, `idle_in_transaction_session_timeout`)를 제공해 `pg_advisory_xact_lock`을 잡는 트랜잭션에 유리하며 암묵적 prepared statement가 없다. better-auth의 Drizzle 어댑터는 드라이버 무관이다.

### 결정

- `packages/db`는 `pg` + `drizzle-orm/node-postgres`로 `createDb(url, opts)`를 제공한다. 풀 기본값: max 10, `idle_in_transaction_session_timeout` 30초, `application_name` 지정, `casing: 'snake_case'`.
- `apps/api`는 별도 Postgres 클라이언트를 두지 않고 `@buddha/db`의 `createDb`로 DB 프로바이더(`DB` 토큰)를 만들며, 헬스체크도 `db.execute(sql\`select 1\`)`로 수행한다. 한 프로세스에 드라이버 두 개를 두지 않기 위함이다.
- Redis는 `ioredis` 6을 직접 쓴다(`REDIS` 토큰).

### 결과

- `bigint({ mode: 'bigint' })`가 2^53+1을 정확히 왕복하는 것을 스크래치 실험에서 확인했다(PLAN §0.2 정수 불변식과 호환).
- `drizzle.config.ts`와 `createDb`의 `casing` 값은 반드시 같아야 한다.

---

## ADR-0006 — `db:migrate`는 `tsx src/migrate.ts`(재사용 가능한 `runMigrations`)

- 날짜: 2026-09-02
- 상태: 채택

### 맥락

PLAN §15는 `db:migrate: drizzle-kit migrate`를 예시로 든다. 통합 테스트(PLAN §14)는 테스트 DB에 같은 마이그레이션을 프로그램적으로 적용해야 한다.

### 결정

- `packages/db/src/migrator.ts`의 `runMigrations(url)`이 `drizzle-orm/node-postgres/migrator`를 호출하고, `db:migrate` 스크립트는 이를 실행하는 `tsx src/migrate.ts`다. 북키핑 테이블(`drizzle.__drizzle_migrations`)은 `drizzle-kit migrate`와 동일하므로 둘은 호환된다.
- DDL은 항상 `DATABASE_MIGRATE_URL`(buddha_migrate)로, 앱은 `DATABASE_URL`(buddha_app)로 접속한다.
- 빈 `drizzle/meta/_journal.json`을 커밋해 스키마가 비어 있는 M0에서도 `pnpm db:migrate`가 동작하게 한다.

### 결과

- 실행 확인: `drizzle` 스키마와 `__drizzle_migrations` 테이블이 buddha_migrate 소유로 생성됨, buddha_app은 `CREATE TABLE` 거부됨.
- PLAN §6.4의 append-only 테이블 권한 제한은 M2에서 `drizzle-kit generate --custom`으로 만든 `REVOKE` 마이그레이션으로 적용한다.

---

## ADR-0007 — 루트 단일 `.env`, 각 프로세스가 직접 로드

- 날짜: 2026-09-02
- 상태: 채택

### 맥락

PLAN §15는 api/worker/web이 공유하는 하나의 `.env.example`을 요구한다. Turborepo 2.x는 `.env`를 로드하지 않으며(strict env mode 기본), Next.js는 `apps/web/.env*`만 읽는다.

### 결정

- 저장소 루트의 `.env` 하나만 쓴다. 로드 방식은 프로세스별로 검증된 방법을 쓴다.
  - `apps/api`: `config/env.ts`가 모듈 위치 기준 절대경로(`apps/api/.env` → 루트 `.env`)를 계산해 `main.ts`(dotenv, Fastify 옵션용)와 `@nestjs/config`(`envFilePath` + zod `validationSchema`, DI용)가 같은 파일을 읽는다. cwd 상대경로를 쓰면 다른 디렉터리에서 실행할 때 엉뚱한 `.env`를 읽으므로(리뷰 반영) 금지.
  - `apps/worker`: Node 24 `process.loadEnvFile` (앱 로컬 `.env` → 루트 `.env`, 기존 값 우선) + zod.
  - `packages/db`: `dotenv` (drizzle.config.ts, migrate/seed 진입점).
  - `apps/web`: `next.config.ts` 상단에서 `dotenv`로 루트 `.env`를 읽어 `NEXT_PUBLIC_API_URL`을 rewrite 대상에 반영. 미설정 시 `http://localhost:4000`.
- 루트 `.env`를 빌드 산출물에 굽는 것은 `apps/web`뿐이므로 `apps/web/turbo.json`(패키지 설정)의 `build.inputs`에만 `$TURBO_ROOT$/.env*`를 넣는다. 루트 `turbo.json`에 넣으면 `.env` 한 줄 수정이 25개 태스크 캐시를 전부 무효화한다(리뷰 반영). `pnpm dev`는 `--env-mode=loose`로 실행한다.
- Turbo는 strict env 모드라 `turbo.json`의 `env`/`passThroughEnv`에 선언되지 않은 변수는 태스크에 전달되지 않는다. CI 워크플로의 job env도 예외가 아니므로, 테스트가 읽을 변수는 먼저 `test.env`에 선언한다.

### 결과

- `.env`는 커밋하지 않는다. `.env.example`에 PLAN §15 항목 + test 프로필용 `TEST_*` 키를 둔다.
- Turbo 문서는 앱별 `.env`를 권장하지만 PLAN을 따른다.

---

## ADR-0008 — ESLint 10 flat config: 팩토리 함수 패키지, `eslint-config-next`/`eslint-config-expo` 미사용

- 날짜: 2026-09-02
- 상태: 채택

### 맥락

Next 16은 `next lint`를 제거했다. `eslint-config-next` 16과 `eslint-config-expo` 57은 `eslint-plugin-import`/`eslint-plugin-react`/`jsx-a11y`에 의존하는데 이들의 peer는 ESLint ^9까지다. typescript-eslint의 `tsconfigRootDir` 자동 추론은 `eslint.config.*` 파일 안에서만 동작해 공유 패키지에서 쓸 수 없다.

### 결정

- `@buddha/config-eslint`는 `base/react/next({ tsconfigRootDir })` 팩토리 함수를 export한다. 각 패키지의 `eslint.config.mjs`는 `import.meta.dirname`을 넘긴다.
- `base`: `@eslint/js` recommended + `typescript-eslint` recommendedTypeChecked(`projectService`) + Prettier 호환. 패키지 루트의 `*.config.ts`도 각 패키지 `tsconfig.json`의 `include`에 들어 있으므로 타입 인식 린트를 받는다. `@buddha/config-eslint` 자신도 `eslint .`로 린트한다.
- `react`: `eslint-plugin-react-hooks` 7 `configs.flat.recommended`(React Compiler 규칙 포함). `next`: `@next/eslint-plugin-next` `core-web-vitals`를 직접 사용.
- 설정 파일은 ESLint 10이 `.ts` 설정을 기본 지원하지 않으므로 `.mjs`로 통일한다.
- Prettier는 ESLint에 연결하지 않고(`eslint-plugin-prettier` 미사용) `pnpm format:check`를 CI의 별도 단계로 둔다. 옵션: `singleQuote`, `printWidth: 100`, `trailingComma: all`.

### 결과

- 타입 인식 린트는 공유 패키지의 `dist/*.d.ts`가 필요하므로 `turbo.json`의 `lint`/`typecheck`는 `^build`에 의존한다.

---

## ADR-0009 — Chakra UI v3 + Turbopack: Emotion 레지스트리로 hydration 불일치 해결

- 날짜: 2026-09-02
- 상태: 채택

### 맥락

Next 16은 dev/build 모두 Turbopack이 기본이다. Chakra v3(Emotion)를 그대로 쓰면 SSR 시 Emotion의 인라인 `<style data-emotion>`이 `<body>`에 남아 매 로드마다 React #418 hydration 오류가 난다(스크래치 실험에서 재현). Chakra 문서는 `--webpack` 사용을 권한다.

### 결정

- Turbopack을 유지하고, `@emotion/cache` + `CacheProvider` + `useServerInsertedHTML`로 구성한 `EmotionRegistry`로 트리를 감싼다(`src/components/ui/emotion-registry.tsx`). 캐시 키는 Chakra 기본값 `css`.
- 색상 모드는 `next-themes`(`attribute="class"`)로, `<html suppressHydrationWarning>`.
- 폰트는 npm `pretendard` 패키지의 dynamic-subset variable CSS를 루트 레이아웃에서 import한다(CDN 미사용). 숫자는 `tabular-nums`.
- `next.config.ts`: `output: 'standalone'`, `outputFileTracingRoot`를 모노레포 루트로, `typedRoutes: true`, `agentRules: false`(Next가 `AGENTS.md`/`CLAUDE.md`를 생성하지 않도록).

### 결과

- 브라우저 확인: 콘솔 오류 0, Emotion 스타일 7개 모두 `<head>`, `<body>`에는 0개. 라이트/다크 토글 정상.
- Next rewrite는 WebSocket을 프록시하지 않으므로 M4의 Socket.IO 연결 방식은 별도 결정이 필요하다(QUESTIONS.md).

---

## ADR-0010 — 모바일: 이름 있는 카탈로그 `expo`, `expo-doctor` 바이너리, 에셋 없는 CNG 스캐폴드

- 날짜: 2026-09-02
- 상태: 채택

### 맥락

Expo SDK 57은 `react 19.2.3` / `react-native 0.86.3`을 정확히 요구한다(웹은 react 19.2.8). npm latest인 RN 0.87.1은 SDK 58용이라 doctor가 실패한다. `@expo/cli` 57의 `expo doctor` 서브커맨드는 "not supported in the local CLI"로 종료된다.

### 결정

- `pnpm-workspace.yaml`의 `catalogs.expo`에 react/react-native를 두고 `apps/mobile`만 `catalog:expo`를 쓴다. pnpm 격리 설치(`nodeLinker: isolated`) 그대로 사용, `metro.config.js`/`babel.config.js` 없음.
- `expo-doctor` 1.20.4를 devDependency로 고정하고 `doctor` 스크립트로 실행한다. PLAN M0 AC의 `pnpm --filter mobile exec expo doctor`는 `pnpm --filter mobile run doctor`로 대체한다.
- `app.json`에 아이콘/스플래시를 두지 않고(`newArchEnabled`도 두지 않음 — SDK 55에서 제거), `scheme`과 placeholder 번들 ID(`app.buddha.mobile`)만 둔다. `expo-dev-client`는 plugins 항목 없이 자동 적용된다.
- `build`/`dev`/`test` 스크립트를 두지 않아 Turbo가 모바일을 해당 태스크에서 건너뛴다. `typecheck`/`lint`에는 참여한다.

### 결과

- `expo-doctor` 21/21 통과. `pnpm install`의 `unmet peer react ^19.2.8 (react-dom)` 경고는 무해하다.
- 번들 ID는 사용자 결정(2026-09-03, Q-M0-3)에 따라 iOS `bundleIdentifier`와 Android `package` 모두 `dev.sboh.buddha`로 확정했다.

---

## ADR-0011 — 테스트: Vitest 4, Nest 데코레이터는 SWC 플러그인 없이, 파일명 `*.test.ts`

- 날짜: 2026-09-02
- 상태: 채택

### 맥락

Vitest 4(Vite 8, oxc)는 tsconfig의 `experimentalDecorators`/`emitDecoratorMetadata`를 읽어 Nest DI 메타데이터를 생성한다(검증됨). Nest 템플릿은 `*.spec.ts`, 다른 영역은 `*.test.ts`를 쓴다.

### 결정

- 모든 패키지가 자체 `vitest.config.ts`를 갖고 Turbo `test` 태스크로 실행한다(루트 `projects` 설정은 캐시를 무력화하므로 사용하지 않음). `unplugin-swc`는 쓰지 않는다.
- 테스트 파일은 `*.test.ts`로 통일하고 `tsconfig.build.json`에서 제외한다. 테스트가 없는 패키지는 `passWithNoTests: true`.
- `packages/shared`만 `vitest run --coverage`로 90% 임계값을 강제하고(PLAN §14), 커버리지 출력은 `packages/shared/turbo.json`(패키지 설정)에서만 `outputs`로 선언한다.
- `@vitest/coverage-v8`은 미리 설치한다(없으면 Vitest가 대화형 설치 프롬프트로 CI를 멈춘다).

### 결과

- M0 테스트: shared 5(fast-check 속성 테스트 포함, 커버리지 100%), api 5(DI + Fastify inject), worker 7, web 3.

---

## ADR-0012 — `@types/node`는 24.x (런타임 메이저 추종)

- 날짜: 2026-09-02
- 상태: 채택

### 맥락

npm latest는 `@types/node` 26.4.1이지만 런타임은 Node 24 LTS다. 26.x는 Node 24에 없는 API를 타입으로 노출한다.

### 결정

`@types/node: 24.13.3`(24.x 최신)을 카탈로그에 고정하고, Node 메이저를 올릴 때 함께 올린다.

---

## ADR-0013 — 패키지 이름: 앱은 무접두, 라이브러리는 `@buddha/*`

- 날짜: 2026-09-02
- 상태: 채택

### 맥락

PLAN M0 AC가 `pnpm --filter mobile`을 쓴다. pnpm `--filter`는 정확한 패키지 이름을 요구한다.

### 결정

`apps/*`는 `web`, `api`, `worker`, `mobile`, `packages/*`는 `@buddha/shared`, `@buddha/db`, `@buddha/api-client`, `@buddha/config-ts`, `@buddha/config-eslint`.

---

## ADR-0014 — 로컬 인프라: 루트 `compose.yaml`이 `docker/docker-compose.yml`을 include

- 날짜: 2026-09-02
- 상태: 채택

### 맥락

PLAN §4는 컴포즈 파일을 `docker/docker-compose.yml`에 두라 하고, M0 AC는 루트에서 `docker compose up -d`를 실행한다.

### 결정

- 루트 `compose.yaml`은 `include: [docker/docker-compose.yml]`만 담는다(프로젝트 이름 `buddha` 공유). `pnpm infra:up|down|logs` 스크립트도 둔다.
- 이미지: `postgres:16.15-alpine`(롤 초기화 SQL을 `docker-entrypoint-initdb.d`로 마운트, `pg_isready -h localhost` 헬스체크), `redis:7.4.11-alpine`(`--maxmemory-policy noeviction --appendonly yes`; BullMQ 요구사항), `axllent/mailpit:v1.31.0`.
- 모든 포트는 `127.0.0.1`에만 게시한다. 개발용 자격 증명(postgres/postgres, buddha/buddha, 인증 없는 Redis, 아무 로그인이나 받는 Mailpit)이 LAN에 노출되지 않게 하기 위함이다(리뷰 반영). 컨테이너 안에서 접근해야 하는 경우가 생기면 그때 명시적으로 연다.
- CI(GitHub Actions)는 compose를 쓰지 않지만 같은 `01-roles.sql`을 `psql`로 적용한 뒤 로컬과 동일한 `buddha_app`/`buddha_migrate` 롤로 접속한다. 슈퍼유저로 테스트하면 PLAN §6.4의 권한 분리가 검증되지 않기 때문이다(리뷰 반영).
- `test` 프로필로 `postgres-test`(5433, tmpfs, fsync off)와 `redis-test`(6380)를 제공한다(PLAN §14). 기본 `up`에는 포함되지 않는다.
- 롤 설계: `buddha_migrate`가 DB 소유자(=`public` 스키마 소유자, PG15+), `buddha_app`은 CONNECT/USAGE + `ALTER DEFAULT PRIVILEGES FOR ROLE buddha_migrate`로 테이블 DML·시퀀스·함수·타입 권한을 받는다.

### 결과

- `docker compose up -d --wait`로 3개 컨테이너 healthy 확인. 초기화 SQL은 빈 볼륨에서만 실행되므로 롤 변경은 `down -v` 후 재기동이 필요하다.
- 로컬 Docker 최소 버전: `include`는 Compose 2.20.0(docker/compose v2.20.0 릴리스 노트), `docker/docker-compose.yml`의 헬스체크 `start_interval`은 스키마상 Compose 2.20.2를 요구한다(둘 다 Docker Desktop 4.22.0에 포함). `start_interval`은 Docker Engine 25(API 1.44, Desktop 4.27) 이상에서만 적용된다. Compose 2.24.0~5.0.2는 Engine 25 미만에서 하드 에러를 냈고 5.1.0에서 그 검사가 제거됐으며, 2.36.0부터는 `start_interval`에 `start_period` 동반을 요구한다(이 파일은 모든 헬스체크에 설정). Docker Desktop은 Compose 2.24 이상을 싣는 4.27부터 Engine도 25이므로 Desktop 사용자는 해당 없고, Linux에서 새 compose 플러그인을 구형 Engine과 조합한 경우만 걸린다. README 요구 사항에 "Docker Desktop 4.22 이상(Compose 2.20.2 이상)"으로 명시했다(리뷰 반영). `docker compose -f docker/docker-compose.yml`로 직접 실행해도 같은 바닥이 적용되므로 구버전 우회 수단이 아니다.

---

## ADR-0015 — API 라우팅: 글로벌 prefix `api` + URI 버저닝, `/api/health`는 버전 중립

- 날짜: 2026-09-02
- 상태: 채택

### 맥락

PLAN §7은 Base `/api/v1`, M0 AC는 `GET /api/health`를 요구한다. better-auth는 `/api/auth/*`를 쓴다.

### 결정

- `setGlobalPrefix('api')` + `enableVersioning({ type: URI, defaultVersion: '1' })`. 일반 컨트롤러는 `/api/v1/<resource>`, 헬스는 `@Controller({ path: 'health', version: VERSION_NEUTRAL })`로 `/api/health`.
- 헬스 응답 `{ status: 'ok'|'degraded', db, redis }`. 각 프로브는 2초 타임아웃, 실패 시 HTTP 503(본문 동일 형태).
- Fastify 어댑터는 `bodyParser: false`로 생성한다(M1 better-auth 요구). 이 옵션은 `@fastify/formbody` 등록만 생략하며 JSON 파싱은 유지된다.
- `trustProxy`는 환경변수 `TRUST_PROXY`(기본 `false`; `true` 또는 프록시 주소/CIDR 목록)로만 켠다. Next.js rewrite는 `X-Forwarded-For`를 붙이지 않으므로 무조건 신뢰하면 클라이언트가 자기 IP를 위조할 수 있고, PLAN §7.5의 IP별 레이트 리밋이 무력화된다(리뷰 반영). 바인드 주소는 `API_HOST`(기본 `localhost` = IPv4+IPv6 루프백, 컨테이너는 `0.0.0.0`). 웹 dev 서버(`next dev --hostname localhost`)와 로컬 standalone 실행(`scripts/start-standalone.mjs`가 `WEB_HOST`, 기본 `localhost`를 `HOSTNAME`으로 넘김)도 루프백에 바인드한다. Next 기본값은 모든 인터페이스(`::`)라 `/api/*` rewrite를 통해 이 결정이 REST에 대해 무력화됐기 때문이다(리뷰 반영). Next는 Fastify와 달리 주소 하나에만 `listen`하므로 Node 24에서는 `::1`만 열리지만 `http://localhost:3000`은 브라우저·curl·Node fetch 모두에서 동작한다. `127.0.0.1`을 쓰면 Next가 `request.url`과 리다이렉트 오리진을 `http://127.0.0.1:3000`으로 만들어 ADR-0017의 `localhost:3000` 오리진과 어긋나므로 쓰지 않는다. 다른 기기에서 웹을 열 때는 `-H 0.0.0.0`과 `allowedDevOrigins`로 명시적으로 연다.
- DB 풀과 Redis 클라이언트는 `onApplicationShutdown`에서 닫는다. Nest 12의 `close()` 순서는 `onModuleDestroy → beforeApplicationShutdown → HTTP 서버 close → onApplicationShutdown`이므로 `onModuleDestroy`에서 닫으면 처리 중인 요청이 끝난 풀을 만난다(리뷰 반영).
- `packages/db`의 풀은 `connectionTimeoutMillis`(5초)와 `query_timeout`/`statement_timeout`(30초)을 기본으로 둔다. 헬스체크의 2초 `Promise.race`는 응답 시간만 제한할 뿐 연결 시도를 취소하지 않아, 타임아웃 없이는 DB 장애 시 프로브가 풀 슬롯을 하나씩 잠식했다(리뷰에서 재현).
- `nest build`는 tsc 빌더를 쓴다(`--builder swc`는 이 ESM 프로젝트에서 CJS를 내보내 실행 불가).

### 결과

- 확인: `/api/health` 200, `/api/v1/health` 404, web rewrite 경유 200.

---

## ADR-0016 — Turbo 캐시에서 `.next/standalone` 제외 (Windows)

- 날짜: 2026-09-02
- 상태: 채택

### 맥락

첫 `pnpm build`에서 Turbo가 `apps/web/.next/standalone/node_modules/.pnpm/next@16.3.4_...` 심링크를 캐시 tar에 넣지 못했다(`provided value is too long when setting link name`). 그대로 두면 캐시 복원 시 standalone 출력이 조용히 깨진다.

### 결정

`build.outputs`에 `!.next/standalone/**`를 추가한다. standalone은 배포 아티팩트이며 CI/Docker에서 새로 빌드된다.

### 결과

- 캐시 히트 후에는 `.next/static`/`BUILD_ID`만 복원되고 standalone은 이전 빌드가 남을 수 있다. `pnpm --filter web start`(`scripts/start-standalone.mjs`)는 두 `BUILD_ID`를 비교해 불일치 시 `turbo run build --filter=web --force` 안내와 함께 종료한다(리뷰 반영).
- Windows에서 만든 standalone 출력은 pnpm 정션이 절대경로 심링크로 복사되어 빌드한 머신에서만 실행된다. 배포 아티팩트는 Linux(CI 또는 Docker 빌드 단계)에서 `next build`로 만든다.
- `web#typecheck`(`next typegen`)와 `web#build`(`next build`, `.next/types` 삭제 후 재생성)가 동시에 `.next`를 쓰면 드물게 경합하므로 `apps/web/turbo.json`에서 `typecheck`가 `build`에 의존하게 했다(리뷰 반영).
- 두 번째 `pnpm build`는 `>>> FULL TURBO`(6/6 캐시)로 완료된다.
- `scripts/start-standalone.mjs`는 `server.js`에 `HOSTNAME=${WEB_HOST:-localhost}`를 넘겨 로컬 실행을 루프백에 묶는다(standalone `server.js` 기본값은 `0.0.0.0`; 근거는 ADR-0015). 셸이 내보낸 `HOSTNAME`(RHEL 계열은 머신 이름, Docker는 컨테이너 ID)은 바인드 주소로 쓸 값이 아니므로 무시하고 `WEB_HOST`만 존중한다. 배포 이미지(아직 없음)는 이 스크립트를 거치지 않고 `HOSTNAME=0.0.0.0`으로 `server.js`를 직접 실행해야 한다(리뷰 반영).

---

## ADR-0017 — 실시간(Socket.IO) 연결 경로: API 오리진 직접 연결 + CORS

- 날짜: 2026-09-03
- 상태: 채택 (사용자 결정, QUESTIONS Q-M0-2)

### 맥락

PLAN §8/§10.1은 브라우저가 같은 출처의 `/api/*`만 쓴다고 가정하지만, Next.js rewrite는 WebSocket 업그레이드를 프록시하지 않는다(ADR-0009 결과). 선택지는 (a) 클라이언트가 API 오리진에 직접 연결 + CORS, (b) 로컬/운영 모두 리버스 프록시였다.

### 결정

- REST는 기존대로 Next rewrite(`/api/*` → API)를 경유한다(같은 출처, 쿠키·CORS 문제 없음).
- Socket.IO 클라이언트는 `NEXT_PUBLIC_API_URL`의 API 오리진에 직접 연결하며 `withCredentials: true`를 쓴다.
- API는 Socket.IO 핸드셰이크(`/ws` 네임스페이스, polling 폴백 포함)에 대해서만 CORS를 허용한다: origin은 웹 오리진(`WEB_ORIGIN` env, 로컬 `http://localhost:3000`), credentials true. REST 라우트는 rewrite로만 접근하므로 CORS를 열지 않는다.
- 세션 쿠키(SameSite=Lax)가 핸드셰이크에 실리려면 웹과 API가 같은 사이트여야 한다. 로컬은 `localhost:3000`/`localhost:4000`으로 충족되고, 운영은 `app.<도메인>`/`api.<도메인>` 형태를 전제한다. 게이트웨이 인증(PLAN §8)은 핸드셰이크 쿠키로 better-auth 세션을 조회한다.

### 결과

- M4에서 `apps/web`은 `NEXT_PUBLIC_API_URL`을 클라이언트 번들에서도 사용한다(현재는 `next.config.ts`에서만 사용). 그 시점에 `.env.example` 설명을 갱신한다.
- `TRUST_PROXY`는 계속 false(QUESTIONS A-M0-13). 리버스 프록시가 없으므로 API는 직접 연결(WS)의 클라이언트 IP는 정확히 보지만, rewrite를 거친 REST 요청의 IP는 Next 서버로 보인다. PLAN §7.5의 IP별 레이트 리밋은 M6에서 Next `proxy.ts`가 `X-Forwarded-For`를 붙이고 API가 Next 서버 주소만 신뢰하는 방식을 검토한다.
- 모바일(Expo)은 처음부터 API 오리진에 직접 연결하므로 이 결정과 자연스럽게 맞는다.
