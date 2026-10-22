/**
 * What converting a PNG asks of memory (#46, owner decision 2026-10-21 (2차) answers 1 and 4,
 * ADR-0073 9-8), by libvips' own high-water mark of the memory it allocates
 * (`sharp.cache().memory.high`, in MiB): process-wide and never lowered, so this file has its own
 * process (vitest runs each test file in a process of its own), builds its PNGs by hand (`pngOf` —
 * zlib, no libvips) and checks the mark after each conversion, cheapest first. No database.
 *
 * A thin image: a frame's long side at most IMAGE_MAX_SIDE_RATIO times its short side. Fitting a
 * strip inside 2,048px leaves libvips a few output rows to make, so it holds every input row at
 * once and buffers a whole row wide on top: a 49KB grey PNG of 5,000,000×10 took ~500MiB and the
 * same RGB ~1.5GiB — within every other header check, from any account that finished onboarding,
 * in an API whose container has 448 MiB. Such a file is refused from its header, decoding nothing;
 * the thinnest frame the ratio lets through, at the most pixels an 8-bit grey or RGB PNG may have,
 * converts within IMAGE_DECODE_BUDGET_BYTES — with an embedded ICC profile too, which has sharp
 * turn the pixels into sRGB before it resizes. On sharp 0.35.5 at 32:1: 8-bit grey 39MiB, with a
 * profile 73; 16-bit grey 78; RGB 116 with its quarter turn, 118 with a profile as well — at 48:1
 * the RGB frame would take 132MiB, at 100:1 162MiB.
 *
 * The other PNG kinds — with alpha, 16-bit samples or interlacing (owner decision 2026-10-21 (2차)
 * answer 4): most went over the budget at the bound they had before (up to ~275MiB at 32:1), so
 * each kind has its own largest frame (PNG_LARGEST_FRAME_PIXELS), measured at every shape up to
 * 32:1; 16-bit grey and interlaced 8-bit grey keep the bound they had (IMAGE_MAX_INPUT_PIXELS, and
 * 41,943,040 for interlaced 16-bit grey). Each kind's costliest shape at its largest frame converts
 * within the budget, with a profile — and a palette with transparency at RGBA's, the kind it
 * decodes to. Those shapes sit just under the steps of libvips' vertical shrink, which come from
 * fitting the frame inside IMAGE_MAX_DIMENSION: this file converts only the shapes recorded, so a
 * change to IMAGE_MAX_DIMENSION, the budget, the ratio or IMAGE_MAX_INPUT_PIXELS, or to sharp or
 * libvips, needs the measurement again (ADR-0073 결과 5).
 *
 * The whole conversion (Codex review of #219, round 3): libvips' mark leaves the encoders out —
 * libwebp's alpha coder, libimagequant's palette, mozjpeg's coefficients — and a high-entropy WebP
 * with alpha at the bound it had took ~223MiB of the process while libvips counted 66. The last
 * block converts each kind's costliest case, at its bounds, in a process of its own
 * (`test/image-child.mjs` — this one has converted already, and the allocator keeps and reuses what
 * it freed) and checks the process's resident memory rose by at most IMAGE_CONVERSION_PEAK_BYTES —
 * a progressive CMYK JPEG among them, whose fourth component's coefficients took ~158MiB at the
 * three-component bound, and a still WebP with alpha read up to its decoding bound and written at
 * WEBP_ALPHA_MAX_OUTPUT_PIXELS (owner decision 2026-10-22 answer 1: the largest one taken, and the
 * costliest measured). The children run with the allocator's setting the API's image has
 * (MALLOC_MMAP_THRESHOLD_, read from the Dockerfile — glibc then gives a conversion's large buffers
 * back as it frees them; without it the API's RSS kept what each conversion took, ADR-0073 9-46).
 * Each case is converted CONVERSION_RUNS times, each in a new process, and the median is what is
 * checked: one case moves by 10MiB or so from run to run (the allocator, ADR-0073 결과 5), and the
 * costliest sit within 7–14MiB of the bound, so one sample would fail now and then with nothing
 * changed — a bound or an encoder setting that costs more lifts every run. Those values are Linux's
 * (production's: measured in the API's image, arm64, and the same within a few MiB on x64): macOS's
 * allocator holds on to more, so there that check is skipped and only the pipeline itself is
 * checked against processImage.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_DIMENSION,
  IMAGE_MAX_INPUT_PIXELS,
  type ImageContentType,
} from '@buddha/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../common/errors/app-error.js';
import { type PngKind, pngOf } from '../test/png.js';
import {
  GIF_ANIMATION_LARGEST_FRAME_PIXELS,
  IMAGE_CONVERSION_PEAK_BYTES,
  IMAGE_DECODE_BUDGET_BYTES,
  IMAGE_MAX_SIDE_RATIO,
  PNG_LARGEST_FRAME_PIXELS,
  WEBP_ALPHA_MAX_OUTPUT_PIXELS,
  WEBP_ANIMATION_LARGEST_FRAME_PIXELS,
  WEBP_ANIMATION_MAX_PIXELS,
  encoderOptions,
  largestFramePixels,
  largestImagePixels,
  outputBox,
  processImage,
  sniffImageType,
} from './image.js';

/** libvips' high-water mark of the memory it has allocated in this process, in MiB. */
const highWater = () => sharp.cache(false).memory.high;

