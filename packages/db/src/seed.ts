// CLI entry: `pnpm db:seed` (tsx src/seed.ts). Idempotent: safe to re-run on every deploy, and
// safe to run twice at once — every step that checks before it inserts holds the `buddha:seed`
// advisory lock for its transaction, so a second seed waits and then finds the rows in place.
//
// Runs as the runtime role (DATABASE_URL = buddha_app): 01-roles.sql grants it DML on every
// table created by migrations, which is all the seed needs.
import { randomUUID } from 'node:crypto';
import {
  initState,
  maxLossP,
  nicknameSchema,
  priceOf,
  probabilityBp,
  serializeQuantity,
  type CategorySlug,
} from '@buddha/shared';
import { hashPassword } from 'better-auth/crypto';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, createDb, type Db } from './client.js';
import { loadRootEnv } from './env.js';
import { clockTimestamp } from './tx-helpers.js';
import {
  account,
  adminActions,
  balances,
  categories,
  chargePackages,
  marketEvents,
  markets,
  priceTicks,
  profiles,
  user,
} from './schema/index.js';

/** PLAN 1.3 categories. Sports and elections are forbidden (PLAN 0.2): never add them. */
const CATEGORIES: readonly { slug: CategorySlug; nameKo: string; sortOrder: number }[] = [
  { slug: 'economy', nameKo: '경제', sortOrder: 10 },
  { slug: 'culture', nameKo: '문화', sortOrder: 20 },
  { slug: 'entertainment', nameKo: '엔터테인먼트', sortOrder: 30 },
  { slug: 'tech', nameKo: '테크', sortOrder: 40 },
  { slug: 'weather', nameKo: '날씨', sortOrder: 50 },
];

/**
 * better-auth 1.7 stores a synthetic issuer on every account row and looks credential
 * accounts up by (issuer, accountId): `createLocalAccountIssuer('credential')`.
 */
const CREDENTIAL_ISSUER = 'local:credential';
const CREDENTIAL_PROVIDER = 'credential';
const ADMIN_NICKNAME = '관리자';

async function seedCategories(db: Db): Promise<void> {
  await db
    .insert(categories)
    .values(CATEGORIES.map((category) => ({ ...category })))
    .onConflictDoUpdate({
      target: categories.slug,
      // is_active is an admin knob: re-seeding must not re-activate a disabled category.
      set: { nameKo: sql`excluded.name_ko`, sortOrder: sql`excluded.sort_order` },
    });
  console.log(`[db:seed] categories: ${String(CATEGORIES.length)} upserted`);
}

/**
 * Starting charge packages (owner decision 2026-09-04): 4,900원 for 5,000P, and the discount
 * grows with the size of the package. Admins edit these at runtime, so the seed only fills a
 * table no admin has ever managed and never overwrites what an admin has changed — which also
 * means that once a developer has touched packages through the admin screen, `db:seed` will
 * not put the default ladder back (buddha_app cannot delete the admin_actions trace, migration
 * 0001): recreate them in the admin screen, truncate admin_actions as buddha_migrate, or start
 * from an empty database (`docker compose down -v`).
 */
const CHARGE_PACKAGES = [
  { amountP: 5_000n, priceKrw: 4_900, sortOrder: 10 }, // 2%
  { amountP: 10_000n, priceKrw: 9_700, sortOrder: 20 }, // 3%
  { amountP: 30_000n, priceKrw: 28_500, sortOrder: 30 }, // 5%
  { amountP: 50_000n, priceKrw: 46_500, sortOrder: 40 }, // 7%
  { amountP: 100_000n, priceKrw: 90_000, sortOrder: 50 }, // 10%
] as const;

/**
 * Serialises the steps that check before they insert. `charge_packages` has no natural key, so
 * two seeds racing on an empty table would both pass the existence check and both insert — a
 * doubled catalogue — and two admin inserts would end in a unique violation instead of a
 * no-op. Transaction-scoped: released at commit, or on any error, whichever comes first.
 */
