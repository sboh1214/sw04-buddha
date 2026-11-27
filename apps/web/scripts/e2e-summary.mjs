// @ts-check
// One summary of the e2e results (#189, ADR-0178): reads the Playwright JSON reports the e2e
// configurations write (playwright.config.ts `e2eReporters`, one per configuration and shard) and
// writes e2e-summary.json and e2e-summary.md — the commit, each configuration's and each result
// file's passed / failed / flaky / skipped, the totals with every test counted once, the
// `@ac189-N` tags and the tests that did not pass. Both are small enough to commit as evidence.
//
//   node apps/web/scripts/e2e-summary.mjs [--expect <config>]... [--out <dir>] [--sha <sha>]
//     [--require-complete] <result file or folder>...
//
// A folder is read recursively for *.json. The summary is complete when every expected
// configuration (`--expect`, and no other) has its results — all shards 1..n of a sharded one and
// every configured project — with no error outside a test, no interrupted or not-run test, no test
// in two files and no unreadable file. Failed tests never change the exit code: the e2e jobs
// already fail the run. It exits 1 only with `--require-complete` on an incomplete summary (after
// writing it) and 2 on a usage error. The commit and the run come from the GitHub Actions
// variables (`--sha` overrides the commit); `--out` defaults to ./e2e-summary.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** @typedef {'passed' | 'failed' | 'flaky' | 'skipped' | 'didNotRun' | 'interrupted'} Outcome */
/** @typedef {Record<Outcome, number>} Counts */
/**
 * One test of one project in one result file.
 * @typedef {object} TestRow
 * @property {string} key project, file and title path: the same test in another file has the same key
 * @property {string} project
 * @property {string} file the spec file, relative to the test directory
 * @property {number} line
 * @property {string} title the describe titles and the test title, joined by ' › '
 * @property {string[]} tags without '@'
 * @property {Outcome} outcome
 */
/**
 * One result file.
 * @typedef {object} Run
 * @property {string} file where it was read, relative to the folder given
 * @property {string} config
 * @property {{ current: number, total: number } | null} shard
 * @property {string[]} projects the configuration's projects
 * @property {string | null} startTime
 * @property {number | null} durationMs
 * @property {string[]} errors the first line of each error outside a test (global setup, servers)
 * @property {TestRow[]} tests
 */
/**
 * @typedef {object} RunInfo
 * @property {string | null} sha the commit the jobs checked out and tested
 * @property {string | null} headSha a pull request's head (a pull request's run tests its merge commit)
 * @property {string | null} ref
 * @property {string | null} event
 * @property {string | null} runId
 * @property {string | null} runAttempt
 * @property {string | null} url
 */
/**
 * @typedef {object} Entry
 * @property {string} config
 * @property {string | null} shard
 * @property {string} project
 * @property {string} file
 * @property {number} line
 * @property {string} title
 */
/**
 * @typedef {object} ConfigLine
 * @property {string} config
 * @property {string} label
 * @property {string} shards
 * @property {number} tests
 * @property {Counts} counts
 */
/**
 * @typedef {object} RunLine
 * @property {string} config
 * @property {string} label
 * @property {string | null} shard
 * @property {string} file
 * @property {string | null} startTime
 * @property {number | null} durationMs
 * @property {number} tests
 * @property {Counts} counts
 * @property {string[]} errors
 */
/**
 * @typedef {object} Summary
 * @property {1} schema
 * @property {RunInfo} run
 * @property {boolean} complete
 * @property {boolean} ok complete, and no test failed
 * @property {string[]} problems why it is not complete
 * @property {ConfigLine[]} configs each configuration, its tests counted once
 * @property {RunLine[]} runs each result file
 * @property {Counts & { tests: number, duplicates: number }} total every test counted once
 * @property {{ tag: string, tests: number, counts: Counts }[]} tags
 * @property {Record<'failed' | 'flaky' | 'interrupted' | 'didNotRun', Entry[]>} notPassed
 */

