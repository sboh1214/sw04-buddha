import { describe, expect, it } from 'vitest';
import { ADMIN_ACTION_TYPES } from './enums.js';
import {
  classifyReleaseSettingChange,
  type ReleaseSettingStageStates,
} from './release-setting-approvals.js';
import {
  RELEASE_SETTING_BASIS_PATH,
  RELEASE_SETTING_CHANGE_APPROVAL_KIND,
  RELEASE_SETTING_CHANGE_BASES,
  RELEASE_SETTING_REFUSALS,
  RELEASE_SETTINGS,
  releaseSettingApprovalRuleSchema,
  releaseSettingChangePayloadSchema,
  releaseSettingChangeRequestPayloadSchema,
  releaseSettingChangeSchema,
  releaseSettingDecisionBodySchema,
  releaseSettingNotAllowedDetailsSchema,
  releaseSettingSchema,
  type ReleaseSettingApprovalRule,
  type ReleaseSettingDefinition,
  type ReleaseSettingStageSlot,
  type ReleaseSettingState,
} from './release-settings.js';

/**
 * 출시 설정 변경의 묶음별 승인 (#331, ADR-0175): the rule every shipped item carries, pinned key by
 * key against the owner answers (331-1…331-7) and ADR-0171 결정 6·10의 1, and the classifier that
 * reads it.
 */

const economic = (
  reduce: 'lower' | 'higher' | null,
  undecided: 'stop' | 'loosen' | 'block' = 'stop',
  stage?: ReleaseSettingStageSlot,
): ReleaseSettingApprovalRule =>
  stage === undefined
    ? { group: 'economic', reduce, undecided }
    : { group: 'economic', reduce, undecided, stage };
const OBSERVATION: ReleaseSettingApprovalRule = { group: 'observation' };
const RETENTION: ReleaseSettingApprovalRule = {
  group: 'retention',
  reduce: null,
  undecided: 'stop',
};

/** docs/SETTINGS.md '변경 승인' and ADR-0175 결정 2, in registry order. */
const EXPECTED: readonly [string, ReleaseSettingApprovalRule][] = [
  ['grant.start_coin', economic('lower')],
  ['grant.regrant_threshold_coin', economic('lower')],
  ['grant.regrant_amount_coin', economic('lower')],
  ['grant.regrant_wait_hours', economic('higher')],
  ['grant.regrant_period_days', economic('higher')],
  ['grant.regrant_period_limit', economic('lower')],
  ['grant.regrant_total_cap_coin', economic('lower')],
  ['market.lead_close_gap', economic(null)],
  ['market.dispute_window', economic(null, 'block')],
  ['order.accepting', { group: 'order_intake' }],
  ['order.rate_limit', economic('lower', 'loosen')],
  ['order.price_protection_ticks', economic(null)],
  ['market_maker.default_budget_coin', economic(null)],
  ['market_maker.default_max_loss_coin', economic(null)],
  ['market_maker.default_b', economic(null)],
  ['market_maker.default_levels', economic(null)],
  ['market_maker.default_quantity', economic(null)],
  ['market_maker.default_safety_ticks', economic(null)],
  ['market_maker.reduce_at_bp', economic('lower', 'stop', 'reduceAtBp')],
  ['market_maker.halt_at_bp', economic('lower', 'stop', 'haltAtBp')],
  ['market_maker.reduce_ratio_bp', economic('lower', 'stop', 'reduceRatioBp')],
  ['market_maker.concentration_top_n', OBSERVATION],
  ['trading_anomaly.pair_min_fills', OBSERVATION],
  ['trading_anomaly.pair_window_seconds', OBSERVATION],
  ['trading_anomaly.pair_lookback_seconds', OBSERVATION],
  ['trading_anomaly.round_trip_min_pairs', OBSERVATION],
  ['trading_anomaly.round_trip_window_seconds', OBSERVATION],
  ['trading_anomaly.round_trip_lookback_seconds', OBSERVATION],
  ['retention.consent_records', RETENTION],
  ['retention.phone_verification_records', RETENTION],
  ['retention.deleted_posts', RETENTION],
  ['retention.moderation_records', RETENTION],
  ['retention.removed_profile_items', RETENTION],
  ['retention.market_proposals', RETENTION],
  ['retention.notifications', RETENTION],
  ['retention.market_visits', RETENTION],
  // 339-2 (ADR-0181): the retention group's rule, as the other periods.
  ['retention.expired_sessions', RETENTION],
];

