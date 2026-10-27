// CLI entry: `node scripts/generate-api-doc.mjs`, chained onto root `pnpm api:openapi` right
// after the OpenAPI document has been re-exported. Reads apps/api/openapi.json and writes
// docs/API.md — the Korean reading copy of the contract (PLAN M6).
//
// CI runs the same `pnpm api:openapi` and then `git diff --exit-code`s apps/api/openapi.json,
// packages/api-client/src/generated AND docs/API.md, so this output is part of the contract
// check. That makes DETERMINISM the first requirement: no Date, no randomness, no ordering that
// the inputs do not already fix. The document's own order is kept everywhere it means something
// (paths in document order, error codes in PLAN 7.4 order); the one alphabetical sort is the
// schema name list, which has no meaningful order of its own.
//
// The second requirement is that it FAILS LOUDLY rather than printing something stale. Every
// table below is either read out of a source of truth or checked against one: a new error code,
// a new rate-limit bucket or a new realtime event that this file has no Korean gloss for stops
// the build here instead of quietly vanishing from the document. That is why the checks throw
// on drift in BOTH directions.
//
// No dependency but node: builtins, and no TypeScript: this runs in CI as a documentation step,
// where a build graph or an install for the doc would be one more thing that can break the
// contract check. The price is that the four TS sources it reads are parsed as TEXT — narrow
// regexes over declarations that are already prettier-formatted, each of which throws when it
// matches nothing. Parsing beats hard-coding here because a hard-coded number goes stale in
// silence, while a regex that stops matching says so on the next CI run.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OPENAPI_PATH = path.join(ROOT, 'apps', 'api', 'openapi.json');
const ERRORS_TS = path.join(ROOT, 'packages', 'shared', 'src', 'api', 'errors.ts');
const APP_ERROR_TS = path.join(ROOT, 'apps', 'api', 'src', 'common', 'errors', 'app-error.ts');
const RATE_LIMIT_TS = path.join(ROOT, 'packages', 'shared', 'src', 'rate-limit.ts');
const REALTIME_TS = path.join(ROOT, 'packages', 'shared', 'src', 'realtime.ts');
const OUTPUT_PATH = path.join(ROOT, 'docs', 'API.md');

/** Every failure carries the same prefix as the export step it runs after (`[openapi:export]`). */
function fail(message) {
  throw new Error(`[api-doc] ${message}`);
}

// =================================================================================================
// 정적 템플릿 — the prose the OpenAPI document cannot carry.
//
// Everything from here to the end of the block is hand-written Korean that is EMITTED VERBATIM.
// It is kept together, at the top, so that a future edit is obvious: the rest of this file is
// mechanical, and nothing outside this block writes a sentence into docs/API.md. Each constant
// names the source file its claims were read from, because a claim in here that nobody can trace
// back is exactly the kind that survives the code it described.
// =================================================================================================

/** Opens the file. `pnpm api:openapi` is the whole regeneration story, so it is stated first. */
const BANNER = `<!-- 이 파일은 scripts/generate-api-doc.mjs 가 생성합니다. 직접 수정하지 마세요. -->

# buddha API

\`apps/api/openapi.json\` 의 한국어 요약본이다. **직접 고치지 않는다.**
\`scripts/generate-api-doc.mjs\` 가 만들고, CI 의 \`OpenAPI contract check\` 단계가
\`pnpm api:openapi\` 를 다시 실행한 뒤 \`git diff --exit-code\` 로 검사한다 — 손으로 고친 줄은
다음 CI 에서 그대로 빨간불이 된다.

내용을 바꾸는 곳은 두 군데다.

- 오퍼레이션(경로·요약·인증·오류): 컨트롤러의 \`@ApiOperation\` / \`@ApiData\` / \`@ApiPageOf\` /
  \`@ApiErrors\` 데코레이터와 zod 스키마. 모든 오퍼레이션에 공통인 \`RATE_LIMITED\`(429) 하나만은
  \`apps/api/src/openapi/document.ts\` 의 \`addGlobalResponse\` 가 붙인다(주소 버킷은 모든 라우트에
  걸리므로). 고친 뒤 \`pnpm api:openapi\` 를 실행한다.
- 문서의 문장(개요·인증·헬스체크·better-auth·레이트 리밋·실시간 절):
  \`scripts/generate-api-doc.mjs\`
  맨 위의 템플릿 상수.`;

/**
 * 개요. Read from packages/shared/src/api/{envelope,pagination,coin-amount}.ts, the document's own
 * `info.description`, apps/api/src/main.ts's prefix/versioning (mirrored in openapi-export.ts),
 * apps/api/src/openapi/document.ts (operationIdFactory) and apps/web/next.config.ts (the rewrite).
 */
const OVERVIEW = `## 개요

- **기본 경로** — 이 문서에 실린 모든 오퍼레이션은 \`/api/v1\` 아래에 있다(전역 prefix \`api\` +
  URI 버저닝, 기본 버전 1). 버전 접두어가 없는 두 표면은 OpenAPI 문서 밖이라 아래에 손으로 적었다:
  헬스체크(\`/api/health\`, \`/api/health/live\`)와 \`/api/auth/*\`(better-auth).
  문서에 \`servers\` 가 없으므로 경로는 API 오리진 기준 상대 경로다. 브라우저는 Next.js
  rewrite(\`/api/:path*\` → \`NEXT_PUBLIC_API_URL\`)를 거쳐 같은 오리진으로 호출한다.
- **성공 봉투** — 단일 리소스는 \`{ "data": ... }\`, 커서 목록은
  \`{ "data": [...], "meta": { "nextCursor": ... } }\`.
- **실패 봉투** — \`{ "error": { "code": ..., "message": ..., "details"?: ... } }\`. \`details\` 는
  값이 없으면 키 자체가 없다(\`undefined\` 로 넣지 않는다). \`VALIDATION_ERROR\` 의 \`details\` 는
  \`{ path, message }\` 배열(\`ValidationIssue\`)이다. \`message\` 는 개발자용 영어 문자열이고,
  사용자에게 보여 줄 한국어 문구는 웹이 \`code\` 로 고른다.
- **커서 페이지네이션** — \`?cursor=&limit=\`. \`limit\` 은 기본 20, 최대 100. 다음 페이지는
  \`meta.nextCursor\` 를 \`cursor\` 로 다시 넘겨 요청하고, \`nextCursor\` 가 \`null\` 이면 마지막
  페이지다. 커서는 불투명한 문자열이니 클라이언트가 해석하지 않는다(내부적으로는
  \`(created_at DESC, id DESC)\` 키셋이다).
- **시각** — 모든 타임스탬프는 ISO 8601 UTC 문자열이다. 정밀도는 밀리초 — timestamptz 컬럼이
  전부 \`timestamp(3)\` 이다.
- **Coin 금액** — 10진 정수 문자열이다(\`"12500"\`, \`"-300"\`). JSON number 는 IEEE double 이라
  Postgres bigint 를 정확히 담지 못해서, Coin 금액은 요청·응답 양방향 모두 문자열로 오간다.
  요청 본문의 Coin 금액은 부호 1자 + \`MAX_COIN_AMOUNT\`(10^15)의 16자리 = 17자까지만 받는다(그보다
  긴 문자열은 파싱하기 전에 거절한다: 백만 자리 \`BigInt()\` 는 요청 스레드에서 실제로 CPU 를 쓴다).
- **본문 형식** — 요청·응답 모두 \`application/json\` 이다.
  \`application/x-www-form-urlencoded\` 파서는 꺼져 있다(HTML 폼이 바로 CSRF 의 모양이다).
- **operationId** — 오퍼레이션마다 \`@ApiOperation({ operationId })\` 로 명시한다. 명시하지 않은
  오퍼레이션만 컨트롤러의 메서드 이름을 쓴다(\`openapi/document.ts\` 의 \`operationIdFactory\`).`;

