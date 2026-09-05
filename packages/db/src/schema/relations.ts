/**
 * Relational-query metadata for `db.query.*` (drizzle-orm 0.45 `relations()` API). Foreign
 * keys are declared on the tables; this file only makes them navigable. Exactly one
 * `relations()` call per table: drizzle merges duplicates at runtime but the query types
 * (`db.query.x.findMany({ with })`) only see one of them.
 */
import { relations } from 'drizzle-orm';
import { adminActions } from './admin-actions.js';
import { account, session, user } from './auth.js';
import { balances } from './balances.js';
import { categories } from './categories.js';
import { chargePackages } from './charge-packages.js';
import { couponRedemptions, coupons } from './coupons.js';
import { disputes } from './disputes.js';
import { fills } from './fills.js';
import { ledgerEntries } from './ledger.js';
import { marketEvents } from './market-events.js';
import { markets } from './markets.js';
import { orders } from './orders.js';
import { payments } from './payments.js';
import { positions } from './positions.js';
import { priceTicks } from './price-ticks.js';
import { profiles } from './profiles.js';

export const profilesRelations = relations(profiles, ({ one }) => ({
  user: one(user, { fields: [profiles.userId], references: [user.id] }),
  balance: one(balances, { fields: [profiles.userId], references: [balances.userId] }),
}));

export const balancesRelations = relations(balances, ({ one }) => ({
  user: one(user, { fields: [balances.userId], references: [user.id] }),
  profile: one(profiles, { fields: [balances.userId], references: [profiles.userId] }),
}));

export const ledgerEntriesRelations = relations(ledgerEntries, ({ one }) => ({
  user: one(user, { fields: [ledgerEntries.userId], references: [user.id] }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  user: one(user, { fields: [payments.userId], references: [user.id] }),
  package: one(chargePackages, {
    fields: [payments.packageId],
    references: [chargePackages.id],
  }),
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

export const categoriesRelations = relations(categories, ({ many }) => ({
  markets: many(markets),
}));

export const marketsRelations = relations(markets, ({ one, many }) => ({
  category: one(categories, { fields: [markets.categoryId], references: [categories.id] }),
  creator: one(user, { fields: [markets.createdBy], references: [user.id] }),
  orders: many(orders),
  fills: many(fills),
  positions: many(positions),
  priceTicks: many(priceTicks),
  disputes: many(disputes),
  events: many(marketEvents),
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

export const disputesRelations = relations(disputes, ({ one }) => ({
  market: one(markets, { fields: [disputes.marketId], references: [markets.id] }),
  user: one(user, { fields: [disputes.userId], references: [user.id] }),
  profile: one(profiles, { fields: [disputes.userId], references: [profiles.userId] }),
}));

export const marketEventsRelations = relations(marketEvents, ({ one }) => ({
  market: one(markets, { fields: [marketEvents.marketId], references: [markets.id] }),
}));

export const adminActionsRelations = relations(adminActions, ({ one }) => ({
  admin: one(user, { fields: [adminActions.adminId], references: [user.id] }),
}));

export const userRelations = relations(user, ({ one, many }) => ({
  sessions: many(session),
  accounts: many(account),
  profile: one(profiles, { fields: [user.id], references: [profiles.userId] }),
  balance: one(balances, { fields: [user.id], references: [balances.userId] }),
  ledgerEntries: many(ledgerEntries),
  payments: many(payments),
  orders: many(orders),
  positions: many(positions),
  disputes: many(disputes),
  createdMarkets: many(markets),
  adminActions: many(adminActions),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));
