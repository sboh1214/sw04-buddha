import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { ADMIN_ACTION_TYPES, RELEASE_SETTING_STATUSES } from './enums.js';
import {
  DISPUTE_WINDOW_MAX_MINUTES,
  DISPUTE_WINDOW_MIN_MINUTES,
  disputeDeadlineOf,
} from './market-judgement.js';
import {
  DISPUTE_WINDOW_SETTING,
  JSONB_LONE_SURROGATE_MESSAGE,
  JSONB_NUL_MESSAGE,
  LEAD_CLOSE_GAP_SETTING,
  MARKET_LIQUIDITY_DEFAULT_SETTINGS,
  MARKET_PROPOSALS_RETENTION_SETTING,
  MARKET_MAKER_CONCENTRATION_TOP_N_SETTING,
  ORDER_ACCEPTING_SETTING,
  ORDER_RATE_LIMIT_SETTING,
  PRICE_PROTECTION_TICKS_SETTING,
  RELEASE_SETTINGS,
  RELEASE_SETTING_STATUS_LABELS,
  RETENTION_PERIOD_SETTINGS,
  START_COIN_SETTING,
  defineReleaseSetting,
  defineReleaseSettings,
  isOrderIntakeOpen,
  isReleaseSettingUnchanged,
  jsonbValueIssues,
  parseReleaseSettingChange,
  readReleaseSetting,
  releaseSettingChangeBodySchema,
  releaseSettingChangeListQuerySchema,
  releaseSettingKeySchema,
  releaseSettingValueJsonSchema,
  type ReleaseSettingValue,
} from './release-settings.js';
import { LEAD_CLOSE_GAP_MAX_MINUTES, timeRuleViolations } from './market-times.js';
import { RETENTION_PERIODS, RETENTION_PERIOD_MAX_DAYS } from './retention.js';
import { START_GRANT_MAX_COIN } from './start-grant.js';

/** U+0000: PostgreSQL's jsonb cannot hold it. */
const NUL = String.fromCharCode(0);

const hours = defineReleaseSetting({
  key: 'test.period_hours',
  label: '시험 기간',
  unit: '시간',
  description: '시험용 항목',
  schema: z.number().int().min(1).max(720),
});

const window = defineReleaseSetting({
  key: 'test.window',
  label: '시험 구간',
  unit: null,
  description: '시험용 항목(객체 값)',
  schema: z.object({ from: z.number().int(), to: z.number().int() }).strict(),
});

