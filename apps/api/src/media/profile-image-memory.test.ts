/**
 * What an image's conversion asks of memory on the files that cost the most for their size (#141,
 * ADR-0079 7-16 and the owner decisions of 2026-10-22). A profile image's ways to its square stay
 * within the decode budget (IMAGE_DECODE_BUDGET_BYTES, 128 MiB — ADR-0073 9-8): scaling a long
 * panorama straight to the square scales by its short side, which leaves the JPEG decoder no
 * shrink-on-load and libvips a full-size image to turn and resize — a 300KB file came near the
 * API's whole 448 MiB; and a long WebP whose square is cut from the file is decoded whole, so its
 * header check charges it that (PROFILE_WEBP_CUT_BYTES_PER_PIXEL). And a very thin image is refused
 * from its header by both kinds (IMAGE_MAX_SIDE_RATIO) before anything is decoded: a
 * 5,000,000×10 PNG of 49KB, fitted inside 2,048px as a post's image is, took about 500 MiB as one
 * channel and 1.5 GiB as three. Each file below passes every other header check and is small to
 * send; the way it is taken must keep it small in memory too.
 *
 * Measured by libvips' own high-water mark of the memory it allocates (`sharp.cache().memory.high`,
 * in MiB — sharp divides the bytes by 1,048,576): process-wide and never lowered, so this file has
 * its own (vitest runs every test file in a process of its own), makes only small files, and checks
 * the mark after each conversion against a bound of its own, cheapest first. On sharp 0.35.5 the
 * ways `processProfileImage` takes stay at or under about 47 MiB up to the long WebP of 3.2
 * megapixels, 81 MiB for a WebP at its bound scaled first, and 126 MiB for a long one with an alpha
 * channel at the bound of a WebP cut first; scaling straight to the square takes 46–96 MiB on the
 * same JPEG and PNG files, fitting the thin PNG inside 2,048px first (as a post's image would be,
 * were it not refused) 120 MiB and up, and the long WebP at the 15 bytes a pixel a post's WebP is
 * charged 129–143 MiB. No database.
 */
import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../common/errors/app-error.js';
import {
  IMAGE_DECODE_BUDGET_BYTES,
  IMAGE_MAX_SIDE_RATIO,
  PROFILE_WEBP_CUT_BYTES_PER_PIXEL,
  processImage,
  processProfileImage,
} from './image.js';

/** The mark the cheap ways here may not pass, in MiB: room above the ~47 the dearest of them takes. */
const BOUND_MIB = 64;

/** The decode budget, in the mark's unit (MiB): what no conversion may pass. */
const BUDGET_MIB = IMAGE_DECODE_BUDGET_BYTES / (1024 * 1024);

/** libvips' high-water mark of the memory it has allocated in this process, in MiB. */
const highWater = () => sharp.cache(false).memory.high;

/** A still image of one colour, `width`×`height`, tagged with `orientation` when given. */
function made(
  format: 'jpeg' | 'png' | 'webp',
  width: number,
  height: number,
  orientation?: number,
): Promise<Buffer> {
  const image = sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 60, b: 200 } },
  }).toFormat(format);
  return (orientation === undefined ? image : image.withMetadata({ orientation })).toBuffer();
}

/**
 * A still WebP of one colour with an alpha channel, `width`×`height`, turned a quarter by its EXIF:
 * the dearest WebP for its pixels (ADR-0079 7-16).
 */
