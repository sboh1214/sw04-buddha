import * as z from 'zod';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_PARAM_KEY_PATTERN,
  NOTIFICATION_TARGET_KINDS,
  NOTIFICATION_TYPE_PATTERN,
  type NotificationDefinition,
  type NotificationType,
} from '../notifications.js';
import {
  findExcludedIdentifier,
  findExcludedText,
  type ExcludedIdentifierHit,
  type ExcludedTextHit,
} from './excluded.js';

/**
 * The notification types, registered for the excluded-feature check (#113). The product's list
 * is NOTIFICATION_DEFINITIONS (notifications.ts, #53, ADR-0157), and this registry is keyed by it
 * exactly as REALTIME_EVENT_REGISTRY is by the event types: a type defined without its entry here,
 * or an entry left behind for a removed type, fails to compile. Each entry holds every text a
 * person reads in the type — its title and body as the web's renderer words them, placeholders as
 * written — and why it exists. N05 §4 leaves score, ranking, Forecast-edit and paid-Coin purchase
 * notifications out of the initial product, and guards/notifications.test.ts fails on a type that
 * names any excluded feature (EXCLUDED_FEATURES), as a name or in its text. Empty in #53, which
 * ships no type (52-20). docs/GUARDS.md has the registration rule.
 */
export interface NotificationTypeText {
  /** Every text a person reads in it: the title and the body, placeholders as written. */
  readonly text: readonly string[];
  /** What it tells, and the plan section and owner answer it comes from. */
  readonly reason: string;
}

export const NOTIFICATION_TYPE_REGISTRY = {} as const satisfies Record<
  NotificationType,
  NotificationTypeText
>;

/** One registered type with its name: what the excluded-feature check reads. */
export interface NotificationTypeEntry extends NotificationTypeText {
  /** The type as the API and its stored rows name it. */
  readonly type: string;
}

export const NOTIFICATION_TYPES: readonly NotificationTypeEntry[] = Object.entries(
  NOTIFICATION_TYPE_REGISTRY as Readonly<Record<string, NotificationTypeText>>,
).map(([type, entry]) => ({ type, ...entry }));

export type NotificationHit = ExcludedIdentifierHit | ExcludedTextHit;

/**
 * The excluded features a notification type names. Its name is an API value, so it is held to
 * the API's tokens (paid purchase included, N05 §4); its text is screen text.
 */
export function findExcludedNotification(entry: NotificationTypeEntry): NotificationHit[] {
  return [
    ...findExcludedIdentifier(entry.type, 'api'),
    ...entry.text.flatMap((text) => findExcludedText(text)),
  ];
}

/**
 * Parameter names that would store another member's identity (ADR-0157, 52-15, ADR-0086): a type
 * that shows one — a reply's author — reads it through its target when the list is read, so a
 * closed member's '탈퇴한 사용자' and a forced nickname change show at once and nothing of theirs
 * stays in other members' inboxes.
 */
export const NOTIFICATION_IDENTITY_PARAM =
  /user|account|counterparty|publicId|nickname|author|email|phone/i;

/** The JSON Schema `type`s a flat parameter may take. */
const FLAT_JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/** Whether a field's JSON Schema takes flat values only: a primitive, a union of them, an enum. */
function isFlat(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return false;
  const node = schema as Record<string, unknown>;
  for (const union of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(node[union])) return (node[union] as unknown[]).every(isFlat);
  }
  if (Array.isArray(node.enum)) {
    return node.enum.every((value) => value === null || typeof value !== 'object');
  }
  if ('const' in node) return node.const === null || typeof node.const !== 'object';
  const types = Array.isArray(node.type) ? (node.type as unknown[]) : [node.type];
  return types.length > 0 && types.every((type) => FLAT_JSON_TYPES.has(String(type)));
}

/**
 * What breaks the rules every notification definition keeps (ADR-0157 결정 2·3): a type outside
 * NOTIFICATION_TYPE_PATTERN or listed twice, a category outside the list, no target or a target
 * kind not in the union, params that are not a flat object of string, number, boolean or null
 * fields, a parameter name outside NOTIFICATION_PARAM_KEY_PATTERN or one that names another
 * account or its identity (NOTIFICATION_IDENTITY_PARAM), and a `merge` that is neither null nor a
 * function. Empty when the list keeps them all; notifications.test.ts reads it for
 * NOTIFICATION_DEFINITIONS and for planted lists.
 */
export function findNotificationDefinitionProblems(
  definitions: readonly NotificationDefinition[],
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const definition of definitions) {
    const { type } = definition;
    if (!NOTIFICATION_TYPE_PATTERN.test(type)) problems.push(`${type}: type shape`);
    if (seen.has(type)) problems.push(`${type}: listed twice`);
    seen.add(type);
    if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(definition.category)) {
      problems.push(`${type}: category ${definition.category}`);
    }
    if (definition.targets.length === 0) problems.push(`${type}: no target kind`);
    for (const kind of definition.targets) {
      if (!(NOTIFICATION_TARGET_KINDS as readonly string[]).includes(kind)) {
        problems.push(`${type}: target kind ${kind}`);
      }
    }
    if (definition.merge !== null && typeof definition.merge !== 'function') {
      problems.push(`${type}: merge`);
    }
    if (!(definition.params instanceof z.ZodObject)) {
      problems.push(`${type}: params are not an object`);
      continue;
    }
    const shape = definition.params.shape;
    for (const [key, field] of Object.entries(shape)) {
      if (!NOTIFICATION_PARAM_KEY_PATTERN.test(key)) problems.push(`${type}.${key}: name shape`);
      if (NOTIFICATION_IDENTITY_PARAM.test(key)) {
        problems.push(`${type}.${key}: names another account or its identity`);
      }
      const flat = (() => {
        try {
          return isFlat(z.toJSONSchema(field, { io: 'input', unrepresentable: 'any' }));
        } catch {
          return false;
        }
      })();
      if (!flat) problems.push(`${type}.${key}: not a flat value`);
    }
  }
  return problems;
}