/** 인증. Read from openapi/document.ts, auth/session.guard.ts and auth/admin.guard.ts. */
const AUTH_NOTES = `- 아래 표의 \`인증\` 칸이 \`🔒\` 인 오퍼레이션은 이 쿠키를 요구한다. \`—\` 는 공개 라우트다.
- 쿠키가 없거나 만료되었으면 \`401 UNAUTHENTICATED\`.
- \`/api/v1/admin/*\` 는 쿠키에 더해 \`profiles.role = 'admin'\` 을 요구한다(\`AdminGuard\`). 아니면
  \`403 FORBIDDEN\`. 역할 캐시(60초)는 거절에만 쓰고, 관리자라는 답은 요청마다 Postgres에서 읽는다.
  운영 기록(원장 감사 실패, 출시 설정 변경 기록, 관리자 권한 변경 이력)도 모두 이 아래에 있다.
  관리자 권한의 부여·회수는 다음 요청부터 적용되고, 회수는 그 계정의 세션을 모두 지운다(#171).
- 상태를 바꾸는 요청(GET·HEAD·OPTIONS 외)은 \`Origin\` 헤더가 신뢰 목록(\`WEB_ORIGIN\`,
  \`BETTER_AUTH_URL\`)에 없으면 \`403 FORBIDDEN\` 이다(\`SessionGuard\` 의 CSRF 검사). 헤더가 아예
  없는 요청은 브라우저가 보낸 것이 아니므로 통과한다(curl, 서버 간 호출, 테스트).
- 쿠키를 **만드는** 쪽(로그인·로그아웃·소셜 연결)은 이 REST 표면이 아니라 아래 \`/api/auth/*\` 다.`;

/** 헬스체크. Read from apps/api/src/health/health.controller.ts. */
const HEALTH_SECTION = `## 헬스체크 (문서 밖)

\`@ApiExcludeController()\` 라 OpenAPI 문서에 없다(클라이언트 계약이 아니라 인프라가 읽는 표면이다).
버전 접두어가 없고(\`VERSION_NEUTRAL\`), PLAN 7 봉투로 감싸지 않으며(ADR-0015 의 본문 모양),
레이트 리밋에서도 면제된다 — 자기를 방어하는 중인 인스턴스가 프로브에 429 를 답하면
오케스트레이터는 그것을 "재시작하라"로 읽는다.

| 메서드 | 경로 | 뜻 |
| --- | --- | --- |
| GET | \`/api/health\` | 레디니스: 이 API 가 요청을 처리하는 데 필요한 의존성 상태 |
| GET | \`/api/health/live\` | 라이브니스: 프로세스가 살아 있는지. 아무것도 프로브하지 않는다 |

\`GET /api/health\` 의 본문:

\`\`\`json
{
  "status": "ok",
  "db": "ok",
  "redis": "ok",
  "uptimeSeconds": 1234,
  "checks": {
    "db": { "status": "ok", "latencyMs": 3 },
    "redis": { "status": "ok", "latencyMs": 1 }
  }
}
\`\`\`

- \`db\` 와 \`redis\` 는 각각 \`"ok"\` 또는 \`"error"\`. 둘 다 \`"ok"\` 면 \`status\` 는 \`"ok"\` 이고
  HTTP 200, 하나라도 실패하면 \`status\` 는 \`"degraded"\` 이고 **HTTP 503(본문 모양은 동일)**.
- \`db\`·\`redis\` 는 M0 부터의 계약이라 평평한 자리에 그대로 두고, \`checks\` 가 프로브별 지연을
  더한다. 실패 이유는 로그에만 남는다 — 이 엔드포인트는 인증이 없고, 드라이버 오류 문구는 호스트·
  포트·롤·DB 이름을 담는다.
- 프로브 하나당 상한은 2초다(\`PROBE_TIMEOUT_MS\`). \`latencyMs\` 는 실제로 걸린 시간이므로, 타임아웃이면 그 상한에 가까운 값이 된다.
- \`GET /api/health/live\` 는 \`{ "status": "ok", "uptimeSeconds": 1234 }\` 만 답한다. 200 말고 다른
  답이 없는 것이 요점이다: 레디니스에 라이브니스 프로브를 물리면 Redis 가 한 번 흔들렸다는 이유로
  컨테이너가 재시작되고, 그 인스턴스가 들고 있던 소켓이 전부 끊긴다.`;

/**
 * /api/auth/*. Read from apps/api/src/auth/auth.ts, auth/auth.module.ts, the better-auth 1.7.2
 * route table (dist 의 `createAuthEndpoint` 선언) and the web call sites under apps/web/src.
 */
