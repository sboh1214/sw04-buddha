import { format, resolveConfig } from 'prettier';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

/*
 * #333 (ADR-0173): checks the two rerun receipts of the chosen launch values — #71's model with
 * `--candidate C5` and #332's regrant driver with `--candidate R2` — against the stored #71 and
 * #332 runs, row by row, and only then writes the summary tables. Any failed run, invariant
 * violation, counterexample, changed input or differing row stops it before anything is written.
 * Display aggregates only: no threshold, ranking or recommendation is computed, and the values are
 * not called verified (N01 §10, N00 §7).
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({
  options: {
    c5: { type: 'string', default: 'docs/research/333-launch-value-rerun/71-c5/results' },
    r2: { type: 'string', default: 'docs/research/333-launch-value-rerun/332-r2/results' },
    stored71: { type: 'string', default: 'docs/research/71-economic-simulation/results' },
    stored332: { type: 'string', default: 'docs/research/332-regrant-simulation/results' },
    out: { type: 'string', default: 'docs/research/333-launch-value-rerun/RESULTS.md' },
  },
});
const dirs = {
  c5: resolve(root, values.c5),
  r2: resolve(root, values.r2),
  stored71: resolve(root, values.stored71),
  stored332: resolve(root, values.stored332),
};
const reportPath = resolve(root, values.out);

class Refused extends Error {}
const refuse = (message) => {
  throw new Refused(message);
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const link = (path) =>
  relative(dirname(reportPath), path)
    .split(sep)
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
const rel = (from, to) => relative(from, to).split(sep).join('/');

/** manifest.json + results.jsonl.gz, refusing a results file whose hash is not the manifest's. */
function readRun(dir, label) {
  const manifestPath = resolve(dir, 'manifest.json');
  const resultsPath = resolve(dir, 'results.jsonl.gz');
  if (!existsSync(manifestPath) || !existsSync(resultsPath))
    refuse(`${label}: manifest.json or results.jsonl.gz missing in ${dir}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bytes = readFileSync(resultsPath);
  if (sha(bytes) !== manifest.resultsSha256)
    refuse(`${label}: results.jsonl.gz sha256 is not the manifest's resultsSha256`);
  const lines = gunzipSync(bytes).toString().trim().split('\n');
  return { dir, manifest, bytes, lines, rows: lines.map((line) => JSON.parse(line)) };
}

/** Keys that differ between two runs of the same inputs (when, where, what came out). */
const RUN_KEYS = new Set([
  'head',
  'node',
  'expected',
  'candidates',
  'source',
  'sourceDigest',
  'startedAt',
  'finishedAt',
  'elapsedMs',
  'completed',
  'successful',
  'failed',
  'failures',
  'invariantChecks',
  'existingInvariantChecks',
  'newInvariantChecks',
  'invariantViolations',
  'sourceUnchanged',
  'resultsSha256',
  'comparisonSha256',
]);

function checkReceipt(run, stored, label, expected) {
  const m = run.manifest;
  if (existsSync(resolve(run.dir, 'counterexamples')))
    refuse(`${label}: counterexamples/ exists — an invariant or model error was recorded`);
  if (m.failed !== 0 || !Array.isArray(m.failures) || m.failures.length !== 0)
    refuse(`${label}: failed ${String(m.failed)} (expected 0)`);
  if ('invariantViolations' in expected && m.invariantViolations !== 0)
    refuse(`${label}: invariantViolations ${String(m.invariantViolations)} (expected 0)`);
  if (m.sourceUnchanged !== true) refuse(`${label}: sourceUnchanged is not true`);
  if (m.qualityThresholds !== null || m.releaseApproved !== false)
    refuse(`${label}: qualityThresholds must be null and releaseApproved false`);
  for (const key of ['expected', 'completed', 'successful'])
    if (m[key] !== expected.rows) refuse(`${label}: ${key} ${String(m[key])} ≠ ${expected.rows}`);
  if (run.rows.length !== expected.rows)
    refuse(`${label}: ${run.rows.length} result rows ≠ ${expected.rows}`);
  if (m.candidates.length !== 1 || m.candidates[0].id !== expected.candidate)
    refuse(`${label}: the run's candidates are not exactly ${expected.candidate}`);
  for (const row of run.rows)
    if (row.candidate !== expected.candidate)
      refuse(`${label}: a row of candidate ${String(row.candidate)}`);
  const inputs = JSON.parse(readFileSync(resolve(run.dir, 'inputs.json'), 'utf8'));
  const storedInputs = JSON.parse(readFileSync(resolve(stored.dir, 'inputs.json'), 'utf8'));
  if (!isDeepStrictEqual(Object.keys(inputs).sort(), Object.keys(storedInputs).sort()))
    refuse(`${label}: inputs.json does not have the stored run's input keys`);
  for (const [key, value] of Object.entries(inputs))
    if (!isDeepStrictEqual(value, m[key])) refuse(`${label}: inputs.json ${key} ≠ manifest`);
}

/** Every input but the candidate list equals the stored run's; the candidate is the stored one. */
function checkSameInputs(run, stored, label) {
  const keys = new Set([...Object.keys(run.manifest), ...Object.keys(stored.manifest)]);
  for (const key of keys) {
    if (RUN_KEYS.has(key)) continue;
    if (!isDeepStrictEqual(run.manifest[key], stored.manifest[key]))
      refuse(`${label}: input ${key} differs from the stored run`);
  }
  const [candidate] = run.manifest.candidates;
  const original = stored.manifest.candidates.find((c) => c.id === candidate.id);
  if (!isDeepStrictEqual(candidate, original))
    refuse(`${label}: candidate ${candidate.id} differs from the stored run's`);
}

/** Whole-row JSON equality against the stored rows of the same candidate; digests secondary. */
function compareRows(run, stored, label, keyOf, digests) {
  const candidate = run.manifest.candidates[0].id;
  const storedLines = stored.lines.filter((_, i) => stored.rows[i].candidate === candidate);
  const storedRows = storedLines.map((line) => JSON.parse(line));
  if (storedRows.length !== run.rows.length)
    refuse(
      `${label}: ${run.rows.length} rerun rows, ${storedRows.length} stored ${candidate} rows`,
    );
  const byKey = new Map();
  storedRows.forEach((row, i) => {
    const key = keyOf(row);
    if (byKey.has(key)) refuse(`${label}: stored key ${key} twice`);
    byKey.set(key, { row, line: storedLines[i], index: i });
  });
  const seen = new Set();
  const differ = [];
  let digestEqual = 0;
  let lineEqual = 0;
  let sameOrder = true;
  run.rows.forEach((row, i) => {
    const key = keyOf(row);
    if (seen.has(key)) refuse(`${label}: rerun key ${key} twice`);
    seen.add(key);
    const original = byKey.get(key);
    if (!original) refuse(`${label}: rerun row ${key} has no stored row`);
    if (original.index !== i) sameOrder = false;
    const digestsMatch = digests.every((d) => isDeepStrictEqual(row[d], original.row[d]));
    if (digestsMatch) digestEqual++;
    if (run.lines[i] === original.line) lineEqual++;
    if (!isDeepStrictEqual(row, original.row)) {
      const fields = Object.keys({ ...row, ...original.row }).filter(
        (f) => !isDeepStrictEqual(row[f], original.row[f]),
      );
      differ.push(`${key} [${fields.join(', ')}]${digestsMatch ? '' : ' (digests differ)'}`);
    }
  });
  if (differ.length)
    refuse(
      `${label}: ${differ.length} row(s) differ from the stored run: ${differ.slice(0, 5).join('; ')}`,
    );
  return {
    rows: run.rows.length,
    wholeRowEqual: run.rows.length,
    lineBytesEqual: lineEqual,
    digestFields: digests,
    digestEqual,
    sameOrder,
  };
}

/** Script and shared/lockfile hashes the rerun saw that the stored run did not. */
function sourceDelta(run, stored) {
  const before = new Map(stored.manifest.source.map((s) => [s.path, s.sha256]));
  const after = new Map(run.manifest.source.map((s) => [s.path, s.sha256]));
  const changed = [...after].filter(([p, h]) => before.has(p) && before.get(p) !== h);
  const added = [...after.keys()].filter((p) => !before.has(p));
  const removed = [...before.keys()].filter((p) => !after.has(p));
  const area = (p) =>
    p.startsWith('scripts/')
      ? p
      : p.startsWith('packages/shared/src/')
        ? 'packages/shared/src'
        : p.startsWith('packages/shared/dist/')
          ? 'packages/shared/dist'
          : p;
  const count = (paths) =>
    paths.reduce((acc, p) => ({ ...acc, [area(p)]: (acc[area(p)] ?? 0) + 1 }), {});
  return {
    storedHead: stored.manifest.head,
    files: run.manifest.source.length,
    storedFiles: stored.manifest.source.length,
    changed: count(changed.map(([p]) => p)),
    added: count(added),
    removed: count(removed),
  };
}

const readCsv = (path) => {
  const [head, ...lines] = readFileSync(path, 'utf8').trimEnd().split('\n');
  const columns = head.split(',');
  return lines.map((line, i) => {
    const cells = line.split(',');
    return { line: i + 2, text: line, ...Object.fromEntries(columns.map((c, k) => [c, cells[k]])) };
  });
};
const num = (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) refuse(`unsafe amount ${String(value)}`);
  return n;
};
const sum = (list) => list.reduce((a, b) => a + b, 0);
const pct = (a, b) => (b === 0 ? '자료 없음' : ((100 * a) / b).toFixed(2));
const groupBy = (rows, keyOf) => {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
};

