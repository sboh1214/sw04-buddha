import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_DIMENSION,
  IMAGE_MAX_INPUT_PIXELS,
  PROFILE_IMAGE_CONTENT_TYPES,
  PROFILE_IMAGE_SIZE,
  type ImageContentType,
  type ImageNotAllowedDetails,
  type ImageRefusal,
  type ProfileImageContentType,
} from '@buddha/shared';
import sharp, {
  type GifOptions,
  type JpegOptions,
  type Metadata,
  type OutputInfo,
  type PngOptions,
  type Sharp,
  type WebpOptions,
} from 'sharp';
import { AppError } from '../common/errors/app-error.js';
import { memoryAdmission, memoryWaits } from './memory-admission.js';

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
 * (PNG_LARGEST_FRAME_PIXELS — owner decision 2026-10-21 (2차) answer 4, ADR-0073 9-8). What
 * libvips does not count — the encoder above all — is IMAGE_CONVERSION_PEAK_BYTES' to bound.
 */
export const IMAGE_DECODE_BUDGET_BYTES = 128 * 1024 * 1024;

/**
 * The most one whole conversion — decode, resize and encode, inside libvips and outside it — may
 * add to the API process's memory at its peak, in bytes: the process's peak resident memory above
 * what it held just before the conversion, measured on Linux arm64 and x64 in the API's own image
 * (the container it runs in, glibc's allocator with the image's MALLOC_MMAP_THRESHOLD_ — the
 * Dockerfile; the costliest kinds took as much or less with it, a WebP with alpha ~25MiB less), on
 * the content that costs most — noise, a different picture in every frame — at each kind's bounds
 * (ADR-0073 9-8, Codex review of #219, round 3).
 * libvips' count (IMAGE_DECODE_BUDGET_BYTES) leaves the encoders out: libwebp, libimagequant and
 * cgif, mozjpeg and libspng allocate on their own, and a high-entropy WebP with alpha at the bound
 * it had (about 8.9 megapixels, 2,048px a side once fitted) took ~223MiB by this count while
 * libvips counted 66MiB. 144 is the budget's 128 and 16 for what libvips does not count: the PNG
 * bounds' costliest frames (owner decision 2026-10-21 (2차) answer 4) take 116–137MiB this way.
 * One conversion runs at a time (`imageConversions`), and it starts only once the API's memory has
 * room for this much (`memoryAdmission`, owner decision 2026-10-22 answer 3): the process's RSS,
 * the shares already given out — the uploads being received (at most 64MiB, image-body.ts), the
 * image reads (at most 32MiB, image-reads.ts) — the room the reads may still take of their
 * budget (a read does not wait for a conversion's share) and this together within a ceiling under
 * the container's 448MiB (deploy/compose.yaml; ADR-0073 9-46 and 결과 5). What keeps each kind
 * within it: the encoder settings (`encoderOptions`), the bound of a progressive JPEG of four
 * components (`decodeBytesPerPixel` — at the three-component one, CMYK took ~158MiB), the size a
 * still WebP with alpha is written at (WEBP_ALPHA_MAX_OUTPUT_PIXELS) and the bounds of WebP
 * animations and GIF animations below; `image-memory.test.ts` converts each kind's costliest
 * case.
 */
export const IMAGE_CONVERSION_PEAK_BYTES = 144 * 1024 * 1024;

