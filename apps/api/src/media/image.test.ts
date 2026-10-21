/**
 * The image rules of #46 (ADR-0069 decision 2 #45-3) on real files made here with sharp: the
 * content decides the type (a disguised file is refused), metadata never survives (EXIF, the
 * orientation tag included, after the pixels were turned upright), the long side is at most
 * 2,048px and never enlarged, an animation keeps its frames and timing, and a decompression bomb
 * is refused from its header. No database.
 */
import { IMAGE_MAX_BYTES, IMAGE_MAX_DIMENSION, IMAGE_MAX_INPUT_PIXELS } from '@buddha/shared';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../common/errors/app-error.js';
import { jpegWithComponents, jpegWithFrame } from '../test/jpeg.js';
import { type PngKind, pngHeaderOnly, pngOf } from '../test/png.js';
import {
  GIF_ANIMATION_LARGEST_FRAME_PIXELS,
  IMAGE_CONVERSION_PEAK_BYTES,
  IMAGE_DECODE_BUDGET_BYTES,
  IMAGE_MAX_SIDE_RATIO,
  JPEG_MAX_COMPONENTS,
  OneAtATime,
  PNG_LARGEST_FRAME_PIXELS,
  WEBP_ALPHA_LARGEST_FRAME_PIXELS,
  WEBP_ANIMATION_LARGEST_FRAME_PIXELS,
  WEBP_ANIMATION_MAX_PIXELS,
  decodeBytesPerPixel,
  encoderOptions,
  imageConversions,
  largestFramePixels,
  largestImagePixels,
  processImage,
  sniffImageType,
} from './image.js';

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } });

/** An animation of `frames` frames, each `width`×`height`, 120 ms apart, looping. */
async function animation(
  format: 'gif' | 'webp',
  width: number,
  height: number,
  frames: number,
): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * frames * 3);
  for (let i = 0; i < width * height * frames; i += 1) {
    raw[i * 3] = Math.floor(i / (width * height)) * 80;
  }
  const image = sharp(raw, {
    raw: { width, height: height * frames, channels: 3, pageHeight: height },
  });
  const delay = Array.from({ length: frames }, () => 120);
  return format === 'gif'
    ? image.gif({ delay, loop: 0 }).toBuffer()
    : image.webp({ delay, loop: 0 }).toBuffer();
}

/** The reason of an IMAGE_NOT_ALLOWED refusal. */
async function refusal(bytes: Uint8Array): Promise<unknown> {
  try {
    await processImage(bytes);
  } catch (error) {
    if (error instanceof AppError && error.code === 'IMAGE_NOT_ALLOWED') {
      expect(error.status).toBe(422);
      return (error.details as { reason: string }).reason;
    }
    throw error;
  }
  throw new Error('accepted');
}

/** A frame of exactly `pixels`, wider than tall and no thinner than the ratio allows. */
function frameOf(pixels: number): readonly [width: number, height: number] {
  let height = Math.floor(Math.sqrt(pixels));
  while (pixels % height !== 0 || pixels / height > IMAGE_MAX_SIDE_RATIO * height) height -= 1;
  return [pixels / height, height];
}

/**
 * What the header checks make of a PNG of this kind at exactly `bound` pixels and one column past
 * it: at the bound the header passes and the decoder gets the few bytes of pixels there are
 * (`unreadable`); a column more is refused before anything is decoded (`pixels`).
 */
async function atAndPast(kind: PngKind, bound: number) {
  const [width, height] = frameOf(bound);
  const at = await refusal(pngHeaderOnly(width, height, kind));
  const past = await refusal(pngHeaderOnly(width + 1, height, kind));
  return { kind, width, height, at, past };
}

