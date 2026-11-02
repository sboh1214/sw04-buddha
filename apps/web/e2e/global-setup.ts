import { type FullConfig, request } from '@playwright/test';
import { ensureDisputeWindow, signInFirstSeedAdmin } from './helpers';

/**
 * The suite's global setup (playwright.config.ts `globalSetup`): runs once per invocation — per
 * CI shard, per local `--project` run — after the web servers answer and before any test.
 *
 * It gives the release setting `market.dispute_window` a value while it is 미정 (#152, ADR-0103):
 * a judgement can be neither registered nor approved without one (ADR-0093 decision 1 #173 item
 * 5: the deadline is fixed from the value as the 잠정 결과 is published), and migrations and the
 * seed never write a value (docs/SETTINGS.md), so every fresh e2e database starts 미정. The first
 * seed admin — the `admin` fixture's account, signed in and onboarded as that fixture does — enters
 * 1분 as a 시험값 with its reason (`ensureDisputeWindow`): the shortest window, which the specs that
 * wait for the worker's confirmation wait out (settlement.spec.ts, themes.spec.ts). A value already
 * there is left as it is — a run before this one entered it, or a developer entered another on
 * their database, and a spec skips its wait when that one is long (`skipUnlessResolvable`).
 *
 * Before any test, so no spec writes the setting while another reads it:
 * release-settings.spec.ts reads the whole list once and holds the screen to it. The value stays
 * in the database for the runs after this one (README '테스트').
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const context = await request.newContext({ baseURL: config.projects[0]?.use.baseURL });
  try {
    await signInFirstSeedAdmin(context);
    await ensureDisputeWindow(context);
  } finally {
    await context.dispose();
  }
}
