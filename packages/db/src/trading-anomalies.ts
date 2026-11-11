import {
  RELEASE_SETTINGS,
  TRADING_ANOMALY_SETTINGS,
  TRADING_ANOMALY_SCAN_LIMIT,
  TRADING_ANOMALY_CANDIDATE_LIMIT,
  TRADING_ANOMALY_EVIDENCE_LIMIT,
  readReleaseSetting,
  type ReleaseSettingsRegistry,
  type TradingAnomalyCandidate,
  type TradingAnomalyLeg,
  type TradingAnomalyReport,
  type TradingAnomalyQuery,
} from '@buddha/shared';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { isHumanAccountTypeSql } from './account-types.js';
import { storedReleaseSettingValue } from './release-settings.js';
import { clockTimestamp } from './tx-helpers.js';
import { fills, markets, profiles, releaseSettings } from './schema/index.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Evidence = TradingAnomalyCandidate['evidence'][number];
type Signal = TradingAnomalyReport['signals'][number];
interface Leg extends TradingAnomalyLeg {
  time: number;
}
interface Pair {
  first: Leg;
  second: Leg;
  qty: bigint;
  start: number;
  end: number;
}
interface PendingCandidate {
  kind: TradingAnomalyCandidate['kind'];
  marketId: string;
  actors: string[];
  outcome: TradingAnomalyCandidate['outcome'];
  pairs: Pair[];
}
const keyOf = (kind: string, marketId: string, actors: readonly string[], outcome: string | null) =>
  JSON.stringify([kind, marketId, ...actors, outcome]);
const sortLeg = (a: Leg, b: Leg) =>
  a.time - b.time ||
  (BigInt(a.fillId) < BigInt(b.fillId) ? -1 : BigInt(a.fillId) > BigInt(b.fillId) ? 1 : 0);

/** The maximal count in one inclusive window; ties use the most recent ending evidence. */
function largestWindow(pairs: Pair[], windowMs: number): Pair[] {
  let start = 0,
    bestStart = 0,
    bestEnd = 0;
  // FIFO produces nondecreasing opening and closing times, as do the one-fill human pairs.
  for (let end = 0; end < pairs.length; end++) {
    while (start <= end && pairs[start]!.start < pairs[end]!.end - windowMs) start++;
    if (end + 1 - start >= bestEnd - bestStart) {
      bestStart = start;
      bestEnd = end + 1;
    }
  }
  return pairs.slice(bestStart, bestEnd);
}

/**
 * Opposite legs consume earliest unpaired quantity first. A raw fill-ID pair is counted once;
 * splitting one fill across different opposite fills can create multiple distinct pairs.
 * Neither a pair mint's two buys nor a bot's own repeated legs create a human round trip.
 */
function roundTrips(legs: Leg[], windowMs: number): Pair[] {
  const queue: { leg: Leg; qty: bigint }[] = [];
  let head = 0;
  const matched = new Map<string, Pair>();
  for (const leg of legs.sort(sortLeg)) {
    while (
      head < queue.length &&
      (queue[head]!.qty === 0n || queue[head]!.leg.time < leg.time - windowMs)
    )
      head++;
    let left = BigInt(leg.qty);
    while (left > 0n && head < queue.length && queue[head]!.leg.side !== leg.side) {
      const earlier = queue[head]!;
      const qty = left < earlier.qty ? left : earlier.qty;
      const key = JSON.stringify([earlier.leg.fillId, leg.fillId]);
      const existing = matched.get(key);
      if (existing) existing.qty += qty;
      else
        matched.set(key, {
          first: earlier.leg,
          second: leg,
          qty,
          start: earlier.leg.time,
          end: leg.time,
        });
      left -= qty;
      earlier.qty -= qty;
      if (earlier.qty === 0n) head++;
    }
    if (left > 0n) queue.push({ leg, qty: left });
  }
  return [...matched.values()];
}
const publicLeg = (leg: Leg): TradingAnomalyLeg => ({
  fillId: leg.fillId,
  orderId: leg.orderId,
  userId: leg.userId,
  at: leg.at,
  outcome: leg.outcome,
  side: leg.side,
  priceCoin: leg.priceCoin,
  qty: leg.qty,
});
const evidence = (pair: Pair): Evidence => ({
  first: publicLeg(pair.first),
  second: publicLeg(pair.second),
  matchedQty: pair.qty.toString(),
});

/**
 * Caller supplies REPEATABLE READ, READ ONLY. One bounded source query, no cursor spanning
 * transactions: the returned report is the complete client paging snapshot. A new request
 * deliberately starts a new observation. No automatic classification, queue, asset read/write.
 */