const BETTER_AUTH_SECTION = `## \`/api/auth/*\` — better-auth (문서 밖)

better-auth 인스턴스가 \`/api/auth\` 에 통째로 마운트된다(PLAN 10.1). @fastify/middie 미들웨어로
Nest 라우팅·전역 prefix·버저닝·본문 파싱보다 **먼저** 실행되므로 OpenAPI 문서에 나타나지 않고,
\`/api/v1/auth/*\` 로는 닿지 않는다(그쪽에 있는 Nest 라우트는 \`POST /api/v1/auth/register\` 하나뿐이다).

**오류 모양이 다르다.** 이 표면의 실패는 PLAN 7 봉투가 아니라 better-auth 의
\`{ "code": ..., "message": ... }\` 이다(HTTP 상태는 그대로). 웹은 \`code\` 를 문자열로 비교해
한국어 문구를 고른다(\`INVALID_EMAIL_OR_PASSWORD\`, \`EMAIL_NOT_VERIFIED\`,
\`FAILED_TO_UNLINK_LAST_ACCOUNT\` 등).

이 저장소가 실제로 쓰는 경로:

| 메서드 | 경로 | 쓰임 |
| --- | --- | --- |
| POST | \`/api/auth/sign-in/email\` | 이메일+비밀번호 로그인. 미인증 계정은 \`EMAIL_NOT_VERIFIED\` |
| POST | \`/api/auth/sign-in/social\` | google·kakao·naver OAuth 시작(브라우저 리디렉트) |
| GET·POST | \`/api/auth/callback/:id\` | OAuth 공급자 콜백. 실패는 \`?error=\` 로 웹에 되돌아온다 |
| POST | \`/api/auth/sign-out\` | 로그아웃 |
| GET | \`/api/auth/get-session\` | 현재 세션 조회(웹의 \`useSession\`) |
| POST | \`/api/auth/send-verification-email\` | 인증 메일 재발송 |
| GET | \`/api/auth/verify-email\` | 메일 링크. 성공하면 자동 로그인 후 \`callbackURL\` 로 리디렉트 |
| POST | \`/api/auth/request-password-reset\` | 비밀번호 재설정 메일 요청 |
| GET | \`/api/auth/reset-password/:token\` | 재설정 메일 링크 → \`callbackURL\` 로 리디렉트 |
| POST | \`/api/auth/reset-password\` | 토큰으로 새 비밀번호 설정 |
| POST | \`/api/auth/change-password\` | 현재 비밀번호를 알고 바꾸기 |
| POST | \`/api/auth/change-email\` | 주소 변경(확인 메일 → 새 주소 인증까지 끝나야 반영) |
| GET | \`/api/auth/list-accounts\` | 연결된 로그인 수단 목록 |
| POST | \`/api/auth/link-social\` | 소셜 계정 연결 |
| POST | \`/api/auth/unlink-account\` | 연결 해제. 마지막 하나는 \`FAILED_TO_UNLINK_LAST_ACCOUNT\` |

**꺼져 있는 경로**

- \`POST /api/auth/sign-up/email\` — \`disabledPaths\` 로 막혀 HTTP 로는 **404** 다. 가입 표면은
  \`POST /api/v1/auth/register\` 하나뿐이어야 하기 때문이다(ADR-0024): better-auth 의 가입은 아무
  주소에나 비밀번호를 먼저 심을 수 있어서, 공격자가 피해자 주소로 가입해 두고 피해자가 우리 인증
  메일을 누르면 그 비밀번호가 피해자 계정의 것이 된다. 서버 안에서 호출하는
  \`auth.api.signUpEmail\` 은 계속 동작한다(\`disabledPaths\` 는 HTTP 라우터에서만 검사된다).
- \`POST /api/auth/update-user\` — \`disabledPaths\` 로 막혀 HTTP 로는 **404** 다. 그 경로가 쓰는 것은
  better-auth 의 이름(\`user.name\`)과 사진(\`user.image\`)뿐인데 이 서비스는 그 둘을 두지 않는다
  (회원의 이름은 닉네임, \`PATCH /api/v1/me\`). 서버 안의 \`auth.api.updateUser\` 는 남지만 데이터베이스
  훅이 두 칸을 그대로 둔다(ADR-0072 7-30·7-31, 오너 결정 2026-10-19 (2차) 3).
- \`GET /api/auth/account-info\` — \`disabledPaths\` 로 막혀 HTTP 로는 **404** 다. 그 답은 연결한 소셜
  로그인 제공자의 프로필(이름·사진)인데, 이 서비스는 제공자에게 그것을 묻지도(구글은 \`openid\`·\`email\`,
  카카오는 \`account_email\` 만) 그것을 담은 제공자의 ID 토큰을 두지도 않는다(ADR-0072 7-30·7-31·7-40).
- \`POST /api/auth/get-access-token\`·\`POST /api/auth/refresh-token\` — \`disabledPaths\` 로 막혀 HTTP
  로는 **404** 다. 둘은 세션 계정에 연결한 소셜 로그인 제공자의 접근 토큰을(뒤의 것은 저장한 갱신
  토큰으로 새로 받아) 내주는데, 이 서비스는 제공자의 접근·갱신 토큰을 두지 않는다 — 로그인과 연결은
  콜백이 받은 토큰으로 제공자에게 묻고 저장하지 않는다(ADR-0072 7-30·7-31, 오너 결정 2026-10-19 (4차) 1).
- 최초 비밀번호 설정에는 대응하는 HTTP 경로가 없다. better-auth 의 \`setPassword\` 는 서버 전용
  엔드포인트라, 이 저장소는 \`POST /api/v1/me/password\` 로 감싸 노출한다. 본문은
  \`newPassword\` 와 화면이 보는 계정 \`expectedAccountId\` 이고, 그것이 쿠키의 계정이 아니면
  아무것도 바꾸지 않고 \`403 FORBIDDEN\`(\`details\` 가 그 필드를 지목한다)이다 — 본인확인의
  \`POST /api/v1/me/phone-verification/*\` 와 실명의 \`PUT /api/v1/me/real-name\` 도 같다(ADR-0043 추기,
  ADR-0070).

**공통 규칙**

- 합성 주소(\`@noemail.buddha.local\`)는 주소를 입력받는 모든 경로에서 거절된다
  (\`INVALID_EMAIL\`). Kakao·Naver 가 이메일을 주지 않았을 때 서버가 붙이는 주소이므로, 남이 먼저
  차지할 수 있으면 안 된다.
- 레이트 리밋은 세 겹이다 — 메일을 보내는 경로는 아래 \`email\` 버킷, \`/sign-in/email\` 은
  \`signIn\` 버킷, 그리고 이 표면 **전체**가 \`/api/v1/*\` 와 같은 \`default\`(주소) 버킷에도
  들어간다. 앞의 둘이 거절할 때의 429 는 헤더가 아니라 본문에 초를 담는다:
  \`{ "code": "RATE_LIMITED", "message": ..., "retryAfterSeconds": N }\`(주소 버킷의 거절은
  \`Retry-After\` 헤더도 함께 보낸다). better-auth 내장 리미터는
  꺼져 있다(프로세스 메모리에 상태를 두고 IP 로 세는데, Next rewrite 뒤에서는 모든 방문자가 소켓
  하나다).
- CSRF 는 better-auth 자신의 \`Origin\` 검사가 담당한다(\`disableOriginCheck: false\`).`;

/** 레이트 리밋 산문. Read from apps/api/src/rate-limit/* and packages/shared/src/rate-limit.ts. */
const RATE_LIMIT_NOTES = `- **버킷을 지목한 라우트는 두 번 세어진다.** \`@RateLimit('<bucket>')\` 이 붙어도 기본 100/분 의
  주소 상한은 그대로 걸리고, 그 위에 그 버킷의 한도가 더해진다. 먼저 닿는 쪽이 거절한다. 지목한
  버킷이 기본값보다 언제나 엄격하므로, 한 호출자가 한 계정으로 부르는 동안은 대개 그쪽이 먼저 닿는다.
- **헤더** — 계수된 응답에는 주소 버킷의 \`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\`,
  \`X-RateLimit-Reset\` 이 붙는다. 버킷을 지목한 라우트는 같은 이름에 \`-route\` 가 붙은 세 개를
  더 받는다. 거절될 때는 \`Retry-After\`(초)가 더 붙고 — 어느 버킷이 거절했든 접미사 없이 —,
  본문은 PLAN 7 봉투의 \`RATE_LIMITED\` 이며 \`details.retryAfterSeconds\` 에 같은 숫자가 들어 있다.
- **\`ip\` 스코프는 API 전체가 한 통이고, 파싱과 핸들러보다 앞에서 센다.** PLAN 7.5 의 기본값은
  주소당으로 쓰여 있으므로 경로별로 나누면 한 호출자가 경로 수만큼 100번을 쓸 수 있다. 세는 곳은
  Fastify 의 \`onRequest\` 훅이라 핸들러에 닿지 못하는 요청 — 파싱할 수 없는 본문(400), \`bodyLimit\`
  초과(413), 라우트 없는 경로(404) — 도 센다(라우터가 훅 이전에 직접 답하는 둘, 해독할 수 없는
  경로 400 과 \`maxParamLength\` 초과 414 만 예외다). 클라이언트를 지목할 수 없는 피어는 아예
  계수하지 않는다 — 거절이 아니라 무계수다: 루프백과, \`RATE_LIMIT_UNCOUNTED_PEERS\` 가 지목한
  프록시(다른 호스트의 웹 서버).
- **키는 해시로 저장한다.** 계정 id 는 사람을 지목하고 이메일은 개인정보인데, 리미터가 그것을
  \`KEYS rl:*\` 로 읽히는 자리에 둘 이유가 없다.
- **면제** — \`/api/health\`, \`/api/health/live\`(주소 리미터 훅의 \`UNCOUNTED_ROUTES\`; 지목한 버킷은 없다).
- **Redis 가 죽으면 열린다**(fail-open). 리미터 때문에 API 전체가 멈추지는 않는다.
- **Socket.IO 는 따로 센다** — 아래 실시간 절 참고.`;

