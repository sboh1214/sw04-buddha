/**
 * `media.orphan_cleanup` (#46, ADR-0073) on the docker `test` database: which uploads it removes
 * — those no post took within ORPHAN_MEDIA_HOURS, row and object — and which it leaves: a younger
 * one, one a post or a notice (#138) took, and one a post is taking at that moment (locked,
 * skipped). An object the store refuses to remove keeps its key queued (`media_deletions`) and a
 * later run removes it once the store lets it go — the key is never lost before then (Codex review
 * of #219, round 3) — and the hourly runs try it again 1, 2, 4 … hours after the run it was
 * refused on, however late in that run the refusal came. Skips when TEST_* are unset.
 */
import { schema, type Db } from '@buddha/db';
import {
  connectTestDb,
  createMarket,
  createMedia,
  createNotice,
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
import {
  ORPHAN_MEDIA_BATCH,
  ORPHAN_MEDIA_RETRY_MAX_HOURS,
  ORPHAN_MEDIA_RETRY_SLACK_MINUTES,
  orphanMediaRetryHours,
  removeOrphanMedia,
} from './media-orphan-cleanup.js';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** How long after the start of the run it was refused on the `attempts`-th refusal is due again. */
const retryMs = (attempts: number) =>
  orphanMediaRetryHours(attempts) * HOUR_MS - ORPHAN_MEDIA_RETRY_SLACK_MINUTES * MINUTE_MS;

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

  /** The keys queued for removal from the store, with what the runs recorded. */
  const queue = async () =>
    (await t.db.select().from(schema.mediaDeletions)).sort((a, b) =>
      a.storageKey.localeCompare(b.storageKey),
    );

  /** A run that removed `removed` objects of `queued` uploads it took, refusing nothing. */
  const clean = (queued: number, removed: number, pending = 0) => ({
    queued,
    removed,
    failed: 0,
    failures: [],
    pending,
  });

  it('removes the uploads no post took within the period, row and object, and nothing else', async () => {
    const orphan = await upload(ORPHAN_MEDIA_HOURS + 1);
    const young = await upload(ORPHAN_MEDIA_HOURS - 1);
    const taken = await upload(ORPHAN_MEDIA_HOURS + 5);
    const market = await createMarket(t.db);
    await createPost(t.db, { marketId: market.id, authorId: ownerId, imageIds: [taken.id] });

    expect(await removeOrphanMedia(t.db, storage)).toEqual(clean(1, 1));
    expect(await rows()).toEqual([young.id, taken.id].sort());
    expect(storage.objects.has(orphan.storageKey)).toBe(false);
    expect([...storage.objects.keys()].sort()).toEqual([young.storageKey, taken.storageKey].sort());
    // Removed from the store, so no longer queued.
    expect(await queue()).toEqual([]);
    // A run with nothing due removes nothing.
    expect(await removeOrphanMedia(t.db, storage)).toEqual(clean(0, 0));
  });

  it('leaves an upload a notice took, as one a post took (#138)', async () => {
    const taken = await upload(ORPHAN_MEDIA_HOURS + 5);
    await createNotice(t.db, { imageIds: [taken.id] });
    expect(await removeOrphanMedia(t.db, storage)).toEqual(clean(0, 0));
    expect(await queue()).toEqual([]);
    expect(await rows()).toEqual([taken.id]);
    expect(storage.objects.has(taken.storageKey)).toBe(true);
  });

  it('works through a backlog a batch at a time, oldest first', async () => {
    // Made out of age order — the youngest first — and run where no index may be used, so the
    // rows come in the table's own order: only the job's ORDER BY takes the two oldest. (The
    // planner would otherwise read the created_at index, whose order hides a missing ORDER BY.)
    const old = await upload(ORPHAN_MEDIA_HOURS + 1);
    const oldest = await upload(ORPHAN_MEDIA_HOURS + 3);
    const older = await upload(ORPHAN_MEDIA_HOURS + 2);
    expect(
      (await withoutIndexes((db) => removeOrphanMedia(db, storage, { batch: 2 }))).queued,
    ).toBe(2);
    expect(await rows()).toEqual([old.id]);
    expect(storage.objects.has(oldest.storageKey) || storage.objects.has(older.storageKey)).toBe(
      false,
    );
    expect(storage.objects.has(old.storageKey)).toBe(true);
    expect(await removeOrphanMedia(t.db, storage, { batch: 2 })).toEqual(clean(1, 1));
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
    expect(await removeOrphanMedia(t.db, storage)).toEqual(clean(0, 0));
    release();
    await holder;
    expect(await removeOrphanMedia(t.db, storage)).toEqual(clean(1, 1));
    expect(storage.objects.size).toBe(0);
  });

  it('keeps the key of an object the store refused to remove, and removes it on a later run once the store lets it go', async () => {
    const refused = await upload(ORPHAN_MEDIA_HOURS + 2);
    const removable = await upload(ORPHAN_MEDIA_HOURS + 1);
    // A store that fails for one key (a transient S3 error) — a moment into the run, as a real
    // refusal comes after the queue's transaction, the deletes before it and the SDK's own
    // retries — then succeeds.
    let failing = true;
    const remove = storage.delete.bind(storage);
    storage.delete = async (key) => {
      if (!failing || key !== refused.storageKey) return remove(key);
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error('SlowDown: please reduce your request rate');
    };

    const first = await removeOrphanMedia(t.db, storage);
    expect(first).toMatchObject({ queued: 2, removed: 1, failed: 1, pending: 1 });
    expect(first.failures).toEqual([
      {
        storageKey: refused.storageKey,
        attempts: 1,
        message: 'SlowDown: please reduce your request rate',
        err: expect.any(Error) as Error,
      },
    ]);
    // Both rows are gone (no post can take either upload any more), the refused object is still
    // in the store, and its key is the queue's — with the refusal and when to try again.
    expect(await rows()).toEqual([]);
    expect(storage.objects.has(refused.storageKey)).toBe(true);
    expect(storage.objects.has(removable.storageKey)).toBe(false);
    const [row] = await queue();
    expect(row).toMatchObject({
      storageKey: refused.storageKey,
      attempts: 1,
      lastError: 'SlowDown: please reduce your request rate',
    });
    // The wait counts from the run's start — before the key was queued — not from the refusal,
    // 50ms or more later: so the run an hour after this one tries it (below).
    const waitMs = row!.nextAttemptAt.getTime() - row!.queuedAt.getTime();
    expect(waitMs).toBeLessThanOrEqual(retryMs(1));
    expect(waitMs).toBeGreaterThan(retryMs(1) - MINUTE_MS);

    // Not due yet: the next run leaves it.
    expect(await removeOrphanMedia(t.db, storage)).toEqual(clean(0, 0, 1));

    // The store recovers: once due, the object goes and only then its key.
    failing = false;
    const due = new Date(row!.nextAttemptAt.getTime());
    expect(await removeOrphanMedia(t.db, storage, { at: due })).toEqual(clean(0, 1));
    expect(storage.objects.size).toBe(0);
    expect(await queue()).toEqual([]);
  });

  it('tries a refused key again on the hourly run its wait comes to — 1, 2, 4 … hours after the run it was refused on — never one later', async () => {
    const refused = await upload(ORPHAN_MEDIA_HOURS + 1);
    let failing = true;
    const remove = storage.delete.bind(storage);
    storage.delete = (key) =>
      failing ? Promise.reject(new Error('InternalError: please try again')) : remove(key);
    // The cron's runs, an hour apart from T; each run's time is what its start reads.
    const start = Date.now();
    const runAt = (hours: number, seconds = 0) => ({
      at: new Date(start + hours * HOUR_MS + seconds * 1000),
    });
    const refusedOn = async (hours: number, seconds = 0) =>
      (await removeOrphanMedia(t.db, storage, runAt(hours, seconds))).failures.map(
        (failure) => failure.attempts,
      );

    // T: queued and refused. The run an hour later — picked up 3s sooner after its :17 than this
    // one was — tries it (a second refusal); counted from the refusal, it would wait a run more.
    expect(await refusedOn(0)).toEqual([1]);
    expect(await refusedOn(1, -3)).toEqual([2]);
    // Twice the wait: not the run an hour later, the one after it.
    expect(await removeOrphanMedia(t.db, storage, runAt(2))).toEqual(clean(0, 0, 1));
    expect(await refusedOn(3)).toEqual([3]);
    // Four hours: not three, four.
    expect(await removeOrphanMedia(t.db, storage, runAt(6))).toEqual(clean(0, 0, 1));
    expect((await queue())[0]).toMatchObject({ storageKey: refused.storageKey, attempts: 3 });
    failing = false;
    expect(await removeOrphanMedia(t.db, storage, runAt(7))).toEqual(clean(0, 1));
    expect(storage.objects.has(refused.storageKey)).toBe(false);
    expect(await queue()).toEqual([]);
  });

  it('removes a queued key whose object is already gone (a run that stopped between the store and the queue)', async () => {
    // Due an hour ago (queued by a run that stopped then). Not the column's default `now()`: the
    // column rounds to the millisecond and the run's clock is read cut short to it, so a key
    // queued within the millisecond the run starts in can come due a fraction after the run's
    // time — and is the next run's.
    await t.db.insert(schema.mediaDeletions).values({
      storageKey: 'post-images/gone.webp',
      nextAttemptAt: new Date(Date.now() - HOUR_MS),
    });
    expect(await removeOrphanMedia(t.db, storage)).toEqual(clean(0, 1));
    expect(await queue()).toEqual([]);
  });

  it('tries at most a batch of queued keys a run, the longest due first', async () => {
    const keys = ['post-images/a.webp', 'post-images/b.webp', 'post-images/c.webp'];
    for (const [index, storageKey] of keys.entries()) {
      await storage.put(storageKey, new Uint8Array([index]), 'image/webp');
      await t.db.insert(schema.mediaDeletions).values({
        storageKey,
        // c is the longest due, then b, then a.
        nextAttemptAt: new Date(Date.now() - (index + 1) * HOUR_MS),
      });
    }
    expect(await removeOrphanMedia(t.db, storage, { batch: 2 })).toEqual(clean(0, 2, 1));
    expect([...storage.objects.keys()]).toEqual(['post-images/a.webp']);
    expect(await removeOrphanMedia(t.db, storage, { batch: 2 })).toEqual(clean(0, 1));
  });

  it('waits an hour after the first refusal, then twice as long each time, at most a day', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 30].map(orphanMediaRetryHours)).toEqual([
      1, 2, 4, 8, 16, 24, 24, 24,
    ]);
    expect(ORPHAN_MEDIA_RETRY_MAX_HOURS).toBe(24);
    // Room for a run picked up a little sooner after the hour's :17 than the one before, well
    // under the hour between runs.
    expect(ORPHAN_MEDIA_RETRY_SLACK_MINUTES).toBe(5);
  });
});
