/**
 * The image rules of #46 (ADR-0069 decision 2 #45-3) on real files made here with sharp: the
 * content decides the type (a disguised file is refused), metadata never survives (EXIF, the
 * orientation tag included, after the pixels were turned upright), the long side is at most
 * 2,048px and never enlarged, an animation keeps its frames and timing, and a decompression bomb
 * is refused from its header, and so is a very thin or long image (owner decision 2026-10-22). And
 * a profile image's (#141, decision 3 #37-6): JPEG, PNG or WebP only, the middle cropped to a
 * square of at most 512px at its full resolution — never enlarged (owner decision 2026-10-22) —
 * metadata gone, an animated WebP kept as its first frame. No database.
 */
import { crc32 } from 'node:zlib';
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_DIMENSION,
  IMAGE_MAX_INPUT_PIXELS,
  PROFILE_IMAGE_SIZE,
} from '@buddha/shared';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  PROFILE_WEBP_CUT_BYTES_PER_PIXEL,
  WEBP_ALPHA_MAX_OUTPUT_PIXELS,
  WEBP_ANIMATION_LARGEST_FRAME_PIXELS,
  WEBP_ANIMATION_MAX_PIXELS,
  decodeBytesPerPixel,
  encoderOptions,
  imageConversions,
  largestFramePixels,
  largestImagePixels,
  outputBox,
  processImage,
  processProfileImage,
  profileDecodeBytesPerPixel,
  sniffImageType,
} from './image.js';
import { memoryAdmission, memoryWaits } from './memory-admission.js';

const MiB = 1024 * 1024;

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

/** A PNG chunk: its length, its type, `data`, and the CRC of the type and the data. */
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * A valid PNG of 8×8 padded to exactly `size` bytes by a text chunk after its header — which a
 * decoder reads past — so a size check meets a real image at its bound.
 */
async function pngOfExactly(size: number): Promise<Buffer> {
  const png = await solid(8, 8).png().toBuffer();
  const headerEnd = 8 + 25; // the signature, then IHDR: length, type, 13 bytes, CRC
  const keyword = Buffer.from('Comment\0', 'latin1');
  const filler = Buffer.alloc(size - png.length - 12 - keyword.length, 0x61);
  const padded = Buffer.concat([
    png.subarray(0, headerEnd),
    pngChunk('tEXt', Buffer.concat([keyword, filler])),
    png.subarray(headerEnd),
  ]);
  expect(padded.length).toBe(size);
  return padded;
}