/** 실시간. Read from packages/shared/src/realtime.ts and apps/api/src/realtime/market.gateway.ts. */
const REALTIME_NOTES = `연결은 Socket.IO 네임스페이스 하나다. 핸드셰이크에서 세션 쿠키를 읽어 로그인 상태면
\`user:<userId>\` 룸에 자동으로 들어간다(페이로드로 사용자 룸을 고를 수 있는 표면은 없다).
로그인하지 않은 소켓도 붙을 수 있고, 공개 이벤트만 받는다.

**룸**

- \`market:<marketId>\` — 공개. 클라이언트가 \`subscribe\` 로 직접 들어간다.
- \`user:<userId>\` — 비공개. 핸드셰이크의 세션에서만 정해진다.

**클라이언트 → 서버**

- \`subscribe\` / \`unsubscribe\`, 페이로드는 \`{ "marketIds": ["<uuid>", ...] }\`.
- 메시지 하나가 담을 수 있는 id 수와 소켓 하나가 들고 있을 수 있는 룸 수는 다르다(아래 표).
  룸 상한이 더 크므로, 그보다 많은 id 를 가진 화면은 메시지 상한 크기로 잘라서 보내야 한다.
  게이트웨이는 페이로드 전체를 검증한 뒤에 룸에 넣기 때문에, 한 번에 너무 많이 보낸 메시지는
  통째로 거절되고 룸에는 하나도 들어가지 않는다.
- 거절은 \`exception\` 이벤트로 돌아온다. 본문은 REST 와 같은
  \`{ "error": { "code", "message", "details"? } }\` 봉투다(프로토콜에 ack 이 없다).

**서버 → 클라이언트**

이벤트 이름이 곧 \`type\` 필드다.`;

/** 실시간 이벤트별 한국어 설명. Keys must cover REALTIME_EVENT_TYPES, or the generator fails. */
const REALTIME_EVENTS = {
  'market:tick': {
    room: '`market:<id>`',
    note: '체결 후의 가격·통계. 지금은 체결 경로가 없어 발행되지 않는다',
    key: '`tradeCount`',
  },
  'market:trade': {
    room: '`market:<id>`',
    note: '익명 체결 1건. 지금은 체결 경로가 없어 발행되지 않는다',
    key: '`fillId`',
  },
  'market:status': {
    room: '`market:<id>`',
    note: '상태 전이(개장·마감·판정·정산 완료). 설명만 고친 편집도 같은 상태로 다시 발행된다',
    key: '`statusEventId`',
  },
  'user:balance': {
    room: '`user:<id>`',
    note: '충전·환불·정산 지급·시작 지급(#70) 후의 잔고',
    key: '`ledgerEntryId`',
  },
  'user:position': { room: '`user:<id>`', note: '변경된 포지션 1행', key: '`version`' },
};

/** 실시간 절의 꼬리말. `supersedes` / `statusSupersedes` 의 계약을 그대로 옮긴 것. */
const REALTIME_ORDERING = `이벤트는 커밋 순서대로 도착하지 않을 수 있고(인스턴스 두 대, 늦게 흘러나온 Redis 큐),
밀리초 \`ts\` 는 동점이 날 수 있다. 그래서 다시 바뀔 수 있는 엔티티의 이벤트는 위 표의 **순서 키**를
싣는다. 클라이언트는 들고 있는 값보다 큰 키만 받아들이고(\`supersedes\`), 같거나 작으면 중복이거나
늦은 것이므로 버린다. 키는 같은 이벤트 종류 안에서만 비교한다 — 서로 다른 시퀀스에서 나온 숫자다.

그 밖에 게이트웨이만 보내는 이벤트가 둘 있다.

- \`realtime:resync\` — Redis 구독이 끊겼다가 다시 걸렸다는 신호(페이로드 없음). 그 사이의 이벤트는
  사라졌으므로 클라이언트는 REST 스냅샷을 다시 받아야 한다.
- \`exception\` — 위의 거절 봉투.

\`market:tick\` 만 volatile 로 보낸다: 다음 틱이 곧바로 덮어쓰는 스냅샷이라, 전송이 밀린 클라이언트는
하나쯤 잃어도 된다. 나머지는 사실(fact)이라 반드시 도착해야 한다.`;

/** 태그 → 한국어 이름. 없는 태그는 이름 그대로 쓴다(새 태그가 빌드를 깨지는 않게). */
const TAG_LABELS = {
  auth: '가입',
  me: '내 계정',
  wallet: '지갑·결제',
  admin: '관리자',
  markets: '시장·시세',
  trades: '거래·포지션',
  watchlist: '관심 시장',
  'search-history': '최근 검색',
};

/**
 * 오류 코드별 한국어 뜻. 코드 목록과 HTTP 상태는 소스에서 읽으므로 여기에 없고, 여기 없는 코드가
 * 소스에 생기면 생성기가 멈춘다.
 */
