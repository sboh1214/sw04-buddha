import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configOf,
  outcomeOf,
  readReport,
  runInfoOf,
  summarize,
  toMarkdown,
  type Summary,
} from '../../scripts/e2e-summary.mjs';

/**
 * The e2e result summary (#189, ADR-0178; scripts/e2e-summary.mjs): what it counts from the
 * Playwright JSON reports the three configurations write, when it calls a set of results complete,
 * and the command CI's `E2E Results Summary` job runs. The reports here are built in the shape of
 * Playwright 1.62's `json` reporter (config.configFile/shard/projects, suites → specs → tests →
 * results, stats, errors).
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/e2e-summary.mjs', import.meta.url));
const PROJECTS = ['mobile-375', 'desktop-1280'];

type Status = 'expected' | 'unexpected' | 'flaky' | 'skipped';
interface FakeTest {
  project: string;
  file: string;
  title: string;
  status: Status;
  describe?: string;
  line?: number;
  tags?: string[];
  expectedStatus?: 'passed' | 'skipped';
  results?: string[];
}

const RESULTS: Record<Status, string[]> = {
  expected: ['passed'],
  unexpected: ['failed', 'failed', 'failed'],
  flaky: ['failed', 'passed'],
  skipped: ['skipped'],
};

function t(
  project: string,
  title: string,
  status: Status = 'expected',
  extra: Partial<FakeTest> = {},
): FakeTest {
  return { project, file: 'orders.spec.ts', title, status, ...extra };
}

/** A report as the `json` reporter writes it, the specs of a file grouped under their describe. */
function report({
  config = '/runner/work/repo/apps/web/playwright.config.ts',
  shard = null,
  projects = PROJECTS,
  tests = [],
  errors = [],
  duration = 61_234.5,
}: {
  config?: string;
  shard?: { current: number; total: number } | null;
  projects?: string[];
  tests?: FakeTest[];
  errors?: unknown[];
  duration?: number;
} = {}) {
  const spec = (test: FakeTest) => ({
    title: test.title,
    ok: test.status !== 'unexpected',
    tags: test.tags ?? [],
    tests: [
      {
        timeout: 180_000,
        annotations: [],
        expectedStatus: test.expectedStatus ?? (test.status === 'skipped' ? 'skipped' : 'passed'),
        projectId: test.project,
        projectName: test.project,
        results: (test.results ?? RESULTS[test.status]).map((status, retry) => ({
          status,
          retry,
        })),
        status: test.status,
      },
    ],
    id: `${test.project}-${test.title}`,
    file: test.file,
    line: test.line ?? 10,
    column: 7,
  });
  const files = [...new Set(tests.map((test) => test.file))];
  return {
    config: {
      configFile: config,
      rootDir: '/runner/work/repo/apps/web/e2e',
      metadata: {},
      shard,
      projects: projects.map((name) => ({ id: name, name })),
    },
    suites: files.map((file) => {
      const own = tests.filter((test) => test.file === file);
      const describes = [...new Set(own.flatMap((test) => test.describe ?? []))];
      return {
        title: file,
        file,
        line: 0,
        column: 0,
        specs: own.filter((test) => !test.describe).map(spec),
        suites: describes.map((title) => ({
          title,
          file,
          line: 5,
          column: 6,
          specs: own.filter((test) => test.describe === title).map(spec),
        })),
      };
    }),
    errors,
    stats: {
      startTime: '2026-11-27T01:00:00.000Z',
      duration,
      expected: 0,
      skipped: 0,
      unexpected: 0,
      flaky: 0,
    },
  };
}

const run = (value: ReturnType<typeof report>, file = 'result.json') => readReport(value, file);

