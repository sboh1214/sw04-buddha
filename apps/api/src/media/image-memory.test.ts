/**
 * What converting a PNG asks of memory (#46, owner 2026-10-22, ADR-0073 9-8), by libvips' own
 * high-water mark of the memory it allocates (`sharp.cache().memory.high`, in MiB): process-wide
 * and never lowered, so this file has its own process (vitest runs each test file in a process of
 * its own), builds its PNGs by hand (`pngOf` — zlib, no libvips) and checks the mark after each
 * conversion, cheapest first. No database.
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
 * The other PNG kinds — with alpha, 16-bit samples or interlacing (owner 2026-10-22, 2nd answer):
 * most went over the budget at the bound they had before (up to ~275MiB at 32:1), so each kind
 * has its own largest frame (PNG_LARGEST_FRAME_PIXELS), measured at every shape up to 32:1; 16-bit
 * grey and interlaced 8-bit grey keep the bound they had (IMAGE_MAX_INPUT_PIXELS, and 41,943,040
 * for interlaced 16-bit grey). Each kind's costliest shape at its largest frame converts within
 * the budget, with a profile — and a palette with transparency at RGBA's, the kind it decodes to.
 * Those shapes sit just under the steps of libvips' vertical shrink, which come from fitting the
 * frame inside IMAGE_MAX_DIMENSION: this file converts only the shapes recorded, so a change to
 * IMAGE_MAX_DIMENSION, the budget, the ratio or IMAGE_MAX_INPUT_PIXELS, or to sharp or libvips,
 * needs the measurement again (ADR-0073 결과 5).
 */
import { IMAGE_MAX_DIMENSION, IMAGE_MAX_INPUT_PIXELS } from '@buddha/shared';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../common/errors/app-error.js';
import { type PngKind, pngOf } from '../test/png.js';
import {
  IMAGE_DECODE_BUDGET_BYTES,
  IMAGE_MAX_SIDE_RATIO,
  PNG_LARGEST_FRAME_PIXELS,
  processImage,
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

describe('processImage: memory of a thin image (#46, owner 2026-10-22)', () => {
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