const ERROR_NOTES = {
  UNAUTHENTICATED: '세션 쿠키가 없거나 만료되었다. 로그인이 필요하다.',
  FORBIDDEN:
    '로그인은 했지만 권한이 없다. 관리자 전용 라우트, 교차 출처 요청 거부, 남의 계정을 지목한 본문이 여기에 들어간다.',
  NOT_FOUND: '대상이 없다. 공개에 보이지 않는 초안(draft) 시장도 여기로 답한다.',
  VALIDATION_ERROR: '요청이 스키마에 맞지 않는다. `details` 에 `{ path, message }` 배열이 붙는다.',
  MARKET_NOT_OPEN: '시장이 `open` 이 아니라 그 동작을 할 수 없다.',
  INSUFFICIENT_BALANCE: '잔고가 모자란다.',
  PRICE_MOVED:
    '화면이 보여 준 충전 상품의 조건(`expectedAmountCoin`·`expectedPriceKrw`)이 지금 판매하는 조건과 다르다.',
  DUPLICATE_REQUEST:
    '이미 쓴 멱등 키를 다른 조건으로 다시 썼거나(키는 소모된다), 한 번만 할 수 있는 일을 두 번 했다(쿠폰 재사용). 환불 재시도는 앞선 시도가 아직 PG 의 답을 기다리는 동안 이것으로 답한다(`details[0].message` 가 `in progress`).',
  RATE_LIMITED: '레이트 리밋 초과. `details.retryAfterSeconds` 와 `Retry-After` 헤더에 대기 초.',
  RULES_REQUIRED: '정산 규칙(`rules`)이 비어 있어 개장하거나 그대로 저장할 수 없다.',
  VERIFICATION_REQUIRED:
    '본인확인(휴대전화 SMS 인증번호)을 마치지 않은 계정이다. `POST /api/v1/me/phone-verification/code` 로 인증번호를 받아 `POST /api/v1/me/phone-verification/confirm` 으로 확인한 뒤 다시 시도한다(ADR-0070).',
  REFUND_NOT_ALLOWED:
    '환불 정책 밖의 결제다. `details[0].message` 가 까닭을 말한다 — `window_closed`(승인 후 7일이 지났다), `status`(환불할 수 있는 상태가 아니다), `provider`(그 결제 수단은 취소를 지원하지 않는다). 이미 쓴 Coin 이 있으면 `INSUFFICIENT_BALANCE` 로 답한다.',
  PAYMENT_GATEWAY_REFUSED:
    'PG 가 요청을 거절했다. `details[0].message` 에 PG 의 `<결과 코드> <메시지>` 가 붙는다. 환불이면 회수했던 Coin 을 되돌려 놓았다. 단 환불 **재시도**가 거절되면 첫 시도가 이미 카드를 취소했을 수 있어 Coin 을 되돌리지 않고 `refunding` 으로 둔다 — 첫 시도라도 PG 의 답을 기다리는 사이 재시도가 결제를 넘겨받았으면 마찬가지다(그 재시도가 정한다). 거절됐어도 그사이 다른 시도가 환불을 끝냈으면 오류가 아니라 `refunded` 로 마친 결제로 답한다.',
  PAYMENT_GATEWAY_ERROR:
    'PG 에 닿지 못했거나 결과를 알 수 없다(502). 다른 5xx 처럼 본문에 내부 사정을 담지 않는다. 환불이면 `refunding` 으로 남으니 다시 시도한다. 단 그사이 다른 시도가 환불을 끝냈으면 오류가 아니라 `refunded` 로 마친 결제로 답한다.',
  ROLE_CHANGE_NOT_ALLOWED:
    '관리자 권한 부여·회수의 규칙에 맞지 않는다. `details[0].message` 가 까닭을 말한다 — 부여는 `already_admin`(이미 관리자다), `email_not_verified`(이메일 인증을 마치지 않았다), `phone_not_verified`(휴대전화 본인확인을 마치지 않았다), 회수는 `not_admin`(관리자가 아니다), `min_admins`(회수하면 관리자가 2명 미만이 된다. 자기 회수도 같다).',
  APPROVAL_NOT_ALLOWED:
    '2인 통제 요청의 결정(승인·거절)을 받지 않는다. `details[0].message` 가 까닭을 말한다 — `requester`(요청한 계정은 자기 요청을 결정할 수 없다. 어느 환경에서도 예외가 없다), `decided`(이미 결정된 요청이다). 이 규칙을 쓰는 라우트가 이 코드를 문서화한다.',
  PHONE_VERIFICATION_NOT_ALLOWED:
    '본인확인을 받지 않는다. `details.reason` 이 까닭을 말한다 — `already_verified`(이미 본인확인을 마쳤다), `phone_in_use`(그 번호는 다른 계정이 본인확인한 번호다. 한 번호에 한 계정, 맞는 인증번호를 확인한 뒤에만 알린다).',
  PHONE_VERIFICATION_LIMITED:
    '인증번호를 보내지 않았다. `details.reason` 이 걸린 한도를, `details.retryAfterSeconds` 가 같은 요청이 그 한도를 지나는 때까지의 초를 말한다(여럿이면 가장 오래 걸리는 것) — `resend_interval`(그 계정의 앞선 발송 뒤 60초가 지나지 않았다), 직전 24시간의 `account_daily`(그 계정이 10번 받았다), `account_phone_daily`(그 계정이 그 번호로 10번 받았다), `phone_accounts`(그 번호로 다른 계정 3개가 받았다), `ip_daily`(같은 접속 주소(IP)의 요청으로 50번 보냈다. 클라이언트를 가리키지 못하는 접속 — 루프백, 웹 서버의 rewrite — 은 세지 않는다), `service_daily`(서비스 전체가 500건 보냈다). 그 계정만의 한도(`resend_interval`·`account_daily`·`account_phone_daily`)는 초까지 정확하고, 다른 계정의 발송과 함께 세는 한도(`phone_accounts`·`ip_daily`·`service_daily`)는 서버 시계의 분 단위로 올려 60의 배수로 답하고 그 분까지 닫혀 있다 — 한도째 발송이 24시간이 된 뒤의 첫 정각 분에 열리므로 남의 발송 시각을 답으로도 통과로도 초까지 알리지 않는다. 기다림은 요청이 든 분의 시작부터 세므로, 답을 받은 때부터 기다리면 그 한도가 열린 때이거나 1분 안으로 뒤다.',
  VERIFICATION_CODE_REJECTED:
    '본인확인이 되지 않았다. `details.reason` 이 까닭을 말한다 — `no_code`(기다리는 인증번호가 없다: 받지 않았거나 이미 썼다), `expired`(3분이 지났다), `attempts_exceeded`(틀린 입력이 5번이 되어 그 인증번호를 버렸다. 새로 받아야 한다), `superseded`(다시 받기 전의 인증번호다. 새 인증번호를 넣어야 하고, 틀린 입력으로 세지 않는다), `mismatch`(틀렸다. `details.remainingAttempts` 가 남은 입력 수다). 계정의 가장 최근 인증번호만 확인한다.',
  SMS_SEND_FAILED:
    'SMS 사업자가 인증번호 문자를 받지 않은 것이 확실하다(502: 거절, 요청이 나가기 전의 연결 실패). 이 발송은 세지 않고 이 요청이 남긴 인증번호도 없다. 앞서 받은 인증번호는 3분 안이고 버려지지 않았으면 그대로 확인할 수 있다(그것이 다시 가장 최근 인증번호다). 다른 5xx 처럼 본문에 내부 사정을 담지 않는다.',
  SMS_SEND_UNCONFIRMED:
    'SMS 사업자의 답을 받지 못했다(502: 시간 초과, 요청이 나간 뒤 끊긴 연결, 5xx, 읽을 수 없는 답). 문자가 갔을 수 있으므로 발송으로 세고(60초 간격과 하루 한도) 그 인증번호는 확인할 수 있다. 5xx 본문은 `details` 를 싣지 않으므로 코드로 `SMS_SEND_FAILED` 와 가린다.',
  ONBOARDING_REQUIRED:
    '그 동작에 필요한 온보딩 단계를 마치지 않은 계정이다(#58). `details.steps` 가 마치지 않은 단계를 순서대로 말한다 — `consent`(약관 동의, `POST /api/v1/me/consents`), `verification`(휴대전화 본인확인), `nickname`(닉네임 설정, `POST /api/v1/me/onboarding/nickname`). 본인확인 인증번호 요청은 약관 동의만 요구하고, 닉네임 설정은 약관 동의와 본인확인을, 온보딩을 마친 계정만 하는 동작(관심 카테고리, 모든 관리자 API, 이후의 글·좋아요·신고·제안·주문)은 세 단계를 모두 요구한다. 관리자 API는 관리자 권한을 먼저 보므로 관리자가 아닌 계정에는 `FORBIDDEN` 이다. 권리를 바꾸는 약관 개정 뒤에는 다시 동의할 때까지 `consent` 가 남는다.',
  NICKNAME_NOT_ALLOWED:
    '닉네임 규칙에 맞지 않는다(#58). `details.reason` 이 까닭을 말한다 — `auto_prefix`(직접 입력한 닉네임이 자동 닉네임의 `user_` 로 시작한다. 대소문자 무관), `reserved_word`(운영자를 사칭하는 낱말이 들어 있다. 대소문자 무관, 밑줄을 빼고 견준다), `taken`(다른 계정이 대소문자만 다른 닉네임까지 포함해 쓰고 있거나, 다른 계정이 비운 지 30일이 지나지 않았다), `change_interval`(마지막 변경 뒤 30일이 지나지 않았다. `details.nextChangeAt` 이 다음 변경이 되는 시각), `already_set`(온보딩의 닉네임 설정을 이미 마쳤다. 바꾸려면 `PATCH /api/v1/me`).',
  INTERNAL: '그 밖의 서버 오류. 본문에 내부 사정을 담지 않는다.',
};

