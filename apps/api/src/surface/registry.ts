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
  /**
   * Open to accounts that have done the onboarding only (OnboardedGuard, #58: ADR-0069 decision 1
   * #57-8 keeps writes, likes, reports, proposals and orders from the rest). registry.test.ts holds
   * this flag and the guard to each other, so a route that should carry the check says so here and
   * a reviewer sees it.
   */
  readonly onboarded?: true;
  /**
   * A public route that shows a person (ADR-0069 decision 5, owner decision 2026-10-18 on ADR-0057
   * 결과 5-1): why it must, and that it shows only the author's public id, nickname, image and
   * 운영자 mark. private-data.test.ts lets the nickname and the public id of account A through on
   * this route alone; A's account id, email and every other value of A stay forbidden on it as
   * everywhere, and every other public route may show no person at all.
   */
  readonly showsPerson?: string;
}

export const PUBLIC_ROUTES: Readonly<Record<string, RegisteredRoute>> = {
  'POST /auth/register': {
    reason:
      '이메일 가입 시작(ADR-0024): 받은 주소로 확인 메일만 보내고 상태 하나를 돌려준다. 주소가 이미 있는지도 알리지 않는다.',
  },
  'GET /markets': {
    reason:
      '시장 탐색과 검색(PLAN 7.1 공개 조회, ADR-0061 결정 1의 18 검색 공개): 초안이 아닌 시장의 공개 정보와 집계. 검색어는 부른 사람의 것이고 여기서 기록하지 않는다(ADR-0066)',
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
  'GET /markets/:id/related': {
    reason:
      '상세의 관련 시장(#65, ADR-0061 결정 1의 18·19, ADR-0068): 운영자가 이 시장과 연결한 시장의 공개 정보와 집계(목록과 같은 항목), 진행 중·거래 마감·판정 완료·정산 완료(open·closed·resolved·settled)만. 연결한 운영자와 시각은 싣지 않는다',
  },
  'GET /markets/:id/posts': {
    reason:
      '시장 상세의 토론(#47, N02 §2 비로그인의 공개 토론 열람, N05 §3 종료 시장도, ADR-0069 결정 4 #47): 이 시장의 근거 글을 커뮤니티 목록과 같은 카드로 최신순 페이지마다, 지우거나 숨긴 글은 빼고, 그 목록 전체의 글 수(`meta.total`). 모든 공개 상태의 시장(초안과 없는 시장은 404). 작성자의 보유·주문·잔액은 싣지 않는다(N05 §2)',
    showsPerson:
      '근거 글의 작성자 표기(N05 §2, ADR-0069 결정 2 #45-9·결정 3 #37-3·#37-6·결정 5, 커뮤니티 목록과 같다): 작성자의 공개 id·지금 닉네임·이미지·운영자 표시만. 계정 id는 싣지 않는다',
  },
  'GET /posts': {
    reason:
      '커뮤니티 목록(#46, N05 §2 비로그인 열람, ADR-0069 결정 2 #45-7): 모든 시장의 근거 글을 최신순으로, 지우거나 숨긴 글은 빼고, 시장·카테고리 필터와 제목·본문 검색. 카드마다 제목·본문 앞부분·첫 이미지·작성 시각·수정 표시·시장(제목·상태·카테고리)·댓글 수(#48: 지우거나 숨기지 않은 댓글·대댓글)·좋아요 수(#49: 수만, 누른 사람과 보는 사람이 눌렀는지는 싣지 않는다)와 작성자. 작성자의 보유·주문·잔액은 싣지 않는다(N05 §2)',
    showsPerson:
      '근거 글의 작성자 표기(N05 §2, ADR-0069 결정 2 #45-9·결정 3 #37-3·#37-6·결정 5): 작성자의 공개 id·지금 닉네임·이미지·운영자 표시만. 계정 id는 싣지 않는다',
  },
  'GET /posts/:postId': {
    reason:
      '근거 글 화면(#46, N05 §2 비로그인 열람): 제목·본문(허용 목록의 서식, 이미지는 미디어 id)·작성 시각·수정 표시·시장·댓글 수(#48)·좋아요 수(#49: 수만, 누른 사람과 보는 사람이 눌렀는지는 싣지 않는다)와 작성자. 숨긴 글과 댓글이 달린 지운 글은 자리표시(시장과 댓글 수만, 좋아요 수는 없다)이고, 아래가 없는 지운 글은 없는 글처럼 404다(ADR-0069 결정 2 #45-5). 운영자만 보는 이전 내용·지운 원문은 싣지 않는다',
    showsPerson:
      '근거 글의 작성자 표기(N05 §2, ADR-0069 결정 2 #45-9·결정 3 #37-3·#37-6·결정 5): 작성자의 공개 id·지금 닉네임·이미지·운영자 표시만. 자리표시에는 작성자가 없다. 계정 id는 싣지 않는다',
  },
  'GET /posts/:postId/comments': {
    reason:
      '근거 글의 댓글·대댓글(#48, N05 §2 비로그인 열람, ADR-0069 결정 2 #45-2·#45-5): 댓글을 작성 순으로 20개까지 페이지마다, 댓글마다 그 아래 대댓글을 작성 순으로 처음 50개와 나머지의 커서(오너 결정 2026-10-21, ADR-0074). 본문(평문)·작성 시각·수정 표시·좋아요 수(#49: 수만, 누른 사람과 보는 사람이 눌렀는지는 싣지 않는다)와 작성자. 대댓글이 달린 지운 댓글과 숨긴 댓글은 자리표시(id만)이고, 그 밖의 지운 댓글은 싣지 않는다. 운영자만 보는 이전 내용·지운 원문은 싣지 않고, 작성자의 보유·주문·잔액도 싣지 않는다(N05 §2). 아래가 없는 지운 글은 404',
    showsPerson:
      '댓글·대댓글의 작성자 표기(N05 §2, ADR-0069 결정 2 #45-9·결정 3 #37-3·#37-6·결정 5, 글과 같다): 작성자의 공개 id·지금 닉네임·이미지·운영자 표시만. 자리표시에는 작성자가 없다. 계정 id는 싣지 않는다',
  },
  'GET /comments/:commentId/replies': {
    reason:
      "댓글의 대댓글 더 보기(#48, N05 §2 비로그인 열람, 오너 결정 2026-10-21 '답글 더 보기', ADR-0074): 한 댓글의 대댓글을 작성 순으로 커서 뒤 50개씩. 본문(평문)·작성 시각·수정 표시·좋아요 수(#49: 수만, 누른 사람과 보는 사람이 눌렀는지는 싣지 않는다)와 작성자. 숨긴 대댓글은 자리표시(id만)이고 지운 대댓글은 싣지 않는다. 운영자만 보는 이전 내용·지운 원문, 작성자의 보유·주문·잔액은 싣지 않는다(N05 §2). 없는 댓글·대댓글·아래가 없는 지운 댓글은 404",
    showsPerson:
      '대댓글의 작성자 표기(N05 §2, ADR-0069 결정 2 #45-9·결정 3 #37-3·#37-6·결정 5, 댓글 목록과 같다): 작성자의 공개 id·지금 닉네임·이미지·운영자 표시만. 자리표시에는 작성자가 없다. 계정 id는 싣지 않는다',
  },
  'GET /profiles/:publicId': {
    reason:
      '공개 프로필(#41, ADR-0069 결정 3 #37-1: 비로그인 열람, 검색 엔진 노출은 웹이 막는다): 공개 항목만 — 닉네임(지금 것, 이전 닉네임은 없다)·이미지·운영자 표시·소개(평문)·고른 관심 카테고리·가입 연·월(한국 시간, 그보다 자세한 시각은 없다)과 지우거나 숨기지 않은 글·댓글 수와 그것들이 받은 좋아요 합계(#37-4, 그 회원이 스스로 누른 것은 빼고, 수만이고 누른 사람은 싣지 않는다). 잔액·주문·보유·체결·손익·관심 시장·제안·본인확인·제재·연락처는 싣지 않는다(#37-8·#37-11~13). 없는 공개 id와 탈퇴한 계정은 404(#37-16)',
    showsPerson:
      '공개 프로필의 주인(ADR-0069 결정 3 #37-2·#37-3·#37-6·#37-7·결정 5): 그 사람의 공개 id·지금 닉네임·이미지·운영자 표시만, 글의 작성자 표기와 같은 얼굴로. 계정 id는 싣지 않는다',
  },
  'GET /profiles/:publicId/posts': {
    reason:
      '공개 프로필의 글 탭(#51, ADR-0069 결정 3 #37-1: 비로그인 열람, #37-14): 그 회원의 근거 글을 최신순으로, 커뮤니티 목록과 같은 카드(제목·본문 앞부분·첫 이미지·작성 시각·수정 표시·시장(제목·상태·카테고리)·댓글 수·좋아요 수 — 수만이고 누른 사람은 싣지 않는다, #49)로. 지우거나 숨긴 글은 빼고, 종료·무효 시장의 글과 제재 중인 사람의 글은 넣는다(#37-14, 프로필의 글 수와 같은 규칙 — 목록은 제재를 읽지 않는다). 작성자의 보유·주문·잔액·손익은 싣지 않는다(N04 §2, N05 §2). 없는 공개 id와 탈퇴한 계정은 프로필처럼 404(#37-16)',
    showsPerson:
      '프로필의 글의 작성자 표기(ADR-0069 결정 3 #37-3·#37-6·결정 5, 커뮤니티 카드와 같다): 그 회원의 공개 id·지금 닉네임·이미지·운영자 표시만. 계정 id는 싣지 않는다',
  },
  'GET /profiles/:publicId/comments': {
    reason:
      '공개 프로필의 댓글 탭(#51, ADR-0069 결정 3 #37-1·#37-14): 그 회원의 댓글·대댓글을 최신순으로, 본문(평문)·작성 시각·수정 표시·좋아요 수(수만, #49)와 그 댓글이 달린 글(공개된 글은 제목과 본문 앞부분, 지운 글의 자리표시와 숨긴 글은 id만)과 그 글의 시장. 지우거나 숨긴 댓글은 빼고, 숨긴 글이나 자리표시로 남은 지운 글 아래의 댓글, 종료·무효 시장의 댓글과 제재 중인 사람의 댓글은 넣는다(#37-14, 프로필의 댓글 수와 같은 규칙). 작성자의 보유·주문·잔액·손익은 싣지 않는다(N04 §2, N05 §2). 없는 공개 id와 탈퇴한 계정은 404(#37-16)',
    showsPerson:
      '프로필의 댓글의 작성자 표기(ADR-0069 결정 3 #37-3·#37-6·결정 5, 글의 댓글과 같다): 그 회원의 공개 id·지금 닉네임·이미지·운영자 표시만. 계정 id는 싣지 않는다',
  },
  'GET /media/:mediaId': {
    reason:
      '근거 글과 운영 공지의 이미지(#46·#138, ADR-0069 결정 2 #45-3·결정 4 #138)와 프로필 이미지(#141, 결정 3 #37-6: 공개 프로필과 작성자 표기에 보인다): 지우거나 숨기지 않은 글의 지금 본문과 고정한 공지의 지금 본문에 있는 이미지와, 회원이 지금 프로필 이미지로 둔 이미지의 바이트만(서버가 EXIF를 지우고 다시 인코딩한 것). 그 밖의 이미지(어느 글·공지도 쓰지 않은 업로드, 수정으로 뺀 이미지, 지우거나 숨긴 글의 이미지, 고정하지 않았거나 고정을 푼 공지의 이미지 — 오너 결정 2026-10-21, 운영자가 내려 운영자만 보게 남긴 프로필 이미지)는 404이고, 올린 계정은 싣지 않는다',
  },
  'GET /notices': {
    reason:
      '커뮤니티 목록 위의 고정 공지(#138, ADR-0069 결정 2 #45-8, 비로그인 열람): 지금 고정한 공지(최대 3개)의 제목·작성 시각·수정 표시만, 최근에 고정한 것부터. 공지는 운영팀의 것으로 보이고(웹이 쓴다) 쓰거나 고정한 운영자와 운영 기록은 싣지 않는다',
  },
  'GET /notices/:noticeId': {
    reason:
      '운영 공지 화면(#138, 비로그인 열람): 고정한 공지의 제목·본문(근거 글과 같은 허용 목록의 서식, 이미지는 미디어 id)·작성 시각·수정 표시. 고정하지 않았거나 고정을 푼 공지는 없는 공지처럼 404다(오너 결정 2026-10-21). 쓴 운영자·운영 기록·운영자만 보는 이전 내용은 싣지 않는다',
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
    reason:
      '본인 계정: 이메일·프로필·잔액·로그인 수단과 본인확인 기록(확인한 휴대전화·실명·확인 시각, ADR-0070), 시작 Coin의 지급 대기·지급(금액·시각, ADR-0071)과 그 번호로는 받을 수 없는지(#58), 온보딩의 단계와 항목마다의 가장 새 동의(항목·판·동의 여부·시각, 접속 주소와 브라우저는 싣지 않는다)·다음 닉네임 변경 가능 시각·관심 카테고리(#58), 공개 프로필의 소개(#41)(N04 §2)',
  },
  'PATCH /me': {
    reason:
      '본인 닉네임 변경(#58, ADR-0069 결정 1 #57-6): 세션 계정의 닉네임만 규칙과 30일 간격대로 바꾸고 비운 닉네임을 다른 계정에 30일 막는다. 온보딩을 마친 계정만이다 — 첫 닉네임은 닉네임 단계가 정하고, 재동의가 남은 계정은 다시 동의한 뒤에 바꾼다(오너 결정 2026-10-22 답 1, ADR-0078). 공개 프로필 항목이라 작성 제한·계정 제한 중에는 바꾸지 않는다(#41, #37-9). 본문의 expectedAccountId가 세션 계정이어야 한다',
    onboarded: true,
  },
  'POST /me/consents': {
    reason:
      '본인 약관 동의(#58, ADR-0069 결정 1 #57-5): 세션 계정의 동의 단계가 묻는 항목(재동의면 서지 않게 된 항목만)과 MY 설정의 마케팅 정보 수신 켜고 끄기를 지금 판으로 기록하고(동의 시각·접속 주소·브라우저 정보를 함께 남긴다) 본인 계정을 돌려준다. 본문의 expectedAccountId가 세션 계정이어야 한다',
  },
  'POST /me/onboarding/nickname': {
    reason:
      '본인 온보딩의 닉네임 설정(#58, ADR-0069 결정 1 #57-6): 약관 동의와 본인확인을 마친 세션 계정의 닉네임을 확정하고 그 계정의 시작 Coin을 지급하거나 대기시킨다(#70). 본문의 expectedAccountId가 세션 계정이어야 한다',
  },
  'POST /me/onboarding/interests': {
    reason:
      '본인 온보딩의 관심 카테고리 단계(#58, ADR-0069 결정 1 #57-7): 세션 계정의 고르기·건너뛰기를 받는다. 화면은 계정이 시작 Coin 안내나 관심 카테고리 화면을 답하지 않고 떠날 때도(로그아웃은 세션을 끝내기 전에) 건너뛰기를 보내고, 서버는 그것을 그 단계의 답으로 남긴다(오너 결정 2026-10-21 2차 답 2, 닿지 않는 때는 ADR-0078 7-23). 단계에 아직 답하지 않았고 닉네임 단계 뒤 24시간 안이면 그 첫 답이고 온보딩을 마친 계정만이며(서비스가 트랜잭션 안에서 묻는다, OnboardedGuard 없음), 공개 프로필 항목이지만 처음 고르는 것이라 작성 제한·계정 제한 중에도 받는다(오너 결정 2026-10-21 답 4). 24시간이 지났으면 고르기는 MY 설정의 변경과 같고(제재 중 거절) 건너뛰기는 그 단계를 건너뛴 것으로 남긴다(온보딩을 마친 계정만, 오너 결정 2026-10-21 3차 답 1). 답한 뒤에는 건너뛰기는 아무것도 바꾸지 않고 고르기는 MY 설정의 변경과 같다. 본문의 expectedAccountId가 세션 계정이어야 한다',
  },
  'PUT /me/interest-categories': {
    reason:
      '본인 관심 카테고리의 MY 설정 수정(#41): 세션 계정의 관심 카테고리만 바꾼다. 온보딩 단계의 첫 답이 되지 않는다 — 온보딩 화면을 떠난 계정은 그 단계를 건너뛰었으므로 여기서 처음 고르는 것도 변경이다(오너 결정 2026-10-21 2차 답 2). 새 카테고리를 더하는 것은 온보딩을 마친 계정만이고, 고른 것을 빼기만 하는 것은 로그인만 본다(재동의만 남은 계정도, 오너 결정 2026-10-21 답 2) — 그래서 OnboardedGuard 대신 서비스가 트랜잭션 안에서 묻는다. 공개 프로필 항목이라 작성 제한·계정 제한 중에는 빼기만 받는다(#37-9, 결정 7). 본문의 expectedAccountId가 세션 계정이어야 한다',
  },
  'POST /posts': {
    reason:
      '근거 글 쓰기(#46, ADR-0069 결정 2 #45-1·#45-3·#45-6): 온보딩을 마친 세션 계정이 공개 상태의 시장 하나에 제목(선택)과 서식 있는 본문을 쓴다. 본문의 이미지는 세션 계정이 올린 것만 받는다. 보유·주문·확률은 받지도 붙이지도 않는다(N05 §2). 본문의 expectedAccountId가 세션 계정이어야 한다',
    onboarded: true,
  },
  'PUT /posts/:postId': {
    reason:
      '근거 글 고치기(#46, ADR-0069 결정 2 #45-4): 세션 계정이 쓴 글의 제목·본문만 바꾸고(시장은 못 바꾼다) 이전 내용을 운영자 전용 이력에 남긴다. 다른 계정의 글은 403, 숨긴 글은 409. 본문의 expectedAccountId가 세션 계정이어야 한다',
    onboarded: true,
  },
  'POST /posts/:postId/delete': {
    reason:
      '근거 글 지우기(#46, ADR-0069 결정 2 #45-5): 세션 계정이 쓴 글만 지운다(원문은 운영자만 보게 남는다). 다른 계정의 글은 403. 로그인만 보고 온보딩·재동의는 보지 않는다(오너 결정 2026-10-19, ADR-0073). 본문의 expectedAccountId가 세션 계정이어야 한다',
  },
  'POST /posts/:postId/comments': {
    reason:
      '댓글·대댓글 쓰기(#48, ADR-0069 결정 2 #45-2·#45-3·#45-5): 온보딩을 마친 세션 계정이 글에 평문 댓글을, 또는 댓글 아래 대댓글을 쓴다(대댓글에 답하면 그 대댓글의 댓글 아래). 숨기거나 지운 글·댓글에는 받지 않는다(409). 보유·주문·확률은 받지도 붙이지도 않는다(N05 §2). 본문의 expectedAccountId가 세션 계정이어야 한다',
    onboarded: true,
  },
  'PUT /comments/:commentId': {
    reason:
      '댓글 고치기(#48, ADR-0069 결정 2 #45-4): 세션 계정이 쓴 댓글·대댓글의 본문만 바꾸고 이전 내용을 운영자 전용 이력에 남긴다. 다른 계정의 댓글은 403, 숨긴 댓글은 409. 본문의 expectedAccountId가 세션 계정이어야 한다',
    onboarded: true,
  },
  'POST /comments/:commentId/delete': {
    reason:
      '댓글 지우기(#48, ADR-0069 결정 2 #45-5·#45-12): 세션 계정이 쓴 댓글·대댓글만 지운다(원문은 운영자만 보게 남는다). 로그인만 본다 — 자기 글의 삭제는 온보딩·제재와 상관없이 열려 있다. 다른 계정의 댓글은 403. 본문의 expectedAccountId가 세션 계정이어야 한다',
  },
  'PUT /posts/:postId/like': {
    reason:
      '근거 글 좋아요·취소(#49, ADR-0069 결정 4): 온보딩을 마친 세션 계정의 좋아요 하나만 쓰거나 지운다(본인확인한 번호마다·계정마다 한 번, 결정 7). 자기 글도 받고, 지운 글의 자리표시와 숨긴 글은 받지 않는다(409). 답은 세션 계정이 눌렀는지와 그 글의 좋아요 수뿐이고 누른 사람은 싣지 않는다. Coin·원장·점수·알림을 만들지 않는다. 본문의 expectedAccountId가 세션 계정이어야 한다',
    onboarded: true,
  },
  'PUT /comments/:commentId/like': {
    reason:
      '댓글·대댓글 좋아요·취소(#49, ADR-0069 결정 4): 글의 좋아요와 같다 — 온보딩을 마친 세션 계정의 좋아요 하나만, 지운 댓글의 자리표시와 숨긴 댓글은 받지 않는다(409). 답은 세션 계정이 눌렀는지와 그 댓글의 좋아요 수뿐이다. 본문의 expectedAccountId가 세션 계정이어야 한다',
    onboarded: true,
  },
  'GET /me/likes/posts/:postId': {
    reason:
      '본인이 한 글 화면에서 누른 좋아요(#49, ADR-0069 결정 4: 본인은 자기가 눌렀는지 본다): 세션 계정(이나 그 본인확인한 번호)이 그 글과 그 아래 댓글·대댓글 가운데 무엇을 눌렀는지만. 수와 다른 사람의 좋아요는 없다',
  },
  'GET /me/posts': {
    reason:
      '본인 MY 내 글의 글 탭(#51, ADR-0069 결정 4 #51: 필터 없이 최신순, 결정 2 #45-5): 세션 계정이 쓴 근거 글을 커뮤니티 카드로. 운영자가 숨긴 글도 넣고 숨김 표시와 그 사유(#50의 숨김이 기록한 신고 사유 하나와 운영자 설명)를 붙이며, 지운 글은 넣지 않는다. 숨긴 사람·신고자는 싣지 않는다(#45-13)',
  },
  'GET /me/comments': {
    reason:
      '본인 MY 내 글의 댓글 탭(#51, ADR-0069 결정 4 #51, 결정 2 #45-5): 세션 계정이 쓴 댓글·대댓글을 최신순으로, 그 댓글이 달린 글(공개된 글은 제목과 본문 앞부분, 자리표시는 id만)과 시장과 함께. 운영자가 숨긴 댓글도 넣고 숨김 표시와 그 사유를 붙이며, 지운 댓글은 넣지 않는다. 숨긴 사람·신고자는 싣지 않는다(#45-13)',
  },
  'POST /posts/:postId/reports': {
    reason:
      '근거 글 신고(#50, ADR-0069 결정 2 #45-10·#45-15·결정 7): 온보딩을 마친 세션 계정이 다른 회원의 글 하나를 사유 하나(기타는 설명 필수)로 신고하고, 그 신고를 본인 목록의 모양으로 돌려받는다. 자기 글·지운 글의 자리표시·숨긴 글은 받지 않고(409), 같은 사람(본인확인한 번호)의 처리 전 신고가 있으면 받지 않으며(409), 같은 사람의 지난 24시간 20건을 넘으면 받지 않는다(429, 운영자 예외). 신고는 무엇도 숨기지 않는다. 신고당한 회원·신고 수는 답에 없다. 본문의 expectedAccountId가 세션 계정이어야 한다',
    onboarded: true,
  },
  'POST /comments/:commentId/reports': {
    reason:
      '댓글·대댓글 신고(#50, ADR-0069 결정 2 #45-10): 글의 신고와 같다 — 온보딩을 마친 세션 계정이 다른 회원의 댓글 하나를 사유 하나로 신고하고 본인 목록의 모양으로 돌려받는다. 본문의 expectedAccountId가 세션 계정이어야 한다',
    onboarded: true,
  },
  'POST /profiles/:publicId/reports': {
    reason:
      '프로필 신고(#50, ADR-0069 결정 3 #37-10: 글과 같은 사유 목록): 온보딩을 마친 세션 계정이 다른 회원의 공개 프로필(닉네임·이미지·소개)을 신고하고 본인 목록의 모양으로 돌려받는다. 없는 공개 id와 탈퇴한 계정은 프로필처럼 404. 본문의 expectedAccountId가 세션 계정이어야 한다',
    onboarded: true,
  },
  'GET /me/reports': {
    reason:
      '본인이 낸 신고와 그 처리 결과(#50, ADR-0069 결정 2 #45-13, 결정 4 #50): 세션 계정이 낸 신고만 최신순으로 — 대상(공개가 지금 보는 대로: 공개된 글·댓글은 제목·앞부분, 자리표시는 id만, 프로필은 공개 얼굴), 사유·설명, 접수 시각, 결과(접수·조치함·기각)와 처리 시각. 어떤 조치였는지와 처리한 운영자는 싣지 않는다',
  },
  'GET /me/moderation/actions': {
    reason:
      '본인이 받은 운영 조치(#50, ADR-0069 결정 2 #45-13: 조치 종류·사유·기간·이의 방법, 결정 4 #50): 세션 계정에 내려진 조치만 최신순으로 — 종류, 사유(신고 사유 하나와 운영자 설명), 무엇에 대한 것인지(본인의 글·댓글은 제목·앞부분, 지운 것은 id만), 끝나는 시각(제한의 것, #185·#139)과 취소 시각. 신고·신고자와 처리한 운영자는 싣지 않는다(#45-13). 공개 응답에는 어느 조치도 싣지 않는다(내부 위험 플래그, #45-12)',
  },
  'GET /me/moderation/restriction': {
    reason:
      '본인에게 지금 서 있는 작성 제한(#185, ADR-0069 결정 4 #50: 진행 중인 제재의 안내 띠): 세션 계정의 것만 — 제한의 종류와 끝나는 시각(무기한은 null, 여럿이면 거절이 말하는 그 끝 — 무기한이 먼저, 아니면 가장 늦은 끝), 없으면 null. 사유·조치한 운영자·신고는 싣지 않는다(#45-13). 공개 응답에는 싣지 않는다(내부 위험 플래그, #45-12)',
  },
  'POST /media/images': {
    reason:
      '근거 글 이미지 올리기(#46, ADR-0069 결정 2 #45-3): 온보딩을 마친 세션 계정이 보낸 파일을 내용으로 검사하고 EXIF를 지우고 줄여 비공개 저장소에 두며, 그 이미지의 id·형식·크기만 돌려준다. 파일이 본문이라 쿼리의 expectedAccountId가 세션 계정이어야 한다',
    onboarded: true,
  },
  'PUT /me/bio': {
    reason:
      '본인 공개 프로필의 소개(#41, ADR-0069 결정 3 #37-3, 결정 4 #41: MY 설정에서 고친다): 세션 계정의 소개만 평문 160자로 바꾸거나 비운다. 글자를 쓰는 것은 온보딩을 마친 계정만이고, 비우기는 로그인만 본다(재동의만 남은 계정도, 오너 결정 2026-10-21 답 2) — 그래서 OnboardedGuard 대신 서비스가 트랜잭션 안에서 묻는다. 작성 제한·계정 제한 중에는 비우기만 받는다(#37-9, 결정 7). 본문의 expectedAccountId가 세션 계정이어야 한다',
  },
  'PUT /me/profile-image': {
    reason:
      '본인 공개 프로필의 이미지 올리기(#141, ADR-0069 결정 3 #37-6, 결정 4 #141): 온보딩을 마친 세션 계정이 보낸 파일을 내용으로 검사해(JPEG·PNG·WebP, 5MB, 긴 변이 짧은 변의 32배 이하) 가운데를 정사각형으로 잘라(512px까지 줄이고 키우지 않는다) EXIF를 지워 비공개 저장소에 두고 세션 계정의 프로필 이미지로 삼으며, 앞의 이미지는 곧바로 지운다. 작성 제한·계정 제한 중에는 받지 않는다(#37-9, 결정 7). 답은 세션 계정의 Me다. 파일이 본문이라 쿼리의 expectedAccountId가 세션 계정이어야 한다',
    onboarded: true,
  },
  'POST /me/profile-image/delete': {
    reason:
      '본인 공개 프로필의 이미지 지우기(#141, ADR-0069 결정 4 #141): 세션 계정의 프로필 이미지를 곧바로 지운다(행과 저장소의 바이트). 비우기라 로그인만 보고(재동의만 남은 계정도 — 오너 결정 2026-10-22, #41의 소개·관심 카테고리와 같다) 작성 제한·계정 제한 중에도 받는다(#37-9, 결정 7). 답은 세션 계정의 Me다. 본문의 expectedAccountId가 세션 계정이어야 한다',
  },
  'POST /me/password': {
    reason: '본인 첫 비밀번호 설정: 본문의 expectedAccountId가 세션 계정이어야 한다',
  },
  'POST /me/phone-verification/code': {
    reason:
      '본인확인 인증번호 발송(#183, ADR-0070): 세션 계정이 적은 실명·휴대전화 번호로 인증번호를 SMS로 보내고 남은 유효 시간과 다시 받기까지의 시간만 돌려준다. 본문의 expectedAccountId가 세션 계정이어야 한다',
  },
  'POST /me/phone-verification/confirm': {
    reason:
      '본인확인 완료(#183, ADR-0070): 세션 계정에 마지막으로 보낸 인증번호와 맞을 때만 세션 계정의 본인확인 기록을 쓰고 그것을 돌려준다. 본문의 expectedAccountId가 세션 계정이어야 한다',
  },
  'PUT /me/real-name': {
    reason:
      '본인 실명 수정(ADR-0069 결정 1 #57-3, ADR-0070): 세션 계정의 본인확인 기록의 실명만 바꾸고(번호는 바꾸지 않는다) 본문의 expectedAccountId가 세션 계정이어야 한다',
  },
  'PUT /me/time-zone': {
    reason:
      '본인 표시 시간대 저장·해제(ADR-0063): 세션 계정의 프로필만 바꾸고, 본인확인처럼 본문의 expectedAccountId가 세션 계정이어야 한다',
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
  'GET /me/watchlist': {
    reason:
      '본인 관심 시장 목록(#89, ADR-0064·0065): 세션 계정이 지금 등록한 시장만, 최근 등록 순(기본)이나 홈의 추천·신규·마감 임박. 관심 시장은 본인 밖의 누구에게도 보이지 않는다(#37)',
  },
  'GET /me/watchlist/:marketId': {
    reason:
      '본인이 한 시장을 관심 등록했는지(#89, ADR-0064): 세션 계정의 등록 여부만, 시장의 등록 수는 없다',
  },
  'PUT /me/watchlist/:marketId': {
    reason:
      '본인 관심 등록·해제(#89, ADR-0064): 세션 계정의 행과 이력만 쓰고, 시간대처럼 본문의 expectedAccountId가 세션 계정이어야 한다',
  },
  'GET /me/search-history': {
    reason:
      '본인 최근 검색(#15, ADR-0066): 세션 계정이 검색한 검색어 가운데 중복 없이 최근 10개와 시각만. 공개 답과 시장 채널에는 싣지 않는다(PRIVATE_DATA search-history, ADR-0066의 선택). 운영자가 볼 수 있는 범위는 #37 11항',
  },
  'POST /me/search-history': {
    reason:
      '본인 검색 기록 남기기(#15, ADR-0066): 로그인한 회원이 제출한 검색어 하나를 세션 계정의 기록에만 쓰고, 관심 등록처럼 본문의 expectedAccountId가 세션 계정이어야 한다',
  },
  'POST /me/search-history/:id/delete': {
    reason:
      '본인 최근 검색 하나 지우기(#15, ADR-0066): 세션 계정의 행 가운데 그 검색어의 것만 지우고, 본문의 expectedAccountId가 세션 계정이어야 한다',
  },
  'POST /me/search-history/clear': {
    reason:
      '본인 검색 기록 전체 지우기(#15, ADR-0066): 세션 계정의 행만 지우고, 본문의 expectedAccountId가 세션 계정이어야 한다',
  },
  'GET /me/closure': {
    reason:
      '본인 탈퇴의 확인 화면(#140, ADR-0069 결정 4 #140 «남은 Coin의 소멸과 되돌릴 수 없음을 한 화면에»): 세션 계정이 지금 탈퇴하면 소멸할 Coin(사용 가능 잔액)과 지금 탈퇴를 막는 것 — 관리자 권한, 정산되지 않은 계약, 진행 중인 결제·환불, 대기 주문의 까닭과 서 있는 작성 제한·계정 제한의 종류와 끝 — 만. 다른 계정의 것은 없다',
  },
  'POST /me/closure': {
    reason:
      "본인 탈퇴(#140, ADR-0069 결정 1 #57-15~18, 결정 3 #37-15~17, 결정 4 #140): 세션 계정만 '탈퇴'를 직접 입력해 곧바로 닫는다 — 남은 Coin을 원장의 '탈퇴 소멸'로 소멸하고, 실명·휴대전화(본인확인 기록)·이메일·로그인 수단·세션·공개 항목·프로필 이미지·관심 시장·검색 기록을 지우며, 작성자 자리는 '탈퇴한 사용자'가 된다. 운영자의 대리 탈퇴는 없다(#57-17). 작성 제한·계정 제한 중에는 받지 않는다(결정 4 #140). 본문의 expectedAccountId가 세션 계정이어야 한다",
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
 * serves (owner decision 2026-10-13 #113 (a)): a plugin (a phone-number sign-in, say; #183's SMS
 * code is the API's own, ADR-0070) or an upgrade that adds an endpoint is refused until it is
 * written here. Keys are `METHOD /path`.
 * `/sign-up/email` is disabled (ADR-0024): RegistrationService calls it on the server only.
 * `/update-user` is disabled (ADR-0072): it writes only better-auth's name and photo, which the
 * service does not keep (a social login's are not stored, 오너 결정 2026-10-19 (2차) 3). So is
 * `/account-info` (ADR-0072 7-31): its answer is the linked provider's name and photo. And
 * `/get-access-token` and `/refresh-token` (오너 결정 2026-10-19 (4차) 1, 7-31): they hand out the
 * linked provider's access and refresh tokens, which the service does not keep.
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
