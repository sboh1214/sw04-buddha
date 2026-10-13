/**
 * #113: the public and owner-only surface is registered (registry.ts), and nothing public names
 * an excluded feature or carries private data. Static, like admin-audit.test.ts: the routes come
 * from the module graph and the shapes from the committed OpenAPI document (apps/api/openapi.json,
 * which CI regenerates and diffs against the code), so it needs no Postgres and no Redis. What a
 * route actually answers is private-data.test.ts's.
 *
 * Owner decision (2026-10-13 #113 (a)): a public route, gateway or socket emit nobody registered
 * is found here and fails the run; review is not the only gate.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  PAID_COIN_SALES_ENABLED,
  findExcludedIdentifier,
  findPrivateField,
  namesPersonalProbability,
} from '@buddha/shared';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { PaidCoinSalesGuard } from '../payments/paid-coin-sales.guard.js';
import {
  discoverGateways,
  discoverRoutes,
  guardsOf,
  type DiscoveredRoute,
} from '../test/routes.js';
import {
  OUTSIDE_NEST_ROUTES,
  OWNER_ROUTES,
  PUBLIC_ROUTES,
  REALTIME_EMITS,
  REALTIME_GATEWAYS,
  type RegisteredRoute,
} from './registry.js';

type RouteClass = 'public' | 'owner' | 'admin';

/**
 * What the guards make a route: who may call it. An AdminGuard route is admin-access.test.ts's,
 * which also keeps every one of them under /admin.
 */
function classOf(route: DiscoveredRoute): RouteClass {
  const guards = guardsOf(route);
  if (guards.includes(AdminGuard)) return 'admin';
  if (guards.includes(SessionGuard)) return 'owner';
  return 'public';
}

const routes = discoverRoutes();
const byClass = (wanted: RouteClass) => routes.filter((route) => classOf(route) === wanted);

/** What is missing from a registry, and what it holds that the app no longer serves as such. */
function drift(found: DiscoveredRoute[], registry: Readonly<Record<string, RegisteredRoute>>) {
  const keys = found.map((route) => route.key);
  return {
    unregistered: keys.filter((key) => !(key in registry)).sort(),
    stale: Object.keys(registry)
      .filter((key) => !keys.includes(key))
      .sort(),
  };
}

const registered = (route: DiscoveredRoute): RegisteredRoute | undefined =>
  PUBLIC_ROUTES[route.key] ?? OWNER_ROUTES[route.key];

/** Paid purchase is looked for in public only, and not on kept paid code (D9, ADR-0049). */
function checksPaid(route: { key: string }): boolean {
  const entry = PUBLIC_ROUTES[route.key];
  return entry !== undefined && entry.preservedPaid !== true;
}

/**
 * `name: feature` for each excluded feature the names carry, paid purchase only when `paid`, and
 * for each name that keeps a probability or a belief (N02 §10: someone's input, or the Community
 * Forecast's).
 */
function excludedIn(names: Iterable<string>, paid: boolean): string[] {
  return [...new Set(names)].flatMap((name) => [
    ...findExcludedIdentifier(name, 'api')
      .filter((hit) => paid || hit.feature !== 'paid-purchase')
      .map((hit) => `${name}: ${hit.feature}`),
    ...(namesPersonalProbability(name) ? [`${name}: personal probability`] : []),
  ]);
}