/** #71 report.mjs's two-seed aggregate, column for column (scenario-summary.csv). */
function aggregate71(rows) {
  if (rows.length !== 2) refuse('a #71 group without exactly two seeds');
  const add = (a, b) => rows.reduce((n, r) => n + r[a][b], 0);
  return {
    candidate: rows[0].candidate,
    profile: rows[0].profile,
    case: rows[0].case,
    filledQty: add('orders', 'filledQty') / 2,
    fullIocPercent: pct(add('orders', 'fullIoc'), add('orders', 'ioc')),
    botFillPercent: pct(add('orders', 'filledBotQty'), add('orders', 'postedBotQty')),
    botMissingPercent: pct(add('time', 'botOneDirectionMissingMs'), add('time', 'openMarketMs')),
    wholeMissingPercent: pct(add('time', 'wholeBookOneAskMissingMs'), add('time', 'openMarketMs')),
    meanSpreadTicks:
      add('time', 'spreadObservedMs') === 0
        ? '자료 없음'
        : (add('time', 'spreadTickMs') / add('time', 'spreadObservedMs')).toFixed(2),
    pausedMarketSeconds: add('time', 'pausedMarketMs') / 2000,
    maxOverallLossCoin: Math.max(...rows.map((r) => num(r.maxOverallLossCoin))),
    maxReservedLossCoin: Math.max(...rows.map((r) => num(r.maxOverallReservedLossCoin))),
    maxSingleOrderReferenceMove: Math.max(...rows.map((r) => r.maxSingleOrderReferenceMove)),
    maxFillPriceRange: Math.max(...rows.map((r) => r.maxFillPriceRange)),
    yesPnlCoin: rows.reduce((n, r) => n + num(r.settlements[0].botPnlCoin), 0) / 2,
    noPnlCoin: rows.reduce((n, r) => n + num(r.settlements[1].botPnlCoin), 0) / 2,
    voidPnlCoin: rows.reduce((n, r) => n + num(r.settlements[2].botPnlCoin), 0) / 2,
    haltMarketSeconds:
      rows.reduce((n, r) => n + r.markets.reduce((k, m) => k + m.stageMs.halt, 0), 0) / 2000,
  };
}

