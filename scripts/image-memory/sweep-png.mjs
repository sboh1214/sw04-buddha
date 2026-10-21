// A PNG kind's largest frame (PNG_LARGEST_FRAME_PIXELS, README.md, ADR-0073 9-8): converts every
// shape of at most `--pixels` the bound was measured at, each in a process of its own, and prints
// the costliest by libvips' high-water mark; with --search, finds the largest frame again.
//
//   node scripts/image-memory/sweep-png.mjs --channels 4 [--depth 16] [--interlaced]
//     [--palette 8 --transparent] [--no-profile | --icc file.icc] [--pixels 19700000] [--coarse]
//     [--jobs 4] [--via sharp|api] [--out cases.jsonl]
//   node scripts/image-memory/sweep-png.mjs --channels 4 --search [--from P] [--to P]
//     [--target 124] [--limit 126] ...
//
// The shapes (wide — width ≥ height — and at most IMAGE_MAX_SIDE_RATIO to 1, with the hand-made
// ICC profile unless --no-profile):
//   a. every width from 1:1 to the ratio, 50 px apart (100 with --coarse), at the tallest height
//      the pixels allow;
//   b. (not --coarse) around each width where libvips' integral vertical shrink steps up — the
//      frame fitted IMAGE_MAX_DIMENSION wide, a vertical factor of 4, 6, 8 … — and at the ratio's
//      end: widths 4 px apart, at the tallest height and at the two heights (within two shrink
//      factors of it) whose factor is closest under the step, where a conversion holds the most;
//   c. (not --coarse) a quarter turn by EXIF (orientation 6) from 1:1 to 4:1, 50 px apart.
// --pixels defaults to the kind's bound in the API's build (PNG_LARGEST_FRAME_PIXELS).
//
// --search: the value as ADR-0073 9-8 found it. First the largest multiple of 100,000 between
// --from (default: the kind's bound) and --to (default: IMAGE_MAX_INPUT_PIXELS) whose coarse sweep
// stays at or under --target MiB, by halving (--to itself when it does); then the full sweep at
// that value and, while its costliest frame is over --limit MiB — room under the 128MiB budget for
// the shapes between those measured — lower values (by at least 100,000, about 3% for each MiB
// over), then halving back up to the largest multiple of 100,000 within the limit.
//
// stdout: one summary line a sweep (and a `result` line for --search); --out also keeps every case.

import { parseArgs } from 'node:util';
import {
  KIND_OPTIONS,
  decodedKind,
  emit,
  int,
  keep,
  kindFlags,
  kindName,
  kindOf,
  loadApi,
  loadShared,
  measureInChild,
  pool,
} from './lib.mjs';

const kindOptions = { ...KIND_OPTIONS };
delete kindOptions.orientation; // the sweep turns the frame itself (shapes c)
const { values } = parseArgs({
  allowNegative: true,
  options: {
    ...kindOptions,
    profile: { type: 'boolean', default: true },
    pixels: { type: 'string' },
    coarse: { type: 'boolean', default: false },
    search: { type: 'boolean', default: false },
    from: { type: 'string' },
    to: { type: 'string' },
    target: { type: 'string' },
    limit: { type: 'string' },
    jobs: { type: 'string' },
    via: { type: 'string', default: 'sharp' },
    out: { type: 'string' },
  },
});

const api = await loadApi();
const { IMAGE_MAX_DIMENSION, IMAGE_MAX_INPUT_PIXELS } = await loadShared();
const kind = kindOf(values);
const decoded = decodedKind(kind);
const bound =
  api.PNG_LARGEST_FRAME_PIXELS[decoded.channels][decoded.depth][kind.interlaced ? 1 : 0];
const ratio = api.IMAGE_MAX_SIDE_RATIO;
const jobs = int(values.jobs, 'jobs', 4);
const name = kindName(kind);

/** The shapes of at most `pixels` (above): [{ width, height, orientation, why }]. */
function shapes(pixels, coarse) {
  const list = new Map();
  const add = (width, height, orientation, why) => {
    if (height < 1 || width < height || width * height > pixels || width > ratio * height) return;
    const key = `${width}x${height}o${orientation ?? 0}`;
    if (!list.has(key)) list.set(key, { width, height, orientation, why });
  };
  const widest = Math.floor(Math.sqrt(ratio * pixels));
  const square = Math.ceil(Math.sqrt(pixels));
  for (let width = square; width <= widest; width += coarse ? 100 : 50) {
    add(width, Math.floor(pixels / width), undefined, 'a');
  }
  if (coarse) return [...list.values()];

  // The factor left for the reduce after the integral shrink: the closer under a step, the more
  // input rows it holds.
  const residual = (factor) => factor / Math.max(1, Math.floor(factor / 2));
  const windows = [];
  for (let step = 4; step * IMAGE_MAX_DIMENSION <= widest + 60; step += 2) {
    windows.push([step * IMAGE_MAX_DIMENSION - 400, step * IMAGE_MAX_DIMENSION + 60]);
  }
  windows.push([widest - 400, widest]);
  for (const [from, to] of windows) {
    for (let width = Math.max(square, from); width <= Math.min(widest, to); width += 4) {
      const scale = width / IMAGE_MAX_DIMENSION;
      const tallest = Math.floor(pixels / width);
      add(width, tallest, undefined, 'b');
      const candidates = [];
      for (let height = tallest; height >= Math.max(1, tallest - Math.ceil(2 * scale)); height--) {
        const fitted = Math.round(height / scale);
        if (fitted >= 1) candidates.push({ height, residual: residual(height / fitted) });
      }
      candidates.sort((x, y) => y.residual - x.residual || y.height - x.height);
      for (const { height } of candidates.slice(0, 2)) add(width, height, undefined, 'b');
    }
  }
  for (let width = square; width <= Math.min(widest, Math.sqrt(4 * pixels)); width += 50) {
    add(width, Math.floor(pixels / width), 6, 'c');
  }
  return [...list.values()];
}

