import { RELEASE_SETTINGS } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ADMIN_RELEASE_SETTINGS_KEY } from '@/hooks/use-admin-release-settings';
import {
  type ReleaseSetting,
  type ReleaseSettingChange,
  type ReleaseSettingChangeRequest,
} from '@/lib/api';
import { byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { AdminReleaseSettings } from './admin-release-settings';

/**
 * 출시 설정 screen, 묶음별 승인 (#331, ADR-0175): the rule line of each item, the waiting-request
 * badge, the 승인 요청 section — retract for its requester, approve and reject for another admin,
 * no approval of a stale one — and the change log's 1인 즉시 / 2인 승인 with the requester and the
 * approver (331-4).
 */

const REQUEST_ID = '33333333-3333-4333-8333-333333333333';

function shipped(key: string, overrides: Partial<ReleaseSetting> = {}): ReleaseSetting {
  const definition = RELEASE_SETTINGS.get(key)!;
  return {
    key,
    label: definition.label,
    unit: definition.unit,
    description: definition.description,
    valueSchema: { type: 'integer' },
    status: 'undecided',
    value: null,
    updatedAt: null,
    updatedBy: null,
    approval: definition.approval,
    pendingRequest: null,
    ...overrides,
  };
}

const request: ReleaseSettingChangeRequest = {
  id: REQUEST_ID,
  key: 'grant.start_coin',
  label: '시작 지급액',
  before: { status: 'undecided', value: null },
  after: { status: 'test', value: 1000 },
  reason: '시작 지급 요청',
  basis: 'enter_value',
  requestedBy: { id: 'admin-a', nickname: '운영자A' },
  requestedAt: '2026-11-26T02:00:00.000Z',
  status: 'pending',
  decidedBy: null,
  decisionReason: null,
  decidedAt: null,
  retractedAt: null,
  stale: false,
};

const changes: ReleaseSettingChange[] = [
  {
    id: '44444444-4444-4444-8444-444444444444',
    key: 'grant.regrant_total_cap_coin',
    label: '재지급 누적 상한',
    before: { status: 'test', value: 500 },
    after: { status: 'test', value: 400 },
    reason: '낮추기',
    actor: { id: 'admin-a', nickname: '운영자A' },
    createdAt: '2026-11-26T03:00:00.000Z',
    path: 'one_admin',
    basis: 'reduce',
    requestedBy: null,
    approvalId: null,
    approvalReason: null,
  },
  {
    id: '55555555-5555-4555-8555-555555555555',
    key: 'grant.start_coin',
    label: '시작 지급액',
    before: { status: 'undecided', value: null },
    after: { status: 'test', value: 1000 },
    reason: '시작 지급 요청',
    actor: { id: 'admin-b', nickname: '운영자B' },
    createdAt: '2026-11-26T02:30:00.000Z',
    path: 'two_admin',
    basis: 'enter_value',
    requestedBy: { id: 'admin-a', nickname: '운영자A' },
    approvalId: REQUEST_ID,
    approvalReason: '확인했습니다',
  },
];

const pages = <T,>(items: T[]) => ({
  pages: [{ items, nextCursor: null }],
  pageParams: [undefined],
});

const draw = (
  items: ReleaseSetting[],
  requests: ReleaseSettingChangeRequest[],
  operatorId: string,
) =>
  renderWithQueries(<AdminReleaseSettings />, [
    [[...ADMIN_RELEASE_SETTINGS_KEY, 'list'], items],
    [[...ADMIN_RELEASE_SETTINGS_KEY, 'requests', 'pending'], pages(requests)],
    [[...ADMIN_RELEASE_SETTINGS_KEY, 'changes'], pages(changes)],
    [['me'], { id: operatorId }],
  ]);

describe('출시 설정 screen, 묶음별 승인 (#331, ADR-0175)', () => {
  it('says each item’s rule, that 승인됨 is two admins’, and which item has a waiting request', () => {
    const html = draw(
      [
        shipped('grant.start_coin', { pendingRequest: request }),
        shipped('market_maker.concentration_top_n'),
      ],
      [request],
      'admin-b',
    );
    expect(byTestId(html, 'release-settings-approved-rule')?.text).toBe(
      copy.adminReleaseSettingsApprovedRule,
    );
    const start = byTestId(html, 'release-setting-grant.start_coin');
    expect(start?.text).toContain(copy.adminReleaseSettingRuleLower);
    expect(start?.text).toContain(copy.adminReleaseSettingPendingBadge);
    const topN = byTestId(html, 'release-setting-market_maker.concentration_top_n');
    expect(topN?.text).toContain(copy.adminReleaseSettingRuleObservation);
    expect(topN?.text).not.toContain(copy.adminReleaseSettingPendingBadge);
  });

  it('offers another admin the approval and 반려, and its requester the retraction', () => {
    const items = [shipped('grant.start_coin', { pendingRequest: request })];
    const other = draw(items, [request], 'admin-b');
    expect(byTestId(other, `release-setting-request-${REQUEST_ID}`)?.text).toContain(
      '시작 지급 요청',
    );
    expect(byTestId(other, 'release-setting-request-approve')?.attributes).not.toHaveProperty(
      'disabled',
    );
    expect(byTestId(other, 'release-setting-request-reject')).toBeDefined();
    expect(byTestId(other, 'release-setting-request-retract')).toBeUndefined();
    const own = draw(items, [request], 'admin-a');
    expect(own).toContain(copy.adminReleaseSettingRequestOwn);
    expect(byTestId(own, 'release-setting-request-retract')).toBeDefined();
    expect(byTestId(own, 'release-setting-request-approve')).toBeUndefined();
  });

  it('flags a stale request and turns its approval off', () => {
    const stale = { ...request, stale: true };
    const html = draw([shipped('grant.start_coin', { pendingRequest: stale })], [stale], 'admin-b');
    expect(byTestId(html, 'release-setting-request-stale')?.text).toBe(
      copy.adminReleaseSettingRequestStale,
    );
    expect(byTestId(html, 'release-setting-request-approve')?.attributes).toHaveProperty(
      'disabled',
    );
    expect(byTestId(html, 'release-setting-request-reject')?.attributes).not.toHaveProperty(
      'disabled',
    );
  });

  it('tells a one-admin change from an approved one in the change log, with who asked and who approved (331-4)', () => {
    const html = draw([shipped('grant.start_coin')], [], 'admin-b');
    expect(testIdsStartingWith(html, 'release-setting-change-path')).toHaveLength(2);
    const one = byTestId(html, `release-setting-change-${changes[0]!.id}`);
    expect(one?.text).toContain(copy.adminReleaseSettingPathOneBadge);
    expect(one?.text).toContain(`${copy.adminReleaseSettingChangeActor} 운영자A`);
    const two = byTestId(html, `release-setting-change-${changes[1]!.id}`);
    expect(two?.text).toContain(copy.adminReleaseSettingPathTwoBadge);
    expect(two?.text).toContain(`${copy.adminReleaseSettingChangeRequester} 운영자A`);
    expect(two?.text).toContain(`${copy.adminReleaseSettingChangeApprover} 운영자B`);
    expect(two?.text).toContain('확인했습니다');
    expect(byTestId(html, 'release-setting-requests-empty')?.text).toBe(
      copy.adminReleaseSettingRequestsEmpty,
    );
  });
});