describe('sniffImageType: the content decides, never the name', () => {
  it('knows the four types by their magic numbers', async () => {
    expect(sniffImageType(await solid(2, 2).jpeg().toBuffer())).toBe('image/jpeg');
    expect(sniffImageType(await solid(2, 2).png().toBuffer())).toBe('image/png');
    expect(sniffImageType(await solid(2, 2).gif().toBuffer())).toBe('image/gif');
    expect(sniffImageType(await solid(2, 2).webp().toBuffer())).toBe('image/webp');
    expect(sniffImageType(Buffer.from('GIF87a'))).toBe('image/gif');
  });

  it('knows nothing else, whatever it would be named', () => {
    for (const text of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<!DOCTYPE html><img src=x onerror=alert(1)>',
      '%PDF-1.7',
      'RIFF\u0000\u0000\u0000\u0000WAVEfmt ',
      '',
    ]) {
      expect(sniffImageType(Buffer.from(text)), text).toBeUndefined();
    }
    // A HEIC/AVIF box, a TIFF and a BMP: images, but not ones a post takes.
    expect(
      sniffImageType(Buffer.from('\u0000\u0000\u0000\u0018ftypheic', 'latin1')),
    ).toBeUndefined();
    expect(sniffImageType(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toBeUndefined();
    expect(sniffImageType(Buffer.from('BM'))).toBeUndefined();
  });
});

describe('processImage', () => {
  it('removes EXIF after turning a photo upright by it, and shrinks the long side to 2,048px', async () => {
    const photo = await solid(3000, 1500)
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Copyright: 'GPS 37.5665 126.9780', Make: 'PhoneMaker' } })
      .toBuffer();
    const before = await sharp(photo).metadata();
    expect(before.orientation).toBe(6);
    expect(before.exif).toBeDefined();

    const image = await processImage(photo);
    expect(image.contentType).toBe('image/jpeg');
    // Orientation 6 is a quarter turn: the 3000×1500 landscape is shown 1500×3000, then fitted.
    expect({ width: image.width, height: image.height }).toEqual({
      width: IMAGE_MAX_DIMENSION / 2,
      height: IMAGE_MAX_DIMENSION,
    });
    const after = await sharp(image.body).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.iptc).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(after.orientation).toBeUndefined();
    expect(Buffer.from(image.body).includes('PhoneMaker')).toBe(false);
  });

  it('never enlarges a small image, and keeps a PNG a PNG and a WebP a WebP', async () => {
    const png = await processImage(await solid(50, 40).png().toBuffer());
    expect(png).toMatchObject({ contentType: 'image/png', width: 50, height: 40 });
    expect((await sharp(png.body).metadata()).format).toBe('png');
    const webp = await processImage(await solid(2100, 300).webp().toBuffer());
    expect(webp).toMatchObject({ contentType: 'image/webp', width: 2048, height: 293 });
  });

  it('keeps an animated GIF moving: every frame and its timing, each frame fitted', async () => {
    const image = await processImage(await animation('gif', 3000, 100, 3));
    expect(image).toMatchObject({ contentType: 'image/gif', width: 2048, height: 68 });
    const after = await sharp(image.body, { animated: true }).metadata();
    expect(after.pages).toBe(3);
    expect(after.delay).toEqual([120, 120, 120]);
    expect(after.loop).toBe(0);
  });

  it('keeps an animated WebP moving too', async () => {
    const image = await processImage(await animation('webp', 40, 30, 2));
    expect(image).toMatchObject({ contentType: 'image/webp', width: 40, height: 30 });
    expect((await sharp(image.body, { animated: true }).metadata()).pages).toBe(2);
  });

  it('refuses what is not one of the four types by content, whatever it claims', async () => {
    expect(await refusal(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('type');
    expect(await refusal(Buffer.from('<html><script>alert(1)</script></html>'))).toBe('type');
    expect(await refusal(await solid(4, 4).tiff().toBuffer())).toBe('type');
  });

  it('refuses a file that starts like an image and does not decode as one', async () => {
    const jpeg = await solid(200, 200).jpeg().toBuffer();
    expect(await refusal(jpeg.subarray(0, 40))).toBe('unreadable');
    expect(
      await refusal(
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.from('junk'),
        ]),
      ),
    ).toBe('unreadable');
    expect(await refusal(Buffer.from('GIF89a garbage'))).toBe('unreadable');
  });

  it('refuses an empty file and one over 5MB before looking at it', async () => {
    expect(await refusal(new Uint8Array(0))).toBe('empty');
    const big = Buffer.alloc(IMAGE_MAX_BYTES + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect(await refusal(big)).toBe('size');
  });

  it('refuses a decompression bomb from its header, before decoding it', async () => {
    expect(await refusal(pngHeaderOnly(100_000, 100_000))).toBe('pixels');
    expect(await refusal(pngHeaderOnly(8_000, 7_000))).toBe('pixels');
    // Every frame counts: 300 frames of 500×500 is 75 megapixels — too many frames, each small.
    expect(await refusal(await animation('gif', 500, 500, 300))).toBe('frames');
  });

  it('refuses a frame too large for the memory its format takes to decode, small files too', async () => {
    const rgba = (width: number, height: number) =>
      sharp({
        create: { width, height, channels: 4, background: { r: 9, g: 99, b: 199, alpha: 0.5 } },
      });
    // A GIF frame is unpacked whole: a 16-megapixel one is a few KB on disk and ~250MB in memory.
    const gif = await rgba(4_096, 4_096).gif().toBuffer();
    expect(gif.length).toBeLessThan(64 * 1024);
    expect(await refusal(gif)).toBe('pixels');
    expect(await refusal(await rgba(3_500, 3_500).webp({ lossless: true }).toBuffer())).toBe(
      'pixels',
    );
    // 16-bit samples count twice; an interlaced PNG is decoded whole; a progressive JPEG keeps
    // its coefficients — all under the 50 megapixels a baseline photo may have.
    expect(await refusal(await rgba(6_000, 6_000).toColourspace('rgb16').png().toBuffer())).toBe(
      'pixels',
    );
    expect(await refusal(await rgba(5_000, 5_000).png({ progressive: true }).toBuffer())).toBe(
      'pixels',
    );
    expect(await refusal(await solid(5_000, 5_000).jpeg({ progressive: true }).toBuffer())).toBe(
      'pixels',
    );
    // An 8-bit RGBA PNG of 8000×6000 (48 megapixels, under the 50 million every frame together may
    // have) is past that kind's largest frame (owner 2026-10-22).
    expect(await refusal(pngHeaderOnly(8_000, 6_000, { channels: 4 }))).toBe('pixels');
  });

  it('bounds a progressive JPEG by its components from its header, and refuses more than four', async () => {
    const red = () => solid(16, 16);
    const rgb = await red().jpeg({ progressive: true, chromaSubsampling: '4:4:4' }).toBuffer();
    const cmyk = await red().toColourspace('cmyk').jpeg({ progressive: true }).toBuffer();
    const baselineCmyk = await red().toColourspace('cmyk').jpeg().toBuffer();
    expect(await sharp(cmyk).metadata()).toMatchObject({
      channels: 4,
      space: 'cmyk',
      isProgressive: true,
    });
    expect(await processImage(cmyk)).toMatchObject({ contentType: 'image/jpeg', width: 16 });

    // Four components keep a third more coefficients than three (Codex review of #219, round 3):
    // at its bound the header passes and the decoder gets the few bytes of pixels there are
    // (`unreadable`); a column more is refused before anything is decoded.
    const bound = largestFramePixels('image/jpeg', {
      channels: 4,
      depth: 'uchar',
      isProgressive: true,
      hasAlpha: false,
    });
    const [width, height] = frameOf(bound);
    expect(await refusal(jpegWithFrame(cmyk, width, height))).toBe('unreadable');
    expect(await refusal(jpegWithFrame(cmyk, width + 1, height))).toBe('pixels');
    // At the three-component bound (3,663², ~158MiB for CMYK) only three components pass.
    expect(await refusal(jpegWithFrame(rgb, 3_663, 3_663))).toBe('unreadable');
    expect(await refusal(jpegWithFrame(cmyk, 3_663, 3_663))).toBe('pixels');
    // A baseline CMYK JPEG is shrunk while it is decoded, as a baseline RGB one is.
    expect(await refusal(jpegWithFrame(baselineCmyk, 7_071, 7_071))).toBe('unreadable');

    // A fifth component: sharp reads it and would convert it (five bands, the first three taken
    // for the JPEG it writes) — a small file here, 187MiB at the three-component bound — so the
    // header refuses it, small or not. Six and up sharp's own header read refuses.
    const five = jpegWithComponents(cmyk, 1);
    expect((await sharp(five).metadata()).channels).toBe(JPEG_MAX_COMPONENTS + 1);
    expect((await sharp(five).jpeg().toBuffer({ resolveWithObject: true })).info).toMatchObject({
      width: 16,
    });
    expect(await refusal(five)).toBe('unreadable');
    expect(await refusal(jpegWithComponents(rgb, 2))).toBe('unreadable');
    expect(await refusal(jpegWithComponents(cmyk, 2))).toBe('unreadable');
  });

  it('refuses a PNG past its kind’s largest frame from its header, and decodes one at it', async () => {
    for (const channels of [1, 2, 3, 4] as const) {
      for (const depth of [8, 16] as const) {
        for (const interlaced of [false, true]) {
          const kind: PngKind = { channels, depth, interlaced };
          const bound = PNG_LARGEST_FRAME_PIXELS[channels][depth][interlaced ? 1 : 0];
          expect(await atAndPast(kind, bound)).toMatchObject({ at: 'unreadable', past: 'pixels' });
        }
      }
    }
  });

  it('bounds a palette or transparent-colour PNG by what it decodes to, from its header', async () => {
    // ADR-0073 9-8: a palette decodes to 8-bit RGB, or RGBA with transparency (a tRNS chunk) —
    // whatever its bits an index (1 to 8); grey or RGB with a transparent colour, to grey + alpha
    // or RGBA at its own depth. The bound is chosen by what sharp's header says it decodes to
    // (`channels`, `depth`), so a reading that left out the transparency would give such a PNG
    // the larger bound of the kind without alpha — 50 million pixels where RGBA's is 19.7 million
    // — which every case here would catch, either at the bound or a column past it.
    const { 1: grey, 2: greyAlpha, 3: rgb, 4: rgba } = PNG_LARGEST_FRAME_PIXELS;
    const cases: readonly (readonly [PngKind, number])[] = [
      [{ palette: 8 }, rgb[8][0]],
      [{ palette: 8, interlaced: true }, rgb[8][1]],
      [{ palette: 1, interlaced: true }, rgb[8][1]],
      [{ palette: 8, transparent: true }, rgba[8][0]],
      [{ palette: 4, transparent: true }, rgba[8][0]],
      [{ palette: 2, transparent: true }, rgba[8][0]],
      [{ palette: 1, transparent: true }, rgba[8][0]],
      [{ palette: 8, transparent: true, interlaced: true }, rgba[8][1]],
      [{ channels: 1, transparent: true }, greyAlpha[8][0]],
      [{ channels: 1, transparent: true, interlaced: true }, greyAlpha[8][1]],
      [{ channels: 1, depth: 16, transparent: true }, greyAlpha[16][0]],
      [{ channels: 3, transparent: true }, rgba[8][0]],
      [{ channels: 3, transparent: true, interlaced: true }, rgba[8][1]],
      [{ channels: 3, depth: 16, transparent: true }, rgba[16][0]],
      [{ channels: 3, depth: 16, transparent: true, interlaced: true }, rgba[16][1]],
    ];
    // Each bound differs from the bound of the same kind without the transparency, so a case tells
    // the two apart; an interlaced opaque palette's, from every other 8-bit kind's.
    for (const depth of [8, 16] as const) {
      for (const interlaced of [0, 1] as const) {
        expect(rgba[depth][interlaced]).not.toBe(rgb[depth][interlaced]);
        expect(greyAlpha[depth][interlaced]).not.toBe(grey[depth][interlaced]);
      }
    }
    for (const other of [grey, greyAlpha, rgba]) expect(other[8][1]).not.toBe(rgb[8][1]);
    for (const [kind, bound] of cases) {
      expect(await atAndPast(kind, bound)).toMatchObject({ at: 'unreadable', past: 'pixels' });
    }
  });

  it('bounds sharp’s own palette PNGs — the kind pngquant writes — by what they decode to', async () => {
    const translucent = () =>
      sharp({
        create: {
          width: 64,
          height: 32,
          channels: 4,
          background: { r: 10, g: 200, b: 30, alpha: 0.5 },
        },
      });
    const files = [
      // [file, bits an index, whether it has a tRNS chunk, its bound]
      [await solid(64, 32).png({ palette: true }).toBuffer(), 8, false, [3, 8, 0]],
      [await translucent().png({ palette: true }).toBuffer(), 8, true, [4, 8, 0]],
      [await translucent().png({ palette: true, colours: 2 }).toBuffer(), 1, true, [4, 8, 0]],
      [
        await translucent().png({ palette: true, progressive: true }).toBuffer(),
        8,
        true,
        [4, 8, 1],
      ],
    ] as const;
    for (const [file, bits, transparent, [channels, depth, interlaced]] of files) {
      // A palette PNG (colour type 3) of those bits, with or without its transparency.
      expect([file[24], file[25], file.includes('tRNS')]).toEqual([bits, 3, transparent]);
      expect(largestFramePixels('image/png', await sharp(file).metadata())).toBe(
        PNG_LARGEST_FRAME_PIXELS[channels][depth][interlaced],
      );
      expect(await processImage(file)).toMatchObject({
        contentType: 'image/png',
        width: 64,
        height: 32,
      });
    }
  });

  it('refuses a frame over 32 times longer than wide, either way round, from its header', async () => {
    expect(IMAGE_MAX_SIDE_RATIO).toBe(32);
    // The owner's case (2026-10-22): 49KB of grey PNG that took ~500MiB to convert, ~1.5GiB as
    // RGB — within the pixels and the decode budget its format is allowed (the memory is
    // `image-memory.test.ts`'s).
    const line = pngOf(5_000_000, 10, { channels: 1 });
    expect(line.length).toBeLessThan(64 * 1024);
    expect(await refusal(line)).toBe('pixels');
    expect(await refusal(pngOf(5_000_000, 10))).toBe('pixels');
    expect(await refusal(pngOf(10, 5_000_000))).toBe('pixels');
    // Just past 32:1 either way, small as it is; in an animation, one frame's sides count.
    expect(await refusal(await solid(3_201, 100).png().toBuffer())).toBe('pixels');
    expect(await refusal(await solid(100, 3_201).jpeg().toBuffer())).toBe('pixels');
    expect(await refusal(await animation('gif', 330, 10, 3))).toBe('pixels');
  });

  it('takes a frame exactly 32 times longer than wide', async () => {
    const strip = await processImage(await solid(3_200, 100).png().toBuffer());
    expect(strip).toMatchObject({ contentType: 'image/png', width: 2_048, height: 64 });
    const tall = await processImage(await solid(100, 3_200).jpeg().toBuffer());
    expect(tall).toMatchObject({ contentType: 'image/jpeg', width: 64, height: 2_048 });
    // Frames of 320×10, stacked 320×30: each frame is what is measured.
    const gif = await processImage(await animation('gif', 320, 10, 3));
    expect(gif).toMatchObject({ contentType: 'image/gif', width: 320, height: 10 });
  });

  it('still takes a phone photo, a 5K screenshot and a 4K GIF', async () => {
    const photo = await processImage(await solid(8_000, 6_000).jpeg().toBuffer());
    expect(photo).toMatchObject({ contentType: 'image/jpeg', width: 2_048, height: 1_536 });
    const screenshot = await processImage(
      await sharp({
        create: { width: 5_120, height: 2_880, channels: 4, background: '#33669980' },
      })
        .png()
        .toBuffer(),
    );
    expect(screenshot).toMatchObject({ contentType: 'image/png', width: 2_048, height: 1_152 });
    const gif = await processImage(await solid(3_840, 2_160).gif().toBuffer());
    expect(gif).toMatchObject({ contentType: 'image/gif', width: 2_048, height: 1_152 });
  });

  it('bounds a frame by its format’s measured largest frame', () => {
    const still = { channels: 3, depth: 'uchar', isProgressive: false, hasAlpha: false } as const;
    expect(decodeBytesPerPixel('image/jpeg', still)).toBe(1);
    expect(decodeBytesPerPixel('image/jpeg', { ...still, channels: 4 })).toBe(1);
    expect(decodeBytesPerPixel('image/jpeg', { isProgressive: true, channels: 1 })).toBe(10);
    expect(decodeBytesPerPixel('image/jpeg', { isProgressive: true, channels: 3 })).toBe(10);
    expect(decodeBytesPerPixel('image/jpeg', { isProgressive: true, channels: 4 })).toBe(14);
    expect(decodeBytesPerPixel('image/gif', still)).toBe(16);
    expect(decodeBytesPerPixel('image/webp', still)).toBe(15);
    // A JPEG, GIF or WebP frame: the budget over what one of its pixels holds — a 4K frame
    // (3840×2160) fits every one; the budget is the API's, well under its 448 MiB. A baseline
    // JPEG's (a byte a pixel) is past the 50 million every frame together may have.
    expect(largestFramePixels('image/jpeg', still)).toBe(134_217_728);
    expect(largestFramePixels('image/jpeg', { ...still, isProgressive: true })).toBe(13_421_772);
    // A progressive CMYK JPEG: 3,096² — an A4 page at 300dpi (2,480×3,508) fits.
    const cmyk = { ...still, channels: 4, isProgressive: true } as const;
    expect(largestFramePixels('image/jpeg', cmyk)).toBe(9_586_980);
    expect(2_480 * 3_508).toBeLessThan(largestFramePixels('image/jpeg', cmyk));
    expect(JPEG_MAX_COMPONENTS).toBe(4);
    expect(largestFramePixels('image/gif', still)).toBe(8_388_608);
    expect(largestFramePixels('image/webp', still)).toBe(8_947_848);
    expect(3_840 * 2_160).toBeLessThan(largestFramePixels('image/gif', still));
    expect(IMAGE_DECODE_BUDGET_BYTES).toBe(128 * 1024 * 1024);
    // What the encoders hold is not libvips' to count: a still WebP with alpha, a WebP animation
    // and a GIF animation have bounds measured on the whole conversion, within
    // IMAGE_CONVERSION_PEAK_BYTES (Codex review of #219, round 3; `image-memory.test.ts`). A WebP
    // animation's frames together have a bound of their own too; a GIF's do not.
    expect(IMAGE_CONVERSION_PEAK_BYTES).toBe(144 * 1024 * 1024);
    expect([
      WEBP_ALPHA_LARGEST_FRAME_PIXELS,
      WEBP_ANIMATION_LARGEST_FRAME_PIXELS,
      WEBP_ANIMATION_MAX_PIXELS,
      GIF_ANIMATION_LARGEST_FRAME_PIXELS,
    ]).toEqual([2_600_000, 1_050_000, 12_000_000, 5_000_000]);
    const alpha = { ...still, channels: 4, hasAlpha: true } as const;
    expect(largestFramePixels('image/webp', alpha)).toBe(WEBP_ALPHA_LARGEST_FRAME_PIXELS);
    expect(largestFramePixels('image/webp', { ...still, pages: 1 })).toBe(8_947_848);
    for (const animation of [
      { ...still, pages: 2 },
      { ...alpha, pages: 12 },
    ]) {
      expect(largestFramePixels('image/webp', animation)).toBe(WEBP_ANIMATION_LARGEST_FRAME_PIXELS);
      expect(largestImagePixels('image/webp', animation)).toBe(WEBP_ANIMATION_MAX_PIXELS);
      expect(largestFramePixels('image/gif', animation)).toBe(GIF_ANIMATION_LARGEST_FRAME_PIXELS);
      expect(largestImagePixels('image/gif', animation)).toBe(IMAGE_MAX_INPUT_PIXELS);
    }
    expect(largestFramePixels('image/gif', { ...alpha, pages: 1 })).toBe(8_388_608);
    expect(largestImagePixels('image/webp', { ...alpha, pages: 1 })).toBe(IMAGE_MAX_INPUT_PIXELS);
    // A 1280×720 WebP animation and a 1600×1600 sticker fit; so does a 2560×1440 (QHD) frame of
    // a GIF animation (a 4K one does not: 8.3 megapixels).
    expect(1_280 * 720).toBeLessThanOrEqual(WEBP_ANIMATION_LARGEST_FRAME_PIXELS);
    expect(1_600 * 1_600).toBeLessThanOrEqual(WEBP_ALPHA_LARGEST_FRAME_PIXELS);
    expect(2_560 * 1_440).toBeLessThanOrEqual(GIF_ANIMATION_LARGEST_FRAME_PIXELS);
    // A PNG frame: its kind's measured value (owner 2026-10-22; `image-memory.test.ts` converts
    // each kind's costliest shape at it), by the channels it decodes to, 8 or 16 bits a sample,
    // interlaced or not. 8-bit grey (interlaced too), plain 8-bit RGB and plain 16-bit grey keep
    // the 50 million pixels every frame together may have, and interlaced 16-bit grey the bound it
    // had (128MiB at 3.2 bytes a pixel).
    expect(PNG_LARGEST_FRAME_PIXELS).toEqual({
      1: {
        8: [IMAGE_MAX_INPUT_PIXELS, IMAGE_MAX_INPUT_PIXELS],
        16: [IMAGE_MAX_INPUT_PIXELS, 41_943_040],
      },
      2: { 8: [37_000_000, 24_500_000], 16: [25_900_000, 17_300_000] },
      3: { 8: [IMAGE_MAX_INPUT_PIXELS, 26_400_000], 16: [13_100_000, 10_300_000] },
      4: { 8: [19_700_000, 15_700_000], 16: [3_300_000, 4_600_000] },
    });
    const png = (channels: 1 | 2 | 3 | 4, depth: 'uchar' | 'ushort', isProgressive: boolean) =>
      largestFramePixels('image/png', {
        channels,
        depth,
        isProgressive,
        hasAlpha: channels % 2 === 0,
      });
    expect(png(4, 'uchar', false)).toBe(PNG_LARGEST_FRAME_PIXELS[4][8][0]);
    expect(png(2, 'ushort', false)).toBe(PNG_LARGEST_FRAME_PIXELS[2][16][0]);
    expect(png(3, 'uchar', true)).toBe(PNG_LARGEST_FRAME_PIXELS[3][8][1]);
    expect(png(4, 'ushort', true)).toBe(PNG_LARGEST_FRAME_PIXELS[4][16][1]);
    // Each is at most what every frame together may have, measured kind by kind — not always
    // lower with alpha, 16 bits or interlacing: plain 16-bit grey and interlaced 8-bit grey keep the
    // 50 million, and interlaced 16-bit RGBA was measured higher than plain (an interlaced PNG is
    // decoded whole, so its costliest shape is another). A 5K screenshot in RGBA (5120×2880) fits.
    for (const byDepth of Object.values(PNG_LARGEST_FRAME_PIXELS)) {
      for (const [plain, interlaced] of Object.values(byDepth)) {
        expect(plain).toBeLessThanOrEqual(IMAGE_MAX_INPUT_PIXELS);
        expect(interlaced).toBeLessThanOrEqual(IMAGE_MAX_INPUT_PIXELS);
      }
    }
    expect(PNG_LARGEST_FRAME_PIXELS[4][8][0]).toBeLessThan(PNG_LARGEST_FRAME_PIXELS[3][8][0]);
    expect(PNG_LARGEST_FRAME_PIXELS[3][16][0]).toBeLessThan(PNG_LARGEST_FRAME_PIXELS[3][8][0]);
    expect(PNG_LARGEST_FRAME_PIXELS[3][8][1]).toBeLessThan(PNG_LARGEST_FRAME_PIXELS[3][8][0]);
    expect(PNG_LARGEST_FRAME_PIXELS[1][16][0]).toBe(IMAGE_MAX_INPUT_PIXELS);
    expect(PNG_LARGEST_FRAME_PIXELS[1][8][1]).toBe(IMAGE_MAX_INPUT_PIXELS);
    expect(PNG_LARGEST_FRAME_PIXELS[4][16][1]).toBeGreaterThan(PNG_LARGEST_FRAME_PIXELS[4][16][0]);
    expect(5_120 * 2_880).toBeLessThanOrEqual(PNG_LARGEST_FRAME_PIXELS[4][8][0]);
  });
});

