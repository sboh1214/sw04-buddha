// CLI entry: `pnpm db:seed` (tsx src/seed.ts). Idempotent: safe to re-run on every deploy, and
// safe to run twice at once — every step that checks before it inserts holds the `buddha:seed`
// advisory lock for its transaction, so a second seed waits and then finds the rows in place.
//
// Runs as the runtime role (DATABASE_URL = buddha_app): 01-roles.sql grants it DML on every
// table created by migrations, which is all the seed needs.
import { randomUUID } from 'node:crypto';
import {
  ALL_CATEGORY_SLUGS,
  AUTH_USER_NAME,
  MARKET_TAGS_MIN,
  type MarketStatus,
  SEED_ADMIN_GRANT_REASON,
  type CategorySlug,
  SUBCATEGORY_SLUGS,
  type SubcategorySlug,
  marketTagsSchema,
  tagKey,
} from '@buddha/shared';
import { hashPassword } from 'better-auth/crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { closeDb, createDb, type Db } from './client.js';
import { loadRootEnv } from './env.js';
import { SEED_MARKETS, type SeedMarket } from './seed-markets.js';
import { clockTimestamp, lockAdminRoles } from './tx-helpers.js';
import {
  account,
  adminActions,
  balances,
  categories,
  chargePackages,
  marketEvents,
  marketSources,
  marketTags,
  markets,
  profiles,
  tags,
  user,
} from './schema/index.js';

/**
 * The tree a fresh database starts with: PLAN 1.3's top-level categories, spaced by ten. Initial
 * data only — from the first seed on, the operators keep the tree on `/admin/categories` (#17):
 * they add, rename, reorder and hide, any category included, sports and politics too (D10,
 * ADR-0047 O-16), and the seed never changes a row that exists (`seedCategories`).
 */
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
 * The starting order within a parent is the order of the shared tuple, spaced by ten like the
 * parents.
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

/** better-auth looks a credential account up by (providerId 'credential', accountId = user id). */
const CREDENTIAL_PROVIDER = 'credential';

/**
 * Inserts the seed tree's missing rows and leaves every other row alone (#17, ADR-0096): a
 * category an admin renamed, reordered or hid keeps its name, place and `is_active` through every
 * deploy's seed. `ON CONFLICT DO NOTHING` with no target, so a row is skipped on either key — its
 * slug exists (the usual case: every seed after the first), or a sibling already has its name
 * (`categories_parent_name_ko_unique`, a seed slug added later that an admin got to first). A
 * fresh database gets the whole tree; a seed slug missing from an existing one is inserted at its
 * seed place, which the admins can move. A deploy's seed never fails on the operators' tree: a
 * skipped row is reported, and its sub-categories with it when it is a parent, and a seed market
 * filed under it is skipped too (`seedMarkets`).
 */
