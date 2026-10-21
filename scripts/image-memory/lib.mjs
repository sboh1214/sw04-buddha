// Shared by the image-memory scripts (README.md, ADR-0073 9-8): where the API's build is, PNG files
// built by hand, and one measurement in a process of its own.
//
// libvips' high-water mark (`sharp.cache().memory.high`) is process-wide and never lowered, so a
// measurement is one conversion in a fresh process (`measure.mjs`); the sweeps here only start
// those processes and read the line each prints. No libvips in a sweep's own process.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, createDeflate, deflateSync } from 'node:zlib';

const API_DIR = fileURLToPath(new URL('../../apps/api/', import.meta.url));
const requireFromApi = createRequire(path.join(API_DIR, 'package.json'));
const IMAGE_JS = path.join(API_DIR, 'dist', 'media', 'image.js');
const IMAGE_TS = path.join(API_DIR, 'src', 'media', 'image.ts');
const MEASURE_MJS = fileURLToPath(new URL('./measure.mjs', import.meta.url));

/** The API's own sharp (apps/api's dependency), so the versions measured are the API's. */
export function loadSharp() {
  return requireFromApi('sharp');
}

/** `@buddha/shared` as the API resolves it (its build): IMAGE_MAX_DIMENSION and the limits. */
export async function loadShared() {
  return import(pathToFileURL(requireFromApi.resolve('@buddha/shared')).href);
}

/** The API's built `media/image.js`: `processImage` and the bounds it checks. */
export async function loadApi() {
  if (!existsSync(IMAGE_JS)) {
    throw new Error(
      `${path.relative(process.cwd(), IMAGE_JS)} is missing: build the API first ` +
        '(corepack pnpm turbo run build --filter=api)',
    );
  }
  // (No source next to the build in the API's image: nothing to compare.)
  if (existsSync(IMAGE_TS) && statSync(IMAGE_TS).mtimeMs > statSync(IMAGE_JS).mtimeMs) {
    process.stderr.write(
      'warning: apps/api/src/media/image.ts is newer than its build; build the API again\n',
    );
  }
  return import(pathToFileURL(IMAGE_JS).href);
}

/** Prints one JSON line to stdout, and appends it to `file` when one is given. */
export function emit(record, file) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
  keep(record, file);
}

/** Appends one JSON line to `file` when one is given (a sweep's every case). */
export function keep(record, file) {
  if (file) appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/** A whole number from an option, or `fallback` when the option is absent. */
export function int(value, name, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`--${name} must be a whole number: ${value}`);
  return number;
}

// ---------------------------------------------------------------------------------------------
// A PNG's kind. The same options as apps/api/src/test/png.ts (`PngKind`, `pngOf`).

/** The options that describe a PNG's kind, for `util.parseArgs`. */
export const KIND_OPTIONS = {
  channels: { type: 'string' }, // 1 grey, 2 grey + alpha, 3 RGB (default), 4 RGBA
  depth: { type: 'string' }, // bits a sample: 8 (default) or 16
  interlaced: { type: 'boolean' }, // Adam7
  palette: { type: 'string' }, // indices of 1, 2, 4 or 8 bits into a palette, in place of channels
  transparent: { type: 'boolean' }, // a tRNS chunk: a palette's alpha, or grey's or RGB's colour
  profile: { type: 'boolean' }, // the hand-made ICC profile (grey or RGB, as the channels are)
  icc: { type: 'string' }, // an ICC profile file to embed in place of the hand-made one
  orientation: { type: 'string' }, // an EXIF orientation, 1 to 8 (6: a quarter turn)
};

/** The kind the options describe, checked. */
export function kindOf(values) {
  const kind = {
    channels: int(values.channels, 'channels', 3),
    depth: int(values.depth, 'depth', 8),
    interlaced: values.interlaced ?? false,
    palette: int(values.palette, 'palette', undefined),
    transparent: values.transparent ?? false,
    profile: values.profile ?? false,
    icc: values.icc,
    orientation: int(values.orientation, 'orientation', undefined),
  };
  if (![1, 2, 3, 4].includes(kind.channels)) throw new Error('--channels is 1, 2, 3 or 4');
  if (![8, 16].includes(kind.depth)) throw new Error('--depth is 8 or 16');
  if (kind.palette !== undefined && ![1, 2, 4, 8].includes(kind.palette)) {
    throw new Error('--palette is 1, 2, 4 or 8');
  }
  if (
    kind.transparent &&
    kind.palette === undefined &&
    (kind.channels === 2 || kind.channels === 4)
  ) {
    throw new Error('a PNG with an alpha channel has no transparent colour (--transparent)');
  }
  if (kind.orientation !== undefined && (kind.orientation < 1 || kind.orientation > 8)) {
    throw new Error('--orientation is 1 to 8');
  }
  return kind;
}

