/**
 * Relational-query metadata for `db.query.*` (drizzle-orm 0.45 `relations()` API). Foreign
 * keys are declared on the tables; this file only makes them navigable. Exactly one
 * `relations()` call per table: drizzle merges duplicates at runtime but the query types
 * (`db.query.x.findMany({ with })`) only see one of them.
 */
import { relations } from 'drizzle-orm';
import { adminActions } from './admin-actions.js';
import { approvalRequests } from './approval-requests.js';
import { account, session, user } from './auth.js';
import { balances } from './balances.js';
import { categories } from './categories.js';
import { chargePackages } from './charge-packages.js';
import { consentRecords } from './consent-records.js';
import { couponRedemptions, coupons } from './coupons.js';
import { fills } from './fills.js';
import { profileInterestCategories } from './interest-categories.js';
import { ledgerAccounts } from './ledger-accounts.js';
import { ledgerEntries } from './ledger.js';
import { commentLikes, postLikes } from './likes.js';
import { linkFlags } from './link-review.js';
import { marketDisputes } from './market-disputes.js';
import { marketEvents } from './market-events.js';
import { marketJudgementDelays } from './market-judgement-delays.js';
import { marketJudgements } from './market-judgements.js';
import { marketLinks } from './market-links.js';
import { marketPauses } from './market-pauses.js';
import { marketProposals } from './market-proposals.js';
import { marketRuleVersions } from './market-rule-versions.js';
import { marketSearches } from './market-searches.js';
import { marketSettlementSteps } from './market-settlement-steps.js';
import { marketSources } from './market-sources.js';
import { markets } from './markets.js';
import { mediaObjects } from './media-objects.js';
import { nicknameHolds } from './nickname-holds.js';
import { noticeImages, noticeRevisions, notices } from './notices.js';
import { orders } from './orders.js';
import { paymentEvents } from './payment-events.js';
import { payments } from './payments.js';
import { phoneVerificationCodes, phoneVerifications } from './phone-verifications.js';
import { positions } from './positions.js';
import { postCommentRevisions, postComments } from './post-comments.js';
import { postImages, postRevisions, posts } from './posts.js';
import { priceTicks } from './price-ticks.js';
import { profiles } from './profiles.js';
import { releaseSettings } from './release-settings.js';
import { startGrantNumbers, startGrants } from './start-grants.js';
import { marketTags, tags } from './tags.js';
import { themeMarkets, themeNotices, themes } from './themes.js';
import { marketWatchEvents, marketWatches } from './watchlist.js';

export const profilesRelations = relations(profiles, ({ one, many }) => ({
  user: one(user, { fields: [profiles.userId], references: [user.id] }),
  balance: one(balances, { fields: [profiles.userId], references: [balances.userId] }),
  interestCategories: many(profileInterestCategories),
  // The profile image (#141): one end of `profiles_image_fk`.
  image: one(mediaObjects, { fields: [profiles.imageId], references: [mediaObjects.id] }),
}));

export const profileInterestCategoriesRelations = relations(
  profileInterestCategories,
  ({ one }) => ({
    profile: one(profiles, {
      fields: [profileInterestCategories.userId],
      references: [profiles.userId],
    }),
    category: one(categories, {
      fields: [profileInterestCategories.categoryId],
      references: [categories.id],
    }),
  }),
);

export const consentRecordsRelations = relations(consentRecords, ({ one }) => ({
  user: one(user, { fields: [consentRecords.userId], references: [user.id] }),
}));

export const nicknameHoldsRelations = relations(nicknameHolds, ({ one }) => ({
  user: one(user, { fields: [nicknameHolds.userId], references: [user.id] }),
}));

export const balancesRelations = relations(balances, ({ one }) => ({
  account: one(ledgerAccounts, { fields: [balances.accountId], references: [ledgerAccounts.id] }),
  user: one(user, { fields: [balances.userId], references: [user.id] }),
  profile: one(profiles, { fields: [balances.userId], references: [profiles.userId] }),
}));

export const ledgerAccountsRelations = relations(ledgerAccounts, ({ one }) => ({
  owner: one(user, { fields: [ledgerAccounts.ownerId], references: [user.id] }),
  market: one(markets, { fields: [ledgerAccounts.marketId], references: [markets.id] }),
  balance: one(balances, { fields: [ledgerAccounts.id], references: [balances.accountId] }),
}));