async function seedCategories(db: Db): Promise<void> {
  // Parents first, then the leaves under them. Only an inserted row comes back from RETURNING,
  // so a leaf's `parent_id` is read back by slug — the slug never changes once made (#17).
  const parents = await db
    .insert(categories)
    .values(CATEGORIES.map((category) => ({ ...category, parentId: null })))
    .onConflictDoNothing()
    .returning({ id: categories.id });
  const parentSlugs = CATEGORIES.map((category) => category.slug);
  const parentRows = await db
    .select({ id: categories.id, slug: categories.slug })
    .from(categories)
    .where(inArray(categories.slug, parentSlugs));
  const parentIds = new Map(parentRows.map((row) => [row.slug, row.id]));

  const leaves = CATEGORIES.flatMap((parent) => {
    const parentId = parentIds.get(parent.slug);
    if (parentId === undefined) return [];
    return SUBCATEGORY_SLUGS[parent.slug].map((slug, index) => ({
      slug,
      nameKo: SUBCATEGORY_NAMES[slug],
      sortOrder: (index + 1) * 10,
      parentId,
    }));
  });
  const insertedLeaves =
    leaves.length === 0
      ? []
      : await db
          .insert(categories)
          .values(leaves)
          .onConflictDoNothing()
          .returning({ id: categories.id });

  const present = new Set(
    (
      await db
        .select({ slug: categories.slug })
        .from(categories)
        .where(inArray(categories.slug, [...ALL_CATEGORY_SLUGS]))
    ).map((row) => row.slug),
  );
  const missing = ALL_CATEGORY_SLUGS.filter((slug) => !present.has(slug));
  for (const slug of missing) {
    console.warn(
      `[db:seed] category ${slug}: not seeded — a sibling already has its name, or its parent is not there; the tree is the operators' (관리자 → 카테고리)`,
    );
  }
  const inserted = parents.length + insertedLeaves.length;
  console.log(
    `[db:seed] categories: ${String(inserted)} inserted, ${String(
      ALL_CATEGORY_SLUGS.length - inserted - missing.length,
    )} already there and left as the operators keep them`,
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

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * One bootstrap admin, the way better-auth's email sign-up makes an account: a `user` row plus a
 * credential `account` row (providerId 'credential', accountId = user id, scrypt hash from
 * better-auth/crypto). The "user" AFTER INSERT trigger (migrations 0002 and 0031) creates the
 * profile (auto nickname) and a zero balance with no ledger entry, like every account: the
 * operator account gets its start Coin as everyone does, after its 본인확인 and onboarding (#70,
 * ADR-0069 decision 4 #70), never from the seed. A fresh account keeps the trigger's auto nickname
 * — the seed no longer renames it 관리자, a reserved word the nickname rules refuse (#57-6): the admin
 * keeps it or picks its own at the onboarding's nickname step, as every account does (오너 결정
 * 2026-10-19 (2차) 2, ADR-0072) — and its better-auth `user.name` is AUTH_USER_NAME, as every
 * account's. A fresh account is promoted; an account the address already has keeps its nickname
 * and password and is verified and promoted. Writes its `admin_grant` record — actor the account
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
      name: AUTH_USER_NAME,
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
  await tx
    .update(profiles)
    .set({ role: 'admin', updatedAt: at })
    .where(eq(profiles.userId, userId));
  await tx.insert(adminActions).values({
    adminId: userId,
    type: 'admin_grant',
    targetType: 'user',
    targetId: userId,
    payload: { reason: SEED_ADMIN_GRANT_REASON },
    createdAt: at,
  });

  // The trigger created the balance, at 0 (migration 0031) — like every account. Never
  // touched: balances change only together with a ledger entry (PLAN 0.2), and a missing row is
  // a broken account for the ledger audit to report, not something the seed papers over.
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
 * from SEED_ADMIN_* and, when given, a second from SEED_SECOND_ADMIN_* (each pair both or neither,
 * the second only with the first and a different email, all checked before anything is seeded,
 * `adminPair`) — the two-person rule needs two distinct admins in every
 * environment (owner decision 2026-10-13). Once any admin exists the seed creates and promotes
 * nobody: admins come and go on the admin screen (`POST /admin/admins`, `…/revoke`), and a
 * revoked account is never promoted again.
 *
 * The one exception to the grant rule of the admin screen (a verified email AND a completed
 * SMS verification of the phone, ADR-0070): nobody exists yet who could grant, so the seed
 * promotes accounts it verifies the email of itself and whose phone nobody verified — they verify
 * it at their first sign-in, the onboarding gate covers /admin too. Each grant is recorded like
 * any other (`admin_grant`, actor the account itself, reason SEED_ADMIN_GRANT_REASON). Re-running
 * never resets a password.
 *
 * Returns the first admin's id when that account holds the role now: the `created_by` and event
 * actor of the seed markets.
 */
async function seedAdmins(
  db: Db,
  first: AdminInput,
  second: AdminInput | undefined,
): Promise<string | undefined> {
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
 * A seed market's tags, the way the admin create path writes them (`linkTags`, #17): each name a
 * tag already has (the same `name_key`, case ignored) links that tag, keeping the spelling it was
 * first made with; any other becomes a new tag — `ON CONFLICT (name_key) DO NOTHING`, then the
 * ids read back by key, so a tag another writer made meanwhile is linked rather than refused. The
 * new tags are inserted in key order, as the API inserts them, so a seed and an admin making the
 * same new tags at once wait on each other's index entries in one order and never in a cycle (a
 * deadlock would fail the deploy's seed or the admin's write). `position` is the order given,
 * 1..n. The market has no `market_tags` rows when this runs. Tags are never updated or deleted
 * (migration 0049).
 */
async function insertSeedTags(tx: Tx, marketId: string, names: readonly string[]): Promise<void> {
  const keys = names.map(tagKey);
  const inKeyOrder = names
    .map((name, index) => ({ name, key: keys[index]! }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  await tx
    .insert(tags)
    .values(inKeyOrder.map(({ name }) => ({ name })))
    .onConflictDoNothing({ target: tags.nameKey });
  const rows = await tx
    .select({ id: tags.id, nameKey: tags.nameKey })
    .from(tags)
    .where(inArray(tags.nameKey, keys));
  const ids = new Map(rows.map((row) => [row.nameKey, row.id]));
  await tx.insert(marketTags).values(
    keys.map((key, index) => {
      const tagId = ids.get(key);
      if (tagId === undefined) throw new Error(`[db:seed] tag "${key}": upsert left no row`);
      return { marketId, tagId, position: index + 1 };
    }),
  );
}

/** Whether the market has any `market_tags` row: a set the seed or an admin gave it. */
async function hasTags(tx: Tx, marketId: string): Promise<boolean> {
  const [row] = await tx
    .select({ marketId: marketTags.marketId })
    .from(marketTags)
    .where(eq(marketTags.marketId, marketId))
    .limit(1);
  return row !== undefined;
}

/** Whether any admin record of the market has `key` in its `after` snapshot. */
async function adminSnapshotHas(tx: Tx, marketId: string, key: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: adminActions.id })
    .from(adminActions)
    .where(
      and(
        eq(adminActions.targetType, 'market'),
        eq(adminActions.targetId, marketId),
        sql`${adminActions.payload} -> 'after' ? ${key}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Whether an admin has set this market's tags since #17: every admin market record from #17 on
 * (`market_create`, `market_update`, the transitions) carries the tag names in its `after`
 * snapshot, an empty set too, so a draft an admin cleared on purpose has one. Records written
 * before #17 have no `tags` key — the market's tags were never anybody's choice.
 */
async function adminSetTags(tx: Tx, marketId: string): Promise<boolean> {
  return adminSnapshotHas(tx, marketId, 'tags');
}

/**
 * Whether an admin has set this market's rule items since #23 (ADR-0097): every admin market
 * record from #23 on carries them all in its `after` snapshot, blank ones too, `yesCondition`
 * among them — so a draft an admin emptied on purpose has one. Records written before #23 have no
 * such key: what they recorded was the old `rules` text, which migration 0050 dropped (D4).
 */
async function adminSetRuleItems(tx: Tx, marketId: string): Promise<boolean> {
  return adminSnapshotHas(tx, marketId, 'yesCondition');
}

/**
 * A seed market's rule items (#23) as `markets` columns; its sources are `market_sources` rows
 * (`insertSeedSources`). 배경 is `description`, written apart: the fill below keeps one a market
 * already has.
 */
function seedRuleColumns(seed: SeedMarket) {
  return {
    yesCondition: seed.yesCondition,
    noCondition: seed.noCondition,
    eventDeadline: new Date(seed.eventDeadline),
    fallbackCondition: seed.fallbackCondition,
    longDelayDays: seed.longDelayDays,
    delayHandling: seed.delayHandling,
  } satisfies Partial<typeof markets.$inferInsert>;
}

/**
 * A seed market's sources, the way the admin create path writes them (#23): priority 0 the 1차
 * 출처, 1..n the 대체 출처 in the order given. The market has no `market_sources` row when this
 * runs.
 */
async function insertSeedSources(tx: Tx, marketId: string, seed: SeedMarket): Promise<void> {
  await tx.insert(marketSources).values(
    [seed.primarySource, ...seed.fallbackSources].map((source, priority) => ({
      marketId,
      priority,
      name: source.name,
      url: source.url,
    })),
  );
}

/**
 * Whether a market's rule items (#23) are all blank, 배경 aside, and whether its 배경 is: what
 * migration 0050 left of a market made before #23 — `rules` and `resolution_source` dropped with
 * their text (D4), every new column at its default and no `market_sources` row. Any item written
 * since, by whoever, makes them not blank. 배경 is the `description` such a market already had.
 */
async function blankRuleItems(
  tx: Tx,
  marketId: string,
): Promise<{ items: boolean; description: boolean }> {
  const [row] = await tx
    .select({
      description: markets.description,
      yesCondition: markets.yesCondition,
      noCondition: markets.noCondition,
      eventDeadline: markets.eventDeadline,
      fallbackCondition: markets.fallbackCondition,
      longDelayDays: markets.longDelayDays,
      delayHandling: markets.delayHandling,
    })
    .from(markets)
    .where(eq(markets.id, marketId));
  const [source] = await tx
    .select({ priority: marketSources.priority })
    .from(marketSources)
    .where(eq(marketSources.marketId, marketId))
    .limit(1);
  const blank = (text: string | null | undefined) => (text ?? '').trim() === '';
  return {
    items:
      row !== undefined &&
      source === undefined &&
      blank(row.yesCondition) &&
      blank(row.noCondition) &&
      row.eventDeadline === null &&
      blank(row.fallbackCondition) &&
      row.longDelayDays === null &&
      blank(row.delayHandling),
    description: blank(row?.description),
  };
}

/**
 * What `seedMarkets` did with one seed market, and the row the staleness report judges. A market
 * that existed may have been given the seed's tags (`tagged`, #17) and its rule items (`ruled`,
 * #23), each on its own.
 */
type SeedMarketOutcome =
  | { kind: 'inserted'; status: MarketStatus; closeAt: Date }
  | { kind: 'existed'; status: MarketStatus; closeAt: Date; tagged: boolean; ruled: boolean }
  | { kind: 'no-category' };

/**
 * Inserts the seed markets as drafts, one transaction per market under the seed lock: the market
 * row with its rule items, its sources, its tags and its 'created' event, as the admin create path
 * writes them (M3 design 3.4; #17; #23), so a crash never leaves a market without its history or
 * with half its tags or sources. Drafts, because a market opens only once another reviewer has
 * checked its rules (N03 §2; #125) — the seed never opens one. No price and no tick: a market has
 * none before its first fill (N02 §5). Runs after `seedAdmins`: the first admin is `created_by`
 * and the actor of the event.
 *
 * One deliberate divergence from that path: `close_at` is an absolute instant (ADR-0027), and
 * `assertFutureCloseAt` refuses a past one on create while this writes it anyway, so a late-run
 * seed still gets its 14 drafts. Opening such a draft is refused until an admin moves its close
 * time; the loop below says so on every run.
 *
 * A market whose slug exists is never updated, with two exceptions, each on its own and on a
 * DRAFT only. An environment seeded by an older seed — a database #174's migration 0048 wiped and
 * seeded before #17 and #23 deployed — would otherwise keep its 14 drafts without what the
 * open-items check asks for, and none could open:
 * - Tags (#17 AC 9): a draft with no `market_tags` row whose tags no admin has set since #17
 *   (`adminSetTags`) gets the seed's tags. A market with any tag keeps its set, and a draft an
 *   admin cleared on purpose stays clear.
 * - Rule items (#23, ADR-0097): a draft whose rule items are all blank (`blankRuleItems`: what
 *   migration 0050 left of it), whose rule items no admin has set since #23 (`adminSetRuleItems`)
 *   and whose title is still the seed's, as stored, gets the seed's — its 배경 only when it has
 *   none, so the one it was seeded with stays. A draft with any item written keeps them all, one
 *   an admin emptied on purpose stays empty, and one an admin re-titled stays blank: the seed's
 *   items answer the seed's question, and a record from before #23 holds no rule item to tell.
 *
 * A market past the draft is left alone: after the open a change is on the record (#172 item 14),
 * and the seed writes none. The market row is taken FOR UPDATE before its status, its title,
 * its tags and its rule items are read again, the lock the admin PATCH takes, so an admin who
 * writes it meanwhile wins. No record is written: what is filled is what a fresh seed would have
 * inserted with the market. The rule fill moves `updated_at`, on the database clock.
 *
 * A seed market whose category is not in the tree — `seedCategories` skipped its slug because an
 * operator's sibling took the name — is skipped with a warning: like the categories, a deploy's
 * seed never fails on the operators' tree.
 */
async function seedMarkets(db: Db, adminId: string): Promise<void> {
  const categoryRows = await db
    .select({ id: categories.id, slug: categories.slug })
    .from(categories);
  const categoryIds = new Map(categoryRows.map((row) => [row.slug, row.id]));

  // One read for the staleness report below; a re-run that inserts nothing spends this single
  // round trip rather than one per market.
  const reportedAt = await dbNow(db);

  const counts = { inserted: 0, existed: 0, tagged: 0, ruled: 0, 'no-category': 0 };
  for (const seed of SEED_MARKETS) {
    const closeAt = new Date(seed.closeAt);
    if (Number.isNaN(closeAt.getTime())) {
      throw new Error(`[db:seed] market ${seed.slug}: closeAt "${seed.closeAt}" is not a date`);
    }
    if (Number.isNaN(Date.parse(seed.eventDeadline))) {
      throw new Error(
        `[db:seed] market ${seed.slug}: eventDeadline "${seed.eventDeadline}" is not a date`,
      );
    }
    // The names the API would take (#17), as written: the literal is the spelling a tag the seed
    // makes is stored with, so it must be normalised already.
    const parsedTags = marketTagsSchema.safeParse(seed.tags);
    if (
      !parsedTags.success ||
      parsedTags.data.length < MARKET_TAGS_MIN ||
      parsedTags.data.some((name, index) => name !== seed.tags[index])
    ) {
      throw new Error(
        `[db:seed] market ${seed.slug}: tags ${JSON.stringify(seed.tags)} are not valid`,
      );
    }
    const outcome = await db.transaction(async (tx): Promise<SeedMarketOutcome> => {
      await lockSeed(tx);
      const [existing] = await tx
        .select({ id: markets.id, status: markets.status, closeAt: markets.closeAt })
        .from(markets)
        .where(eq(markets.slug, seed.slug));
      // Left as it is, status included: a re-seed never rewrites a market an admin has been
      // working with. Its status and close time are read back so the report below judges the
      // row that exists, not the literal in this file.
      if (existing) {
        const unchanged = {
          kind: 'existed',
          status: existing.status,
          closeAt: existing.closeAt,
          tagged: false,
          ruled: false,
        } as const;
        // Only a draft is filled: a market that opened changes its tags and rule items on the
        // record alone (#172 item 14), and the seed writes none.
        if (existing.status !== 'draft') return unchanged;
        if ((await hasTags(tx, existing.id)) && !(await blankRuleItems(tx, existing.id)).items) {
          return unchanged;
        }
        // A draft seeded before #17 (no tag at all) or #23 (no rule item). Locked, then read
        // again, title included — an admin's PATCH or open that committed while this waited is
        // the market's — and each filled on its own unless an admin has set it since (cleared it
        // on purpose, say): a draft seeded before both needs both.
        const [locked] = await tx
          .select({ status: markets.status, closeAt: markets.closeAt, title: markets.title })
          .from(markets)
          .where(eq(markets.id, existing.id))
          .for('update');
        if (locked?.status !== 'draft') {
          return locked
            ? { ...unchanged, status: locked.status, closeAt: locked.closeAt }
            : unchanged;
        }
        const row = { kind: 'existed', status: locked.status, closeAt: locked.closeAt } as const;
        const tagged = !(await hasTags(tx, existing.id)) && !(await adminSetTags(tx, existing.id));
        if (tagged) await insertSeedTags(tx, existing.id, seed.tags);
        const blank = await blankRuleItems(tx, existing.id);
        // The seed's items answer the seed's question: a draft an admin re-titled before #23 has
        // no record naming a rule item, so its title, compared as stored, is what tells it apart.
        const ruled =
          blank.items && locked.title === seed.title && !(await adminSetRuleItems(tx, existing.id));
        if (ruled) {
          await tx
            .update(markets)
            .set({
              ...seedRuleColumns(seed),
              ...(blank.description ? { description: seed.description } : {}),
              // The database clock, as every instant the seed leaves (ADR-0027), not the
              // runner's that `$onUpdate` would write.
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(markets.id, existing.id));
          await insertSeedSources(tx, existing.id, seed);
        }
        return { ...row, tagged, ruled };
      }

      // `seedCategories` ran first and skipped only what the operators' tree blocks.
      const categoryId = categoryIds.get(seed.category);
      if (categoryId === undefined) return { kind: 'no-category' };

      // `created_at`, `last_price` (NULL: no fill yet) and the statistics are column defaults.
      const [market] = await tx
        .insert(markets)
        .values({
          slug: seed.slug,
          title: seed.title,
          description: seed.description,
          ...seedRuleColumns(seed),
          categoryId,
          status: 'draft',
          openAt: null,
          closeAt,
          createdBy: adminId,
        })
        .returning({ id: markets.id, status: markets.status });
      if (!market) throw new Error(`[db:seed] market ${seed.slug}: insert returned no row`);
      await insertSeedSources(tx, market.id, seed);
      await insertSeedTags(tx, market.id, seed.tags);
      const [created] = await tx
        .insert(marketEvents)
        .values({
          marketId: market.id,
          type: 'created',
          actorId: adminId,
          toStatus: 'draft',
          payload: { source: 'seed' },
        })
        .returning({ id: marketEvents.id });
      // The status key every transition writes (M5): the 'created' event is what put the row in
      // `draft`, so a `market:status` a client compares this row against orders after it.
      await tx
        .update(markets)
        .set({ statusEventId: created?.id ?? null })
        .where(eq(markets.id, market.id));
      return { kind: 'inserted', status: market.status, closeAt };
    });
    counts[outcome.kind]++;
    if (outcome.kind === 'no-category') {
      console.warn(
        `[db:seed] market ${seed.slug}: not seeded — its category "${seed.category}" is not in the tree (a sibling already has its name); the tree is the operators' (관리자 → 카테고리)`,
      );
      continue;
    }
    if (outcome.kind === 'inserted') {
      console.log(`[db:seed] market ${seed.slug}: created`);
    } else {
      if (outcome.tagged) counts.tagged++;
      if (outcome.ruled) counts.ruled++;
      const given = [
        ...(outcome.tagged ? ['tags (it had none)'] : []),
        ...(outcome.ruled ? ['rule items (they were blank)'] : []),
      ];
      console.log(
        `[db:seed] market ${seed.slug}: already exists${
          given.length > 0 ? `, given the seed's ${given.join(' and ')}` : ''
        }`,
      );
    }
    // Every run, not only the one that inserts: the cutoffs are absolute, so an environment
    // seeded before one passes reaches the same state without the seed doing anything — and
    // that is the larger half. Against the row's own close time, so an admin who pushed it
    // forward (the copy refresh Q-M3-4 describes) is not nagged about a market they fixed. Only
    // a draft or an open market has a close time still ahead of it to care about: the other
    // statuses before the close (review, scheduled, paused) come with #78·#21·#114, which say
    // what an admin does about a passed cutoff there.
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
    `[db:seed] markets: ${String(counts.inserted)} inserted, ${String(
      counts.existed,
    )} already existed (${String(counts.tagged)} of them given the seed's tags, ${String(
      counts.ruled,
    )} the seed's rule items), ${String(counts['no-category'])} skipped (category not in the tree)`,
  );
}

loadRootEnv();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[db:seed] DATABASE_URL is not set (copy .env.example to .env)');
  process.exit(1);
}
/** A configuration the seed refuses: said once on stderr, before anything is seeded. */
function configError(message: string): never {
  console.error(`[db:seed] ${message}`);
  process.exit(1);
}

/**
 * One SEED_*ADMIN_* pair: both values or neither, whitespace alone counting as empty — terraform's
 * validation reads seed_*admin_* the same way, and this catches a local .env or any other direct
 * run. One without the other is an admin someone meant to configure: seeding without it would
 * leave the environment with fewer admins than meant (none, or no two-person approval, #171), so
 * nothing is seeded. The password length is checked here too, and the email lower-cased the way
 * better-auth does on sign-up and sign-in.
 */
function adminPair(emailVariable: string, passwordVariable: string): AdminInput | undefined {
  const email = process.env[emailVariable] ?? '';
  const password = process.env[passwordVariable] ?? '';
  const hasEmail = email.trim() !== '';
  if (hasEmail !== (password.trim() !== '')) {
    configError(
      `${hasEmail ? passwordVariable : emailVariable} is empty: set both ${emailVariable} and ${passwordVariable}, or neither (#171)`,
    );
  }
  if (!hasEmail) return undefined;
  if (password.length < 8 || password.length > 128) {
    configError(`${passwordVariable} must be 8-128 characters (better-auth defaults)`);
  }
  return { email: email.trim().toLowerCase(), password };
}

// Every admin setting is checked before the pool opens: a refused configuration seeds nothing.
const firstAdmin = adminPair('SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD');
const secondAdmin = adminPair('SEED_SECOND_ADMIN_EMAIL', 'SEED_SECOND_ADMIN_PASSWORD');
// The second is the second of two: with no first, seedAdmins would not run, and the seed would
// end with no admin at all and the configured second skipped.
if (secondAdmin && !firstAdmin) {
  configError(
    'SEED_SECOND_ADMIN_* is set but SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD are not: set the first admin too, or neither (#171)',
  );
}
if (secondAdmin && secondAdmin.email === firstAdmin?.email) {
  configError('SEED_SECOND_ADMIN_EMAIL must differ from SEED_ADMIN_EMAIL');
}

const db = createDb(url, { max: 1, applicationName: 'buddha-seed' });
try {
  await seedCategories(db);
  await seedChargePackages(db);
  if (firstAdmin) {
    const adminId = await seedAdmins(db, firstAdmin, secondAdmin);
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
