import {
  expect,
  test as base,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Cookie,
  type Locator,
  type Page,
  type Request,
  type Response,
  type Route,
} from '@playwright/test';
import type {
  AdminMarket,
  Category,
  MarketPausePath,
  MarketPauseReason,
  MarketPauseReviewResult,
  MarketResult,
  MarketReviewChecklistItem,
  MarketRuleItems,
  MarketSupplementChanges,
  MarketTimes,
  Me,
  ReleaseSetting,
} from '@buddha/shared';
import { copy } from '../src/copy';
import { E2E_CONSENT_VERSIONS } from './consent-versions';

/**
 * Fixtures every M4 spec shares (PLAN 14): the Mailpit sign-up flow auth.spec.ts introduced,
 * plus an admin API context that CREATES the market a spec runs against.
 *
 * The market is created per run, never taken from `pnpm db:seed`. The seed's markets are drafts
 * waiting for review (#125) with absolute KST close times, so a spec pinned to them would pass
 * today and rot on a date nobody will connect to the failure. The two things a spec still needs from
 * the seed are the bootstrap admins (PLAN 10.5 — two since #171, as the two-person rule needs
 * distinct admins in every environment), which no route can make, and the category tree: an admin
 * route makes categories since #17, but the specs file their markets under the seed's own tree
 * (`createDraftMarket`) and leave it as it is for the other workers. Both are named in the error a
 * helper throws, so a missing seed reads as "run pnpm db:seed" rather than as a 401 or a 404 in
 * the middle of a flow. Both admins take part in every open market since #21: the first submits
 * it for review and the second approves it (`openThroughReview`). So in every rule supplement
 * since #80: the first asks for it and the second approves it (`approveSupplementAsReviewer`). And
 * in every early close since #114, the one way to close a market before its close: the first
 * pauses it and asks for the 조기 마감, the second approves it (`closeMarket`). And in every
 * judgement since #152: the first registers it and the second approves it, which publishes the
 * 잠정 결과 (`judgeMarket`); the worker confirms it once its dispute window — the release setting
 * the suite's global setup enters while it is 미정 (global-setup.ts) — has passed, no 판정 이의
 * holding it (#175: only a member with a fill submits one, and the only fill on a market a spec
 * judges is the helper's own pair before its close — `closeMarket`, two members of the worker's
 * own that never dispute, since #20 makes a market with no fill CANCELLED). And
 * in every 판정 정정 since #176: the first registers it and the second approves it — the next
 * judgement version, its result and a new deadline of the first one's length (`registerCorrection`
 * and `approveJudgementAsReviewer`) — or rejects it; while it waits, it holds the confirmation.
 * A 판정 지연 기록 since #142 is one admin's alone and at once, no approval (`recordJudgementDelay`).
 *
 * Everything here is re-runnable against a persistent local database: a fresh email per
 * sign-up, a random tag in every market title and slug.
 *
 * Type-only imports from `@buddha/shared`: Playwright runs these files straight from source,
 * and a value import would make every spec depend on that package having been built.
 */

/** Every account these specs create. auth.spec.ts keeps its own copy of the same string. */
export const E2E_PASSWORD = 'passw0rd-e2e';

/** Mailpit HTTP API (docker compose). Override with MAILPIT_URL. */
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';

/** The real name every account here gives in the 본인확인 step (ADR-0070). */
export const E2E_REAL_NAME = '테스트회원';

/**
 * A mobile number no other account here has verified: 010 and eight random digits. Each account
 * needs its own since ADR-0070 — one account per verified number (ADR-0069 decision 1 #57-1) —
 * and a number receives codes for at most three accounts a day, so no two accounts share one
 * even across re-runs against a persistent database (a collision is one in a hundred million).
 */
export function freshPhone(): string {
  return `010${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`;
}

/** `.env.example`'s defaults, so a developer who never exported them still runs the suite. */
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@buddha.local';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'admin1234!';
const SECOND_ADMIN_EMAIL = process.env.SEED_SECOND_ADMIN_EMAIL ?? 'admin2@buddha.local';
const SECOND_ADMIN_PASSWORD = process.env.SEED_SECOND_ADMIN_PASSWORD ?? 'admin5678!';

/**
 * A bootstrap admin of `pnpm db:seed`, and the real name and number its fixture verifies it with
 * (the seed onboards nobody, #58). Fixed numbers, one per admin: verified once, they stay the
 * admin's in a persistent database. `freshPhone()` draws one of them once in fifty million.
 */
interface SeedAdmin {
  email: string;
  password: string;
  verification: { realName: string; phone: string };
  /** The variables that name it, for the error a missing seed raises. */
  env: string;
}

const FIRST_ADMIN: SeedAdmin = {
  email: ADMIN_EMAIL,
  password: ADMIN_PASSWORD,
  verification: { realName: '테스트관리자', phone: '01000000000' },
  env: 'SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD',
};

const SECOND_ADMIN: SeedAdmin = {
  email: SECOND_ADMIN_EMAIL,
  password: SECOND_ADMIN_PASSWORD,
  verification: { realName: '테스트둘째관리자', phone: '01000000001' },
  env: 'SEED_SECOND_ADMIN_EMAIL / SEED_SECOND_ADMIN_PASSWORD',
};

/**
 * How long a fixture keeps trying to onboard a seed admin. Parallel workers share the two admins,
 * so all but one of them are refused the code (the 60-second resend interval, or the per-account
 * rate limit) while the one that got the code confirms it; the rest wait and look again.
 */
const ADMIN_VERIFY_MS = 120_000;

/** How long a fixture that was refused waits before it asks `GET /me` again. */
const ADMIN_VERIFY_POLL_MS = 2_000;

/**
 * What a run says when the service-wide limit refuses its codes: every send stays as an
 * account's 본인확인 기록 (ADR-0070), so a database counts the sends of every run of the last 24
 * hours against the service's five hundred — a fixed owner value. A full run sends some five
 * hundred across both projects (about half each), so no one database takes the whole suite in a
 * day: CI splits it into shards, each on a database of its own (`.github/workflows/ci.yml`), and a
 * full local run goes one project at a time on an isolated e2e database with the sends deleted in
 * between (README, ADR-0092 결과 5).
 */
const SERVICE_LIMIT_HELP =
  'the service-wide limit of 500 verification codes in 24 hours (ADR-0070) is reached in this ' +
  "database, which keeps every earlier run's sends — a full run sends some five hundred, so run " +
  'one project at a time (`--project=mobile-375`, then `--project=desktop-1280`): on ' +
  'an isolated e2e database delete them before each (`DELETE FROM phone_verification_codes` and ' +
  '`DELETE FROM phone_verification_refused_sends`, as the migration role) or wait until the ' +
  'oldest is 24 hours old';

/** PLAN 13 M4 AC 1: 한 브라우저의 변화가 다른 브라우저의 카드·상세에 1초 내 반영된다. */
export const REALTIME_BUDGET_MS = 1_000;

/** How long a socket may take to open and ask for its rooms before a spec gives up on it. */
const REALTIME_READY_MS = 10_000;

/** Far enough out that no spec races the close, close enough to stay obviously synthetic. */
const CLOSE_IN_MS = 24 * 60 * 60 * 1_000;

/**
 * A spec market's 사건 기한 (#23): a day after its close. Nothing orders the two (ADR-0097 result 4
 * (a), kept by #22), so this only keeps the default plausible; both are at or before the
 * scheduled judgement (`timesFor`, owner answer 2026-10-31 A1).
 */
const EVENT_DEADLINE_IN_MS = 2 * CLOSE_IN_MS;

/** Korea's fixed UTC offset: the admin's `datetime-local` inputs are KST wall-clock minutes. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

/** The unit every order between market times is compared in (#22, #172 item 12). */
const MINUTE_MS = 60 * 1_000;

/**
 * How long after its close and its 사건 기한 a spec market is judged (`timesFor`): a day, as the
 * database factory's default (ADR-0098).
 */
const JUDGEMENT_AFTER_MS = 24 * 60 * 60 * 1_000;

/**
 * The 판정 기준 시간대 the admin form pre-fills and every spec market is judged in unless a spec
 * says otherwise: shared's DEFAULT_JUDGEMENT_TIME_ZONE, restated (type-only imports, above).
 */
export const DEFAULT_JUDGEMENT_TIME_ZONE = 'Asia/Seoul';

// ---- fixtures -----------------------------------------------------------------------

/**
 * Signs `context` in as a bootstrap admin and makes sure it has finished the onboarding (#58).
 *
 * The seed admins are accounts like any other, so the onboarding gate would send a spec's
 * browser sign-in as one (`signIn(…, adminAccount…)`) to /onboarding instead of `/` — the
 * owner's decision for operators (ADR-0069 decision 4, #58: they onboard as every account does).
 * Every spec that signs a browser in as an admin also asks for that admin's fixture, so the admin
 * onboards here, through the API and the development SMS sender, the first time any fixture runs
 * against a database; after that `GET /me` already says so and nothing is written. Every body
 * names the account it is for (`expectedAccountId`, A-PG-24): the sign-in's own answer.
 */
async function signInSeedAdmin(context: APIRequestContext, admin: SeedAdmin): Promise<void> {
  const signedIn = await context.post('/api/auth/sign-in/email', {
    data: { email: admin.email, password: admin.password },
  });
  if (!signedIn.ok()) {
    throw new Error(
      `admin sign-in failed for ${admin.email} (${String(signedIn.status())}): ` +
        `run \`pnpm db:seed\` with ${admin.env} set — the seed creates its admins only while ` +
        'the database has none, so one seeded with fewer needs a reset or a grant on /admin/admins',
    );
  }
  const { user } = (await signedIn.json()) as { user: { id: string } };
  await onboardSeedAdmin(context, admin, user.id);
}

/**
 * Signs `context` in as the first seed admin, onboarded (`signInSeedAdmin`): the `admin` fixture's
 * account, for the suite's global setup (global-setup.ts), which runs before any fixture does.
 */
export function signInFirstSeedAdmin(context: APIRequestContext): Promise<void> {
  return signInSeedAdmin(context, FIRST_ADMIN);
}

/**
 * Takes a seed admin through whatever is left of its onboarding (#58): the consent, the 본인확인 and
 * the nickname step (`chooseSeedAdminNickname`). Workers running in parallel share the two admins,
 * and every step but the 본인확인 is safe to repeat (the same consent answers are not written again,
 * the same nickname confirms nothing new and grants once, and a second worker's other nickname is
 * `already_set`, after which `GET /me` says the step is done). The 본인확인 is not: the worker
 * whose code request is answered confirms the code it reads from Mailpit, and the others — refused
 * with 429 (the resend interval, or the per-account rate limit) or with a code that a newer one
 * replaced — wait and ask `GET /me` again until it says verified.
 */
