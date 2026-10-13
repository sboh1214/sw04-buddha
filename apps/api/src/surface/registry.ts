import { errorEnvelopeSchema, realtimeEventSchema } from '@buddha/shared';
import type * as z from 'zod';

/**
 * The API's public and owner-only routes, registered (#113). A public route is one with no
 * SessionGuard: anyone reaches it, signed in or not. An owner-only route has SessionGuard and
 * not AdminGuard: it answers about the session's own account and nobody else's. The admin
 * surface is checked on its own (admin-access.test.ts: SessionGuard then AdminGuard on every
 * /admin route).
 *
 * The routes come from the module graph, not from here: registry.test.ts fails on a public or
 * owner-only route missing below, on a line whose route is gone or changed class, on a field of
 * a documented public answer that PRIVATE_DATA names, on a public path or field naming an
 * excluded feature (EXCLUDED_FEATURES), and on any route's path, owner-only and admin ones too,
 * naming a transfer, an activity reward or a cash-out (EVERY_ROUTE_PATH_FEATURES);
 * private-data.test.ts calls every line for real with another account's private data in the
 * database. A route added tomorrow is refused until it is written
 * here with a reason, and the reason is what a reviewer reads. docs/GUARDS.md has the steps.
 *
 * Keys are `METHOD /path` as the controllers write them, without `/api` and the version.
 *
 * better-auth's routes under /api/auth are registered the same way (AUTH_ROUTES), found from
 * the auth instance, and so is the realtime surface: every Socket.IO gateway by namespace
 * (REALTIME_GATEWAYS) and every place the API sends on a socket with the schema of what it
 * sends (REALTIME_EMITS), both found by registry.test.ts from the module graph and the sources;
 * the event types themselves are REALTIME_EVENT_REGISTRY's (@buddha/shared).
 */

export interface RegisteredRoute {
  /** Why it may be public, or whose data it answers about. */
  readonly reason: string;
  /**
   * Kept paid-Coin code (D9, ADR-0049): PaidCoinSalesGuard runs first and answers 404 while
   * PAID_COIN_SALES_ENABLED is false. Only such a route may name paid purchase in public.
   */
  readonly preservedPaid?: true;
  /** Left out of the OpenAPI document (`@ApiExcludeController`); docs/API.md describes it. */
  readonly undocumented?: true;
}

export const PUBLIC_ROUTES: Readonly<Record<string, RegisteredRoute>> = {
  'POST /auth/register': {
    reason:
      '이메일 가입 시작(ADR-0024): 받은 주소로 확인 메일만 보내고 상태 하나를 돌려준다. 주소가 이미 있는지도 알리지 않는다.',
  },
  'GET /markets': {
    reason: '시장 탐색(PLAN 7.1 공개 조회): 초안이 아닌 시장의 공개 정보와 집계',
  },
  'GET /markets/:idOrSlug': {
    reason: '시장 상세(PLAN 7.1 공개 조회): 규칙·출처·상태·시장가격과 집계',
  },
  'GET /markets/:id/fills': {
    reason: '최근 체결(N01 §5): 계정·주문 없이 방향·수량·가격·시각만, 익명으로',
  },
  'GET /markets/:id/ticks': {
    reason: '시장가격 흐름(N02 §5 차트): 시장 단위의 가격 기록',
  },
  'GET /categories': {
    reason: '시장 탐색의 카테고리(PLAN 7.1 공개 조회)',
  },
  'GET /charge-packages': {
    reason: '보존한 충전 상품 목록(D9, ADR-0049): 유료 Coin 판매를 끈 동안 404',
    preservedPaid: true,
  },
  'GET /payments/provider': {
    reason: '보존한 결제 수단 안내(D9, ADR-0049): 유료 Coin 판매를 끈 동안 404',
    preservedPaid: true,
  },
  'GET /health': {
    reason:
      '배포·관제의 준비 상태 확인(ADR-0015): 의존성별 ok/error와 걸린 시간·가동 시간만, 오류 문구 없이',
    undocumented: true,
  },
  'GET /health/live': {
    reason: '배포·관제의 생존 확인(ADR-0015): 가동 시간만',
    undocumented: true,
  },
};

