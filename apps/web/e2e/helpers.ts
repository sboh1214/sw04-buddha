import {
  expect,
  test as base,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import type { AdminMarket, Category } from '@buddha/shared';
import { copy } from '../src/copy';

/**
 * Fixtures every M4 spec shares (PLAN 14): the Mailpit sign-up flow auth.spec.ts introduced,
 * plus an admin API context that CREATES the market a spec runs against.
 *
 * The market is created per run, never taken from `pnpm db:seed`. The seed's markets are drafts
 * waiting for review (#125) with absolute KST close times, so a spec pinned to them would pass
 * today and rot on a date nobody will connect to the failure. The two things a spec still needs from
 * the seed are the ones no public or admin route can make: the bootstrap admins (PLAN 10.5 — two
 * since #171, as the two-person rule needs distinct admins in every environment) and the
 * category rows. Both are named in the error a helper throws, so a missing seed reads as
 * "run pnpm db:seed" rather than as a 401 or a 404 in the middle of a flow.
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

/**
 * The real name and mobile number every sign-up here gives on /set-password (ADR-0043). The
 * phone is typed the way people type it; the API stores the digits.
 */
export const E2E_CONTACT = { realName: '테스트회원', phone: '010-1234-5678' } as const;

/** `.env.example`'s defaults, so a developer who never exported them still runs the suite. */
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@buddha.local';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'admin1234!';
const SECOND_ADMIN_EMAIL = process.env.SEED_SECOND_ADMIN_EMAIL ?? 'admin2@buddha.local';
const SECOND_ADMIN_PASSWORD = process.env.SEED_SECOND_ADMIN_PASSWORD ?? 'admin5678!';

/** A bootstrap admin of `pnpm db:seed`, and the contact its fixture gives it (the seed gives none). */
interface SeedAdmin {
  email: string;
  password: string;
  contact: { realName: string; phone: string };
  /** The variables that name it, for the error a missing seed raises. */
  env: string;
}

const FIRST_ADMIN: SeedAdmin = {
  email: ADMIN_EMAIL,
  password: ADMIN_PASSWORD,
  contact: { realName: '테스트관리자', phone: '01000000000' },
  env: 'SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD',
};

const SECOND_ADMIN: SeedAdmin = {
  email: SECOND_ADMIN_EMAIL,
  password: SECOND_ADMIN_PASSWORD,
  contact: { realName: '테스트둘째관리자', phone: '01000000001' },
  env: 'SEED_SECOND_ADMIN_EMAIL / SEED_SECOND_ADMIN_PASSWORD',
};

/** PLAN 13 M4 AC 1: 한 브라우저의 변화가 다른 브라우저의 카드·상세에 1초 내 반영된다. */
export const REALTIME_BUDGET_MS = 1_000;

/** How long a socket may take to open and ask for its rooms before a spec gives up on it. */
const REALTIME_READY_MS = 10_000;

/** Far enough out that no spec races the close, close enough to stay obviously synthetic. */
const CLOSE_IN_MS = 24 * 60 * 60 * 1_000;

// ---- fixtures -----------------------------------------------------------------------

/**
 * Signs `context` in as a bootstrap admin and gives it a contact.
 *
 * The seed admins are accounts like any other, so the onboarding gate (ADR-0043) would send a
 * spec's browser sign-in as one (`signIn(…, adminAccount…)`) to /onboarding instead of `/`.
 * Every spec that does that also asks for that admin's fixture, so the admin gets a contact
 * here — an upsert, so a re-run against a persistent database changes nothing. The body names
 * the account it is for (`expectedAccountId`, A-PG-24): the sign-in's own answer.
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
  const contact = await context.put('/api/v1/me/contact', {
    data: { ...admin.contact, expectedAccountId: user.id },
  });
  if (!contact.ok()) {
    throw new Error(
      `saving the contact of ${admin.email} failed (${String(contact.status())}): ${await contact.text()}`,
    );
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

/** The verify-email link of the newest Mailpit message addressed to `email`. */
export async function verificationLink(email: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const query = encodeURIComponent(`to:${email}`);
    const search = (await (
      await fetch(`${MAILPIT_URL}/api/v1/search?query=${query}`)
    ).json()) as MailpitSearch;
    const newest = search.messages[0];
    if (newest) {
      const message = (await (
        await fetch(`${MAILPIT_URL}/api/v1/message/${newest.ID}`)
      ).json()) as MailpitMessage;
      const match = /https?:\/\/\S+\/verify-email\?\S+/.exec(message.Text);
      if (match) return match[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no verification mail for ${email} (is Mailpit up at ${MAILPIT_URL}?)`);
}

/**
 * The first half of a sign-up (ADR-0024): the form takes the email only, and the link in the
 * mail signs the user in and lands on /set-password. The account is signed in from here on
 * but has neither a password nor a real name and phone yet — which is also the state the
 * onboarding gate exists for (ADR-0043), so onboarding.spec.ts starts from this.
 */
export async function openSetPassword(page: Page, email: string): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel(copy.email).fill(email);
  await page.getByRole('button', { name: copy.signupWithEmail }).click();
  await expect(page.getByTestId('signup-check-mail')).toBeVisible();

  await page.goto(await verificationLink(email));
  await expect(page).toHaveURL('/set-password');
}

/**
 * Sign-up (ADR-0024, ADR-0043): /set-password takes the first password AND the real name and
 * mobile number, so the account never meets the onboarding gate. It arrives with the sign-up
 * bonus already credited (migration 0004), which the balance chip shows.
 */
export async function signUp(page: Page, email: string): Promise<void> {
  await openSetPassword(page, email);
  await page.getByTestId('new-password').fill(E2E_PASSWORD);
  await page.getByTestId('new-password-confirm').fill(E2E_PASSWORD);
  await page.getByTestId('contact-real-name').fill(E2E_CONTACT.realName);
  await page.getByTestId('contact-phone').fill(E2E_CONTACT.phone);
  await page.getByRole('button', { name: copy.setPasswordSubmit }).click();
  await expect(page).toHaveURL('/');
}

/**
 * Signs an existing account in through the login form; lands on `/` with no `next`. The account
 * must have a real name and phone — every `signUp` account does, and the seed admins get them
 * from the `admin` and `secondAdmin` fixtures — or the onboarding gate (ADR-0043) sends it to
 * /onboarding instead.
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
   * The random part of the title and the slug. Unique per run, so `/search?q=<tag>` is a search
   * screen holding exactly this market's card and nothing else — which is what makes AC 1's card
   * assertion independent of how many markets the database already has. Every status is
   * searched until one is picked (ADR-0066), so it finds the market after a close too.
   */
  tag: string;
  /** The slug of the category it is filed under: `/?category=<slug>` lists it. */
  categorySlug: string;
}

export interface CreateOpenMarketOptions {
  /**
   * Which TOP-LEVEL category, by position in `GET /categories` (parents first, in display
   * order): 0, the default, is the first. A spec that needs markets in two different categories
   * passes 1 for the second. Throws when the seed has fewer.
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
  { topLevelCategory = 0, group, description }: CreateOpenMarketOptions = {},
): Promise<TestMarket> {
  const categories = await unwrap<Category[]>(await admin.get('/api/v1/categories'));
  const category = categories.filter((row) => row.parentId === null)[topLevelCategory];
  if (category === undefined) {
    throw new Error('no active category: run `pnpm db:seed` (categories have no admin route)');
  }

  const tag = freshTag();
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
        categoryId: category.id,
        imageUrl: null,
        closeAt: new Date(Date.now() + CLOSE_IN_MS).toISOString(),
        slug: `e2e-${tag}`,
      },
    }),
  );
  const open = await unwrap<AdminMarket>(
    await admin.post(`/api/v1/admin/markets/${draft.id}/open`),
  );
  return { id: open.id, slug: open.slug, title, rules, tag, categorySlug: category.slug };
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
 * 마감 through the admin API (`POST /admin/markets/:id/close`): trading stops, and the market
 * waits for the admin's 판정. The API, not the UI, because closing is a means here — the
 * settlement spec measures what comes after it.
 */
export async function closeMarket(
  admin: APIRequestContext,
  marketId: string,
): Promise<AdminMarket> {
  return unwrap<AdminMarket>(await admin.post(`/api/v1/admin/markets/${marketId}/close`));
}

/**
 * How long a spec waits for a judged market to read 정산 완료 (ADR-0046). There is no window to
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