describe('release settings registry', () => {
  it('ships the items the issues that use them registered: the start grant (#70), the lead-close gap (#22), the dispute window (#152), the order intake, rate limit and price-protection width (#119) and the retention periods (#184, #77)', () => {
    expect([...RELEASE_SETTINGS.keys()]).toEqual([
      'grant.start_coin',
      // 선행 마감 최소 간격 (#22, ADR-0093 #172 item 13): the operating values come first.
      'market.lead_close_gap',
      // 이의 기간 (#152, ADR-0093 #173 item 5): one value for every market.
      'market.dispute_window',
      // 주문 접수·주문 속도 제한·가격 보호 폭 표준값 (#119, ADR-0107 결정 1 #177 2·9항, 결정 3).
      'order.accepting',
      'order.rate_limit',
      'order.price_protection_ticks',
      'market_maker.default_budget_coin',
      'market_maker.default_max_loss_coin',
      'market_maker.default_b',
      'market_maker.default_levels',
      'market_maker.default_quantity',
      'market_maker.default_safety_ticks',
      'market_maker.reduce_at_bp',
      'market_maker.halt_at_bp',
      'market_maker.reduce_ratio_bp',
      'market_maker.concentration_top_n',
      'retention.consent_records',
      'retention.phone_verification_records',
      'retention.deleted_posts',
      'retention.moderation_records',
      'retention.removed_profile_items',
      // 시장 제안 기록 보존기간 (#77, ADR-0087's owner decision 2026-10-24 13).
      'retention.market_proposals',
    ]);
    expect(RELEASE_SETTINGS.get('grant.start_coin')).toBe(START_COIN_SETTING);
    expect(RELEASE_SETTINGS.get('market.lead_close_gap')).toBe(LEAD_CLOSE_GAP_SETTING);
    expect(RELEASE_SETTINGS.get('market.dispute_window')).toBe(DISPUTE_WINDOW_SETTING);
    expect(RELEASE_SETTINGS.get('order.accepting')).toBe(ORDER_ACCEPTING_SETTING);
    expect(RELEASE_SETTINGS.get('order.rate_limit')).toBe(ORDER_RATE_LIMIT_SETTING);
    expect(RELEASE_SETTINGS.get('market_maker.concentration_top_n')).toBe(
      MARKET_MAKER_CONCENTRATION_TOP_N_SETTING,
    );
    expect(RELEASE_SETTINGS.get('order.price_protection_ticks')).toBe(
      PRICE_PROTECTION_TICKS_SETTING,
    );
    // The worker reads each period through the very object the registry holds.
    for (const definition of Object.values(RETENTION_PERIOD_SETTINGS)) {
      expect(RELEASE_SETTINGS.get(definition.key)).toBe(definition);
    }
  });

  it('starts all six liquidity suggestions undecided and validates explicit values without numeric Coin rounding', () => {
    const defs = MARKET_LIQUIDITY_DEFAULT_SETTINGS;
    for (const definition of Object.values(defs)) {
      expect(
        readReleaseSetting<ReleaseSettingValue>(RELEASE_SETTINGS, definition, undefined),
      ).toEqual({ key: definition.key, status: 'undecided', value: null });
    }
    for (const definition of [defs.budgetCoin, defs.maxLossCoin]) {
      expect(definition.schema.parse('999999999999999')).toBe('999999999999999');
      for (const value of [0, 100, '0', '-1', '1.5', '1e3', '9223372036854775808']) {
        expect(definition.schema.safeParse(value).success).toBe(false);
      }
      for (const status of ['proposal', 'test', 'approved'] as const) {
        expect(
          readReleaseSetting(RELEASE_SETTINGS, definition, { status, value: '100' }),
        ).toMatchObject({ status, value: '100' });
      }
    }
    for (const value of [1e-100, 0.5, 1e100]) expect(defs.b.schema.parse(value)).toBe(value);
    for (const value of [0, -1, Number.MIN_VALUE, Number.MAX_VALUE, Infinity])
      expect(defs.b.schema.safeParse(value).success).toBe(false);
    expect(defs.safetyTicks.schema.parse(0)).toBe(0);
    expect(defs.levels.schema.safeParse(0).success).toBe(false);
    expect(defs.quantity.schema.parse(1_000_000)).toBe(1_000_000);
    expect(defs.quantity.schema.safeParse(1_000_001).success).toBe(false);
    for (const definition of [defs.levels, defs.quantity, defs.safetyTicks]) {
      for (const value of [-1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1])
        expect(definition.schema.safeParse(value).success).toBe(false);
    }
  });

  it('takes a retention period in whole days, 1 to RETENTION_PERIOD_MAX_DAYS (#184)', () => {
    expect(Object.keys(RETENTION_PERIOD_SETTINGS)).toEqual([...RETENTION_PERIODS]);
    for (const definition of Object.values(RETENTION_PERIOD_SETTINGS)) {
      const accepts = (value: unknown) => definition.schema.safeParse(value).success;
      expect(definition.unit, definition.key).toBe('일');
      expect(definition.label, definition.key).toMatch(/보존기간$/);
      // Every description says only an approved value deletes (ADR-0069 decision 7).
      expect(definition.description, definition.key).toContain('승인됨일 때만 지우고');
      expect(accepts(1)).toBe(true);
      expect(accepts(365)).toBe(true);
      expect(accepts(RETENTION_PERIOD_MAX_DAYS)).toBe(true);
      for (const value of [0, -1, 1.5, '30', RETENTION_PERIOD_MAX_DAYS + 1]) {
        expect(accepts(value), `${definition.key} ${String(value)}`).toBe(false);
      }
      expect(
        readReleaseSetting(RELEASE_SETTINGS, definition, { status: 'approved', value: 30 }),
      ).toEqual({
        key: definition.key,
        status: 'approved',
        value: 30,
      });
    }
  });

  it('names, where the owner approves the 신고·제재 period, every action the worker deletes under it (#184)', () => {
    // The worker's moderation_actions step takes every type of action on a withdrawn member, the
    // profile actions among them; the screen the owner approves the period on lists them all.
    const { description } = RETENTION_PERIOD_SETTINGS.moderation_records;
    for (const action of [
      '경고',
      '숨김',
      '닉네임 강제 변경',
      '소개 비우기',
      '프로필 이미지 삭제',
      '작성 제한',
      '계정 제한',
    ]) {
      expect(description, action).toContain(action);
    }
  });

  it('tells the owner, where the periods are approved, what the answers of 2026-10-24 and 2026-10-24 (2차) changed (#184)', () => {
    const { moderation_records: moderation, deleted_posts: deleted } = RETENTION_PERIOD_SETTINGS;
    // 1: the reports a withdrawn member received go too; 3: a hidden item is emptied, kept hidden.
    expect(moderation.description).toContain('탈퇴한 회원이 받은 신고와 조치');
    expect(moderation.description).toContain('숨긴 채로 남은 것은 지운 원문처럼 내용을 비우고');
    // 12: what a pending account restriction request cites waits for its decision — a condition of
    // its own beside a pending report's (4), not a kind of request.
    expect(deleted.description).toContain('결정을 기다리는 계정 제한 요청이 근거로 든');
    expect(deleted.description).toContain('처리 중인 신고가 있는 글·댓글과 결정을 기다리는');
    expect(deleted.description).toContain('신고가 처리되거나 요청이 결정·철회될 때까지');
    expect(deleted.description).not.toContain('신고가 있거나 결정을 기다리는');
    // (2차) 2: the hidden item's edit history goes with its content, under the 신고·제재 period —
    // and the edit history's own item says so too, whatever its own status and value: the rule at
    // its end (only an approved value deletes) does not hold it back.
    expect(moderation.description).toContain(
      '그 수정 이력(이전 내용과 그것만 쓰던 이미지)과 숨김 조치도 함께 지운다',
    );
    expect(deleted.description).toContain(
      "숨긴 채로 남은 것의 수정 이력은 이 항목의 상태·값과 상관없이 그 내용을 비울 때('신고·제재 기록 보존기간') 함께 지운다",
    );
    expect(deleted.description).not.toContain('이 기간 전이라도');
    // 13: #187's repeated-link review list, from the later of the flag and its '확인함' mark —
    // whoever wrote the items — while the mark's record keeps the link.
    expect(moderation.description).toContain(
      "반복 링크 검토 목록의 항목은 작성자의 탈퇴와 상관없이 탐지된 시각과 '확인함'으로 표시된 시각 가운데 늦은 쪽부터",
    );
    expect(moderation.description).toContain("('확인함' 운영 기록과 그 주소는 남는다)");
    // #175 (ADR-0087 (6), ADR-0069 #57-18): a withdrawn account's 판정 이의, once decided or
    // retracted, emptied in place from the later of the two instants; a pending one is kept, and
    // an accepted one awaiting its correction counts as under review (the worker keeps it).
    // #176 (ADR-0105): one closed by a correction (정정으로 종결) too, from its closing.
    expect(moderation.description).toContain(
      '탈퇴한 계정이 낸 판정 이의(#175)는 기각·수용되거나 철회된 것과 정정으로 종결된 것(#176)의 근거 링크와 사유를',
    );
    expect(moderation.description).toContain('탈퇴 시각과 처리·철회·종결 시각 가운데 늦은 쪽부터');
    expect(moderation.description).toContain('(이의 건수와 처리 상태는 남는다)');
    expect(moderation.description).toContain(
      '검토 중이거나 수용해 정정을 기다리는 판정 이의는 지우지 않는다',
    );
    // 14: a kind that failed is recorded as such.
    for (const definition of Object.values(RETENTION_PERIOD_SETTINGS)) {
      expect(definition.description, definition.key).toContain(
        '오류로 끝내지 못한 종류는 실패로 남긴다',
      );
    }
  });

  it('names the market proposals’ period as the owner set it: a withdrawn account’s, once processed (#77, ADR-0087’s owner decision 2026-10-24 13)', () => {
    const definition = RETENTION_PERIOD_SETTINGS.market_proposals;
    expect(definition).toBe(MARKET_PROPOSALS_RETENTION_SETTING);
    expect(definition).toMatchObject({
      key: 'retention.market_proposals',
      label: '시장 제안 기록 보존기간',
      unit: '일',
    });
    // From the later of the withdrawal and the processing's end (ADR-0069 decision 7), never while
    // the operators have it to review, and never a live account's.
    expect(definition.description).toContain('탈퇴한 계정의 시장 제안');
    expect(definition.description).toContain('탈퇴 시각과 처리가 끝난 시각');
    expect(definition.description).toContain('늦은 쪽부터');
    expect(definition.description).toContain('처리를 기다리는 제안(접수·검토)');
    expect(definition.description).toContain('탈퇴하지 않은 계정의 제안은 지우지 않는다');
  });

  it('takes a whole Coin amount for the start grant, up to START_GRANT_MAX_COIN (#70)', () => {
    const accepts = (value: unknown) => START_COIN_SETTING.schema.safeParse(value).success;
    expect(START_COIN_SETTING).toMatchObject({ label: '시작 지급액', unit: 'Coin' });
    expect(accepts(1)).toBe(true);
    expect(accepts(10_000)).toBe(true);
    expect(accepts(START_GRANT_MAX_COIN)).toBe(true);
    // No zero (no grant is not a grant of nothing: leave it undecided), no fraction, no string,
    // nothing above the bound.
    for (const value of [0, -1, 10.5, '10000', START_GRANT_MAX_COIN + 1]) {
      expect(accepts(value), String(value)).toBe(false);
    }
    // Read back as stored: a number in, the same number out.
    expect(
      readReleaseSetting(RELEASE_SETTINGS, START_COIN_SETTING, { status: 'test', value: 5_000 }),
    ).toEqual({ key: 'grant.start_coin', status: 'test', value: 5_000 });
    expect(readReleaseSetting(RELEASE_SETTINGS, START_COIN_SETTING, undefined)).toEqual({
      key: 'grant.start_coin',
      status: 'undecided',
      value: null,
    });
  });

  it('takes the lead-close gap in whole minutes, 0 to a week (#22, ADR-0098)', () => {
    const accepts = (value: unknown) => LEAD_CLOSE_GAP_SETTING.schema.safeParse(value).success;
    expect(LEAD_CLOSE_GAP_SETTING).toMatchObject({ label: '선행 마감 최소 간격', unit: '분' });
    // 0 is a close at or before the announcement; the design proposal is 60 (#172 item 13).
    for (const value of [0, 60, LEAD_CLOSE_GAP_MAX_MINUTES]) expect(accepts(value)).toBe(true);
    expect(LEAD_CLOSE_GAP_MAX_MINUTES).toBe(7 * 24 * 60);
    for (const value of [-1, 0.5, '60', LEAD_CLOSE_GAP_MAX_MINUTES + 1, null]) {
      expect(accepts(value), String(value)).toBe(false);
    }
    expect(
      readReleaseSetting(RELEASE_SETTINGS, LEAD_CLOSE_GAP_SETTING, {
        status: 'proposal',
        value: 60,
      }),
    ).toEqual({ key: 'market.lead_close_gap', status: 'proposal', value: 60 });
    expect(readReleaseSetting(RELEASE_SETTINGS, LEAD_CLOSE_GAP_SETTING, undefined)).toEqual({
      key: 'market.lead_close_gap',
      status: 'undecided',
      value: null,
    });
    // Where the owner enters it, it says what an undecided gap does and that no draft is refused.
    const { description } = LEAD_CLOSE_GAP_SETTING;
    expect(description).toContain('설계 제안 60분');
    expect(description).toContain(
      '미정이면 발표 예정 시각이 있는 시장은 선행 마감을 통과하지 못해 검수 제출할 수 없다',
    );
    expect(description).toContain('초안을 만들거나 고칠 때는 거절하지 않는다');
    expect(description).toContain('시장은 검수 제출할 때 읽은 값을 저장해');
    // Only a submission stores the gap: the open neither checks nor stores it (#21, ADR-0100).
    expect(description).not.toContain('열 수 없다');
    // The reading is what the time rules take: undecided is null, which a market with an
    // announcement cannot pass.
    const times = {
      scheduledOpenAt: null,
      closeAt: '2026-11-26T14:59:59.000Z',
      scheduledAnnouncementAt: '2026-11-27T01:00:00.000Z',
      scheduledJudgementAt: null,
      judgementTimeZone: null,
      eventDeadline: null,
    };
    const undecided = readReleaseSetting(RELEASE_SETTINGS, LEAD_CLOSE_GAP_SETTING, undefined);
    expect(timeRuleViolations(times, undecided.value).map(({ rule }) => rule)).toEqual([
      'leadClose',
    ]);
    expect(timeRuleViolations(times, 60)).toEqual([]);
  });

  it('takes the dispute window in whole minutes, a minute to a week (#152, #173 item 5)', () => {
    const accepts = (value: unknown) => DISPUTE_WINDOW_SETTING.schema.safeParse(value).success;
    expect(DISPUTE_WINDOW_SETTING).toMatchObject({ label: '이의 기간', unit: '분' });
    // The approved design proposal is 1,440 (24 hours); 1 is the shortest, which e2e uses.
    for (const value of [DISPUTE_WINDOW_MIN_MINUTES, 1_440, DISPUTE_WINDOW_MAX_MINUTES]) {
      expect(accepts(value), String(value)).toBe(true);
    }
    expect([DISPUTE_WINDOW_MIN_MINUTES, DISPUTE_WINDOW_MAX_MINUTES]).toEqual([1, 7 * 24 * 60]);
    // No zero: a result is never confirmed at its publication.
    for (const value of [0, -1, 1.5, '1440', DISPUTE_WINDOW_MAX_MINUTES + 1, null]) {
      expect(accepts(value), String(value)).toBe(false);
    }
    expect(
      readReleaseSetting(RELEASE_SETTINGS, DISPUTE_WINDOW_SETTING, {
        status: 'approved',
        value: 1_440,
      }),
    ).toEqual({ key: 'market.dispute_window', status: 'approved', value: 1_440 });
    expect(readReleaseSetting(RELEASE_SETTINGS, DISPUTE_WINDOW_SETTING, undefined)).toEqual({
      key: 'market.dispute_window',
      status: 'undecided',
      value: null,
    });
    // Where the owner enters it, it says what the value fixes and what an undecided one does.
    const { description } = DISPUTE_WINDOW_SETTING;
    expect(description).toContain('설계 제안 1,440분 = 24시간');
    expect(description).toContain('모든 시장에 같은 값이다');
    expect(description).toContain('승인할 때 이 값을 읽어 그 시장의 이의 기한을 고정하고');
    expect(description).toContain('이미 공개한 시장의 기한은 그대로다');
    expect(description).toContain('미정이면 첫 판정을 등록하거나 승인할 수 없어');
    // A correction (#176, ADR-0105; #173 item 5) reads no value: the first deadline's length.
    expect(description).toContain('판정을 정정하면(#176) 이 값을 다시 읽지 않고');
    expect(description).toContain('그 시장의 첫 기한과 같은 길이의 새 기한을 준다');
    expect(description).not.toMatch(/환불|원금/);
    // The deadline the reading fixes: the publication plus the window, to the millisecond.
    const publishedAt = new Date('2026-11-02T03:04:05.678Z');
    expect(disputeDeadlineOf(publishedAt, 1_440).toISOString()).toBe('2026-11-03T03:04:05.678Z');
  });

  it('opens order intake only on a value of true, whatever the status (#119, the first boolean item)', () => {
    const accepts = (value: unknown) => ORDER_ACCEPTING_SETTING.schema.safeParse(value).success;
    expect(ORDER_ACCEPTING_SETTING).toMatchObject({ label: '주문 접수', unit: null });
    expect([true, false].map(accepts)).toEqual([true, true]);
    for (const value of ['true', 1, 0, null, {}])
      expect(accepts(value), JSON.stringify(value)).toBe(false);
    const read = (stored: Parameters<typeof readReleaseSetting>[2]) =>
      readReleaseSetting(RELEASE_SETTINGS, ORDER_ACCEPTING_SETTING, stored);
    // Undecided (no row, or a row with no value) and false keep it closed; true opens it, a test
    // value as an approved one.
    expect(isOrderIntakeOpen(read(undefined))).toBe(false);
    expect(isOrderIntakeOpen(read({ status: 'undecided', value: null }))).toBe(false);
    expect(isOrderIntakeOpen(read({ status: 'approved', value: false }))).toBe(false);
    expect(isOrderIntakeOpen(read({ status: 'test', value: true }))).toBe(true);
    expect(isOrderIntakeOpen(read({ status: 'approved', value: true }))).toBe(true);
    expect(read({ status: 'approved', value: true })).toEqual({
      key: 'order.accepting',
      status: 'approved',
      value: true,
    });
    // A change to false is a change from undecided; a stored false is read back as false.
    expect(
      parseReleaseSettingChange(ORDER_ACCEPTING_SETTING, { status: 'approved', value: false }),
    ).toEqual({ success: true, state: { status: 'approved', value: false } });
    expect(isReleaseSettingUnchanged(undefined, { status: 'approved', value: false })).toBe(false);
    expect(releaseSettingValueJsonSchema(ORDER_ACCEPTING_SETTING)).toMatchObject({
      type: 'boolean',
    });
    const { description } = ORDER_ACCEPTING_SETTING;
    expect(description).toContain('미정이거나 거짓이면 새 주문을 운영 마켓메이커의 것까지');
    expect(description).toContain('주문 행 없이 거절');
    expect(description).toContain('정산의 대기 주문 확인(#126)과 장부 대사(#93)');
  });

  it('takes the order rate limit per account per minute, 1 to 1,000 (#119, #177 9항)', () => {
    const accepts = (value: unknown) => ORDER_RATE_LIMIT_SETTING.schema.safeParse(value).success;
    expect(ORDER_RATE_LIMIT_SETTING).toMatchObject({ label: '주문 속도 제한', unit: '회/분' });
    for (const value of [1, 20, 1_000]) expect(accepts(value), String(value)).toBe(true);
    for (const value of [0, -1, 1.5, '20', 1_001, null]) {
      expect(accepts(value), String(value)).toBe(false);
    }
    const { description } = ORDER_RATE_LIMIT_SETTING;
    expect(description).toContain('시험값 20');
    expect(description).toContain('취소는 세지 않는다');
    expect(description).toContain('운영 마켓메이커는 세지 않는다');
    expect(description).toContain('미정이면 계정 제한 없이 접속 주소마다 1분 100회 제한만');
  });

  it('takes the price-protection width default in ticks, 1 to 98 (#119, #177 2항)', () => {
    const accepts = (value: unknown) =>
      PRICE_PROTECTION_TICKS_SETTING.schema.safeParse(value).success;
    expect(PRICE_PROTECTION_TICKS_SETTING).toMatchObject({
      key: 'order.price_protection_ticks',
      label: '가격 보호 폭 표준값',
      unit: '틱',
    });
    for (const value of [1, 5, 98]) expect(accepts(value), String(value)).toBe(true);
    for (const value of [0, -1, 1.5, '5', 99, null]) {
      expect(accepts(value), String(value)).toBe(false);
    }
    const { description } = PRICE_PROTECTION_TICKS_SETTING;
    expect(description).toContain('시험값 5');
    expect(description).toContain('시장을 만들 때 이 값을 시장에 복사하고');
    expect(description).toContain('검수부터 그 시장의 값이 잠긴다');
    expect(description).toContain('미정이면 값이 없는 시장을 검수 제출할 수 없다');
  });

  it('labels every status, and only proposal and test are distinct from approved', () => {
    expect(RELEASE_SETTING_STATUSES).toEqual(['undecided', 'proposal', 'test', 'approved']);
    expect(RELEASE_SETTING_STATUS_LABELS).toEqual({
      undecided: '미정',
      proposal: '설계 제안',
      test: '시험값',
      approved: '승인됨',
    });
  });

  it('keeps registration order and refuses a duplicate or malformed key', () => {
    const registry = defineReleaseSettings([window, hours]);
    expect([...registry.keys()]).toEqual(['test.window', 'test.period_hours']);
    expect(registry.get('test.period_hours')).toBe(hours);

    expect(() => defineReleaseSettings([hours, { ...hours }])).toThrow(/registered twice/);
    for (const key of ['Test.hours', 'test..hours', '1st', 'test-hours', 'test.', 'a'.repeat(65)]) {
      expect(() => defineReleaseSetting({ ...hours, key })).toThrow(/must match/);
    }
    expect(() => defineReleaseSetting({ ...hours, label: ' ' })).toThrow(/label/);
    expect(() => defineReleaseSetting({ ...hours, description: '' })).toThrow(/description/);
    expect(() => defineReleaseSetting({ ...hours, unit: '' })).toThrow(/unit/);
  });

  it('records the change as its own admin action type', () => {
    expect(ADMIN_ACTION_TYPES).toContain('release_setting_change');
  });
});