const UNDECIDED: ReleaseSettingState = { status: 'undecided', value: null };
const state = (status: ReleaseSettingState['status'], value: unknown): ReleaseSettingState => ({
  status,
  value,
});

/** A valid value of `definition` and another one, both from its own schema. */
function twoValues(definition: ReleaseSettingDefinition): [unknown, unknown] {
  switch (definition.key) {
    case 'order.accepting':
      return [true, false];
    case 'market_maker.default_budget_coin':
    case 'market_maker.default_max_loss_coin':
      return ['1000', '2000'];
    case 'market_maker.default_b':
      return [100, 200];
    case 'grant.regrant_threshold_coin':
    case 'grant.regrant_wait_hours':
    case 'market_maker.default_safety_ticks':
    case 'market_maker.reduce_at_bp':
    case 'market_maker.halt_at_bp':
    case 'market_maker.reduce_ratio_bp':
    case 'market.lead_close_gap':
      return [10, 20];
    default:
      return [2, 3];
  }
}
for (const definition of RELEASE_SETTINGS.values()) {
  const [a, b] = twoValues(definition);
  if (!definition.schema.safeParse(a).success || !definition.schema.safeParse(b).success) {
    throw new Error(`test values do not fit ${definition.key}`);
  }
}

/** Valid, so a stage change's combination stays valid unless the case says otherwise. */
const VALID_STAGES: ReleaseSettingStageStates = {
  reduceAtBp: state('test', 10),
  haltAtBp: state('test', 20),
  reduceRatioBp: state('test', 20),
};

function classify(
  definition: ReleaseSettingDefinition,
  before: ReleaseSettingState | undefined,
  after: ReleaseSettingState,
) {
  const { approval } = definition;
  const stages =
    'stage' in approval && approval.stage !== undefined
      ? { ...VALID_STAGES, [approval.stage]: before }
      : undefined;
  return classifyReleaseSettingChange(approval, before, after, stages);
}

