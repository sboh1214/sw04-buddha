import assert from 'node:assert/strict';
import { format, resolveConfig } from 'prettier';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

const directory = resolve(process.argv[2] ?? 'docs/research/71-economic-simulation/results');
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
assert.equal(results.length, 2016);
assert.equal(manifest.failed, 0);
assert.equal(manifest.sourceUnchanged, true);
const groups = new Map();
for (const row of results) {
  const key = [row.candidate, row.profile, row.case].join('/');
  const group = groups.get(key) ?? [];
  group.push(row);
  groups.set(key, group);
}
assert.equal(groups.size, 1008);
const aggregate = (rows) => {
  assert.equal(rows.length, 2);
  const sum = (a, b) => rows.reduce((n, r) => n + r[a][b], 0);
  const ratio = (a, b) => (b === 0 ? '자료 없음' : ((100 * a) / b).toFixed(2));
  const amount = (n) => {
    assert.ok(Number.isSafeInteger(Number(n)));
    return Number(n);
  };
  return {
    candidate: rows[0].candidate,
    profile: rows[0].profile,
    case: rows[0].case,
    filledQty: sum('orders', 'filledQty') / 2,
    fullIocPercent: ratio(sum('orders', 'fullIoc'), sum('orders', 'ioc')),
    botFillPercent: ratio(sum('orders', 'filledBotQty'), sum('orders', 'postedBotQty')),
    botMissingPercent: ratio(sum('time', 'botOneDirectionMissingMs'), sum('time', 'openMarketMs')),
    wholeMissingPercent: ratio(
      sum('time', 'wholeBookOneAskMissingMs'),
      sum('time', 'openMarketMs'),
    ),
    meanSpreadTicks:
      sum('time', 'spreadObservedMs') === 0
        ? '자료 없음'
        : (sum('time', 'spreadTickMs') / sum('time', 'spreadObservedMs')).toFixed(2),
    pausedMarketSeconds: sum('time', 'pausedMarketMs') / 2000,
    maxOverallLossCoin: Math.max(...rows.map((r) => amount(r.maxOverallLossCoin))),
    maxReservedLossCoin: Math.max(...rows.map((r) => amount(r.maxOverallReservedLossCoin))),
    maxSingleOrderReferenceMove: Math.max(...rows.map((r) => r.maxSingleOrderReferenceMove)),
    maxFillPriceRange: Math.max(...rows.map((r) => r.maxFillPriceRange)),
    yesPnlCoin: rows.reduce((sum, r) => sum + amount(r.settlements[0].botPnlCoin), 0) / 2,
    noPnlCoin: rows.reduce((sum, r) => sum + amount(r.settlements[1].botPnlCoin), 0) / 2,
    voidPnlCoin: rows.reduce((sum, r) => sum + amount(r.settlements[2].botPnlCoin), 0) / 2,
    haltMarketSeconds:
      rows.reduce((sum, r) => sum + r.markets.reduce((n, m) => n + m.stageMs.halt, 0), 0) / 2000,
  };
};
const all = [...groups.values()].map(aggregate);
const columns = Object.keys(all[0]);
const csv = (rows) =>
  [columns.join(','), ...rows.map((row) => columns.map((key) => row[key]).join(','))].join('\n') +
  '\n';
writeFileSync(resolve(directory, 'scenario-summary.csv'), csv(all));
writeFileSync(
  resolve(directory, 'population-market-sensitivity.csv'),
  csv(all.filter((row) => row.case === 'balanced')),
);
const find = (c, p, s) =>
  all.find((row) => row.candidate === c && row.profile === p && row.case === s);