describe('parseReleaseSettingChange', () => {
  it('takes no value while undecided and requires one otherwise', () => {
    for (const value of [undefined, null]) {
      expect(parseReleaseSettingChange(hours, { status: 'undecided', value })).toEqual({
        success: true,
        state: { status: 'undecided', value: null },
      });
    }
    expect(parseReleaseSettingChange(hours, { status: 'undecided', value: 24 })).toEqual({
      success: false,
      issues: [{ path: ['value'], message: 'must be omitted while the status is undecided' }],
    });
    for (const status of ['proposal', 'test', 'approved'] as const) {
      for (const value of [undefined, null]) {
        expect(parseReleaseSettingChange(hours, { status, value })).toEqual({
          success: false,
          issues: [{ path: ['value'], message: 'is required unless the status is undecided' }],
        });
      }
      expect(parseReleaseSettingChange(hours, { status, value: 24 })).toEqual({
        success: true,
        state: { status, value: 24 },
      });
    }
  });

  it('checks the value against the item, reporting paths under value', () => {
    const outOfRange = parseReleaseSettingChange(hours, { status: 'test', value: 0 });
    expect(outOfRange).toMatchObject({ success: false, issues: [{ path: ['value'] }] });
    expect(parseReleaseSettingChange(hours, { status: 'test', value: '24' }).success).toBe(false);

    const nested = parseReleaseSettingChange(window, {
      status: 'proposal',
      value: { from: 1, to: 'x' },
    });
    expect(nested).toMatchObject({ success: false, issues: [{ path: ['value', 'to'] }] });
    expect(
      parseReleaseSettingChange(window, { status: 'proposal', value: { from: 1, to: 2 } }),
    ).toEqual({ success: true, state: { status: 'proposal', value: { from: 1, to: 2 } } });
  });

  it('refuses a value jsonb cannot hold: NUL or a lone surrogate in a string or a key', () => {
    const json = defineReleaseSetting({
      key: 'test.json',
      label: '시험 JSON',
      unit: null,
      description: '시험용 항목(아무 JSON)',
      schema: z.json() as z.ZodType<ReleaseSettingValue>,
    });
    for (const [value, path, message] of [
      [NUL, ['value'], JSONB_NUL_MESSAGE],
      [`a${NUL}b`, ['value'], JSONB_NUL_MESSAGE],
      ['a\ud800', ['value'], JSONB_LONE_SURROGATE_MESSAGE],
      ['\udc00a', ['value'], JSONB_LONE_SURROGATE_MESSAGE],
      ['\ude00\ud83d', ['value'], JSONB_LONE_SURROGATE_MESSAGE],
      [['ok', [`x${NUL}`]], ['value', 1, 0], JSONB_NUL_MESSAGE],
      [{ list: [{ name: 'a\udbff' }] }, ['value', 'list', 0, 'name'], JSONB_LONE_SURROGATE_MESSAGE],
      [{ [`k${NUL}`]: 1 }, ['value', `k${NUL}`], `key ${JSONB_NUL_MESSAGE}`],
      [
        { inner: { '\ud800': true } },
        ['value', 'inner', '\ud800'],
        `key ${JSONB_LONE_SURROGATE_MESSAGE}`,
      ],
    ] as const) {
      expect(parseReleaseSettingChange(json, { status: 'test', value })).toEqual({
        success: false,
        issues: [{ path, message }],
      });
    }
    // A key and its value are each reported.
    expect(parseReleaseSettingChange(json, { status: 'test', value: { [NUL]: NUL } })).toEqual({
      success: false,
      issues: [
        { path: ['value', NUL], message: `key ${JSONB_NUL_MESSAGE}` },
        { path: ['value', NUL], message: JSONB_NUL_MESSAGE },
      ],
    });
    // Paired surrogates and other control characters are text jsonb holds.
    for (const value of ['😀', { '😀': 'a\u0001\u001f' }]) {
      expect(parseReleaseSettingChange(json, { status: 'test', value })).toEqual({
        success: true,
        state: { status: 'test', value },
      });
    }
    // What is stored is the schema's output: a key it drops is never written.
    const loose = defineReleaseSetting({
      ...window,
      schema: z.object({ from: z.number().int(), to: z.number().int() }),
    });
    expect(
      parseReleaseSettingChange(loose, { status: 'test', value: { from: 1, to: 2, [NUL]: NUL } }),
    ).toEqual({ success: true, state: { status: 'test', value: { from: 1, to: 2 } } });
  });
});