/** Converts every shape of at most `pixels`, `jobs` processes at a time; the summary line. */
async function sweep(pixels, coarse) {
  const list = shapes(pixels, coarse);
  const results = await pool(list, jobs, async (shape) => {
    const result = await measureInChild([
      '--width',
      String(shape.width),
      '--height',
      String(shape.height),
      ...kindFlags({ ...kind, orientation: shape.orientation }),
      '--via',
      values.via,
    ]);
    keep({ sweep: name, sweepPixels: pixels, why: shape.why, ...result }, values.out);
    return { ...shape, ...result };
  });
  const failed = results.filter((r) => r.error !== undefined);
  const refused = results.filter((r) => r.refused !== undefined);
  const measured = results.filter((r) => r.error === undefined && r.refused === undefined);
  measured.sort((x, y) => y.highMiB - x.highMiB);
  const byWhy = {};
  for (const r of measured) byWhy[r.why] = Math.max(byWhy[r.why] ?? 0, r.highMiB);
  // The vertical factor of the costliest: the stored frame's height over its fitted height.
  const factor = (r) => (r.height / (r.orientation ? r.out.width : r.out.height)).toFixed(3);
  const top = measured
    .slice(0, 8)
    .map(
      (r) =>
        `${r.highMiB}@${r.width}x${r.height}${r.orientation ? ' o6' : ''} (${r.why}, ${factor(r)})`,
    );
  return {
    type: coarse ? 'coarse' : 'sweep',
    kind: name,
    pixels,
    bound,
    ratio,
    budgetMiB: api.IMAGE_DECODE_BUDGET_BYTES / (1024 * 1024),
    cases: list.length,
    failed: failed.length,
    ...(failed.length > 0 ? { firstError: failed[0].error } : {}),
    refused: refused.length,
    maxMiB: measured[0]?.highMiB ?? null,
    byWhy,
    top,
    maxRssMiB: Math.max(0, ...measured.map((r) => r.maxRssMiB)),
    sharp: measured[0]?.sharp,
    vips: measured[0]?.vips,
    platform: measured[0]?.platform,
  };
}

/** One sweep, printed; stops on a case that failed (a frame not measured is not a bound). */
async function sweepAndEmit(pixels, coarse) {
  const summary = await sweep(pixels, coarse);
  emit(summary, values.out);
  if (summary.failed > 0) {
    throw new Error(`${summary.failed} case(s) failed: ${summary.firstError}`);
  }
  return summary;
}

if (!values.search) {
  await sweepAndEmit(int(values.pixels, 'pixels', bound), values.coarse);
} else {
  const STEP = 100_000;
  const target = int(values.target, 'target', 124);
  const limit = int(values.limit, 'limit', 126);
  let low = int(values.from, 'from', bound);
  let high = int(values.to, 'to', IMAGE_MAX_INPUT_PIXELS);
  if (low > high) throw new Error('--from is above --to');
  const coarseMax = async (pixels) => (await sweepAndEmit(pixels, true)).maxMiB;

  // Halving on the coarse sweep: `low` within the target, `high` over it (or the top itself).
  if ((await coarseMax(high)) <= target) {
    low = high;
  } else {
    while ((await coarseMax(low)) > target) {
      high = low;
      low = Math.floor((low * 0.85) / STEP) * STEP;
      if (low <= 0) throw new Error('no frame is within the target');
    }
    while (high - low > STEP) {
      const middle = Math.round((low + high) / 2 / STEP) * STEP;
      if (middle === low || middle === high) break;
      if ((await coarseMax(middle)) <= target) low = middle;
      else high = middle;
    }
  }
  // The full sweep: lowered until its costliest frame is within the limit, then halving back up
  // between that and the lowest value over it.
  let pixels = low;
  let summary = await sweepAndEmit(pixels, false);
  let over;
  while (summary.maxMiB > limit) {
    over = pixels;
    const lowered = Math.floor((pixels * (1 - 0.03 * (summary.maxMiB - limit))) / STEP) * STEP;
    pixels = Math.min(pixels - STEP, lowered);
    if (pixels <= 0) throw new Error('no frame is within the limit');
    summary = await sweepAndEmit(pixels, false);
  }
  while (over !== undefined && over - pixels > STEP) {
    const middle = Math.round((pixels + over) / 2 / STEP) * STEP;
    if (middle === pixels || middle === over) break;
    const tried = await sweepAndEmit(middle, false);
    if (tried.maxMiB <= limit) {
      pixels = middle;
      summary = tried;
    } else {
      over = middle;
    }
  }
  emit(
    {
      type: 'result',
      kind: name,
      largestFrame: pixels,
      bound,
      maxMiB: summary.maxMiB,
      top: summary.top.slice(0, 3),
      target,
      limit,
    },
    values.out,
  );
}
