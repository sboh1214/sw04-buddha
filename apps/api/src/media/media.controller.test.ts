/**
 * 올린 이미지 (#46, ADR-0073) against the docker `test` profile: `POST /media/images` and
 * `GET /media/:mediaId`. Pinned: the upload is the file itself, open to an account that finished
 * the onboarding and naming the account the screen shows; the content decides the type and the
 * stored object is the server's own encoding without metadata; the read serves an image only
 * while a post shows it, to anyone, revalidated on every use, and holds no more images at once than
 * the process's budget; the upload bodies received at once stay within theirs (owner decision
 * 2026-10-21). Skips when TEST_* are unset.
 */
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  get as httpGet,
  request as httpRequest,
} from 'node:http';
import { schema } from '@buddha/db';
import { completeOnboarding, createMarket, createMedia, createPost } from '@buddha/db/test';
import { IMAGE_MAX_BYTES, uploadedImageSchema, type UploadedImage } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { SESSION_COOKIE } from '../openapi/document.js';
import { hasTestInfra } from '../test/setup-env.js';
import { ByteBudget } from './byte-budget.js';
import {
  IMAGE_BODY_LIMIT,
  IMAGE_UPLOAD_RECEIVING_BYTES,
  imageUploadsReceiving,
} from './image-body.js';
import {
  IMAGE_READ_BUDGET_BYTES,
  IMAGE_READ_BUSY_RETRY_SECONDS,
  imageReads,
} from './image-reads.js';
import { IMAGE_BUSY_RETRY_SECONDS, OneAtATime, imageConversions } from './image.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

const photo = () =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: '#3366cc' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'where-and-when' } })
    .toBuffer();
const png = () =>
  sharp({ create: { width: 10, height: 10, channels: 4, background: '#00000000' } })
    .png()
    .toBuffer();