describe('jsonbValueIssues', () => {
  it('walks strings, arrays and object members, skipping undefined members as JSON does', () => {
    expect(jsonbValueIssues([1, true, null, 'ok', { a: 'b' }])).toEqual([]);
    expect(jsonbValueIssues({ [NUL]: undefined, a: undefined })).toEqual([]);
    expect(jsonbValueIssues(`${NUL}`, ['reason'])).toEqual([
      { path: ['reason'], message: JSONB_NUL_MESSAGE },
    ]);
  });
});

describe('isReleaseSettingUnchanged (owner decision: a change to the current state is refused)', () => {
  it('reads no row as undecided with no value', () => {
    expect(isReleaseSettingUnchanged(undefined, { status: 'undecided', value: null })).toBe(true);
    expect(isReleaseSettingUnchanged(undefined, { status: 'test', value: 24 })).toBe(false);
    const undecided = { status: 'undecided', value: null } as const;
    expect(isReleaseSettingUnchanged(undecided, { status: 'undecided', value: null })).toBe(true);
  });

  it('is a change when either the status or the value differs', () => {
    const current = { status: 'test', value: 24 } as const;
    expect(isReleaseSettingUnchanged(current, { status: 'test', value: 24 })).toBe(true);
    expect(isReleaseSettingUnchanged(current, { status: 'approved', value: 24 })).toBe(false);
    expect(isReleaseSettingUnchanged(current, { status: 'test', value: 25 })).toBe(false);
    expect(isReleaseSettingUnchanged(current, { status: 'undecided', value: null })).toBe(false);
    // A string that reads as the number is another value.
    expect(isReleaseSettingUnchanged(current, { status: 'test', value: '24' })).toBe(false);
  });

  it('compares values as jsonb does: deep, members in any order, undefined members absent', () => {
    const current = { status: 'proposal', value: { from: 1, to: [2, { at: 'x' }] } } as const;
    for (const value of [
      { to: [2, { at: 'x' }], from: 1 },
      { from: 1, to: [2, { at: 'x' }], note: undefined },
    ]) {
      expect(isReleaseSettingUnchanged(current, { status: 'proposal', value })).toBe(true);
    }
    for (const value of [
      { from: 1, to: [{ at: 'x' }, 2] },
      { from: 1, to: [2, { at: 'y' }] },
      { from: 1, to: [2, { at: 'x' }], note: null },
      { from: 1 },
      [1, [2, { at: 'x' }]],
    ]) {
      expect(isReleaseSettingUnchanged(current, { status: 'proposal', value })).toBe(false);
    }
    const list = { status: 'test', value: [1, 2] } as const;
    expect(isReleaseSettingUnchanged(list, { status: 'test', value: [1, 2] })).toBe(true);
    expect(isReleaseSettingUnchanged(list, { status: 'test', value: [1, 2, 3] })).toBe(false);
    expect(isReleaseSettingUnchanged(list, { status: 'test', value: { 0: 1, 1: 2 } })).toBe(false);
  });
});

