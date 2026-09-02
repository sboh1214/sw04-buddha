# 미해결 질문 / 가정

PLAN §0.1-2에 따라, 문서에 없거나 애매한 사항을 여기에 기록한다.

- **질문**: 사용자 확인이 필요한 항목. 블로킹이면 작업을 멈추고 직접 묻는다.
- **가정**: 진행에 영향이 없어 가장 보수적인 선택으로 진행한 항목. 사용자가 다른 답을 주면 수정한다.

상태: `열림` / `답변됨(날짜)` / `철회`

---

## M0 — 스캐폴딩

### 질문 (사용자 확인 필요)

| #      | 상태 | 내용                                                                                                                                                                                                                                                                                                                              |
| ------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q-M0-1 | 열림 | **원격 저장소.** GitHub 등 원격 URL이 없어 CI 워크플로(`.github/workflows/ci.yml`)를 실제로 실행해 보지 못했다. 원격 URL을 주면 `origin` 추가 후 `main`/`m0-scaffold`를 푸시하고 CI 결과를 확인하겠다.                                                                                                                            |
| Q-M0-2 | 열림 | **실시간(M4) 연결 경로.** Next.js rewrite는 WebSocket 업그레이드를 프록시하지 않는다. PLAN §8/§10.1의 "동일 출처 `/api/*`" 가정은 Socket.IO에 적용되지 않으므로, (a) 클라이언트가 API 오리진(`:4000`)에 직접 연결(CORS + credentials) 또는 (b) 로컬/운영 모두 리버스 프록시(nginx/ALB 경로 라우팅) 중 하나를 M4 전에 정해야 한다. |
| Q-M0-3 | 열림 | **모바일 번들 ID.** `apps/mobile/app.json`의 `ios.bundleIdentifier`/`android.package`는 placeholder `app.buddha.mobile`이다. 네이티브 빌드/EAS 전에 실제 역도메인 ID가 필요하다.                                                                                                                                                  |
| Q-M0-4 | 열림 | **`@thallesp/nestjs-better-auth` 2.7.0의 peer 범위가 NestJS ^11.1.6**이다(^12 없음). M1 시작 시 Nest 12에서 로딩을 실제로 확인하고, 실패하면 PLAN §10.6 대안(`auth.handler`를 Fastify 라우트에 직접 마운트)으로 가도 되는지. (M1 착수 시 결정 요청)                                                                               |
| Q-M0-5 | 열림 | **로컬 Redis 이미지 라이선스.** `redis:7.4.11-alpine`(RSALv2/SSPLv1)을 썼다. 로컬 개발도 OSI 라이선스를 원하면 `redis:7.2.16-alpine` 또는 `valkey/valkey:8-alpine`으로 바꾸면 된다(다른 변경 없음). 운영은 PLAN대로 Valkey.                                                                                                       |

### 가정 (보수적 기본값으로 진행)

| #       | 상태 | 내용                                                                                                                                                                                                                                             |
| ------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A-M0-1  | 열림 | **AC 명령 문구.** `pnpm --filter mobile exec expo doctor`는 @expo/cli 57에서 "not supported in the local CLI"로 종료된다. `pnpm --filter mobile run doctor`(고정 버전 `expo-doctor`)로 대체했고 21/21 통과. PLAN §13 M0 AC 문구 갱신을 권장한다. |
| A-M0-2  | 열림 | **`.npmrc` 설정 무시.** pnpm 11은 `.npmrc`에서 인증/레지스트리만 읽는다. PLAN §4.2의 `strict-peer-dependencies=false`는 `pnpm-workspace.yaml`의 `strictPeerDependencies: false`로 옮겼다(ADR-0004). PLAN §4.2 갱신 권장.                         |
| A-M0-3  | 열림 | **`minimumReleaseAge` 기본값(24h) 유지.** 0으로 끄지 않고, pnpm이 자동 추가한 `minimumReleaseAgeExclude`(Expo 57 최신 패키지 13건)를 커밋했다. 이 목록은 24시간이 지나면 의미가 없어지지만 남겨도 무해하다.                                      |
| A-M0-4  | 열림 | **Next `agentRules: false`.** Next 16.2+는 `next dev` 때 `apps/web/AGENTS.md`/`CLAUDE.md`를 생성한다. 저장소에 생성 파일이 섞이고 Claude Code가 이를 컨텍스트로 읽게 되므로 비활성화했다.                                                        |
| A-M0-5  | 열림 | **`.env.example` 추가 키.** PLAN §15 외에 test 프로필용 `TEST_DATABASE_URL`, `TEST_DATABASE_MIGRATE_URL`, `TEST_REDIS_URL`과 `SMTP_FROM=noreply@buddha.local`을 추가했다.                                                                        |
| A-M0-6  | 열림 | **BullMQ 키 prefix**는 기본 `bull:`을 쓴다. `apps/api`가 M3에서 잡을 넣기 시작하면 큐/잡 이름 상수(`apps/worker/src/queues.ts`)와 `defaultJobOptions`를 `packages/shared`로 옮긴다(프로듀서 쪽에서 적용되는 옵션이기 때문).                      |
| A-M0-7  | 열림 | **Prettier 옵션.** `singleQuote: true`, `printWidth: 100`, `trailingComma: all`. PLAN에 명시가 없어 Nest/일반 관례를 따랐다.                                                                                                                     |
| A-M0-8  | 열림 | **`nestjs.json`의 `strictPropertyInitialization: false`** 는 Nest 기본값을 유지했다. zod DTO만 쓸 계획이므로 `true`로 올려도 되지만 M1에서 실제 코드가 생기면 다시 본다.                                                                         |
| A-M0-9  | 열림 | **브랜드 색.** PLAN §17 Q7대로 인디고 placeholder(Tailwind indigo 스케일), yes/no는 Chakra 기본 teal/red 스케일을 썼다.                                                                                                                          |
| A-M0-10 | 열림 | **Turbo 캐시에서 `.next/standalone` 제외**(ADR-0016). 캐시 히트 후 standalone 서버를 띄우려면 `--force` 재빌드가 필요하다.                                                                                                                       |
| A-M0-11 | 열림 | **README.md를 M0에 최소 버전으로 추가**했다(로컬 실행 절차만). PLAN은 README를 M6에 두지만, 사용자가 M0 결과를 바로 실행해 볼 수 있어야 하므로 앞당겼다. M6에서 아키텍처 다이어그램 등을 보강한다.                                               |
| A-M0-12 | 열림 | **`openapi-typescript` 7.13의 peer가 TypeScript ^5**(6 미지원 선언)이지만 실제로는 6.0.3에서 동작한다(경고만). `strictPeerDependencies`를 켜지 않는 한 문제 없음.                                                                                |
