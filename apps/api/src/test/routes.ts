// Route discovery from the module graph, for the static suites that check a rule over EVERY
// route — not over a list someone has to remember to extend (admin-audit.test.ts,
// admin-access.test.ts, surface/registry.test.ts).
import { RequestMethod, VERSION_NEUTRAL } from '@nestjs/common';
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
  VERSION_METADATA,
} from '@nestjs/common/constants.js';
import { AppModule } from '../app.module.js';

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
  handler: (...args: unknown[]) => unknown;
}

/** Walks a module and everything it imports, collecting controller classes once each. */
function controllersOf(module: unknown, seen = new Set<unknown>()): unknown[] {
  // A module is either a CLASS (a function) or a DynamicModule (an object); rejecting one of
  // the two returns an empty list from the root and makes every assertion vacuous.
  // Written as two inline `typeof`s and not through a variable: the variable form is not a
  // type guard, so `module` stays `unknown` and `Reflect.getMetadata` will not take it.
  if (module === null || (typeof module !== 'object' && typeof module !== 'function')) return [];
  if (seen.has(module)) return [];
  seen.add(module);
  // A DynamicModule (ConfigModule.forRoot(), ThrottlerModule.forRootAsync()) carries its
  // metadata as plain properties; a class module carries it as Reflect metadata.
  const dynamic = module as { module?: unknown; imports?: unknown[]; controllers?: unknown[] };
  const imports =
    dynamic.imports ??
    (Reflect.getMetadata(MODULE_METADATA.IMPORTS, module) as unknown[] | undefined) ??
    [];
  const controllers =
    dynamic.controllers ??
    (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, module) as unknown[] | undefined) ??
    [];
  const nested = dynamic.module === undefined ? [] : controllersOf(dynamic.module, seen);
  return [
    ...controllers,
    ...nested,
    ...imports.flatMap((imported) => controllersOf(imported, seen)),
  ];
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

/** Every route of every controller reachable from AppModule. */
export function discoverRoutes(): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  for (const controller of controllersOf(AppModule)) {
    if (typeof controller !== 'function') continue;
    const base = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '';
    const prototype = (controller as { prototype: object }).prototype;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
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
        handler: handler as DiscoveredRoute['handler'],
      });
    }
  }
  return routes;
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