/** The decode budget in the mark's unit. */
const BUDGET_MIB = IMAGE_DECODE_BUDGET_BYTES / (1024 * 1024);

/** The reason of an IMAGE_NOT_ALLOWED refusal. */
async function refusal(bytes: Uint8Array): Promise<unknown> {
  try {
    await processImage(bytes);
  } catch (error) {
    if (error instanceof AppError && error.code === 'IMAGE_NOT_ALLOWED') {
      return (error.details as { reason: string }).reason;
    }
    throw error;
  }
  throw new Error('accepted');
}

/**
 * A kind's largest frame (PNG_LARGEST_FRAME_PIXELS), by what it decodes to (ADR-0073 9-8): a
 * palette to 8-bit RGB, or RGBA with transparency; grey or RGB with a transparent colour to grey +
 * alpha or RGBA.
 */
function largestFrame(kind: PngKind): number {
  const { channels = 3, depth = 8, interlaced = false, palette, transparent = false } = kind;
  const column = interlaced ? 1 : 0;
  if (palette !== undefined) return PNG_LARGEST_FRAME_PIXELS[transparent ? 4 : 3][8][column];
  if (!transparent) return PNG_LARGEST_FRAME_PIXELS[channels][depth][column];
  return PNG_LARGEST_FRAME_PIXELS[channels === 1 ? 2 : 4][depth][column];
}

