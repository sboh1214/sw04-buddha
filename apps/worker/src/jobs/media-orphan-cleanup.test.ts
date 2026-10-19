/**
 * `media.orphan_cleanup` (#46, ADR-0073) on the docker `test` database: which uploads it removes
 * — those no post took within ORPHAN_MEDIA_HOURS, row and object — and which it leaves: a younger
 * one, one a post took, and one a post is taking at that moment (locked, skipped). Skips when
 * TEST_* are unset.
 */
import { schema, type Db } from '@buddha/db';
import {
  connectTestDb,
  createMarket,
  createMedia,
  createPost,
  createUser,
  hasTestDb,
  type TestDb,
} from '@buddha/db/test';
import { ORPHAN_MEDIA_HOURS } from '@buddha/shared';
import { MemoryObjectStorage } from '@buddha/storage';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ORPHAN_MEDIA_BATCH, removeOrphanMedia } from './media-orphan-cleanup.js';

const HOUR_MS = 60 * 60 * 1000;

describe.skipIf(!hasTestDb())('media.orphan_cleanup (integration)', () => {
  let t: TestDb;
  let storage: MemoryObjectStorage;
  let ownerId: string;

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    storage = new MemoryObjectStorage();
    ownerId = (await createUser(t.db)).user.id;
  });

  /** An upload of `hoursAgo` hours ago, its object in the store. */
  async function upload(hoursAgo: number) {
    const media = await createMedia(t.db, {
      ownerId,
      createdAt: new Date(Date.now() - hoursAgo * HOUR_MS),
    });
    await storage.put(media.storageKey, new Uint8Array([1, 2, 3]), media.contentType);
    return media;
  }

  /** `run` on one connection that may scan no index: rows come in the table's own order. */
  async function withoutIndexes<T>(run: (db: Db) => Promise<T>): Promise<T> {
    const client = await t.db.$client.connect();
    try {
      for (const setting of ['enable_indexscan', 'enable_indexonlyscan', 'enable_bitmapscan']) {
        await client.query(`SET ${setting} = off`);
      }
      return await run(drizzle(client, { schema, casing: 'snake_case' }) as unknown as Db);
    } finally {
      await client.query('RESET ALL');
      client.release();
    }
  }

  const rows = async () =>
    (await t.db.select({ id: schema.mediaObjects.id }).from(schema.mediaObjects))
      .map((row) => row.id)
      .sort();

  it('removes the uploads no post took within the period, row and object, and nothing else', async () => {
    const orphan = await upload(ORPHAN_MEDIA_HOURS + 1);
    const young = await upload(ORPHAN_MEDIA_HOURS - 1);
    const taken = await upload(ORPHAN_MEDIA_HOURS + 5);
    const market = await createMarket(t.db);
    await createPost(t.db, { marketId: market.id, authorId: ownerId, imageIds: [taken.id] });

    expect(await removeOrphanMedia(t.db, storage)).toEqual({ removed: 1, failed: 0, failures: [] });
    expect(await rows()).toEqual([young.id, taken.id].sort());
    expect(storage.objects.has(orphan.storageKey)).toBe(false);
    expect([...storage.objects.keys()].sort()).toEqual([young.storageKey, taken.storageKey].sort());
    // A run with nothing due removes nothing.
    expect(await removeOrphanMedia(t.db, storage)).toEqual({ removed: 0, failed: 0, failures: [] });
  });

  it('works through a backlog a batch at a time, oldest first', async () => {
    // Made out of age order — the youngest first — and run where no index may be used, so the
    // rows come in the table's own order: only the job's ORDER BY takes the two oldest. (The
    // planner would otherwise read the created_at index, whose order hides a missing ORDER BY.)
    const old = await upload(ORPHAN_MEDIA_HOURS + 1);
    const oldest = await upload(ORPHAN_MEDIA_HOURS + 3);
    const older = await upload(ORPHAN_MEDIA_HOURS + 2);
    expect((await withoutIndexes((db) => removeOrphanMedia(db, storage, 2))).removed).toBe(2);
    expect(await rows()).toEqual([old.id]);
    expect(storage.objects.has(oldest.storageKey) || storage.objects.has(older.storageKey)).toBe(
      false,
    );
    expect(storage.objects.has(old.storageKey)).toBe(true);
    expect((await removeOrphanMedia(t.db, storage, 2)).removed).toBe(1);
    expect(ORPHAN_MEDIA_BATCH).toBeGreaterThan(0);
  });

  it('passes over an upload a post is taking right now (locked), and removes it on a later run if it was not taken', async () => {
    const media = await upload(ORPHAN_MEDIA_HOURS + 1);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // A post's transaction holding the upload as PostsService.claimImages does.
    const holder = t.db.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.mediaObjects)
        .where(eq(schema.mediaObjects.id, media.id))
        .for('update');
      locked();
      await released;
    });
    await isLocked;
    expect(await removeOrphanMedia(t.db, storage)).toEqual({ removed: 0, failed: 0, failures: [] });
    release();
    await holder;
    expect(await removeOrphanMedia(t.db, storage)).toEqual({ removed: 1, failed: 0, failures: [] });
    expect(storage.objects.size).toBe(0);
  });
});
