import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_DIMENSION,
  IMAGE_MAX_INPUT_PIXELS,
  type ImageContentType,
  type ImageNotAllowedDetails,
  type ImageRefusal,
} from '@buddha/shared';
import sharp, { type Metadata, type OutputInfo } from 'sharp';
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
const SHARP_FORMAT: Readonly<Record<ImageContentType, string>> = {
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
 * peak for one frame. One conversion runs at a time (`imageConversions`), so this plus the API's
 * own use stays under its container's 448 MiB (deploy/compose.yaml) with room left.
 *
 * A known exception, open with the owner (ADR-0073 결과 4 (1)): a thin PNG with alpha or 16-bit
 * colour — 8-bit RGBA and 16-bit grey + alpha, RGB or RGBA, interlaced or not, and 8-bit grey +
 * alpha that embeds an ICC profile (an interlaced 8-bit RGB sits at the edge) — passes every check
 * here and still takes more: up to ~275MiB by libvips' count, ~360MiB at the process's peak
 * (16-bit RGBA at 32:1 with a profile; IMAGE_MAX_SIDE_RATIO).
 */
export const IMAGE_DECODE_BUDGET_BYTES = 128 * 1024 * 1024;

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
 * Not every PNG fits at this ratio: a thin one with alpha or 16-bit colour can take up to ~275MiB
 * — the known exception in IMAGE_DECODE_BUDGET_BYTES, open with the owner (ADR-0073 결과 4 (1)).
 */
export const IMAGE_MAX_SIDE_RATIO = 32;

/**
 * What a conversion holds per pixel of one frame, at its peak, in bytes — measured on the pipeline
 * below (sharp 0.35.5, cache off, one thread, a quarter turn by EXIF where it costs more), at and
 * around the bound, near square, rounded up (ADR-0073 9-8; a thinner PNG, or one that embeds an
 * ICC profile, can take more — IMAGE_DECODE_BUDGET_BYTES):
 *
 * - a baseline JPEG is shrunk while it is decoded (libjpeg's shrink-on-load), so even 48
 *   megapixels peak near 45MB: 1 byte;
 * - a progressive JPEG keeps every coefficient until the last scan: up to 10 (4:4:4);
 * - a PNG is decoded a band of rows at a time, 0.6 per sample (a 16-bit sample is two) — but an
 *   interlaced one (Adam7) is decoded whole: 1.6 per sample;
 * - a GIF frame is unpacked whole with the frame before it: 16; a WebP frame (read as an
 *   animation, a still one too): 15. The frames of an animation are decoded one after another,
 *   so the frame counts here and all of them only against IMAGE_MAX_INPUT_PIXELS.
 */
export function decodeBytesPerPixel(
  contentType: ImageContentType,
  metadata: Pick<Metadata, 'channels' | 'depth' | 'isProgressive'>,
): number {
  switch (contentType) {
    case 'image/jpeg':
      return metadata.isProgressive ? 10 : 1;
    case 'image/png': {
      const samples = (metadata.channels ?? 4) * (metadata.depth === 'ushort' ? 2 : 1);
      // In tenths, so 4 samples are 2.4 and not 2.4000000000000004.
      return (samples * (metadata.isProgressive ? 16 : 6)) / 10;
    }
    case 'image/gif':
      return 16;
    case 'image/webp':
      return 15;
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
 * uploads' bytes held while they wait.
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
 * 2. One of the four types by its magic number (`sniffImageType`), and the decoder agrees.
 * 3. Small enough to decode, read from the header before anything is decoded (a decompression
 *    bomb is a few bytes): one frame no thinner than IMAGE_MAX_SIDE_RATIO allows and within
 *    IMAGE_DECODE_BUDGET_BYTES by its format (`decodeBytesPerPixel`), else `pixels`; every frame
 *    together within IMAGE_MAX_INPUT_PIXELS, else `frames` for an animation and `pixels` for a
 *    still — sharp's own limit is a second fence.
 * 4. Turned upright by its EXIF orientation, then shrunk to fit IMAGE_MAX_DIMENSION on its long side
 *    (never enlarged); an animated GIF or WebP keeps every frame and its timing.
 * 5. Encoded again in its own type. sharp writes no metadata unless asked, so EXIF (the place and
 *    the device a photo was taken with), XMP, IPTC and the ICC profile are gone — the pixels are
 *    turned into sRGB first, so the colours stay.
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
  const width = metadata.width;
  // `height` is every frame stacked; `pageHeight` one frame's (none for a still image).
  const totalHeight = metadata.height;
  if (!width || !totalHeight) throw imageRefused('unreadable');
  const frameHeight = metadata.pageHeight ?? totalHeight;
  if (
    Math.max(width, frameHeight) > IMAGE_MAX_SIDE_RATIO * Math.min(width, frameHeight) ||
    width * frameHeight * decodeBytesPerPixel(contentType, metadata) > IMAGE_DECODE_BUDGET_BYTES
  ) {
    throw imageRefused('pixels');
  }
  if (width * totalHeight > IMAGE_MAX_INPUT_PIXELS) {
    throw imageRefused(frameHeight < totalHeight ? 'frames' : 'pixels');
  }

  const pipeline = sharp(bytes, input).autoOrient().resize({
    width: IMAGE_MAX_DIMENSION,
    height: IMAGE_MAX_DIMENSION,
    fit: 'inside',
    withoutEnlargement: true,
  });
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
