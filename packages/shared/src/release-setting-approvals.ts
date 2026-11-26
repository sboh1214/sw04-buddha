import { marketMakerStageSettings } from './market-maker-stage-settings.js';
import {
  isReleaseSettingUnchanged,
  RELEASE_SETTING_BASIS_PATH,
  sameReleaseSettingJson,
  type ReleaseSettingApprovalRule,
  type ReleaseSettingChangeBasis,
  type ReleaseSettingChangePath,
  type ReleaseSettingReading,
  type ReleaseSettingStageSlot,
  type ReleaseSettingState,
} from './release-settings.js';

/**
 * 출시 설정 변경의 묶음별 승인 (#331, ADR-0175; ADR-0171 결정 6·10의 1, owner answers 331-1…331-7):
 * which of an item's changes one admin makes at once and which wait for another admin's approval.
 * The server decides it under the key's lock from the row it read (ReleaseSettingsService); the
 * admin screen calls the same function on the list to preview the path before saving.
 *
 * One change is one item's status and value. When either part needs two admins the whole change
 * does (I5): the checks below run in this order and the first that applies wins.
 * 1. No change: `unchanged` (refused, as before #331).
 * 2. The change ends at 승인됨: two admins, every item (133-23; 331-6 — a one-admin change is never
 *    승인됨).
 * 3. The value stays and only the status moves (away from 승인됨, or between 설계 제안 and 시험값):
 *    one admin (331-5 '값은 그대로 승인됨에서 내리기는 1인'; I-c — no runtime effect otherwise).
 * 4. The item's rule (`ReleaseSettingApprovalRule`): observation one admin; order intake closing
 *    one, opening two; then 미정 by its effect (331-5), the risk stages' combination when the change
 *    moves it between valid and 미정·무효 (331-2, I-a) and the direction (331-1).
 */

/** The path a change takes and why, or `unchanged` for a change to the current state. */
export type ReleaseSettingChangeClassification =
  { path: 'unchanged' } | { path: ReleaseSettingChangePath; basis: ReleaseSettingChangeBasis };

/** The three risk stages' current states (#129), by slot: undefined for no row (미정). */
export type ReleaseSettingStageStates = Readonly<
  Record<ReleaseSettingStageSlot, ReleaseSettingState | undefined>
>;

const UNDECIDED: ReleaseSettingState = { status: 'undecided', value: null };

function classified(basis: ReleaseSettingChangeBasis): ReleaseSettingChangeClassification {
  return { path: RELEASE_SETTING_BASIS_PATH[basis], basis };
}

/** A state as the worker would read it, for the stages' combination check. */
function reading(state: ReleaseSettingState | undefined): ReleaseSettingReading<number> {
  if (state === undefined || state.status === 'undecided' || typeof state.value !== 'number') {
    return { key: '', status: 'undecided', value: null };
  }
  return { key: '', status: state.status, value: state.value };
}

/** Whether the three stages run the bots (`marketMakerStageSettings`, as the worker reads them). */
function stagesReady(stages: ReleaseSettingStageStates): boolean {
  return (
    marketMakerStageSettings({
      reduceAtBp: reading(stages.reduceAtBp),
      haltAtBp: reading(stages.haltAtBp),
      reduceRatioBp: reading(stages.reduceRatioBp),
    }).kind === 'ready'
  );
}

/**
 * The path of changing an item whose rule is `rule` from `before` (undefined: no row, 미정) to
 * `after`. `stages`: the three risk stages' current states, required when `rule.stage` is set
 * (the combinations before and after the change put `before` and `after` in that slot) and
 * ignored otherwise.
 */
export function classifyReleaseSettingChange(
  rule: ReleaseSettingApprovalRule,
  before: ReleaseSettingState | undefined,
  after: ReleaseSettingState,
  stages?: ReleaseSettingStageStates,
): ReleaseSettingChangeClassification {
  if (isReleaseSettingUnchanged(before, after)) return { path: 'unchanged' };
  const from = before ?? UNDECIDED;
  if (after.status === 'approved') return classified('approved_target');
  if (
    from.status !== 'undecided' &&
    after.status !== 'undecided' &&
    sameReleaseSettingJson(from.value, after.value)
  ) {
    return classified('status_only');
  }
  if (rule.group === 'observation') return classified('observation');
  if (rule.group === 'order_intake') {
    return classified(
      after.status !== 'undecided' && after.value === true ? 'intake_open' : 'intake_close',
    );
  }
  if (after.status === 'undecided') {
    return classified(
      rule.undecided === 'stop'
        ? 'undecided_stop'
        : rule.undecided === 'loosen'
          ? 'undecided_loosens'
          : 'undecided_blocks',
    );
  }
  if (from.status === 'undecided') {
    return classified(rule.undecided === 'loosen' ? 'enter_tightens' : 'enter_value');
  }
  if (rule.stage !== undefined) {
    if (stages === undefined) {
      throw new Error(`a risk stage change (${rule.stage}) is classified with the three stages`);
    }
    // Only a change that moves the bots stops or restarts them (331-2, I-a): from running to
    // stopped is one admin's stop, from stopped to running two admins' restart. A change that
    // leaves them running, or leaves them stopped, takes the direction rule (331-1) — a raise
    // while they are stopped is two admins', so a later restart carries no unapproved raise.
    const readyBefore = stagesReady({ ...stages, [rule.stage]: from });
    const readyAfter = stagesReady({ ...stages, [rule.stage]: after });
    if (readyBefore && !readyAfter) return classified('stage_stop');
    if (!readyBefore && readyAfter) return classified('stage_resume');
  }
  if (rule.reduce === null) return classified('no_direction');
  if (typeof from.value !== 'number' || typeof after.value !== 'number') {
    return classified('increase');
  }
  const reduces = rule.reduce === 'lower' ? after.value < from.value : after.value > from.value;
  return classified(reduces ? 'reduce' : 'increase');
}