describe.skipIf(!hasTestInfra)('/api/v1/media (integration)', () => {
  let t: TestApp;
  let author: TestUser;

  beforeAll(async () => {
    // Listening too: a client that goes away mid-read needs a socket (`inject` has none).
    t = await createTestApp({ listen: true });
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    author = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: author.id });
  });
  afterEach(async () => {
    // Every upload a spec began has given its share back (a request hung up on is let go at once).
    await vi.waitFor(() => {
      expect(imageUploadsReceiving.size).toBe(0);
    });
  });

  const upload = (
    body: Buffer | string,
    options: { who?: TestUser | null; type?: string; expected?: string | null } = {},
  ) => {
    const who = options.who === undefined ? author : options.who;
    const expected = options.expected === undefined ? who?.id : options.expected;
    return t.app.inject({
      method: 'POST',
      url: `/api/v1/media/images${expected === null || expected === undefined ? '' : `?expectedAccountId=${encodeURIComponent(expected)}`}`,
      headers: {
        origin: TRUSTED_ORIGIN,
        'content-type': options.type ?? 'image/jpeg',
        ...(who ? { cookie: who.cookie } : {}),
      },
      payload: body,
    });
  };

  const read = (mediaId: string, headers: Record<string, string> = {}) =>
    t.app.inject({ method: 'GET', url: `/api/v1/media/${mediaId}`, headers });

  interface RawAnswer {
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
  }

  /**
   * An upload over a real socket (`inject` sends its whole payload at once): its body announced at
   * `length` (null: none, so Node sends it chunked) and only `first` of it sent. The answer, and the
   * request to send the rest on — or to hang up.
   */
  function rawUpload(
    length: number | null,
    first: Buffer,
    options: { cookie?: string; origin?: string | null } = {},
  ): { request: ReturnType<typeof httpRequest>; answer: Promise<RawAnswer> } {
    const origin = options.origin === undefined ? TRUSTED_ORIGIN : options.origin;
    const request = httpRequest(`${t.url!}/api/v1/media/images?expectedAccountId=${author.id}`, {
      method: 'POST',
      headers: {
        'content-type': 'image/jpeg',
        cookie: options.cookie ?? author.cookie,
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

  const mediaRows = () => t.db.select().from(schema.mediaObjects);

  // ---- upload -------------------------------------------------------------------------------

  it('stores an upload as its own encoding, without its metadata, attached to nothing', async () => {
    const res = await upload(await photo());
    expect(res.statusCode).toBe(201);
    const image: UploadedImage = uploadedImageSchema.parse(res.json<{ data: unknown }>().data);
    expect(image).toMatchObject({ contentType: 'image/jpeg', width: 64, height: 48 });
    const [row] = await mediaRows();
    expect(row).toMatchObject({
      id: image.id,
      ownerId: author.id,
      kind: 'post_image',
      storageKey: `post-images/${image.id}.jpg`,
      contentType: 'image/jpeg',
      byteSize: image.byteSize,
      attachedAt: null,
    });
    const stored = t.storage.objects.get(row!.storageKey);
    expect(stored?.contentType).toBe('image/jpeg');
    expect(stored?.body.length).toBe(image.byteSize);
    const metadata = await sharp(stored!.body).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(Buffer.from(stored!.body).includes('where-and-when')).toBe(false);
  });

  it('decides the type by the content, not by the Content-Type it was sent with', async () => {
    const asOctets = await upload(await png(), { type: 'application/octet-stream' });
    expect(asOctets.statusCode).toBe(201);
    expect(asOctets.json<{ data: UploadedImage }>().data.contentType).toBe('image/png');
    // A PNG sent as a JPEG is still a PNG.
    const mislabelled = await upload(await png(), { type: 'image/jpeg' });
    expect(mislabelled.json<{ data: UploadedImage }>().data.contentType).toBe('image/png');
    // An SVG with a script, sent as a PNG, is no image here, and nothing is stored.
    const svg = await upload(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      {
        type: 'image/png',
      },
    );
    expect(svg.statusCode).toBe(422);
    expect(svg.json()).toEqual({
      error: {
        code: 'IMAGE_NOT_ALLOWED',
        message: expect.any(String) as unknown,
        details: { reason: 'type' },
      },
    });
    expect(await mediaRows()).toHaveLength(2);
    expect(t.storage.objects.size).toBe(2);
  });

  it('refuses a file over 5MB with its reason, and an absurd body before reading it', async () => {
    const over = Buffer.alloc(IMAGE_MAX_BYTES + 1);
    over.set([0xff, 0xd8, 0xff]);
    const res = await upload(over);
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { details: unknown } }>().error.details).toEqual({ reason: 'size' });
    const absurd = await upload(Buffer.alloc(IMAGE_MAX_BYTES * 2 + 1));
    expect(absurd.statusCode).toBe(413);
    expect(absurd.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
    expect(await mediaRows()).toEqual([]);
  });

  it('takes the file as the body only: JSON or another type is refused', async () => {
    const json = await t.app.inject({
      method: 'POST',
      url: `/api/v1/media/images?expectedAccountId=${author.id}`,
      headers: {
        origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
        cookie: author.cookie,
      },
      payload: JSON.stringify({ image: 'data:image/png;base64,AAAA' }),
    });
    expect(json.statusCode).toBe(400);
    expect(json.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
    // Fastify reads text itself, which the handler refuses; a type nobody reads is refused first.
    const text = await upload('hello', { type: 'text/plain' });
    expect(text.statusCode).toBe(400);
    expect(text.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
    const pdf = await upload('%PDF-1.7', { type: 'application/pdf' });
    expect(pdf.statusCode).toBe(415);
    expect(pdf.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
    expect(await mediaRows()).toEqual([]);
  });

  it('keeps the image body to the upload route, and refuses an anonymous or foreign one unread', async () => {
    // Over the parser's limit, so a 413 would mean the body had been read: every refusal below
    // comes first, from the gate ahead of the parser (image-body.ts).
    const huge = Buffer.alloc(IMAGE_BODY_LIMIT + 1);
    const elsewhere = await t.app.inject({
      method: 'POST',
      url: '/api/v1/posts',
      headers: { origin: TRUSTED_ORIGIN, 'content-type': 'application/octet-stream' },
      payload: huge,
    });
    expect(elsewhere.statusCode).toBe(415);
    expect(elsewhere.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
    // With a session too, and with parameters on the type: still no route but the upload's.
    const signedIn = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/posts/0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60',
      headers: {
        origin: TRUSTED_ORIGIN,
        'content-type': 'Image/PNG; charset=x',
        cookie: author.cookie,
      },
      payload: huge,
    });
    expect(signedIn.statusCode).toBe(415);
    const anonymous = await upload(huge, { who: null, expected: 'x' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
    // A made-up cookie and no Origin (no browser: curl, a script) names no session: refused
    // unread too, the session resolved through better-auth before the body (not the cookie's
    // presence alone).
    const madeUp = await t.app.inject({
      method: 'POST',
      url: `/api/v1/media/images?expectedAccountId=${author.id}`,
      headers: { 'content-type': 'image/jpeg', cookie: `${SESSION_COOKIE}=x` },
      payload: huge,
    });
    expect(madeUp.statusCode).toBe(401);
    expect(madeUp.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
    // A real session of an account with a step left is refused unread as well.
    const newcomer = await signUpTestUser(t);
    const early = await upload(huge, { who: newcomer });
    expect(early.statusCode).toBe(409);
    expect(early.json<{ error: { code: string } }>().error.code).toBe('ONBOARDING_REQUIRED');
    const foreign = await t.app.inject({
      method: 'POST',
      url: `/api/v1/media/images?expectedAccountId=${author.id}`,
      headers: {
        origin: 'https://evil.example',
        'content-type': 'image/jpeg',
        cookie: author.cookie,
      },
      payload: huge,
    });
    expect(foreign.statusCode).toBe(403);
    // The upload route itself refuses it by its declared length (413, unread too — below).
    expect((await upload(huge)).statusCode).toBe(413);
    expect(await mediaRows()).toEqual([]);
  });

  it('answers a made-up cookie before the body has come', async () => {
    // A real socket, the body announced at the parser's limit and only begun: were the body read
    // first, the answer would wait for the rest of it (which never comes).
    const { request, answer } = rawUpload(IMAGE_BODY_LIMIT, Buffer.alloc(1024), {
      cookie: `${SESSION_COOKIE}=x`,
      origin: null,
    });
    try {
      const res = await beforeTheBody(answer);
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    } finally {
      request.destroy();
    }
  });

  it('refuses unread an upload that declares no length, or one over the limit', async () => {
    // Sent chunked: what it would hold is not known before it has all come.
    const chunked = rawUpload(null, Buffer.alloc(1024));
    // Announced past the parser's limit: refused by that length, as Fastify itself would.
    const over = rawUpload(IMAGE_BODY_LIMIT + 1, Buffer.alloc(1024));
    try {
      const noLength = await beforeTheBody(chunked.answer);
      expect(noLength.status).toBe(411);
      expect(JSON.parse(noLength.body)).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      const tooLong = await beforeTheBody(over.answer);
      expect(tooLong.status).toBe(413);
      expect(JSON.parse(tooLong.body)).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      // Neither took a share of the uploads being received.
      expect(imageUploadsReceiving.size).toBe(0);
    } finally {
      chunked.request.destroy();
      over.request.destroy();
    }
    expect(await mediaRows()).toEqual([]);
  });

  it('receives no more upload bytes at once than the process’s budget: past it, refused unread with Retry-After', async () => {
    // Six uploads announced at the parser's limit and only begun: 60MiB on its way, held while it
    // comes (owner decision 2026-10-21: 64MiB).
    const held = Array.from({ length: 6 }, () => rawUpload(IMAGE_BODY_LIMIT, Buffer.alloc(1024)));
    const others: ReturnType<typeof rawUpload>[] = [];
    try {
      await vi.waitFor(() => {
        expect(imageUploadsReceiving.size).toBe(6 * IMAGE_BODY_LIMIT);
      });
      // A seventh as large would pass 64MiB: answered at once, its body never read.
      const seventh = rawUpload(IMAGE_BODY_LIMIT, Buffer.alloc(1024));
      others.push(seventh);
      const busy = await beforeTheBody(seventh.answer);
      expect(busy.status).toBe(429);
      expect(busy.headers['retry-after']).toBe(String(IMAGE_BUSY_RETRY_SECONDS));
      expect(JSON.parse(busy.body)).toMatchObject({
        error: { code: 'RATE_LIMITED', details: { retryAfterSeconds: IMAGE_BUSY_RETRY_SECONDS } },
      });
      expect(imageUploadsReceiving.size).toBe(6 * IMAGE_BODY_LIMIT);
      // A photo fits beside them, and gives its share back once its body is in.
      const fits = await upload(await photo());
      expect(fits.statusCode).toBe(201);
      expect(imageUploadsReceiving.size).toBe(6 * IMAGE_BODY_LIMIT);
      // One that fills the budget to the byte is taken; past that, even a photo waits.
      const rest = IMAGE_UPLOAD_RECEIVING_BYTES - 6 * IMAGE_BODY_LIMIT;
      others.push(rawUpload(rest, Buffer.alloc(1024)));
      await vi.waitFor(() => {
        expect(imageUploadsReceiving.size).toBe(IMAGE_UPLOAD_RECEIVING_BYTES);
      });
      const full = await upload(await photo());
      expect(full.statusCode).toBe(429);
      expect(full.headers['retry-after']).toBe(String(IMAGE_BUSY_RETRY_SECONDS));
      expect(full.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
      expect(await mediaRows()).toHaveLength(1);
    } finally {
      for (const { request } of [...held, ...others]) request.destroy();
    }
    // Hung up on mid-body: every share comes back, and uploads are taken again.
    await vi.waitFor(() => {
      expect(imageUploadsReceiving.size).toBe(0);
    });
    expect((await upload(await photo())).statusCode).toBe(201);
  });

  it('gives an upload’s share back once its body is in, or once its client has gone mid-body', async () => {
    const image = await photo();
    const half = Math.floor(image.length / 2);
    const sent = rawUpload(image.length, image.subarray(0, half));
    const dropped = rawUpload(IMAGE_BODY_LIMIT, Buffer.alloc(1024));
    try {
      // Both are held while their bodies come.
      await vi.waitFor(() => {
        expect(imageUploadsReceiving.size).toBe(image.length + IMAGE_BODY_LIMIT);
      });
      // The client goes before the rest of its body: its share comes back.
      dropped.request.destroy();
      await vi.waitFor(() => {
        expect(imageUploadsReceiving.size).toBe(image.length);
      });
      // The rest of the other comes: stored, its share back by the time it is answered.
      sent.request.end(image.subarray(half));
      const res = await sent.answer;
      expect(res.status).toBe(201);
      expect(
        uploadedImageSchema.safeParse((JSON.parse(res.body) as { data: unknown }).data).success,
      ).toBe(true);
      expect(imageUploadsReceiving.size).toBe(0);
    } finally {
      sent.request.destroy();
      dropped.request.destroy();
    }
    expect(await mediaRows()).toHaveLength(1);
  });

  it('gives an upload’s share back as soon as its body is in, while it still waits for its conversion', async () => {
    // The conversion held until let go: the upload is answered only after it. Were the share given
    // back only when the answer ends (`stream.finished`), it would be held all this while — through
    // the conversion queue's wait (owner decision 2026-10-21 answer 1: given back once the body is
    // in). Checked once the answer has ended, the two cannot be told apart.
    const real = imageConversions.run.bind(imageConversions);
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const run = vi.spyOn(imageConversions, 'run').mockImplementation(async (task) => {
      entered();
      await held;
      return real(task);
    });
    const image = await photo();
    // Through `inject`, and over a real socket with its whole body sent.
    const injected = upload(image);
    const raw = rawUpload(image.length, image);
    try {
      raw.request.end();
      await waiting;
      await vi.waitFor(() => {
        expect(run).toHaveBeenCalledTimes(2);
      });
      // Both bodies are the handler's now: nothing of them is held as being received.
      expect(imageUploadsReceiving.size).toBe(0);
      letGo();
      expect((await injected).statusCode).toBe(201);
      expect((await raw.answer).status).toBe(201);
    } finally {
      letGo();
      raw.request.destroy();
      run.mockRestore();
    }
    expect(await mediaRows()).toHaveLength(2);
  });

  it('holds an upload’s share by its declared length alone, for as long as its connection stays open', async () => {
    // Today's behaviour, an open question to the owner (ADR-0073 결과 4): the share is taken before
    // a byte of the body has come, and nothing times out a body that never comes — the server has
    // no request or connection timeout (Fastify 5's 0; main.ts sets neither, as this app does not).
    const server = t.app.getHttpServer();
    expect(server.requestTimeout).toBe(0);
    expect(server.timeout).toBe(0);
    const idle = rawUpload(IMAGE_BODY_LIMIT, Buffer.alloc(0));
    idle.request.flushHeaders();
    try {
      await vi.waitFor(() => {
        expect(imageUploadsReceiving.size).toBe(IMAGE_BODY_LIMIT);
      });
      // No body byte sent, none coming: still held.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(imageUploadsReceiving.size).toBe(IMAGE_BODY_LIMIT);
    } finally {
      idle.request.destroy();
    }
    // Only the connection's end gives it back.
    await vi.waitFor(() => {
      expect(imageUploadsReceiving.size).toBe(0);
    });
  });

  it('removes the stored object when its row cannot be written', async () => {
    const insert = t.db.insert.bind(t.db);
    const spy = vi.spyOn(t.db, 'insert').mockImplementation((table) => {
      if (table === schema.mediaObjects) throw new Error('insert failed');
      return insert(table);
    });
    try {
      const res = await upload(await photo());
      expect(res.statusCode).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await mediaRows()).toEqual([]);
    expect(t.storage.objects.size).toBe(0);
  });

  it('asks the client to send again when too many conversions are waiting, storing nothing', async () => {
    // The queue's own refusal, as a full queue gives it (none may wait behind none).
    const run = vi
      .spyOn(imageConversions, 'run')
      .mockImplementationOnce((task) => new OneAtATime(-1).run(task));
    try {
      const res = await upload(await photo());
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe(String(IMAGE_BUSY_RETRY_SECONDS));
      expect(res.json<{ error: { code: string; details: unknown } }>().error).toMatchObject({
        code: 'RATE_LIMITED',
        details: { retryAfterSeconds: IMAGE_BUSY_RETRY_SECONDS },
      });
    } finally {
      run.mockRestore();
    }
    expect(await mediaRows()).toEqual([]);
    expect(t.storage.objects.size).toBe(0);
  });

  it('is open to a signed-in account that finished the onboarding, naming itself', async () => {
    const image = await photo();
    expect((await upload(image, { who: null, expected: 'x' })).statusCode).toBe(401);
    const newcomer = await signUpTestUser(t);
    const early = await upload(image, { who: newcomer });
    expect(early.statusCode).toBe(409);
    expect(early.json<{ error: { code: string } }>().error.code).toBe('ONBOARDING_REQUIRED');
    // Another account named, or none: refused before the file is looked at.
    const other = await upload(image, { expected: newcomer.id });
    expect(other.statusCode).toBe(403);
    expect(other.json<{ error: { details: unknown } }>().error.details).toEqual([
      { path: ['expectedAccountId'], message: expect.any(String) as unknown },
    ]);
    expect((await upload(image, { expected: null })).statusCode).toBe(400);
    // A foreign page cannot make the browser upload (SessionGuard's Origin check).
    const foreign = await t.app.inject({
      method: 'POST',
      url: `/api/v1/media/images?expectedAccountId=${author.id}`,
      headers: {
        origin: 'https://evil.example',
        'content-type': 'image/jpeg',
        cookie: author.cookie,
      },
      payload: image,
    });
    expect(foreign.statusCode).toBe(403);
    expect(await mediaRows()).toEqual([]);
    expect(t.storage.objects.size).toBe(0);
  });

  // ---- read ---------------------------------------------------------------------------------

  /** An upload of the author's, its object in the store, and its id. */
  async function stored(): Promise<{ id: string; body: Uint8Array }> {
    const res = await upload(await png());
    const { id } = res.json<{ data: UploadedImage }>().data;
    const [row] = await t.db
      .select()
      .from(schema.mediaObjects)
      .where(eq(schema.mediaObjects.id, id));
    return { id, body: t.storage.objects.get(row!.storageKey)!.body };
  }

  it('serves an image only while a post shows it, to anyone, revalidated on every use', async () => {
    const image = await stored();
    // Attached to nothing yet: not served, not even to its uploader.
    expect((await read(image.id)).statusCode).toBe(404);
    expect((await read(image.id, { cookie: author.cookie })).statusCode).toBe(404);

    const market = await createMarket(t.db, { status: 'settled' });
    const post = await createPost(t.db, {
      marketId: market.id,
      authorId: author.id,
      imageIds: [image.id],
    });
    const res = await read(image.id);
    expect(res.statusCode).toBe(200);
    expect(new Uint8Array(res.rawPayload)).toEqual(image.body);
    expect(res.headers).toMatchObject({
      'content-type': 'image/png',
      'cache-control': 'public, no-cache',
      etag: `"${image.id}"`,
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
    });
    // A revalidation still checks the post, and reads no object to answer 304.
    const get = vi.spyOn(t.storage, 'get');
    const again = await read(image.id, { 'if-none-match': `"${image.id}"` });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);
    expect(again.headers.etag).toBe(`"${image.id}"`);
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();

    // An edit that took the image out of the body: no longer served (it stays for the history).
    await t.db.update(schema.posts).set({ imageIds: [] }).where(eq(schema.posts.id, post.id));
    expect((await read(image.id)).statusCode).toBe(404);
    await t.db
      .update(schema.posts)
      .set({ imageIds: [image.id] })
      .where(eq(schema.posts.id, post.id));
    expect((await read(image.id)).statusCode).toBe(200);
    // Hidden by an operator, or deleted by its author: its images stop at once, the 304 too.
    await t.db
      .update(schema.posts)
      .set({ hiddenAt: new Date() })
      .where(eq(schema.posts.id, post.id));
    expect((await read(image.id)).statusCode).toBe(404);
    expect((await read(image.id, { 'if-none-match': `"${image.id}"` })).statusCode).toBe(404);
    await t.db
      .update(schema.posts)
      .set({ hiddenAt: null, deletedAt: new Date() })
      .where(eq(schema.posts.id, post.id));
    expect((await read(image.id)).statusCode).toBe(404);
  });

  it('answers an unknown image as not found and a malformed id as bad input', async () => {
    const unknown = await read('0b6f6a3e-2c1d-4c8e-9f0a-1b2c3d4e5f60');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
    expect((await read('not-a-uuid')).statusCode).toBe(400);
  });

  it('answers a shown image whose object is gone as not found', async () => {
    const market = await createMarket(t.db);
    const media = await createMedia(t.db, { ownerId: author.id });
    await createPost(t.db, { marketId: market.id, authorId: author.id, imageIds: [media.id] });
    expect((await read(media.id)).statusCode).toBe(404);
    // Given back once that answer is out (the store's read had settled before it).
    await vi.waitFor(() => {
      expect(imageReads.size).toBe(0);
    });
  });

  /** An upload of the author's, shown by a post of theirs. */
  async function shown(): Promise<{ id: string; body: Uint8Array }> {
    const image = await stored();
    const market = await createMarket(t.db);
    await createPost(t.db, { marketId: market.id, authorId: author.id, imageIds: [image.id] });
    return image;
  }

  it('holds its image within the process’s budget: past it, refused unread; given back once sent', async () => {
    const image = await shown();
    const getObject = t.storage.get.bind(t.storage);
    // While the store is read, the image's bytes are already counted.
    const held: number[] = [];
    const get = vi.spyOn(t.storage, 'get').mockImplementation((key) => {
      held.push(imageReads.size);
      return getObject(key);
    });
    try {
      // Other reads hold the whole budget.
      const others = imageReads.take(IMAGE_READ_BUDGET_BYTES);
      expect(others).not.toBeNull();
      try {
        const busy = await read(image.id);
        expect(busy.statusCode).toBe(429);
        expect(busy.headers['retry-after']).toBe(String(IMAGE_READ_BUSY_RETRY_SECONDS));
        expect(busy.json<{ error: { code: string; details: unknown } }>().error).toMatchObject({
          code: 'RATE_LIMITED',
          details: { retryAfterSeconds: IMAGE_READ_BUSY_RETRY_SECONDS },
        });
        expect(get).not.toHaveBeenCalled();
        // A revalidation holds nothing: answered all the same.
        expect((await read(image.id, { 'if-none-match': `"${image.id}"` })).statusCode).toBe(304);
      } finally {
        others?.();
      }
      expect(imageReads.size).toBe(0);

      const res = await read(image.id);
      expect(res.statusCode).toBe(200);
      expect(new Uint8Array(res.rawPayload)).toEqual(image.body);
      expect(held).toEqual([image.body.length]);
      await vi.waitFor(() => {
        expect(imageReads.size).toBe(0);
      });

      // A store that fails gives the share back too.
      get.mockRejectedValueOnce(new Error('store down'));
      expect((await read(image.id)).statusCode).toBe(500);
      await vi.waitFor(() => {
        expect(imageReads.size).toBe(0);
      });
    } finally {
      get.mockRestore();
    }
  });

  it('gives the read up when the client goes before its image is sent, and its share back only once that read has stopped', async () => {
    const image = await shown();
    const getObject = t.storage.get.bind(t.storage);
    let reached!: (signal: AbortSignal | undefined) => void;
    const reading = new Promise<AbortSignal | undefined>((resolve) => {
      reached = resolve;
    });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    // A store read that takes its time, and — as S3's does — keeps going until it notices it was
    // given up: what it gathered stays in memory until then.
    const get = vi.spyOn(t.storage, 'get').mockImplementationOnce(async (key, options) => {
      reached(options?.signal);
      await gate;
      options?.signal?.throwIfAborted();
      return getObject(key);
    });
    try {
      const request = httpGet(`${t.url!}/api/v1/media/${image.id}`);
      request.on('error', () => undefined);
      const signal = await reading;
      expect(imageReads.size).toBe(image.body.length);
      expect(signal?.aborted).toBe(false);
      // The client hangs up while the store is still being read: the read is given up…
      request.destroy();
      await vi.waitFor(() => {
        expect(signal?.aborted).toBe(true);
      });
      // …but its share stays taken while that read has not stopped.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(imageReads.size).toBe(image.body.length);
      open();
      await vi.waitFor(() => {
        expect(imageReads.size).toBe(0);
      });
      // Nothing more is taken back afterwards.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(imageReads.size).toBe(0);
    } finally {
      open();
      get.mockRestore();
    }
    expect((await read(image.id)).statusCode).toBe(200);
  });

  it('keeps the share of a read that outlives its answer until the read stops', async () => {
    const image = await shown();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    // The store fails slowly after the client went: the share is held through the failure.
    const get = vi.spyOn(t.storage, 'get').mockImplementationOnce(async () => {
      await gate;
      throw new Error('store down');
    });
    try {
      const request = httpGet(`${t.url!}/api/v1/media/${image.id}`);
      request.on('error', () => undefined);
      await vi.waitFor(() => {
        expect(get).toHaveBeenCalled();
      });
      request.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(imageReads.size).toBe(image.body.length);
      open();
      await vi.waitFor(() => {
        expect(imageReads.size).toBe(0);
      });
    } finally {
      open();
      get.mockRestore();
    }
  });

  it('keeps the share of an answer the client is not reading, after the store read has settled, until the answer is out', async () => {
    const image = await shown();
    // Far more than a loopback socket's buffers take: while the client reads nothing, the answer
    // cannot all be handed to the socket. (The share is the row's size, not these bytes: the
    // controller serves the store's bytes as they come.)
    const large = new Uint8Array(64 * 1024 * 1024);
    let settled = false;
    const get = vi.spyOn(t.storage, 'get').mockImplementationOnce(() => {
      const read = Promise.resolve(large);
      void read.then(() => {
        settled = true;
      });
      return read;
    });
    let response: IncomingMessage | undefined;
    const request = httpGet(`${t.url!}/api/v1/media/${image.id}`, (res) => {
      // Reads nothing for now: the rest of the answer waits in the API.
      res.pause();
      response = res;
    });
    request.on('error', () => undefined);
    try {
      await vi.waitFor(() => {
        expect(response?.statusCode).toBe(200);
      });
      expect(settled).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The store read has settled, but the answer is not out: the share stays taken (9-36).
      expect(imageReads.size).toBe(image.body.length);
      // Read to its end: the answer is out, the share comes back.
      let received = 0;
      response!.on('data', (chunk: Buffer) => {
        received += chunk.length;
      });
      response!.resume();
      await vi.waitFor(
        () => {
          expect(imageReads.size).toBe(0);
        },
        { timeout: 10_000 },
      );
      await vi.waitFor(() => {
        expect(received).toBe(large.length);
      });
    } finally {
      request.destroy();
      get.mockRestore();
    }
  });
});

describe('the upload bodies received at once', () => {
  it('are 64MiB per process, the owner’s value (owner decision 2026-10-21 answer 1)', () => {
    // The integration test above works from the constant; this holds the constant to the owner's
    // number (ADR-0073 decision 9-43, docs/SETTINGS.md).
    expect(IMAGE_UPLOAD_RECEIVING_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe('ByteBudget', () => {
  it('takes shares up to the budget and refuses one past it', () => {
    const budget = new ByteBudget(10);
    const a = budget.take(6);
    const b = budget.take(4);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(budget.size).toBe(10);
    expect(budget.take(1)).toBeNull();
    a?.();
    expect(budget.size).toBe(4);
    expect(budget.take(6)).not.toBeNull();
    expect(budget.size).toBe(10);
  });

  it('gives a share back once, however often it is released', () => {
    const budget = new ByteBudget(10);
    const a = budget.take(3);
    budget.take(2);
    a?.();
    a?.();
    expect(budget.size).toBe(2);
  });

  it('takes any one share while it holds nothing, so no image is refused for its size alone', () => {
    const budget = new ByteBudget(10);
    const large = budget.take(25);
    expect(large).not.toBeNull();
    expect(budget.take(1)).toBeNull();
    large?.();
    expect(budget.size).toBe(0);
  });
});
