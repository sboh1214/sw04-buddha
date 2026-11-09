/**
 * PLAN M6 "보안: … 관리자 라우트 감사 로그 완전성 확인".
 *
 * The individual suites already prove that each admin write leaves the RIGHT `admin_actions`
 * row — `charge-package.controller.test` and `coupon.controller.test` for the catalogue,
 * `admin-markets.controller.test` and `admin-markets-lifecycle.controller.test` for the market
 * transitions, `admin-markets-review.controller.test` for the market review (#78),
 * `admin-markets-supplement.controller.test` for the rule supplements (#80),
 * `admin-market-pauses.controller.test` for the pauses and their next paths (#114),
 * `admin-market-judgements.controller.test` for the judgements (#152),
 * `admin-market-judgement-delays.controller.test` for the judgement delay records (#142),
 * `related-markets.controller.test` for the links between markets,
 * `moderation.controller.test` for the moderation actions and the dismissals of reports (#50),
 * `restrictions.controller.test` for the writing restrictions and their shortenings and lifts
 * (#185),
 * `admin-themes.controller.test` for the themes, their markets and notices,
 * `admin-categories.controller.test` for the categories' creation, renames, order and hiding,
 * `admin-proposals.controller.test` for the review of market proposals,
 * `release-settings.controller.test` for the release settings,
 * `admin-accounts.controller.test` for the admin grants and revokes,
 * `notices.controller.test` for the notices' writes, pins and unpins and
 * `link-review.test` for the marks on the repeated-link review list. What none of them can
 * prove is COMPLETENESS: they assert about routes that exist, so an admin write added tomorrow
 * with no audit row would break nothing.
 *
 * This closes that. It discovers every admin route from the module graph — not from a list
 * maintained here — and requires each state-changing one to name the `ADMIN_ACTION_TYPES` value
 * it writes. A new admin mutation fails this test until someone writes down what it records,
 * and a `ADMIN_ACTION_TYPES` value that no route produces fails it too, so the enum cannot
 * drift into fiction either — unless it is RETIRED: written by a route that is gone, and kept so
 * the rows it left still parse and render.
 *
 * Static, and deliberately: it reads route metadata, so it needs no Postgres, no Redis and no
 * file lock, and it runs in every environment.
 */
import { ADMIN_ACTION_TYPES, type AdminActionType } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { discoverRoutes, isAdminPath } from '../test/routes.js';

/**
 * What each state-changing admin route appends to `admin_actions`.
 *
 * A route may appear here only if the service behind it inserts that row IN THE SAME
 * TRANSACTION as the effect — an audit row that can commit without its effect, or the other way
 * round, is worse than none. Every entry below was checked against its `tx.insert(adminActions)`
 * call site.
 */
