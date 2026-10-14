import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_TYPES,
  type NotificationTypeEntry,
  findExcludedNotification,
} from './notifications.js';

const entry = (type: string, ...text: string[]): NotificationTypeEntry => ({
  type,
  text,
  reason: 'test',
});

const features = (candidate: NotificationTypeEntry) => [
  ...new Set(findExcludedNotification(candidate).map((hit) => hit.feature)),
];

describe('NOTIFICATION_TYPES (#113, #53)', () => {
  it('registers each type once, with its text and a reason', () => {
    const types = NOTIFICATION_TYPES.map((candidate) => candidate.type);
    expect(new Set(types).size).toBe(types.length);
    for (const candidate of NOTIFICATION_TYPES) {
      expect(candidate.reason.trim(), candidate.type).not.toBe('');
      expect(candidate.text.length, candidate.type).toBeGreaterThan(0);
    }
  });

  it('names no excluded feature, as a type or in its text (N05 §4)', () => {
    expect(
      NOTIFICATION_TYPES.map((candidate) => ({
        type: candidate.type,
        hits: findExcludedNotification(candidate),
      })).filter((result) => result.hits.length > 0),
    ).toEqual([]);
  });
});

describe('findExcludedNotification', () => {
  // N05 §4: the notifications the initial product leaves out, as #53 might name them.
  it.each([
    ['score_updated', '새 점수가 나왔습니다', 'scoring'],
    ['rank_changed', '순위가 올랐습니다', 'scoring'],
    ['forecast_edited', 'Forecast가 수정되었습니다', 'probability-input'],
    ['coin_low', 'Coin을 충전하고 보너스를 받으세요', 'paid-purchase'],
    ['package_discount', '오늘만 할인', 'paid-purchase'],
    ['attendance_reward', '출석 보상을 받으세요', 'activity-reward'],
  ])('finds %s: %s (%s)', (type, text, feature) => {
    expect(features(entry(type, text))).toContain(feature);
  });

  it('looks at the type name and the text alike', () => {
    expect(features(entry('rank_changed', '알림'))).toEqual(['scoring']);
    expect(features(entry('market_moved', '랭킹이 바뀌었습니다'))).toEqual(['scoring']);
  });

  it('lets a notification about the user’s own market through', () => {
    expect(
      findExcludedNotification(entry('market_resolved', '{title} 시장이 판정되었습니다.')),
    ).toEqual([]);
  });
});