/**
 * How thin one frame may be: its long side at most this many times its short side, else `pixels`
 * (owner decision 2026-10-21 (2차) answer 1: a measured long/short side ratio, ADR-0073 9-8). What a
 * conversion holds grows with how thin the image is, not only with its pixels: fitting a strip
 * inside IMAGE_MAX_DIMENSION leaves a few output rows to make, so libvips holds every input row at
 * once and buffers a whole row wide on top — a 5,000,000×10 PNG took ~500MiB (grey, 49KB) and
 * ~1.5GiB (RGB, 146KB) by libvips' own count, ~0.9 and ~2.6GB at the process's peak. Measured on
 * the pipeline below at the largest frame an 8-bit grey or RGB PNG may have
 * (IMAGE_MAX_INPUT_PIXELS; sharp 0.35.5, cache off, one thread, libvips' high-water mark): at 32:1
 * the RGB one peaks at 116MiB — the same with a quarter turn by EXIF, which sharp makes after the
 * resize — and at 118MiB when it embeds an ICC profile (sharp turns the pixels into sRGB before it
 * resizes, and anyone can put a profile in a file), within IMAGE_DECODE_BUDGET_BYTES; at 48:1
 * already 132MiB, at 100:1 162MiB. The grey one at 32:1 takes 39MiB, 73MiB with a profile
 * (`image-memory.test.ts`). Both ways round: a strip stored tall costs little, but which side a
 * file stores as its width is not what a person sees (EXIF turns it), and the owner's rule is the
 * long side over the short.
 *
 * Most PNG kinds with alpha, 16-bit samples or interlacing hold more at the same shape — at this
 * ratio up to ~275MiB at the most pixels they were allowed before — so each PNG kind has its own
 * largest frame, measured at every shape up to this ratio (PNG_LARGEST_FRAME_PIXELS, owner
 * decision 2026-10-21 (2차) answer 4); 16-bit grey and interlaced 8-bit grey keep the bound they had
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
 * The bound this gives is the frame's for a JPEG, a still GIF and a still WebP, with alpha or
 * without — one with alpha is written smaller instead when its encoder would cost too much
 * (WEBP_ALPHA_MAX_OUTPUT_PIXELS). The encoders cost more than libvips counts for animations, so
 * they have bounds of their own, measured on the whole conversion (IMAGE_CONVERSION_PEAK_BYTES): a
 * WebP animation (WEBP_ANIMATION_LARGEST_FRAME_PIXELS and WEBP_ANIMATION_MAX_PIXELS) and a GIF
 * animation (GIF_ANIMATION_LARGEST_FRAME_PIXELS).
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
 * A WebP whose profile square is cut from the file, per pixel: measured on `profileSquare` (sharp
 * 0.35.5, cache off, one thread, libvips' own high-water mark) at the WebP's bound and at 4:1 to
 * 40:1, a quarter turn by EXIF or none, lossy and lossless — up to 16.8 with an alpha channel (15.4
 * without), rounded up. At the 15 a post's WebP is charged, a long one of ~8.9 megapixels took
 * 129–143 MiB, over IMAGE_DECODE_BUDGET_BYTES; at this, ~7.9 megapixels, 126 MiB at most (121 at
 * IMAGE_MAX_SIDE_RATIO; ADR-0079 7-16, profile-image-memory.test.ts).
 */
export const PROFILE_WEBP_CUT_BYTES_PER_PIXEL = 17;

/**
 * What a profile image's conversion holds per pixel of a JPEG or WebP frame at its peak, in bytes:
 * what a post's image of its format does (`decodeBytesPerPixel`), but
 * PROFILE_WEBP_CUT_BYTES_PER_PIXEL for a WebP whose square `profileSquare` cuts from the file
 * (`cutsSquareFirst`) — that one is decoded whole, with none of libwebp's scaled decoding a post's
 * image of the same file gets. `width`×`height` is one frame as stored. A PNG has no cost per pixel
 * (PNG_LARGEST_FRAME_PIXELS).
 */
export function profileDecodeBytesPerPixel(
  contentType: Exclude<ProfileImageContentType, 'image/png'>,
  metadata: Pick<Metadata, 'channels' | 'isProgressive'>,
  width: number,
  height: number,
): number {
  return contentType === 'image/webp' && cutsSquareFirst(contentType, width, height)
    ? PROFILE_WEBP_CUT_BYTES_PER_PIXEL
    : decodeBytesPerPixel(contentType, metadata);
}

/**
 * The most pixels one frame of a profile image may have: a PNG's as a post's image's
 * (`largestFramePixels`), a JPEG's or WebP's from IMAGE_DECODE_BUDGET_BYTES and what its
 * conversion holds per pixel (`profileDecodeBytesPerPixel`).
 */
function profileLargestFramePixels(
  contentType: ProfileImageContentType,
  metadata: Pick<Metadata, 'channels' | 'depth' | 'isProgressive' | 'pages'>,
  width: number,
  height: number,
): number {
  if (contentType === 'image/png') return largestFramePixels(contentType, metadata);
  return Math.floor(
    IMAGE_DECODE_BUDGET_BYTES / profileDecodeBytesPerPixel(contentType, metadata, width, height),
  );
}

