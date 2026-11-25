import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { SIGNUP_ALLOWLIST_KEY } from '@/hooks/use-admin-signup-allowlist';
import { type SignupAllowlist } from '@/lib/api';
import { byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { AdminSignupAllowlist } from './admin-signup-allowlist';

const ENTRY_A = '11111111-1111-4111-8111-111111111111';
const ENTRY_B = '22222222-2222-4222-8222-222222222222';
const listed: SignupAllowlist = {
  entries: [
    { id: ENTRY_A, createdAt: '2026-11-26T01:00:00.000Z' },
    { id: ENTRY_B, createdAt: '2026-11-26T00:00:00.000Z' },
  ],
  summary: { entryCount: 2, outsideVerifiedMembers: 0, outsideVerifiedAdmins: 2 },
  pendingClear: null,
};
const pending = {
  id: '33333333-3333-4333-8333-333333333333',
  requestedBy: { id: 'admin-a', nickname: '운영자A' },
  reason: '공개 출시',
  requestedAt: '2026-11-26T02:00:00.000Z',
  status: 'pending' as const,
  decidedBy: null,
  decisionReason: null,
  decidedAt: null,
  retractedAt: null,
};

const draw = (allowlist: SignupAllowlist, operatorId?: string) =>
  renderWithQueries(<AdminSignupAllowlist />, [
    [SIGNUP_ALLOWLIST_KEY, allowlist],
    ...(operatorId === undefined ? [] : [[['me'], { id: operatorId }] as const]),
  ]);

describe('가입 허용 목록 screen (#330, ADR-0174)', () => {
  it('says whether the list applies, and the counts #149 checks (330-3, 330-9)', () => {
    const html = draw(listed, 'admin-a');
    expect(byTestId(html, 'signup-allowlist-status')?.text).toBe(copy.adminSignupAllowlistOn);
    expect(byTestId(html, 'signup-allowlist-count')?.text).toBe('2');
    expect(byTestId(html, 'signup-allowlist-outside-members')?.text).toContain('0');
    expect(byTestId(html, 'signup-allowlist-outside-admins')?.text).toContain('2');
    const empty = draw(
      { entries: [], summary: { ...listed.summary, entryCount: 0 }, pendingClear: null },
      'admin-a',
    );
    expect(byTestId(empty, 'signup-allowlist-status')?.text).toBe(copy.adminSignupAllowlistOff);
    expect(byTestId(empty, 'signup-allowlist-entries-empty')).toBeDefined();
    // Nothing to clear: the request waits for an entry.
    expect(byTestId(empty, 'signup-allowlist-clear-submit')?.attributes).toHaveProperty('disabled');
  });

  it('lists entries as ids and times, never a number (330-8)', () => {
    const html = draw(listed, 'admin-a');
    expect(testIdsStartingWith(html, 'signup-allowlist-entry')).toHaveLength(2);
    expect(html).toContain(ENTRY_A);
    expect(html).toContain(ENTRY_B);
    expect(html).not.toMatch(/01[016789]\d{7,8}/);
  });

  it('waits for the admin on screen before any write', () => {
    const html = draw(listed);
    for (const id of [
      'signup-allowlist-add-submit',
      'signup-allowlist-remove-submit',
      'signup-allowlist-clear-submit',
    ]) {
      expect(byTestId(html, id)?.attributes, id).toHaveProperty('disabled');
    }
  });

  it('offers the waiting clear to another admin to decide, and to its requester to retract (330-2)', () => {
    const withRequest = { ...listed, pendingClear: pending };
    const other = draw(withRequest, 'admin-b');
    expect(byTestId(other, 'signup-allowlist-pending')?.text).toContain('공개 출시');
    expect(byTestId(other, 'signup-allowlist-approve')?.attributes).not.toHaveProperty('disabled');
    expect(byTestId(other, 'signup-allowlist-reject')).toBeDefined();
    expect(byTestId(other, 'signup-allowlist-retract')).toBeUndefined();
    expect(byTestId(other, 'signup-allowlist-clear-submit')).toBeUndefined();
    const own = draw(withRequest, 'admin-a');
    expect(own).toContain(copy.adminSignupAllowlistClearOwn);
    expect(byTestId(own, 'signup-allowlist-retract')).toBeDefined();
    expect(byTestId(own, 'signup-allowlist-approve')).toBeUndefined();
  });
});
