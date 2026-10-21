import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_DIMENSION,
  IMAGE_MAX_INPUT_PIXELS,
  type ImageContentType,
  type ImageNotAllowedDetails,
  type ImageRefusal,
} from '@buddha/shared';
import sharp, {
  type GifOptions,
  type JpegOptions,
  type Metadata,
  type OutputInfo,
  type PngOptions,
  type WebpOptions,
} from 'sharp';
import { AppError } from '../common/errors/app-error.js';

// Memory before speed (ADR-0073 9-8): the API's container has 448 MiB for everything it does, and
// a conversion is the one thing in it that can ask libvips for hundreds of megabytes. No cache —
// an upload is decoded once, so a cached operation only holds memory nobody reads again — and one
// libvips thread per conversion (each thread holds its own tiles). Process-wide settings; this is
// the API's only use of sharp.
sharp.cache(false);
sharp.concurrency(1);

/** An upload the image rules refuse (IMAGE_NOT_ALLOWED, 422), with why. */
export function imageRefused(reason: ImageRefusal): AppError {
  const details: ImageNotAllowedDetails = { reason };
  return new AppError('IMAGE_NOT_ALLOWED', { message: `Image refused: ${reason}`, details });
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, index) => bytes[offset + index] === byte);

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/**
 * The image type an upload's bytes say it is, by its magic number — never its name or the
 * Content-Type the browser sent (#45-3: 'wrong type disguised by extension' is refused): JPEG
 * (FF D8 FF), PNG (the eight-byte signature), GIF (GIF87a/GIF89a) or WebP (a RIFF container of
 * type WEBP). Anything else — an SVG, a HEIC, a PDF, a script named `.jpg` — is no image here, and
 * is never handed to the decoder (libvips reads many more formats than the four the owner allowed).
 */
export function sniffImageType(bytes: Uint8Array): ImageContentType | undefined {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  return undefined;
}

/** sharp's name of each allowed type: what the decoder must agree the bytes are. */
const SHARP_FORMAT: Readonly<Record<ImageContentType, 'jpeg' | 'png' | 'gif' | 'webp'>> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** A file extension per type, for the object key. */
export const IMAGE_EXTENSION: Readonly<Record<ImageContentType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * The memory one conversion may take, in bytes: what the decoder and the resize hold at their
 * peak for one frame, by libvips' own count. The header checks keep a frame within it: a JPEG,
 * GIF or opaque still WebP frame by what it holds per pixel (`decodeBytesPerPixel`), a PNG frame
 * by its kind's largest frame, measured at every shape up to IMAGE_MAX_SIDE_RATIO
 * (PNG_LARGEST_FRAME_PIXELS — owner 2026-10-22, ADR-0073 9-8). What libvips does not count — the
 * encoder above all — is IMAGE_CONVERSION_PEAK_BYTES' to bound.
 */
export const IMAGE_DECODE_BUDGET_BYTES = 128 * 1024 * 1024;

/**
 * The most one whole conversion — decode, resize and encode, inside libvips and outside it — may
 * add to the API process's memory at its peak, in bytes: the process's peak resident memory above
 * what it held just before the conversion, measured on Linux arm64 in the API's own image (the
 * container it runs in, glibc's allocator), on the content that costs most — noise, a different
 * picture in every frame — at each kind's bounds (ADR-0073 9-8, Codex review of #219, round 3).
 * libvips' count (IMAGE_DECODE_BUDGET_BYTES) leaves the encoders out: libwebp, libimagequant and
 * cgif, mozjpeg and libspng allocate on their own, and a high-entropy WebP with alpha at the bound
 * it had (about 8.9 megapixels, 2,048px a side once fitted) took ~223MiB by this count while
 * libvips counted 66MiB. 144 is the budget's 128 and 16 for what libvips does not count: the PNG
 * bounds' costliest frames (owner 2026-10-22) take 116–137MiB this way. One conversion runs at a
 * time (`imageConversions`), so this, the uploads being received (64MiB, image-body.ts), the
 * bodies the conversions hold (the one converting — held before it starts, so outside this — and
 * IMAGE_CONVERSIONS_WAITING_MAX waiting, at most IMAGE_MAX_BYTES each: 45MiB), the image reads
 * (32MiB, image-reads.ts) and the API's own use share its container's 448MiB
 * (deploy/compose.yaml; ADR-0073 결과 5 has what that leaves). What keeps each kind within it:
 * the encoder settings (`encoderOptions`), the bound of a progressive JPEG of four components
 * (`decodeBytesPerPixel` — at the three-component one, CMYK took ~158MiB) and the bounds of WebP
 * with alpha, WebP animations and GIF animations below; `image-memory.test.ts` converts each
 * kind's costliest case.
 */