describe('public and owner-only routes (static)', () => {
  it('finds the public, owner-only and admin surface at all', () => {
    // A guard on the discovery: a walk that found nothing would pass everything below.
    expect(byClass('public').map((route) => route.key)).toEqual(
      expect.arrayContaining(['GET /markets', 'POST /auth/register', 'GET /health']),
    );
    expect(byClass('owner').map((route) => route.key)).toEqual(
      expect.arrayContaining(['GET /me', 'GET /me/ledger', 'GET /me/orders']),
    );
    expect(byClass('admin').length).toBeGreaterThanOrEqual(15);
  });

  it('registers every public route, and no route that is not one', () => {
    expect(drift(byClass('public'), PUBLIC_ROUTES)).toEqual({ unregistered: [], stale: [] });
  });

  it('registers every owner-only route, and no route that is not one', () => {
    expect(drift(byClass('owner'), OWNER_ROUTES)).toEqual({ unregistered: [], stale: [] });
  });

  it('gives every registered route a reason', () => {
    for (const [key, entry] of Object.entries({ ...PUBLIC_ROUTES, ...OWNER_ROUTES })) {
      expect(entry.reason.trim(), key).not.toBe('');
    }
    for (const outside of OUTSIDE_NEST_ROUTES) expect(outside.reason.trim()).not.toBe('');
  });

  it('closes every kept paid route first, while paid Coin is off (D9, ADR-0049)', () => {
    expect(PAID_COIN_SALES_ENABLED).toBe(false);
    const gated = routes.filter((route) => guardsOf(route).includes(PaidCoinSalesGuard));
    // A sanity check on the gate itself, then the flag in both directions: a route flagged as
    // kept paid code is closed before anything else runs, and every closed route says so.
    expect(gated.length).toBeGreaterThanOrEqual(4);
    expect(
      gated
        .filter((route) => classOf(route) !== 'admin')
        .filter((route) => registered(route)?.preservedPaid !== true)
        .map((route) => route.key),
    ).toEqual([]);
    expect(
      routes
        .filter((route) => registered(route)?.preservedPaid === true)
        .filter((route) => guardsOf(route)[0] !== PaidCoinSalesGuard)
        .map((route) => route.key),
    ).toEqual([]);
  });

  it('leaves /api/auth/* to better-auth, named with a reason', () => {
    expect(OUTSIDE_NEST_ROUTES.map((outside) => outside.path)).toContain('/api/auth/*');
    expect(routes.filter((route) => route.url.startsWith('/api/auth/'))).toEqual([]);
  });

  it('names no excluded feature or probability in any route path (rewards, transfers, cash-out)', () => {
    // Every class: a transfer or a cash-out would be an owner-only route, and an activity
    // reward could be an admin one. Paid purchase only in public (D9).
    expect(
      routes.flatMap((route) =>
        excludedIn([route.path], checksPaid(route)).map((hit) => `${route.key} ${hit}`),
      ),
    ).toEqual([]);
  });
});

// ---- the OpenAPI document ---------------------------------------------------------------

interface Operation {
  security?: unknown[];
  parameters?: { name: string }[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
}
interface OpenApiDocument {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown> };
}

const document = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../openapi.json'), 'utf8'),
) as OpenApiDocument;
const schemas = document.components.schemas;

/** Every operation, keyed like the routes: `GET /markets/:idOrSlug`. */
const operations = Object.entries(document.paths).flatMap(([url, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({
    key: `${method.toUpperCase()} ${url.replace(/^\/api\/v\d+/, '').replaceAll(/\{(\w+)\}/g, ':$1')}`,
    url,
    operation,
  })),
);

/** The component names a part of the document refers to, followed through every reference. */
function referencedSchemas(node: unknown, seen = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) referencedSchemas(item, seen);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        const name = value.split('/').pop()!;
        if (!seen.has(name)) {
          seen.add(name);
          referencedSchemas(schemas[name], seen);
        }
      } else {
        referencedSchemas(value, seen);
      }
    }
  }
  return seen;
}

/** Every property name in a part of the document and in the components it refers to. */
function fieldNames(node: unknown): string[] {
  const own = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(own);
    if (value === null || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    const properties =
      record.properties !== null && typeof record.properties === 'object'
        ? Object.keys(record.properties)
        : [];
    return [...properties, ...Object.values(record).flatMap(own)];
  };
  return [...own(node), ...[...referencedSchemas(node)].flatMap((name) => own(schemas[name]))];
}