/** 레이트 리밋 버킷별 적용 라우트. 버킷 목록·스코프·한도는 소스에서 읽는다. */
const RATE_LIMIT_ROUTES = {
  default:
    '모든 HTTP 라우트. 아래 버킷을 지목한 라우트도 여기에 함께 들어간다(주소 하나당 API 전체 합산).',
  charge: '`POST /api/v1/payments/charge`',
  coupon: '`POST /api/v1/coupons/redeem`',
  searchHistory:
    '`POST /api/v1/me/search-history`(제출한 검색어 기록). 기록마다 남는 행이라(보관 기간 없음) 계정마다 센다. 웹은 거절된 기록을 버리고 검색은 그대로 간다.',
  phoneVerification:
    '`POST /api/v1/me/phone-verification/code`(본인확인 인증번호 요청). 계정마다 센다. 발송 수 자체는 이 버킷이 아니라 DB 의 고정 한도(60초 간격, 계정·번호마다 24시간 10번, `PHONE_VERIFICATION_LIMITED`)가 막고, 이 버킷은 그 한도에 거절당할 요청을 스크립트가 쏟아 내는 속도를 막는다.',
  consent:
    '`POST /api/v1/me/consents`(약관 동의와 MY 설정의 마케팅 정보 수신 켜고 끄기). 계정마다 센다. 바뀐 답마다 고치지 못하고 보존기간 동안 남는 동의 기록 행이 쌓이므로(선택 항목인 마케팅 정보 수신은 MY 설정에서 몇 번이든 켜고 끌 수 있다), 주소 버킷만으로는 한 계정이 보낼 주소가 있는 만큼 기록을 늘릴 수 있다. 동의 단계는 한 번(개정 뒤 다시 묻는 때에 한 번 더) 보내고, MY 설정의 마케팅 스위치는 바꿀 때마다 한 번 보낸다.',
  email:
    '메일을 보내는 경로 — `POST /api/v1/auth/register` 와 `/api/auth/*` 의 `/change-email`, `/send-verification-email`, `/request-password-reset`, `/forget-password`. 시도 자체를 센다(시도가 곧 피해다). `/change-email` 만은 **로그인한 요청만** 센다(세션 없는 요청은 401 이고 아무에게도 메일이 가지 않으므로): 먼저 **요청한 계정**의 버킷을, 그다음 `newEmail` 의 버킷을 — 인증된 계정의 확인 메일은 본문의 주소가 아니라 계정이 이미 가진 주소로 가고, 계정을 먼저 세야 한 계정이 1분에 다섯 주소까지만 지목할 수 있기 때문이다. `GET /verify-email` 도 링크가 메일을 보내는 종류(이메일 변경의 **확인** 링크: 누를 때마다 새 주소에 다시 보낸다)이면 그 수신 주소로 센다 — 토큰은 1시간짜리 무상태 JWT 라 누른다고 소모되지 않기 때문이다. 서명이 유효한 토큰만 세고, 변경을 적용하는 **검증** 링크는 메일을 보내지 않으므로 세지 않는다.',
  signIn:
    '`/api/auth/sign-in/email`. 시도를 세되 **성공한 로그인이 버킷을 지운다** — 비밀번호가 맞은 로그인은 공격이 아니고, 그것까지 남기면 공유 계정이 쓰이는 것만으로 스스로 잠긴다. `/api/auth/*` 전체는 이와 별도로 `default`(주소) 버킷에도 들어간다.',
};

/** 레이트 리밋 스코프의 뜻(`RateLimitScope`). */
const RATE_LIMIT_SCOPES = {
  ip: '클라이언트 주소 (API 전체에 하나)',
  user: '로그인 계정 (라우트별)',
  email: '본문이 지목한 이메일 주소 (라우트별)',
};

// =================================================================================================
// 정적 템플릿 끝. 아래는 전부 기계적이다.
// =================================================================================================

/**
 * `HttpStatus.<NAME>` → 숫자. @nestjs/common 을 import 하지 않는 이유는 두 가지다: 이 스크립트는
 * 빌드 없이 저장소 루트에서 돌고, 여기 필요한 것은 Nest 의 enum 이 아니라 HTTP 의 숫자다. 목록에
 * 없는 이름이 나오면 멈춘다 — 조용히 넘기면 문서가 틀린 상태를 답하게 된다.
 */
const HTTP_STATUS_NUMBERS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
};

function read(file) {
  return readFileSync(file, 'utf8');
}

/**
 * `export const NAME = [ 'a', 'b' ] as const;` 의 문자열 원소들. 첫 \`]\` 까지만 본다 — 이 저장소의
 * 해당 선언들은 모두 평평한 문자열 배열이라 그 이상이 필요 없고, 중첩이 생기면 결과가 이상해지는
 * 대신 아래 교차 검증에서 걸린다.
 */
function stringArrayConst(source, name, file) {
  const block = new RegExp(`export const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(source);
  if (!block) fail(`${name} not found in ${file}`);
  const values = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  if (values.length === 0) fail(`${name} in ${file} listed no values`);
  return values;
}

/** `export const NAME = 123;` / `= 16_384;` 의 숫자. */
function numberConst(source, name, file) {
  const match = new RegExp(`export const ${name}[^=]*=\\s*([\\d_]+);`).exec(source);
  if (!match) fail(`${name} not found in ${file}`);
  return Number(match[1].replaceAll('_', ''));
}

/** `export const NAME = 'value';` 의 문자열. */
function stringConst(source, name, file) {
  const match = new RegExp(`export const ${name}[^=]*=\\s*'([^']*)';`).exec(source);
  if (!match) fail(`${name} not found in ${file}`);
  return match[1];
}

/** `HTTP_STATUS_BY_CODE` 를 코드 → 숫자로 읽는다. */
function statusByCode(source) {
  const block = /export const HTTP_STATUS_BY_CODE[^{]*\{([^}]*)\}/.exec(source);
  if (!block) fail(`HTTP_STATUS_BY_CODE not found in ${APP_ERROR_TS}`);
  const statuses = {};
  for (const [, code, name] of block[1].matchAll(/(\w+):\s*HttpStatus\.(\w+)/g)) {
    const status = HTTP_STATUS_NUMBERS[name];
    if (status === undefined) {
      fail(`HttpStatus.${name} (code ${code}) is unknown; add it to HTTP_STATUS_NUMBERS`);
    }
    statuses[code] = status;
  }
  return statuses;
}

