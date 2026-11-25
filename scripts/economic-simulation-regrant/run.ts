import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { HORIZON_MS, SCAN_INTERVAL_MS, SETTLEMENT_WAIT_MS } from '../economic-simulation/inputs.ts';
import { digest, json } from '../economic-simulation/model.ts';
import { RegrantSimulationFailure, simulateRegrant, type RunSummary } from './driver.ts';
import {
  BUNDLE,
  CYCLES,
  CYCLE_MS,
  DELAY_MAX_HOURS,
  MARKET_CASE,
  NORMAL_SPEND_BP,
  PROFILES,
  R0_APPLY_AT_COIN,
  REGRANT_CANDIDATES,
  SEEDS,
  THRESHOLDS,
  VARIANTS,
} from './inputs.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    candidate: { type: 'string' },
    profile: { type: 'string' },
    variant: { type: 'string' },
    seed: { type: 'string' },
  },
});
if (!values.out)
  throw new Error('Required --out DIRECTORY (must not already contain manifest.json)');
const out = resolve(values.out);
if (existsSync(resolve(out, 'manifest.json')))
  throw new Error('Refusing to overwrite an existing run manifest');
mkdirSync(out, { recursive: true });
const candidates = REGRANT_CANDIDATES.filter((c) => !values.candidate || c.id === values.candidate);
const profiles = PROFILES.filter((p) => !values.profile || p.id === values.profile);
const variants = VARIANTS.filter((v) => !values.variant || v.id === values.variant);
const seeds = SEEDS.filter((seed) => !values.seed || String(seed) === values.seed);
if (!candidates.length || !profiles.length || !variants.length || !seeds.length)
  throw new Error('Unknown candidate/profile/variant/seed');
const expected = candidates.length * profiles.length * variants.length * seeds.length;
const pretty = (value: unknown) => JSON.stringify(JSON.parse(json(value)), null, 2) + '\n';
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) =>
      entry.isDirectory() ? files(resolve(dir, entry.name)) : [resolve(dir, entry.name)],
    );
/** #71's model and inputs, this folder, the mirrored #74 rule, shared src/dist and the lockfile. */
function sourceManifest() {
  return [
    ...files(resolve(root, 'scripts/economic-simulation')),
    ...files(resolve(root, 'scripts/economic-simulation-regrant')),
    resolve(root, 'packages/db/src/regrants.ts'),
    ...files(resolve(root, 'packages/shared/src')),
    ...files(resolve(root, 'packages/shared/dist')),
    resolve(root, 'pnpm-lock.yaml'),
  ]
    .filter((path) => !path.endsWith('.tsbuildinfo'))
    .map((path) => ({ path: relative(root, path), sha256: sha(readFileSync(path)) }));
}
const inputs = {
  bundle: BUNDLE,
  candidates,
  profiles,
  variants,
  seeds,
  cycles: CYCLES,
  cycleMs: CYCLE_MS,
  horizonMs: HORIZON_MS,
  scanIntervalMs: SCAN_INTERVAL_MS,
  settlementWaitMs: SETTLEMENT_WAIT_MS,
  marketCase: MARKET_CASE,
  normalSpendBp: NORMAL_SPEND_BP,
  delayMaxHours: DELAY_MAX_HOURS,
  thresholds: THRESHOLDS,
  r0ApplyAtCoin: R0_APPLY_AT_COIN,
};
const before = sourceManifest();
const startedAt = new Date().toISOString();
const start = performance.now();
const results: RunSummary[] = [];
const failures: unknown[] = [];
let completed = 0;
const manifest = {
  version: 1,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  node: process.version,
  expected,
  ...inputs,
  source: before,
  sourceDigest: digest(before),
  startedAt,
};
writeFileSync(resolve(out, 'inputs.json'), pretty(inputs));
for (const candidate of candidates)
  for (const profile of profiles)
    for (const variant of variants)
      for (const seed of seeds) {
        const key = `${candidate.id}-${profile.id}-${variant.id}-${seed}`;
        try {
          results.push(simulateRegrant({ candidate, profile, variant, seed }));
        } catch (error) {
          const evidence =
            error instanceof RegrantSimulationFailure
              ? error.evidence
              : { candidate, profile, variant, seed, error: String(error) };
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
        process.stdout.write(
          `${completed}/${expected} completed (${key}); ${failures.length} invariant/model errors; ${Math.round((performance.now() - start) / 1000)}s\n`,
        );
      }
const resultBytes = gzipSync(results.map((row) => json(row)).join('\n') + '\n');
writeFileSync(resolve(out, 'results.jsonl.gz'), resultBytes);
const after = sourceManifest();
const sourceUnchanged = digest(before) === digest(after);
const count = (pick: (row: RunSummary) => Record<string, number>) =>
  results.reduce((sum, row) => sum + Object.values(pick(row)).reduce((a, b) => a + b, 0), 0);
const final = {
  ...manifest,
  completed,
  successful: results.length,
  failed: failures.length,
  failures,
  existingInvariantChecks: count((row) => row.invariants.existing),
  newInvariantChecks: count((row) => row.invariants.new),
  invariantViolations: results.reduce((sum, row) => sum + row.invariants.violations, 0),
  sourceUnchanged,
  finishedAt: new Date().toISOString(),
  elapsedMs: Math.round(performance.now() - start),
  resultsSha256: sha(resultBytes),
  qualityThresholds: null,
  releaseApproved: false,
};
writeFileSync(resolve(out, 'manifest.json'), pretty(final));
if (failures.length || !sourceUnchanged || completed !== expected) process.exitCode = 1;
