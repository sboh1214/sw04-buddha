/**
 * `community.records_purge` (#187, ADR-0083) on the docker `test` database: it deletes the write
 * limits' counted writes and the repetition rules' link uses once they are older than their
 * 24-hour windows and the margin past them, keeps everything a window still counts and what is
 * within the margin, and never touches the review list. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import {
  connectTestDb,
  createLinkFlag,
  createLinkUse,
  createMarket,
  createPost,
  createUser,
  createWriteLimitEvent,
  hasTestDb,
  type TestDb,
} from '@buddha/db/test';
import { LINK_REPEAT_WINDOW_SECONDS, WRITE_LIMIT_DAY_SECONDS } from '@buddha/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMUNITY_RECORDS_PURGE_MARGIN_SECONDS,
  purgeCommunityRecords,
} from './community-records-purge.js';

const MINUTE_MS = 60_000;

describe.skipIf(!hasTestDb())('community.records_purge (integration)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
  });

  const ago = (ms: number) => new Date(Date.now() - ms);

  it('deletes what left the 24-hour windows past the margin and keeps the rest and the review list', async () => {
    const day = WRITE_LIMIT_DAY_SECONDS * 1_000;
    expect(LINK_REPEAT_WINDOW_SECONDS * 1_000).toBe(day);
    const margin = COMMUNITY_RECORDS_PURGE_MARGIN_SECONDS * 1_000;
    const { user } = await createUser(t.db);
    const market = await createMarket(t.db);
    const post = await createPost(t.db, { marketId: market.id, authorId: user.id });
    const url = 'https://example.com/a';

    // Past the window and the margin: deleted. Within the window, or past it but within the
    // margin (a count that read its clock just before could still include it): kept.
    await createWriteLimitEvent(t.db, { action: 'post', createdAt: ago(day + margin + MINUTE_MS) });
    const freshEvent = await createWriteLimitEvent(t.db, {
      action: 'upload',
      createdAt: ago(day - MINUTE_MS),
    });
    const edgeEvent = await createWriteLimitEvent(t.db, {
      action: 'edit',
      createdAt: ago(day + MINUTE_MS),
    });
    await createLinkUse(t.db, { url, postId: post.id, usedAt: ago(day + margin + MINUTE_MS) });
    const freshUse = await createLinkUse(t.db, {
      url,
      postId: post.id,
      usedAt: ago(day - MINUTE_MS),
    });
    const edgeUse = await createLinkUse(t.db, {
      url,
      postId: post.id,
      usedAt: ago(day + MINUTE_MS),
    });
    const flag = await createLinkFlag(t.db, {
      url,
      reason: 'same_account',
      postId: post.id,
      flaggedAt: ago(30 * day),
    });

    expect(await purgeCommunityRecords(t.db)).toEqual({ writeLimitEvents: 1, linkUses: 1 });
    expect((await t.db.select().from(schema.writeLimitEvents)).map((row) => row.id).sort()).toEqual(
      [freshEvent.id, edgeEvent.id].sort(),
    );
    expect((await t.db.select().from(schema.linkUses)).map((row) => row.id).sort()).toEqual(
      [freshUse.id, edgeUse.id].sort(),
    );
    expect((await t.db.select().from(schema.linkFlags)).map((row) => row.id)).toEqual([flag.id]);

    // Nothing more to do: a second run deletes nothing.
    expect(await purgeCommunityRecords(t.db)).toEqual({ writeLimitEvents: 0, linkUses: 0 });
  });
});
