/**
 * The 재통보 sender check as production runs it (ADR-0042): behind Caddy, whose fixed compose
 * address is the one TRUST_PROXY names (terraform env.tftpl), so `request.ip` is the address
 * Caddy puts in X-Forwarded-For — SmartroPay's server — and never one a client made up.
 *
 * Its own file because its app trusts the proxy: the packages/db file lock allows one live test
 * app per file, and every other suite runs with nothing trusted (the socket peer). Skips when
 * TEST_* are unset.
 */
import { schema } from '@buddha/db';
import { SIGNUP_BONUS_P } from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../../test/app.js';
import { expectLedgerChain } from '../../test/ledger.js';
import { hasTestInfra } from '../../test/setup-env.js';
import {
  FORM_HEADERS,
  FakeSmartroClient,
  TEST_NOTIFY_IP,
  formBody,
  notifyForm,
  reserveSmartroPayment,
  testTid,
} from '../../test/smartro.js';

/** Caddy on the compose network (deploy/compose.yaml IPAM), the only trusted hop. */
const CADDY = '172.28.0.10';
const STRANGER = '203.0.113.7';

describe.skipIf(!hasTestInfra)('SmartroPay 재통보 behind the proxy (integration)', () => {
  let t: TestApp;
  const pg = new FakeSmartroClient();
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp({ smartro: { client: pg }, trustProxy: `${CADDY}/32` });
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    pg.reset();
    user = await signUpTestUser(t);
  });

  const postNotify = (
    fields: Record<string, string>,
    remoteAddress: string,
    forwardedFor?: string,
  ) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/smartro/notify',
      headers: {
        ...FORM_HEADERS,
        ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
      },
      payload: formBody(fields),
      remoteAddress,
    });

  /** A claimed `pending` payment and the approval notice SmartroPay would send for it. */
  async function claimedPayment() {
    const claim = testTid();
    const payment = await reserveSmartroPayment(t.db, user.id, { claimedBy: claim });
    const tid = testTid();
    return {
      payment,
      claim,
      tid,
      form: notifyForm({ paymentId: payment.id, priceKrw: payment.priceKrw, tid }),
    };
  }

  async function paymentRow(id: string) {
    const [row] = await t.db.select().from(schema.payments).where(eq(schema.payments.id, id));
    return row!;
  }

  async function ledgerOf(userId: string) {
    return t.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.userId, userId))
      .orderBy(asc(schema.ledgerEntries.id));
  }

  async function eventsOf(paymentId: string) {
    return t.db
      .select()
      .from(schema.paymentEvents)
      .where(eq(schema.paymentEvents.paymentId, paymentId));
  }

  it("credits a notice Caddy forwards from SmartroPay's server", async () => {
    const { payment, tid, form } = await claimedPayment();
    const res = await postNotify(form, CADDY, TEST_NOTIFY_IP);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('OK');
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'succeeded', providerRef: tid });
    const ledger = await ledgerOf(user.id);
    expect(ledger.filter((entry) => entry.type === 'DEPOSIT')).toHaveLength(1);
    expectLedgerChain(ledger, SIGNUP_BONUS_P + 10_000n);
  });

  it.each([
    // Straight to the API, claiming SmartroPay's address: not a trusted hop, so not believed.
    ['a stranger naming SmartroPay', STRANGER, TEST_NOTIFY_IP],
    // A client-supplied header Caddy appended to: the address Caddy saw is the stranger's.
    ['a forged header behind Caddy', CADDY, `${TEST_NOTIFY_IP}, ${STRANGER}`],
    // Caddy itself, with nothing forwarded: Caddy is not SmartroPay.
    ['the proxy with no header', CADDY, undefined],
  ])('refuses %s (403, nothing recorded)', async (_case, remoteAddress, forwardedFor) => {
    const { payment, claim, form } = await claimedPayment();
    const res = await postNotify(form, remoteAddress, forwardedFor);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('OK');
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'pending', providerRef: claim });
    expect(await eventsOf(payment.id)).toHaveLength(0);
    expect(await ledgerOf(user.id)).toHaveLength(1);
  });
});