/** @type {readonly Outcome[]} */
export const OUTCOMES = ['passed', 'failed', 'flaky', 'skipped', 'didNotRun', 'interrupted'];

/** When the same test is in two files, the first of these it has is the one counted. */
const SEVERITY = /** @type {const} */ ([
  'failed',
  'interrupted',
  'didNotRun',
  'flaky',
  'passed',
  'skipped',
]);

/** The configurations' names (playwright.config.ts `e2eReporters`) and their names in the docs. */
const LABELS = /** @type {Record<string, string>} */ ({
  general: '일반 회귀',
  'market-maker': '실제 봇 호가',
  treasury: '부족 금고',
});

const DEFAULT_TAG_PREFIX = 'ac189-';

/** How many tests of each kind the Markdown lists; the JSON has them all. */
const LISTED = 20;

/** @returns {Counts} */
function zero() {
  return { passed: 0, failed: 0, flaky: 0, skipped: 0, didNotRun: 0, interrupted: 0 };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A test's outcome the way Playwright's own summary counts it (`generateSummary` of its base
 * reporter): the JSON report's `skipped` also holds the interrupted and the not-run tests.
 * @param {Record<string, any>} test a `tests[]` entry of a JSON report's spec
 * @returns {Outcome}
 */
export function outcomeOf(test) {
  /** @type {Record<string, any>[]} */
  const results = Array.isArray(test.results) ? test.results : [];
  switch (test.status) {
    case 'expected':
      return 'passed';
    case 'unexpected':
      return 'failed';
    case 'flaky':
      return 'flaky';
    case 'skipped':
      if (results.some((result) => result.status === 'interrupted')) return 'interrupted';
      if (!results.length || test.expectedStatus !== 'skipped') return 'didNotRun';
      return 'skipped';
    default:
      throw new Error(`unknown test status: ${String(test.status)}`);
  }
}

/**
 * The configuration's name from its file: `playwright.config.ts` is `general`,
 * `playwright.<name>.config.ts` is `<name>`.
 * @param {unknown} configFile
 * @returns {string}
 */
export function configOf(configFile) {
  if (typeof configFile !== 'string' || !configFile) return 'unknown';
  const base = path.basename(configFile);
  if (/^playwright\.config\.[cm]?[jt]s$/.test(base)) return 'general';
  return base.match(/^playwright\.(.+)\.config\.[cm]?[jt]s$/)?.[1] ?? base;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function firstLine(error) {
  const text = isObject(error) ? (error.message ?? error.value ?? '') : error;
  return (
    String(text)
      // eslint-disable-next-line no-control-regex -- the ANSI colours of Playwright's messages
      .replace(/\u001b\[[0-9;]*m/g, '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean)
      ?.slice(0, 200) ?? '(no message)'
  );
}

/**
 * Reads one Playwright JSON report (the `json` reporter's file).
 * @param {unknown} report the parsed file
 * @param {string} file where it was read, for the summary
 * @returns {Run}
 */
export function readReport(report, file) {
  if (
    !isObject(report) ||
    !isObject(report.config) ||
    !Array.isArray(report.suites) ||
    !isObject(report.stats) ||
    !Array.isArray(report.errors)
  ) {
    throw new Error('not a Playwright JSON report');
  }
  const { config, stats } = report;
  const shard =
    isObject(config.shard) &&
    Number.isInteger(config.shard.current) &&
    Number.isInteger(config.shard.total)
      ? { current: Number(config.shard.current), total: Number(config.shard.total) }
      : null;
  /** @type {TestRow[]} */
  const tests = [];
  /**
   * @param {Record<string, any>} suite
   * @param {string[]} titles the describe titles above its specs
   */
  const walk = (suite, titles) => {
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      const title = [...titles, String(spec.title)];
      for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
        const project = String(test.projectName ?? '');
        tests.push({
          key: [project, String(spec.file), ...title].join('\u001f'),
          project,
          file: String(spec.file),
          line: Number(spec.line) || 0,
          title: title.join(' › '),
          tags: Array.isArray(spec.tags) ? spec.tags.map(String) : [],
          outcome: outcomeOf(test),
        });
      }
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) {
      walk(child, [...titles, String(child.title)]);
    }
  };
  // The top suites are the spec files; their titles are the file names, not describe titles.
  for (const fileSuite of report.suites) walk(fileSuite, []);
  /** @type {unknown[]} */
  const projects = Array.isArray(config.projects) ? config.projects : [];
  return {
    file,
    config: configOf(config.configFile),
    shard,
    projects: projects.map((project) => (isObject(project) ? String(project.name) : '')),
    startTime: typeof stats.startTime === 'string' ? stats.startTime : null,
    durationMs: typeof stats.duration === 'number' ? Math.round(stats.duration) : null,
    errors: report.errors.map(firstLine),
    tests,
  };
}

/**
 * @param {{ current: number, total: number } | null} shard
 * @returns {string | null}
 */
function shardText(shard) {
  return shard ? `${shard.current}/${shard.total}` : null;
}

/**
 * @param {string} config
 * @returns {string}
 */
function labelOf(config) {
  return LABELS[config] ?? config;
}

/**
 * Each test once (by key), at its most severe outcome when it is in more than one file.
 * @param {TestRow[]} rows
 * @returns {Map<string, TestRow>}
 */
function unique(rows) {
  /** @type {Map<string, TestRow>} */
  const byKey = new Map();
  for (const row of rows) {
    const seen = byKey.get(row.key);
    if (!seen || SEVERITY.indexOf(row.outcome) < SEVERITY.indexOf(seen.outcome)) {
      byKey.set(row.key, row);
    }
  }
  return byKey;
}

/**
 * @param {Iterable<TestRow>} rows
 * @returns {Counts}
 */
function countsOf(rows) {
  const counts = zero();
  for (const row of rows) counts[row.outcome] += 1;
  return counts;
}

/**
 * @param {Run[]} runs
 * @param {object} [options]
 * @param {string[]} [options.expect] the configurations there must be results of, and no other
 * @param {Partial<RunInfo>} [options.run]
 * @param {string} [options.tagPrefix] the tags to count, `ac189-` by default
 * @param {string[]} [options.problems] those found before (unreadable files, missing folders)
 * @returns {Summary}
 */
export function summarize(runs, options = {}) {
  const expect = options.expect ?? [];
  const tagPrefix = options.tagPrefix ?? DEFAULT_TAG_PREFIX;
  const problems = [...(options.problems ?? [])];
  const configNames = [
    ...expect.filter((config) => runs.some((run) => run.config === config)),
    ...[...new Set(runs.map((run) => run.config))].filter((c) => !expect.includes(c)).sort(),
  ];
  const ordered = [...runs].sort(
    (a, b) =>
      configNames.indexOf(a.config) - configNames.indexOf(b.config) ||
      (a.shard?.current ?? 0) - (b.shard?.current ?? 0) ||
      a.file.localeCompare(b.file),
  );

  if (!runs.length) problems.push('결과 파일이 하나도 없다');
  for (const config of expect) {
    if (!runs.some((run) => run.config === config)) {
      problems.push(`${labelOf(config)}(${config}): 결과 파일이 없다`);
    }
  }

  /** @type {ConfigLine[]} */
  const configs = configNames.map((config) => {
    const label = labelOf(config);
    const own = ordered.filter((run) => run.config === config);
    if (expect.length && !expect.includes(config)) {
      problems.push(`${label}: 예상하지 않은 구성의 결과다`);
    }
    const sharded = own.filter((run) => run.shard);
    const totals = [...new Set(sharded.map((run) => run.shard?.total ?? 0))];
    let shards = `${own.length}회`;
    if (sharded.length && sharded.length < own.length) {
      problems.push(`${label}: 샤드로 나눈 결과와 나누지 않은 결과가 섞여 있다`);
    } else if (totals.length > 1) {
      problems.push(`${label}: 샤드 수가 다른 결과가 섞여 있다(${totals.join('·')})`);
    } else if (totals.length === 1) {
      const total = totals[0] ?? 0;
      shards = `샤드 ${new Set(sharded.map((run) => run.shard?.current)).size}개/${total}개`;
      for (let current = 1; current <= total; current += 1) {
        const found = sharded.filter((run) => run.shard?.current === current).length;
        if (!found) problems.push(`${label}: 샤드 ${current}/${total}의 결과가 없다`);
        if (found > 1) problems.push(`${label}: 샤드 ${current}/${total}의 결과가 ${found}개다`);
      }
    }
    const rows = own.flatMap((run) => run.tests);
    const seenProjects = new Set(rows.map((row) => row.project));
    for (const project of new Set(own.flatMap((run) => run.projects))) {
      if (!seenProjects.has(project)) problems.push(`${label}: 프로젝트 ${project}의 시험이 없다`);
    }
    const byKey = unique(rows);
    return { config, label, shards, tests: byKey.size, counts: countsOf(byKey.values()) };
  });

  for (const run of ordered) {
    const where = [labelOf(run.config), shardText(run.shard)].filter(Boolean).join(' ');
    if (!run.tests.length) problems.push(`${where}: 시험이 없다(${run.file})`);
    for (const error of run.errors) problems.push(`${where}: 시험 밖 오류 — ${error}`);
  }

  const all = ordered.flatMap((run) => run.tests.map((test) => ({ run, test })));
  const byKey = unique(all.map(({ test }) => test));
  const total = {
    tests: byKey.size,
    ...countsOf(byKey.values()),
    duplicates: all.length - byKey.size,
  };
  if (total.duplicates) {
    problems.push(`같은 시험이 결과 파일 둘 이상에 있다: ${total.duplicates}개`);
  }
  if (total.interrupted) problems.push(`중단된 시험이 있다: ${total.interrupted}개`);
  if (total.didNotRun) problems.push(`돌지 않은 시험이 있다: ${total.didNotRun}개`);

  /** @type {Map<string, TestRow[]>} */
  const tagged = new Map();
  for (const row of byKey.values()) {
    for (const tag of row.tags.filter((t) => t.startsWith(tagPrefix))) {
      tagged.set(tag, [...(tagged.get(tag) ?? []), row]);
    }
  }
  const tags = [...tagged.keys()]
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((tag) => {
      const rows = tagged.get(tag) ?? [];
      return { tag, tests: rows.length, counts: countsOf(rows) };
    });

  /** @type {Summary['notPassed']} */
  const notPassed = { failed: [], flaky: [], interrupted: [], didNotRun: [] };
  for (const { run, test } of all) {
    if (test.outcome === 'passed' || test.outcome === 'skipped') continue;
    notPassed[test.outcome].push({
      config: run.config,
      shard: shardText(run.shard),
      project: test.project,
      file: test.file,
      line: test.line,
      title: test.title,
    });
  }

  const complete = problems.length === 0;
  return {
    schema: 1,
    run: {
      sha: options.run?.sha ?? null,
      headSha: options.run?.headSha ?? null,
      ref: options.run?.ref ?? null,
      event: options.run?.event ?? null,
      runId: options.run?.runId ?? null,
      runAttempt: options.run?.runAttempt ?? null,
      url: options.run?.url ?? null,
    },
    complete,
    ok: complete && total.failed === 0,
    problems,
    configs,
    runs: ordered.map((run) => ({
      config: run.config,
      label: labelOf(run.config),
      shard: shardText(run.shard),
      file: run.file,
      startTime: run.startTime,
      durationMs: run.durationMs,
      tests: run.tests.length,
      counts: countsOf(run.tests),
      errors: run.errors,
    })),
    total,
    tags,
    notPassed,
  };
}

/**
 * The run of the GitHub Actions job this is in, from its default variables (and `E2E_HEAD_SHA`,
 * which the workflow sets to a pull request's head).
 * @param {Record<string, string | undefined>} env
 * @returns {RunInfo}
 */
export function runInfoOf(env) {
  /** @param {string} name */
  const value = (name) => env[name] || null;
  const runId = value('GITHUB_RUN_ID');
  const server = value('GITHUB_SERVER_URL');
  const repository = value('GITHUB_REPOSITORY');
  const attempt = value('GITHUB_RUN_ATTEMPT');
  return {
    sha: value('GITHUB_SHA'),
    headSha: value('E2E_HEAD_SHA'),
    ref: value('GITHUB_REF'),
    event: value('GITHUB_EVENT_NAME'),
    runId,
    runAttempt: attempt,
    url:
      runId && server && repository
        ? `${server}/${repository}/actions/runs/${runId}${attempt ? `/attempts/${attempt}` : ''}`
        : null,
  };
}

/**
 * Text for one Markdown line or table cell.
 * @param {string} text
 * @returns {string}
 */
function inline(text) {
  return text.replace(/\s+/g, ' ').replace(/</g, '&lt;').replace(/\|/g, '\\|');
}

/**
 * @param {Counts} counts
 * @returns {string}
 */
function countCells(counts) {
  return OUTCOMES.map((outcome) => String(counts[outcome])).join(' | ');
}

const COUNT_HEADER = 'passed | failed | flaky | skipped | did not run | interrupted';

/**
 * @param {number} columns the number columns after the first ones
 * @param {number} [texts] the text columns first
 * @returns {string}
 */
function ruler(columns, texts = 1) {
  return `|${' --- |'.repeat(texts)}${' ---: |'.repeat(columns)}`;
}

/**
 * @param {Summary} summary
 * @returns {string}
 */
export function toMarkdown(summary) {
  const { run, total } = summary;
  const lines = ['## E2E 결과 요약', ''];
  const sha = run.sha ? `\`${run.sha}\`` : '알 수 없음';
  const head = run.headSha ? ` — PR head \`${run.headSha}\`의 병합 커밋` : '';
  lines.push(`- 시험한 커밋: ${sha}${head}`);
  if (run.event || run.ref)
    lines.push(`- 사건: ${[run.event, run.ref].filter(Boolean).join(' · ')}`);
  if (run.runId) {
    const text = `실행 ${run.runId}${run.runAttempt ? ` 시도 ${run.runAttempt}` : ''}`;
    lines.push(`- ${run.url ? `[${text}](${run.url})` : text}`);
  }
  /** @type {string[]} */
  const verdict = [];
  if (total.failed) verdict.push(`실패 ${total.failed}개`);
  if (!summary.complete) verdict.push('불완전');
  lines.push(`- 판정: **${verdict.length ? verdict.join(' · ') : '통과'}**`, '');

  lines.push('### 구성별', '', `| 구성 | 실행 | 시험 | ${COUNT_HEADER} |`, ruler(7, 2));
  for (const config of summary.configs) {
    lines.push(
      `| ${inline(config.label)} (\`${config.config}\`) | ${config.shards} | ${config.tests} | ${countCells(config.counts)} |`,
    );
  }
  lines.push(`| **중복 없는 합계** | | ${total.tests} | ${countCells(total)} |`, '');

  lines.push(
    '### 결과 파일별',
    '',
    `| 구성 | 샤드 | 시험 | ${COUNT_HEADER} | 실행 시간(분) |`,
    ruler(8, 2),
  );
  for (const one of summary.runs) {
    const minutes = one.durationMs === null ? '' : (one.durationMs / 60_000).toFixed(1);
    lines.push(
      `| ${inline(one.label)} | ${one.shard ?? '—'} | ${one.tests} | ${countCells(one.counts)} | ${minutes} |`,
    );
  }
  lines.push('');

  lines.push('### 수용 기준 태그', '');
  if (summary.tags.length) {
    lines.push(`| 태그 | 시험 | ${COUNT_HEADER} |`, ruler(7));
    for (const tag of summary.tags) {
      lines.push(`| \`@${tag.tag}\` | ${tag.tests} | ${countCells(tag.counts)} |`);
    }
  } else {
    lines.push('태그가 붙은 시험이 없다.');
  }
  lines.push('');

  const kinds = /** @type {const} */ ([
    ['failed', '실패'],
    ['flaky', 'flaky(재시도로 통과)'],
    ['interrupted', '중단됨'],
    ['didNotRun', '돌지 않음'],
  ]);
  const listed = kinds.filter(([kind]) => summary.notPassed[kind].length);
  if (listed.length) {
    lines.push('### 통과하지 못한 시험', '');
    for (const [kind, name] of listed) {
      const entries = summary.notPassed[kind];
      lines.push(`- ${name} ${entries.length}개`);
      for (const entry of entries.slice(0, LISTED)) {
        const where = [labelOf(entry.config), entry.shard].filter(Boolean).join(' ');
        lines.push(
          `  - [${inline(entry.project)}] ${inline(entry.file)}:${entry.line} › ${inline(entry.title)} (${inline(where)})`,
        );
      }
      if (entries.length > LISTED) {
        lines.push(`  - 그 밖에 ${entries.length - LISTED}개(e2e-summary.json)`);
      }
    }
    lines.push('');
  }

  if (summary.problems.length) {
    lines.push('### 불완전한 까닭', '');
    for (const problem of summary.problems) lines.push(`- ${inline(problem)}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The result files under the inputs, each named by its path inside the folder given, and the
 * inputs that are not there or cannot be read.
 * @param {string[]} inputs files or folders
 * @returns {{ runs: Run[], problems: string[] }}
 */
export function readInputs(inputs) {
  /** @type {Run[]} */
  const runs = [];
  /** @type {string[]} */
  const problems = [];
  for (const input of inputs) {
    if (!existsSync(input)) {
      problems.push(`없는 경로다: ${path.basename(input)}`);
      continue;
    }
    const files = statSync(input).isDirectory()
      ? readdirSync(input, { recursive: true, encoding: 'utf8' })
          .filter((name) => name.endsWith('.json'))
          .sort()
          .map((name) => ({ full: path.join(input, name), shown: name.split(path.sep).join('/') }))
      : [{ full: input, shown: path.basename(input) }];
    for (const { full, shown } of files) {
      if (!statSync(full).isFile()) continue;
      try {
        runs.push(readReport(JSON.parse(readFileSync(full, 'utf8')), shown));
      } catch (error) {
        problems.push(`읽을 수 없는 결과 파일이다: ${shown} — ${firstLine(error)}`);
      }
    }
  }
  return { runs, problems };
}

const USAGE =
  'usage: node apps/web/scripts/e2e-summary.mjs [--expect <config>]... [--out <dir>] ' +
  '[--sha <sha>] [--require-complete] <result file or folder>...';

const OPTIONS = /** @type {const} */ ({
  out: { type: 'string' },
  expect: { type: 'string', multiple: true },
  sha: { type: 'string' },
  'require-complete': { type: 'boolean' },
});

/**
 * @param {string[]} argv the arguments after the script
 * @param {Record<string, string | undefined>} env
 * @returns {number} the exit code
 */
export function main(argv, env) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    console.error(`${firstLine(error)}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (!positionals.length) {
    console.error(USAGE);
    return 2;
  }
  const { runs, problems } = readInputs(positionals);
  const run = runInfoOf(env);
  const summary = summarize(runs, {
    expect: values.expect ?? [],
    run: values.sha ? { ...run, sha: values.sha } : run,
    problems,
  });
  const markdown = toMarkdown(summary);
  const out = values.out ?? 'e2e-summary';
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'e2e-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(path.join(out, 'e2e-summary.md'), markdown);
  console.log(markdown);
  if (values['require-complete'] && !summary.complete) {
    console.error(`the e2e summary is incomplete:\n- ${summary.problems.join('\n- ')}`);
    return 1;
  }
  return 0;
}

// Run as a script, also through a symlinked path (macOS's /tmp is one): Node's import.meta.url is
// the real path, so compare real paths, not the path as typed.
if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