export const ledgerEntriesRelations = relations(ledgerEntries, ({ one }) => ({
  fromAccount: one(ledgerAccounts, {
    fields: [ledgerEntries.fromAccountId],
    references: [ledgerAccounts.id],
  }),
  toAccount: one(ledgerAccounts, {
    fields: [ledgerEntries.toAccountId],
    references: [ledgerAccounts.id],
  }),
  market: one(markets, { fields: [ledgerEntries.marketId], references: [markets.id] }),
}));

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  user: one(user, { fields: [payments.userId], references: [user.id] }),
  package: one(chargePackages, {
    fields: [payments.packageId],
    references: [chargePackages.id],
  }),
  events: many(paymentEvents),
}));

export const paymentEventsRelations = relations(paymentEvents, ({ one }) => ({
  payment: one(payments, { fields: [paymentEvents.paymentId], references: [payments.id] }),
}));

export const phoneVerificationsRelations = relations(phoneVerifications, ({ one }) => ({
  user: one(user, { fields: [phoneVerifications.userId], references: [user.id] }),
}));

export const startGrantsRelations = relations(startGrants, ({ one, many }) => ({
  user: one(user, { fields: [startGrants.userId], references: [user.id] }),
  ledgerEntry: one(ledgerEntries, {
    fields: [startGrants.ledgerEntryId],
    references: [ledgerEntries.id],
  }),
  numbers: many(startGrantNumbers),
}));

export const startGrantNumbersRelations = relations(startGrantNumbers, ({ one }) => ({
  grant: one(startGrants, { fields: [startGrantNumbers.grantId], references: [startGrants.id] }),
}));

export const phoneVerificationCodesRelations = relations(phoneVerificationCodes, ({ one }) => ({
  user: one(user, { fields: [phoneVerificationCodes.userId], references: [user.id] }),
}));

export const chargePackagesRelations = relations(chargePackages, ({ many }) => ({
  payments: many(payments),
}));

export const couponsRelations = relations(coupons, ({ one, many }) => ({
  createdBy: one(user, { fields: [coupons.createdBy], references: [user.id] }),
  redemptions: many(couponRedemptions),
}));

export const couponRedemptionsRelations = relations(couponRedemptions, ({ one }) => ({
  coupon: one(coupons, { fields: [couponRedemptions.couponId], references: [coupons.id] }),
  user: one(user, { fields: [couponRedemptions.userId], references: [user.id] }),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  markets: many(markets),
  interestPicks: many(profileInterestCategories),
  // Both ends of the self-reference need a `relationName`: with two relations between the
  // same pair of tables drizzle cannot tell which foreign key each one walks.
  parent: one(categories, {
    fields: [categories.parentId],
    references: [categories.id],
    relationName: 'category_parent',
  }),
  children: many(categories, { relationName: 'category_parent' }),
}));

export const marketsRelations = relations(markets, ({ one, many }) => ({
  category: one(categories, { fields: [markets.categoryId], references: [categories.id] }),
  creator: one(user, { fields: [markets.createdBy], references: [user.id] }),
  orders: many(orders),
  fills: many(fills),
  positions: many(positions),
  priceTicks: many(priceTicks),
  events: many(marketEvents),
  settlementSteps: many(marketSettlementSteps),
  watches: many(marketWatches),
  watchEvents: many(marketWatchEvents),
  // 관련 시장 (#65): the links where this market is the pair's smaller id and where it is the
  // larger one. Its related markets are the other end of both (market-links.ts).
  linksAsLow: many(marketLinks, { relationName: 'market_link_low' }),
  linksAsHigh: many(marketLinks, { relationName: 'market_link_high' }),
  // 테마 (#81): the themes this market is in.
  themeMarkets: many(themeMarkets),
  // 태그 (#17): its tags, `position` the order.
  tags: many(marketTags),
  // 출처 (#23): its 1차 출처 (priority 0) and 대체 출처 (1..3), `priority` the order.
  sources: many(marketSources),
  // 규칙 버전 (#80): v1 from the open and one per approved supplement, `version` the order.
  ruleVersions: many(marketRuleVersions),
  // 거래 일시 중단 (#114): every pause, `paused_at` the order; at most one lasts.
  pauses: many(marketPauses),
  // 판정 (#152): every approved judgement, `version` the order; `judgement_version` the current.
  judgements: many(marketJudgements),
  // 판정 이의 (#175): every dispute of every version, `submitted_at` the order.
  disputes: many(marketDisputes),
  // 판정 지연 기록 (#142): every record of every episode, `event_id` the order.
  judgementDelays: many(marketJudgementDelays),
  posts: many(posts),
  // 시장 제안 (#77): the proposals adopted into this market, and the ones rejected as its
  // duplicates. Admin reads only: a market never shows who proposed it.
  adoptedProposals: many(marketProposals, { relationName: 'market_proposal_market' }),
  duplicateProposals: many(marketProposals, { relationName: 'market_proposal_duplicate' }),
}));

