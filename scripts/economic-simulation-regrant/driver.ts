import assert from 'node:assert/strict';
import {
  CONTRACT_TERMS,
  OUTCOMES,
  botRisk,
  bookDepth,
  settlePosition,
  type Outcome,
} from '../../packages/shared/dist/index.js';
import {
  HORIZON_MS,
  SCAN_INTERVAL_MS,
  coinBudget,
  limitsOf,
  type Profile,
  type TapeEvent,
} from '../economic-simulation/inputs.ts';
import { Economy, digest } from '../economic-simulation/model.ts';
import {
  BUNDLE,
  CYCLES,
  CYCLE_MS,
  MARKET_CASE,
  R0_APPLY_AT_COIN,
  START_GRANTED_AT,
  THRESHOLDS,
  validateRegrant,
  type RegrantCandidate,
  type Variant,
} from './inputs.ts';
import {
  HOUR_MS,
  DAY_MS,
  RegrantAccount,
  decide,
  readHistory,
  type RegrantFacts,
  type RegrantRefusal,
  type RegrantRow,
  type RegrantValues,
} from './rule.ts';
import {
  assignPeople,
  createCycleTape,
  createRandom,
  drawCycle,
  type CycleDraws,
  type Person,
} from './tape.ts';

/*
 * #332 driver: 60 cycles of #71's model with the re-grant rule between them. #71's model.ts is used
 * as it is: a fresh exported `Economy` per cycle, #71's scan loop (simulate()'s, which builds its
 * tape only from createTape) and a thin carry-over layer — the wallets carried in, `readonly
 * issued` re-set by a cast, the existing audit() then running unchanged on that baseline. The model
 * has no settled state, so the driver settles one drawn result per market with shared's
 * `settlePosition` and re-implements #71's settlement checks under their names. From cycle 2 the
 * model's own settlements()/summary() are not called: their PnL check reads `wallet − S`.
 */

type Market = Economy['markets'][number];
const human = (i: number) => `H${i}`;

