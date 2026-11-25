import assert from 'node:assert/strict';
import { format, resolveConfig } from 'prettier';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

/*
 * #332 report: display aggregates of a finished run, never an input to the model. Every number in
 * RESULTS.md is read from the CSVs this script writes next to the results, and each table row names
 * its row of candidate-summary.csv. No threshold, ranking or recommendation is computed.
 */

const directory = resolve(process.argv[2] ?? 'docs/research/332-regrant-simulation/results');
const reportPath = resolve(process.argv[3] ?? resolve(directory, 'RESULTS.md'));
const artifactUrl = (file) =>
  relative(dirname(reportPath), resolve(directory, file))
    .split(sep)
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
const bytes = readFileSync(resolve(directory, 'results.jsonl.gz'));
const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.resultsSha256);
const results = gunzipSync(bytes)
  .toString()
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
assert.equal(results.length, 216);
assert.equal(manifest.expected, 216);
assert.equal(manifest.failed, 0);
assert.equal(manifest.sourceUnchanged, true);
for (const row of results) {
  assert.equal(row.invariants.violations, 0);
  // 금고 회수 = Σ주기 A·m + Σ MM 손익 (the cycle's A·m is minted afresh, 332-1).
  assert.equal(
    BigInt(row.recovery.recoveredCoin) - BigInt(row.issuance.treasuryCoin),
    BigInt(row.bot.pnlCoin),
  );
}

const num = (value) => {
  const n = Number(value);
  assert.ok(Number.isSafeInteger(n), `unsafe ${value}`);
  return n;
};
const sum = (values) => values.reduce((a, b) => a + b, 0);
const pct = (a, b) => (b === 0 ? '자료 없음' : ((100 * a) / b).toFixed(2));
/** Nearest-rank median (the lower of two middles); null for none. */
const median = (sorted) => (sorted.length ? sorted[Math.ceil(sorted.length / 2) - 1] : null);
const days = (ms) => (ms === null ? '없음' : (ms / 86400000).toFixed(2));
const hours = (ms) => (ms === null ? '없음' : (ms / 3600000).toFixed(1));
const REASONS = [
  'not_ready',
  'not_exhausted',
  'live_orders',
  'unsettled_positions',
  'waiting',
  'period_limit',
  'total_cap',
];
const THRESHOLDS = manifest.thresholds.map(String);
const candidates = manifest.candidates.map((c) => c.id);
const profiles = manifest.profiles.map((p) => p.id);
const variants = manifest.variants.map((v) => v.id);
const thresholdOf = (id) => {
  const c = manifest.candidates.find((row) => row.id === id);
  return c.values === null ? null : String(c.values.thresholdCoin);
};

const groups = new Map();
for (const row of results) {
  const key = [row.candidate, row.profile, row.variant].join('/');
  const group = groups.get(key) ?? [];
  group.push(row);
  groups.set(key, group);
}
assert.equal(groups.size, 108);

