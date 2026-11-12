import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const reporter = fileURLToPath(new URL('./report.mjs', import.meta.url));
const fixtures = fileURLToPath(
  new URL('../../docs/research/71-economic-simulation/results/', import.meta.url),
);
const inputFiles = ['manifest.json', 'results.jsonl.gz', 'comparison.csv'];
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function copyRun(directory: string) {
  mkdirSync(directory, { recursive: true });
  for (const file of inputFiles) copyFileSync(join(fixtures, file), join(directory, file));
  return inputFiles.map((file) => digest(join(directory, file)));
}

function assertArtifactLinks(reportPath: string, directory: string) {
  const body = readFileSync(reportPath, 'utf8');
  const links = [...body.matchAll(/\]\(([^)]+)\)/g)].map((match) => decodeURIComponent(match[1]!));
  assert.equal(links.length, 4);
  const expected = [
    'comparison.csv',
    'results.jsonl.gz',
    'scenario-summary.csv',
    'population-market-sensitivity.csv',
  ].map((file) => join(directory, file));
  assert.deepEqual(
    links.map((link) => resolve(dirname(reportPath), link)),
    expected,
  );
  for (const file of expected) assert.ok(readFileSync(file).length > 0);
}

await test('keeps sibling run reports independent and never overwrites their parent report', () => {
  const root = mkdtempSync(join(tmpdir(), 'buddha-economy-report-'));
  try {
    const sentinel = join(root, 'RESULTS.md');
    copyFileSync(new URL(import.meta.url), sentinel);
    const sentinelDigest = digest(sentinel);
    const first = join(root, 'first run');
    const second = join(root, 'second run');
    const firstInputs = copyRun(first);
    const secondInputs = copyRun(second);
    execFileSync(process.execPath, [reporter, first]);
    assert.equal(digest(sentinel), sentinelDigest, 'the parent report must remain untouched');
    const firstReport = join(first, 'RESULTS.md');
    const firstReportDigest = digest(firstReport);
    execFileSync(process.execPath, [reporter, second]);
    assert.equal(digest(sentinel), sentinelDigest);
    assert.equal(digest(firstReport), firstReportDigest);
    assertArtifactLinks(firstReport, first);
    assertArtifactLinks(join(second, 'RESULTS.md'), second);
    assert.deepEqual(
      inputFiles.map((file) => digest(join(first, file))),
      firstInputs,
    );
    assert.deepEqual(
      inputFiles.map((file) => digest(join(second, file))),
      secondInputs,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('resolves artifact links from an explicit report path outside the selected run', () => {
  const root = mkdtempSync(join(tmpdir(), 'buddha-economy-report-'));
  try {
    const directory = join(root, 'runs', 'selected run (one) #1');
    const inputs = copyRun(directory);
    const reportPath = join(root, 'reports', 'chosen.md');
    mkdirSync(dirname(reportPath));
    execFileSync(process.execPath, [reporter, directory, reportPath]);
    assertArtifactLinks(reportPath, directory);
    assert.deepEqual(
      inputFiles.map((file) => digest(join(directory, file))),
      inputs,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('preserves the published report bytes when its historical location is explicit', () => {
  const root = mkdtempSync(join(tmpdir(), 'buddha-economy-report-'));
  try {
    const directory = join(root, 'results');
    copyRun(directory);
    const reportPath = join(root, 'RESULTS.md');
    execFileSync(process.execPath, [reporter, directory, reportPath]);
    assert.deepEqual(readFileSync(reportPath), readFileSync(join(fixtures, '..', 'RESULTS.md')));
    assertArtifactLinks(reportPath, directory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
