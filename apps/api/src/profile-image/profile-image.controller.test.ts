/**
 * 프로필 이미지 (#141, ADR-0079; ADR-0069 decision 3 #37-6, decision 4 #141) against the docker
 * `test` profile: `PUT /me/profile-image` and `POST /me/profile-image/delete`, and where the image
 * shows. Pinned: the upload is the file itself, of an account that finished the onboarding, naming
 * the account the screen shows; it is stored as the server's own square — 512px at most, a smaller
 * one at its own size — without metadata, in the media store, attached from the start; the
 * profile, the bylines and `GET /me` carry its address, which `GET /media/:mediaId` serves to
 * anyone; replacing or deleting removes the earlier image at once — its row with the write, which
 * queues its object's key (`media_deletions`), its object right after the commit, so a slow store
 * holds no lock, and a store that will not remove it leaves the key queued for the worker, the
 * refusal counted and logged (owner decision 2026-10-22) — and its address stops; two writes of one
 * member take turns on the profile row; the deletion needs sign-in only; a social login's photo is
 * never shown; another account's cookie changes nothing. The upload goes the post images' hardened
 * way (#46, ADR-0073; ADR-0079 결정 9·10): refused unread before its body for a foreign page, no
 * session, a step of the onboarding left, a length over the limit, or — whatever its sender — a
 * body of a type the route does not take; one of the account's three uploads in flight — its post
 * images' and this together — until its conversion and store have settled; within the bytes the
 * process receives at once; cut after the idle time or past its deadline; held for the API's
 * memory, its body and its conversion; and its read holds a share of the image reads' budget and
 * waits for the memory too. The restriction's hook is public-items-sanctioned.test.ts's. Skips when
 * TEST_* are unset.
 */
import { type IncomingHttpHeaders, type ServerResponse, request as httpRequest } from 'node:http';
import { finished } from 'node:stream';
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createComment,
  createConsents,
  createMarket,
  createPost,
  createProfileImage,
} from '@buddha/db/test';
import {
  IMAGE_MAX_BYTES,
  ORPHAN_MEDIA_RETRY_SLACK_MINUTES,
  meSchema,
  orphanMediaRetryHours,
  postImageNotUsableMessage,
  type Me,
  type PostAuthor,
} from '@buddha/shared';
import { Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { type LightMyRequestResponse } from 'fastify';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_BODY_LIMIT,
  IMAGE_UPLOADS_PER_ACCOUNT,
  IMAGE_UPLOAD_DEADLINE_SECONDS,
  IMAGE_UPLOAD_IDLE_SECONDS,
  IMAGE_UPLOAD_RECEIVING_BYTES,
  imageUploadDeadline,
  imageUploadIdle,
  imageUploadsInFlight,
  imageUploadsReceiving,
} from '../media/image-body.js';
import {
  IMAGE_READ_BUDGET_BYTES,
  IMAGE_READ_BUSY_RETRY_SECONDS,
  imageReads,
} from '../media/image-reads.js';
import {
  IMAGE_BUSY_RETRY_SECONDS,
  IMAGE_CONVERSION_PEAK_BYTES,
  OneAtATime,
  imageConversions,
} from '../media/image.js';
import { memoryAdmission, memoryWaits } from '../media/memory-admission.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { SESSION_COOKIE } from '../openapi/document.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { failInserts } from '../test/fail-inserts.js';
import { hasTestInfra } from '../test/setup-env.js';
import { waitForLockWaiter } from '../test/wait.js';
import { ProfileImageService } from './profile-image.service.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

const MiB = 1024 * 1024;

const photo = (width = 64, height = 48) =>
  sharp({ create: { width, height, channels: 3, background: '#3366cc' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'where-and-when' } })
    .toBuffer();
const png = () =>
  sharp({ create: { width: 10, height: 10, channels: 4, background: '#00000000' } })
    .png()
    .toBuffer();

