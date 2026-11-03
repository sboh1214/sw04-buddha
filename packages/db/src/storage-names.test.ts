import {
  ACCOUNT_RESTRICTION_APPROVAL_KINDS,
  ADMIN_ACTION_TYPES,
  ALL_CATEGORY_SLUGS,
  AUDIT_FAILURE_KINDS,
  CONSENT_ITEMS,
  IMAGE_CONTENT_TYPES,
  LEDGER_REF_TYPES,
  LINK_FLAG_REASONS,
  MARKET_DISPUTE_STATUSES,
  MARKET_EVENT_TYPES,
  MARKET_JUDGEMENT_APPROVAL_KIND,
  MARKET_PAUSE_DECISION_APPROVAL_KIND,
  MARKET_PAUSE_END_KINDS,
  MARKET_PAUSE_REASONS,
  MARKET_PAUSE_REVIEW_RESULTS,
  MARKET_REVIEW_APPROVAL_KIND,
  MARKET_SUPPLEMENT_APPROVAL_KIND,
  MEDIA_KINDS,
  MODERATION_ACTION_TYPES,
  PAYMENT_EVENT_TYPES,
  PAYMENT_PROVIDERS,
  PHONE_VERIFICATION_SEND_OUTCOMES,
  RELEASE_SETTINGS,
  RESTRICTION_END_CHANGE_KINDS,
  RETENTION_PURGE_KINDS,
  RETENTION_PURGE_OUTCOMES,
  RULE_VERSION_ITEMS,
  SETTLEMENT_STEPS,
  SETTLEMENT_STEP_STATUSES,
  START_GRANT_NUMBER_SOURCES,
  WATCH_EVENT_ACTIONS,
  WRITE_LIMIT_ACTIONS,
  findExcludedIdentifier,
  identifierWords,
  namesPersonalProbability,
  tokenForms,
} from '@buddha/shared';
import { is } from 'drizzle-orm';
import {
  PgTable,
  getTableConfig,
  integer,
  isPgEnum,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema/index.js';

/**
 * What the plan leaves out must not come back as stored data (#113): no table, column,
 * constraint, index or enum, and no value a varchar column holds from a fixed list, names an
 * excluded feature of EXCLUDED_FEATURES (@buddha/shared) — a Forecast or a belief, a score, rank
 * or badge, an activity reward, a transfer between users, a cash withdrawal. An activity reward
 * or a transfer would most likely arrive as a ledger entry type, which is an enum value here, or
 * as a table or column of its own: named for a reward, a check-in or a transfer it fails on the
 * tokens, and named for a bonus (LIKE_BONUS, TRADE_VOLUME_BONUS, daily_bonuses,
 * bonusClaimedAt) it fails unless BONUS_NAMES lists it.
 *
 * Read from the Drizzle schema objects, the same ones drizzle-kit generates the migrations from,
 * so no database is needed.
 *
 * Paid purchase is not looked for in storage: the payment, charge package and coupon tables,
 * their ledger types and their admin action types stay while sales are closed (D9, ADR-0049) —
 * only screens and public responses must not show them.
 */

const EXPORTS: unknown[] = Object.values(schema);
const TABLES = EXPORTS.filter((value): value is PgTable => is(value, PgTable)).map((table) =>
  getTableConfig(table),
);
const ENUMS = EXPORTS.filter(isPgEnum);

/**
 * The fixed value lists varchar columns hold (a Postgres enum's values come with the enum). A
 * varchar column that takes its values from a new list adds the list here. Left out:
 * `admin_actions.target_type`, the name of the target's table.
 */
const VARCHAR_VALUES: Readonly<Record<string, readonly string[]>> = {
  'ledger_entries.ref_type': LEDGER_REF_TYPES,
  'payments.provider': PAYMENT_PROVIDERS,
  'payment_events.type': PAYMENT_EVENT_TYPES,
  'market_events.type': MARKET_EVENT_TYPES,
  'market_settlement_steps.step': SETTLEMENT_STEPS,
  'market_settlement_steps.status': SETTLEMENT_STEP_STATUSES,
  'admin_actions.type': ADMIN_ACTION_TYPES,
  'audit_failures.kind': AUDIT_FAILURE_KINDS,
  // The slugs the seed starts the tree with. An operator's own (#17, `/admin/categories`) are
  // typed on the admin screen, like a tag's name: no fixed list holds them.
  'categories.slug': ALL_CATEGORY_SLUGS,
  'release_settings.key': [...RELEASE_SETTINGS.keys()],
  'market_watch_events.action': WATCH_EVENT_ACTIONS,
  'phone_verification_codes.send_outcome': PHONE_VERIFICATION_SEND_OUTCOMES,
  'start_grant_numbers.source': START_GRANT_NUMBER_SOURCES,
  'consent_records.item': CONSENT_ITEMS,
  'media_objects.kind': MEDIA_KINDS,
  'media_objects.content_type': IMAGE_CONTENT_TYPES,
  // Generated (#141): the profile image's kind its foreign key requires, NULL without an image.
  'profiles.image_kind': MEDIA_KINDS.filter((kind) => kind === 'profile_image'),
  // #50: what an operator did to a member, held by a CHECK that a type's migration replaces —
  // #185's writing restriction did (0040), #139's account restriction (0042).
  'moderation_actions.type': MODERATION_ACTION_TYPES,
  // #185: how an operator brought a writing restriction's end forward (감경, 조기 해제).
  'restriction_end_changes.kind': RESTRICTION_END_CHANGE_KINDS,
  // #187 (ADR-0083): what a write limit counts, and why a link is on the review list.
  'write_limit_events.action': WRITE_LIMIT_ACTIONS,
  'link_flags.reason': LINK_FLAG_REASONS,
  // #171's two-person rule: each consumer's kinds — the account restriction's four (#139) the
  // first, the market review (#78), the rule supplement (#80), a paused market's next path (#114),
  // a market's judgement — a CLOSED one's (#152) and a PROVISIONAL one's correction (#176), one
  // kind; #130's bot control and the rest add theirs here.
  'approval_requests.kind': [
    ...Object.values(ACCOUNT_RESTRICTION_APPROVAL_KINDS),
    MARKET_REVIEW_APPROVAL_KIND,
    MARKET_SUPPLEMENT_APPROVAL_KIND,
    MARKET_PAUSE_DECISION_APPROVAL_KIND,
    MARKET_JUDGEMENT_APPROVAL_KIND,
  ],
  // #80: the items a rule version changed (a text[] of the version items' keys, held by a CHECK).
  'market_rule_versions.changed_items': RULE_VERSION_ITEMS,
  // #114: a pause's reason (three only, ADR-0093 #173 item 3), a `basis_change` pause's review
  // result and how a pause ended, each held by a CHECK.
  'market_pauses.reason': MARKET_PAUSE_REASONS,
  'market_pauses.review_result': MARKET_PAUSE_REVIEW_RESULTS,
  'market_pauses.end_kind': MARKET_PAUSE_END_KINDS,
  // #175: a 판정 이의's status, held by a CHECK — #176's migration 0057 added
  // 'closed_by_correction' ('retracted', never the cash-out's `withdraw*`; 'dismissed', never
  // 'review' or 'appeal').
  'market_disputes.status': MARKET_DISPUTE_STATUSES,
  // #184's purge records: the kinds a run counts (no personal content), and whether a kind was
  // done or failed (owner decision 2026-10-24 14).
  'retention_purges.kind': RETENTION_PURGE_KINDS,
  'retention_purges.outcome': RETENTION_PURGE_OUTCOMES,
};

/**
 * The stored names that may name a bonus — a table, column, constraint, enum or stored value,
 * keyed as storageNames() places them — with why. 'bonus' is a path token of the activity reward
 * only: the coupon's BONUS ledger type is the product's own (ADR-0026), and so a bonus-named
 * stored name is held to this list instead. A new one is added here with its reason, which a
 * reviewer reads.
 */
const BONUS_NAMES: Readonly<Record<string, string>> = {
  'ledger_entry_type value BONUS':
    'the kept coupon redemption (D9, ADR-0049), and the sign-up grant of accounts created before ' +
    '#70. The start Coin has its own START_GRANT type (ADR-0069 decision 4 #70, ADR-0071)',
};
const BONUS_FORMS = tokenForms('bonus');

/** Every stored name, with where it is. */
function storageNames(): { where: string; name: string }[] {
  const names: { where: string; name: string }[] = [];
  for (const table of TABLES) {
    names.push({ where: 'table', name: table.name });
    for (const column of table.columns) {
      names.push({ where: `${table.name} column`, name: column.name });
    }
    const constraints = [
      ...table.indexes.map((index) => index.config.name),
      ...table.checks.map((check) => check.name),
      ...table.uniqueConstraints.map((unique) => unique.name),
      ...table.foreignKeys.map((fk) => fk.getName()),
      ...table.primaryKeys.map((pk) => pk.getName()),
    ];
    for (const name of constraints) {
      if (name !== undefined) names.push({ where: `${table.name} constraint`, name });
    }
  }
  for (const pgEnum of ENUMS) {
    names.push({ where: 'enum', name: pgEnum.enumName });
    for (const value of pgEnum.enumValues) {
      names.push({ where: `${pgEnum.enumName} value`, name: value });
    }
  }
  for (const [column, values] of Object.entries(VARCHAR_VALUES)) {
    for (const value of values) names.push({ where: `${column} value`, name: value });
  }
  return names;
}

/** A column that holds an account, constrained or not: `userId`, `user_id`, `accountId`. */
function holdsAccount(column: string): boolean {
  const words = identifierWords(column);
  return words.some(
    (word, index) => (word === 'user' || word === 'account') && words[index + 1] === 'id',
  );
}

/**
 * The tables whose rows may belong to one person: the user row itself, every table with an
 * account column (a foreign key or not), and every table that points at one of those, directly or
 * through another (a fill is its order's, a payment event its payment's, and so on down).
 */
function personalTables(tables: typeof TABLES = TABLES) {
  const personal = new Set(
    tables.filter(
      (table) => table.name === 'user' || table.columns.some((column) => holdsAccount(column.name)),
    ),
  );
  for (let grew = true; grew;) {
    grew = false;
    for (const table of tables) {
      if (personal.has(table)) continue;
      const points = table.foreignKeys.some((fk) =>
        [...personal].some(
          (owner) => owner.name === getTableConfig(fk.reference().foreignTable).name,
        ),
      );
      if (points) {
        personal.add(table);
        grew = true;
      }
    }
  }
  return [...personal];
}

describe('excluded features in stored data (#113)', () => {
  it('reads the whole schema', () => {
    const tables = TABLES.map((table) => table.name);
    expect(tables).toEqual(
      expect.arrayContaining(['user', 'orders', 'fills', 'positions', 'ledger_entries']),
    );
    expect(ENUMS.map((pgEnum) => pgEnum.enumName)).toContain('ledger_entry_type');
    // Every varchar list names a real column.
    for (const column of Object.keys(VARCHAR_VALUES)) {
      const [table, name] = column.split('.');
      const config = TABLES.find((t) => t.name === table);
      expect(
        config?.columns.some(
          (c) => c.name.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`) === name,
        ),
        column,
      ).toBe(true);
    }
  });

  it('names no excluded feature in a table, column, constraint, enum or stored value', () => {
    const hits = storageNames().flatMap(({ where, name }) =>
      findExcludedIdentifier(name, 'storage').map(
        (hit) => `${where} ${name}: ${hit.feature} '${hit.word}'`,
      ),
    );
    expect(hits).toEqual([]);
  });

  it('names a bonus in a stored name only where BONUS_NAMES says why', () => {
    const named = storageNames()
      .filter(({ name }) => identifierWords(name).some((word) => BONUS_FORMS.includes(word)))
      .map(({ where, name }) => `${where} ${name}`);
    // Every line is still needed, and nothing else names a bonus.
    expect(named.sort()).toEqual(Object.keys(BONUS_NAMES).sort());
  });

  it('orders a market’s sources by `priority`, a word that names no ranking (#23)', () => {
    // ADR-0097: 1차 출처 at 0, 대체 출처 at 1..3. `rank` is a scoring token, so a column, key or
    // CHECK named for it would fail the test above.
    const sources = TABLES.find((table) => table.name === 'market_sources');
    expect(sources?.columns.map((column) => column.name)).toEqual([
      'marketId',
      'priority',
      'name',
      'url',
    ]);
    expect(storageNames().filter(({ where }) => where === 'market_sources constraint')).toEqual(
      expect.arrayContaining([
        { where: 'market_sources constraint', name: 'market_sources_priority_check' },
        { where: 'market_sources constraint', name: 'market_sources_url_check' },
        { where: 'market_sources constraint', name: 'market_sources_not_empty_check' },
      ]),
    );
    expect(findExcludedIdentifier('rank', 'storage').map((hit) => hit.feature)).toEqual([
      'scoring',
    ]);
  });

  it('names the market times and their CHECKs explicitly, each read by the test above (#22)', () => {
    // ADR-0098, migration 0051: the scheduled times, the judgement zone and the lead-close gap
    // the submission stored beside the close, and the order CHECKs and the gap's own, under the
    // names the API's tests and the migration spell.
    const marketsTable = TABLES.find((table) => table.name === 'markets');
    expect(marketsTable?.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'openAt',
        'scheduledOpenAt',
        'closeAt',
        'scheduledAnnouncementAt',
        'scheduledJudgementAt',
        'judgementTimeZone',
        'leadCloseGapMinutes',
      ]),
    );
    expect(storageNames().filter(({ where }) => where === 'markets constraint')).toEqual(
      expect.arrayContaining(
        [
          'markets_open_before_close_check',
          'markets_close_by_judgement_check',
          'markets_deadline_by_judgement_check',
          'markets_lead_close_gap_minutes_check',
        ].map((name) => ({ where: 'markets constraint', name })),
      ),
    );
  });

  it('names the market records’ index and the review’s stored values, each read above (#78)', () => {
    // ADR-0099, migration 0052: one market's admin records (the review's editors) under the name
    // the migration and the schema test spell; the review's approval kind, market event types and
    // admin action types, which the test above reads for an excluded feature.
    expect(storageNames()).toEqual(
      expect.arrayContaining([
        { where: 'admin_actions constraint', name: 'admin_actions_market_target_idx' },
        { where: 'approval_requests.kind value', name: 'market_review' },
        ...['submitted', 'approved', 'rejected', 'reverted', 'open_rescheduled'].map((name) => ({
          where: 'market_events.type value',
          name,
        })),
        ...[
          'market_submit',
          'market_approve',
          'market_reject',
          'market_revert',
          'market_reschedule',
        ].map((name) => ({ where: 'admin_actions.type value', name })),
      ]),
    );
  });

  it('names the rule versions, their CHECKs and the supplement’s stored values, each read above (#80)', () => {
    // ADR-0101, migration 0053: the table of a market's rule versions, the current version on the
    // market, their CHECKs under the names the schema test spells, and the supplement's approval
    // kind, market event type and admin action types, which the test above reads for an excluded
    // feature ('version', 'supplement', 'impact' name none).
    const versions = TABLES.find((table) => table.name === 'market_rule_versions');
    expect(versions?.columns.map((column) => column.name)).toEqual([
      'marketId',
      'version',
      'content',
      'changedItems',
      'reason',
      'settlementImpact',
      'approvalId',
      'requestedBy',
      'createdBy',
      'createdAt',
    ]);
    expect(TABLES.find((table) => table.name === 'markets')?.columns.map((c) => c.name)).toContain(
      'ruleVersion',
    );
    expect(storageNames()).toEqual(
      expect.arrayContaining([
        { where: 'table', name: 'market_rule_versions' },
        ...[
          // The primary key as the schema object names it (the migration's is snake_case).
          'market_rule_versions_marketId_version_pk',
          'market_rule_versions_version_check',
          'market_rule_versions_supplement_check',
          'market_rule_versions_reasons_check',
          'market_rule_versions_changed_items_check',
          'market_rule_versions_content_check',
        ].map((name) => ({ where: 'market_rule_versions constraint', name })),
        { where: 'markets constraint', name: 'markets_rule_version_check' },
        { where: 'approval_requests.kind value', name: 'market_supplement' },
        { where: 'market_events.type value', name: 'rules_supplemented' },
        ...[
          'market_supplement_request',
          'market_supplement_approve',
          'market_supplement_reject',
          'market_supplement_retract',
        ].map((name) => ({ where: 'admin_actions.type value', name })),
        ...RULE_VERSION_ITEMS.map((name) => ({
          where: 'market_rule_versions.changed_items value',
          name,
        })),
      ]),
    );
  });

  it('names the pauses, their CHECKs and the pause’s stored values, each read above (#114)', () => {
    // ADR-0102, migration 0054: the table of a market's pauses, its CHECKs and indexes under the
    // names the schema test spells, and the pause's approval kind, market event types and admin
    // action types, which the test above reads for an excluded feature ('pause', 'resume',
    // 'judgeable', 'early_close' name none).
    const pauses = TABLES.find((table) => table.name === 'market_pauses');
    expect(pauses?.columns.map((column) => column.name)).toEqual([
      'id',
      'marketId',
      'reason',
      'note',
      'resultPublishedAt',
      'pausedAt',
      'pausedBy',
      'pauseEventId',
      'reviewResult',
      'endKind',
      'endedAt',
      'endedBy',
      'endEventId',
      'endApprovalId',
    ]);
    expect(storageNames()).toEqual(
      expect.arrayContaining([
        { where: 'table', name: 'market_pauses' },
        ...[
          'market_pauses_reason_check',
          'market_pauses_note_check',
          'market_pauses_result_published_at_check',
          'market_pauses_review_result_check',
          'market_pauses_end_kind_check',
          'market_pauses_end_check',
          'market_pauses_review_check',
          'market_pauses_market_id_lasting_unique',
          'market_pauses_market_id_paused_at_idx',
        ].map((name) => ({ where: 'market_pauses constraint', name })),
        { where: 'approval_requests.kind value', name: 'market_pause_decision' },
        ...['paused', 'resumed'].map((name) => ({ where: 'market_events.type value', name })),
        ...[
          'market_pause',
          'market_pause_decision_request',
          'market_pause_decision_approve',
          'market_pause_decision_reject',
          'market_pause_decision_retract',
        ].map((name) => ({ where: 'admin_actions.type value', name })),
        ...MARKET_PAUSE_REASONS.map((name) => ({ where: 'market_pauses.reason value', name })),
        ...MARKET_PAUSE_REVIEW_RESULTS.map((name) => ({
          where: 'market_pauses.review_result value',
          name,
        })),
        ...MARKET_PAUSE_END_KINDS.map((name) => ({ where: 'market_pauses.end_kind value', name })),
      ]),
    );
  });

  it('names the judgements, their CHECKs and the judgement’s stored values, each read above (#152)', () => {
    // ADR-0103, migration 0055: the table of a market's approved judgements, the current version
    // and deadline on the market, the CHECKs and the scan's index under the names the schema test
    // spells, and the judgement's approval kind, market event type, admin action types and release
    // setting key, which the test above reads for an excluded feature ('judgement', 'provisional',
    // 'dispute', 'evidence', 'void' name none). Not `dispute_until`: that M5 column stays dropped
    // (schema.test.ts).
    const judgements = TABLES.find((table) => table.name === 'market_judgements');
    expect(judgements?.columns.map((column) => column.name)).toEqual([
      'marketId',
      'version',
      'result',
      'sourcePriority',
      'sourceName',
      'sourceUrl',
      'fallbackReason',
      'voidReason',
      'evidenceLinks',
      'evidenceDescription',
      'collectedAt',
      'ruleVersion',
      'eventDeadlineConfirmed',
      'disputeWindowMinutes',
      'publishedAt',
      'disputeDeadline',
      // 정정 사유 (#176, migration 0057).
      'correctionReason',
      'approvalId',
      'registeredBy',
      'approvedBy',
      'provisionalEventId',
      'createdAt',
    ]);
    const marketColumns = TABLES.find((table) => table.name === 'markets')?.columns;
    expect(marketColumns?.map((column) => column.name)).toEqual(
      expect.arrayContaining(['judgementVersion', 'disputeDeadline']),
    );
    expect(marketColumns?.map((column) => column.name)).not.toContain('disputeUntil');
    expect(storageNames()).toEqual(
      expect.arrayContaining([
        { where: 'table', name: 'market_judgements' },
        ...[
          // The primary key as the schema object names it (the migration's is snake_case).
          'market_judgements_marketId_version_pk',
          'market_judgements_version_check',
          'market_judgements_source_check',
          'market_judgements_fallback_reason_check',
          'market_judgements_void_reason_check',
          'market_judgements_evidence_check',
          'market_judgements_dispute_check',
          'market_judgements_approver_check',
        ].map((name) => ({ where: 'market_judgements constraint', name })),
        ...[
          'markets_judgement_version_check',
          'markets_provisional_check',
          'markets_provisional_dispute_deadline_idx',
        ].map((name) => ({ where: 'markets constraint', name })),
        { where: 'approval_requests.kind value', name: 'market_judgement' },
        ...['provisional', 'resolved'].map((name) => ({ where: 'market_events.type value', name })),
        ...[
          'market_judgement_request',
          'market_judgement_approve',
          'market_judgement_reject',
          'market_judgement_retract',
        ].map((name) => ({ where: 'admin_actions.type value', name })),
        { where: 'release_settings.key value', name: 'market.dispute_window' },
      ]),
    );
  });

  it('names the disputes, their CHECKs and the dispute’s stored values, each read above (#175)', () => {
    // ADR-0104, migration 0056: the table of the 판정 이의, the hold mirror on the market, the
    // CHECKs and indexes under the names the schema test spells, the dispute's admin action types
    // and the purge kind, which the test above reads for an excluded feature ('dispute', 'retract',
    // 'dismiss', 'hold', 'purge' name none). Not `disputes` nor `dispute_status`: those M5 names
    // stay dropped (schema.test.ts).
    const disputes = TABLES.find((table) => table.name === 'market_disputes');
    expect(disputes?.columns.map((column) => column.name)).toEqual([
      'id',
      'marketId',
      'judgementVersion',
      'userId',
      'links',
      'reason',
      'status',
      'submittedAt',
      'decidedBy',
      'decidedAt',
      'decisionReason',
      'retractedAt',
      // 정정으로 종결's instant (#176, migration 0057).
      'closedAt',
      'purgedAt',
    ]);
    expect(TABLES.map((table) => table.name)).not.toContain('disputes');
    expect(ENUMS.map((pgEnum) => pgEnum.enumName)).not.toContain('dispute_status');
    expect(TABLES.find((table) => table.name === 'markets')?.columns.map((c) => c.name)).toContain(
      'disputeHoldCount',
    );
    expect(storageNames()).toEqual(
      expect.arrayContaining([
        { where: 'table', name: 'market_disputes' },
        ...[
          'market_disputes_judgement_fk',
          'market_disputes_market_id_judgement_version_user_id_unique',
          'market_disputes_status_check',
          'market_disputes_links_check',
          'market_disputes_reason_check',
          'market_disputes_decision_check',
          'market_disputes_retracted_check',
          'market_disputes_purged_check',
          'market_disputes_holding_idx',
          'market_disputes_pending_submitted_at_idx',
          'market_disputes_ended_at_idx',
          'market_disputes_user_id_submitted_at_idx',
        ].map((name) => ({ where: 'market_disputes constraint', name })),
        ...['markets_dispute_hold_count_check', 'markets_dispute_hold_status_check'].map(
          (name) => ({ where: 'markets constraint', name }),
        ),
        ...MARKET_DISPUTE_STATUSES.map((name) => ({ where: 'market_disputes.status value', name })),
        ...['market_dispute_dismiss', 'market_dispute_accept'].map((name) => ({
          where: 'admin_actions.type value',
          name,
        })),
        { where: 'retention_purges.kind value', name: 'market_disputes' },
      ]),
    );
    // The personal table it is (a submitter's), holding no personal probability (the test below).
    expect(personalTables().map((table) => table.name)).toContain('market_disputes');
  });

  it('names the correction’s columns, CHECKs and stored values, each read above (#176)', () => {
    // ADR-0105, migration 0057: the 정정 사유 on a judgement version, the closure's instant on a
    // dispute, the correction mirror on the market and their CHECKs, the new dispute status and
    // the correction's market event type, which the test above reads for an excluded feature
    // ('correction', 'corrected', 'closed', 'pending' name none). No new approval kind or admin
    // action type: a correction is a `market_judgement` request and its four records.
    const columnsOf = (name: string) =>
      TABLES.find((table) => table.name === name)?.columns.map((column) => column.name);
    expect(columnsOf('market_judgements')).toContain('correctionReason');
    expect(columnsOf('market_disputes')).toContain('closedAt');
    expect(columnsOf('markets')).toEqual(
      expect.arrayContaining(['disputeHoldCount', 'correctionPending']),
    );
    expect(storageNames()).toEqual(
      expect.arrayContaining([
        {
          where: 'market_judgements constraint',
          name: 'market_judgements_correction_reason_check',
        },
        { where: 'market_disputes constraint', name: 'market_disputes_closed_check' },
        { where: 'markets constraint', name: 'markets_correction_pending_status_check' },
        { where: 'market_disputes.status value', name: 'closed_by_correction' },
        { where: 'market_events.type value', name: 'judgement_corrected' },
      ]),
    );
    expect(MARKET_DISPUTE_STATUSES).toContain('closed_by_correction');
    expect(MARKET_EVENT_TYPES).toContain('judgement_corrected');
  });

  it('passes with the payment and coupon structures kept for paid Coin (D9)', () => {
    const tables = TABLES.map((table) => table.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'payments',
        'payment_events',
        'charge_packages',
        'coupons',
        'coupon_redemptions',
      ]),
    );
    // They would name paid purchase on a screen or in a public response, where it is looked for.
    expect(findExcludedIdentifier('charge_packages', 'api').map((hit) => hit.feature)).toEqual([
      'paid-purchase',
    ]);
    expect(findExcludedIdentifier('charge_packages', 'storage')).toEqual([]);
  });

  it('knows a table of one person through another table, or by an unconstrained account', () => {
    const planted = [
      ...TABLES,
      getTableConfig(
        pgTable('fill_marks', {
          fillId: uuid('fill_id').references(() => schema.fills.id),
          probabilityBp: integer('probability_bp'),
        }),
      ),
      getTableConfig(
        pgTable('watch_notes', { ownerUserId: text('owner_user_id'), note: text('note') }),
      ),
    ];
    expect(
      personalTables(planted)
        .map((table) => table.name)
        .filter((name) => ['fill_marks', 'watch_notes'].includes(name))
        .sort(),
    ).toEqual(['fill_marks', 'watch_notes']);
    expect(personalTables().map((table) => table.name)).not.toContain('categories');
  });

  it('keeps no buy input or fill price as a personal probability (N02 §10, N04 §5)', () => {
    const tables = personalTables();
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining([
        'user',
        'profiles',
        'balances',
        'orders',
        'fills',
        'positions',
        'payment_events',
      ]),
    );
    expect(holdsAccount('userId') && holdsAccount('account_id')).toBe(true);
    expect(holdsAccount('userAgent') || holdsAccount('accountIdentifier')).toBe(false);
    const hits = tables.flatMap((table) => [
      ...(namesPersonalProbability(table.name) ? [table.name] : []),
      ...table.columns
        .filter((column) => namesPersonalProbability(column.name))
        .map((column) => `${table.name}.${column.name}`),
    ]);
    expect(hits).toEqual([]);
  });
});