describe('the encoders: settings and the bounds the whole conversion needs (Codex review of #219, round 3)', () => {
  it('asks each encoder for the settings measured to bound its memory', () => {
    expect(encoderOptions('image/jpeg', { hasAlpha: false })).toEqual({
      quality: 85,
      mozjpeg: true,
    });
    expect(encoderOptions('image/png', { hasAlpha: true })).toEqual({});
    // libimagequant at 3 holds about half what it holds from 4 up (sharp's default is 7).
    expect(encoderOptions('image/gif', { hasAlpha: true, pages: 4 })).toEqual({ effort: 3 });
    // libwebp from 3 up keeps the whole image's tokens; with alpha, the least effort's alpha coder.
    expect(encoderOptions('image/webp', { hasAlpha: false })).toEqual({
      quality: 85,
      effort: 2,
      smartSubsample: false,
    });
    expect(encoderOptions('image/webp', { hasAlpha: true })).toEqual({
      quality: 85,
      effort: 0,
      smartSubsample: false,
    });
    expect(encoderOptions('image/webp', { hasAlpha: true, pages: 3 })).toMatchObject({ effort: 2 });
  });

  it('refuses a WebP with alpha, a WebP animation and a GIF animation past their own bounds, from the header', async () => {
    const sticker = (width: number, height: number) =>
      sharp({
        create: { width, height, channels: 4, background: { r: 9, g: 99, b: 199, alpha: 0.5 } },
      })
        .webp()
        .toBuffer();
    // 1700×1700 is 2.89 megapixels: past a WebP with alpha's bound, within one without alpha's.
    expect(await refusal(await sticker(1_700, 1_700))).toBe('pixels');
    expect(await processImage(await sticker(1_600, 1_600))).toMatchObject({
      contentType: 'image/webp',
      width: 1_600,
    });
    expect(await processImage(await solid(1_700, 1_700).webp().toBuffer())).toMatchObject({
      contentType: 'image/webp',
      width: 1_700,
    });
    // A WebP animation: a frame past its bound is `pixels`, frames together past theirs `frames`.
    expect(await refusal(await animation('webp', 1_100, 1_000, 2))).toBe('pixels');
    expect(await refusal(await animation('webp', 600, 600, 34))).toBe('frames');
    expect(await processImage(await animation('webp', 1_000, 1_000, 2))).toMatchObject({
      contentType: 'image/webp',
      width: 1_000,
    });
    // A GIF animation's frame has a bound of its own; a still GIF keeps its decoding's.
    expect(await refusal(await animation('gif', 2_300, 2_300, 2))).toBe('pixels');
    expect(await processImage(await solid(2_300, 2_300).gif().toBuffer())).toMatchObject({
      contentType: 'image/gif',
      width: 2_048,
    });
  }, 60_000);
});

