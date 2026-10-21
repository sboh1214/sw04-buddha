/**
 * 올린 이미지 (#46, ADR-0073) against the docker `test` profile: `POST /media/images` and
 * `GET /media/:mediaId`. Pinned: the upload is the file itself, open to an account that finished
 * the onboarding and naming the account the screen shows; the content decides the type and the
 * stored object is the server's own encoding without metadata; the read serves an image only
 * while a post shows it, to anyone, revalidated on every use, and holds no more images at once than
 * the process's budget; the upload bodies received at once stay within theirs, an account has at
 * most three uploads in flight — each until its conversion and store have settled, a client that
 * hangs up included — and a body that sends nothing for 30 seconds is cut (owner decisions
 * 2026-10-21). Skips when TEST_* are unset.
 */
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
  get as httpGet,
  request as httpRequest,
} from 'node:http';
import { readFileSync } from 'node:fs';
import { finished } from 'node:stream';
import { schema } from '@buddha/db';
import { completeOnboarding, createMarket, createMedia, createPost } from '@buddha/db/test';
import { IMAGE_MAX_BYTES, uploadedImageSchema, type UploadedImage } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { SESSION_COOKIE } from '../openapi/document.js';
import { pngOf } from '../test/png.js';
import { hasTestInfra } from '../test/setup-env.js';
import { ByteBudget } from './byte-budget.js';
import {
  IMAGE_BODY_LIMIT,
  IMAGE_UPLOADS_PER_ACCOUNT,
  IMAGE_UPLOAD_IDLE_SECONDS,
  IMAGE_UPLOAD_RECEIVING_BYTES,
  imageUploadIdle,
  imageUploadsInFlight,
  imageUploadsReceiving,
} from './image-body.js';
import {
  IMAGE_READ_BUDGET_BYTES,
  IMAGE_READ_BUSY_RETRY_SECONDS,
  imageReads,
} from './image-reads.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import {
  IMAGE_BUSY_RETRY_SECONDS,
  IMAGE_CONVERSIONS_WAITING_MAX,
  IMAGE_CONVERSION_PEAK_BYTES,
  OneAtATime,
  imageConversions,
} from './image.js';
import { InFlightPerKey } from './in-flight.js';
import { MediaService } from './media.service.js';

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
    imageUploadIdle.ms = IMAGE_UPLOAD_IDLE_SECONDS * 1000;
    // Every upload a spec began has given its share back and left its account's uploads in flight
    // (a request hung up on is let go at once).
    await vi.waitFor(() => {
      expect(imageUploadsReceiving.size).toBe(0);
      expect(imageUploadsInFlight.size).toBe(0);
    });
  });

  /** Another account that may upload. */
  const uploader = async (): Promise<TestUser> => {
    const user = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: user.id });
    return user;
  };

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
   * `length` (null: none, so Node sends it chunked) and only `first` of it sent, by `who` (the
   * author unless said; a `cookie` of null sends none) as `type` (a JPEG unless said; null sends
   * no Content-Type). The answer, and the request to send the rest on — or to hang up.
   */
  function rawUpload(
    length: number | null,
    first: Buffer,
    options: {
      who?: TestUser;
      cookie?: string | null;
      origin?: string | null;
      type?: string | null;
    } = {},
  ): { request: ReturnType<typeof httpRequest>; answer: Promise<RawAnswer> } {
    const who = options.who ?? author;
    const origin = options.origin === undefined ? TRUSTED_ORIGIN : options.origin;
    const type = options.type === undefined ? 'image/jpeg' : options.type;
    const cookie = options.cookie === undefined ? who.cookie : options.cookie;
    const request = httpRequest(`${t.url!}/api/v1/media/images?expectedAccountId=${who.id}`, {
      method: 'POST',
      headers: {
        ...(type === null ? {} : { 'content-type': type }),
        ...(cookie === null ? {} : { cookie }),
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

  /**
   * The API's own side of every upload sent over a socket from now on (`rawUpload`), as its HTTP
   * server hands it to Fastify — to know when the API has seen a client go — until `stop`.
   */
  function serverAnswers(): { answers: ServerResponse[]; stop: () => void } {
    const server = t.app.getHttpServer();
    const answers: ServerResponse[] = [];
    const seen = (request: IncomingMessage, response: ServerResponse) => {
      if (request.url?.startsWith('/api/v1/media/images') === true) answers.push(response);
    };
    server.on('request', seen);
    return { answers, stop: () => server.off('request', seen) };
  }

  /**
   * Once the API has seen `response` end — its client gone. The image-body gate's own listener came
   * before this one (it is added when the gate lets the upload in), so it has run by then.
   */
  const ended = (response: ServerResponse) =>
    new Promise<void>((resolve) => {
      finished(response, () => {
        resolve();
      });
    });

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

  it('refuses an image thin as a line as too large, storing nothing (owner decision 2026-10-22)', async () => {
    // 49KB of grey PNG, 5,000,000×10: within every other check, and ~500MiB to convert.
    const res = await upload(pngOf(5_000_000, 10, { channels: 1 }), { type: 'image/png' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error: {
        code: 'IMAGE_NOT_ALLOWED',
        message: expect.any(String) as unknown,
        details: { reason: 'pixels' },
      },
    });
    expect(await mediaRows()).toEqual([]);
    expect(t.storage.objects.size).toBe(0);
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
    // Refused by the gate, unread (Fastify's own parsers read JSON and text, but not here): the
    // route takes its own types only.
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
    // No type at all: refused alike.
    const untyped = await t.app.inject({
      method: 'POST',
      url: `/api/v1/media/images?expectedAccountId=${author.id}`,
      headers: { origin: TRUSTED_ORIGIN, cookie: author.cookie },
      payload: await photo(),
    });
    expect(untyped.statusCode).toBe(415);
    expect(await mediaRows()).toEqual([]);
    // None of them took a place or a share.
    expect(imageUploadsInFlight.size).toBe(0);
    expect(imageUploadsReceiving.size).toBe(0);
  });

  it('checks the sender of an upload of any type before a parser reads its body (Codex review of #219, round 2)', async () => {
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

  it('refuses a body of a type the route does not take before it takes a place or a share: 415 with the account’s three or the budget full, and over the parser’s limit', async () => {
    // Bodies of types Fastify's own parsers read (JSON, text) and of none, announced and only begun.
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

    // The account's three in flight: an image waits its turn (429); the others are refused for
    // their type all the same — they never asked for a place.
    const three = Array.from({ length: IMAGE_UPLOADS_PER_ACCOUNT }, () =>
      imageUploadsInFlight.take(author.id),
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

  it('takes an upload that declares no length at the parser’s limit, and refuses unread one declared over it', async () => {
    // Sent chunked (owner decision 2026-10-21 answer 5): taken, holding the most the parser
    // reads — what it holds is not known before it has all come.
    const image = await photo();
    const half = Math.floor(image.length / 2);
    const chunked = rawUpload(null, image.subarray(0, half));
    // Announced past the parser's limit: refused by that length, as Fastify itself would.
    const over = rawUpload(IMAGE_BODY_LIMIT + 1, Buffer.alloc(1024));
    try {
      const tooLong = await beforeTheBody(over.answer);
      expect(tooLong.status).toBe(413);
      expect(JSON.parse(tooLong.body)).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      await vi.waitFor(() => {
        expect(imageUploadsReceiving.size).toBe(IMAGE_BODY_LIMIT);
      });
      expect(imageUploadsInFlight.of(author.id)).toBe(1);
      chunked.request.end(image.subarray(half));
      const res = await chunked.answer;
      expect(res.status).toBe(201);
      expect(
        uploadedImageSchema.safeParse((JSON.parse(res.body) as { data: unknown }).data).success,
      ).toBe(true);
      expect(imageUploadsReceiving.size).toBe(0);
    } finally {
      chunked.request.destroy();
      over.request.destroy();
    }
    expect(await mediaRows()).toHaveLength(1);
  });

  it('cuts a body that declares no length once it passes the parser’s limit, giving its share back', async () => {
    const chunked = rawUpload(null, Buffer.alloc(1024));
    try {
      await vi.waitFor(() => {
        expect(imageUploadsReceiving.size).toBe(IMAGE_BODY_LIMIT);
      });
      // More than the parser reads, as it comes: refused mid-body, never held past its share.
      chunked.request.write(Buffer.alloc(IMAGE_BODY_LIMIT));
      const res = await chunked.answer;
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    } finally {
      chunked.request.destroy();
    }
    await vi.waitFor(() => {
      expect(imageUploadsReceiving.size).toBe(0);
    });
    expect(await mediaRows()).toEqual([]);
  });

  it('receives no more upload bytes at once than the process’s budget: past it, refused unread with Retry-After', async () => {
    // Six uploads announced at the parser's limit and only begun, two of each of three accounts
    // (each may have three in flight): 60MiB on its way, held while it comes (owner decision
    // 2026-10-21: 64MiB).
    const senders = [author, await uploader(), await uploader()];
    const others = await uploader();
    const held = senders.flatMap((who) =>
      Array.from({ length: 2 }, () => rawUpload(IMAGE_BODY_LIMIT, Buffer.alloc(1024), { who })),
    );
    const more: ReturnType<typeof rawUpload>[] = [];
    try {
      await vi.waitFor(() => {
        expect(imageUploadsReceiving.size).toBe(6 * IMAGE_BODY_LIMIT);
      });
      // A seventh as large would pass 64MiB: answered at once, its body never read — and it is not
      // one of its account's uploads in flight.
      const seventh = rawUpload(IMAGE_BODY_LIMIT, Buffer.alloc(1024), { who: others });
      more.push(seventh);
      const busy = await beforeTheBody(seventh.answer);
      expect(busy.status).toBe(429);
      expect(busy.headers['retry-after']).toBe(String(IMAGE_BUSY_RETRY_SECONDS));
      expect(JSON.parse(busy.body)).toMatchObject({
        error: { code: 'RATE_LIMITED', details: { retryAfterSeconds: IMAGE_BUSY_RETRY_SECONDS } },
      });
      expect(imageUploadsReceiving.size).toBe(6 * IMAGE_BODY_LIMIT);
      expect(imageUploadsInFlight.of(others.id)).toBe(0);
      // A photo fits beside them, and gives its share back once its body is in.
      const fits = await upload(await photo(), { who: others });
      expect(fits.statusCode).toBe(201);
      expect(imageUploadsReceiving.size).toBe(6 * IMAGE_BODY_LIMIT);
      // One that fills the budget to the byte is taken; past that, even a photo waits.
      const rest = IMAGE_UPLOAD_RECEIVING_BYTES - 6 * IMAGE_BODY_LIMIT;
      more.push(rawUpload(rest, Buffer.alloc(1024), { who: others }));
      await vi.waitFor(() => {
        expect(imageUploadsReceiving.size).toBe(IMAGE_UPLOAD_RECEIVING_BYTES);
      });
      const full = await upload(await photo(), { who: others });
      expect(full.statusCode).toBe(429);
      expect(full.headers['retry-after']).toBe(String(IMAGE_BUSY_RETRY_SECONDS));
      expect(full.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
      expect(await mediaRows()).toHaveLength(1);
    } finally {
      for (const { request } of [...held, ...more]) request.destroy();
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
      // Both bodies are the handler's now: nothing of them is held as being received — but both
      // are still the account's uploads in flight, through the conversion and the store.
      expect(imageUploadsReceiving.size).toBe(0);
      expect(imageUploadsInFlight.of(author.id)).toBe(2);
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

  it('cuts an upload whose body sends no byte for the idle time: its share and its place back, answered 408', async () => {
    // The owner's 30 seconds (owner decision 2026-10-21 answer 4), shortened for the spec.
    imageUploadIdle.ms = 300;
    const image = await photo();
    // One that never sends a byte of its body, and one that stops halfway.
    const silent = rawUpload(IMAGE_BODY_LIMIT, Buffer.alloc(0));
    silent.request.flushHeaders();
    const stalled = rawUpload(image.length, image.subarray(0, Math.floor(image.length / 2)));
    const closed = (request: ReturnType<typeof httpRequest>) =>
      new Promise<void>((resolve) => {
        request.on('close', resolve);
      });
    const silentClosed = closed(silent.request);
    const stalledClosed = closed(stalled.request);
    try {
      await vi.waitFor(() => {
        expect(imageUploadsReceiving.size).toBe(IMAGE_BODY_LIMIT + image.length);
      });
      expect(imageUploadsInFlight.of(author.id)).toBe(2);
      for (const { answer } of [silent, stalled]) {
        const res = await answer;
        expect(res.status).toBe(408);
        expect(res.headers.connection).toBe('close');
        expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      }
      // Both given back, and their connections closed by the API: nothing more of them waited for.
      expect(imageUploadsReceiving.size).toBe(0);
      await Promise.all([silentClosed, stalledClosed]);
      await vi.waitFor(() => {
        expect(imageUploadsInFlight.of(author.id)).toBe(0);
      });
    } finally {
      silent.request.destroy();
      stalled.request.destroy();
    }
    expect(await mediaRows()).toEqual([]);
    // The account uploads again.
    expect((await upload(image)).statusCode).toBe(201);
  });

  it('does not cut an upload that keeps sending, however long its whole body takes', async () => {
    imageUploadIdle.ms = 300;
    const image = await photo();
    // Ten pieces a third of the idle time apart, the last completing the declared length: three
    // times the idle time in all, never idle for it.
    const pieces = 10;
    const size = Math.ceil(image.length / pieces);
    const slow = rawUpload(image.length, image.subarray(0, size));
    try {
      for (let sent = size; sent < image.length; sent += size) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        slow.request.write(image.subarray(sent, sent + size));
      }
      slow.request.end();
      const res = await slow.answer;
      expect(res.status).toBe(201);
    } finally {
      slow.request.destroy();
    }
    expect(await mediaRows()).toHaveLength(1);
  });

  it('lets an account have three uploads in flight: a fourth is refused unread with Retry-After, other accounts are not', async () => {
    const image = await photo();
    const half = Math.floor(image.length / 2);
    const three = Array.from({ length: IMAGE_UPLOADS_PER_ACCOUNT }, () =>
      rawUpload(image.length, image.subarray(0, half)),
    );
    let fourth: ReturnType<typeof rawUpload> | undefined;
    try {
      await vi.waitFor(() => {
        expect(imageUploadsInFlight.of(author.id)).toBe(3);
      });
      // Answered before its body (which never comes), holding nothing.
      fourth = rawUpload(IMAGE_BODY_LIMIT, Buffer.alloc(1024));
      const busy = await beforeTheBody(fourth.answer);
      expect(busy.status).toBe(429);
      expect(busy.headers['retry-after']).toBe(String(IMAGE_BUSY_RETRY_SECONDS));
      expect(JSON.parse(busy.body)).toMatchObject({
        error: { code: 'RATE_LIMITED', details: { retryAfterSeconds: IMAGE_BUSY_RETRY_SECONDS } },
      });
      expect(imageUploadsReceiving.size).toBe(3 * image.length);
      expect(imageUploadsInFlight.of(author.id)).toBe(3);
      // The same through `inject`: the fourth is refused whoever sends it of this account.
      expect((await upload(image)).statusCode).toBe(429);
      // Another account uploads beside them.
      const other = await uploader();
      expect((await upload(image, { who: other })).statusCode).toBe(201);
      // One of the three ends: its place is the account's again.
      three[0]!.request.end(image.subarray(half));
      expect((await three[0]!.answer).status).toBe(201);
      await vi.waitFor(() => {
        expect(imageUploadsInFlight.of(author.id)).toBe(2);
      });
      expect((await upload(image)).statusCode).toBe(201);
    } finally {
      for (const { request } of three) request.destroy();
      fourth?.request.destroy();
    }
    // Hung up on: every place comes back.
    await vi.waitFor(() => {
      expect(imageUploadsInFlight.of(author.id)).toBe(0);
    });
    expect(await mediaRows()).toHaveLength(3);
  });

  it('holds an upload’s place among its account’s three until its conversion and store have settled, even when its client hangs up once its body is in', async () => {
    // The conversions held until let go. Were the place given back when the client hangs up (the
    // answer ends then), an account could hang up on three uploads at a time, each once its body is
    // in, and keep sending: its conversions — which nothing stops — would fill the queue (one
    // running and eight waiting) for every other account.
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
    const three = Array.from({ length: IMAGE_UPLOADS_PER_ACCOUNT }, () =>
      rawUpload(image.length, image),
    );
    try {
      for (const { request } of three) request.end();
      // Every body is in, and its conversion waits.
      await vi.waitFor(() => {
        expect(run).toHaveBeenCalledTimes(IMAGE_UPLOADS_PER_ACCOUNT);
      });
      expect(imageUploadsReceiving.size).toBe(0);
      expect(imageUploadsInFlight.of(author.id)).toBe(3);
      expect(server.answers).toHaveLength(IMAGE_UPLOADS_PER_ACCOUNT);
      // The clients hang up, and the API sees each go.
      const gone = server.answers.map(ended);
      for (const { request } of three) request.destroy();
      await Promise.all(gone);
      // Their work goes on, and they hold their places: a fourth of the account's is refused unread.
      expect(imageUploadsInFlight.of(author.id)).toBe(3);
      const fourth = await upload(image);
      expect(fourth.statusCode).toBe(429);
      expect(fourth.headers['retry-after']).toBe(String(IMAGE_BUSY_RETRY_SECONDS));
      expect(fourth.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
      expect(run).toHaveBeenCalledTimes(IMAGE_UPLOADS_PER_ACCOUNT);
      // Once their work has settled, the places are the account's again.
      letGo();
      await vi.waitFor(() => {
        expect(imageUploadsInFlight.of(author.id)).toBe(0);
      });
    } finally {
      letGo();
      server.stop();
      for (const { request } of three) request.destroy();
      run.mockRestore();
    }
    // Stored all the same — their work had started before their clients went (left for the cleanup
    // of uploads no post takes) — and the account uploads again.
    expect(await mediaRows()).toHaveLength(3);
    expect((await upload(image)).statusCode).toBe(201);
  });

  it('stores nothing for an upload whose client went before its handler ran, its place back at once', async () => {
    // The guards after the body held until let go, for the first upload alone: its client goes
    // in between.
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
    const stores = vi.spyOn(MediaService.prototype, 'uploadPostImage');
    const server = serverAnswers();
    const image = await photo();
    const raw = rawUpload(image.length, image);
    try {
      raw.request.end();
      // Its body is in; its handler waits behind the guard.
      await reached;
      expect(imageUploadsReceiving.size).toBe(0);
      expect(imageUploadsInFlight.of(author.id)).toBe(1);
      expect(server.answers).toHaveLength(1);
      const response = server.answers[0]!;
      const gone = ended(response);
      raw.request.destroy();
      await gone;
      // Gone before any work on it started: its place is back at once.
      expect(imageUploadsInFlight.of(author.id)).toBe(0);
      letGo();
      // Its handler has run — and answered no one — without converting or storing anything.
      await vi.waitFor(() => {
        expect(response.writableEnded).toBe(true);
      });
      expect(stores).not.toHaveBeenCalled();
      expect(await mediaRows()).toEqual([]);
      expect(t.storage.objects.size).toBe(0);
    } finally {
      letGo();
      server.stop();
      raw.request.destroy();
      guard.mockRestore();
      stores.mockRestore();
    }
    expect((await upload(image)).statusCode).toBe(201);
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

  it('answers a HEAD from the row: the headers and length of the GET, no store read and no share (Codex review of #219, round 2)', async () => {
    const image = await stored();
    const market = await createMarket(t.db);
    const post = await createPost(t.db, {
      marketId: market.id,
      authorId: author.id,
      imageIds: [image.id],
    });
    const head = (headers: Record<string, string> = {}) =>
      t.app.inject({ method: 'HEAD', url: `/api/v1/media/${image.id}`, headers });
    const got = await read(image.id);
    expect(got.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(imageReads.size).toBe(0);
    });
    const get = vi.spyOn(t.storage, 'get');
    // Other reads hold the whole budget: a GET would be refused, a HEAD takes nothing.
    const others = imageReads.take(IMAGE_READ_BUDGET_BYTES);
    expect(others).not.toBeNull();
    try {
      expect((await read(image.id)).statusCode).toBe(429);
      const res = await head();
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.length).toBe(0);
      expect(res.headers).toMatchObject({
        'content-type': 'image/png',
        'content-length': String(image.body.length),
        'cache-control': 'public, no-cache',
        etag: `"${image.id}"`,
        'content-disposition': 'inline',
      });
      // The GET's own headers, its length included.
      expect(res.headers['content-length']).toBe(got.headers['content-length']);
      expect(imageReads.size).toBe(IMAGE_READ_BUDGET_BYTES);
      // A revalidation, as for a GET.
      expect((await head({ 'if-none-match': `"${image.id}"` })).statusCode).toBe(304);
      expect(get).not.toHaveBeenCalled();
    } finally {
      others?.();
      get.mockRestore();
    }
    expect(imageReads.size).toBe(0);
    // A hidden post's image: not found, as for a GET.
    await t.db
      .update(schema.posts)
      .set({ hiddenAt: new Date() })
      .where(eq(schema.posts.id, post.id));
    expect((await head()).statusCode).toBe(404);
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
  // The integration tests above work from the constants; these hold them to the owner's numbers
  // (ADR-0073 decision 9-43, docs/SETTINGS.md).
  it('are 64MiB per process, the owner’s value (owner decision 2026-10-21 answer 1)', () => {
    expect(IMAGE_UPLOAD_RECEIVING_BYTES).toBe(64 * 1024 * 1024);
  });

  it('are cut after 30 seconds without a byte, and three per account at once (owner decision 2026-10-21 answer 4)', () => {
    expect(IMAGE_UPLOAD_IDLE_SECONDS).toBe(30);
    expect(imageUploadIdle.ms).toBe(30_000);
    expect(IMAGE_UPLOADS_PER_ACCOUNT).toBe(3);
  });
});

describe('the image budgets in the API container (ADR-0073 결과 5, open: 결과 4 question 3)', () => {
  const MiB = 1024 * 1024;

  /** The api service's memory limit in deploy/compose.yaml. */
  function apiContainerLimit(): number {
    const compose = readFileSync(
      new URL('../../../../deploy/compose.yaml', import.meta.url),
      'utf8',
    );
    const api = /^ {2}api:\n([\s\S]*?)^ {2}\S/m.exec(compose)?.[1] ?? '';
    const limit = /^\s+memory: (\d+)m$/m.exec(api)?.[1];
    expect(limit, 'the api service has a memory limit in MiB').toBeDefined();
    return Number(limit) * MiB;
  }

  it('wait for at most eight conversions and read 32MiB at once, the values the owner kept', () => {
    // Implementation-chosen and kept by the owner: one conversion and eight waiting (owner decision
    // 2026-10-19 answer 6, decision 9-8), 32MiB of reads (owner decision 2026-10-20 answer 4,
    // decision 9-36). Lowering them so the container total fits is the owner's call (결과 4
    // question 3), not the code's.
    expect(IMAGE_CONVERSIONS_WAITING_MAX).toBe(8);
    expect(IMAGE_READ_BUDGET_BYTES).toBe(32 * MiB);
  });

  it('leave the API less of its container than it holds idle, as 결과 5 says, until the owner answers', () => {
    // Every budget full at once: the bodies being received, the bodies the conversions hold (the
    // one converting, outside its peak, and those waiting, each up to IMAGE_MAX_BYTES), the reads
    // and one conversion's peak.
    const budgets =
      IMAGE_UPLOAD_RECEIVING_BYTES +
      (1 + IMAGE_CONVERSIONS_WAITING_MAX) * IMAGE_MAX_BYTES +
      IMAGE_READ_BUDGET_BYTES +
      IMAGE_CONVERSION_PEAK_BYTES;
    expect(budgets).toBe((64 + 45 + 32 + 144) * MiB);
    const limit = apiContainerLimit();
    expect(limit).toBe(448 * MiB);
    // What is left for the API itself (163MiB) is under what it held idle in its image: ~293MiB
    // resident, ~234MiB of it anonymous (결과 5). When the owner's answer changes the limit or a
    // budget, this fails: write the answer into 결과 4·5 and this test with it.
    expect(limit - budgets).toBe(163 * MiB);
    expect(limit - budgets).toBeLessThan(234 * MiB);
  });
});

describe('InFlightPerKey', () => {
  it('takes places up to the maximum per key, each key apart', () => {
    const inFlight = new InFlightPerKey(2);
    const a1 = inFlight.take('a');
    const a2 = inFlight.take('a');
    expect(a1).not.toBeNull();
    expect(a2).not.toBeNull();
    expect(inFlight.take('a')).toBeNull();
    expect(inFlight.take('b')).not.toBeNull();
    expect(inFlight.of('a')).toBe(2);
    expect(inFlight.of('b')).toBe(1);
    a1?.();
    expect(inFlight.of('a')).toBe(1);
    expect(inFlight.take('a')).not.toBeNull();
  });

  it('gives a place back once, however often it is released, and forgets a key holding nothing', () => {
    const inFlight = new InFlightPerKey(3);
    const a = inFlight.take('a');
    inFlight.take('a');
    a?.();
    a?.();
    expect(inFlight.of('a')).toBe(1);
    expect(inFlight.size).toBe(1);
    const b = inFlight.take('b');
    b?.();
    expect(inFlight.of('b')).toBe(0);
    expect(inFlight.size).toBe(1);
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
