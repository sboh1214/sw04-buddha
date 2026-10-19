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
import { ledgerEntries } from './ledger.js';
import { marketEvents } from './market-events.js';
import { marketLinks } from './market-links.js';
import { marketSearches } from './market-searches.js';
import { marketSettlementSteps } from './market-settlement-steps.js';
import { markets } from './markets.js';
import { nicknameHolds } from './nickname-holds.js';
import { orders } from './orders.js';
import { paymentEvents } from './payment-events.js';
import { payments } from './payments.js';
import { phoneVerificationCodes, phoneVerifications } from './phone-verifications.js';
import { positions } from './positions.js';
import { priceTicks } from './price-ticks.js';
import { profiles } from './profiles.js';
import { releaseSettings } from './release-settings.js';
import { startGrantNumbers, startGrants } from './start-grants.js';
import { marketWatchEvents, marketWatches } from './watchlist.js';

export const profilesRelations = relations(profiles, ({ one, many }) => ({
  user: one(user, { fields: [profiles.userId], references: [user.id] }),
  balance: one(balances, { fields: [profiles.userId], references: [balances.userId] }),
  interestCategories: many(profileInterestCategories),
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
  user: one(user, { fields: [balances.userId], references: [user.id] }),
  profile: one(profiles, { fields: [balances.userId], references: [profiles.userId] }),
}));

export const ledgerEntriesRelations = relations(ledgerEntries, ({ one }) => ({
  user: one(user, { fields: [ledgerEntries.userId], references: [user.id] }),
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

export const adminActionsRelations = relations(adminActions, ({ one }) => ({
  admin: one(user, { fields: [adminActions.adminId], references: [user.id] }),
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
  ledgerEntries: many(ledgerEntries),
  payments: many(payments),
  orders: many(orders),
  positions: many(positions),
  createdMarkets: many(markets),
  watches: many(marketWatches),
  watchEvents: many(marketWatchEvents),
  searches: many(marketSearches),
  marketLinks: many(marketLinks),
  adminActions: many(adminActions),
  releaseSettingUpdates: many(releaseSettings),
  approvalRequests: many(approvalRequests, { relationName: 'approval_requester' }),
  approvalDecisions: many(approvalRequests, { relationName: 'approval_decider' }),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));
