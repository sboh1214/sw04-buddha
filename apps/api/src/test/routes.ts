// Route and gateway discovery from the module graph, and better-auth's routes from its instance,
// for the static suites that check a rule over EVERY route or gateway — not over a list someone
// has to remember to extend (admin-audit.test.ts, admin-access.test.ts, surface/registry.test.ts).
import { RequestMethod, VERSION_NEUTRAL } from '@nestjs/common';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { MetadataScanner } from '@nestjs/core';
// From `constants.js`, not the package root: the root re-exports these names as TYPES only, so
// importing them from there compiles and then reads `Reflect.getMetadata(undefined, …)` at
// runtime — which answers `undefined` for every handler and turns a suite into a test that
// discovers nothing and passes. Each suite keeps a "finds the admin surface at all" case because
// that is exactly what happened while writing the first one.
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
  VERSION_METADATA,
} from '@nestjs/common/constants.js';
import {
  GATEWAY_METADATA,
  GATEWAY_OPTIONS,
  MESSAGE_MAPPING_METADATA,
  MESSAGE_METADATA,
  PARAM_ARGS_METADATA,
} from '@nestjs/websockets/constants.js';
import { WsParamtype } from '@nestjs/websockets/enums/ws-paramtype.enum.js';
import { type Db } from '@buddha/db';
import { AppModule } from '../app.module.js';
import { type Auth, createAuth } from '../auth/auth.js';
import { envSchema } from '../config/env.js';

export interface DiscoveredRoute {
  method: string;
  /** `/admin/markets/:id/open`, without the global `api` prefix and the `v1` version. */
  path: string;
  /** `METHOD /path`. */
  key: string;
  /**
   * Where the app serves it, parameters as written: `/api/v1/markets/:id`, or `/api/health` for
   * a VERSION_NEUTRAL controller (main.ts: prefix `api`, URI versioning, default version 1).
   */
  url: string;
  controller: abstract new (...args: never[]) => unknown;
  /** The handler's method name, its own or inherited. */
  name: string;
  handler: (...args: unknown[]) => unknown;
}

type Members = 'controllers' | 'providers';

/** Walks a module and everything it imports, collecting its controllers or providers. */
function membersOf(kind: Members, module: unknown, seen = new Set<unknown>()): unknown[] {
  // A module is either a CLASS (a function) or a DynamicModule (an object); rejecting one of
  // the two returns an empty list from the root and makes every assertion vacuous.
  // Written as two inline `typeof`s and not through a variable: the variable form is not a
  // type guard, so `module` stays `unknown` and `Reflect.getMetadata` will not take it.
  if (module === null || (typeof module !== 'object' && typeof module !== 'function')) return [];
  // `forwardRef(() => FeatureModule)`, the way a cycle between modules is imported: Nest unwraps
  // it, and a walk that read the wrapper would find nothing of the module behind it.
  if ('forwardRef' in module && typeof module.forwardRef === 'function') {
    return membersOf(kind, (module.forwardRef as () => unknown)(), seen);
  }
  if (seen.has(module)) return [];
  seen.add(module);
  // A DynamicModule (ConfigModule.forRoot(), ThrottlerModule.forRootAsync()) carries its
  // metadata as plain properties; a class module carries it as Reflect metadata.
  const dynamic = module as { module?: unknown; imports?: unknown[] } & {
    [K in Members]?: unknown[];
  };
  const imports =
    dynamic.imports ??
    (Reflect.getMetadata(MODULE_METADATA.IMPORTS, module) as unknown[] | undefined) ??
    [];
  const members =
    dynamic[kind] ??
    (Reflect.getMetadata(
      kind === 'controllers' ? MODULE_METADATA.CONTROLLERS : MODULE_METADATA.PROVIDERS,
      module,
    ) as unknown[] | undefined) ??
    [];
  const nested = dynamic.module === undefined ? [] : membersOf(kind, dynamic.module, seen);
  return [...members, ...nested, ...imports.flatMap((imported) => membersOf(kind, imported, seen))];
}

const METHOD_NAMES: Readonly<Record<number, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.ALL]: 'ALL',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
};

/** main.ts `enableVersioning({ defaultVersion: '1' })`. */
const DEFAULT_VERSION = '1';

/** `/api/v1`, or `/api` for a route that answers on every version. */
function prefixOf(controller: object, handler: object): string {
  const version: unknown =
    Reflect.getMetadata(VERSION_METADATA, handler) ??
    Reflect.getMetadata(VERSION_METADATA, controller) ??
    DEFAULT_VERSION;
  if (version === VERSION_NEUTRAL) return '/api';
  const first: unknown = Array.isArray(version) ? version[0] : version;
  return `/api/v${String(first)}`;
}

const scanner = new MetadataScanner();