describe('the approval rule of every shipped item (#331, ADR-0175)', () => {
  it('pins each of the 37 to the owner answers, in registry order', () => {
    expect([...RELEASE_SETTINGS.values()].map((d) => [d.key, d.approval])).toEqual(EXPECTED);
    for (const { approval } of RELEASE_SETTINGS.values()) {
      expect(releaseSettingApprovalRuleSchema.parse(approval)).toEqual(approval);
    }
  });

  it('counts the groups of ADR-0171 결정 10의 1 and 339-2: economic 20, observation 7, retention 9, order intake 1', () => {
    const count = (group: string) =>
      [...RELEASE_SETTINGS.values()].filter((d) => d.approval.group === group).length;
    expect([
      count('economic'),
      count('observation'),
      count('retention'),
      count('order_intake'),
    ]).toEqual([20, 7, 9, 1]);
  });

  it('gives a one-admin direction to exactly the eleven of 331-1, on integer items only', () => {
    const directed = [...RELEASE_SETTINGS.values()].flatMap((d) =>
      'reduce' in d.approval && d.approval.reduce !== null ? [[d.key, d.approval.reduce]] : [],
    );
    expect(directed).toEqual([
      ['grant.start_coin', 'lower'],
      ['grant.regrant_threshold_coin', 'lower'],
      ['grant.regrant_amount_coin', 'lower'],
      ['grant.regrant_wait_hours', 'higher'],
      ['grant.regrant_period_days', 'higher'],
      ['grant.regrant_period_limit', 'lower'],
      ['grant.regrant_total_cap_coin', 'lower'],
      ['order.rate_limit', 'lower'],
      ['market_maker.reduce_at_bp', 'lower'],
      ['market_maker.halt_at_bp', 'lower'],
      ['market_maker.reduce_ratio_bp', 'lower'],
    ]);
    for (const [key] of directed) {
      expect(RELEASE_SETTINGS.get(key!)!.schema.safeParse(1.5).success).toBe(false);
    }
    const undecided = (kind: string) =>
      [...RELEASE_SETTINGS.values()]
        .filter((d) => 'undecided' in d.approval && d.approval.undecided === kind)
        .map((d) => d.key);
    expect(undecided('loosen')).toEqual(['order.rate_limit']);
    expect(undecided('block')).toEqual(['market.dispute_window']);
    expect(
      [...RELEASE_SETTINGS.values()].flatMap((d) =>
        'stage' in d.approval && d.approval.stage ? [d.approval.stage] : [],
      ),
    ).toEqual(['reduceAtBp', 'haltAtBp', 'reduceRatioBp']);
  });

  it('maps every basis to one path', () => {
    expect(Object.keys(RELEASE_SETTING_BASIS_PATH)).toEqual([...RELEASE_SETTING_CHANGE_BASES]);
    expect(
      RELEASE_SETTING_CHANGE_BASES.filter((b) => RELEASE_SETTING_BASIS_PATH[b] === 'one_admin'),
    ).toEqual([
      'status_only',
      'observation',
      'intake_close',
      'undecided_stop',
      'enter_tightens',
      'stage_stop',
      'reduce',
    ]);
  });
});

describe('classifyReleaseSettingChange, item by item (331-1…331-6)', () => {
  const items = [...RELEASE_SETTINGS.values()];

  it.each(items.map((d) => [d.key, d] as const))('%s', (_key, definition) => {
    const { approval } = definition;
    const [a, b] = twoValues(definition);
    // 1. No change.
    expect(classify(definition, undefined, UNDECIDED)).toEqual({ path: 'unchanged' });
    expect(classify(definition, state('test', a), state('test', a))).toEqual({
      path: 'unchanged',
    });
    // 2. To 승인됨 — from any status, the value kept or not — is two admins (133-23, 331-6).
    for (const from of [undefined, state('test', a), state('proposal', a)]) {
      for (const value of [a, b]) {
        expect(classify(definition, from, state('approved', value))).toEqual({
          path: 'two_admin',
          basis: 'approved_target',
        });
      }
    }
    expect(classify(definition, state('approved', a), state('approved', b))).toMatchObject({
      path: 'two_admin',
    });
    // 3. The value kept, the status down from 승인됨 or between 설계 제안 and 시험값: one admin.
    for (const [from, to] of [
      ['approved', 'test'],
      ['approved', 'proposal'],
      ['test', 'proposal'],
      ['proposal', 'test'],
    ] as const) {
      expect(classify(definition, state(from, a), state(to, a))).toEqual({
        path: 'one_admin',
        basis: 'status_only',
      });
    }

    const toUndecided = classify(definition, state('test', a), UNDECIDED);
    const fromUndecided = classify(definition, undefined, state('test', a));
    const raise = classify(definition, state('test', a), state('test', b));
    const lower = classify(definition, state('test', b), state('test', a));
    if (approval.group === 'observation') {
      for (const result of [toUndecided, fromUndecided, raise, lower]) {
        expect(result).toEqual({ path: 'one_admin', basis: 'observation' });
      }
      return;
    }
    if (approval.group === 'order_intake') {
      // a = true, b = false.
      expect(toUndecided).toEqual({ path: 'one_admin', basis: 'intake_close' });
      expect(fromUndecided).toEqual({ path: 'two_admin', basis: 'intake_open' });
      expect(raise).toEqual({ path: 'one_admin', basis: 'intake_close' });
      expect(lower).toEqual({ path: 'two_admin', basis: 'intake_open' });
      return;
    }
    // 4. To 미정 and from it, by the effect (331-5).
    expect(toUndecided).toEqual(
      approval.undecided === 'stop'
        ? { path: 'one_admin', basis: 'undecided_stop' }
        : approval.undecided === 'loosen'
          ? { path: 'two_admin', basis: 'undecided_loosens' }
          : { path: 'two_admin', basis: 'undecided_blocks' },
    );
    expect(fromUndecided).toEqual(
      approval.undecided === 'loosen'
        ? { path: 'one_admin', basis: 'enter_tightens' }
        : { path: 'two_admin', basis: 'enter_value' },
    );
    // 5. Value to value: one admin only in the item's direction (331-1), never for retention.
    if (approval.reduce === null) {
      expect(raise).toEqual({ path: 'two_admin', basis: 'no_direction' });
      expect(lower).toEqual({ path: 'two_admin', basis: 'no_direction' });
    } else if (approval.reduce === 'lower') {
      expect(lower).toEqual({ path: 'one_admin', basis: 'reduce' });
      expect(raise).toEqual({ path: 'two_admin', basis: 'increase' });
    } else {
      expect(raise).toEqual({ path: 'one_admin', basis: 'reduce' });
      expect(lower).toEqual({ path: 'two_admin', basis: 'increase' });
    }
  });
});

