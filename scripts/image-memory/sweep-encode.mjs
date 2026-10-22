// The whole conversion at every kind's bounds (README.md, ADR-0073 9-8, IMAGE_CONVERSION_PEAK_BYTES):
// for each case, makes the file that costs most there (`make-image.mjs` — noise, or a different
// picture in every frame) and converts it with the API's build (`measure.mjs --file --via api`),
// each in a process of its own, then prints how much each conversion raised the process's memory
// (`peakMiB`) against the budget. The sizes come from the build's bounds, so a case the API
// refuses means a bound moved and the case list wants looking at.
//
//   node scripts/image-memory/sweep-encode.mjs [--only webp] [--jobs 3] [--keep dir] [--out f]
//   node scripts/image-memory/sweep-encode.mjs --profile-image ...
//
// --profile-image: a profile image's cases instead (#141, ADR-0079), converted by the build's
// processProfileImage (`measure.mjs --via profile`) — JPEG, PNG and WebP at the bounds of its own
// header check (`profileLargestFramePixels`), the first frame of an animated WebP, and each way to
// the square (`profileSquare`: scaled first, or cut from the file first — a PNG always, a JPEG or a
// WebP four times longer than wide and more).
//
// Run it on Linux in the API's image to measure what production runs (README.md); macOS's
// allocator keeps more and its numbers run higher. --only takes a prefix of the case names.
// stdout: one line a case and a summary line; --out also keeps them.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { emit, int, loadApi, loadShared, makeImageInChild, measureInChild, pool } from './lib.mjs';

const { values } = parseArgs({
  options: {
    only: { type: 'string' },
    jobs: { type: 'string' },
    keep: { type: 'string' },
    out: { type: 'string' },
    'profile-image': { type: 'boolean', default: false },
  },
});
const profileImage = values['profile-image'];

const api = await loadApi();
const { IMAGE_MAX_INPUT_PIXELS } = await loadShared();
const MiB = 1024 * 1024;
const budgetMiB = api.IMAGE_CONVERSION_PEAK_BYTES / MiB;
const jobs = int(values.jobs, 'jobs', 3);

const side = (pixels) => Math.floor(Math.sqrt(pixels));
/** The widest frame of at most `pixels` at `ratio`:1 — [width, height]. */
const thin = (pixels, ratio) => {
  const height = Math.floor(Math.sqrt(pixels / ratio));
  return [ratio * height, height];
};

const still = { channels: 3, depth: 'uchar', isProgressive: false, hasAlpha: false };
const progressive = side(api.largestFramePixels('image/jpeg', { ...still, isProgressive: true }));
const cmyk = side(
  api.largestFramePixels('image/jpeg', { ...still, channels: 4, isProgressive: true }),
);
const gifStill = side(api.largestFramePixels('image/gif', still));
const webpOpaque = side(api.largestFramePixels('image/webp', still));
// A still WebP with alpha is read up to its decoding bound (the same as without alpha) and written
// at most WEBP_ALPHA_MAX_OUTPUT_PIXELS large (`outputBox`).
const webpAlpha = api.WEBP_ALPHA_MAX_OUTPUT_PIXELS;
const webpAlphaRead = side(api.largestFramePixels('image/webp', { ...still, channels: 4 }));
const animFrame = api.WEBP_ANIMATION_LARGEST_FRAME_PIXELS;
const animFrames = Math.floor(api.WEBP_ANIMATION_MAX_PIXELS / side(animFrame) ** 2);
const gifFrame = api.GIF_ANIMATION_LARGEST_FRAME_PIXELS;
const [gif32w, gif32h] = thin(gifFrame, api.IMAGE_MAX_SIDE_RATIO);
const [gif16w, gif16h] = thin(gifFrame, 16);
const gifFrames = (w, h) => Math.floor(IMAGE_MAX_INPUT_PIXELS / (w * h));
const [anim32w, anim32h] = thin(animFrame, api.IMAGE_MAX_SIDE_RATIO);
const baseline = side(IMAGE_MAX_INPUT_PIXELS);