/**
 * The methods Nest looks at for handlers: the class's own and every one it inherits, nearest
 * first, less accessors and the constructor — Nest's own MetadataScanner, so a handler a
 * controller or a gateway inherits is found as Nest maps it.
 */
function methodsOf(type: { prototype: object }): string[] {
  return scanner.getAllMethodNames(type.prototype);
}

/** The class that declares `method` along the prototype chain: `Base.ping` for an inherited one. */
function declaringClassOf(type: { prototype: object; name: string }, method: string): string {
  for (let prototype: object | null = type.prototype; prototype;) {
    if (Object.hasOwn(prototype, method)) {
      return (prototype as { constructor: { name: string } }).constructor.name;
    }
    prototype = Reflect.getPrototypeOf(prototype);
  }
  return type.name;
}

/** Every route of every controller reachable from `root` (AppModule). */
export function discoverRoutes(root: unknown = AppModule): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  for (const controller of membersOf('controllers', root)) {
    if (typeof controller !== 'function') continue;
    const base = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '';
    const prototype = (controller as { prototype: object }).prototype;
    for (const name of methodsOf(controller)) {
      const handler = (prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;
      const suffix = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (suffix === undefined) continue;
      const method = METHOD_NAMES[Reflect.getMetadata(METHOD_METADATA, handler) as number] ?? '?';
      const path = `/${[base, suffix === '/' ? '' : suffix].filter(Boolean).join('/')}`;
      routes.push({
        method,
        path,
        key: `${method} ${path}`,
        url: `${prefixOf(controller, handler)}${path}`,
        controller: controller as DiscoveredRoute['controller'],
        name,
        handler: handler as DiscoveredRoute['handler'],
      });
    }
  }
  return routes;
}

/** A `@Query()` parameter as Nest keeps it: a key it reads, or a schema of the whole query. */
interface QueryArg {
  data?: unknown;
  schema?: unknown;
}

/** The keys of a schema of the query: a zod object's shape. */
function schemaKeys(schema: unknown): string[] | undefined {
  const shape = (schema as { shape?: unknown } | null)?.shape;
  return shape !== null && typeof shape === 'object' ? Object.keys(shape) : undefined;
}

/**
 * The query keys a route reads: each `@Query('key')`, and the keys of a `@Query({ schema })`
 * object. `*` when a `@Query()` takes the whole query with no object schema, so its keys cannot
 * be listed.
 */
export function queryKeysOf(route: DiscoveredRoute): string[] {
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, route.controller, route.name) ??
    {}) as Record<string, QueryArg>;
  const keys = Object.entries(args)
    .filter(([key]) => key.split(':')[0] === String(RouteParamtypes.QUERY))
    .flatMap(([, arg]) =>
      typeof arg.data === 'string' ? [arg.data] : (schemaKeys(arg.schema) ?? ['*']),
    );
  return [...new Set(keys)].sort();
}

/**
 * The body keys a route reads: the keys of its `@Body({ schema })` object (a refined object's
 * too — zod 4 keeps its shape), `*` when a `@Body()` takes the body with no object schema; none
 * when it takes no body.
 */
export function bodyKeysOf(route: DiscoveredRoute): string[] {
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, route.controller, route.name) ??
    {}) as Record<string, QueryArg>;
  const keys = Object.entries(args)
    .filter(([key]) => key.split(':')[0] === String(RouteParamtypes.BODY))
    .flatMap(([, arg]) =>
      typeof arg.data === 'string' ? [arg.data] : (schemaKeys(arg.schema) ?? ['*']),
    );
  return [...new Set(keys)].sort();
}

export interface DiscoveredGateway {
  /** The Socket.IO namespace it serves, as written: `/ws`, or `/` when none is named. */
  namespace: string;
  /** The messages a client may send it (`@SubscribeMessage`), sorted. */
  messages: string[];
  /**
   * Its message handlers, `Class.method` of the class that declares them (an inherited one is
   * the base class's), each with the positions of its `@Ack()` parameters (the client's
   * acknowledgement callback, which the handler calls itself), sorted.
   */
  handlers: { name: string; acks: number[] }[];
  gateway: abstract new (...args: never[]) => unknown;
}

/** The positions of a handler's `@Ack()` parameters, from the arguments Nest resolves for it. */
function acksOf(gateway: DiscoveredGateway['gateway'], method: string): number[] {
  const args = (Reflect.getMetadata(PARAM_ARGS_METADATA, gateway, method) ?? {}) as Record<
    string,
    { index: number }
  >;
  return Object.entries(args)
    .filter(([key]) => key.split(':')[0] === String(WsParamtype.ACK))
    .map(([, arg]) => arg.index)
    .sort((a, b) => a - b);
}