describe('classifyReleaseSettingChange, the special cases', () => {
  const get = (key: string) => RELEASE_SETTINGS.get(key)!;
  const rule = (key: string) => get(key).approval;

  it('makes a mixed change two admins when either part is (I5)', () => {
    const start = rule('grant.start_coin');
    // Lowered, but to 승인됨.
    expect(
      classifyReleaseSettingChange(start, state('test', 1000), state('approved', 900)),
    ).toEqual({ path: 'two_admin', basis: 'approved_target' });
    // Lowered and down from 승인됨: both parts one admin's.
    expect(
      classifyReleaseSettingChange(start, state('approved', 1000), state('test', 900)),
    ).toEqual({ path: 'one_admin', basis: 'reduce' });
    // Raised while down from 승인됨.
    expect(
      classifyReleaseSettingChange(start, state('approved', 1000), state('test', 1100)),
    ).toEqual({ path: 'two_admin', basis: 'increase' });
    // A retention period shortened or lengthened is two admins either way (331-3).
    for (const value of [30, 3650]) {
      expect(
        classifyReleaseSettingChange(
          rule('retention.notifications'),
          state('approved', 365),
          state('test', value),
        ),
      ).toEqual({ path: 'two_admin', basis: 'no_direction' });
    }
  });

  it('opens and closes order intake as ADR-0171 결정 10의 1 and I-b say', () => {
    const intake = rule('order.accepting');
    const cases: [ReleaseSettingState | undefined, ReleaseSettingState, string, string][] = [
      [state('test', true), state('test', false), 'one_admin', 'intake_close'],
      [state('test', false), state('test', true), 'two_admin', 'intake_open'],
      [undefined, state('test', true), 'two_admin', 'intake_open'],
      [undefined, state('test', false), 'one_admin', 'intake_close'],
      [state('test', true), UNDECIDED, 'one_admin', 'intake_close'],
      [state('test', false), UNDECIDED, 'one_admin', 'intake_close'],
      [state('test', true), state('approved', true), 'two_admin', 'approved_target'],
      [state('approved', true), state('test', false), 'one_admin', 'intake_close'],
    ];
    for (const [before, after, path, basis] of cases) {
      expect(classifyReleaseSettingChange(intake, before, after)).toEqual({ path, basis });
    }
  });

  it('lets one admin stop every bot through the risk stages, and only two restart them (331-2, I-a)', () => {
    const reduce = rule('market_maker.reduce_at_bp');
    const halt = rule('market_maker.halt_at_bp');
    const ratio = rule('market_maker.reduce_ratio_bp');
    const stages = (reduceAt: unknown, haltAt: unknown, ratioBp: unknown) => ({
      reduceAtBp: reduceAt === null ? undefined : state('test', reduceAt),
      haltAtBp: haltAt === null ? undefined : state('test', haltAt),
      reduceRatioBp: ratioBp === null ? undefined : state('test', ratioBp),
    });
    // Raising 축소 시작 above 중단 시작 is a raise, but it stops every bot: one admin.
    expect(
      classifyReleaseSettingChange(
        reduce,
        state('test', 7000),
        state('test', 9500),
        stages(7000, 9000, 5000),
      ),
    ).toEqual({ path: 'one_admin', basis: 'stage_stop' });
    // Lowering 중단 시작 below 축소 시작: a lowering, and a stop.
    expect(
      classifyReleaseSettingChange(
        halt,
        state('test', 9000),
        state('test', 6000),
        stages(7000, 9000, 5000),
      ),
    ).toEqual({ path: 'one_admin', basis: 'stage_stop' });
    // Lowering 축소 시작 out of an invalid combination restarts every bot: two admins (I-a).
    expect(
      classifyReleaseSettingChange(
        reduce,
        state('test', 9500),
        state('test', 7000),
        stages(9500, 9000, 5000),
      ),
    ).toEqual({ path: 'two_admin', basis: 'stage_resume' });
    // With another stage 미정 the bots stay stopped: the change moves nothing, so the direction
    // rule decides — a lowering is one admin's, a raise two admins' (331-1), and a later restart
    // carries no raise another admin did not approve.
    expect(
      classifyReleaseSettingChange(
        ratio,
        state('test', 5000),
        state('test', 4000),
        stages(7000, null, 5000),
      ),
    ).toEqual({ path: 'one_admin', basis: 'reduce' });
    expect(
      classifyReleaseSettingChange(
        halt,
        state('test', 8000),
        state('test', 10000),
        stages(5000, 8000, null),
      ),
    ).toEqual({ path: 'two_admin', basis: 'increase' });
    // Inside an invalid combination (축소 시작 above 중단 시작) likewise.
    expect(
      classifyReleaseSettingChange(
        ratio,
        state('test', 2000),
        state('test', 5000),
        stages(5000, 1000, 2000),
      ),
    ).toEqual({ path: 'two_admin', basis: 'increase' });
    expect(
      classifyReleaseSettingChange(
        halt,
        state('test', 1000),
        state('test', 500),
        stages(5000, 1000, 2000),
      ),
    ).toEqual({ path: 'one_admin', basis: 'reduce' });
    // Fixing the invalid combination restarts every bot: two admins.
    expect(
      classifyReleaseSettingChange(
        halt,
        state('test', 1000),
        state('test', 8000),
        stages(5000, 1000, 2000),
      ),
    ).toEqual({ path: 'two_admin', basis: 'stage_resume' });
    // Inside a valid combination: the direction rule.
    expect(
      classifyReleaseSettingChange(
        ratio,
        state('test', 5000),
        state('test', 2500),
        stages(7000, 9000, 5000),
      ),
    ).toEqual({ path: 'one_admin', basis: 'reduce' });
    expect(
      classifyReleaseSettingChange(
        halt,
        state('test', 9000),
        state('test', 9500),
        stages(7000, 9000, 5000),
      ),
    ).toEqual({ path: 'two_admin', basis: 'increase' });
    // 미정 to a value is opening (331-5), 미정 the stop.
    expect(
      classifyReleaseSettingChange(reduce, undefined, state('test', 0), stages(null, 0, 0)),
    ).toEqual({ path: 'two_admin', basis: 'enter_value' });
    expect(
      classifyReleaseSettingChange(reduce, state('test', 0), UNDECIDED, stages(0, 0, 0)),
    ).toEqual({ path: 'one_admin', basis: 'undecided_stop' });
    // The three are read together: a stage's value change without them is a programming error.
    expect(() => classifyReleaseSettingChange(reduce, state('test', 1), state('test', 2))).toThrow(
      /three stages/,
    );
  });

  it('keeps the dispute window two admins both ways, 미정 included (D:22448, 331-5)', () => {
    const dispute = rule('market.dispute_window');
    expect(classifyReleaseSettingChange(dispute, state('approved', 1440), UNDECIDED)).toEqual({
      path: 'two_admin',
      basis: 'undecided_blocks',
    });
    expect(classifyReleaseSettingChange(dispute, state('test', 1440), state('test', 1))).toEqual({
      path: 'two_admin',
      basis: 'no_direction',
    });
  });

  it('tightens the order rate limit from 미정 with one admin and lifts it only with two (331-5)', () => {
    const limit = rule('order.rate_limit');
    expect(classifyReleaseSettingChange(limit, undefined, state('test', 20))).toEqual({
      path: 'one_admin',
      basis: 'enter_tightens',
    });
    expect(classifyReleaseSettingChange(limit, state('test', 20), UNDECIDED)).toEqual({
      path: 'two_admin',
      basis: 'undecided_loosens',
    });
  });
});

