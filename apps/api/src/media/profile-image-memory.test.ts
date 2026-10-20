/**
 * What a profile image's conversion asks of memory (#141, ADR-0079 7-16): never more than a post's
 * image of the same file — the cost the decode budget was measured on (ADR-0073 9-8). Scaling a
 * long panorama straight to the 512 square scales by its short side, which leaves the JPEG
 * decoder no shrink-on-load and libvips a full-size image to turn and resize: a 300KB file came
 * near the API's whole 448 MiB. Each file below passes every header check and is small to send;
 * the way `processProfileImage` takes it must keep it small in memory too.
 *
 * Measured by libvips' own high-water mark of the memory it allocates (`sharp.cache().memory.high`,
 * in MB): process-wide and never lowered, so this file has its own (vitest runs every test file in
 * a process of its own), makes only small files, and checks the mark after each conversion against
 * one bound. On sharp 0.35.5 the ways `processProfileImage` takes stay at or under about 30MB
 * here; scaling straight to the square takes 65–150MB on the same files, and fitting a thin PNG
 * inside 2,048px first (as a post's image is) takes 100MB and up. No database.
 */
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { processProfileImage } from './image.js';

/** The mark no conversion here may pass, in MB: room above the ~30 they take, under the 57+ of the wrong ways. */
const BOUND_MB = 48;

/** libvips' high-water mark of the memory it has allocated in this process, in MB. */
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

describe('processProfileImage: memory (#141)', () => {
  beforeAll(() => {
    // A process of its own: nothing has decoded an image here yet, or the mark would say nothing.
    expect(highWater()).toBeLessThan(BOUND_MB);
  });

  it('takes a long JPEG panorama turned by its EXIF without decoding it whole', async () => {
    // 30000×600 with a quarter turn: 18 megapixels in about 100KB, within every header check.
    const panorama = await made('jpeg', 30_000, 600, 6);
    const image = await processProfileImage(panorama);
    expect(image).toMatchObject({ contentType: 'image/jpeg', width: 512, height: 512 });
    expect(highWater()).toBeLessThanOrEqual(BOUND_MB);
  });

  it('takes a long WebP panorama turned by its EXIF through its scaled decoding', async () => {
    const image = await processProfileImage(await made('webp', 8_000, 400, 6));
    expect(image).toMatchObject({ contentType: 'image/webp', width: 512, height: 512 });
    expect(highWater()).toBeLessThanOrEqual(BOUND_MB);
  });

  it('takes a long PNG panorama turned by its EXIF by cutting the square first', async () => {
    const image = await processProfileImage(await made('png', 20_000, 500, 6));
    expect(image).toMatchObject({ contentType: 'image/png', width: 512, height: 512 });
    expect(highWater()).toBeLessThanOrEqual(BOUND_MB);
  });

  it('takes a PNG as thin as a line without the long-side reduce that makes one cost gigabytes', async () => {
    // 400000×10: fitted inside 2,048px first, as a post's image is, this alone takes ~120MB, and
    // 5,000,000×10 — still a 50KB file — about 1.5GB as RGB (ADR-0079 결과 5).
    const image = await processProfileImage(await made('png', 400_000, 10));
    expect(image).toMatchObject({ contentType: 'image/png', width: 512, height: 512 });
    expect(highWater()).toBeLessThanOrEqual(BOUND_MB);
  });
});