/**
 * Every `@WebSocketGateway` provider reachable from `root` (AppModule), once each, with its own
 * and inherited handlers. A provider given as `{ provide, useClass }` is read through its class.
 */
export function discoverGateways(root: unknown = AppModule): DiscoveredGateway[] {
  const classes = membersOf('providers', root).map((provider) =>
    typeof provider === 'object' && provider !== null && 'useClass' in provider
      ? provider.useClass
      : provider,
  );
  return [...new Set(classes)]
    .filter(
      (provider): provider is DiscoveredGateway['gateway'] =>
        typeof provider === 'function' && Reflect.getMetadata(GATEWAY_METADATA, provider) === true,
    )
    .map((gateway) => {
      const options = Reflect.getMetadata(GATEWAY_OPTIONS, gateway) as
        { namespace?: string | RegExp } | undefined;
      const prototype = gateway.prototype as Record<string, unknown>;
      const methods = methodsOf(gateway).filter((name) => {
        const handler = prototype[name];
        return (
          typeof handler === 'function' &&
          Reflect.getMetadata(MESSAGE_MAPPING_METADATA, handler) === true
        );
      });
      return {
        namespace: options?.namespace === undefined ? '/' : String(options.namespace),
        messages: methods
          .map((method) => String(Reflect.getMetadata(MESSAGE_METADATA, prototype[method]!)))
          .sort(),
        handlers: methods
          .map((method) => ({
            name: `${declaringClassOf(gateway, method)}.${method}`,
            acks: acksOf(gateway, method),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        gateway,
      };
    });
}

/** The admin surface: `/admin` and everything under it. */
export function isAdminPath(path: string): boolean {
  return path === '/admin' || path.startsWith('/admin/');
}

/** Class guards, then the handler's: the order Nest runs them in. */
export function guardsOf(route: DiscoveredRoute): unknown[] {
  return [
    ...((Reflect.getMetadata(GUARDS_METADATA, route.controller) as unknown[] | undefined) ?? []),
    ...((Reflect.getMetadata(GUARDS_METADATA, route.handler) as unknown[] | undefined) ?? []),
  ];
}

export interface DiscoveredAuthRoute {
  method: string;
  /** `/get-session`, relative to better-auth's base path (AUTH_BASE_PATH, `/api/auth`). */
  path: string;
  /** `METHOD /path`. */
  key: string;
}

/** An endpoint of `auth.api`, as far as its routing goes. */
interface AuthEndpoint {
  path?: string;
  options?: { method?: string | readonly string[]; metadata?: { SERVER_ONLY?: boolean } };
}

/**
 * An auth instance built the way AuthInstanceModule builds it (createAuth), with every option the
 * environment can switch on — every OAuth provider — and nothing behind it: listing its routes
 * calls nothing.
 */
function staticAuth(): Auth {
  const unused = 'routes-only';
  const env = envSchema.parse({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused@localhost/unused',
    REDIS_URL: 'redis://localhost:6379',
    BETTER_AUTH_SECRET: 'routes-only-secret-0123456789abcdef0123456789',
    GOOGLE_CLIENT_ID: unused,
    GOOGLE_CLIENT_SECRET: unused,
    KAKAO_CLIENT_ID: unused,
    KAKAO_CLIENT_SECRET: unused,
    NAVER_CLIENT_ID: unused,
    NAVER_CLIENT_SECRET: unused,
  });
  return createAuth({
    env,
    db: {} as Db,
    mailer: { send: () => Promise.resolve(), verify: () => Promise.resolve(), close: () => {} },
  });
}

/**
 * Every route better-auth serves under /api/auth: each endpoint of `auth.api` with a path,
 * plugins' included, once per method, less the server-only ones (better-call's router skips
 * them) and `disabledPaths` (404 over HTTP). The instance defaults to one built like the app's.
 */
export function discoverAuthRoutes(auth: Pick<Auth, 'api' | 'options'> = staticAuth()) {
  const disabled = new Set<string>(auth.options.disabledPaths ?? []);
  return Object.values(auth.api as Record<string, AuthEndpoint>)
    .filter(
      (endpoint) =>
        endpoint.path !== undefined &&
        endpoint.options?.metadata?.SERVER_ONLY !== true &&
        !disabled.has(endpoint.path),
    )
    .flatMap((endpoint): DiscoveredAuthRoute[] => {
      const methods = endpoint.options?.method ?? 'GET';
      return (typeof methods === 'string' ? [methods] : [...methods]).map((method) => ({
        method,
        path: endpoint.path!,
        key: `${method} ${endpoint.path!}`,
      }));
    });
}

/** The paths better-auth serves only to the server's own calls (`disabledPaths`). */
export function disabledAuthPaths(auth: Pick<Auth, 'options'> = staticAuth()): string[] {
  return [...(auth.options.disabledPaths ?? [])];
}