const THRESHOLD_KEYS = ['50', '100', '200', '500'];
const REASONS = [
  'not_ready',
  'not_exhausted',
  'live_orders',
  'unsettled_positions',
  'waiting',
  'period_limit',
  'total_cap',
];
/** #332 report.mjs's two-seed aggregate (candidate-summary.csv), without the R0-pair columns; R0 has threshold ''. */
function aggregate332(rows, threshold) {
  if (rows.length !== 2) refuse('a #332 group without exactly two seeds');
  const [first] = rows;
  const people = first.people;
  const mean = (pick) => sum(rows.map(pick)) / rows.length;
  const pooled = (pick) => rows.flatMap(pick).sort((a, b) => a - b);
  const median = (sorted) => (sorted.length ? sorted[Math.ceil(sorted.length / 2) - 1] : null);
  const days = (ms) => (ms === null ? '없음' : (ms / 86400000).toFixed(2));
  const hours = (ms) => (ms === null ? '없음' : (ms / 3600000).toFixed(1));
  const grants = pooled((r) =>
    Object.entries(r.recipients.grantCountHistogram).flatMap(([count, n]) =>
      Number(count) > 0 ? Array.from({ length: n }, () => Number(count)) : [],
    ),
  );
  const firstGrant = pooled((r) => r.recipients.firstGrantMs);
  const toGrant = pooled((r) => r.recipients.exhaustToGrantMs);
  const openAge = pooled((r) => r.unfinished.openEpisodeAgeMs);
  const exhaustedAt = Object.fromEntries(
    THRESHOLD_KEYS.map((t) => [t, pct(sum(rows.map((r) => r.exhaustion.final[t])), people * 2)]),
  );
  const group = (key) => rows.map((r) => r.groups[key] ?? { people: 0, grants: 0 });
  const stage = (name) => mean((r) => r.bot.stageMs[name]) / 1000;
  return {
    candidate: first.candidate,
    profile: first.profile,
    variant: first.variant,
    people,
    markets: first.markets,
    threshold,
    regrantCoin: mean((r) => num(r.issuance.regrantCoin)),
    regrantPerStartPct: pct(
      sum(rows.map((r) => num(r.issuance.regrantCoin))),
      sum(rows.map((r) => num(r.issuance.startCoin))),
    ),
    recoveredCoin: mean((r) => num(r.recovery.recoveredCoin)),
    regrantPerRecoveredPct: pct(
      sum(rows.map((r) => num(r.issuance.regrantCoin))),
      sum(rows.map((r) => num(r.recovery.recoveredCoin))),
    ),
    netRecoveredCoin: mean((r) => num(r.recovery.recoveredCoin) - num(r.issuance.treasuryCoin)),
    regrantPerNetRecoveredPct: pct(
      sum(rows.map((r) => num(r.issuance.regrantCoin))),
      sum(rows.map((r) => num(r.recovery.recoveredCoin) - num(r.issuance.treasuryCoin))),
    ),
    recipientsPct: pct(sum(rows.map((r) => r.recipients.accounts)), people * 2),
    grantsMedian: median(grants) ?? '없음',
    grantsMax: grants.length ? grants.at(-1) : 0,
    capReached: mean((r) => r.recipients.capReached),
    firstGrantDaysMedian: days(median(firstGrant)),
    firstGrantDaysMax: days(firstGrant.at(-1) ?? null),
    finalExhaustedPct: threshold === '' ? '' : exhaustedAt[threshold],
    ...Object.fromEntries(THRESHOLD_KEYS.map((t) => [`finalExhaustedPctAt${t}`, exhaustedAt[t]])),
    exhaustToGrantHoursMedian: hours(median(toGrant)),
    exhaustToGrantHoursMax: hours(toGrant.at(-1) ?? null),
    unfinishedOpenAtEnd: mean((r) => r.unfinished.openEpisodesAtEnd),
    unfinishedOpenAgeHoursMax: hours(openAge.at(-1) ?? null),
    unfinishedCappedExhaustedAtEnd: mean((r) => r.unfinished.cappedExhaustedAtEnd),
    requestsSent: mean((r) => r.requests.sent),
    requestsGranted: mean((r) => r.requests.granted),
    ...Object.fromEntries(
      REASONS.map((reason) => [reason, mean((r) => r.requests.refusals[reason])]),
    ),
    exhaustImmediatePeople: mean((r) => r.groups['exhaust/immediate']?.people ?? 0),
    exhaustImmediateGrants: sum(group('exhaust/immediate').map((g) => g.grants)) / 2,
    exhaustImmediateGrantsPerPerson: (() => {
      const g = group('exhaust/immediate');
      const p = sum(g.map((x) => x.people));
      return p === 0 ? '자료 없음' : (sum(g.map((x) => x.grants)) / p).toFixed(2);
    })(),
    recipientsLossPerRegrantPct: pct(
      sum(rows.map((r) => num(r.recipients.tradingLossCoin))),
      sum(rows.map((r) => num(r.recipients.regrantCoin))),
    ),
    mmPnlCoin: mean((r) => num(r.bot.pnlCoin)),
    mmMinMarketPnlCoin: Math.min(...rows.map((r) => num(r.bot.minMarketPnl))),
    mmMaxMarketPnlCoin: Math.max(...rows.map((r) => num(r.bot.maxMarketPnl))),
    reduceMarketSeconds: stage('reduce'),
    haltMarketSeconds: stage('halt'),
    toReduce: mean((r) => r.bot.transitions.reduce),
    toHalt: mean((r) => r.bot.transitions.halt),
    maxReservedLossCoin: Math.max(...rows.map((r) => num(r.bot.maxReservedLossCoin))),
    maxLossLimitCoin: num(first.bot.maxLossLimitCoin),
    ordersPlaced: mean((r) => r.orders.placed),
    ordersSkippedBelowOneContract: mean((r) => r.orders.skippedBelowOneContract),
    existingChecks: sum(rows.map((r) => sum(Object.values(r.invariants.existing)))),
    newChecks: sum(rows.map((r) => sum(Object.values(r.invariants.new)))),
    violations: sum(rows.map((r) => r.invariants.violations)),
  };
}