describe('one conversion at a time', () => {
  /** A task that runs until `finish` is called, recording that it started. */
  function gate() {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const state = { started: false, finish };
    const task = () => {
      state.started = true;
      return done;
    };
    return { state, task };
  }

  it('runs the next task only once the one before ended, in order, failures too', async () => {
    const queue = new OneAtATime(5);
    const first = gate();
    const second = gate();
    const third = gate();
    const a = queue.run(first.task);
    const b = queue.run(() => Promise.reject(new Error('failed')));
    const c = queue.run(second.task);
    const d = queue.run(third.task);
    expect(queue.size).toBe(4);
    await Promise.resolve();
    expect([first.state.started, second.state.started]).toEqual([true, false]);
    first.state.finish();
    await a;
    await expect(b).rejects.toThrow('failed');
    await vi.waitFor(() => {
      expect(second.state.started).toBe(true);
    });
    expect(third.state.started).toBe(false);
    second.state.finish();
    third.state.finish();
    await Promise.all([c, d]);
    expect(queue.size).toBe(0);
  });

  it('refuses a task when the queue is full, as RATE_LIMITED with when to send again', async () => {
    const queue = new OneAtATime(1);
    const running = gate();
    const waiting = gate();
    const held = [queue.run(running.task), queue.run(waiting.task)];
    await expect(queue.run(() => Promise.resolve())).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 2 },
    });
    running.state.finish();
    waiting.state.finish();
    await Promise.all(held);
    await expect(queue.run(() => Promise.resolve('next'))).resolves.toBe('next');
  });

  it('is what processImage converts through', async () => {
    const run = vi.spyOn(imageConversions, 'run');
    try {
      await Promise.all([
        processImage(await solid(20, 20).png().toBuffer()),
        processImage(await solid(20, 20).jpeg().toBuffer()),
      ]);
      expect(run).toHaveBeenCalledTimes(2);
      // A refusal from the header waits for nothing.
      await refusal(pngHeaderOnly(100_000, 100_000));
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      run.mockRestore();
    }
  });
});