/** The CI set: six general shards (mobile first, as Playwright orders projects), and the two dedicated configs. */
function ciRuns() {
  const general = [1, 2, 3, 4, 5, 6].map((current) =>
    run(
      report({
        shard: { current, total: 6 },
        tests: [
          t(current <= 3 ? 'mobile-375' : 'desktop-1280', `시험 ${current}-a`, 'expected', {
            describe: '주문',
          }),
          t(
            current <= 3 ? 'mobile-375' : 'desktop-1280',
            `시험 ${current}-b`,
            current === 2 ? 'flaky' : 'expected',
          ),
          ...(current === 5 ? [t('desktop-1280', '데스크톱만', 'skipped')] : []),
        ],
      }),
      `e2e-results-shard-${current}/general-shard-${current}-of-6.json`,
    ),
  );
  const dedicated = (name: string) =>
    run(
      report({
        config: `/runner/work/repo/apps/web/playwright.${name}.config.ts`,
        tests: PROJECTS.map((project) =>
          t(project, `${name} 시나리오`, 'expected', { file: `${name}.spec.ts` }),
        ),
      }),
      `e2e-results-${name}/${name}.json`,
    );
  return [dedicated('treasury'), ...general.reverse(), dedicated('market-maker')];
}

const EXPECT = ['general', 'market-maker', 'treasury'];

describe('outcomeOf — the counts of Playwright’s own summary', () => {
  it.each([
    [{ status: 'expected', results: [{ status: 'passed' }] }, 'passed'],
    [{ status: 'unexpected', results: [{ status: 'failed' }] }, 'failed'],
    [{ status: 'flaky', results: [{ status: 'failed' }, { status: 'passed' }] }, 'flaky'],
    [{ status: 'skipped', expectedStatus: 'skipped', results: [{ status: 'skipped' }] }, 'skipped'],
    [{ status: 'skipped', expectedStatus: 'skipped', results: [] }, 'didNotRun'],
    [{ status: 'skipped', expectedStatus: 'passed', results: [] }, 'didNotRun'],
    [
      { status: 'skipped', expectedStatus: 'passed', results: [{ status: 'skipped' }] },
      'didNotRun',
    ],
    [
      { status: 'skipped', expectedStatus: 'passed', results: [{ status: 'interrupted' }] },
      'interrupted',
    ],
  ])('%j is %s', (test, outcome) => {
    expect(outcomeOf(test)).toBe(outcome);
  });

  it('refuses a status it does not know', () => {
    expect(() => outcomeOf({ status: 'timedOut', results: [] })).toThrow('unknown test status');
  });
});

describe('configOf — the configuration from its file', () => {
  it.each([
    ['/runner/work/repo/apps/web/playwright.config.ts', 'general'],
    ['/runner/work/repo/apps/web/playwright.market-maker.config.ts', 'market-maker'],
    ['playwright.treasury.config.ts', 'treasury'],
    ['custom.config.ts', 'custom.config.ts'],
    [undefined, 'unknown'],
  ])('%s is %s', (file, name) => {
    expect(configOf(file)).toBe(name);
  });
});

describe('readReport', () => {
  it('reads the shard, the projects, the describe titles, the tags and the errors outside tests', () => {
    const one = readReport(
      report({
        shard: { current: 2, total: 6 },
        tests: [
          t('mobile-375', '주문을 낸다 @ac189-1', 'expected', {
            describe: '주문 패널',
            line: 110,
            tags: ['ac189-1'],
          }),
        ],
        errors: [{ message: '\u001b[31mError: global setup failed\u001b[39m\n    at setup.ts:1' }],
      }),
      'e2e-results-shard-2/general-shard-2-of-6.json',
    );
    expect(one).toEqual({
      file: 'e2e-results-shard-2/general-shard-2-of-6.json',
      config: 'general',
      shard: { current: 2, total: 6 },
      projects: PROJECTS,
      startTime: '2026-11-27T01:00:00.000Z',
      durationMs: 61_235,
      errors: ['Error: global setup failed'],
      tests: [
        {
          key: ['mobile-375', 'orders.spec.ts', '주문 패널', '주문을 낸다 @ac189-1'].join('\u001f'),
          project: 'mobile-375',
          file: 'orders.spec.ts',
          line: 110,
          title: '주문 패널 › 주문을 낸다 @ac189-1',
          tags: ['ac189-1'],
          outcome: 'passed',
        },
      ],
    });
  });

  it.each([null, [], { suites: [] }, { config: {}, suites: [], stats: {} }])(
    'refuses what is not a Playwright JSON report (%j)',
    (value) => {
      expect(() => readReport(value, 'x.json')).toThrow('not a Playwright JSON report');
    },
  );
});