const body = [
  '# #71 합성 경제 실험 결과',
  '',
  '2016개 실행·8후보·9규모 조합·14경로·2seed. 불변식 오류 0건. **출시 합격 또는 운영 수치 추천이 아니다.** 아래 수량·손익은 두 seed의 산술평균이고, 비율은 분자·분모를 합친 값이다. 최악 손실·한 주문 이동폭은 두 seed의 최대다. 표의 양수 MM 손익은 사용자 손익과 반대이며 품질 점수가 아니다.',
  '',
  '## 양방향 소액: 대표 세 조건',
  '',
  '완료율은 모든 유효한 합성 인간 IOC 시도 중 shared 종료 상태가 filled인 비율이다. 무체결·자기거래·마감 후 거절 시도도 분모에 포함하며 실제 서비스의 저장 주문 기반 운영 지표와 같다고 주장하지 않는다. 호가 공백은 OPEN 동안 MM 매수 두 방향 중 한쪽이라도 실행 가능한 물량이 없는 시간/전체 OPEN 시장시간이다.',
];
for (const [profile, label] of [
  ['p20-m1', '내부 가정: 20명/1시장'],
  ['p100-m5', '초기 공개 가정: 100명/5시장'],
  ['p500-m20', '압박 가정: 500명/20시장'],
]) {
  body.push(
    '',
    `### ${label}`,
    '',
    '| 후보 | 체결 계약 | IOC 완료 % | MM 공백 % | 양측 관측 spread 틱 | 시장별 손실 합의 최대 Coin | MM 최종 YES / NO / VOID 손익 Coin |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
  );
  for (const c of manifest.candidates) {
    const r = find(c.id, profile, 'balanced');
    body.push(
      `| ${c.id} | ${r.filledQty} | ${r.fullIocPercent} | ${r.botMissingPercent} | ${r.meanSpreadTicks} | ${r.maxOverallLossCoin} | ${r.yesPnlCoin} / ${r.noPnlCoin} / ${r.voidPnlCoin} |`,
    );
  }
}
body.push(
  '',
  '## 큰손의 한 번 주문과 20회 분할',
  '',
  '100명/5시장. 지정 큰손 1명/시장은 사전 소액 거래에서 제외해 정확히 같은 S 전액을 쓴다. 분할은 250ms 간격이라 갱신 기회가 달라진다. 따라서 차이를 주문 분할의 순수 효과만으로 해석하지 않는다.',
  '',
  '| 후보 | 분할 | 전체 체결 계약 | MM 공백 % | 최대 곡선 기준값 변화 Coin | 최대 실제 체결가격 폭 틱 | 최대 시장 손실 합 Coin |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
);
for (const c of manifest.candidates)
  for (const split of [1, 20]) {
    const r = find(c.id, 'p100-m5', `whale-${split}`);
    body.push(
      `| ${c.id} | ${split} | ${r.filledQty} | ${r.botMissingPercent} | ${r.maxSingleOrderReferenceMove.toFixed(3)} | ${r.maxFillPriceRange} | ${r.maxOverallLossCoin} |`,
    );
  }
body.push(
  '',
  '## 오래된 호가: 같은 tape의 갱신 지연 민감도',
  '',
  '100명/5시장. 각 줄은 0/250/1000/5000ms만 다른 동일 요청 tape다. 동시 도착은 정해진 순서로 직렬 실행하며 DB 동시성·네트워크 지연을 측정하지 않는다.',
  '',
  '| 후보 | 갱신 ms | 체결 계약 | MM 공백 % | IOC 완료 % | 최대 시장 손실 합 Coin |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
);
for (const c of ['C3', 'C7'])
  for (const delay of [0, 250, 1000, 5000]) {
    const r = find(c, 'p100-m5', `stale-${delay}`);
    body.push(
      `| ${c} | ${delay} | ${r.filledQty} | ${r.botMissingPercent} | ${r.fullIocPercent} | ${r.maxOverallLossCoin} |`,
    );
  }
body.push(
  '',
  '## 뉴스 뒤 운영 중단 지연',
  '',
  'C7, 100명/5시장. 가상 뉴스 시각 60초 이후 같은 방향 매수이며 사실 확률·수익 예측이 아니다. PAUSED 시간은 공급 공백 분모에서 빼고 별도 표시한다.',
  '',
  '| 중단 지연 초 | 체결 계약 | OPEN 중 MM 공백 % | PAUSED 시장·초 | 최대 시장 손실 합 Coin |',
  '| --- | ---: | ---: | ---: | ---: |',
);
for (const delay of [0, 30000, 300000]) {
  const r = find('C7', 'p100-m5', `news-stop-${delay}`);
  body.push(
    `| ${delay / 1000} | ${r.filledQty} | ${r.botMissingPercent} | ${r.pausedMarketSeconds} | ${r.maxOverallLossCoin} |`,
  );
}
body.push(
  '',
  '## 전체 자료와 해석 제한',
  '',
  `- [모든 실행의 수치](${artifactUrl('comparison.csv')})·[모든 원결과 JSONL](${artifactUrl('results.jsonl.gz')})·[1008개 후보/규모/경로별 seed 집계](${artifactUrl('scenario-summary.csv')})를 함께 보존한다. 위 표에 없는 결과를 버리지 않았다.`,
  `- [9개 독립 참가자×시장 축 민감도](${artifactUrl('population-market-sensitivity.csv')})는 balanced 경로의 72개 조합이다. 대표 세 조건만으로 참가자 수 효과와 시장 수 효과를 분리했다고 주장하지 않는다.`,
  '- 각 시장의 YES·NO·VOID와 공동 결과별 실제 지급을 검사한다. 여러 시장의 모든 3^M 결합을 열거하지 않는다. 손실 한도는 각 시장·각 결과에서 독립 검사하고, 전체 위험은 시장별 최악 손실을 합쳐 이익으로 상쇄하지 않는다.',
  '- 전체 2016회는 하나의 직렬 순수 모형이다. 승인·원장 DB·장애·작업 재시도·동시성의 실제 서비스 검증은 #131이다. 숫자 품질 문턱, 경보 문턱과 최종 출시 값은 #133이 정한다.',
  '',
);
writeFileSync(
  reportPath,
  await format(body.join('\n'), {
    ...(await resolveConfig(import.meta.filename)),
    parser: 'markdown',
  }),
);