/** [name, make-image.mjs flags] — or [name, null, measure.mjs flags] for a PNG built by hand. */
const make = (format, width, height, rest = []) => [
  '--format',
  format,
  '--width',
  String(width),
  '--height',
  String(height),
  ...rest,
];
const encoder = (options) => ['--encoder', JSON.stringify(options)];
const CASES = [
  // JPEG: a progressive 4:4:4 one keeps every coefficient; a baseline one is shrunk as it decodes.
  [
    'jpeg-progressive-444',
    make(
      'jpeg',
      progressive,
      progressive,
      encoder({ quality: 12, progressive: true, chromaSubsampling: '4:4:4' }),
    ),
  ],
  [
    'jpeg-progressive-444-o6-p3',
    make('jpeg', progressive, progressive, [
      ...encoder({ quality: 12, progressive: true, chromaSubsampling: '4:4:4' }),
      '--orientation',
      '6',
      '--icc',
      'p3',
    ]),
  ],
  [
    'jpeg-baseline-o6',
    make('jpeg', baseline, baseline, [...encoder({ quality: 5 }), '--orientation', '6']),
  ],
  // A CMYK one: four components keep a third more coefficients (and turn into sRGB).
  [
    'jpeg-progressive-cmyk',
    make('jpeg', cmyk, cmyk, [
      '--colourspace',
      'cmyk',
      ...encoder({ quality: 1, progressive: true }),
    ]),
  ],
  [
    'jpeg-progressive-cmyk-o6-icc',
    make('jpeg', cmyk, cmyk, [
      '--colourspace',
      'cmyk',
      ...encoder({ quality: 1, progressive: true }),
      '--orientation',
      '6',
      '--icc',
      'cmyk',
    ]),
  ],
  [
    'jpeg-baseline-cmyk-o6-icc',
    make('jpeg', baseline, baseline, [
      '--content',
      'flat',
      '--colourspace',
      'cmyk',
      ...encoder({ quality: 50 }),
      '--orientation',
      '6',
      '--icc',
      'cmyk',
    ]),
  ],
  // PNG: the costliest frames of the owner's bounds (image-memory.test.ts), with a profile.
  ['png-rgba8', null, ['--channels', '4', '--width', '24576', '--height', '801', '--profile']],
  [
    'png-rgba16',
    null,
    ['--channels', '4', '--depth', '16', '--width', '8192', '--height', '402', '--profile'],
  ],
  ['png-ga8', null, ['--channels', '2', '--width', '32712', '--height', '1131', '--profile']],
  // GIF: a still at its bound, noise of 16 colours or 4 with transparency; animations at theirs.
  ['gif-still', make('gif', gifStill, gifStill, encoder({ colours: 16, dither: 0 }))],
  [
    'gif-still-alpha',
    make('gif', gifStill, gifStill, [
      '--channels',
      '4',
      '--alpha-levels',
      '2',
      ...encoder({ colours: 4, dither: 0 }),
    ]),
  ],
  [
    'gif-animation-32to1',
    make('gif', gif32w, gif32h, [
      '--content',
      'frames',
      '--frames',
      String(gifFrames(gif32w, gif32h)),
    ]),
  ],
  [
    'gif-animation-16to1',
    make('gif', gif16w, gif16h, [
      '--content',
      'frames',
      '--frames',
      String(gifFrames(gif16w, gif16h)),
    ]),
  ],
  [
    'gif-animation-square',
    make('gif', side(gifFrame), side(gifFrame), [
      '--content',
      'frames',
      '--frames',
      String(gifFrames(side(gifFrame), side(gifFrame))),
    ]),
  ],
  [
    'gif-animation-noise',
    make('gif', side(gifFrame), side(gifFrame), [
      '--frames',
      '2',
      '--channels',
      '4',
      '--alpha-levels',
      '2',
      ...encoder({ colours: 4, dither: 0 }),
    ]),
  ],
  // WebP: without alpha at its decoding bound; with alpha as large as it is written (square, and as
  // wide as 2,048px lets it be), read a little larger and written smaller, and read at its
  // decoding bound and written smaller (its alpha quantised so the file fits 5MB); animations at
  // their bounds.
  ['webp-opaque', make('webp', webpOpaque, webpOpaque, encoder({ quality: 60 }))],
  [
    'webp-opaque-o6-p3',
    make('webp', webpOpaque, webpOpaque, [
      ...encoder({ quality: 60 }),
      '--orientation',
      '6',
      '--icc',
      'p3',
    ]),
  ],
  [
    'webp-alpha',
    make('webp', side(webpAlpha), side(webpAlpha), ['--channels', '4', ...encoder({ quality: 1 })]),
  ],
  [
    'webp-alpha-o6-p3',
    make('webp', side(webpAlpha), side(webpAlpha), [
      '--channels',
      '4',
      ...encoder({ quality: 1 }),
      '--orientation',
      '6',
      '--icc',
      'p3',
    ]),
  ],
  [
    'webp-alpha-wide',
    make('webp', 2048, Math.floor(webpAlpha / 2048), [
      '--channels',
      '4',
      ...encoder({ quality: 1 }),
    ]),
  ],
  [
    'webp-alpha-read-bound',
    make('webp', webpAlphaRead, webpAlphaRead, [
      '--channels',
      '4',
      ...encoder({ quality: 1, alphaQuality: 20 }),
    ]),
  ],
  [
    'webp-alpha-read-bound-o6-p3',
    make('webp', webpAlphaRead, webpAlphaRead, [
      '--channels',
      '4',
      ...encoder({ quality: 1, alphaQuality: 20 }),
      '--orientation',
      '6',
      '--icc',
      'p3',
    ]),
  ],
  ['webp-alpha-shrunk', make('webp', 2000, 2000, ['--channels', '4', ...encoder({ quality: 1 })])],
  [
    'webp-alpha-shrunk-wide',
    make('webp', 2236, 1385, ['--channels', '4', ...encoder({ quality: 1, alphaQuality: 20 })]),
  ],
  [
    'webp-animation-noise',
    make('webp', side(animFrame), side(animFrame), [
      '--channels',
      '4',
      '--alpha-levels',
      '2',
      '--frames',
      String(animFrames),
      ...encoder({ quality: 1 }),
    ]),
  ],
  [
    'webp-animation-frames',
    make('webp', side(animFrame), side(animFrame), [
      '--channels',
      '4',
      '--content',
      'frames',
      '--frames',
      String(animFrames),
    ]),
  ],
  [
    'webp-animation-opaque',
    make('webp', side(animFrame), side(animFrame), [
      '--frames',
      String(animFrames),
      ...encoder({ quality: 10 }),
    ]),
  ],
  [
    'webp-animation-32to1',
    make('webp', anim32w, anim32h, [
      '--channels',
      '4',
      '--content',
      'frames',
      '--frames',
      String(Math.floor(api.WEBP_ANIMATION_MAX_PIXELS / (anim32w * anim32h))),
    ]),
  ],
];