/**
 * The most pixels a still WebP with alpha is written with (owner decision 2026-10-22 answer 1,
 * ADR-0073 9-8): one larger is shrunk to this — on top of fitting IMAGE_MAX_DIMENSION, keeping its
 * shape (`outputBox`) — rather than refused; 1,843×1,843 for a square one, while a 4:3 or wider
 * one fits IMAGE_MAX_DIMENSION within it (2,048×1,536 is 3.1 megapixels). libwebp writes the
 * alpha plane losslessly, and that coder holds far more than libvips counts, growing with the
 * frame it writes: written at 2048×2048, a WebP whose alpha is noise took ~155MiB of the process
 * even with the encoder's least effort (`encoderOptions`), whatever it was read from. The frame is
 * read up to its decoding bound (`decodeBytesPerPixel`, ~8.9 megapixels), shrunk and written: with
 * the API's allocator setting (MALLOC_MMAP_THRESHOLD_, Dockerfile) what that costs is the writing,
 * the reading adds little — written at this, the costliest measured (alpha and colour both noise,
 * read at this size and up to the decoding bound, square and 1.6 times as wide, upright or turned
 * by EXIF, with or without an ICC profile, run again and again, a few at once) took at most
 * ~132MiB on Linux arm64 and ~135 on x64 within IMAGE_CONVERSION_PEAK_BYTES — under what the
 * costliest PNG takes (135, 137); written at 3.6 megapixels already ~139 on x64, at 3.8 ~145 on
 * arm64. Until the owner's answer 2,600,000 was the largest frame taken (measured without the
 * allocator setting, which then cost up to ~25MiB more), and one larger was refused. A WebP
 * without alpha is written at IMAGE_MAX_DIMENSION: the colour coder alone took at most ~82MiB
 * there.
 */