/** Two seeds pooled: counts as the two-seed mean, ratios from summed parts, extremes over both. */
function aggregate(rows) {
  assert.equal(rows.length, 2);
  const [first] = rows;
  const people = first.people;
  const mean = (pick) => sum(rows.map(pick)) / rows.length;
  const pooled = (pick) => rows.flatMap(pick).sort((a, b) => a - b);
  const grants = pooled((r) =>
    Object.entries(r.recipients.grantCountHistogram).flatMap(([count, n]) =>
      Number(count) > 0 ? Array.from({ length: n }, () => Number(count)) : [],
    ),
  );
  const firstGrant = pooled((r) => r.recipients.firstGrantMs);
  const toGrant = pooled((r) => r.recipients.exhaustToGrantMs);
  const openAge = pooled((r) => r.unfinished.openEpisodeAgeMs);
  const own = thresholdOf(first.candidate);
  const exhaustedAt = Object.fromEntries(
    THRESHOLDS.map((t) => [t, pct(sum(rows.map((r) => r.exhaustion.final[t])), people * 2)]),
  );
  const group = (key) => rows.map((r) => r.groups[key] ?? { people: 0, grants: 0 });
  const stage = (name) => mean((r) => r.bot.stageMs[name]) / 1000;
  return {
    candidate: first.candidate,
    profile: first.profile,
    variant: first.variant,
    people,
    markets: first.markets,
    threshold: own ?? '',
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
    // 순회수: recovery less the A·m every cycle mints afresh = Σ MM PnL = what people lost in trade.
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
    finalExhaustedPct: own === null ? '' : exhaustedAt[own],
    ...Object.fromEntries(THRESHOLDS.map((t) => [`finalExhaustedPctAt${t}`, exhaustedAt[t]])),
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
const order = (row) => [
  candidates.indexOf(row.candidate),
  profiles.indexOf(row.profile),
  variants.indexOf(row.variant),
];
const byOrder = (a, b) => {
  const x = order(a),
    y = order(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};
const summary = [...groups.values()].map(aggregate).sort(byOrder);
const find = (c, p, v) =>
  summary.find((row) => row.candidate === c && row.profile === p && row.variant === v);
// R0 pairs: R0's exhaustion read at the paired candidate's threshold, and the MM / recovery gaps.
for (const row of summary) {
  const control = find('R0', row.profile, row.variant);
  const gap = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : '');
  row.r0FinalExhaustedPct =
    row.threshold === '' ? '' : control[`finalExhaustedPctAt${row.threshold}`];
  row.finalExhaustedPctPointsVsR0 =
    row.threshold === ''
      ? ''
      : (Number(row.finalExhaustedPct) - Number(row.r0FinalExhaustedPct)).toFixed(2);
  row.mmPnlCoinVsR0 = gap(row.mmPnlCoin, control.mmPnlCoin);
  row.recoveredCoinVsR0 = gap(row.recoveredCoin, control.recoveredCoin);
  row.haltMarketSecondsVsR0 = gap(row.haltMarketSeconds, control.haltMarketSeconds);
}
const columns = Object.keys(summary[0]);
const csv = (rows, keys) =>
  [keys.join(','), ...rows.map((row) => keys.map((key) => row[key]).join(','))].join('\n') + '\n';
writeFileSync(resolve(directory, 'candidate-summary.csv'), csv(summary, columns));
const line = (row) => summary.indexOf(row) + 2;

const runs = results
  .map((r) => ({
    candidate: r.candidate,
    profile: r.profile,
    variant: r.variant,
    seed: r.seed,
    people: r.people,
    markets: r.markets,
    regrantCoin: r.issuance.regrantCoin,
    recoveredCoin: r.recovery.recoveredCoin,
    treasuryCoin: r.issuance.treasuryCoin,
    recipients: r.recipients.accounts,
    capReached: r.recipients.capReached,
    requestsSent: r.requests.sent,
    requestsGranted: r.requests.granted,
    unfinishedOpenAtEnd: r.unfinished.openEpisodesAtEnd,
    unfinishedOpenAgeMsMax: r.unfinished.openEpisodeAgeMs.at(-1) ?? '',
    unfinishedCappedExhaustedAtEnd: r.unfinished.cappedExhaustedAtEnd,
    pendingAtEnd: r.requests.pendingAtEnd,
    ...Object.fromEntries(REASONS.map((reason) => [reason, r.requests.refusals[reason]])),
    ...Object.fromEntries(THRESHOLDS.map((t) => [`finalExhaustedAt${t}`, r.exhaustion.final[t]])),
    mmPnlCoin: r.bot.pnlCoin,
    haltMs: r.bot.stageMs.halt,
    reduceMs: r.bot.stageMs.reduce,
    maxReservedLossCoin: r.bot.maxReservedLossCoin,
    ordersPlaced: r.orders.placed,
    ordersSkippedBelowOneContract: r.orders.skippedBelowOneContract,
    existingChecks: sum(Object.values(r.invariants.existing)),
    newChecks: sum(Object.values(r.invariants.new)),
    violations: r.invariants.violations,
    traceDigest: r.traceDigest,
  }))
  .sort((a, b) => byOrder(a, b) || a.seed - b.seed);
writeFileSync(resolve(directory, 'runs.csv'), csv(runs, Object.keys(runs[0])));

const cycles = manifest.cycles;
const exhaustionRows = [];
for (const row of summary)
  for (const t of THRESHOLDS)
    for (const type of ['exhaust', 'normal']) {
      const rows = groups.get([row.candidate, row.profile, row.variant].join('/'));
      exhaustionRows.push({
        candidate: row.candidate,
        profile: row.profile,
        variant: row.variant,
        threshold: t,
        type,
        ...Object.fromEntries(
          Array.from({ length: cycles }, (_, k) => [
            `c${k + 1}`,
            sum(rows.map((r) => r.exhaustion.byCycle[t][type][k])) / rows.length,
          ]),
        ),
      });
    }
writeFileSync(
  resolve(directory, 'exhaustion-by-cycle.csv'),
  csv(exhaustionRows, Object.keys(exhaustionRows[0])),
);

const existingChecks = sum(results.map((r) => sum(Object.values(r.invariants.existing))));
const newChecks = sum(results.map((r) => sum(Object.values(r.invariants.new))));
const newByName = {};
for (const r of results)
  for (const [name, count] of Object.entries(r.invariants.new))
    newByName[name] = (newByName[name] ?? 0) + count;
const ASSUMPTIONS = [
  ['p20-m1', '내부 테스트 가정: 20명/1시장'],
  ['p100-m5', '초기 공개 가정: 100명/5시장'],
];
const valuesText = (id) => {
  const c = manifest.candidates.find((row) => row.id === id);
  if (c.values === null) return '여섯 미정(`not_ready`)';
  const v = c.values;
  return `기준액 ${v.thresholdCoin} · 1회 ${v.amountCoin} · 대기 ${v.waitHours}시간 · ${v.periodDays}일에 ${v.periodLimit}회 · 누적 상한 ${v.totalCapCoin}`;
};
const vsR0 = (row) => (row.candidate === 'R0' ? '' : ` (R0 ${row.finalExhaustedPctPointsVsR0}%p)`);

const body = [
  '# #332 재지급 시나리오 실행 결과',
  '',
  `216개 실행(재지급 후보 R0–R5 × #71의 9규모 조합 × 변형 V1·V2 × seed 2개), 실행마다 ${cycles}주기, 출시 묶음 C5 위. 불변식 위반 0건(기존 이름의 검사 ${existingChecks}회, 새 검사 ${newChecks}회). **출시 합격 값이나 추천 값이 아니다.** 후보와 시나리오는 모두 합성 시험 입력이다. 문턱이나 순위를 두지 않았고 관찰한 수치만 적는다. 표의 각 줄은 [후보 요약](${artifactUrl('candidate-summary.csv')})의 행 번호(머리 줄이 1행)를 적는다. 수량은 두 seed의 산술평균, 비율은 두 seed의 분자·분모를 합친 값, 중앙값·최대는 두 seed를 합친 목록에서 구했다.`,
  '',
  `금고 회수는 정산 뒤 MM 기금에 남은 Coin의 합(Σ주기·시장의 A + MM 손익)이다. 금고 잔액은 상태가 아니고 주기마다 A·m을 새로 발행한 것으로 보므로(오너 답 332-1) 금고 회수의 대부분은 그 새 발행이다. 그래서 표는 재지급을 **순회수**(금고 회수 − Σ주기 A·m = MM 손익 합 = 사람이 거래로 잃은 Coin의 합)에 견주고, 총 금고 회수에 견준 비율은 [후보 요약](${artifactUrl('candidate-summary.csv')})의 \`regrantPerRecoveredPct\`에만 둔다. 어느 비율도 금고가 줄어드는 정도가 아니다.`,
  '',
  '## 후보',
  '',
  '| 후보 | 값 |',
  '| --- | --- |',
  ...candidates.map((id) => `| ${id} | ${valuesText(id)} |`),
];
for (const [profile, label] of ASSUMPTIONS) {
  body.push(
    '',
    `## ${label}`,
    '',
    '마지막 소진 잔류는 마지막 정산 뒤 그 시각의 신청까지 처리한 다음 가용 Coin이 후보의 기준액 이하인 계정의 비율이다. 괄호는 같은 조합·변형의 R0을 같은 기준액으로 잰 값과의 차이다. 소진→지급 시간은 지급으로 끝난 소진만 잰다. 끝날 때 못 받은 것은 따로 적는다(두 seed 평균): 진행 중은 마지막 정산 뒤에도 끝나지 않은 소진(지급을 기다리는 신청과 아직 보내지 않은 지연 신청), 상한은 `total_cap`으로 신청을 그만둔 채 기준액 이하인 계정, 진행 중 최장 시간은 그 소진이 시작된 때부터 마지막 정산까지다. 실행이 끝나 잘린 시간이라 실제로 못 받는 시간은 그보다 길다.',
    '',
    '| 후보 | 변형 | 재지급 ÷ 시작 지급 % | 재지급 ÷ 순회수 % | 받은 계정 % | 받은 횟수 중앙/최대 | 상한에 닿은 계정 | 첫 재지급 일 중앙/최대 | 마지막 소진 잔류 % | 소진→지급 시간 중앙/최대 | 끝날 때 못 받음: 진행 중 / 상한 / 진행 중 최장 시간 | 받은 계정 손실 ÷ 재지급 % | 요약 행 |',
    '| --- | --- | ---: | ---: | ---: | --- | ---: | --- | --- | --- | --- | ---: | ---: |',
  );
  for (const c of candidates)
    for (const v of variants) {
      const r = find(c, profile, v);
      body.push(
        `| ${c} | ${v} | ${r.regrantPerStartPct} | ${r.regrantPerNetRecoveredPct} | ${r.recipientsPct} | ${r.grantsMedian} / ${r.grantsMax} | ${r.capReached} | ${r.firstGrantDaysMedian} / ${r.firstGrantDaysMax} | ${c === 'R0' ? THRESHOLDS.map((t) => r[`finalExhaustedPctAt${t}`]).join(' / ') + ` (기준 ${THRESHOLDS.join('/')})` : r.finalExhaustedPct + vsR0(r)} | ${r.exhaustToGrantHoursMedian} / ${r.exhaustToGrantHoursMax} | ${r.unfinishedOpenAtEnd} / ${r.unfinishedCappedExhaustedAtEnd} / ${r.unfinishedOpenAgeHoursMax} | ${r.recipientsLossPerRegrantPct} | ${line(r)} |`,
      );
    }
  body.push(
    '',
    '거절 사유는 신청 한 번이 해당하는 사유를 모두 센다(두 seed 평균).',
    '',
    `| 후보 | 변형 | 신청 | 지급 | ${REASONS.map((r) => `\`${r}\``).join(' | ')} | 소진형·즉시의 1인당 재지급 | 요약 행 |`,
    `| --- | --- | ---: | ---: | ${REASONS.map(() => '---:').join(' | ')} | ---: | ---: |`,
  );
  for (const c of candidates)
    for (const v of variants) {
      const r = find(c, profile, v);
      body.push(
        `| ${c} | ${v} | ${r.requestsSent} | ${r.requestsGranted} | ${REASONS.map((reason) => r[reason]).join(' | ')} | ${r.exhaustImmediateGrantsPerPerson} | ${line(r)} |`,
      );
    }
  body.push(
    '',
    'MM 손익은 사용자 손실과 반대이며 품질 점수가 아니다. 단계 시간은 모든 시장의 초를 더한 시장·초(두 seed 평균)라 시장 수에 따라 커지고, 최대 예약 손실은 한 시장의 값이다.',
    '',
    '| 후보 | 변형 | MM 손익 합 Coin (R0 차) | 시장별 최소 / 최대 손익 | reduce 시장·초 | halt 시장·초 (R0 차) | reduce / halt 전환 | 최대 예약 손실 / L | 요약 행 |',
    '| --- | --- | ---: | --- | ---: | ---: | --- | --- | ---: |',
  );
  for (const c of candidates)
    for (const v of variants) {
      const r = find(c, profile, v);
      body.push(
        `| ${c} | ${v} | ${r.mmPnlCoin}${c === 'R0' ? '' : ` (${r.mmPnlCoinVsR0})`} | ${r.mmMinMarketPnlCoin} / ${r.mmMaxMarketPnlCoin} | ${r.reduceMarketSeconds} | ${r.haltMarketSeconds}${c === 'R0' ? '' : ` (${r.haltMarketSecondsVsR0})`} | ${r.toReduce} / ${r.toHalt} | ${r.maxReservedLossCoin} / ${r.maxLossLimitCoin} | ${line(r)} |`,
      );
    }
}

/** The same facts for every candidate (§4): one cell per assumption × variant. */
const facts = (r) =>
  r.candidate === 'R0'
    ? `소진 잔류 ${THRESHOLDS.map((t) => r[`finalExhaustedPctAt${t}`]).join('/')}%(기준 ${THRESHOLDS.join('/')}) · \`not_ready\` ${r.not_ready}회 · halt ${r.haltMarketSeconds}시장·초 (${line(r)}행)`
    : `소진 잔류 ${r.finalExhaustedPct}%(R0 ${r.r0FinalExhaustedPct}%) · 받은 계정 ${r.recipientsPct}% · 상한 ${r.capReached}명 · 재지급÷순회수 ${r.regrantPerNetRecoveredPct}% · 소진→지급 최대 ${r.exhaustToGrantHoursMax}시간 · 끝날 때 못 받음 ${r.unfinishedOpenAtEnd}+${r.unfinishedCappedExhaustedAtEnd}명(진행 중 최장 ${r.unfinishedOpenAgeHoursMax === '없음' ? '없음' : `${r.unfinishedOpenAgeHoursMax}시간`}) · halt ${r.haltMarketSeconds}시장·초 (${line(r)}행)`;
// Comparable across sizes: shares of the people, halt per market (not summed over markets).
const round = (x) => Number(x.toFixed(2));
const haltPerMarket = ['halt 시장당 초', (r) => round(r.haltMarketSeconds / r.markets)];
const EXTREMES = [
  ['마지막 소진 잔류 %', (r) => Number(r.finalExhaustedPct)],
  ['재지급 ÷ 순회수 %', (r) => Number(r.regrantPerNetRecoveredPct) || 0],
  ['상한에 닿은 계정 %', (r) => round((r.capReached * 100) / r.people)],
  ['소진→지급 최대 시간', (r) => Number(r.exhaustToGrantHoursMax) || 0],
  [
    '끝날 때 못 받은 계정 %',
    (r) => round(((r.unfinishedOpenAtEnd + r.unfinishedCappedExhaustedAtEnd) * 100) / r.people),
  ],
  ['진행 중 소진 최장 시간', (r) => Number(r.unfinishedOpenAgeHoursMax) || 0],
  haltPerMarket,
  ['최대 예약 손실', (r) => r.maxReservedLossCoin],
];
const EXTREMES_R0 = [
  ...THRESHOLDS.map((t) => [`소진 잔류 %(기준 ${t})`, (r) => Number(r[`finalExhaustedPctAt${t}`])]),
  haltPerMarket,
  ['최대 예약 손실', (r) => r.maxReservedLossCoin],
];
const named = ASSUMPTIONS.map(([p]) => p);
function onlyNine(c) {
  const rows = summary.filter((r) => r.candidate === c);
  const inside = rows.filter((r) => named.includes(r.profile));
  const outside = rows.filter((r) => !named.includes(r.profile));
  const notes = [];
  for (const [label, pick] of c === 'R0' ? EXTREMES_R0 : EXTREMES) {
    const top = Math.max(...outside.map(pick));
    const insideTop = Math.max(...inside.map(pick));
    if (!(top > insideTop)) continue;
    const r = outside.find((row) => pick(row) === top);
    notes.push(
      `${label} ${top}(${r.profile}·${r.variant}, ${line(r)}행; 두 가정의 최대 ${insideTop})`,
    );
  }
  return notes.length ? notes.join(' · ') : '두 가정 밖 7조합에서 이 지표들의 더 큰 값 없음';
}
body.push(
  '',
  '## 후보별 약점 비교',
  '',
  '후보마다 같은 지표를 두 가정·두 변형에서 적고, 마지막 칸에는 두 가정 밖 7조합(×2변형)에서 두 가정의 최댓값보다 크게 나온 값만 적는다. 그 칸은 인원이나 시장 수만큼 커지는 값을 피해 계정 수는 인원 대비 %로, halt는 시장당 초(시장·초 ÷ 시장 수)로 견준다. 끝날 때 못 받음은 진행 중 + 상한 계정이다. 고르는 것은 오너다(ADR-0171 결정 3의 2). 칸의 수치는 모두 괄호의 요약 행의 값이거나 그 값을 인원·시장 수로 나눈 것이다.',
  '',
  `| 후보 | ${ASSUMPTIONS.flatMap(([p]) => variants.map((v) => `${p}·${v}`)).join(' | ')} | 9조합에서만 드러난 것 |`,
  `| --- | ${ASSUMPTIONS.flatMap(() => variants.map(() => '---')).join(' | ')} | --- |`,
  ...candidates.map(
    (c) =>
      `| ${c} | ${ASSUMPTIONS.flatMap(([p]) => variants.map((v) => facts(find(c, p, v)))).join(' | ')} | ${onlyNine(c)} |`,
  ),
);

const r1 = summary.filter((r) => r.candidate === 'R1');
body.push(
  '',
  '## 구조에서 나온 것',
  '',
  `- R1의 받은 횟수는 9조합·두 변형에서 최대 ${Math.max(...r1.map((r) => r.grantsMax))}회이고 상한에 닿은 계정은 ${Math.max(...r1.map((r) => r.capReached))}명이다(요약 ${r1.map(line).join('·')}행). 대기 168시간과 30일에 1회라 ${cycles}주기 안에 2회까지만 받을 수 있어 누적 상한 1000에 닿지 않는다(오너 답 332-1).`,
  `- \`live_orders\`는 모든 실행에서 ${sum(summary.map((r) => r.live_orders))}회다. 사람은 IOC 매수만 하고 마감이 모든 주문을 취소하므로 생기지 않으며 규칙의 경계는 \`rule.test.ts\`가 검사한다.`,
  `- \`unsettled_positions\`는 지연 신청이 다음 주기 거래 뒤 정산 전에 닿을 때 나온다. 주기를 이어 붙인 모형의 간격에 달린 수다.`,
  '',
  '## 새 불변식',
  '',
  '| 검사 | 216회 합계 |',
  '| --- | ---: |',
  ...Object.entries(newByName).map(([name, count]) => `| ${name} | ${count} |`),
  '',
  '## 전체 자료',
  '',
  `- [후보 요약 108행](${artifactUrl('candidate-summary.csv')}), [실행별 216행](${artifactUrl('runs.csv')}), [주기·유형별 소진 수](${artifactUrl('exhaustion-by-cycle.csv')}), [모든 원결과 JSONL](${artifactUrl('results.jsonl.gz')}), [입력과 실행 영수증](${artifactUrl('manifest.json')}). 표에 없는 결과도 버리지 않았다.`,
  '- 하나의 직렬 순수 모형이다. 실제 서비스의 DB·잠금·동시성·재시도는 #131의 범위이고 이 실행은 #131을 돌리지 않았다.',
  '',
);
writeFileSync(
  reportPath,
  await format(body.join('\n'), {
    ...(await resolveConfig(import.meta.filename)),
    parser: 'markdown',
  }),
);