describe('processImage: memory of a thin image (#46, owner decision 2026-10-21 (2차))', () => {
  beforeAll(() => {
    // A process of its own: nothing has decoded an image here yet, or the mark would say nothing.
    expect(highWater()).toBe(0);
  });

  it('refuses a PNG as thin as a line, grey or RGB, without decoding any of it', async () => {
    expect(await refusal(pngOf(5_000_000, 10, { channels: 1 }))).toBe('pixels');
    expect(await refusal(pngOf(5_000_000, 10, { channels: 3 }))).toBe('pixels');
    expect(await refusal(pngOf(5_000_000, 10, { channels: 3, orientation: 6 }))).toBe('pixels');
    expect(await refusal(pngOf(5_000_000, 10, { channels: 3, profile: true }))).toBe('pixels');
    expect(highWater()).toBe(0);
  });

  it('converts the thinnest frame it takes, at the most pixels, within the decode budget', async () => {
    // Exactly IMAGE_MAX_SIDE_RATIO to 1 with as many pixels as an 8-bit grey or RGB PNG may have
    // (IMAGE_MAX_INPUT_PIXELS): 40000×1250 at 32:1. Taken from the constant, so a looser ratio is
    // measured here too (at 48:1 the RGB frame would take 132MiB).
    const short = Math.floor(Math.sqrt(IMAGE_MAX_INPUT_PIXELS / IMAGE_MAX_SIDE_RATIO));
    const long = IMAGE_MAX_SIDE_RATIO * short;
    const fitted = Math.round(IMAGE_MAX_DIMENSION / IMAGE_MAX_SIDE_RATIO);
    const wide = { contentType: 'image/png', width: 2_048, height: fitted };
    const convert = async (options: Parameters<typeof pngOf>[2]) => {
      expect(long * short).toBeLessThanOrEqual(largestFrame(options ?? {}));
      const converted = await processImage(pngOf(long, short, options));
      expect(highWater()).toBeLessThanOrEqual(BUDGET_MIB);
      return converted;
    };

    expect(await convert({ channels: 1 })).toMatchObject(wide);
    const grey = highWater();
    // An embedded profile has sharp turn the pixels into sRGB before the resize, and that holds
    // more: the mark rises (a profile sharp ignored would leave it where it was).
    expect(await convert({ channels: 1, profile: true })).toMatchObject(wide);
    expect(highWater()).toBeGreaterThan(grey);
    // 16-bit grey: sharp does not use its profile.
    expect(await convert({ channels: 1, depth: 16, profile: true })).toMatchObject(wide);
    // RGB with a quarter turn by EXIF, then with a profile as well: the costliest of these.
    const upright = { contentType: 'image/png', width: fitted, height: 2_048 };
    expect(await convert({ channels: 3, orientation: 6 })).toMatchObject(upright);
    expect(await convert({ channels: 3, orientation: 6, profile: true })).toMatchObject(upright);
    // The mark saw the conversion (a gauge that read nothing would pass the lines above).
    expect(highWater()).toBeGreaterThan(BUDGET_MIB / 2);
  });

  it('converts each PNG kind’s costliest frame at its largest frame within the decode budget', async () => {
    // [kind, width, height]: the frame the measurement found costliest at the kind's largest
    // frame (ADR-0073 9-8), cheapest first: within the bound and the ratio, and at the bound —
    // twice the shrink factor in rows more is past it, so a looser bound fails here until it is
    // measured again. The shapes are this pipeline's — fitted inside IMAGE_MAX_DIMENSION — and a
    // different one, or another sharp, has costliest shapes of its own that this does not find.
    const costliest: readonly (readonly [PngKind, number, number])[] = [
      [{ channels: 1, interlaced: true }, 20_480, 2_439], // 110MiB
      [{ channels: 1, depth: 16, interlaced: true }, 20_477, 2_048], // 121
      [{ channels: 2, interlaced: true }, 16_050, 1_526], // 124
      [{ channels: 2, depth: 16, interlaced: true }, 11_960, 1_446], // 124
      [{ channels: 3, depth: 16, interlaced: true }, 11_910, 864], // 124
      [{ channels: 2 }, 32_712, 1_131], // 125
      [{ channels: 3, interlaced: true }, 16_139, 1_635], // 125
      [{ channels: 4 }, 24_576, 801], // 125
      // The same frame as a palette with transparency (what pngquant writes), which decodes to
      // RGBA: it took the same.
      [{ palette: 8, transparent: true }, 24_576, 801], // 125
      [{ channels: 4, interlaced: true }, 8_160, 1_924], // 125
      [{ palette: 8, transparent: true, interlaced: true }, 8_160, 1_924], // 125
      [{ channels: 2, depth: 16 }, 28_600, 905], // 125
      [{ channels: 3, depth: 16 }, 20_304, 645], // 125
      [{ channels: 4, depth: 16, interlaced: true }, 8_192, 559], // 126
      [{ channels: 4, depth: 16 }, 8_192, 402], // 126
    ];
    for (const [kind, width, height] of costliest) {
      const bound = largestFrame(kind);
      const twiceTheShrink = Math.ceil((2 * width) / IMAGE_MAX_DIMENSION) + 1;
      expect(width * height).toBeLessThanOrEqual(bound);
      expect(width * (height + twiceTheShrink)).toBeGreaterThan(bound);
      expect(width).toBeLessThanOrEqual(IMAGE_MAX_SIDE_RATIO * height);
      const converted = await processImage(pngOf(width, height, { ...kind, profile: true }));
      expect(converted).toMatchObject({ contentType: 'image/png', width: IMAGE_MAX_DIMENSION });
      expect(highWater(), JSON.stringify({ kind, width, height })).toBeLessThanOrEqual(BUDGET_MIB);
    }
    // Near the budget: each kind's largest frame is about as large as the budget lets it be.
    expect(highWater()).toBeGreaterThan(BUDGET_MIB - 8);
  }, 120_000);
});