export const postsRelations = relations(posts, ({ one, many }) => ({
  market: one(markets, { fields: [posts.marketId], references: [markets.id] }),
  author: one(user, { fields: [posts.authorId], references: [user.id] }),
  revisions: many(postRevisions),
  images: many(postImages),
  comments: many(postComments),
  likes: many(postLikes),
  linkFlags: many(linkFlags),
}));

export const postCommentsRelations = relations(postComments, ({ one, many }) => ({
  post: one(posts, { fields: [postComments.postId], references: [posts.id] }),
  author: one(user, { fields: [postComments.authorId], references: [user.id] }),
  // A 대댓글's 댓글 and a 댓글's 대댓글 (#45-2): the two ends of `post_comments_parent_fk`.
  parent: one(postComments, {
    fields: [postComments.parentId],
    references: [postComments.id],
    relationName: 'post_comment_parent',
  }),
  replies: many(postComments, { relationName: 'post_comment_parent' }),
  revisions: many(postCommentRevisions),
  likes: many(commentLikes),
  linkFlags: many(linkFlags),
}));

// 반복 링크 (#187): the post or the comment an entry of the review list names (exactly one of them),
// and the operator's mark '확인함' that covered it, if one did (an admin_actions row).
// `link_uses` has no relations: a day's working record, read by link and time only.
export const linkFlagsRelations = relations(linkFlags, ({ one }) => ({
  post: one(posts, { fields: [linkFlags.postId], references: [posts.id] }),
  comment: one(postComments, { fields: [linkFlags.commentId], references: [postComments.id] }),
  review: one(adminActions, { fields: [linkFlags.reviewActionId], references: [adminActions.id] }),
}));

// 좋아요 (#49): the target and the account that liked. No relation reads a target's likers in
// public; the like counts are aggregates (apps/api likes/like-queries.ts).
export const postLikesRelations = relations(postLikes, ({ one }) => ({
  post: one(posts, { fields: [postLikes.postId], references: [posts.id] }),
  user: one(user, { fields: [postLikes.userId], references: [user.id] }),
}));

export const commentLikesRelations = relations(commentLikes, ({ one }) => ({
  comment: one(postComments, { fields: [commentLikes.commentId], references: [postComments.id] }),
  user: one(user, { fields: [commentLikes.userId], references: [user.id] }),
}));

export const postCommentRevisionsRelations = relations(postCommentRevisions, ({ one }) => ({
  comment: one(postComments, {
    fields: [postCommentRevisions.commentId],
    references: [postComments.id],
  }),
}));

export const postRevisionsRelations = relations(postRevisions, ({ one }) => ({
  post: one(posts, { fields: [postRevisions.postId], references: [posts.id] }),
}));

export const postImagesRelations = relations(postImages, ({ one }) => ({
  post: one(posts, { fields: [postImages.postId], references: [posts.id] }),
  media: one(mediaObjects, { fields: [postImages.mediaId], references: [mediaObjects.id] }),
}));

export const mediaObjectsRelations = relations(mediaObjects, ({ one }) => ({
  owner: one(user, { fields: [mediaObjects.ownerId], references: [user.id] }),
  post: one(postImages, { fields: [mediaObjects.id], references: [postImages.mediaId] }),
  // 운영 공지 (#138): an upload a notice took instead (never both, the API's rule).
  notice: one(noticeImages, { fields: [mediaObjects.id], references: [noticeImages.mediaId] }),
  // The profile whose image it is (#141), while one is.
  profile: one(profiles, { fields: [mediaObjects.id], references: [profiles.imageId] }),
}));

export const noticesRelations = relations(notices, ({ many }) => ({
  revisions: many(noticeRevisions),
  images: many(noticeImages),
}));