describe('the public API document (static)', () => {
  it('reads the document at all', () => {
    expect(operations.length).toBeGreaterThanOrEqual(30);
    expect(fieldNames(document.paths['/api/v1/markets/{idOrSlug}'])).toEqual(
      expect.arrayContaining(['slug', 'rules', 'lastPrice']),
    );
  });

  it('documents the registered public routes as public and every owner-only one behind the session', () => {
    const documented = (registry: Readonly<Record<string, RegisteredRoute>>) =>
      Object.entries(registry)
        .filter(([, entry]) => entry.undocumented !== true)
        .map(([key]) => key)
        .sort();
    expect(
      operations
        .filter(({ operation }) => (operation.security ?? []).length === 0)
        .map(({ key }) => key)
        .sort(),
    ).toEqual(documented(PUBLIC_ROUTES));
    expect(
      operations
        .filter(({ key }) => key in OWNER_ROUTES)
        .filter(({ operation }) => (operation.security ?? []).length > 0)
        .map(({ key }) => key)
        .sort(),
    ).toEqual(documented(OWNER_ROUTES));
  });

  it('names no excluded feature or probability in a path, parameter, schema or field', () => {
    // Every operation for the features left out everywhere (a personal score in /me is as
    // excluded as a public one); paid purchase in public operations only, kept paid code aside.
    const found = operations.flatMap(({ key, url, operation }) => {
      const names = [
        url,
        ...(operation.parameters ?? []).map((parameter) => parameter.name),
        ...referencedSchemas(operation),
        ...fieldNames(operation),
      ];
      return excludedIn(names, checksPaid({ key })).map((hit) => `${key} ${hit}`);
    });
    expect(found).toEqual([]);
  });

  it('finds paid purchase in the kept paid routes: the allowance is what lets them through', () => {
    const paid = operations.filter(({ key }) => PUBLIC_ROUTES[key]?.preservedPaid === true);
    expect(paid.map(({ key }) => key).sort()).toEqual([
      'GET /charge-packages',
      'GET /payments/provider',
    ]);
    for (const { key, url, operation } of paid) {
      expect(excludedIn([url, ...referencedSchemas(operation)], true).length, key).toBeGreaterThan(
        0,
      );
    }
  });

  it('carries no private data in a public answer', () => {
    // Answers only: a request may carry the caller's own address (register).
    const found = operations
      .filter(({ key }) => key in PUBLIC_ROUTES)
      .flatMap(({ key, operation }) =>
        [...new Set(fieldNames(operation.responses))].flatMap((name) =>
          findPrivateField(name).map((hit) => `${key} ${name}: ${hit.item}`),
        ),
      );
    expect(found).toEqual([]);
  });

  it('finds the private data an owner-only answer carries: the check above is not blind', () => {
    const me = operations.find(({ key }) => key === 'GET /me')!;
    const items = new Set(
      fieldNames(me.operation.responses).flatMap((name) =>
        findPrivateField(name).map((hit) => hit.item),
      ),
    );
    for (const item of ['email', 'real-name', 'phone', 'balance'] as const) {
      expect([...items]).toContain(item);
    }
  });
});

// ---- the realtime surface -----------------------------------------------------------------

const SRC = path.resolve(import.meta.dirname, '..');

/** The API's own sources: not a test, not the test support. */
function sources(dir: string = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return full === path.join(SRC, 'test') ? [] : sources(full);
    return /\.ts$/.test(entry.name) && !/\.(test|d)\.ts$/.test(entry.name) ? [full] : [];
  });
}

/** The Socket.IO calls that send an event: `emit` and its variants (`to(room).emit` included). */
const EMITS = new Set(['emit', 'emitWithAck', 'serverSideEmit']);

/** Every emit call in a source, with its event as written. */
function emitsOf(fileName: string, text: string): { event: string }[] {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: { event: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      EMITS.has(node.expression.name.text)
    ) {
      found.push({ event: node.arguments[0]?.getText(file) ?? '' });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('the realtime surface (static)', () => {
  it('registers every gateway by namespace, with the messages it takes', () => {
    const gateways = discoverGateways();
    // A guard on the discovery, as for the routes.
    expect(gateways.map((gateway) => gateway.namespace)).toContain('/ws');
    expect(
      Object.fromEntries(gateways.map(({ namespace, messages }) => [namespace, messages])),
    ).toEqual(
      Object.fromEntries(
        Object.entries(REALTIME_GATEWAYS).map(([namespace, entry]) => [
          namespace,
          [...entry.messages].sort(),
        ]),
      ),
    );
    expect(gateways).toHaveLength(Object.keys(REALTIME_GATEWAYS).length);
    for (const [namespace, entry] of Object.entries(REALTIME_GATEWAYS)) {
      expect(entry.reason.trim(), namespace).not.toBe('');
    }
  });

  it('knows an emit call when it reads one', () => {
    const planted = [
      'client.emit(REALTIME_EXCEPTION_EVENT, envelope);',
      'this.server.to(room).emit("user:secret", data);',
      'namespace.local.volatile.to(channel).emit(event.type, event);',
      "await socket.timeout(5).emitWithAck('ping');",
      "// server.emit('commented') is not a call",
      'reply.send(body);',
    ].join('\n');
    expect(emitsOf('planted.ts', planted).map(({ event }) => event)).toEqual([
      'REALTIME_EXCEPTION_EVENT',
      '"user:secret"',
      'event.type',
      "'ping'",
    ]);
  });

  it('emits on a socket only where REALTIME_EMITS says, each with a reason', () => {
    const found = sources()
      .flatMap((file) =>
        emitsOf(file, readFileSync(file, 'utf8')).map(({ event }) => ({
          file: path.relative(SRC, file).split(path.sep).join('/'),
          event,
        })),
      )
      .map(({ file, event }) => `${file} ${event}`)
      .sort();
    expect(found).toContain('realtime/market.gateway.ts event.type');
    expect(found).toEqual(REALTIME_EMITS.map(({ file, event }) => `${file} ${event}`).sort());
    for (const emit of REALTIME_EMITS) expect(emit.reason.trim(), emit.event).not.toBe('');
  });
});