const IMAGE_CHILD = path.join(import.meta.dirname, '..', 'test', 'image-child.mjs');
const run = promisify(execFile);

/** What `image-child.mjs convert` prints. */
interface ChildConversion {
  peakBytes: number;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

/** The input a case converts, as `image-child.mjs make` takes it. */
interface ChildInput {
  format: 'jpeg' | 'png' | 'gif' | 'webp';
  width: number;
  height: number;
  channels?: 3 | 4;
  frames?: number;
  content?: 'noise' | 'frames';
  alphaLevels?: number;
  /** A JPEG of four components. */
  colourspace?: 'cmyk';
  encoder?: Record<string, unknown>;
}

const SHARP_FORMAT = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
} as const;

/**
 * The glibc allocator's setting the API's image starts the API with (the Dockerfile's `api` stage,
 * ADR-0073 9-46): the children convert with it, as production does.
 */
function apiAllocatorEnv(): Record<string, string> {
  const dockerfile = readFileSync(new URL('../../../../Dockerfile', import.meta.url), 'utf8');
  const api = /^FROM \S+ AS api\n([\s\S]*?)^FROM /m.exec(dockerfile)?.[1] ?? '';
  const threshold = /MALLOC_MMAP_THRESHOLD_=(\d+)/.exec(api)?.[1];
  expect(threshold, 'the api image sets MALLOC_MMAP_THRESHOLD_').toBeDefined();
  return { MALLOC_MMAP_THRESHOLD_: threshold! };
}

async function makeInChild(input: ChildInput, file: string): Promise<void> {
  await run(process.execPath, [IMAGE_CHILD, 'make', JSON.stringify(input), file], {
    maxBuffer: 1024 * 1024,
  });
}

