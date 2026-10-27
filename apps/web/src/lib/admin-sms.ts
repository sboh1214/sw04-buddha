import { copy } from '@/copy';
import { type AdminSmsStatus } from './api';
import { formatKst } from './datetime';

/**
 * SMS 발송 현황 (#183, owner decision 2026-10-18, second round, ADR-0070) as the admin screen
 * reads it: the counts of `GET /admin/sms/status` in words. Kept out of the component so vitest
 * can run it under its node environment (admin-sms.test.ts).
 */

/** A count of texts: `12건`. */
export function smsCount(count: number): string {
  return `${count.toLocaleString('ko-KR')}${copy.adminSmsCountUnit}`;
}

/**
 * The service's sends of the last 24 hours against its daily limit: `12 / 500건`. The limit is
 * the API's (`serviceLimit`), so the screen never states a number the server does not hold.
 */
export function smsServiceUsage(last24Hours: AdminSmsStatus['last24Hours']): string {
  return `${last24Hours.sent.toLocaleString('ko-KR')} / ${smsCount(last24Hours.serviceLimit)}`;
}

/**
 * When the counts were read (`asOf`, the database clock), as a label and its value — the way the
 * admin screens label a time ('마지막 변경 …'): `기준 시각 2026. 10. 18. 오후 7:55`, in Seoul.
 */
export function smsAsOf(asOf: string): string {
  return `${copy.adminSmsAsOf} ${formatKst(asOf)}`;
}

/**
 * A Korean date of the API (`YYYY-MM-DD`, already the day in Seoul) as the screen writes dates:
 * `2026. 10. 18.`, the date part of `formatKst` above the table (`dateStyle: 'medium'`), so the
 * screen has one date style. Written from the string itself — no instant, so no time zone.
 */
export function smsDayDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return date;
  const [, year, month, day] = match;
  return `${year!}. ${String(Number(month))}. ${String(Number(day))}.`;
}

/** One row of the seven days' table: the Korean date, today marked, and the three counts. */
export interface SmsDayRow {
  date: string;
  label: string;
  sent: string;
  unknown: string;
  refused: string;
}

/**
 * The seven days as the table shows them, newest first as the API answers them: the first is
 * today (so far), marked `오늘`. `date` stays the API's, the row's key.
 */
export function smsDayRows(days: AdminSmsStatus['days']): SmsDayRow[] {
  return days.map((day, index) => ({
    date: day.date,
    label: index === 0 ? `${smsDayDate(day.date)} (${copy.adminSmsToday})` : smsDayDate(day.date),
    sent: smsCount(day.sent),
    unknown: smsCount(day.unknown),
    refused: smsCount(day.refused),
  }));
}
