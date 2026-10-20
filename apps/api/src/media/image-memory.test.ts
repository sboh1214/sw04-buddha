/**
 * What converting a thin image asks of memory (#46, owner 2026-10-22, ADR-0073 9-8): a frame's
 * long side at most IMAGE_MAX_SIDE_RATIO times its short side. Fitting a strip inside 2,048px
 * leaves libvips a few output rows to make, so it holds every input row at once and buffers a
 * whole row wide on top: a 49KB grey PNG of 5,000,000×10 took ~500MiB and the same RGB ~1.5GiB —
 * within every other header check, from any account that finished onboarding, in an API whose
 * container has 448 MiB. Such a file is refused from its header, decoding nothing; the thinnest
 * frame the ratio lets through, at the most pixels an 8-bit grey or RGB PNG may have, converts
 * within IMAGE_DECODE_BUDGET_BYTES — with an embedded ICC profile too, which has sharp turn the
 * pixels into sRGB before it resizes.
 *
 * Measured by libvips' own high-water mark of the memory it allocates (`sharp.cache().memory.high`,
 * in MiB): process-wide and never lowered, so this file has its own process (vitest runs each test
 * file in a process of its own), builds its PNGs by hand (`pngOf` — zlib, no libvips) and checks
 * the mark after each step, cheapest first. On sharp 0.35.5 at 32:1: 8-bit grey 39MiB, with a
 * profile 73; 16-bit grey 78; 8-bit grey + alpha 90; RGB 116 with its quarter turn, 118 with a
 * profile as well — at 48:1 the RGB frame would take 132MiB, at 100:1 162MiB. The PNGs that go
 * over at this ratio (alpha or 16-bit colour, and grey + alpha with a profile — 147MiB) are the
 * open question of ADR-0073 결과 4 (1), so they are not converted here. No database.
 */
import { IMAGE_MAX_DIMENSION, IMAGE_MAX_INPUT_PIXELS } from '@buddha/shared';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../common/errors/app-error.js';
import { pngOf } from '../test/png.js';
import { IMAGE_DECODE_BUDGET_BYTES, IMAGE_MAX_SIDE_RATIO, processImage } from './image.js';

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
    // Exactly IMAGE_MAX_SIDE_RATIO to 1 with as many pixels as an 8-bit PNG may have
    // (IMAGE_MAX_INPUT_PIXELS): 40000×1250 at 32:1. Taken from the constant, so a looser ratio is
    // measured here too (at 48:1 the RGB frame would take 132MiB).
    const short = Math.floor(Math.sqrt(IMAGE_MAX_INPUT_PIXELS / IMAGE_MAX_SIDE_RATIO));
    const long = IMAGE_MAX_SIDE_RATIO * short;
    const fitted = Math.round(IMAGE_MAX_DIMENSION / IMAGE_MAX_SIDE_RATIO);
    const wide = { contentType: 'image/png', width: 2_048, height: fitted };
    const convert = async (options: Parameters<typeof pngOf>[2]) => {
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
    // 16-bit grey (sharp does not use its profile either) and 8-bit grey + alpha without one: not
    // among the PNGs that go over (ADR-0073 결과 4 (1)) — with a profile, grey + alpha is (147MiB).
    expect(await convert({ channels: 1, depth: 16 })).toMatchObject(wide);
    expect(await convert({ channels: 2 })).toMatchObject(wide);
    // RGB with a quarter turn by EXIF, then with a profile as well: the costliest of these.
    const upright = { contentType: 'image/png', width: fitted, height: 2_048 };
    expect(await convert({ channels: 3, orientation: 6 })).toMatchObject(upright);
    expect(await convert({ channels: 3, orientation: 6, profile: true })).toMatchObject(upright);
    // The mark saw the conversion (a gauge that read nothing would pass the lines above).
    expect(highWater()).toBeGreaterThan(BUDGET_MIB / 2);
  });
});