describe('readReleaseSetting', () => {
  const registry = defineReleaseSettings([hours, window]);

  it('reads no row, or an undecided one, as undecided with no value', () => {
    const undecided = { key: 'test.period_hours', status: 'undecided', value: null };
    expect(readReleaseSetting(registry, hours, undefined)).toEqual(undecided);
    expect(readReleaseSetting(registry, hours, { status: 'undecided', value: null })).toEqual(
      undecided,
    );
  });

  it('types and returns a stored value with its status', () => {
    const reading = readReleaseSetting(registry, hours, { status: 'test', value: 48 });
    expect(reading).toEqual({ key: 'test.period_hours', status: 'test', value: 48 });
    if (reading.status !== 'undecided') {
      // Compile-time: the value is the schema's output type.
      const value: number = reading.value;
      expect(value).toBe(48);
    }
  });

  it('refuses a stored row that breaks the rule or no longer fits the schema', () => {
    expect(() => readReleaseSetting(registry, hours, { status: 'undecided', value: 24 })).toThrow(
      /undecided but holds a value/,
    );
    expect(() => readReleaseSetting(registry, hours, { status: 'approved', value: 'x' })).toThrow(
      /does not fit its schema/,
    );
  });

  it('reads only the very definition the registry holds', () => {
    const stored = { status: 'test', value: 48 } as const;
    // Another key, a copy of a registered definition, and the shipped registry (which lists the
    // start grant, not this suite's item).
    const unlisted = defineReleaseSetting({ ...hours, key: 'test.unlisted' });
    for (const [inRegistry, definition] of [
      [registry, unlisted],
      [registry, { ...hours }],
      [RELEASE_SETTINGS, hours],
    ] as const) {
      expect(() => readReleaseSetting(inRegistry, definition, stored)).toThrow(/is not registered/);
      expect(() => readReleaseSetting(inRegistry, definition, undefined)).toThrow(
        /is not registered/,
      );
    }
  });
});

