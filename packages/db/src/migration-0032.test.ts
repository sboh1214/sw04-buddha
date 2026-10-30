import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/** A statement's SQL without the `--` comment lines a hand-edited migration opens it with. */
function withoutLeadingComments(statement: string): string {
  const lines = statement.trim().split(/\r?\n/);
  while (lines[0]?.startsWith('--')) lines.shift();
  return lines.join('\n').trim();
}

/**
 * The one statement of migration 0032 that starts with `start`, read from the migration itself: no
 * second copy to drift from what a persistent database (dev, deployed) runs.
 */
function statementOf(start: string): string {
  const migration = readFileSync(
    new URL('../drizzle/0032_onboarding.sql', import.meta.url),
    'utf8',
  );
  const statements = migration
    .split(STATEMENT_BREAKPOINT)
    .map(withoutLeadingComments)
    .filter((statement) => statement.startsWith(start));
  expect(statements).toHaveLength(1);
  return statements[0]!;
}

/** The hand-edited block that clears the case variants before `profiles_nickname_lower_unique`. */
const caseVariantBlock = () => statementOf('DO $$');

/**
 * Migration 0032's clean-up of the nicknames that differ only in case (#58, ADR-0069 decision 1
 * #57-6: 'Abc' keeps 'abc' out). Migrations run against an empty test database, so the block
 * would otherwise never meet a variant in any test. Recreated as it stood before 0032 — the unique
 * index on lower(nickname) not built yet — in a transaction that is rolled back, as the migrate
 * role (the table's owner: only it may drop the index).
 */