// A profile image's (#141): its header check's bounds — a PNG's kind and a JPEG's as a post's
// image's, a WebP cut from the file at PROFILE_WEBP_CUT_BYTES_PER_PIXEL — at the shapes its square
// costs most: square (scaled first), just at 4:1 and at 32:1 (cut first). The PNGs are the
// costliest shapes `sweep-png.mjs --profile-image` found for the kinds that cost the most there.
const profileBound = (type, header, width, height) =>
  api.profileLargestFramePixels(type, { ...still, pages: 1, ...header }, width, height);
/** The widest frame at `ratio`:1 within the profile bound of that shape — [width, height]. */
const profileThin = (type, header, ratio) => {
  let [width, height] = thin(profileBound(type, header, 4_096, 1_024), ratio);
  while (width * height > profileBound(type, header, width, height)) {
    height -= 1;
    width = ratio * height;
  }
  return [width, height];
};
const progressiveHeader = { isProgressive: true };
const cmykHeader = { channels: 4, isProgressive: true };
const [pj4w, pj4h] = profileThin('image/jpeg', progressiveHeader, 4);
const [pj32w, pj32h] = profileThin('image/jpeg', progressiveHeader, 32);
const [cj4w, cj4h] = profileThin('image/jpeg', cmykHeader, 4);
const [cj32w, cj32h] = profileThin('image/jpeg', cmykHeader, 32);
const [bj32w, bj32h] = thin(IMAGE_MAX_INPUT_PIXELS, api.IMAGE_MAX_SIDE_RATIO);
const alphaHeader = { channels: 4, hasAlpha: true };
const [wa4w, wa4h] = profileThin('image/webp', alphaHeader, 4);
const [wa30w, wa30h] = profileThin('image/webp', alphaHeader, 30);
const [wo4w, wo4h] = profileThin('image/webp', {}, 4);
const PROFILE_CASES = [
  [
    'jpeg-progressive-444',
    make(
      'jpeg',
      progressive,
      progressive,
      encoder({ quality: 12, progressive: true, chromaSubsampling: '4:4:4' }),
    ),
  ],
  [
    'jpeg-progressive-444-4to1-o6',
    make('jpeg', pj4w, pj4h, [
      ...encoder({ quality: 12, progressive: true, chromaSubsampling: '4:4:4' }),
      '--orientation',
      '6',
    ]),
  ],
  [
    'jpeg-progressive-444-32to1',
    make(
      'jpeg',
      pj32w,
      pj32h,
      encoder({ quality: 12, progressive: true, chromaSubsampling: '4:4:4' }),
    ),
  ],
  [
    'jpeg-progressive-cmyk',
    make('jpeg', cmyk, cmyk, [
      '--colourspace',
      'cmyk',
      ...encoder({ quality: 1, progressive: true }),
    ]),
  ],
  [
    'jpeg-progressive-cmyk-4to1-o6-icc',
    make('jpeg', cj4w, cj4h, [
      '--colourspace',
      'cmyk',
      ...encoder({ quality: 1, progressive: true }),
      '--orientation',
      '6',
      '--icc',
      'cmyk',
    ]),
  ],
  [
    'jpeg-progressive-cmyk-32to1',
    make('jpeg', cj32w, cj32h, [
      '--colourspace',
      'cmyk',
      ...encoder({ quality: 1, progressive: true }),
    ]),
  ],
  [
    'jpeg-baseline-o6',
    make('jpeg', baseline, baseline, [...encoder({ quality: 5 }), '--orientation', '6']),
  ],
  [
    'jpeg-baseline-32to1-o6',
    make('jpeg', bj32w, bj32h, [
      '--content',
      'flat',
      ...encoder({ quality: 50 }),
      '--orientation',
      '6',
    ]),
  ],
  // PNG: each the costliest shape `sweep-png.mjs --profile-image` found for its kind (macOS arm64,
  // libvips' mark) among the kinds that cost the most — the interlaced ones, decoded whole — and
  // the costliest plain one.
  [
    'png-grey16-interlaced',
    null,
    [
      '--channels',
      '1',
      '--depth',
      '16',
      '--interlaced',
      '--width',
      '6477',
      '--height',
      '6475',
      '--profile',
    ],
  ],
  [
    'png-rgb8-interlaced',
    null,
    ['--channels', '3', '--interlaced', '--width', '5189', '--height', '5087', '--profile'],
  ],
  [
    'png-ga16-interlaced',
    null,
    [
      '--channels',
      '2',
      '--depth',
      '16',
      '--interlaced',
      '--width',
      '4260',
      '--height',
      '4061',
      '--profile',
    ],
  ],
  [
    'png-rgba8-interlaced',
    null,
    ['--channels', '4', '--interlaced', '--width', '3963', '--height', '3961', '--profile'],
  ],
  [
    'png-rgb16',
    null,
    ['--channels', '3', '--depth', '16', '--width', '20270', '--height', '646', '--profile'],
  ],
  [
    'png-rgb8-32to1',
    null,
    ['--channels', '3', '--width', '39572', '--height', '1263', '--profile'],
  ],
  [
    'webp-alpha-read-bound',
    make('webp', webpAlphaRead, webpAlphaRead, [
      '--channels',
      '4',
      ...encoder({ quality: 1, alphaQuality: 20 }),
    ]),
  ],
  [
    'webp-alpha-read-bound-o6-p3',
    make('webp', webpAlphaRead, webpAlphaRead, [
      '--channels',
      '4',
      ...encoder({ quality: 1, alphaQuality: 20 }),
      '--orientation',
      '6',
      '--icc',
      'p3',
    ]),
  ],
  [
    'webp-alpha-cut-4to1',
    make('webp', wa4w, wa4h, ['--channels', '4', ...encoder({ quality: 1, alphaQuality: 20 })]),
  ],
  [
    'webp-alpha-cut-4to1-o6-p3',
    make('webp', wa4w, wa4h, [
      '--channels',
      '4',
      ...encoder({ quality: 1, alphaQuality: 20 }),
      '--orientation',
      '6',
      '--icc',
      'p3',
    ]),
  ],
  [
    'webp-alpha-cut-30to1',
    make('webp', wa30w, wa30h, ['--channels', '4', ...encoder({ quality: 1, alphaQuality: 20 })]),
  ],
  ['webp-opaque-cut-4to1', make('webp', wo4w, wo4h, encoder({ quality: 30 }))],
  [
    'webp-animation-first-frame',
    make('webp', webpAlphaRead, webpAlphaRead, [
      '--channels',
      '4',
      '--alpha-levels',
      '2',
      '--frames',
      '2',
      ...encoder({ quality: 1 }),
    ]),
  ],
];

