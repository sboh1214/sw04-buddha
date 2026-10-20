<!-- 이 파일은 scripts/generate-api-doc.mjs 가 생성합니다. 직접 수정하지 마세요. -->

# buddha API

`apps/api/openapi.json` 의 한국어 요약본이다. **직접 고치지 않는다.**
`scripts/generate-api-doc.mjs` 가 만들고, CI 의 `OpenAPI contract check` 단계가
`pnpm api:openapi` 를 다시 실행한 뒤 `git diff --exit-code` 로 검사한다 — 손으로 고친 줄은
다음 CI 에서 그대로 빨간불이 된다.

내용을 바꾸는 곳은 두 군데다.

- 오퍼레이션(경로·요약·인증·오류): 컨트롤러의 `@ApiOperation` / `@ApiData` / `@ApiPageOf` /
  `@ApiErrors` 데코레이터와 zod 스키마. 모든 오퍼레이션에 공통인 `RATE_LIMITED`(429) 하나만은
  `apps/api/src/openapi/document.ts` 의 `addGlobalResponse` 가 붙인다(주소 버킷은 모든 라우트에
  걸리므로). 고친 뒤 `pnpm api:openapi` 를 실행한다.
- 문서의 문장(개요·인증·헬스체크·better-auth·레이트 리밋·실시간 절):
  `scripts/generate-api-doc.mjs`
  맨 위의 템플릿 상수.

## 개요

- **기본 경로** — 이 문서에 실린 모든 오퍼레이션은 `/api/v1` 아래에 있다(전역 prefix `api` +
  URI 버저닝, 기본 버전 1). 버전 접두어가 없는 두 표면은 OpenAPI 문서 밖이라 아래에 손으로 적었다:
  헬스체크(`/api/health`, `/api/health/live`)와 `/api/auth/*`(better-auth).
  문서에 `servers` 가 없으므로 경로는 API 오리진 기준 상대 경로다. 브라우저는 Next.js
  rewrite(`/api/:path*` → `NEXT_PUBLIC_API_URL`)를 거쳐 같은 오리진으로 호출한다.
- **성공 봉투** — 단일 리소스는 `{ "data": ... }`, 커서 목록은
  `{ "data": [...], "meta": { "nextCursor": ... } }`. 화면이 목록 전체의 수를 보이는 목록은
  `meta` 에 그 수 `total` 도 싣는다(`CountedPageMeta` — 그 페이지와 같은 시점에 센 수, 지금은
  시장 상세의 토론 `GET /api/v1/markets/{id}/posts`).
- **실패 봉투** — `{ "error": { "code": ..., "message": ..., "details"?: ... } }`. `details` 는
  값이 없으면 키 자체가 없다(`undefined` 로 넣지 않는다). `VALIDATION_ERROR` 의 `details` 는
  `{ path, message }` 배열(`ValidationIssue`)이다. `message` 는 개발자용 영어 문자열이고,
  사용자에게 보여 줄 한국어 문구는 웹이 `code` 로 고른다.
- **커서 페이지네이션** — `?cursor=&limit=`. `limit` 은 기본 20, 최대 100. 다음 페이지는
  `meta.nextCursor` 를 `cursor` 로 다시 넘겨 요청하고, `nextCursor` 가 `null` 이면 마지막
  페이지다. 커서는 불투명한 문자열이니 클라이언트가 해석하지 않는다(내부적으로는
  `(created_at DESC, id DESC)` 키셋이다).
- **시각** — 모든 타임스탬프는 ISO 8601 UTC 문자열이다. 정밀도는 밀리초 — timestamptz 컬럼이
  전부 `timestamp(3)` 이다.
- **Coin 금액** — 10진 정수 문자열이다(`"12500"`, `"-300"`). JSON number 는 IEEE double 이라
  Postgres bigint 를 정확히 담지 못해서, Coin 금액은 요청·응답 양방향 모두 문자열로 오간다.
  요청 본문의 Coin 금액은 부호 1자 + `MAX_COIN_AMOUNT`(10^15)의 16자리 = 17자까지만 받는다(그보다
  긴 문자열은 파싱하기 전에 거절한다: 백만 자리 `BigInt()` 는 요청 스레드에서 실제로 CPU 를 쓴다).
- **본문 형식** — 요청·응답 모두 `application/json` 이다.
  `application/x-www-form-urlencoded` 파서는 꺼져 있다(HTML 폼이 바로 CSRF 의 모양이다).
- **검색 엔진** — 모든 응답(`/api/auth/*`·헬스체크·오류 응답까지)에 `X-Robots-Tag: noindex` 가
  붙는다(`apps/api/src/infra/http/security-headers.ts`, ADR-0075). 웹의 `/robots.txt` 는 검색
  로봇에게 `/api/` 를 막는다. API 의 답은 검색 엔진이 담을 화면이 아니다.
- **operationId** — 오퍼레이션마다 `@ApiOperation({ operationId })` 로 명시한다. 명시하지 않은
  오퍼레이션만 컨트롤러의 메서드 이름을 쓴다(`openapi/document.ts` 의 `operationIdFactory`).

**필수 요청 헤더** — 없으면 요청이 거절된다.

| 헤더 | 오퍼레이션 | 설명 |
| --- | --- | --- |
| `Idempotency-Key` | `POST /api/v1/payments/charge` | Client-generated key for this purchase (PLAN 5.4). Re-sending it returns the first outcome instead of charging again. DUPLICATE_REQUEST (409) answers a key whose first request is still running (details name Idempotency-Key: keep the key and retry) and a key re-used with a different body (no details: the key is spent). |

## 인증

문서가 선언하는 보안 스킴은 세션 쿠키 하나다.

| 스킴 | 종류 | 위치 | 쿠키 이름 | 설명 |
| --- | --- | --- | --- | --- |
| `session` | `apiKey` | `cookie` | `buddha.session_token` | better-auth session cookie: `buddha.session_token` when the API is served over HTTP, `__Secure-buddha.session_token` when BETTER_AUTH_URL is HTTPS. Browsers send it automatically with `credentials: "include"`. |