/** `RATE_LIMIT_BUCKETS` 를 선언 순서대로 읽는다. */
function rateLimitBuckets(source) {
  const block = /export const RATE_LIMIT_BUCKETS = \{([\s\S]*?)\n\} as const/.exec(source);
  if (!block) fail(`RATE_LIMIT_BUCKETS not found in ${RATE_LIMIT_TS}`);
  const buckets = [
    ...block[1].matchAll(/^\s*(\w+):\s*\{\s*scope:\s*'(\w+)',\s*limit:\s*(\d+)/gm),
  ].map(([, name, scope, limit]) => ({ name, scope, limit: Number(limit) }));
  if (buckets.length === 0) fail(`RATE_LIMIT_BUCKETS in ${RATE_LIMIT_TS} listed no buckets`);
  return buckets;
}

/** 표 한 칸: 줄바꿈을 없애고 `|` 를 이스케이프한다(요약문은 문서에서 그대로 온다). */
function cell(text) {
  return String(text).replaceAll(/\s+/g, ' ').replaceAll('|', '\\|').trim();
}

/**
 * 열 너비를 맞추지 않는 이유: `설명` 칸에는 400자가 넘는 요약도 들어 있어서, 정렬하면 모든 행이
 * 그 폭으로 늘어난다. 렌더링 결과는 어차피 같다. (docs/API.md 는 .prettierignore 에 있어 prettier
 * 가 다시 정렬하지도 않는다.)
 */
function table(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`);
  return lines.join('\n');
}

// ---- 입력 --------------------------------------------------------------------------------------

const document = JSON.parse(read(OPENAPI_PATH));
const errorCodes = stringArrayConst(read(ERRORS_TS), 'ERROR_CODES', ERRORS_TS);
const errorStatuses = statusByCode(read(APP_ERROR_TS));

const rateLimitSource = read(RATE_LIMIT_TS);
const buckets = rateLimitBuckets(rateLimitSource);
const windowSeconds = numberConst(rateLimitSource, 'RATE_LIMIT_WINDOW_SECONDS', RATE_LIMIT_TS);

const realtimeSource = read(REALTIME_TS);
const realtime = {
  namespace: stringConst(realtimeSource, 'REALTIME_NAMESPACE', REALTIME_TS),
  resyncEvent: stringConst(realtimeSource, 'RESYNC_EVENT', REALTIME_TS),
  exceptionEvent: stringConst(realtimeSource, 'REALTIME_EXCEPTION_EVENT', REALTIME_TS),
  eventTypes: stringArrayConst(realtimeSource, 'REALTIME_EVENT_TYPES', REALTIME_TS),
  subscribeMax: numberConst(realtimeSource, 'REALTIME_SUBSCRIBE_MAX', REALTIME_TS),
  roomsMax: numberConst(realtimeSource, 'REALTIME_ROOMS_MAX', REALTIME_TS),
  maxMessageBytes: numberConst(realtimeSource, 'REALTIME_MAX_MESSAGE_BYTES', REALTIME_TS),
  messagesPerWindow: numberConst(realtimeSource, 'REALTIME_MESSAGES_PER_WINDOW', REALTIME_TS),
};

// ---- 교차 검증: 정적 표가 소스보다 낡으면 여기서 멈춘다 -----------------------------------------

for (const code of errorCodes) {
  if (errorStatuses[code] === undefined) fail(`${code} has no HTTP status in ${APP_ERROR_TS}`);
  if (ERROR_NOTES[code] === undefined) fail(`${code} has no Korean note; add one to ERROR_NOTES`);
}
for (const code of Object.keys(errorStatuses)) {
  if (!errorCodes.includes(code)) fail(`${code} has an HTTP status but is not in ERROR_CODES`);
}
const documentedCodes = document.components?.schemas?.ErrorCode?.enum;
if (!Array.isArray(documentedCodes)) fail('components.schemas.ErrorCode.enum is missing');
for (const code of documentedCodes) {
  if (!errorCodes.includes(code)) fail(`the document names ${code}, which ERROR_CODES does not`);
}
for (const bucket of buckets) {
  if (RATE_LIMIT_ROUTES[bucket.name] === undefined) {
    fail(`rate-limit bucket '${bucket.name}' has no route note; add one to RATE_LIMIT_ROUTES`);
  }
  if (RATE_LIMIT_SCOPES[bucket.scope] === undefined) {
    fail(`rate-limit scope '${bucket.scope}' has no note; add one to RATE_LIMIT_SCOPES`);
  }
}
for (const type of realtime.eventTypes) {
  if (REALTIME_EVENTS[type] === undefined) {
    fail(`realtime event '${type}' has no note; add one to REALTIME_EVENTS`);
  }
}

// ---- 오퍼레이션 --------------------------------------------------------------------------------

/**
 * A path item's own keys are read in the order the document wrote them (`patch` before `delete`
 * on /admin/charge-packages/{id}, which is the order the controller declares); anything that is
 * not one of these is metadata (`parameters`, `summary`, `$ref`) and is skipped.
 */
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const VERSIONED_PREFIX = '/api/v1/';

/**
 * 한 오퍼레이션이 문서화한 오류 코드들. `@ApiErrors` 가 상태 하나당 응답 하나를 만들고 그 상태를
 * 공유하는 코드들을 `description` 에 `' | '` 로 이어 두므로, 4xx·5xx 응답의 description 이 곧
 * 코드 목록이다. 429 만은 `openapi/document.ts` 의 `addGlobalResponse` 가 같은 모양으로 모든
 * 오퍼레이션에 붙인다(주소 버킷은 라우트를 가리지 않는다) — 그래서 표의 모든 행에 `RATE_LIMITED` 가
 * 있다. 코드가 아닌 문장이 그 자리에 오면(다른 데코레이터가 4xx 를 문서화했다면) 멈춘다:
 * 조용히 넘기면 표의 `오류` 칸이 문장 하나를 코드인 척 싣게 된다.
 */
function errorCodesOf(operation, where) {
  const codes = [];
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    if (Number(status) < 400) continue;
    const description = response.description ?? '';
    if (description.trim() === '') fail(`${where}: response ${status} documents no error code`);
    for (const code of description.split('|').map((part) => part.trim())) {
      if (!errorCodes.includes(code)) {
        fail(`${where}: response ${status} names '${code}', which is not an error code`);
      }
      if (errorStatuses[code] !== Number(status)) {
        fail(
          `${where}: ${code} is documented as ${status} but HTTP_STATUS_BY_CODE says ` +
            `${String(errorStatuses[code])}`,
        );
      }
      codes.push(code);
    }
  }
  // 전역 응답이 빠지면 CI 의 drift 검사는 그것을 잡지 못한다(재생성물을 함께 커밋하면 초록이다).
  // 주소 버킷이 모든 라우트에 걸리는 한 429 가 없는 오퍼레이션은 문서의 오류이므로 여기서 멈춘다.
  if (!codes.includes('RATE_LIMITED')) {
    fail(
      `${where} documents no RATE_LIMITED (429); the address bucket counts every request ahead ` +
        'of routing (rate-limit/address-limit.ts) — see openapi/document.ts addGlobalResponse',
    );
  }
  return codes;
}

/** 태그별 오퍼레이션. 태그는 문서에 처음 나온 순서, 그 안은 경로의 문서 순서 그대로다. */
const byTag = new Map();
/** 필수 헤더는 표의 다섯 칸에 들어가지 않으므로 개요 아래에 따로 모은다(오늘은 Idempotency-Key 뿐). */
const requiredHeaders = [];
let operationCount = 0;

for (const [route, item] of Object.entries(document.paths)) {
  if (!route.startsWith(VERSIONED_PREFIX)) {
    fail(`${route} is outside ${VERSIONED_PREFIX}; the 개요 section claims every path is under it`);
  }
  for (const [method, operation] of Object.entries(item)) {
    if (!HTTP_METHODS.has(method)) continue;
    const where = `${method.toUpperCase()} ${route}`;
    const tag = operation.tags?.[0];
    if (tag === undefined) fail(`${where} has no tag`);
    if (!operation.summary) fail(`${where} has no summary`);
    operationCount += 1;
    for (const parameter of operation.parameters ?? []) {
      if (parameter.in === 'header' && parameter.required === true) {
        requiredHeaders.push([
          `\`${parameter.name}\``,
          `\`${where}\``,
          parameter.description ?? '—',
        ]);
      }
    }
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push([
      method.toUpperCase(),
      `\`${route}\``,
      operation.summary,
      // A requirement naming the session scheme is the only one this API declares; anything
      // else would be a scheme the 인증 section does not describe, so it is worth stopping for.
      operationSecurity(operation, where),
      errorCodesOf(operation, where)
        .map((code) => `\`${code}\``)
        .join(', ') || '—',
    ]);
  }
}