export const noticeRevisionsRelations = relations(noticeRevisions, ({ one }) => ({
  notice: one(notices, { fields: [noticeRevisions.noticeId], references: [notices.id] }),
}));

export const noticeImagesRelations = relations(noticeImages, ({ one }) => ({
  notice: one(notices, { fields: [noticeImages.noticeId], references: [notices.id] }),
  media: one(mediaObjects, { fields: [noticeImages.mediaId], references: [mediaObjects.id] }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  user: one(user, { fields: [orders.userId], references: [user.id] }),
  market: one(markets, { fields: [orders.marketId], references: [markets.id] }),
  fills: many(fills, { relationName: 'orderFills' }),
}));

export const fillsRelations = relations(fills, ({ one }) => ({
  market: one(markets, { fields: [fills.marketId], references: [markets.id] }),
  order: one(orders, {
    fields: [fills.orderId],
    references: [orders.id],
    relationName: 'orderFills',
  }),
  counterpartyOrder: one(orders, {
    fields: [fills.counterpartyOrderId],
    references: [orders.id],
    relationName: 'counterpartyFills',
  }),
}));

export const positionsRelations = relations(positions, ({ one }) => ({
  user: one(user, { fields: [positions.userId], references: [user.id] }),
  profile: one(profiles, { fields: [positions.userId], references: [profiles.userId] }),
  market: one(markets, { fields: [positions.marketId], references: [markets.id] }),
}));

export const priceTicksRelations = relations(priceTicks, ({ one }) => ({
  market: one(markets, { fields: [priceTicks.marketId], references: [markets.id] }),
}));

export const marketSettlementStepsRelations = relations(marketSettlementSteps, ({ one }) => ({
  market: one(markets, { fields: [marketSettlementSteps.marketId], references: [markets.id] }),
}));

export const marketEventsRelations = relations(marketEvents, ({ one }) => ({
  market: one(markets, { fields: [marketEvents.marketId], references: [markets.id] }),
}));

export const marketWatchesRelations = relations(marketWatches, ({ one }) => ({
  user: one(user, { fields: [marketWatches.userId], references: [user.id] }),
  market: one(markets, { fields: [marketWatches.marketId], references: [markets.id] }),
}));

export const marketWatchEventsRelations = relations(marketWatchEvents, ({ one }) => ({
  user: one(user, { fields: [marketWatchEvents.userId], references: [user.id] }),
  market: one(markets, { fields: [marketWatchEvents.marketId], references: [markets.id] }),
}));

export const marketSearchesRelations = relations(marketSearches, ({ one }) => ({
  user: one(user, { fields: [marketSearches.userId], references: [user.id] }),
}));

// Two references to `markets`, so both ends name theirs (as `category_parent` above).
export const marketLinksRelations = relations(marketLinks, ({ one }) => ({
  lowMarket: one(markets, {
    fields: [marketLinks.lowMarketId],
    references: [markets.id],
    relationName: 'market_link_low',
  }),
  highMarket: one(markets, {
    fields: [marketLinks.highMarketId],
    references: [markets.id],
    relationName: 'market_link_high',
  }),
  creator: one(user, { fields: [marketLinks.createdBy], references: [user.id] }),
}));

export const themesRelations = relations(themes, ({ one, many }) => ({
  creator: one(user, { fields: [themes.createdBy], references: [user.id] }),
  markets: many(themeMarkets),
  notices: many(themeNotices),
}));

export const themeMarketsRelations = relations(themeMarkets, ({ one }) => ({
  theme: one(themes, { fields: [themeMarkets.themeId], references: [themes.id] }),
  market: one(markets, { fields: [themeMarkets.marketId], references: [markets.id] }),
  creator: one(user, { fields: [themeMarkets.createdBy], references: [user.id] }),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  markets: many(marketTags),
}));

export const marketTagsRelations = relations(marketTags, ({ one }) => ({
  market: one(markets, { fields: [marketTags.marketId], references: [markets.id] }),
  tag: one(tags, { fields: [marketTags.tagId], references: [tags.id] }),
}));

export const marketSourcesRelations = relations(marketSources, ({ one }) => ({
  market: one(markets, { fields: [marketSources.marketId], references: [markets.id] }),
}));

// Two references to `user` (the supplement's requester and the version's maker), so both ends
// name theirs (as `approval_requester` below).
export const marketRuleVersionsRelations = relations(marketRuleVersions, ({ one }) => ({
  market: one(markets, { fields: [marketRuleVersions.marketId], references: [markets.id] }),
  /** The supplement's approved request; none for v1. */
  approval: one(approvalRequests, {
    fields: [marketRuleVersions.approvalId],
    references: [approvalRequests.id],
  }),
  requester: one(user, {
    fields: [marketRuleVersions.requestedBy],
    references: [user.id],
    relationName: 'rule_version_requester',
  }),
  creator: one(user, {
    fields: [marketRuleVersions.createdBy],
    references: [user.id],
    relationName: 'rule_version_creator',
  }),
}));

// Two references to `user` (who paused, who approved the end) and two to `market_events` (the
// pause's event and the end's), so each end names its own (as `approval_requester` below).
export const marketPausesRelations = relations(marketPauses, ({ one }) => ({
  market: one(markets, { fields: [marketPauses.marketId], references: [markets.id] }),
  pausedByUser: one(user, {
    fields: [marketPauses.pausedBy],
    references: [user.id],
    relationName: 'market_pause_paused_by',
  }),
  pauseEvent: one(marketEvents, {
    fields: [marketPauses.pauseEventId],
    references: [marketEvents.id],
    relationName: 'market_pause_event',
  }),
  /** The approver of a resume or an early close; none for the worker's close at `close_at`. */
  endedByUser: one(user, {
    fields: [marketPauses.endedBy],
    references: [user.id],
    relationName: 'market_pause_ended_by',
  }),
  endEvent: one(marketEvents, {
    fields: [marketPauses.endEventId],
    references: [marketEvents.id],
    relationName: 'market_pause_end_event',
  }),
  /** The approved `market_pause_decision` request a resume or an early close came in by. */
  endApproval: one(approvalRequests, {
    fields: [marketPauses.endApprovalId],
    references: [approvalRequests.id],
  }),
}));

// Two references to `user` (who registered, who approved), so both ends name theirs (as
// `approval_requester` below).
export const marketJudgementsRelations = relations(marketJudgements, ({ one, many }) => ({
  market: one(markets, { fields: [marketJudgements.marketId], references: [markets.id] }),
  /** The approved `market_judgement` request the judgement came in by. */
  approval: one(approvalRequests, {
    fields: [marketJudgements.approvalId],
    references: [approvalRequests.id],
  }),
  registeredByUser: one(user, {
    fields: [marketJudgements.registeredBy],
    references: [user.id],
    relationName: 'market_judgement_registered_by',
  }),
  approvedByUser: one(user, {
    fields: [marketJudgements.approvedBy],
    references: [user.id],
    relationName: 'market_judgement_approved_by',
  }),
  /** Its CLOSED → PROVISIONAL `provisional` event. */
  provisionalEvent: one(marketEvents, {
    fields: [marketJudgements.provisionalEventId],
    references: [marketEvents.id],
  }),
  /** The 판정 이의 against it (#175). */
  disputes: many(marketDisputes),
}));

// Two references to `user` (who submitted, who decided), so both ends name theirs.
export const marketDisputesRelations = relations(marketDisputes, ({ one }) => ({
  market: one(markets, { fields: [marketDisputes.marketId], references: [markets.id] }),
  /** The judgement disputed: the composite `market_disputes_judgement_fk`. */
  judgement: one(marketJudgements, {
    fields: [marketDisputes.marketId, marketDisputes.judgementVersion],
    references: [marketJudgements.marketId, marketJudgements.version],
  }),
  submitter: one(user, {
    fields: [marketDisputes.userId],
    references: [user.id],
    relationName: 'market_dispute_submitter',
  }),
  decider: one(user, {
    fields: [marketDisputes.decidedBy],
    references: [user.id],
    relationName: 'market_dispute_decider',
  }),
}));

// One reference to `user` (who recorded) and one to `market_events`, named as the user's other
// admin records are.
export const marketJudgementDelaysRelations = relations(marketJudgementDelays, ({ one }) => ({
  market: one(markets, { fields: [marketJudgementDelays.marketId], references: [markets.id] }),
  recordedByUser: one(user, {
    fields: [marketJudgementDelays.recordedBy],
    references: [user.id],
    relationName: 'market_judgement_delay_recorded_by',
  }),
  /** Its `judgement_delay_recorded` event. */
  event: one(marketEvents, {
    fields: [marketJudgementDelays.eventId],
    references: [marketEvents.id],
  }),
}));

export const themeNoticesRelations = relations(themeNotices, ({ one }) => ({
  theme: one(themes, { fields: [themeNotices.themeId], references: [themes.id] }),
  creator: one(user, { fields: [themeNotices.createdBy], references: [user.id] }),
}));

// Two references to `markets` (the adopted market and a 중복's), so both ends name theirs.
export const marketProposalsRelations = relations(marketProposals, ({ one }) => ({
  user: one(user, { fields: [marketProposals.userId], references: [user.id] }),
  category: one(categories, {
    fields: [marketProposals.categoryId],
    references: [categories.id],
  }),
  market: one(markets, {
    fields: [marketProposals.marketId],
    references: [markets.id],
    relationName: 'market_proposal_market',
  }),
  duplicateMarket: one(markets, {
    fields: [marketProposals.duplicateMarketId],
    references: [markets.id],
    relationName: 'market_proposal_duplicate',
  }),
}));

export const adminActionsRelations = relations(adminActions, ({ one, many }) => ({
  admin: one(user, { fields: [adminActions.adminId], references: [user.id] }),
  /** The review-list entries a `link_flag_review` mark covered (#187). */
  linkFlags: many(linkFlags),
}));

export const releaseSettingsRelations = relations(releaseSettings, ({ one }) => ({
  updatedBy: one(user, { fields: [releaseSettings.updatedBy], references: [user.id] }),
}));

// Two references to `user`, so both ends name theirs (as `category_parent` above).
export const approvalRequestsRelations = relations(approvalRequests, ({ one }) => ({
  requester: one(user, {
    fields: [approvalRequests.requestedBy],
    references: [user.id],
    relationName: 'approval_requester',
  }),
  decider: one(user, {
    fields: [approvalRequests.decidedBy],
    references: [user.id],
    relationName: 'approval_decider',
  }),
}));

export const userRelations = relations(user, ({ one, many }) => ({
  sessions: many(session),
  accounts: many(account),
  profile: one(profiles, { fields: [user.id], references: [profiles.userId] }),
  balance: one(balances, { fields: [user.id], references: [balances.userId] }),
  phoneVerification: one(phoneVerifications, {
    fields: [user.id],
    references: [phoneVerifications.userId],
  }),
  phoneVerificationCodes: many(phoneVerificationCodes),
  startGrant: one(startGrants, { fields: [user.id], references: [startGrants.userId] }),
  consentRecords: many(consentRecords),
  nicknameHolds: many(nicknameHolds),
  ledgerAccounts: many(ledgerAccounts),
  payments: many(payments),
  orders: many(orders),
  positions: many(positions),
  createdMarkets: many(markets),
  watches: many(marketWatches),
  watchEvents: many(marketWatchEvents),
  searches: many(marketSearches),
  marketLinks: many(marketLinks),
  posts: many(posts),
  postComments: many(postComments),
  postLikes: many(postLikes),
  commentLikes: many(commentLikes),
  media: many(mediaObjects),
  themes: many(themes),
  themeMarkets: many(themeMarkets),
  themeNotices: many(themeNotices),
  adminActions: many(adminActions),
  releaseSettingUpdates: many(releaseSettings),
  approvalRequests: many(approvalRequests, { relationName: 'approval_requester' }),
  approvalDecisions: many(approvalRequests, { relationName: 'approval_decider' }),
  ruleVersionRequests: many(marketRuleVersions, { relationName: 'rule_version_requester' }),
  ruleVersionsMade: many(marketRuleVersions, { relationName: 'rule_version_creator' }),
  marketPauses: many(marketPauses, { relationName: 'market_pause_paused_by' }),
  marketPauseEnds: many(marketPauses, { relationName: 'market_pause_ended_by' }),
  judgementsRegistered: many(marketJudgements, {
    relationName: 'market_judgement_registered_by',
  }),
  judgementsApproved: many(marketJudgements, { relationName: 'market_judgement_approved_by' }),
  disputesSubmitted: many(marketDisputes, { relationName: 'market_dispute_submitter' }),
  disputesDecided: many(marketDisputes, { relationName: 'market_dispute_decider' }),
  judgementDelaysRecorded: many(marketJudgementDelays, {
    relationName: 'market_judgement_delay_recorded_by',
  }),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));
