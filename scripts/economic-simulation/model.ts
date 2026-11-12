import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CONTRACT_TERMS,
  applyBuy,
  applySell,
  applyPairBurn,
  settlePosition,
  botRisk,
  bookDepth,
  orderIntakeLock,
  orderRemainingLock,
  planRiskIntakeMatch,
  quoteLadder,
  planBotQuotes,
  reconcileBotQuotes,
  referencePriceCoin,
  type BookOrder,
  type BotBook,
  type LiveBotOrder,
  type Outcome,
  type OrderTerms,
  type PositionState,
  type MatchFill,
  type RiskStage,
} from '../../packages/shared/dist/index.js';
import {
  coinBudget,
  createTape,
  HORIZON_MS,
  SCAN_INTERVAL_MS,
  SETTLEMENT_WAIT_MS,
  limitsOf,
  validateCandidate,
  type Candidate,
  type Profile,
  type ScenarioCase,
  type TapeEvent,
} from './inputs.ts';

export const json = (value: unknown) =>
  JSON.stringify(value, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
export const digest = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');
const zero = (): PositionState => ({ qty: 0, costBasisCoin: 0n, realizedPnlCoin: 0n });
const OUTCOMES = ['YES', 'NO'] as const;
const humanId = (actor: number) => `H${actor}`;
const isHuman = (id: string) => id.startsWith('H');
const opposite = (outcome: Outcome): Outcome => (outcome === 'YES' ? 'NO' : 'YES');

interface Supply {
  at: number;
  open: boolean;
  botMissing: boolean;
  allMissing: boolean;
  stage: RiskStage;
  spread: number | null;
  reference: number;
}
interface Market {
  id: number;
  ownerId: string;
  coin: bigint;
  collateral: bigint;
  status: 'open' | 'paused' | 'closed' | 'cancelled';
  enabled: boolean;
  book: BookOrder[];
  positions: Map<string, Record<Outcome, PositionState>>;
  nextRefresh: number | null;
  humanFills: number;
  observation: Supply;
  stats: {
    openMs: number;
    pausedMs: number;
    botMissingMs: number;
    allMissingMs: number;
    spreadSum: number;
    spreadMs: number;
    maxSpread: number;
    stageMs: Record<RiskStage, number>;
    maxLoss: bigint;
    maxReservedLoss: bigint;
    maxUtilizationBp: bigint;
    maxReferenceDisplacement: number;
    postedQty: number;
    botFilledQty: number;
    burns: number;
    burnedQty: number;
    requestCount: number;
    fullIocCount: number;
    filledQty: number;
    amountCoin: bigint;
    maxFillPriceRange: number;
    maxSingleOrderReferenceMove: number;
    cancellations: number;
    refreshes: number;
  };
}
export interface OrderResult {
  kind: 'placed' | 'rejected';
  reason: string | null;
  filledQty: number;
  amountCoin: bigint;
  remainingQty: number | null;
  unspentCoin: bigint | null;
  status: string;
  protectedLimit: number;
  fills: readonly MatchFill[];
}
interface Saved {
  fingerprint: string;
  result: OrderResult;
}
export interface Trace {
  at: number;
  kind: string;
  [key: string]: unknown;
}

/** In-memory economic adapter around production pure rules. No DB transaction/approval/queue proof. */
export class Economy {
  readonly candidate: Candidate;
  readonly profile: Profile;
  readonly scenario: ScenarioCase;
  readonly wallets: bigint[];
  readonly markets: Market[];
  readonly issued: bigint;
  readonly trace: Trace[] = [];
  readonly replays = new Map<string, Saved>();
  readonly rejections: Record<string, number> = {};
  at = 0;
  arrival = 0;
  transferCount = 0;
  invariantChecks = 0;
  replayChecks = 0;
  maxOverallLoss = 0n;
  maxOverallReservedLoss = 0n;
  humanFillCount = 0;

  constructor(candidate: Candidate, profile: Profile, scenario: ScenarioCase) {
    validateCandidate(candidate);
    this.candidate = candidate;
    this.profile = profile;
    this.scenario = scenario;
    this.wallets = Array.from({ length: profile.people }, () => candidate.startCoin);
    this.issued =
      candidate.startCoin * BigInt(profile.people) + candidate.budgetCoin * BigInt(profile.markets);
    this.markets = Array.from({ length: profile.markets }, (_, id) => ({
      id,
      ownerId: `B${id}`,
      coin: candidate.budgetCoin,
      collateral: 0n,
      status: 'open',
      enabled: true,
      book: [],
      positions: new Map(),
      nextRefresh: null,
      humanFills: 0,
      observation: {
        at: 0,
        open: true,
        botMissing: true,
        allMissing: true,
        stage: 'normal',
        spread: null,
        reference: 50,
      },
      stats: {
        openMs: 0,
        pausedMs: 0,
        botMissingMs: 0,
        allMissingMs: 0,
        spreadSum: 0,
        spreadMs: 0,
        maxSpread: 0,
        stageMs: { normal: 0, reduce: 0, halt: 0 },
        maxLoss: 0n,
        maxReservedLoss: 0n,
        maxUtilizationBp: 0n,
        maxReferenceDisplacement: 0,
        postedQty: 0,
        botFilledQty: 0,
        burns: 0,
        burnedQty: 0,
        requestCount: 0,
        fullIocCount: 0,
        filledQty: 0,
        amountCoin: 0n,
        maxFillPriceRange: 0,
        maxSingleOrderReferenceMove: 0,
        cancellations: 0,
        refreshes: 0,
      },
    }));
    this.trace.push({
      at: 0,
      kind: 'initialize',
      people: profile.people,
      markets: profile.markets,
      humanIssuedCoin: candidate.startCoin * BigInt(profile.people),
      treasuryIssuedCoin: candidate.budgetCoin * BigInt(profile.markets),
      allocatedCoin: candidate.budgetCoin * BigInt(profile.markets),
      initialPairs: 0,
    });
    for (const market of this.markets) this.refresh(market);
    this.audit();
  }
  positions(m: Market, id: string): Record<Outcome, PositionState> {
    let row = m.positions.get(id);
    if (!row) {
      row = { YES: zero(), NO: zero() };
      m.positions.set(id, row);
    }
    return row;
  }
  coin(m: Market, id: string): bigint {
    return isHuman(id) ? this.wallets[Number(id.slice(1))]! : m.coin;
  }
  changeCoin(m: Market, id: string, delta: bigint) {
    if (isHuman(id)) this.wallets[Number(id.slice(1))]! += delta;
    else {
      assert.equal(id, m.ownerId);
      m.coin += delta;
    }
  }
  botBook(m: Market): BotBook {
    const p = m.positions.get(m.ownerId);
    return {
      coin: m.coin,
      yesQty: p?.YES.qty ?? 0,
      noQty: p?.NO.qty ?? 0,
      invested: this.candidate.budgetCoin,
      recovered: 0n,
    };
  }
  botOrders(m: Market): LiveBotOrder[] {
    return m.book
      .filter((row) => !row.owner.human)
      .map((row) => ({
        id: row.id,
        outcome: row.outcome,
        side: row.side,
        priceCoin: row.priceCoin,
        qty: row.remainingQty,
      }));
  }
  lockedCoin(id: string): bigint {
    let locked = 0n;
    for (const market of this.markets)
      for (const row of market.book)
        if (row.owner.id === id && row.side === 'buy') {
          const value = orderRemainingLock({
            side: 'buy',
            outcome: row.outcome,
            limitPriceCoin: row.priceCoin,
            qty: row.remainingQty,
            filledQty: 0,
            budgetCoin: null,
            live: true,
          });
          if (value.kind === 'coin') locked += value.amountCoin;
        }
    return locked;
  }
  lockedQty(m: Market, id: string, outcome: Outcome): number {
    return m.book
      .filter((row) => row.owner.id === id && row.outcome === outcome && row.side === 'sell')
      .reduce((n, row) => n + row.remainingQty, 0);
  }
  private recordRejection(reason: string) {
    this.rejections[reason] = (this.rejections[reason] ?? 0) + 1;
  }
  private cancelled(m: Market, id: string, reason: string) {
    const index = m.book.findIndex((row) => row.id === id);
    assert.ok(index >= 0, 'Cancel targets a live remainder');
    const [row] = m.book.splice(index, 1);
    m.stats.cancellations++;
    this.trace.push({
      at: this.at,
      kind: 'cancel',
      market: m.id,
      id,
      owner: row!.owner.id,
      qty: row!.remainingQty,
      reason,
    });
  }
  private markDirty(m: Market) {
    if (m.enabled && m.status === 'open' && m.nextRefresh === null)
      m.nextRefresh = this.at + this.scenario.refreshDelayMs;
  }
  private applyFill(m: Market, incomingOwner: string, terms: OrderTerms, fill: MatchFill) {
    const resting = m.book.find((row) => row.id === fill.restingOrderId);
    assert.ok(resting, 'Resting order exists before fill');
    assert.ok(incomingOwner !== resting.owner.id, 'No same-person fill');
    assert.ok(isHuman(incomingOwner) || resting.owner.human, 'No MM self-group fill');
    if (fill.kind === 'pair_mint') {
      assert.equal(terms.side, 'buy');
      assert.equal(resting.side, 'buy');
      assert.equal(resting.outcome, opposite(terms.outcome));
      assert.equal(fill.priceCoin + fill.restingPriceCoin, 100);
      this.changeCoin(m, incomingOwner, -fill.amountCoin);
      const restingCost = BigInt(fill.restingPriceCoin) * BigInt(fill.qty);
      this.changeCoin(m, resting.owner.id, -restingCost);
      const a = this.positions(m, incomingOwner),
        b = this.positions(m, resting.owner.id);
      a[terms.outcome] = applyBuy(a[terms.outcome], fill.qty, fill.amountCoin);
      b[resting.outcome] = applyBuy(b[resting.outcome], fill.qty, restingCost);
      m.collateral += 100n * BigInt(fill.qty);
      this.transferCount += 2;
    } else {
      assert.equal(resting.outcome, terms.outcome);
      const buyer = terms.side === 'buy' ? incomingOwner : resting.owner.id;
      const seller = terms.side === 'sell' ? incomingOwner : resting.owner.id;
      this.changeCoin(m, buyer, -fill.amountCoin);
      this.changeCoin(m, seller, fill.amountCoin);
      const a = this.positions(m, buyer),
        b = this.positions(m, seller);
      a[terms.outcome] = applyBuy(a[terms.outcome], fill.qty, fill.amountCoin);
      b[terms.outcome] = applySell(b[terms.outcome], fill.qty, fill.amountCoin);
      this.transferCount++;
    }
    if (fill.restingRemainingQty === 0) m.book = m.book.filter((row) => row.id !== resting.id);
    else
      m.book = m.book.map((row) =>
        row.id === resting.id ? { ...row, remainingQty: fill.restingRemainingQty } : row,
      );
    if (!isHuman(incomingOwner) || !resting.owner.human) {
      m.stats.botFilledQty += fill.qty;
      this.markDirty(m);
    }
    m.humanFills++;
    this.humanFillCount++;
    this.trace.push({
      ...fill,
      at: this.at,
      kind: 'fill',
      fillKind: fill.kind,
      market: m.id,
      incomingOwner,
    });
  }
  private burn(m: Market) {
    if (m.status !== 'open') return;
    const held = m.positions.get(m.ownerId);
    if (!held) return;
    const qty = Math.min(
      held.YES.qty - this.lockedQty(m, m.ownerId, 'YES'),
      held.NO.qty - this.lockedQty(m, m.ownerId, 'NO'),
    );
    if (qty === 0) return;
    const pnlBefore = botRisk(this.botBook(m), [], limitsOf(this.candidate), CONTRACT_TERMS).pnl;
    const changed = applyPairBurn(held.YES, held.NO, qty);
    m.positions.set(m.ownerId, changed);
    const amount = BigInt(qty) * 100n;
    m.collateral -= amount;
    m.coin += amount;
    this.transferCount++;
    m.stats.burns++;
    m.stats.burnedQty += qty;
    assert.deepEqual(
      botRisk(this.botBook(m), [], limitsOf(this.candidate), CONTRACT_TERMS).pnl,
      pnlBefore,
      'Burn preserves every result PnL',
    );
    this.trace.push({ at: this.at, kind: 'burn', market: m.id, qty, amountCoin: amount });
  }

  /** Whole economic request; failure plans never mutate assets/book. IDs replay before gates. */
  order(
    m: Market,
    ownerId: string,
    requestId: string,
    terms: OrderTerms,
    measure = true,
  ): OrderResult {
    const fingerprint = json({ market: m.id, ownerId, terms });
    const saved = this.replays.get(requestId);
    if (saved) {
      assert.equal(saved.fingerprint, fingerprint, 'Same request ID cannot change terms');
      return saved.result;
    }
    const human = isHuman(ownerId);
    const owner = { id: ownerId, human };
    const declined = (reason: string, limit = terms.limitPriceCoin): OrderResult => ({
      kind: 'rejected',
      reason,
      filledQty: 0,
      amountCoin: 0n,
      remainingQty: terms.qty,
      unspentCoin: terms.budgetCoin,
      status: 'rejected',
      protectedLimit: limit,
      fills: [],
    });
    let value: OrderResult;
    if (measure && human && terms.timeInForce === 'ioc') m.stats.requestCount++;
    if (m.status !== 'open' || this.at >= HORIZON_MS)
      value = declined(m.status === 'paused' ? 'paused' : 'closed');
    else if (!human && !m.enabled) value = declined('bot_stopped');
    else {
      const raw = m.enabled ? m.book : m.book.filter((row) => row.owner.human);
      const planned = planRiskIntakeMatch(raw, terms, this.candidate.protectionTicks, owner, {
        book: this.botBook(m),
        limits: limitsOf(this.candidate),
      });
      if (planned.kind !== 'planned')
        value = declined(planned.reason, planned.protectedLimitPriceCoin);
      else {
        const { plan } = planned;
        const lock = orderIntakeLock({
          side: terms.side,
          outcome: terms.outcome,
          limitPriceCoin: terms.budgetCoin === null ? plan.protectedLimitPriceCoin : null,
          qty: terms.qty,
          filledQty: 0,
          budgetCoin: terms.budgetCoin,
          live: true,
        });
        const enough =
          lock.kind === 'coin'
            ? lock.amountCoin <= this.coin(m, ownerId) - this.lockedCoin(ownerId)
            : lock.qty <=
              (m.positions.get(ownerId)?.[terms.outcome].qty ?? 0) -
                this.lockedQty(m, ownerId, terms.outcome);
        if (!enough)
          value = declined(
            lock.kind === 'coin' ? 'insufficient_coin' : 'insufficient_contracts',
            plan.protectedLimitPriceCoin,
          );
        else {
          const referenceBefore = referencePriceCoin(
            this.botBook(m).noQty - this.botBook(m).yesQty,
            this.candidate.b,
            100,
          );
          for (const fill of plan.result.fills) this.applyFill(m, ownerId, terms, fill);
          for (const cancellation of planned.botCancellations) {
            assert.equal(
              m.book.find((row) => row.id === cancellation.orderId)?.remainingQty,
              cancellation.qty,
            );
            this.cancelled(m, cancellation.orderId, 'risk_remainder');
            this.markDirty(m);
          }
          assert.deepEqual(
            this.botBook(m),
            planned.projectedBook,
            'Adapter uses actual resting price and fills exactly',
          );
          if (plan.result.remainder === 'rest' && plan.result.remainingQty! > 0) {
            m.book.push({
              id: `order-${++this.arrival}`,
              owner,
              outcome: terms.outcome,
              side: terms.side,
              priceCoin: plan.protectedLimitPriceCoin,
              remainingQty: plan.result.remainingQty!,
              arrival: this.arrival,
            });
          }
          if (!human && plan.end.status !== 'rejected') m.stats.postedQty += terms.qty!;
          this.burn(m);
          const after = referencePriceCoin(
            this.botBook(m).noQty - this.botBook(m).yesQty,
            this.candidate.b,
            100,
          );
          if (human)
            m.stats.maxSingleOrderReferenceMove = Math.max(
              m.stats.maxSingleOrderReferenceMove,
              Math.abs(after - referenceBefore),
            );
          value = {
            kind: 'placed',
            reason: plan.end.rejectReason ?? plan.end.cancelReason,
            filledQty: plan.result.filledQty,
            amountCoin: plan.result.amountCoin,
            remainingQty: plan.result.remainingQty,
            unspentCoin: plan.result.unspentCoin,
            status: plan.end.status,
            protectedLimit: plan.protectedLimitPriceCoin,
            fills: plan.result.fills,
          };
          if (human && measure) {
            m.stats.filledQty += value.filledQty;
            m.stats.amountCoin += value.amountCoin;
            if (terms.timeInForce === 'ioc' && plan.end.status === 'filled') m.stats.fullIocCount++;
            if (value.fills.length) {
              const prices = value.fills.map((fill) => fill.priceCoin);
              m.stats.maxFillPriceRange = Math.max(
                m.stats.maxFillPriceRange,
                Math.max(...prices) - Math.min(...prices),
              );
            }
          }
        }
      }
    }
    if (value.reason && human && measure) this.recordRejection(value.reason);
    this.replays.set(requestId, { fingerprint, result: value });
    this.trace.push({
      at: this.at,
      kind: 'order',
      market: m.id,
      ownerId,
      requestId,
      terms,
      result: {
        ...value,
        fills: value.fills.map((fill) => ({
          restingOrderId: fill.restingOrderId,
          qty: fill.qty,
          priceCoin: fill.priceCoin,
        })),
      },
    });
    return value;
  }

  refresh(m: Market) {
    m.nextRefresh = null;
    if (m.status !== 'open' || !m.enabled) return;
    m.stats.refreshes++;
    this.burn(m);
    const held = this.botBook(m);
    const ladder = quoteLadder(held.noQty - held.yesQty, this.candidate, CONTRACT_TERMS);
    const target = planBotQuotes(
      ladder,
      held,
      this.botOrders(m),
      this.candidate.quantity,
      limitsOf(this.candidate),
      CONTRACT_TERMS,
    );
    const changes = reconcileBotQuotes(target, this.botOrders(m));
    for (const row of changes.cancel) this.cancelled(m, row.id, 'refresh');
    const replacement = reconcileBotQuotes(target, this.botOrders(m));
    assert.equal(replacement.cancel.length, 0);
    const refused = new Set<Outcome>();
    for (const row of replacement.place) {
      if (refused.has(row.outcome)) continue;
      const result = this.order(
        m,
        m.ownerId,
        `bot-${m.id}-${++this.arrival}`,
        {
          outcome: row.outcome,
          side: 'buy',
          timeInForce: 'gtc',
          limitPriceCoin: row.priceCoin,
          qty: row.qty,
          budgetCoin: null,
        },
        false,
      );
      if (result.status === 'rejected') refused.add(row.outcome);
      // Same #129 contract: an actual fill changes inventory; do not post the stale ladder tail.
      if (result.filledQty > 0) break;
    }
    this.trace.push({
      at: this.at,
      kind: 'refresh',
      market: m.id,
      stage: target.stage,
      liveBotOrders: this.botOrders(m),
    });
    this.observe(m);
  }
  /** Advance synthetic time; queues are serialized, equal-time user inputs keep tape order. */
  advance(at: number) {
    assert.ok(at >= this.at);
    let count = 0;
    for (;;) {
      const next = this.markets
        .filter((m) => m.nextRefresh !== null && m.nextRefresh <= at)
        .sort((a, b) => a.nextRefresh! - b.nextRefresh! || a.id - b.id)[0];
      if (!next) break;
      assert.ok(++count < 100000, 'Bounded refresh queue converges');
      this.at = next.nextRefresh!;
      this.refresh(next);
      this.audit();
    }
    this.at = at;
  }
  observe(m: Market) {
    const previous = m.observation;
    const elapsed = this.at - previous.at;
    assert.ok(elapsed >= 0);
    if (previous.open) {
      m.stats.openMs += elapsed;
      if (previous.botMissing) m.stats.botMissingMs += elapsed;
      if (previous.allMissing) m.stats.allMissingMs += elapsed;
      m.stats.stageMs[previous.stage] += elapsed;
      if (previous.spread !== null) {
        m.stats.spreadSum += previous.spread * elapsed;
        m.stats.spreadMs += elapsed;
      }
    } else if (m.status === 'paused' || previous.at < HORIZON_MS) m.stats.pausedMs += elapsed;
    const book = this.botBook(m);
    const risk = botRisk(book, this.botOrders(m), limitsOf(this.candidate), CONTRACT_TERMS);
    const eligible = m.enabled ? m.book : m.book.filter((row) => row.owner.human);
    const depth = bookDepth(eligible, { book, limits: limitsOf(this.candidate) });
    const botDepth = bookDepth(m.enabled ? m.book.filter((row) => !row.owner.human) : [], {
      book,
      limits: limitsOf(this.candidate),
    });
    const yes = depth[0]!;
    const spread =
      yes.bestAskCoin === null || yes.bestBidCoin === null
        ? null
        : yes.bestAskCoin - yes.bestBidCoin;
    const reference = referencePriceCoin(book.noQty - book.yesQty, this.candidate.b, 100);
    m.observation = {
      at: this.at,
      open: m.status === 'open' && this.at < HORIZON_MS,
      botMissing: botDepth.some((row) => row.bids.length === 0),
      allMissing: depth.some((row) => row.asks.length === 0),
      stage: risk.stage,
      spread,
      reference,
    };
    if (spread !== null) m.stats.maxSpread = Math.max(m.stats.maxSpread, spread);
    m.stats.maxReferenceDisplacement = Math.max(
      m.stats.maxReferenceDisplacement,
      Math.abs(reference - 50),
    );
    m.stats.maxLoss = m.stats.maxLoss > risk.worstLoss ? m.stats.maxLoss : risk.worstLoss;
    m.stats.maxReservedLoss =
      m.stats.maxReservedLoss > risk.reservedWorstLoss
        ? m.stats.maxReservedLoss
        : risk.reservedWorstLoss;
    m.stats.maxUtilizationBp =
      m.stats.maxUtilizationBp > risk.utilizationBp ? m.stats.maxUtilizationBp : risk.utilizationBp;
  }
  execute(event: TapeEvent, byId: Map<string, TapeEvent>) {
    this.advance(event.at);
    if (event.kind === 'replay') {
      const original = byId.get(event.requestId);
      assert.ok(original && original.kind === 'buy');
      const before = this.assetDigest();
      this.execute({ ...original, at: this.at }, byId);
      assert.equal(this.assetDigest(), before, 'Replay changes no assets or locks');
      this.replayChecks++;
      return;
    }
    const market = this.markets[event.market]!;
    if (event.kind === 'pause' || event.kind === 'close' || event.kind === 'bot-stop') {
      if (event.kind === 'bot-stop') market.enabled = false;
      else
        market.status =
          event.kind === 'pause' ? 'paused' : market.humanFills === 0 ? 'cancelled' : 'closed';
      market.nextRefresh = null;
      for (const order of [...market.book])
        if (event.kind !== 'bot-stop' || !order.owner.human)
          this.cancelled(market, order.id, event.kind);
      this.trace.push({ at: this.at, kind: event.kind, market: market.id });
    } else if ('actor' in event) {
      const amount = (this.candidate.startCoin * BigInt(event.budgetBp)) / 10000n;
      const terms: OrderTerms =
        event.kind === 'buy'
          ? {
              outcome: event.outcome,
              side: 'buy',
              timeInForce: 'ioc',
              limitPriceCoin: event.limit,
              qty: null,
              budgetCoin: coinBudget(this.candidate, event),
            }
          : {
              outcome: event.outcome,
              side: event.kind === 'sell' ? 'sell' : 'buy',
              timeInForce: event.kind === 'sell' ? 'ioc' : 'gtc',
              limitPriceCoin: event.limit,
              qty: Number(amount / 50n),
              budgetCoin: null,
            };
      if (terms.budgetCoin === 0n || terms.qty === 0) {
        this.recordRejection('below_one_contract_input');
        this.trace.push({ at: this.at, kind: 'unrepresentable', input: event });
      } else this.order(market, humanId(event.actor), event.id, terms);
    }
    this.observe(market);
    this.audit();
  }
  assetDigest() {
    return digest({
      wallets: this.wallets,
      markets: this.markets.map((m) => ({
        coin: m.coin,
        collateral: m.collateral,
        status: m.status,
        book: m.book,
        positions: [...m.positions],
      })),
      transfers: this.transferCount,
    });
  }
  audit() {
    this.invariantChecks++;
    let actual = this.wallets.reduce((sum, coin) => sum + coin, 0n);
    let loss = 0n,
      reserved = 0n;
    const humanLocks = new Map<string, bigint>();
    for (const m of this.markets) {
      actual += m.coin + m.collateral;
      assert.ok(m.coin >= 0n && m.collateral >= 0n, 'Nonnegative market funds and collateral');
      const qty = { YES: 0, NO: 0 };
      for (const [id, rows] of m.positions)
        for (const outcome of OUTCOMES) {
          const p = rows[outcome];
          assert.ok(
            Number.isSafeInteger(p.qty) &&
              p.qty >= 0 &&
              p.costBasisCoin >= 0n &&
              (p.qty > 0 || p.costBasisCoin === 0n),
            'Position integrity',
          );
          qty[outcome] += p.qty;
          assert.ok(this.lockedQty(m, id, outcome) <= p.qty, 'Sell reservations have holdings');
        }
      assert.equal(qty.YES, qty.NO, 'Equal unsettled YES/NO supply');
      assert.equal(m.collateral, BigInt(qty.YES) * 100n, 'Collateral equals outstanding pairs');
      const botLocks = this.lockedCoin(m.ownerId);
      assert.ok(botLocks <= m.coin, 'MM buy reservations have funds');
      for (const order of m.book) {
        assert.ok(order.remainingQty > 0 && Number.isSafeInteger(order.remainingQty));
        if (order.owner.human && order.side === 'buy')
          humanLocks.set(
            order.owner.id,
            (humanLocks.get(order.owner.id) ?? 0n) +
              BigInt(order.priceCoin) * BigInt(order.remainingQty),
          );
      }
      const risk = botRisk(
        this.botBook(m),
        this.botOrders(m),
        limitsOf(this.candidate),
        CONTRACT_TERMS,
      );
      assert.ok(
        risk.worstLoss <= this.candidate.maxLossCoin &&
          risk.reservedWorstLoss <= this.candidate.maxLossCoin,
        'Every market/results reservation stays within L',
      );
      loss += risk.worstLoss;
      reserved += risk.reservedWorstLoss;
      if (m.status !== 'open')
        assert.equal(m.book.length, 0, 'Pause/close expires every modeled lock');
    }
    for (let i = 0; i < this.wallets.length; i++)
      assert.ok(
        this.wallets[i]! >= (humanLocks.get(humanId(i)) ?? 0n),
        'Nonnegative human available Coin',
      );
    assert.equal(
      actual,
      this.issued,
      'Issued Coin equals all available+locked wallets/funds/collateral',
    );
    this.maxOverallLoss = this.maxOverallLoss > loss ? this.maxOverallLoss : loss;
    this.maxOverallReservedLoss =
      this.maxOverallReservedLoss > reserved ? this.maxOverallReservedLoss : reserved;
  }

  settlements() {
    return (['YES', 'NO', 'VOID'] as const).map((result) => {
      const wallets = [...this.wallets];
      let treasury = 0n;
      let paidCoin = 0n;
      const completed = new Map<number, { paid: bigint; recall: bigint; pnl: bigint }>();
      const pay = (m: Market) => {
        if (completed.has(m.id)) return;
        assert.equal(m.book.length, 0);
        let collateral = m.collateral;
        let funds = m.coin;
        let paid = 0n;
        for (const [id, rows] of m.positions)
          for (const outcome of OUTCOMES) {
            const settled = settlePosition(rows[outcome], result, outcome);
            collateral -= settled.payoutCoin;
            paid += settled.payoutCoin;
            if (isHuman(id)) wallets[Number(id.slice(1))]! += settled.payoutCoin;
            else funds += settled.payoutCoin;
            assert.equal(settled.qty, 0);
            assert.equal(settled.costBasisCoin, 0n);
          }
        assert.equal(collateral, 0n, 'Settlement pays exactly collateral once');
        assert.ok(funds >= 0n);
        const pnl = funds - this.candidate.budgetCoin;
        assert.equal(
          pnl,
          botRisk(this.botBook(m), [], limitsOf(this.candidate), CONTRACT_TERMS).pnl[result],
        );
        treasury += funds;
        paidCoin += paid;
        completed.set(m.id, { paid, recall: funds, pnl });
      };
      for (const m of this.markets) pay(m);
      const once = digest({ wallets, treasury, paidCoin, completed: [...completed] });
      for (const m of this.markets) pay(m);
      assert.equal(
        digest({ wallets, treasury, paidCoin, completed: [...completed] }),
        once,
        'Settlement/recall retry pays nothing twice',
      );
      assert.equal(
        wallets.reduce((sum, coin) => sum + coin, 0n) + treasury,
        this.issued,
        'Final recovery conserves issuance',
      );
      const botPnl = [...completed.values()].reduce((sum, row) => sum + row.pnl, 0n);
      const humanPnl = wallets.reduce((sum, coin) => sum + coin - this.candidate.startCoin, 0n);
      assert.equal(botPnl + humanPnl, 0n, 'Fee-free final human and MM PnL sum to zero');
      return {
        result,
        settledAtMs: HORIZON_MS + SETTLEMENT_WAIT_MS,
        paidCoin,
        treasuryRecoveredCoin: treasury,
        botPnlCoin: botPnl,
        humanPnlCoin: humanPnl,
        marketPnl: [...completed].map(([market, value]) => ({ market, ...value })),
        retryUnchanged: true,
      };
    });
  }
  summary() {
    const markets = this.markets.map((m) => ({
      market: m.id,
      status: m.status,
      coin: m.coin,
      collateral: m.collateral,
      holdings: this.botBook(m),
      pnl: botRisk(this.botBook(m), [], limitsOf(this.candidate), CONTRACT_TERMS).pnl,
      ...m.stats,
    }));
    const sum = (
      key:
        | 'openMs'
        | 'pausedMs'
        | 'botMissingMs'
        | 'allMissingMs'
        | 'postedQty'
        | 'botFilledQty'
        | 'requestCount'
        | 'fullIocCount'
        | 'filledQty'
        | 'spreadSum'
        | 'spreadMs'
        | 'refreshes'
        | 'burnedQty',
    ) => markets.reduce((n, m) => n + m[key], 0);
    return {
      candidate: this.candidate.id,
      profile: this.profile.id,
      profileLabel: this.profile.label,
      case: this.scenario.id,
      scenario: this.scenario.scenario,
      people: this.profile.people,
      marketCount: this.profile.markets,
      issuedCoin: this.issued,
      humanIssuedCoin: this.candidate.startCoin * BigInt(this.profile.people),
      allocatedCoin: this.candidate.budgetCoin * BigInt(this.profile.markets),
      additionalTreasuryReserveCoin: 0n,
      maxOverallLossCoin: this.maxOverallLoss,
      maxOverallReservedLossCoin: this.maxOverallReservedLoss,
      sumLimitCoin: this.candidate.maxLossCoin * BigInt(this.profile.markets),
      invariantChecks: this.invariantChecks,
      invariantViolations: 0,
      replayChecks: this.replayChecks,
      humanFillCount: this.humanFillCount,
      orders: {
        ioc: sum('requestCount'),
        fullIoc: sum('fullIocCount'),
        filledQty: sum('filledQty'),
        postedBotQty: sum('postedQty'),
        filledBotQty: sum('botFilledQty'),
        rejections: this.rejections,
      },
      time: {
        openMarketMs: sum('openMs'),
        pausedMarketMs: sum('pausedMs'),
        botOneDirectionMissingMs: sum('botMissingMs'),
        wholeBookOneAskMissingMs: sum('allMissingMs'),
        spreadTickMs: sum('spreadSum'),
        spreadObservedMs: sum('spreadMs'),
      },
      maxFillPriceRange: Math.max(...markets.map((m) => m.maxFillPriceRange)),
      maxSingleOrderReferenceMove: Math.max(...markets.map((m) => m.maxSingleOrderReferenceMove)),
      maxReferenceDisplacement: Math.max(...markets.map((m) => m.maxReferenceDisplacement)),
      refreshes: sum('refreshes'),
      burnedQty: sum('burnedQty'),
      markets,
      settlements: this.settlements(),
    };
  }
}

export function simulate(
  candidate: Candidate,
  profile: Profile,
  scenario: ScenarioCase,
  seed: number,
) {
  const tape = createTape(profile, scenario, seed);
  const byId = new Map(tape.map((event) => [event.id, event]));
  const economy = new Economy(candidate, profile, scenario);
  let nextScan = SCAN_INTERVAL_MS;
  try {
    for (const event of tape) {
      while (nextScan <= event.at && nextScan < HORIZON_MS) {
        economy.advance(nextScan);
        for (const m of economy.markets)
          if (m.enabled && m.status === 'open' && m.nextRefresh === null)
            m.nextRefresh = nextScan + scenario.refreshDelayMs;
        nextScan += SCAN_INTERVAL_MS;
      }
      economy.execute(event, byId);
    }
    economy.advance(HORIZON_MS + 1);
    const summary = {
      ...economy.summary(),
      seed,
      inputDigest: digest(tape),
      traceDigest: digest(economy.trace),
      traceRecords: economy.trace.length,
    };
    return { summary, trace: economy.trace, tape };
  } catch (error) {
    throw new SimulationFailure(candidate, profile, scenario, seed, tape, economy.trace, error);
  }
}
export class SimulationFailure extends Error {
  readonly evidence: unknown;
  constructor(
    candidate: Candidate,
    profile: Profile,
    scenario: ScenarioCase,
    seed: number,
    tape: TapeEvent[],
    trace: Trace[],
    cause: unknown,
  ) {
    super(`Simulation invariant failed: ${candidate.id}/${profile.id}/${scenario.id}/${seed}`, {
      cause,
    });
    this.evidence = {
      candidate,
      profile,
      scenario,
      seed,
      tape,
      trace,
      error:
        cause instanceof Error ? { message: cause.message, stack: cause.stack } : String(cause),
    };
  }
}