/** Each recomputed aggregate must equal its stored summary row, column for column. */
function matchSummary(aggregates, stored, keyOf, label) {
  return aggregates.map((agg) => {
    const row = stored.find((s) => keyOf(s) === keyOf(agg));
    if (!row) refuse(`${label}: no stored summary row for ${keyOf(agg)}`);
    for (const column of Object.keys(row))
      if (column !== 'line' && column !== 'text' && !(column in agg))
        refuse(`${label}: stored column ${column} is not recomputed`);
    for (const [column, value] of Object.entries(agg))
      if (String(value) !== row[column])
        refuse(
          `${label}: ${keyOf(agg)} ${column} ${String(value)} ≠ stored ${String(row[column])}`,
        );
    return { ...agg, line: row.line };
  });
}

async function main() {
  const c5 = readRun(dirs.c5, '#71 C5');
  const r2 = readRun(dirs.r2, '#332 R2');
  const stored71 = readRun(dirs.stored71, 'stored #71');
  const stored332 = readRun(dirs.stored332, 'stored #332');
  for (const [run, label] of [
    [stored71, 'stored #71'],
    [stored332, 'stored #332'],
  ])
    if (
      run.manifest.failed !== 0 ||
      run.manifest.sourceUnchanged !== true ||
      ('invariantViolations' in run.manifest && run.manifest.invariantViolations !== 0) ||
      existsSync(resolve(run.dir, 'counterexamples'))
    )
      refuse(`${label}: the stored receipt is not a clean run`);
  checkReceipt(c5, stored71, '#71 C5', { candidate: 'C5', rows: 252 });
  checkReceipt(r2, stored332, '#332 R2', { candidate: 'R2', rows: 36, invariantViolations: 0 });
  for (const row of c5.rows)
    if (row.invariantViolations !== 0)
      refuse(`#71 C5: ${row.profile}/${row.case}/${row.seed} invariantViolations ≠ 0`);
  for (const row of r2.rows)
    if (row.invariants.violations !== 0)
      refuse(`#332 R2: ${row.profile}/${row.variant}/${row.seed} invariants.violations ≠ 0`);
  const existing = sum(r2.rows.map((r) => sum(Object.values(r.invariants.existing))));
  const added = sum(r2.rows.map((r) => sum(Object.values(r.invariants.new))));
  if (existing !== r2.manifest.existingInvariantChecks || added !== r2.manifest.newInvariantChecks)
    refuse('#332 R2: the rows do not add up to the manifest invariant counts');
  if (sum(c5.rows.map((r) => r.invariantChecks)) !== c5.manifest.invariantChecks)
    refuse('#71 C5: the rows do not add up to the manifest invariantChecks');
  const csvBytes = readFileSync(resolve(dirs.c5, 'comparison.csv'));
  if (sha(csvBytes) !== c5.manifest.comparisonSha256)
    refuse('#71 C5: comparison.csv sha256 is not the manifest comparisonSha256');
  if (c5.manifest.head !== r2.manifest.head)
    refuse(`the two reruns ran at different HEADs (${c5.manifest.head}, ${r2.manifest.head})`);
  checkSameInputs(c5, stored71, '#71 C5');
  checkSameInputs(r2, stored332, '#332 R2');
  if (!isDeepStrictEqual(r2.manifest.bundle, c5.manifest.candidates[0]))
    refuse('#332 R2: the bundle is not the #71 C5 candidate');
  const groups71 = groupBy(c5.rows, (r) => `${r.profile}/${r.case}`);
  if (groups71.size !== 126) refuse(`#71 C5: ${groups71.size} groups ≠ 126`);
  const groups332 = groupBy(r2.rows, (r) => `${r.profile}/${r.variant}`);
  if (groups332.size !== 18) refuse(`#332 R2: ${groups332.size} groups ≠ 18`);

  const rows71 = compareRows(c5, stored71, '#71 C5', (r) => `${r.profile}/${r.case}/${r.seed}`, [
    'inputDigest',
    'traceDigest',
  ]);
  const rows332 = compareRows(
    r2,
    stored332,
    '#332 R2',
    (r) => `${r.profile}/${r.variant}/${r.seed}`,
    ['inputDigests', 'traceDigest'],
  );
  const storedCsv = readFileSync(resolve(dirs.stored71, 'comparison.csv'), 'utf8').split('\n');
  const rerunCsv = csvBytes.toString().split('\n');
  const storedC5Csv = [storedCsv[0], ...storedCsv.filter((l) => l.startsWith('C5,')), ''];
  if (!isDeepStrictEqual(rerunCsv, storedC5Csv))
    refuse('#71 C5: comparison.csv differs from the stored C5 lines');

  const key71 = (r) => `${r.candidate}/${r.profile}/${r.case}`;
  const summary71 = matchSummary(
    [...groups71.values()].map(aggregate71),
    readCsv(resolve(dirs.stored71, 'scenario-summary.csv')),
    key71,
    '#71 C5 scenario-summary',
  );
  const threshold = r2.manifest.candidates[0].values.thresholdCoin;
  const key332 = (r) => `${r.candidate}/${r.profile}/${r.variant}`;
  const storedSummary332 = readCsv(resolve(dirs.stored332, 'candidate-summary.csv'));
  // R0 is not rerun (333-6): its quoted cells are recomputed from the stored #332 R0 rows, and the
  // R0-pair columns as #332 report.mjs does, so every quoted cell is checked against the CSV.
  const groupsR0 = groupBy(
    stored332.rows.filter((r) => r.candidate === 'R0'),
    (r) => `${r.profile}/${r.variant}`,
  );
  if (groupsR0.size !== 18) refuse(`stored #332 R0: ${groupsR0.size} groups ≠ 18`);
  const aggregatesR0 = [...groupsR0.values()].map((rows) => aggregate332(rows, ''));
  const withR0Pair = (row) => {
    const control = aggregatesR0.find(
      (r) => r.profile === row.profile && r.variant === row.variant,
    );
    if (!control) refuse(`stored #332 R0: no ${row.profile}/${row.variant}`);
    const gap = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : '');
    const r0FinalExhaustedPct =
      row.threshold === '' ? '' : control[`finalExhaustedPctAt${row.threshold}`];
    return {
      ...row,
      r0FinalExhaustedPct,
      finalExhaustedPctPointsVsR0:
        row.threshold === ''
          ? ''
          : (Number(row.finalExhaustedPct) - Number(r0FinalExhaustedPct)).toFixed(2),
      mmPnlCoinVsR0: gap(row.mmPnlCoin, control.mmPnlCoin),
      recoveredCoinVsR0: gap(row.recoveredCoin, control.recoveredCoin),
      haltMarketSecondsVsR0: gap(row.haltMarketSeconds, control.haltMarketSeconds),
    };
  };
  const summary332 = matchSummary(
    [...groups332.values()].map((rows) => withR0Pair(aggregate332(rows, threshold))),
    storedSummary332,
    key332,
    '#332 R2 candidate-summary',
  );
  const summaryR0 = matchSummary(
    aggregatesR0.map(withR0Pair),
    storedSummary332,
    key332,
    'stored #332 R0 candidate-summary',
  );
  const r0 = (profile, variant) =>
    summaryR0.find((s) => s.profile === profile && s.variant === variant);

  const writeJson = async (dir, value) =>
    writeFileSync(
      resolve(dir, 'row-comparison.json'),
      await format(JSON.stringify(value), {
        ...(await resolveConfig(import.meta.filename)),
        parser: 'json',
      }),
    );
  await writeJson(dirs.c5, {
    stored: rel(dirs.c5, dirs.stored71),
    storedResultsSha256: stored71.manifest.resultsSha256,
    rerunResultsSha256: c5.manifest.resultsSha256,
    ...rows71,
    comparisonCsvEqual: true,
    scenarioSummaryRowsEqual: summary71.length,
    source: sourceDelta(c5, stored71),
  });
  await writeJson(dirs.r2, {
    stored: rel(dirs.r2, dirs.stored332),
    storedResultsSha256: stored332.manifest.resultsSha256,
    rerunResultsSha256: r2.manifest.resultsSha256,
    ...rows332,
    candidateSummaryRowsEqual: summary332.length,
    source: sourceDelta(r2, stored332),
  });

  const body = report({ c5, r2, rows71, rows332, summary71, summary332, r0 });
  writeFileSync(
    reportPath,
    await format(body.join('\n'), {
      ...(await resolveConfig(import.meta.filename)),
      parser: 'markdown',
    }),
  );
}

