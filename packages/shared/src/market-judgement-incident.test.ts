import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  APPROVAL_KIND_MAX_LENGTH,
  APPROVAL_KIND_PATTERN,
  APPROVAL_REASON_MAX_LENGTH,
} from './approvals.js';
import { MARKET_RESULTS, MARKET_STATUSES, type MarketStatus } from './enums.js';
import { expectedAccountBodySchema } from './expected-account.js';
import { findExcludedIdentifier } from './guards/excluded.js';
import { findPrivateField } from './guards/private-data.js';
import * as shared from './index.js';
import {
  JUDGEMENT_INCIDENT_CONFIRMABLE_STATUS,
  JUDGEMENT_INCIDENT_STATUSES,
  MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND,
  MARKET_JUDGEMENT_INCIDENT_REFUSALS,
  adminMarketJudgementIncidentQueueItemSchema,
  adminMarketJudgementIncidentSchema,
  confirmJudgementIncidentBodySchema,
  dismissJudgementIncidentBodySchema,
  judgementIncidentDecisionRefusal,
  judgementIncidentStatusRefusal,
  marketJudgementIncidentRequestPayloadSchema,
  registerJudgementIncidentBodySchema,
  retractJudgementIncidentBodySchema,
} from './market-judgement-incident.js';
import { JUDGEMENT_EVIDENCE_LINK_MAX, MARKET_JUDGEMENT_APPROVAL_KIND } from './market-judgement.js';
import { publicMarketJudgementCorrectionSchema } from './market-judging-record.js';
import { STORABLE_INSTANT_TOO_EARLY } from './market-rules.js';

const at = '2026-11-23T03:00:00.000Z';
const link = 'https://www.bok.or.kr/press/1';
const requestId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const incidentId = '6c1d2e3f-4a5b-4c6d-9e7f-8091a2b3c4d5';
const marketId = '9b2e1f4c-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const registrant = { id: 'admin-1', nickname: '운영자1' };
const reviewer = { id: 'admin-2', nickname: null };

const issues = (result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  result.error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) ?? [];
const paths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

const body = {
  noConflictConfirmed: true,
  correctedResult: 'NO',
  description: '  발표 원문의 수치를 잘못 읽었다.  ',
  evidence: { links: [` ${link} `], collectedAt: at },
  expectedAccountId: 'admin-1',
};