export const IMAGE_CONVERSION_PEAK_BYTES = 144 * 1024 * 1024;

/**
 * How thin one frame may be: its long side at most this many times its short side, else `pixels`
 * (owner 2026-10-22: a measured long/short side ratio, ADR-0073 9-8). What a conversion holds grows
 * with how thin the image is, not only with its pixels: fitting a strip inside IMAGE_MAX_DIMENSION
 * leaves a few output rows to make, so libvips holds every input row at once and buffers a whole
 * row wide on top — a 5,000,000×10 PNG took ~500MiB (grey, 49KB) and ~1.5GiB (RGB, 146KB) by
 * libvips' own count, ~0.9 and ~2.6GB at the process's peak. Measured on the pipeline below at the
 * largest frame an 8-bit grey or RGB PNG may have (IMAGE_MAX_INPUT_PIXELS; sharp 0.35.5, cache off,
 * one thread, libvips' high-water mark): at 32:1 the RGB one peaks at 116MiB — the same with a
 * quarter turn by EXIF, which sharp makes after the resize — and at 118MiB when it embeds an ICC
 * profile (sharp turns the pixels into sRGB before it resizes, and anyone can put a profile in a
 * file), within IMAGE_DECODE_BUDGET_BYTES; at 48:1 already 132MiB, at 100:1 162MiB. The grey one at
 * 32:1 takes 39MiB, 73MiB with a profile (`image-memory.test.ts`). Both ways round: a strip stored
 * tall costs little, but which side a file stores as its width is not what a person sees (EXIF
 * turns it), and the owner's rule is the long side over the short.
 *
 * Most PNG kinds with alpha, 16-bit samples or interlacing hold more at the same shape — at this
 * ratio up to ~275MiB at the most pixels they were allowed before — so each PNG kind has its own
 * largest frame, measured at every shape up to this ratio (PNG_LARGEST_FRAME_PIXELS, owner
 * 2026-10-22); 16-bit grey and interlaced 8-bit grey keep the bound they had
 * (IMAGE_MAX_INPUT_PIXELS, and 41,943,040 for interlaced 16-bit grey).
 *
 * The thin shapes cost what they do because the frame is fitted inside IMAGE_MAX_DIMENSION: a
 * change to it, to this ratio or to IMAGE_DECODE_BUDGET_BYTES, or to sharp or libvips, needs these
 * measurements and PNG_LARGEST_FRAME_PIXELS' again (ADR-0073 결과 5).
 */
export const IMAGE_MAX_SIDE_RATIO = 32;

