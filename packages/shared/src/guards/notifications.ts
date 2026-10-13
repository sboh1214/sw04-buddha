import {
  findExcludedIdentifier,
  findExcludedText,
  type ExcludedIdentifierHit,
  type ExcludedTextHit,
} from './excluded.js';

/**
 * The notification types, registered for the excluded-feature check (#113). There is no
 * notification yet: the feature is #53, which lists every type here as it adds it — its name and
 * every text a person reads in it. N05 §4 leaves score, ranking, Forecast-edit and paid-Coin
 * purchase notifications out of the initial product, and guards/notifications.test.ts fails on a
 * type that names any excluded feature (EXCLUDED_FEATURES), as a name or in its text.
 * docs/GUARDS.md has the registration rule.
 */
export interface NotificationTypeEntry {
  /** The type as the API and its stored rows name it. */
  readonly type: string;
  /** Every text a person reads in it: the title and the body, placeholders as written. */
  readonly text: readonly string[];
  /** What it tells, and the plan section it comes from. */
  readonly reason: string;
}

export const NOTIFICATION_TYPES: readonly NotificationTypeEntry[] = [];

export type NotificationHit = ExcludedIdentifierHit | ExcludedTextHit;

/**
 * The excluded features a notification type names. Its name is an API value, so it is held to
 * the public API's tokens (paid purchase included, N05 §4); its text is screen text.
 */
export function findExcludedNotification(entry: NotificationTypeEntry): NotificationHit[] {
  return [
    ...findExcludedIdentifier(entry.type, 'api'),
    ...entry.text.flatMap((text) => findExcludedText(text)),
  ];
}