const AUDITED: Readonly<Record<string, AdminActionType>> = {
  'POST /admin/charge-packages': 'charge_package_create',
  'PATCH /admin/charge-packages/:id': 'charge_package_update',
  'DELETE /admin/charge-packages/:id': 'charge_package_delete',
  'POST /admin/coupons': 'coupon_create',
  'PATCH /admin/coupons/:id': 'coupon_update',
  'POST /admin/markets': 'market_create',
  'PATCH /admin/markets/:id': 'market_update',
  // #78: the review's writes, each with the market's own review event.
  'POST /admin/markets/:id/submit': 'market_submit',
  'POST /admin/markets/:id/approve': 'market_approve',
  'POST /admin/markets/:id/reject': 'market_reject',
  'POST /admin/markets/:id/revert': 'market_revert',
  'POST /admin/markets/:id/reschedule': 'market_reschedule',
  // #119: one admin changes an open or paused market's 가격 보호 폭, with the market's own event
  // (`price_protection_changed`).
  'POST /admin/markets/:id/price-protection': 'market_price_protection_change',
  // #80: a rule supplement is a request, then another admin's decision or its requester's
  // retraction; only the approval also writes the market's event.
  'POST /admin/markets/:id/supplements': 'market_supplement_request',
  'POST /admin/markets/:id/supplements/:requestId/approve': 'market_supplement_approve',
  'POST /admin/markets/:id/supplements/:requestId/reject': 'market_supplement_reject',
  'POST /admin/markets/:id/supplements/:requestId/retract': 'market_supplement_retract',
  // #114: one admin pauses (with the market's `paused` event); the next path is a request, then
  // another admin's decision or its requester's retraction, and only the approval also writes the
  // market's event (`resumed` or `closed`).
  'POST /admin/markets/:id/pause': 'market_pause',
  'POST /admin/markets/:id/pause-decisions': 'market_pause_decision_request',
  'POST /admin/markets/:id/pause-decisions/:requestId/approve': 'market_pause_decision_approve',
  'POST /admin/markets/:id/pause-decisions/:requestId/reject': 'market_pause_decision_reject',
  'POST /admin/markets/:id/pause-decisions/:requestId/retract': 'market_pause_decision_retract',
  'POST /admin/markets/:id/cancel-requests': 'market_cancel_request',
  'POST /admin/markets/:id/cancel-requests/:requestId/approve': 'market_cancel_approve',
  'POST /admin/markets/:id/cancel-requests/:requestId/reject': 'market_cancel_reject',
  'POST /admin/markets/:id/cancel-requests/:requestId/retract': 'market_cancel_retract',
  // #152: a judgement is a registration, then another admin's decision or its registrant's
  // retraction; only the approval also writes the market's event (`provisional`).
  'POST /admin/markets/:id/judgements': 'market_judgement_request',
  'POST /admin/markets/:id/judgements/:requestId/approve': 'market_judgement_approve',
  'POST /admin/markets/:id/judgements/:requestId/reject': 'market_judgement_reject',
  'POST /admin/markets/:id/judgements/:requestId/retract': 'market_judgement_retract',
  // #175: a 판정 이의 is decided by one admin, not an approval request; neither decision writes a
  // market event (the member's submission and 철회 are no admin route and write none).
  'POST /admin/markets/:id/disputes/:disputeId/dismiss': 'market_dispute_dismiss',
  'POST /admin/markets/:id/disputes/:disputeId/accept': 'market_dispute_accept',
  // #142: a 판정 지연 기록 is one admin's, not an approval request, with the market's own event
  // (`judgement_delay_recorded`); there is no edit or withdrawal route.
  'POST /admin/markets/:id/judgement-delays': 'market_delay_record',
  'POST /admin/markets/:id/related': 'market_link',
  'DELETE /admin/markets/:id/related/:relatedMarketId': 'market_unlink',
  'POST /admin/themes': 'theme_create',
  'PATCH /admin/themes/:id': 'theme_update',
  'POST /admin/themes/:id/publish': 'theme_publish',
  'POST /admin/themes/:id/unpublish': 'theme_unpublish',
  'POST /admin/themes/:id/markets': 'theme_market_link',
  'DELETE /admin/themes/:id/markets/:marketId': 'theme_market_unlink',
  'POST /admin/themes/:id/notices': 'theme_notice_create',
  'PATCH /admin/themes/:id/notices/:noticeId': 'theme_notice_update',
  'POST /admin/themes/:id/notices/:noticeId/hide': 'theme_notice_hide',
  'POST /admin/themes/:id/notices/:noticeId/show': 'theme_notice_show',
  'POST /admin/categories': 'category_create',
  'PATCH /admin/categories/:id': 'category_rename',
  'PUT /admin/categories/order': 'category_reorder',
  'POST /admin/categories/:id/hide': 'category_hide',
  'POST /admin/categories/:id/show': 'category_show',
  'POST /admin/payments/:id/refund': 'payment_refund',
  'PATCH /admin/release-settings/:key': 'release_setting_change',
  'POST /admin/admins': 'admin_grant',
  'POST /admin/admins/:userId/revoke': 'admin_revoke',
  'POST /admin/notices': 'notice_create',
  'PUT /admin/notices/:noticeId': 'notice_update',
  'POST /admin/notices/:noticeId/pin': 'notice_pin',
  'POST /admin/notices/:noticeId/unpin': 'notice_unpin',
  'POST /admin/moderation/posts/:postId/hide': 'moderation_post_hide',
  'POST /admin/moderation/comments/:commentId/hide': 'moderation_comment_hide',
  'POST /admin/moderation/users/:userId/warn': 'moderation_warning',
  'POST /admin/moderation/users/:userId/nickname-reset': 'moderation_nickname_reset',
  'POST /admin/moderation/users/:userId/bio-clear': 'moderation_bio_clear',
  'POST /admin/moderation/users/:userId/image-remove': 'moderation_image_remove',
  'POST /admin/moderation/actions/:actionId/cancel': 'moderation_cancel',
  'POST /admin/reports/dismiss': 'report_dismiss',
  'POST /admin/moderation/users/:userId/writing-restriction': 'moderation_writing_restriction',
  'POST /admin/moderation/actions/:actionId/shorten': 'moderation_restriction_shorten',
  'POST /admin/moderation/actions/:actionId/lift': 'moderation_restriction_lift',
  'POST /admin/link-flags/reviews': 'link_flag_review',
  // #139: every account restriction step is a request, then another admin's decision.
  'POST /admin/moderation/users/:userId/account-restriction': 'account_restriction_request',
  'POST /admin/moderation/actions/:actionId/account-restriction/shorten':
    'account_restriction_shorten_request',
  'POST /admin/moderation/actions/:actionId/account-restriction/lift':
    'account_restriction_lift_request',
  'POST /admin/moderation/actions/:actionId/account-restriction/cancel':
    'account_restriction_cancel_request',
  'POST /admin/moderation/account-restriction-requests/:requestId/approve':
    'account_restriction_approve',
  'POST /admin/moderation/account-restriction-requests/:requestId/reject':
    'account_restriction_reject',
  // Owner decision 2026-10-23: the one who asked may retract a request before its decision.
  'POST /admin/moderation/account-restriction-requests/:requestId/retract':
    'account_restriction_retract',
  'POST /admin/proposals/:id/review': 'proposal_review',
  'POST /admin/proposals/:id/adopt': 'proposal_adopt',
  'POST /admin/proposals/:id/market': 'proposal_link',
  'PUT /admin/proposals/:id/internal-memo': 'proposal_memo',
  'POST /admin/proposals/:id/reject': 'proposal_reject',
};