export const WEBP_ALPHA_MAX_OUTPUT_PIXELS = 3_400_000;

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
 * The largest frame a PNG may have, in pixels (owner decision 2026-10-21 (2차) answers 4 and 5,
 * ADR-0073 9-8), by what its header says it decodes to — its channels (a palette decodes to RGB, or RGBA with transparency; grey or
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
 * PNG_LARGEST_FRAME_PIXELS, a WebP animation's and a GIF animation's from their own bounds, any
 * other's — a still WebP with alpha's too, which is written smaller instead (`outputBox`) — from
 * IMAGE_DECODE_BUDGET_BYTES and what it holds per pixel.
 */
export function largestFramePixels(
  contentType: ImageContentType,
  metadata: Pick<Metadata, 'channels' | 'depth' | 'isProgressive' | 'pages'>,
): number {
  if (contentType === 'image/png') {
    return PNG_LARGEST_FRAME_PIXELS[metadata.channels][metadata.depth === 'ushort' ? 16 : 8][
      metadata.isProgressive ? 1 : 0
    ];
  }
  if (contentType === 'image/webp' && isAnimation(metadata)) {
    return WEBP_ANIMATION_LARGEST_FRAME_PIXELS;
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

/** The size one frame is fitted inside (step 4 of `processImage`), never enlarged. */
export interface OutputBox {
  readonly width: number;
  readonly height: number;
}

/**
 * The box one frame is fitted inside (step 4 of `processImage`): IMAGE_MAX_DIMENSION a side — and
 * for a still WebP with alpha that would still have more than WEBP_ALPHA_MAX_OUTPUT_PIXELS there,
 * the box of its own shape (upright, as EXIF turns it) with at most that many pixels (owner
 * decision 2026-10-22 answer 1). sharp fits the frame inside it keeping the shape and rounding the
 * side that is not the box's, so the frame it writes is within the box.
 */
export function outputBox(
  contentType: ImageContentType,
  metadata: Pick<
    Metadata,
    'width' | 'height' | 'pageHeight' | 'orientation' | 'hasAlpha' | 'pages'
  >,
): OutputBox {
  const square = { width: IMAGE_MAX_DIMENSION, height: IMAGE_MAX_DIMENSION };
  if (contentType !== 'image/webp' || !metadata.hasAlpha || isAnimation(metadata)) return square;
  const frameHeight = metadata.pageHeight ?? metadata.height;
  // EXIF orientations 5 to 8 turn the frame a quarter (sharp's autoOrient).
  const turned = (metadata.orientation ?? 1) >= 5;
  const width = turned ? frameHeight : metadata.width;
  const height = turned ? metadata.width : frameHeight;
  // As sharp fits it inside the square: the long side at 2,048, the other rounded.
  const factor = Math.max(1, width / IMAGE_MAX_DIMENSION, height / IMAGE_MAX_DIMENSION);
  if (Math.round(width / factor) * Math.round(height / factor) <= WEBP_ALPHA_MAX_OUTPUT_PIXELS) {
    return square;
  }
  const scale = Math.sqrt(WEBP_ALPHA_MAX_OUTPUT_PIXELS / (width * height));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
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
 * The refusal of an upload or a conversion the API's memory had no room for in time (owner
 * decision 2026-10-22 answer 3): RATE_LIMITED, sent again after IMAGE_BUSY_RETRY_SECONDS — what a
 * full conversion queue answers.
 */
export function imageMemoryBusy(): AppError {
  return new AppError('RATE_LIMITED', {
    message: 'The server is short of memory for images; send it again',
    details: { retryAfterSeconds: IMAGE_BUSY_RETRY_SECONDS },
  });
}

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
 * decision 2026-10-19 answer 6). The bodies waiting are in the process's RSS, which the memory
 * admission watches (owner decision 2026-10-22 answer 3, ADR-0073 9-46).
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
 *    — a still WebP with alpha to WEBP_ALPHA_MAX_OUTPUT_PIXELS too (`outputBox`) — never
 *    enlarged; an animated GIF or WebP keeps every frame and its timing.
 * 5. Encoded again in its own type, with the settings that bound the encoder's memory
 *    (`encoderOptions`). sharp writes no metadata unless asked, so EXIF (the place and the device a
 *    photo was taken with), XMP, IPTC and the ICC profile are gone — the pixels are turned into
 *    sRGB first, so the colours stay.
 *
 * Steps 4 and 5 run one conversion at a time (`imageConversions`), each once the API's memory has
 * room for IMAGE_CONVERSION_PEAK_BYTES (`memoryAdmission`) — waiting for it until
 * `memoryWaits.conversionMs` after the conversion joined the queue; a refusal from the header
 * waits for nothing. Throws IMAGE_NOT_ALLOWED with the reason for anything
 * it refuses, and RATE_LIMITED when too many conversions are already waiting or the memory had no
 * room in time.
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
    .resize({ ...outputBox(contentType, metadata), fit: 'inside', withoutEnlargement: true })
    .toFormat(SHARP_FORMAT[contentType], encoderOptions(contentType, metadata));
  // The memory's wait counts from when the conversion joins the queue, not from its turn: one
  // queued behind a conversion that waited in vain is refused at once if there is still no room,
  // rather than waiting its own whole time after that one's (ADR-0073 9-46).
  const deadline = Date.now() + memoryWaits.conversionMs;
  let output: { data: Buffer; info: OutputInfo };
  try {
    output = await imageConversions.run(async () => {
      const release = await memoryAdmission.admit(IMAGE_CONVERSION_PEAK_BYTES, {
        kind: 'conversion',
        waitMs: Math.max(0, deadline - Date.now()),
      });
      if (release === null) throw imageMemoryBusy();
      try {
        return await pipeline.toBuffer({ resolveWithObject: true });
      } finally {
        release();
      }
    });
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

/** An upload the header checks let through: its type, how the decoder is to read it, one frame's size. */
interface InspectedImage<T extends ImageContentType> {
  readonly contentType: T;
  readonly input: { readonly animated: boolean; readonly limitInputPixels: number };
  /** One frame as stored, before any EXIF orientation turns it. */
  readonly width: number;
  readonly height: number;
}

/**
 * Steps 1 to 3 of `processImage`, for `processProfileImage`, before anything is decoded: not empty,
 * at most IMAGE_MAX_BYTES, one of `types` by its magic number with the decoder agreeing, not very
 * thin or long, and small enough to decode by its header — one frame (`width`×`height` as stored)
 * within `largestFrame`. `animated` reads every frame of a GIF or a WebP — a post's image keeps
 * them — and false reads the first frame only, which is all that is then decoded and so all that
 * is counted.
 */
async function inspectImage<T extends ImageContentType>(
  bytes: Uint8Array,
  types: readonly T[],
  animated: (contentType: T) => boolean,
  largestFrame: (contentType: T, metadata: Metadata, width: number, height: number) => number,
): Promise<InspectedImage<T>> {
  if (bytes.length === 0) throw imageRefused('empty');
  if (bytes.length > IMAGE_MAX_BYTES) throw imageRefused('size');
  const sniffed = sniffImageType(bytes);
  const contentType = types.find((type) => type === sniffed);
  if (contentType === undefined) throw imageRefused('type');

  const input = { animated: animated(contentType), limitInputPixels: IMAGE_MAX_INPUT_PIXELS };
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
  // `height` is every frame read stacked (one, unless `animated`); `pageHeight` one frame's (none
  // for a still image).
  const totalHeight = metadata.height;
  if (!width || !totalHeight) throw imageRefused('unreadable');
  const frameHeight = metadata.pageHeight ?? totalHeight;
  // Very thin or long (owner decisions 2026-10-22, IMAGE_MAX_SIDE_RATIO): the per-pixel costs below
  // were measured on ordinary shapes, and a strip costs far more than its pixels say — refused
  // whatever its pixel count, a quarter turn by EXIF making no difference.
  if (Math.max(width, frameHeight) > IMAGE_MAX_SIDE_RATIO * Math.min(width, frameHeight)) {
    throw imageRefused('pixels');
  }
  if (width * frameHeight > largestFrame(contentType, metadata, width, frameHeight)) {
    throw imageRefused('pixels');
  }
  if (width * totalHeight > largestImagePixels(contentType, metadata)) {
    throw imageRefused(frameHeight < totalHeight ? 'frames' : 'pixels');
  }
  return { contentType, input, width, height: frameHeight };
}

/** Encodes `pipeline` in `contentType` again — what makes the stored bytes the server's own. */
function encodeAs(pipeline: Sharp, contentType: ImageContentType): void {
  switch (contentType) {
    case 'image/jpeg':
      pipeline.jpeg({ quality: 85, mozjpeg: true });
      break;
    case 'image/png':
      pipeline.png();
      break;
    case 'image/gif':
      pipeline.gif();
      break;
    case 'image/webp':
      pipeline.webp({ quality: 85 });
      break;
  }
}

/** A conversion's output: the encoded bytes and what sharp says of them. */
type Converted = { data: Buffer; info: OutputInfo };

/**
 * Runs a conversion in the API's queue (`imageConversions`) — all of `task`, however many passes it
 * makes, as one turn — refusing what the decoder cannot read.
 */
async function convert(task: () => Promise<Converted>): Promise<Converted> {
  try {
    return await imageConversions.run(task);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && /pixel limit/i.test(error.message)) throw imageRefused('pixels');
    throw imageRefused('unreadable');
  }
}

/**
 * A profile image as it is stored: a square of one of its three types, PROFILE_IMAGE_SIZE at most —
 * the upload's short side when that is smaller.
 */
export interface ProcessedProfileImage extends ProcessedImage {
  readonly contentType: ProfileImageContentType;
}

/**
 * Checks and converts a profile image (#141, ADR-0069 decision 3 #37-6: «JPEG·PNG·WebP, 5MB, 서버에서
 * 정사각 512px로 자르고 EXIF 제거») — as a post's image is (`processImage`), but:
 *
 * - JPEG, PNG or WebP only (PROFILE_IMAGE_CONTENT_TYPES): a GIF is refused as `type`, as anything
 *   else that is not one of the three is.
 * - The first frame of an animated WebP only: the decoder reads that one frame, so the header checks
 *   count that frame alone, and the stored image is still (ADR-0079).
 * - A WebP whose square is cut from the file is counted at what that costs, more than a post's
 *   image of it (`profileDecodeBytesPerPixel`): past that, `pixels`. A PNG has a post's image's
 *   bound (`largestFramePixels`).
 * - Turned upright by its EXIF orientation, and the middle of it cropped to a square: the upload's
 *   short side, scaled down to PROFILE_IMAGE_SIZE when it is longer, never enlarged — a 300×200
 *   upload is stored 200×200 (owner decisions 2026-10-22: the centre, no crop box; 512 is the most).
 *   How it gets there is bounded by memory (`profileSquare`).
 * - Encoded again in its own type, without EXIF or any other metadata, as `processImage` does.
 *
 * Through the same one-at-a-time queue (`imageConversions`); throws as `processImage` does.
 */
export async function processProfileImage(bytes: Uint8Array): Promise<ProcessedProfileImage> {
  const inspected = await inspectImage(
    bytes,
    PROFILE_IMAGE_CONTENT_TYPES,
    () => false,
    profileLargestFramePixels,
  );
  const output = await convert(() => profileSquare(bytes, inspected));
  return {
    body: new Uint8Array(output.data),
    contentType: inspected.contentType,
    width: output.info.width,
    height: output.info.height,
  };
}

/**
 * The square itself — the middle square of the upload, at its full resolution, scaled to `target`
 * (PROFILE_IMAGE_SIZE, or the short side when that is smaller: never enlarged) — in two ways chosen
 * for memory (ADR-0073 9-8; ADR-0079 7-16 and the table of its 결정 4). Scaling the
 * whole upload straight to the square ('cover') scales by the SHORT side: a long panorama then gets
 * no shrink-on-load and is decoded, turned and resized at full size — a 300KB JPEG of 60000×833
 * with a quarter turn peaked near 400 MiB, the API's whole container.
 *
 * - Scaled first, for a JPEG or a WebP whose short side stays longer than `target` once its long
 *   side fits inside IMAGE_MAX_DIMENSION — a photo less than four times wider than tall, or one
 *   whose long side is that small already: `processImage`'s own pass (turned upright, fitted
 *   inside IMAGE_MAX_DIMENSION, so the decoder shrinks by the LONG side as it reads — libjpeg's
 *   shrink-on-load, libwebp's scaled decoding) as raw pixels (at most 2048×2048×4 bytes), then the
 *   middle square of that scaled to `target`. The cheapest way: the same memory as a post's image
 *   of the same file.
 * - Cut first (`cutsSquareFirst`), for a PNG — no decoder shrinks it, so a first pass would gain
 *   nothing, and its long-side reduce is what makes a long PNG cost the most — and for a JPEG or a
 *   WebP longer than that, whose first pass would leave a short side under `target` (a square then
 *   enlarged, soft): the middle square is cut in the orientation the file is stored in — the same
 *   square once turned, since a turn or a mirror keeps the middle in the middle — read from the
 *   file at its full resolution (no shrink-on-load: the decoder reads the rows and keeps the
 *   square's columns), scaled to `target` and then turned upright (sharp turns after the resize
 *   when `extract` comes before `autoOrient`; the EXIF tests in image.test.ts would see a square
 *   turned the wrong way). A long JPEG is read row by row this way (~62 MiB for 50 megapixels at
 *   32:1, IMAGE_MAX_SIDE_RATIO). A long WebP is decoded whole — up to 16.8 bytes a pixel, more than the 15 its format is
 *   charged — so the header check charges it PROFILE_WEBP_CUT_BYTES_PER_PIXEL
 *   (`profileDecodeBytesPerPixel`), which keeps it within IMAGE_DECODE_BUDGET_BYTES (126 MiB at
 *   most at its bound). Both more than a post's image of the same file (ADR-0079 결정 4's table,
 *   profile-image-memory.test.ts).
 */
function profileSquare(
  bytes: Uint8Array,
  { contentType, input, width, height }: InspectedImage<ProfileImageContentType>,
): Promise<Converted> {
  const target = profileSquareSide(width, height);
  const toSquare = (pipeline: Sharp, size: number) => {
    pipeline.resize({ width: size, height: size, fit: 'cover', position: 'centre' });
    encodeAs(pipeline, contentType);
    return pipeline.toBuffer({ resolveWithObject: true });
  };
  if (cutsSquareFirst(contentType, width, height)) {
    const side = Math.min(width, height);
    return toSquare(
      sharp(bytes, input)
        .extract({
          left: Math.floor((width - side) / 2),
          top: Math.floor((height - side) / 2),
          width: side,
          height: side,
        })
        .autoOrient(),
      target,
    );
  }
  return sharp(bytes, input)
    .autoOrient()
    .resize({
      width: IMAGE_MAX_DIMENSION,
      height: IMAGE_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) =>
      toSquare(
        sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }),
        // Never more than the first pass left: nothing is enlarged.
        Math.min(target, info.width, info.height),
      ),
    );
}

/** The side of a profile image's square: the upload's short side, PROFILE_IMAGE_SIZE at most. */
function profileSquareSide(width: number, height: number): number {
  return Math.min(PROFILE_IMAGE_SIZE, width, height);
}

/**
 * Whether `profileSquare` cuts the square from the file at its full resolution — a PNG always, and
 * a JPEG or a WebP whose short side would be no longer than the square once its long side is fitted
 * inside IMAGE_MAX_DIMENSION — rather than taking `processImage`'s long-side pass first. The header
 * check asks it too (`profileDecodeBytesPerPixel`), so the two cannot disagree.
 */
function cutsSquareFirst(
  contentType: ProfileImageContentType,
  width: number,
  height: number,
): boolean {
  if (contentType === 'image/png') return true;
  const long = Math.max(width, height);
  // Scaled first only when the short side stays strictly longer than the square, so the first
  // pass's rounded short side is at least the square too.
  return (
    long > IMAGE_MAX_DIMENSION &&
    Math.min(width, height) * IMAGE_MAX_DIMENSION <= profileSquareSide(width, height) * long
  );
}