/** processImage's pipeline on `file` in a process of its own, as processImage would encode it. */
async function convertInChild(file: string, bytes: Uint8Array): Promise<ChildConversion> {
  const contentType = sniffImageType(bytes)!;
  const animated = contentType === 'image/gif' || contentType === 'image/webp';
  const metadata = await sharp(bytes, { animated, limitInputPixels: false }).metadata();
  const options = {
    animated,
    limitInputPixels: IMAGE_MAX_INPUT_PIXELS,
    box: outputBox(contentType, metadata),
    format: SHARP_FORMAT[contentType],
    encoder: encoderOptions(contentType, metadata),
  };
  const { stdout } = await run(
    process.execPath,
    [IMAGE_CHILD, 'convert', file, JSON.stringify(options)],
    { maxBuffer: 1024 * 1024, env: { ...process.env, ...apiAllocatorEnv() } },
  );
  return JSON.parse(stdout) as ChildConversion;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const side = (pixels: number) => Math.floor(Math.sqrt(pixels));

/** How many times the Linux check converts each case, each in a new process (above). */
const CONVERSION_RUNS = 3;

/** The middle of an odd count of values. */
const median = (values: readonly number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

describe('processImage: memory of the whole conversion, encoders included (Codex review of #219, round 3)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'image-memory-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('converts in a process of its own byte for byte what processImage does', async () => {
    const rgba = (width: number, height: number) =>
      sharp({
        create: { width, height, channels: 4, background: { r: 9, g: 99, b: 199, alpha: 0.5 } },
      });
    const frames = (format: 'gif' | 'webp', width: number, height: number, count: number) => {
      const raw = Buffer.alloc(width * height * count * 3);
      for (let i = 0; i < width * height * count; i += 1) raw[i * 3] = (i % 251) + 1;
      return sharp(raw, { raw: { width, height: height * count, channels: 3, pageHeight: height } })
        .toFormat(format, { delay: Array.from({ length: count }, () => 100), loop: 0 })
        .toBuffer();
    };
    const inputs: [string, Buffer][] = [
      ['jpeg', await rgba(300, 200).flatten().jpeg().withMetadata({ orientation: 6 }).toBuffer()],
      [
        'jpeg-cmyk',
        await rgba(300, 200).flatten().toColourspace('cmyk').jpeg({ progressive: true }).toBuffer(),
      ],
      ['png', await rgba(2_300, 200).png().toBuffer()],
      ['gif', await frames('gif', 120, 80, 3)],
      ['webp-alpha', await rgba(200, 100).webp().toBuffer()],
      // Written smaller (WEBP_ALPHA_MAX_OUTPUT_PIXELS): 2200×2000 turned upright, at 1757×1933.
      [
        'webp-alpha-shrunk',
        await rgba(2_200, 2_000).webp().withMetadata({ orientation: 6 }).toBuffer(),
      ],
      ['webp-opaque', await rgba(300, 100).flatten().webp().toBuffer()],
      ['webp-animation', await frames('webp', 100, 80, 3)],
    ];
    for (const [name, bytes] of inputs) {
      const file = path.join(dir, `mirror-${name}`);
      writeFileSync(file, bytes);
      const child = await convertInChild(file, bytes);
      const image = await processImage(bytes);
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

  // Linux only: the values are production's allocator's (above).
  it.runIf(process.platform === 'linux')(
    'converts each kind’s costliest case at its bounds within IMAGE_CONVERSION_PEAK_BYTES',
    async () => {
      const still = { channels: 3, depth: 'uchar', isProgressive: false, hasAlpha: false } as const;
      const progressiveBound = largestFramePixels('image/jpeg', { ...still, isProgressive: true });
      const cmykBound = largestFramePixels('image/jpeg', {
        ...still,
        channels: 4,
        isProgressive: true,
      });
      const gifStillBound = largestFramePixels('image/gif', still);
      const webpOpaqueBound = largestFramePixels('image/webp', still);
      const webpAlphaBound = largestFramePixels('image/webp', { ...still, channels: 4 });
      const webpAlphaSide = side(webpAlphaBound);
      const [progressive, cmyk, gifStill, webpOpaque] = [
        progressiveBound,
        cmykBound,
        gifStillBound,
        webpOpaqueBound,
      ].map(side) as [number, number, number, number];
      const gifHeight = Math.floor(
        Math.sqrt(GIF_ANIMATION_LARGEST_FRAME_PIXELS / IMAGE_MAX_SIDE_RATIO),
      );
      const gifWidth = IMAGE_MAX_SIDE_RATIO * gifHeight;
      const animSide = side(WEBP_ANIMATION_LARGEST_FRAME_PIXELS);
      // [case, its input, the bound its frame sits at]: the costliest measured of each kind
      // (ADR-0073 9-8, scripts/image-memory/sweep-encode.mjs), most of them noise — what the
      // encoders hold most for — small enough for IMAGE_MAX_BYTES at a low quality.
      const cases: readonly (readonly [string, ChildInput | Uint8Array, number])[] = [
        [
          'PNG, 8-bit grey + alpha at its costliest shape, with a profile',
          pngOf(32_712, 1_131, { channels: 2, profile: true }),
          PNG_LARGEST_FRAME_PIXELS[2][8][0],
        ],
        [
          'progressive 4:4:4 JPEG of noise',
          {
            format: 'jpeg',
            width: progressive,
            height: progressive,
            encoder: { quality: 12, progressive: true, chromaSubsampling: '4:4:4' },
          },
          progressiveBound,
        ],
        [
          'progressive CMYK JPEG of noise',
          {
            format: 'jpeg',
            width: cmyk,
            height: cmyk,
            colourspace: 'cmyk',
            encoder: { quality: 1, progressive: true },
          },
          cmykBound,
        ],
        [
          'GIF of 16-colour noise',
          { format: 'gif', width: gifStill, height: gifStill, encoder: { colours: 16, dither: 0 } },
          gifStillBound,
        ],
        [
          'GIF animation at 32:1, a colour a frame, as many frames as fit',
          {
            format: 'gif',
            width: gifWidth,
            height: gifHeight,
            content: 'frames',
            frames: Math.floor(IMAGE_MAX_INPUT_PIXELS / (gifWidth * gifHeight)),
          },
          GIF_ANIMATION_LARGEST_FRAME_PIXELS,
        ],
        [
          'opaque WebP of noise',
          { format: 'webp', width: webpOpaque, height: webpOpaque, encoder: { quality: 50 } },
          webpOpaqueBound,
        ],
        [
          'WebP with alpha, colour and alpha both noise, as large as it is written',
          {
            format: 'webp',
            width: side(WEBP_ALPHA_MAX_OUTPUT_PIXELS),
            height: side(WEBP_ALPHA_MAX_OUTPUT_PIXELS),
            channels: 4,
            encoder: { quality: 1 },
          },
          WEBP_ALPHA_MAX_OUTPUT_PIXELS,
        ],
        // Read larger and written at that size (owner decision 2026-10-22 answer 1): the largest
        // taken — its decoding bound, 2,991², written at 1843² (its alpha quantised so the file
        // fits 5MB) — and one read a little larger, its alpha noise of every level.
        [
          'WebP with alpha, noise, at its decoding bound, written smaller',
          {
            format: 'webp',
            width: webpAlphaSide,
            height: webpAlphaSide,
            channels: 4,
            encoder: { quality: 1, alphaQuality: 20 },
          },
          webpAlphaBound,
        ],
        [
          'WebP with alpha, colour and alpha both noise, read larger and written smaller',
          {
            format: 'webp',
            width: 2_000,
            height: 2_000,
            channels: 4,
            encoder: { quality: 1 },
          },
          2_000 * 2_000,
        ],
        [
          'WebP animation of noise with alpha, as many frames as fit',
          {
            format: 'webp',
            width: animSide,
            height: animSide,
            channels: 4,
            alphaLevels: 2,
            frames: Math.floor(WEBP_ANIMATION_MAX_PIXELS / animSide ** 2),
            encoder: { quality: 1 },
          },
          WEBP_ANIMATION_LARGEST_FRAME_PIXELS,
        ],
      ];
      const peaks: Record<string, number> = {};
      for (const [name, input, bound] of cases) {
        const file = path.join(dir, `case-${Object.keys(peaks).length}`);
        let bytes: Uint8Array;
        if (input instanceof Uint8Array) {
          bytes = input;
          writeFileSync(file, bytes);
        } else {
          await makeInChild(input, file);
          bytes = new Uint8Array(readFileSync(file));
        }
        // An upload processImage takes, from its header — at its kind's bound (within 3% of it,
        // so a looser bound fails here until it is measured again).
        const contentType: ImageContentType = sniffImageType(bytes)!;
        const metadata = await sharp(bytes, { animated: true, limitInputPixels: false }).metadata();
        const frameHeight = metadata.pageHeight ?? metadata.height;
        const frame = metadata.width * frameHeight;
        expect(bytes.length, name).toBeLessThanOrEqual(IMAGE_MAX_BYTES);
        expect(frame, name).toBeLessThanOrEqual(largestFramePixels(contentType, metadata));
        expect(frame, name).toBeGreaterThan(0.97 * bound);
        expect(metadata.width * metadata.height, name).toBeLessThanOrEqual(
          largestImagePixels(contentType, metadata),
        );
        const runs: number[] = [];
        for (let run = 0; run < CONVERSION_RUNS; run += 1) {
          const converted = await convertInChild(file, bytes);
          expect(Math.max(converted.width, converted.height), name).toBeLessThanOrEqual(
            IMAGE_MAX_DIMENSION,
          );
          if (contentType === 'image/webp' && metadata.hasAlpha && (metadata.pages ?? 1) === 1) {
            expect(converted.width * converted.height, name).toBeLessThanOrEqual(
              WEBP_ALPHA_MAX_OUTPUT_PIXELS,
            );
          }
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
