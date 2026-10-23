import { APPEAL_WINDOW_DAYS } from '@buddha/shared';
import { type Locator } from '@playwright/test';
import { copy } from '../src/copy';
import { expect } from './helpers';

/**
 * 제재 이의의 안내 (#186, ADR-0084) as the specs check it on an action's card on 조치·신고 내역:
 * its '이의 기한' line, read against the card's own '조치한 때'. Shared by reports.spec.ts (#50's
 * actions) and restrictions.spec.ts (#185's writing restriction, whose card keeps the line through a
 * 감경 or an early lift — ADR-0084 결과 5).
 */

/**
 * `text` — an absolute time as a member screen writes it in Seoul, the projects' zone
 * (`2026. 10. 22. 오후 3:00`, ADR-0063) — `days` later. Seoul keeps no daylight saving, so the clock
 * part reads the same; reading the screen's own text keeps the ICU that wrote it out of the check.
 */
export function seoulDaysLater(text: string, days: number): string {
  const match = /^(\d{4})\. (\d{1,2})\. (\d{1,2})\. (.+)$/.exec(text.trim());
  if (match === null) throw new Error(`not a member screen's time: ${text}`);
  const [, year, month, day, clock] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + days));
  return `${String(date.getUTCFullYear())}. ${String(date.getUTCMonth() + 1)}. ${String(date.getUTCDate())}. ${clock ?? ''}`;
}

/**
 * An action's card on 조치·신고 내역 gives its appeal deadline (owner decision 2026-10-22 답 1) —
 * '이의 기한' and `deadline`, or once that has passed '이의 기한이 지났습니다.' and the same deadline
 * (답 2) — and nothing more of the appeal: the guidance is the page's, once (답 4).
 */
export async function expectDeadlineLine(
  card: Locator,
  deadline: string,
  passed: boolean,
): Promise<void> {
  await expect(card.getByTestId('my-action-appeal-label')).toHaveText(
    passed ? copy.moderationAppealDeadlinePassed : copy.moderationAppealDeadline,
  );
  await expect(card.getByTestId('my-action-appeal-value')).toHaveText(deadline);
  await expect(card.getByTestId('my-moderation-appeal')).toHaveCount(0);
  await expect(card).not.toContainText('고객센터 이메일');
}

/**
 * The deadline an action's card on 조치·신고 내역 must give: APPEAL_WINDOW_DAYS after the time its
 * '조치한 때' line writes.
 */
export async function deadlineOnCard(card: Locator): Promise<string> {
  await expect(card.getByTestId('my-action-taken-label')).toHaveText(copy.moderationTakenAt);
  const taken = (await card.getByTestId('my-action-taken-value').textContent()) ?? '';
  return seoulDaysLater(taken, APPEAL_WINDOW_DAYS);
}