async function onboardSeedAdmin(
  context: APIRequestContext,
  admin: SeedAdmin,
  expectedAccountId: string,
): Promise<void> {
  const deadline = Date.now() + ADMIN_VERIFY_MS;
  while (Date.now() < deadline) {
    const me = await unwrap<Me>(await context.get('/api/v1/me'));
    const step = me.onboarding.nextStep;
    if (step === null) return;
    if (step === 'consent') {
      await agreeThroughApi(context, expectedAccountId);
      continue;
    }
    if (step === 'nickname') {
      await chooseSeedAdminNickname(context, expectedAccountId, me.profile.nickname);
      continue;
    }
    const seen = await smsMessageIds(admin.verification.phone);
    const sent = await context.post('/api/v1/me/phone-verification/code', {
      data: { ...admin.verification, expectedAccountId },
    });
    if (sent.ok()) {
      const code = await smsCode(admin.verification.phone, seen);
      const confirmed = await context.post('/api/v1/me/phone-verification/confirm', {
        data: { code, expectedAccountId },
      });
      if (confirmed.ok()) continue;
      // 409: another worker verified first, or its newer code replaced this one.
      if (confirmed.status() !== 409) {
        throw new Error(
          `confirming the code of ${admin.email} failed (${String(confirmed.status())}): ` +
            (await confirmed.text()),
        );
      }
    } else if (sent.status() === 429) {
      // A daily limit is not another worker's minute: waiting would not end it in this test.
      const body = (await sent.json()) as { error: { details?: { reason?: string } } };
      if (body.error.details?.reason === 'service_daily') throw new Error(SERVICE_LIMIT_HELP);
    } else if (sent.status() !== 409) {
      throw new Error(
        `requesting a code for ${admin.email} failed (${String(sent.status())}): ${await sent.text()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, ADMIN_VERIFY_POLL_MS));
  }
  throw new Error(
    `${admin.email} did not finish the onboarding within ${String(ADMIN_VERIFY_MS)} ms`,
  );
}

/**
 * The seed admin's nickname step (오너 결정 2026-10-19 (2차) 2): the nickname it has, confirmed —
 * the auto nickname a fresh seed leaves — unless the rules refuse it, as they refuse the 관리자 an
 * earlier seed gave (a reserved word): then one of its own, as an admin does on the screen. A
 * refusal because another worker finished the step first (`already_set`) is fine: the caller reads
 * `GET /me` again.
 */
async function chooseSeedAdminNickname(
  context: APIRequestContext,
  expectedAccountId: string,
  current: string,
): Promise<void> {
  const post = (nickname: string) =>
    context.post('/api/v1/me/onboarding/nickname', { data: { nickname, expectedAccountId } });
  const kept = await post(current);
  if (kept.ok()) return;
  const refusal = (
    (await kept.json()) as { error: { code: string; details?: { reason?: string } } }
  ).error;
  const reason = refusal.details?.reason;
  if (refusal.code !== 'NICKNAME_NOT_ALLOWED') {
    throw new Error(`the nickname step of ${current} failed: ${JSON.stringify(refusal)}`);
  }
  if (reason === 'already_set') return;
  if (reason !== 'reserved_word' && reason !== 'auto_prefix') {
    throw new Error(`the nickname step of ${current} failed: ${JSON.stringify(refusal)}`);
  }
  const chosen = await post(`시장지기${freshTag().slice(-8)}`);
  if (chosen.ok()) return;
  const second = ((await chosen.json()) as { error: { details?: { reason?: string } } }).error;
  if (second.details?.reason !== 'already_set') {
    throw new Error(`the seed admin's own nickname was refused: ${JSON.stringify(second)}`);
  }
}

/**
 * The reviewer each `admin` context goes with (`test`'s fixtures), for `approveAsReviewer`,
 * `approveSupplementAsReviewer`, `approvePauseDecisionAsReviewer` and
 * `approveJudgementAsReviewer`.
 */
const reviewers = new WeakMap<APIRequestContext, APIRequestContext>();

/**
 * The two members who trade once on a market before `closeMarket` closes it (#20, ADR-0117: a
 * market reaching its close with no fill of a person's account is CANCELLED, not CLOSED), each an
 * API context with a member's cookie: made on first use, once per worker process (`test`'s
 * `traders`), and paired with each `admin` context here, as `reviewers` are.
 */
export type HelperTraders = readonly [APIRequestContext, APIRequestContext];
const traderPairs = new WeakMap<APIRequestContext, () => Promise<HelperTraders>>();

/**
 * `admin` is an API context signed in as the first seed admin and `secondAdmin` as the second
 * (#171), each isolated from every browser context in the test: the specs' own `request`
 * fixture stays cookie-less, which is what lets AC 2 read the detail page's HTML as an
 * anonymous visitor would.
 *
 * `reviewer` is the second seed admin too, once per worker process: the admin who approves what
 * `admin` submits, so `createOpenMarket(admin)` can open a market without every test that wants
 * one asking for a second admin (#21 — a market opens only through the review, which its creator
 * and its submitter never decide, #172 item 5), what `admin` asks to supplement (#80 — its
 * requester never decides a supplement, #172 item 15), the next path `admin` asks for a paused
 * market (#114 — its requester never decides it, #173 item 2) and the judgement `admin` registers
 * (#152 — its registrant neither approves nor rejects it, ADR-0093 decision 3 '역할'). `admin`
 * depends on it and is paired with it here (`reviewers`); a spec that acts as the second admin
 * itself asks for `secondAdmin`. Worker-scoped fixtures see no test-scoped `baseURL`, so it reads
 * the project's.
 *
 * `traders` are two fresh members, once per worker process and only once a test asks for them
 * (`closeMarket`, through `traderPairs`): since #20 (ADR-0117) a market whose close comes with no
 * fill of a person's account is CANCELLED, so the helper's 조기 마감 trades one pair first — the
 * members a spec signs up itself never trade. Signed up in a browser context of their own
 * (`signUp`), closed when the worker ends.
 */
export const test = base.extend<
  { admin: APIRequestContext; secondAdmin: APIRequestContext },
  { reviewer: APIRequestContext; traders: () => Promise<HelperTraders> }
>({
  // The second argument is Playwright's `use`, renamed: this package lints with
  // eslint-plugin-react-hooks, which reads a call to `use(…)` outside a component as React's
  // own `use` hook and fails `rules-of-hooks`. Playwright passes it positionally.
  admin: async ({ playwright, baseURL, reviewer, traders }, provide) => {
    const context = await playwright.request.newContext({ baseURL });
    await signInSeedAdmin(context, FIRST_ADMIN);
    reviewers.set(context, reviewer);
    traderPairs.set(context, traders);
    await provide(context);
    await context.dispose();
  },
  secondAdmin: async ({ playwright, baseURL }, provide) => {
    const context = await playwright.request.newContext({ baseURL });
    await signInSeedAdmin(context, SECOND_ADMIN);
    await provide(context);
    await context.dispose();
  },
  reviewer: [
    async ({ playwright }, provide, workerInfo) => {
      const context = await playwright.request.newContext({
        baseURL: workerInfo.project.use.baseURL,
      });
      await signInSeedAdmin(context, SECOND_ADMIN);
      await provide(context);
      await context.dispose();
    },
    { scope: 'worker' },
  ],
  traders: [
    async ({ browser }, provide, workerInfo) => {
      const contexts: BrowserContext[] = [];
      let made: Promise<HelperTraders> | undefined;
      const signUpTrader = async (): Promise<APIRequestContext> => {
        const context = await browser.newContext({ baseURL: workerInfo.project.use.baseURL });
        contexts.push(context);
        const page = await context.newPage();
        await signUp(page, freshEmail());
        return page.request;
      };
      await provide(() => {
        made ??= (async () => [await signUpTrader(), await signUpTrader()] as const)();
        return made;
      });
      for (const context of contexts) await context.close();
    },
    { scope: 'worker' },
  ],
});

export { expect };

// ---- sign-up ------------------------------------------------------------------------

export function freshEmail(): string {
  return `e2e-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}@buddha.local`;
}

interface MailpitSearch {
  messages: { ID: string }[];
}
interface MailpitMessage {
  Text: string;
}

/** The Mailpit ids of every message addressed to `email`, newest first. */
export async function mailMessageIds(email: string): Promise<string[]> {
  const query = encodeURIComponent(`to:${email}`);
  const search = (await (
    await fetch(`${MAILPIT_URL}/api/v1/search?query=${query}`)
  ).json()) as MailpitSearch;
  return search.messages.map((message) => message.ID);
}

/**
 * The verify-email link of the newest Mailpit message addressed to `email` that is not one of
 * `seen` — the ids `mailMessageIds` gave before the mail was asked for, so a sign-up again with an
 * address a closed account freed (#140, account-closure.spec.ts) never reads the first sign-up's
 * mail for the second.
 */
export async function verificationLink(
  email: string,
  seen: readonly string[] = [],
): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const newest = (await mailMessageIds(email)).find((id) => !seen.includes(id));
    if (newest !== undefined) {
      const message = (await (
        await fetch(`${MAILPIT_URL}/api/v1/message/${newest}`)
      ).json()) as MailpitMessage;
      const match = /https?:\/\/\S+\/verify-email\?\S+/.exec(message.Text);
      if (match) return match[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no verification mail for ${email} (is Mailpit up at ${MAILPIT_URL}?)`);
}

/**
 * Where the API's development SMS sender (SMS_PROVIDER=dev, the default outside production)
 * mails the text it would have sent to `phone` (digits): apps/api/src/sms/dev-sms-sender.ts.
 */
function smsAddress(phone: string): string {
  return `sms-${phone}@sms.buddha.local`;
}

/** The Mailpit ids of every development SMS to `phone`, newest first. */
export async function smsMessageIds(phone: string): Promise<string[]> {
  const query = encodeURIComponent(`to:${smsAddress(phone)}`);
  const search = (await (
    await fetch(`${MAILPIT_URL}/api/v1/search?query=${query}`)
  ).json()) as MailpitSearch;
  return search.messages.map((message) => message.ID);
}

/**
 * The six digits of the newest development SMS to `phone` that is not one of `seen` — the ids
 * `smsMessageIds` gave before the code was requested, so an older text to the same number (a
 * resend, a re-run against a persistent Mailpit) is never read for the new one.
 */
export async function smsCode(phone: string, seen: readonly string[] = []): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const fresh = (await smsMessageIds(phone)).find((id) => !seen.includes(id));
    if (fresh !== undefined) {
      const message = (await (
        await fetch(`${MAILPIT_URL}/api/v1/message/${fresh}`)
      ).json()) as MailpitMessage;
      const match = /인증번호는 (\d{6})입니다/.exec(message.Text);
      if (match?.[1] !== undefined) return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no SMS code for ${phone} (is Mailpit up at ${MAILPIT_URL}?)`);
}

/**
 * The 본인확인 step on /onboarding (ADR-0070), done as a member does it: the real name and the
 * number, 인증번호 받기, the code the development sender mailed to Mailpit, 본인확인 완료. The
 * stepper then goes on to the nickname step (#58), which the caller checks. Returns the number
 * verified.
 */
export async function verifyPhone(
  page: Page,
  phone: string = freshPhone(),
  realName: string = E2E_REAL_NAME,
): Promise<string> {
  await expect(page.getByTestId('verification-step')).toBeVisible();
  const seen = await smsMessageIds(phone);
  await page.getByTestId('verification-real-name').fill(realName);
  await page.getByTestId('verification-phone').fill(phone);
  await page.getByTestId('verification-send').click();
  await expectCodeInput(page);
  await page.getByTestId('verification-code').fill(await smsCode(phone, seen));
  await page.getByTestId('verification-confirm').click();
  return phone;
}

/**
 * Waits for the code input a send opens, and fails with what to do when the service-wide limit
 * refused the send instead (SERVICE_LIMIT_HELP) rather than as a missing input.
 */
export async function expectCodeInput(page: Page): Promise<void> {
  const input = page.getByTestId('verification-code');
  const serviceLimit = page
    .getByTestId('verification-notice')
    .filter({ hasText: copy.errVerificationServiceDaily });
  await expect(input.or(serviceLimit)).toBeVisible();
  if (await serviceLimit.isVisible()) throw new Error(SERVICE_LIMIT_HELP);
}

/**
 * The colour a Chakra colour token (`yellow.subtle`) paints as `property` (`backgroundColor`,
 * `color`) where `element` is, in that page's colour mode: read off a probe appended inside it, so
 * it resolves as the element's own would.
 */
export function tokenColour(
  element: Locator,
  token: string,
  property: 'backgroundColor' | 'color' = 'backgroundColor',
): Promise<string> {
  return element.evaluate(
    (node, [name, prop]) => {
      const probe = document.createElement('div');
      probe.style[prop] = `var(--chakra-colors-${name.replace('.', '-')})`;
      node.append(probe);
      const colour = getComputedStyle(probe)[prop];
      probe.remove();
      return colour;
    },
    [token, property] as const,
  );
}

/** The background `element` is drawn with. */
export function backgroundOf(element: Locator): Promise<string> {
  return element.evaluate((node) => getComputedStyle(node).backgroundColor);
}

/**
 * Every 주의 안내 is yellow (owner decision 2026-10-18, third round, ADR-0070 — the 본인확인
 * "the text may have come" notice first, second round): `element`, an alert of the warning status,
 * is drawn with the yellow palette — `yellow.subtle` behind `yellow.fg` words — and not with the
 * orange Chakra gives the status by itself. The theme decides it (theme/system.ts), not the screen.
 */
export async function expectYellowWarning(element: Locator): Promise<void> {
  await expect(element).toBeVisible();
  const yellow = await tokenColour(element, 'yellow.subtle');
  const orange = await tokenColour(element, 'orange.subtle');
  // Both tokens resolve to a colour (an unknown variable paints nothing) and they differ.
  expect(yellow).not.toBe('rgba(0, 0, 0, 0)');
  expect(yellow).not.toBe(orange);
  expect(await backgroundOf(element)).toBe(yellow);
  expect(await element.evaluate((node) => getComputedStyle(node).color)).toBe(
    await tokenColour(element, 'yellow.fg', 'color'),
  );
}

/**
 * The consent step on /onboarding (#58), done as a member does it: 전체 동의 — the optional
 * marketing item with the rest — and 동의하고 계속하기. The stepper then shows the 본인확인 step.
 */
export async function agreeOnScreen(page: Page): Promise<void> {
  await expect(page.getByTestId('consent-step')).toBeVisible();
  await page.getByTestId('consent-all').click();
  await page.getByTestId('consent-submit').click();
  await expect(page.getByTestId('verification-step')).toBeVisible();
}

/**
 * The small '탈퇴하기' link at the very bottom of the onboarding screen now shown (오너 결정
 * 2026-10-23 (4차) 1, ADR-0086 7-35): under 로그아웃, to the 탈퇴 screen.
 */
export async function expectOnboardingClosureLink(page: Page): Promise<void> {
  const link = page.getByTestId('onboarding-closure');
  await expect(link).toBeVisible();
  await expect(link).toHaveText(copy.onboardingClosureLink);
  await expect(link).toHaveAttribute('href', '/my/settings/closure');
  const logout = await page.getByTestId('onboarding-logout').boundingBox();
  const box = await link.boundingBox();
  expect(box!.y).toBeGreaterThan(logout!.y + logout!.height - 1);
}

/**
 * Opens the 탈퇴 screen (#140) — by its address, or by `open` (a link followed) — and waits until
 * its read (`GET /me/closure`, in the browser once the session is known) has answered: before it,
 * the button is off and the lines that depend on the account (the start Coin's, the market
 * proposals' — #77) are not drawn, for no reason the test means. account-closure.spec.ts and
 * proposals.spec.ts open it.
 */
export async function openClosure(
  page: Page,
  open: () => Promise<unknown> = () => page.goto('/my/settings/closure'),
): Promise<void> {
  const read = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === '/api/v1/me/closure',
  );
  await open();
  await expect(page).toHaveURL('/my/settings/closure');
  const response = await read;
  expect(response.status(), await response.text()).toBe(200);
  await expect(page.getByTestId('closure-coin')).toBeVisible();
}

/**
 * The first half of a sign-up (ADR-0024): the form takes the email only, and the link in the
 * mail signs the user in and lands on /set-password. The account is signed in from here on
 * but has neither a password nor any onboarding step done — which is also the state the
 * onboarding gate exists for (ADR-0043, #58), so onboarding.spec.ts starts from this.
 */
export async function openSetPassword(page: Page, email: string): Promise<void> {
  const seen = await mailMessageIds(email);
  await page.goto('/signup');
  await page.getByLabel(copy.email).fill(email);
  await page.getByRole('button', { name: copy.signupWithEmail }).click();
  await expect(page.getByTestId('signup-check-mail')).toBeVisible();

  await page.goto(await verificationLink(email, seen));
  await expect(page).toHaveURL('/set-password');
}

/** Sets the first password on /set-password, which then goes on to its `next` (home by default). */
export async function setFirstPassword(page: Page): Promise<void> {
  await page.getByTestId('new-password').fill(E2E_PASSWORD);
  await page.getByTestId('new-password-confirm').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: copy.setPasswordSubmit }).click();
}

// ---- the onboarding through the API (#58) -------------------------------------------

/** `GET /me` of the account `context` is signed in as. */
export async function meOf(context: APIRequestContext): Promise<Me> {
  return unwrap<Me>(await context.get('/api/v1/me'));
}

const accountIds = new WeakMap<APIRequestContext, Promise<string>>();

/**
 * The account `context` is signed in as, read once per context: what an admin write straight at
 * the API names as the admin on screen (`expectedAccountId`, ADR-0092), as the screens do.
 */
export function accountIdOf(context: APIRequestContext): Promise<string> {
  let id = accountIds.get(context);
  if (id === undefined) {
    id = meOf(context).then((me) => me.id);
    accountIds.set(context, id);
  }
  return id;
}

/**
 * The consent step through the API: every item at its current version (consent-versions.ts), the
 * required ones agreed and the optional marketing one as `marketing` says (declined by default).
 */
export async function agreeThroughApi(
  context: APIRequestContext,
  expectedAccountId: string,
  marketing = false,
): Promise<Me> {
  const answer = (item: keyof typeof E2E_CONSENT_VERSIONS, agreed: boolean) => ({
    version: E2E_CONSENT_VERSIONS[item],
    agreed,
  });
  return unwrap<Me>(
    await context.post('/api/v1/me/consents', {
      data: {
        consents: {
          terms: answer('terms', true),
          privacy: answer('privacy', true),
          age: answer('age', true),
          marketing: answer('marketing', marketing),
        },
        expectedAccountId,
      },
    }),
  );
}

/** The 본인확인 through the API, with the code the development sender mailed to Mailpit. */
export async function verifyThroughApi(
  context: APIRequestContext,
  expectedAccountId: string,
  phone: string,
  realName: string = E2E_REAL_NAME,
): Promise<void> {
  const seen = await smsMessageIds(phone);
  const sent = await context.post('/api/v1/me/phone-verification/code', {
    data: { realName, phone, expectedAccountId },
  });
  if (sent.status() === 429) {
    const body = (await sent.json()) as { error: { details?: { reason?: string } } };
    if (body.error.details?.reason === 'service_daily') throw new Error(SERVICE_LIMIT_HELP);
  }
  await unwrap<unknown>(sent);
  await unwrap<unknown>(
    await context.post('/api/v1/me/phone-verification/confirm', {
      data: { code: await smsCode(phone, seen), expectedAccountId },
    }),
  );
}

/**
 * The nickname step through the API: `nickname` set or — the account's own — confirmed. With it
 * the server grants the start Coin (#70), or leaves it waiting while the amount is undecided.
 */
export async function confirmNicknameThroughApi(
  context: APIRequestContext,
  expectedAccountId: string,
  nickname: string,
): Promise<Me> {
  return unwrap<Me>(
    await context.post('/api/v1/me/onboarding/nickname', {
      data: { nickname, expectedAccountId },
    }),
  );
}

/**
 * The interests step through the API (`POST /me/onboarding/interests`): `categoryIds`, or none —
 * the skip.
 */
export async function answerInterestsThroughApi(
  context: APIRequestContext,
  expectedAccountId: string,
  categoryIds: readonly number[],
): Promise<Me> {
  return unwrap<Me>(
    await context.post('/api/v1/me/onboarding/interests', {
      data: { categoryIds, expectedAccountId },
    }),
  );
}

export interface OnboardingOptions {
  /** The number to verify; a fresh one unless given. */
  phone?: string;
  /** The nickname to set at the nickname step; the auto nickname confirmed unless given. */
  nickname?: string;
}

/**
 * Whatever is left of the onboarding of the account `context` is signed in as, through the API
 * (#58): what every spec's accounts go through on their way to the screens they test, quickly —
 * onboarding.spec.ts and phone-verification.spec.ts walk the screens themselves. Returns `GET /me`
 * once nothing is left, and the number verified.
 */
export async function completeOnboardingThroughApi(
  context: APIRequestContext,
  { phone = freshPhone(), nickname }: OnboardingOptions = {},
): Promise<{ me: Me; phone: string }> {
  let me = await meOf(context);
  if (!me.onboarding.consent) me = await agreeThroughApi(context, me.id);
  if (!me.onboarding.verification) {
    await verifyThroughApi(context, me.id, phone);
    me = await meOf(context);
  }
  if (!me.onboarding.nickname) {
    me = await confirmNicknameThroughApi(context, me.id, nickname ?? me.profile.nickname);
  }
  if (!me.onboarding.interests) me = await answerInterestsThroughApi(context, me.id, []);
  expect(me.onboarding.nextStep).toBeNull();
  return { me, phone };
}

/**
 * Sign-up (ADR-0024, #58): /set-password takes the first password and goes home, where the
 * onboarding gate takes the account on to its first step, the consent. The rest of the onboarding
 * — consent, 본인확인 (a fresh number unless `phone` is given), the nickname (the auto one confirmed
 * unless `nickname` is given) and the interest categories skipped — is done through the API
 * (`completeOnboardingThroughApi`) with the page's own cookie, and the page goes home: it lands
 * there onboarded. Creating the account granted nothing (#70); the nickname step recorded its start
 * Coin, paid while the release setting 시작 지급액 has a value and waiting otherwise (ADR-0071).
 * Returns the number it verified.
 */