describe('summarize', () => {
  it('calls the CI set complete and counts each configuration, each file and every test once', () => {
    const summary = summarize(ciRuns(), {
      expect: EXPECT,
      run: { sha: 'abc123', event: 'push', ref: 'refs/heads/main' },
    });
    expect(summary.problems).toEqual([]);
    expect(summary).toMatchObject({ schema: 1, complete: true, ok: true });
    expect(summary.run).toEqual({
      sha: 'abc123',
      headSha: null,
      ref: 'refs/heads/main',
      event: 'push',
      runId: null,
      runAttempt: null,
      url: null,
    });
    expect(summary.configs).toEqual([
      {
        config: 'general',
        label: '일반 회귀',
        shards: '샤드 6개/6개',
        tests: 13,
        counts: { passed: 11, failed: 0, flaky: 1, skipped: 1, didNotRun: 0, interrupted: 0 },
      },
      {
        config: 'market-maker',
        label: '실제 봇 호가',
        shards: '1회',
        tests: 2,
        counts: { passed: 2, failed: 0, flaky: 0, skipped: 0, didNotRun: 0, interrupted: 0 },
      },
      {
        config: 'treasury',
        label: '부족 금고',
        shards: '1회',
        tests: 2,
        counts: { passed: 2, failed: 0, flaky: 0, skipped: 0, didNotRun: 0, interrupted: 0 },
      },
    ]);
    expect(summary.runs.map((one) => [one.config, one.shard, one.tests, one.durationMs])).toEqual([
      ['general', '1/6', 2, 61_235],
      ['general', '2/6', 2, 61_235],
      ['general', '3/6', 2, 61_235],
      ['general', '4/6', 2, 61_235],
      ['general', '5/6', 3, 61_235],
      ['general', '6/6', 2, 61_235],
      ['market-maker', null, 2, 61_235],
      ['treasury', null, 2, 61_235],
    ]);
    expect(summary.total).toEqual({
      tests: 17,
      passed: 15,
      failed: 0,
      flaky: 1,
      skipped: 1,
      didNotRun: 0,
      interrupted: 0,
      duplicates: 0,
    });
    expect(summary.notPassed).toEqual({
      failed: [],
      flaky: [
        {
          config: 'general',
          shard: '2/6',
          project: 'mobile-375',
          file: 'orders.spec.ts',
          line: 10,
          title: '시험 2-b',
        },
      ],
      interrupted: [],
      didNotRun: [],
    });
    expect(summary.tags).toEqual([]);
  });

  it('is complete but not ok when a test failed, and lists where it failed', () => {
    const runs = ciRuns();
    runs.push(
      run(
        report({
          config: 'playwright.extra.config.ts',
          projects: ['desktop-1280'],
          tests: [
            t('desktop-1280', '깨진 시험', 'unexpected', { file: 'market.spec.ts', line: 841 }),
          ],
        }),
      ),
    );
    const summary = summarize(runs, { expect: [...EXPECT, 'extra'] });
    expect(summary).toMatchObject({ complete: true, ok: false, problems: [] });
    expect(summary.total.failed).toBe(1);
    expect(summary.notPassed.failed).toEqual([
      {
        config: 'extra',
        shard: null,
        project: 'desktop-1280',
        file: 'market.spec.ts',
        line: 841,
        title: '깨진 시험',
      },
    ]);
  });

  it('names a missing shard, a missing and an unexpected configuration', () => {
    const runs = ciRuns().filter(
      (one) => one.config !== 'treasury' && !(one.config === 'general' && one.shard?.current === 4),
    );
    runs.push(
      run(report({ config: 'playwright.old.config.ts', tests: [t('mobile-375', '옛 시험')] })),
    );
    const summary = summarize(runs, { expect: EXPECT });
    expect(summary.complete).toBe(false);
    expect(summary.ok).toBe(false);
    expect(summary.problems).toEqual([
      '부족 금고(treasury): 결과 파일이 없다',
      '일반 회귀: 샤드 4/6의 결과가 없다',
      'old: 예상하지 않은 구성의 결과다',
      'old: 프로젝트 desktop-1280의 시험이 없다',
    ]);
    expect(summary.configs.map((one) => [one.config, one.shards])).toEqual([
      ['general', '샤드 5개/6개'],
      ['market-maker', '1회'],
      ['old', '1회'],
    ]);
  });

  it('names a shard read twice, shard counts that differ and sharded results beside an unsharded one', () => {
    const shard = (current: number, total: number) =>
      run(
        report({
          shard: { current, total },
          tests: PROJECTS.map((p) => t(p, `시험 ${current}/${total}`)),
        }),
      );
    expect(summarize([shard(1, 2), shard(2, 2), shard(2, 2)]).problems).toEqual([
      '일반 회귀: 샤드 2/2의 결과가 2개다',
      '같은 시험이 결과 파일 둘 이상에 있다: 2개',
    ]);
    expect(summarize([shard(1, 2), shard(2, 2), shard(1, 3)]).problems).toEqual([
      '일반 회귀: 샤드 수가 다른 결과가 섞여 있다(2·3)',
    ]);
    const whole = run(report({ tests: PROJECTS.map((p) => t(p, '전체')) }));
    expect(summarize([shard(1, 2), shard(2, 2), whole]).problems).toEqual([
      '일반 회귀: 샤드로 나눈 결과와 나누지 않은 결과가 섞여 있다',
    ]);
  });

  it('accepts unsharded results split by project (a local run per project) and names a missing project', () => {
    const mobile = run(report({ tests: [t('mobile-375', '시험')] }), 'mobile-375.json');
    const desktop = run(report({ tests: [t('desktop-1280', '시험')] }), 'desktop-1280.json');
    expect(summarize([mobile, desktop], { expect: ['general'] })).toMatchObject({
      complete: true,
      ok: true,
      configs: [{ config: 'general', shards: '2회', tests: 2 }],
    });
    expect(summarize([mobile], { expect: ['general'] }).problems).toEqual([
      '일반 회귀: 프로젝트 desktop-1280의 시험이 없다',
    ]);
  });

  it('counts a test in two files once, at its worse outcome, and calls it incomplete', () => {
    const passed = run(
      report({ tests: [t('mobile-375', '같은 시험'), t('desktop-1280', '같은 시험')] }),
      'a.json',
    );
    const failed = run(report({ tests: [t('mobile-375', '같은 시험', 'unexpected')] }), 'b.json');
    const summary = summarize([passed, failed]);
    expect(summary.total).toMatchObject({ tests: 2, passed: 1, failed: 1, duplicates: 1 });
    expect(summary.configs[0]).toMatchObject({ tests: 2, counts: { passed: 1, failed: 1 } });
    expect(summary.problems).toEqual(['같은 시험이 결과 파일 둘 이상에 있다: 1개']);
    expect(summary).toMatchObject({ complete: false, ok: false });
  });

  it('names an error outside the tests, a file without tests, interrupted and not-run tests', () => {
    const summary = summarize([
      run(
        report({
          shard: { current: 1, total: 2 },
          tests: [
            t('mobile-375', '돌던 시험', 'skipped', {
              expectedStatus: 'passed',
              results: ['interrupted'],
            }),
            t('mobile-375', '남은 시험', 'skipped', { expectedStatus: 'passed', results: [] }),
            t('desktop-1280', '돈 시험'),
          ],
          errors: [{ message: 'Timed out waiting 240000ms from config.webServer.' }],
        }),
      ),
      run(report({ shard: { current: 2, total: 2 }, tests: [] }), 'empty.json'),
    ]);
    expect(summary.problems).toEqual([
      '일반 회귀 1/2: 시험 밖 오류 — Timed out waiting 240000ms from config.webServer.',
      '일반 회귀 2/2: 시험이 없다(empty.json)',
      '중단된 시험이 있다: 1개',
      '돌지 않은 시험이 있다: 1개',
    ]);
    expect(summary.notPassed.interrupted.map((one) => one.title)).toEqual(['돌던 시험']);
    expect(summary.notPassed.didNotRun.map((one) => one.title)).toEqual(['남은 시험']);
  });

  it('has no configuration and one problem without any result file', () => {
    expect(summarize([], { expect: EXPECT, problems: ['없는 경로다: e2e-results'] })).toMatchObject(
      {
        complete: false,
        configs: [],
        problems: [
          '없는 경로다: e2e-results',
          '결과 파일이 하나도 없다',
          '일반 회귀(general): 결과 파일이 없다',
          '실제 봇 호가(market-maker): 결과 파일이 없다',
          '부족 금고(treasury): 결과 파일이 없다',
        ],
      },
    );
  });

  it('tables the acceptance tags in numeric order, each test once, and only the prefix asked for', () => {
    const tagged = run(
      report({
        tests: [
          ...PROJECTS.map((p) => t(p, '주문 네 경로', 'expected', { tags: ['ac189-1'] })),
          t('mobile-375', '모바일 확인', 'flaky', { tags: ['ac189-5', 'mobile'] }),
          t('desktop-1280', '태그 둘', 'unexpected', { tags: ['ac189-10', 'ac189-2'] }),
          t('desktop-1280', '태그 없음'),
        ],
      }),
    );
    const zero = { passed: 0, failed: 0, flaky: 0, skipped: 0, didNotRun: 0, interrupted: 0 };
    expect(summarize([tagged]).tags).toEqual([
      { tag: 'ac189-1', tests: 2, counts: { ...zero, passed: 2 } },
      { tag: 'ac189-2', tests: 1, counts: { ...zero, failed: 1 } },
      { tag: 'ac189-5', tests: 1, counts: { ...zero, flaky: 1 } },
      { tag: 'ac189-10', tests: 1, counts: { ...zero, failed: 1 } },
    ]);
    expect(summarize([tagged], { tagPrefix: 'mobile' }).tags).toEqual([
      { tag: 'mobile', tests: 1, counts: { ...zero, flaky: 1 } },
    ]);
  });
});

