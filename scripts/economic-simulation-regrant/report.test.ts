import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const reporter = fileURLToPath(new URL('./report.mjs', import.meta.url));
const published = fileURLToPath(
  new URL('../../docs/research/332-regrant-simulation/', import.meta.url),
);
const inputs = ['manifest.json', 'results.jsonl.gz'];
const outputs = ['candidate-summary.csv', 'runs.csv', 'exhaustion-by-cycle.csv'];

await test('regenerating from the saved results gives the published report and tables byte for byte', () => {
  const root = mkdtempSync(join(tmpdir(), 'buddha-regrant-report-'));
  try {
    const directory = join(root, 'results');
    mkdirSync(directory);
    for (const file of inputs)
      copyFileSync(join(published, 'results', file), join(directory, file));
    execFileSync(process.execPath, [reporter, directory, join(root, 'RESULTS.md')]);
    assert.deepEqual(
      readFileSync(join(root, 'RESULTS.md')),
      readFileSync(join(published, 'RESULTS.md')),
    );
    for (const file of outputs)
      assert.deepEqual(
        readFileSync(join(directory, file)),
        readFileSync(join(published, 'results', file)),
        file,
      );
    for (const file of inputs)
      assert.deepEqual(
        readFileSync(join(directory, file)),
        readFileSync(join(published, 'results', file)),
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('refuses results whose hash differs from the manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'buddha-regrant-report-'));
  try {
    copyFileSync(join(published, 'results', 'manifest.json'), join(root, 'manifest.json'));
    copyFileSync(join(published, 'results', 'inputs.json'), join(root, 'results.jsonl.gz'));
    assert.throws(() =>
      execFileSync(process.execPath, [reporter, root, join(root, 'RESULTS.md')], {
        stdio: 'pipe',
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