const SEED_LOCK_KEY = 'buddha:seed';
async function lockSeed(tx: Pick<Db, 'execute'>): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${SEED_LOCK_KEY}))`);
}

/**
 * The database clock, read AFTER `lockSeed` — the instant rule every market write follows
 * (ADR-0027; `clockTimestamp` in tx-helpers.ts, which the API and the worker share since M5).
 * The seed runner and Postgres are two machines: a Windows host and a Docker VM, most
 * obviously. A runner that is ahead writes an `open_at` in the future and an open tick that
 * sorts AFTER the first trades' ticks, so `/markets/:id/ticks` draws the initial probability as
 * a reset partway along the chart; a runner that is behind writes `open_at` earlier than the
 * same row's `created_at`.
 */
async function dbNow(tx: Pick<Db, 'execute'>): Promise<Date> {
  try {
    return await clockTimestamp(tx);
  } catch (error) {
    throw new Error('[db:seed] clock_timestamp() returned no value', { cause: error });
  }
}

async function seedChargePackages(db: Db): Promise<void> {
  const outcome = await db.transaction(async (tx) => {
    await lockSeed(tx);
    const [existing] = await tx.select({ id: chargePackages.id }).from(chargePackages).limit(1);
    if (existing) return 'configured';
    // An empty table is not proof of a fresh database: deletion is a real DELETE (A-M2-8), so
    // an admin who took every package off sale on purpose leaves it empty too, and the next
    // deploy's seed must not reopen sales at the default prices. Every admin create, update
    // and delete writes an `admin_actions` row (charge_package_*), which is the durable trace
    // the seed reads: once an admin has managed the catalogue, it is theirs, empty or not.
    const [managed] = await tx
      .select({ id: adminActions.id })
      .from(adminActions)
      .where(eq(adminActions.targetType, 'charge_package'))
      .limit(1);
    if (managed) return 'managed';
    await tx.insert(chargePackages).values(CHARGE_PACKAGES.map((row) => ({ ...row })));
    return 'inserted';
  });
  console.log(
    outcome === 'inserted'
      ? `[db:seed] charge packages: ${String(CHARGE_PACKAGES.length)} inserted`
      : outcome === 'managed'
        ? '[db:seed] charge packages: emptied by an admin, left untouched'
        : '[db:seed] charge packages: already configured, left untouched',
  );
}

interface AdminInput {
  email: string;
  password: string;
}

/** '관리자', then '관리자2', '관리자3', ... when another user already owns the nickname. */
async function pickNickname(tx: Pick<Db, 'select'>, ownUserId: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = attempt === 0 ? ADMIN_NICKNAME : `${ADMIN_NICKNAME}${String(attempt + 1)}`;
    if (!nicknameSchema.safeParse(candidate).success) continue;
    const [taken] = await tx
      .select({ userId: profiles.userId })
      .from(profiles)
      .where(eq(profiles.nickname, candidate));
    if (!taken || taken.userId === ownUserId) return candidate;
  }
  throw new Error('[db:seed] could not find a free admin nickname');
}

/**
 * Creates the first admin (PLAN 10.5) the way better-auth's email sign-up does: a `user`
 * row plus a credential `account` row (providerId 'credential', accountId = user id, scrypt
 * hash from better-auth/crypto). The "user" AFTER INSERT trigger (migrations 0002 and 0004)
 * creates the profile (auto nickname) and the balance, sign-up bonus included: the operator
 * account starts with SIGNUP_BONUS_P like every account (Q-M2-2). The seed then renames the
 * profile to 관리자 and promotes it.
 *
 * Re-running never resets an existing password; it only guarantees that the user exists, is
 * verified, has a credential account and has role 'admin'. Returns the admin's user id, the
 * `created_by` / actor of the seed markets.
 */
async function seedAdmin(db: Db, input: AdminInput): Promise<string> {
  // better-auth lower-cases the email on sign-up and sign-in; match it here.
  const email = input.email.trim().toLowerCase();
  if (input.password.length < 8 || input.password.length > 128) {
    throw new Error(
      '[db:seed] SEED_ADMIN_PASSWORD must be 8-128 characters (better-auth defaults)',
    );
  }

  return db.transaction(async (tx) => {
    await lockSeed(tx);
    const now = new Date();
    let created = false;

    let [existing] = await tx
      .select({ id: user.id, emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.email, email));
    if (!existing) {
      const id = randomUUID();
      await tx.insert(user).values({
        id,
        name: ADMIN_NICKNAME,
        email,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      existing = { id, emailVerified: true };
      created = true;
    }
    const userId = existing.id;
    // The address may already exist unverified: ADR-0024 lets anyone register it (a user row
    // with no password) before a deploy runs the seed. Adding the credential below would then
    // produce an admin that `requireEmailVerification` answers with 403 EMAIL_NOT_VERIFIED, so
    // verify it here as the fresh branch does — the operator owns SEED_ADMIN_EMAIL.
    const verifiedNow = !created && !existing.emailVerified;
    if (verifiedNow) {
      await tx.update(user).set({ emailVerified: true, updatedAt: now }).where(eq(user.id, userId));
    }

    const [credential] = await tx
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, CREDENTIAL_PROVIDER)));
    if (!credential) {
      await tx.insert(account).values({
        id: randomUUID(),
        issuer: CREDENTIAL_ISSUER,
        accountId: userId,
        providerId: CREDENTIAL_PROVIDER,
        userId,
        password: await hashPassword(input.password),
        createdAt: now,
        updatedAt: now,
      });
    }

    const [profile] = await tx
      .select({ role: profiles.role, nickname: profiles.nickname })
      .from(profiles)
      .where(eq(profiles.userId, userId));
    if (!profile) {
      throw new Error('[db:seed] the "user" trigger did not create a profile (run db:migrate)');
    }
    if (created) {
      // Fresh admin: replace the trigger's auto nickname and promote in one statement.
      const nickname = await pickNickname(tx, userId);
      await tx
        .update(profiles)
        .set({ nickname, role: 'admin', updatedAt: now })
        .where(eq(profiles.userId, userId));
    } else if (profile.role !== 'admin') {
      await tx
        .update(profiles)
        .set({ role: 'admin', updatedAt: now })
        .where(eq(profiles.userId, userId));
    }

    // The trigger created the balance, sign-up bonus included (migration 0004) — like every
    // account. Never touched: balances change only together with a ledger entry (PLAN 0.2),
    // and a missing row is a broken account for the ledger audit to report, not something
    // the seed papers over with a silent 0.
    const [balance] = await tx
      .select({ userId: balances.userId })
      .from(balances)
      .where(eq(balances.userId, userId));
    if (!balance) {
      throw new Error('[db:seed] the "user" trigger did not create a balance (run db:migrate)');
    }

    console.log(
      `[db:seed] admin ${email}: ${created ? 'created' : 'already exists'}` +
        ` (role=admin, credential ${credential ? 'kept' : 'created'}${verifiedNow ? ', verified' : ''})`,
    );
    return userId;
  });
}

interface SeedMarket {
  category: CategorySlug;
  slug: string;
  title: string;
  description: string;
  rules: string;
  resolutionSource: string;
  /** Initial YES probability in basis points. */
  initialProbBp: number;
  /** LMSR liquidity parameter b. */
  liquidityB: number;
  /**
   * `close_at` as an ISO-8601 instant (UTC; the KST wall-clock time is in the entry's comment).
   * Absolute, never relative to the seed time: each rule names an absolute cutoff, and trading
   * has to stop before the outcome is public, so a first seed that runs late must not open a
   * market past its own event (the slug is the idempotency key, so only the first seed counts).
   */
  closeAt: string;
}

/**
 * PLAN 13 M3: 12 open markets, 2-3 per category, in the shape of Appendix B — every one with
 * rules that state the criterion, its boundary and the "no announcement → 아니오" clause, plus
 * a resolution source. Never sports or elections (PLAN 0.2). The slug is the idempotency key
 * of the seed: a market whose slug exists is left exactly as it is, copy included — an admin
 * may have edited it, and the seed never overwrites (Q-M3: copy refresh cadence).
 */
const SEED_MARKETS: readonly SeedMarket[] = [
  {
    category: 'economy',
    slug: 'bok-october-rate-cut-2026',
    title: '10월 한국은행 금융통화위원회에서 기준금리가 인하될까?',
    description: '한국은행 금융통화위원회의 10월 통화정책방향 결정회의 결과를 예측합니다.',
    rules:
      "2026년 10월 정례 통화정책방향 결정회의에서 한국은행 기준금리가 직전 결정 대비 인하되면 '예'로 정산합니다. 동결이나 인상은 '아니오'입니다. 10월 중 결정회의가 열리지 않거나 2026년 10월 31일(KST)까지 결과가 발표되지 않으면 '아니오'로 정산합니다.",
    resolutionSource: '한국은행 보도자료(통화정책방향) https://www.bok.or.kr',
    initialProbBp: 3500,
    liquidityB: 1000,
    // 2026-10-21 23:59:59 KST: the October MPC meeting is on 2026-10-22 (BOK 2026 schedule).
    closeAt: '2026-10-21T14:59:59Z',
  },
  {
    category: 'economy',
    slug: 'cpi-september-2026-above-2pct',
    title: '9월 소비자물가 상승률(전년 동월 대비)이 2.0% 이상으로 발표될까?',
    description: '통계청이 발표하는 2026년 9월 소비자물가 동향을 예측합니다.',
    rules:
      "통계청 '2026년 9월 소비자물가동향'의 소비자물가지수 전년동월비 상승률이 2.0% 이상이면 '예'로 정산합니다. 1.9% 이하는 '아니오'입니다. 2026년 10월 31일(KST)까지 공식 발표가 없으면 '아니오'로 정산합니다. 이후 정정치는 반영하지 않습니다.",
    resolutionSource: '통계청 소비자물가동향 보도자료 https://kostat.go.kr',
    initialProbBp: 5500,
    liquidityB: 800,
    // 2026-09-30 23:59:59 KST: the September CPI release lands in the first days of October.
    closeAt: '2026-09-30T14:59:59Z',
  },
  {
    category: 'economy',
    slug: 'krw-usd-yearend-2026-above-1400',
    title: '올해 마지막 거래일 원/달러 환율 종가가 1,400원 이상일까?',
    description: '2026년 서울외환시장 마지막 거래일의 원/달러 환율 종가를 예측합니다.',
    rules:
      "2026년 서울외환시장 마지막 거래일 원/달러 환율 종가(15:30 기준 종가, 매매기준율 아님)가 1,400.0원 이상이면 '예'로 정산합니다. 1,399.9원 이하는 '아니오'입니다. 종가가 확인되지 않으면 서울외국환중개 고시 종가로 판정하고, 그마저 없으면 '아니오'로 정산합니다.",
    resolutionSource: '서울외국환중개 환율 고시 https://www.smbs.biz',
    initialProbBp: 5000,
    liquidityB: 1500,
    // 2026-12-29 23:59:59 KST: 2026-12-31 is the year-end market holiday, so the last trading
    // day is 2026-12-30 and trading here stops before it opens.
    closeAt: '2026-12-29T14:59:59Z',
  },
  {
    category: 'weather',
    slug: 'seoul-first-snow-before-nov-20-2026',
    title: '서울의 올해 첫눈이 11월 20일 이전에 관측될까?',
    description: '기상청 서울 관측소 기준 올해 첫눈 관측일을 예측합니다.',
    rules:
      "기상청이 발표하는 2026년 서울(종로구 송월동 관측소) 첫눈 관측일이 11월 19일 이전(19일 포함)이면 '예'로 정산합니다. 11월 20일 0시(KST)까지 첫눈 관측 발표가 없으면 '아니오'로 정산합니다. 진눈깨비도 기상청이 첫눈으로 발표하면 인정합니다.",
    resolutionSource: '기상청 보도자료·기상자료개방포털 https://data.kma.go.kr',
    initialProbBp: 3000,
    liquidityB: 1000,
    // 2026-11-20 00:00 KST: the rule's own cutoff.
    closeAt: '2026-11-19T15:00:00Z',
  },
  {
    category: 'weather',
    slug: 'seoul-october-2026-rain-above-50mm',
    title: '10월 서울 월 강수량이 50mm를 넘을까?',
    description: '기상청 서울 관측소의 2026년 10월 월 강수량을 예측합니다.',
    rules:
      "기상자료개방포털의 서울(108) 관측소 2026년 10월 월합계 강수량이 50.0mm를 초과하면 '예'로 정산합니다. 정확히 50.0mm 이하는 '아니오'입니다. 11월 15일까지 월자료가 공개되지 않으면 일자료 합계로 판정하고, 그마저 없으면 '아니오'로 정산합니다.",
    resolutionSource: '기상자료개방포털 월자료 https://data.kma.go.kr',
    initialProbBp: 6000,
    liquidityB: 800,
    // 2026-10-31 23:59:59 KST: end of the month being measured.
    closeAt: '2026-10-31T14:59:59Z',
  },
  {
    category: 'weather',
    slug: 'seoul-november-2026-below-minus-5',
    title: '11월 중 서울 일 최저기온이 영하 5도 이하로 내려가는 날이 있을까?',
    description: '2026년 11월 서울의 일 최저기온을 예측합니다.',
    rules:
      "기상자료개방포털의 서울(108) 관측소 2026년 11월 1일~30일 일 최저기온 중 영하 5.0℃ 이하인 날이 하루라도 있으면 '예'로 정산합니다. 모든 날이 영하 4.9℃ 이상이면 '아니오'입니다. 자료가 공개되지 않으면 '아니오'로 정산합니다.",
    resolutionSource: '기상자료개방포털 일자료 https://data.kma.go.kr',
    initialProbBp: 4500,
    liquidityB: 1000,
    // 2026-11-30 23:59:59 KST: end of the month being measured.
    closeAt: '2026-11-30T14:59:59Z',
  },
  {
    category: 'tech',
    slug: 'korea-telco-6g-trial-2026',
    title: '연내 국내 통신 3사 중 한 곳이라도 6G 시범 서비스 개시를 공식 발표할까?',
    description: '국내 통신 3사의 6G 시범 서비스 발표 여부를 예측합니다.',
    rules:
      "2026년 12월 31일(KST)까지 SK텔레콤·KT·LG유플러스 중 한 곳이라도 자사 공식 뉴스룸 또는 보도자료로 일반 이용자 대상 '6G 시범 서비스' 개시를 발표하면 '예'로 정산합니다. 기술 시연, 연구 성과 발표, 표준화 참여 발표는 제외합니다. 발표가 없으면 '아니오'로 정산합니다.",
    resolutionSource: '각사 공식 뉴스룸(SK텔레콤·KT·LG유플러스)',
    initialProbBp: 2000,
    liquidityB: 800,
    // 2026-12-31 23:59:59 KST: the rule's own cutoff.
    closeAt: '2026-12-31T14:59:59Z',
  },
  {
    category: 'tech',
    slug: 'samsung-trifold-korea-launch-2026',
    title: '삼성전자가 연내 국내에 3단 접이식(트라이폴드) 스마트폰을 정식 출시할까?',
    description: '삼성전자의 3단 접이식 스마트폰 국내 정식 출시 여부를 예측합니다.',
    rules:
      "2026년 12월 31일(KST)까지 삼성전자 뉴스룸이 3단 접이식(트라이폴드) 스마트폰의 국내 정식 판매 개시를 발표하면 '예'로 정산합니다. 사전 예약 개시, 해외 출시, 콘셉트 공개만으로는 '아니오'입니다. 발표가 없으면 '아니오'로 정산합니다.",
    resolutionSource: '삼성전자 뉴스룸 https://news.samsung.com/kr',
    initialProbBp: 4000,
    liquidityB: 1000,
    // 2026-12-31 23:59:59 KST: the rule's own cutoff.
    closeAt: '2026-12-31T14:59:59Z',
  },
  {
    category: 'entertainment',
    slug: 'november-2026-korean-film-3m-in-2-weeks',
    title: '11월 개봉 한국 영화 중 개봉 2주 안에 누적 관객 300만을 넘는 작품이 나올까?',
    description: '2026년 11월 개봉 한국 영화의 초반 흥행을 예측합니다.',
    rules:
      "영화진흥위원회 통합전산망(KOBIS) 기준으로 2026년 11월 1일~30일에 국내 개봉한 한국 영화 중 개봉일을 포함한 14일 안에 누적 관객 300만 명 이상을 기록한 작품이 하나라도 있으면 '예'로 정산합니다. 해당 작품이 없으면 '아니오'입니다. 재개봉작은 제외합니다.",
    resolutionSource: '영화진흥위원회 통합전산망 https://www.kobis.or.kr',
    initialProbBp: 3500,
    liquidityB: 1000,
    // 2026-12-13 23:59:59 KST: day 14 of a film released on 2026-11-30, the last window.
    closeAt: '2026-12-13T14:59:59Z',
  },
  {
    category: 'entertainment',
    slug: 'melon-last-week-2026-domestic-no1',
    title: '12월 마지막 주 멜론 주간 차트 1위가 국내 아티스트의 곡일까?',
    description: '2026년 마지막 멜론 주간 차트 1위 곡을 예측합니다.',
    rules:
      "2026년 12월에 시작해 12월 안에 끝나는 마지막 멜론 주간 차트(월요일~일요일)에서 1위 곡의 아티스트가 국내 소속사 아티스트이면 '예'로 정산합니다. 국내외 아티스트 합작곡은 대표 아티스트 기준으로 판정합니다. 차트가 발표되지 않으면 '아니오'로 정산합니다.",
    resolutionSource: '멜론 차트 https://www.melon.com/chart',
    initialProbBp: 8000,
    liquidityB: 800,
    // 2026-12-27 23:59:59 KST: the last Mon-Sun chart week inside December is 12-21..12-27.
    closeAt: '2026-12-27T14:59:59Z',
  },
  {
    category: 'culture',
    slug: 'national-museum-2026-visitors-above-4m',
    title: '국립중앙박물관의 2026년 연간 관람객이 400만 명을 넘을까?',
    description: '국립중앙박물관의 2026년 연간 관람객 수를 예측합니다.',
    rules:
      "국립중앙박물관이 공식 발표하는 2026년 연간 관람객 수(본관 기준, 특별전 포함)가 400만 명을 초과하면 '예'로 정산합니다. 2027년 1월 31일까지 공식 발표가 없으면 '아니오'로 정산합니다.",
    resolutionSource: '국립중앙박물관 보도자료 https://www.museum.go.kr',
    initialProbBp: 5000,
    liquidityB: 1000,
    // 2026-12-31 23:59:59 KST: end of the year being counted; the announcement comes later.
    closeAt: '2026-12-31T14:59:59Z',
  },
  {
    category: 'culture',
    slug: 'korea-new-books-2026-more-than-2025',
    title: '2026년 국내 신간 발행 종수가 2025년보다 많을까?',
    description: '2026년 국내 출판 신간 발행 종수를 예측합니다.',
    rules:
      "대한출판문화협회가 발표하는 2026년 신간 발행 종수(납본 기준)가 같은 기준의 2025년 종수보다 많으면 '예'로 정산합니다. 같거나 적으면 '아니오'입니다. 2027년 3월 31일까지 발표가 없으면 '아니오'로 정산합니다.",
    resolutionSource: '대한출판문화협회 출판통계 https://www.kpa21.or.kr',
    initialProbBp: 4500,
    liquidityB: 800,
    // 2026-12-31 23:59:59 KST: end of the year being counted; the announcement comes later.
    closeAt: '2026-12-31T14:59:59Z',
  },
];

/**
 * How close a seeded market's cutoff may come before `db:seed` starts asking for fresh copy.
 * Two weeks: long enough that a warning is actionable (new copy needs an owner decision on the
 * subject, Q-M3-4), short enough that it is not shouting for most of the fixture's life.
 */
const SEED_CLOSE_SOON_DAYS = 14;
const SEED_CLOSE_SOON_MS = SEED_CLOSE_SOON_DAYS * 24 * 60 * 60 * 1_000;

/**
 * Inserts the seed markets, one transaction per market under the seed lock, exactly as the
 * admin create + open path writes them (M3 design 3.4): the market row, its 'open' price tick
 * and the 'created' / 'opened' events, all in one commit so a crash never leaves a market
 * without its history. A market whose slug exists is skipped, never updated. Runs after
 * `seedAdmin`: the admin is `created_by` and the actor of both events.
 *
 * One deliberate divergence from that path: `close_at` is an absolute instant (ADR-0027), and
 * `assertFutureCloseAt` refuses a past one on both admin routes while this writes it anyway,
 * open, so a late-run seed still gets its 12 markets. Such a market refuses every trade until
 * someone closes it; the loop below says so on every run.
 */
async function seedMarkets(db: Db, adminId: string): Promise<void> {
  const categoryRows = await db
    .select({ id: categories.id, slug: categories.slug })
    .from(categories);
  const categoryIds = new Map(categoryRows.map((row) => [row.slug, row.id]));

  // One read for the staleness report below. The rows' own instants still come from each
  // transaction's post-lock read (A-M3-30); this one only decides what to warn about, and a
  // re-run that inserts nothing spends this single round trip rather than one per market.
  const reportedAt = await dbNow(db);

  let inserted = 0;
  for (const seed of SEED_MARKETS) {
    // `seedCategories` ran first; a missing slug means the category list and the market list
    // disagree, which is a bug in this file, not a state to seed around.
    const categoryId = categoryIds.get(seed.category);
    if (categoryId === undefined) {
      throw new Error(`[db:seed] market ${seed.slug}: category "${seed.category}" is not seeded`);
    }
    const closeAt = new Date(seed.closeAt);
    if (Number.isNaN(closeAt.getTime())) {
      throw new Error(`[db:seed] market ${seed.slug}: closeAt "${seed.closeAt}" is not a date`);
    }
    const outcome = await db.transaction(async (tx) => {
      await lockSeed(tx);
      const [existing] = await tx
        .select({ id: markets.id, closeAt: markets.closeAt })
        .from(markets)
        .where(eq(markets.slug, seed.slug));
      // Left exactly as it is, status included: a re-seed never rewrites a market an admin
      // has been working with. Its close time is read back so the report below judges the
      // row that exists, not the literal in this file.
      if (existing) return { inserted: false, closeAt: existing.closeAt };

      // After the slug check, not before it: a re-run that inserts nothing then spends no
      // round trip on a clock it will not use.
      const now = await dbNow(tx);
      const p0 = seed.initialProbBp / 10_000;
      const state = initState(p0, seed.liquidityB);
      const [market] = await tx
        .insert(markets)
        .values({
          slug: seed.slug,
          title: seed.title,
          description: seed.description,
          rules: seed.rules,
          resolutionSource: seed.resolutionSource,
          categoryId,
          mechanism: 'lmsr',
          status: 'open',
          liquidityB: seed.liquidityB.toFixed(6),
          qYes: serializeQuantity(state.qYes),
          qNo: serializeQuantity(state.qNo),
          initialProbBp: seed.initialProbBp,
          reserveP: maxLossP(p0, seed.liquidityB),
          lastPrice: priceOf(state),
          openAt: now,
          closeAt,
          createdBy: adminId,
        })
        .returning({ id: markets.id });
      if (!market) throw new Error(`[db:seed] market ${seed.slug}: insert returned no row`);
      await tx.insert(priceTicks).values({
        marketId: market.id,
        ts: now,
        pYesBp: probabilityBp(state),
        trigger: 'open',
      });
      // Two statements, so the bigserial ids keep 'created' before 'opened'.
      const payload = { source: 'seed' };
      await tx
        .insert(marketEvents)
        .values({ marketId: market.id, type: 'created', actorId: adminId, payload });
      const [opened] = await tx
        .insert(marketEvents)
        .values({ marketId: market.id, type: 'opened', actorId: adminId, payload })
        .returning({ id: marketEvents.id });
      // The status key every transition writes (M5): the 'opened' event is what put the row in
      // `open`, so a `market:status` a client compares this row against orders after it.
      await tx
        .update(markets)
        .set({ statusEventId: opened?.id ?? null })
        .where(eq(markets.id, market.id));
      return { inserted: true, closeAt };
    });
    if (outcome.inserted) inserted++;
    console.log(
      `[db:seed] market ${seed.slug}: ${outcome.inserted ? 'created' : 'already exists'}`,
    );
    // Every run, not only the one that inserts: the cutoffs are absolute, so an environment
    // seeded before one passes reaches the same state without the seed doing anything — and
    // that is the larger half. Against the row's own close time, so an admin who pushed it
    // forward (the copy refresh Q-M3-4 describes) is not nagged about a market they fixed.
    const remainingMs = outcome.closeAt.getTime() - reportedAt.getTime();
    if (remainingMs <= 0) {
      // Seeded as written rather than skipped: skipping would make the fixture's size a
      // function of the calendar (every cutoff is in 2026, so a fresh seed would insert
      // nothing at all from 2027). Such a market refuses every quote and trade with
      // MARKET_CLOSED until the worker's per-minute `market.close` scan closes it (PLAN 5.5,
      // M5) — or an admin does from 관리자 → 시장 상세 → 마감. The real fix is fresh copy
      // (Q-M3-4), under a new slug.
      console.warn(
        `[db:seed] market ${seed.slug}: closeAt ${seed.closeAt} is already past — the worker's market.close scan will close it within a minute (or 관리자 → 시장 상세 → 마감); refresh the seed copy`,
      );
    } else if (remainingMs <= SEED_CLOSE_SOON_MS) {
      // The M6 half of the same mechanism. The warning above only fires once the fixture is
      // already broken — a developer who clones the repo that week gets a home page of closed
      // markets and no idea it was foreseeable. This one fires while it can still be acted on,
      // and it is the same signal at a different distance, so refreshing the copy silences both.
      console.warn(
        `[db:seed] market ${seed.slug}: closeAt ${seed.closeAt} is within ${String(
          SEED_CLOSE_SOON_DAYS,
        )} days — refresh the seed copy (Q-M3-4) before the fixture expires`,
      );
    }
  }
  console.log(
    `[db:seed] markets: ${String(inserted)} inserted, ${String(SEED_MARKETS.length - inserted)} already existed`,
  );
}

loadRootEnv();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[db:seed] DATABASE_URL is not set (copy .env.example to .env)');
  process.exit(1);
}
const adminEmail = process.env.SEED_ADMIN_EMAIL;
const adminPassword = process.env.SEED_ADMIN_PASSWORD;

const db = createDb(url, { max: 1, applicationName: 'buddha-seed' });
try {
  await seedCategories(db);
  await seedChargePackages(db);
  if (adminEmail && adminPassword) {
    const adminId = await seedAdmin(db, { email: adminEmail, password: adminPassword });
    await seedMarkets(db, adminId);
  } else {
    console.log('[db:seed] SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set: admin skipped');
    console.log('[db:seed] markets skipped (no admin)');
  }
} finally {
  await closeDb(db);
}