const ASSUMPTIONS = [
  ['p20-m1', '내부 테스트 가정: 20명/1시장'],
  ['p100-m5', '초기 공개 가정: 100명/5시장'],
];
const NAMED = ASSUMPTIONS.map(([p]) => p);

function report({ c5, r2, rows71, rows332, summary71, summary332, r0 }) {
  const files71 = (f) => link(resolve(dirs.c5, f));
  const files332 = (f) => link(resolve(dirs.r2, f));
  const stored71 = (f) => link(resolve(dirs.stored71, f));
  const stored332 = (f) => link(resolve(dirs.stored332, f));
  const C = c5.manifest.candidates[0];
  const R = r2.manifest.candidates[0].values;
  const L = num(C.maxLossCoin);
  const find71 = (p, c) => summary71.find((r) => r.profile === p && r.case === c);
  const find332 = (p, v) => summary332.find((r) => r.profile === p && r.variant === v);
  const cases = c5.manifest.cases.map((c) => c.id);
  const profiles = c5.manifest.profiles;
  const variants = r2.manifest.variants.map((v) => v.id);
  const seconds = (ms) => (ms / 1000).toFixed(1);
  const body = [
    '# #333 고른 출시 값(C5·R2)으로 다시 돌린 모형 실행 결과',
    '',
    `이 파일은 \`scripts/launch-rerun-333/check.mjs\`가 두 실행 영수증을 검사하고 저장된 #71·#332 행과 대조한 뒤 만든다. 대조가 하나라도 어긋나면 이 파일을 쓰지 않는다. **고른 값으로 돌린 모형 실행 결과이며 검증 완료, 추천 값, 출시 승인이 아니다**(N01 §10, N00 §7). 문턱이나 순위를 두지 않았다. 수량·손익은 두 seed의 산술평균, 비율은 두 seed의 분자·분모를 합친 값, 최대는 두 seed의 최대다. 표의 줄마다 저장된 요약 CSV의 행 번호(머리 줄이 1행)를 적는다 — 다시 계산한 값이 그 행과 칸마다 같다는 것을 이 스크립트가 확인했다. 약점의 원문은 [README](README.md#기록-표에-넣을-수-있게-남기는-약점)에 있다.`,
    '',
    '## 실행과 대조',
    '',
    '| 실행 | 값 | HEAD | 실행 수 | 실패 | 불변식 | 로컬 소요 | resultsSha256 | 저장된 행과 대조 |',
    '| --- | --- | --- | ---: | ---: | --- | ---: | --- | --- |',
    `| #71 모형 \`--candidate C5\` | C5 | \`${c5.manifest.head.slice(0, 12)}\` | ${c5.manifest.completed}/${c5.manifest.expected} | ${c5.manifest.failed} | 오류 0, 보존 검사 ${c5.manifest.invariantChecks}회, \`counterexamples/\` 없음 | ${seconds(c5.manifest.elapsedMs)}초 | \`${c5.manifest.resultsSha256}\` | 행 전체 ${rows71.wholeRowEqual}/${rows71.rows} 같음(줄 바이트 ${rows71.lineBytesEqual}/${rows71.rows}, \`inputDigest\`·\`traceDigest\` ${rows71.digestEqual}/${rows71.rows}, 순서 ${rows71.sameOrder ? '같음' : '다름'}), \`comparison.csv\`의 C5 줄 같음 |`,
    `| #332 driver \`--candidate R2\` | C5 위 R2 | \`${r2.manifest.head.slice(0, 12)}\` | ${r2.manifest.completed}/${r2.manifest.expected} | ${r2.manifest.failed} | 위반 ${r2.manifest.invariantViolations}, 기존 이름 검사 ${r2.manifest.existingInvariantChecks}회·새 검사 ${r2.manifest.newInvariantChecks}회, \`counterexamples/\` 없음 | ${seconds(r2.manifest.elapsedMs)}초 | \`${r2.manifest.resultsSha256}\` | 행 전체 ${rows332.wholeRowEqual}/${rows332.rows} 같음(줄 바이트 ${rows332.lineBytesEqual}/${rows332.rows}, \`inputDigests\`·\`traceDigest\` ${rows332.digestEqual}/${rows332.rows}, 순서 ${rows332.sameOrder ? '같음' : '다름'}) |`,
    '',
    `부분 집합이라 \`resultsSha256\`는 저장된 전체 실행(#71 2016회, #332 216회)의 것과 다르다. 대조 결과와 소스 해시의 차이는 [#71 C5 대조](${files71('row-comparison.json')})·[#332 R2 대조](${files332('row-comparison.json')})에, 실행 영수증은 [#71 C5](${files71('manifest.json')})·[#332 R2](${files332('manifest.json')})에 있다. 로컬 소요는 연구 도구의 관측값이며 서비스 성능이 아니다.`,
    '',
    '## C5 — #71 모형',
    '',
    `값: S ${C.startCoin} · A ${C.budgetCoin} · L ${C.maxLossCoin} · b ${C.b} · ${C.levels}단 · 방향별 물량 ${C.quantity} · 안전 ${C.safetyTicks}틱 · 가격 보호 ${C.protectionTicks}틱 · reduce/halt ${C.reduceAtBp / 100}/${C.haltAtBp / 100}% · 축소 ${C.reduceRatioBp / 100}%. 완료율·공백의 정의는 [#71 README](../71-economic-simulation/README.md#지표-정의와-관측된-약점)와 같다. 최대 손실은 시장별 손실 합의 최대이고 L × 시장 수와 나란히 적는다. MM 손익은 사용자 손익과 반대이며 품질 점수가 아니다.`,
  ];
  for (const [profile, label] of ASSUMPTIONS) {
    const markets = profiles.find((p) => p.id === profile).markets;
    body.push(
      '',
      `### ${label}`,
      '',
      '| 경로 | 체결 계약 | IOC 완료 % | MM 공백 % | 양측 관측 spread 틱 | 최대 손실 / L × 시장 수 Coin | MM YES / NO / VOID 손익 Coin | halt 시장·초 | PAUSED 시장·초 | [scenario-summary](' +
        stored71('scenario-summary.csv') +
        ') 행 |',
      '| --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: |',
    );
    for (const c of cases) {
      const r = find71(profile, c);
      body.push(
        `| ${c} | ${r.filledQty} | ${r.fullIocPercent} | ${r.botMissingPercent} | ${r.meanSpreadTicks} | ${r.maxOverallLossCoin} / ${L * markets} | ${r.yesPnlCoin} / ${r.noPnlCoin} / ${r.voidPnlCoin} | ${r.haltMarketSeconds} | ${r.pausedMarketSeconds} | ${r.line} |`,
      );
    }
  }
  const outside71 = summary71.filter((r) => !NAMED.includes(r.profile));
  const inside71 = summary71.filter((r) => NAMED.includes(r.profile));
  const marketsOf = (p) => profiles.find((x) => x.id === p).markets;
  // human-trade and self-trade turn the bot's supply off (#71 README), so their 100% MM gap and
  // their IOC rates say nothing about C5's quotes; whale-20 and news-stop-0 fill nothing anywhere.
  const supplied = (r) => r.case !== 'human-trade' && r.case !== 'self-trade';
  const metrics71 = [
    [
      'MM 공백 %(봇 공급을 끈 두 경로 제외)',
      (r) => (supplied(r) ? Number(r.botMissingPercent) : 0),
      'max',
    ],
    [
      'halt 시장당 초',
      (r) => Number((r.haltMarketSeconds / marketsOf(r.profile)).toFixed(2)),
      'max',
    ],
    [
      '최대 손실 ÷ (L × 시장 수) %',
      (r) => Number(((100 * r.maxOverallLossCoin) / (L * marketsOf(r.profile))).toFixed(2)),
      'max',
    ],
    [
      'balanced IOC 완료 %(작을수록 약함)',
      (r) => (r.case === 'balanced' ? Number(r.fullIocPercent) : 100),
      'min',
    ],
  ];
  body.push(
    '',
    '### 9조합에서만 드러난 것',
    '',
    `두 가정 밖 7조합의 14경로에서 두 가정의 값보다 나쁜 쪽으로 나온 것만 적는다(시장 수만큼 커지는 값은 시장당으로 견준다). 9조합 가운데 7조합의 프로필 라벨은 \`'scale-sensitivity'\`(\`scripts/economic-simulation/inputs.ts\`)이다. 이 라벨은 **참가자 수·시장 수 축**을 뜻하며, 133-31이 하지 않기로 한 '승인된 값을 바꿔 보는 민감도 실행'이 아니다 — 9조합과 14경로(\`stale-*\`의 갱신 지연, \`news-stop-*\`의 중단 지연 포함)는 C5의 열한 값을 바꾸지 않고, 출시 설정도 아니다(#333 범위 "두 가정과 9조합으로 돌린다").`,
    '',
    '| 지표 | 두 가정의 가장 나쁜 값 | 7조합의 가장 나쁜 값 | 경로·행 |',
    '| --- | ---: | ---: | --- |',
  );
  for (const [label, pick, dir] of metrics71) {
    const worst = (rows) => (dir === 'max' ? Math.max : Math.min)(...rows.map(pick));
    const a = worst(inside71);
    const b = worst(outside71);
    const worse = dir === 'max' ? b > a : b < a;
    const where = worse
      ? outside71
          .filter((r) => pick(r) === b)
          .map((r) => `${r.profile}·${r.case}(${r.line}행)`)
          .join(', ')
      : '7조합에서 더 나쁜 값 없음';
    body.push(`| ${label} | ${a} | ${worse ? b : '—'} | ${where} |`);
  }
  const whale20 = summary71.filter((r) => r.case === 'whale-20');
  body.push(
    '',
    `- 큰손 20분할(\`whale-20\`)의 체결 계약은 ${whale20.filter((r) => r.filledQty === 0).length}/${whale20.length}조합에서 0이다(행 ${whale20.map((r) => r.line).join('·')}).`,
    `- 전체 252행은 [원결과](${files71('results.jsonl.gz')})·[실행별 수치](${files71('comparison.csv')})에, 126개 집계는 저장된 [scenario-summary](${stored71('scenario-summary.csv')})의 C5 행과 같다.`,
    '',
    '## R2 — #332 driver(C5 위)',
    '',
    `값: 기준액 ${R.thresholdCoin} · 1회 ${R.amountCoin} · 대기 ${R.waitHours}시간 · ${R.periodDays}일에 ${R.periodLimit}회 · 누적 상한 ${R.totalCapCoin}. 333-6에 따라 R2만 돌렸다. R0(재지급 없음)은 다시 돌리지 않았고 저장된 #332 [후보 요약](${stored332('candidate-summary.csv')})의 R0 행을 인용한다 — 인용한 R0 칸과 R0 대조 칸은 저장된 #332 R0 원결과 행에서 다시 계산해 그 요약 행과 칸마다 같음을 이 스크립트가 확인했다. 지표의 정의는 [#332 RESULTS](../332-regrant-simulation/RESULTS.md)와 같다. 재지급은 순회수(금고 회수 − Σ주기 A·m = 사람이 거래로 잃은 Coin의 합)에 견주며 금고가 줄어드는 정도가 아니다.`,
    '',
    '| 가정·변형 | 마지막 소진 잔류 % (저장된 R0, 같은 기준액) | 받은 계정 % | 상한에 닿은 계정 | 재지급 ÷ 순회수 % | 소진→지급 최대 시간 | 끝날 때 못 받음: 진행 중 + 상한 (진행 중 최장 시간) | halt 시장·초 (저장된 R0) | MM 손익 합 Coin (R0 차) | 최대 예약 손실 / L | 요약 행 R2 / R0 |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |',
  );
  for (const [profile] of ASSUMPTIONS)
    for (const v of variants) {
      const r = find332(profile, v);
      const z = r0(profile, v);
      body.push(
        `| ${profile}·${v} | ${r.finalExhaustedPct} (${r.r0FinalExhaustedPct}) | ${r.recipientsPct} | ${r.capReached} | ${r.regrantPerNetRecoveredPct} | ${r.exhaustToGrantHoursMax} | ${r.unfinishedOpenAtEnd} + ${r.unfinishedCappedExhaustedAtEnd} (${r.unfinishedOpenAgeHoursMax}) | ${r.haltMarketSeconds} (${z.haltMarketSeconds}) | ${r.mmPnlCoin} (${r.mmPnlCoinVsR0}) | ${r.maxReservedLossCoin} / ${r.maxLossLimitCoin} | ${r.line} / ${z.line} |`,
      );
    }
  const outside332 = summary332.filter((r) => !NAMED.includes(r.profile));
  const inside332 = summary332.filter((r) => NAMED.includes(r.profile));
  const round = (x) => Number(x.toFixed(2));
  const metrics332 = [
    ['마지막 소진 잔류 %', (r) => Number(r.finalExhaustedPct)],
    ['재지급 ÷ 순회수 %', (r) => Number(r.regrantPerNetRecoveredPct) || 0],
    ['상한에 닿은 계정 %', (r) => round((r.capReached * 100) / r.people)],
    ['소진→지급 최대 시간', (r) => Number(r.exhaustToGrantHoursMax) || 0],
    [
      '끝날 때 못 받은 계정 %',
      (r) => round(((r.unfinishedOpenAtEnd + r.unfinishedCappedExhaustedAtEnd) * 100) / r.people),
    ],
    ['진행 중 소진 최장 시간', (r) => Number(r.unfinishedOpenAgeHoursMax) || 0],
    ['halt 시장당 초', (r) => round(r.haltMarketSeconds / r.markets)],
    ['최대 예약 손실', (r) => r.maxReservedLossCoin],
  ];
  body.push(
    '',
    '### 9조합에서만 드러난 것',
    '',
    "#332 RESULTS의 '9조합에서만 드러난 것'과 같은 방식이다: 두 가정 밖 7조합(× 두 변형)에서 두 가정의 최댓값보다 크게 나온 값만 적고, 계정 수는 인원 대비 %, halt는 시장당 초로 견준다.",
    '',
    '| 지표 | 두 가정의 최대 | 7조합의 최대 | 조합·행 |',
    '| --- | ---: | ---: | --- |',
  );
  for (const [label, pick] of metrics332) {
    const a = Math.max(...inside332.map(pick));
    const b = Math.max(...outside332.map(pick));
    const where =
      b > a
        ? outside332
            .filter((r) => pick(r) === b)
            .map((r) => `${r.profile}·${r.variant}(${r.line}행)`)
            .join(', ')
        : '7조합에서 더 큰 값 없음';
    body.push(`| ${label} | ${a} | ${b > a ? b : '—'} | ${where} |`);
  }
  body.push(
    '',
    `- 전체 36행은 [원결과](${files332('results.jsonl.gz')})에, 18개 집계는 저장된 [후보 요약](${stored332('candidate-summary.csv')})의 R2 행과 칸마다 같다.`,
    '',
    '## 해석 제한',
    '',
    '- 두 실행은 seed가 고정된 결정적 모형이고, 다시 돌린 행은 저장된 행과 같았다. 새 수치는 없다. 남는 것은 지금 HEAD에 묶인 별도 영수증과 행 대조다. 저장된 실행을 덮거나 새 HEAD의 검증으로 고쳐 적지 않는다(ADR-0129).',
    "- 하나의 직렬 순수 모형이다. 실제 DB·잠금·동시성·재시도는 #131의 범위이고, C5의 서비스 실행은 README의 '#131 서비스 시나리오(C5)'에 따로 있다. R2의 서비스 시나리오는 없다(333-5).",
    '',
  );
  return body;
}

try {
  await main();
} catch (error) {
  if (!(error instanceof Refused)) throw error;
  process.stderr.write(`REFUSED: ${error.message}\n`);
  process.exitCode = 1;
}