describe('the change-request contract (#331)', () => {
  it('names its approval kind, refusals and admin action types', () => {
    expect(RELEASE_SETTING_CHANGE_APPROVAL_KIND).toBe('release_setting_change');
    expect(RELEASE_SETTING_REFUSALS).toEqual(['request_pending', 'stale', 'requester_ineligible']);
    expect(releaseSettingNotAllowedDetailsSchema.parse({ reason: 'stale' })).toEqual({
      reason: 'stale',
    });
    expect(ADMIN_ACTION_TYPES.slice(-3)).toEqual([
      'release_setting_change_request',
      'release_setting_change_reject',
      'release_setting_change_retract',
    ]);
    for (const type of ADMIN_ACTION_TYPES.slice(-3)) expect(type.length).toBeLessThanOrEqual(40);
  });

  it('reads a change record written before #331, and one with its path and approval', () => {
    const old = {
      key: 'grant.start_coin',
      before: UNDECIDED,
      after: state('test', 1000),
      reason: '시험',
    };
    expect(releaseSettingChangePayloadSchema.parse(old)).toEqual(old);
    const approved = {
      ...old,
      path: 'two_admin',
      basis: 'enter_value',
      approval: {
        id: '00000000-0000-4000-8000-000000000001',
        requestedBy: 'admin-a',
        requestedAt: '2026-11-26T00:00:00.000Z',
        decisionReason: '확인',
      },
    };
    expect(releaseSettingChangePayloadSchema.parse(approved)).toEqual(approved);
    expect(releaseSettingChangePayloadSchema.safeParse({ ...old, path: 'three' }).success).toBe(
      false,
    );
    expect(
      releaseSettingChangeRequestPayloadSchema.safeParse({ ...old, basis: 'enter_value' }).success,
    ).toBe(true);
    expect(releaseSettingChangeRequestPayloadSchema.safeParse(old).success).toBe(false);
  });

  it('carries the rule and the waiting request on an item, and the path on a record', () => {
    expect(Object.keys(releaseSettingSchema.shape)).toEqual(
      expect.arrayContaining(['approval', 'pendingRequest']),
    );
    expect(Object.keys(releaseSettingChangeSchema.shape)).toEqual(
      expect.arrayContaining(['path', 'basis', 'requestedBy', 'approvalId', 'approvalReason']),
    );
    expect(
      releaseSettingDecisionBodySchema.safeParse({ reason: ' ', expectedAccountId: 'a' }).success,
    ).toBe(false);
    expect(
      releaseSettingDecisionBodySchema.safeParse({ reason: '확인', expectedAccountId: 'a' })
        .success,
    ).toBe(true);
  });
});