/** The kind back as `measure.mjs` options. */
export function kindFlags(kind) {
  return [
    ...(kind.palette === undefined
      ? ['--channels', String(kind.channels), '--depth', String(kind.depth)]
      : ['--palette', String(kind.palette)]),
    ...(kind.interlaced ? ['--interlaced'] : []),
    ...(kind.transparent ? ['--transparent'] : []),
    ...(kind.icc ? ['--icc', kind.icc] : kind.profile ? ['--profile'] : []),
    ...(kind.orientation ? ['--orientation', String(kind.orientation)] : []),
  ];
}

/**
 * What a PNG of this kind decodes to — the row of PNG_LARGEST_FRAME_PIXELS it is bounded by: a
 * palette to 8-bit RGB, or RGBA with transparency; grey or RGB with a transparent colour to grey +
 * alpha or RGBA (ADR-0073 9-8).
 */
export function decodedKind({ channels, depth, palette, transparent }) {
  if (palette !== undefined) return { channels: transparent ? 4 : 3, depth: 8 };
  if (transparent) return { channels: channels === 1 ? 2 : 4, depth };
  return { channels, depth };
}

/** A short name for a kind: 'rgba16 interlaced +icc', 'palette8 +tRNS'. */
export function kindName(kind) {
  const base =
    kind.palette === undefined
      ? `${{ 1: 'grey', 2: 'ga', 3: 'rgb', 4: 'rgba' }[kind.channels]}${kind.depth}`
      : `palette${kind.palette}`;
  return [
    base,
    ...(kind.interlaced ? ['interlaced'] : []),
    ...(kind.transparent ? ['+tRNS'] : []),
    ...(kind.icc ? [`+icc:${path.basename(kind.icc)}`] : kind.profile ? ['+icc'] : []),
    ...(kind.orientation ? [`o${kind.orientation}`] : []),
  ].join(' ');
}

// ---------------------------------------------------------------------------------------------
// PNG files built byte by byte (zlib only, no libvips — the mark starts from nothing), every
// sample 0: they deflate to almost nothing and decode to their full size. The rows are deflated
// as a stream, so building a 50-megapixel file does not hold its pixels in this process either
// (the process's peak RSS stays the conversion's).

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOUR_TYPE = { 1: 0, 2: 4, 3: 2, 4: 6 };
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function header(width, height, { channels, depth, interlaced, palette }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(palette ?? depth, 8);
  ihdr.writeUInt8(palette === undefined ? COLOUR_TYPE[channels] : 3, 9);
  ihdr.writeUInt8(interlaced ? 1 : 0, 12);
  return chunk('IHDR', ihdr);
}

/**
 * `PLTE` (black and white) for a palette, and `tRNS`: a palette's first entry half transparent, or
 * the transparent colour of grey or RGB — black.
 */
function paletteAndTransparency({ channels, palette, transparent }) {
  const chunks = [];
  if (palette !== undefined) chunks.push(chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])));
  if (transparent) {
    const colour = Buffer.alloc(channels === 1 ? 2 : 6);
    chunks.push(chunk('tRNS', palette === undefined ? colour : Buffer.from([128])));
  }
  return chunks;
}

/** The length of the rows before they are deflated: each a filter byte and its pixels. */
function rawLength(width, height, bits, interlaced) {
  const row = (pixels) => 1 + Math.ceil((pixels * bits) / 8);
  if (!interlaced) return row(width) * height;
  let length = 0;
  for (const [x, y, dx, dy] of ADAM7) {
    const passWidth = Math.max(0, Math.ceil((width - x) / dx));
    const passHeight = Math.max(0, Math.ceil((height - y) / dy));
    if (passWidth > 0) length += row(passWidth) * passHeight;
  }
  return length;
}

/** An `eXIf` chunk holding only the orientation tag. */
function exifOrientation(orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'ascii');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22);
  return chunk('eXIf', tiff);
}

function s15Fixed16(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(Math.round(value * 65_536));
  return bytes;
}

function xyzElement(x, y, z) {
  const head = Buffer.alloc(8);
  head.write('XYZ ', 0, 'ascii');
  return Buffer.concat([head, s15Fixed16(x), s15Fixed16(y), s15Fixed16(z)]);
}