/**
 * What a conversion holds per pixel of a JPEG, GIF or WebP frame, at its peak, in bytes — measured
 * on the pipeline below (sharp 0.35.5, cache off, one thread, a quarter turn by EXIF where it costs
 * more), at and around the bound, near square, rounded up — and at the bound within
 * IMAGE_DECODE_BUDGET_BYTES as thin as IMAGE_MAX_SIDE_RATIO lets it be too (ADR-0073 9-8; a PNG
 * has PNG_LARGEST_FRAME_PIXELS):
 *
 * - a baseline JPEG is shrunk while it is decoded (libjpeg's shrink-on-load), so even 48
 *   megapixels peak near 45MB — a CMYK one too, 65–70MiB at 50 megapixels by the process's count:
 *   1 byte;
 * - a progressive JPEG — or any of several scans, which libvips reports as progressive — keeps
 *   every coefficient until the last scan, two bytes each, as many as the frame has pixels for
 *   each of its components (fewer for a subsampled one): up to 10 with three (4:4:4), and 14 with
 *   four (CMYK or YCCK, 4:4:4:4 — a third more coefficients, and the turn from CMYK into sRGB).
 *   libjpeg allocates them outside libvips' count, so the four-component value is measured on the
 *   whole conversion (IMAGE_CONVERSION_PEAK_BYTES, ADR-0073 9-8): CMYK noise at that bound (3,096²)
 *   peaked at 131MiB on Linux arm64 and 137 on x64 — what three components take at theirs (133,
 *   136) — against ~158 at the three-component bound (3,663²). A JPEG of more than four is
 *   refused before this (`JPEG_MAX_COMPONENTS`);
 * - a GIF frame is unpacked whole with the frame before it: 16; a WebP frame (read as an
 *   animation, a still one too): 15.
 *
 * The bound this gives is the frame's for a JPEG, a still GIF and a still WebP without alpha. The
 * encoders cost more than libvips counts for the rest, so they have bounds of their own, measured
 * on the whole conversion (IMAGE_CONVERSION_PEAK_BYTES): a still WebP with alpha
 * (WEBP_ALPHA_LARGEST_FRAME_PIXELS), a WebP animation (WEBP_ANIMATION_LARGEST_FRAME_PIXELS and
 * WEBP_ANIMATION_MAX_PIXELS) and a GIF animation (GIF_ANIMATION_LARGEST_FRAME_PIXELS).
 */
export function decodeBytesPerPixel(
  contentType: Exclude<ImageContentType, 'image/png'>,
  metadata: Pick<Metadata, 'isProgressive' | 'channels'>,
): number {
  switch (contentType) {
    case 'image/jpeg':
      if (!metadata.isProgressive) return 1;
      return metadata.channels < 4 ? 10 : 14;
    case 'image/gif':
      return 16;
    case 'image/webp':
      return 15;
  }
}

/**
 * The largest frame of a still WebP with alpha, in pixels (ADR-0073 9-8, Codex review of #219,
 * round 3). libwebp writes the alpha plane losslessly, and that coder holds far more than libvips
 * counts, growing with the frame it writes (at most 2,048px a side, IMAGE_MAX_DIMENSION): a WebP
 * whose alpha is noise took ~176MiB of the process at 2048×2048 even with the encoder's least
 * effort (`encoderOptions`), ~209 with its default. At this bound — 1,612×1,612 — the costliest
 * measured (alpha and colour both noise, the frame written as it came, upright or turned by EXIF,
 * with or without an ICC profile, wide or square, run again and again, a few at once) took at
 * most ~130MiB within IMAGE_CONVERSION_PEAK_BYTES; at 2.8 megapixels already ~142 now and then.
 * A WebP without alpha keeps the bound its decoding gives (`decodeBytesPerPixel`, ~8.9
 * megapixels): the colour coder alone took at most ~82MiB there.
 */
export const WEBP_ALPHA_LARGEST_FRAME_PIXELS = 2_600_000;

/**
 * The largest frame of a WebP animation, and every frame of it together, in pixels (ADR-0073 9-8,
 * Codex review of #219, round 3). libvips decodes a WebP animation whole before it resizes it — in
 * memory while that is under 100MB — and libwebp's animation encoder keeps canvases as large as a
 * frame and every frame's candidate encodings: 2,048×2,048 frames took ~236MiB of the process with
 * two frames that are one colour each and ~354 with five that are noise, eleven of them ~381, at
 * any effort. At these bounds the costliest measured (noise with alpha in every frame, eleven
 * 1,024×1,024 frames; a different colour in every frame; thin frames) took at most ~116MiB on
 * Linux arm64 and ~122 on x64, within IMAGE_CONVERSION_PEAK_BYTES. A frame past the first is
 * `pixels`, frames together past the second are `frames`.
 */