describe('the 판정 오류 사건 (#144, ADR-0165)', () => {
  it('names its own approval kind, never the judgement’s', () => {
    expect(MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND).toBe('market_judgement_incident');
    expect(APPROVAL_KIND_PATTERN.test(MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND)).toBe(true);
    expect(MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND.length).toBeLessThanOrEqual(
      APPROVAL_KIND_MAX_LENGTH,
    );
    // The judgement's waiting-request reads count `market_judgement` alone; an incident must not
    // hold a market's judgement state (market-dispute.ts `waitingJudgementsOf`).
    expect(MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND).not.toBe(MARKET_JUDGEMENT_APPROVAL_KIND);
  });

  it('names its refusals apart under each path, each a message a client maps', () => {
    expect(MARKET_JUDGEMENT_INCIDENT_REFUSALS).toEqual({
      status: { notResultConfirmed: 'not result confirmed', notSettled: 'not settled' },
      judgement: { legacy: 'legacy' },
      correctedResult: { sameResult: 'same result' },
      evidence: { duplicateLink: 'duplicate', collectedAfterNow: 'after now' },
      incident: { confirmed: 'confirmed', pending: 'pending' },
      decider: { registrant: 'registrant' },
      requestId: { unknown: 'unknown' },
    });
    for (const [path, messages] of Object.entries(MARKET_JUDGEMENT_INCIDENT_REFUSALS)) {
      const values = Object.values(messages);
      expect(new Set(values).size, path).toBe(values.length);
    }
  });

  it('registers and dismisses from 결과 확정 on (144-8) and confirms once paid (144-13)', () => {
    expect(JUDGEMENT_INCIDENT_STATUSES).toEqual(['resolved', 'settling', 'settled']);
    expect(JUDGEMENT_INCIDENT_CONFIRMABLE_STATUS).toBe('settled');
    const taken = (action: 'register' | 'confirm' | 'dismiss') =>
      MARKET_STATUSES.filter((status) => judgementIncidentStatusRefusal(status, action) === null);
    expect(taken('register')).toEqual(['resolved', 'settling', 'settled']);
    expect(taken('dismiss')).toEqual(['resolved', 'settling', 'settled']);
    expect(taken('confirm')).toEqual(['settled']);
    const before: MarketStatus[] = ['draft', 'open', 'paused', 'closed', 'provisional'];
    for (const status of [...before, 'cancelled'] as const) {
      for (const action of ['register', 'confirm', 'dismiss'] as const) {
        expect(judgementIncidentStatusRefusal(status, action), `${status} ${action}`).toBe(
          'not result confirmed',
        );
      }
    }
    expect(judgementIncidentStatusRefusal('resolved', 'confirm')).toBe('not settled');
    expect(judgementIncidentStatusRefusal('settling', 'confirm')).toBe('not settled');
  });

  it('refuses the paid version’s registrant as a decider, from one shared function (144-4)', () => {
    expect(judgementIncidentDecisionRefusal('admin-1', 'admin-1')).toBe('registrant');
    expect(judgementIncidentDecisionRefusal('admin-2', 'admin-1')).toBeNull();
    // Exact: no trimming or case folding of an account id.
    expect(judgementIncidentDecisionRefusal('Admin-1', 'admin-1')).toBeNull();
  });

  it('stores and answers names no excluded feature reads', () => {
    for (const name of [
      'market_judgement_incidents',
      'applied_txid',
      'original_result',
      'originalResult',
      'corrected_result',
      'correctedResult',
      'paid_registered_by',
      'confirmed_by',
      'confirmedBy',
      'confirmed_at',
      'confirmedAt',
      'registered_at',
      'registeredAt',
      'incidentId',
      'judgementIncident',
      'registrable',
      'confirmable',
      'corrected',
      MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND,
      ...shared.ADMIN_ACTION_TYPES.filter((type) => type.startsWith('market_judgement_incident_')),
      'judgement-incidents',
      'market-judgement-incidents',
    ]) {
      expect(findExcludedIdentifier(name, 'api'), name).toEqual([]);
      expect(findExcludedIdentifier(name, 'storage'), name).toEqual([]);
    }
  });
});