describe.skipIf(!hasTestDb())('migration 0032: the case variants (integration)', () => {
  let t: TestDb;
  let migrate: Client;
  beforeAll(async () => {
    t = await connectTestDb();
    migrate = new Client({ connectionString: testDbUrls()!.migrateUrl });
    await migrate.connect();
  });
  afterAll(async () => {
    await migrate?.end();
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
  });

  /** A user and, through the sign-up trigger, its profile; then the nickname and time given. */
  async function account(id: string, nickname: string, createdAt: string): Promise<void> {
    await migrate.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'x', $2)`, [
      id,
      `${id}@test.local`,
    ]);
    await migrate.query(`UPDATE profiles SET nickname = $2, created_at = $3 WHERE user_id = $1`, [
      id,
      nickname,
      createdAt,
    ]);
  }

  async function nicknames(): Promise<Record<string, string>> {
    const { rows } = await migrate.query<{ user_id: string; nickname: string }>(
      'SELECT user_id, nickname FROM profiles',
    );
    return Object.fromEntries(rows.map((row) => [row.user_id, row.nickname]));
  }

  async function rolledBack(body: () => Promise<void>): Promise<void> {
    await migrate.query('BEGIN');
    try {
      await migrate.query('DROP INDEX profiles_nickname_lower_unique');
      await body();
    } finally {
      await migrate.query('ROLLBACK');
    }
  }

  it('keeps each nickname with its oldest account and gives the later variants auto nicknames', async () => {
    await rolledBack(async () => {
      await account('v-oldest', 'Abc', '2026-01-01T00:00:00Z');
      await account('v-newer', 'abc', '2026-02-01T00:00:00Z');
      await account('v-newest', 'ABC', '2026-03-01T00:00:00Z');
      // Created at the same instant: the smaller user id is the older.
      await account('w-a', '홍길동_X', '2026-01-05T00:00:00Z');
      await account('w-b', '홍길동_x', '2026-01-05T00:00:00Z');
      await account('other', 'other', '2026-04-01T00:00:00Z');

      await migrate.query(caseVariantBlock());

      const after = await nicknames();
      expect(after['v-oldest']).toBe('Abc');
      expect(after['w-a']).toBe('홍길동_X');
      expect(after.other).toBe('other');
      for (const renamed of ['v-newer', 'v-newest', 'w-b']) {
        expect(after[renamed], renamed).toMatch(/^user_[23456789A-HJ-NP-Z]{4}$/);
      }
      // No two left alike in any case, and the index the migration builds next builds.
      const { rows } = await migrate.query<{ distinct: number; total: number }>(
        'SELECT count(DISTINCT lower(nickname))::int AS distinct, count(*)::int AS total FROM profiles',
      );
      expect(rows[0]!.distinct).toBe(rows[0]!.total);
      await migrate.query(
        'CREATE UNIQUE INDEX profiles_nickname_lower_unique ON profiles USING btree (lower(nickname))',
      );
    });
  });

  it('changes nothing where no nickname differs from another only in case', async () => {
    await rolledBack(async () => {
      await account('a', 'Trader_Kim', '2026-01-01T00:00:00Z');
      await account('b', '홍길동', '2026-01-02T00:00:00Z');
      const before = await nicknames();
      await migrate.query(caseVariantBlock());
      expect(await nicknames()).toEqual(before);
    });
  });
});

/**
 * Migration 0032's tail that clears what a social login left behind (ADR-0072 7-30): better-auth's
 * name and photo on `user` (오너 결정 2026-10-19 (2차) 3), and the provider's tokens on `account` —
 * the ID token, Google's carrying the member's name and photo address ((2차) 3), and the access and
 * refresh tokens with their expiry ((4차) 1). From 0032 on the API's auth hooks keep them from being
 * written; these statements are what clears the rows a persistent database (dev, deployed) already
 * holds, and migrations run against an empty test database, so they would otherwise never meet a
 * row in any test. Run as the migrate role, in a transaction rolled back.
 */
describe.skipIf(!hasTestDb())(
  'migration 0032: no social name, photo or provider token (integration)',
  () => {
    let t: TestDb;
    let migrate: Client;
    beforeAll(async () => {
      t = await connectTestDb();
      migrate = new Client({ connectionString: testDbUrls()!.migrateUrl });
      await migrate.connect();
    });
    afterAll(async () => {
      await migrate?.end();
      await t?.close(); // undefined when beforeAll timed out waiting for the file lock
    });
    beforeEach(async () => {
      await t.reset();
    });

    async function rolledBack(body: () => Promise<void>): Promise<void> {
      await migrate.query('BEGIN');
      try {
        await body();
      } finally {
        await migrate.query('ROLLBACK');
      }
    }

    async function user(id: string, name: string, image: string | null): Promise<void> {
      await migrate.query(
        `INSERT INTO "user" (id, name, email, email_verified, image) VALUES ($1, $2, $3, true, $4)`,
        [id, name, `${id}@test.local`, image],
      );
    }

    async function users() {
      const { rows } = await migrate.query<{
        id: string;
        name: string;
        image: string | null;
        email: string;
        email_verified: boolean;
      }>('SELECT id, name, image, email, email_verified FROM "user" ORDER BY id');
      return rows;
    }

    /** A provider's ID token as Google's looks: a JWT whose payload names the member. */
    const GOOGLE_ID_TOKEN = [
      Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(
        JSON.stringify({
          sub: '1234567890',
          email: 'member@gmail.com',
          name: '홍길동',
          picture: 'https://lh3.googleusercontent.com/a/photo',
        }),
      ).toString('base64url'),
      'signature',
    ].join('.');

    /** A provider's tokens as better-auth stored them; each left out is NULL. */
    interface Tokens {
      idToken?: string;
      accessToken?: string;
      refreshToken?: string;
      accessTokenExpiresAt?: Date;
      refreshTokenExpiresAt?: Date;
    }

    async function account(id: string, userId: string, tokens: Tokens): Promise<void> {
      await migrate.query(
        `INSERT INTO "account" (id, account_id, provider_id, user_id, id_token, access_token,
         refresh_token, access_token_expires_at, refresh_token_expires_at, scope, updated_at)
       VALUES ($1, $1, 'google', $2, $3, $4, $5, $6, $7, 'openid,email', now())`,
        [
          id,
          userId,
          tokens.idToken ?? null,
          tokens.accessToken ?? null,
          tokens.refreshToken ?? null,
          tokens.accessTokenExpiresAt ?? null,
          tokens.refreshTokenExpiresAt ?? null,
        ],
      );
    }

    async function accounts() {
      const { rows } = await migrate.query<{
        id: string;
        id_token: string | null;
        access_token: string | null;
        refresh_token: string | null;
        access_token_expires_at: Date | null;
        refresh_token_expires_at: Date | null;
        account_id: string;
        scope: string | null;
      }>(
        `SELECT id, id_token, access_token, refresh_token, access_token_expires_at,
           refresh_token_expires_at, account_id, scope
         FROM "account" ORDER BY id`,
      );
      return rows;
    }

    it('clears every user’s name and photo, and nothing else', async () => {
      await rolledBack(async () => {
        await user('both', '홍길동', 'https://k.kakaocdn.net/photo.jpg');
        await user('name-only', '관리자', null);
        await user('image-only', '', 'https://phinf.pstatic.net/photo.jpg');

        const { rowCount } = await migrate.query(statementOf('UPDATE "user"'));
        expect(rowCount).toBe(3);
        expect(await users()).toEqual(
          ['both', 'image-only', 'name-only'].map((id) => ({
            id,
            name: '',
            image: null,
            email: `${id}@test.local`,
            email_verified: true,
          })),
        );
      });
    });

    it('clears every stored provider token and keeps the rest of the login account', async () => {
      await rolledBack(async () => {
        const inAnHour = new Date(Date.now() + 3_600_000);
        await user('google', '', null);
        // Every token a sign-in left, and rows holding only one of them.
        await account('all', 'google', {
          idToken: GOOGLE_ID_TOKEN,
          accessToken: 'access-all',
          refreshToken: 'refresh-all',
          accessTokenExpiresAt: inAnHour,
          refreshTokenExpiresAt: inAnHour,
        });
        await account('id-only', 'google', { idToken: GOOGLE_ID_TOKEN });
        await account('access-only', 'google', { accessToken: 'access-only' });
        await account('refresh-only', 'google', { refreshToken: 'refresh-only' });
        await account('expiry-only', 'google', { accessTokenExpiresAt: inAnHour });
        await account('refresh-expiry-only', 'google', { refreshTokenExpiresAt: inAnHour });

        const { rowCount } = await migrate.query(statementOf('UPDATE "account"'));
        expect(rowCount).toBe(6);
        expect(await accounts()).toEqual(
          [
            'access-only',
            'all',
            'expiry-only',
            'id-only',
            'refresh-expiry-only',
            'refresh-only',
          ].map((id) => ({
            id,
            id_token: null,
            access_token: null,
            refresh_token: null,
            access_token_expires_at: null,
            refresh_token_expires_at: null,
            account_id: id,
            scope: 'openid,email',
          })),
        );
      });
    });

    it('touches no row that holds none of them', async () => {
      await rolledBack(async () => {
        await user('clean', '', null);
        await account('clean-account', 'clean', {});
        expect((await migrate.query(statementOf('UPDATE "user"'))).rowCount).toBe(0);
        expect((await migrate.query(statementOf('UPDATE "account"'))).rowCount).toBe(0);
      });
    });
  },
);
