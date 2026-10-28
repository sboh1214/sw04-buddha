// One conversion in this process, measured by libvips' high-water mark and by the process's own
// memory (README.md, ADR-0073 9-8): a PNG built by hand of the given kind and shape, or a
// JPEG/PNG/GIF/WebP file (`make-image.mjs` writes the costly ones).
//
//   node scripts/image-memory/measure.mjs --width 2000 --height 1000 --channels 4 [--depth 16]
//     [--interlaced] [--palette 8] [--transparent] [--profile | --icc file.icc] [--orientation 6]
//     [--via sharp|api] [--out results.jsonl]
//   node scripts/image-memory/measure.mjs --file photo.webp [--via sharp|api|profile]
//     [--encoder '{...}']
//
// --via sharp (default): processImage's pipeline without its header checks (the header read, then
//   autoOrient, a resize to fit inside the build's `outputBox` — IMAGE_MAX_DIMENSION, and
//   WEBP_ALPHA_MAX_OUTPUT_PIXELS for a still WebP with alpha — and the encoder with the build's
//   `encoderOptions`) — shapes past the bounds can be measured. Mirrors apps/api/src/media/image.ts:
//   change both together. --encoder '{"effort":4}' changes the encoder's options on top (to try a
//   setting before image.ts takes it).
// --via api: the API's built processImage itself, header checks included; a refusal prints its
//   reason (`refused`) and the mark of what it decoded (nothing, for a header refusal).
// --via profile: the API's built processProfileImage (#141, ADR-0079) the same way — a profile
//   image's own pipeline (its header checks, the middle square at most 512px, `profileSquare`).
//
// Prints one JSON line: highMiB (libvips' high-water mark, MiB); rssBeforeMiB (the process's RSS
// just before the conversion — node, sharp, the build and the file); peakMiB (the most the RSS rose
// above that while the conversion ran, sampled every millisecond — the whole conversion, encoders
// and allocator included: what IMAGE_CONVERSION_PEAK_BYTES bounds); maxRssMiB (the process's peak
// RSS, start-up included); on Linux anonPeakMiB and filePeakMiB, the rise split into anonymous
// memory and mapped files (libvips maps the temporary file it decodes a large image into, which the
// kernel can drop). The mark and maxRss are process-wide and never lowered: run one case per
// process (the sweeps do).

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
    encoder: { type: 'string' },
    out: { type: 'string' },
    ...KIND_OPTIONS,
  },
});
if (!['sharp', 'api', 'profile'].includes(values.via)) {
  throw new Error('--via is sharp, api or profile');
}

const sharp = loadSharp();
// Loaded before the baseline RSS is taken (both ways: `--via sharp` takes the build's encoder
// options). The API's image.js sets the cache and the threads below on import.
const api = await loadApi();
const encoderOverride = values.encoder === undefined ? {} : JSON.parse(values.encoder);
if (values.via !== 'sharp' && values.encoder !== undefined) {
  throw new Error('--encoder is for --via sharp: the API encodes with its own options');
}
const { IMAGE_MAX_INPUT_PIXELS } = await loadShared();
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

// The rise of the process's resident memory while the conversion runs, sampled from this thread
// (the conversion runs on libuv's): process.memoryUsage.rss() everywhere, and on Linux the
// anonymous and file-backed parts from /proc/self/status.
const MiB = 1024 * 1024;
const linux = process.platform === 'linux';
function linuxRss() {
  const status = readFileSync('/proc/self/status', 'utf8');
  const kib = (key) => Number(status.match(new RegExp(`${key}:\\s+(\\d+)`))[1]);
  return { anon: kib('RssAnon') * 1024, file: kib('RssFile') * 1024 };
}
const rssBefore = process.memoryUsage.rss();
const splitBefore = linux ? linuxRss() : undefined;
let rssTop = rssBefore;
let anonTop = splitBefore?.anon ?? 0;
let fileTop = splitBefore?.file ?? 0;
function sample() {
  rssTop = Math.max(rssTop, process.memoryUsage.rss());
  if (linux) {
    const { anon, file } = linuxRss();
    anonTop = Math.max(anonTop, anon);
    fileTop = Math.max(fileTop, file);
  }
}
const sampler = setInterval(sample, 1);
const rssBeforeMiB = Math.round(rssBefore / MiB);
const started = performance.now();
let out;
let refused;
if (values.via === 'api' || values.via === 'profile') {
  try {
    const convert = values.via === 'api' ? api.processImage : api.processProfileImage;
    const image = await convert(new Uint8Array(bytes));
    out = { width: image.width, height: image.height, bytes: image.body.length };
  } catch (error) {
    if (error?.code !== 'IMAGE_NOT_ALLOWED') throw error;
    refused = error.details?.reason ?? 'unknown';
  }
} else {
  const animated = format === 'gif' || format === 'webp';
  const options = { animated, limitInputPixels: IMAGE_MAX_INPUT_PIXELS };
  // processImage reads the header first, then converts.
  const metadata = await sharp(bytes, { ...options, limitInputPixels: false }).metadata();
  const pipeline = sharp(bytes, options)
    .autoOrient()
    .resize({
      ...api.outputBox(`image/${format}`, metadata),
      fit: 'inside',
      withoutEnlargement: true,
    })
    .toFormat(format, {
      ...api.encoderOptions(`image/${format}`, metadata),
      ...encoderOverride,
    });
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  out = { width: info.width, height: info.pageHeight ?? info.height, bytes: data.length };
}
clearInterval(sampler);
sample();
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
    ...(values.encoder === undefined ? {} : { encoder: encoderOverride }),
    highMiB,
    rssBeforeMiB,
    peakMiB: Math.round((rssTop - rssBefore) / MiB),
    ...(linux
      ? {
          anonPeakMiB: Math.round((anonTop - splitBefore.anon) / MiB),
          filePeakMiB: Math.round((fileTop - splitBefore.file) / MiB),
        }
      : {}),
    maxRssMiB: peakRssMiB,
    ms,
    sharp: sharp.versions.sharp,
    vips: sharp.versions.vips,
    platform: `${process.platform}-${process.arch}`,
  },
  values.out,
);