describe('the incident bodies', () => {
  it('requires a fresh explicit conflict acknowledgement without defaulting it', () => {
    const { noConflictConfirmed: _confirmed, ...without } = body;
    expect(paths(registerJudgementIncidentBodySchema.safeParse(without))).toEqual([
      'noConflictConfirmed',
    ]);
    expect(
      paths(registerJudgementIncidentBodySchema.safeParse({ ...body, noConflictConfirmed: false })),
    ).toEqual(['noConflictConfirmed']);
    for (const schema of [confirmJudgementIncidentBodySchema, dismissJudgementIncidentBodySchema]) {
      const decision = { reason: '확인', noConflictConfirmed: true, expectedAccountId: 'admin-2' };
      expect(schema.parse(decision)).toEqual(decision);
      const { noConflictConfirmed: _gone, ...unconfirmed } = decision;
      expect(paths(schema.safeParse(unconfirmed))).toEqual(['noConflictConfirmed']);
      expect(paths(schema.safeParse({ ...decision, noConflictConfirmed: false }))).toEqual([
        'noConflictConfirmed',
      ]);
    }
  });

  it('takes each corrected result, the description and the evidence, trimmed, extra keys dropped', () => {
    for (const correctedResult of MARKET_RESULTS) {
      expect(
        registerJudgementIncidentBodySchema.parse({
          ...body,
          correctedResult,
          publicNoticeConfirmed: true,
          amountCoin: '100',
        }),
      ).toEqual({
        noConflictConfirmed: true,
        correctedResult,
        description: '발표 원문의 수치를 잘못 읽었다.',
        evidence: { links: [link], collectedAt: at },
        expectedAccountId: 'admin-1',
      });
    }
    for (const bad of ['MAYBE', 'yes', null]) {
      expect(
        paths(registerJudgementIncidentBodySchema.safeParse({ ...body, correctedResult: bad })),
        String(bad),
      ).toEqual(['correctedResult']);
    }
  });

  it('bounds the description and the decisions’ reasons as an approval reason (1–500, trimmed)', () => {
    const max = 'x'.repeat(APPROVAL_REASON_MAX_LENGTH);
    expect(
      registerJudgementIncidentBodySchema.parse({ ...body, description: ` ${max} ` }).description,
    ).toBe(max);
    for (const description of ['', '   ', `${max}x`, undefined]) {
      expect(
        paths(registerJudgementIncidentBodySchema.safeParse({ ...body, description })),
        String(description),
      ).toEqual(['description']);
    }
    for (const schema of [confirmJudgementIncidentBodySchema, dismissJudgementIncidentBodySchema]) {
      const decision = { noConflictConfirmed: true, expectedAccountId: 'admin-2' };
      expect(schema.parse({ ...decision, reason: ' 근거 확인 ' }).reason).toBe('근거 확인');
      for (const reason of ['', ' ', `${max}x`, undefined]) {
        expect(paths(schema.safeParse({ ...decision, reason })), String(reason)).toEqual([
          'reason',
        ]);
      }
    }
  });

  it('takes the judgement’s evidence rule: one to five distinct http(s) links and a storable instant', () => {
    const evidence = (links: string[], collectedAt = at) => ({
      ...body,
      evidence: { links, collectedAt },
    });
    const five = [1, 2, 3, 4, 5].map((n) => `${link}/${String(n)}`);
    expect(registerJudgementIncidentBodySchema.safeParse(evidence(five)).success).toBe(true);
    expect(paths(registerJudgementIncidentBodySchema.safeParse(evidence([])))).toEqual([
      'evidence.links',
    ]);
    expect(
      paths(registerJudgementIncidentBodySchema.safeParse(evidence([...five, `${link}/6`]))),
    ).toEqual(['evidence.links']);
    expect(
      issues(registerJudgementIncidentBodySchema.safeParse(evidence([link, ` ${link}`, link]))),
    ).toEqual(['evidence.links.1: duplicate', 'evidence.links.2: duplicate']);
    const long = `https://example.com/${'a'.repeat(JUDGEMENT_EVIDENCE_LINK_MAX - 19)}`;
    for (const bad of ['', 'javascript:alert(1)', 'ftp://example.com/a', 'bok.or.kr', long]) {
      expect(paths(registerJudgementIncidentBodySchema.safeParse(evidence([bad]))), bad).toEqual([
        'evidence.links.0',
      ]);
    }
    expect(
      issues(
        registerJudgementIncidentBodySchema.safeParse(evidence([link], '0099-12-31T23:59:59.999Z')),
      ),
    ).toEqual([`evidence.collectedAt: ${STORABLE_INSTANT_TOO_EARLY}`]);
    for (const collectedAt of ['2026-11-23', '2026-11-23T12:00:00+09:00']) {
      expect(
        paths(registerJudgementIncidentBodySchema.safeParse(evidence([link], collectedAt))),
        collectedAt,
      ).toEqual(['evidence.collectedAt']);
    }
  });

  it('takes a 철회 with the account alone', () => {
    expect(retractJudgementIncidentBodySchema).toBe(expectedAccountBodySchema);
  });
});