describe.skipIf(!hasTestInfra)('/api/v1/me/profile-image (integration)', () => {
  let t: TestApp;
  let member: TestUser;

  beforeAll(async () => {
    // Listening too: the upload path's specs send a body a piece at a time, or hang up mid-way,
    // which needs a socket (`inject` sends its whole payload at once).
    t = await createTestApp({ listen: true });
    // The specs run without a ceiling unless they stub the RSS (`stubMemory`), as #46's do.
    memoryAdmission.configure({ ceilingBytes: null });
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    member = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: member.id });
  });
  afterEach(async () => {
    imageUploadIdle.ms = IMAGE_UPLOAD_IDLE_SECONDS * 1000;
    imageUploadDeadline.ms = IMAGE_UPLOAD_DEADLINE_SECONDS * 1000;
    // Every upload a spec began has given its share back and left its account's uploads in flight,
    // and every share of the API's memory is back.
    await vi.waitFor(() => {
      expect(imageUploadsReceiving.size).toBe(0);
      expect(imageUploadsInFlight.size).toBe(0);
      expect(memoryAdmission.heldBytes).toBe(0);
      expect(memoryAdmission.waitingCount).toBe(0);
    });
    memoryAdmission.configure({ ceilingBytes: null });
    memoryWaits.uploadMs = 10_000;
    memoryWaits.conversionMs = 10_000;
    memoryWaits.readMs = 2_000;
  });

  /**
   * The API's memory as the admission reads it from now on (owner decision 2026-10-22 answer 3, as
   * #46's specs stub it): `resident` MiB under a ceiling of 416 — the api container's.
   */
  function stubMemory(resident: number): { set: (mib: number) => void } {
    let now = resident * MiB;
    memoryAdmission.configure({ ceilingBytes: 416 * MiB, resident: () => now });
    return {
      set: (mib) => {
        now = mib * MiB;
      },
    };
  }

  const upload = (
    body: Buffer | string,
    options: {
      who?: TestUser | null;
      type?: string;
      expected?: string | null;
      origin?: string;
    } = {},
  ) => {
    const who = options.who === undefined ? member : options.who;
    const expected = options.expected === undefined ? who?.id : options.expected;
    return t.app.inject({
      method: 'PUT',
      url: `/api/v1/me/profile-image${expected === null || expected === undefined ? '' : `?expectedAccountId=${encodeURIComponent(expected)}`}`,
      headers: {
        origin: options.origin ?? TRUSTED_ORIGIN,
        'content-type': options.type ?? 'image/jpeg',
        ...(who ? { cookie: who.cookie } : {}),
      },
      payload: body,
    });
  };

  const remove = (who: TestUser = member, expected: string = who.id) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/me/profile-image/delete',
      headers: { origin: TRUSTED_ORIGIN, 'content-type': 'application/json', cookie: who.cookie },
      payload: JSON.stringify({ expectedAccountId: expected }),
    });

  const read = (url: string, headers: Record<string, string> = {}) =>
    t.app.inject({ method: 'GET', url, headers });

  /** The answer's `Me`, parsed. */
  const meOf = (res: { statusCode: number; body: string; json: <T>() => T }): Me => {
    expect(res.statusCode, res.body).toBe(200);
    return meSchema.parse(res.json<{ data: unknown }>().data);
  };

  const mediaRows = () => t.db.select().from(schema.mediaObjects);
  const deletions = () => t.db.select().from(schema.mediaDeletions);
  const imageIdOf = async (userId: string = member.id) =>
    (
      await t.db
        .select({ imageId: schema.profiles.imageId })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, userId))
    )[0]?.imageId;
  const publicIdOf = async (userId: string = member.id) =>
    (
      await t.db
        .select({ publicId: schema.profiles.publicId })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, userId))
    )[0]!.publicId;

  // ---- upload -------------------------------------------------------------------------------

  it('stores the upload as the member’s profile image: a square of its own type, 512px at most and a smaller one at its own size, without metadata, attached from the start', async () => {
    const me = meOf(await upload(await photo(800, 600)));
    const [row] = await mediaRows();
    expect(row).toMatchObject({
      ownerId: member.id,
      kind: 'profile_image',
      storageKey: `profile-images/${row!.id}.jpg`,
      contentType: 'image/jpeg',
      width: 512,
      height: 512,
    });
    // The profile's from the start: the orphan clean-up, which takes unattached uploads, never
    // reaches it.
    expect(row!.attachedAt).not.toBeNull();
    expect(await imageIdOf()).toBe(row!.id);
    expect(me.profile.imageUrl).toBe(`/api/v1/media/${row!.id}`);
    const stored = t.storage.objects.get(row!.storageKey);
    expect(stored?.contentType).toBe('image/jpeg');
    expect(stored?.body.length).toBe(row!.byteSize);
    const metadata = await sharp(stored!.body).metadata();
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 512, height: 512 });
    expect(metadata.exif).toBeUndefined();
    expect(Buffer.from(stored!.body).includes('where-and-when')).toBe(false);
    // GET /me says the same.
    const again = meOf(await read('/api/v1/me', { cookie: member.cookie }));
    expect(again.profile.imageUrl).toBe(me.profile.imageUrl);

    // A smaller upload is never enlarged (owner decision 2026-10-22): its middle square at its
    // own size — 64×48 is stored 48×48.
    meOf(await upload(await photo(64, 48)));
    const [small] = await mediaRows();
    expect(small).toMatchObject({ width: 48, height: 48 });
    const smallBytes = t.storage.objects.get(small!.storageKey)!.body;
    const smallSize = await sharp(smallBytes).metadata();
    expect({ width: smallSize.width, height: smallSize.height }).toEqual({ width: 48, height: 48 });
  });

  it('serves the image to anyone, revalidated on every use, and shows it on the profile and the bylines', async () => {
    const market = await createMarket(t.db);
    const post = await createPost(t.db, { marketId: market.id, authorId: member.id });
    const comment = await createComment(t.db, { postId: post.id, authorId: member.id });
    await createComment(t.db, { postId: post.id, authorId: member.id, parentId: comment.id });
    const { imageUrl } = meOf(await upload(await png(), { type: 'image/png' })).profile;
    const imageId = imageUrl!.split('/').at(-1)!;

    const res = await read(imageUrl!);
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      'content-type': 'image/png',
      'cache-control': 'public, no-cache',
      etag: `"${imageId}"`,
    });
    // The 10×10 PNG kept at its own size (never enlarged, owner decision 2026-10-22).
    expect((await sharp(res.rawPayload).metadata()).width).toBe(10);
    expect((await read(imageUrl!, { 'if-none-match': `"${imageId}"` })).statusCode).toBe(304);

    // Every public face of the member carries the same address (ADR-0069 decision 5, #37-6).
    const faces = await publicFaces(post.id, market.id);
    expect(faces).toEqual(faces.map(() => expect.objectContaining({ imageUrl }) as unknown));
    expect(faces).toHaveLength(7);
  });

  /**
   * The member's face on every public route that shows a person (`showsPerson`): the profile, the
   * community list, the post page, its comments — a 댓글 and the first page of its 대댓글, read in
   * one LATERAL query (#48) — the 대댓글 page of '답글 더 보기' (#48) and the 토론 of the post's
   * market (#47). Without a 댓글 with a 대댓글, the first five.
   */
  async function publicFaces(postId: string, marketId: string): Promise<PostAuthor[]> {
    const profile = await read(`/api/v1/profiles/${await publicIdOf()}`);
    const list = await read('/api/v1/posts');
    const page = await read(`/api/v1/posts/${postId}`);
    const comments = await read(`/api/v1/posts/${postId}/comments`);
    const discussion = await read(`/api/v1/markets/${marketId}/posts`);
    const [thread] = comments.json<{
      data: { comment: { id: string; author: PostAuthor }; replies: { author: PostAuthor }[] }[];
    }>().data;
    const faces = [
      profile.json<{ data: { member: PostAuthor } }>().data.member,
      list.json<{ data: { author: PostAuthor }[] }>().data[0]!.author,
      page.json<{ data: { author: PostAuthor } }>().data.author,
      thread!.comment.author,
      discussion.json<{ data: { author: PostAuthor }[] }>().data[0]!.author,
    ];
    if (thread!.replies.length === 0) return faces;
    const replies = await read(`/api/v1/comments/${thread!.comment.id}/replies`);
    return [
      ...faces,
      thread!.replies[0]!.author,
      replies.json<{ data: { author: PostAuthor }[] }>().data[0]!.author,
    ];
  }

  it('serves no image a profile does not name now: one kept for operators (#50) is nobody’s to read', async () => {
    // An earlier image whose row stays, as an operator's removal will leave it (#37-10), and the
    // member's image now — both with their objects.
    const kept = await createProfileImage(t.db, { userId: member.id });
    const current = await createProfileImage(t.db, { userId: member.id });
    for (const image of [kept, current]) {
      await t.storage.put(image.storageKey, await png(), image.contentType);
    }
    expect((await read(`/api/v1/media/${kept.id}`)).statusCode).toBe(404);
    expect((await read(`/api/v1/media/${kept.id}`, { cookie: member.cookie })).statusCode).toBe(
      404,
    );
    expect((await read(`/api/v1/media/${current.id}`)).statusCode).toBe(200);
    // The member's next upload removes its image now, and leaves the operators' one alone.
    meOf(await upload(await photo()));
    const ids = (await mediaRows()).map((row) => row.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(current.id);
    expect(t.storage.objects.has(kept.storageKey)).toBe(true);
    expect(t.storage.objects.has(current.storageKey)).toBe(false);
  });

  it('replaces: a new address, and the earlier image removed at once, row and object', async () => {
    const first = meOf(await upload(await photo())).profile.imageUrl!;
    const [firstRow] = await mediaRows();
    const second = meOf(await upload(await png(), { type: 'image/png' })).profile.imageUrl!;
    expect(second).not.toBe(first);
    const rows = await mediaRows();
    expect(rows.map((row) => row.id)).toEqual([second.split('/').at(-1)]);
    expect(rows[0]!.storageKey).toMatch(/^profile-images\/.+\.png$/);
    expect(t.storage.objects.has(firstRow!.storageKey)).toBe(false);
    expect([...t.storage.objects.keys()]).toEqual([rows[0]!.storageKey]);
    expect(await deletions()).toEqual([]);
    expect(await imageIdOf()).toBe(rows[0]!.id);
    expect((await read(first)).statusCode).toBe(404);
    expect((await read(first, { 'if-none-match': `"${firstRow!.id}"` })).statusCode).toBe(404);
    expect((await read(second)).statusCode).toBe(200);
  });

  /**
   * Runs `first` until it waits inside its transaction, holding the profile row's lock — at its
   * INSERT into media_objects, which a SHARE lock on the table blocks after its profile is locked
   * — then `second`, until it waits too (behind the profile lock; without that lock, at its own
   * write), then lets both go. Waits on Postgres, not on the clock: each step is reached for sure.
   */
  async function overlapped(
    first: () => Promise<LightMyRequestResponse>,
    second: () => Promise<LightMyRequestResponse>,
  ): Promise<[LightMyRequestResponse, LightMyRequestResponse]> {
    const blocker = await t.db.$client.connect();
    let a: Promise<LightMyRequestResponse> | undefined;
    let b: Promise<LightMyRequestResponse> | undefined;
    let released = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE media_objects IN SHARE MODE');
      a = first();
      await waitForLockWaiter(blocker, 'the first write, holding the profile');
      b = second();
      await waitForLockWaiter(blocker, 'the second write, behind it', 2);
      await blocker.query('COMMIT');
      released = true;
      return [await a, await b];
    } finally {
      if (!released) await blocker.query('ROLLBACK');
      blocker.release();
      await a?.catch(() => undefined);
      await b?.catch(() => undefined);
    }
  }

  it('takes two uploads that overlap in turn: the later replaces the earlier, and one image is left', async () => {
    meOf(await upload(await photo()));
    const [jpeg, image] = [await photo(), await png()];
    const [a, b] = await overlapped(
      () => upload(jpeg),
      () => upload(image, { type: 'image/png' }),
    );
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    // The second found the first's image as the one to remove: without the profile row's lock
    // both would have read the seeded image, and the first's would stay, named by no profile.
    const rows = await mediaRows();
    expect(rows.map((row) => row.contentType)).toEqual(['image/png']);
    expect(await imageIdOf()).toBe(rows[0]!.id);
    expect([...t.storage.objects.keys()]).toEqual([rows[0]!.storageKey]);
    expect(meOf(b).profile.imageUrl).toBe(`/api/v1/media/${rows[0]!.id}`);
  });

  it('takes an upload and a deletion that overlap in turn: the deletion removes the new image', async () => {
    meOf(await upload(await photo()));
    const image = await png();
    const [uploaded, deleted] = await overlapped(
      () => upload(image, { type: 'image/png' }),
      () => remove(),
    );
    expect(uploaded.statusCode).toBe(200);
    expect(meOf(deleted).profile.imageUrl).toBeNull();
    // Without the lock the deletion would clear the seeded image the upload had already let go of,
    // and the upload would then set its own: an image after a deletion that answered none.
    expect(await imageIdOf()).toBeNull();
    expect(await mediaRows()).toEqual([]);
    expect(t.storage.objects.size).toBe(0);
  });

  it('refuses what is not a JPEG, PNG or WebP, over 5MB or very thin, with its reason, and keeps the image it has', async () => {
    const kept = meOf(await upload(await photo())).profile.imageUrl;
    const reasonOf = (res: { statusCode: number; json: <T>() => T }) => ({
      status: res.statusCode,
      error: res.json<{ error: { code: string; details?: unknown } }>().error,
    });
    const gif = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#ff0000' },
    })
      .gif()
      .toBuffer();
    // A GIF is a post's type, not a profile image's — sent as itself or as a JPEG.
    for (const type of ['image/gif', 'image/jpeg']) {
      expect(reasonOf(await upload(gif, { type }))).toEqual({
        status: 422,
        error: {
          code: 'IMAGE_NOT_ALLOWED',
          message: expect.any(String) as unknown,
          details: { reason: 'type' },
        },
      });
    }
    const svg = await upload('<svg xmlns="http://www.w3.org/2000/svg"/>', { type: 'image/png' });
    expect(reasonOf(svg).error.details).toEqual({ reason: 'type' });
    const over = Buffer.alloc(IMAGE_MAX_BYTES + 1);
    over.set([0xff, 0xd8, 0xff]);
    expect(reasonOf(await upload(over)).error.details).toEqual({ reason: 'size' });
    const broken = (await photo()).subarray(0, 40);
    expect(reasonOf(await upload(broken)).error.details).toEqual({ reason: 'unreadable' });
    // Longer than 32 times its short side (owner decisions 2026-10-22: one bound, #46's), as for a
    // post's image.
    expect(reasonOf(await upload(await photo(330, 10))).error.details).toEqual({
      reason: 'pixels',
    });
    // An absurd body is cut by the parser (413), as for a post's image.
    expect((await upload(Buffer.alloc(IMAGE_BODY_LIMIT + 1))).statusCode).toBe(413);

    expect(meOf(await read('/api/v1/me', { cookie: member.cookie })).profile.imageUrl).toBe(kept);
    expect(await mediaRows()).toHaveLength(1);
    expect(t.storage.objects.size).toBe(1);
  });

  it('takes the file as the body only: JSON, another type or none is refused unread, and the image body is kept to the upload routes', async () => {
    const json = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/me/profile-image?expectedAccountId=${member.id}`,
      headers: {
        origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
        cookie: member.cookie,
      },
      payload: JSON.stringify({ image: 'data:image/png;base64,AAAA' }),
    });
    // Refused by the gate before the body is read (#46's, whatever the type — Fastify's own parsers
    // read JSON and text, but not here): the route takes its own types only.
    expect(json.statusCode).toBe(415);
    expect(json.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The body must be the image file itself',
        details: [{ path: [], message: expect.stringContaining('image/jpeg') as unknown }],
      },
    });
    for (const type of ['text/plain', 'application/pdf', 'multipart/form-data; boundary=x']) {
      const other = await upload('hello', { type });
      expect(other.statusCode).toBe(415);
      expect(other.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
    }
    const untyped = await t.app.inject({
      method: 'PUT',
      url: `/api/v1/me/profile-image?expectedAccountId=${member.id}`,
      headers: { origin: TRUSTED_ORIGIN, cookie: member.cookie },
      payload: await photo(),
    });
    expect(untyped.statusCode).toBe(415);
    // None of them took a place or a share.
    expect(imageUploadsInFlight.size).toBe(0);
    expect(imageUploadsReceiving.size).toBe(0);
    // The deletion takes JSON: an image body there is refused unread, as on every other route.
    const imageToDelete = await t.app.inject({
      method: 'POST',
      url: '/api/v1/me/profile-image/delete',
      headers: { origin: TRUSTED_ORIGIN, 'content-type': 'image/png', cookie: member.cookie },
      payload: Buffer.alloc(IMAGE_BODY_LIMIT + 1),
    });
    expect(imageToDelete.statusCode).toBe(415);
    expect(await mediaRows()).toEqual([]);
  });

  it('asks the client to send again when too many conversions are waiting, storing nothing', async () => {
    const run = vi
      .spyOn(imageConversions, 'run')
      .mockImplementationOnce((task) => new OneAtATime(-1).run(task));
    try {
      const res = await upload(await photo());
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe(String(IMAGE_BUSY_RETRY_SECONDS));
    } finally {
      run.mockRestore();
    }
    expect(await mediaRows()).toEqual([]);
    expect(t.storage.objects.size).toBe(0);
  });

  it('removes the earlier object after the commit: a slow store holds no lock on the profile', async () => {
    meOf(await upload(await photo()));
    const [before] = await mediaRows();
    let finish!: () => void;
    const stalled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const remove = t.storage.delete.bind(t.storage);
    const del = vi.spyOn(t.storage, 'delete').mockImplementationOnce(async (key) => {
      await stalled;
      await remove(key);
    });
    try {
      const pending = upload(await png(), { type: 'image/png' });
      await vi.waitFor(() => {
        expect(del).toHaveBeenCalledWith(before!.storageKey);
      });
      // While the store is still removing the earlier object, the write has committed: the profile
      // names the new image, the earlier row is gone — and the profile row is free for another
      // write (a removal inside the transaction would hold its lock, and a pooled connection, for
      // as long as the store takes).
      const rows = await mediaRows();
      expect(rows.map((row) => row.contentType)).toEqual(['image/png']);
      expect(await imageIdOf()).toBe(rows[0]!.id);
      // The earlier object's key was queued with the commit (`media_deletions`): were the API to
      // stop now, the worker would remove it.
      expect((await deletions()).map((row) => row.storageKey)).toEqual([before!.storageKey]);
      const bio = await t.app.inject({
        method: 'PUT',
        url: '/api/v1/me/bio',
        headers: {
          origin: TRUSTED_ORIGIN,
          'content-type': 'application/json',
          cookie: member.cookie,
        },
        payload: JSON.stringify({ bio: '느린 저장소', expectedAccountId: member.id }),
      });
      expect(bio.statusCode, bio.body).toBe(200);
      finish();
      expect((await pending).statusCode).toBe(200);
    } finally {
      finish();
      del.mockRestore();
    }
    expect([...t.storage.objects.keys()]).toEqual([(await mediaRows())[0]!.storageKey]);
    // Removed: its key has left the queue.
    expect(await deletions()).toEqual([]);
  });

  it('keeps the member’s change when the store will not remove the earlier object: its key stays queued for the worker, the refusal counted and logged (owner decision 2026-10-22)', async () => {
    meOf(await upload(await photo()));
    const [before] = await mediaRows();
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const del = vi.spyOn(t.storage, 'delete').mockRejectedValue(new Error('store down'));
    /** The queue's row of `storageKey`, with how long until the worker may try it, in minutes. */
    const queued = async (storageKey: string) => {
      const [row] = await t.db
        .select({
          attempts: schema.mediaDeletions.attempts,
          lastError: schema.mediaDeletions.lastError,
          dueInMinutes: sql<number>`round(extract(epoch from (${schema.mediaDeletions.nextAttemptAt} - now())) / 60)::int`,
        })
        .from(schema.mediaDeletions)
        .where(eq(schema.mediaDeletions.storageKey, storageKey));
      return row;
    };
    // The queue's first wait, less its slack (the worker's schedule, @buddha/shared): 55 minutes.
    const firstWait = orphanMediaRetryHours(1) * 60 - ORPHAN_MEDIA_RETRY_SLACK_MINUTES;
    try {
      // Replaced: the new image is the profile's, the earlier row is gone and its address stops;
      // its object stays in the store, named by no row — and its key stays queued, this refusal
      // counted as the first, so the worker's runs try it again (1, 2, 4 … hours, then daily).
      const replaced = meOf(await upload(await png(), { type: 'image/png' })).profile.imageUrl!;
      const [after] = await mediaRows();
      expect(after!.contentType).toBe('image/png');
      expect(await imageIdOf()).toBe(after!.id);
      expect((await read(`/api/v1/media/${before!.id}`)).statusCode).toBe(404);
      expect(t.storage.objects.has(before!.storageKey)).toBe(true);
      expect(await queued(before!.storageKey)).toEqual({
        attempts: 1,
        lastError: 'store down',
        dueInMinutes: firstWait,
      });
      // One string, the refusal's words in it (an object would lose an Error's message).
      expect(error).toHaveBeenCalledWith(
        `could not remove a replaced or deleted profile image; its key stays queued for the worker ${JSON.stringify(
          { storageKey: before!.storageKey, refusal: 'store down' },
        )}`,
      );
      // Deleted: the same.
      expect(meOf(await remove()).profile.imageUrl).toBeNull();
      expect(await mediaRows()).toEqual([]);
      expect((await read(replaced)).statusCode).toBe(404);
      expect(t.storage.objects.has(after!.storageKey)).toBe(true);
      expect(await queued(after!.storageKey)).toEqual({
        attempts: 1,
        lastError: 'store down',
        dueInMinutes: firstWait,
      });
      expect((await deletions()).map((row) => row.storageKey).sort()).toEqual(
        [before!.storageKey, after!.storageKey].sort(),
      );
    } finally {
      del.mockRestore();
      error.mockRestore();
    }
  });

  it('queues the earlier key with the commit, due for the worker only after the queue’s first wait: the API’s own try comes first', async () => {
    meOf(await upload(await photo()));
    const [before] = await mediaRows();
    // The store held while the API tries it: by then the write has committed with the key queued —
    // were the API to stop here (a deploy, a crash), the worker would remove it once due. Due only
    // after the first wait, so a run of the worker meanwhile does not race the API's own try.
    let finish!: () => void;
    const stalled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const remove = t.storage.delete.bind(t.storage);
    const del = vi.spyOn(t.storage, 'delete').mockImplementationOnce(async (key) => {
      await stalled;
      await remove(key);
    });
    try {
      const pending = upload(await png(), { type: 'image/png' });
      await vi.waitFor(() => {
        expect(del).toHaveBeenCalledWith(before!.storageKey);
      });
      const [row] = await deletions();
      expect(row).toMatchObject({ storageKey: before!.storageKey, attempts: 0, lastError: null });
      expect(row!.nextAttemptAt.getTime() - row!.queuedAt.getTime()).toBe(
        (orphanMediaRetryHours(1) * 60 - ORPHAN_MEDIA_RETRY_SLACK_MINUTES) * 60_000,
      );
      finish();
      expect((await pending).statusCode).toBe(200);
    } finally {
      finish();
      del.mockRestore();
    }
    expect(await deletions()).toEqual([]);
  });

  it('removes the new object again when the write does not commit, and keeps the image it has', async () => {
    meOf(await upload(await photo()));
    const [before] = await mediaRows();
    // The member is held back by a re-consent after the guard let the upload in and while its
    // object was being stored: the transaction asks the onboarding again and refuses.
    const store = t.storage.put.bind(t.storage);
    const put = vi.spyOn(t.storage, 'put').mockImplementationOnce(async (...args) => {
      await t.db.delete(schema.consentRecords).where(eq(schema.consentRecords.userId, member.id));
      await createConsents(t.db, { userId: member.id, versions: { terms: 'draft-1999-01-01' } });
      await store(...args);
    });
    try {
      const res = await upload(await png(), { type: 'image/png' });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('ONBOARDING_REQUIRED');
      expect(put).toHaveBeenCalledTimes(1);
    } finally {
      put.mockRestore();
    }
    expect(await mediaRows()).toEqual([before]);
    expect(await imageIdOf()).toBe(before!.id);
    expect([...t.storage.objects.keys()]).toEqual([before!.storageKey]);
    // Nothing removed, nothing queued: the image it has is still the profile's.
    expect(await deletions()).toEqual([]);
  });

  it('queues the new object’s key for the worker when its row cannot be written and the store refuses to remove it, and keeps the image it has (Codex 4th review on #219, ADR-0073 9-45)', async () => {
    meOf(await upload(await photo()));
    const [before] = await mediaRows();
    const failing = failInserts(t.db);
    const del = vi.spyOn(t.storage, 'delete').mockRejectedValueOnce(new Error('store unavailable'));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const res = await upload(await png(), { type: 'image/png' });
      // The write's failure is the answer, the queueing changes nothing of it.
      expect(res.statusCode).toBe(500);
      // The profile keeps its image; the object the upload stored is still there, named by no row …
      expect(await mediaRows()).toEqual([before]);
      expect(await imageIdOf()).toBe(before!.id);
      const [storageKey] = [...t.storage.objects.keys()].filter(
        (key) => key !== before!.storageKey,
      );
      expect(storageKey).toMatch(/^profile-images\/[0-9a-f-]{36}\.png$/);
      expect(t.storage.objects.size).toBe(2);
      expect(del).toHaveBeenCalledExactlyOnceWith(storageKey);
      // … and its key is queued, the store's refusal counted as the first, due at the next run
      // (not after the first wait, as a replaced image's key: no try of the API's comes first).
      const queued = await deletions();
      expect(queued).toEqual([
        expect.objectContaining({ storageKey, attempts: 1, lastError: 'store unavailable' }),
      ]);
      const { rows } = await t.db.execute<{ now: Date | string }>(sql`select now() as now`);
      expect(queued[0]!.nextAttemptAt.getTime()).toBeLessThanOrEqual(
        new Date(rows[0]!.now).getTime(),
      );
      // A warning names the key and the refusal; nothing went unrecorded.
      expect(warn).toHaveBeenCalledWith(
        `could not remove an unrecorded upload; queued its key ${JSON.stringify({
          storageKey,
          refusal: 'store unavailable',
        })}`,
      );
      expect(error.mock.calls.filter(([line]) => String(line).includes(storageKey!))).toEqual([]);
    } finally {
      failing.restore();
      del.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('logs the new object’s key with both failures when its row cannot be written, the store refuses to remove it and the key cannot be queued either (Codex 4th review on #219)', async () => {
    const failing = failInserts(t.db, true);
    const del = vi.spyOn(t.storage, 'delete').mockRejectedValueOnce(new Error('store unavailable'));
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const res = await upload(await photo());
      expect(res.statusCode).toBe(500);
      expect(await mediaRows()).toEqual([]);
      expect(await imageIdOf()).toBeNull();
      expect(await deletions()).toEqual([]);
      expect(t.storage.objects.size).toBe(1);
      const [storageKey] = [...t.storage.objects.keys()];
      expect(del).toHaveBeenCalledExactlyOnceWith(storageKey);
      // The one place the key is left: an error line, with why it is there, for an operator.
      expect(error).toHaveBeenCalledExactlyOnceWith(
        `could not remove an unrecorded upload, nor queue its key ${JSON.stringify({
          storageKey,
          refusal: 'store unavailable',
          queueing: 'queue insert failed',
        })}`,
      );
    } finally {
      failing.restore();
      del.mockRestore();
      error.mockRestore();
    }
  });

  it('is not a post’s image: a post refuses the profile image in its body', async () => {
    const market = await createMarket(t.db);
    meOf(await upload(await photo()));
    const [image] = await mediaRows();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: {
        origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
        cookie: member.cookie,
      },
      payload: JSON.stringify({
        marketId: market.id,
        body: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '사진' }] },
            { type: 'image', attrs: { mediaId: image!.id } },
          ],
        },
        expectedAccountId: member.id,
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { details: unknown } }>().error.details).toEqual([
      { path: ['body'], message: postImageNotUsableMessage(image!.id) },
    ]);
    expect(await imageIdOf()).toBe(image!.id);
  });

  // ---- delete -------------------------------------------------------------------------------

  it('deletes: the row and the object at once, the address stops, and every face draws the initial again', async () => {
    const market = await createMarket(t.db);
    const post = await createPost(t.db, { marketId: market.id, authorId: member.id });
    await createComment(t.db, { postId: post.id, authorId: member.id });
    const imageUrl = meOf(await upload(await photo())).profile.imageUrl!;
    const me = meOf(await remove());
    expect(me.profile.imageUrl).toBeNull();
    expect(await imageIdOf()).toBeNull();
    expect(await mediaRows()).toEqual([]);
    expect(t.storage.objects.size).toBe(0);
    // The key was queued with the deletion and has left the queue with the object.
    expect(await deletions()).toEqual([]);
    expect((await read(imageUrl)).statusCode).toBe(404);
    const faces = await publicFaces(post.id, market.id);
    expect(faces).toEqual(faces.map(() => expect.objectContaining({ imageUrl: null }) as unknown));
    // Nothing left to delete changes nothing.
    expect(meOf(await remove()).profile.imageUrl).toBeNull();
  });

  it('never shows a social login’s photo (#37-6)', async () => {
    // What a social login could have left in better-auth's `user.image` (ADR-0072 keeps none).
    await t.db
      .update(schema.user)
      .set({ image: 'https://lh3.googleusercontent.com/a/photo' })
      .where(eq(schema.user.id, member.id));
    const market = await createMarket(t.db);
    const post = await createPost(t.db, { marketId: market.id, authorId: member.id });
    await createComment(t.db, { postId: post.id, authorId: member.id });
    const faces = await publicFaces(post.id, market.id);
    expect(faces).toEqual(faces.map(() => expect.objectContaining({ imageUrl: null }) as unknown));
    expect(meOf(await read('/api/v1/me', { cookie: member.cookie })).profile.imageUrl).toBeNull();
  });

  // ---- who ----------------------------------------------------------------------------------

  it('is the member’s own: another account’s cookie, no session or a foreign page changes nothing', async () => {
    const other = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: other.id });
    const imageUrl = meOf(await upload(await photo())).profile.imageUrl;
    const before = await mediaRows();

    // The other account naming the member: refused before the file is looked at, or anything read.
    const replaced = await upload(await png(), { who: other, expected: member.id });
    expect(replaced.statusCode).toBe(403);
    expect(replaced.json<{ error: { details: unknown } }>().error.details).toEqual([
      { path: ['expectedAccountId'], message: expect.any(String) as unknown },
    ]);
    const deleted = await remove(other, member.id);
    expect(deleted.statusCode).toBe(403);
    // Without a session, or from a foreign page: refused before the body is read.
    const huge = Buffer.alloc(IMAGE_BODY_LIMIT + 1);
    expect((await upload(huge, { who: null, expected: member.id })).statusCode).toBe(401);
    expect((await upload(huge, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await upload(await photo(), { expected: null })).statusCode).toBe(400);

    expect(await mediaRows()).toEqual(before);
    expect(t.storage.objects.size).toBe(1);
    expect(meOf(await read('/api/v1/me', { cookie: member.cookie })).profile.imageUrl).toBe(
      imageUrl,
    );
    // Each account's own deletion touches its own image only.
    expect(meOf(await remove(other)).profile.imageUrl).toBeNull();
    expect(await mediaRows()).toEqual(before);
  });

  it('takes a new image from an account that finished the onboarding, and a deletion with sign-in only', async () => {
    const newcomer = await signUpTestUser(t);
    const early = await upload(await photo(), { who: newcomer });
    expect(early.statusCode).toBe(409);
    expect(early.json<{ error: { code: string } }>().error.code).toBe('ONBOARDING_REQUIRED');
    // A newcomer has nothing to delete: signed in is enough, and nothing changes.
    expect(meOf(await remove(newcomer)).profile.imageUrl).toBeNull();

    // A member held back by a re-consent (a revision that changed members' rights): no new image
    // until it agrees, but its image comes down with sign-in only (owner decision 2026-10-22: «재동의만
    // 남은 계정의 프로필 이미지 지우기 → 로그인만으로»).
    meOf(await upload(await photo()));
    await t.db.delete(schema.consentRecords).where(eq(schema.consentRecords.userId, member.id));
    await createConsents(t.db, { userId: member.id, versions: { terms: 'draft-1999-01-01' } });
    const replaced = await upload(await png(), { type: 'image/png' });
    expect(replaced.statusCode).toBe(409);
    expect(replaced.json<{ error: { code: string; details: unknown } }>().error).toMatchObject({
      code: 'ONBOARDING_REQUIRED',
      details: { steps: ['consent'] },
    });
    expect(await mediaRows()).toHaveLength(1);
    const me = meOf(await remove());
    expect(me.profile.imageUrl).toBeNull();
    expect(me.onboarding.completed).toBe(false);
    expect(await mediaRows()).toEqual([]);
    expect(t.storage.objects.size).toBe(0);
  });

  // ---- the upload path: #46's gate and bounds (ADR-0079 결정 9·10) ---------------------------

  interface RawAnswer {
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
  }

  /**
   * An upload over a real socket (`inject` sends its whole payload at once) — to
   * `PUT /me/profile-image`, or with `post` to `POST /media/images`, the account's other upload
   * route — its body announced at `length` (null: none, so Node sends it chunked) and only `first`
   * of it sent, by `who` (the member unless said), as `type` (`image/jpeg` unless said; null: no
   * Content-Type). The answer, and the request to send the rest on — or to hang up.
   */
  function rawUpload(
    length: number | null,
    first: Buffer,
    options: {
      who?: TestUser;
      cookie?: string | null;
      origin?: string | null;
      post?: boolean;
      type?: string | null;
    } = {},
  ): { request: ReturnType<typeof httpRequest>; answer: Promise<RawAnswer> } {
    const who = options.who ?? member;
    const origin = options.origin === undefined ? TRUSTED_ORIGIN : options.origin;
    const path = options.post === true ? '/api/v1/media/images' : '/api/v1/me/profile-image';
    const request = httpRequest(`${t.url!}${path}?expectedAccountId=${who.id}`, {
      method: options.post === true ? 'POST' : 'PUT',
      headers: {
        ...(options.type === null ? {} : { 'content-type': options.type ?? 'image/jpeg' }),
        ...(options.cookie === null ? {} : { cookie: options.cookie ?? who.cookie }),
        ...(origin === null ? {} : { origin }),
        ...(length === null ? {} : { 'content-length': String(length) }),
      },
    });
    // A hang-up of ours, or the API closing a connection it refused.
    request.on('error', () => undefined);
    const answer = new Promise<RawAnswer>((resolve) => {
      request.on('response', (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      });
    });
    request.write(first);
    return { request, answer };
  }

  /** `answer` if it comes within 3s, a failure otherwise: an answer that waited for the body. */
  async function beforeTheBody<T>(answer: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('no answer before the body was sent'));
      }, 3_000);
    });
    try {
      return await Promise.race([answer, waited]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A post's image of the member's, through `inject` — the account's other upload route. */
  const uploadPostImage = (body: Buffer) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/media/images?expectedAccountId=${member.id}`,
      headers: { origin: TRUSTED_ORIGIN, 'content-type': 'image/jpeg', cookie: member.cookie },
      payload: body,
    });

  /** The API's own side of every profile upload sent over a socket from now on, until `stop`. */
  function serverAnswers(): { answers: ServerResponse[]; stop: () => void } {
    const server = t.app.getHttpServer();
    const answers: ServerResponse[] = [];
    const seen = (request: { url?: string }, response: ServerResponse) => {
      if (request.url?.startsWith('/api/v1/me/profile-image') === true) answers.push(response);
    };
    server.on('request', seen);
    return { answers, stop: () => server.off('request', seen) };
  }

  /** Once the API has seen `response` end — its client gone. */
  const ended = (response: ServerResponse) =>
    new Promise<void>((resolve) => {
      finished(response, () => {
        resolve();
      });
    });

  it('refuses unread, before its body has come, a made-up cookie, a foreign page, an account with a step left and a length over the limit', async () => {
    // Each announced at the parser's limit (or past it) and only begun: were the body read first,
    // the answer would wait for the rest of it, which never comes.
    const newcomer = await signUpTestUser(t);
    const reconsent = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: reconsent.id });
    await t.db.delete(schema.consentRecords).where(eq(schema.consentRecords.userId, reconsent.id));
    await createConsents(t.db, { userId: reconsent.id, versions: { terms: 'draft-1999-01-01' } });
    const begun = Buffer.alloc(1024);
    const cases = [
      {
        sent: rawUpload(IMAGE_BODY_LIMIT, begun, { cookie: `${SESSION_COOKIE}=x`, origin: null }),
        want: { status: 401, code: 'UNAUTHENTICATED' },
      },
      {
        sent: rawUpload(IMAGE_BODY_LIMIT, begun, { origin: 'https://evil.example' }),
        want: { status: 403, code: 'FORBIDDEN' },
      },
      // The onboarding is asked before the body too (OnboardedGuard runs only after it): a new
      // account, and one held back by a re-consent.
      {
        sent: rawUpload(IMAGE_BODY_LIMIT, begun, { who: newcomer }),
        want: { status: 409, code: 'ONBOARDING_REQUIRED' },
      },
      {
        sent: rawUpload(IMAGE_BODY_LIMIT, begun, { who: reconsent }),
        want: { status: 409, code: 'ONBOARDING_REQUIRED' },
      },
      {
        sent: rawUpload(IMAGE_BODY_LIMIT + 1, begun),
        want: { status: 413, code: 'VALIDATION_ERROR' },
      },
    ];
    try {
      for (const { sent, want } of cases) {
        const res = await beforeTheBody(sent.answer);
        const { code } = (JSON.parse(res.body) as { error: { code: string } }).error;
        expect({ status: res.status, code }).toEqual(want);
      }
      // None was let in: no share of the budget taken, no place of the account's.
      expect(imageUploadsReceiving.size).toBe(0);
      expect(imageUploadsInFlight.size).toBe(0);
    } finally {
      for (const { sent } of cases) sent.request.destroy();
    }
    // A type no route reads is refused as on every route (415), unread.
    const pdf = await upload('%PDF-1.7', { type: 'application/pdf' });
    expect(pdf.statusCode).toBe(415);
    expect(pdf.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
    expect(await mediaRows()).toEqual([]);
  });

  it('checks the sender of a profile upload of any type before a parser reads its body, as a post image’s (#46, Codex review of #219, round 2)', async () => {
    // Bodies announced at 1KiB and only begun, of types Fastify's own parsers read (JSON, text),
    // of one no parser reads, and of none: were a body read first, the answer would wait for the
    // rest of it (which never comes).
    const types = ['application/json', 'text/plain', 'application/x-unknown', null];
    const newcomer = await signUpTestUser(t);
    const senders: {
      name: string;
      options: Parameters<typeof rawUpload>[2];
      status: number;
      code: string;
    }[] = [
      { name: 'anonymous', options: { cookie: null }, status: 401, code: 'UNAUTHENTICATED' },
      {
        name: 'a made-up cookie, no Origin',
        options: { cookie: `${SESSION_COOKIE}=x`, origin: null },
        status: 401,
        code: 'UNAUTHENTICATED',
      },
      {
        name: 'a foreign page',
        options: { origin: 'https://evil.example' },
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        name: 'an account with a step left',
        options: { who: newcomer },
        status: 409,
        code: 'ONBOARDING_REQUIRED',
      },
      { name: 'an account that may upload', options: {}, status: 415, code: 'VALIDATION_ERROR' },
    ];
    for (const sender of senders) {
      for (const type of types) {
        const { request, answer } = rawUpload(1024, Buffer.from('{"a":'), {
          ...sender.options,
          type,
        });
        try {
          const res = await beforeTheBody(answer);
          expect({ sender: sender.name, type, status: res.status }).toEqual({
            sender: sender.name,
            type,
            status: sender.status,
          });
          expect(JSON.parse(res.body)).toMatchObject({ error: { code: sender.code } });
          // Nothing held for it: neither a place among the account's three nor a share.
          expect(imageUploadsInFlight.size).toBe(0);
          expect(imageUploadsReceiving.size).toBe(0);
        } finally {
          request.destroy();
        }
      }
    }
    expect(await mediaRows()).toEqual([]);
  });

  it('refuses a profile upload’s body of a type the route does not take before it takes a place or a share: 415 with the account’s three or the budget full, and over the parser’s limit', async () => {
    const types = ['application/json', 'text/plain', null];
    const send = async (type: string | null, length = 1024) => {
      const { request, answer } = rawUpload(length, Buffer.from('{"a":'), { type });
      try {
        const res = await beforeTheBody(answer);
        const { error } = JSON.parse(res.body) as { error: { code: string } };
        return { type, status: res.status, code: error.code };
      } finally {
        request.destroy();
      }
    };
    const refusedForItsType = (type: string | null) => ({
      type,
      status: 415,
      code: 'VALIDATION_ERROR',
    });

    // The account's three in flight — post images' and profile images' alike: an image waits its
    // turn (429); the others are refused for their type all the same, never asking for a place.
    const three = Array.from({ length: IMAGE_UPLOADS_PER_ACCOUNT }, () =>
      imageUploadsInFlight.take(member.id),
    );
    try {
      expect(three).not.toContain(null);
      expect((await upload(await photo())).statusCode).toBe(429);
      for (const type of types) expect(await send(type)).toEqual(refusedForItsType(type));
    } finally {
      for (const leave of three) leave?.();
    }

    // The bytes received at once at the budget: alike, they never asked for a share.
    const all = imageUploadsReceiving.take(IMAGE_UPLOAD_RECEIVING_BYTES);
    try {
      expect(all).not.toBeNull();
      expect((await upload(await photo())).statusCode).toBe(429);
      for (const type of types) expect(await send(type)).toEqual(refusedForItsType(type));
    } finally {
      all?.();
    }

    // Announced over the parser's limit: refused for its type, not for its length (413).
    for (const type of types) {
      expect(await send(type, IMAGE_BODY_LIMIT + 1)).toEqual(refusedForItsType(type));
    }
    expect(await mediaRows()).toEqual([]);
  });

  it('counts a profile image among the account’s three uploads in flight, with its post images: a fourth of either is refused unread with Retry-After', async () => {
    const image = await photo();
    const half = Math.floor(image.length / 2);
    // The profile image and two post images, each only half sent.
    const three = [
      rawUpload(image.length, image.subarray(0, half)),
      rawUpload(image.length, image.subarray(0, half), { post: true }),
      rawUpload(image.length, image.subarray(0, half), { post: true }),
    ];
    let fourth: ReturnType<typeof rawUpload> | undefined;
    try {
      await vi.waitFor(() => {
        expect(imageUploadsInFlight.of(member.id)).toBe(IMAGE_UPLOADS_PER_ACCOUNT);
      });
      expect(imageUploadsReceiving.size).toBe(3 * image.length);
      // A fourth — a profile image or a post's — answered before its body, holding nothing.
      fourth = rawUpload(IMAGE_BODY_LIMIT, Buffer.alloc(1024));
      const busy = await beforeTheBody(fourth.answer);
      expect(busy.status).toBe(429);
      expect(busy.headers['retry-after']).toBe(String(IMAGE_BUSY_RETRY_SECONDS));
      expect(JSON.parse(busy.body)).toMatchObject({
        error: { code: 'RATE_LIMITED', details: { retryAfterSeconds: IMAGE_BUSY_RETRY_SECONDS } },
      });
      expect((await uploadPostImage(image)).statusCode).toBe(429);
      expect(imageUploadsInFlight.of(member.id)).toBe(3);
      // The profile image's body comes: stored, and its place is the account's again.
      three[0]!.request.end(image.subarray(half));
      const stored = await three[0]!.answer;
      expect(stored.status).toBe(200);
      await vi.waitFor(() => {
        expect(imageUploadsInFlight.of(member.id)).toBe(2);
      });
      expect((await upload(await png(), { type: 'image/png' })).statusCode).toBe(200);
    } finally {
      for (const { request } of three) request.destroy();
      fourth?.request.destroy();
    }
    // Hung up on: every place comes back.
    await vi.waitFor(() => {
      expect(imageUploadsInFlight.of(member.id)).toBe(0);
    });
  });

  it('receives a profile image within the process’s budget, a body of no declared length held at the parser’s limit: past the budget, refused unread with Retry-After', async () => {
    const image = await photo();
    const half = Math.floor(image.length / 2);
    // Sent chunked (owner decision 2026-10-21 answer 5): held at the most the parser reads.
    const chunked = rawUpload(null, image.subarray(0, half));
    let others: (() => void) | null = null;
    try {
      await vi.waitFor(() => {
        expect(imageUploadsReceiving.size).toBe(IMAGE_BODY_LIMIT);
      });
      // Other uploads hold the rest of the 64MiB: one more is refused before its body.
      others = imageUploadsReceiving.take(IMAGE_UPLOAD_RECEIVING_BYTES - IMAGE_BODY_LIMIT);
      expect(others).not.toBeNull();
      const full = await upload(await photo());
      expect(full.statusCode).toBe(429);
      expect(full.headers['retry-after']).toBe(String(IMAGE_BUSY_RETRY_SECONDS));
      expect(full.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
      others?.();
      others = null;
      // The chunked body ends: stored, its share back by the time it is answered.
      chunked.request.end(image.subarray(half));
      expect((await chunked.answer).status).toBe(200);
      expect(imageUploadsReceiving.size).toBe(0);
    } finally {
      others?.();
      chunked.request.destroy();
    }
    expect(await mediaRows()).toHaveLength(1);
  });

  it('cuts a profile upload whose body sends no byte for the idle time: answered 408, its share and its place back', async () => {
    // The owner's 30 seconds (owner decision 2026-10-21 answer 4), shortened for the spec.
    imageUploadIdle.ms = 300;
    const silent = rawUpload(IMAGE_BODY_LIMIT, Buffer.alloc(0));
    silent.request.flushHeaders();
    try {
      await vi.waitFor(() => {
        expect(imageUploadsReceiving.size).toBe(IMAGE_BODY_LIMIT);
      });
      const res = await silent.answer;
      expect(res.status).toBe(408);
      expect(res.headers.connection).toBe('close');
      expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      expect(imageUploadsReceiving.size).toBe(0);
      await vi.waitFor(() => {
        expect(imageUploadsInFlight.of(member.id)).toBe(0);
      });
    } finally {
      silent.request.destroy();
    }
    expect(await mediaRows()).toEqual([]);
  });

  it('cuts a profile upload whose whole body has not come by its deadline, however it trickles: answered 408, its share and its place back (#46, owner decision 2026-10-22 (2차) answer 1)', async () => {
    // The owner's 30 seconds and 2 minutes, shortened for the spec.
    imageUploadIdle.ms = 300;
    imageUploadDeadline.ms = 900;
    const image = await photo();
    // A piece every 100ms — never idle for 300 — and too many pieces to be all in by 900.
    const pieces = 30;
    const size = Math.ceil(image.length / pieces);
    const trickle = rawUpload(image.length, image.subarray(0, size));
    let answered = false;
    void trickle.answer.then(() => {
      answered = true;
    });
    const started = Date.now();
    try {
      await vi.waitFor(() => {
        expect(imageUploadsReceiving.size).toBe(image.length);
      });
      for (let sent = size; sent < image.length && !answered; sent += size) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (!answered) trickle.request.write(image.subarray(sent, sent + size));
      }
      const res = await trickle.answer;
      // Cut by the deadline, not by idling: it never stopped for 300ms, and not before 900.
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      expect(res.status).toBe(408);
      expect(res.headers.connection).toBe('close');
      expect(JSON.parse(res.body)).toMatchObject({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The whole file did not come within 0.9 seconds; send it again',
        },
      });
      expect(imageUploadsReceiving.size).toBe(0);
      await vi.waitFor(() => {
        expect(imageUploadsInFlight.of(member.id)).toBe(0);
      });
    } finally {
      trickle.request.destroy();
    }
    expect(await mediaRows()).toEqual([]);
    expect(await imageIdOf()).toBeNull();
  });

  it('holds a profile upload’s place until its conversion and store have settled, even when its client hangs up once its body is in', async () => {
    // The conversion held until let go: were the place given back when the client hangs up, an
    // account could keep the conversion queue full with uploads it never waits for.
    const real = imageConversions.run.bind(imageConversions);
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    const run = vi.spyOn(imageConversions, 'run').mockImplementation(async (task) => {
      await held;
      return real(task);
    });
    const server = serverAnswers();
    const image = await photo();
    const raw = rawUpload(image.length, image);
    try {
      raw.request.end();
      await vi.waitFor(() => {
        expect(run).toHaveBeenCalledTimes(1);
      });
      expect(imageUploadsReceiving.size).toBe(0);
      expect(imageUploadsInFlight.of(member.id)).toBe(1);
      expect(server.answers).toHaveLength(1);
      const gone = ended(server.answers[0]!);
      raw.request.destroy();
      await gone;
      // Its work goes on, and holds its place.
      expect(imageUploadsInFlight.of(member.id)).toBe(1);
      letGo();
      await vi.waitFor(() => {
        expect(imageUploadsInFlight.of(member.id)).toBe(0);
      });
    } finally {
      letGo();
      server.stop();
      raw.request.destroy();
      run.mockRestore();
    }
    // Stored all the same — its work had started before its client went: the member's image now.
    expect(await imageIdOf()).not.toBeNull();
    expect(await mediaRows()).toHaveLength(1);
  });

  it('stores nothing for a profile upload whose client went before its handler ran, its place back at once', async () => {
    // Read off the prototype as a function of its own (`real.call` gives it the guard back).
    const real = Reflect.get(OnboardedGuard.prototype, 'canActivate');
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    const guard = vi
      .spyOn(OnboardedGuard.prototype, 'canActivate')
      .mockImplementation(async function (this: OnboardedGuard, context) {
        if (first) {
          first = false;
          entered();
          await held;
        }
        return real.call(this, context);
      });
    const replaces = vi.spyOn(ProfileImageService.prototype, 'replace');
    const server = serverAnswers();
    const image = await photo();
    const raw = rawUpload(image.length, image);
    try {
      raw.request.end();
      await reached;
      expect(imageUploadsInFlight.of(member.id)).toBe(1);
      const response = server.answers[0]!;
      const gone = ended(response);
      raw.request.destroy();
      await gone;
      expect(imageUploadsInFlight.of(member.id)).toBe(0);
      letGo();
      await vi.waitFor(() => {
        expect(response.writableEnded).toBe(true);
      });
      expect(replaces).not.toHaveBeenCalled();
      expect(await mediaRows()).toEqual([]);
      expect(t.storage.objects.size).toBe(0);
    } finally {
      letGo();
      server.stop();
      raw.request.destroy();
      guard.mockRestore();
      replaces.mockRestore();
    }
    expect(meOf(await upload(image)).profile.imageUrl).not.toBeNull();
  });

  it('reads a profile image within the image reads’ budget, its row’s size held while it is read: past the budget, refused unread with Retry-After', async () => {
    const { imageUrl } = meOf(await upload(await png(), { type: 'image/png' })).profile;
    const [row] = await mediaRows();
    const getObject = t.storage.get.bind(t.storage);
    const held: number[] = [];
    const get = vi.spyOn(t.storage, 'get').mockImplementation((key, options) => {
      held.push(imageReads.size);
      return getObject(key, options);
    });
    try {
      const others = imageReads.take(IMAGE_READ_BUDGET_BYTES);
      expect(others).not.toBeNull();
      try {
        const busy = await read(imageUrl!);
        expect(busy.statusCode).toBe(429);
        expect(busy.headers['retry-after']).toBe(String(IMAGE_READ_BUSY_RETRY_SECONDS));
        expect(busy.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
        expect(get).not.toHaveBeenCalled();
      } finally {
        others?.();
      }
      const res = await read(imageUrl!);
      expect(res.statusCode).toBe(200);
      expect(held).toEqual([row!.byteSize]);
      await vi.waitFor(() => {
        expect(imageReads.size).toBe(0);
      });
    } finally {
      get.mockRestore();
    }
  });

  it('holds a profile upload for the API’s memory — its body unread, then its conversion — and refuses it past the wait with Retry-After, keeping the image it has (#46, owner decision 2026-10-22 answer 3)', async () => {
    const before = meOf(await upload(await photo())).profile.imageUrl;
    const [kept] = await mediaRows();
    // At the ceiling: the body waits unread, and is refused once its wait is over.
    const memory = stubMemory(416);
    memoryWaits.uploadMs = 300;
    const unread = await upload(await png(), { type: 'image/png' });
    expect(unread.statusCode).toBe(429);
    expect(unread.headers['retry-after']).toBe(String(IMAGE_BUSY_RETRY_SECONDS));
    expect(unread.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
    // A body fits, a conversion's IMAGE_CONVERSION_PEAK_BYTES does not (300 + 144 + 32 > 416):
    // read, then refused before anything is decoded or stored.
    memory.set(300);
    memoryWaits.uploadMs = 10_000;
    memoryWaits.conversionMs = 300;
    const unconverted = await upload(await png(), { type: 'image/png' });
    expect(unconverted.statusCode).toBe(429);
    expect(unconverted.headers['retry-after']).toBe(String(IMAGE_BUSY_RETRY_SECONDS));
    expect(await mediaRows()).toEqual([kept]);
    expect([...t.storage.objects.keys()]).toEqual([kept!.storageKey]);
    expect(
      meOf(
        await t.app.inject({
          method: 'GET',
          url: '/api/v1/me',
          headers: { cookie: member.cookie },
        }),
      ).profile.imageUrl,
    ).toBe(before);

    // Waiting, it goes on once room comes: the body asked for its length, the conversion for its
    // peak — as a post's image does.
    memoryWaits.conversionMs = 10_000;
    const image = await png();
    const admit = vi.spyOn(memoryAdmission, 'admit');
    try {
      const pending = upload(image, { type: 'image/png' });
      await vi.waitFor(() => {
        expect(memoryAdmission.waitingCount).toBe(1);
      });
      memory.set(200);
      expect(meOf(await pending).profile.imageUrl).not.toBe(before);
      expect(admit.mock.calls.map(([bytes, { kind }]) => [bytes, kind])).toEqual([
        [image.length, 'body'],
        [IMAGE_CONVERSION_PEAK_BYTES, 'conversion'],
      ]);
    } finally {
      admit.mockRestore();
    }
  });

  it('holds a profile image’s read back while the API’s memory has no room for it: past the wait, refused unread with Retry-After (#46, owner decision 2026-10-22 answer 3)', async () => {
    const { imageUrl } = meOf(await upload(await png(), { type: 'image/png' })).profile;
    const [row] = await mediaRows();
    const memory = stubMemory(416);
    memoryWaits.readMs = 300;
    const get = vi.spyOn(t.storage, 'get');
    const admit = vi.spyOn(memoryAdmission, 'admit');
    try {
      const busy = await read(imageUrl!);
      expect(busy.statusCode).toBe(429);
      expect(busy.headers['retry-after']).toBe(String(IMAGE_READ_BUSY_RETRY_SECONDS));
      expect(busy.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
      expect(get).not.toHaveBeenCalled();
      // A revalidation holds nothing, and waits for nothing.
      expect((await read(imageUrl!, { 'if-none-match': `"${row!.id}"` })).statusCode).toBe(304);
      memoryWaits.readMs = 10_000;
      const pending = read(imageUrl!);
      await vi.waitFor(() => {
        expect(memoryAdmission.waitingCount).toBe(1);
      });
      memory.set(200);
      expect((await pending).statusCode).toBe(200);
      expect(admit.mock.calls.map(([bytes, { kind }]) => [bytes, kind])).toEqual([
        [row!.byteSize, 'read'],
        [row!.byteSize, 'read'],
      ]);
    } finally {
      admit.mockRestore();
      get.mockRestore();
    }
  });

  it('answers a profile image whose object is gone as not found, and a store that fails as a failure', async () => {
    // The member's image now, its object never stored: the store answers it is not there (S3's
    // NoSuchKey alone — @buddha/storage), and the read says so.
    const image = await createProfileImage(t.db, { userId: member.id });
    expect((await read(`/api/v1/media/${image.id}`)).statusCode).toBe(404);
    await t.storage.put(image.storageKey, await png(), image.contentType);
    // Any other failure of the store is not an image that is gone.
    const get = vi.spyOn(t.storage, 'get').mockRejectedValueOnce(new Error('store down'));
    try {
      expect((await read(`/api/v1/media/${image.id}`)).statusCode).toBe(500);
    } finally {
      get.mockRestore();
    }
    expect((await read(`/api/v1/media/${image.id}`)).statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(imageReads.size).toBe(0);
    });
  });
});