/** The reason of an IMAGE_NOT_ALLOWED refusal, of `process` (a post's image by default). */
async function refusal(
  bytes: Uint8Array,
  process: (bytes: Uint8Array) => Promise<unknown> = processImage,
): Promise<unknown> {
  try {
    await process(bytes);
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

// Every conversion gives its share of the API's memory back, whether it stored an image or failed
// in the pipeline — as the header-only PNGs at their bound do (`unreadable`): a share kept would
// stay held for the life of the process, and every later conversion would wait for it (counted
// without a ceiling too).
afterEach(async () => {
  await vi.waitFor(() => {
    expect(memoryAdmission.heldBytes).toBe(0);
    expect(memoryAdmission.waitingCount).toBe(0);
  });
});

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

  it('refuses an empty file and one over 5MB before looking at it, and takes one of exactly 5MB', async () => {
    expect(await refusal(new Uint8Array(0))).toBe('empty');
    const big = Buffer.alloc(IMAGE_MAX_BYTES + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect(await refusal(big)).toBe('size');
    // «5MB» is the bound itself: the screen lets a file of exactly IMAGE_MAX_BYTES through too.
    const image = await processImage(await pngOfExactly(IMAGE_MAX_BYTES));
    expect(image).toMatchObject({ contentType: 'image/png', width: 8, height: 8 });
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
    // have) is past that kind's largest frame (owner decision 2026-10-21 (2차) answer 4).
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
    // The owner's case (owner decision 2026-10-21 (2차) answer 1): 49KB of grey PNG that took
    // ~500MiB to convert, ~1.5GiB as RGB — within the pixels and the decode budget its format is
    // allowed (the memory is `image-memory.test.ts`'s).
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
    // What the encoders hold is not libvips' to count: a WebP animation and a GIF animation have
    // bounds measured on the whole conversion, within IMAGE_CONVERSION_PEAK_BYTES (Codex review of
    // #219, round 3; `image-memory.test.ts`), and a still WebP with alpha is written at most
    // WEBP_ALPHA_MAX_OUTPUT_PIXELS large instead of being refused (owner decision 2026-10-22
    // answer 1) — its frame is bounded by its decoding, as one without alpha. A WebP animation's
    // frames together have a bound of their own too; a GIF's do not.
    expect(IMAGE_CONVERSION_PEAK_BYTES).toBe(144 * 1024 * 1024);
    expect([
      WEBP_ALPHA_MAX_OUTPUT_PIXELS,
      WEBP_ANIMATION_LARGEST_FRAME_PIXELS,
      WEBP_ANIMATION_MAX_PIXELS,
      GIF_ANIMATION_LARGEST_FRAME_PIXELS,
    ]).toEqual([3_400_000, 1_050_000, 12_000_000, 5_000_000]);
    const alpha = { ...still, channels: 4, hasAlpha: true } as const;
    expect(largestFramePixels('image/webp', alpha)).toBe(8_947_848);
    expect(largestFramePixels('image/webp', { ...alpha, pages: 1 })).toBe(8_947_848);
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
    // A 1280×720 WebP animation fits, and an 1800×1800 sticker is written as it is; so does a
    // 2560×1440 (QHD) frame of a GIF animation fit (a 4K one does not: 8.3 megapixels).
    expect(1_280 * 720).toBeLessThanOrEqual(WEBP_ANIMATION_LARGEST_FRAME_PIXELS);
    expect(1_800 * 1_800).toBeLessThanOrEqual(WEBP_ALPHA_MAX_OUTPUT_PIXELS);
    expect(2_560 * 1_440).toBeLessThanOrEqual(GIF_ANIMATION_LARGEST_FRAME_PIXELS);
    // A PNG frame: its kind's measured value (owner decision 2026-10-21 (2차) answers 4 and 5;
    // `image-memory.test.ts` converts each kind's costliest shape at it), by the channels it
    // decodes to, 8 or 16 bits a sample, interlaced or not. 8-bit grey (interlaced too), plain
    // 8-bit RGB and plain 16-bit grey keep the 50 million pixels every frame together may have, and
    // interlaced 16-bit grey the bound it had (128MiB at 3.2 bytes a pixel).
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
      largestFramePixels('image/png', { channels, depth, isProgressive });
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

  it('fits a still WebP with alpha in the box of at most WEBP_ALPHA_MAX_OUTPUT_PIXELS, its own shape upright', () => {
    const MAX = IMAGE_MAX_DIMENSION;
    const square = { width: MAX, height: MAX };
    const alpha = (width: number, height: number, more: object = {}) => ({
      width,
      height,
      hasAlpha: true,
      ...more,
    });
    // Within the bound once fitted inside 2,048px: the box every other image has.
    expect(outputBox('image/webp', alpha(1_800, 1_800))).toEqual(square);
    expect(outputBox('image/webp', alpha(2_048, 1_660))).toEqual(square);
    // 4000×3000 is 12 megapixels, and 2048×1536 — within the bound — once fitted: a 4:3 photo or
    // anything wider is written as large as any other image.
    expect(outputBox('image/webp', alpha(4_000, 3_000))).toEqual(square);
    // Past it: a box of the frame's shape with at most that many pixels.
    expect(outputBox('image/webp', alpha(1_900, 1_900))).toEqual({ width: 1_843, height: 1_843 });
    expect(outputBox('image/webp', alpha(2_991, 2_991))).toEqual({ width: 1_843, height: 1_843 });
    // Upright: EXIF 5 to 8 turn it a quarter before the resize (sharp's autoOrient).
    expect(outputBox('image/webp', alpha(2_200, 2_000, { orientation: 6 }))).toEqual({
      width: 1_758,
      height: 1_933,
    });
    for (const orientation of [5, 7, 8]) {
      expect(
        outputBox('image/webp', alpha(2_200, 2_000, { orientation })),
        String(orientation),
      ).toEqual({
        width: 1_758,
        height: 1_933,
      });
    }
    for (const orientation of [1, 2, 3, 4]) {
      expect(
        outputBox('image/webp', alpha(2_200, 2_000, { orientation })),
        String(orientation),
      ).toEqual({
        width: 1_933,
        height: 1_758,
      });
    }
    // Any shape: written with at most that many pixels, at most 2,048px a side — fitted inside its
    // box as sharp fits it (the long side, the other rounded).
    const fit = (box: { width: number; height: number }, width: number, height: number) => {
      const factor = Math.max(1, width / box.width, height / box.height);
      return [Math.round(width / factor), Math.round(height / factor)] as const;
    };
    for (const [width, height] of [
      [2_100, 1_300],
      [1_844, 1_843],
      [2_200, 2_100],
      [2_992, 2_990],
      [5_000, 1_700],
      [1_200, 7_000],
      [16_383, 546],
    ] as const) {
      const [outWidth, outHeight] = fit(
        outputBox('image/webp', alpha(width, height)),
        width,
        height,
      );
      expect(outWidth * outHeight).toBeLessThanOrEqual(WEBP_ALPHA_MAX_OUTPUT_PIXELS);
      expect(Math.max(outWidth, outHeight)).toBeLessThanOrEqual(MAX);
    }
    // Every other image: the 2,048px box — a WebP without alpha, a WebP animation with alpha, a PNG.
    expect(outputBox('image/webp', { width: 2_991, height: 2_991, hasAlpha: false })).toEqual(
      square,
    );
    expect(
      outputBox('image/webp', alpha(1_024, 3 * 1_024, { pageHeight: 1_024, pages: 3 })),
    ).toEqual(square);
    expect(outputBox('image/png', alpha(4_000, 4_000))).toEqual(square);
  });

  it('writes a still WebP with alpha past that size smaller, up to its decoding bound, and refuses a WebP animation and a GIF animation past their own bounds, from the header', async () => {
    const sticker = (width: number, height: number) =>
      sharp({
        create: { width, height, channels: 4, background: { r: 9, g: 99, b: 199, alpha: 0.5 } },
      })
        .webp()
        .toBuffer();
    // 1900×1900 is 3.61 megapixels: written at 1843×1843, 3.4 (owner decision 2026-10-22 answer
    // 1 — past 2.6 it was refused before), with its alpha; 1800×1800 as it is, and one without
    // alpha at its size.
    const shrunk = await processImage(await sticker(1_900, 1_900));
    expect(shrunk).toMatchObject({ contentType: 'image/webp', width: 1_843, height: 1_843 });
    expect(await sharp(shrunk.body).metadata()).toMatchObject({ hasAlpha: true, width: 1_843 });
    expect(await processImage(await sticker(1_800, 1_800))).toMatchObject({
      contentType: 'image/webp',
      width: 1_800,
    });
    expect(await processImage(await solid(1_900, 1_900).webp().toBuffer())).toMatchObject({
      contentType: 'image/webp',
      width: 1_900,
    });
    // Up to the frame its decoding allows (~8.9 megapixels, 2,991²), turned upright first; past
    // it, `pixels` from the header as before.
    expect(await processImage(await sticker(2_991, 2_991))).toMatchObject({
      contentType: 'image/webp',
      width: 1_843,
      height: 1_843,
    });
    const turned = await sharp({
      create: {
        width: 2_200,
        height: 2_000,
        channels: 4,
        background: { r: 1, g: 2, b: 3, alpha: 0.5 },
      },
    })
      .webp()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    // Within its box (1758×1933): sharp fits the long side and rounds the other.
    expect(await processImage(turned)).toMatchObject({ width: 1_757, height: 1_933 });
    expect(await refusal(await sticker(3_000, 3_000))).toBe('pixels');
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

describe('processProfileImage (#141)', () => {
  /** The colour of the stored image's pixel at (x, y), as [r, g, b]. */
  async function pixel(body: Uint8Array, x: number, y: number): Promise<number[]> {
    const { data, info } = await sharp(body)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const at = (y * info.width + x) * info.channels;
    return [data[at]!, data[at + 1]!, data[at + 2]!];
  }

  /**
   * A PNG of three bands across its long side — red, blue, green — the middle band a square of
   * 600px: cropping the middle leaves blue alone, squeezing the whole would leave red and green at
   * the edges.
   */
  function bands(orientation: 'wide' | 'tall'): Promise<Buffer> {
    const side = 600;
    const [width, height] = orientation === 'wide' ? [side * 3, side] : [side, side * 3];
    const colours = [
      [255, 0, 0],
      [0, 0, 255],
      [0, 255, 0],
    ] as const;
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        raw.set(colours[Math.floor((orientation === 'wide' ? x : y) / side)]!, (y * width + x) * 3);
      }
    }
    return sharp(raw, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
  }

  it('crops the middle of the upload to a square, scaled down to 512px, wide or tall', async () => {
    expect(PROFILE_IMAGE_SIZE).toBe(512);
    for (const orientation of ['wide', 'tall'] as const) {
      const image = await processProfileImage(await bands(orientation));
      expect(image, orientation).toMatchObject({
        contentType: 'image/png',
        width: PROFILE_IMAGE_SIZE,
        height: PROFILE_IMAGE_SIZE,
      });
      const metadata = await sharp(image.body).metadata();
      expect({ width: metadata.width, height: metadata.height }).toEqual({
        width: 512,
        height: 512,
      });
      // Blue from edge to edge: the middle band, never the red or green ones beside it. A few
      // pixels in from each edge, past the resampling's blend at the cut.
      for (const [x, y] of [
        [40, 40],
        [256, 256],
        [471, 471],
        [40, 471],
        [471, 40],
      ] as const) {
        const [r, g, b] = await pixel(image.body, x, y);
        expect({ orientation, x, y, blue: b! > 200 && r! < 60 && g! < 60 }).toEqual({
          orientation,
          x,
          y,
          blue: true,
        });
      }
    }
  });

  it('never enlarges: a smaller upload keeps its own size, the middle square of it', async () => {
    // Owner decision 2026-10-22: «512px보다 작은 프로필 이미지 → 키우지 않음(정사각으로만 자르고 제
    // 크기, 512는 최대)» — the square of the short side, at most 512.
    const sizes = [
      { format: 'jpeg', width: 10, height: 6, side: 6 },
      { format: 'png', width: 300, height: 200, side: 200 },
      { format: 'webp', width: 400, height: 600, side: 400 },
      { format: 'png', width: 512, height: 900, side: 512 },
      { format: 'jpeg', width: 4_000, height: 3_000, side: 512 },
      { format: 'webp', width: 2_000, height: 1_500, side: 512 },
    ] as const;
    for (const { format, width, height, side } of sizes) {
      const image = await processProfileImage(
        await solid(width, height).toFormat(format).toBuffer(),
      );
      const metadata = await sharp(image.body).metadata();
      expect({
        format,
        width,
        stored: [image.width, image.height, metadata.width, metadata.height],
      }).toEqual({
        format,
        width,
        stored: [side, side, side, side],
      });
    }
  });

  it('keeps a panorama wider than four to one at its full resolution: the middle square of the file, not of a reduced copy', async () => {
    // 3000×600: fitting the long side inside 2,048px first would leave a short side of 409, and a
    // square of 512 from that is enlarged — soft. What is stored is the file's own middle 600×600,
    // scaled down to 512, exactly as cutting it from the file directly gives (ADR-0079 7-16).
    const [width, height] = [3_000, 600];
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i += 1) {
      // Vertical stripes 2px wide, black and white: detail a reduced copy loses.
      raw.fill(Math.floor((i % width) / 2) % 2 === 0 ? 0 : 255, i * 3, i * 3 + 3);
    }
    /** The mean absolute difference of two images' samples, decoded. */
    const difference = async (a: Uint8Array, b: Uint8Array) => {
      const [x, y] = await Promise.all([a, b].map((bytes) => sharp(bytes).raw().toBuffer()));
      let sum = 0;
      for (let i = 0; i < x!.length; i += 1) sum += Math.abs(x![i]! - y![i]!);
      return sum / x!.length;
    };
    for (const format of ['jpeg', 'webp'] as const) {
      const file = await sharp(raw, { raw: { width, height, channels: 3 } })
        .toFormat(format)
        .toBuffer();
      const image = await processProfileImage(file);
      expect(image).toMatchObject({ contentType: `image/${format}`, width: 512, height: 512 });
      const middle = await sharp(file)
        .extract({ left: (width - height) / 2, top: 0, width: height, height })
        .resize(512, 512)
        .toFormat(format, format === 'jpeg' ? { quality: 85, mozjpeg: true } : { quality: 85 })
        .toBuffer();
      const reduced = await sharp(file)
        .resize({ width: IMAGE_MAX_DIMENSION, height: IMAGE_MAX_DIMENSION, fit: 'inside' })
        .toBuffer()
        .then((copy) => sharp(copy).resize(512, 512, { fit: 'cover' }).toFormat(format).toBuffer());
      const [toMiddle, toReduced] = [
        await difference(image.body, middle),
        await difference(image.body, reduced),
      ];
      expect({ format, sharp: toMiddle < 1, soft: toReduced > 10 }).toEqual({
        format,
        sharp: true,
        soft: true,
      });
    }
  });

  it('charges a WebP whose square is cut from the file what decoding it whole costs, and refuses past that from its header', async () => {
    // ADR-0079 7-16: a WebP more than four times wider than tall is decoded whole for its square —
    // ~17 bytes a pixel, not the 15 a post's WebP (decoded scaled) is charged.
    const still = { channels: 4, depth: 'uchar', isProgressive: false } as const;
    const cost = (type: 'image/jpeg' | 'image/webp', width: number, height: number) =>
      profileDecodeBytesPerPixel(type, still, width, height);
    expect(PROFILE_WEBP_CUT_BYTES_PER_PIXEL).toBe(17);
    // Cut first: just past 4:1 at the WebP's bound, wide or tall; exactly 4:1 (its first pass
    // would leave a short side of exactly 512, no longer than the square); a short side under 512.
    expect(cost('image/webp', 5_993, 1_493)).toBe(17);
    expect(cost('image/webp', 1_493, 5_993)).toBe(17);
    expect(cost('image/webp', 2_560, 640)).toBe(17);
    expect(cost('image/webp', 3_000, 400)).toBe(17);
    // Scaled first, as a post's image is: under 4:1, a square, a long side within 2,048px.
    expect(cost('image/webp', 5_898, 1_517)).toBe(15);
    expect(cost('image/webp', 2_991, 2_991)).toBe(15);
    expect(cost('image/webp', 2_048, 100)).toBe(15);
    // A JPEG cut first is read row by row: its format's own cost.
    expect(cost('image/jpeg', 24_000, 600)).toBe(decodeBytesPerPixel('image/jpeg', still));

    const rgba = (width: number, height: number) =>
      sharp({
        create: { width, height, channels: 4, background: { r: 9, g: 99, b: 199, alpha: 0.5 } },
      })
        .webp({ lossless: true })
        .withMetadata({ orientation: 6 })
        .toBuffer();
    // ~8.9 megapixels: within the 15 bytes a pixel of a post's WebP, over the 17 of one cut first.
    const long = await rgba(5_993, 1_493);
    expect(5_993 * 1_493 * 15).toBeLessThanOrEqual(IMAGE_DECODE_BUDGET_BYTES);
    expect(5_993 * 1_493 * 17).toBeGreaterThan(IMAGE_DECODE_BUDGET_BYTES);
    expect(await refusal(long, processProfileImage)).toBe('pixels');
    // A post's image of it is decoded scaled, and taken.
    expect(await processImage(long)).toMatchObject({ contentType: 'image/webp', height: 2_048 });
    // As many pixels under 4:1 are scaled first, charged as a post's WebP, and taken.
    expect(5_898 * 1_517 * 17).toBeGreaterThan(IMAGE_DECODE_BUDGET_BYTES);
    expect(await processProfileImage(await rgba(5_898, 1_517))).toMatchObject({
      contentType: 'image/webp',
      width: 512,
      height: 512,
    });
  });

  /**
   * `flank` + `side` + `flank` wide and `side` tall as stored, tagged with a quarter turn (EXIF
   * orientation 6: shown turned 90° clockwise): red on the left, green on the right, and between
   * them a square whose top half is blue and bottom half white. Turned upright, red is on top and
   * green at the bottom, and the middle square has white on its left and blue on its right; not
   * turned, the square's blue is on top. A square of one colour would come out the same either way.
   */
  function turnedPhoto(
    format: 'jpeg' | 'png' | 'webp',
    { side, flank }: { side: number; flank: number },
  ): Promise<Buffer> {
    const [width, height] = [flank * 2 + side, side];
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const colour =
          x < flank
            ? [255, 0, 0]
            : x >= flank + side
              ? [0, 255, 0]
              : y < side / 2
                ? [0, 0, 255]
                : [255, 255, 255];
        raw.set(colour, (y * width + x) * 3);
      }
    }
    return sharp(raw, { raw: { width, height, channels: 3 } })
      .toFormat(format)
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Copyright: 'GPS 37.5665 126.9780', Make: 'PhoneMaker' } })
      .toBuffer();
  }

  /** The stored image's pixel at (x, y), named. */
  async function colourAt(body: Uint8Array, x: number, y: number): Promise<string> {
    const [r = 0, g = 0, b = 0] = await pixel(body, x, y);
    if (r > 200 && g > 200 && b > 200) return 'white';
    if (b > 200 && r < 60 && g < 60) return 'blue';
    if (r > 200 && g < 60 && b < 60) return 'red';
    if (g > 200 && r < 60 && b < 60) return 'green';
    return `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
  }

  it('turns a photo upright by its EXIF before the crop, then removes every piece of metadata', async () => {
    // Each of the three types and each way to the square (`profileSquare`): a small photo kept at
    // its size, one scaled down to 512 after its long side is fitted (a JPEG or a WebP), and one
    // five times wider than tall whose square is cut from the file first (a PNG always).
    const shapes = [
      { side: 100, flank: 100, stored: 100 },
      { side: 600, flank: 600, stored: 512 },
      { side: 600, flank: 1_200, stored: 512 },
    ];
    for (const format of ['jpeg', 'png', 'webp'] as const) {
      for (const { side, flank, stored } of shapes) {
        const photo = await turnedPhoto(format, { side, flank });
        const before = await sharp(photo).metadata();
        expect({ format, side, orientation: before.orientation }).toEqual({
          format,
          side,
          orientation: 6,
        });
        expect(before.exif).toBeDefined();

        const image = await processProfileImage(photo);
        expect(image).toMatchObject({
          contentType: `image/${format}`,
          width: stored,
          height: stored,
        });
        // The middle square turned upright: white on the left, blue on the right, top and bottom
        // alike — never the red or green beside it.
        const [near, far] = [Math.round(stored / 8), Math.round((stored * 7) / 8)];
        const [top, bottom] = [Math.round(stored / 4), Math.round((stored * 3) / 4)];
        const seen = {
          format,
          flank,
          left: [await colourAt(image.body, near, top), await colourAt(image.body, near, bottom)],
          right: [await colourAt(image.body, far, top), await colourAt(image.body, far, bottom)],
        };
        expect(seen).toEqual({
          format,
          flank,
          left: ['white', 'white'],
          right: ['blue', 'blue'],
        });

        const after = await sharp(image.body).metadata();
        expect(after.exif).toBeUndefined();
        expect(after.xmp).toBeUndefined();
        expect(after.iptc).toBeUndefined();
        expect(after.icc).toBeUndefined();
        expect(after.orientation).toBeUndefined();
        expect(Buffer.from(image.body).includes('PhoneMaker')).toBe(false);
      }
    }
  });

  it('keeps an animated WebP as its first frame', async () => {
    // Owner decision 2026-10-22: «움직이는 WebP는 첫 장면만 … → 이대로».
    const image = await processProfileImage(await animation('webp', 40, 30, 3));
    expect(image).toMatchObject({ contentType: 'image/webp', width: 30, height: 30 });
    const after = await sharp(image.body, { animated: true }).metadata();
    expect(after.pages ?? 1).toBe(1);
    // The first frame's colour (black — frame n is 80n red), not a later one's.
    const [r] = await pixel(image.body, 15, 15);
    expect(r).toBeLessThan(40);
  });

  it('takes JPEG, PNG and WebP only: a GIF is refused as any other type is', async () => {
    const profile = (bytes: Uint8Array) => refusal(bytes, processProfileImage);
    expect(await profile(await solid(8, 8).gif().toBuffer())).toBe('type');
    expect(await profile(await animation('gif', 8, 8, 2))).toBe('type');
    expect(await profile(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('type');
    expect(await profile(await solid(4, 4).tiff().toBuffer())).toBe('type');
    for (const format of ['jpeg', 'png', 'webp'] as const) {
      const image = await processProfileImage(await solid(8, 8).toFormat(format).toBuffer());
      expect((await sharp(image.body).metadata()).format).toBe(format);
    }
  });

  it('refuses as a post’s image does: empty, over 5MB, unreadable, a bomb, very thin or long — and takes exactly 5MB and exactly 32:1', async () => {
    const profile = (bytes: Uint8Array) => refusal(bytes, processProfileImage);
    expect(await profile(new Uint8Array(0))).toBe('empty');
    const big = Buffer.alloc(IMAGE_MAX_BYTES + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect(await profile(big)).toBe('size');
    const bound = await processProfileImage(await pngOfExactly(IMAGE_MAX_BYTES));
    expect(bound).toMatchObject({ contentType: 'image/png', width: 8, height: 8 });
    expect(await profile((await solid(200, 200).jpeg().toBuffer()).subarray(0, 40))).toBe(
      'unreadable',
    );
    expect(await profile(pngHeaderOnly(100_000, 100_000))).toBe('pixels');
    // The same shared header step and bound (owner decisions 2026-10-22: «글·프로필 모두», «하나로
    // 맞춤(#46이 잰 32배)»).
    expect(await profile(await solid(330, 10).png().toBuffer())).toBe('pixels');
    expect(await profile(await solid(10, 330).jpeg().toBuffer())).toBe('pixels');
    expect(await profile(await solid(3_201, 100).webp().toBuffer())).toBe('pixels');
    expect(await profile(pngHeaderOnly(5_000_000, 10))).toBe('pixels');
    const strip = await processProfileImage(await solid(320, 10).png().toBuffer());
    expect(strip).toMatchObject({ contentType: 'image/png', width: 10, height: 10 });
    const panorama = await processProfileImage(await solid(3_200, 100).webp().toBuffer());
    expect(panorama).toMatchObject({ contentType: 'image/webp', width: 100, height: 100 });
  });

  it('converts through the same one-at-a-time queue', async () => {
    const run = vi.spyOn(imageConversions, 'run');
    try {
      await processProfileImage(await solid(4, 4).png().toBuffer());
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      run.mockRestore();
    }
  });
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

  it('refuses the conversions queued behind one that waited in vain for memory within their own wait, not one wait after another', async () => {
    // No room for a conversion's peak, ever: 416 resident under a ceiling of 416.
    memoryAdmission.configure({ ceilingBytes: 416 * MiB, resident: () => 416 * MiB });
    memoryWaits.conversionMs = 400;
    const admit = vi.spyOn(memoryAdmission, 'admit');
    try {
      const photos = await Promise.all(
        [1, 2, 3].map((n) =>
          solid(20 + n, 20)
            .jpeg()
            .toBuffer(),
        ),
      );
      const started = Date.now();
      const settled = await Promise.all(
        photos.map((photo) =>
          processImage(photo).then(
            () => ({ code: 'stored', after: Date.now() - started }),
            (error: unknown) => ({
              code: error instanceof AppError ? error.code : String(error),
              after: Date.now() - started,
            }),
          ),
        ),
      );
      expect(settled.map(({ code }) => code)).toEqual([
        'RATE_LIMITED',
        'RATE_LIMITED',
        'RATE_LIMITED',
      ]);
      // The first waits its 400ms; the two behind it, queued at the same moment, have no wait
      // left by their turn and are refused at once — not at 800 and 1,200ms.
      for (const { after } of settled) expect(after).toBeLessThan(700);
      const waits = admit.mock.calls.map(([, options]) => options.waitMs);
      expect(waits).toHaveLength(3);
      expect(waits[0]).toBeGreaterThan(300);
      expect(waits[0]).toBeLessThanOrEqual(400);
      expect(waits[1]).toBeLessThan(100);
      expect(waits[2]).toBeLessThan(100);
      expect(admit.mock.calls.map(([, options]) => options.kind)).toEqual([
        'conversion',
        'conversion',
        'conversion',
      ]);
    } finally {
      admit.mockRestore();
      memoryAdmission.configure({ ceilingBytes: null });
      memoryWaits.conversionMs = 10_000;
    }
  });

  it('still converts one whose wait went by in the queue behind conversions that ran, when its turn finds room', async () => {
    memoryAdmission.configure({ ceilingBytes: 416 * MiB, resident: () => 100 * MiB });
    memoryWaits.conversionMs = 100;
    let finish!: () => void;
    const running = imageConversions.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    try {
      const pending = processImage(await solid(30, 20).jpeg().toBuffer());
      // Longer than its wait, behind a conversion that takes its time.
      await new Promise((resolve) => setTimeout(resolve, 250));
      finish();
      await running;
      await expect(pending).resolves.toMatchObject({ contentType: 'image/jpeg', width: 30 });
    } finally {
      finish();
      memoryAdmission.configure({ ceilingBytes: null });
      memoryWaits.conversionMs = 10_000;
    }
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