export const WEBP_ANIMATION_LARGEST_FRAME_PIXELS = 1_050_000;
export const WEBP_ANIMATION_MAX_PIXELS = 12_000_000;

/**
 * The largest frame of a GIF animation, in pixels (ADR-0073 9-8, Codex review of #219, round 3).
 * A still GIF keeps the bound its decoding gives (`decodeBytesPerPixel`, ~8.4 megapixels), but an
 * animation of thin frames holds more with every frame, up to a few: eight-megapixel frames at
 * 32:1 took ~115MiB of the process as a still and ~159 as five frames — the resize of the frames
 * stacked, not the encoder. At this bound the costliest measured (32:1, ten frames, a different
 * colour in each) took about 130MiB within IMAGE_CONVERSION_PEAK_BYTES (16:1 ~107, square ~90);
 * at six megapixels 32:1 already took 144.
 */
export const GIF_ANIMATION_LARGEST_FRAME_PIXELS = 5_000_000;

/**
 * The most components a JPEG may have: CMYK's (or YCCK's) four. libjpeg reads up to ten and libvips
 * hands each on as a band, but no picture a person sends has more than four, and a progressive one
 * holds more than any bound here is measured for — a five-component one at the three-component
 * bound (3,663², 13.4 megapixels) took 187MiB of the process on Linux arm64, 191 on x64, and was
 * converted (ADR-0073 9-8). More is refused from the header as `unreadable` (sharp's header read
 * already refuses six and up).
 */
export const JPEG_MAX_COMPONENTS = 4;

/** A PNG's channels as it decodes: grey, grey + alpha, RGB, RGBA. */
type PngChannels = Metadata['channels'];

/**
 * The largest frame a PNG may have, in pixels (owner 2026-10-22, ADR-0073 9-8), by what its header
 * says it decodes to — its channels (a palette decodes to RGB, or RGBA with transparency; grey or
 * RGB with a transparent colour, to grey + alpha or RGBA), 8 bits a sample (1 to 8 decode as 8)
 * or 16 — then [not interlaced, interlaced]: so that converting any frame the header checks let
 * through stays within IMAGE_DECODE_BUDGET_BYTES, whatever its shape up to IMAGE_MAX_SIDE_RATIO
 * and with an embedded ICC profile (anyone can put one in a file, and sharp turns the pixels into
 * sRGB before the resize — but not a 16-bit grey or grey + alpha one's). `image.test.ts` checks
 * that sharp's header reads palette and transparent-colour PNGs as the kind they decode to.
 *
 * Not a cost per pixel: what a PNG conversion holds depends on the frame's shape far more than on
 * its pixels. libvips reads a plain PNG a band of rows at a time and an interlaced one whole, and
 * the resize holds input rows as wide as the frame, most where libvips' integral vertical shrink
 * is about to step up — a vertical factor just under 4, 6, 8 … (sharp fits the frame inside
 * IMAGE_MAX_DIMENSION and rounds the output height): 16-bit RGBA at 3.5 megapixels took 127MiB as
 * 8195×427 (a factor of 3.99) and 79MiB as 8195×424 (4.0).
 *
 * Measured by libvips' high-water mark on the pipeline below (sharp 0.35.5, libvips 8.18.7, cache
 * off, one thread, macOS arm64) with a hand-made profile (a real Display P3 one measured the same,
 * and so did palette, transparent-colour and 1- to 4-bit PNGs against the kind they decode to):
 * the bound's wide frames from 1:1 to 32:1 every 50 to 100 px, every 4 to 8 px around those widths
 * and at 32:1 with the heights whose factor is just under the step, and up to 4:1 turned a quarter
 * by EXIF (sharp turns after the resize; a frame stored tall holds far less). Each value is a
 * multiple of 100,000 at which the costliest of them took at most 126MiB — room under the budget
 * for the shapes between — or the bound the kind had before where that was already within; 8-bit
 * RGBA, for one, takes a 5K screenshot (14.7 megapixels) and refuses 8000×6000.
 * `image-memory.test.ts` converts each kind's costliest frame — only those shapes, so a change to
 * IMAGE_MAX_DIMENSION (which places the shrink's steps), the budget, the ratio or
 * IMAGE_MAX_INPUT_PIXELS, or to sharp or libvips, needs the measurement again (ADR-0073 결과 5).
 * The values are this pipeline's: another — a profile image's square cut to 512px (#141) — has
 * costliest shapes of its own and is measured on its own before it uses them.
 */
