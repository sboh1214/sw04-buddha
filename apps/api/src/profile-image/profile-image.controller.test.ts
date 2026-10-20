/**
 * 프로필 이미지 (#141, ADR-0079; ADR-0069 decision 3 #37-6, decision 4 #141) against the docker
 * `test` profile: `PUT /me/profile-image` and `POST /me/profile-image/delete`, and where the image
 * shows. Pinned: the upload is the file itself, of an account that finished the onboarding, naming
 * the account the screen shows; it is stored as the server's own square — 512px at most, a smaller
 * one at its own size — without metadata, in the media store, attached from the start; the
 * profile, the bylines and `GET /me` carry its address, which `GET /media/:mediaId` serves to
 * anyone; replacing or deleting removes the earlier image at once — its row with the write, its
 * object right after the commit, so a slow store holds no lock and a store that will not remove it
 * leaves unreachable bytes, logged — and its address stops; two writes of one member take turns on
 * the profile row; the deletion needs sign-in only; a social login's photo is never shown; another
 * account's cookie changes nothing. The restriction's hook is public-items-sanctioned.test.ts's.
 * Skips when TEST_* are unset.
 */
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
  meSchema,
  postImageNotUsableMessage,
  type Me,
  type PostAuthor,
} from '@buddha/shared';
import { Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type LightMyRequestResponse } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_BODY_LIMIT } from '../media/image-body.js';
import { IMAGE_BUSY_RETRY_SECONDS, OneAtATime, imageConversions } from '../media/image.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { waitForLockWaiter } from '../test/wait.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

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
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    member = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: member.id });
  });

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
    await createComment(t.db, { postId: post.id, authorId: member.id });
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
    const faces = await publicFaces(post.id);
    expect(faces).toEqual(faces.map(() => expect.objectContaining({ imageUrl }) as unknown));
    expect(faces).toHaveLength(4);
  });

  /** The member's face on the profile, the community list, the post page and its comments. */
  async function publicFaces(postId: string): Promise<PostAuthor[]> {
    const profile = await read(`/api/v1/profiles/${await publicIdOf()}`);
    const list = await read('/api/v1/posts');
    const page = await read(`/api/v1/posts/${postId}`);
    const comments = await read(`/api/v1/posts/${postId}/comments`);
    return [
      profile.json<{ data: { member: PostAuthor } }>().data.member,
      list.json<{ data: { author: PostAuthor }[] }>().data[0]!.author,
      page.json<{ data: { author: PostAuthor } }>().data.author,
      comments.json<{ data: { comment: { author: PostAuthor } }[] }>().data[0]!.comment.author,
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
    // Longer than 40 times its short side (owner decision 2026-10-22), as for a post's image.
    expect(reasonOf(await upload(await photo(410, 10))).error.details).toEqual({
      reason: 'pixels',
    });
    // An absurd body is cut by the parser (413), as for a post's image.
    expect((await upload(Buffer.alloc(IMAGE_BODY_LIMIT + 1))).statusCode).toBe(413);

    expect(meOf(await read('/api/v1/me', { cookie: member.cookie })).profile.imageUrl).toBe(kept);
    expect(await mediaRows()).toHaveLength(1);
    expect(t.storage.objects.size).toBe(1);
  });

  it('takes the file as the body only, and keeps the image body to the upload routes', async () => {
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
    expect(json.statusCode).toBe(400);
    expect(json.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
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
  });

  it('keeps the member’s change when the store will not remove the earlier object: the bytes stay, unreachable, and are logged', async () => {
    meOf(await upload(await photo()));
    const [before] = await mediaRows();
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const del = vi.spyOn(t.storage, 'delete').mockRejectedValue(new Error('store down'));
    try {
      // Replaced: the new image is the profile's, the earlier row is gone and its address stops;
      // its object stays in the store, which nothing names any more.
      const replaced = meOf(await upload(await png(), { type: 'image/png' })).profile.imageUrl!;
      const [after] = await mediaRows();
      expect(after!.contentType).toBe('image/png');
      expect(await imageIdOf()).toBe(after!.id);
      expect((await read(`/api/v1/media/${before!.id}`)).statusCode).toBe(404);
      expect(t.storage.objects.has(before!.storageKey)).toBe(true);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ storageKey: before!.storageKey }),
        'could not remove a replaced or deleted profile image',
      );
      // Deleted: the same.
      expect(meOf(await remove()).profile.imageUrl).toBeNull();
      expect(await mediaRows()).toEqual([]);
      expect((await read(replaced)).statusCode).toBe(404);
      expect(t.storage.objects.has(after!.storageKey)).toBe(true);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ storageKey: after!.storageKey }),
        'could not remove a replaced or deleted profile image',
      );
    } finally {
      del.mockRestore();
      error.mockRestore();
    }
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
    expect((await read(imageUrl)).statusCode).toBe(404);
    const faces = await publicFaces(post.id);
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
    const faces = await publicFaces(post.id);
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
});