describe('runInfoOf', () => {
  it('reads the commit and the run of a GitHub Actions job', () => {
    expect(
      runInfoOf({
        GITHUB_SHA: 'merge-sha',
        E2E_HEAD_SHA: 'head-sha',
        GITHUB_REF: 'refs/pull/9/merge',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'owner/repo',
      }),
    ).toEqual({
      sha: 'merge-sha',
      headSha: 'head-sha',
      ref: 'refs/pull/9/merge',
      event: 'pull_request',
      runId: '123',
      runAttempt: '2',
      url: 'https://github.com/owner/repo/actions/runs/123/attempts/2',
    });
  });

  it('has nothing outside one (and an empty head is none)', () => {
    expect(runInfoOf({ E2E_HEAD_SHA: '' })).toEqual({
      sha: null,
      headSha: null,
      ref: null,
      event: null,
      runId: null,
      runAttempt: null,
      url: null,
    });
  });
});

describe('toMarkdown', () => {
  it('heads a passing run with its commit, run and verdict, then the tables', () => {
    const markdown = toMarkdown(
      summarize(ciRuns(), {
        expect: EXPECT,
        run: runInfoOf({
          GITHUB_SHA: 'abc123',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_EVENT_NAME: 'push',
          GITHUB_RUN_ID: '45',
          GITHUB_RUN_ATTEMPT: '1',
          GITHUB_SERVER_URL: 'https://github.com',
          GITHUB_REPOSITORY: 'owner/repo',
        }),
      }),
    );
    const lines = markdown.split('\n');
    expect(lines.slice(0, 6)).toEqual([
      '## E2E 결과 요약',
      '',
      '- 시험한 커밋: `abc123`',
      '- 사건: push · refs/heads/main',
      '- [실행 45 시도 1](https://github.com/owner/repo/actions/runs/45/attempts/1)',
      '- 판정: **통과**',
    ]);
    expect(lines).toContain(
      '| 일반 회귀 (`general`) | 샤드 6개/6개 | 13 | 11 | 0 | 1 | 1 | 0 | 0 |',
    );
    expect(lines).toContain('| **중복 없는 합계** | | 17 | 15 | 0 | 1 | 1 | 0 | 0 |');
    expect(lines).toContain('| 일반 회귀 | 5/6 | 3 | 2 | 0 | 0 | 1 | 0 | 0 | 1.0 |');
    expect(lines).toContain('| 부족 금고 | — | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 1.0 |');
    expect(lines).toContain('태그가 붙은 시험이 없다.');
    expect(lines).toContain('- flaky(재시도로 통과) 1개');
    expect(markdown).not.toContain('불완전');
  });

  it('says failed and incomplete, lists at most twenty of a kind and keeps titles inline', () => {
    const many = Array.from({ length: 23 }, (_, index) =>
      t('mobile-375', `실패 ${index} <b>|</b>\n둘째 줄`, 'unexpected'),
    );
    const markdown = toMarkdown(
      summarize([run(report({ tests: many }))], {
        expect: EXPECT,
        run: { headSha: 'head', sha: 'merge' },
      }),
    );
    expect(markdown).toContain('- 시험한 커밋: `merge` — PR head `head`의 병합 커밋');
    expect(markdown).toContain('- 판정: **실패 23개 · 불완전**');
    expect(markdown).toContain('- 실패 23개');
    expect(markdown).toContain(
      '  - [mobile-375] orders.spec.ts:10 › 실패 0 &lt;b>\\|&lt;/b> 둘째 줄 (일반 회귀)',
    );
    expect(markdown).not.toContain('실패 20 ');
    expect(markdown).toContain('  - 그 밖에 3개(e2e-summary.json)');
    expect(markdown).toContain('### 불완전한 까닭');
    expect(markdown).toContain('- 부족 금고(treasury): 결과 파일이 없다');
  });
});