/** Invariant checks by name; a failed check throws (the run fails, nothing is weakened). */
export class Invariants {
  readonly counts: Record<string, number> = {};
  check(name: string, ok: boolean, detail?: unknown) {
    this.counts[name] = (this.counts[name] ?? 0) + 1;
    assert.ok(ok, detail === undefined ? name : `${name}: ${JSON.stringify(detail, big)}`);
  }
}
const big = (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value;

export const NEW_INVARIANTS = {
  decide: 'Re-grant passes decide() again before its mint',
  exhausted: 'Re-grant goes only to available Coin at or below the threshold',
  noOrders: 'No live order nor unsettled position at a mint',
  wait: 'Wait kept since the last re-grant or the start grant',
  period: 'Re-grants within one period stay within its limit',
  cap: 'Lifetime re-grants stay within the cap',
  once: 'A granted request id mints once',
  boundary: 'An immediate retry at its boundary time is granted',
  issuance: 'Issuance conserved: S·n + Σ A·m + Σ re-grants',
  pnl: 'Human PnL net of re-grants and all MM PnL sum to zero',
} as const;
export const SETTLEMENT_INVARIANTS = {
  collateral: 'Settlement pays exactly collateral once',
  retry: 'Settlement/recall retry pays nothing twice',
  recovery: 'Final recovery conserves issuance',
  zeroSum: 'Fee-free final human and MM PnL sum to zero',
  botPnl: 'MM settlement PnL equals its result PnL',
} as const;

/** Before a mint, every condition of the six checked directly from the rows (not via decide()). */
export function checkMint(
  inv: Invariants,
  values: RegrantValues,
  facts: RegrantFacts,
  before: readonly RegrantRow[],
  now: number,
) {
  inv.check(
    NEW_INVARIANTS.exhausted,
    facts.availableCoin !== null && facts.availableCoin <= values.thresholdCoin,
    { available: facts.availableCoin, threshold: values.thresholdCoin },
  );
  inv.check(NEW_INVARIANTS.noOrders, !facts.liveOrders && !facts.unsettledPositions, facts);
  const last = before.reduce<number | null>(
    (at, row) => (at === null || row.createdAt > at ? row.createdAt : at),
    null,
  );
  const since = last ?? facts.startGrantedAt;
  inv.check(NEW_INVARIANTS.wait, since !== null && now >= since + values.waitHours * HOUR_MS, {
    since,
    now,
  });
  const windowStart = now - values.periodDays * DAY_MS;
  const inPeriod = before.filter((row) => row.createdAt > windowStart).length;
  inv.check(NEW_INVARIANTS.period, inPeriod + 1 <= values.periodLimit, { inPeriod, now });
  const total = before.reduce((sum, row) => sum + row.amountCoin, 0n);
  inv.check(NEW_INVARIANTS.cap, total + values.amountCoin <= values.totalCapCoin, { total });
}
export function checkMintOnce(inv: Invariants, rows: readonly RegrantRow[]) {
  inv.check(
    NEW_INVARIANTS.once,
    new Set(rows.map((row) => row.requestId)).size === rows.length,
    rows.map((row) => row.requestId),
  );
}
export function checkIssuance(inv: Invariants, issued: bigint, held: bigint) {
  inv.check(NEW_INVARIANTS.issuance, issued === held, { issued, held });
}
export function checkPnlBasis(
  inv: Invariants,
  wallets: readonly bigint[],
  granted: readonly bigint[],
  startCoin: bigint,
  botPnl: bigint,
) {
  const human = wallets.reduce((sum, coin, i) => sum + coin - startCoin - granted[i]!, 0n);
  inv.check(NEW_INVARIANTS.pnl, human + botPnl === 0n, { human, botPnl });
}

export interface MarketSettlement {
  market: number;
  result: Outcome;
  paid: bigint;
  recall: bigint;
  pnl: bigint;
}
/**
 * One cycle's settlement: each market's drawn YES/NO paid from collateral exactly once (a second
 * pass pays nothing), every Coin of the cycle back in a wallet or recovered, and the cycle's human
 * PnL against the MM PnL. Returns the wallets after; the economy itself is not changed.
 */
export function settleCycle(
  inv: Invariants,
  economy: Economy,
  results: readonly Outcome[],
  cycleBase: readonly bigint[],
) {
  const wallets = [...economy.wallets];
  const completed = new Map<number, MarketSettlement>();
  const pay = (m: Market) => {
    if (completed.has(m.id)) return;
    assert.equal(m.book.length, 0, 'A settled market has no live order');
    const result = results[m.id]!;
    let collateral = m.collateral;
    let funds = m.coin;
    let paid = 0n;
    for (const [id, rows] of m.positions)
      for (const outcome of OUTCOMES) {
        const settled = settlePosition(rows[outcome], result, outcome);
        collateral -= settled.payoutCoin;
        paid += settled.payoutCoin;
        if (id.startsWith('H')) wallets[Number(id.slice(1))]! += settled.payoutCoin;
        else funds += settled.payoutCoin;
        // #71's per-position checks (model.ts settlements()): nothing is left after settling.
        assert.equal(settled.qty, 0);
        assert.equal(settled.costBasisCoin, 0n);
      }
    inv.check(SETTLEMENT_INVARIANTS.collateral, collateral === 0n && funds >= 0n, {
      market: m.id,
      collateral,
    });
    const pnl = funds - economy.candidate.budgetCoin;
    inv.check(
      SETTLEMENT_INVARIANTS.botPnl,
      pnl ===
        botRisk(economy.botBook(m), [], limitsOf(economy.candidate), CONTRACT_TERMS).pnl[result],
      { market: m.id, pnl },
    );
    completed.set(m.id, { market: m.id, result, paid, recall: funds, pnl });
  };
  for (const m of economy.markets) pay(m);
  const once = digest({ wallets, completed: [...completed] });
  for (const m of economy.markets) pay(m);
  inv.check(SETTLEMENT_INVARIANTS.retry, digest({ wallets, completed: [...completed] }) === once);
  const markets = [...completed.values()];
  const recovered = markets.reduce((sum, row) => sum + row.recall, 0n);
  inv.check(
    SETTLEMENT_INVARIANTS.recovery,
    wallets.reduce((sum, coin) => sum + coin, 0n) + recovered === economy.issued,
    { recovered, issued: economy.issued },
  );
  const botPnl = markets.reduce((sum, row) => sum + row.pnl, 0n);
  const humanPnl = wallets.reduce((sum, coin, i) => sum + coin - cycleBase[i]!, 0n);
  inv.check(SETTLEMENT_INVARIANTS.zeroSum, botPnl + humanPnl === 0n, { botPnl, humanPnl });
  return { wallets, markets, recovered, botPnl };
}

/** Carry-over layer: the wallets as the last cycle left them, issuance re-based on them. */
export function carryOver(economy: Economy, wallets: readonly bigint[]) {
  assert.equal(economy.wallets.length, wallets.length);
  wallets.forEach((coin, i) => {
    economy.wallets[i] = coin;
  });
  (economy as { issued: bigint }).issued =
    wallets.reduce((sum, coin) => sum + coin, 0n) +
    economy.candidate.budgetCoin * BigInt(economy.markets.length);
  economy.audit();
}

/** A re-grant mints into a person's wallet during the cycle: issuance follows, audit() re-runs. */
function mintInto(economy: Economy, person: number, amount: bigint) {
  economy.wallets[person]! += amount;
  (economy as { issued: bigint }).issued += amount;
  economy.audit();
}

/** 즉시's first request, its retry at the refusal's own time, 지연's request and any retry at a settlement. */
type RequestKind = 'first' | 'boundary-retry' | 'delayed' | 'settlement-retry';
interface Pending {
  at: number;
  person: number;
  kind: RequestKind;
}
interface Episode {
  requestId: string;
  startedAt: number;
  /** 즉시 waiting for its retry: it does not trade meanwhile. */
  waiting: boolean;
}
interface PersonState {
  episode: Episode | null;
  /** R0: refused `not_ready` — no new request until available rises above the trigger again. */
  gaveUp: boolean;
  /** Refused `total_cap`: no time lifts it, no request again. */
  capped: boolean;
  episodes: number;
  granted: bigint;
  grants: number;
  firstGrantAt: number | null;
}

export interface RunInput {
  candidate: RegrantCandidate;
  profile: Profile;
  variant: Variant;
  seed: number;
  cycles?: number;
}

const REASONS = [
  'not_ready',
  'not_exhausted',
  'live_orders',
  'unsettled_positions',
  'waiting',
  'period_limit',
  'total_cap',
] as const satisfies readonly RegrantRefusal[];

const zeroes = (n: number) => Array.from({ length: n }, () => 0);

export class RegrantRun {
  readonly input: RunInput;
  readonly cycles: number;
  readonly people: Person[];
  readonly accounts: RegrantAccount[];
  readonly state: PersonState[];
  readonly inv = new Invariants();
  readonly draw: () => number;
  wallets: bigint[];
  economy: Economy | null = null;
  /** The current cycle's markets are open or wait for settlement. */
  active = false;
  cycle = 0;
  private queue: Pending[] = [];
  private cycleBase: bigint[];
  private regrantTotal = 0n;
  private recoveredTotal = 0n;
  private botPnlTotal = 0n;
  readonly metrics;

  constructor(input: RunInput) {
    validateRegrant(input.candidate);
    this.input = input;
    this.cycles = input.cycles ?? CYCLES;
    const n = input.profile.people;
    this.draw = createRandom(input.seed);
    this.people = assignPeople(n, input.variant, this.draw);
    this.accounts = Array.from({ length: n }, () => new RegrantAccount());
    this.state = Array.from({ length: n }, () => ({
      episode: null,
      gaveUp: false,
      capped: false,
      episodes: 0,
      granted: 0n,
      grants: 0,
      firstGrantAt: null,
    }));
    this.wallets = Array.from({ length: n }, () => BUNDLE.startCoin);
    this.cycleBase = [...this.wallets];
    const byCycle = () => zeroes(this.cycles);
    this.metrics = {
      regrantByCycle: byCycle().map(() => 0n),
      recoveredByCycle: byCycle().map(() => 0n),
      botPnlByCycle: byCycle().map(() => 0n),
      exhaustion: Object.fromEntries(
        THRESHOLDS.map((t) => [String(t), { exhaust: byCycle(), normal: byCycle() }]),
      ) as Record<string, { exhaust: number[]; normal: number[] }>,
      requests: {
        sent: 0,
        granted: 0,
        refused: 0,
        replayed: 0,
        boundaryRetries: 0,
        notExhaustedDropped: 0,
        gaveUp: 0,
        capped: 0,
        refusals: Object.fromEntries(REASONS.map((r) => [r, 0])) as Record<
          (typeof REASONS)[number],
          number
        >,
      },
      exhaustToGrantMs: [] as number[],
      orders: {
        placed: 0,
        skippedBelowOneContract: 0,
        filledQty: 0,
        replaysSkipped: 0,
        rejections: {} as Record<string, number>,
      },
      bot: {
        minMarketPnl: null as bigint | null,
        maxMarketPnl: null as bigint | null,
        stageMs: { normal: 0, reduce: 0, halt: 0 },
        transitions: { reduce: 0, halt: 0 },
        maxReservedLossCoin: 0n,
        maxLossCoin: 0n,
        maxOverallReservedLossCoin: 0n,
      },
      existing: { audit: 0, replay: 0 },
      inputDigests: [] as string[],
      traceDigests: [] as string[],
    };
  }

  get values(): RegrantValues | null {
    return this.input.candidate.values;
  }
  /** When a person counts as exhausted for its own requests (R0: see R0_APPLY_AT_COIN). */
  get trigger(): bigint {
    return this.values?.thresholdCoin ?? R0_APPLY_AT_COIN;
  }
  available(i: number): bigint {
    if (!this.active || !this.economy) return this.wallets[i]!;
    return this.economy.wallets[i]! - this.economy.lockedCoin(human(i));
  }
  facts(i: number): RegrantFacts {
    let liveOrders = false;
    let unsettledPositions = false;
    if (this.active && this.economy)
      for (const m of this.economy.markets) {
        if (m.book.some((row) => row.owner.id === human(i))) liveOrders = true;
        const held = m.positions.get(human(i));
        if (held && (held.YES.qty > 0 || held.NO.qty > 0)) unsettledPositions = true;
      }
    return {
      restricted: false,
      admin: false,
      held: false,
      startGrantedAt: START_GRANTED_AT,
      availableCoin: this.available(i),
      liveOrders,
      unsettledPositions,
    };
  }

  private enqueue(item: Pending) {
    this.queue.push(item);
    this.queue.sort((a, b) => a.at - b.at || a.person - b.person);
  }
  /** The first settlement time at or after `at` and after `now`. */
  private settlementAfter(at: number, now: number) {
    const j = Math.max(Math.ceil(at / CYCLE_MS), Math.floor(now / CYCLE_MS) + 1);
    return j * CYCLE_MS;
  }

  private mint(i: number, amount: bigint, at: number) {
    if (this.active && this.economy) {
      mintInto(this.economy, i, amount);
      this.cycleBase[i]! += amount;
    } else this.wallets[i]! += amount;
    this.regrantTotal += amount;
    // The cycle whose span (T_k, T_k+1] holds the grant: one at a settlement time is that cycle's.
    this.metrics.regrantByCycle[Math.ceil(at / CYCLE_MS) - 1]! += amount;
  }

  /** One request of person `i` at `at`, with what follows from its answer. */
  request(i: number, at: number, kind: RequestKind) {
    const s = this.state[i]!;
    const episode = s.episode;
    assert.ok(episode, 'A request belongs to an episode');
    if (this.active && this.economy) this.economy.advance(at - this.cycle * CYCLE_MS);
    const facts = this.facts(i);
    const account = this.accounts[i]!;
    const before = [...account.rows];
    const values = this.values;
    const answer = account.apply(episode.requestId, values, facts, at);
    this.metrics.requests.sent++;
    if (kind === 'boundary-retry') {
      this.metrics.requests.boundaryRetries++;
      this.inv.check(NEW_INVARIANTS.boundary, answer.outcome === 'granted', answer);
    }
    if (answer.outcome === 'replayed') throw new Error('An open episode never reuses a granted id');
    if (answer.outcome === 'granted') {
      assert.ok(values);
      this.inv.check(
        NEW_INVARIANTS.decide,
        decide(values, facts, readHistory(before, at, values), at).eligible,
      );
      checkMint(this.inv, values, facts, before, at);
      this.mint(i, answer.regrant.amountCoin, at);
      checkMintOnce(this.inv, account.rows);
      const total = account.rows.reduce((sum, row) => sum + row.amountCoin, 0n);
      this.inv.check(NEW_INVARIANTS.cap, total <= values.totalCapCoin, { total });
      const inPeriod = account.rows.filter(
        (row) => row.createdAt > at - values.periodDays * DAY_MS,
      ).length;
      this.inv.check(NEW_INVARIANTS.period, inPeriod <= values.periodLimit, { inPeriod });
      // The answer lost: the same id sent again reads the same row back and mints nothing.
      const walletBefore = this.available(i);
      const again = account.apply(episode.requestId, values, this.facts(i), at);
      this.inv.check(
        NEW_INVARIANTS.once,
        again.outcome === 'replayed' &&
          again.regrant === answer.regrant &&
          this.available(i) === walletBefore &&
          account.rows.length === before.length + 1,
      );
      this.metrics.requests.replayed++;
      this.metrics.requests.granted++;
      this.metrics.exhaustToGrantMs.push(at - episode.startedAt);
      s.granted += answer.regrant.amountCoin;
      s.grants++;
      s.firstGrantAt ??= at;
      s.episode = null;
      return;
    }
    const { status } = answer;
    this.metrics.requests.refused++;
    for (const reason of status.refusals) {
      assert.ok((REASONS as readonly string[]).includes(reason), `Unmodelled refusal ${reason}`);
      this.metrics.requests.refusals[reason as (typeof REASONS)[number]]++;
    }
    const has = (reason: RegrantRefusal) => status.refusals.includes(reason);
    if (has('total_cap')) {
      s.capped = true;
      s.episode = null;
      this.metrics.requests.capped++;
      return;
    }
    if (has('not_ready')) {
      s.gaveUp = true;
      s.episode = null;
      this.metrics.requests.gaveUp++;
      return;
    }
    if (has('not_exhausted')) {
      s.episode = null;
      this.metrics.requests.notExhaustedDropped++;
      return;
    }
    const times = [status.waitUntil, status.nextPeriodAt].filter((t): t is number => t !== null);
    const reasonAt = times.length ? Math.max(...times) : at;
    if (this.people[i]!.behaviour === 'immediate' && kind !== 'settlement-retry' && times.length) {
      // 즉시: again at the later of waitUntil and nextPeriodAt, not trading until then.
      episode.waiting = true;
      this.enqueue({ at: reasonAt, person: i, kind: 'boundary-retry' });
    } else {
      // 지연 (or a refusal no time lifts): again at the first settlement after the reason's time.
      episode.waiting = false;
      this.enqueue({ at: this.settlementAfter(reasonAt, at), person: i, kind: 'settlement-retry' });
    }
  }

  /** Requests queued strictly before `limit` (or also exactly at it with `inclusive`). */
  private drain(limit: number, inclusive = false) {
    while (
      this.queue.length &&
      (this.queue[0]!.at < limit || (inclusive && this.queue[0]!.at === limit))
    ) {
      const item = this.queue.shift()!;
      this.request(item.person, item.at, item.kind);
    }
  }

  /** After a settlement: exhaustion counted, then new episodes (즉시 now, 지연 later, 안 함 none). */
  private afterSettlement(at: number, cycleIndex: number) {
    for (const t of THRESHOLDS) {
      const row = this.metrics.exhaustion[String(t)]!;
      this.people.forEach((person, i) => {
        if (this.wallets[i]! <= t) row[person.type][cycleIndex]!++;
      });
    }
    this.drain(at, true);
    this.people.forEach((person, i) => {
      const s = this.state[i]!;
      const exhausted = this.wallets[i]! <= this.trigger;
      if (!exhausted) s.gaveUp = false;
      if (!exhausted || s.episode || s.gaveUp || s.capped || person.behaviour === 'never') return;
      s.episodes++;
      s.episode = {
        requestId: `r-${String(i).padStart(4, '0')}-${String(s.episodes).padStart(6, '0')}`,
        startedAt: at,
        waiting: false,
      };
      if (person.behaviour === 'immediate') this.request(i, at, 'first');
      else if (person.delayHours === 0) this.request(i, at, 'delayed');
      else this.enqueue({ at: at + person.delayHours * HOUR_MS, person: i, kind: 'delayed' });
    });
  }

  /** Executes one tape event: the one-contract skip at the live best ask, the replay retarget. */
  private execute(
    economy: Economy,
    event: TapeEvent,
    byId: Map<string, TapeEvent>,
    executed: { first: string | null },
  ) {
    if (event.kind === 'buy' && event.at <= HORIZON_MS) {
      economy.advance(event.at);
      const m = economy.markets[event.market]!;
      const budget = coinBudget(BUNDLE, event);
      let ask: number | null = null;
      if (m.status === 'open') {
        const eligible = m.enabled ? m.book : m.book.filter((row) => row.owner.human);
        const depth = bookDepth(eligible, {
          book: economy.botBook(m),
          limits: limitsOf(economy.candidate),
        });
        ask = depth[OUTCOMES.indexOf(event.outcome)]!.bestAskCoin;
      }
      if (budget === 0n || (ask !== null && budget < BigInt(ask))) {
        this.metrics.orders.skippedBelowOneContract++;
        return;
      }
      this.metrics.orders.placed++;
      economy.execute(event, byId);
      executed.first ??= event.id;
      return;
    }
    if (event.kind === 'replay') {
      if (executed.first === null) {
        this.metrics.orders.replaysSkipped++;
        economy.advance(event.at);
        return;
      }
      economy.execute({ ...event, requestId: executed.first }, byId);
      return;
    }
    economy.execute(event, byId);
  }

  /** One cycle: tape, #71's scan loop with the requests interleaved, settlement, requests. */
  runCycle() {
    const k = this.cycle;
    const T = k * CYCLE_MS;
    const draws: CycleDraws = drawCycle(this.input.profile, this.draw);
    const trading = this.state.map((s) => !s.episode?.waiting);
    const tape = createCycleTape(k, this.input.profile, this.people, this.wallets, trading, draws);
    this.metrics.inputDigests.push(digest(tape));
    const economy = new Economy(BUNDLE, this.input.profile, MARKET_CASE);
    carryOver(economy, this.wallets);
    this.economy = economy;
    this.active = true;
    this.cycleBase = [...this.wallets];
    const byId = new Map(tape.map((event) => [event.id, event]));
    const executed = { first: null as string | null };
    let nextScan = SCAN_INTERVAL_MS;
    for (const event of tape) {
      while (nextScan <= event.at && nextScan < HORIZON_MS) {
        this.drain(T + nextScan);
        economy.advance(nextScan);
        for (const m of economy.markets)
          if (m.enabled && m.status === 'open' && m.nextRefresh === null)
            m.nextRefresh = nextScan + MARKET_CASE.refreshDelayMs;
        nextScan += SCAN_INTERVAL_MS;
      }
      this.drain(T + event.at);
      this.execute(economy, event, byId, executed);
    }
    economy.advance(HORIZON_MS + 1);
    this.drain(T + CYCLE_MS);
    this.collectCycle(economy);
    const settled = settleCycle(this.inv, economy, draws.results, this.cycleBase);
    this.wallets = settled.wallets;
    this.active = false;
    this.recoveredTotal += settled.recovered;
    this.botPnlTotal += settled.botPnl;
    this.metrics.recoveredByCycle[k] = settled.recovered;
    this.metrics.botPnlByCycle[k] = settled.botPnl;
    const bot = this.metrics.bot;
    for (const row of settled.markets) {
      bot.minMarketPnl =
        bot.minMarketPnl === null || row.pnl < bot.minMarketPnl ? row.pnl : bot.minMarketPnl;
      bot.maxMarketPnl =
        bot.maxMarketPnl === null || row.pnl > bot.maxMarketPnl ? row.pnl : bot.maxMarketPnl;
    }
    this.cycle++;
    const at = this.cycle * CYCLE_MS;
    this.checkTotals();
    this.afterSettlement(at, k);
    this.checkTotals();
    return { economy, tape, draws, settled };
  }

  private collectCycle(economy: Economy) {
    const bot = this.metrics.bot;
    const last = new Map<number, string>();
    for (const row of economy.trace)
      if (row.kind === 'refresh') {
        const market = row.market as number;
        const stage = row.stage as string;
        if (stage !== (last.get(market) ?? 'normal') && (stage === 'reduce' || stage === 'halt'))
          bot.transitions[stage]++;
        last.set(market, stage);
      }
    for (const m of economy.markets) {
      bot.stageMs.normal += m.stats.stageMs.normal;
      bot.stageMs.reduce += m.stats.stageMs.reduce;
      bot.stageMs.halt += m.stats.stageMs.halt;
      if (m.stats.maxReservedLoss > bot.maxReservedLossCoin)
        bot.maxReservedLossCoin = m.stats.maxReservedLoss;
      if (m.stats.maxLoss > bot.maxLossCoin) bot.maxLossCoin = m.stats.maxLoss;
      this.metrics.orders.filledQty += m.stats.filledQty;
    }
    if (economy.maxOverallReservedLoss > bot.maxOverallReservedLossCoin)
      bot.maxOverallReservedLossCoin = economy.maxOverallReservedLoss;
    for (const [reason, count] of Object.entries(economy.rejections))
      this.metrics.orders.rejections[reason] =
        (this.metrics.orders.rejections[reason] ?? 0) + count;
    this.metrics.existing.audit += economy.invariantChecks;
    this.metrics.existing.replay += economy.replayChecks;
    this.metrics.traceDigests.push(digest(economy.trace));
  }

  /** Whole-run issuance and the PnL basis after every settlement and its requests. */
  private checkTotals() {
    const n = BigInt(this.input.profile.people);
    const m = BigInt(this.input.profile.markets);
    const issued =
      BUNDLE.startCoin * n + BUNDLE.budgetCoin * m * BigInt(this.cycle) + this.regrantTotal;
    const held = this.wallets.reduce((sum, coin) => sum + coin, 0n) + this.recoveredTotal;
    checkIssuance(this.inv, issued, held);
    checkPnlBasis(
      this.inv,
      this.wallets,
      this.state.map((s) => s.granted),
      BUNDLE.startCoin,
      this.botPnlTotal,
    );
  }

  run() {
    while (this.cycle < this.cycles) this.runCycle();
    return this.summary();
  }

  summary() {
    const { candidate, profile, variant, seed } = this.input;
    const n = profile.people;
    const groups: Record<
      string,
      { people: number; grants: number; regrantCoin: bigint; tradingPnlCoin: bigint }
    > = {};
    const histogram: Record<string, number> = {};
    let recipients = 0;
    let recipientsLoss = 0n;
    let recipientsRegrant = 0n;
    let capReached = 0;
    const firstGrantMs: number[] = [];
    this.people.forEach((person, i) => {
      const s = this.state[i]!;
      const key = `${person.type}/${person.behaviour}`;
      const g = (groups[key] ??= { people: 0, grants: 0, regrantCoin: 0n, tradingPnlCoin: 0n });
      const pnl = this.wallets[i]! - BUNDLE.startCoin - s.granted;
      g.people++;
      g.grants += s.grants;
      g.regrantCoin += s.granted;
      g.tradingPnlCoin += pnl;
      histogram[String(s.grants)] = (histogram[String(s.grants)] ?? 0) + 1;
      if (s.grants > 0) {
        recipients++;
        recipientsLoss -= pnl;
        recipientsRegrant += s.granted;
        firstGrantMs.push(s.firstGrantAt!);
      }
      if (this.values && s.granted === this.values.totalCapCoin) capReached++;
    });
    const sortedGroups = Object.fromEntries(
      Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)),
    );
    const finalExhausted = Object.fromEntries(
      THRESHOLDS.map((t) => [String(t), this.wallets.filter((coin) => coin <= t).length]),
    );
    // Not yet granted at the end: episodes still open (their age at the last settlement), and
    // accounts refused `total_cap` that are still at or below the trigger.
    const end = this.cycle * CYCLE_MS;
    const openEpisodeAgeMs = this.state
      .flatMap((s) => (s.episode ? [end - s.episode.startedAt] : []))
      .sort((a, b) => a - b);
    const cappedExhaustedAtEnd = this.state.filter(
      (s, i) => s.capped && this.wallets[i]! <= this.trigger,
    ).length;
    return {
      candidate: candidate.id,
      values: candidate.values,
      profile: profile.id,
      people: n,
      markets: profile.markets,
      variant: variant.id,
      seed,
      cycles: this.cycles,
      peopleByType: {
        exhaust: this.people.filter((p) => p.type === 'exhaust').length,
        normal: this.people.filter((p) => p.type === 'normal').length,
        immediate: this.people.filter((p) => p.behaviour === 'immediate').length,
        delayed: this.people.filter((p) => p.behaviour === 'delayed').length,
        never: this.people.filter((p) => p.behaviour === 'never').length,
      },
      issuance: {
        startCoin: BUNDLE.startCoin * BigInt(n),
        treasuryCoin: BUNDLE.budgetCoin * BigInt(profile.markets) * BigInt(this.cycles),
        regrantCoin: this.regrantTotal,
        regrantByCycle: this.metrics.regrantByCycle,
      },
      recovery: {
        recoveredCoin: this.recoveredTotal,
        recoveredByCycle: this.metrics.recoveredByCycle,
      },
      recipients: {
        accounts: recipients,
        grantCountHistogram: histogram,
        capReached,
        firstGrantMs: firstGrantMs.sort((a, b) => a - b),
        exhaustToGrantMs: [...this.metrics.exhaustToGrantMs].sort((a, b) => a - b),
        tradingLossCoin: recipientsLoss,
        regrantCoin: recipientsRegrant,
      },
      groups: sortedGroups,
      exhaustion: { byCycle: this.metrics.exhaustion, final: finalExhausted },
      requests: { ...this.metrics.requests, pendingAtEnd: this.queue.length },
      unfinished: {
        openEpisodesAtEnd: openEpisodeAgeMs.length,
        openEpisodeAgeMs,
        cappedExhaustedAtEnd,
      },
      orders: this.metrics.orders,
      bot: {
        ...this.metrics.bot,
        pnlCoin: this.botPnlTotal,
        pnlByCycle: this.metrics.botPnlByCycle,
        maxLossLimitCoin: BUNDLE.maxLossCoin,
      },
      walletsCoin: {
        total: this.wallets.reduce((sum, coin) => sum + coin, 0n),
        min: this.wallets.reduce((a, b) => (b < a ? b : a)),
        max: this.wallets.reduce((a, b) => (b > a ? b : a)),
      },
      invariants: {
        existing: {
          'audit()': this.metrics.existing.audit,
          'Replay changes no assets or locks': this.metrics.existing.replay,
          ...Object.fromEntries(
            Object.values(SETTLEMENT_INVARIANTS).map((name) => [name, this.inv.counts[name] ?? 0]),
          ),
        },
        new: Object.fromEntries(
          Object.values(NEW_INVARIANTS).map((name) => [name, this.inv.counts[name] ?? 0]),
        ),
        violations: 0,
      },
      inputDigests: this.metrics.inputDigests,
      traceDigest: digest(this.metrics.traceDigests),
    };
  }
}
export type RunSummary = ReturnType<RegrantRun['summary']>;

export class RegrantSimulationFailure extends Error {
  readonly evidence: unknown;
  constructor(input: RunInput, cycle: number, cause: unknown) {
    super(
      `Regrant simulation invariant failed: ${input.candidate.id}/${input.profile.id}/${input.variant.id}/${input.seed} cycle ${cycle + 1}`,
      { cause },
    );
    this.evidence = {
      input,
      cycle,
      error:
        cause instanceof Error ? { message: cause.message, stack: cause.stack } : String(cause),
    };
  }
}

export function simulateRegrant(input: RunInput): RunSummary {
  const run = new RegrantRun(input);
  try {
    return run.run();
  } catch (error) {
    throw new RegrantSimulationFailure(input, run.cycle, error);
  }
}
