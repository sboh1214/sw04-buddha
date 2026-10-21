// One conversion in this process, measured by libvips' high-water mark (README.md, ADR-0073 9-8):
// a PNG built by hand of the given kind and shape, or a JPEG/PNG/GIF/WebP file.
//
//   node scripts/image-memory/measure.mjs --width 2000 --height 1000 --channels 4 [--depth 16]
//     [--interlaced] [--palette 8] [--transparent] [--profile | --icc file.icc] [--orientation 6]
//     [--via sharp|api] [--out results.jsonl]
//   node scripts/image-memory/measure.mjs --file photo.webp [--via sharp|api] [--out ...]
//
// --via sharp (default): processImage's pipeline without its header checks (the header read, then
//   autoOrient, a resize to fit IMAGE_MAX_DIMENSION and the same encoder) — shapes past the bounds
//   can be measured. Mirrors apps/api/src/media/image.ts: change both together.
// --via api: the API's built processImage itself, header checks included; a refusal prints its
//   reason (`refused`) and the mark of what it decoded (nothing, for a header refusal).
//
// Prints one JSON line: highMiB (libvips' high-water mark, MiB), maxRssMiB (the process's peak
// RSS) and rssBeforeMiB (the same just before the conversion — node, sharp and the file).
// The mark is process-wide and never lowered: run one case per process (the sweeps do).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import {
  KIND_OPTIONS,
  emit,
  int,
  kindName,
  kindOf,
  loadApi,
  loadShared,
  loadSharp,
  pngOf,
} from './lib.mjs';

const { values } = parseArgs({
  options: {
    width: { type: 'string' },
    height: { type: 'string' },
    file: { type: 'string' },
    via: { type: 'string', default: 'sharp' },
    out: { type: 'string' },
    ...KIND_OPTIONS,
  },
});
if (values.via !== 'sharp' && values.via !== 'api') throw new Error('--via is sharp or api');

const sharp = loadSharp();
// Loaded before the baseline RSS is taken. The API's image.js sets the same on import.
const api = values.via === 'api' ? await loadApi() : undefined;
const { IMAGE_MAX_DIMENSION, IMAGE_MAX_INPUT_PIXELS } = await loadShared();
// As the API does (image.ts): no cache, one libvips thread.
const highAtStart = sharp.cache(false).memory.high;
sharp.concurrency(1);
if (highAtStart !== 0) throw new Error(`libvips has allocated before the case: ${highAtStart}MiB`);
const highWater = () => sharp.cache(false).memory.high;
const maxRssMiB = () => Math.round(process.resourceUsage().maxRSS / 1024);

let bytes;
let input;
if (values.file !== undefined) {
  bytes = readFileSync(values.file);
  input = { file: path.basename(values.file) };
} else {
  const width = int(values.width, 'width', undefined);
  const height = int(values.height, 'height', undefined);
  if (!(width > 0 && height > 0)) throw new Error('--width and --height (or --file) are needed');
  const kind = kindOf(values);
  const icc = kind.icc === undefined ? undefined : readFileSync(kind.icc);
  bytes = await pngOf(width, height, kind, icc);
  input = { kind: kindName(kind), width, height, pixels: width * height };
}

/** The four types by their magic numbers, as the API sniffs them. */
function formatOf(data) {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  throw new Error('not a JPEG, PNG, GIF or WebP');
}

const format = formatOf(bytes);
const rssBeforeMiB = maxRssMiB();
const started = performance.now();
let out;
let refused;
if (api !== undefined) {
  try {
    const image = await api.processImage(new Uint8Array(bytes));
    out = { width: image.width, height: image.height, bytes: image.body.length };
  } catch (error) {
    if (error?.code !== 'IMAGE_NOT_ALLOWED') throw error;
    refused = error.details?.reason ?? 'unknown';
  }
} else {
  const animated = format === 'gif' || format === 'webp';
  const options = { animated, limitInputPixels: IMAGE_MAX_INPUT_PIXELS };
  // processImage reads the header first, then converts.
  await sharp(bytes, { ...options, limitInputPixels: false }).metadata();
  const pipeline = sharp(bytes, options).autoOrient().resize({
    width: IMAGE_MAX_DIMENSION,
    height: IMAGE_MAX_DIMENSION,
    fit: 'inside',
    withoutEnlargement: true,
  });
  if (format === 'jpeg') pipeline.jpeg({ quality: 85, mozjpeg: true });
  else if (format === 'png') pipeline.png();
  else if (format === 'gif') pipeline.gif();
  else pipeline.webp({ quality: 85 });
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  out = { width: info.width, height: info.pageHeight ?? info.height, bytes: data.length };
}
const ms = Math.round(performance.now() - started);
const highMiB = highWater();
const peakRssMiB = maxRssMiB();
// The header as sharp reads it, after the mark is taken.
const header = await sharp(bytes, { limitInputPixels: false }).metadata();

emit(
  {
    ...input,
    via: values.via,
    format,
    fileBytes: bytes.length,
    header: {
      width: header.width,
      height: header.pageHeight ?? header.height,
      pages: header.pages ?? 1,
      channels: header.channels,
      depth: header.depth,
      interlaced: header.isProgressive,
      icc: Boolean(header.icc),
      orientation: header.orientation ?? null,
    },
    ...(refused === undefined ? { out } : { refused }),
    highMiB,
    rssBeforeMiB,
    maxRssMiB: peakRssMiB,
    ms,
    sharp: sharp.versions.sharp,
    vips: sharp.versions.vips,
    platform: `${process.platform}-${process.arch}`,
  },
  values.out,
);
