import type { APIRequestContext, APIResponse, Page, Route } from '@playwright/test';
import type { Category, Me, ReleaseSetting, StartGrant } from '@buddha/shared';
import { copy } from '../src/copy';
import {
  E2E_PASSWORD,
  E2E_REAL_NAME,
  agreeOnScreen,
  agreeThroughApi,
  createOpenMarket,
  expect,
  freshEmail,
  freshPhone,
  freshTag,
  logOut,
  meOf,
  openSetPassword,
  setFirstPassword,
  signIn,
  signUp,
  test,
  verificationLink,
  verifyPhone,
  verifyThroughApi,
} from './helpers';

/**
 * 가입 직후 온보딩 (#58, ADR-0072) and its gate (ADR-0043): 약관 동의 → 본인확인 → 닉네임 설정 →
 * 시작 Coin 안내 → 관심 카테고리(건너뛸 수 있음, shown once) → the page the account was on before it
 * signed up (ADR-0069 decision 4 #58, decision 1 #57-4~#57-10), the re-consent after a revision and
 * the reason a step was sent back, and MY 설정's marketing switch (오너 결정 2026-10-19 (2차)).
 *
 * The email sign-up passes through exactly the state the gate exists for: the verification link
 * signs the account in on /set-password before any step is done. Leaving that page for another one
 * is what a social sign-up does after signing in, so the gate is exercised on a real account with
 * no database access. The codes come from the API's development SMS sender, which mails them to
 * Mailpit (helpers.ts `smsCode`); phone-verification.spec.ts covers the 본인확인 step's refusals.
 *
 * The start Coin the nickname step grants waits while the release setting 시작 지급액 has no value
 * (ADR-0071) — the e2e database's state, which no spec changes: a value entered here would be paid
 * by the worker to every account any spec made. So the notice screen's waiting form is the real
 * one, and its amount form is drawn from the nickname step's own answer rewritten in the browser
 * (`page.route`), the way start-grant.spec.ts draws the paid wallet.
 *
 * Messages are matched `exact` where a step's intro could contain them as a phrase.
 */

const START_COIN_KEY = 'grant.start_coin';

/** `{ data }` out of the success envelope, with the body in the message on a failure. */
async function dataOf<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  if (!response.ok()) throw new Error(`${response.url()} -> ${body}`);
  return (JSON.parse(body) as { data: T }).data;
}

/** The value of the release setting 시작 지급액 as the admin API reads it (null: 미정). */
async function startCoinValue(admin: APIRequestContext): Promise<number | null> {
  const items = await dataOf<ReleaseSetting[]>(await admin.get('/api/v1/admin/release-settings'));
  const item = items.find((setting) => setting.key === START_COIN_KEY);
  if (item === undefined) throw new Error(`${START_COIN_KEY} is not registered`);
  return typeof item.value === 'number' ? item.value : null;
}

/** An error envelope's code and details. */
async function errorOf(response: APIResponse): Promise<{ code: string; details?: unknown }> {
  return ((await response.json()) as { error: { code: string; details?: unknown } }).error;
}

/** A nickname no account has: letters and digits after a prefix, at most 20 characters. */
function freshNickname(prefix: string): string {
  return `${prefix}${freshTag().slice(-10)}`.slice(0, 20);
}

/**
 * An account at the nickname step, quickly: a fresh email sign-up with its password, the consent
 * and the 본인확인 through the API, then /onboarding — which resumes at the nickname (#57-8).
 */
async function atNicknameStep(page: Page): Promise<Me> {
  await openSetPassword(page, freshEmail());
  await setFirstPassword(page);
  await expect(page).toHaveURL('/onboarding');
  const me = await meOf(page.request);
  await agreeThroughApi(page.request, me.id);
  await verifyThroughApi(page.request, me.id, freshPhone());
  await page.reload();
  await expect(page.getByTestId('nickname-step')).toBeVisible();
  return me;
}

