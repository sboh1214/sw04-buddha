// The whole conversion at every kind's bounds (README.md, ADR-0073 9-8, IMAGE_CONVERSION_PEAK_BYTES):
// for each case, makes the file that costs most there (`make-image.mjs` — noise, or a different
// picture in every frame) and converts it with the API's build (`measure.mjs --file --via api`),
// each in a process of its own, then prints how much each conversion raised the process's memory
// (`peakMiB`) against the budget. The sizes come from the build's bounds, so a case the API
// refuses means a bound moved and the case list wants looking at.
//
//   node scripts/image-memory/sweep-encode.mjs [--only webp] [--jobs 3] [--keep dir] [--out f]
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
  },
});

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
const webpAlpha = api.WEBP_ALPHA_LARGEST_FRAME_PIXELS;
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
  // WebP: without alpha at its decoding bound; with alpha at its own; animations at theirs.
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
].filter(([name]) => values.only === undefined || name.startsWith(values.only));

const dir = values.keep ?? mkdtempSync(path.join(tmpdir(), 'image-memory-'));
mkdirSync(dir, { recursive: true });
try {
  const results = await pool(CASES, jobs, async ([name, makeFlags, pngFlags]) => {
    let measured;
    let made;
    if (makeFlags === null) {
      measured = await measureInChild([...pngFlags, '--via', 'api']);
    } else {
      const file = path.join(dir, `${name}.${makeFlags[1] === 'jpeg' ? 'jpg' : makeFlags[1]}`);
      made = await makeImageInChild([...makeFlags, '--out', file]);
      if (made.error) return { case: name, error: `make-image: ${made.error}` };
      measured = await measureInChild(['--file', file, '--via', 'api']);
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
