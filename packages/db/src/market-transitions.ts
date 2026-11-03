import { type MarketEventType, type MarketStatus, canTransitionMarket } from '@buddha/shared';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema/index.js';
import { marketEvents, markets } from './schema/index.js';

type MarketRowSet = Partial<
  Omit<typeof markets.$inferInsert, 'id' | 'status' | 'statusEventId' | 'updatedAt'>
>;

/** A transaction handle of either app: never the pooled `Db`, which would split the two writes. */
type Executor = Pick<NodePgDatabase<typeof schema>, 'insert' | 'update'>;

/** A status change `MARKET_LIFECYCLE_TRANSITIONS` and the interim edges do not allow. */
export class MarketTransitionError extends Error {
  readonly from: MarketStatus;
  readonly to: MarketStatus;

  constructor(from: MarketStatus, to: MarketStatus) {
    super(`Market cannot go from ${from} to ${to}`);
    this.name = 'MarketTransitionError';
    this.from = from;
    this.to = to;
  }
}

export interface MarketTransition {
  marketId: string;
  /** The status the caller read under the market lock: the change is made only from it. */
  from: MarketStatus;
  to: MarketStatus;
  type: MarketEventType;
  /** The admin who acted, or null for the worker (ADR-0093 decision 1 item 1's automatic edges). */
  actorId: string | null;
  payload?: Record<string, unknown> | null;
  /** The DB clock read after the market lock (`clockTimestamp`): the event's and the row's time. */
  at: Date;
  /** Other columns the transition writes with it (`openAt`, `resolvedResult`, `settledAt`…). */
  set?: MarketRowSet;
}

/**
 * The one way either app changes `markets.status` (#174): refuses a pair the lifecycle does not
 * allow (`canTransitionMarket`), then writes the `market_events` row — who, when, from and to —
 * and the market row with that event's id as `status_event_id`, in the caller's transaction.
 *
 * Call it under `lockMarket` with the status read `FOR UPDATE` after the lock: the UPDATE matches
 * `from` too, and a row that has moved on (which the lock rules out) fails loudly rather than
 * being overwritten. The event row is inserted FIRST so the market UPDATE can carry its id, the
 * ordering key of `market:status` (A-M3-19). Returns that id; the caller publishes after COMMIT.
 */
export async function transitionMarket(
  tx: Executor,
  transition: MarketTransition,
): Promise<number> {
  const { marketId, from, to, at } = transition;
  if (!canTransitionMarket(from, to)) throw new MarketTransitionError(from, to);
  const [event] = await tx
    .insert(marketEvents)
    .values({
      marketId,
      type: transition.type,
      actorId: transition.actorId,
      fromStatus: from,
      toStatus: to,
      payload: transition.payload ?? null,
      createdAt: at,
    })
    .returning({ id: marketEvents.id });
  if (!event) throw new Error('market_events insert returned no row');
  const updated = await tx
    .update(markets)
    .set({ ...transition.set, status: to, statusEventId: event.id, updatedAt: at })
    .where(and(eq(markets.id, marketId), eq(markets.status, from)))
    .returning({ id: markets.id });
  if (updated.length !== 1) {
    throw new Error(
      `Market ${marketId} is no longer ${from}: its transition to ${to} was not made`,
    );
  }
  return event.id;
}