export const OWNER_ROUTES: Readonly<Record<string, RegisteredRoute>> = {
  'GET /me': {
    reason: '본인 계정: 이메일·프로필·잔액·로그인 수단·실명·휴대전화(N04 §2)',
  },
  'PATCH /me': {
    reason: '본인 닉네임 변경',
  },
  'POST /me/password': {
    reason: '본인 첫 비밀번호 설정: 본문의 expectedAccountId가 세션 계정이어야 한다',
  },
  'PUT /me/contact': {
    reason: '본인 실명·휴대전화(ADR-0043): 본문의 expectedAccountId가 세션 계정이어야 한다',
  },
  'GET /me/ledger': {
    reason: '본인 Coin 원장(N04 §3 지갑)',
  },
  'GET /me/payments': {
    reason: '본인의 지난 결제(보존한 결제 코드, D9)',
  },
  'GET /me/payments/:id': {
    reason: '본인의 결제 한 건(보존한 결제 코드, D9): 다른 계정의 결제는 404',
  },
  'GET /me/positions': {
    reason: '본인 보유 계약과 손익(N04 §2·§3)',
  },
  'GET /me/orders': {
    reason: '본인 주문과 체결(N04 §2·§3)',
  },
  'POST /payments/charge': {
    reason: '보존한 Coin 충전(D9, ADR-0049): 유료 Coin 판매를 끈 동안 404',
    preservedPaid: true,
  },
  'POST /coupons/redeem': {
    reason: '보존한 쿠폰 사용(D9, ADR-0049): 유료 Coin 판매를 끈 동안 404',
    preservedPaid: true,
  },
};

export interface RegisteredAuthRoute {
  /** What it does and for whom, and why anyone may call it. */
  readonly reason: string;
  /**
   * It answers with an account's data — a user, a session, a linked account, a provider token —
   * so private-data.test.ts calls it anonymously and as B aimed at A (`AUTH_CASES`).
   */
  readonly answersAccount?: true;
}

/**
 * better-auth's routes (PLAN 10.1), relative to /api/auth: served by middie ahead of Nest routing,
 * so the module walk cannot see them, and open to anyone — each checks the session itself.
 * registry.test.ts lists what the auth instance serves (every endpoint of `auth.api` with a path,
 * plugins' included, less `disabledPaths`) and fails on one missing here or a line it no longer
 * serves (owner decision 2026-10-13 #113 (a)): a plugin (the SMS OTP of #183, say) or an upgrade
 * that adds an endpoint is refused until it is written here. Keys are `METHOD /path`.
 * `/sign-up/email` is disabled (ADR-0024): RegistrationService calls it on the server only.
 */
