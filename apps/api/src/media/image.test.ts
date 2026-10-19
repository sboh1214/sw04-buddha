/**
 * The image rules of #46 (ADR-0069 decision 2 #45-3) on real files made here with sharp: the
 * content decides the type (a disguised file is refused), metadata never survives (EXIF, the
 * orientation tag included, after the pixels were turned upright), the long side is at most
 * 2,048px and never enlarged, an animation keeps its frames and timing, and a decompression bomb
 * is refused from its header. No database.
 */
import { crc32, deflateSync } from 'node:zlib';
import { IMAGE_MAX_BYTES, IMAGE_MAX_DIMENSION } from '@buddha/shared';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../common/errors/app-error.js';
import {
  IMAGE_DECODE_BUDGET_BYTES,
  OneAtATime,
  decodeBytesPerPixel,
  imageConversions,
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

/**
 * A PNG whose header claims `width`×`height` over a few bytes of pixel data: a bomb, which must be
 * refused from its header (the decoder would fail on the data only after allocating the image).
 */
function pngHeaderOnly(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(64))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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

  it('bounds a frame by its format’s measured cost per pixel', () => {
    const still = { channels: 4, depth: 'uchar', isProgressive: false } as const;
    expect(decodeBytesPerPixel('image/jpeg', { ...still, channels: 3 })).toBe(1);
    expect(decodeBytesPerPixel('image/jpeg', { ...still, isProgressive: true })).toBe(10);
    expect(decodeBytesPerPixel('image/png', still)).toBe(2.4);
    expect(decodeBytesPerPixel('image/png', { ...still, channels: 3 })).toBe(1.8);
    expect(decodeBytesPerPixel('image/png', { ...still, depth: 'ushort' })).toBe(4.8);
    expect(decodeBytesPerPixel('image/png', { ...still, isProgressive: true })).toBe(6.4);
    expect(decodeBytesPerPixel('image/gif', still)).toBe(16);
    expect(decodeBytesPerPixel('image/webp', still)).toBe(15);
    // A 4K frame (3840×2160) fits every format; the budget is the API's, well under its 448 MiB.
    expect(3_840 * 2_160 * 16).toBeLessThan(IMAGE_DECODE_BUDGET_BYTES);
    expect(IMAGE_DECODE_BUDGET_BYTES).toBe(128 * 1024 * 1024);
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
