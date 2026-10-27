/**
 * #113: the public and owner-only surface is registered (registry.ts), nothing public names an
 * excluded feature or carries private data, and no route's path, owner-only and admin ones
 * included, names a transfer, an activity reward or a cash-out. Static, like admin-audit.test.ts:
 * the routes come
 * from the module graph and the shapes from the committed OpenAPI document (apps/api/openapi.json,
 * which CI regenerates and diffs against the code), so it needs no Postgres and no Redis. What a
 * route actually answers is private-data.test.ts's.
 *
 * Owner decision (2026-10-13 #113 (a)): a public route, a better-auth route, a gateway or a
 * socket send nobody registered is found here and fails the run; review is not the only gate.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  EVERY_ROUTE_PATH_FEATURES,
  PAID_COIN_SALES_ENABLED,
  errorEnvelopeSchema,
  findExcludedIdentifier,
  findPrivateField,
  namesPersonalProbability,
} from '@buddha/shared';
import { Controller, Get, Module, Post, forwardRef } from '@nestjs/common';
import { SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { AdminGuard } from '../auth/admin.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { PaidCoinSalesGuard } from '../payments/paid-coin-sales.guard.js';
import { SRC, programOf, sources, srcPath } from '../test/program.js';
import {
  disabledAuthPaths,
  discoverAuthRoutes,
  discoverGateways,
  discoverRoutes,
  guardsOf,
  type DiscoveredRoute,
} from '../test/routes.js';
import {
  AUTH_ROUTES,
  OWNER_ROUTES,
  PUBLIC_ROUTES,
  REALTIME_EMITS,
  REALTIME_GATEWAYS,
  type RegisteredEmit,
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
const authRoutes = discoverAuthRoutes();

/** What is missing from a registry, and what it holds that the app no longer serves as such. */
function drift(found: readonly { key: string }[], registry: Readonly<Record<string, unknown>>) {
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
 * `name: feature` for each excluded feature public names carry, paid purchase only when `paid`,
 * and for each name that keeps a probability or a belief (N02 §10: someone's input, or the
 * Community Forecast's). `path` when the names are paths, which a path token (`bonus`) names too.
 */
function excludedIn(names: Iterable<string>, paid: boolean, path = false): string[] {
  return [...new Set(names)].flatMap((name) => [
    ...findExcludedIdentifier(name, 'api', { path })
      .filter((hit) => paid || hit.feature !== 'paid-purchase')
      .map((hit) => `${name}: ${hit.feature}`),
    ...(namesPersonalProbability(name) ? [`${name}: personal probability`] : []),
  ]);
}

/**
 * The transfer, activity reward or cash-out a path names: what every route is held to, owner-only
 * and admin ones too (owner decision 2026-10-14 #113). The rest of an owner-only or admin route —
 * a score of one's own, a probability, its fields — is not looked at by name.
 */
const excludedInAnyPath = (routePath: string): string[] =>
  findExcludedIdentifier(routePath, 'api', {
    features: EVERY_ROUTE_PATH_FEATURES,
    path: true,
  }).map((hit) => hit.feature);

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

  it('finds a handler a controller or a gateway inherits, as Nest maps it (MetadataScanner)', () => {
    class BaseController {
      @Get('inherited')
      inherited() {
        return 'served by every subclass';
      }

      @Post('overridden')
      overridden() {
        return 'replaced below';
      }
    }
    @Controller('planted')
    class PlantedController extends BaseController {
      @Get('own')
      own() {
        return 'own';
      }

      // Overridden without a decorator: Nest maps the subclass's function, which has none.
      override overridden() {
        return 'not a route';
      }
    }
    class BaseGateway {
      @SubscribeMessage('ping')
      ping(): void {}
    }
    @WebSocketGateway({ namespace: '/planted' })
    class PlantedGateway extends BaseGateway {}
    @Module({ controllers: [PlantedController], providers: [PlantedGateway] })
    class PlantedModule {}

    expect(
      discoverRoutes(PlantedModule)
        .map((route) => route.key)
        .sort(),
    ).toEqual(['GET /planted/inherited', 'GET /planted/own']);
    expect(
      discoverGateways(PlantedModule).map(({ namespace, messages, handlers }) => ({
        namespace,
        messages,
        handlers,
      })),
    ).toEqual([
      {
        namespace: '/planted',
        messages: ['ping'],
        handlers: [{ name: 'BaseGateway.ping', acks: [] }],
      },
    ]);
  });

  it('finds the routes and gateways of a module imported through forwardRef, as Nest does', () => {
    @Controller('cyclic')
    class CyclicController {
      @Get('route')
      route() {
        return 'served';
      }
    }
    @WebSocketGateway({ namespace: '/cyclic' })
    class CyclicGateway {
      @SubscribeMessage('ping')
      ping(): void {}
    }
    @Module({ controllers: [CyclicController], providers: [CyclicGateway] })
    class CyclicModule {}
    @Controller('dynamic-cyclic')
    class DynamicCyclicController {
      @Get()
      list() {
        return [];
      }
    }
    // `forwardRef(() => Module)` is how a cycle between two modules is written; Nest unwraps it,
    // in a class module's imports and a DynamicModule's alike.
    @Module({
      imports: [
        forwardRef(() => CyclicModule),
        {
          module: class DynamicHost {},
          imports: [
            forwardRef(() => ({
              module: class DynamicCyclic {},
              controllers: [DynamicCyclicController],
            })),
          ],
        },
      ],
    })
    class HostModule {}

    expect(
      discoverRoutes(HostModule)
        .map((route) => route.key)
        .sort(),
    ).toEqual(['GET /cyclic/route', 'GET /dynamic-cyclic']);
    expect(
      discoverGateways(HostModule).map(({ namespace, messages }) => ({ namespace, messages })),
    ).toEqual([{ namespace: '/cyclic', messages: ['ping'] }]);
  });

  it('registers every public route, and no route that is not one', () => {
    expect(drift(byClass('public'), PUBLIC_ROUTES)).toEqual({ unregistered: [], stale: [] });
  });

  it('registers every owner-only route, and no route that is not one', () => {
    expect(drift(byClass('owner'), OWNER_ROUTES)).toEqual({ unregistered: [], stale: [] });
  });

  it('gives every registered route a reason', () => {
    for (const [key, entry] of Object.entries({
      ...PUBLIC_ROUTES,
      ...OWNER_ROUTES,
      ...AUTH_ROUTES,
    })) {
      expect(entry.reason.trim(), key).not.toBe('');
    }
  });

  it('flags exactly the routes behind OnboardedGuard, each after SessionGuard (#58, #57-8)', () => {
    const guarded = routes.filter((route) => guardsOf(route).includes(OnboardedGuard));
    // A sanity check on the walk: the interest categories are behind it today.
    expect(guarded.map((route) => route.key)).toContain('PUT /me/interest-categories');
    // A post's writes are behind it — but not deleting one's own post, which asks for a session
    // alone (owner decision 2026-10-19, ADR-0073): no guard and no `onboarded` mark.
    expect(guarded.map((route) => route.key)).toEqual(
      expect.arrayContaining(['POST /posts', 'PUT /posts/:postId', 'POST /media/images']),
    );
    const deletePost = routes.find((route) => route.key === 'POST /posts/:postId/delete');
    expect(deletePost && guardsOf(deletePost)).toEqual([SessionGuard]);
    expect(OWNER_ROUTES['POST /posts/:postId/delete']?.onboarded).toBeUndefined();
    expect(
      guarded
        .filter((route) => classOf(route) === 'owner')
        .filter((route) => registered(route)?.onboarded !== true)
        .map((route) => route.key),
    ).toEqual([]);
    expect(
      routes
        .filter((route) => registered(route)?.onboarded === true)
        .filter((route) => !guardsOf(route).includes(OnboardedGuard))
        .map((route) => route.key),
    ).toEqual([]);
    // It reads the session SessionGuard resolved: never on a public route, never before it.
    expect(
      guarded
        .filter((route) => {
          const guards = guardsOf(route);
          const session = guards.indexOf(SessionGuard);
          return session < 0 || session > guards.indexOf(OnboardedGuard);
        })
        .map((route) => route.key),
    ).toEqual([]);
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

  it('registers every route better-auth serves under /api/auth, and none it does not', () => {
    // A guard on the discovery, as for the module walk.
    expect(authRoutes.map((route) => route.key)).toEqual(
      expect.arrayContaining(['GET /get-session', 'POST /sign-in/email', 'GET /list-sessions']),
    );
    expect(drift(authRoutes, AUTH_ROUTES)).toEqual({ unregistered: [], stale: [] });
    // Sign-up is RegistrationService's on the server only (ADR-0024); Nest serves nothing there.
    expect(disabledAuthPaths()).toContain('/sign-up/email');
    expect(authRoutes.map((route) => route.path)).not.toContain('/sign-up/email');
    // better-auth's name-and-photo update, its read of the provider's profile and its hand-out of
    // the provider's access and refresh tokens: the service keeps none of them (ADR-0072 7-31).
    for (const path of ['/update-user', '/account-info', '/get-access-token', '/refresh-token']) {
      expect(disabledAuthPaths()).toContain(path);
      expect(authRoutes.map((route) => route.path)).not.toContain(path);
    }
    expect(routes.filter((route) => route.url.startsWith('/api/auth/'))).toEqual([]);
  });

  it('names no excluded feature or probability in a public route path', () => {
    // Paid purchase only where the route is not kept paid code (D9). better-auth's routes are
    // open to anyone as well.
    const paths = [
      ...byClass('public').map((route) => ({ ...route, paid: checksPaid(route) })),
      ...authRoutes.map((route) => ({ ...route, key: `auth ${route.key}`, paid: true })),
    ];
    expect(
      paths.flatMap((route) =>
        excludedIn([route.path], route.paid, true).map((hit) => `${route.key} ${hit}`),
      ),
    ).toEqual([]);
  });

  it('names no transfer, activity reward or cash-out in any route path, owner-only and admin too', () => {
    // A transfer or a cash-out would be an owner-only route, an activity reward could be an
    // admin one (owner decision 2026-10-14 #113).
    expect(
      [...routes, ...authRoutes].flatMap((route) =>
        excludedInAnyPath(route.path).map((feature) => `${route.key}: ${feature}`),
      ),
    ).toEqual([]);
  });

  it('holds an owner-only or admin path to transfers, rewards and cash-out only', () => {
    expect(excludedInAnyPath('/me/coins/send')).toEqual(['coin-transfer']);
    expect(excludedInAnyPath('/admin/rewards')).toEqual(['activity-reward']);
    expect(excludedInAnyPath('/admin/daily-bonuses')).toContain('activity-reward');
    expect(excludedInAnyPath('/me/withdrawals')).toEqual(['cash-out']);
    expect(excludedInAnyPath('/me/exchange')).toEqual(['cash-out']);
    // A score or a probability of one's own is the public API's to refuse, not this check's.
    expect(excludedInAnyPath('/me/score')).toEqual([]);
    expect(excludedInAnyPath('/me/probability')).toEqual([]);
    expect(excludedIn(['/me/score', '/me/probability'], true)).toEqual([
      '/me/score: scoring',
      '/me/probability: personal probability',
    ]);
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

/** Every string an `enum` or a `const` allows in a part of the document and its components. */
function enumValues(node: unknown): string[] {
  const own = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(own);
    if (value === null || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    const allowed = [
      ...(Array.isArray(record.enum) ? (record.enum as unknown[]) : []),
      ...('const' in record ? [record.const] : []),
    ].filter((item): item is string => typeof item === 'string');
    return [...allowed, ...Object.values(record).flatMap(own)];
  };
  return [...own(node), ...[...referencedSchemas(node)].flatMap((name) => own(schemas[name]))];
}

/**
 * The error codes every operation's error envelope allows. They name paid purchase
 * (PAYMENT_GATEWAY_*: the kept payment code's, D9, ADR-0049), so only for that feature they are
 * not looked at.
 */
const ERROR_CODES = new Set(enumValues(schemas.ErrorCode));

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

/**
 * The property names of every object schema in a part of the document and in the components it
 * refers to, one list per object (sorted).
 */
function objectShapes(node: unknown): string[][] {
  const own = (value: unknown): string[][] => {
    if (Array.isArray(value)) return value.flatMap(own);
    if (value === null || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    const shape =
      record.properties !== null && typeof record.properties === 'object'
        ? [Object.keys(record.properties).sort()]
        : [];
    return [...shape, ...Object.values(record).flatMap(own)];
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

  it('names no excluded feature or probability in a public path, parameter, schema or field', () => {
    // Public operations only (owner decision 2026-10-14 #113): an owner-only or admin one is
    // held to its path alone, above. Paid purchase where the route is not kept paid code (D9).
    const found = operations
      .filter(({ key }) => key in PUBLIC_ROUTES)
      .flatMap(({ key, url, operation }) => {
        const names = [
          ...(operation.parameters ?? []).map((parameter) => parameter.name),
          ...referencedSchemas(operation),
          ...fieldNames(operation),
        ];
        return [
          ...excludedIn([url], checksPaid({ key }), true),
          ...excludedIn(names, checksPaid({ key })),
        ].map((hit) => `${key} ${hit}`);
      });
    expect(found).toEqual([]);
  });

  it('allows no excluded feature or probability as a value of a public answer or request', () => {
    // A status, a sort, a type a public operation takes or gives (owner decision 2026-10-14
    // #113: the public API). Paid purchase is looked for past the error codes.
    expect([...ERROR_CODES]).toEqual(
      expect.arrayContaining(['NOT_FOUND', 'PAYMENT_GATEWAY_ERROR']),
    );
    const values = operations
      .filter(({ key }) => key in PUBLIC_ROUTES)
      .flatMap(({ key, operation }) =>
        [...new Set(enumValues(operation))].map((value) => ({ key, value })),
      );
    expect(values.map(({ value }) => value)).toEqual(
      expect.arrayContaining(['open', 'newest', 'YES', 'trade']),
    );
    const found = values.flatMap(({ key, value }) =>
      excludedIn([value], checksPaid({ key }) && !ERROR_CODES.has(value)).map(
        (hit) => `${key} ${hit}`,
      ),
    );
    expect(found).toEqual([]);
  });

  it('documents ONBOARDING_REQUIRED (409) on every route behind OnboardedGuard (#58)', () => {
    // The admin surface included (오너 결정 2026-10-19, ADR-0072): a client reads the refusal it
    // can get from the document, as for every other code.
    const guarded = new Set(
      routes.filter((route) => guardsOf(route).includes(OnboardedGuard)).map((route) => route.key),
    );
    const documented = operations.filter(({ key }) => guarded.has(key));
    expect(documented.map(({ key }) => key)).toEqual(
      expect.arrayContaining(['PUT /me/interest-categories', 'GET /admin/release-settings']),
    );
    const missing = documented
      .filter(({ operation }) => {
        const conflict = operation.responses?.['409'] as { description?: string } | undefined;
        return !(conflict?.description ?? '').split(' | ').includes('ONBOARDING_REQUIRED');
      })
      .map(({ key }) => key);
    expect(missing).toEqual([]);
  });

  it('shows a person only where a public route says why, and then by its public face alone (#46)', () => {
    // ADR-0069 decision 5: a public answer may name a person — a post's author — only on a route
    // registered with the reason, and then by the public id, the nickname, the image and the
    // 운영자 mark. The account id stays forbidden there (the `counterparty` item of PRIVATE_DATA,
    // checked above for every public answer).
    const PERSON_FIELDS = ['publicId', 'nickname'];
    const showing = Object.entries(PUBLIC_ROUTES)
      .filter(([, entry]) => entry.showsPerson !== undefined)
      .map(([key]) => key);
    expect(showing.sort()).toEqual(['GET /posts', 'GET /posts/:postId']);
    for (const key of showing) expect(PUBLIC_ROUTES[key]!.showsPerson!.trim(), key).not.toBe('');
    expect(
      Object.entries(OWNER_ROUTES)
        .filter(([, entry]) => entry.showsPerson !== undefined)
        .map(([key]) => key),
    ).toEqual([]);
    const shown = operations
      .filter(({ key }) => key in PUBLIC_ROUTES)
      .map(({ key, operation }) => ({
        key,
        fields: fieldNames(operation.responses).filter((name) => PERSON_FIELDS.includes(name)),
      }));
    expect(
      shown
        .filter(({ fields }) => fields.length > 0)
        .map(({ key }) => key)
        .sort(),
    ).toEqual(showing.sort());
    for (const { key, fields } of shown.filter(({ key }) => showing.includes(key))) {
      expect([...new Set(fields)].sort(), key).toEqual(['nickname', 'publicId']);
      // Every object that names a person names it by exactly the public face: a field added to
      // the author (when it joined, whether it verified…) fails here, on every such route.
      const people = objectShapes(
        operations.find((op) => op.key === key)!.operation.responses,
      ).filter((shape) => shape.some((name) => PERSON_FIELDS.includes(name)));
      expect(people.length, key).toBeGreaterThan(0);
      for (const shape of people) {
        expect(shape, key).toEqual(['imageUrl', 'isAdmin', 'kind', 'nickname', 'publicId']);
      }
    }
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
    for (const item of [
      'email',
      'real-name',
      'phone',
      'identity-verification',
      'balance',
    ] as const) {
      expect([...items]).toContain(item);
    }
  });
});

// ---- the realtime surface -----------------------------------------------------------------

/** The Socket.IO calls that send an event: `emit` and its variants (`to(room).emit` included). */
const EMITS = new Set(['emit', 'emitWithAck', 'serverSideEmit']);

/**
 * The Socket.IO calls that send a `message` event: `send` and `write` on a socket, a namespace, a
 * server or a room. Looked for only in a file that imports a socket package, so a Fastify
 * `reply.send` is not one.
 */
const SOCKET_SENDS = new Set(['send', 'write']);
const SOCKET_MODULE =
  /^(?:socket\.io|@socket\.io\/|@nestjs\/websockets$|@nestjs\/platform-socket\.io$)/;

/** A handler's declared return type that sends nothing back. */
const NO_REPLY = new Set(['void', 'Promise<void>']);

/** The Nest decorators the reader needs, whatever name a file imports them under. */
const NEST_DECORATORS = new Set(['SubscribeMessage', 'Ack']);

/**
 * The calls that add a listener. Socket.IO hands a listener the client's acknowledgement callback,
 * when the client asked for one, as its last argument.
 */
const LISTENS = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);

/**
 * What a decorator is, read through the file's imports: `@OnMessage('x')` after
 * `import { SubscribeMessage as OnMessage }`, `@ws.SubscribeMessage('x')` after
 * `import * as ws from '@nestjs/websockets'`. A spelling this cannot follow (a local constant, a
 * composed decorator) is caught by the handlers Nest maps: see 'reads every message handler'.
 */
function nestDecorators(file: ts.SourceFile): (decorator: ts.Decorator) => string | undefined {
  const aliases = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue;
    const { name, namedBindings } = statement.importClause;
    const nest =
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === '@nestjs/websockets';
    if (nest && name) namespaces.add(name.text);
    if (nest && namedBindings && ts.isNamespaceImport(namedBindings)) {
      namespaces.add(namedBindings.name.text);
    }
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (NEST_DECORATORS.has(imported)) aliases.set(element.name.text, imported);
      }
    }
  }
  return (decorator) => {
    if (!ts.isCallExpression(decorator.expression)) return undefined;
    const callee = decorator.expression.expression;
    if (ts.isIdentifier(callee)) {
      return (
        aliases.get(callee.text) ?? (NEST_DECORATORS.has(callee.text) ? callee.text : undefined)
      );
    }
    return ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      namespaces.has(callee.expression.text) &&
      NEST_DECORATORS.has(callee.name.text)
      ? callee.name.text
      : undefined;
  };
}

/** Whether `id` reads the binding it names: not a property's name, not a new declaration. */
function readsBinding(id: ts.Identifier): boolean {
  const parent = id.parent;
  const named =
    ts.isPropertyAccessExpression(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isBindingElement(parent);
  return (
    !(named && parent.name === id) && !(ts.isBindingElement(parent) && parent.propertyName === id)
  );
}

/** Every place `body` reads the binding `name`, and the call when it is a call of it. */
function readsOf(body: ts.Node, name: string): { call?: ts.CallExpression }[] {
  const found: { call?: ts.CallExpression }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name && readsBinding(node)) {
      const called = ts.isCallExpression(node.parent) && node.parent.expression === node;
      found.push(called ? { call: node.parent } : {});
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/** The values a function body returns: its own return statements, not a nested function's. */
function returnsOf(body: ts.Node): ts.Expression[] {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

type FunctionWithBody = ts.FunctionLikeDeclaration & { body: ts.Node };

const hasBody = (node: ts.Node | undefined): node is FunctionWithBody =>
  node !== undefined &&
  (ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)) &&
  node.body !== undefined;

/**
 * The function a listener argument names, when the file has it: a function written in place,
 * `this.member` (a method or a function-valued property of the enclosing class), or a function
 * the file declares by that name.
 */
function listenerOf(file: ts.SourceFile, argument: ts.Expression): FunctionWithBody | undefined {
  if (hasBody(argument)) return argument;
  if (
    ts.isPropertyAccessExpression(argument) &&
    argument.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    let owner: ts.Node | undefined = argument.parent;
    while (owner !== undefined && !ts.isClassLike(owner)) owner = owner.parent;
    const member = (owner as ts.ClassLikeDeclaration | undefined)?.members.find(
      (m) => m.name?.getText(file) === argument.name.text,
    );
    if (hasBody(member)) return member;
    return member && ts.isPropertyDeclaration(member) && hasBody(member.initializer)
      ? member.initializer
      : undefined;
  }
  if (!ts.isIdentifier(argument)) return undefined;
  const find = (node: ts.Node): FunctionWithBody | undefined => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === argument.text && hasBody(node)) {
      return node;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === argument.text &&
      hasBody(node.initializer)
    ) {
      return node.initializer;
    }
    return ts.forEachChild(node, find);
  };
  return find(file);
}

/** A place the API sends on a socket. */
interface SocketSend {
  /** The event as written: `REALTIME_EXCEPTION_EVENT`, `reply to 'ping'`, `ack to 'save'`. */
  event: string;
  /**
   * What goes out, as written: the arguments after the event, the arguments of an
   * acknowledgement's call, a reply's returned values. Undefined when it cannot be read where it
   * is sent: an acknowledgement handed on is called elsewhere.
   */
  payload: readonly ts.Expression[] | undefined;
  /** A reply's handler: Nest sends what it returns, so its return type is the payload's. */
  handler?: ts.MethodDeclaration;
}

/** What a source's socket code does: where it sends, and the message handlers it declares. */
interface SocketCode {
  /** Every send, with its event as written and what it carries. */
  sends: SocketSend[];
  /** Every `@SubscribeMessage` handler, `Class.method`, with the positions of its `@Ack()`s. */
  handlers: { name: string; acks: number[] }[];
}

/**
 * Every send in a source, with its event as written and what it carries: an emit call; in a
 * socket file, a `send` or `write` call (`message`) and a call of the acknowledgement callback a
 * listener is handed as its last argument (`ack to` its event); a `@SubscribeMessage` handler
 * that may return something — Nest sends a returned value back, as the ack or as the
 * `{ event, data }` it names — as `reply to` its message, and each read of its `@Ack()`
 * parameter — a call, or handing it on — as `ack to` its message. A handler is no reply only
 * when it declares `void` or `Promise<void>`. The decorators are read under whatever name the
 * file imports them.
 */
function readSocketCode(file: ts.SourceFile): SocketCode {
  const socketFile = file.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      SOCKET_MODULE.test(statement.moduleSpecifier.text),
  );
  const decoratorOf = nestDecorators(file);
  const code: SocketCode = { sends: [], handlers: [] };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const event = node.arguments[0]?.getText(file) ?? '';
      if (EMITS.has(name)) code.sends.push({ event, payload: node.arguments.slice(1) });
      else if (socketFile && SOCKET_SENDS.has(name)) {
        code.sends.push({ event: 'message', payload: [...node.arguments] });
      } else if (socketFile && LISTENS.has(name) && node.arguments.length > 1) {
        const listener = listenerOf(file, node.arguments.at(-1)!);
        const ack = listener?.parameters.at(-1)?.name;
        if (listener && ack && ts.isIdentifier(ack)) {
          // Calls only: a listener's last argument is the ack only when the client asked for
          // one, and is otherwise data (a Redis listener's message), which is read but not called.
          for (const { call } of readsOf(listener.body, ack.text)) {
            if (call) code.sends.push({ event: `ack to ${event}`, payload: [...call.arguments] });
          }
        }
      }
    }
    if (ts.isMethodDeclaration(node)) {
      const subscribed = (ts.getDecorators(node) ?? []).find(
        (decorator) => decoratorOf(decorator) === 'SubscribeMessage',
      );
      if (subscribed) {
        const message = (subscribed.expression as ts.CallExpression).arguments[0]?.getText(file);
        const owner = ts.isClassLike(node.parent) ? node.parent.name?.text : undefined;
        const acks = node.parameters.flatMap((parameter, index) =>
          (ts.getDecorators(parameter) ?? []).some((decorator) => decoratorOf(decorator) === 'Ack')
            ? [index]
            : [],
        );
        code.handlers.push({ name: `${owner ?? '(anonymous)'}.${node.name.getText(file)}`, acks });
        if (!NO_REPLY.has(node.type?.getText(file).replaceAll(/\s/g, '') ?? '')) {
          code.sends.push({
            event: `reply to ${message ?? ''}`,
            payload: node.body === undefined ? [] : returnsOf(node.body),
            handler: node,
          });
        }
        for (const index of acks) {
          // Every read: a call sends its arguments, and a callback handed on is called elsewhere,
          // with a payload this cannot read. One that cannot be followed (destructured) counts
          // once, unread.
          const ack = node.parameters[index]!.name;
          const reads =
            ts.isIdentifier(ack) && node.body !== undefined ? readsOf(node.body, ack.text) : [{}];
          code.sends.push(
            ...reads.map(({ call }) => ({
              event: `ack to ${message ?? ''}`,
              payload: call ? [...call.arguments] : undefined,
            })),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return code;
}

/** What the socket code of `text` does, read without types. */
const socketCodeOf = (fileName: string, text: string) =>
  readSocketCode(ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true));

const emitsOf = (fileName: string, text: string) => socketCodeOf(fileName, text).sends;

/** The types of a program, as the payload check reads them. */
interface Types {
  checker: ts.TypeChecker;
  /** Declared only by TypeScript's own library (Date, Map, Promise): no fields of ours. */
  isLibrary: (type: ts.Type) => boolean;
}

function typesOf(program: ts.Program): Types {
  return {
    checker: program.getTypeChecker(),
    isLibrary: (type) => {
      const declarations = (type.aliasSymbol ?? type.getSymbol())?.getDeclarations() ?? [];
      return (
        declarations.length > 0 &&
        declarations.every((d) => program.isSourceFileDefaultLibrary(d.getSourceFile()))
      );
    },
  };
}

/**
 * The property names a type gives what is sent, at every level: an object's properties that are
 * not methods, an array's or a tuple's elements, each member of a union. A primitive, `unknown`,
 * a function and a library type (Date) give none.
 */
function typeNames(types: Types, type: ts.Type, at: ts.Node, seen = new Set<ts.Type>()): string[] {
  if (seen.has(type)) return [];
  seen.add(type);
  const { checker } = types;
  if (type.isUnionOrIntersection()) {
    return type.types.flatMap((member) => typeNames(types, member, at, seen));
  }
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return checker
      .getTypeArguments(type as ts.TypeReference)
      .flatMap((element) => typeNames(types, element, at, seen));
  }
  if ((type.flags & ts.TypeFlags.Object) === 0 || type.getCallSignatures().length > 0) return [];
  if (types.isLibrary(type)) return [];
  return type.getProperties().flatMap((property) => {
    const value = checker.getTypeOfSymbolAtLocation(property, at);
    if (!value.isUnion() && value.getCallSignatures().length > 0) return [];
    return [property.name, ...typeNames(types, value, at, seen)];
  });
}

/** The property names the object literals written in `node` give, at every level. */
function writtenNames(node: ts.Node): string[] {
  const names: string[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isObjectLiteralExpression(child)) {
      for (const property of child.properties) {
        const name = property.name;
        if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) names.push(name.text);
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names;
}

/**
 * What a send carries, by name: `typed` from the type of each value sent (a reply's from its
 * handler's return type, awaited), `written` from the object literals in them. Undefined when
 * the payload cannot be read where it is sent.
 */
function payloadNamesOf(send: SocketSend, types: Types) {
  if (send.payload === undefined) return undefined;
  const { checker } = types;
  const signature = send.handler && checker.getSignatureFromDeclaration(send.handler);
  const returned = signature && checker.getReturnTypeOfSignature(signature);
  const typed = returned
    ? typeNames(types, checker.getAwaitedType(returned) ?? returned, send.handler!)
    : send.payload.flatMap((value) => typeNames(types, checker.getTypeAtLocation(value), value));
  return { typed: [...new Set(typed)], written: [...new Set(send.payload.flatMap(writtenNames))] };
}

/** Every property name a JSON Schema has, at every level. */
function jsonSchemaNames(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(jsonSchemaNames);
  if (node === null || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  const own =
    record.properties !== null && typeof record.properties === 'object'
      ? Object.keys(record.properties)
      : [];
  return [...own, ...Object.values(record).flatMap(jsonSchemaNames)];
}

/** The property names a declared payload schema has, at every level. */
const schemaNames = (schema: z.ZodType) =>
  new Set(jsonSchemaNames(z.toJSONSchema(schema, { unrepresentable: 'any' })));

/** `name: item` for each name PRIVATE_DATA names, or that names an excluded feature or a probability. */
const forbiddenNames = (names: Iterable<string>) => [
  ...new Set([
    ...[...new Set(names)].flatMap((name) =>
      findPrivateField(name).map((hit) => `${name}: ${hit.item}`),
    ),
    ...excludedIn(names, true),
  ]),
];

/**
 * What is wrong with what a send carries, against what its registry line declares: a payload
 * that cannot be read here; a payload where none is declared; a name the schema does not have;
 * a name, sent or declared, that is private data, an excluded feature or a probability (not for
 * a room event, whose names are its channel's to check).
 */
function payloadProblems(
  send: SocketSend,
  declared: Pick<RegisteredEmit, 'payload' | 'roomEvent'>,
  types: Types,
): string[] {
  const names = payloadNamesOf(send, types);
  if (names === undefined) return ['cannot read what it sends where it sends it'];
  if (declared.payload === null) {
    const sent = [...send.payload!.map((value) => value.getText()), ...names.typed];
    return sent.length === 0 ? [] : [`sends ${sent.join(', ')}: declares no payload`];
  }
  const allowed = schemaNames(declared.payload);
  const undeclared = names.typed
    .filter((name) => !allowed.has(name))
    .map((name) => `${name}: not in its schema`);
  if (declared.roomEvent) return undeclared;
  return [...undeclared, ...forbiddenNames([...names.typed, ...names.written, ...allowed])];
}

/** The API's sources, each with what its socket code does, read with their types. */
const PROGRAM = programOf(sources());
const TYPES = typesOf(PROGRAM);
const SOCKET_CODE = sources().map((file) => ({
  file: srcPath(file),
  ...readSocketCode(PROGRAM.getSourceFile(file)!),
}));

/** The registry line of a send. */
const emitOf = (file: string, send: SocketSend) =>
  REALTIME_EMITS.find((emit) => emit.file === file && emit.event === send.event);

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

  it('knows a send when it reads one', () => {
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
    // In a socket file, `send` and `write` send a `message`, and a handler may reply.
    const gateway = [
      "import { SubscribeMessage } from '@nestjs/websockets';",
      "import { type Socket } from 'socket.io';",
      'class Planted {',
      "  @SubscribeMessage('subscribe') handleSubscribe(): void { client.send(secret); }",
      "  @SubscribeMessage('watch') async watch(): Promise<void> { this.server.write(data); }",
      "  @SubscribeMessage('ping') ping() { return { event: 'pong', data: secret }; }",
      "  @SubscribeMessage('ask') ask(): WsResponse<string> { return reply; }",
      '}',
    ].join('\n');
    expect(emitsOf('planted.ts', gateway).map(({ event }) => event)).toEqual([
      'message',
      'message',
      "reply to 'ping'",
      "reply to 'ask'",
    ]);
  });

  it('reads what each send carries: the arguments, an acknowledgement’s, a reply’s returns', () => {
    const planted = [
      "import { Ack, SubscribeMessage } from '@nestjs/websockets';",
      "import { type Socket } from 'socket.io';",
      'class Planted {',
      "  @SubscribeMessage('ask') ask() { if (x) return { a: 1 }; return reply; }",
      "  @SubscribeMessage('save') save(@Ack() done: Done): void { done({ ok: true }); relay(done); }",
      '  wire(client: Socket) {',
      '    client.emit(REALTIME_EXCEPTION_EVENT, envelope);',
      '    this.namespace.local.emit(RESYNC_EVENT);',
      '    client.send(first, second);',
      "    client.on('find', (query: string, reply: Done) => { reply(found); });",
      '  }',
      '}',
    ].join('\n');
    expect(
      emitsOf('planted.ts', planted).map(({ event, payload }) => [
        event,
        payload?.map((value) => value.getText()),
      ]),
    ).toEqual([
      ["reply to 'ask'", ['{ a: 1 }', 'reply']],
      ["ack to 'save'", ['{ ok: true }']],
      // Handed on: called elsewhere, with what this cannot read.
      ["ack to 'save'", undefined],
      ['REALTIME_EXCEPTION_EVENT', ['envelope']],
      ['RESYNC_EVENT', []],
      ['message', ['first', 'second']],
      ["ack to 'find'", ['found']],
    ]);
  });

  it('holds what a send carries to the schema its line declares, by type and as written', () => {
    const file = path.join(SRC, 'realtime', '__planted__.ts');
    const planted = [
      "import { REALTIME_EXCEPTION_EVENT, RESYNC_EVENT, errorEnvelope, type ErrorEnvelope } from '@buddha/shared';",
      "import { Ack, SubscribeMessage } from '@nestjs/websockets';",
      "import { type Socket } from 'socket.io';",
      'interface Account { email: string; availableCoin: string }',
      'type Done = (body: unknown) => void;',
      'declare function forward(done: Done): void;',
      'export function refuse(client: Socket, envelope: ErrorEnvelope, account: Account) {',
      '  client.emit(REALTIME_EXCEPTION_EVENT, envelope);',
      '  client.emit(REALTIME_EXCEPTION_EVENT, { ...envelope, email: account.email });',
      "  client.emit(REALTIME_EXCEPTION_EVENT, errorEnvelope('RATE_LIMITED', 'slow', { availableCoin: account.availableCoin }));",
      "  client.emit(REALTIME_EXCEPTION_EVENT, { error: { code: 'INTERNAL' as const, message: '', at: new Date() } });",
      '  client.emit(RESYNC_EVENT);',
      '  client.emit(RESYNC_EVENT, { at: Date.now() });',
      '}',
      'export class Planted {',
      "  private readonly account: Account = { email: '', availableCoin: '0' };",
      "  @SubscribeMessage('whoami')",
      '  async whoami(@Ack() done: Done): Promise<Account> {',
      '    done(this.account);',
      '    return this.account;',
      '  }',
      "  @SubscribeMessage('relay')",
      '  relay(@Ack() done: Done): void {',
      '    forward(done);',
      '  }',
      '}',
    ].join('\n');
    const program = programOf([], { [file]: planted });
    const types = typesOf(program);
    const { sends } = readSocketCode(program.getSourceFile(file)!);
    const declared = (send: SocketSend) => ({
      payload: send.event === 'RESYNC_EVENT' ? null : errorEnvelopeSchema,
    });
    const account = [
      'email: not in its schema',
      'availableCoin: not in its schema',
      'email: email',
      'availableCoin: balance',
    ];
    expect(sends.map((send) => [send.event, payloadProblems(send, declared(send), types)])).toEqual(
      [
        ['REALTIME_EXCEPTION_EVENT', []],
        // A field added beside the envelope: by its type, and as written.
        ['REALTIME_EXCEPTION_EVENT', ['email: not in its schema', 'email: email']],
        // In `details`, which the schema leaves open: as written.
        ['REALTIME_EXCEPTION_EVENT', ['availableCoin: balance']],
        // Nested, and a library type (Date) is a value, not fields.
        ['REALTIME_EXCEPTION_EVENT', ['at: not in its schema']],
        ['RESYNC_EVENT', []],
        ['RESYNC_EVENT', ['sends { at: Date.now() }, at: declares no payload']],
        ["reply to 'whoami'", account],
        ["ack to 'whoami'", account],
        ["ack to 'relay'", ['cannot read what it sends where it sends it']],
      ],
    );
    // A room event's names are its channel's: only that they are the schema's is checked here.
    expect(
      payloadProblems(sends[1]!, { payload: errorEnvelopeSchema, roomEvent: true }, types),
    ).toEqual(['email: not in its schema']);
  });

  it('reads the decorators under any name they are imported by, and every acknowledgement', () => {
    const aliased = [
      "import { Ack as Reply, SubscribeMessage as OnMessage } from '@nestjs/websockets';",
      "import * as ws from '@nestjs/websockets';",
      'class Planted {',
      "  @OnMessage('lookup') lookup() { return secret; }",
      "  @ws.SubscribeMessage('find') find(): WsResponse<string> { return reply; }",
      "  @OnMessage('silent') silent(): void { log(); }",
      // An acknowledgement the handler calls itself, under any name, or hands on.
      "  @OnMessage('save') save(@MessageBody() body: Body, @Reply() done: Done): void {",
      '    done(secret);',
      '    if (body.twice) done(secret);',
      '  }',
      "  @OnMessage('relay') relay(@ws.Ack() ack: Done): void { this.service.answer(ack); }",
      "  @OnMessage('unused') unused(@Reply() ack: Done): void { const x = { ack: 1 }; x.ack; }",
      '}',
    ].join('\n');
    const code = socketCodeOf('planted.ts', aliased);
    expect(code.sends.map(({ event }) => event)).toEqual([
      "reply to 'lookup'",
      "reply to 'find'",
      "ack to 'save'",
      "ack to 'save'",
      "ack to 'relay'",
    ]);
    expect(code.handlers).toEqual([
      { name: 'Planted.lookup', acks: [] },
      { name: 'Planted.find', acks: [] },
      { name: 'Planted.silent', acks: [] },
      { name: 'Planted.save', acks: [1] },
      { name: 'Planted.relay', acks: [0] },
      { name: 'Planted.unused', acks: [0] },
    ]);
    // A Socket.IO listener is handed the client's acknowledgement last: in place, as
    // `this.member`, or by a name the file declares. A listener that never calls its last
    // argument (a Redis message) sends nothing.
    const listeners = [
      "import { type Socket } from 'socket.io';",
      'function onFind(query: string, reply: Done) { reply(secret); }',
      'class Planted {',
      '  private readonly onAsk = (body: Body, answer: Done): void => { answer(secret); };',
      '  private onPing(done: Done) { done(); }',
      '  wire(client: Socket) {',
      "    client.on('lookup', (body: Body, ack: Done) => { ack(secret); });",
      "    client.once('ask', this.onAsk);",
      "    client.on('ping', this.onPing);",
      "    client.on('find', onFind);",
      "    subscriber.on('pmessage', (pattern: string, channel: string, message: string) => {",
      '      parse(message);',
      '    });',
      "    client.on('disconnect', () => {});",
      '  }',
      '}',
    ].join('\n');
    expect(emitsOf('planted.ts', listeners).map(({ event }) => event)).toEqual([
      "ack to 'lookup'",
      "ack to 'ask'",
      "ack to 'ping'",
      "ack to 'find'",
    ]);
  });

  it('reads every message handler Nest maps, with its @Ack() parameters', () => {
    // What the module graph maps against what the reader above recognised: a decorator spelled
    // in a way it cannot follow (a local constant, a decorator composed of it) fails here rather
    // than leaving the handler's replies and acknowledgements uncounted.
    // A base class two gateways share declares its handlers once.
    const mapped = [
      ...new Map(
        discoverGateways()
          .flatMap((gateway) => gateway.handlers)
          .map((handler) => [handler.name, handler]),
      ).values(),
    ];
    expect(mapped.map(({ name }) => name)).toContain('MarketGateway.handleSubscribe');
    const read = SOCKET_CODE.flatMap(({ handlers }) => handlers);
    const byName = (handlers: { name: string; acks: number[] }[]) =>
      [...handlers].sort((a, b) => a.name.localeCompare(b.name));
    expect(byName(read)).toEqual(byName(mapped));
  });

  it('sends on a socket only where REALTIME_EMITS says, each with a reason', () => {
    const found = SOCKET_CODE.flatMap(({ file, sends }) =>
      sends.map(({ event }) => `${file} ${event}`),
    ).sort();
    expect(found).toContain('realtime/market.gateway.ts event.type');
    expect(found).toEqual(REALTIME_EMITS.map(({ file, event }) => `${file} ${event}`).sort());
    for (const emit of REALTIME_EMITS) expect(emit.reason.trim(), emit.event).not.toBe('');
  });

  it('sends only what each line declares, and nothing private, excluded or a probability', () => {
    const problems = SOCKET_CODE.flatMap(({ file, sends }) =>
      sends.flatMap((send) => {
        const declared = emitOf(file, send);
        // A send with no line fails the test above.
        return declared === undefined
          ? []
          : payloadProblems(send, declared, TYPES).map(
              (problem) => `${file} ${send.event}: ${problem}`,
            );
      }),
    );
    expect(problems).toEqual([]);
    // A guard on the reading: the error envelopes' names were read, by type and as written.
    const sendsOf = (file: string) => SOCKET_CODE.find((code) => code.file === file)!.sends;
    const refusal = sendsOf('realtime/realtime-exception.filter.ts')[0]!;
    expect(payloadNamesOf(refusal, TYPES)?.typed).toEqual(
      expect.arrayContaining(['error', 'code', 'message', 'details']),
    );
    const rateLimited = sendsOf('realtime/market.gateway.ts').find(
      (send) => send.event === 'REALTIME_EXCEPTION_EVENT',
    )!;
    expect(payloadNamesOf(rateLimited, TYPES)?.written).toEqual(['retryAfterSeconds']);
    const roomEvent = sendsOf('realtime/market.gateway.ts').find(
      (send) => send.event === 'event.type',
    )!;
    expect(payloadNamesOf(roomEvent, TYPES)?.typed).toEqual(
      expect.arrayContaining(['marketId', 'availableCoin', 'statusEventId']),
    );
    for (const emit of REALTIME_EMITS) {
      if (emit.payload) expect(schemaNames(emit.payload).size, emit.event).toBeGreaterThan(0);
    }
  });
});
