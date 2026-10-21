// The side-ratio bound (IMAGE_MAX_SIDE_RATIO, README.md, ADR-0073 9-8): converts a PNG kind's
// largest frame at each long/short side ratio, each in a process of its own, and prints libvips'
// high-water mark by ratio and the largest ratio measured within the decode budget.
//
//   node scripts/image-memory/measure-ratio.mjs [--ratios 1,8,16,32,40,44,48,64,100]
//     [--channels 3 [--depth 16] [--interlaced] [--profile | --icc file.icc] [--orientation 6]]
//     [--pixels 50000000] [--jobs 4] [--via sharp|api] [--out cases.jsonl]
//
// Without a kind it measures the cases 9-8 records: 8-bit grey and RGB, each with and without the
// hand-made ICC profile, RGB also turned a quarter by EXIF (orientation 6). The frame at ratio r is
// the widest of at most --pixels (default: the kind's bound in the API's build — 50,000,000 for
// 8-bit grey and RGB): short side ⌊√(pixels / r)⌋, long side ⌊r × short⌋ — 40,000×1,250 at 32.
// --via sharp (default) measures past the bound too; --via api refuses those ('pixels').
// A thin strip as #141's review found it: --ratios 500000 at 50,000,000 pixels is 5,000,000×10
// (takes ~0.5GiB grey and ~1.5GiB RGB by libvips' count — mind the machine's memory).
//
// stdout: one summary line a kind; --out also keeps every case.

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
  measureInChild,
  pool,
} from './lib.mjs';

const { values } = parseArgs({
  options: {
    ...KIND_OPTIONS,
    ratios: { type: 'string', default: '1,8,16,32,40,44,48,64,100' },
    pixels: { type: 'string' },
    jobs: { type: 'string' },
    via: { type: 'string', default: 'sharp' },
    out: { type: 'string' },
  },
});

const api = await loadApi();
const budgetMiB = api.IMAGE_DECODE_BUDGET_BYTES / (1024 * 1024);
const ratios = values.ratios.split(',').map((r) => {
  const ratio = Number(r);
  if (!(ratio >= 1)) throw new Error(`--ratios takes numbers of 1 or more: ${r}`);
  return ratio;
});
const jobs = int(values.jobs, 'jobs', 4);

const kinds =
  values.channels !== undefined || values.palette !== undefined
    ? [kindOf(values)]
    : [
        { channels: 1 },
        { channels: 1, profile: true },
        { channels: 3 },
        { channels: 3, orientation: 6 },
        { channels: 3, profile: true },
        { channels: 3, profile: true, orientation: 6 },
      ].map((options) => kindOf(options));

for (const kind of kinds) {
  const decoded = decodedKind(kind);
  const bound =
    api.PNG_LARGEST_FRAME_PIXELS[decoded.channels][decoded.depth][kind.interlaced ? 1 : 0];
  const pixels = int(values.pixels, 'pixels', bound);
  const frames = ratios.map((ratio) => {
    const short = Math.floor(Math.sqrt(pixels / ratio));
    return { ratio, width: Math.floor(ratio * short), height: short };
  });
  const results = await pool(frames, jobs, async (frame) => {
    const result = await measureInChild([
      '--width',
      String(frame.width),
      '--height',
      String(frame.height),
      ...kindFlags(kind),
      '--via',
      values.via,
    ]);
    keep({ ratioCase: kindName(kind), ratio: frame.ratio, ...result }, values.out);
    return { ...frame, ...result };
  });
  const byRatio = {};
  for (const r of results) {
    byRatio[r.ratio] = r.error !== undefined ? 'error' : (r.refused ?? r.highMiB);
  }
  // The largest ratio up to which every ratio measured stayed within the budget.
  let within = null;
  for (const r of [...results].sort((x, y) => x.ratio - y.ratio)) {
    if (r.error !== undefined || r.refused !== undefined || r.highMiB > budgetMiB) break;
    within = r.ratio;
  }
  const failed = results.filter((r) => r.error !== undefined);
  emit(
    {
      type: 'ratio',
      kind: kindName(kind),
      pixels,
      frames: Object.fromEntries(results.map((r) => [r.ratio, `${r.width}x${r.height}`])),
      byRatio,
      budgetMiB,
      withinBudgetUpTo: within,
      current: api.IMAGE_MAX_SIDE_RATIO,
      maxRssMiB: Math.max(0, ...results.map((r) => r.maxRssMiB ?? 0)),
      failed: failed.length,
      ...(failed.length > 0 ? { firstError: failed[0].error } : {}),
      sharp: results.find((r) => r.sharp)?.sharp,
      vips: results.find((r) => r.vips)?.vips,
      platform: results.find((r) => r.platform)?.platform,
    },
    values.out,
  );
  if (failed.length > 0) process.exitCode = 1;
}
