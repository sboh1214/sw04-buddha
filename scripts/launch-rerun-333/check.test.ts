import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const checker = fileURLToPath(new URL('./check.mjs', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));
const RERUN = 'docs/research/333-launch-value-rerun';
const FOLDERS = {
  c5: {
    path: `${RERUN}/71-c5/results`,
    files: ['manifest.json', 'results.jsonl.gz', 'inputs.json', 'comparison.csv'],
  },
  r2: {
    path: `${RERUN}/332-r2/results`,
    files: ['manifest.json', 'results.jsonl.gz', 'inputs.json'],
  },
  stored71: {
    path: 'docs/research/71-economic-simulation/results',
    files: [
      'manifest.json',
      'results.jsonl.gz',
      'inputs.json',
      'comparison.csv',
      'scenario-summary.csv',
    ],
  },
  stored332: {
    path: 'docs/research/332-regrant-simulation/results',
    files: ['manifest.json', 'results.jsonl.gz', 'inputs.json', 'candidate-summary.csv'],
  },
} as const;
type Folder = keyof typeof FOLDERS;
type Json = Record<string, unknown>;

/** A copy of the four result folders at the repository's relative layout, so links match. */
function mirror(): { root: string; dir: (f: Folder) => string; run: () => Run } {
  const root = mkdtempSync(join(tmpdir(), 'buddha-launch-rerun-333-'));
  const dir = (f: Folder) => join(root, FOLDERS[f].path);
  for (const [name, { path, files }] of Object.entries(FOLDERS)) {
    mkdirSync(join(root, path), { recursive: true });
    for (const file of files) copyFileSync(join(repo, path, file), join(dir(name as Folder), file));
  }
  const run = (): Run => {
    const result = spawnSync(
      process.execPath,
      [
        checker,
        ...(Object.keys(FOLDERS) as Folder[]).flatMap((f) => [`--${f}`, dir(f)]),
        '--out',
        join(root, RERUN, 'RESULTS.md'),
      ],
      { encoding: 'utf8' },
    );
    return {
      status: result.status,
      stderr: result.stderr,
      wrote: existsSync(join(root, RERUN, 'RESULTS.md')),
    };
  };
  return { root, dir, run };
}
interface Run {
  status: number | null;
  stderr: string;
  wrote: boolean;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Json;
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
const readRows = (dir: string) =>
  gunzipSync(readFileSync(join(dir, 'results.jsonl.gz')))
    .toString()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Json);