/**
 * ADMIN_ACTION_TYPES no route writes any more, each with the route that did. The type stays in
 * the enum because deployed `admin_actions` rows carry it and the audit log must still read them;
 * no route may name it again (the AUDITED map above refuses it below).
 */
const RETIRED: Readonly<Partial<Record<AdminActionType, string>>> = {
  // The interim draft → open, `POST /admin/markets/:id/open`, gone with #21 (ADR-0100): a market
  // opens from SCHEDULED alone, recorded by its `opened` event.
  market_open: 'POST /admin/markets/:id/open',
  // The interim one-admin open → closed, `POST /admin/markets/:id/close`, gone with #114
  // (ADR-0102): a market closes at its close, or early from PAUSED by another admin's approval.
  market_close: 'POST /admin/markets/:id/close',
  // The interim one-admin closed → resolved, `POST /admin/markets/:id/resolve`, gone with #152
  // (ADR-0103): a judgement is registered by one admin and approved by another (PROVISIONAL), and
  // the worker confirms it at its dispute deadline.
  market_resolve: 'POST /admin/markets/:id/resolve',
};

const adminRoutes = discoverRoutes().filter((route) => isAdminPath(route.path));
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

describe('admin audit log completeness', () => {
  it('finds the admin surface at all', () => {
    // A guard on the discovery itself: if the walk broke, every assertion below would pass
    // vacuously and this test would go on reporting success while checking nothing.
    expect(adminRoutes.length).toBeGreaterThanOrEqual(15);
    expect(adminRoutes.map((route) => route.key)).toContain(
      'POST /admin/markets/:id/judgements/:requestId/approve',
    );
  });

  it('records an admin_actions row for every state-changing admin route', () => {
    const unaudited = adminRoutes
      .filter((route) => !SAFE_METHODS.has(route.method))
      .filter((route) => AUDITED[route.key] === undefined)
      .map((route) => route.key);
    expect(unaudited).toEqual([]);
  });

  it('leaves read-only admin routes unaudited, on purpose', () => {
    // PLAN 6.2/12 specify an ACTION log, not an access log. Logging reads would multiply the
    // writes of a list route by its page count and record nothing that changed; if the owner
    // ever wants admin reads recorded, that is a new ADMIN_ACTION_TYPES value and a decision
    // about write amplification, not an oversight to fix quietly.
    const audited = adminRoutes
      .filter((route) => SAFE_METHODS.has(route.method))
      .filter((route) => AUDITED[route.key] !== undefined);
    expect(audited).toEqual([]);
  });

  it('uses every ADMIN_ACTION_TYPES value exactly once, but the retired ones', () => {
    const used = Object.values(AUDITED);
    const retired = Object.keys(RETIRED) as AdminActionType[];
    // Every type is produced by some route: a value nothing writes is a value a reader of the
    // enum would look for in the audit log and never find — unless it is retired, which only
    // history carries.
    expect([...used, ...retired].sort()).toEqual([...ADMIN_ACTION_TYPES].sort());
    expect(new Set(used).size).toBe(used.length);
    expect(used.filter((type) => retired.includes(type))).toEqual([]);
  });

  it('serves no route a retired type was written by', () => {
    const keys = new Set(adminRoutes.map((route) => route.key));
    expect(Object.values(RETIRED).filter((key) => keys.has(key))).toEqual([]);
  });

  it('audits nothing outside /admin', () => {
    const keys = new Set(adminRoutes.map((route) => route.key));
    expect(Object.keys(AUDITED).filter((key) => !keys.has(key))).toEqual([]);
  });
});