const SELECTED = (profileImage ? PROFILE_CASES : CASES).filter(
  ([name]) => values.only === undefined || name.startsWith(values.only),
);

const dir = values.keep ?? mkdtempSync(path.join(tmpdir(), 'image-memory-'));
mkdirSync(dir, { recursive: true });
try {
  const via = profileImage ? 'profile' : 'api';
  const results = await pool(SELECTED, jobs, async ([name, makeFlags, pngFlags]) => {
    let measured;
    let made;
    if (makeFlags === null) {
      measured = await measureInChild([...pngFlags, '--via', via]);
    } else {
      const file = path.join(dir, `${name}.${makeFlags[1] === 'jpeg' ? 'jpg' : makeFlags[1]}`);
      made = await makeImageInChild([...makeFlags, '--out', file]);
      if (made.error) return { case: name, error: `make-image: ${made.error}` };
      measured = await measureInChild(['--file', file, '--via', via]);
      if (values.keep === undefined) rmSync(file, { force: true });
    }
    if (measured.error) return { case: name, error: measured.error };
    const record = {
      case: name,
      ...(made ? { fileBytes: made.bytes, frames: made.frames } : {}),
      header: measured.header,
      ...(measured.refused === undefined ? { out: measured.out } : { refused: measured.refused }),
      highMiB: measured.highMiB,
      peakMiB: measured.peakMiB,
      ...(measured.anonPeakMiB === undefined
        ? {}
        : { anonPeakMiB: measured.anonPeakMiB, filePeakMiB: measured.filePeakMiB }),
      ms: measured.ms,
    };
    emit(record, values.out);
    return { ...record, sharp: measured.sharp, vips: measured.vips, platform: measured.platform };
  });
  const measured = results.filter((r) => r.error === undefined && r.refused === undefined);
  const costliest = [...measured].sort((a, b) => b.peakMiB - a.peakMiB);
  emit(
    {
      type: 'summary',
      ...(profileImage ? { pipeline: 'profile image' } : {}),
      budgetMiB,
      cases: results.length,
      errors: results.filter((r) => r.error !== undefined).map((r) => `${r.case}: ${r.error}`),
      refused: results.filter((r) => r.refused !== undefined).map((r) => `${r.case}: ${r.refused}`),
      over: costliest.filter((r) => r.peakMiB > budgetMiB).map((r) => r.case),
      maxPeakMiB: costliest[0]?.peakMiB ?? null,
      top: costliest.slice(0, 5).map((r) => `${r.peakMiB}MiB ${r.case}`),
      sharp: measured[0]?.sharp,
      vips: measured[0]?.vips,
      platform: measured[0]?.platform,
    },
    values.out,
  );
} finally {
  if (values.keep === undefined) rmSync(dir, { recursive: true, force: true });
}
