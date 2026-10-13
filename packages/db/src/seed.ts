// CLI entry: `pnpm db:seed` (tsx src/seed.ts). Idempotent: safe to re-run on every deploy, and
// safe to run twice at once — every step that checks before it inserts holds the `buddha:seed`
// advisory lock for its transaction, so a second seed waits and then finds the rows in place.
//
// Runs as the runtime role (DATABASE_URL = buddha_app): 01-roles.sql grants it DML on every
// table created by migrations, which is all the seed needs.
import { randomUUID } from 'node:crypto';
import {
  nicknameSchema,
  SEED_ADMIN_GRANT_REASON,
  type CategorySlug,
  SUBCATEGORY_SLUGS,
  type SubcategorySlug,
} from '@buddha/shared';
import { hashPassword } from 'better-auth/crypto';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, createDb, type Db } from './client.js';
import { loadRootEnv } from './env.js';
import { SEED_MARKETS } from './seed-markets.js';
import { clockTimestamp, lockAdminRoles } from './tx-helpers.js';
import {
  account,
  adminActions,
  balances,
  categories,
  chargePackages,
  marketEvents,
  markets,
  profiles,
  user,
} from './schema/index.js';

/** PLAN 1.3 top-level categories. Sports and elections are forbidden (PLAN 0.2): never add them. */
const CATEGORIES: readonly { slug: CategorySlug; nameKo: string; sortOrder: number }[] = [
  { slug: 'economy', nameKo: '경제', sortOrder: 10 },
  { slug: 'culture', nameKo: '문화', sortOrder: 20 },
  { slug: 'entertainment', nameKo: '엔터테인먼트', sortOrder: 30 },
  { slug: 'tech', nameKo: '테크', sortOrder: 40 },
  { slug: 'weather', nameKo: '날씨', sortOrder: 50 },
];

/**
 * The second level, one Korean name per slug in `SUBCATEGORY_SLUGS` (shared enums.ts, which is
 * also where the two-level rule is written down). `satisfies` over every leaf slug: a slug added
 * to the shared list without a name here fails to compile rather than seeding a nameless row.
 * Display order within a parent is the order of the shared tuple, spaced by ten like the
 * parents so an admin can slot one between two later.
 */
const SUBCATEGORY_NAMES = {
  housing: '주택',
  jobs: '일자리',
  fx: '환율',
  rates: '금리',
  prices: '물가',
  books: '출판',
  exhibitions: '전시',
  performances: '공연',
  food: '음식',
  movies: '영화',
  music: '음악',
  tv: '방송',
  games: '게임',
  ai: 'AI',
  devices: '기기·통신',
  semiconductors: '반도체',
  space: '우주',
  temperature: '기온',
  rain: '강수',
  typhoons: '태풍',
  'air-quality': '대기질',
} as const satisfies Record<SubcategorySlug, string>;

/**
 * better-auth 1.7 stores a synthetic issuer on every account row and looks credential
 * accounts up by (issuer, accountId): `createLocalAccountIssuer('credential')`.
 */
const CREDENTIAL_ISSUER = 'local:credential';
const CREDENTIAL_PROVIDER = 'credential';
const ADMIN_NICKNAME = '관리자';

async function seedCategories(db: Db): Promise<void> {
  // Parents first, then the leaves under them: a leaf's `parent_id` is the id the first
  // statement produced (or already held — the upsert returns the surviving row either way).
  const parents = await db
    .insert(categories)
    .values(CATEGORIES.map((category) => ({ ...category, parentId: null })))
    .onConflictDoUpdate({
      target: categories.slug,
      // is_active is an admin knob: re-seeding must not re-activate a disabled category. The
      // parent is rewritten to NULL on purpose: a slug in CATEGORIES is top-level by definition.
      set: { nameKo: sql`excluded.name_ko`, sortOrder: sql`excluded.sort_order`, parentId: null },
    })
    .returning({ id: categories.id, slug: categories.slug });
  const parentIds = new Map(parents.map((row) => [row.slug, row.id]));

  const leaves = CATEGORIES.flatMap((parent) => {
    const parentId = parentIds.get(parent.slug);
    if (parentId === undefined) {
      throw new Error(`[db:seed] category ${parent.slug}: upsert returned no row`);
    }
    return SUBCATEGORY_SLUGS[parent.slug].map((slug, index) => ({
      slug,
      nameKo: SUBCATEGORY_NAMES[slug],
      sortOrder: (index + 1) * 10,
      parentId,
    }));
  });
  await db
    .insert(categories)
    .values(leaves)
    .onConflictDoUpdate({
      target: categories.slug,
      set: {
        nameKo: sql`excluded.name_ko`,
        sortOrder: sql`excluded.sort_order`,
        parentId: sql`excluded.parent_id`,
      },
    });
  console.log(
    `[db:seed] categories: ${String(CATEGORIES.length)} top-level + ${String(leaves.length)} sub-categories upserted`,
  );
}

