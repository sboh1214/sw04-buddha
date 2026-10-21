// JPEG files changed byte by byte for the image suites (#46): a frame header (SOF) that says a
// size its scans do not hold — the header checks read only the header, as with `pngHeaderOnly` —
// and components no scan names, which sharp would not write.

/** Where a JPEG's frame header starts (its SOF0, SOF1 or SOF2 marker), walking the segments. */
function frameHeaderAt(bytes: Uint8Array): number {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2; // past SOI
  while (at + 4 <= view.length) {
    if (view[at] !== 0xff) throw new Error(`no JPEG marker at ${String(at)}`);
    const marker = view[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xc2) return at;
    if (marker === 0xda) break; // the first scan: the frame header comes before it
    at += 2 + view.readUInt16BE(at + 2);
  }
  throw new Error('no frame header');
}

/** `bytes` with its frame header saying `width`×`height`; the scans still hold the small image. */
export function jpegWithFrame(bytes: Uint8Array, width: number, height: number): Buffer {
  const out = Buffer.from(bytes);
  const at = frameHeaderAt(out);
  // FF Cn, length (2), sample precision (1), height (2), width (2), components (1) …
  out.writeUInt16BE(height, at + 5);
  out.writeUInt16BE(width, at + 7);
  return out;
}

/**
 * `bytes` with `extra` more components in its frame header, each sampled 1×1 with quantisation
 * table 0 and named by no scan — a progressive JPEG decodes them as mid-grey, so libjpeg (which
 * reads up to ten) and libvips hand on a JPEG of that many bands.
 */
export function jpegWithComponents(bytes: Uint8Array, extra: number): Buffer {
  const source = Buffer.from(bytes);
  const at = frameHeaderAt(source);
  const length = source.readUInt16BE(at + 2);
  const count = source[at + 9]!;
  const ids = new Set(Array.from({ length: count }, (_, index) => source[at + 10 + 3 * index]));
  const added: number[] = [];
  for (let id = 100; added.length < 3 * extra; id += 1) {
    if (!ids.has(id)) added.push(id, 0x11, 0);
  }
  const header = Buffer.from(source.subarray(at, at + 2 + length));
  header.writeUInt16BE(length + added.length, 2);
  header[9] = count + extra;
  return Buffer.concat([
    source.subarray(0, at),
    header,
    Buffer.from(added),
    source.subarray(at + 2 + length),
  ]);
}
