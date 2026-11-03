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
import type { AdminMarket, Category, Me } from '@buddha/shared';
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
 * the middle of a flow.
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
 * `admin` is an API context signed in as the first seed admin and `secondAdmin` as the second
 * (#171), each isolated from every browser context in the test: the specs' own `request`
 * fixture stays cookie-less, which is what lets AC 2 read the detail page's HTML as an
 * anonymous visitor would.
 */
export const test = base.extend<{ admin: APIRequestContext; secondAdmin: APIRequestContext }>({
  // The second argument is Playwright's `use`, renamed: this package lints with
  // eslint-plugin-react-hooks, which reads a call to `use(…)` outside a component as React's
  // own `use` hook and fails `rules-of-hooks`. Playwright passes it positionally.
  admin: async ({ playwright, baseURL }, provide) => {
    const context = await playwright.request.newContext({ baseURL });
    await signInSeedAdmin(context, FIRST_ADMIN);
    await provide(context);
    await context.dispose();
  },
  secondAdmin: async ({ playwright, baseURL }, provide) => {
    const context = await playwright.request.newContext({ baseURL });
    await signInSeedAdmin(context, SECOND_ADMIN);
    await provide(context);
    await context.dispose();
  },
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
  rules: string;
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
   * The market's 배경 (`description`), which the detail draws as its own section only when there
   * is one (#122). None, the default: the detail has no 배경 section.
   */
  description?: string;
  /**
   * Its tags, 1..5 (#17: opening takes at least one), in the order the detail shows them. The
   * default is the market's own `tag`, which no other market has, so a search for it still finds
   * this market alone. `[]` makes a draft without tags, which `createOpenMarket` cannot open.
   */
  tags?: string[];
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
 * Creates a draft through `POST /admin/markets` and opens it, so the spec owns a market that is
 * `open` and closes a day from now whatever the calendar says. It has no fill — there is no way
 * to trade until the CLOB lands (#119) — so its price reads 체결 없음 and its chart is empty
 * (N02 §5): opening writes no price tick.
 */
export async function createOpenMarket(
  admin: APIRequestContext,
  options: CreateOpenMarketOptions = {},
): Promise<TestMarket> {
  const draft = await createDraftMarket(admin, options);
  const open = await unwrap<AdminMarket>(
    await admin.post(`/api/v1/admin/markets/${draft.id}/open`, {
      data: { expectedAccountId: await accountIdOf(admin) },
    }),
  );
  return { ...draft, id: open.id, slug: open.slug };
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
 * the title are `createOpenMarket`'s, which opens one of these: it has rules, a category a market
 * may be filed under and its tags, so the open-items check passes (#17).
 */
export async function createDraftMarket(
  admin: APIRequestContext,
  { topLevelCategory = 0, group, description, tags }: CreateOpenMarketOptions = {},
): Promise<TestMarket> {
  const { top, leaf } = await marketCategoryOf(admin, topLevelCategory);

  const tag = freshTag();
  const marketTags = tags ?? [tag];
  const title = group === undefined ? `E2E 시장 ${tag}` : `E2E 시장 ${group} ${tag}`;
  // Deliberately does NOT contain 규칙: AC 2 looks for the section heading and for this
  // text separately, and a rules body carrying the heading would satisfy both on its own.
  const rules = `이 시장은 자동화 테스트가 만들었습니다. 확인 코드 ${tag}.`;

  const draft = await unwrap<AdminMarket>(
    await admin.post('/api/v1/admin/markets', {
      data: {
        title,
        description: description ?? null,
        rules,
        resolutionSource: `테스트 출처 ${tag}`,
        categoryId: leaf.id,
        tags: marketTags,
        imageUrl: null,
        closeAt: new Date(Date.now() + CLOSE_IN_MS).toISOString(),
        slug: `e2e-${tag}`,
        expectedAccountId: await accountIdOf(admin),
      },
    }),
  );
  return {
    id: draft.id,
    slug: draft.slug,
    title,
    rules,
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
 * `${detailCopyTestId(page, 'market-rules')}-close-at`.
 */
export function detailCopyTestId(page: Page, testId: string): string {
  return `${testId}-${detailWidth(page)}`;
}

/**
 * 마감 through the admin API (`POST /admin/markets/:id/close`): trading stops, and the market
 * waits for the admin's 판정. The API, not the UI, because closing is a means here — the
 * settlement spec measures what comes after it.
 */
export async function closeMarket(
  admin: APIRequestContext,
  marketId: string,
): Promise<AdminMarket> {
  return unwrap<AdminMarket>(
    await admin.post(`/api/v1/admin/markets/${marketId}/close`, {
      data: { expectedAccountId: await accountIdOf(admin) },
    }),
  );
}

/**
 * How long a spec waits for a judged market to read 지급 완료 (ADR-0046). There is no window to
 * wait out any more: the 판정 queues `market.finalize` with no delay and the worker settles in
 * well under a second, so this is room for a cold worker and a loaded CI box — not for the
 * per-minute safety-net scan, which only matters when the job could not be queued at all.
 */
export const SETTLEMENT_WAIT_MS = 30_000;

/**
 * True when the worker's health listener is switched off (`WORKER_HEALTH_PORT=0`, worker env.ts),
 * which is when playwright.config.ts lists no worker to wait for. A spec that needs the
 * `market.finalize` job then has nothing to tell it a worker is up, so it skips rather than wait
 * for a job nobody may be running. Read from `process.env` here, not in the config: the config
 * loaded the root `.env` into the runner, and Playwright passes that environment to its workers.
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
