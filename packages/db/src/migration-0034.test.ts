import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createComment, createMarket, createPost, createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/** A statement's SQL without the `--` comment lines a hand-edited migration opens it with. */
function withoutLeadingComments(statement: string): string {
  const lines = statement.trim().split(/\r?\n/);
  while (lines[0]?.startsWith('--')) lines.shift();
  return lines.join('\n').trim();
}

/** Migration 0034's fill of `post_comment_counts`, read from the migration itself. */
function backfillStatement(): string {
  const migration = readFileSync(
    new URL('../drizzle/0034_post_comments.sql', import.meta.url),
    'utf8',
  );
  const statements = migration
    .split(STATEMENT_BREAKPOINT)
    .map(withoutLeadingComments)
    .filter((statement) => statement.startsWith('INSERT INTO "post_comment_counts"'));
  expect(statements).toHaveLength(1);
  return statements[0]!;
}

/**
 * Migration 0034 fills each post's comment count from the comments already there (Codex review on
 * PR #220, ADR-0074 7-33) — which a migration run against the empty test database never shows, as
 * it creates `post_comments` in the same file. Recreated as it stood before the counts: comments of
 * every kind on three posts and no count at all, in a transaction that is rolled back, as the
 * migrate role (the table's owner).
 */
describe.skipIf(!hasTestDb())(
  'migration 0034: comment counts of existing comments (integration)',
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

    it('counts each post’s comments in view, 댓글 and 대댓글 alike, and gives a post with none no row', async () => {
      const { user: author } = await createUser(t.db);
      const market = await createMarket(t.db);
      const [busy, quiet, empty] = await Promise.all(
        [0, 1, 2].map(() => createPost(t.db, { marketId: market.id, authorId: author.id })),
      );
      const on = (
        postId: string,
        extra: Omit<Parameters<typeof createComment>[1], 'postId' | 'authorId'> = {},
      ) => createComment(t.db, { postId, authorId: author.id, ...extra });
      // busy: a 댓글 with a 대댓글 shown and one hidden, a deleted 댓글 with a 대댓글 under it (read in
      // full, so counted), a hidden 댓글 with a 대댓글 under it, and one deleted and hidden.
      const shown = await on(busy!.id);
      await on(busy!.id, { parentId: shown.id });
      await on(busy!.id, { parentId: shown.id, hiddenAt: new Date() });
      const deleted = await on(busy!.id, { deletedAt: new Date() });
      await on(busy!.id, { parentId: deleted.id });
      const hidden = await on(busy!.id, { hiddenAt: new Date() });
      await on(busy!.id, { parentId: hidden.id });
      await on(busy!.id, { deletedAt: new Date(), hiddenAt: new Date() });
      // quiet: only comments out of view; empty: none.
      await on(quiet!.id, { deletedAt: new Date() });
      await on(quiet!.id, { hiddenAt: new Date() });

      /** The counts with none kept, filled by the migration's statement, then rolled back. */
      const backfill = async () => {
        await migrate.query('BEGIN');
        try {
          await migrate.query('DELETE FROM post_comment_counts');
          await migrate.query(backfillStatement());
          const { rows } = await migrate.query<{ post_id: string; count: number }>(
            'SELECT post_id, count FROM post_comment_counts',
          );
          return rows;
        } finally {
          await migrate.query('ROLLBACK');
        }
      };
      const backfilled = await backfill();
      expect(backfilled).toEqual([{ post_id: busy!.id, count: 4 }]);
      // The same as the trigger kept them while they were written: no row for quiet or empty.
      const { rows: kept } = await migrate.query<{ post_id: string; count: number }>(
        'SELECT post_id, count FROM post_comment_counts',
      );
      expect(kept).toEqual(backfilled);
      expect([quiet!.id, empty!.id]).not.toContain(kept[0]?.post_id);
    });
  },
);
