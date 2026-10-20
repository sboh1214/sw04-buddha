// PNG files built byte by byte for the image suites (#46): zlib only, no libvips — so a suite
// that reads libvips' memory high-water mark (`image-memory.test.ts`) starts from nothing — and
// files sharp would not write: a header over no image (a decompression bomb).

import { crc32, deflateSync } from 'node:zlib';

/** One PNG chunk: length, type, data and the CRC over type and data. */
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The colour type of a PNG with this many channels: grey, grey + alpha, RGB, RGBA. */
const COLOUR_TYPE = { 1: 0, 2: 4, 3: 2, 4: 6 } as const;

type Channels = keyof typeof COLOUR_TYPE;

function header(width: number, height: number, channels: Channels, depth: 8 | 16): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(depth, 8);
  ihdr.writeUInt8(COLOUR_TYPE[channels], 9);
  return chunk('IHDR', ihdr); // compression, filter and interlace: 0
}

/** An `eXIf` chunk holding only the EXIF orientation tag (big-endian TIFF, one IFD entry). */
function exifOrientation(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'ascii');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // the first IFD
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14); // one value
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22); // no next IFD
  return chunk('eXIf', tiff);
}

/** A number as an ICC s15Fixed16Number. */
function s15Fixed16(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(Math.round(value * 65_536));
  return bytes;
}

/** An ICC `XYZ ` element: one colour in the profile connection space. */
function xyzElement(x: number, y: number, z: number): Buffer {
  const head = Buffer.alloc(8);
  head.write('XYZ ', 0, 'ascii');
  return Buffer.concat([head, s15Fixed16(x), s15Fixed16(y), s15Fixed16(z)]);
}

/** An ICC `curv` element of one gamma (a u8Fixed8Number), padded to four bytes. */
function gammaElement(gamma: number): Buffer {
  const curve = Buffer.alloc(16);
  curve.write('curv', 0, 'ascii');
  curve.writeUInt32BE(1, 8); // one entry: a gamma
  curve.writeUInt16BE(Math.round(gamma * 256), 12);
  return curve;
}

/**
 * A minimal ICC v2 display profile for a grey PNG (one 2.2 gamma curve) or an RGB one (sRGB's
 * primaries adapted to D50 and a 2.2 gamma) — enough for sharp, which turns the pixels of an image
 * with an embedded profile into sRGB before it resizes (a 16-bit grey one aside), and holds more
 * memory doing it.
 */
function iccProfile(grey: boolean): Buffer {
  const white = xyzElement(0.9642, 1, 0.8249); // D50
  const curve = gammaElement(2.2);
  const tags: readonly (readonly [string, Buffer])[] = grey
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
  // The 128-byte header, the tag table (a count and 12 bytes a tag), then each element once: the
  // tags that name the same element (the three curves of RGB) point at one copy of it.
  const table = Buffer.alloc(4 + 12 * tags.length);
  table.writeUInt32BE(tags.length, 0);
  const elements: Buffer[] = [];
  const offsets = new Map<Buffer, number>();
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
  head.writeUInt32BE(0x02_10_00_00, 8); // version 2.1
  head.write('mntr', 12, 'ascii'); // a display
  head.write(grey ? 'GRAY' : 'RGB ', 16, 'ascii');
  head.write('XYZ ', 20, 'ascii'); // the connection space
  head.write('acsp', 36, 'ascii');
  white.copy(head, 68, 8); // the connection space's illuminant: D50
  return Buffer.concat([head, table, ...elements]);
}

/** An `iCCP` chunk: a profile name, compression method 0 and the profile deflated. */
function embeddedProfile(grey: boolean): Buffer {
  return chunk(
    'iCCP',
    Buffer.concat([Buffer.from('icc\0\0', 'latin1'), deflateSync(iccProfile(grey))]),
  );
}

/**
 * A real PNG of `width`×`height` with `channels` channels of `depth` bits, every sample 0 — so it
 * deflates to almost nothing (5,000,000×10 grey is 49KB) and decodes to its full size — tagged
 * with an EXIF `orientation` when given, and with an embedded ICC profile (grey or RGB, as its
 * channels are) when `profile` is set.
 */
export function pngOf(
  width: number,
  height: number,
  {
    channels = 3,
    depth = 8,
    orientation,
    profile = false,
  }: { channels?: Channels; depth?: 8 | 16; orientation?: number; profile?: boolean } = {},
): Buffer {
  // Each row is its filter byte (0, none) and its samples.
  const rows = Buffer.alloc((1 + (width * channels * depth) / 8) * height);
  return Buffer.concat([
    SIGNATURE,
    header(width, height, channels, depth),
    ...(profile ? [embeddedProfile(channels <= 2)] : []),
    ...(orientation === undefined ? [] : [exifOrientation(orientation)]),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * An RGB PNG whose header claims `width`×`height` over a few bytes of pixel data: a bomb, which
 * must be refused from its header (the decoder would fail on the data only after allocating the
 * image).
 */
export function pngHeaderOnly(width: number, height: number): Buffer {
  return Buffer.concat([
    SIGNATURE,
    header(width, height, 3, 8),
    chunk('IDAT', deflateSync(Buffer.alloc(64))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