function webp(width: number, height: number, { lossless }: { lossless: boolean }): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 120, g: 60, b: 200, alpha: 0.5 } },
  })
    .webp({ lossless, quality: 85 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

/**
 * A valid greyscale PNG of `width`×`height`, every pixel black, made by hand (zlib, not libvips —
 * so making it moves no mark): the owner's 5,000,000×10 strip is 49KB.
 */
function blackPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(0, 9); // greyscale
  // Each row: filter byte 0, then `width` zero samples.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('image conversions: memory (#141)', () => {
  beforeAll(() => {
    // A process of its own: nothing has decoded an image here yet, or the mark would say nothing.
    expect(highWater()).toBeLessThan(BOUND_MIB);
  });

  it('refuses a strip as thin as a line from its header, for both kinds, decoding nothing', async () => {
    // The owner's case (2026-10-22): 5,000,000×10, one channel and three. Fitted inside 2,048px
    // as a post's image is, the first took ~500 MiB and the second ~1.5 GiB; past
    // IMAGE_MAX_SIDE_RATIO neither is decoded at all.
    const strips = [blackPng(5_000_000, 10), await made('png', 400_000, 10)];
    expect(5_000_000 / 10).toBeGreaterThan(IMAGE_MAX_SIDE_RATIO);
    const before = highWater();
    for (const process of [processImage, processProfileImage]) {
      for (const strip of strips) {
        const refused = await process(strip).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(refused).toBeInstanceOf(AppError);
        expect((refused as AppError).details).toEqual({ reason: 'pixels' });
      }
    }
    // Only the headers were read.
    expect(highWater()).toBe(before);
  });

  // Cheapest first, each against its own bound: the mark is the most any conversion here took.

  it('takes a JPEG photo through the long-side pass of a post’s image', async () => {
    // 8000×2400 with a quarter turn: fitted inside 2,048px first, the decoder shrinks it as it
    // reads (~19 MiB).
    const image = await processProfileImage(await made('jpeg', 8_000, 2_400, 6));
    expect(image).toMatchObject({ contentType: 'image/jpeg', width: 512, height: 512 });
    expect(highWater()).toBeLessThanOrEqual(40);
  });

  it('takes a long PNG panorama, turned by its EXIF, by cutting the square first', async () => {
    // 16000×500, at IMAGE_MAX_SIDE_RATIO: ~23 MiB; fitted inside 2,048px first (as a post's image
    // is) ~49 MiB, straight to the square ~46 MiB.
    const image = await processProfileImage(await made('png', 16_000, 500, 6));
    expect(image).toMatchObject({ contentType: 'image/png', width: 500, height: 500 });
    expect(highWater()).toBeLessThanOrEqual(40);
  });

  it('takes a JPEG panorama at the bound, turned by its EXIF, by cutting its square from the file', async () => {
    // 19200×600 — 32:1 (IMAGE_MAX_SIDE_RATIO), 11.5 megapixels in about 70KB: its long side fitted
    // first would leave a 64px short side, so the 600px middle is read from the file (~30 MiB;
    // ~37 at 40:1, the bound before); straight to the square takes ~96 MiB (~120 at 40:1).
    expect(19_200 / 600).toBe(IMAGE_MAX_SIDE_RATIO);
    const image = await processProfileImage(await made('jpeg', 19_200, 600, 6));
    expect(image).toMatchObject({ contentType: 'image/jpeg', width: 512, height: 512 });
    expect(highWater()).toBeLessThanOrEqual(48);
  });

  it('takes a long WebP panorama, turned by its EXIF, decoded whole for its square', async () => {
    // Cut from the file, a WebP is decoded whole: 3.2 megapixels, ~47 MiB.
    const image = await processProfileImage(await made('webp', 8_000, 400, 6));
    expect(image).toMatchObject({ contentType: 'image/webp', width: 400, height: 400 });
    expect(highWater()).toBeLessThanOrEqual(BOUND_MIB);
  });

  it('takes a WebP at its bound, under four to one, the way a post’s image is: decoded scaled', async () => {
    // 2991×2991 with an alpha channel and a quarter turn, at the 15 bytes a pixel a WebP is
    // charged: libwebp's scaled decoding, 81 MiB as a post's image of it. Decoded whole (cut
    // first), the same file would take ~143 MiB.
    const image = await processProfileImage(await webp(2_991, 2_991, { lossless: true }));
    expect(image).toMatchObject({ contentType: 'image/webp', width: 512, height: 512 });
    expect(highWater()).toBeLessThanOrEqual(96);
  });

  it('takes a long WebP with an alpha channel at the bound of one cut first, within the decode budget', async () => {
    // The dearest shapes (ADR-0079 7-16): just past 4:1, and about 30:1, each as many pixels as
    // PROFILE_WEBP_CUT_BYTES_PER_PIXEL lets through — ~126 and ~122 MiB, lossless and lossy alike.
    // At the 15 a post's WebP is charged (~8.9 megapixels) they took 143 and 138.
    const bound = Math.floor(IMAGE_DECODE_BUDGET_BYTES / PROFILE_WEBP_CUT_BYTES_PER_PIXEL);
    const shapes = [
      { side: 1_403, lossless: true },
      { side: 513, lossless: false },
    ];
    for (const { side, lossless } of shapes) {
      const long = Math.floor(bound / side);
      expect(long).toBeGreaterThan(4 * side);
      expect(long).toBeLessThanOrEqual(30 * side);
      expect(bound - long * side).toBeLessThan(side);
      const image = await processProfileImage(await webp(long, side, { lossless }));
      expect(image).toMatchObject({ contentType: 'image/webp', width: 512, height: 512 });
      expect(highWater(), `${String(long)}×${String(side)}`).toBeLessThanOrEqual(BUDGET_MIB);
    }
  });
});