export async function signUp(
  page: Page,
  email: string,
  phone: string = freshPhone(),
  { nickname }: Pick<OnboardingOptions, 'nickname'> = {},
): Promise<string> {
  await openSetPassword(page, email);
  await setFirstPassword(page);
  await expect(page).toHaveURL('/onboarding');
  await expect(page.getByTestId('consent-step')).toBeVisible();
  await completeOnboardingThroughApi(page.request, { phone, ...(nickname ? { nickname } : {}) });
  await page.goto('/');
  await expect(page).toHaveURL('/');
  return phone;
}

/**
 * Signs an existing account in through the login form; lands on `/` with no `next`. The account
 * must have finished its onboarding — every `signUp` account has, and the seed admins do in the
 * `admin` and `secondAdmin` fixtures — or the onboarding gate (#58) sends it to /onboarding
 * instead.
 */
export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(copy.email).fill(email);
  await page.getByLabel(copy.password, { exact: true }).fill(password);
  await page.getByRole('button', { name: copy.loginWithEmail }).click();
  await expect(page).toHaveURL('/');
}

/**
 * Signs the browser out the way a reader does: 로그아웃 is in MY (#16, owner decision 2026-10-13 —
 * the header has no profile menu), and it lands on `/` with the 로그인 link back in the header.
 */
export async function logOut(page: Page): Promise<void> {
  await page.goto('/my');
  await page.getByTestId('my-logout').click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('link', { name: copy.login })).toBeVisible();
}

/**
 * The tab's account switched under its screen (A-PG-24, ADR-0078 7-29): the page's cookie becomes
 * `to`'s — what another tab signing in as `to` leaves it with — and the session is read again (on
 * the `visibilitychange` better-auth refetches it on), so the session, and SessionCacheGuard with
 * it, says `to`. `GET /me`, and each request `held` picks, still go as the account the screen
 * showed — through `shown`, a request context holding that account's cookie — so the guard's reset
 * draws the screen again from that account's `Me`: the render between the session naming another
 * account and the guard's reset, held for as long as the spec needs it. Every other request goes
 * with `to`'s cookie. Resolves once the session said `to` and `['me']` was read again after it.
 */
export async function switchAccountUnderScreen(
  page: Page,
  shown: APIRequestContext,
  to: { id: string; cookies: Cookie[] },
  held: (request: Request) => boolean = () => false,
): Promise<void> {
  const shownMe = await meOf(shown);
  const isMeRead = (request: Request) =>
    request.method() === 'GET' && new URL(request.url()).pathname === '/api/v1/me';
  await page.route(
    (url) => url.pathname.startsWith('/api/v1/me'),
    async (route) => {
      const request = route.request();
      if (!isMeRead(request) && !held(request)) return route.fallback();
      // The page's own headers but its cookie — `shown`'s jar supplies the shown account's — and
      // those the request context sets itself.
      const headers = Object.fromEntries(
        Object.entries(await request.allHeaders()).filter(
          ([name]) => !['cookie', 'content-length', 'host', 'connection'].includes(name),
        ),
      );
      const response = await shown.fetch(request.url(), {
        method: request.method(),
        headers,
        data: request.postDataBuffer() ?? undefined,
      });
      await route.fulfill({ response });
    },
  );
  let sessionAnswered = false;
  const onSession = (response: Response) => {
    if (new URL(response.url()).pathname === '/api/auth/get-session') sessionAnswered = true;
  };
  page.on('response', onSession);
  try {
    const sessionRead = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/auth/get-session',
    );
    const meRead = page.waitForResponse(
      (response) => sessionAnswered && isMeRead(response.request()),
    );
    await page.context().clearCookies();
    await page.context().addCookies(to.cookies);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const session = (await (await sessionRead).json()) as { user?: { id?: string } } | null;
    expect(session?.user?.id).toBe(to.id);
    const drawn = (await (await meRead).json()) as { data: Me };
    expect(drawn.data.id).toBe(shownMe.id);
  } finally {
    page.off('response', onSession);
  }
}

/**
 * The tab's cookie becomes another account's — what another window signing in as that account
 * leaves it with — and nothing is read again: no `visibilitychange`, so better-auth's session and
 * `['me']` still say the account the page shows. The order two windows side by side take
 * (SessionCacheGuard's header): the next write the page sends names the account it shows with the
 * other account's cookie, and the refusal's own session read is the first to say the other
 * account — SessionCacheGuard's reset, and the screen drawn again for that account, come after the
 * refusal (ADR-0091). `switchAccountUnderScreen` holds the other order: the session read again
 * first.
 */
export async function swapCookieUnderScreen(page: Page, cookies: Cookie[]): Promise<void> {
  await page.context().clearCookies();
  await page.context().addCookies(cookies);
}

/**
 * The answer to the first `GET /me` the page sends from now on — never one already on its way, which
 * still carries the cookie the tab had when it was sent. For a spec that changes the tab's cookie
 * and then makes `['me']` read again (ADR-0090 결정 4-2's order): the answer it waits for is the
 * new cookie's.
 */
export function nextMeRead(page: Page): Promise<Response> {
  const sent = new Set<Request>();
  const onRequest = (request: Request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/v1/me') {
      sent.add(request);
    }
  };
  page.on('request', onRequest);
  return page
    .waitForResponse((response) => sent.has(response.request()))
    .finally(() => page.off('request', onRequest));
}

/**
 * ADR-0090 결정 4-2's order, the reverse of `switchAccountUnderScreen`'s: `['me']` turns from the
 * account the page shows to `to` in place, before the session does, so SessionCacheGuard resets
 * nothing — a window-focus refetch of `GET /me` answered with `to`'s cookie while better-auth's
 * session still says the shown account. Held as phone-verification.spec.ts holds it: better-auth's
 * answers keep coming from `shown`'s jar (given the page's cookies here — its body only, since a
 * cookie the shown account's answer set would put that account back in the tab), `to`'s cookie
 * goes into the tab, and the page's clock — installed (`page.clock.install()`) before the page was
 * opened — makes `['me']` older than its `staleTime` (30 s) for the focus refetch. Resolves once
 * `GET /me` has answered as `to`; the get-session route stays until the spec unroutes it.
 */
export async function switchMeBeforeSession(
  page: Page,
  shown: BrowserContext,
  to: { id: string; cookies: Cookie[] },
): Promise<void> {
  await shown.addCookies(await page.context().cookies());
  await page.route(
    (url) => url.pathname === '/api/auth/get-session',
    async (route) => {
      const answer = await shown.request.get(route.request().url());
      await route.fulfill({ status: answer.status(), json: (await answer.json()) as unknown });
    },
  );
  await page.context().clearCookies();
  await page.context().addCookies(to.cookies);
  const meRead = nextMeRead(page);
  await page.clock.fastForward('00:31');
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  const drawn = (await (await meRead).json()) as { data: Me };
  expect(drawn.data.id).toBe(to.id);
}

/**
 * Two members in ADR-0090 결정 4-2's order, for a screen drawn for the account on screen: A signed
 * up on `page`, B in a browser context of its own. `open` installs the page's clock — so
 * `switchMeBeforeSession` can make `['me']` older than its `staleTime` — and opens `path` as A;
 * `toB` turns `['me']` from A to B in place, better-auth's session still A's
 * (`switchMeBeforeSession`), and `toA` back: A's cookie in the tab again and `GET /me` read again
 * as A (on the same `visibilitychange`), the session still answered as A. `close` ends both
 * contexts and the page's routes. A spec makes what `path` shows between the two: A's and B's
 * accounts are there (`a`, `b`, and `other`, B's page). `bStepLeft`: B stops at its first
 * onboarding step (the consent, its first password set — `openSetPassword`), so the onboarding
 * gate puts its placeholder in place of A's page in the very render `['me']` turns to B, and moves
 * on to `/onboarding`; `toA` then lands back on `path` (the stepper sends an account with nothing
 * left on to its `next`).
 */
export async function membersTurningInPlace(
  browser: Browser,
  page: Page,
  { bStepLeft = false }: { bStepLeft?: boolean } = {},
): Promise<{
  a: Me;
  b: Me;
  other: Page;
  open: (path: string) => Promise<void>;
  toB: () => Promise<void>;
  toA: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const otherContext = await browser.newContext();
  const shownContext = await browser.newContext();
  const close = async () => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await otherContext.close();
    await shownContext.close();
  };
  try {
    const other = await otherContext.newPage();
    if (bStepLeft) {
      await openSetPassword(other, freshEmail());
      await setFirstPassword(other);
      await expect(other).toHaveURL('/onboarding');
    } else {
      await signUp(other, freshEmail());
    }
    const b = await meOf(other.request);
    expect(b.onboarding.nextStep).toBe(bStepLeft ? 'consent' : null);
    await signUp(page, freshEmail());
    const a = await meOf(page.request);
    expect(a.id).not.toBe(b.id);
    const aCookies = await page.context().cookies();
    const open = async (path: string) => {
      await page.clock.install();
      await page.goto(path);
    };
    const toB = async () =>
      switchMeBeforeSession(page, shownContext, {
        id: b.id,
        cookies: await otherContext.cookies(),
      });
    const toA = async () => {
      await page.context().clearCookies();
      await page.context().addCookies(aCookies);
      const meRead = nextMeRead(page);
      await page.clock.fastForward('00:31');
      await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
      const drawn = (await (await meRead).json()) as { data: Me };
      expect(drawn.data.id).toBe(a.id);
    };
    return { a, b, other, open, toB, toA, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * The forward order with nothing held (SessionCacheGuard's own, ADR-0092 결정 10): `to`'s cookie
 * goes into the tab — what another window signing in as `to` leaves it with — and the session is
 * read again on the `visibilitychange` better-auth refetches it on, so SessionCacheGuard resets the
 * cache and `GET /me` is read again with that cookie: the screen is `to`'s. Unlike
 * `switchAccountUnderScreen`, which answers `GET /me` as the account shown, nothing is routed. The
 * page's clock — installed (`page.clock.install()`) before the page was opened — moves past
 * better-auth's limit of one focus refetch in 5 s first (`FOCUS_REFETCH_RATE_LIMIT_SECONDS`), so a
 * spec can turn the session there and back. Resolves once the session said `to` and `GET /me`
 * answered for it.
 */
export async function switchSessionTo(
  page: Page,
  to: { id: string; cookies: Cookie[] },
): Promise<void> {
  await page.clock.fastForward('00:06');
  await page.context().clearCookies();
  await page.context().addCookies(to.cookies);
  const sessionRead = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/auth/get-session',
  );
  const meRead = nextMeRead(page);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const session = (await (await sessionRead).json()) as { user?: { id?: string } } | null;
  expect(session?.user?.id).toBe(to.id);
  const drawn = (await (await meRead).json()) as { data: Me };
  expect(drawn.data.id).toBe(to.id);
}

/**
 * The return in the mixed order (ADR-0092 8-36), as a browser brings it: `to`'s cookie goes into the
 * tab — `to` signed in again in another window — and one `visibilitychange`, dispatched as a
 * browser dispatches it (bubbling from the document to the window), makes better-auth read the
 * session again (its listener is the document's) and TanStack Query read the stale `['me']` again
 * (its focus listener is the window's). The page's clock — installed (`page.clock.install()`)
 * before the page was opened — moves past `['me']`'s `staleTime` (30 s) first, and so past
 * better-auth's 5 s limit. The session's answer is held until `GET /me` has answered as `to`:
 * `['me']` turns in place first and the screen is drawn for `to` — `between` looks at it then —
 * and only then does the session say `to`, so SessionCacheGuard resets the cache for the account
 * already on screen and `GET /me` is read again. Resolves once that read has answered.
 */
export async function switchMeThenSessionTo(
  page: Page,
  to: { id: string; cookies: Cookie[] },
  between: () => Promise<void> = () => Promise.resolve(),
): Promise<void> {
  await page.clock.fastForward('00:31');
  await page.context().clearCookies();
  await page.context().addCookies(to.cookies);
  const isSessionRead = (url: URL) => url.pathname === '/api/auth/get-session';
  const isMeRead = (request: Request) =>
    request.method() === 'GET' && new URL(request.url()).pathname === '/api/v1/me';
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hold = async (route: Route) => {
    await released;
    await route.continue().catch(() => undefined);
  };
  await page.route(isSessionRead, hold);
  // The reads of `GET /me` sent once the session has answered: the reset's.
  let sessionAnswered = false;
  const afterSession = new Set<Request>();
  const onResponse = (response: Response) => {
    if (isSessionRead(new URL(response.url()))) sessionAnswered = true;
  };
  const onRequest = (request: Request) => {
    if (sessionAnswered && isMeRead(request)) afterSession.add(request);
  };
  page.on('response', onResponse);
  page.on('request', onRequest);
  try {
    const meRead = nextMeRead(page);
    await page.evaluate(() =>
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true })),
    );
    const drawn = (await (await meRead).json()) as { data: Me };
    expect(drawn.data.id).toBe(to.id);
    await between();
    const sessionRead = page.waitForResponse((response) => isSessionRead(new URL(response.url())));
    const meAgain = page.waitForResponse((response) => afterSession.has(response.request()));
    release();
    const session = (await (await sessionRead).json()) as { user?: { id?: string } } | null;
    expect(session?.user?.id).toBe(to.id);
    const again = (await (await meAgain).json()) as { data: Me };
    expect(again.data.id).toBe(to.id);
  } finally {
    release();
    page.off('response', onResponse);
    page.off('request', onRequest);
    await page.unroute(isSessionRead, hold);
  }
}

/**
 * Two members in the forward order (`switchSessionTo`), for a screen drawn for the account on
 * screen: A signed up on `page`, B in a browser context of its own. `open` installs the page's
 * clock and opens `path` as A; `toB` turns the tab's session to B first — SessionCacheGuard's reset
 * empties `['me']`, and `GET /me` answers as B — and `toA` back the same way; `toAMeFirst` back in
 * the mixed order instead (`switchMeThenSessionTo` — `GET /me` answers A before the session does,
 * `between` looking at the screen then). `close` ends B's context. A spec makes what `path` shows
 * between the two.
 */