test.describe('가입 직후 온보딩 (#58)', () => {
  test('보던 시장에서 이메일로 가입하면 약관 동의·본인확인·닉네임·시작 Coin 안내·관심 카테고리를 거쳐 그 시장으로 돌아온다', async ({
    page,
    admin,
  }) => {
    const market = await createOpenMarket(admin);
    const startCoin = await startCoinValue(admin);
    const marketPath = `/markets/${market.slug}`;

    // A visitor on a market signs up from the header; the page rides along (#57-9).
    await page.goto(marketPath);
    await page.getByRole('link', { name: copy.signup }).first().click();
    await expect(page).toHaveURL(`/signup?next=${encodeURIComponent(marketPath)}`);
    // So does the login screen's own 회원가입 link.
    await page.goto(`/login?next=${encodeURIComponent(marketPath)}`);
    await expect(page.getByRole('link', { name: copy.signup }).last()).toHaveAttribute(
      'href',
      `/signup?next=${encodeURIComponent(marketPath)}`,
    );
    await page.getByRole('link', { name: copy.signup }).last().click();
    await expect(page).toHaveURL(`/signup?next=${encodeURIComponent(marketPath)}`);

    // The mail's link carries it to /set-password, wherever the link is opened.
    const email = freshEmail();
    await page.getByLabel(copy.email).fill(email);
    await page.getByRole('button', { name: copy.signupWithEmail }).click();
    await expect(page.getByTestId('signup-check-mail')).toBeVisible();
    await page.goto(await verificationLink(email));
    await expect(page).toHaveURL(`/set-password?next=${encodeURIComponent(marketPath)}`);
    await setFirstPassword(page);

    // The market, then the gate: the onboarding, carrying the market.
    await expect(page).toHaveURL(`/onboarding?next=${encodeURIComponent(marketPath)}`);

    // --- 약관 동의: required items, each its own box, and 전체 동의 (#57-4·#57-5).
    const consent = page.getByTestId('consent-step');
    await expect(consent).toBeVisible();
    await expect(page.getByTestId('onboarding-heading')).toHaveText(copy.onboardingStepConsent);
    // A first consent has nothing to explain: no reason, and arriving moves no focus (7-36). Nor a
    // way to MY 설정, which only a re-consent's step offers (ADR-0078, 오너 결정 2026-10-22 답 2).
    await expect(page.getByTestId('onboarding-return-reason')).toHaveCount(0);
    await expect(page.getByTestId('onboarding-settings-link')).toHaveCount(0);
    await expect(page.getByTestId('onboarding-heading')).not.toBeFocused();
    await expect(page.getByTestId('onboarding-heading')).not.toHaveAttribute('aria-describedby');
    await expect(page.getByTestId('onboarding-position')).toHaveText('1 / 5');
    for (const item of ['terms', 'privacy', 'age', 'marketing']) {
      await expect(consent.getByTestId(`consent-${item}`).getByRole('checkbox')).not.toBeChecked();
    }
    await expect(consent.getByText(`${copy.consentAge} ${copy.consentRequiredTag}`)).toBeVisible();
    // Nothing checked, or only the optional item: refused here, nothing recorded.
    await page.getByTestId('consent-submit').click();
    await expect(page.getByTestId('consent-required-error')).toHaveText(copy.errConsentRequired);
    await page.getByTestId('consent-marketing').click();
    await page.getByTestId('consent-submit').click();
    await expect(page.getByTestId('consent-required-error')).toBeVisible();
    expect((await meOf(page.request)).onboarding.consents).toEqual([]);
    // The two texts this step owns open in place; the documents in a new tab.
    await page.getByTestId('consent-privacy-toggle').click();
    const privacyText = page.getByTestId('consent-privacy-text');
    await expect(privacyText).toContainText('알리고(㈜알리는사람들)');
    // Each toggle is named after its text: two '내용 보기' would not say which opens what.
    await expect(page.getByTestId('consent-privacy-toggle')).toHaveAccessibleName(
      `개인정보 수집·이용 동의(필수) ${copy.consentHideText}`,
    );
    await expect(page.getByTestId('consent-marketing-toggle')).toHaveAccessibleName(
      `마케팅 정보 수신 동의(선택) ${copy.consentShowText}`,
    );
    // The collection table fits the box at any width (375px included): every row's retention
    // period is read without scrolling sideways.
    await expect(privacyText.getByText('보유·이용 기간').first()).toBeVisible();
    expect(await privacyText.evaluate((box) => box.scrollWidth <= box.clientWidth)).toBe(true);
    await expect(consent.getByRole('link', { name: copy.consentViewTerms })).toHaveAttribute(
      'href',
      '/terms',
    );
    // 전체 동의 checks the four; the optional one is then cleared again.
    await page.getByTestId('consent-all').click();
    for (const item of ['terms', 'privacy', 'age', 'marketing']) {
      await expect(consent.getByTestId(`consent-${item}`).getByRole('checkbox')).toBeChecked();
    }
    await page.getByTestId('consent-marketing').click();
    await expect(page.getByTestId('consent-required-error')).toHaveCount(0);
    await page.getByTestId('consent-submit').click();

    // --- 본인확인 (#183), the heading taking the focus as the step changes.
    await expect(page.getByTestId('verification-step')).toBeVisible();
    await expect(page.getByTestId('onboarding-heading')).toBeFocused();
    await expect(page.getByTestId('onboarding-position')).toHaveText('2 / 5');
    await verifyPhone(page);

    // --- 닉네임: the auto nickname offered, and confirmed as it is (#57-6).
    const input = page.getByTestId('nickname-step-input');
    await expect(input).toHaveValue(/^user_/);
    const autoNickname = await input.inputValue();
    await page.getByTestId('nickname-step-submit').click();

    // --- 시작 Coin 안내 (#57-10): the amount, or while it is undecided the owner's sentence.
    await expect(page.getByTestId('notice-step')).toBeVisible();
    if (startCoin === null) {
      await expect(page.getByTestId('notice-pending')).toHaveText(copy.walletStartGrantPending);
      await expect(page.getByTestId('notice-amount')).toHaveCount(0);
    } else {
      await expect(page.getByTestId('notice-amount')).toHaveText(
        `${startCoin.toLocaleString('en-US')} Coin`,
      );
    }
    await expect(page.getByTestId('notice-facts')).toContainText(copy.onboardingNoticeNoCash);
    await expect(page.getByTestId('notice-facts')).toContainText(copy.onboardingNoticeCounterparty);
    await page.getByTestId('notice-next').click();

    // --- 관심 카테고리, skipped (#57-7) — and back on the market. The step's answer is the one
    // write: leaving the screen it answered sends no second skip (ADR-0078).
    const stepWrites: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/v1/me/onboarding/interests')) {
        stepWrites.push(request.method());
      }
    });
    await expect(page.getByTestId('interests-step')).toBeVisible();
    await expect(page.getByTestId('interests-list')).toBeVisible();
    await page.getByTestId('interests-skip').click();
    await expect(page).toHaveURL(marketPath);
    expect(stepWrites).toEqual(['POST']);

    // What the server holds: each answer with its version, the nickname set, the start Coin
    // recorded (waiting or paid), no categories, nothing left.
    const me = await meOf(page.request);
    expect(me.onboarding).toMatchObject({
      consent: true,
      verification: true,
      nickname: true,
      completed: true,
      interests: true,
      nextStep: null,
    });
    expect(me.onboarding.consents.map(({ item, agreed }) => ({ item, agreed }))).toEqual([
      { item: 'terms', agreed: true },
      { item: 'privacy', agreed: true },
      { item: 'age', agreed: true },
      { item: 'marketing', agreed: false },
    ]);
    expect(me.profile.nickname).toBe(autoNickname);
    expect(me.startGrant?.status).toBe(startCoin === null ? 'pending' : 'granted');
    expect(me.profile.interestCategoryIds).toEqual([]);

    // Never asked again: /onboarding sends a finished account straight on — to a path on this
    // origin only; anything else is home.
    await page.goto('/onboarding?next=%2Fmy%2Fsettings');
    await expect(page).toHaveURL('/my/settings');
    await page.goto(`/onboarding?next=${encodeURIComponent('https://evil.example/')}`);
    await expect(page).toHaveURL('/');
    await page.goto(`/onboarding?next=${encodeURIComponent('//evil.example')}`);
    await expect(page).toHaveURL('/');
  });

  test('마치지 않은 단계가 있으면 어느 화면에서든 남은 단계로 보내지고, 마치면 가려던 화면으로 돌아간다', async ({
    page,
  }) => {
    // Signed in, no password, no step done.
    await openSetPassword(page, freshEmail());

    // Exempt: the legal documents stay readable. The balance chip means `GET /me` has answered,
    // and the gate decides in the same render — so its placeholder would be up by now.
    await page.goto('/terms');
    await expect(page.getByTestId('balance-chip')).toBeVisible();
    await expect(page.getByTestId('onboarding-gate')).toHaveCount(0);
    await expect(page).toHaveURL('/terms');

    // Gated: any other page sends the account to its remaining step, carrying where it was going.
    await page.goto('/my/wallet');
    await expect(page).toHaveURL('/onboarding?next=%2Fmy%2Fwallet');
    await agreeOnScreen(page);

    // Left after the consent and back later: it resumes at the 본인확인 (#57-8).
    await page.goto('/my/wallet');
    await expect(page).toHaveURL('/onboarding?next=%2Fmy%2Fwallet');
    await expect(page.getByTestId('verification-step')).toBeVisible();
    // Required, and checked with the API's own rules before anything is sent.
    await page.getByTestId('verification-send').click();
    await expect(page.getByText(copy.errRealNameRequired, { exact: true })).toBeVisible();
    await expect(page.getByText(copy.errPhoneRequired, { exact: true })).toBeVisible();
    await verifyPhone(page);
    await expect(page.getByText(copy.verificationDone)).toBeVisible();

    // Left at the nickname: back there.
    await expect(page.getByTestId('nickname-step')).toBeVisible();
    // Home carries no `next`: home is where the onboarding ends without one.
    await page.goto('/');
    await expect(page).toHaveURL('/onboarding');
    await expect(page.getByTestId('nickname-step')).toBeVisible();
    await page.getByTestId('nickname-step-submit').click();

    // Left at the notice: the three steps are done and the interests skipped — they are shown
    // once, right after the nickname step (오너 결정 2026-10-19 (2차) 5). Nothing sends the
    // account back, and /onboarding opened again goes straight on. The page that went sent the
    // skip as it went (`pagehide`), and the server holds it (owner decision 2026-10-21 (2nd)
    // answer 2, ADR-0078).
    await expect(page.getByTestId('notice-step')).toBeVisible();
    await page.goto('/my/wallet');
    await expect(page.getByTestId('balance-chip')).toBeVisible();
    await expect(page.getByTestId('onboarding-gate')).toHaveCount(0);
    await expect(page).toHaveURL('/my/wallet');
    await page.goto('/onboarding?next=%2Fmy%2Fwallet');
    await expect(page).toHaveURL('/my/wallet');
    await expect.poll(async () => (await meOf(page.request)).onboarding.interests).toBe(true);
    expect((await meOf(page.request)).onboarding).toMatchObject({
      completed: true,
      interests: true,
      nextStep: null,
    });
    expect((await meOf(page.request)).profile.interestCategoryIds).toEqual([]);

    // Nothing left: other pages open as usual.
    await page.goto('/');
    await expect(page.getByTestId('balance-chip')).toBeVisible();
    await expect(page.getByTestId('onboarding-gate')).toHaveCount(0);
    await expect(page).toHaveURL('/');

    // /set-password still sets the first password of an account that has none, and goes home.
    await page.goto('/set-password');
    await setFirstPassword(page);
    await expect(page).toHaveURL('/');
  });

  test('필수 동의 없이는 다음 단계로 갈 수 없고, 화면을 거치지 않은 요청도 서버가 순서대로 거절한다', async ({
    page,
  }) => {
    await openSetPassword(page, freshEmail());
    const { id } = await meOf(page.request);
    const expectRefused = async (response: APIResponse, status: number, code: string) => {
      expect(response.status(), await response.text()).toBe(status);
      return errorOf(response).then((error) => {
        expect(error.code).toBe(code);
        return error;
      });
    };

    // The 본인확인 comes after the consent; the nickname after both; the interests after the three.
    const code = await expectRefused(
      await page.request.post('/api/v1/me/phone-verification/code', {
        data: { realName: E2E_REAL_NAME, phone: freshPhone(), expectedAccountId: id },
      }),
      409,
      'ONBOARDING_REQUIRED',
    );
    expect(code.details).toEqual({ steps: ['consent'] });
    const nickname = await expectRefused(
      await page.request.post('/api/v1/me/onboarding/nickname', {
        data: { nickname: freshNickname('e2e'), expectedAccountId: id },
      }),
      409,
      'ONBOARDING_REQUIRED',
    );
    expect(nickname.details).toEqual({ steps: ['consent', 'verification'] });
    const interests = await expectRefused(
      await page.request.post('/api/v1/me/onboarding/interests', {
        data: { categoryIds: [], expectedAccountId: id },
      }),
      409,
      'ONBOARDING_REQUIRED',
    );
    expect(interests.details).toEqual({ steps: ['consent', 'verification', 'nickname'] });
    // MY 설정's write answers no step: dropping nothing changes nothing (ADR-0078).
    const settings = await page.request.put('/api/v1/me/interest-categories', {
      data: { categoryIds: [], expectedAccountId: id },
    });
    expect(settings.status(), await settings.text()).toBe(200);
    expect((await meOf(page.request)).onboarding.interests).toBe(false);

    // A required item not agreed is refused; nothing is recorded.
    const agreed = { version: 'draft-2026-10-18', agreed: true };
    await expectRefused(
      await page.request.post('/api/v1/me/consents', {
        data: {
          consents: {
            terms: agreed,
            privacy: agreed,
            age: { ...agreed, agreed: false },
            marketing: agreed,
          },
          expectedAccountId: id,
        },
      }),
      400,
      'VALIDATION_ERROR',
    );
    const me = await meOf(page.request);
    expect(me.onboarding.consent).toBe(false);
    expect(me.onboarding.consents).toEqual([]);
    expect(me.startGrant).toBeNull();
  });

  test("닉네임 규칙: 'user_'로 시작하거나 예약어가 든 닉네임과 대소문자만 다른 닉네임은 안 되고, 설정에서는 30일에 한 번 바꾼다", async ({
    page,
  }) => {
    // Account A sets a nickname of its own at its nickname step.
    const emailA = freshEmail();
    const taken = freshNickname('Ab');
    await signUp(page, emailA, freshPhone(), { nickname: taken });
    expect((await meOf(page.request)).profile.nickname).toBe(taken);
    await logOut(page);

    // Account B at its nickname step.
    await atNicknameStep(page);
    const input = page.getByTestId('nickname-step-input');
    const submit = page.getByTestId('nickname-step-submit');
    const error = page.getByTestId('nickname-step-error');

    // The rules a typed nickname is held to, said before anything is sent (#57-6).
    await input.fill('user_mine1');
    await submit.click();
    await expect(error).toHaveText(copy.errNicknameAutoPrefix);
    await input.fill('공식Admin');
    await submit.click();
    await expect(error).toHaveText(copy.errNicknameReservedWord);
    // Another account's nickname in another case: the server's answer, under the input.
    await input.fill(taken.toLowerCase());
    await submit.click();
    await expect(error).toHaveText(copy.errNicknameTaken);
    await expect(page.getByTestId('nickname-step')).toBeVisible();

    // One of its own: set, and the notice follows.
    const mine = freshNickname('Bc');
    await input.fill(mine);
    await submit.click();
    await expect(page.getByTestId('notice-step')).toBeVisible();
    await page.getByTestId('notice-next').click();

    // Interests: a top-level category and a sub-category of another, as many as it likes (#57-7).
    const categories = await dataOf<Category[]>(await page.request.get('/api/v1/categories'));
    const parent = categories.find((row) => row.parentId === null);
    const child = categories.find((row) => row.parentId !== null && row.parentId !== parent?.id);
    if (parent === undefined || child === undefined) {
      throw new Error('the seeded categories are missing: run `pnpm db:seed`');
    }
    await expect(page.getByTestId('interests-save')).toBeDisabled();
    await page.getByTestId(`interest-${parent.slug}`).click();
    await page.getByTestId(`interest-${child.slug}`).click();
    await page.getByTestId('interests-save').click();
    await expect(page).toHaveURL('/');
    const me = await meOf(page.request);
    expect(me.profile.nickname).toBe(mine);
    expect(me.profile.interestCategoryIds).toEqual([parent.id, child.id].sort((a, b) => a - b));
    // The onboarding's choice is no change: the first change in MY 설정 is open.
    expect(me.profile.nicknameChangeAvailableAt).toBeNull();

    // MY 설정: the same rules, then once in 30 days.
    await page.goto('/my/settings');
    const settingsInput = page.getByTestId('nickname-input');
    const save = page.getByTestId('settings-profile').getByRole('button', { name: copy.save });
    await expect(settingsInput).toHaveValue(mine);
    await settingsInput.fill('운영팀입니다');
    await save.click();
    await expect(page.getByTestId('nickname-error')).toHaveText(copy.errNicknameReservedWord);
    const changed = freshNickname('Cd');
    await settingsInput.fill(changed);
    await save.click();
    await expect(page.getByText(copy.nicknameSaved)).toBeVisible();
    await expect(settingsInput).toHaveValue(changed);
    await settingsInput.fill(freshNickname('De'));
    await save.click();
    await expect(page.getByTestId('nickname-error')).toContainText(copy.errNicknameChangeInterval);
    await expect(page.getByTestId('nickname-error')).toContainText(copy.nicknameChangeAgainFrom);
    expect((await meOf(page.request)).profile.nickname).toBe(changed);
    await logOut(page);

    // The nickname B gave up is held from other accounts for 30 days (#57-6, #37-16): A, whose
    // first change is open, cannot take it — in any case.
    await signIn(page, emailA, E2E_PASSWORD);
    await page.goto('/my/settings');
    await expect(page.getByTestId('nickname-input')).toHaveValue(taken);
    await page.getByTestId('nickname-input').fill(mine.toUpperCase());
    await page.getByTestId('settings-profile').getByRole('button', { name: copy.save }).click();
    await expect(page.getByTestId('nickname-error')).toHaveText(copy.errNicknameTaken);
  });

  /**
   * The nickname step's answer and `GET /me` with `startGrant` rewritten: the step asks `GET /me`
   * again after the grant (for the balance), and that answer would otherwise put the real waiting
   * grant back on the screen.
   */
  async function rewriteStartGrant(page: Page, startGrant: StartGrant): Promise<void> {
    const rewrite = async (route: Route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { data: Me };
      body.data.startGrant = startGrant;
      await route.fulfill({ response, json: body });
    };
    await page.route('**/api/v1/me/onboarding/nickname', rewrite);
    await page.route('**/api/v1/me', (route) =>
      route.request().method() === 'GET' ? rewrite(route) : route.fallback(),
    );
  }

  test('시작 Coin이 지급되면 안내 화면은 대기 문장 대신 지급액을 보인다', async ({ page }) => {
    await atNicknameStep(page);
    // The amount form of the notice (#57-10), from the nickname step's own answer rewritten: a
    // value entered for real would be paid to every waiting account of every spec (see above).
    await rewriteStartGrant(page, {
      status: 'granted',
      amountCoin: '10000',
      grantedAt: new Date().toISOString(),
    });
    await page.getByTestId('nickname-step-submit').click();

    await expect(page.getByTestId('notice-granted')).toContainText(copy.onboardingNoticeGranted);
    await expect(page.getByTestId('notice-amount')).toHaveText('10,000 Coin');
    await expect(page.getByTestId('notice-pending')).toHaveCount(0);
    await expect(page.getByTestId('notice-number-used')).toHaveCount(0);
    await expect(page.getByTestId('notice-facts')).toContainText(copy.onboardingNoticeNoCash);
    // A `GET /me` still in flight (a focus refetch) must not outlive the page's routes.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('이미 시작 Coin을 받은 번호면 안내 화면은 지급액 대신 그 문장을 보이고 나머지는 같다', async ({
    page,
  }) => {
    await atNicknameStep(page);
    // 오너 결정 2026-10-19: the verified number's start Coin went to an earlier account (a
    // re-signup after a withdrawal, #57-1·#57-17). No spec can make that account — two accounts
    // never hold one verified number, and withdrawal is #140's — so the server's answer
    // (`number_used`, pinned by the API suite) is drawn from its own answer rewritten.
    await rewriteStartGrant(page, { status: 'number_used', amountCoin: null, grantedAt: null });
    await page.getByTestId('nickname-step-submit').click();

    await expect(page.getByTestId('notice-number-used')).toHaveText(
      copy.onboardingNoticeNumberUsed,
    );
    await expect(page.getByTestId('notice-granted')).toHaveCount(0);
    await expect(page.getByTestId('notice-pending')).toHaveCount(0);
    // The rest of the notice and the interests step are the same.
    await expect(page.getByTestId('notice-facts')).toContainText(copy.onboardingNoticeNoCash);
    await expect(page.getByTestId('notice-facts')).toContainText(copy.onboardingNoticeCounterparty);
    await page.getByTestId('notice-next').click();
    await expect(page.getByTestId('interests-step')).toBeVisible();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('지급 안내나 관심 카테고리 화면을 답하지 않고 떠나면 서버에 건너뛴 것으로 남고, MY 설정에서 처음 고르는 것은 그 단계의 답이 아니다', async ({
    page,
  }) => {
    // Owner decision 2026-10-21 (2nd) answer 2 (ADR-0078): leaving the start-Coin notice or the
    // interests screen without an answer is the skip (ADR-0072), and the stepper tells the server.
    // Left inside the app: the header's home link from the interests screen.
    const me = await atNicknameStep(page);
    const categories = await dataOf<Category[]>(await page.request.get('/api/v1/categories'));
    const category = categories.find((row) => row.parentId === null);
    if (category === undefined)
      throw new Error('the seeded categories are missing: run `pnpm db:seed`');
    await page.getByTestId('nickname-step-submit').click();
    await page.getByTestId('notice-next').click();
    await expect(page.getByTestId('interests-step')).toBeVisible();
    const skip = page.waitForRequest(
      (request) =>
        request.url().endsWith('/api/v1/me/onboarding/interests') && request.method() === 'POST',
    );
    await page.getByRole('heading', { level: 1 }).getByRole('link', { name: copy.appName }).click();
    await expect(page).toHaveURL('/');
    expect((await skip).postDataJSON()).toEqual({ categoryIds: [], expectedAccountId: me.id });
    await expect.poll(async () => (await meOf(page.request)).onboarding.interests).toBe(true);
    // Not shown again.
    await page.goto('/onboarding');
    await expect(page).toHaveURL('/');

    // The first pick is MY 설정's, a change the server takes as one (no restriction exists yet —
    // under one it would be refused, as the API suite shows), not the step's first answer.
    await page.goto('/my/settings');
    const interests = page.getByTestId('settings-interests');
    await interests.getByTestId(`interest-${category.slug}`).click();
    await interests.getByTestId('interests-settings-save').click();
    await expect(page.getByText(copy.interestsSaved)).toBeVisible();
    expect((await meOf(page.request)).profile.interestCategoryIds).toEqual([category.id]);

    // Left by reloading the notice: the page that went sent the skip (`pagehide`), and the
    // reloaded screen goes straight on.
    await logOut(page);
    await atNicknameStep(page);
    await page.getByTestId('nickname-step-submit').click();
    await expect(page.getByTestId('notice-step')).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL('/');
    await expect.poll(async () => (await meOf(page.request)).onboarding.interests).toBe(true);
    expect((await meOf(page.request)).profile.interestCategoryIds).toEqual([]);
  });

  test('지급 안내나 관심 카테고리 화면의 로그아웃은 세션을 끝내기 전에 건너뛰기를 보내 서버에 남는다', async ({
    page,
  }) => {
    // Owner decision 2026-10-21 (2nd) answer 2 (ADR-0078 decision 6, 7-23): 로그아웃 is the one way
    // out the screen itself offers, and the session it ends is what the skip needs — so the skip
    // goes first and is answered (200, not the 401 it would get after), and the stepper going
    // after the sign-out sends no second one.
    const categories = await dataOf<Category[]>(await page.request.get('/api/v1/categories'));
    const category = categories.find((row) => row.parentId === null);
    if (category === undefined)
      throw new Error('the seeded categories are missing: run `pnpm db:seed`');
    const stepWrites: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/v1/me/onboarding/interests')) {
        stepWrites.push(request.method());
      }
    });
    const skipAnswered = () =>
      page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/v1/me/onboarding/interests') &&
          response.request().method() === 'POST',
      );

    // On the start-Coin notice.
    const onNotice = await atNicknameStep(page);
    await page.getByTestId('nickname-step-submit').click();
    await expect(page.getByTestId('notice-step')).toBeVisible();
    const fromNotice = skipAnswered();
    await page.getByTestId('onboarding-logout').click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('link', { name: copy.login })).toBeVisible();
    const noticeSkip = await fromNotice;
    expect(noticeSkip.status()).toBe(200);
    expect(noticeSkip.request().postDataJSON()).toEqual({
      categoryIds: [],
      expectedAccountId: onNotice.id,
    });
    await signIn(page, onNotice.email, E2E_PASSWORD);
    let me = await meOf(page.request);
    expect(me.onboarding).toMatchObject({ completed: true, interests: true, nextStep: null });
    expect(me.profile.interestCategoryIds).toEqual([]);
    expect(stepWrites).toEqual(['POST']);
    // Not shown again.
    await page.goto('/onboarding');
    await expect(page).toHaveURL('/');
    await logOut(page);

    // On the interests screen, a category ticked and not saved: the skip, not the tick.
    stepWrites.length = 0;
    const onInterests = await atNicknameStep(page);
    await page.getByTestId('nickname-step-submit').click();
    await page.getByTestId('notice-next').click();
    await expect(page.getByTestId('interests-step')).toBeVisible();
    await page.getByTestId('interests-step').getByTestId(`interest-${category.slug}`).click();
    const fromInterests = skipAnswered();
    await page.getByTestId('onboarding-logout').click();
    await expect(page).toHaveURL('/');
    const interestsSkip = await fromInterests;
    expect(interestsSkip.status()).toBe(200);
    expect(interestsSkip.request().postDataJSON()).toEqual({
      categoryIds: [],
      expectedAccountId: onInterests.id,
    });
    await signIn(page, onInterests.email, E2E_PASSWORD);
    me = await meOf(page.request);
    expect(me.onboarding).toMatchObject({ completed: true, interests: true, nextStep: null });
    expect(me.profile.interestCategoryIds).toEqual([]);
    expect(stepWrites).toEqual(['POST']);
  });

  test('관심 카테고리 단계의 고른 것을 보내는 동안 떠나도 건너뛰기를 보내지 않아, 고른 것이 그 단계의 첫 답으로 남는다', async ({
    page,
  }) => {
    // The step's answer answers the step; a skip sent beside it could land first and turn the picks
    // into a change — refused under a restriction (ADR-0078 decision 6, 7-23). The answer is held
    // on its way while the page says it is going (`pagehide`) and the stepper goes (the header's
    // home link): one write reaches the server, the picks.
    const me = await atNicknameStep(page);
    const categories = await dataOf<Category[]>(await page.request.get('/api/v1/categories'));
    const category = categories.find((row) => row.parentId === null);
    if (category === undefined)
      throw new Error('the seeded categories are missing: run `pnpm db:seed`');
    await page.getByTestId('nickname-step-submit').click();
    await page.getByTestId('notice-next').click();
    await expect(page.getByTestId('interests-step')).toBeVisible();

    const stepWrites: unknown[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/v1/me/onboarding/interests')) {
        stepWrites.push(request.postDataJSON());
      }
    });
    let hold: (route: Route) => void = () => undefined;
    const held = new Promise<Route>((resolve) => {
      hold = resolve;
    });
    let holding = true;
    await page.route('**/api/v1/me/onboarding/interests', async (route) => {
      if (holding) {
        holding = false;
        hold(route);
        return;
      }
      await route.continue();
    });

    await page.getByTestId('interests-step').getByTestId(`interest-${category.slug}`).click();
    await page.getByTestId('interests-save').click();
    const answer = await held;
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.getByRole('heading', { level: 1 }).getByRole('link', { name: copy.appName }).click();
    await expect(page).toHaveURL('/');

    const answered = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/me/onboarding/interests') &&
        response.request().method() === 'POST',
    );
    await answer.continue();
    expect((await answered).status()).toBe(200);
    const after = await meOf(page.request);
    expect(after.onboarding.interests).toBe(true);
    expect(after.profile.interestCategoryIds).toEqual([category.id]);
    expect(stepWrites).toEqual([{ categoryIds: [category.id], expectedAccountId: me.id }]);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  /**
   * `GET /me` with `onboarding` rewritten by `edit` while `active()` says so: what no spec can bring
   * about for real looks like on screen — a revision of the consent texts that changed members'
   * rights (the version table is the build's), a step that came undone.
   */
  async function rewriteOnboarding(
    page: Page,
    active: () => boolean,
    edit: (onboarding: Me['onboarding']) => Me['onboarding'],
  ): Promise<void> {
    await page.route('**/api/v1/me', async (route) => {
      if (route.request().method() !== 'GET' || !active()) return route.fallback();
      const response = await route.fetch();
      const body = (await response.json()) as { data: Me };
      body.data.onboarding = edit(body.data.onboarding);
      await route.fulfill({ response, json: body });
    });
  }

  test('권리를 바꾸는 개정 뒤의 재동의는 서지 않게 된 항목만 묻고 까닭을 보이며, 마케팅 동의는 그대로 둔다', async ({
    page,
  }) => {
    // An onboarded account that agreed to the marketing too (the consent answers again, through the
    // API: only the marketing one changes).
    await signUp(page, freshEmail());
    const { id } = await meOf(page.request);
    await agreeThroughApi(page.request, id, true);
    // A revision of the terms that changed members' rights (오너 결정 2026-10-19 (2차) 1·6): the
    // terms agreement no longer stands, the rest does — `GET /me` says what the server would, until
    // the account agrees again.
    let revised = true;
    await rewriteOnboarding(
      page,
      () => revised,
      (onboarding) => ({
        ...onboarding,
        consent: false,
        completed: false,
        nextStep: 'consent',
        consents: onboarding.consents.map((answer) =>
          answer.item === 'terms' ? { ...answer, version: 'draft-1999-01-01' } : answer,
        ),
      }),
    );
    await page.route('**/api/v1/me/consents', async (route) => {
      const response = await route.fetch();
      revised = false;
      await route.fulfill({ response });
    });

    // The next sign-in's gate: the consent step, saying why, asking the terms only.
    await page.goto('/my/wallet');
    await expect(page).toHaveURL('/onboarding?next=%2Fmy%2Fwallet');
    const reason = page.getByTestId('onboarding-return-reason');
    await expect(reason).toHaveText(copy.onboardingReconsentReason);
    await expect(reason).toHaveAttribute('role', 'status');
    // A status that appears with its text in it is not reliably read out (ADR-0072 7-36): the
    // heading takes the focus and is described by the sentence, so both are read on arrival.
    const heading = page.getByTestId('onboarding-heading');
    await expect(heading).toBeFocused();
    await expect(heading).toHaveAccessibleDescription(copy.onboardingReconsentReason);
    const consent = page.getByTestId('consent-step');
    await expect(consent.getByTestId('consent-item-terms')).toBeVisible();
    for (const item of ['privacy', 'age', 'marketing']) {
      await expect(consent.getByTestId(`consent-item-${item}`)).toHaveCount(0);
    }
    await expect(consent.getByText(copy.consentAllHint)).toHaveCount(0);
    // A way to MY 설정, which stays open to the account before it agrees (ADR-0078, 오너 결정
    // 2026-10-22 답 2 — profile.spec.ts follows it).
    await expect(page.getByTestId('onboarding-settings-link')).toContainText(
      copy.onboardingReconsentSettingsHint,
    );
    await expect(
      page.getByRole('link', { name: copy.onboardingReconsentSettingsLink }),
    ).toHaveAttribute('href', '/my/settings');
    await expect(consent.getByTestId('consent-terms').getByRole('checkbox')).not.toBeChecked();
    await page.getByTestId('consent-submit').click();
    await expect(page.getByTestId('consent-required-error')).toBeVisible();
    await page.getByTestId('consent-all').click();
    await page.getByTestId('consent-submit').click();

    // Back where it was going; the marketing opt-in stands as it was.
    await expect(page).toHaveURL('/my/wallet');
    const me = await meOf(page.request);
    expect(me.onboarding).toMatchObject({ consent: true, completed: true, nextStep: null });
    expect(me.onboarding.consents.find((answer) => answer.item === 'marketing')?.agreed).toBe(true);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('단계를 하는 사이 앞 단계가 풀려 돌려보내지면 그 단계의 제목 위에 까닭을 알린다', async ({
    page,
  }) => {
    await atNicknameStep(page);
    // The 본인확인 came undone while the nickname step was open (오너 결정 2026-10-19 (2차) 6): the
    // server refuses the step, and `GET /me` names the 본인확인 again.
    let undone = false;
    await rewriteOnboarding(
      page,
      () => undone,
      (onboarding) => ({
        ...onboarding,
        verification: false,
        completed: false,
        nextStep: 'verification',
      }),
    );
    await page.route('**/api/v1/me/onboarding/nickname', async (route) => {
      undone = true;
      await route.fulfill({
        status: 409,
        json: {
          error: {
            code: 'ONBOARDING_REQUIRED',
            message: 'The consent and the verification come before the nickname',
            details: { steps: ['verification'] },
          },
        },
      });
    });
    await page.getByTestId('nickname-step-submit').click();

    await expect(page.getByTestId('verification-step')).toBeVisible();
    const reason = page.getByTestId('onboarding-return-reason');
    await expect(reason).toHaveText(copy.errOnboardingStepsFirst);
    await expect(reason).toHaveAttribute('role', 'alert');
    await expect(page.getByTestId('onboarding-heading')).toBeFocused();
    await expect(page.getByTestId('onboarding-heading')).toHaveText(
      copy.onboardingStepVerification,
    );

    // Back to the truth: the nickname step, and nothing to explain.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.reload();
    await expect(page.getByTestId('nickname-step')).toBeVisible();
    await expect(page.getByTestId('onboarding-return-reason')).toHaveCount(0);
  });

  test('MY 설정에서 이메일 마케팅 정보 수신을 언제든 켜고 끈다', async ({ page }) => {
    // 오너 결정 2026-10-19 (2차) 4. Declined at the consent step (signUp's).
    await signUp(page, freshEmail());
    await page.goto('/my/settings');
    const card = page.getByTestId('settings-marketing');
    const box = card.getByRole('checkbox', { name: copy.consentMarketing });
    await expect(box).not.toBeChecked();
    await expect(box).toBeEnabled();
    // The text agreed to opens in place: by email only.
    await card.getByTestId('settings-marketing-toggle').click();
    const text = card.getByTestId('settings-marketing-text');
    await expect(text).toContainText('이메일 주소');
    await expect(text).not.toContainText('휴대전화');
    const marketingAnswer = async () =>
      (await meOf(page.request)).onboarding.consents.find((answer) => answer.item === 'marketing');

    // On: recorded, with when.
    await card.getByTestId('settings-marketing-switch').click();
    await expect(page.getByText(copy.marketingConsentOn)).toBeVisible();
    await expect(box).toBeChecked();
    expect((await marketingAnswer())?.agreed).toBe(true);
    await expect(card.getByTestId('settings-marketing-changed-at')).toContainText(
      copy.marketingConsentChangedAt,
    );

    // Off again, and still off after a reload: the server's answer.
    await expect(box).toBeEnabled();
    await card.getByTestId('settings-marketing-switch').click();
    await expect(page.getByText(copy.marketingConsentOff)).toBeVisible();
    expect((await marketingAnswer())?.agreed).toBe(false);
    await page.reload();
    await expect(
      page.getByTestId('settings-marketing').getByRole('checkbox', { name: copy.consentMarketing }),
    ).not.toBeChecked();
  });

  test('비밀번호만 정하면 온보딩으로 가고, 본인확인한 번호는 설정에서 읽기만 하며 실명은 고친다', async ({
    page,
  }) => {
    await openSetPassword(page, freshEmail());
    // No real name or number here: the 본인확인 step is the one place they are given.
    await expect(page.getByTestId('new-password')).toBeVisible();
    await expect(page.getByTestId('verification-real-name')).toHaveCount(0);
    await expect(page.getByTestId('verification-phone')).toHaveCount(0);
    await setFirstPassword(page);

    // Home, and the gate takes the account on to its first step.
    await expect(page).toHaveURL('/onboarding');
    await agreeOnScreen(page);
    const phone = await verifyPhone(page);
    await expect(page.getByTestId('nickname-step')).toBeVisible();
    await page.getByTestId('nickname-step-submit').click();
    await page.getByTestId('notice-next').click();
    await page.getByTestId('interests-skip').click();
    await expect(page).toHaveURL('/');

    // /my/settings shows the record: the number read-only and hyphenated, the name editable.
    await page.goto('/my/settings');
    const card = page.getByTestId('settings-verification');
    const formatted = `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`;
    await expect(card.getByTestId('verification-real-name')).toHaveValue(E2E_REAL_NAME);
    await expect(card.getByTestId('verification-phone')).toHaveValue(formatted);
    await expect(card.getByTestId('verification-phone')).not.toBeEditable();
    await expect(card.getByText(copy.verifiedPhoneHint)).toBeVisible();
    await expect(card.getByTestId('verification-real-name-save')).toBeDisabled();

    // The real name keeps the shared rule, and saves trimmed.
    await card.getByTestId('verification-real-name').fill('홍길동1');
    await card.getByTestId('verification-real-name-save').click();
    await expect(card.getByText(copy.errRealNameFormat, { exact: true })).toBeVisible();
    await card.getByTestId('verification-real-name').fill(' 김 철수 ');
    await card.getByTestId('verification-real-name-save').click();
    await expect(page.getByText(copy.realNameSaved)).toBeVisible();
    await expect(card.getByTestId('verification-real-name')).toHaveValue('김 철수');
  });

  test('게이트에 묶인 계정은 /set-password와 /onboarding에서 로그아웃할 수 있다', async ({
    page,
  }) => {
    // 로그아웃 is in MY, which the gate keeps such an account out of, and the header has no
    // profile menu (owner decision 2026-10-13, #16). Both land where MY's 로그아웃 does.
    await openSetPassword(page, freshEmail());
    await page.getByTestId('set-password-logout').click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('link', { name: copy.login })).toBeVisible();
    await page.goto('/set-password');
    await page.waitForURL(/\/login\?/);

    await openSetPassword(page, freshEmail());
    await page.goto('/my');
    await expect(page).toHaveURL('/onboarding?next=%2Fmy');
    await expect(page.getByTestId('consent-step')).toBeVisible();
    await page.getByTestId('onboarding-logout').click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('link', { name: copy.login })).toBeVisible();
    await page.goto('/onboarding');
    await page.waitForURL(/\/login\?/);
  });

  test('프로필을 불러오지 못한 /onboarding에도 로그아웃이 있다', async ({ page }) => {
    await openSetPassword(page, freshEmail());
    // `GET /me` failing is the rung with no step; the gate cannot say "steps left" either, so
    // the screen is opened directly.
    await page.route('**/api/v1/me', (route) => route.abort());
    await page.goto('/onboarding');
    await expect(page.getByTestId('onboarding-unavailable')).toBeVisible();
    await page.getByTestId('onboarding-logout').click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('link', { name: copy.login })).toBeVisible();
  });

  test('로그인하지 않은 방문자의 /onboarding은 로그인 화면으로, next를 그대로 싣고 간다', async ({
    page,
  }) => {
    await page.goto('/onboarding?next=%2Fmy%2Fwallet');
    // Compared decoded: how much of a server redirect's query string stays percent-encoded is
    // the framework's business (auth.spec.ts accepts both spellings for the same reason).
    await page.waitForURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get('next')).toBe('/onboarding?next=%2Fmy%2Fwallet');
  });
});