describe('DTO schemas', () => {
  it('requires a trimmed, non-empty reason of at most 500 characters', () => {
    const body = { status: 'test', value: 24, expectedAccountId: 'admin-1' };
    expect(
      releaseSettingChangeBodySchema.parse({ ...body, reason: '  시뮬레이션 반영  ' }),
    ).toEqual({
      ...body,
      reason: '시뮬레이션 반영',
    });
    for (const reason of [undefined, '', '   ', 'x'.repeat(501)]) {
      expect(releaseSettingChangeBodySchema.safeParse({ ...body, reason }).success).toBe(false);
    }
    expect(
      releaseSettingChangeBodySchema.safeParse({
        status: 'final',
        reason: 'x',
        expectedAccountId: 'admin-1',
      }).success,
    ).toBe(false);
  });

  it('names the admin on screen (ADR-0092)', () => {
    const parsed = releaseSettingChangeBodySchema.safeParse({
      status: 'test',
      value: 24,
      reason: '시뮬레이션 반영',
    });
    expect(parsed.error?.issues.map(({ path }) => path)).toEqual([['expectedAccountId']]);
  });

  it('refuses a reason jsonb cannot hold, naming the reason (Codex #201)', () => {
    const body = { status: 'test', value: 24, expectedAccountId: 'admin-1' };
    for (const [reason, message] of [
      [NUL, JSONB_NUL_MESSAGE],
      [`  ${NUL}  `, JSONB_NUL_MESSAGE],
      [`사유${NUL}끝`, JSONB_NUL_MESSAGE],
      ['사유\ud800', JSONB_LONE_SURROGATE_MESSAGE],
      ['\udc00사유', JSONB_LONE_SURROGATE_MESSAGE],
      ['\ude00\ud83d', JSONB_LONE_SURROGATE_MESSAGE],
    ] as const) {
      const parsed = releaseSettingChangeBodySchema.safeParse({ ...body, reason });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map(({ path, message: m }) => ({ path, message: m }))).toEqual([
        { path: ['reason'], message },
      ]);
    }
    // Paired surrogates and other control characters are text jsonb holds.
    for (const reason of ['😀', '사유\u0001\u001f끝']) {
      expect(releaseSettingChangeBodySchema.parse({ ...body, reason }).reason).toBe(reason);
    }
  });

  it('validates the key of a change-log filter like a registry key', () => {
    expect(releaseSettingKeySchema.safeParse('grant.initial_coin').success).toBe(true);
    expect(releaseSettingChangeListQuerySchema.parse({ key: 'test.period_hours' })).toEqual({
      key: 'test.period_hours',
      limit: 20,
    });
    expect(releaseSettingChangeListQuerySchema.safeParse({ key: 'DROP TABLE' }).success).toBe(
      false,
    );
  });

  it('describes the value an admin enters as JSON Schema', () => {
    expect(releaseSettingValueJsonSchema(hours)).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 720,
    });
    expect(releaseSettingValueJsonSchema(window)).toMatchObject({
      type: 'object',
      required: ['from', 'to'],
    });
  });
});