export async function membersSwitchingSessions(
  browser: Browser,
  page: Page,
): Promise<{
  a: Me;
  b: Me;
  open: (path: string) => Promise<void>;
  toB: () => Promise<void>;
  toA: () => Promise<void>;
  toAMeFirst: (between?: () => Promise<void>) => Promise<void>;
  close: () => Promise<void>;
}> {
  const otherContext = await browser.newContext();
  const close = () => otherContext.close();
  try {
    const other = await otherContext.newPage();
    await signUp(other, freshEmail());
    const b = await meOf(other.request);
    await signUp(page, freshEmail());
    const a = await meOf(page.request);
    expect(a.id).not.toBe(b.id);
    const aCookies = await page.context().cookies();
    const bCookies = await otherContext.cookies();
    const open = async (path: string) => {
      await page.clock.install();
      await page.goto(path);
    };
    const toB = () => switchSessionTo(page, { id: b.id, cookies: bCookies });
    const toA = () => switchSessionTo(page, { id: a.id, cookies: aCookies });
    const toAMeFirst = (between?: () => Promise<void>) =>
      switchMeThenSessionTo(page, { id: a.id, cookies: aCookies }, between);
    return { a, b, open, toB, toA, toAMeFirst, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The first seed admin, for a spec that needs a second signed-in browser without a second mailbox. */
export const adminAccount = { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } as const;

/** The second seed admin (#171); a spec that signs a browser in as it asks for `secondAdmin`. */
export const secondAdminAccount = {
  email: SECOND_ADMIN_EMAIL,
  password: SECOND_ADMIN_PASSWORD,
} as const;

// ---- the market under test ----------------------------------------------------------

export interface TestMarket {
  /** Canonical lower-cased uuid: the realtime room, the ticks route and the cache key. */
  id: string;
  /** What `/markets/[slug]` is opened with. */
  slug: string;
  title: string;
  /**
   * Its YES 조건 as sent (`ruleItems.yesCondition`, #23): the rules snippet a spec finds in the
   * detail's 규칙 and in the server's HTML (AC 2). It holds the `tag`, never the word 규칙.
   */
  yesCondition: string;
  /**
   * Every rule item as sent (#23, ADR-0097): `ruleItemsFor(tag)` with `description` and
   * `ruleItems` (`CreateOpenMarketOptions`) over it.
   */
  ruleItems: MarketRuleItems;
  /** Its 거래 마감 시각 as sent: a day from its making unless `closeAt` said otherwise. */
  closeAt: string;
  /**
   * Its times but the close as sent (#22, ADR-0098): `timesFor(closeAt, ruleItems.eventDeadline)`
   * with `times` (`CreateOpenMarketOptions`) over it.
   */
  times: MarketTimes;
  /**
   * The random part of the title and the slug — and the market's one tag unless `tags` named
   * others (#17). Unique per run, so `/search?q=<tag>` is a search screen holding exactly this
   * market's card and nothing else — which is what makes AC 1's card assertion independent of
   * how many markets the database already has. Every status is searched until one is picked
   * (ADR-0066), so it finds the market after a close too.
   */
  tag: string;
  /** Its tags as sent, in order (#17): `[tag]` unless `tags` named others. */
  tags: string[];
  /**
   * The slug of the TOP-LEVEL category it is under: the market is filed under that category's
   * first sub-category, or under it when it has none (#17: a category with sub-categories takes no
   * market). `/?category=<slug>` lists it — a top-level slug lists its sub-categories' markets — as
   * do the header's category row and the search and community screens' category selects, which
   * offer that slug. The admin market form and the proposal draft select do not: their options are
   * ids, and a top-level category with sub-categories is no pickable option there.
   */
  categorySlug: string;
}

export interface CreateOpenMarketOptions {
  /**
   * Which TOP-LEVEL category, by position in `GET /categories` (parents first, in display
   * order): 0, the default, is the first. The market goes under its first sub-category, the
   * category a market may be filed under (#17), or under it when it has none. A spec that needs
   * markets in two different categories passes 1 for the second. Throws when the seed has fewer.
   *
   * A spec that must find its market on the HOME itself (which takes no search term since
   * ADR-0066) opens `/?category=<slug>&sort=newest`: the market it just opened is on that first
   * page only while fewer than a page of others are opened in the category meanwhile, which the
   * default category cannot promise while other workers run. Such a spec takes a category no
   * other spec uses: 2 is home.spec's 관심 시장 test, 3 is market.spec's AC 1.
   */
  topLevelCategory?: number;
  /**
   * A word put in the title before the market's own tag, for a spec that lists several markets
   * together: give them one `freshTag()` and `/search?q=<group>` holds exactly them, in the order
   * the sort picked — which is how the order on screen can be checked at all on a database every
   * earlier run has added to. No group, the default: the title is the tag alone.
   */
  group?: string;
  /**
   * The market's 배경 (`description`), which the detail draws as its own section before 규칙
   * (#122). The default is `ruleItemsFor`'s sentence: 배경 is a rule item opening asks for (#23),
   * so an open market always has the section — only one opened before #23 can lack it.
   */
  description?: string;
  /**
   * Its tags, 1..5 (#17: opening takes at least one), in the order the detail shows them. The
   * default is the market's own `tag`, which no other market has, so a search for it still finds
   * this market alone. `[]` makes a draft without tags, which `createOpenMarket` cannot open.
   */
  tags?: string[];
  /**
   * Rule items over `ruleItemsFor(tag)`'s complete set (#23, ADR-0097), `description` included
   * (it wins over the option above): fallbacks and their switch condition, say, or a blank (`''`,
   * `null`, `[]`) for a draft the open-items check finds incomplete — which `createOpenMarket`
   * cannot open.
   */
  ruleItems?: Partial<MarketRuleItems>;
  /**
   * The 거래 마감 시각, an ISO instant: a day from now by default. A close that has passed is
   * refused by the API (it must be in the future), and one too near is closed by the worker.
   */
  closeAt?: string;
  /**
   * Times over `timesFor`'s (#22, ADR-0098): another 판정 기준 시간대, say, or a blank (`null`) for
   * a draft the open-items check finds incomplete — which `createOpenMarket` cannot open. A
   * scheduled open still ahead is a draft's: approved, it would wait for it as 개장 예정 (#21), so
   * `createOpenMarket` refuses it. An announcement time makes a market that cannot be submitted
   * for review while the release setting `market.lead_close_gap` is 미정 (ADR-0098).
   */
  times?: Partial<MarketTimes>;
}

/**
 * A complete set of rule items for the market of `tag` (#23, ADR-0097), as the create body and the
 * public `Market` carry them: every text holds the tag and none the word 규칙 (AC 2 looks for the
 * heading and the YES condition apart), and none says 환불 or 원금, or that a late result alone is
 * NO (N03 §4·§6). The 1차 출처 has an https address under `https://example.com/e2e/<tag>`, which
 * the link review then exempts for this market alone (ADR-0083 7-9); there is no fallback, so no
 * switch condition, and the detail's 대체 출처 reads 없음. The 사건 기한 is a day after the
 * `createOpenMarket` close. With a title, the times (`timesFor`), a category and a tag, the
 * open-items check passes.
 */
export function ruleItemsFor(tag: string): MarketRuleItems {
  return {
    description: `자동화 테스트가 만든 시장의 배경입니다. 확인 코드 ${tag}.`,
    yesCondition: `사건 기한까지 확인 코드가 발표되면 YES입니다. 확인 코드 ${tag}.`,
    noCondition: `사건 기한까지 확인 코드가 발표되지 않으면 NO입니다. 확인 코드 ${tag}.`,
    eventDeadline: new Date(Date.now() + EVENT_DEADLINE_IN_MS).toISOString(),
    primarySource: { name: `테스트 1차 출처 ${tag}`, url: `https://example.com/e2e/${tag}` },
    fallbackSources: [],
    fallbackCondition: '',
    longDelayDays: 14,
    delayHandling:
      '장기 지연 기한까지 판정하지 못하면 무효로 판정합니다. ' +
      '사건이 취소되거나 연기되어도 무효입니다. ' +
      `발표가 늦어진 것만으로 NO로 판정하지 않습니다. 확인 코드 ${tag}.`,
  };
}

/** An ISO instant as the admin's `datetime-local` holds it: KST wall-clock minutes. */
export function kstLocalOf(iso: string): string {
  return new Date(Date.parse(iso) + KST_OFFSET_MS).toISOString().slice(0, 16);
}

/**
 * Types `items` into the admin market form's 규칙 항목 (#23, the create card's or the detail's):
 * each text, the event deadline in KST, the 1차 출처's name and address, the long-delay days. A
 * fallback is added with 대체 출처 추가 and filled row by row, so the form must have none yet; the
 * switch condition is typed once its input shows. A null or blank item is typed as blank.
 */
export async function fillRuleItemInputs(page: Page, items: MarketRuleItems): Promise<void> {
  await page.getByTestId('market-description').fill(items.description ?? '');
  await page.getByTestId('market-yes-condition').fill(items.yesCondition);
  await page.getByTestId('market-no-condition').fill(items.noCondition);
  await page
    .getByTestId('market-event-deadline')
    .fill(items.eventDeadline === null ? '' : kstLocalOf(items.eventDeadline));
  await page.getByTestId('market-primary-source-name').fill(items.primarySource?.name ?? '');
  await page.getByTestId('market-primary-source-url').fill(items.primarySource?.url ?? '');
  for (const [index, source] of items.fallbackSources.entries()) {
    await page.getByTestId('market-fallback-add').click();
    await page.getByTestId(`market-fallback-${String(index)}-name`).fill(source.name);
    await page.getByTestId(`market-fallback-${String(index)}-url`).fill(source.url);
  }
  if (items.fallbackSources.length > 0) {
    await page.getByTestId('market-fallback-condition').fill(items.fallbackCondition);
  }
  await page
    .getByTestId('market-long-delay-days')
    .fill(items.longDelayDays === null ? '' : String(items.longDelayDays));
  await page.getByTestId('market-delay-handling').fill(items.delayHandling);
}

/** `ms` floored to its whole minute. */
function floorMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** `ms` raised to the next whole minute unless it is one. */
function ceilMinute(ms: number): number {
  return Math.ceil(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * A complete set of times for a market that closes at `closeAt` with the 사건 기한 `eventDeadline`
 * (#22, ADR-0098), as the create body and the public `Market` carry them:
 *
 * - 예정 개장 시각: a minute before this minute, so the approval opens the market at once (#21,
 *   ADR-0100; ADR-0093 decision 2 #172 item 6 — it waits for no job), on any clock the database's
 *   is a few seconds off from.
 * - 발표 예정 시각: none ('없음'), so the lead close the open-items check holds a market to
 *   (`market.lead_close_gap`, a release setting no spec writes — docs/SETTINGS.md) never blocks
 *   one; while that setting is 미정 a market with an announcement time cannot be submitted.
 * - 예정 판정 시각: a day after the later of the close and the 사건 기한, on a whole minute — derived
 *   from the final items, so an override of either still keeps close ≤ judgement (#172 item 12)
 *   and 사건 기한 ≤ judgement (owner answer 2026-10-31 A1), which the API and the database check
 *   to the minute.
 * - 판정 기준 시간대: Asia/Seoul, the form's pre-fill.
 */
export function timesFor(
  closeAt: string,
  eventDeadline: string | null,
  now: number = Date.now(),
): MarketTimes {
  const latest = Math.max(Date.parse(closeAt), Date.parse(eventDeadline ?? closeAt));
  return {
    scheduledOpenAt: new Date(floorMinute(now) - MINUTE_MS).toISOString(),
    scheduledAnnouncementAt: null,
    scheduledJudgementAt: new Date(ceilMinute(latest) + JUDGEMENT_AFTER_MS).toISOString(),
    judgementTimeZone: DEFAULT_JUDGEMENT_TIME_ZONE,
  };
}

/**
 * Types `times` into the admin market form's 시각 (#22, the create card's or the detail's), each
 * time in KST as `kstLocalOf` writes it — to the minute — and a null as blank, which for the
 * announcement is '없음'; the close too when `closeAt` is given. The 판정 기준 시간대 is picked
 * when it is not null; null leaves the select as it is (Asia/Seoul pre-filled, #172 item 11).
 * For 시장 만들기 or a draft's form: an open market's edit form has every time off (#80), and its
 * close is typed into the 규칙 보충 form, where the scheduled open and judgement are locked (#172
 * item 14) — so a spec types its close alone there.
 */
export async function fillTimeInputs(
  page: Page,
  times: MarketTimes & { closeAt?: string },
): Promise<void> {
  const local = (iso: string | null) => (iso === null ? '' : kstLocalOf(iso));
  await page.getByTestId('market-scheduled-open-at').fill(local(times.scheduledOpenAt));
  if (times.closeAt !== undefined) {
    await page.getByTestId('market-close-at').fill(local(times.closeAt));
  }
  await page
    .getByTestId('market-scheduled-announcement-at')
    .fill(local(times.scheduledAnnouncementAt));
  await page.getByTestId('market-scheduled-judgement-at').fill(local(times.scheduledJudgementAt));
  if (times.judgementTimeZone !== null) {
    await page.getByTestId('market-judgement-time-zone').selectOption(times.judgementTimeZone);
  }
}

/**
 * A word no market title holds yet: base36 time and randomness, [a-z0-9] and so slug-safe
 * (MARKET_SLUG_PATTERN allows '-'). The tag of every `createOpenMarket`, and a spec's own
 * `group`, or a search term no market answers.
 */
export function freshTag(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** `{ data }` out of the PLAN 7 success envelope, with the body in the message on a failure. */
async function unwrap<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  if (!response.ok()) {
    throw new Error(`${response.url()} -> ${String(response.status())} ${body}`);
  }
  return (JSON.parse(body) as { data: T }).data;
}

/**
 * Creates a draft through `POST /admin/markets` and opens it through the review
 * (`openThroughReview`), so the spec owns a market that is `open` and closes a day from now
 * whatever the calendar says. Its scheduled open has passed (`timesFor`, #22), so the approval
 * opens it at once (#21, ADR-0100), and the open records its content as rule v1 (#80, ADR-0101):
 * its `ruleVersion` is 1, and its rule version items change by a supplement alone
 * (`requestSupplement`, `approveSupplementAsReviewer`). It has no fill — orders.spec.ts trades
 * through the API on its own markets (#119; the order panel is #66), and `closeMarket` trades one
 * pair just before it closes one (#20) — so its price reads 체결 없음 and its chart is empty (N02
 * §5): opening writes no price tick.
 */
export async function createOpenMarket(
  admin: APIRequestContext,
  options: CreateOpenMarketOptions = {},
): Promise<TestMarket> {
  const draft = await createDraftMarket(admin, options);
  const open = await openThroughReview(admin, draft.id);
  return { ...draft, id: open.id, slug: open.slug };
}

/**
 * The checklist of an approval (#172 item 4), every item confirmed, in MARKET_REVIEW_CHECKLIST
 * order — restated, as this file takes only types from @buddha/shared; the record's type makes it
 * whole.
 */
const CHECKLIST_ITEMS: Readonly<Record<MarketReviewChecklistItem, true>> = {
  knownResult: true,
  ambiguity: true,
  duplicate: true,
  requiredItems: true,
  timeOrder: true,
  leadClose: true,
  independence: true,
};
export const REVIEW_CHECKLIST = Object.keys(CHECKLIST_ITEMS) as MarketReviewChecklistItem[];

/** The reason every helper approval gives (1..500 characters, #172 item 4). */
const HELPER_APPROVAL_REASON = '자동화 테스트의 시장입니다. 체크리스트를 모두 확인했습니다.';

/** The second seed admin `admin` was handed with (`test`'s `reviewer`). */
function reviewerOf(admin: APIRequestContext): APIRequestContext {
  const reviewer = reviewers.get(admin);
  if (reviewer === undefined) {
    throw new Error('no reviewer goes with this context: pass the `admin` fixture of `test`');
  }
  return reviewer;
}

/** `POST /admin/markets/:id/<write>` as the admin `context` is signed in as (ADR-0092). */
async function marketWrite(
  context: APIRequestContext,
  marketId: string,
  write: 'submit' | 'approve' | 'revert',
  body: Record<string, unknown> = {},
): Promise<AdminMarket> {
  return unwrap<AdminMarket>(
    await context.post(`/api/v1/admin/markets/${marketId}/${write}`, {
      data: { ...body, expectedAccountId: await accountIdOf(context) },
    }),
  );
}

/**
 * 검수 제출 (#78) of a complete draft through the API, as `admin`: the answer, in review — its
 * `review.pending.requestId` is what an approval names.
 */
export async function submitForReview(
  admin: APIRequestContext,
  marketId: string,
): Promise<AdminMarket> {
  const submitted = await marketWrite(admin, marketId, 'submit');
  expect(submitted.status).toBe('review');
  return submitted;
}

/**
 * 승인 (#78) of a market in review, as the second seed admin `admin` was handed with (`test`'s
 * `reviewer`), who neither made nor submitted it: every checklist item and a reason, naming the
 * pending request (`requestId`, read when not given). The answer is OPEN when the scheduled open
 * had passed at the approval, which opens it at once (#21, ADR-0100), and 개장 예정 otherwise —
 * the worker opens it at that time.
 */
export async function approveAsReviewer(
  admin: APIRequestContext,
  marketId: string,
  requestId?: string,
): Promise<AdminMarket> {
  const reviewer = reviewerOf(admin);
  const pending =
    requestId ??
    (await unwrap<AdminMarket>(await reviewer.get(`/api/v1/admin/markets/${marketId}`))).review
      .pending?.requestId;
  if (pending === undefined) throw new Error(`market ${marketId} is not in review`);
  return marketWrite(reviewer, marketId, 'approve', {
    requestId: pending,
    checklist: REVIEW_CHECKLIST,
    reason: HELPER_APPROVAL_REASON,
  });
}

/**
 * Sends a market in review or 개장 예정 back to a draft as `context`'s admin, so a run that failed
 * halfway leaves neither the 검수 대기 list of a persistent database longer nor a stray market
 * public: a submitter's own 되돌리기 retracts its request. Best effort, for a failure's cleanup.
 */
export async function sendBackToDraft(context: APIRequestContext, marketId: string): Promise<void> {
  const market = await context
    .get(`/api/v1/admin/markets/${marketId}`)
    .then((response) => unwrap<AdminMarket>(response))
    .catch(() => null);
  if (market?.status !== 'review' && market?.status !== 'scheduled') return;
  await marketWrite(context, marketId, 'revert', { reason: '시험 정리' }).catch(() => undefined);
}

/**
 * A 검수 제출 through the API that the open-items check refuses (#78; #17, #23, #22): 422
 * OPEN_ITEMS_MISSING, and the items its details name, in the check's order — the items the draft's
 * notice names (`missingOpenItems`), while its 검수 제출 is off.
 */
export async function submitRefusedItems(
  admin: APIRequestContext,
  marketId: string,
): Promise<string[]> {
  const response = await admin.post(`/api/v1/admin/markets/${marketId}/submit`, {
    data: { expectedAccountId: await accountIdOf(admin) },
  });
  const body = await response.text();
  expect(response.status(), body).toBe(422);
  const { error } = JSON.parse(body) as {
    error: { code: string; details: { path: (string | number)[] }[] };
  };
  expect(error.code).toBe('OPEN_ITEMS_MISSING');
  return error.details.map((detail) => detail.path.join('.'));
}

/**
 * Opens a complete draft the only way there is since #21 (ADR-0100): `admin` submits it for
 * review and the second seed admin approves it (`approveAsReviewer`) — its scheduled open has
 * passed, so the approval opens it at once (ADR-0093 decision 2 #172 item 6) and records the
 * content it locked as rule v1 (#80, ADR-0101). For a market a spec made on screen: the screen
 * still shows the draft until it is read again. Throws, after sending the market back to a draft,
 * when it does not open — a scheduled open still ahead, say.
 */
export async function openThroughReview(
  admin: APIRequestContext,
  marketId: string,
): Promise<AdminMarket> {
  const submitted = await submitForReview(admin, marketId);
  let approved: AdminMarket;
  try {
    approved = await approveAsReviewer(admin, marketId, submitted.review.pending?.requestId);
  } catch (error) {
    await sendBackToDraft(admin, marketId);
    throw error;
  }
  if (approved.status !== 'open') {
    await sendBackToDraft(admin, marketId);
    throw new Error(
      `market ${marketId} was approved as ${approved.status}, not opened: its scheduled open ` +
        `(${String(approved.scheduledOpenAt)}) has to have passed`,
    );
  }
  return approved;
}

// ---- 규칙 보충 (#80) -------------------------------------------------------------------

/**
 * The reason every helper supplement gives (#172 item 15: 1..500 characters), public in the
 * market's rule version history once approved.
 */
export const HELPER_SUPPLEMENT_REASON = '자동화 테스트의 보충입니다. 문구를 다듬습니다.';

/**
 * The 정산 영향 검토 every helper supplement gives (1..500 characters): why it moves no judgement
 * and no Coin. The operators' alone — no public answer carries it.
 */
export const HELPER_SUPPLEMENT_IMPACT =
  '판정 기준과 출처의 의미가 그대로라 판정과 Coin 지급에 영향이 없습니다.';

/** The reason every helper approval of a supplement gives (1..500 characters). */
const HELPER_SUPPLEMENT_APPROVAL_REASON =
  '보충 문구와 사유를 확인했습니다. 의미가 바뀌지 않습니다.';

export interface SupplementOptions {
  /**
   * The rule version the text is written against: the market's current one unless given (1 for a
   * market with none, which the API refuses as 'none') — a spec that pins 'stale' names another.
   */
  baseVersion?: number;
  /** The supplement's reason: HELPER_SUPPLEMENT_REASON unless given. */
  reason?: string;
  /** Its 정산 영향 검토: HELPER_SUPPLEMENT_IMPACT unless given. */
  settlementImpact?: string;
}

/**
 * 보충 요청 (#80, ADR-0101; ADR-0093 decision 2 #172 item 15) through
 * `POST /admin/markets/:id/supplements` as the admin `context` is signed in as (ADR-0092): the
 * answer as it came, for a spec that reads a refusal. `changes` holds the new value of each item to
 * change, in the update body's shapes (`MarketSupplementChanges`) — or anything else, which the API
 * refuses ('not a supplement item').
 */
export async function sendSupplement(
  context: APIRequestContext,
  marketId: string,
  changes: Record<string, unknown>,
  {
    baseVersion,
    reason = HELPER_SUPPLEMENT_REASON,
    settlementImpact = HELPER_SUPPLEMENT_IMPACT,
  }: SupplementOptions = {},
): Promise<APIResponse> {
  const base =
    baseVersion ??
    (await unwrap<AdminMarket>(await context.get(`/api/v1/admin/markets/${marketId}`)))
      .ruleVersion ??
    1;
  return context.post(`/api/v1/admin/markets/${marketId}/supplements`, {
    data: {
      baseVersion: base,
      changes,
      reason,
      settlementImpact,
      expectedAccountId: await accountIdOf(context),
    },
  });
}

/**
 * `sendSupplement` as `admin`, which must be taken: the market as the request left it — nothing of
 * its text or version changes until the approval — with the request in `supplement.pending`, what
 * `approveSupplementAsReviewer` decides. The market must be OPEN (or PAUSED), its close ahead, its
 * rule version set (opened since #80) and no other supplement waiting on it.
 */
export async function requestSupplement(
  admin: APIRequestContext,
  marketId: string,
  changes: MarketSupplementChanges,
  options: SupplementOptions = {},
): Promise<AdminMarket> {
  const requested = await unwrap<AdminMarket>(
    await sendSupplement(admin, marketId, changes, options),
  );
  if (requested.supplement.pending === null) {
    throw new Error(`market ${marketId} has no waiting supplement after its request`);
  }
  return requested;
}

/**
 * `POST /admin/markets/:id/supplements/:requestId/<decision>` as the admin `context` is signed in
 * as (ADR-0092), the answer as it came: 승인 takes `{reason}`, 반려 `{rejectReason, reason}`, 철회
 * nothing.
 */
export async function sendSupplementDecision(
  context: APIRequestContext,
  marketId: string,
  requestId: string,
  decision: 'approve' | 'reject' | 'retract',
  body: Record<string, unknown> = {},
): Promise<APIResponse> {
  return context.post(`/api/v1/admin/markets/${marketId}/supplements/${requestId}/${decision}`, {
    data: { ...body, expectedAccountId: await accountIdOf(context) },
  });
}

/** The id of the supplement waiting on a market, as `context` reads it. Throws when none waits. */
async function pendingSupplementOf(context: APIRequestContext, marketId: string): Promise<string> {
  const market = await unwrap<AdminMarket>(await context.get(`/api/v1/admin/markets/${marketId}`));
  const pending = market.supplement.pending?.requestId;
  if (pending === undefined) throw new Error(`no supplement waits on market ${marketId}`);
  return pending;
}

/**
 * 승인 (#80, #172 item 15) of the supplement waiting on a market, as the second seed admin `admin`
 * was handed with (`test`'s `reviewer`) — any admin but its requester decides it, so one `admin`
 * asked for — with a reason, naming the waiting request (`requestId`, read when not given). The
 * answer is the market with its new text and its next rule version (`ruleVersion`, and the version
 * history `ruleVersions` the public detail lists); the approval republishes `market:status`, so an
 * open public detail reads it without a reload.
 */
export async function approveSupplementAsReviewer(
  admin: APIRequestContext,
  marketId: string,
  requestId?: string,
): Promise<AdminMarket> {
  const reviewer = reviewerOf(admin);
  const pending = requestId ?? (await pendingSupplementOf(reviewer, marketId));
  return unwrap<AdminMarket>(
    await sendSupplementDecision(reviewer, marketId, pending, 'approve', {
      reason: HELPER_SUPPLEMENT_APPROVAL_REASON,
    }),
  );
}

/**
 * 철회 (#80) of the supplement waiting on a market by its requester `admin`, in any status — a
 * request still waiting at the close ends so, or by another admin's 반려. The answer is the market
 * with no supplement waiting and its text and version as they were.
 */
export async function retractSupplement(
  admin: APIRequestContext,
  marketId: string,
  requestId?: string,
): Promise<AdminMarket> {
  const pending = requestId ?? (await pendingSupplementOf(admin, marketId));
  return unwrap<AdminMarket>(await sendSupplementDecision(admin, marketId, pending, 'retract'));
}

/**
 * Retracts the supplement `context`'s admin left waiting on a market, so a run that failed halfway
 * leaves the 규칙 보충 대기 list of a persistent database no longer. Best effort, for a `finally`:
 * nothing when none waits, or when another admin asked for it.
 */
export async function leaveNoSupplement(
  context: APIRequestContext,
  marketId: string,
): Promise<void> {
  await retractSupplement(context, marketId).catch(() => undefined);
}

// ---- 거래 일시 중단·재개·조기 마감 (#114) ---------------------------------------------------

/**
 * The note every helper pause gives (1..500 characters): what happened. The admins' alone — no
 * public answer carries it (#173 item 13's public record is #24's, and the note is not in it).
 */
export const HELPER_PAUSE_NOTE = '자동화 테스트의 일시 중단입니다. 거래를 멈추고 검토합니다.';

/** The reason every helper next-path request gives (1..500 characters), the admins' alone. */
export const HELPER_PAUSE_DECISION_REASON = '자동화 테스트의 요청입니다. 검토를 마쳤습니다.';

/** The reason every helper approval of a next path gives (1..500 characters). */
const HELPER_PAUSE_APPROVAL_REASON = '요청한 경로와 그 사유를 확인했습니다.';

/**
 * How long `closeMarket` waits for the worker's close of a market whose close came before its
 * early close could: the delayed `market.close` job at `close_at`, or the per-minute scan behind it
 * should the job be lost — a minute, with room for a loaded box.
 */
const CLOSE_ON_SCHEDULE_WAIT_MS = 90_000;

export interface PauseOptions {
  /** The note: HELPER_PAUSE_NOTE unless given. */
  note?: string;
  /**
   * The result's publication instant (ISO), which an `early_result` pause alone records (ADR-0093
   * decision 3 '#114 조기 결과의 공개 시각'): a minute before now for one unless given, and null
   * for any other reason unless given — a spec that pins a refusal sends what it pins.
   */
  resultPublishedAt?: string | null;
}

/**
 * 거래 일시 중단 (#114, ADR-0102; ADR-0093 decision 1 #173 items 2·3) through
 * `POST /admin/markets/:id/pause` as the admin `context` is signed in as (ADR-0092), one admin and
 * at once: the reason, one of the three, and the note — the answer as it came, for a spec that
 * reads a refusal.
 */
export async function sendPause(
  context: APIRequestContext,
  marketId: string,
  reason: MarketPauseReason,
  { note = HELPER_PAUSE_NOTE, resultPublishedAt }: PauseOptions = {},
): Promise<APIResponse> {
  const published =
    resultPublishedAt !== undefined
      ? resultPublishedAt
      : reason === 'early_result'
        ? new Date(Date.now() - MINUTE_MS).toISOString()
        : null;
  return context.post(`/api/v1/admin/markets/${marketId}/pause`, {
    data: {
      reason,
      note,
      resultPublishedAt: published,
      expectedAccountId: await accountIdOf(context),
    },
  });
}

/**
 * `sendPause` as `admin`, which must be taken: the market PAUSED, its pause the first of
 * `pause.history` with no end. The market must be OPEN with its close ahead. `basis_change` (실질
 * 기준 변경) unless another reason is given: its next path carries a review result
 * (`requestPauseDecision`'s `reviewResult`).
 */
export async function pauseMarket(
  admin: APIRequestContext,
  marketId: string,
  reason: MarketPauseReason = 'basis_change',
  options: PauseOptions = {},
): Promise<AdminMarket> {
  const paused = await unwrap<AdminMarket>(await sendPause(admin, marketId, reason, options));
  expect(paused.status).toBe('paused');
  return paused;
}

export interface PauseDecisionOptions {
  /**
   * The pause the request names (`pauseId` — the one its author saw, ADR-0102 9-2): the market's
   * lasting pause as `context` reads it through the admin API unless given (`currentPauseIdOf`);
   * a spec that pins the 'stale' refusal names one that has ended, and a caller that holds the
   * market already passes its pause instead of a read.
   */
  pauseId?: string;
  /**
   * The review result (owner answer Q1 of 2026-11-02): null unless given — what a pause for
   * `early_result` or `ledger_failure` takes, while a `basis_change` pause's request needs one.
   */
  reviewResult?: MarketPauseReviewResult | null;
  /** The request's reason: HELPER_PAUSE_DECISION_REASON unless given. */
  reason?: string;
}

/**
 * A well-formed pause id that names no pause: what a request names on a market with no pause
 * lasting, which the API refuses by its status (`status` 'not paused') before it reads the pause.
 */
const NO_PAUSE_ID = '00000000-0000-4000-8000-000000000000';

/** The id of the pause lasting on `market` (`pause.history`'s one with no end), if one lasts. */
function lastingPauseIdOf(market: AdminMarket): string | undefined {
  return market.pause.history.find((pause) => pause.endedAt === null)?.id;
}

/**
 * The id of the pause lasting on a market as `context` reads it through
 * `GET /admin/markets/:id` — the pause the admin detail's request dialog opens on and names — or
 * NO_PAUSE_ID when none lasts.
 */
export async function currentPauseIdOf(
  context: APIRequestContext,
  marketId: string,
): Promise<string> {
  const market = await unwrap<AdminMarket>(await context.get(`/api/v1/admin/markets/${marketId}`));
  return lastingPauseIdOf(market) ?? NO_PAUSE_ID;
}

/**
 * 재개·조기 마감 요청 (#114; #173 item 2) of a paused market through
 * `POST /admin/markets/:id/pause-decisions` as the admin `context` is signed in as (ADR-0092),
 * naming the pause it is about (`pauseId`): the answer as it came, for a spec that reads a refusal.
 */
export async function sendPauseDecisionRequest(
  context: APIRequestContext,
  marketId: string,
  path: MarketPausePath,
  {
    pauseId,
    reviewResult = null,
    reason = HELPER_PAUSE_DECISION_REASON,
  }: PauseDecisionOptions = {},
): Promise<APIResponse> {
  const named = pauseId ?? (await currentPauseIdOf(context, marketId));
  return context.post(`/api/v1/admin/markets/${marketId}/pause-decisions`, {
    data: {
      pauseId: named,
      path,
      reviewResult,
      reason,
      expectedAccountId: await accountIdOf(context),
    },
  });
}

/**
 * `sendPauseDecisionRequest` as `admin`, which must be taken: the market as the request left it —
 * still PAUSED until the approval — with the request in `pause.pending`, what
 * `approvePauseDecisionAsReviewer` decides. The market must be PAUSED with its close ahead and no
 * other request waiting; `not_judgeable` takes 조기 마감 alone (#173 item 4).
 */
export async function requestPauseDecision(
  admin: APIRequestContext,
  marketId: string,
  path: MarketPausePath,
  options: PauseDecisionOptions = {},
): Promise<AdminMarket> {
  const requested = await unwrap<AdminMarket>(
    await sendPauseDecisionRequest(admin, marketId, path, options),
  );
  if (requested.pause.pending === null) {
    throw new Error(`market ${marketId} has no waiting next path after its request`);
  }
  return requested;
}

/**
 * `POST /admin/markets/:id/pause-decisions/:requestId/<decision>` as the admin `context` is signed
 * in as (ADR-0092), the answer as it came: 승인 and 반려 take `{reason}`, 철회 nothing.
 */
export async function sendPauseDecision(
  context: APIRequestContext,
  marketId: string,
  requestId: string,
  decision: 'approve' | 'reject' | 'retract',
  body: Record<string, unknown> = {},
): Promise<APIResponse> {
  return context.post(
    `/api/v1/admin/markets/${marketId}/pause-decisions/${requestId}/${decision}`,
    { data: { ...body, expectedAccountId: await accountIdOf(context) } },
  );
}

/** The id of the next path waiting on a market, as `context` reads it. Throws when none waits. */
async function pendingPauseDecisionOf(
  context: APIRequestContext,
  marketId: string,
): Promise<string> {
  const market = await unwrap<AdminMarket>(await context.get(`/api/v1/admin/markets/${marketId}`));
  const pending = market.pause.pending?.requestId;
  if (pending === undefined) throw new Error(`no next path waits on market ${marketId}`);
  return pending;
}

/**
 * 승인 (#114, #173 item 2) of the next path waiting on a market, as the second seed admin `admin`
 * was handed with (`test`'s `reviewer`) — any admin but its requester decides it, the admin who
 * paused included — with a reason, naming the waiting request (`requestId`, read when not given).
 * The answer is the market OPEN (재개) or CLOSED (조기 마감) with its pause ended; the approval
 * publishes `market:status`, so an open public detail follows without a reload.
 */
export async function approvePauseDecisionAsReviewer(
  admin: APIRequestContext,
  marketId: string,
  requestId?: string,
): Promise<AdminMarket> {
  const reviewer = reviewerOf(admin);
  const pending = requestId ?? (await pendingPauseDecisionOf(reviewer, marketId));
  return unwrap<AdminMarket>(
    await sendPauseDecision(reviewer, marketId, pending, 'approve', {
      reason: HELPER_PAUSE_APPROVAL_REASON,
    }),
  );
}

/**
 * 철회 (#114) of the next path waiting on a market by its requester `admin`, in any status — a
 * request still waiting at the close ends so, or by another admin's 반려. The answer is the market
 * with no request waiting and its status and pause as they were.
 */
export async function retractPauseDecision(
  admin: APIRequestContext,
  marketId: string,
  requestId?: string,
): Promise<AdminMarket> {
  const pending = requestId ?? (await pendingPauseDecisionOf(admin, marketId));
  return unwrap<AdminMarket>(await sendPauseDecision(admin, marketId, pending, 'retract'));
}

/**
 * Retracts the next path `context`'s admin left waiting on a market, so a run that failed halfway
 * leaves the 일시 중단 결정 대기 list of a persistent database no longer (as `leaveNoSupplement`:
 * a waiting request never expires). Best effort, for a `finally`: nothing when none waits, or when
 * another admin asked for it.
 */
export async function leaveNoPauseDecision(
  context: APIRequestContext,
  marketId: string,
): Promise<void> {
  await retractPauseDecision(context, marketId).catch(() => undefined);
}

/**
 * 마감 before the close, the one way there is since #114 (ADR-0102; ADR-0093 decision 1 #173 items
 * 2·4 — the interim one-admin `POST /admin/markets/:id/close` is gone): `admin` pauses the market
 * as 실질 기준 변경 and asks for its 조기 마감 reviewed 기존 규칙으로 판정 가능 — the owner's answer
 * Q2 of 2026-11-02 for a close that has to come earlier — and the second seed admin approves it
 * (`approvePauseDecisionAsReviewer`). Trading stops, and the market waits for its 판정. The answer
 * is the CLOSED market; its `closeAt` stays the scheduled close, and the `closed` event's
 * `closedAt` is the actual one. A reader in the market's room is sent `market:status` twice — 거래
 * 일시 중단, then 거래 마감 — and keeps the newer. The API, not the UI, because closing is a means
 * here — the settlement spec measures what comes after it; pause.spec.ts walks the screens.
 * First the helper's two members trade one pair on it (`tradeOnce`): since #20
 * (ADR-0117) a market closed — early or at its close — with no fill of a person's account is
 * CANCELLED, with no judgement; cancel.spec.ts and pause.spec.ts show that path.
 *
 * A market whose close comes while these steps run (a spec that made it close in seconds) has a
 * step refused for it — `closeAt` 'closed' by the clock — and is closed by the worker on schedule
 * instead, paused or not (#173 item 1): the helper retracts the request it left waiting and waits
 * for that close (`CLOSE_ON_SCHEDULE_WAIT_MS`). Any other refusal throws with its body.
 */
export async function closeMarket(
  admin: APIRequestContext,
  marketId: string,
): Promise<AdminMarket> {
  await tradeOnce(admin, marketId);
  const paused = await sendPause(admin, marketId, 'basis_change');
  if (!paused.ok()) return closedOnSchedule(admin, marketId, paused);
  // The pause's answer is the market it paused: its lasting pause is the one to close early.
  const pauseId = lastingPauseIdOf(await unwrap<AdminMarket>(paused));
  if (pauseId === undefined) throw new Error(`market ${marketId} has no lasting pause after it`);
  const requested = await sendPauseDecisionRequest(admin, marketId, 'early_close', {
    pauseId,
    reviewResult: 'judgeable',
  });
  if (!requested.ok()) return closedOnSchedule(admin, marketId, requested);
  const requestId = (await unwrap<AdminMarket>(requested)).pause.pending?.requestId;
  if (requestId === undefined) {
    throw new Error(`market ${marketId} has no waiting 조기 마감 after its request`);
  }
  const approved = await sendPauseDecision(reviewerOf(admin), marketId, requestId, 'approve', {
    reason: HELPER_PAUSE_APPROVAL_REASON,
  });
  if (!approved.ok()) {
    await leaveNoPauseDecision(admin, marketId);
    return closedOnSchedule(admin, marketId, approved);
  }
  const closed = await unwrap<AdminMarket>(approved);
  expect(closed.status).toBe('closed');
  return closed;
}

/**
 * The helper's two members paired with `admin` (`test`'s `traders`), signed up on first use — a
 * spec whose clock starts after the market's making asks for them first, so their sign-up is not
 * spent from its budget.
 */
export async function helperTraders(admin: APIRequestContext): Promise<HelperTraders> {
  const traders = traderPairs.get(admin);
  if (traders === undefined) {
    throw new Error('the helper traders need the `admin` fixture of helpers.ts `test`');
  }
  return traders();
}

/**
 * One pair mint between the helper's two members (`traders`, paired with `admin`), so the close
 * that follows is a 거래 마감 rather than a 취소 (#20, ADR-0117 — a market with no fill of a person's
 * account is CANCELLED at its close or early close): the first member's 지정가(GTC) NO buy of one at
 * 50 rests, and the second's 즉시 거래(IOC) YES buy of one meets it at the resting price — each pays
 * 50, nothing is left resting (orders.spec.ts's pattern, #119). The intake is open with the suite's
 * test values (global-setup.ts) and each member sends one order per close, well under the 20 a
 * minute. A buy the market refuses — its close came first, so the worker cancels it — throws:
 * nothing the helper can close is left.
 */
export async function tradeOnce(admin: APIRequestContext, marketId: string): Promise<void> {
  const [maker, taker] = await helperTraders(admin);
  const order = async (
    context: APIRequestContext,
    terms: { outcome: 'YES' | 'NO'; timeInForce: 'gtc' | 'ioc'; limitPriceCoin: number },
  ) => {
    const placed = await unwrap<{ order: { status: string; rejectReason: string | null } }>(
      await context.post(`/api/v1/markets/${marketId}/orders`, {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        data: { ...terms, side: 'buy', qty: 1, expectedAccountId: await accountIdOf(context) },
      }),
    );
    return placed.order;
  };
  const resting = await order(maker, { outcome: 'NO', timeInForce: 'gtc', limitPriceCoin: 50 });
  const taken = await order(taker, { outcome: 'YES', timeInForce: 'ioc', limitPriceCoin: 99 });
  if (taken.status !== 'filled') {
    throw new Error(
      `the helper's trade on market ${marketId} did not fill (${resting.status} / ${taken.status}` +
        ` ${String(taken.rejectReason)}): with no fill of a person's account the market is ` +
        'cancelled at its close (#20), not closed',
    );
  }
}

/**
 * The market `closeMarket` could not close early, from the step's refusal: when it says the close
 * has come (`closeAt` 'closed', the server's clock), the worker's close at `close_at` — waited for
 * here; when the market reads CLOSED already (the worker came first: `status`), the market; any
 * other refusal throws with its body.
 */
async function closedOnSchedule(
  admin: APIRequestContext,
  marketId: string,
  refused: APIResponse,
): Promise<AdminMarket> {
  const body = await refused.text();
  const failure = new Error(`${refused.url()} -> ${String(refused.status())} ${body}`);
  if (refused.status() !== 400) throw failure;
  const { error } = JSON.parse(body) as { error: { details?: { path?: unknown[] }[] } };
  const field = error.details?.[0]?.path?.[0];
  const read = async () =>
    unwrap<AdminMarket>(await admin.get(`/api/v1/admin/markets/${marketId}`));
  let market = await read();
  if (market.status === 'closed') return market;
  if (field !== 'closeAt') throw failure;
  await expect
    .poll(
      async () => {
        market = await read();
        return market.status;
      },
      {
        message: `market ${marketId} is not closed on schedule after ${body}`,
        timeout: CLOSE_ON_SCHEDULE_WAIT_MS,
        intervals: [1_000],
      },
    )
    .toBe('closed');
  return market;
}

// ---- 시장 취소 (#20) -----------------------------------------------------------------------

/**
 * The reason every automatic CANCELLED stores (#20, ADR-0117; `MARKET_NO_FILL_CANCEL_REASON`,
 * restated: these specs import only types from `@buddha/shared`) — the worker's close and an
 * approved early close that find no fill of a person's account.
 */
export const NO_FILL_CANCEL_REASON =
  '거래가 끝날 때까지 체결이 한 건도 없어 결과를 정하지 않고 시장을 취소했습니다.';

// ---- 이의 기간 (#152, 출시 설정) ----------------------------------------------------------

/**
 * The release setting a judgement's approval reads its dispute window from (#152, ADR-0103;
 * `DISPUTE_WINDOW_SETTING`, restated: these specs import only types from `@buddha/shared`) — whole
 * minutes, one value for every market, fixed on each market as its 잠정 결과 is published (ADR-0093
 * decision 1 #173 item 5).
 */
export const DISPUTE_WINDOW_KEY = 'market.dispute_window';

/**
 * The dispute window the suite enters while the setting is 미정 (`ensureDisputeWindow`): the
 * shortest the setting takes, so a spec that waits for the worker's confirmation waits a minute.
 */
export const E2E_DISPUTE_WINDOW_MINUTES = 1;

/** Why the suite entered it, as the change record keeps it (1..500 characters). */
const E2E_DISPUTE_WINDOW_REASON = 'e2e: 짧은 이의 기간';

/**
 * The longest dispute window a spec waits out (`skipUnlessResolvable`): a database where someone
 * entered a longer one — the design proposal's 1,440, say — has its confirmations left to the API's
 * and the worker's integration tests rather than holding a test for hours.
 */
const QUICK_DISPUTE_WINDOW_MAX_MINUTES = 2;

/** The skip a spec that needs the worker gives when the config has no worker probe to wait on. */
const NO_WORKER_PROBE = 'WORKER_HEALTH_PORT=0: no worker probe; the suite cannot wait for a worker';

/**
 * The dispute window as `context`'s admin reads it through `GET /admin/release-settings`: its
 * minutes whatever the status (설계 제안, 시험값 and 승인됨 alike are used, ADR-0103), or null while
 * it is 미정 — when a judgement can be neither registered nor approved.
 */
export async function disputeWindowMinutes(context: APIRequestContext): Promise<number | null> {
  const items = await unwrap<ReleaseSetting[]>(await context.get('/api/v1/admin/release-settings'));
  const item = items.find((entry) => entry.key === DISPUTE_WINDOW_KEY);
  if (item === undefined) throw new Error(`no release setting ${DISPUTE_WINDOW_KEY} is registered`);
  return item.status === 'undecided' || typeof item.value !== 'number' ? null : item.value;
}

/**
 * Makes sure the dispute window has a value, for the suite's global setup (global-setup.ts):
 * while it is 미정, `context`'s admin enters E2E_DISPUTE_WINDOW_MINUTES as a 시험값 with its reason;
 * a value already there — a run before this one, or a developer's — is left as it is. Safe to run
 * twice at once: the second change of the same status and value is refused as unchanged
 * (docs/SETTINGS.md), so any refusal is read again before it fails the run. Returns the minutes in
 * force.
 */
export async function ensureDisputeWindow(context: APIRequestContext): Promise<number> {
  const before = await disputeWindowMinutes(context);
  if (before !== null) return before;
  const entered = await context.patch(`/api/v1/admin/release-settings/${DISPUTE_WINDOW_KEY}`, {
    data: {
      status: 'test',
      value: E2E_DISPUTE_WINDOW_MINUTES,
      reason: E2E_DISPUTE_WINDOW_REASON,
      expectedAccountId: await accountIdOf(context),
    },
  });
  if (entered.ok()) return E2E_DISPUTE_WINDOW_MINUTES;
  const after = await disputeWindowMinutes(context);
  if (after !== null) return after;
  throw new Error(
    `entering ${DISPUTE_WINDOW_KEY} failed (${String(entered.status())}): ${await entered.text()}`,
  );
}

/**
 * Skips the test, before it makes anything, unless it can wait for the worker to confirm a 잠정 결과
 * (#152): a worker probe to wait on (`workerProbeDisabled`), and a dispute window of at most
 * QUICK_DISPUTE_WINDOW_MAX_MINUTES — the one the global setup enters, unless the database holds
 * another.
 */
export async function skipUnlessResolvable(admin: APIRequestContext): Promise<void> {
  test.skip(workerProbeDisabled(), NO_WORKER_PROBE);
  const minutes = await disputeWindowMinutes(admin);
  test.skip(
    minutes === null || minutes > QUICK_DISPUTE_WINDOW_MAX_MINUTES,
    `${DISPUTE_WINDOW_KEY} is ${minutes === null ? '미정' : `${String(minutes)}분`}: a spec waits ` +
      `out ${String(QUICK_DISPUTE_WINDOW_MAX_MINUTES)}분 at most (global-setup.ts enters ` +
      `${String(E2E_DISPUTE_WINDOW_MINUTES)}분 while it is 미정)`,
  );
}

// ---- 시작 지급액 (#70, #116, 출시 설정) ------------------------------------------------------

/**
 * The release setting the start Coin is paid from (#70, ADR-0071; `START_COIN_SETTING`, restated:
 * these specs import only types from `@buddha/shared`).
 */
export const START_COIN_KEY = 'grant.start_coin';

/**
 * The start Coin the suite enters while the setting is 미정 (`ensureStartCoin`): the largest the
 * setting takes (`START_GRANT_MAX_COIN`), seven digits, so a header chip or a wallet is measured
 * with a long amount (coin.spec.ts).
 */
export const E2E_START_COIN = 1_000_000;

/** Why the suite entered it, as the change record keeps it (1..500 characters). */
const E2E_START_COIN_REASON = 'e2e: 시험 DB의 시작 지급액';

/**
 * The start Coin as `context`'s admin reads it through `GET /admin/release-settings`: its amount
 * whatever the status (설계 제안, 시험값 and 승인됨 are all paid, ADR-0071 decision 7), or null
 * while it is 미정 — when every grant waits.
 */
export async function startCoinValue(context: APIRequestContext): Promise<number | null> {
  const items = await unwrap<ReleaseSetting[]>(await context.get('/api/v1/admin/release-settings'));
  const item = items.find((entry) => entry.key === START_COIN_KEY);
  if (item === undefined) throw new Error(`no release setting ${START_COIN_KEY} is registered`);
  return item.status === 'undecided' || typeof item.value !== 'number' ? null : item.value;
}

/**
 * Makes sure the start Coin has a value, for the suite's global setup (global-setup.ts): no admin
 * adjusts a balance since #116 (ADR-0107 결정 2 #73 7항: "e2e는 시험 DB의 시작 지급 설정값으로 Coin을
 * 받는다"), so the start grant is how every account a spec makes gets its Coin. While it is 미정,
 * `context`'s admin enters E2E_START_COIN as a 시험값 with its reason; a value already there is
 * left as it is. Safe to run twice at once, as `ensureDisputeWindow` is. Returns the amount in
 * force; a spec reads it (`startCoinValue`) rather than assuming this one.
 */
export async function ensureStartCoin(context: APIRequestContext): Promise<number> {
  const before = await startCoinValue(context);
  if (before !== null) return before;
  const entered = await context.patch(`/api/v1/admin/release-settings/${START_COIN_KEY}`, {
    data: {
      status: 'test',
      value: E2E_START_COIN,
      reason: E2E_START_COIN_REASON,
      expectedAccountId: await accountIdOf(context),
    },
  });
  if (entered.ok()) return E2E_START_COIN;
  const after = await startCoinValue(context);
  if (after !== null) return after;
  throw new Error(
    `entering ${START_COIN_KEY} failed (${String(entered.status())}): ${await entered.text()}`,
  );
}

/**
 * How long the global setup waits for the worker to pay the first seed admin's waiting start
 * Coin (`awaitOwnStartGrant`): the every-minute `start_grant.pay` run, plus a margin.
 */
const OWN_START_GRANT_MS = 90_000;

/** How often it asks `GET /me` again meanwhile. */
const OWN_START_GRANT_POLL_MS = 2_000;

/**
 * Waits until `context`'s account has no start grant waiting, for the suite's global setup: on a
 * fresh database the first seed admin onboards (`signInFirstSeedAdmin`) before `ensureStartCoin`
 * enters the amount, so its grant waits and the worker's every-minute `start_grant.pay` pays it.
 * Without this wait that payment lands while the specs run and moves the admin's header chip under
 * a spec that holds it still (market.spec.ts AC 1). Nothing to wait for when the grant was paid at
 * once (a database where the amount was already entered) or when no worker runs
 * (`workerProbeDisabled`: then nothing pays it, and nothing moves the chip either).
 */
export async function awaitOwnStartGrant(context: APIRequestContext): Promise<void> {
  if (workerProbeDisabled()) return;
  const deadline = Date.now() + OWN_START_GRANT_MS;
  while (Date.now() < deadline) {
    const me = await unwrap<Me>(await context.get('/api/v1/me'));
    if (me.startGrant?.status !== 'pending') return;
    await new Promise((resolve) => setTimeout(resolve, OWN_START_GRANT_POLL_MS));
  }
  throw new Error(
    `the start grant of the first seed admin still waits after ${String(OWN_START_GRANT_MS)} ms: ` +
      'is the worker (start_grant.pay) running?',
  );
}

/**
 * A whole Coin amount as `formatCoin` writes it ('1,000,000 Coin'): restated, as these specs import
 * no value from `@buddha/shared`.
 */
export function coinText(amount: number | string): string {
  return `${BigInt(amount).toLocaleString('en-US')} Coin`;
}

/**
 * The start Coin as `formatCoin` writes it, for the specs that read a new account's balance. Fails
 * when the setting is 미정, which the global setup never leaves it.
 */
export async function startCoinText(context: APIRequestContext): Promise<string> {
  const amount = await startCoinValue(context);
  if (amount === null) throw new Error(`${START_COIN_KEY} is 미정: global-setup.ts enters it`);
  return coinText(amount);
}

// ---- 주문 접수 (#119, 출시 설정) -----------------------------------------------------------

/**
 * The three release settings of the order intake (#119, ADR-0112; `ORDER_ACCEPTING_SETTING`,
 * `ORDER_RATE_LIMIT_SETTING`, `PRICE_PROTECTION_TICKS_SETTING`, restated: these specs import only
 * types from `@buddha/shared`), and what the suite enters while each is 미정 — the test values of
 * ADR-0107 결정 3·결과 3: intake open, 20 orders a minute per account, a width of 5 ticks.
 */
export const ORDER_SETTINGS = {
  accepting: { key: 'order.accepting', value: true },
  rateLimit: { key: 'order.rate_limit', value: 20 },
  priceProtectionTicks: { key: 'order.price_protection_ticks', value: 5 },
} as const;

/** Why the suite entered them, as the change record keeps it (1..500 characters). */
const E2E_ORDER_SETTINGS_REASON = 'e2e: 시험 DB의 주문 접수 시험값';

/** A release setting's value as `context`'s admin reads it, or null while it is 미정. */
async function releaseSettingValue(
  context: APIRequestContext,
  key: string,
): Promise<number | boolean | null> {
  const items = await unwrap<ReleaseSetting[]>(await context.get('/api/v1/admin/release-settings'));
  const item = items.find((entry) => entry.key === key);
  if (item === undefined) throw new Error(`no release setting ${key} is registered`);
  if (item.status === 'undecided') return null;
  return typeof item.value === 'number' || typeof item.value === 'boolean' ? item.value : null;
}

/**
 * Makes sure the order intake's settings have values, for the suite's global setup
 * (global-setup.ts) — the width before any spec submits a market for review, whose submission
 * needs one (OPEN_ITEMS_MISSING `priceProtection`) and copies it: while one is 미정, `context`'s
 * admin enters ORDER_SETTINGS' value as a 시험값 with its reason; a value already there — a run
 * before this one, or a developer's — is left as it is. Safe to run twice at once, as
 * `ensureDisputeWindow` is.
 */
export async function ensureOrderSettings(context: APIRequestContext): Promise<void> {
  for (const { key, value } of Object.values(ORDER_SETTINGS)) {
    if ((await releaseSettingValue(context, key)) !== null) continue;
    const entered = await context.patch(`/api/v1/admin/release-settings/${key}`, {
      data: {
        status: 'test',
        value,
        reason: E2E_ORDER_SETTINGS_REASON,
        expectedAccountId: await accountIdOf(context),
      },
    });
    if (entered.ok() || (await releaseSettingValue(context, key)) !== null) continue;
    throw new Error(
      `entering ${key} failed (${String(entered.status())}): ${await entered.text()}`,
    );
  }
}

// ---- 판정 (#152) ---------------------------------------------------------------------------

/**
 * What every helper registration says was confirmed (1..500 characters) — the request's reason,
 * the admins' alone until #24's public record.
 */
export const HELPER_JUDGEMENT_DESCRIPTION =
  '자동화 테스트의 판정입니다. 1차 출처의 발표를 확인했습니다.';

/** The 무효 사유 a helper registration of 무효 gives unless told otherwise (1..500 characters). */
export const HELPER_JUDGEMENT_VOID_REASON =
  '자동화 테스트의 무효 판정입니다. 규칙의 무효 처리를 따릅니다.';

/** The reason every helper approval of a judgement gives (1..500 characters). */
const HELPER_JUDGEMENT_APPROVAL_REASON = '등록한 출처와 증거, NO 조건의 사건 기한을 확인했습니다.';

/**
 * How long past a 잠정 결과's dispute deadline a spec waits for the worker to confirm it: the
 * delayed `market.resolve` job at the deadline, or the per-minute `market-resolve-scan` behind it
 * should the job be lost — a whole minute — with room for a loaded box.
 */
const RESOLVE_AFTER_DEADLINE_MS = 90_000;

export interface JudgementOptions {
  /** The result: YES unless given. */
  result?: MarketResult;
  /**
   * The source by its priority (0 the 1차 출처, 1.. the 대체 출처): the 1차 출처 unless given, and
   * none (`null`) for 무효 — which alone may name none (ADR-0093 decision 3 '판정 출처').
   */
  source?: { priority: number } | null;
  /** Why the 1차 출처 could not be used, which a 대체 출처 needs: null unless given. */
  fallbackReason?: string | null;
  /** The 무효 사유, which 무효 needs: HELPER_JUDGEMENT_VOID_REASON for 무효 unless given, else null. */
  voidReason?: string | null;
  /** The evidence links (1..5): `judgementEvidenceLink(marketId)` alone unless given. */
  links?: string[];
  /** When the evidence was collected (ISO): five minutes ago unless given. */
  collectedAt?: string;
  /** What was confirmed: HELPER_JUDGEMENT_DESCRIPTION unless given. */
  description?: string;
  /**
   * A 판정 정정's own part (#176, ADR-0105): the version it replaces and its 정정 사유 — the
   * other fields are then the new version's in full. Null, a first judgement, unless given
   * (`registerCorrection` gives it).
   */
  correction?: { baseVersion: number; reason: string } | null;
}

/** An evidence link of a spec's judgement: https, under the market's own path, `n` apart. */
export function judgementEvidenceLink(marketId: string, n = 1): string {
  return `https://example.com/e2e/evidence/${marketId}/${String(n)}`;
}

/**
 * 판정 등록 (#152, ADR-0103; ADR-0093 decision 3 the #152 rows) through
 * `POST /admin/markets/:id/judgements` as the admin `context` is signed in as (ADR-0092): the
 * answer as it came, for a spec that reads a refusal. The body is `options` over a YES on the 1차
 * 출처 with one evidence link — no market price, volume or majority goes in it (#152 AC 8) — and,
 * for a 판정 정정 (#176), its `correction`; `correction: null` for a first judgement, which the API
 * also takes left out.
 */
export async function sendJudgementRegistration(
  context: APIRequestContext,
  marketId: string,
  options: JudgementOptions = {},
): Promise<APIResponse> {
  const result = options.result ?? 'YES';
  const isVoid = result === 'VOID';
  return context.post(`/api/v1/admin/markets/${marketId}/judgements`, {
    data: {
      result,
      source: options.source !== undefined ? options.source : isVoid ? null : { priority: 0 },
      fallbackReason: options.fallbackReason ?? null,
      voidReason:
        options.voidReason !== undefined
          ? options.voidReason
          : isVoid
            ? HELPER_JUDGEMENT_VOID_REASON
            : null,
      evidence: {
        links: options.links ?? [judgementEvidenceLink(marketId)],
        collectedAt: options.collectedAt ?? new Date(Date.now() - 5 * MINUTE_MS).toISOString(),
      },
      description: options.description ?? HELPER_JUDGEMENT_DESCRIPTION,
      correction: options.correction ?? null,
      noConflictConfirmed: true,
      expectedAccountId: await accountIdOf(context),
    },
  });
}

/**
 * `sendJudgementRegistration` as `admin`, which must be taken: the market as the registration
 * left it — still CLOSED, nothing published (#173 item 1) — with the registration in
 * `judgement.pending`, what `approveJudgementAsReviewer` decides. The market must be CLOSED, the
 * dispute window decided and no other registration waiting. A 판정 정정 is `registerCorrection`'s.
 */
export async function registerJudgement(
  admin: APIRequestContext,
  marketId: string,
  options: JudgementOptions = {},
): Promise<AdminMarket> {
  const registered = await unwrap<AdminMarket>(
    await sendJudgementRegistration(admin, marketId, options),
  );
  if (registered.judgement.pending === null) {
    throw new Error(`market ${marketId} has no waiting judgement after its registration`);
  }
  return registered;
}

/**
 * `POST /admin/markets/:id/judgements/:requestId/<decision>` as the admin `context` is signed in
 * as (ADR-0092), the answer as it came: 승인 takes `{reason, eventDeadlineConfirmed}`, 반려
 * `{reason}`, 철회 nothing.
 */
export async function sendJudgementDecision(
  context: APIRequestContext,
  marketId: string,
  requestId: string,
  decision: 'approve' | 'reject' | 'retract',
  body: Record<string, unknown> = {},
): Promise<APIResponse> {
  return context.post(`/api/v1/admin/markets/${marketId}/judgements/${requestId}/${decision}`, {
    data: {
      ...(decision === 'approve' ? { noConflictConfirmed: true } : {}),
      ...body,
      expectedAccountId: await accountIdOf(context),
    },
  });
}

/** The id of the registration waiting on a market as `context` reads it; throws when none waits. */
async function pendingJudgementOf(context: APIRequestContext, marketId: string): Promise<string> {
  const market = await unwrap<AdminMarket>(await context.get(`/api/v1/admin/markets/${marketId}`));
  const pending = market.judgement.pending?.requestId;
  if (pending === undefined) throw new Error(`no judgement waits on market ${marketId}`);
  return pending;
}

/**
 * 승인 (#152; #173 item 1) of the registration waiting on a market, as the second seed admin
 * `admin` was handed with (`test`'s `reviewer`) — any admin but its registrant decides it — with a
 * reason and the confirmation of the NO condition's event deadline, which an approval before the
 * scheduled judgement needs (decision 3 '등록 시점') and every spec market's comes before (its
 * scheduled judgement is days out, `timesFor`), naming the waiting registration (`requestId`, read
 * when not given). The answer is the market PROVISIONAL with its result and its dispute deadline:
 * for a first judgement judgement v1 and the deadline the window fixed; for a 판정 정정 (#176,
 * `registerCorrection`) the next version, the correction's result and a new deadline of the
 * replaced version's length from the approval (#173 item 5). The approval publishes
 * `market:status` — a correction's under a newer event (ADR-0105).
 */
export async function approveJudgementAsReviewer(
  admin: APIRequestContext,
  marketId: string,
  requestId?: string,
): Promise<AdminMarket> {
  const reviewer = reviewerOf(admin);
  const pending = requestId ?? (await pendingJudgementOf(reviewer, marketId));
  return unwrap<AdminMarket>(
    await sendJudgementDecision(reviewer, marketId, pending, 'approve', {
      reason: HELPER_JUDGEMENT_APPROVAL_REASON,
      eventDeadlineConfirmed: true,
    }),
  );
}

/**
 * 철회 (#152) of the registration waiting on a market by its registrant `admin`, in any status. The
 * answer is the market with no registration waiting and its status as it was — for a 판정 정정
 * (#176) its version and deadline too, the confirmation following them again (past the deadline
 * the API queues it at once, ADR-0105).
 */
export async function retractJudgement(
  admin: APIRequestContext,
  marketId: string,
  requestId?: string,
): Promise<AdminMarket> {
  const pending = requestId ?? (await pendingJudgementOf(admin, marketId));
  return unwrap<AdminMarket>(await sendJudgementDecision(admin, marketId, pending, 'retract'));
}

/**
 * Retracts the registration `context`'s admin left waiting on a market, so a run that failed
 * halfway leaves the 판정 승인 대기 list of a persistent database no longer (a waiting registration
 * never expires — and a waiting 판정 정정 holds the market's confirmation, #176). Best effort, for
 * a `finally`: nothing when none waits, or when another admin registered it.
 */
export async function leaveNoJudgement(
  context: APIRequestContext,
  marketId: string,
): Promise<void> {
  await retractJudgement(context, marketId).catch(() => undefined);
}

/**
 * 판정 of a CLOSED market, the one way there is since #152 (ADR-0103; ADR-0093 decision 1 #173
 * items 1·9 — the interim one-admin `POST /admin/markets/:id/resolve` is gone): `admin` registers
 * `result` on the 1차 출처 (무효 on none, with its reason) and the second seed admin approves it
 * (`approveJudgementAsReviewer`). The answer is the market PROVISIONAL — its 잠정 결과 public at once
 * — and the worker confirms it once its dispute deadline passes (`waitForResolved`): no spec
 * holds it with a 판정 이의 (#175, ADR-0104 — none can submit one without a fill on it), and a 판정
 * 정정 (#176, `registerCorrection`) holds it only until the spec approves or rejects it. The API,
 * not the UI: judgement.spec.ts walks the screens. A confirmed 무효 pays 50 Coin per contract
 * on both outcomes (#126, ADR-0118), which settlement.spec.ts checks. Retracts what it left
 * waiting on a failure.
 */
export async function judgeMarket(
  admin: APIRequestContext,
  marketId: string,
  result: MarketResult = 'YES',
): Promise<AdminMarket> {
  try {
    const registered = await registerJudgement(admin, marketId, { result });
    const judged = await approveJudgementAsReviewer(
      admin,
      marketId,
      registered.judgement.pending?.requestId,
    );
    expect(judged.status).toBe('provisional');
    return judged;
  } catch (error) {
    await leaveNoJudgement(admin, marketId);
    throw error;
  }
}

// ---- 판정 정정 (#176) ------------------------------------------------------------------------

/** The 정정 사유 every helper correction gives unless told otherwise (1..500 characters). */
export const HELPER_CORRECTION_REASON =
  '자동화 테스트의 판정 정정입니다. 1차 출처가 발표를 정정했습니다.';

/** What every helper correction says was confirmed unless told otherwise (1..500 characters). */
export const HELPER_CORRECTION_DESCRIPTION =
  '자동화 테스트의 정정한 판정입니다. 1차 출처의 정정 발표를 확인했습니다.';

export interface CorrectionOptions extends Omit<JudgementOptions, 'correction'> {
  /** The version it replaces: the market's current one unless given (another is 'stale'). */
  baseVersion?: number;
  /** The 정정 사유: HELPER_CORRECTION_REASON unless given. */
  reason?: string;
}

/**
 * 판정 정정 (#176, ADR-0105; ADR-0093 decision 1 #173 items 2·5·7·8) of a PROVISIONAL market as
 * `admin`, which must be taken, through the registration route with its `correction`: `options`
 * over the current judgement's 1차 출처 with the other of YES and NO for its result, the evidence
 * link of the next version (`judgementEvidenceLink(marketId, version + 1)`) and
 * HELPER_CORRECTION_DESCRIPTION, so the result and its grounds change (one that changes nothing is
 * refused 'unchanged', #173 item 7). A 무효 base takes an explicit replacement `result`.
 * The answer is the market as the registration left it — still
 * PROVISIONAL with its version, result and deadline, the correction in `judgement.pending`, what
 * `approveJudgementAsReviewer` approves — and the confirmation is held while it waits, past the
 * deadline too (decision 3 '#176 정정 대기'). So it is registered within the version's dispute
 * window: at the deadline the worker confirms a market nothing holds, and a confirmed one takes no
 * correction (#173 item 8). Any admin may register it, the version's registrant and approver too.
 */
export async function registerCorrection(
  admin: APIRequestContext,
  marketId: string,
  options: CorrectionOptions = {},
): Promise<AdminMarket> {
  const { baseVersion, reason, ...judgement } = options;
  const market = await unwrap<AdminMarket>(await admin.get(`/api/v1/admin/markets/${marketId}`));
  const base = market.judgement.current;
  if (base === null) throw new Error(`market ${marketId} has no judgement to correct`);
  if (judgement.result === undefined && base.result === 'VOID') {
    throw new Error(`market ${marketId} was judged 무효: give the correction its result`);
  }
  const registered = await unwrap<AdminMarket>(
    await sendJudgementRegistration(admin, marketId, {
      ...judgement,
      result: judgement.result ?? (base.result === 'YES' ? 'NO' : 'YES'),
      links: judgement.links ?? [judgementEvidenceLink(marketId, base.version + 1)],
      description: judgement.description ?? HELPER_CORRECTION_DESCRIPTION,
      correction: {
        baseVersion: baseVersion ?? base.version,
        reason: reason ?? HELPER_CORRECTION_REASON,
      },
    }),
  );
  if ((registered.judgement.pending?.correction ?? null) === null) {
    throw new Error(`market ${marketId} has no waiting correction after its registration`);
  }
  return registered;
}

/**
 * Retracts the 판정 정정 `context`'s admin left waiting on a market (`leaveNoJudgement` for a
 * correction alone), so a run that failed halfway leaves no market of a persistent database held:
 * a waiting correction holds the confirmation and never expires (decision 3 '#176 정정 대기'), and
 * its 철회 lets the worker confirm the version as it stands. Best effort, for a `finally`: nothing
 * when none waits, when a first judgement waits, or when another admin registered it.
 */
export async function leaveNoCorrection(
  context: APIRequestContext,
  marketId: string,
): Promise<void> {
  const retract = async () => {
    const market = await unwrap<AdminMarket>(
      await context.get(`/api/v1/admin/markets/${marketId}`),
    );
    const pending = market.judgement.pending;
    if (pending === null || pending.correction === null) return;
    await retractJudgement(context, marketId, pending.requestId);
  };
  await retract().catch(() => undefined);
}

/**
 * How long a spec waits, from now, for the worker to confirm `market`'s 잠정 결과: until its
 * dispute deadline (`AdminMarket.disputeDeadline`, fixed at the approval of its current version —
 * a 판정 정정's approval gives a new one, #176) and RESOLVE_AFTER_DEADLINE_MS past it. Throws for a
 * market with no deadline: none is PROVISIONAL.
 */
export function resolveWaitMs(
  market: Pick<AdminMarket, 'id' | 'disputeDeadline'>,
  now: number = Date.now(),
): number {
  if (market.disputeDeadline === null) {
    throw new Error(`market ${market.id} has no dispute deadline: it is no 잠정 결과`);
  }
  return Math.max(0, Date.parse(market.disputeDeadline) - now) + RESOLVE_AFTER_DEADLINE_MS;
}

/**
 * Waits, polling the admin detail through the API, until the worker has confirmed the 잠정 결과
 * of a market (`judgeMarket`) — PROVISIONAL → RESOLVED at its dispute deadline (#173 item 1), no
 * 판정 이의 holding it (#175, none here can), and from there on to 지급 중 and 지급 완료 at once —
 * and answers the market as it then reads. The deadline is read once, at the start
 * (`resolveWaitMs`): with a 판정 정정 (#176) a spec calls this once the correction is approved — the
 * new deadline — or rejected, never while it waits and holds the market. Skips
 * the test when that cannot be waited for (`skipUnlessResolvable`): a spec calls that before it
 * makes anything, so this is a backstop.
 */
export async function waitForResolved(
  admin: APIRequestContext,
  marketId: string,
): Promise<AdminMarket> {
  await skipUnlessResolvable(admin);
  const read = async () =>
    unwrap<AdminMarket>(await admin.get(`/api/v1/admin/markets/${marketId}`));
  let market = await read();
  if (market.status === 'provisional') {
    await expect
      .poll(
        async () => {
          market = await read();
          return market.status;
        },
        {
          message: `market ${marketId} is not confirmed after ${String(market.disputeDeadline)}`,
          timeout: resolveWaitMs(market),
          intervals: [1_000],
        },
      )
      .not.toBe('provisional');
  }
  expect(['resolved', 'settling', 'settled']).toContain(market.status);
  return market;
}

/**
 * `waitForResolved`, then the worker's payout (ADR-0046, ADR-0118): the market as it reads
 * 지급 완료 for YES, NO or VOID.
 */
export async function waitForSettled(
  admin: APIRequestContext,
  marketId: string,
): Promise<AdminMarket> {
  let market = await waitForResolved(admin, marketId);
  if (market.status !== 'settled') {
    await expect
      .poll(
        async () => {
          market = await unwrap<AdminMarket>(await admin.get(`/api/v1/admin/markets/${marketId}`));
          return market.status;
        },
        {
          message: `market ${marketId} is not settled`,
          timeout: SETTLEMENT_WAIT_MS,
          intervals: [1_000],
        },
      )
      .toBe('settled');
  }
  return market;
}

/**
 * The category a spec's market is filed under for `topLevelCategory` (`CreateOpenMarketOptions`):
 * that top-level category's first sub-category in display order, or the category itself when it
 * has none — a category with an active sub-category takes no new market (#17, ADR-0093 decision 2
 * #172 item 1). The public list holds active categories under active parents only, so either is
 * one the API accepts. `top` is what `TestMarket.categorySlug` names.
 */
export async function marketCategoryOf(
  admin: APIRequestContext,
  topLevelCategory = 0,
): Promise<{ top: Category; leaf: Category }> {
  const categories = await unwrap<Category[]>(await admin.get('/api/v1/categories'));
  const top = categories.filter((row) => row.parentId === null)[topLevelCategory];
  if (top === undefined) {
    throw new Error('no active category: run `pnpm db:seed` (the specs file under its tree)');
  }
  return { top, leaf: categories.find((row) => row.parentId === top.id) ?? top };
}

/**
 * A draft through `POST /admin/markets`, left a draft: on no public page, for a spec that checks
 * what a draft does not do (a theme of drafts alone is not published, ADR-0088). The options and
 * the title are `createOpenMarket`'s, which opens one of these: it has every rule item
 * (`ruleItemsFor`, #23), its times and 판정 기준 시간대 (`timesFor`, #22), a category a market may be
 * filed under and its tags, so the open-items check passes (#17) — unless `ruleItems`, `times` or
 * `tags` blanked some. Its address is ASCII (`e2e-<tag>`): `/markets/[slug]` does not reach a slug
 * with Hangul in it yet.
 */
export async function createDraftMarket(
  admin: APIRequestContext,
  {
    topLevelCategory = 0,
    group,
    description,
    tags,
    ruleItems,
    closeAt = new Date(Date.now() + CLOSE_IN_MS).toISOString(),
    times,
  }: CreateOpenMarketOptions = {},
): Promise<TestMarket> {
  const { top, leaf } = await marketCategoryOf(admin, topLevelCategory);

  const tag = freshTag();
  const marketTags = tags ?? [tag];
  const title = group === undefined ? `E2E 시장 ${tag}` : `E2E 시장 ${group} ${tag}`;
  const items: MarketRuleItems = {
    ...ruleItemsFor(tag),
    ...(description === undefined ? {} : { description }),
    ...ruleItems,
  };
  // Derived from the final close and 사건 기한, so an override of either keeps the order.
  const marketTimes: MarketTimes = { ...timesFor(closeAt, items.eventDeadline), ...times };

  const draft = await unwrap<AdminMarket>(
    await admin.post('/api/v1/admin/markets', {
      data: {
        title,
        ...items,
        categoryId: leaf.id,
        tags: marketTags,
        imageUrl: null,
        closeAt,
        ...marketTimes,
        slug: `e2e-${tag}`,
        expectedAccountId: await accountIdOf(admin),
      },
    }),
  );
  return {
    id: draft.id,
    slug: draft.slug,
    title,
    yesCondition: items.yesCondition,
    ruleItems: items,
    closeAt,
    times: marketTimes,
    tag,
    tags: marketTags,
    categorySlug: top.slug,
  };
}

/**
 * A watch straight at the API with the page's own cookie (#89, ADR-0064), for a spec that needs
 * several: the detail's press is pinned by watchlist.spec.ts, and more of them would only add
 * time. Sends the account the cookie is, as the button does (`expectedAccountId`).
 */
export async function watchThroughApi(page: Page, marketId: string): Promise<void> {
  const me = await page.request.get('/api/v1/me');
  expect(me.ok(), await me.text()).toBe(true);
  const { data } = (await me.json()) as { data: { id: string } };
  const saved = await page.request.put(`/api/v1/me/watchlist/${marketId}`, {
    data: { watched: true, expectedAccountId: data.id },
  });
  expect(saved.status(), await saved.text()).toBe(200);
}

/**
 * Chakra's `md`, 48rem: from this width up the market detail is laid out for md and up, below it
 * for the phone (lib/market-detail.ts `MD_UP_MEDIA_QUERY`).
 */
const MD_MIN_WIDTH_PX = 768;

/**
 * Which of the market detail's two layouts this page's viewport draws: `md` from md up, `base`
 * below it — Chakra's names, and lib/market-detail.ts `DetailWidth`. Read at the call, so a spec
 * that resizes asks again.
 */
export function detailWidth(page: Page): 'base' | 'md' {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('no viewport size');
  return viewport.width < MD_MIN_WIDTH_PX ? 'base' : 'md';
}

/**
 * The test id of the copy of a market detail section that this page's width draws (#122,
 * ADR-0067). 배경 (`market-background`), 규칙 (`market-rules`) and 공개 판정 기록
 * (`market-judging-record`) stand in different places at the two widths, so the detail holds each
 * twice — once where md and up draws it, once where a phone does — and hides the other width's
 * copy; each copy's ids carry its width after the section's (lib/market-detail.ts `copyTestId`):
 * `market-rules-md`, `market-rules-base-close-at`. A sub-id goes after this one:
 * `${detailCopyTestId(page, 'market-rules')}-close-at`, and a time's two lines after that: the
 * viewer's `-close-at-viewer-zone` and, when the 판정 기준 시간대 differs, `-close-at-judgement-zone`
 * (#22, `DateTimeText`).
 */
export function detailCopyTestId(page: Page, testId: string): string {
  return `${testId}-${detailWidth(page)}`;
}

/**
 * How long a spec waits for a confirmed market to read 지급 완료 (ADR-0046), counted from its
 * confirmation: the worker that confirms the 잠정 결과 at its dispute deadline queues
 * `market.finalize` with no delay (#152, ADR-0103) and settles in well under a second, so this is
 * room for a cold worker and a loaded CI box — not for the per-minute safety-net scan, which only
 * matters when the job could not be queued at all. The dispute window itself is waited out first
 * (`resolveWaitMs`).
 */
export const SETTLEMENT_WAIT_MS = 30_000;

/**
 * True when the worker's health listener is switched off (`WORKER_HEALTH_PORT=0`, worker env.ts),
 * which is when playwright.config.ts lists no worker to wait for. A spec that needs a worker's job
 * — `market.open`, `market.close`, `market.resolve` or `market.finalize` — then has nothing to tell
 * it a worker is up, so it skips rather than wait for a job nobody may be running. Read from
 * `process.env` here, not in the config: the config loaded the root `.env` into the runner, and
 * Playwright passes that environment to its workers.
 */
export function workerProbeDisabled(): boolean {
  return process.env.WORKER_HEALTH_PORT === '0';
}

/**
 * Sets a marker on the document so a later assertion can prove no reload happened in between
 * ("리프레시 없이"): a navigation wipes `window`, and with it the marker.
 */
const NO_RELOAD_MARKER = 'buddhaE2eNoReload';

export async function markDocument(page: Page): Promise<void> {
  await page.evaluate((key) => {
    (window as unknown as Record<string, boolean>)[key] = true;
  }, NO_RELOAD_MARKER);
}

export function documentSurvived(page: Page): Promise<boolean> {
  return page.evaluate(
    (key) => (window as unknown as Record<string, boolean | undefined>)[key] === true,
    NO_RELOAD_MARKER,
  );
}

// ---- 판정 지연 기록 (#142) ----------------------------------------------------------------

/**
 * The 지연 사유 every helper record gives unless told otherwise (1..500 characters): the one public
 * sentence (ADR-0093 decision 3 '#142 지연 사유') — no admin's name, no expected result and no
 * correction not yet approved (docs/OPERATIONS.md '판정 지연 기록').
 */
export const HELPER_JUDGEMENT_DELAY_REASON =
  '1차 출처의 발표가 늦어지고 있습니다. 발표를 확인하는 대로 판정을 등록합니다.';

/** How far ahead a helper record's 다음 검토 시각 is unless given: a day, well inside the bound. */
const HELPER_JUDGEMENT_DELAY_REVIEW_IN_MS = 24 * 60 * MINUTE_MS;

export interface JudgementDelayOptions {
  /** The 지연 사유: HELPER_JUDGEMENT_DELAY_REASON unless given. */
  reason?: string;
  /**
   * The 다음 검토 시각, an ISO instant in UTC (seconds and milliseconds taken):
   * HELPER_JUDGEMENT_DELAY_REVIEW_IN_MS from now unless given. The API takes one after now and at
   * most 7 × 24 hours ahead on its database clock (owner answer 2026-11-03 (1)); a spec that pins
   * a refusal sends what it pins.
   */
  nextReviewAt?: string;
}

/**
 * 판정 지연 기록 (#142, ADR-0106; ADR-0093 decision 1 #173 items 2·11, decision 3 '#142 지연
 * 사유') through `POST /admin/markets/:id/judgement-delays` as the admin `context` is signed in as
 * (ADR-0092), one admin and at once — no approval request: the reason and the next review time,
 * the answer as it came, for a spec that reads a refusal. The UI's `datetime-local` is
 * minute-precise, so a spec that needs a next review time seconds ahead records through this.
 */
export async function sendJudgementDelay(
  context: APIRequestContext,
  marketId: string,
  {
    reason = HELPER_JUDGEMENT_DELAY_REASON,
    nextReviewAt = new Date(Date.now() + HELPER_JUDGEMENT_DELAY_REVIEW_IN_MS).toISOString(),
  }: JudgementDelayOptions = {},
): Promise<APIResponse> {
  return context.post(`/api/v1/admin/markets/${marketId}/judgement-delays`, {
    data: { reason, nextReviewAt, expectedAccountId: await accountIdOf(context) },
  });
}

/**
 * `sendJudgementDelay` as `admin`, which must be taken: the admin market as the record left it —
 * its status, result and judgement as they were (a record changes nothing of the market, #173
 * item 11), the new record the first of `judgementDelays` and the current one, the earlier ones
 * its history (owner answer 2026-11-03 (4): no edit, no withdrawal). The market must read '판정
 * 지연' on the API's clock: CLOSED past its scheduled judgement, or a PROVISIONAL one a 판정 이의 or
 * a waiting 판정 정정 holds past its 이의 기한 (#173 items 7·11) — any admin records, the
 * registrant of a waiting judgement included. The record republishes `market:status` with its
 * key unchanged, so an open public detail reads it again without a reload (A-M4-36).
 */
export async function recordJudgementDelay(
  admin: APIRequestContext,
  marketId: string,
  options: JudgementDelayOptions = {},
): Promise<AdminMarket> {
  const recorded = await unwrap<AdminMarket>(await sendJudgementDelay(admin, marketId, options));
  if (recorded.judgementDelays[0]?.current !== true) {
    throw new Error(`market ${marketId} has no current delay record after its record`);
  }
  return recorded;
}

/**
 * Waits on `page` until `ms` past `iso`, an instant on the API's clock — the same box's, so the
 * runner's clock stands for it — with the screens open: an instant nothing is published at, as a
 * held market's 이의 기한 (correction.spec.ts) or a 판정 지연 기록's 다음 검토 시각 (delay.spec.ts —
 * the time passing creates nothing, #173 item 11).
 */
export async function waitPast(page: Page, iso: string, ms: number): Promise<void> {
  const wait = Date.parse(iso) + ms - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
}

// ---- realtime -----------------------------------------------------------------------

/**
 * Resolves once this tab has asked the gateway for `marketId`'s room, so a spec that causes an
 * event straight afterwards cannot lose it in the connect gap (A-M4: the t0→t1 window between
 * the SSR snapshot and the first `subscribe` is accepted, and it is exactly what would make an
 * AC 1 assertion flaky).
 *
 * Call it BEFORE `goto`: `page.waitForEvent` only sees sockets opened after it is armed. The
 * predicate is the Engine.IO query string, because `next dev` opens an HMR socket of its own
 * and it is usually the first one on the page.
 *
 * Everything is best effort. The client prefers `websocket` but keeps `polling` as a fallback
 * (ADR-0030), and a polling transport raises no WebSocket event at all — so a timeout here
 * degrades to a fixed settle rather than failing a test on a detail of the transport.
 */
export function subscribed(page: Page, marketId: string): Promise<void> {
  return page
    .waitForEvent('websocket', {
      predicate: (socket) => socket.url().includes('EIO='),
      timeout: REALTIME_READY_MS,
    })
    .then((socket) =>
      socket.waitForEvent('framesent', {
        predicate: (frame) => {
          const payload = String(frame.payload);
          return payload.includes('subscribe') && payload.includes(marketId);
        },
        timeout: REALTIME_READY_MS,
      }),
    )
    .then(() => undefined)
    .catch(() => page.waitForTimeout(REALTIME_BUDGET_MS));
}