export const PNG_LARGEST_FRAME_PIXELS: Readonly<
  Record<PngChannels, Readonly<Record<8 | 16, readonly [plain: number, interlaced: number]>>>
> = {
  1: {
    8: [IMAGE_MAX_INPUT_PIXELS, IMAGE_MAX_INPUT_PIXELS],
    16: [IMAGE_MAX_INPUT_PIXELS, 41_943_040],
  },
  2: { 8: [37_000_000, 24_500_000], 16: [25_900_000, 17_300_000] },
  3: { 8: [IMAGE_MAX_INPUT_PIXELS, 26_400_000], 16: [13_100_000, 10_300_000] },
  4: { 8: [19_700_000, 15_700_000], 16: [3_300_000, 4_600_000] },
};

/** Whether the header says the image has more than one frame (a GIF or WebP animation). */
function isAnimation(metadata: Pick<Metadata, 'pages'>): boolean {
  return (metadata.pages ?? 1) > 1;
}

/**
 * The most pixels one frame of this image may have (step 3 of `processImage`): a PNG's from
 * PNG_LARGEST_FRAME_PIXELS, a still WebP with alpha's, a WebP animation's and a GIF animation's
 * from their own bounds, any other's from IMAGE_DECODE_BUDGET_BYTES and what it holds per pixel.
 */
export function largestFramePixels(
  contentType: ImageContentType,
  metadata: Pick<Metadata, 'channels' | 'depth' | 'isProgressive' | 'hasAlpha' | 'pages'>,
): number {
  if (contentType === 'image/png') {
    return PNG_LARGEST_FRAME_PIXELS[metadata.channels][metadata.depth === 'ushort' ? 16 : 8][
      metadata.isProgressive ? 1 : 0
    ];
  }
  if (contentType === 'image/webp') {
    if (isAnimation(metadata)) return WEBP_ANIMATION_LARGEST_FRAME_PIXELS;
    if (metadata.hasAlpha) return WEBP_ALPHA_LARGEST_FRAME_PIXELS;
  }
  if (contentType === 'image/gif' && isAnimation(metadata)) {
    return GIF_ANIMATION_LARGEST_FRAME_PIXELS;
  }
  return Math.floor(IMAGE_DECODE_BUDGET_BYTES / decodeBytesPerPixel(contentType, metadata));
}

/**
 * The most pixels every frame of this image together may have (step 3 of `processImage`): a WebP
 * animation's own bound, any other's IMAGE_MAX_INPUT_PIXELS.
 */
export function largestImagePixels(
  contentType: ImageContentType,
  metadata: Pick<Metadata, 'pages'>,
): number {
  return contentType === 'image/webp' && isAnimation(metadata)
    ? WEBP_ANIMATION_MAX_PIXELS
    : IMAGE_MAX_INPUT_PIXELS;
}

