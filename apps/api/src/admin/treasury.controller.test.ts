import { randomUUID } from 'node:crypto';
import { lockAdminRoles, schema } from '@buddha/db';
import { completeOnboarding, withLedgerGuardsOff } from '@buddha/db/test';
import {
  adminTreasurySchema,
  treasuryIssuanceSchema,
  treasuryIssueRequestSchema,
  treasuryIssueWriteSchema,
} from '@buddha/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { TreasuryService } from './treasury.service.js';

const base = '/api/v1/admin/treasury';
const origin = 'http://localhost:3000';
const requestReason = 'TREASURY_PRIVATE_REQUEST_REASON';
const approveReason = 'TREASURY_PRIVATE_APPROVAL_REASON';

describe.skipIf(!hasTestInfra)('operating treasury issuance (integration)', () => {
  let t: TestApp;
  let asker: TestUser;
  let decider: TestUser;
  let third: TestUser;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await t.reset();
    asker = await admin();
    decider = await admin();
    third = await admin();
  });
  async function admin() {
    const who = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, who.id));
    await completeOnboarding(t.db, { userId: who.id });
    await t.app.get(AdminGuard).invalidate(who.id);
    return who;
  }
  const post = (path: string, who = asker, body: Record<string, unknown> = {}) =>
    t.app.inject({
      method: 'POST',
      url: `${base}${path}`,
      headers: { origin, cookie: who.cookie },
      payload: { expectedAccountId: who.id, ...body },
    });
  const get = (path = '', who = asker) =>
    t.app.inject({ method: 'GET', url: `${base}${path}`, headers: { cookie: who.cookie } });
  async function request(amountCoin = '1000') {
    const response = await post('/issue-requests', asker, { amountCoin, reason: requestReason });
    expect(response.statusCode, response.body).toBe(200);
    return treasuryIssueWriteSchema.parse(response.json<{ data: unknown }>().data);
  }
  async function approve(id: string, who = decider) {
    return post(`/issue-requests/${id}/approve`, who, { reason: approveReason });
  }
  const mintRows = () =>
    t.db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.type, 'TREASURY_MINT'));
  const result = (response: { json: <T>() => T }) =>
    treasuryIssueWriteSchema.parse(response.json<{ data: unknown }>().data);

  it('reads an uninitialized treasury without creating accounts or approvals', async () => {
    const before = await t.db.select().from(schema.ledgerAccounts);
    const response = await get();
    expect(response.statusCode, response.body).toBe(200);
    expect(adminTreasurySchema.parse(response.json<{ data: unknown }>().data)).toEqual({
      accountId: null,
      status: 'uninitialized',
      availableCoin: null,
      lockedCoin: null,
      ledgerCoin: null,
      issuedCoin: '0',
    });
    expect(await t.db.select().from(schema.ledgerAccounts)).toEqual(before);
    expect(await mintRows()).toEqual([]);
  });

  it('fixes an amount at request time, independently approves it, and records exactly one mint and history', async () => {
    const requested = await request('1000000000000000');
    expect(requested.request).toMatchObject({
      status: 'pending',
      amountCoin: '1000000000000000',
      ledgerEntryId: null,
      requestedBy: { id: asker.id },
    });
    expect(requested.treasury.status).toBe('uninitialized');
    expect(await mintRows()).toHaveLength(0);
    const response = await approve(requested.request.id);
    expect(response.statusCode, response.body).toBe(200);
    const done = result(response);
    expect(done.request).toMatchObject({
      status: 'approved',
      amountCoin: '1000000000000000',
      decidedBy: { id: decider.id },
      decisionReason: approveReason,
    });
    expect(done.treasury).toMatchObject({
      status: 'ready',
      availableCoin: '1000000000000000',
      ledgerCoin: '1000000000000000',
      lockedCoin: '0',
      issuedCoin: '1000000000000000',
    });
    const ledger = await mintRows();
    expect(ledger).toHaveLength(1);
    expect(String(ledger[0]!.id)).toBe(done.request.ledgerEntryId);
    expect(ledger[0]).toMatchObject({
      amountCoin: 1_000_000_000_000_000n,
      refType: 'approval_request',
      refId: requested.request.id,
      fromAccountId: null,
    });
    const history = await get('/history');
    const rows = history
      .json<{ data: unknown[] }>()
      .data.map((row) => treasuryIssuanceSchema.parse(row));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: requested.request.id,
      approvalId: requested.request.id,
      ledgerEntryId: done.request.ledgerEntryId,
      requestReason,
      approvalReason: approveReason,
      requestedBy: { id: asker.id },
      approvedBy: { id: decider.id },
    });
    expect((await approve(requested.request.id, third)).statusCode).toBe(409);
    expect(await mintRows()).toEqual(ledger);
    const audit = await t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetType, 'treasury'));
    expect(audit.map((row) => row.type).sort()).toEqual([
      'treasury_issue_approve',
      'treasury_issue_request',
    ]);
  });

  it('refuses self approval, replacement amounts, wrong identities and malformed Coin before mutation', async () => {
    const { request: pending } = await request();
    expect((await approve(pending.id, asker)).statusCode).toBe(409);
    expect(
      (
        await post(`/issue-requests/${pending.id}/approve`, decider, {
          reason: approveReason,
          amountCoin: '2000',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post(`/issue-requests/${pending.id}/approve`, decider, {
          reason: approveReason,
          expectedAccountId: asker.id,
        })
      ).statusCode,
    ).toBe(403);
    for (const amountCoin of ['0', '-1', '1000000000000001', '1.2', '9'.repeat(1000), 100]) {
      expect(
        (await post('/issue-requests', asker, { amountCoin, reason: requestReason })).statusCode,
      ).toBe(400);
    }
    expect(await mintRows()).toHaveLength(0);
    expect(
      (await t.db.select().from(schema.approvalRequests)).filter(
        (row) => row.kind === 'treasury_issue',
      ),
    ).toHaveLength(1);
  });

  it('allows only another administrator to reject and only the requester to retract, without money', async () => {
    const first = await request();
    expect(
      (await post(`/issue-requests/${first.request.id}/reject`, asker, { reason: 'self' }))
        .statusCode,
    ).toBe(409);
    expect((await post(`/issue-requests/${first.request.id}/retract`, decider)).statusCode).toBe(
      409,
    );
    const rejected = await post(`/issue-requests/${first.request.id}/reject`, decider, {
      reason: 'Unnecessary reserve',
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(result(rejected).request.status).toBe('rejected');
    const second = await request();
    const retracted = await post(`/issue-requests/${second.request.id}/retract`);
    expect(retracted.statusCode, retracted.body).toBe(200);
    expect(result(retracted).request.status).toBe('retracted');
    expect(await mintRows()).toEqual([]);
    expect((await get('/history')).json<{ data: unknown[] }>().data).toEqual([]);
  });

  it('keeps damaged treasury pending on approval and permits cleanup without changing damaged assets', async () => {
    const initial = await request();
    expect((await approve(initial.request.id)).statusCode).toBe(200);
    const first = await request('20');
    const second = await request('30');
    await withLedgerGuardsOff((client) =>
      client.query(
        "UPDATE balances SET available_coin=available_coin-10 WHERE account_id IN (SELECT id FROM ledger_accounts WHERE kind='treasury')",
      ),
    );
    const before = await t.db.select().from(schema.balances);
    const ledger = await mintRows();
    const refused = await approve(first.request.id);
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json<{ error: { details: unknown } }>().error.details).toEqual([
      { path: ['treasuryIssue'], message: 'treasury_inconsistent' },
    ]);
    expect(
      treasuryIssueRequestSchema.parse(
        (await get(`/issue-requests/${first.request.id}`)).json<{ data: unknown }>().data,
      ).status,
    ).toBe('pending');
    const rejected = await post(`/issue-requests/${first.request.id}/reject`, decider, {
      reason: 'Repair books first',
    });
    const retracted = await post(`/issue-requests/${second.request.id}/retract`);
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(retracted.statusCode, retracted.body).toBe(200);
    expect(result(rejected).treasury.status).toBe('inconsistent');
    expect(await t.db.select().from(schema.balances)).toEqual(before);
    expect(await mintRows()).toEqual(ledger);
  });

  it('serializes simultaneous independent approvals to one actual issuance', async () => {
    const { request: pending } = await request();
    const responses = await Promise.all([approve(pending.id), approve(pending.id, third)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(await mintRows()).toHaveLength(1);
    expect(await t.db.select().from(schema.treasuryIssuances)).toHaveLength(1);
    expect(
      await t.db
        .select()
        .from(schema.adminActions)
        .where(eq(schema.adminActions.type, 'treasury_issue_approve')),
    ).toHaveLength(1);
  });

  it('rolls approval, mint, account creation and audit back if the authoritative response fails', async () => {
    const { request: pending } = await request();
    const service = t.app.get(TreasuryService);
    const spy = vi
      .spyOn(service as unknown as { writeSnapshot: () => Promise<unknown> }, 'writeSnapshot')
      .mockRejectedValueOnce(new Error('response fixture rollback'));
    try {
      expect((await approve(pending.id)).statusCode).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await mintRows()).toEqual([]);
    expect(await t.db.select().from(schema.treasuryIssuances)).toEqual([]);
    expect(
      await t.db
        .select()
        .from(schema.ledgerAccounts)
        .where(eq(schema.ledgerAccounts.kind, 'treasury')),
    ).toEqual([]);
    expect(
      treasuryIssueRequestSchema.parse(
        (await get(`/issue-requests/${pending.id}`)).json<{ data: unknown }>().data,
      ).status,
    ).toBe('pending');
    expect(
      await t.db
        .select()
        .from(schema.adminActions)
        .where(eq(schema.adminActions.type, 'treasury_issue_approve')),
    ).toEqual([]);
  });

  it('checks both roles afresh and refuses a request with no independent current approver', async () => {
    const { request: pending } = await request();
    await t.db.transaction(async (tx) => {
      await lockAdminRoles(tx, 'exclusive');
      await tx
        .update(schema.profiles)
        .set({ role: 'user' })
        .where(eq(schema.profiles.userId, asker.id));
    });
    // Keep the requester's AdminGuard cache stale deliberately; the transaction is authoritative.
    expect((await post(`/issue-requests/${pending.id}/retract`)).statusCode).toBe(403);
    expect((await approve(pending.id)).statusCode).toBe(400);
    expect(await mintRows()).toEqual([]);
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(eq(schema.profiles.userId, third.id));
    const response = await post('/issue-requests', decider, {
      amountCoin: '10',
      reason: requestReason,
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ error: { details: unknown } }>().error.details).toEqual([
      { path: ['request'], message: 'no_decider' },
    ]);
  });

  it('returns only own-kind requests with stable cursor pages, and never exposes admin records to members', async () => {
    const a = await request('10');
    const b = await request('20');
    const c = await request('30');
    await post(`/issue-requests/${b.request.id}/retract`);
    const unrelated = await t.db
      .insert(schema.approvalRequests)
      .values({
        kind: 'unrelated',
        requestedAt: new Date(),
        requestedBy: asker.id,
        requestReason: 'different action',
        targetType: 'treasury',
        targetId: 'treasury',
        payload: { amountCoin: '999' },
      })
      .returning();
    expect((await get(`/issue-requests/${unrelated[0]!.id}`)).statusCode).toBe(404);
    expect((await approve(unrelated[0]!.id)).statusCode).toBe(404);
    const page1 = await get('/issue-requests?status=all&limit=2');
    const first = page1.json<{ data: { id: string }[]; meta: { nextCursor: string } }>();
    const page2 = await get(
      `/issue-requests?status=all&limit=2&cursor=${encodeURIComponent(first.meta.nextCursor)}`,
    );
    expect(
      [...first.data, ...page2.json<{ data: { id: string }[] }>().data].map((row) => row.id).sort(),
    ).toEqual([a.request.id, b.request.id, c.request.id].sort());
    expect(
      (await get('/issue-requests'))
        .json<{ data: { id: string }[] }>()
        .data.map((row) => row.id)
        .sort(),
    ).toEqual([a.request.id, c.request.id].sort());
    expect((await get(`/issue-requests/${randomUUID()}`)).statusCode).toBe(404);
    const member = await signUpTestUser(t);
    for (const path of ['', '/issue-requests', '/history', `/issue-requests/${a.request.id}`]) {
      expect((await get(path, member)).statusCode).toBe(403);
      const anonymous = await t.app.inject({ method: 'GET', url: `${base}${path}` });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.body).not.toContain(requestReason);
    }
    expect(
      await t.db
        .select()
        .from(schema.adminActions)
        .where(
          and(
            eq(schema.adminActions.type, 'treasury_issue_request'),
            eq(schema.adminActions.adminId, asker.id),
          ),
        ),
    ).toHaveLength(3);
  });
});
