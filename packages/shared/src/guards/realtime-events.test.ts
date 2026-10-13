import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  REALTIME_EVENT_TYPES,
  marketRealtimeEventSchema,
  realtimeEventSchema,
  userRealtimeEventSchema,
  type UserRealtimeEvent,
} from '../realtime.js';
import { findExcludedIdentifier, namesPersonalProbability } from './excluded.js';
import { findPrivateField } from './private-data.js';
import { REALTIME_EVENT_REGISTRY } from './realtime-events.js';

const marketId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ts = '2026-09-05T00:00:00.000Z';

/** One valid event per user-channel type: what a smuggled publish would carry. */
const USER_EVENTS = {
  'user:balance': {
    type: 'user:balance',
    availableCoin: '9480',
    lockedCoin: '0',
    ledgerEntryId: '42',
    ts,
  },
  'user:position': {
    type: 'user:position',
    marketId,
    outcome: 'YES',
    qty: 10,
    costBasisCoin: '520',
    realizedPnlCoin: '0',
    settled: false,
    version: 1,
    ts,
  },
} as const satisfies { [K in UserRealtimeEvent['type']]: Extract<UserRealtimeEvent, { type: K }> };

/** The `type` literal of each member of a family union. */
function typesOf(family: { options: readonly { shape: { type: { value: string } } }[] }) {
  return family.options.map((member) => member.shape.type.value);
}

/** Every property name anywhere in a JSON Schema. */
function fieldNames(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(fieldNames);
  if (schema === null || typeof schema !== 'object') return [];
  const node = schema as Record<string, unknown>;
  const own =
    node.properties !== null && typeof node.properties === 'object'
      ? Object.keys(node.properties)
      : [];
  return [...own, ...Object.values(node).flatMap(fieldNames)];
}

const channelOf = (type: string) =>
  REALTIME_EVENT_REGISTRY[type as keyof typeof REALTIME_EVENT_REGISTRY].channel;

describe('REALTIME_EVENT_REGISTRY (#113)', () => {
  it('registers every event type once, with a reason', () => {
    expect(Object.keys(REALTIME_EVENT_REGISTRY).sort()).toEqual([...REALTIME_EVENT_TYPES].sort());
    for (const [type, entry] of Object.entries(REALTIME_EVENT_REGISTRY)) {
      expect(entry.reason.trim(), type).not.toBe('');
    }
  });

  it('puts each type on the channel whose family the gateway parses it with', () => {
    const market = typesOf(marketRealtimeEventSchema);
    const user = typesOf(userRealtimeEventSchema);
    expect(market.map(channelOf)).toEqual(market.map(() => 'market'));
    expect(user.map(channelOf)).toEqual(user.map(() => 'user'));
    // The two families split the publisher's union between them, with nothing in both.
    expect([...market, ...user].sort()).toEqual(typesOf(realtimeEventSchema).sort());
    expect(market.filter((type) => user.includes(type))).toEqual([]);
  });

  it('carries no private data and no excluded feature in a market-channel event', () => {
    const names = marketRealtimeEventSchema.options.flatMap((member) =>
      fieldNames(z.toJSONSchema(member)),
    );
    // A guard on the walk: an empty list would pass everything below.
    expect(names).toEqual(expect.arrayContaining(['marketId', 'fillId', 'statusEventId']));
    expect(names.flatMap((name) => findPrivateField(name))).toEqual([]);
    expect(names.flatMap((name) => findExcludedIdentifier(name, 'api'))).toEqual([]);
  });

  it('keeps no probability or belief in any event, on either channel (N02 §10)', () => {
    const names = realtimeEventSchema.options.flatMap((member) =>
      fieldNames(z.toJSONSchema(member)),
    );
    expect(names).toEqual(expect.arrayContaining(['marketId', 'availableCoin', 'costBasisCoin']));
    expect(names.filter(namesPersonalProbability)).toEqual([]);
  });

  it('finds the private data the user-channel events carry: the check above is not blind', () => {
    const names = userRealtimeEventSchema.options.flatMap((member) =>
      fieldNames(z.toJSONSchema(member)),
    );
    expect(new Set(names.flatMap((name) => findPrivateField(name).map((hit) => hit.item)))).toEqual(
      new Set(['balance', 'holdings', 'pnl']),
    );
  });

  it.each(Object.values(USER_EVENTS))('never parses $type as a market-channel event', (event) => {
    expect(userRealtimeEventSchema.safeParse(event).success).toBe(true);
    expect(marketRealtimeEventSchema.safeParse(event).success).toBe(false);
    // Not even relabelled for a market room it names.
    expect(marketRealtimeEventSchema.safeParse({ ...event, marketId }).success).toBe(false);
  });
});