describe('the incident records and read models', () => {
  it('store the request payload frozen at the insert', () => {
    const payload = {
      noConflictConfirmed: true,
      judgementVersion: 2,
      originalResult: 'YES',
      correctedResult: 'VOID',
      evidence: { links: [link], collectedAt: at },
    };
    expect(marketJudgementIncidentRequestPayloadSchema.parse(payload)).toEqual(payload);
    for (const key of Object.keys(payload)) {
      const { [key as keyof typeof payload]: _gone, ...without } = payload;
      expect(marketJudgementIncidentRequestPayloadSchema.safeParse(without).success, key).toBe(
        false,
      );
    }
  });

  it('show the waiting incident, the confirmed one and every registration with how it ended', () => {
    const pending = {
      requestId,
      correctedResult: 'NO',
      description: '수치를 잘못 읽었다.',
      evidence: { links: [link], collectedAt: at },
      requestedBy: registrant,
      requestedAt: at,
    };
    const confirmed = {
      incidentId,
      requestId,
      judgementVersion: 1,
      originalResult: 'YES',
      correctedResult: 'NO',
      description: '수치를 잘못 읽었다.',
      evidence: { links: [link], collectedAt: at },
      registeredBy: registrant,
      confirmedBy: reviewer,
      registeredAt: at,
      confirmedAt: '2026-11-23T04:00:00.000Z',
      reason: '원문을 다시 확인했다.',
    };
    const state = {
      registrable: false,
      confirmable: true,
      pending: null,
      confirmed,
      log: [
        {
          ...pending,
          status: 'approved',
          decidedBy: reviewer,
          decidedAt: confirmed.confirmedAt,
          decisionReason: confirmed.reason,
          retractedAt: null,
        },
        {
          ...pending,
          requestId: incidentId,
          status: 'retracted',
          decidedBy: null,
          decidedAt: null,
          decisionReason: null,
          retractedAt: at,
        },
      ],
      // The 판정 오류 보상's state (ADR-0166, judgement-compensation.test.ts): null before one is
      // confirmed, required either way.
      compensation: null,
    };
    expect(adminMarketJudgementIncidentSchema.parse(state)).toEqual(state);
    expect(
      paths(adminMarketJudgementIncidentSchema.safeParse({ ...state, compensation: undefined })),
    ).toEqual(['compensation']);
    expect(
      adminMarketJudgementIncidentSchema.parse({ ...state, pending, confirmed: null }).pending,
    ).toEqual(pending);
    expect(
      paths(adminMarketJudgementIncidentSchema.safeParse({ ...state, registrable: undefined })),
    ).toEqual(['registrable']);
    const item = {
      kind: 'incident',
      requestId,
      marketId,
      slug: 'market-a',
      title: '시장 A',
      status: 'settling',
      originalResult: 'YES',
      correctedResult: 'NO',
      requestedBy: registrant,
      requestedAt: at,
      accountCount: null,
      totalCoin: null,
    };
    expect(adminMarketJudgementIncidentQueueItemSchema.parse(item)).toEqual(item);
    // #144 part 2 (ADR-0166 T13): a compensation request waits in the same queue, with its count
    // and total — never an account of its list.
    const compensation = {
      ...item,
      kind: 'compensation',
      status: 'settled',
      accountCount: 2,
      totalCoin: '300',
    };
    expect(adminMarketJudgementIncidentQueueItemSchema.parse(compensation)).toEqual(compensation);
    expect(
      paths(adminMarketJudgementIncidentQueueItemSchema.safeParse({ ...item, kind: 'other' })),
    ).toEqual(['kind']);
    expect(
      adminMarketJudgementIncidentQueueItemSchema.safeParse({ ...compensation, accountCount: 0 })
        .success,
    ).toBe(false);
  });

  it('publish only the allowlisted correction fields, no private or excluded name', () => {
    for (const key of Object.keys(publicMarketJudgementCorrectionSchema.shape)) {
      expect(findPrivateField(key), key).toEqual([]);
      expect(findExcludedIdentifier(key, 'api'), key).toEqual([]);
    }
    // The admin record's identities and reasons are not public fields.
    for (const key of ['registeredBy', 'confirmedBy', 'reason', 'incidentId', 'requestId']) {
      expect(publicMarketJudgementCorrectionSchema.shape).not.toHaveProperty(key);
    }
  });
});

describe('the OpenAPI component ids of the incident', () => {
  it('are each named once and convert with the admin market', () => {
    const ids = new Map<string, number>();
    for (const value of Object.values(shared)) {
      if (!(value instanceof z.ZodType)) continue;
      const id = z.globalRegistry.get(value)?.id;
      if (id !== undefined) ids.set(id, (ids.get(id) ?? 0) + 1);
    }
    for (const id of [
      'RegisterJudgementIncidentBody',
      'ConfirmJudgementIncidentBody',
      'DismissJudgementIncidentBody',
      'MarketJudgementIncidentPending',
      'MarketJudgementIncidentConfirmed',
      'MarketJudgementIncidentLogEntry',
      'AdminMarketJudgementIncident',
      'AdminMarketJudgementIncidentQueueItem',
      'PublicMarketJudgementCorrection',
      // #176's admin correction shape keeps its id; the public one is apart.
      'MarketJudgementCorrection',
    ]) {
      expect(ids.get(id), id).toBe(1);
    }
    expect(() =>
      z.toJSONSchema(
        z.object({
          market: shared.adminMarketSchema,
          detail: shared.marketSchema,
          register: registerJudgementIncidentBodySchema,
          confirm: confirmJudgementIncidentBodySchema,
          dismiss: dismissJudgementIncidentBodySchema,
          queue: adminMarketJudgementIncidentQueueItemSchema,
          theme: shared.themeResultSchema,
        }),
      ),
    ).not.toThrow();
  });
});