export async function readTradingAnomalies(
  tx: Tx,
  query: TradingAnomalyQuery = {},
  registry: ReleaseSettingsRegistry = RELEASE_SETTINGS,
): Promise<TradingAnomalyReport> {
  const asOf = await clockTimestamp(tx);
  const asOfMs = asOf.getTime();
  const definitions = Object.values(TRADING_ANOMALY_SETTINGS);
  const settingsRows = await tx
    .select({
      key: releaseSettings.key,
      status: releaseSettings.status,
      value: storedReleaseSettingValue,
    })
    .from(releaseSettings)
    .where(
      inArray(
        releaseSettings.key,
        definitions.map((row) => row.key),
      ),
    );
  const reading = (definition: (typeof definitions)[number]) =>
    readReleaseSetting(
      registry,
      definition,
      settingsRows.find((row) => row.key === definition.key),
    );
  const s = TRADING_ANOMALY_SETTINGS;
  const signals: Signal[] = [
    {
      kind: 'human_pair',
      status: 'undecided',
      settings: {
        count: reading(s.pairCount),
        windowSeconds: reading(s.pairWindow),
        lookbackSeconds: reading(s.pairLookback),
      },
      rangeStartedAt: null,
      observedCandidates: '0',
      candidatesTruncated: false,
    },
    {
      kind: 'round_trip',
      status: 'undecided',
      settings: {
        count: reading(s.roundTripCount),
        windowSeconds: reading(s.roundTripWindow),
        lookbackSeconds: reading(s.roundTripLookback),
      },
      rangeStartedAt: null,
      observedCandidates: '0',
      candidatesTruncated: false,
    },
  ];
  for (const signal of signals) {
    const { count, windowSeconds, lookbackSeconds } = signal.settings;
    if (count.value === null || windowSeconds.value === null || lookbackSeconds.value === null)
      continue;
    const from = asOfMs - lookbackSeconds.value * 1000;
    if (
      windowSeconds.value > lookbackSeconds.value ||
      !Number.isSafeInteger(from) ||
      from < Date.parse('0000-01-01T00:00:00.000Z')
    ) {
      signal.status = 'invalid';
      continue;
    }
    signal.status = 'ready';
    signal.rangeStartedAt = new Date(from).toISOString();
  }
  const ready = signals.filter((row) => row.status === 'ready');
  const from = ready.length
    ? new Date(Math.min(...ready.map((row) => Date.parse(row.rangeStartedAt!))))
    : null;
  const report: TradingAnomalyReport = {
    asOf: asOf.toISOString(),
    marketId: query.marketId ?? null,
    rangeStartedAt: from?.toISOString() ?? null,
    source: {
      scannedFills: 0,
      limit: TRADING_ANOMALY_SCAN_LIMIT,
      truncated: false,
      complete: ready.length === signals.length,
      oldestScannedAt: null,
    },
    signals,
    candidates: [],
  };
  if (from === null) return report;
  const rows = await tx
    .select({
      id: sql<string>`${fills.id}::text`,
      marketId: fills.marketId,
      kind: fills.kind,
      incomingOrderId: fills.incomingOrderId,
      restingOrderId: fills.restingOrderId,
      incomingOwnerId: fills.incomingOwnerId,
      restingOwnerId: fills.restingOwnerId,
      incomingHuman: isHumanAccountTypeSql(fills.incomingAccountType),
      restingHuman: isHumanAccountTypeSql(fills.restingAccountType),
      outcome: fills.outcome,
      side: fills.side,
      qty: fills.qty,
      priceCoin: fills.priceCoin,
      createdAt: fills.createdAt,
    })
    .from(fills)
    .where(
      and(
        gte(fills.createdAt, from),
        lte(fills.createdAt, asOf),
        query.marketId ? eq(fills.marketId, query.marketId) : undefined,
      ),
    )
    .orderBy(desc(fills.createdAt), desc(fills.id))
    .limit(TRADING_ANOMALY_SCAN_LIMIT + 1);
  report.source.truncated = rows.length > TRADING_ANOMALY_SCAN_LIMIT;
  if (report.source.truncated) {
    rows.pop();
    report.source.complete = false;
  }
  report.source.scannedFills = rows.length;
  report.source.oldestScannedAt = rows.at(-1)?.createdAt.toISOString() ?? null;
  const humanPairs = new Map<string, { marketId: string; actors: string[]; pairs: Pair[] }>();
  const humanLegs = new Map<
    string,
    { marketId: string; userId: string; outcome: Leg['outcome']; legs: Leg[] }
  >();
  const pairSignal = signals[0]!,
    roundSignal = signals[1]!;
  const addLeg = (marketId: string, leg: Leg) => {
    const key = JSON.stringify([marketId, leg.userId, leg.outcome]);
    let group = humanLegs.get(key);
    if (!group) {
      group = { marketId, userId: leg.userId, outcome: leg.outcome, legs: [] };
      humanLegs.set(key, group);
    }
    group.legs.push(leg);
  };
  for (const row of rows) {
    const base = {
      fillId: row.id,
      at: row.createdAt.toISOString(),
      time: row.createdAt.getTime(),
      qty: String(row.qty),
    };
    const incoming: Leg = {
      ...base,
      orderId: row.incomingOrderId,
      userId: row.incomingOwnerId,
      outcome: row.outcome,
      side: row.side,
      priceCoin: row.priceCoin,
    };
    const resting: Leg = {
      ...base,
      orderId: row.restingOrderId,
      userId: row.restingOwnerId,
      outcome: row.kind === 'pair_mint' ? (row.outcome === 'YES' ? 'NO' : 'YES') : row.outcome,
      side: row.kind === 'pair_mint' ? 'buy' : row.side === 'buy' ? 'sell' : 'buy',
      priceCoin: row.kind === 'pair_mint' ? 100 - row.priceCoin : row.priceCoin,
    };
    if (
      pairSignal.status === 'ready' &&
      base.time >= Date.parse(pairSignal.rangeStartedAt!) &&
      row.incomingHuman &&
      row.restingHuman
    ) {
      const actors = [row.incomingOwnerId, row.restingOwnerId].sort();
      const key = JSON.stringify([row.marketId, ...actors]);
      let group = humanPairs.get(key);
      if (!group) {
        group = { marketId: row.marketId, actors, pairs: [] };
        humanPairs.set(key, group);
      }
      group.pairs.push({
        first: incoming,
        second: resting,
        qty: BigInt(row.qty),
        start: base.time,
        end: base.time,
      });
    }
    if (roundSignal.status === 'ready' && base.time >= Date.parse(roundSignal.rangeStartedAt!)) {
      if (row.incomingHuman) addLeg(row.marketId, incoming);
      if (row.restingHuman) addLeg(row.marketId, resting);
    }
  }
  const candidates: PendingCandidate[] = [];
  if (pairSignal.status === 'ready')
    for (const group of humanPairs.values()) {
      const pairs = largestWindow(
        group.pairs.sort((a, b) => sortLeg(a.first, b.first)),
        pairSignal.settings.windowSeconds.value! * 1000,
      );
      if (pairs.length >= pairSignal.settings.count.value!)
        candidates.push({
          kind: 'human_pair',
          marketId: group.marketId,
          actors: group.actors,
          outcome: null,
          pairs,
        });
    }
  if (roundSignal.status === 'ready')
    for (const group of humanLegs.values()) {
      const pairs = largestWindow(
        roundTrips(group.legs, roundSignal.settings.windowSeconds.value! * 1000),
        roundSignal.settings.windowSeconds.value! * 1000,
      );
      if (pairs.length >= roundSignal.settings.count.value!)
        candidates.push({
          kind: 'round_trip',
          marketId: group.marketId,
          actors: [group.userId],
          outcome: group.outcome,
          pairs,
        });
    }
  candidates.sort(
    (a, b) =>
      b.pairs.length - a.pairs.length ||
      b.pairs.at(-1)!.end - a.pairs.at(-1)!.end ||
      keyOf(a.kind, a.marketId, a.actors, a.outcome).localeCompare(
        keyOf(b.kind, b.marketId, b.actors, b.outcome),
      ),
  );
  const shown = candidates.slice(0, TRADING_ANOMALY_CANDIDATE_LIMIT);
  for (const signal of signals) {
    const observed = candidates.filter((row) => row.kind === signal.kind).length;
    signal.observedCandidates = String(observed);
    signal.candidatesTruncated = shown.filter((row) => row.kind === signal.kind).length < observed;
  }
  if (shown.length === 0) return report;
  const marketIds = [...new Set(shown.map((row) => row.marketId))],
    userIds = [...new Set(shown.flatMap((row) => row.actors))];
  const marketRows = await tx
    .select({ id: markets.id, title: markets.title, status: markets.status })
    .from(markets)
    .where(inArray(markets.id, marketIds));
  const names = await tx
    .select({ id: profiles.userId, nickname: profiles.nickname, closedAt: profiles.closedAt })
    .from(profiles)
    .where(inArray(profiles.userId, userIds));
  report.candidates = shown.map((row) => ({
    id: keyOf(row.kind, row.marketId, row.actors, row.outcome),
    kind: row.kind,
    market: marketRows.find((m) => m.id === row.marketId)!,
    actors: row.actors.map((userId) => {
      const name = names.find((row) => row.id === userId);
      return { userId, nickname: name && !name.closedAt ? name.nickname : null };
    }),
    outcome: row.outcome,
    count: String(row.pairs.length),
    quantity: row.pairs.reduce((sum, pair) => sum + pair.qty, 0n).toString(),
    windowStartedAt: new Date(row.pairs[0]!.start).toISOString(),
    windowEndedAt: new Date(row.pairs.at(-1)!.end).toISOString(),
    evidenceTotal: String(row.pairs.length),
    evidenceTruncated: row.pairs.length > TRADING_ANOMALY_EVIDENCE_LIMIT,
    evidence: row.pairs.slice(0, TRADING_ANOMALY_EVIDENCE_LIMIT).map(evidence),
  }));
  return report;
}
