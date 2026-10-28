import { describe, expect, it } from 'vitest';
import { addStepKeeper, keepSettingsDraftsForStep } from './use-settings-step';

/**
 * MY 설정's cards keep what they hold as the page goes to the onboarding step (owner decision
 * 2026-10-22 answer 3, ADR-0078 7-25): every card mounted then — whichever card's save sent the
 * page — and none that has gone. The cards' own rules of what to keep are lib/profile-drafts.ts's
 * (profile-drafts.test.ts); this is the page's part, run plain under `environment: 'node'`.
 */
describe('keepSettingsDraftsForStep', () => {
  it('asks every card mounted to keep what it holds, once each, and no card that has gone', () => {
    const kept: string[] = [];
    const removeBio = addStepKeeper(() => kept.push('bio'));
    const removeInterests = addStepKeeper(() => kept.push('interests'));
    keepSettingsDraftsForStep();
    expect(kept.sort()).toEqual(['bio', 'interests']);

    removeBio();
    kept.length = 0;
    keepSettingsDraftsForStep();
    expect(kept).toEqual(['interests']);

    removeInterests();
    kept.length = 0;
    keepSettingsDraftsForStep();
    expect(kept).toEqual([]);
  });

  it('keeps a card registered twice (React’s development remount) apart: removing one leaves the other', () => {
    const kept: string[] = [];
    const first = addStepKeeper(() => kept.push('bio'));
    const second = addStepKeeper(() => kept.push('bio'));
    first();
    keepSettingsDraftsForStep();
    expect(kept).toEqual(['bio']);
    second();
  });
});
