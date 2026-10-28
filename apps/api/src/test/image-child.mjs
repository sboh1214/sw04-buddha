// A process of its own for `media/image-memory.test.ts` (#46, ADR-0073 9-8) and
// `media/profile-image-memory.test.ts` (#141, ADR-0079), through `image-children.ts`: what one whole
// conversion — decode, resize and encode — adds to a process's resident memory, which neither
// libvips' own count (the encoders allocate outside it) nor a test process that has converted
// before (the allocator keeps what it freed, and reuses it) can tell.
//
//   node image-child.mjs make <spec json> <out file>
//     writes the input a case converts: noise (every byte at random from a fixed seed, an alpha
//     channel of `alphaLevels` levels) or `frames` (a different colour in every frame) — a JPEG of
//     four components with `colourspace: 'cmyk'` — made with libvips here so the test process
//     never does.
//   node image-child.mjs convert <file> <options json>
//     runs processImage's pipeline on the file — the header read, then autoOrient, a resize to fit
//     inside `box` (image.ts `outputBox`) and the encoder `toFormat(format, encoder)` — with the
//     cache off and one thread, and prints one JSON line: `peakBytes` (the most the process's RSS
//     rose above what it held before, sampled every millisecond), the output's size and its
//     SHA-256 (the test checks this pipeline converts byte for byte what processImage does).
//   node image-child.mjs convert-profile <file> <options json>
//     the same for processProfileImage's pipeline (#141, ADR-0079 — `profileSquare`): the first
//     frame only, then either the middle square cut from the file (`cut`), turned upright and scaled
//     to `side`, or the frame turned upright and fitted inside `box` as raw pixels first, then the
//     middle square of that scaled to `side` (never more than the pass left) — and the encoder.
//
// Plain JavaScript: a child cannot load the API's TypeScript, so the test hands it what image.ts
// decides (`outputBox`, `encoderOptions`, the limits; for a profile image `cutsSquareFirst` and
// `profileSquareSide`) as JSON — and the allocator's setting the API's image runs with
// (MALLOC_MMAP_THRESHOLD_, Dockerfile) in its environment.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

sharp.cache(false);
sharp.concurrency(1);

const [mode, first, second] = process.argv.slice(2);

/** xorshift32 from a fixed seed: the same file every run. */
function random() {
  let seed = 0x9e3779b9;
  return () => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed;
  };
}

async function make(spec, out) {
  const { format, width, height, channels = 3, frames = 1, content = 'noise' } = spec;
  const alphaLevels = spec.alphaLevels ?? 256;
  const frameBytes = width * height * channels;
  const data = Buffer.alloc(frameBytes * frames);
  if (content === 'noise') {
    const next = random();
    for (let i = 0; i < data.length; i += 4) {
      const word = next();
      data[i] = word;
      data[i + 1] = word >>> 8;
      data[i + 2] = word >>> 16;
      data[i + 3] = word >>> 24;
    }
    if (channels === 4 && alphaLevels < 256) {
      for (let i = 3; i < data.length; i += 4) {
        data[i] = Math.round(((data[i] % alphaLevels) / (alphaLevels - 1)) * 255);
      }
    }
  } else {
    for (let frame = 0; frame < frames; frame += 1) {
      const value = (20 + frame * 37) % 256;
      const start = frame * frameBytes;
      for (let i = start; i < start + frameBytes; i += channels) {
        data[i] = value;
        data[i + 1] = 255 - value;
        data[i + 2] = (value * 7) % 256;
        if (channels === 4) data[i + 3] = ((i - start) / channels) % width < width / 2 ? 0 : 255;
      }
    }
  }
  const image = sharp(data, {
    raw: {
      width,
      height: height * frames,
      channels,
      ...(frames > 1 ? { pageHeight: height } : {}),
    },
  });
  const animation = frames > 1 ? { loop: 0, delay: Array.from({ length: frames }, () => 100) } : {};
  if (spec.colourspace === 'cmyk') image.toColourspace('cmyk');
  image.toFormat(format, { ...animation, ...spec.encoder });
  writeFileSync(out, await image.toBuffer());
}

/**
 * Runs `pipeline` (the conversion, given the file's bytes) sampling the process's RSS every
 * millisecond, and prints the line `convert` and `convert-profile` print.
 */
async function measured(file, options, pipeline) {
  const bytes = readFileSync(file);
  const before = process.memoryUsage.rss();
  let top = before;
  const sample = () => {
    top = Math.max(top, process.memoryUsage.rss());
  };
  const sampler = setInterval(sample, 1);
  const header = { animated: options.animated, limitInputPixels: false };
  await sharp(bytes, header).metadata();
  const { data, info } = await pipeline(bytes);
  clearInterval(sampler);
  sample();
  process.stdout.write(
    `${JSON.stringify({
      peakBytes: top - before,
      width: info.width,
      height: info.pageHeight ?? info.height,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    })}\n`,
  );
}

async function convert(file, options) {
  const input = { animated: options.animated, limitInputPixels: options.limitInputPixels };
  await measured(file, options, (bytes) =>
    sharp(bytes, input)
      .autoOrient()
      .resize({ ...options.box, fit: 'inside', withoutEnlargement: true })
      .toFormat(options.format, options.encoder)
      .toBuffer({ resolveWithObject: true }),
  );
}

async function convertProfile(file, options) {
  const input = { animated: false, limitInputPixels: options.limitInputPixels };
  const square = (image, side) =>
    image
      .resize({ width: side, height: side, fit: 'cover', position: 'centre' })
      .toFormat(options.format, options.encoder)
      .toBuffer({ resolveWithObject: true });
  await measured(file, { animated: false }, async (bytes) => {
    if (options.cut !== undefined) {
      return square(sharp(bytes, input).extract(options.cut).autoOrient(), options.side);
    }
    const { data, info } = await sharp(bytes, input)
      .autoOrient()
      .resize({ ...options.box, fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const raw = { width: info.width, height: info.height, channels: info.channels };
    return square(sharp(data, { raw }), Math.min(options.side, info.width, info.height));
  });
}

if (mode === 'make') await make(JSON.parse(first), second);
else if (mode === 'convert') await convert(first, JSON.parse(second));
else if (mode === 'convert-profile') await convertProfile(first, JSON.parse(second));
else {
  throw new Error(
    'usage: image-child.mjs make <spec> <out> | convert <file> <options> | convert-profile <file> <options>',
  );
}
