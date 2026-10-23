import { describe, expect, it } from 'vitest';
import { NICKNAME_HOLD_DAYS } from './nickname.js';
import { RETENTION_PERIOD_SETTINGS } from './release-settings.js';
import {
  NICKNAME_HOLD_PURGE_DAYS,
  RETENTION_PERIODS,
  RETENTION_PURGE_KINDS,
  RETENTION_PURGE_KIND_PERIODS,
  retentionCutoffOf,
  retentionPurgeSchema,
} from './retention.js';

describe('retention (#184)', () => {
  it('has a release setting for each period the owner listed, and the 본인확인 기록', () => {
    expect(RETENTION_PERIODS).toEqual([
      'consent_records',
      'phone_verification_records',
      'deleted_posts',
      'moderation_records',
      'removed_profile_items',
    ]);
    expect(Object.keys(RETENTION_PERIOD_SETTINGS)).toEqual([...RETENTION_PERIODS]);
  });

  it('gives every purge kind its period: the edit history shares the deleted originals’ (ADR-0069 decision 7)', () => {
    expect(Object.keys(RETENTION_PURGE_KIND_PERIODS)).toEqual([...RETENTION_PURGE_KINDS]);
    expect(RETENTION_PURGE_KIND_PERIODS.post_revisions).toBe('deleted_posts');
    expect(RETENTION_PURGE_KIND_PERIODS.comment_revisions).toBe('deleted_posts');
    expect(RETENTION_PURGE_KIND_PERIODS.deleted_comments).toBe('deleted_posts');
    expect(RETENTION_PURGE_KIND_PERIODS.reports).toBe('moderation_records');
    expect(RETENTION_PURGE_KIND_PERIODS.approval_requests).toBe('moderation_records');
    // Every period is applied to some kind.
    expect(new Set(Object.values(RETENTION_PURGE_KIND_PERIODS).filter(Boolean))).toEqual(
      new Set(RETENTION_PERIODS),
    );
    // The nickname holds' 30 days are the hold itself (#57-6), not a setting.
    expect(RETENTION_PURGE_KIND_PERIODS.nickname_holds).toBeNull();
    expect(NICKNAME_HOLD_PURGE_DAYS).toBe(NICKNAME_HOLD_DAYS);
  });

  it('counts a period in days of 24 hours back from the run', () => {
    const now = new Date('2026-10-24T03:00:00.000Z');
    expect(retentionCutoffOf(now, 1).toISOString()).toBe('2026-10-23T03:00:00.000Z');
    expect(retentionCutoffOf(now, 365).toISOString()).toBe('2025-10-24T03:00:00.000Z');
  });

  it('records a kind, a count, a period and an instant — nothing about a person', () => {
    const record = {
      id: '1',
      kind: 'consent_records',
      count: 4,
      periodDays: 30,
      ranAt: '2026-10-24T03:00:00.000Z',
    };
    expect(retentionPurgeSchema.parse(record)).toEqual(record);
    expect(Object.keys(retentionPurgeSchema.shape).sort()).toEqual(
      ['count', 'id', 'kind', 'periodDays', 'ranAt'].sort(),
    );
    expect(retentionPurgeSchema.safeParse({ ...record, kind: 'ledger_entries' }).success).toBe(
      false,
    );
  });
});
