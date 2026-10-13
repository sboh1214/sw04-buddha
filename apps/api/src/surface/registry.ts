/**
 * The API's public and owner-only routes, registered (#113). A public route is one with no
 * SessionGuard: anyone reaches it, signed in or not. An owner-only route has SessionGuard and
 * not AdminGuard: it answers about the session's own account and nobody else's. The admin
 * surface is checked on its own (admin-access.test.ts: SessionGuard then AdminGuard on every
 * /admin route).
 *
 * The routes come from the module graph, not from here: registry.test.ts fails on a public or
 * owner-only route missing below, on a line whose route is gone or changed class, on a field of
 * a documented public answer that PRIVATE_DATA names, and on a path or field naming an excluded
 * feature (EXCLUDED_FEATURES); private-data.test.ts calls every line for real with another
 * account's private data in the database. A route added tomorrow is refused until it is written
 * here with a reason, and the reason is what a reviewer reads. docs/GUARDS.md has the steps.
 *
 * Keys are `METHOD /path` as the controllers write them, without `/api` and the version.
 *
 * The realtime surface is registered the same way: every Socket.IO gateway by namespace
 * (REALTIME_GATEWAYS) and every place the API emits on a socket (REALTIME_EMITS), both found by
 * registry.test.ts from the module graph and the sources; the event types themselves are
 * REALTIME_EVENT_REGISTRY's (@buddha/shared).
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

/**
 * Public surface the module walk cannot see: it is served outside the Nest controllers, so it
 * is named here with what it answers. The realtime rooms are below and in
 * REALTIME_EVENT_REGISTRY (@buddha/shared).
 */
export const OUTSIDE_NEST_ROUTES: readonly { readonly path: string; readonly reason: string }[] = [
  {
    path: '/api/auth/*',
    reason:
      'better-auth(PLAN 10.1)가 Nest 라우팅 앞에서 처리한다: 로그인·로그아웃·가입 확인·비밀번호 재설정·소셜 로그인과 연결·이메일 변경. 세션을 읽는 호출(get-session·list-sessions)은 그 세션 계정의 것만 돌려주고, /sign-up/email은 막혀 있다(ADR-0024).',
  },
];

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

/**
 * Every place the API emits on a socket: the file under `src/`, the event as the call writes it,
 * and what goes out. registry.test.ts reads the sources and fails on an emit not listed here, so
 * an event cannot reach a room around the channel families the gateway parses with.
 */
export const REALTIME_EMITS: readonly {
  readonly file: string;
  readonly event: string;
  readonly reason: string;
}[] = [
  {
    file: 'realtime/market.gateway.ts',
    event: 'event.type',
    reason:
      '방의 이벤트: 채널의 계열 스키마(시장 방은 marketRealtimeEventSchema, 본인 방은 userRealtimeEventSchema)로 파싱한 것만 그 방에 보낸다. 유형은 REALTIME_EVENT_REGISTRY의 것이다.',
  },
  {
    file: 'realtime/market.gateway.ts',
    event: 'RESYNC_EVENT',
    reason: '구독이 끊겼다 다시 이어졌을 때 연결된 모든 소켓에 다시 읽으라는 신호. 본문이 없다.',
  },
  {
    file: 'realtime/market.gateway.ts',
    event: 'REALTIME_EXCEPTION_EVENT',
    reason: '메시지 속도 제한의 거절 봉투(RATE_LIMITED): 그 소켓에만',
  },
  {
    file: 'realtime/realtime-exception.filter.ts',
    event: 'REALTIME_EXCEPTION_EVENT',
    reason: '핸들러가 거절한 메시지의 오류 봉투(PLAN 7.4): 그 소켓에만',
  },
];
