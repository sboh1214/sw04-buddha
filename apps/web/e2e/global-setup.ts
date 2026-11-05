import { type FullConfig, request } from '@playwright/test';
import {
  awaitOwnStartGrant,
  ensureDisputeWindow,
  ensureOrderSettings,
  ensureStartCoin,
  signInFirstSeedAdmin,
} from './helpers';

/**
 * The suite's global setup (playwright.config.ts `globalSetup`): runs once per invocation — per
 * CI shard, per local `--project` run — after the web servers answer and before any test.
 *
 * It gives the release setting `market.dispute_window` a value while it is 미정 (#152, ADR-0103):
 * a first judgement can be neither registered nor approved without one (ADR-0093 decision 1 #173
 * item 5: the deadline is fixed from the value as the 잠정 결과 is published; a 판정 정정's reads
 * none — it takes the first one's length, #176), and migrations and the seed never write a value
 * (docs/SETTINGS.md), so every fresh e2e database starts 미정. The first seed admin — the `admin`
 * fixture's account, signed in and onboarded as that fixture does — enters 1분 as a 시험값 with its
 * reason (`ensureDisputeWindow`): the shortest window, which the specs that wait for the worker's
 * confirmation wait out (settlement.spec.ts, themes.spec.ts, dispute.spec.ts, correction.spec.ts).
 * A value already there is left as it is — a run before this one entered it, or a developer
 * entered another on their database, and a spec skips its wait when that one is long
 * (`skipUnlessResolvable`).
 *
 * It gives `grant.start_coin` a value the same way (#116, ADR-0109): no admin adjusts a balance any
 * more (ADR-0107 결정 2 #73 7항), and the owner chose that "e2e는 시험 DB의 시작 지급 설정값으로 Coin을
 * 받는다". While it is 미정 the first seed admin enters 1,000,000 Coin (`START_GRANT_MAX_COIN`) as a
 * 시험값 (`ensureStartCoin`), so every account a spec signs up is paid its start Coin at the
 * nickname step. The first seed admin's own grant, made by the sign-in above on a fresh database
 * before the amount was entered, waits for the worker (`start_grant.pay`), and the setup waits for
 * that payment (`awaitOwnStartGrant`) so it never lands under a spec that holds the admin's balance
 * still (market.spec.ts AC 1). A value already there is left as it is, and the specs read the one
 * in force (`startCoinValue`).
 *
 * And the order intake's three settings (#119, ADR-0112; ADR-0107 결정 3: the test environment opens
 * it with test values): `order.accepting` true, `order.rate_limit` 20 a minute and
 * `order.price_protection_ticks` 5 — the width before any spec submits a market for review, which
 * needs one and copies it (`ensureOrderSettings`). Values already there are left as they are.
 *
 * Before any test, so no spec writes a setting while another reads it:
 * release-settings.spec.ts reads the whole list once and holds the screen to it. The values stay
 * in the database for the runs after this one (README '테스트').
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const context = await request.newContext({ baseURL: config.projects[0]?.use.baseURL });
  try {
    await signInFirstSeedAdmin(context);
    await ensureDisputeWindow(context);
    await ensureStartCoin(context);
    await ensureOrderSettings(context);
    await awaitOwnStartGrant(context);
  } finally {
    await context.dispose();
  }
}