describe('the command (CI: E2E Results Summary)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** The downloaded artifacts: one folder per job, as actions/download-artifact lays them out. */
  function artifacts(runs: { folder: string; file: string; value: unknown }[]) {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-summary-'));
    dirs.push(root);
    for (const { folder, file, value } of runs) {
      mkdirSync(path.join(root, 'e2e-results', folder), { recursive: true });
      writeFileSync(
        path.join(root, 'e2e-results', folder, file),
        typeof value === 'string' ? value : JSON.stringify(value),
      );
    }
    return root;
  }

  const shardFiles = (total: number, skip: number[] = []) =>
    Array.from({ length: total }, (_, index) => index + 1)
      .filter((current) => !skip.includes(current))
      .map((current) => ({
        folder: `e2e-results-shard-${current}`,
        file: `general-shard-${current}-of-${total}.json`,
        value: report({
          shard: { current, total },
          tests: PROJECTS.map((p) => t(p, `시험 ${current}`)),
        }),
      }));

  /** The run variables the script reads: a CI job's own must not reach the script under test. */
  const RUN_VARIABLES = [
    'GITHUB_SHA',
    'E2E_HEAD_SHA',
    'GITHUB_REF',
    'GITHUB_EVENT_NAME',
    'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT',
    'GITHUB_SERVER_URL',
    'GITHUB_REPOSITORY',
  ];

  function summarizeIn(
    root: string,
    args: string[],
    env: Record<string, string> = {},
    script = SCRIPT,
  ) {
    const result = spawnSync(process.execPath, [script, '--out', 'out', ...args], {
      cwd: root,
      env: {
        ...process.env,
        ...Object.fromEntries(RUN_VARIABLES.map((name) => [name, ''])),
        ...env,
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    const read = (file: string) => readFileSync(path.join(root, 'out', file), 'utf8');
    return { result, read };
  }

  it('writes the JSON and the Markdown of the folders it is given and prints the Markdown', () => {
    const root = artifacts(shardFiles(2));
    const { result, read } = summarizeIn(root, ['--expect', 'general', 'e2e-results'], {
      GITHUB_SHA: 'abc123',
      GITHUB_EVENT_NAME: 'push',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const summary = JSON.parse(read('e2e-summary.json')) as Summary;
    expect(summary).toMatchObject({
      complete: true,
      ok: true,
      run: { sha: 'abc123', event: 'push' },
    });
    expect(summary.runs.map((one) => one.file)).toEqual([
      'e2e-results-shard-1/general-shard-1-of-2.json',
      'e2e-results-shard-2/general-shard-2-of-2.json',
    ]);
    expect(read('e2e-summary.md')).toBe(toMarkdown(summary));
    expect(result.stdout).toContain('- 시험한 커밋: `abc123`');
  });

  it('fails with --require-complete only when incomplete, after writing the summary', () => {
    const root = artifacts(shardFiles(3, [2]));
    const incomplete = summarizeIn(root, [
      '--require-complete',
      '--expect',
      'general',
      'e2e-results',
    ]);
    expect(incomplete.result.status).toBe(1);
    expect(incomplete.result.stderr).toContain('- 일반 회귀: 샤드 2/3의 결과가 없다');
    expect((JSON.parse(incomplete.read('e2e-summary.json')) as Summary).complete).toBe(false);
    expect(summarizeIn(root, ['--expect', 'general', 'e2e-results']).result.status).toBe(0);

    const whole = artifacts(shardFiles(3));
    expect(summarizeIn(whole, ['--require-complete', 'e2e-results']).result.status).toBe(0);
  });

  it('runs when called through a symlinked path (macOS’s /tmp is one), not silently nothing', () => {
    const root = artifacts(shardFiles(1));
    const link = path.join(root, 'linked-e2e-summary.mjs');
    symlinkSync(SCRIPT, link);
    const { result, read } = summarizeIn(root, ['e2e-results'], {}, link);
    expect(result.status).toBe(0);
    expect((JSON.parse(read('e2e-summary.json')) as Summary).total.tests).toBe(2);
  });

  it('summarizes a folder that is not there and a file it cannot read as problems', () => {
    const root = artifacts([
      ...shardFiles(1),
      { folder: 'e2e-results-treasury', file: 'treasury.json', value: '{"config": ' },
    ]);
    const { result, read } = summarizeIn(root, ['--sha', 'local', 'e2e-results', 'missing']);
    expect(result.status).toBe(0);
    const summary = JSON.parse(read('e2e-summary.json')) as Summary;
    expect(summary.run.sha).toBe('local');
    expect(summary.problems).toHaveLength(2);
    expect(summary.problems[0]).toMatch(
      /^읽을 수 없는 결과 파일이다: e2e-results-treasury\/treasury\.json — /,
    );
    expect(summary.problems[1]).toBe('없는 경로다: missing');
  });

  it.each([[[]], [['--bogus', 'e2e-results']], [['--expect']]])(
    'exits 2 on a usage error (%j)',
    (args) => {
      const root = artifacts([]);
      const { result } = summarizeIn(root, args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('usage: node apps/web/scripts/e2e-summary.mjs');
    },
  );
});