function operationSecurity(operation, where) {
  const requirements = operation.security ?? [];
  if (requirements.length === 0) return '—';
  for (const requirement of requirements) {
    for (const scheme of Object.keys(requirement)) {
      if (document.components?.securitySchemes?.[scheme] === undefined) {
        fail(`${where} requires the undeclared security scheme '${scheme}'`);
      }
    }
  }
  return '🔒';
}

// ---- 문서 조립 ---------------------------------------------------------------------------------

const blocks = [BANNER, OVERVIEW];

if (requiredHeaders.length > 0) {
  blocks.push(
    '**필수 요청 헤더** — 없으면 요청이 거절된다.',
    table(['헤더', '오퍼레이션', '설명'], requiredHeaders),
  );
}

const securitySchemes = Object.entries(document.components?.securitySchemes ?? {});
if (securitySchemes.length === 0) fail('components.securitySchemes is empty');
blocks.push(
  '## 인증',
  '문서가 선언하는 보안 스킴은 세션 쿠키 하나다.',
  table(
    ['스킴', '종류', '위치', '쿠키 이름', '설명'],
    securitySchemes.map(([name, scheme]) => [
      `\`${name}\``,
      `\`${scheme.type}\``,
      `\`${scheme.in}\``,
      `\`${scheme.name}\``,
      scheme.description ?? '—',
    ]),
  ),
  AUTH_NOTES,
);

blocks.push(
  '## 에러 코드',
  `코드 목록과 순서는 \`packages/shared/src/api/errors.ts\` 의 \`ERROR_CODES\`, HTTP 상태는
\`apps/api/src/common/errors/app-error.ts\` 의 \`HTTP_STATUS_BY_CODE\` 에서 그대로 읽었다.
API 는 이 목록 밖의 코드를 내지 않는다.`,
  table(
    ['코드', 'HTTP', '뜻'],
    errorCodes.map((code) => [`\`${code}\``, errorStatuses[code], ERROR_NOTES[code]]),
  ),
);

blocks.push(
  `## 오퍼레이션 (${String(operationCount)}개)`,
  '태그별로 묶었고, 태그 안의 순서는 OpenAPI 문서의 경로 순서 그대로다.',
);
for (const [tag, rows] of byTag) {
  const label = TAG_LABELS[tag];
  blocks.push(
    `### \`${tag}\`${label === undefined ? '' : ` — ${label}`}`,
    table(['메서드', '경로', '설명', '인증', '오류'], rows),
  );
}

const schemaNames = Object.keys(document.components?.schemas ?? {}).sort();
if (schemaNames.length === 0) fail('components.schemas is empty');
blocks.push(
  `## 스키마 (${String(schemaNames.length)}개)`,
  `요청·응답 본문의 실제 모양은 \`apps/api/openapi.json\` 의 \`components.schemas\` 에 있다. 이름만
적어 두니 거기서 찾아 읽는다. 이름은 zod 스키마의 \`.meta({ id })\` 에서 온다.`,
  schemaNames.map((name) => `\`${name}\``).join(', '),
);

blocks.push(HEALTH_SECTION, BETTER_AUTH_SECTION);

blocks.push(
  '## 레이트 리밋',
  `PLAN 7.5 의 표는 \`packages/shared/src/rate-limit.ts\` 한 곳에 있고, 아래 표는 거기서 읽은 것이다.
모든 한도는 **${String(windowSeconds)}초 고정 창** 기준이며, 카운터는 Redis 에 있다(프로세스 메모리가 아니다).`,
  table(
    ['버킷', '기준', `한도(/${String(windowSeconds)}초)`, '적용 라우트'],
    buckets.map((bucket) => [
      `\`${bucket.name}\``,
      RATE_LIMIT_SCOPES[bucket.scope],
      bucket.limit,
      RATE_LIMIT_ROUTES[bucket.name],
    ]),
  ),
  RATE_LIMIT_NOTES,
);

blocks.push(
  '## 실시간 (Socket.IO)',
  REALTIME_NOTES,
  table(
    ['이벤트', '룸', '뜻', '순서 키'],
    realtime.eventTypes.map((type) => [
      `\`${type}\``,
      REALTIME_EVENTS[type].room,
      REALTIME_EVENTS[type].note,
      REALTIME_EVENTS[type].key,
    ]),
  ),
  REALTIME_ORDERING,
  '**한도**',
  table(
    ['항목', '값'],
    [
      [
        '네임스페이스',
        `\`${realtime.namespace}\` (\`\${NEXT_PUBLIC_API_URL}${realtime.namespace}\`)`,
      ],
      ['메시지 하나의 `marketIds` 최대', `${String(realtime.subscribeMax)}개`],
      ['소켓 하나가 들고 있을 수 있는 시장 룸', `${String(realtime.roomsMax)}개`],
      ['메시지 하나의 최대 크기', `${String(realtime.maxMessageBytes)} 바이트`],
      [
        `연결 하나가 ${String(windowSeconds)}초에 보낼 수 있는 메시지`,
        `${String(realtime.messagesPerWindow)}개 (초과분은 \`${realtime.exceptionEvent}\` 이벤트로 \`RATE_LIMITED\`)`,
      ],
      ['재동기화 신호', `\`${realtime.resyncEvent}\``],
    ],
  ),
);

writeFileSync(OUTPUT_PATH, `${blocks.join('\n\n')}\n`);
console.log(
  `[api-doc] wrote ${OUTPUT_PATH} (${String(operationCount)} operations, ` +
    `${String(byTag.size)} tags, ${String(schemaNames.length)} schemas)`,
);