/**
 * What each encoder is asked for (step 5 of `processImage`), by the image's header (ADR-0073 9-8,
 * Codex review of #219, round 3). The settings that matter are the ones that bound the encoder's
 * memory, measured on the whole conversion (IMAGE_CONVERSION_PEAK_BYTES):
 *
 * - JPEG: quality 85 with mozjpeg's settings (progressive, trellis): ~30MiB at 2,048px.
 * - PNG: sharp's defaults (zlib level 6, adaptive filters): ~20MiB.
 * - GIF: effort 3 — libimagequant's palette at this effort holds about half what it holds at 4 and
 *   above (7 is sharp's default; 1 to 3 hold and write the same): five 2,896×2,896 frames took
 *   ~108MiB against ~181 at 7, 16-colour noise ~94 against ~140, eleven 2,048px frames ~80 against
 *   ~150. The palette is a little rougher: a GIF that is not shrunk comes back at ~47dB PSNR
 *   against ~67 at 7, a shrunk one ~42 against ~44, and 10–20% larger.
 * - WebP: quality 85; effort 2, not sharp's default 4 — from 3 up libwebp keeps the whole image's
 *   tokens for its rate optimisation (~129MiB for noise at 2,048px against ~82 at 2), for photos
 *   2–6% larger at the same quality — and effort 0 for a still WebP with alpha, whose lossless
 *   alpha coder holds less the less it searches (~30MiB less at 2,048px than at 2), for photos
 *   about a quarter larger. `smartSubsample` stays off (it keeps another copy of the image).
 */
export function encoderOptions(
  contentType: ImageContentType,
  metadata: Pick<Metadata, 'hasAlpha' | 'pages'>,
): JpegOptions | PngOptions | GifOptions | WebpOptions {
  switch (contentType) {
    case 'image/jpeg':
      return { quality: 85, mozjpeg: true };
    case 'image/png':
      return {};
    case 'image/gif':
      return { effort: 3 };
    case 'image/webp':
      return {
        quality: 85,
        effort: metadata.hasAlpha && !isAnimation(metadata) ? 0 : 2,
        smartSubsample: false,
      };
  }
}

/** How long a client refused for a full queue waits before sending again. */
export const IMAGE_BUSY_RETRY_SECONDS = 2;

/**
 * Runs tasks one at a time, in the order they came, and refuses one when `maxWaiting` are already
 * waiting behind the one running. The waiting tasks hold their uploads' bytes (at most
 * IMAGE_BODY_LIMIT each), so the queue is bounded as well as the conversion.
 */
export class OneAtATime {
  private tail: Promise<unknown> = Promise.resolve();
  private held = 0;

  constructor(private readonly maxWaiting: number) {}

  /** Tasks running or waiting. */
  get size(): number {
    return this.held;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.held > this.maxWaiting) {
      // RATE_LIMITED: the client waits and sends again (the web says '다시 시도해 주세요').
      return Promise.reject(
        new AppError('RATE_LIMITED', {
          message: 'Too many images are being converted; send it again',
          details: { retryAfterSeconds: IMAGE_BUSY_RETRY_SECONDS },
        }),
      );
    }
    this.held += 1;
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result.finally(() => {
      this.held -= 1;
    });
  }
}

/**
 * Conversions waiting behind the one running, at most: a few seconds of work (a conversion takes
 * well under a second for a photo, a few seconds for a long animation), and at most this many
 * uploads' bytes held while they wait. Implementation-chosen; the owner kept it as built (owner
 * decision 2026-10-19 answer 6). Its bodies are part of what ADR-0073 결과 5 found cannot all fit
 * in the API container's 448MiB at once — whether to lower it is the owner's question (결과 4).
 */
export const IMAGE_CONVERSIONS_WAITING_MAX = 8;

/** The API's conversions: one at a time, process-wide (the memory bound above is per conversion). */
export const imageConversions = new OneAtATime(IMAGE_CONVERSIONS_WAITING_MAX);

/** An upload as it is stored: the converted bytes, their type and one frame's size. */
export interface ProcessedImage {
  readonly body: Uint8Array;
  readonly contentType: ImageContentType;
  readonly width: number;
  readonly height: number;
}