/**
 * Starting charge packages (owner decision 2026-09-04): 4,900원 for 5,000 Coin, and the discount
 * grows with the size of the package. Inserted off sale (`is_active = false`): paid charging is
 * not offered at launch (D9, #112), so the ladder waits for an admin to put a package on sale.
 *
 * Admins edit these at runtime, so the seed only fills a table no admin has ever managed and
 * never overwrites what an admin has changed — which also means that once a developer has
 * touched packages through the admin screen, `db:seed` will not put the default ladder back
 * (buddha_app cannot delete the admin_actions trace, migration 0001): recreate them in the
 * admin screen, truncate admin_actions as buddha_migrate, or start from an empty database
 * (`docker compose down -v`).
 */
const CHARGE_PACKAGES = [
  { amountCoin: 5_000n, priceKrw: 4_900, sortOrder: 10 }, // 2%
  { amountCoin: 10_000n, priceKrw: 9_700, sortOrder: 20 }, // 3%
  { amountCoin: 30_000n, priceKrw: 28_500, sortOrder: 30 }, // 5%
  { amountCoin: 50_000n, priceKrw: 46_500, sortOrder: 40 }, // 7%
  { amountCoin: 100_000n, priceKrw: 90_000, sortOrder: 50 }, // 10%
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
 * The database clock (ADR-0027; `clockTimestamp` in tx-helpers.ts, which the API and the worker
 * share since M5): what the staleness report compares close times against. The seed runner and
 * Postgres are two machines — a Windows host and a Docker VM, most obviously — and every market
 * instant the seed leaves behind comes from the database (column defaults), so the report must
 * judge them on the same clock.
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
    await tx
      .insert(chargePackages)
      .values(CHARGE_PACKAGES.map((row) => ({ ...row, isActive: false })));
    return 'inserted';
  });
  console.log(
    outcome === 'inserted'
      ? `[db:seed] charge packages: ${String(CHARGE_PACKAGES.length)} inserted, off sale`
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

/** better-auth lower-cases the email on sign-up and sign-in; match it here. */
function normaliseAdmin(input: AdminInput, variable: string): AdminInput {
  if (input.password.length < 8 || input.password.length > 128) {
    throw new Error(`[db:seed] ${variable} must be 8-128 characters (better-auth defaults)`);
  }
  return { email: input.email.trim().toLowerCase(), password: input.password };
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * One bootstrap admin, the way better-auth's email sign-up makes an account: a `user` row plus a
 * credential `account` row (providerId 'credential', accountId = user id, scrypt hash from
 * better-auth/crypto). The "user" AFTER INSERT trigger (migrations 0002 and 0004) creates the
 * profile (auto nickname) and the balance, sign-up bonus included: the operator account starts
 * with SIGNUP_BONUS_COIN like every account (Q-M2-2). A fresh account is renamed 관리자 (관리자2
 * for the second) and promoted; an account the address already has keeps its nickname and
 * password and is verified and promoted. Writes its `admin_grant` record — actor the account
 * itself, reason SEED_ADMIN_GRANT_REASON — at `at`, and returns its id. Returns undefined,
 * changing nothing, for an account that was revoked once: the seed never gives the role back
 * (owner decision 2026-10-13).
 */
async function seedOneAdmin(tx: Tx, input: AdminInput, at: Date): Promise<string | undefined> {
  const { email } = input;
  const now = new Date();
  let created = false;

  let [existing] = await tx
    .select({ id: user.id, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.email, email));
  if (existing) {
    const [revoked] = await tx
      .select({ id: adminActions.id })
      .from(adminActions)
      .where(
        and(
          eq(adminActions.type, 'admin_revoke'),
          eq(adminActions.targetType, 'user'),
          eq(adminActions.targetId, existing.id),
        ),
      )
      .limit(1);
    if (revoked) {
      console.warn(`[db:seed] admin ${email}: its admin role was revoked once, not promoted again`);
      return undefined;
    }
  } else {
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
  // verify it here as the fresh branch does — the operator owns the SEED_*ADMIN_EMAIL address.
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
    .select({ role: profiles.role })
    .from(profiles)
    .where(eq(profiles.userId, userId));
  if (!profile) {
    throw new Error('[db:seed] the "user" trigger did not create a profile (run db:migrate)');
  }
  // A fresh account also trades the trigger's auto nickname for 관리자 in the same statement.
  await tx
    .update(profiles)
    .set({
      ...(created ? { nickname: await pickNickname(tx, userId) } : {}),
      role: 'admin',
      updatedAt: at,
    })
    .where(eq(profiles.userId, userId));
  await tx.insert(adminActions).values({
    adminId: userId,
    type: 'admin_grant',
    targetType: 'user',
    targetId: userId,
    payload: { reason: SEED_ADMIN_GRANT_REASON },
    createdAt: at,
  });

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
    `[db:seed] admin ${email}: ${created ? 'created' : 'promoted'}` +
      ` (role=admin, admin_grant recorded, credential ${credential ? 'kept' : 'created'}${verifiedNow ? ', verified' : ''})`,
  );
  return userId;
}

/**
 * The bootstrap admins (PLAN 10.5, #171): only while NO account holds the admin role, the first
 * from SEED_ADMIN_* and, when given, a second from SEED_SECOND_ADMIN_* (both or neither, checked
 * before anything is seeded) — the two-person rule needs two distinct admins in every
 * environment (owner decision 2026-10-13). Once any admin exists the seed creates and promotes
 * nobody: admins come and go on the admin screen (`POST /admin/admins`, `…/revoke`), and a
 * revoked account is never promoted again.
 *
 * The one exception to the grant rule of the admin screen (a verified email AND a real name and
 * mobile number, ADR-0043): nobody exists yet who could grant, so the seed promotes accounts it
 * verifies itself and with no contact — they enter it at their first sign-in, the onboarding gate
 * covers /admin too. Each grant is recorded like any other (`admin_grant`, actor the account
 * itself, reason SEED_ADMIN_GRANT_REASON). Re-running never resets a password.
 *
 * Returns the first admin's id when that account holds the role now: the `created_by` and event
 * actor of the seed markets.
 */
async function seedAdmins(
  db: Db,
  first: AdminInput,
  second: AdminInput | undefined,
): Promise<string | undefined> {
  if (second && second.email === first.email) {
    throw new Error('[db:seed] SEED_SECOND_ADMIN_EMAIL must differ from SEED_ADMIN_EMAIL');
  }
  return db.transaction(async (tx) => {
    await lockSeed(tx);
    // After the seed lock, like every taker of both: the admin screen's grants and revokes hold
    // this one too, so "no admin yet" stays true until this commits.
    await lockAdminRoles(tx, 'exclusive');
    const [anyAdmin] = await tx
      .select({ userId: profiles.userId })
      .from(profiles)
      .where(eq(profiles.role, 'admin'))
      .limit(1);

    if (!anyAdmin) {
      // One instant per grant, the second strictly after the first, so the history lists them
      // in the order they were made.
      const firstAt = await dbNow(tx);
      const firstId = await seedOneAdmin(tx, first, firstAt);
      if (second) {
        const secondAt = new Date(Math.max((await dbNow(tx)).getTime(), firstAt.getTime() + 1));
        await seedOneAdmin(tx, second, secondAt);
      } else {
        console.log(
          '[db:seed] SEED_SECOND_ADMIN_EMAIL / SEED_SECOND_ADMIN_PASSWORD not set: one admin only — a two-person approval needs a second (#171)',
        );
      }
      return firstId;
    }

    console.log('[db:seed] admins: an admin exists already, nobody created or promoted (#171)');
    const [seeded] = await tx
      .select({ id: user.id, role: profiles.role })
      .from(user)
      .innerJoin(profiles, eq(profiles.userId, user.id))
      .where(eq(user.email, first.email));
    return seeded?.role === 'admin' ? seeded.id : undefined;
  });
}

/**
 * How close a seeded market's cutoff may come before `db:seed` starts asking for fresh copy.
 * Two weeks: long enough that a warning is actionable (new copy needs an owner decision on the
 * subject, Q-M3-4), short enough that it is not shouting for most of the fixture's life.
 */
const SEED_CLOSE_SOON_DAYS = 14;
const SEED_CLOSE_SOON_MS = SEED_CLOSE_SOON_DAYS * 24 * 60 * 60 * 1_000;

/**
 * Inserts the seed markets as drafts, one transaction per market under the seed lock: the market
 * row and its 'created' event, as the admin create path writes them (M3 design 3.4), so a crash
 * never leaves a market without its history. Drafts, because a market opens only once another
 * reviewer has checked its rules (N03 §2; #125) — the seed never opens one. No price and no tick:
 * a market has none before its first fill (N02 §5). A market whose slug exists is skipped, never
 * updated. Runs after `seedAdmins`: the first admin is `created_by` and the actor of the event.
 *
 * One deliberate divergence from that path: `close_at` is an absolute instant (ADR-0027), and
 * `assertFutureCloseAt` refuses a past one on create while this writes it anyway, so a late-run
 * seed still gets its 14 drafts. Opening such a draft is refused until an admin moves its close
 * time; the loop below says so on every run.
 */
async function seedMarkets(db: Db, adminId: string): Promise<void> {
  const categoryRows = await db
    .select({ id: categories.id, slug: categories.slug })
    .from(categories);
  const categoryIds = new Map(categoryRows.map((row) => [row.slug, row.id]));

  // One read for the staleness report below; a re-run that inserts nothing spends this single
  // round trip rather than one per market.
  const reportedAt = await dbNow(db);

  let inserted = 0;
  for (const seed of SEED_MARKETS) {
    // `seedCategories` ran first; a missing slug means the category list and the market list
    // disagree, which is a bug in this package, not a state to seed around.
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
        .select({ id: markets.id, status: markets.status, closeAt: markets.closeAt })
        .from(markets)
        .where(eq(markets.slug, seed.slug));
      // Left exactly as it is, status included: a re-seed never rewrites a market an admin
      // has been working with. Its status and close time are read back so the report below
      // judges the row that exists, not the literal in this file.
      if (existing) return { inserted: false, status: existing.status, closeAt: existing.closeAt };

      // `created_at`, `last_price` (NULL: no fill yet) and the statistics are column defaults.
      const [market] = await tx
        .insert(markets)
        .values({
          slug: seed.slug,
          title: seed.title,
          description: seed.description,
          rules: seed.rules,
          resolutionSource: seed.resolutionSource,
          categoryId,
          status: 'draft',
          openAt: null,
          closeAt,
          createdBy: adminId,
        })
        .returning({ id: markets.id, status: markets.status });
      if (!market) throw new Error(`[db:seed] market ${seed.slug}: insert returned no row`);
      const [created] = await tx
        .insert(marketEvents)
        .values({
          marketId: market.id,
          type: 'created',
          actorId: adminId,
          payload: { source: 'seed' },
        })
        .returning({ id: marketEvents.id });
      // The status key every transition writes (M5): the 'created' event is what put the row in
      // `draft`, so a `market:status` a client compares this row against orders after it.
      await tx
        .update(markets)
        .set({ statusEventId: created?.id ?? null })
        .where(eq(markets.id, market.id));
      return { inserted: true, status: market.status, closeAt };
    });
    if (outcome.inserted) inserted++;
    console.log(
      `[db:seed] market ${seed.slug}: ${outcome.inserted ? 'created' : 'already exists'}`,
    );
    // Every run, not only the one that inserts: the cutoffs are absolute, so an environment
    // seeded before one passes reaches the same state without the seed doing anything — and
    // that is the larger half. Against the row's own close time, so an admin who pushed it
    // forward (the copy refresh Q-M3-4 describes) is not nagged about a market they fixed. Only
    // a draft or an open market has a close time still ahead of it to care about.
    if (outcome.status !== 'draft' && outcome.status !== 'open') continue;
    const remainingMs = outcome.closeAt.getTime() - reportedAt.getTime();
    if (remainingMs <= 0 && outcome.status === 'draft') {
      // Seeded as written rather than skipped: skipping would make the fixture's size a
      // function of the calendar (every cutoff is in 2026, so a fresh seed would insert
      // nothing at all from 2027). Opening it is refused until an admin moves the close time
      // (관리자 → 시장 상세 → 수정). The real fix is fresh copy (Q-M3-4), under a new slug.
      console.warn(
        `[db:seed] market ${seed.slug}: closeAt ${seed.closeAt} is already past — it cannot be opened until its close time is moved forward (관리자 → 시장 상세 → 수정); refresh the seed copy`,
      );
    } else if (remainingMs <= 0) {
      // An admin opened the draft and its cutoff has since passed: the worker's per-minute
      // `market.close` scan closes it (PLAN 5.5, M5), or an admin does.
      console.warn(
        `[db:seed] market ${seed.slug}: closeAt ${seed.closeAt} is already past — the worker's market.close scan will close it within a minute (or 관리자 → 시장 상세 → 마감); refresh the seed copy`,
      );
    } else if (remainingMs <= SEED_CLOSE_SOON_MS) {
      // The M6 half of the same mechanism. The warnings above only fire once the fixture is
      // already broken — a developer who clones the repo that week gets markets that cannot
      // open and no idea it was foreseeable. This one fires while it can still be acted on,
      // and it is the same signal at a different distance, so refreshing the copy silences all.
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
const secondEmail = process.env.SEED_SECOND_ADMIN_EMAIL ?? '';
const secondPassword = process.env.SEED_SECOND_ADMIN_PASSWORD ?? '';
// The second admin's pair is both or neither, whitespace alone counting as empty — terraform's
// validation reads seed_second_admin_* the same way, and this catches a local .env or any other
// direct run. One without the other is a second admin someone meant to configure: seeding one
// admin then would leave the environment with no two-person approval (#171), so nothing is seeded.
const hasSecond = secondEmail.trim() !== '';
if (hasSecond !== (secondPassword.trim() !== '')) {
  const missing = hasSecond ? 'SEED_SECOND_ADMIN_PASSWORD' : 'SEED_SECOND_ADMIN_EMAIL';
  console.error(
    `[db:seed] ${missing} is empty: set both SEED_SECOND_ADMIN_EMAIL and SEED_SECOND_ADMIN_PASSWORD, or neither (#171)`,
  );
  process.exit(1);
}

const db = createDb(url, { max: 1, applicationName: 'buddha-seed' });
try {
  await seedCategories(db);
  await seedChargePackages(db);
  if (adminEmail && adminPassword) {
    const adminId = await seedAdmins(
      db,
      normaliseAdmin({ email: adminEmail, password: adminPassword }, 'SEED_ADMIN_PASSWORD'),
      hasSecond
        ? normaliseAdmin(
            { email: secondEmail, password: secondPassword },
            'SEED_SECOND_ADMIN_PASSWORD',
          )
        : undefined,
    );
    if (adminId) {
      await seedMarkets(db, adminId);
    } else {
      console.log('[db:seed] markets skipped (the SEED_ADMIN_EMAIL account is not an admin)');
    }
  } else {
    console.log('[db:seed] SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set: admin skipped');
    console.log('[db:seed] markets skipped (no admin)');
  }
} finally {
  await closeDb(db);
}
