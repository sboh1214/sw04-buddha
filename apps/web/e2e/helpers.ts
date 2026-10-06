import {
  expect,
  test as base,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import type { AdminMarket, Category, ChargePackage } from '@buddha/shared';
import { copy } from '../src/copy';

/**
 * Fixtures every M4 spec shares (PLAN 14): the Mailpit sign-up flow auth.spec.ts introduced,
 * plus an admin API context that CREATES the market a spec trades on.
 *
 * The market is created per run, never taken from `pnpm db:seed`. A seeded market carries an
 * absolute KST close time and keeps `status: 'open'` after it (A-M3-31) while the API refuses
 * every trade with MARKET_CLOSED, so a spec pinned to the seed's calendar passes today and
 * rots on a date nobody will connect to the failure. The two things a spec still needs from
 * the seed are the ones no public or admin route can make: the first admin (PLAN 10.5) and the
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

/** What the `admin` fixture gives the seed admin, which `pnpm db:seed` creates without one. */
const ADMIN_CONTACT = { realName: '테스트관리자', phone: '01000000000' } as const;

/** The repo's placeholder for a figure that does not exist yet (trade-panel.tsx). */
export const DASH = '—';

/** PLAN 13 M4 AC 1: 브라우저 A에서 매수 → 브라우저 B의 카드·상세 확률이 1초 내 갱신. */
export const REALTIME_BUDGET_MS = 1_000;

/**
 * A quote costs the 300ms debounce (PLAN 11.4) plus a `POST /quotes` round trip, so AC 3's
 * "300ms 내 견적" cannot be measured as a wall-clock budget from the keystroke; this is the
 * generous bound that still fails a panel which never prices at all.
 */
export const QUOTE_TIMEOUT_MS = 8_000;

/** How long a socket may take to open and ask for its rooms before a spec gives up on it. */
const REALTIME_READY_MS = 10_000;

/**
 * A market whose price moves visibly on a few thousand P. The reading that matters is the
 * WHOLE percent both the detail's 확률 and a card's 예 NN% badge show, so the buy has to move
 * the probability by points, not by fractions of one.
 *
 * LMSR from q_yes = q_no = 0: 5,000P buys q where 100·b·ln((e^(q/b) + 1) / 2) = 5,000, and the
 * price lands at e^(q/b) / (e^(q/b) + 1). At b = 200 that is ~90 contracts and 50% → 61%,
 * which nothing rounds away. b = 10,000 — the first guess here — buys ~100 contracts and moves
 * the price by a quarter of a point, so the badge still reads 50% and AC 1 could never pass.
 */
const LIQUIDITY_B = 200;
const INITIAL_PROB_BP = 5_000;

/** Far enough out that no spec races the close, close enough to stay obviously synthetic. */
const CLOSE_IN_MS = 24 * 60 * 60 * 1_000;

// ---- fixtures -----------------------------------------------------------------------

/**
 * `admin` is an API context signed in as the seed admin, isolated from every browser context
 * in the test: the specs' own `request` fixture stays cookie-less, which is what lets AC 2
 * read the detail page's HTML as an anonymous visitor would.
 */
export const test = base.extend<{ admin: APIRequestContext }>({
  // The second argument is Playwright's `use`, renamed: this package lints with
  // eslint-plugin-react-hooks, which reads a call to `use(…)` outside a component as React's
  // own `use` hook and fails `rules-of-hooks`. Playwright passes it positionally.
  admin: async ({ playwright, baseURL }, provide) => {
    const context = await playwright.request.newContext({ baseURL });
    const signedIn = await context.post('/api/auth/sign-in/email', {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    if (!signedIn.ok()) {
      throw new Error(
        `admin sign-in failed for ${ADMIN_EMAIL} (${String(signedIn.status())}): ` +
          'run `pnpm db:seed` with SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD set',
      );
    }
    // The seed admin is an account like any other, so the onboarding gate (ADR-0043) would send
    // a spec's browser sign-in as the admin (`signIn(…, adminAccount…)`) to /onboarding instead
    // of `/`. Every spec that does that also asks for this fixture, so the admin gets a contact
    // here — an upsert, so a re-run against a persistent database changes nothing. The body
    // names the account it is for (`expectedAccountId`, A-PG-24): the sign-in's own answer.
    const { user } = (await signedIn.json()) as { user: { id: string } };
    const contact = await context.put('/api/v1/me/contact', {
      data: { ...ADMIN_CONTACT, expectedAccountId: user.id },
    });
    if (!contact.ok()) {
      throw new Error(
        `saving the seed admin's contact failed (${String(contact.status())}): ${await contact.text()}`,
      );
    }
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
 * must have a real name and phone — every `signUp` account does, and the seed admin gets them
 * from the `admin` fixture — or the onboarding gate (ADR-0043) sends it to /onboarding instead.
 */
export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(copy.email).fill(email);
  await page.getByLabel(copy.password, { exact: true }).fill(password);
  await page.getByRole('button', { name: copy.loginWithEmail }).click();
  await expect(page).toHaveURL('/');
}

/** The seed admin, for a spec that needs a second signed-in browser without a second mailbox. */
export const adminAccount = { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } as const;

// ---- the market under test ----------------------------------------------------------

export interface TestMarket {
  /** Canonical lower-cased uuid: the realtime room, the ticks route and the cache key. */
  id: string;
  /** What `/markets/[slug]` is opened with. */
  slug: string;
  title: string;
  rules: string;
  /** Display YES price 1..99, as `예 NN%` renders it in the HTML AC 2 reads. */
  lastPrice: number;
  /** YES probability in basis points, as `NN.NN%` renders it beside the big number. */
  pYesBp: number;
  /**
   * The random part of the title and the slug. Unique per run, so `/?q=<tag>` is a home page
   * holding exactly this market's card and nothing else — which is what makes AC 1's card
   * assertion independent of how many markets the database already has.
   */
  tag: string;
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
 * `open`, has an `open` price tick (and therefore a chart and a sparkline), and closes a day
 * from now whatever the calendar says.
 */
export async function createOpenMarket(admin: APIRequestContext): Promise<TestMarket> {
  const categories = await unwrap<Category[]>(await admin.get('/api/v1/categories'));
  const category = categories[0];
  if (category === undefined) {
    throw new Error('no active category: run `pnpm db:seed` (categories have no admin route)');
  }

  // Slug-safe by construction: base36 is [a-z0-9] and MARKET_SLUG_PATTERN allows '-'.
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const title = `E2E 확률 시장 ${tag}`;
  // Deliberately does NOT contain 정산 기준: AC 2 looks for the section heading and for this
  // text separately, and a rules body carrying the heading would satisfy both on its own.
  const rules = `이 시장은 자동화 테스트가 만들었습니다. 확인 코드 ${tag}.`;

  const draft = await unwrap<AdminMarket>(
    await admin.post('/api/v1/admin/markets', {
      data: {
        title,
        description: null,
        rules,
        resolutionSource: `테스트 출처 ${tag}`,
        categoryId: category.id,
        imageUrl: null,
        closeAt: new Date(Date.now() + CLOSE_IN_MS).toISOString(),
        initialProbBp: INITIAL_PROB_BP,
        liquidityB: LIQUIDITY_B,
        slug: `e2e-${tag}`,
      },
    }),
  );
  const open = await unwrap<AdminMarket>(
    await admin.post(`/api/v1/admin/markets/${draft.id}/open`),
  );
  return {
    id: open.id,
    slug: open.slug,
    title,
    rules,
    lastPrice: open.lastPrice,
    pYesBp: open.pYesBp,
    tag,
  };
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

/**
 * Makes sure the charge catalogue has something to buy. The seed fills it, but an admin who
 * emptied it leaves it empty on purpose (seed.ts), and AC 7 needs a 충전 step either way.
 */
export async function ensureChargePackage(admin: APIRequestContext): Promise<void> {
  const packages = await unwrap<ChargePackage[]>(await admin.get('/api/v1/charge-packages'));
  if (packages.length > 0) return;
  await unwrap(
    await admin.post('/api/v1/admin/charge-packages', {
      // priceKrw must not exceed the face value (charge-package.ts `priceWithinFaceValue`).
      data: { amountP: '10000', priceKrw: 9900, sortOrder: 0, isActive: true },
    }),
  );
}

/** Buys the first package on /wallet and waits for the confirmation toast. */
export async function chargeOnce(page: Page): Promise<void> {
  await page.goto('/wallet');
  const buy = page.locator('[data-testid^="charge-buy-"]').first();
  await expect(buy).toBeVisible();
  await buy.click();
  await expect(page.getByText(copy.chargeDone)).toBeVisible();
}

// ---- the trade panel ----------------------------------------------------------------

/** The inline card at `md` and up; the bottom sheet the fixed 예/아니오 bar opens below it. */
export type TradeTestIdPrefix = 'trade' | 'trade-sheet';

/**
 * Opens the panel for one outcome and answers the testid prefix to address it with.
 *
 * The prefix is not cosmetic: below `md` the inline card stays mounted behind `display: none`
 * while the sheet is open, so both id sets are in the DOM at once and a bare `trade-value`
 * matches two fields (trade-panel.tsx `TradePanelViewProps`). Which one is live is decided by
 * the viewport, not by the project name, so this reads the fixed 예/아니오 bar's own visibility
 * — a spec that overrides `viewport` gets the right half with no extra argument.
 */
export async function openTradeForm(page: Page, outcome: 'YES' | 'NO'): Promise<TradeTestIdPrefix> {
  const bar = page.getByTestId('trade-bar');
  await bar.waitFor({ state: 'attached' });
  if (await bar.isVisible()) {
    await page.getByTestId(outcome === 'YES' ? 'trade-bar-yes' : 'trade-bar-no').click();
    await expect(page.getByTestId('trade-sheet')).toBeVisible();
    return 'trade-sheet';
  }
  await page.getByTestId(outcome === 'YES' ? 'trade-outcome-yes' : 'trade-outcome-no').click();
  return 'trade';
}

/**
 * 금액 입력 → 견적 → 확인, the whole of AC 3 in one call for the specs that only need the
 * trade to have happened. trade.spec.ts spells the same steps out, because there the
 * intermediate states ARE the acceptance criterion.
 */
export async function buyThroughPanel(
  page: Page,
  outcome: 'YES' | 'NO',
  amountP: string,
): Promise<void> {
  const prefix = await openTradeForm(page, outcome);
  await page.getByTestId(`${prefix}-value`).fill(amountP);
  await expect(page.getByTestId(`${prefix}-summary-shares`)).not.toHaveText(DASH, {
    timeout: QUOTE_TIMEOUT_MS,
  });
  await page.getByTestId(`${prefix}-submit`).click();
  await expect(page.getByText(copy.tradeBought)).toBeVisible();
}

// ---- realtime -----------------------------------------------------------------------

/**
 * Resolves once this tab has asked the gateway for `marketId`'s room, so a spec that publishes
 * a tick straight afterwards cannot lose it in the connect gap (A-M4: the t0→t1 window between
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