/**
 * Checks and converts an upload (#45-3) — what the server stores is always its own encoding,
 * never the bytes it received:
 *
 * 1. Not empty, at most IMAGE_MAX_BYTES (the content-type parser stops a larger body first).
 * 2. One of the four types by its magic number (`sniffImageType`), and the decoder agrees — a
 *    JPEG of at most JPEG_MAX_COMPONENTS components.
 * 3. Small enough to convert, read from the header before anything is decoded (a decompression
 *    bomb is a few bytes): one frame no thinner than IMAGE_MAX_SIDE_RATIO allows and no larger
 *    than its kind's largest frame (`largestFramePixels` — within IMAGE_DECODE_BUDGET_BYTES by
 *    libvips' count and IMAGE_CONVERSION_PEAK_BYTES by the process's), else `pixels`; every frame
 *    together within IMAGE_MAX_INPUT_PIXELS (a WebP animation's own bound, `largestImagePixels`),
 *    else `frames` for an animation and `pixels` for a still — sharp's own limit is a second
 *    fence.
 * 4. Turned upright by its EXIF orientation, then shrunk to fit IMAGE_MAX_DIMENSION on its long side
 *    (never enlarged); an animated GIF or WebP keeps every frame and its timing.
 * 5. Encoded again in its own type, with the settings that bound the encoder's memory
 *    (`encoderOptions`). sharp writes no metadata unless asked, so EXIF (the place and the device a
 *    photo was taken with), XMP, IPTC and the ICC profile are gone — the pixels are turned into
 *    sRGB first, so the colours stay.
 *
 * Steps 4 and 5 run one conversion at a time (`imageConversions`); a refusal from the header waits
 * for nothing. Throws IMAGE_NOT_ALLOWED with the reason for anything it refuses, and RATE_LIMITED
 * when too many conversions are already waiting.
 */
export async function processImage(bytes: Uint8Array): Promise<ProcessedImage> {
  if (bytes.length === 0) throw imageRefused('empty');
  if (bytes.length > IMAGE_MAX_BYTES) throw imageRefused('size');
  const contentType = sniffImageType(bytes);
  if (contentType === undefined) throw imageRefused('type');

  // Every frame of an animation (GIF, animated WebP); a still image has one page either way.
  const animated = contentType === 'image/gif' || contentType === 'image/webp';
  const input = { animated, limitInputPixels: IMAGE_MAX_INPUT_PIXELS } as const;
  let metadata: Metadata;
  try {
    // The header only: nothing is decoded, so no pixel limit is needed to read it (sharp's own
    // would refuse a bomb here as a failure to read, not as what it is).
    metadata = await sharp(bytes, { ...input, limitInputPixels: false }).metadata();
  } catch {
    throw imageRefused('unreadable');
  }
  if (metadata.format !== SHARP_FORMAT[contentType]) throw imageRefused('unreadable');
  if (contentType === 'image/jpeg' && metadata.channels > JPEG_MAX_COMPONENTS) {
    throw imageRefused('unreadable');
  }
  const width = metadata.width;
  // `height` is every frame stacked; `pageHeight` one frame's (none for a still image).
  const totalHeight = metadata.height;
  if (!width || !totalHeight) throw imageRefused('unreadable');
  const frameHeight = metadata.pageHeight ?? totalHeight;
  if (
    Math.max(width, frameHeight) > IMAGE_MAX_SIDE_RATIO * Math.min(width, frameHeight) ||
    width * frameHeight > largestFramePixels(contentType, metadata)
  ) {
    throw imageRefused('pixels');
  }
  if (width * totalHeight > largestImagePixels(contentType, metadata)) {
    throw imageRefused(frameHeight < totalHeight ? 'frames' : 'pixels');
  }

  const pipeline = sharp(bytes, input)
    .autoOrient()
    .resize({
      width: IMAGE_MAX_DIMENSION,
      height: IMAGE_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .toFormat(SHARP_FORMAT[contentType], encoderOptions(contentType, metadata));
  let output: { data: Buffer; info: OutputInfo };
  try {
    output = await imageConversions.run(() => pipeline.toBuffer({ resolveWithObject: true }));
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && /pixel limit/i.test(error.message)) throw imageRefused('pixels');
    throw imageRefused('unreadable');
  }
  return {
    body: new Uint8Array(output.data),
    contentType,
    width: output.info.width,
    height: output.info.pageHeight ?? output.info.height,
  };
}
