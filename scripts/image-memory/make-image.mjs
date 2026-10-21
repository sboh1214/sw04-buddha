// Writes one JPEG, PNG, GIF or WebP file to measure (README.md, ADR-0073 9-8): the content that
// costs a conversion most — noise, or a different picture in every frame of an animation — at a
// given size, made with the API's sharp. A process of its own: making a file with libvips raises
// the process's high-water marks, so it never runs in the process that measures (`measure.mjs
// --file` reads what this writes; `sweep-encode.mjs` runs both, each in a new process).
//
//   node scripts/image-memory/make-image.mjs --format webp --width 1761 --height 1761 \
//     --channels 4 --content noise --alpha-levels 256 --encoder '{"quality":1}' --out a.webp
//
// --content: noise (every byte at random from a fixed seed — what compresses least; the alpha
//   channel, with --channels 4, takes --alpha-levels levels: 2 for a file small enough at large
//   sizes, 256 for the most), frames (one colour per frame, each frame different — an animation
//   no encoder can merge; with --channels 4 the left half transparent, GIF's 1-bit alpha too) or
//   flat (one colour).
// --frames n: an animation of n frames (GIF or WebP), 100ms each, looping.
// --colourspace cmyk: a JPEG of four components (CMYK — sharp turns the pixels into CMYK through its
//   own profile before encoding): a progressive one keeps a component more of coefficients. With
//   --orientation it needs --icc cmyk (sharp's metadata otherwise turns the pixels back into sRGB).
// --encoder: the options of the file's own encoder (sharp's jpeg/png/gif/webp), e.g. a low
//   quality so that noise fits in IMAGE_MAX_BYTES. The API reads the file, not these.
// --orientation 1–8: an EXIF orientation. --icc p3|srgb|<file>: an embedded ICC profile.
// Prints one JSON line: the file, its size and whether the API would take it by its size.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { int, loadShared, loadSharp } from './lib.mjs';

const { values } = parseArgs({
  options: {
    format: { type: 'string' },
    width: { type: 'string' },
    height: { type: 'string' },
    channels: { type: 'string', default: '3' },
    frames: { type: 'string', default: '1' },
    content: { type: 'string', default: 'noise' },
    'alpha-levels': { type: 'string', default: '256' },
    encoder: { type: 'string' },
    colourspace: { type: 'string' },
    orientation: { type: 'string' },
    icc: { type: 'string' },
    out: { type: 'string' },
  },
});

const format = values.format;
if (!['jpeg', 'png', 'gif', 'webp'].includes(format)) {
  throw new Error('--format is jpeg, png, gif or webp');
}
const width = int(values.width, 'width', undefined);
const height = int(values.height, 'height', undefined);
if (!(width > 0 && height > 0)) throw new Error('--width and --height are needed');
const channels = int(values.channels, 'channels', 3);
if (channels !== 3 && channels !== 4) throw new Error('--channels is 3 or 4');
const frames = int(values.frames, 'frames', 1);
if (frames < 1) throw new Error('--frames is at least 1');
if (frames > 1 && format !== 'gif' && format !== 'webp') {
  throw new Error('an animation is a GIF or a WebP');
}
if (values.colourspace !== undefined && values.colourspace !== 'cmyk') {
  throw new Error('--colourspace is cmyk');
}
if (values.colourspace === 'cmyk' && (format !== 'jpeg' || channels !== 3)) {
  throw new Error('--colourspace cmyk is for a JPEG made from --channels 3');
}
if (values.colourspace === 'cmyk' && values.orientation && values.icc !== 'cmyk') {
  throw new Error('--colourspace cmyk with --orientation needs --icc cmyk');
}
const alphaLevels = int(values['alpha-levels'], 'alpha-levels', 256);
if (alphaLevels < 2 || alphaLevels > 256) throw new Error('--alpha-levels is 2 to 256');
if (!values.out) throw new Error('--out <file> is needed');

// A fixed seed (xorshift32): the same file every time.
let seed = 0x9e3779b9;
function next() {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed;
}

const frameBytes = width * height * channels;
const data = Buffer.alloc(frameBytes * frames);
switch (values.content) {
  case 'noise': {
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
    break;
  }
  case 'frames': {
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
    break;
  }
  case 'flat':
    data.fill(120);
    break;
  default:
    throw new Error('--content is noise, frames or flat');
}

const sharp = loadSharp();
const image = sharp(data, {
  raw: {
    width,
    height: height * frames,
    channels,
    ...(frames > 1 ? { pageHeight: height } : {}),
  },
});
const options = values.encoder ? JSON.parse(values.encoder) : {};
const animation = frames > 1 ? { loop: 0, delay: Array.from({ length: frames }, () => 100) } : {};
if (values.colourspace === 'cmyk') image.toColourspace('cmyk');
image.toFormat(format, { ...animation, ...options });
if (values.orientation) image.withMetadata({ orientation: int(values.orientation, 'orientation') });
if (values.icc) image.withIccProfile(values.icc);
const bytes = await image.toBuffer();
writeFileSync(values.out, bytes);

const { IMAGE_MAX_BYTES } = await loadShared();
const header = await sharp(bytes, { animated: true, limitInputPixels: false }).metadata();
process.stdout.write(
  `${JSON.stringify({
    file: path.basename(values.out),
    format,
    width,
    height,
    channels,
    ...(values.colourspace === undefined ? {} : { colourspace: values.colourspace }),
    frames: header.pages ?? 1,
    content: values.content,
    bytes: bytes.length,
    takenBySize: bytes.length <= IMAGE_MAX_BYTES,
  })}\n`,
);
if ((header.pages ?? 1) !== frames) {
  process.stderr.write(
    `warning: ${String(frames)} frames asked, the file has ${String(header.pages ?? 1)}\n`,
  );
}
