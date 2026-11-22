// 수신 설정 (#56, ADR-0162) for the producer suites: a member switches a category through the API,
// as MY › 설정 does, so the producers' gate reads what the route wrote.

import {
  notificationSettingsSchema,
  type NotificationCategory,
  type NotificationSettings,
} from '@buddha/shared';
import { type TestApp, type TestUser } from './app.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const ORIGIN = 'http://localhost:3000';

/**
 * `PUT /me/notifications/settings/:category` as `who`, naming its own account; throws unless 200.
 * Answers every switch after it.
 */
export async function setNotificationSetting(
  t: Pick<TestApp, 'app'>,
  who: Pick<TestUser, 'id' | 'cookie'>,
  category: NotificationCategory,
  enabled: boolean,
): Promise<NotificationSettings> {
  const res = await t.app.inject({
    method: 'PUT',
    url: `/api/v1/me/notifications/settings/${category}`,
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: who.cookie },
    payload: JSON.stringify({ enabled, expectedAccountId: who.id }),
  });
  if (res.statusCode !== 200) {
    throw new Error(`settings write failed: ${String(res.statusCode)} ${res.body}`);
  }
  return notificationSettingsSchema.parse(res.json<{ data: unknown }>().data);
}

/** Turns `categories` off for `who` (the others stay as they are). */
export async function turnOff(
  t: Pick<TestApp, 'app'>,
  who: Pick<TestUser, 'id' | 'cookie'>,
  ...categories: NotificationCategory[]
): Promise<void> {
  for (const category of categories) await setNotificationSetting(t, who, category, false);
}