export const AUTH_ROUTES: Readonly<Record<string, RegisteredAuthRoute>> = {
  'POST /sign-in/social': {
    reason:
      '소셜 로그인 시작(PLAN 10.2): 제공자의 로그인 주소를 돌려준다. 제공자의 ID 토큰을 주면 그 계정으로 로그인하고 사용자를 돌려준다.',
    answersAccount: true,
  },
  'GET /callback/:id': {
    reason: 'OAuth 제공자의 콜백(PLAN 10.2): 세션 쿠키를 굽고 웹으로 돌려보낸다(리디렉트).',
  },
  'POST /callback/:id': {
    reason: '같은 콜백을 form_post로 받는 제공자용(PLAN 10.2).',
  },
  'GET /get-session': {
    reason: '세션 읽기: 요청한 세션의 계정과 세션만 돌려준다. 세션이 없으면 null.',
    answersAccount: true,
  },
  'POST /get-session': {
    reason:
      '세션 읽기(POST): 세션 갱신 미루기(session.deferSessionRefresh)를 켜지 않아서 405로 거절한다. 켜면 GET과 같다.',
    answersAccount: true,
  },
  'POST /sign-out': {
    reason: '로그아웃: 요청한 세션을 끝낸다.',
  },
  'POST /sign-in/email': {
    reason:
      '이메일 로그인(PLAN 10.2): 맞는 주소와 비밀번호에만 그 계정의 세션과 사용자를 돌려준다. 이메일 인증 전이면 403.',
    answersAccount: true,
  },
  'POST /reset-password': {
    reason: '비밀번호 재설정 완료: 메일의 토큰으로 새 비밀번호를 정한다.',
  },
  'POST /verify-password': {
    reason: '세션 계정의 비밀번호가 맞는지만 답한다.',
  },
  'GET /verify-email': {
    reason:
      '메일 링크의 확인(ADR-0023·ADR-0024): 서명된 토큰이 가리키는 주소를 인증하거나 바꾼다. 이메일 변경 확인에서는 그 계정의 사용자를 돌려준다.',
    answersAccount: true,
  },
  'POST /send-verification-email': {
    reason: '인증 메일 다시 보내기(ADR-0023): 주소마다 횟수 제한.',
  },
  'POST /change-email': {
    reason: '세션 계정의 이메일 변경 시작(PLAN 17 Q5): 확인 메일만 보낸다.',
  },
  'POST /change-password': {
    reason:
      '세션 계정의 비밀번호 변경: 지금 비밀번호가 맞아야 하고, 세션 계정의 사용자를 돌려준다.',
    answersAccount: true,
  },
  'POST /update-session': {
    reason:
      '세션의 추가 필드 고치기: 추가 필드를 두지 않아서 거절한다. 고치면 세션 계정의 그 세션을 돌려준다.',
    answersAccount: true,
  },
  'POST /update-user': {
    reason: '세션 계정의 이름·이미지 고치기(better-auth 사용자 필드). 상태만 돌려준다.',
  },
  'POST /delete-user': {
    reason: '계정 삭제: better-auth의 계정 삭제(user.deleteUser)를 켜지 않아서 거절한다.',
  },
  'POST /request-password-reset': {
    reason: '비밀번호 재설정 메일(PLAN 10.2): 주소가 있는지 알리지 않고 같은 답을 한다.',
  },
  'GET /reset-password/:token': {
    reason: '재설정 메일 링크: 토큰을 확인하고 웹의 재설정 화면으로 돌려보낸다(리디렉트).',
  },
  'GET /list-sessions': {
    reason: '세션 계정의 활성 세션 목록.',
    answersAccount: true,
  },
  'POST /revoke-session': {
    reason: '세션 계정의 세션 하나 끝내기: 다른 계정의 세션 토큰이면 아무것도 하지 않는다.',
  },
  'POST /revoke-sessions': {
    reason: '세션 계정의 모든 세션 끝내기.',
  },
  'POST /revoke-other-sessions': {
    reason: '세션 계정의 다른 세션 끝내기.',
  },
  'POST /link-social': {
    reason: '세션 계정에 소셜 로그인 연결(PLAN 10.3): 제공자의 로그인 주소를 돌려준다.',
  },
  'GET /list-accounts': {
    reason: '세션 계정의 로그인 수단 목록(PLAN 10.3).',
    answersAccount: true,
  },
  'GET /delete-user/callback': {
    reason: '계정 삭제 메일 링크: 계정 삭제를 켜지 않아서 거절한다.',
  },
  'POST /unlink-account': {
    reason:
      '세션 계정의 로그인 수단 하나 끊기(PLAN 10.3, 마지막 하나는 거절): 다른 계정의 것이면 찾지 못한다.',
  },
  'POST /refresh-token': {
    reason: '세션 계정에 연결된 제공자 토큰 갱신: 세션 계정의 것만 찾는다.',
    answersAccount: true,
  },
  'POST /get-access-token': {
    reason: '세션 계정에 연결된 제공자의 접근 토큰: 세션 계정의 것만 찾는다.',
    answersAccount: true,
  },
  'GET /account-info': {
    reason: '세션 계정에 연결된 제공자의 계정 정보: 세션 계정의 것만 찾는다.',
    answersAccount: true,
  },
  'GET /ok': {
    reason: 'better-auth의 생존 확인: { ok: true }.',
  },
  'GET /error': {
    reason: 'better-auth의 오류 페이지: 쿼리의 오류 코드를 보인다.',
  },
};