function gammaElement(gamma) {
  const curve = Buffer.alloc(16);
  curve.write('curv', 0, 'ascii');
  curve.writeUInt32BE(1, 8);
  curve.writeUInt16BE(Math.round(gamma * 256), 12);
  return curve;
}

/**
 * The minimal ICC v2 display profile of apps/api/src/test/png.ts: a 2.2 gamma curve for grey,
 * sRGB's primaries (D50) and a 2.2 gamma for RGB. sharp turns the pixels of any image with an
 * embedded profile into sRGB before it resizes (16-bit grey aside), and holds more doing it.
 */
function iccProfile(grey) {
  const white = xyzElement(0.9642, 1, 0.8249);
  const curve = gammaElement(2.2);
  const tags = grey
    ? [
        ['wtpt', white],
        ['kTRC', curve],
      ]
    : [
        ['wtpt', white],
        ['rXYZ', xyzElement(0.4361, 0.2225, 0.0139)],
        ['gXYZ', xyzElement(0.3851, 0.7169, 0.0971)],
        ['bXYZ', xyzElement(0.1431, 0.0606, 0.7141)],
        ['rTRC', curve],
        ['gTRC', curve],
        ['bTRC', curve],
      ];
  const table = Buffer.alloc(4 + 12 * tags.length);
  table.writeUInt32BE(tags.length, 0);
  const elements = [];
  const offsets = new Map();
  let size = 128 + table.length;
  tags.forEach(([signature, element], index) => {
    let offset = offsets.get(element);
    if (offset === undefined) {
      offset = size;
      offsets.set(element, offset);
      elements.push(element);
      size += element.length;
    }
    table.write(signature, 4 + 12 * index, 'ascii');
    table.writeUInt32BE(offset, 8 + 12 * index);
    table.writeUInt32BE(element.length, 12 + 12 * index);
  });
  const head = Buffer.alloc(128);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(0x02_10_00_00, 8);
  head.write('mntr', 12, 'ascii');
  head.write(grey ? 'GRAY' : 'RGB ', 16, 'ascii');
  head.write('XYZ ', 20, 'ascii');
  head.write('acsp', 36, 'ascii');
  white.copy(head, 68, 8);
  return Buffer.concat([head, table, ...elements]);
}

/** `length` zero bytes, deflated as a stream (a few MiB at a time). */
async function deflateZeros(length) {
  const deflate = createDeflate();
  const parts = [];
  deflate.on('data', (part) => parts.push(part));
  const ended = once(deflate, 'end');
  const block = Buffer.alloc(Math.min(length, 4 * 1024 * 1024));
  for (let left = length; left > 0; left -= block.length) {
    const piece = left >= block.length ? block : block.subarray(0, left);
    if (!deflate.write(piece)) await once(deflate, 'drain');
  }
  deflate.end();
  await ended;
  return Buffer.concat(parts);
}

/**
 * A real PNG of `width`×`height` of the given kind, every sample 0, with the hand-made ICC profile
 * when `profile` is set (or the profile bytes `iccBytes`) and an EXIF `orientation` when given.
 */
export async function pngOf(width, height, kind, iccBytes) {
  const bits = kind.palette ?? kind.channels * kind.depth;
  const grey = kind.palette === undefined && kind.channels <= 2;
  const profile = iccBytes ?? (kind.profile ? iccProfile(grey) : undefined);
  return Buffer.concat([
    SIGNATURE,
    header(width, height, kind),
    ...(profile
      ? [chunk('iCCP', Buffer.concat([Buffer.from('icc\0\0', 'latin1'), deflateSync(profile)]))]
      : []),
    ...paletteAndTransparency(kind),
    ...(kind.orientation === undefined ? [] : [exifOrientation(kind.orientation)]),
    chunk('IDAT', await deflateZeros(rawLength(width, height, bits, kind.interlaced))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------------------------
// One measurement in a process of its own, and many of them a few at a time.

/** Runs `measure.mjs` with these options in a new process; its JSON line, or `{ error }`. */
export function measureInChild(flags) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MEASURE_MJS, ...flags], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (data) => (out += data));
    child.stderr.on('data', (data) => (err += data));
    child.on('close', (code) => {
      try {
        if (code !== 0) throw new Error(err.trim() || `exit ${code}`);
        resolve(JSON.parse(out.trim().split('\n').pop()));
      } catch (error) {
        resolve({ error: String(error.message ?? error).slice(-500), flags });
      }
    });
  });
}

/** Runs `task` for every item, `jobs` at a time; the results in the items' order. */
export async function pool(items, jobs, task) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
  return results;
}
