import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import {
  CANDIDATES,
  PROFILES,
  CASES,
  SEEDS,
  HORIZON_MS,
  SCAN_INTERVAL_MS,
  SETTLEMENT_WAIT_MS,
} from './inputs.ts';
import { digest, json, simulate, SimulationFailure } from './model.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    candidate: { type: 'string' },
    profile: { type: 'string' },
    case: { type: 'string' },
    seed: { type: 'string' },
    trace: { type: 'boolean', default: false },
  },
});
if (!values.out)
  throw new Error('Required --out DIRECTORY (must not already contain manifest.json)');
const out = resolve(values.out);
if (existsSync(resolve(out, 'manifest.json')))
  throw new Error('Refusing to overwrite an existing run manifest');
mkdirSync(out, { recursive: true });
const candidates = CANDIDATES.filter((c) => !values.candidate || c.id === values.candidate);
const profiles = PROFILES.filter((p) => !values.profile || p.id === values.profile);
const cases = CASES.filter((c) => !values.case || c.id === values.case);
const seeds = SEEDS.filter((seed) => !values.seed || String(seed) === values.seed);
if (!candidates.length || !profiles.length || !cases.length || !seeds.length)
  throw new Error('Unknown candidate/profile/case/seed');
const expected = candidates.length * profiles.length * cases.length * seeds.length;
if (values.trace && expected !== 1) throw new Error('--trace requires exactly one selected run');
const pretty = (value: unknown) => JSON.stringify(JSON.parse(json(value)), null, 2) + '\n';
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) =>
      entry.isDirectory() ? files(resolve(dir, entry.name)) : [resolve(dir, entry.name)],
    );
function sourceManifest() {
  return [
    ...files(resolve(root, 'scripts/economic-simulation')),
    ...files(resolve(root, 'packages/shared/src')),
    ...files(resolve(root, 'packages/shared/dist')),
    resolve(root, 'pnpm-lock.yaml'),
  ]
    .filter((path) => !path.endsWith('.tsbuildinfo'))
    .map((path) => ({ path: relative(root, path), sha256: sha(readFileSync(path)) }));
}
const before = sourceManifest();
const startedAt = new Date().toISOString();
const start = performance.now();
const results: ReturnType<typeof simulate>['summary'][] = [];
const failures: unknown[] = [];
let completed = 0;
const manifest = {
  version: 1,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  node: process.version,
  expected,
  candidates,
  profiles,
  cases,
  seeds,
  horizonMs: HORIZON_MS,
  scanIntervalMs: SCAN_INTERVAL_MS,
  settlementWaitMs: SETTLEMENT_WAIT_MS,
  source: before,
  sourceDigest: digest(before),
  startedAt,
};
writeFileSync(resolve(out, 'inputs.json'), pretty({ candidates, profiles, cases, seeds }));
for (const candidate of candidates)
  for (const profile of profiles)
    for (const scenario of cases)
      for (const seed of seeds) {
        const key = `${candidate.id}-${profile.id}-${scenario.id}-${seed}`;
        try {
          const result = simulate(candidate, profile, scenario, seed);
          results.push(result.summary);
          if (values.trace)
            writeFileSync(
              resolve(out, `${key}-trace.json.gz`),
              gzipSync(json({ tape: result.tape, trace: result.trace })),
            );
        } catch (error) {
          const evidence =
            error instanceof SimulationFailure
              ? error.evidence
              : { candidate, profile, scenario, seed, error: String(error) };
          failures.push({ key, error: String(error) });
          mkdirSync(resolve(out, 'counterexamples'), { recursive: true });
          writeFileSync(
            resolve(out, 'counterexamples', `${key}.json.gz`),
            gzipSync(json(evidence)),
          );
          process.stderr.write(
            `FAIL ${key}: ${error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : 'Unknown thrown value'}\n`,
          );
        }
        completed++;
        if (completed % 16 === 0 || completed === expected)
          process.stdout.write(
            `${completed}/${expected} completed; ${failures.length} invariant/model errors; ${Math.round((performance.now() - start) / 1000)}s\n`,
          );
      }
const columns = [
  'candidate',
  'profile',
  'case',
  'seed',
  'ioc',
  'full_ioc',
  'filled_qty',
  'bot_posted_qty',
  'bot_filled_qty',
  'open_market_ms',
  'bot_missing_ms',
  'whole_book_missing_ms',
  'max_loss_coin',
  'max_reserved_loss_coin',
  'max_one_order_reference_move',
  'max_execution_price_range',
  'yes_pnl_coin',
  'no_pnl_coin',
  'void_pnl_coin',
];
const csv =
  [
    columns.join(','),
    ...results.map((r) =>
      [
        r.candidate,
        r.profile,
        r.case,
        r.seed,
        r.orders.ioc,
        r.orders.fullIoc,
        r.orders.filledQty,
        r.orders.postedBotQty,
        r.orders.filledBotQty,
        r.time.openMarketMs,
        r.time.botOneDirectionMissingMs,
        r.time.wholeBookOneAskMissingMs,
        r.maxOverallLossCoin,
        r.maxOverallReservedLossCoin,
        r.maxSingleOrderReferenceMove,
        r.maxFillPriceRange,
        ...r.settlements.map((s) => s.botPnlCoin),
      ].join(','),
    ),
  ].join('\n') + '\n';
const resultBytes = gzipSync(results.map((row) => json(row)).join('\n') + '\n');
writeFileSync(resolve(out, 'results.jsonl.gz'), resultBytes);
writeFileSync(resolve(out, 'comparison.csv'), csv);
const after = sourceManifest();
const sourceUnchanged = digest(before) === digest(after);
const final = {
  ...manifest,
  completed,
  successful: results.length,
  failed: failures.length,
  failures,
  invariantChecks: results.reduce((sum, row) => sum + row.invariantChecks, 0),
  sourceUnchanged,
  finishedAt: new Date().toISOString(),
  elapsedMs: Math.round(performance.now() - start),
  resultsSha256: sha(resultBytes),
  comparisonSha256: sha(csv),
  qualityThresholds: null,
  releaseApproved: false,
};
writeFileSync(resolve(out, 'manifest.json'), pretty(final));
if (failures.length || !sourceUnchanged || completed !== expected) process.exitCode = 1;