/** Rewrites the rows and the manifest's hash together, so only the row check can refuse. */
function writeRows(dir: string, rows: Json[]) {
  const bytes = gzipSync(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(join(dir, 'results.jsonl.gz'), bytes);
  const manifest = readJson(join(dir, 'manifest.json'));
  manifest.resultsSha256 = createHash('sha256').update(bytes).digest('hex');
  writeJson(join(dir, 'manifest.json'), manifest);
}
function editManifest(dir: string, edit: (m: Json) => void) {
  const manifest = readJson(join(dir, 'manifest.json'));
  edit(manifest);
  writeJson(join(dir, 'manifest.json'), manifest);
}

function refuses(change: (dir: (f: Folder) => string) => void, reason: RegExp) {
  const { root, dir, run } = mirror();
  try {
    change(dir);
    const result = run();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /^REFUSED: /);
    assert.match(result.stderr, reason);
    assert.equal(result.wrote, false, 'RESULTS.md must not be written after a refusal');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await test('regenerating from the saved receipts gives the published RESULTS.md and row comparisons byte for byte', () => {
  const { root, dir, run } = mirror();
  try {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      readFileSync(join(root, RERUN, 'RESULTS.md')),
      readFileSync(join(repo, RERUN, 'RESULTS.md')),
    );
    for (const f of ['c5', 'r2'] as const)
      assert.deepEqual(
        readFileSync(join(dir(f), 'row-comparison.json')),
        readFileSync(join(repo, FOLDERS[f].path, 'row-comparison.json')),
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('refuses results whose hash is not the manifest’s', () => {
  refuses((dir) => {
    copyFileSync(join(dir('c5'), 'inputs.json'), join(dir('c5'), 'results.jsonl.gz'));
  }, /#71 C5: results\.jsonl\.gz sha256/);
});

await test('refuses a C5 receipt with a missing row', () => {
  refuses((dir) => {
    writeRows(dir('c5'), readRows(dir('c5')).slice(1));
  }, /#71 C5: 251 result rows ≠ 252/);
});

await test('refuses a C5 row that differs from the stored #71 row', () => {
  refuses((dir) => {
    const rows = readRows(dir('c5'));
    const orders = rows[7]!.orders as Json;
    orders.filledQty = Number(orders.filledQty) + 1;
    writeRows(dir('c5'), rows);
  }, /#71 C5: 1 row\(s\) differ from the stored run: .*\[orders\]$/m);
});

await test('names a digest that differs from the stored row', () => {
  refuses((dir) => {
    const rows = readRows(dir('c5'));
    rows[3]!.traceDigest = '0'.repeat(64);
    writeRows(dir('c5'), rows);
  }, /\[traceDigest\] \(digests differ\)/);
});

await test('refuses a C5 receipt with a failed run, a counterexample or changed sources', () => {
  refuses(
    (dir) =>
      editManifest(dir('c5'), (m) => {
        m.failed = 1;
        m.failures = [{ key: 'C5-p20-m1-balanced-71', error: 'x' }];
      }),
    /#71 C5: failed 1/,
  );
  refuses(
    (dir) => mkdirSync(join(dir('c5'), 'counterexamples')),
    /#71 C5: counterexamples\/ exists/,
  );
  refuses(
    (dir) => editManifest(dir('c5'), (m) => (m.sourceUnchanged = false)),
    /#71 C5: sourceUnchanged/,
  );
  refuses(
    (dir) => editManifest(dir('c5'), (m) => (m.releaseApproved = true)),
    /releaseApproved false/,
  );
});

await test('refuses an R2 receipt with an invariant violation in the manifest or in a row', () => {
  refuses(
    (dir) => editManifest(dir('r2'), (m) => (m.invariantViolations = 1)),
    /#332 R2: invariantViolations 1/,
  );
  refuses((dir) => {
    const rows = readRows(dir('r2'));
    (rows[5]!.invariants as Json).violations = 1;
    writeRows(dir('r2'), rows);
  }, /#332 R2: .* invariants\.violations ≠ 0/);
});

await test('refuses an R2 run of other values than the stored R2', () => {
  refuses((dir) => {
    const change = (m: Json) => {
      const [candidate] = m.candidates as { values: Json }[];
      candidate!.values.amountCoin = '1000';
    };
    editManifest(dir('r2'), change);
    const inputs = readJson(join(dir('r2'), 'inputs.json'));
    change(inputs);
    writeJson(join(dir('r2'), 'inputs.json'), inputs);
  }, /#332 R2: candidate R2 differs from the stored run's/);
});

await test('refuses two reruns made at different HEADs', () => {
  refuses((dir) => editManifest(dir('r2'), (m) => (m.head = '0'.repeat(40))), /different HEADs/);
});

await test('refuses a rerun inputs.json without the stored run’s input keys', () => {
  refuses(
    (dir) => writeJson(join(dir('c5'), 'inputs.json'), {}),
    /#71 C5: inputs\.json does not have the stored run's input keys/,
  );
});

await test('refuses a stored #332 receipt with an invariant violation', () => {
  refuses(
    (dir) => editManifest(dir('stored332'), (m) => (m.invariantViolations = 3)),
    /stored #332: the stored receipt is not a clean run/,
  );
});

await test('refuses a quoted stored R0 cell that its rows do not give', () => {
  refuses((dir) => {
    const path = join(dir('stored332'), 'candidate-summary.csv');
    const [head, ...lines] = readFileSync(path, 'utf8').split('\n');
    const column = head!.split(',').indexOf('haltMarketSeconds');
    const edited = lines.map((line) => {
      if (!line.startsWith('R0,p20-m1,V1,')) return line;
      const cells = line.split(',');
      cells[column] = '999';
      return cells.join(',');
    });
    writeFileSync(path, [head, ...edited].join('\n'));
  }, /stored #332 R0 candidate-summary: R0\/p20-m1\/V1 haltMarketSeconds 0 ≠ stored 999/);
});