- 아래 표의 `인증` 칸이 `🔒` 인 오퍼레이션은 이 쿠키를 요구한다. `—` 는 공개 라우트다.
- 쿠키가 없거나 만료되었으면 `401 UNAUTHENTICATED`.
- `/api/v1/admin/*` 는 쿠키에 더해 `profiles.role = 'admin'` 을 요구한다(`AdminGuard`). 아니면
  `403 FORBIDDEN`. 역할 캐시(60초)는 거절에만 쓰고, 관리자라는 답은 요청마다 Postgres에서 읽는다.
  운영 기록(원장 감사 실패, 출시 설정 변경 기록, 관리자 권한 변경 이력)도 모두 이 아래에 있다.
  관리자 권한의 부여·회수는 다음 요청부터 적용되고, 회수는 그 계정의 세션을 모두 지운다(#171).
- 상태를 바꾸는 요청(GET·HEAD·OPTIONS 외)은 `Origin` 헤더가 신뢰 목록(`WEB_ORIGIN`,
  `BETTER_AUTH_URL`)에 없으면 `403 FORBIDDEN` 이다(`SessionGuard` 의 CSRF 검사). 헤더가 아예
  없는 요청은 브라우저가 보낸 것이 아니므로 통과한다(curl, 서버 간 호출, 테스트).
- 쿠키를 **만드는** 쪽(로그인·로그아웃·소셜 연결)은 이 REST 표면이 아니라 아래 `/api/auth/*` 다.

## 에러 코드

코드 목록과 순서는 `packages/shared/src/api/errors.ts` 의 `ERROR_CODES`, HTTP 상태는
`apps/api/src/common/errors/app-error.ts` 의 `HTTP_STATUS_BY_CODE` 에서 그대로 읽었다.
API 는 이 목록 밖의 코드를 내지 않는다.

| 코드 | HTTP | 뜻 |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | 세션 쿠키가 없거나 만료되었다. 로그인이 필요하다. |
| `FORBIDDEN` | 403 | 로그인은 했지만 권한이 없다. 관리자 전용 라우트, 교차 출처 요청 거부, 남의 계정을 지목한 본문이 여기에 들어간다. |
| `NOT_FOUND` | 404 | 대상이 없다. 공개에 보이지 않는 초안(draft) 시장도 여기로 답한다. |
| `VALIDATION_ERROR` | 400 | 요청이 스키마에 맞지 않는다. `details` 에 `{ path, message }` 배열이 붙는다. |
| `MARKET_NOT_OPEN` | 409 | 시장이 `open` 이 아니라 그 동작을 할 수 없다. |
| `INSUFFICIENT_BALANCE` | 409 | 잔고가 모자란다. |
| `PRICE_MOVED` | 409 | 화면이 보여 준 충전 상품의 조건(`expectedAmountCoin`·`expectedPriceKrw`)이 지금 판매하는 조건과 다르다. |
| `DUPLICATE_REQUEST` | 409 | 이미 쓴 멱등 키를 다른 조건으로 다시 썼거나(키는 소모된다), 한 번만 할 수 있는 일을 두 번 했다(쿠폰 재사용). 환불 재시도는 앞선 시도가 아직 PG 의 답을 기다리는 동안 이것으로 답한다(`details[0].message` 가 `in progress`). |
| `RATE_LIMITED` | 429 | 레이트 리밋 초과. `details.retryAfterSeconds` 와 `Retry-After` 헤더에 대기 초. |
| `RULES_REQUIRED` | 422 | 정산 규칙(`rules`)이 비어 있어 개장하거나 그대로 저장할 수 없다. |
| `VERIFICATION_REQUIRED` | 409 | 본인확인(휴대전화 SMS 인증번호)을 마치지 않은 계정이다. `POST /api/v1/me/phone-verification/code` 로 인증번호를 받아 `POST /api/v1/me/phone-verification/confirm` 으로 확인한 뒤 다시 시도한다(ADR-0070). |
| `REFUND_NOT_ALLOWED` | 409 | 환불 정책 밖의 결제다. `details[0].message` 가 까닭을 말한다 — `window_closed`(승인 후 7일이 지났다), `status`(환불할 수 있는 상태가 아니다), `provider`(그 결제 수단은 취소를 지원하지 않는다). 이미 쓴 Coin 이 있으면 `INSUFFICIENT_BALANCE` 로 답한다. |
| `PAYMENT_GATEWAY_REFUSED` | 409 | PG 가 요청을 거절했다. `details[0].message` 에 PG 의 `<결과 코드> <메시지>` 가 붙는다. 환불이면 회수했던 Coin 을 되돌려 놓았다. 단 환불 **재시도**가 거절되면 첫 시도가 이미 카드를 취소했을 수 있어 Coin 을 되돌리지 않고 `refunding` 으로 둔다 — 첫 시도라도 PG 의 답을 기다리는 사이 재시도가 결제를 넘겨받았으면 마찬가지다(그 재시도가 정한다). 거절됐어도 그사이 다른 시도가 환불을 끝냈으면 오류가 아니라 `refunded` 로 마친 결제로 답한다. |
| `PAYMENT_GATEWAY_ERROR` | 502 | PG 에 닿지 못했거나 결과를 알 수 없다(502). 다른 5xx 처럼 본문에 내부 사정을 담지 않는다. 환불이면 `refunding` 으로 남으니 다시 시도한다. 단 그사이 다른 시도가 환불을 끝냈으면 오류가 아니라 `refunded` 로 마친 결제로 답한다. |
| `ROLE_CHANGE_NOT_ALLOWED` | 409 | 관리자 권한 부여·회수의 규칙에 맞지 않는다. `details[0].message` 가 까닭을 말한다 — 부여는 `already_admin`(이미 관리자다), `email_not_verified`(이메일 인증을 마치지 않았다), `phone_not_verified`(휴대전화 본인확인을 마치지 않았다), 회수는 `not_admin`(관리자가 아니다), `min_admins`(회수하면 관리자가 2명 미만이 된다. 자기 회수도 같다). |
| `APPROVAL_NOT_ALLOWED` | 409 | 2인 통제 요청의 결정(승인·거절)을 받지 않는다. `details[0].message` 가 까닭을 말한다 — `requester`(요청한 계정은 자기 요청을 결정할 수 없다. 어느 환경에서도 예외가 없다), `decided`(이미 결정된 요청이다). 이 규칙을 쓰는 라우트가 이 코드를 문서화한다. |
| `PHONE_VERIFICATION_NOT_ALLOWED` | 409 | 본인확인을 받지 않는다. `details.reason` 이 까닭을 말한다 — `already_verified`(이미 본인확인을 마쳤다), `phone_in_use`(그 번호는 다른 계정이 본인확인한 번호다. 한 번호에 한 계정, 맞는 인증번호를 확인한 뒤에만 알린다). |
| `PHONE_VERIFICATION_LIMITED` | 429 | 인증번호를 보내지 않았다. `details.reason` 이 걸린 한도를, `details.retryAfterSeconds` 가 같은 요청이 그 한도를 지나는 때까지의 초를 말한다(여럿이면 가장 오래 걸리는 것) — `resend_interval`(그 계정의 앞선 발송 뒤 60초가 지나지 않았다), 직전 24시간의 `account_daily`(그 계정이 10번 받았다), `account_phone_daily`(그 계정이 그 번호로 10번 받았다), `phone_accounts`(그 번호로 다른 계정 3개가 받았다), `ip_daily`(같은 접속 주소(IP)의 요청으로 50번 보냈다. 클라이언트를 가리키지 못하는 접속 — 루프백, 웹 서버의 rewrite — 은 세지 않는다), `service_daily`(서비스 전체가 500건 보냈다). 그 계정만의 한도(`resend_interval`·`account_daily`·`account_phone_daily`)는 초까지 정확하고, 다른 계정의 발송과 함께 세는 한도(`phone_accounts`·`ip_daily`·`service_daily`)는 서버 시계의 분 단위로 올려 60의 배수로 답하고 그 분까지 닫혀 있다 — 한도째 발송이 24시간이 된 뒤의 첫 정각 분에 열리므로 남의 발송 시각을 답으로도 통과로도 초까지 알리지 않는다. 기다림은 요청이 든 분의 시작부터 세므로, 답을 받은 때부터 기다리면 그 한도가 열린 때이거나 1분 안으로 뒤다. |
| `VERIFICATION_CODE_REJECTED` | 409 | 본인확인이 되지 않았다. `details.reason` 이 까닭을 말한다 — `no_code`(기다리는 인증번호가 없다: 받지 않았거나 이미 썼다), `expired`(3분이 지났다), `attempts_exceeded`(틀린 입력이 5번이 되어 그 인증번호를 버렸다. 새로 받아야 한다), `superseded`(다시 받기 전의 인증번호다. 새 인증번호를 넣어야 하고, 틀린 입력으로 세지 않는다), `mismatch`(틀렸다. `details.remainingAttempts` 가 남은 입력 수다). 계정의 가장 최근 인증번호만 확인한다. |
| `SMS_SEND_FAILED` | 502 | SMS 사업자가 인증번호 문자를 받지 않은 것이 확실하다(502: 거절, 요청이 나가기 전의 연결 실패). 이 발송은 세지 않고 이 요청이 남긴 인증번호도 없다. 앞서 받은 인증번호는 3분 안이고 버려지지 않았으면 그대로 확인할 수 있다(그것이 다시 가장 최근 인증번호다). 다른 5xx 처럼 본문에 내부 사정을 담지 않는다. |
| `SMS_SEND_UNCONFIRMED` | 502 | SMS 사업자의 답을 받지 못했다(502: 시간 초과, 요청이 나간 뒤 끊긴 연결, 5xx, 읽을 수 없는 답). 문자가 갔을 수 있으므로 발송으로 세고(60초 간격과 하루 한도) 그 인증번호는 확인할 수 있다. 5xx 본문은 `details` 를 싣지 않으므로 코드로 `SMS_SEND_FAILED` 와 가린다. |
| `ONBOARDING_REQUIRED` | 409 | 그 동작에 필요한 온보딩 단계를 마치지 않은 계정이다(#58). `details.steps` 가 마치지 않은 단계를 순서대로 말한다 — `consent`(약관 동의, `POST /api/v1/me/consents`), `verification`(휴대전화 본인확인), `nickname`(닉네임 설정, `POST /api/v1/me/onboarding/nickname`). 본인확인 인증번호 요청은 약관 동의만 요구하고, 닉네임 설정은 약관 동의와 본인확인을, 온보딩을 마친 계정만 하는 동작(관심 카테고리 단계의 답 `POST /api/v1/me/onboarding/interests`, 소개·관심 카테고리의 새 값, 모든 관리자 API, 근거 글 쓰기·수정과 이미지 올리기, 이후의 댓글·좋아요·신고·제안·주문)은 세 단계를 모두 요구한다 — 자기 글 삭제(ADR-0073)와 소개 비우기·고른 관심 카테고리 빼기는 로그인만 본다. 관리자 API는 관리자 권한을 먼저 보므로 관리자가 아닌 계정에는 `FORBIDDEN` 이다. 권리를 바꾸는 약관 개정 뒤에는 다시 동의할 때까지 `consent` 가 남는다. |
| `NICKNAME_NOT_ALLOWED` | 409 | 닉네임 규칙에 맞지 않는다(#58). `details.reason` 이 까닭을 말한다 — `auto_prefix`(직접 입력한 닉네임이 자동 닉네임의 `user_` 로 시작한다. 대소문자 무관), `reserved_word`(운영자를 사칭하는 낱말이 들어 있다. 대소문자 무관, 밑줄을 빼고 견준다), `taken`(다른 계정이 대소문자만 다른 닉네임까지 포함해 쓰고 있거나, 다른 계정이 비운 지 30일이 지나지 않았다), `change_interval`(마지막 변경 뒤 30일이 지나지 않았다. `details.nextChangeAt` 이 다음 변경이 되는 시각), `already_set`(온보딩의 닉네임 설정을 이미 마쳤다. 바꾸려면 `PATCH /api/v1/me`). |
| `POST_NOT_EDITABLE` | 409 | 그 글은 지금 작성자가 고칠 수 없다(#46). `details.reason` 이 까닭을 말한다 — `hidden`(운영 정책에 따라 숨긴 글이다. 숨긴 글은 지울 수는 있다). |
| `IMAGE_NOT_ALLOWED` | 422 | 올린 파일을 이미지로 받지 않는다(#46, 422). `details.reason` 이 까닭을 말한다 — `type`(내용이 JPEG·PNG·WebP·GIF가 아니다. 파일 이름이나 보낸 형식은 보지 않는다), `size`(5MB(5,242,880바이트)보다 크다. 본문은 읽기 전에 길이로 거른다 — 그 두 배를 넘게 밝힌 본문은 413 `VALIDATION_ERROR` 이고, 길이(`Content-Length`)를 밝히지 않은 본문은 그 두 배(10MiB)를 밝힌 것으로 셈하며 넘으면 받는 중에 413 이다. 계정마다 끝나지 않은 업로드(답이 끝나고 변환·저장도 끝날 때까지 — 클라이언트가 먼저 끊어도)가 셋일 때의 넷째나, API 프로세스가 받는 중인 업로드 본문에 이 본문의 길이를 더해 64MiB를 넘는 업로드는 — 어느 하나만으로도 — 본문을 읽지 않고 429 `RATE_LIMITED`(`Retry-After` 2초) 다. 그 안이어도 API의 메모리 — 프로세스의 상주 메모리(RSS)와 이미 내준 몫에 이 본문의 길이를 더한 것 — 가 한도(`API_MEMORY_CEILING_MIB`, 비우면 컨테이너의 메모리 한도 448MiB에서 32MiB를 뺀 416MiB) 안에 들 때까지 본문을 읽지 않고 10초까지 기다리고, 들지 않으면 같은 429 다. 받은 본문의 변환도 그 메모리에 변환 하나의 몫(144MiB)과 이미지 읽기에 남겨 두는 몫(읽기의 예산 32MiB 가운데 빈 것)이 들 때까지, 변환 대기열에 든 때부터 10초까지 기다리고, 들지 않으면 아무것도 저장하지 않고 같은 429 다(오너 결정 2026-10-22 답 3). 본문이 30초 동안 한 바이트도 오지 않거나(오너 결정 2026-10-21), 읽기 시작한 지 2분 안에 다 오지 않으면(계속 보내도 — 오너 결정 2026-10-22 (2차)) 끊고 408 `VALIDATION_ERROR` 다. 본문의 형식(`Content-Type`)이 이미지 네 형식(`image/jpeg`·`image/png`·`image/webp`·`image/gif`)이나 `application/octet-stream` 이 아니면 — JSON·텍스트도, 형식이 없어도 — 본문을 읽지 않고 415 `VALIDATION_ERROR` 다: 계정의 업로드가 셋이거나 64MiB 가 찼어도, 밝힌 길이가 10MiB 를 넘어도(413 이 아니다) 415 다. 출처·세션·온보딩의 확인(403 `FORBIDDEN`·401 `UNAUTHENTICATED`·`ONBOARDING_REQUIRED`)은 본문의 형식과 상관없이 이 모두보다 먼저이고 본문을 읽지 않는다, ADR-0073), `pixels`(한 장면이 너무 크다 — 풀 때 드는 메모리로 형식마다 정한 한도(ADR-0073 결정 9-8. PNG는 풀린 뒤의 채널·비트와 인터레이스의 종류마다 잰 한도다 — 알파가 있는 PNG와 16비트 RGB, 인터레이스 RGB는 더 작고(8비트 RGBA 1,970만, 16비트 RGBA 330만 화소) 알파가 없는 회색과 인터레이스가 아닌 8비트 RGB는 5천만(인터레이스 16비트 회색만 약 4,194만)이다. 팔레트는 RGB로, 투명(`tRNS`)이 든 팔레트·회색·RGB는 알파가 있는 것으로 센다, 오너 결정 2026-10-21 (2차). 변환 전체가 드는 메모리로 잰 한도도 있다 — 움직이는 WebP의 장면은 105만, 움직이는 GIF의 장면은 500만, 성분이 넷(CMYK)인 점진적 JPEG는 약 959만 화소까지. 알파가 있는 정지 WebP는 풀 때의 한도(약 895만 화소)까지 받고 340만 화소 안으로 줄여 저장한다(정사각이면 1,843px — 오너 결정 2026-10-22 답 1))나 5천만 화소를 넘거나, 긴 변이 짧은 변의 32배를 넘는다(아주 가는 이미지는 화소보다 훨씬 많은 메모리로 변환된다, 오너 결정 2026-10-21 (2차)). 가로로 길든 세로로 길든 같고, 움직이는 이미지는 한 장면의 두 변이다), `frames`(움직이는 이미지의 장면 하나하나는 괜찮지만 모든 장면을 더하면 5천만 화소(움직이는 WebP는 1,200만)를 넘는다 — 장면이 너무 많다), `unreadable`(그 형식이라면서 읽히지 않는다. 성분이 넷보다 많은 JPEG도), `empty`(내용이 없다). |
| `COMMENT_NOT_ALLOWED` | 409 | 그 자리에는 새 댓글을 받지 않는다(#48). `details.reason` 이 까닭을 말한다 — `post_hidden`(운영 정책에 따라 숨긴 글이다), `post_deleted`(작성자가 지운 글이다. 댓글이 달려 자리표시로 남은 글), `parent_hidden`(답하려는 댓글이나 대댓글이 숨긴 것이다), `parent_deleted`(답하려는 댓글이 지워져 자리표시로 남은 것이다). 화면에서 빠진 글이나 댓글(아래가 없는 지운 것)은 `NOT_FOUND` 다. |
| `COMMENT_NOT_EDITABLE` | 409 | 그 댓글은 지금 작성자가 고칠 수 없다(#48). `details.reason` 이 까닭을 말한다 — `hidden`(운영 정책에 따라 숨긴 댓글이다. 숨긴 댓글은 지울 수는 있다). |
| `LIKE_NOT_ALLOWED` | 409 | 그 글이나 댓글은 지금 좋아요를 받지 않는다(#49). 좋아요 취소도 같다. `details.reason` 이 까닭을 말한다 — `deleted`(작성자가 지워 자리표시로 남은 글이나 댓글이다), `hidden`(운영 정책에 따라 숨긴 글이나 댓글이다). 화면에서 빠진 글이나 댓글(아래가 없는 지운 것)은 `NOT_FOUND` 다. |
| `NOTICE_PIN_LIMIT_REACHED` | 409 | 이미 공지 3개가 고정되어 있어 더 고정할 수 없다(#138). `details.limit` 이 동시에 고정할 수 있는 수다. 자동으로 풀리는 공지는 없으니 하나를 풀고(`POST /api/v1/admin/notices/{noticeId}/unpin`) 다시 고정한다. |
| `NOTICE_EDIT_CONFLICT` | 409 | 공지 수정 화면을 연 뒤 그 공지가 먼저 고쳐졌다 — 누가 고쳤든(다른 운영자든 같은 운영자의 다른 탭이든) 같다(#138, 오너 결정 2026-10-21). 아무것도 바꾸지 않았다. 요청의 `expectedEditedAt` 이 공지의 지금 `editedAt` 과 다르다 — `details.editedAt` 이 지금의 판이다(한 번도 고치지 않았으면 null). 최신 공지를 다시 읽고(`GET /api/v1/admin/notices/{noticeId}`) 그 `editedAt` 으로 다시 보낸다. |
| `INTERNAL` | 500 | 그 밖의 서버 오류. 본문에 내부 사정을 담지 않는다. |

## 오퍼레이션 (94개)

태그별로 묶었고, 태그 안의 순서는 OpenAPI 문서의 경로 순서 그대로다.

### `auth` — 가입

| 메서드 | 경로 | 설명 | 인증 | 오류 |
| --- | --- | --- | --- | --- |
| POST | `/api/v1/auth/register` | Start an email sign-up: mails the verification link | — | `VALIDATION_ERROR`, `RATE_LIMITED` |

### `me` — 내 계정

| 메서드 | 경로 | 설명 | 인증 | 오류 |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/me` | Profile, balance and linked sign-in methods | 🔒 | `UNAUTHENTICATED`, `NOT_FOUND`, `RATE_LIMITED` |
| PATCH | `/api/v1/me` | Change nickname | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `NICKNAME_NOT_ALLOWED`, `RATE_LIMITED` |
| POST | `/api/v1/me/password` | Set the first password (after verification, or for a social-only account) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `RATE_LIMITED` |
| PUT | `/api/v1/me/time-zone` | Set the time zone times are shown in (null: follow the browser) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED` |
| PUT | `/api/v1/me/bio` | Set the public profile’s 소개: plain text, line breaks kept, at most 160 characters; null or blank clears it | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| POST | `/api/v1/me/phone-verification/code` | Text a six-digit code to the mobile number, keeping the real name for the confirmation | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `ONBOARDING_REQUIRED`, `PHONE_VERIFICATION_NOT_ALLOWED`, `PHONE_VERIFICATION_LIMITED`, `RATE_LIMITED`, `SMS_SEND_FAILED`, `SMS_SEND_UNCONFIRMED` |
| POST | `/api/v1/me/phone-verification/confirm` | Confirm the account's newest code: records the verified number and real name | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `VERIFICATION_CODE_REJECTED`, `PHONE_VERIFICATION_NOT_ALLOWED`, `RATE_LIMITED` |
| PUT | `/api/v1/me/real-name` | Change the real name | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `VERIFICATION_REQUIRED`, `RATE_LIMITED` |
| POST | `/api/v1/me/consents` | Record consent answers: the items the consent step asks, or the marketing one alone | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED` |
| POST | `/api/v1/me/onboarding/nickname` | Set or confirm the nickname in the onboarding, and grant the start Coin | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `NICKNAME_NOT_ALLOWED`, `VERIFICATION_REQUIRED`, `RATE_LIMITED` |
| POST | `/api/v1/me/onboarding/interests` | Answer the onboarding interests step: categories picked, or none to skip it | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| PUT | `/api/v1/me/interest-categories` | Set the interest categories in MY settings (none: drop them all) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |

### `wallet` — 지갑·결제

| 메서드 | 경로 | 설명 | 인증 | 오류 |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/charge-packages` | Charge packages on sale, cheapest discount first. Closed while paid Coin is off: 404 (ADR-0049) | — | `NOT_FOUND`, `RATE_LIMITED` |
| GET | `/api/v1/payments/provider` | The configured payment provider (mock: immediate charge). Closed while paid Coin is off: 404 (ADR-0049) | — | `NOT_FOUND`, `RATE_LIMITED` |
| POST | `/api/v1/payments/charge` | Buy one charge package (mock provider: succeeds immediately). Coin is never convertible back to cash. Closed while paid Coin is off: 404 (ADR-0049) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `PRICE_MOVED`, `DUPLICATE_REQUEST`, `RATE_LIMITED` |
| POST | `/api/v1/coupons/redeem` | Redeem a coupon code for Coin. Closed while paid Coin is off: 404 (ADR-0049) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `DUPLICATE_REQUEST`, `RATE_LIMITED` |
| GET | `/api/v1/me/ledger` | Ledger entries, newest first | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `RATE_LIMITED` |
| GET | `/api/v1/me/payments` | Charges, newest first | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `RATE_LIMITED` |
| GET | `/api/v1/me/payments/{id}` | One of the caller charges | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `NOT_FOUND`, `RATE_LIMITED` |

### `admin` — 관리자

| 메서드 | 경로 | 설명 | 인증 | 오류 |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/admin/charge-packages` | Every charge package, active or not | 🔒 | `UNAUTHENTICATED`, `FORBIDDEN`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| POST | `/api/v1/admin/charge-packages` | Add a charge package | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| PATCH | `/api/v1/admin/charge-packages/{id}` | Change the amount, price, order or availability | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| DELETE | `/api/v1/admin/charge-packages/{id}` | Remove a package (past payments keep their own amount and price) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| GET | `/api/v1/admin/coupons` | Coupons, newest first | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| POST | `/api/v1/admin/coupons` | Issue a coupon (the code is generated when omitted) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| PATCH | `/api/v1/admin/coupons/{id}` | Disable a coupon or change its cap, expiry or memo | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| GET | `/api/v1/admin/users` | Search users by email or nickname | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| POST | `/api/v1/admin/users/{id}/balance-adjust` | Credit or debit Coin with a mandatory reason (ADMIN_ADJUST) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `INSUFFICIENT_BALANCE`, `RATE_LIMITED` |
| GET | `/api/v1/admin/payments` | Charges, newest first | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| POST | `/api/v1/admin/payments/{id}/refund` | Refund an unused charge within 7 days of its approval: claw back all its Coin, then cancel the whole KRW at the provider (retry a refunding one). Closed while paid Coin is off: 404 (ADR-0049) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `INSUFFICIENT_BALANCE`, `DUPLICATE_REQUEST`, `REFUND_NOT_ALLOWED`, `PAYMENT_GATEWAY_REFUSED`, `RATE_LIMITED`, `PAYMENT_GATEWAY_ERROR` |
| GET | `/api/v1/admin/audit-failures` | Ledger/balance mismatches found by the ledger.audit job | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| GET | `/api/v1/admin/markets` | Every market, drafts included, newest first; q narrows it to titles holding the term (a case-insensitive partial match), as the related-market picker searches | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| POST | `/api/v1/admin/markets` | Create a draft market (no price until its first fill) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| GET | `/api/v1/admin/markets/{id}/related` | The markets linked to this one, any status, the latest link first, with who linked | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| POST | `/api/v1/admin/markets/{id}/related` | Link another market to this one, two-way, in any status of either; linking a linked pair changes nothing. Answers the links as they stand | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| DELETE | `/api/v1/admin/markets/{id}/related/{relatedMarketId}` | Unlink two markets; unlinking a pair that is not linked changes nothing. Answers the path market's links as they stand | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| GET | `/api/v1/admin/markets/{id}` | One market with its exposure, settlement steps and event log | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| PATCH | `/api/v1/admin/markets/{id}` | Edit a draft (any field) or an open market (text, close time, category; slug refused naming the field, blank rules refused with RULES_REQUIRED); other statuses refuse naming status | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RULES_REQUIRED`, `RATE_LIMITED` |
| POST | `/api/v1/admin/markets/{id}/open` | draft → open; refused without rules (RULES_REQUIRED) or with a past closeAt | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RULES_REQUIRED`, `RATE_LIMITED` |
| POST | `/api/v1/admin/markets/{id}/close` | open → closed | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `MARKET_NOT_OPEN`, `RATE_LIMITED` |
| POST | `/api/v1/admin/markets/{id}/resolve` | closed → resolved: record the final result; settlement starts immediately | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| GET | `/api/v1/admin/release-settings` | Every registered release setting with its status and value, in registry order; `status=undecided` lists the ones with no value | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| GET | `/api/v1/admin/release-settings/changes` | Release setting changes, newest first: before and after, reason, admin and time (of one key with `key`) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| PATCH | `/api/v1/admin/release-settings/{key}` | Set the status and value of a release setting with a reason (recorded); `undecided` takes no value, the others require one that fits the item, and a change to the current status and value is refused | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| GET | `/api/v1/admin/admins` | Every account that holds the admin role now, with its latest grant | 🔒 | `UNAUTHENTICATED`, `FORBIDDEN`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| POST | `/api/v1/admin/admins` | Make an account an admin with a reason (recorded); only an account with a verified email that has verified its mobile number | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `ROLE_CHANGE_NOT_ALLOWED`, `RATE_LIMITED` |
| GET | `/api/v1/admin/admins/changes` | Admin grants and revokes, newest first: account, admin, reason and time (of one account with `userId`) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| POST | `/api/v1/admin/admins/{userId}/revoke` | Take the admin role from an account (one's own included) with a reason (recorded) and sign it out everywhere; refused when fewer than two admins would remain | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `ROLE_CHANGE_NOT_ALLOWED`, `RATE_LIMITED` |
| GET | `/api/v1/admin/sms/status` | Counts of the verification texts: sent (against the daily service limit), unanswered and refused, in the last 24 hours and per Korean day for seven days | 🔒 | `UNAUTHENTICATED`, `FORBIDDEN`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| GET | `/api/v1/admin/notices` | The notices of one state: pinned (the fixed area, the latest pinned first) or unpinned (every other notice, the newest first — each may be pinned again) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| POST | `/api/v1/admin/notices` | Write a notice, not pinned: a required title and a formatted body as a post’s (at most 5000 characters of text and 10 images, each an upload of the admin’s own that no post or notice has taken) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| GET | `/api/v1/admin/notices/{noticeId}` | One notice, pinned or not, as the editor loads it | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| PUT | `/api/v1/admin/notices/{noticeId}` | Replace a notice’s title and body: it shows as edited and the earlier version is kept for operators. The same content changes nothing (`changed: false`). A pinned notice stays pinned. Refused when the notice was saved since the version the edit was opened from, whoever saved it (`expectedEditedAt`, NOTICE_EDIT_CONFLICT) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `NOTICE_EDIT_CONFLICT`, `RATE_LIMITED` |
| GET | `/api/v1/admin/notices/{noticeId}/actions` | A notice’s operation records, newest first: who wrote, edited, pinned or unpinned it and when (an edit names the version it replaced). An unknown notice has none | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| GET | `/api/v1/admin/notices/{noticeId}/revisions` | A notice’s earlier versions, newest first: each title, when and by whom it was written and replaced. An unknown notice has none | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| GET | `/api/v1/admin/notices/{noticeId}/revisions/{revisionId}` | One earlier version of a notice, whole, to read (NOT_FOUND if not this notice’s) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| GET | `/api/v1/admin/notices/{noticeId}/images/{mediaId}` | An image the notice holds, now or in an earlier version, pinned or not (NOT_FOUND for any other). Revalidated on every use (ETag) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| POST | `/api/v1/admin/notices/{noticeId}/pin` | Pin a notice above the community list, on top; refused while 3 are pinned (NOTICE_PIN_LIMIT_REACHED — none is unpinned to make room). A pinned one changes nothing | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `NOTICE_PIN_LIMIT_REACHED`, `RATE_LIMITED` |
| POST | `/api/v1/admin/notices/{noticeId}/unpin` | Unpin a notice: out of the fixed area and out of the public (its page and images answer NOT_FOUND), kept on the admin screen, and may be pinned again. One not pinned changes nothing | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |

### `markets` — 시장·시세

| 메서드 | 경로 | 설명 | 인증 | 오류 |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/markets` | Markets by status (default open; all is every public status), never drafts, optionally by category and a title search (q, a case-insensitive partial match); sorted recommended (24-hour volume, then the latest opening; the default), newest (latest opening) or closing (soonest close; with any status but open, the open markets first and then the ended ones, latest close first) | — | `VALIDATION_ERROR`, `RATE_LIMITED` |
| GET | `/api/v1/markets/{idOrSlug}` | One market by id or slug (a draft is NOT_FOUND to the public) | — | `VALIDATION_ERROR`, `NOT_FOUND`, `RATE_LIMITED` |
| GET | `/api/v1/markets/{id}/fills` | Newest 20 fills, anonymous | — | `VALIDATION_ERROR`, `NOT_FOUND`, `RATE_LIMITED` |
| GET | `/api/v1/markets/{id}/related` | Markets linked to this one (links are two-way): open, closed, resolved and settled ones, never voided or drafts, sorted recommended (24-hour volume, then the latest opening); a draft or unknown market is NOT_FOUND | — | `VALIDATION_ERROR`, `NOT_FOUND`, `RATE_LIMITED` |
| GET | `/api/v1/markets/{id}/ticks` | Price series, ascending, at most 500 points. `raw` returns stored ticks, downsampled from the newest 10000 of the range (`truncated` says when older ones were left out). `1m`/`1h` sample the probability in force on an absolute grid, coarsening the stride until the window fits; `bucketSeconds` reports the stride served, and the point at `from` carries the last value at or before it, so the left edge is never empty. | — | `VALIDATION_ERROR`, `NOT_FOUND`, `RATE_LIMITED` |
| GET | `/api/v1/categories` | Active categories in display order: top-level rows (parentId null) first, then their sub-categories | — | `RATE_LIMITED` |

### `trades` — 거래·포지션

| 메서드 | 경로 | 설명 | 인증 | 오류 |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/me/positions` | Every position of the account, most recently changed first. status=open keeps the unsettled rows (qty may be 0 after a full sell), status=settled the settled ones; omitted lists all. No cursor: bounded by the markets one account has touched. | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `RATE_LIMITED` |
| GET | `/api/v1/me/orders` | Orders of the account with their fill, newest first | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `RATE_LIMITED` |

### `watchlist` — 관심 시장

| 메서드 | 경로 | 설명 | 인증 | 오류 |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/me/watchlist` | Markets the account watches, every public status unless status narrows it (an ended market stays until unwatched); category takes either level like GET /markets; sorted watched (most recently watched first, the default) or by the GET /markets orders | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `RATE_LIMITED` |
| GET | `/api/v1/me/watchlist/{marketId}` | Whether the account watches one market (a draft is NOT_FOUND) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `NOT_FOUND`, `RATE_LIMITED` |
| PUT | `/api/v1/me/watchlist/{marketId}` | Watch or unwatch one market; repeating either changes nothing (a draft is NOT_FOUND) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED` |

### `search-history` — 최근 검색

| 메서드 | 경로 | 설명 | 인증 | 오류 |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/me/search-history` | The account's recent searches: the newest 10 distinct terms, newest first | 🔒 | `UNAUTHENTICATED`, `RATE_LIMITED` |
| POST | `/api/v1/me/search-history` | Record one submitted search of the account; answers its recent searches (the newest 10 distinct terms, newest first) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `RATE_LIMITED` |
| POST | `/api/v1/me/search-history/{id}/delete` | Delete one recent search: every recorded search of the entry's term (an id the account has none of deletes nothing); answers the recent searches (the newest 10 distinct terms, newest first) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `RATE_LIMITED` |
| POST | `/api/v1/me/search-history/clear` | Delete every recorded search of the account; answers the (empty) recent searches | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `RATE_LIMITED` |

### `posts`

| 메서드 | 경로 | 설명 | 인증 | 오류 |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/posts` | The community list: every market’s posts, newest first (the only order), never a deleted or hidden one; narrowed by market, by category (either level, like GET /markets) and by q, a case-insensitive partial match in the title or the text | — | `VALIDATION_ERROR`, `RATE_LIMITED` |
| POST | `/api/v1/posts` | A post on a market in any public status: an optional title and a formatted body (at most 5000 characters of text and 10 images, each an upload of the author’s own); formatting outside the allow-list is removed | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `RATE_LIMITED` |
| GET | `/api/v1/posts/{postId}` | A post page: the whole post, or a placeholder for a hidden post and for a deleted one that comments not deleted (hidden ones too) still hang under; a deleted post with none is NOT_FOUND | — | `VALIDATION_ERROR`, `NOT_FOUND`, `RATE_LIMITED` |
| PUT | `/api/v1/posts/{postId}` | The author replaces the title and the body (never the market); the post shows as edited and the earlier version is kept for operators. The same content changes nothing. A hidden post cannot be edited (POST_NOT_EDITABLE) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `POST_NOT_EDITABLE`, `RATE_LIMITED` |
| POST | `/api/v1/posts/{postId}/delete` | The author deletes the post (a hidden one too), signed in whatever their onboarding: it stays as the placeholder 삭제된 글입니다 while comments not deleted (hidden ones too) hang under it, and is gone from every view otherwise. Never restored | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED` |
| GET | `/api/v1/markets/{id}/posts` | A market’s discussion: its posts as the community list’s cards, newest first, never a deleted or hidden one, and meta.total, how many the whole list holds; readable in every public status, ended markets too. A draft or unknown market is NOT_FOUND | — | `VALIDATION_ERROR`, `NOT_FOUND`, `RATE_LIMITED` |

### `media`

| 메서드 | 경로 | 설명 | 인증 | 오류 |
| --- | --- | --- | --- | --- |
| POST | `/api/v1/media/images` | An image for a post (or an admin’s notice): JPEG, PNG, WebP or GIF by its content, at most 5242880 bytes. Stored without its metadata, the long side at most 2048px (a still WebP with alpha at most 3400000 pixels), a GIF still moving. Its id goes into the post’s image node; it is served once a post shows it, and removed if nothing takes it within 24 hours | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `ONBOARDING_REQUIRED`, `IMAGE_NOT_ALLOWED`, `RATE_LIMITED` |
| GET | `/api/v1/media/{mediaId}` | An image a post or a pinned notice shows (NOT_FOUND for any other: not attached, removed by an edit, of a deleted or hidden post, or of a notice not pinned). Revalidated on every use (ETag) | — | `VALIDATION_ERROR`, `NOT_FOUND`, `RATE_LIMITED` |

### `comments`

| 메서드 | 경로 | 설명 | 인증 | 오류 |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/posts/{postId}/comments` | A post’s comments: its 댓글 oldest first, at most 20 a page, each with its first 50 대댓글 oldest first and the cursor of the rest (repliesNextCursor, for GET /comments/:commentId/replies); a deleted 댓글 that 대댓글 hang under and a hidden comment are placeholders, other deleted ones are left out. The cursors are opaque, sealed for their list: one that does not open is VALIDATION_ERROR. A post that is gone is NOT_FOUND | — | `VALIDATION_ERROR`, `NOT_FOUND`, `RATE_LIMITED` |
| POST | `/api/v1/posts/{postId}/comments` | A comment of plain text (at most 1000 characters, line breaks kept): a 댓글, or with parentId a 대댓글 — under the 댓글 named, or under the 댓글 of the 대댓글 named. A hidden or deleted post or 댓글 takes none (COMMENT_NOT_ALLOWED) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `COMMENT_NOT_ALLOWED`, `RATE_LIMITED` |
| GET | `/api/v1/comments/{commentId}/replies` | The 대댓글 of a 댓글 after the cursor, oldest first, 50 a page — the first page is the one its post’s comment page carries. A deleted 대댓글 is left out and a hidden one is its placeholder. The cursor is opaque, sealed for this 댓글’s list: another list’s, or one that does not open, is VALIDATION_ERROR. NOT_FOUND for an unknown comment, a 대댓글 and a 댓글 that is gone | — | `VALIDATION_ERROR`, `NOT_FOUND`, `RATE_LIMITED` |
| PUT | `/api/v1/comments/{commentId}` | The author replaces the body; the comment shows as edited and the earlier version is kept for operators. The same text changes nothing. A hidden comment cannot be edited (COMMENT_NOT_EDITABLE) | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `COMMENT_NOT_EDITABLE`, `RATE_LIMITED` |
| POST | `/api/v1/comments/{commentId}/delete` | The author deletes the comment (a hidden one too): a 댓글 stays as the placeholder 삭제된 글입니다 while 대댓글 hang under it, and anything else is gone from every view. Never restored | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED` |

### `likes`

| 메서드 | 경로 | 설명 | 인증 | 오류 |
| --- | --- | --- | --- | --- |
| PUT | `/api/v1/posts/{postId}/like` | Like a post (liked: true) or take the like back (false); repeating either changes nothing. One like per person: per account and per verified number. One’s own post too, in any public market status. A deleted post’s placeholder and a hidden post take none (LIKE_NOT_ALLOWED). Answers the state and the post’s like count — not liked, nothing written, when another live account’s like holds the verified number’s place | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `LIKE_NOT_ALLOWED`, `RATE_LIMITED` |
| PUT | `/api/v1/comments/{commentId}/like` | Like a 댓글 or a 대댓글 (liked: true) or take the like back (false), as a post’s like. A deleted 댓글’s placeholder and a hidden comment take none (LIKE_NOT_ALLOWED). Answers the state and the comment’s like count | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `ONBOARDING_REQUIRED`, `LIKE_NOT_ALLOWED`, `RATE_LIMITED` |
| GET | `/api/v1/me/likes/posts/{postId}` | Whether the account likes a post and which of the comments under it it likes (by its account, or by its verified number for a like a withdrawn account left); no count and nobody else’s | 🔒 | `VALIDATION_ERROR`, `UNAUTHENTICATED`, `RATE_LIMITED` |

### `notices`

| 메서드 | 경로 | 설명 | 인증 | 오류 |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/notices` | The pinned notices (at most 3), the latest pinned first: the fixed area above the community list | — | `RATE_LIMITED` |
| GET | `/api/v1/notices/{noticeId}` | A pinned notice’s page: its title, body and dates (NOT_FOUND for a notice not pinned, as for an unknown one) | — | `VALIDATION_ERROR`, `NOT_FOUND`, `RATE_LIMITED` |

### `profiles`

| 메서드 | 경로 | 설명 | 인증 | 오류 |
| --- | --- | --- | --- | --- |
| GET | `/api/v1/profiles/{publicId}` | A member’s public profile: the nickname, the image, the 운영자 mark, the bio, the interest categories, the month joined, and the counts of visible posts, comments and the likes they received; an unknown public id is NOT_FOUND | — | `NOT_FOUND`, `RATE_LIMITED` |

## 스키마 (136개)

요청·응답 본문의 실제 모양은 `apps/api/openapi.json` 의 `components.schemas` 에 있다. 이름만
적어 두니 거기서 찾아 읽는다. 이름은 zod 스키마의 `.meta({ id })` 에서 온다.

`AdminAccount`, `AdminAccountActor`, `AdminBalanceAdjustResult`, `AdminGrantBody`, `AdminMarket`, `AdminNotice`, `AdminNoticeAction`, `AdminNoticeRevision`, `AdminNoticeRevisionSummary`, `AdminNoticeSummary`, `AdminNoticeUpdateResult`, `AdminPayment`, `AdminRelatedMarket`, `AdminRevokeBody`, `AdminRoleChange`, `AdminRoleChangeType`, `AdminSettlementStep`, `AdminSmsStatus`, `AdminUser`, `AdminUserQuery`, `AnswerInterestsStepBody`, `AuditFailure`, `Balance`, `BalanceAdjustBody`, `Category`, `ChargeBody`, `ChargePackage`, `ChargeResult`, `CoinAmount`, `CommentDeletion`, `CommentThread`, `ConfirmPhoneVerificationBody`, `ConsentItem`, `ConsentRecord`, `CountedPageMeta`, `Coupon`, `CouponCode`, `CreateChargePackageBody`, `CreateCommentBody`, `CreateCouponBody`, `CreateMarketBody`, `CreateNoticeBody`, `CreatePostBody`, `CursorQuery`, `DeleteCommentBody`, `DeletePostBody`, `DeletedComment`, `DeletedPost`, `ErrorCode`, `ErrorEnvelope`, `Fill`, `HiddenComment`, `HiddenPost`, `LedgerEntry`, `LikeState`, `LinkRelatedMarketBody`, `LinkedAccount`, `Market`, `MarketEvent`, `MarketSummary`, `Me`, `MyPostLikes`, `NextPath`, `Nickname`, `Notice`, `NoticeActionType`, `NoticeSummary`, `OkResult`, `Onboarding`, `OnboardingStep`, `Order`, `PageMeta`, `Password`, `Payment`, `PaymentProviderInfo`, `PhoneVerification`, `PhoneVerificationCodeSent`, `Position`, `Post`, `PostAuthor`, `PostBlock`, `PostComment`, `PostDeletion`, `PostDocument`, `PostInline`, `PostListItem`, `PostMark`, `PostMarket`, `PostSummary`, `PostTableRow`, `PriceSeries`, `PriceTick`, `ProfileInterestCategory`, `ProfileMember`, `PublicProfile`, `PublishedComment`, `PublishedPost`, `RecentSearch`, `RecordConsentsBody`, `RecordSearchBody`, `RedeemCouponBody`, `RedeemCouponResult`, `RefundPaymentBody`, `RegisterBody`, `RegisterResult`, `ReleaseSetting`, `ReleaseSettingActor`, `ReleaseSettingChange`, `ReleaseSettingChangeBody`, `ReleaseSettingState`, `ReleaseSettingStatus`, `RequestPhoneVerificationCodeBody`, `ResolveMarketBody`, `SearchHistoryWriteBody`, `SetInterestCategoriesBody`, `SetOnboardingNicknameBody`, `SetPasswordBody`, `SettlementStep`, `SettlementStepStatus`, `SmsSendDay`, `StartGrant`, `UpdateBioBody`, `UpdateChargePackageBody`, `UpdateCommentBody`, `UpdateCouponBody`, `UpdateLikeBody`, `UpdateMarketBody`, `UpdateMeBody`, `UpdateNoticeBody`, `UpdatePostBody`, `UpdateRealNameBody`, `UpdateTimeZoneBody`, `UpdateWatchBody`, `UploadedImage`, `UserRole`, `WatchState`

## 헬스체크 (문서 밖)

`@ApiExcludeController()` 라 OpenAPI 문서에 없다(클라이언트 계약이 아니라 인프라가 읽는 표면이다).
버전 접두어가 없고(`VERSION_NEUTRAL`), PLAN 7 봉투로 감싸지 않으며(ADR-0015 의 본문 모양),
레이트 리밋에서도 면제된다 — 자기를 방어하는 중인 인스턴스가 프로브에 429 를 답하면
오케스트레이터는 그것을 "재시작하라"로 읽는다.

| 메서드 | 경로 | 뜻 |
| --- | --- | --- |
| GET | `/api/health` | 레디니스: 이 API 가 요청을 처리하는 데 필요한 의존성 상태 |
| GET | `/api/health/live` | 라이브니스: 프로세스가 살아 있는지. 아무것도 프로브하지 않는다 |

`GET /api/health` 의 본문:

```json
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
```

- `db` 와 `redis` 는 각각 `"ok"` 또는 `"error"`. 둘 다 `"ok"` 면 `status` 는 `"ok"` 이고
  HTTP 200, 하나라도 실패하면 `status` 는 `"degraded"` 이고 **HTTP 503(본문 모양은 동일)**.
- `db`·`redis` 는 M0 부터의 계약이라 평평한 자리에 그대로 두고, `checks` 가 프로브별 지연을
  더한다. 실패 이유는 로그에만 남는다 — 이 엔드포인트는 인증이 없고, 드라이버 오류 문구는 호스트·
  포트·롤·DB 이름을 담는다.
- 프로브 하나당 상한은 2초다(`PROBE_TIMEOUT_MS`). `latencyMs` 는 실제로 걸린 시간이므로, 타임아웃이면 그 상한에 가까운 값이 된다.
- `GET /api/health/live` 는 `{ "status": "ok", "uptimeSeconds": 1234 }` 만 답한다. 200 말고 다른
  답이 없는 것이 요점이다: 레디니스에 라이브니스 프로브를 물리면 Redis 가 한 번 흔들렸다는 이유로
  컨테이너가 재시작되고, 그 인스턴스가 들고 있던 소켓이 전부 끊긴다.

## `/api/auth/*` — better-auth (문서 밖)

better-auth 인스턴스가 `/api/auth` 에 통째로 마운트된다(PLAN 10.1). @fastify/middie 미들웨어로
Nest 라우팅·전역 prefix·버저닝·본문 파싱보다 **먼저** 실행되므로 OpenAPI 문서에 나타나지 않고,
`/api/v1/auth/*` 로는 닿지 않는다(그쪽에 있는 Nest 라우트는 `POST /api/v1/auth/register` 하나뿐이다).

**오류 모양이 다르다.** 이 표면의 실패는 PLAN 7 봉투가 아니라 better-auth 의
`{ "code": ..., "message": ... }` 이다(HTTP 상태는 그대로). 웹은 `code` 를 문자열로 비교해
한국어 문구를 고른다(`INVALID_EMAIL_OR_PASSWORD`, `EMAIL_NOT_VERIFIED`,
`FAILED_TO_UNLINK_LAST_ACCOUNT` 등).

이 저장소가 실제로 쓰는 경로:

| 메서드 | 경로 | 쓰임 |
| --- | --- | --- |
| POST | `/api/auth/sign-in/email` | 이메일+비밀번호 로그인. 미인증 계정은 `EMAIL_NOT_VERIFIED` |
| POST | `/api/auth/sign-in/social` | google·kakao·naver OAuth 시작(브라우저 리디렉트) |
| GET·POST | `/api/auth/callback/:id` | OAuth 공급자 콜백. 실패는 `?error=` 로 웹에 되돌아온다 |
| POST | `/api/auth/sign-out` | 로그아웃 |
| GET | `/api/auth/get-session` | 현재 세션 조회(웹의 `useSession`) |
| POST | `/api/auth/send-verification-email` | 인증 메일 재발송 |
| GET | `/api/auth/verify-email` | 메일 링크. 성공하면 자동 로그인 후 `callbackURL` 로 리디렉트 |
| POST | `/api/auth/request-password-reset` | 비밀번호 재설정 메일 요청 |
| GET | `/api/auth/reset-password/:token` | 재설정 메일 링크 → `callbackURL` 로 리디렉트 |
| POST | `/api/auth/reset-password` | 토큰으로 새 비밀번호 설정 |
| POST | `/api/auth/change-password` | 현재 비밀번호를 알고 바꾸기 |
| POST | `/api/auth/change-email` | 주소 변경(확인 메일 → 새 주소 인증까지 끝나야 반영) |
| GET | `/api/auth/list-accounts` | 연결된 로그인 수단 목록 |
| POST | `/api/auth/link-social` | 소셜 계정 연결 |
| POST | `/api/auth/unlink-account` | 연결 해제. 마지막 하나는 `FAILED_TO_UNLINK_LAST_ACCOUNT` |

**꺼져 있는 경로**

- `POST /api/auth/sign-up/email` — `disabledPaths` 로 막혀 HTTP 로는 **404** 다. 가입 표면은
  `POST /api/v1/auth/register` 하나뿐이어야 하기 때문이다(ADR-0024): better-auth 의 가입은 아무
  주소에나 비밀번호를 먼저 심을 수 있어서, 공격자가 피해자 주소로 가입해 두고 피해자가 우리 인증
  메일을 누르면 그 비밀번호가 피해자 계정의 것이 된다. 서버 안에서 호출하는
  `auth.api.signUpEmail` 은 계속 동작한다(`disabledPaths` 는 HTTP 라우터에서만 검사된다).
- `POST /api/auth/update-user` — `disabledPaths` 로 막혀 HTTP 로는 **404** 다. 그 경로가 쓰는 것은
  better-auth 의 이름(`user.name`)과 사진(`user.image`)뿐인데 이 서비스는 그 둘을 두지 않는다
  (회원의 이름은 닉네임, `PATCH /api/v1/me`). 서버 안의 `auth.api.updateUser` 는 남지만 데이터베이스
  훅이 두 칸을 그대로 둔다(ADR-0072 7-30·7-31, 오너 결정 2026-10-19 (2차) 3).
- `GET /api/auth/account-info` — `disabledPaths` 로 막혀 HTTP 로는 **404** 다. 그 답은 연결한 소셜
  로그인 제공자의 프로필(이름·사진)인데, 이 서비스는 제공자에게 그것을 묻지도(구글은 `openid`·`email`,
  카카오는 `account_email` 만) 그것을 담은 제공자의 ID 토큰을 두지도 않는다(ADR-0072 7-30·7-31·7-40).
- `POST /api/auth/get-access-token`·`POST /api/auth/refresh-token` — `disabledPaths` 로 막혀 HTTP
  로는 **404** 다. 둘은 세션 계정에 연결한 소셜 로그인 제공자의 접근 토큰을(뒤의 것은 저장한 갱신
  토큰으로 새로 받아) 내주는데, 이 서비스는 제공자의 접근·갱신 토큰을 두지 않는다 — 로그인과 연결은
  콜백이 받은 토큰으로 제공자에게 묻고 저장하지 않는다(ADR-0072 7-30·7-31, 오너 결정 2026-10-19 (4차) 1).
- 최초 비밀번호 설정에는 대응하는 HTTP 경로가 없다. better-auth 의 `setPassword` 는 서버 전용
  엔드포인트라, 이 저장소는 `POST /api/v1/me/password` 로 감싸 노출한다. 본문은
  `newPassword` 와 화면이 보는 계정 `expectedAccountId` 이고, 그것이 쿠키의 계정이 아니면
  아무것도 바꾸지 않고 `403 FORBIDDEN`(`details` 가 그 필드를 지목한다)이다 — 본인확인의
  `POST /api/v1/me/phone-verification/*` 와 실명의 `PUT /api/v1/me/real-name` 도 같다(ADR-0043 추기,
  ADR-0070).

**공통 규칙**

- 합성 주소(`@noemail.buddha.local`)는 주소를 입력받는 모든 경로에서 거절된다
  (`INVALID_EMAIL`). Kakao·Naver 가 이메일을 주지 않았을 때 서버가 붙이는 주소이므로, 남이 먼저
  차지할 수 있으면 안 된다.
- 레이트 리밋은 세 겹이다 — 메일을 보내는 경로는 아래 `email` 버킷, `/sign-in/email` 은
  `signIn` 버킷, 그리고 이 표면 **전체**가 `/api/v1/*` 와 같은 `default`(주소) 버킷에도
  들어간다. 앞의 둘이 거절할 때의 429 는 헤더가 아니라 본문에 초를 담는다:
  `{ "code": "RATE_LIMITED", "message": ..., "retryAfterSeconds": N }`(주소 버킷의 거절은
  `Retry-After` 헤더도 함께 보낸다). better-auth 내장 리미터는
  꺼져 있다(프로세스 메모리에 상태를 두고 IP 로 세는데, Next rewrite 뒤에서는 모든 방문자가 소켓
  하나다).
- CSRF 는 better-auth 자신의 `Origin` 검사가 담당한다(`disableOriginCheck: false`).

## 레이트 리밋

PLAN 7.5 의 표는 `packages/shared/src/rate-limit.ts` 한 곳에 있고, 아래 표는 거기서 읽은 것이다.
모든 한도는 **60초 고정 창** 기준이며, 카운터는 Redis 에 있다(프로세스 메모리가 아니다).

| 버킷 | 기준 | 한도(/60초) | 적용 라우트 |
| --- | --- | --- | --- |
| `default` | 클라이언트 주소 (라우트를 가리지 않고 버킷마다 하나. 요청 하나는 주소 버킷 하나에만 든다) | 100 | 이미지 읽기(`mediaRead`)를 뺀 모든 HTTP 라우트. 아래 `user`·`email` 버킷을 지목한 라우트도 여기에 함께 들어간다(주소 하나당 API 전체 합산). |
| `mediaRead` | 클라이언트 주소 (라우트를 가리지 않고 버킷마다 하나. 요청 하나는 주소 버킷 하나에만 든다) | 600 | `GET /api/v1/media/{mediaId}`(근거 글의 이미지 읽기, 304 포함). `default` 대신 이 버킷에만 든다(오너 결정 2026-10-19, ADR-0073) — API가 이미지를 쓸 때마다 다시 확인하므로(no-cache + ETag) 이미지를 그릴 때마다 요청이 하나이고, 썸네일이 있는 목록이나 이미지가 많은 글을 읽는 것만으로 기본 100/분에 닿을 수 있어서다. PLAN 7.5 의 표에는 없다. |
| `charge` | 로그인 계정 (라우트별) | 10 | `POST /api/v1/payments/charge` |
| `coupon` | 로그인 계정 (라우트별) | 10 | `POST /api/v1/coupons/redeem` |
| `searchHistory` | 로그인 계정 (라우트별) | 30 | `POST /api/v1/me/search-history`(제출한 검색어 기록). 기록마다 남는 행이라(보관 기간 없음) 계정마다 센다. 웹은 거절된 기록을 버리고 검색은 그대로 간다. |
| `phoneVerification` | 로그인 계정 (라우트별) | 5 | `POST /api/v1/me/phone-verification/code`(본인확인 인증번호 요청). 계정마다 센다. 발송 수 자체는 이 버킷이 아니라 DB 의 고정 한도(60초 간격, 계정·번호마다 24시간 10번, `PHONE_VERIFICATION_LIMITED`)가 막고, 이 버킷은 그 한도에 거절당할 요청을 스크립트가 쏟아 내는 속도를 막는다. |
| `consent` | 로그인 계정 (라우트별) | 5 | `POST /api/v1/me/consents`(약관 동의와 MY 설정의 마케팅 정보 수신 켜고 끄기). 계정마다 센다. 바뀐 답마다 고치지 못하고 보존기간 동안 남는 동의 기록 행이 쌓이므로(선택 항목인 마케팅 정보 수신은 MY 설정에서 몇 번이든 켜고 끌 수 있다), 주소 버킷만으로는 한 계정이 보낼 주소가 있는 만큼 기록을 늘릴 수 있다. 동의 단계는 한 번(개정 뒤 다시 묻는 때에 한 번 더) 보내고, MY 설정의 마케팅 스위치는 바꿀 때마다 한 번 보낸다. |
| `email` | 본문이 지목한 이메일 주소 (라우트별) | 5 | 메일을 보내는 경로 — `POST /api/v1/auth/register` 와 `/api/auth/*` 의 `/change-email`, `/send-verification-email`, `/request-password-reset`, `/forget-password`. 시도 자체를 센다(시도가 곧 피해다). `/change-email` 만은 **로그인한 요청만** 센다(세션 없는 요청은 401 이고 아무에게도 메일이 가지 않으므로): 먼저 **요청한 계정**의 버킷을, 그다음 `newEmail` 의 버킷을 — 인증된 계정의 확인 메일은 본문의 주소가 아니라 계정이 이미 가진 주소로 가고, 계정을 먼저 세야 한 계정이 1분에 다섯 주소까지만 지목할 수 있기 때문이다. `GET /verify-email` 도 링크가 메일을 보내는 종류(이메일 변경의 **확인** 링크: 누를 때마다 새 주소에 다시 보낸다)이면 그 수신 주소로 센다 — 토큰은 1시간짜리 무상태 JWT 라 누른다고 소모되지 않기 때문이다. 서명이 유효한 토큰만 세고, 변경을 적용하는 **검증** 링크는 메일을 보내지 않으므로 세지 않는다. |
| `signIn` | 본문이 지목한 이메일 주소 (라우트별) | 10 | `/api/auth/sign-in/email`. 시도를 세되 **성공한 로그인이 버킷을 지운다** — 비밀번호가 맞은 로그인은 공격이 아니고, 그것까지 남기면 공유 계정이 쓰이는 것만으로 스스로 잠긴다. `/api/auth/*` 전체는 이와 별도로 `default`(주소) 버킷에도 들어간다. |

- **버킷을 지목한 라우트는 두 번 세어진다.** `@RateLimit('<bucket>')` 이 붙어도 기본 100/분 의
  주소 상한은 그대로 걸리고, 그 위에 그 버킷의 한도가 더해진다. 먼저 닿는 쪽이 거절한다. 지목한
  버킷이 기본값보다 언제나 엄격하므로, 한 호출자가 한 계정으로 부르는 동안은 대개 그쪽이 먼저 닿는다.
- **헤더** — 계수된 응답에는 주소 버킷의 `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
  `X-RateLimit-Reset` 이 붙는다. 버킷을 지목한 라우트는 같은 이름에 `-route` 가 붙은 세 개를
  더 받는다. 거절될 때는 `Retry-After`(초)가 더 붙고 — 어느 버킷이 거절했든 접미사 없이 —,
  본문은 PLAN 7 봉투의 `RATE_LIMITED` 이며 `details.retryAfterSeconds` 에 같은 숫자가 들어 있다.
- **`ip` 스코프는 경로를 가리지 않고 주소마다 세고(이미지 읽기만 따로), 파싱과 핸들러보다 앞에서 센다.** PLAN 7.5 의 기본값은
  주소당으로 쓰여 있으므로 경로별로 나누면 한 호출자가 경로 수만큼 100번을 쓸 수 있다. 예외는 이미지
  읽기 하나다: `GET /api/v1/media/{mediaId}` 는 `default` 가 아니라 `mediaRead` 에만 들고(304 포함),
  그 응답의 `X-RateLimit-*` 은 그 버킷의 한도를 말한다. 세는 곳은
  Fastify 의 `onRequest` 훅이라 핸들러에 닿지 못하는 요청 — 파싱할 수 없는 본문(400), `bodyLimit`
  초과(413), 라우트 없는 경로(404) — 도 센다(라우터가 훅 이전에 직접 답하는 둘, 해독할 수 없는
  경로 400 과 `maxParamLength` 초과 414 만 예외다). 클라이언트를 지목할 수 없는 피어는 아예
  계수하지 않는다 — 거절이 아니라 무계수다: 루프백과, `RATE_LIMIT_UNCOUNTED_PEERS` 가 지목한
  프록시(다른 호스트의 웹 서버).
- **키는 해시로 저장한다.** 계정 id 는 사람을 지목하고 이메일은 개인정보인데, 리미터가 그것을
  `KEYS rl:*` 로 읽히는 자리에 둘 이유가 없다.
- **면제** — `/api/health`, `/api/health/live`(주소 리미터 훅의 `UNCOUNTED_ROUTES`; 지목한 버킷은 없다).
- **Redis 가 죽으면 열린다**(fail-open). 리미터 때문에 API 전체가 멈추지는 않는다.
- **Socket.IO 는 따로 센다** — 아래 실시간 절 참고.

## 실시간 (Socket.IO)

연결은 Socket.IO 네임스페이스 하나다. 핸드셰이크에서 세션 쿠키를 읽어 로그인 상태면
`user:<userId>` 룸에 자동으로 들어간다(페이로드로 사용자 룸을 고를 수 있는 표면은 없다).
로그인하지 않은 소켓도 붙을 수 있고, 공개 이벤트만 받는다.

**룸**

- `market:<marketId>` — 공개. 클라이언트가 `subscribe` 로 직접 들어간다.
- `user:<userId>` — 비공개. 핸드셰이크의 세션에서만 정해진다.

**클라이언트 → 서버**

- `subscribe` / `unsubscribe`, 페이로드는 `{ "marketIds": ["<uuid>", ...] }`.
- 메시지 하나가 담을 수 있는 id 수와 소켓 하나가 들고 있을 수 있는 룸 수는 다르다(아래 표).
  룸 상한이 더 크므로, 그보다 많은 id 를 가진 화면은 메시지 상한 크기로 잘라서 보내야 한다.
  게이트웨이는 페이로드 전체를 검증한 뒤에 룸에 넣기 때문에, 한 번에 너무 많이 보낸 메시지는
  통째로 거절되고 룸에는 하나도 들어가지 않는다.
- 거절은 `exception` 이벤트로 돌아온다. 본문은 REST 와 같은
  `{ "error": { "code", "message", "details"? } }` 봉투다(프로토콜에 ack 이 없다).

**서버 → 클라이언트**

이벤트 이름이 곧 `type` 필드다.

| 이벤트 | 룸 | 뜻 | 순서 키 |
| --- | --- | --- | --- |
| `market:tick` | `market:<id>` | 체결 후의 가격·통계. 지금은 체결 경로가 없어 발행되지 않는다 | `tradeCount` |
| `market:trade` | `market:<id>` | 익명 체결 1건. 지금은 체결 경로가 없어 발행되지 않는다 | `fillId` |
| `market:status` | `market:<id>` | 상태 전이(개장·마감·판정·정산 완료). 설명만 고친 편집도 같은 상태로 다시 발행된다 | `statusEventId` |
| `user:balance` | `user:<id>` | 충전·환불·정산 지급·시작 지급(#70) 후의 잔고 | `ledgerEntryId` |
| `user:position` | `user:<id>` | 변경된 포지션 1행 | `version` |

이벤트는 커밋 순서대로 도착하지 않을 수 있고(인스턴스 두 대, 늦게 흘러나온 Redis 큐),
밀리초 `ts` 는 동점이 날 수 있다. 그래서 다시 바뀔 수 있는 엔티티의 이벤트는 위 표의 **순서 키**를
싣는다. 클라이언트는 들고 있는 값보다 큰 키만 받아들이고(`supersedes`), 같거나 작으면 중복이거나
늦은 것이므로 버린다. 키는 같은 이벤트 종류 안에서만 비교한다 — 서로 다른 시퀀스에서 나온 숫자다.

그 밖에 게이트웨이만 보내는 이벤트가 둘 있다.

- `realtime:resync` — Redis 구독이 끊겼다가 다시 걸렸다는 신호(페이로드 없음). 그 사이의 이벤트는
  사라졌으므로 클라이언트는 REST 스냅샷을 다시 받아야 한다.
- `exception` — 위의 거절 봉투.

`market:tick` 만 volatile 로 보낸다: 다음 틱이 곧바로 덮어쓰는 스냅샷이라, 전송이 밀린 클라이언트는
하나쯤 잃어도 된다. 나머지는 사실(fact)이라 반드시 도착해야 한다.

**한도**

| 항목 | 값 |
| --- | --- |
| 네임스페이스 | `/ws` (`${NEXT_PUBLIC_API_URL}/ws`) |
| 메시지 하나의 `marketIds` 최대 | 100개 |
| 소켓 하나가 들고 있을 수 있는 시장 룸 | 200개 |
| 메시지 하나의 최대 크기 | 16384 바이트 |
| 연결 하나가 60초에 보낼 수 있는 메시지 | 120개 (초과분은 `exception` 이벤트로 `RATE_LIMITED`) |
| 재동기화 신호 | `realtime:resync` |
