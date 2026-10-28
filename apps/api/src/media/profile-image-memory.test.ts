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
 * charged 129–143 MiB. A PNG's bound is its kind's largest frame (#46's PNG_LARGEST_FRAME_PIXELS,
 * owner decision 2026-10-22): each kind's costliest shape for the square — the interlaced ones,
 * decoded whole, the dearest — at 31 to 97 MiB (`scripts/image-memory/sweep-png.mjs
 * --profile-image`, ADR-0079 결정 10).
 *
 * The whole conversion (#46's IMAGE_CONVERSION_PEAK_BYTES, ADR-0079 결정 10): the last block converts
 * a profile image's costliest cases at its bounds in a process of its own (`test/image-child.mjs
 * convert-profile`, as `image-memory.test.ts` does a post's image's) and checks the process's
 * resident memory rose by at most IMAGE_CONVERSION_PEAK_BYTES — a progressive CMYK JPEG at 32:1,
 * whose square is cut from the file (~120 MiB on Linux arm64, ~124 on x64), the dearest. Linux only,
 * as that one is; elsewhere only the pipeline itself is checked against processProfileImage. No
 * database.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_DIMENSION,
  IMAGE_MAX_INPUT_PIXELS,
  PROFILE_IMAGE_SIZE,
  type ProfileImageContentType,
} from '@buddha/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../common/errors/app-error.js';
import {
  CONVERSION_RUNS,
  type ChildConversion,
  type ChildInput,
  SHARP_FORMAT,
  convertInChild,
  makeInChild,
  median,
  sha256,
} from '../test/image-children.js';
import { type PngKind, pngOf } from '../test/png.js';
import {
  IMAGE_CONVERSION_PEAK_BYTES,
  IMAGE_DECODE_BUDGET_BYTES,
  IMAGE_MAX_SIDE_RATIO,
  PNG_LARGEST_FRAME_PIXELS,
  PROFILE_WEBP_CUT_BYTES_PER_PIXEL,
  cutsSquareFirst,
  encoderOptions,
  processImage,
  processProfileImage,
  profileLargestFramePixels,
  profileSquareSide,
  sniffImageType,
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

  it('takes each PNG kind’s costliest frame for its square, at the kind’s largest frame, within the decode budget (owner decision 2026-10-22)', async () => {
    // [kind, width, height]: the costliest shape `sweep-png.mjs --profile-image` found at each
    // kind's largest frame (PNG_LARGEST_FRAME_PIXELS — #46's, measured on a post's image), with an
    // embedded profile, cheapest first. The square is cut from the file, so what a post's image
    // pays for a frame's width costs it little; an interlaced PNG is decoded whole, and that is the
    // most it holds (ADR-0079 결정 10).
    const costliest: readonly (readonly [PngKind, number, number])[] = [
      [{ channels: 1 }, 7_072, 7_070], // 31MiB
      [{ channels: 4, depth: 16 }, 1_817, 1_816], // 34
      [{ channels: 1, depth: 16 }, 39_972, 1_250], // 42
      [{ channels: 2 }, 6_083, 6_082], // 43
      [{ channels: 4 }, 24_639, 799], // 53
      [{ channels: 2, depth: 16 }, 28_740, 901], // 61
      [{ channels: 3 }, 39_572, 1_263], // 62
      [{ channels: 3, depth: 16 }, 20_270, 646], // 63
      [{ channels: 4, depth: 16, interlaced: true }, 2_280, 2_017], // 64
      [{ channels: 1, interlaced: true }, 7_072, 7_070], // 75
      [{ channels: 2, interlaced: true }, 4_950, 4_949], // 77
      [{ channels: 3, depth: 16, interlaced: true }, 3_360, 3_065], // 85
      [{ channels: 4, interlaced: true }, 3_963, 3_961], // 86
      [{ channels: 2, depth: 16, interlaced: true }, 4_260, 4_061], // 91
      [{ channels: 3, interlaced: true }, 5_189, 5_087], // 96
      [{ channels: 1, depth: 16, interlaced: true }, 6_477, 6_475], // 97
    ];
    for (const [kind, width, height] of costliest) {
      const { channels = 3, depth = 8, interlaced = false } = kind;
      expect(width * height).toBeLessThanOrEqual(
        PNG_LARGEST_FRAME_PIXELS[channels][depth][interlaced ? 1 : 0],
      );
      const image = await processProfileImage(pngOf(width, height, { ...kind, profile: true }));
      expect(image).toMatchObject({ contentType: 'image/png', width: 512, height: 512 });
      expect(highWater(), JSON.stringify({ kind, width, height })).toBeLessThanOrEqual(BUDGET_MIB);
    }
  }, 120_000);

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

/**
 * processProfileImage's pipeline on `file` in a process of its own (`image-child.mjs
 * convert-profile`), with what image.ts decides of it: the first frame, the square cut first or
 * not (`cutsSquareFirst`), its side (`profileSquareSide`) and the encoder (`encoderOptions`, a
 * still image's).
 */
async function convertProfileInChild(file: string, bytes: Uint8Array): Promise<ChildConversion> {
  const contentType = sniffImageType(bytes) as ProfileImageContentType;
  const header = await sharp(bytes, { limitInputPixels: false }).metadata();
  const width = header.width;
  const height = header.pageHeight ?? header.height;
  const short = Math.min(width, height);
  return convertInChild('convert-profile', file, {
    limitInputPixels: IMAGE_MAX_INPUT_PIXELS,
    cut: cutsSquareFirst(contentType, width, height)
      ? {
          left: Math.floor((width - short) / 2),
          top: Math.floor((height - short) / 2),
          width: short,
          height: short,
        }
      : undefined,
    side: profileSquareSide(width, height),
    box: { width: IMAGE_MAX_DIMENSION, height: IMAGE_MAX_DIMENSION },
    format: SHARP_FORMAT[contentType],
    encoder: encoderOptions(contentType, { ...header, pages: 1 }),
  });
}

describe('processProfileImage: memory of the whole conversion, encoders included (#46’s IMAGE_CONVERSION_PEAK_BYTES)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'profile-image-memory-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('converts in a process of its own byte for byte what processProfileImage does', async () => {
    const rgba = (width: number, height: number) =>
      sharp({
        create: { width, height, channels: 4, background: { r: 9, g: 99, b: 199, alpha: 0.5 } },
      });
    const frames = (width: number, height: number, count: number) => {
      const raw = Buffer.alloc(width * height * count * 4);
      for (let i = 0; i < raw.length; i += 1) raw[i] = (i % 251) + 1;
      return sharp(raw, { raw: { width, height: height * count, channels: 4, pageHeight: height } })
        .webp({ delay: Array.from({ length: count }, () => 100), loop: 0 })
        .toBuffer();
    };
    const inputs: [string, Buffer][] = [
      // Scaled first: a photo, turned by its EXIF.
      ['jpeg', await rgba(900, 600).flatten().jpeg().withMetadata({ orientation: 6 }).toBuffer()],
      [
        'jpeg-cmyk',
        await rgba(700, 600).flatten().toColourspace('cmyk').jpeg({ progressive: true }).toBuffer(),
      ],
      ['webp-alpha', await rgba(800, 700).webp().toBuffer()],
      ['webp-animation', await frames(300, 200, 3)],
      // Cut first: a PNG always, a JPEG and a WebP four times longer than wide and more.
      ['png', await rgba(2_300, 200).png().withMetadata({ orientation: 6 }).toBuffer()],
      ['jpeg-long', await rgba(3_000, 600).flatten().jpeg().toBuffer()],
      [
        'webp-alpha-long',
        await rgba(3_000, 600).webp().withMetadata({ orientation: 6 }).toBuffer(),
      ],
      // A small one, at its own size.
      ['png-small', await rgba(120, 90).png().toBuffer()],
    ];
    for (const [name, bytes] of inputs) {
      const file = path.join(dir, `mirror-${name}`);
      writeFileSync(file, bytes);
      const child = await convertProfileInChild(file, bytes);
      const image = await processProfileImage(bytes);
      expect({ name, ...child, peakBytes: undefined }).toEqual({
        name,
        peakBytes: undefined,
        width: image.width,
        height: image.height,
        bytes: image.body.length,
        sha256: sha256(image.body),
      });
    }
  }, 60_000);

  // Linux only: the values are production's allocator's (image-memory.test.ts says why).
  it.runIf(process.platform === 'linux')(
    'converts each costliest case of a profile image at its bounds within IMAGE_CONVERSION_PEAK_BYTES',
    async () => {
      const still = { channels: 3, depth: 'uchar', isProgressive: false, pages: 1 } as const;
      const bound = (
        type: ProfileImageContentType,
        header: object,
        width: number,
        height: number,
      ) => profileLargestFramePixels(type, { ...still, ...header }, width, height);
      /** The widest frame at `ratio`:1 within the profile's bound of that shape. */
      const thin = (type: ProfileImageContentType, header: object, ratio: number) => {
        let height = Math.floor(Math.sqrt(bound(type, header, ratio * 1_024, 1_024) / ratio));
        while (ratio * height * height > bound(type, header, ratio * height, height)) height -= 1;
        return [ratio * height, height] as const;
      };
      const side = (pixels: number) => Math.floor(Math.sqrt(pixels));
      const progressive = { isProgressive: true };
      const cmyk = { channels: 4, isProgressive: true };
      const alpha = { channels: 4, hasAlpha: true };
      const [p32w, p32h] = thin('image/jpeg', progressive, IMAGE_MAX_SIDE_RATIO);
      const [c32w, c32h] = thin('image/jpeg', cmyk, IMAGE_MAX_SIDE_RATIO);
      const [a30w, a30h] = thin('image/webp', alpha, 30);
      const [a4w, a4h] = thin('image/webp', alpha, 4);
      // A baseline JPEG's frame is bounded by every frame's IMAGE_MAX_INPUT_PIXELS alone.
      const b32h = Math.floor(Math.sqrt(IMAGE_MAX_INPUT_PIXELS / IMAGE_MAX_SIDE_RATIO));
      const b32w = IMAGE_MAX_SIDE_RATIO * b32h;
      const progressiveSide = side(bound('image/jpeg', progressive, 2_048, 2_048));
      const cmykSide = side(bound('image/jpeg', cmyk, 2_048, 2_048));
      const webpSide = side(bound('image/webp', alpha, 2_048, 2_048));
      const noise444 = { quality: 12, progressive: true, chromaSubsampling: '4:4:4' };
      const noiseCmyk = { quality: 1, progressive: true };
      // [case, its input, the bound its frame sits at]: the costliest measured
      // (`scripts/image-memory/sweep-encode.mjs --profile-image`, ADR-0079 결정 10), most of them
      // noise, small enough for IMAGE_MAX_BYTES at a low quality. Linux arm64 / x64 MiB.
      const cases: readonly (readonly [string, ChildInput | Uint8Array, number])[] = [
        [
          'progressive CMYK JPEG of noise at 32:1, its square cut from the file', // 120 / 124
          { format: 'jpeg', width: c32w, height: c32h, colourspace: 'cmyk', encoder: noiseCmyk },
          bound('image/jpeg', cmyk, c32w, c32h),
        ],
        [
          'progressive 4:4:4 JPEG of noise at 32:1, its square cut from the file', // 116 / 118
          { format: 'jpeg', width: p32w, height: p32h, encoder: noise444 },
          bound('image/jpeg', progressive, p32w, p32h),
        ],
        [
          'progressive CMYK JPEG of noise, square, scaled first', // 108 / 112
          {
            format: 'jpeg',
            width: cmykSide,
            height: cmykSide,
            colourspace: 'cmyk',
            encoder: noiseCmyk,
          },
          bound('image/jpeg', cmyk, cmykSide, cmykSide),
        ],
        [
          'progressive 4:4:4 JPEG of noise, square, scaled first', // 108 / 111
          { format: 'jpeg', width: progressiveSide, height: progressiveSide, encoder: noise444 },
          bound('image/jpeg', progressive, progressiveSide, progressiveSide),
        ],
        [
          'WebP with alpha, noise, at 30:1, decoded whole for its square', // 106 / 110
          {
            format: 'webp',
            width: a30w,
            height: a30h,
            channels: 4,
            encoder: { quality: 1, alphaQuality: 20 },
          },
          bound('image/webp', alpha, a30w, a30h),
        ],
        [
          'PNG, 8-bit RGB interlaced, decoded whole, with a profile', // 100 / 101
          pngOf(5_189, 5_087, { channels: 3, interlaced: true, profile: true }),
          PNG_LARGEST_FRAME_PIXELS[3][8][1],
        ],
        [
          'PNG, 16-bit grey interlaced, decoded whole, with a profile', // 99 / 101
          pngOf(6_477, 6_475, { channels: 1, depth: 16, interlaced: true, profile: true }),
          PNG_LARGEST_FRAME_PIXELS[1][16][1],
        ],
        [
          'WebP with alpha, noise, at 4:1, decoded whole for its square', // 89 / 92
          {
            format: 'webp',
            width: a4w,
            height: a4h,
            channels: 4,
            encoder: { quality: 1, alphaQuality: 20 },
          },
          bound('image/webp', alpha, a4w, a4h),
        ],
        [
          'baseline JPEG of one colour at 32:1, its rows read for its square', // 68 / 72
          {
            format: 'jpeg',
            width: b32w,
            height: b32h,
            content: 'frames',
            encoder: { quality: 50 },
          },
          IMAGE_MAX_INPUT_PIXELS,
        ],
        [
          'WebP with alpha, noise, at its decoding bound, scaled first', // 59 / 62
          {
            format: 'webp',
            width: webpSide,
            height: webpSide,
            channels: 4,
            encoder: { quality: 1, alphaQuality: 20 },
          },
          bound('image/webp', alpha, webpSide, webpSide),
        ],
        [
          'WebP animation of noise with alpha, its first frame at a still’s decoding bound', // 57
          {
            format: 'webp',
            width: webpSide,
            height: webpSide,
            channels: 4,
            alphaLevels: 2,
            frames: 2,
            encoder: { quality: 1 },
          },
          bound('image/webp', alpha, webpSide, webpSide),
        ],
      ];
      const peaks: Record<string, number> = {};
      for (const [name, input, frameBound] of cases) {
        const file = path.join(dir, `case-${Object.keys(peaks).length}`);
        let bytes: Uint8Array;
        if (input instanceof Uint8Array) {
          bytes = input;
          writeFileSync(file, bytes);
        } else {
          await makeInChild(input, file);
          bytes = new Uint8Array(readFileSync(file));
        }
        // An upload processProfileImage takes, from its header — at its bound (within 3% of it,
        // so a looser bound fails here until it is measured again).
        const header = await sharp(bytes, { limitInputPixels: false }).metadata();
        const frame = header.width * (header.pageHeight ?? header.height);
        expect(bytes.length, name).toBeLessThanOrEqual(IMAGE_MAX_BYTES);
        expect(frame, name).toBeLessThanOrEqual(frameBound);
        expect(frame, name).toBeGreaterThan(0.97 * frameBound);
        const runs: number[] = [];
        for (let run = 0; run < CONVERSION_RUNS; run += 1) {
          const converted = await convertProfileInChild(file, bytes);
          expect(converted.width, name).toBeLessThanOrEqual(PROFILE_IMAGE_SIZE);
          expect(converted.height, name).toBe(converted.width);
          runs.push(converted.peakBytes);
        }
        const mib = runs.map((peak) => Math.round(peak / (1024 * 1024)));
        peaks[name] = median(mib);
        expect(median(runs), `${name}: ${mib.join(', ')}MiB`).toBeLessThanOrEqual(
          IMAGE_CONVERSION_PEAK_BYTES,
        );
      }
      // The sampling saw the conversions (a gauge that read nothing would pass the lines above).
      expect(Math.max(...Object.values(peaks))).toBeGreaterThan(
        IMAGE_CONVERSION_PEAK_BYTES / (2 * 1024 * 1024),
      );
    },
    420_000,
  );
});