export interface RegisteredGateway {
  /** What a client may do on it and what it is sent, and why that may be open to anyone. */
  readonly reason: string;
  /** The messages a client may send it (`@SubscribeMessage`), sorted. */
  readonly messages: readonly string[];
}

/**
 * The Socket.IO gateways, by namespace (#113, owner decision 2026-10-13 (a)). A socket is open to
 * anyone, signed in or not, so a gateway is public surface the HTTP registry does not see: a new
 * one, a new namespace or a new message fails registry.test.ts until it is written here.
 */
export const REALTIME_GATEWAYS: Readonly<Record<string, RegisteredGateway>> = {
  '/ws': {
    reason:
      '실시간 방(PLAN 8, ADR-0017): 누구나 subscribe·unsubscribe로 시장 방 market:<id>를 듣고(소켓마다 상한), 핸드셰이크에 세션이 있으면 본인 방 user:<id>에 들어간다. 방에 오는 이벤트는 REALTIME_EVENT_REGISTRY의 유형뿐이다(REALTIME_EMITS).',
    messages: ['subscribe', 'unsubscribe'],
  },
};

export interface RegisteredEmit {
  /** The file under `src/`. */
  readonly file: string;
  /** The event as the call writes it. */
  readonly event: string;
  /**
   * What goes out: the zod schema of the payload, or `null` for a bare signal. registry.test.ts
   * reads what the call sends — the arguments after the event, an acknowledgement's arguments, a
   * reply's returned value — and fails on a property name, at any level, of its type or of an
   * object literal written in it, that the schema does not have, and on one (the schema's too)
   * that PRIVATE_DATA names or that names an excluded feature or a probability. A send whose
   * payload cannot be read where it is sent (an acknowledgement handed on) fails.
   */
  readonly payload: z.ZodType | null;
  /**
   * The payload is a realtime event that goes only into the room of the channel family whose
   * schema parsed it (REALTIME_EVENT_REGISTRY): realtime-events.test.ts holds a market-channel
   * event to the public names, and a user-channel one is the owner's own. Only that its names
   * are the schema's is checked here.
   */
  readonly roomEvent?: true;
  /** What goes out to whom, and why. */
  readonly reason: string;
}

/**
 * Every place the API sends on a socket: the file under `src/`, the event as the call writes it,
 * what goes out (its schema) and why. A send is an emit, a `send` or `write`, a message handler's
 * returned value (`reply to '<message>'`) or a call of a client's acknowledgement callback — a
 * handler's `@Ack()` parameter, a listener's last argument (`ack to '<message>'`).
 * registry.test.ts reads the sources and fails on a send not listed here and on a payload its
 * schema does not declare, so an event cannot reach a room around the channel families the
 * gateway parses with, nor an answer reach a client unreviewed or carry what the line does not say.
 */
export const REALTIME_EMITS: readonly RegisteredEmit[] = [
  {
    file: 'realtime/market.gateway.ts',
    event: 'event.type',
    payload: realtimeEventSchema,
    roomEvent: true,
    reason:
      '방의 이벤트: 채널의 계열 스키마(시장 방은 marketRealtimeEventSchema, 본인 방은 userRealtimeEventSchema)로 파싱한 것만 그 방에 보낸다. 유형은 REALTIME_EVENT_REGISTRY의 것이다.',
  },
  {
    file: 'realtime/market.gateway.ts',
    event: 'RESYNC_EVENT',
    payload: null,
    reason: '구독이 끊겼다 다시 이어졌을 때 연결된 모든 소켓에 다시 읽으라는 신호. 본문이 없다.',
  },
  {
    file: 'realtime/market.gateway.ts',
    event: 'REALTIME_EXCEPTION_EVENT',
    payload: errorEnvelopeSchema,
    reason:
      '메시지 속도 제한의 거절 봉투(RATE_LIMITED, PLAN 7.4): 그 소켓에만, details는 다시 보낼 수 있을 때까지의 초',
  },
  {
    file: 'realtime/realtime-exception.filter.ts',
    event: 'REALTIME_EXCEPTION_EVENT',
    payload: errorEnvelopeSchema,
    reason: '핸들러가 거절한 메시지의 오류 봉투(PLAN 7.4): 그 소켓에만',
  },
];
