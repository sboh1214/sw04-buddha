// CLI entry: `pnpm db:seed` (tsx src/seed.ts). Idempotent: safe to re-run on every deploy, and
// safe to run twice at once — every step that checks before it inserts holds the `buddha:seed`
// advisory lock for its transaction, so a second seed waits and then finds the rows in place.
//
// Runs as the runtime role (DATABASE_URL = buddha_app): 01-roles.sql grants it DML on every
// table created by migrations, which is all the seed needs.
import { randomUUID } from 'node:crypto';
import { nicknameSchema } from '@buddha/shared';
import { hashPassword } from 'better-auth/crypto';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, createDb, type Db } from './client.js';
import { loadRootEnv } from './env.js';
import { account, balances, categories, chargePackages, profiles, user } from './schema/index.js';

/** PLAN 1.3 categories. Sports and elections are forbidden (PLAN 0.2): never add them. */
const CATEGORIES = [
  { slug: 'economy', nameKo: '경제', sortOrder: 10 },
  { slug: 'culture', nameKo: '문화', sortOrder: 20 },
  { slug: 'entertainment', nameKo: '엔터테인먼트', sortOrder: 30 },
  { slug: 'tech', nameKo: '테크', sortOrder: 40 },
  { slug: 'weather', nameKo: '날씨', sortOrder: 50 },
] as const;

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
 * grows with the size of the package. Admins edit these at runtime, so the seed only fills an
 * empty table and never overwrites what an admin has changed.
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

async function seedChargePackages(db: Db): Promise<void> {
  const inserted = await db.transaction(async (tx) => {
    await lockSeed(tx);
    const [existing] = await tx.select({ id: chargePackages.id }).from(chargePackages).limit(1);
    if (existing) return false;
    await tx.insert(chargePackages).values(CHARGE_PACKAGES.map((row) => ({ ...row })));
    return true;
  });
  console.log(
    inserted
      ? `[db:seed] charge packages: ${String(CHARGE_PACKAGES.length)} inserted`
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
 * verified, has a credential account and has role 'admin'.
 */
async function seedAdmin(db: Db, input: AdminInput): Promise<void> {
  // better-auth lower-cases the email on sign-up and sign-in; match it here.
  const email = input.email.trim().toLowerCase();
  if (input.password.length < 8 || input.password.length > 128) {
    throw new Error(
      '[db:seed] SEED_ADMIN_PASSWORD must be 8-128 characters (better-auth defaults)',
    );
  }

  await db.transaction(async (tx) => {
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
  });
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
    await seedAdmin(db, { email: adminEmail, password: adminPassword });
  } else {
    console.log('[db:seed] SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set: admin skipped');
  }
} finally {
  await closeDb(db);
}
