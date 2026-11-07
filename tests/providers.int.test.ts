/**
 * Real providers with the network stubbed: Brevo (email + delivery webhook) and Razorpay (plan purchase and wallet
 * recharge: Checkout verify, webhook, signature checks, exactly-once credit).
 */
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, as, err, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { clock, istToday } from '../src/lib/clock.js';
import { env } from '../src/config/env.js';
import { Account } from '../src/modules/accounts/account.model.js';
import { Customer } from '../src/modules/customers/customer.model.js';
import { BouncedAddress, Outbox, WalletTxn } from '../src/modules/comms/outbox.model.js';
import { ensureSystemTemplates, resetSeeded, sendDue } from '../src/modules/comms/comms.service.js';
import { SubscriptionOrder } from '../src/modules/admin/admin.model.js';

const E = env as unknown as Record<string, unknown>;
const saved = { ...E };
beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => {
  clock.setOffset(0); resetSeeded(); await resetState();
  Object.assign(E, {
    EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'xkeysib-test', EMAIL_FROM_ADDRESS: 'hello@bimayantra.in', EMAIL_FROM_NAME: 'Bimayantra', BREVO_WEBHOOK_TOKEN: 'brevo-hook-token-0123456789abcdef',
    PAYMENT_GATEWAY: 'razorpay', RAZORPAY_KEY_ID: 'rzp_test_abc', RAZORPAY_KEY_SECRET: 'rzp-secret', RAZORPAY_WEBHOOK_SECRET: 'rzp-webhook-secret', PAYMENT_DISPLAY_NAME: 'Bimayantra',
  });
});
afterEach(() => { vi.unstubAllGlobals(); Object.assign(E, saved); });

type Route = [RegExp, (url: string, init?: RequestInit) => { status?: number; body: unknown }];
function net(routes: Route[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = routes.find(([re]) => re.test(url));
    const out = r ? r[1](url, init) : { status: 404, body: { error: { description: 'no route' } } };
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}
const sig = (secret: string, s: string) => createHmac('sha256', secret).update(s).digest('hex');

describe('Brevo email', () => {
  async function queued() {
    const adv = await registerAdvisor('Asha Rao');
    const cus = (await as(adv.token).post('/customers', { name: 'Meena Iyer', mobile: newMobile(), email: 'meena@example.com' })).body.data;
    const accountId = (await Customer.findById(cus.id).lean())!.accountId;
    await ensureSystemTemplates();
    await Outbox.create({ accountId, customerId: cus.id, personKey: `C:${cus.id}`, channel: 'EMAIL', purpose: 'QUOTATION_EMAIL', template: 'QT-EMAIL', params: { 'customer name': 'Meena', 'quotation number': 'QT-1 R1', link: 'https://app.bimayantra.in/q/x', 'advisor name': 'Asha', 'advisor mobile': '98' }, to: 'meena@example.com', text: 'x', occurrenceKey: 'b1', day: istToday() });
  }

  it('sends through Brevo with the verified sender; delivered → opened move forward; a hard bounce blocks the address; a wrong token is refused', async () => {
    await queued();
    const calls = net([[/api\.brevo\.com\/v3\/smtp\/email/, () => ({ status: 201, body: { messageId: '<m1@smtp-relay.brevo.com>' } })]]);
    expect((await sendDue()).sent).toBe(1);
    const sent = JSON.parse(String(calls[0]!.init!.body));
    expect(calls[0]!.init!.headers).toMatchObject({ 'api-key': 'xkeysib-test' });
    expect(sent).toMatchObject({ sender: { email: 'hello@bimayantra.in', name: 'Bimayantra' }, to: [{ email: 'meena@example.com' }] });
    expect(sent.htmlContent).toContain('<a href="https://app.bimayantra.in/q/x">');
    expect(await Outbox.findOne({ occurrenceKey: 'b1' }).lean()).toMatchObject({ status: 'SENT', providerMessageId: '<m1@smtp-relay.brevo.com>' });

    const hook = (body: object, token = env.BREVO_WEBHOOK_TOKEN!) => request(app).post(`/v1/webhooks/brevo/${token}`).send(body);
    expect((await hook({ event: 'delivered', 'message-id': '<m1@smtp-relay.brevo.com>' }, 'wrong-token-0123456789abcdef-x')).status).toBe(403);
    await hook({ event: 'delivered', 'message-id': '<m1@smtp-relay.brevo.com>', email: 'meena@example.com', ts_event: 1 });
    expect((await Outbox.findOne({ occurrenceKey: 'b1' }).lean())!.status).toBe('DELIVERED');
    await hook({ event: 'opened', 'message-id': '<m1@smtp-relay.brevo.com>', email: 'meena@example.com', ts_event: 2 });
    expect((await Outbox.findOne({ occurrenceKey: 'b1' }).lean())!.status).toBe('READ');
    await hook({ event: 'delivered', 'message-id': '<m1@smtp-relay.brevo.com>', email: 'meena@example.com', ts_event: 3 }); // late: never backwards
    expect((await Outbox.findOne({ occurrenceKey: 'b1' }).lean())!.status).toBe('READ');
    await hook({ event: 'hard_bounce', 'message-id': '<m9@x>', email: 'Meena@Example.com', reason: 'mailbox does not exist', ts_event: 4 });
    expect(await BouncedAddress.findById('meena@example.com').lean()).toBeTruthy();
  });

  it('a 400 from Brevo fails at once with its reason; a 503 is retried', async () => {
    await queued();
    net([[/api\.brevo\.com/, () => ({ status: 503, body: { message: 'Service unavailable' } })]]);
    expect((await sendDue()).retry).toBe(1);
    await Outbox.updateOne({ occurrenceKey: 'b1' }, { $set: { nextAttemptAt: null } });
    net([[/api\.brevo\.com/, () => ({ status: 400, body: { code: 'invalid_parameter', message: 'email is not valid' } })]]);
    expect((await sendDue()).failed).toBe(1);
    expect(await Outbox.findOne({ occurrenceKey: 'b1' }).lean()).toMatchObject({ status: 'FAILED', skipReason: 'email is not valid' });
  });
});

describe('Razorpay', () => {
  async function advisor(premium = false) {
    const adv = await registerAdvisor('Asha Rao');
    if (premium) await Account.updateOne({ _id: adv.user.accountId }, { $set: { 'subscription.plan': 'PREMIUM', 'subscription.status': 'ACTIVE', 'subscription.endsAt': new Date(Date.now() + 365 * 86_400_000) } });
    return { adv, A: as(adv.token) };
  }

  it('plan purchase: the order carries Checkout details; a valid Checkout signature + captured payment activates once; a forged signature changes nothing', async () => {
    const { A } = await advisor();
    let amount = 0;
    net([
      [/\/v1\/orders$/, (_u, init) => { amount = JSON.parse(String(init!.body)).amount; return { body: { id: 'order_PLAN01', amount, currency: 'INR', status: 'created', receipt: 'x' } }; }],
      [/\/v1\/payments\/pay_PLAN01$/, () => ({ body: { id: 'pay_PLAN01', order_id: 'order_PLAN01', amount, currency: 'INR', status: 'authorized' } })],
      [/\/v1\/payments\/pay_PLAN01\/capture$/, () => ({ body: { id: 'pay_PLAN01', order_id: 'order_PLAN01', amount, currency: 'INR', status: 'captured' } })],
    ]);
    const o = (await A.post('/billing/orders', { plan: 'NORMAL', cycle: 'YEARLY' })).body.data;
    expect(o).toMatchObject({ gateway: 'razorpay', keyId: 'rzp_test_abc', razorpayOrderId: 'order_PLAN01', amountPaise: o.totalPaise, currency: 'INR', name: 'Bimayantra' });
    const forged = await A.post(`/billing/orders/${o.orderId}/verify`, { razorpayOrderId: 'order_PLAN01', razorpayPaymentId: 'pay_PLAN01', razorpaySignature: 'a'.repeat(64) });
    expect(err(forged)).toMatchObject({ status: 400, code: 'PAYMENT_NOT_VERIFIED' });
    const ok = await A.post(`/billing/orders/${o.orderId}/verify`, { razorpayOrderId: 'order_PLAN01', razorpayPaymentId: 'pay_PLAN01', razorpaySignature: sig('rzp-secret', 'order_PLAN01|pay_PLAN01') });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('SUCCESS');
    expect((await A.get('/billing')).body.data).toMatchObject({ plan: 'NORMAL', status: 'ACTIVE' });
    // the webhook for the same payment is a no-op
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_PLAN01', order_id: 'order_PLAN01', amount, currency: 'INR', status: 'captured' } } } });
    await request(app).post('/v1/webhooks/razorpay').set('Content-Type', 'application/json').set('X-Razorpay-Signature', sig('rzp-webhook-secret', body)).set('X-Razorpay-Event-Id', 'ev1').send(body);
    expect(await SubscriptionOrder.countDocuments({ status: 'SUCCESS' })).toBe(1);
  });

  it('wallet recharge: if the browser closes, the signed webhook credits once; a repeated or forged webhook changes nothing; a wrong amount is ignored', async () => {
    const { A, adv } = await advisor(true);
    net([[/\/v1\/orders$/, (_u, init) => ({ body: { id: 'order_WAL01', amount: JSON.parse(String(init!.body)).amount, currency: 'INR', status: 'created', receipt: 'x' } })]]);
    const r = (await A.post('/wallet/recharge', { amount: 500 })).body.data;
    expect(r).toMatchObject({ gateway: 'razorpay', razorpayOrderId: 'order_WAL01', amountPaise: 50000 });
    const send = (entity: object, id: string, secret = 'rzp-webhook-secret') => {
      const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity } } });
      return request(app).post('/v1/webhooks/razorpay').set('Content-Type', 'application/json').set('X-Razorpay-Signature', sig(secret, body)).set('X-Razorpay-Event-Id', id).send(body);
    };
    expect((await send({ id: 'pay_W1', order_id: 'order_WAL01', amount: 50000, currency: 'INR', status: 'captured' }, 'f1', 'wrong')).status).toBe(403);
    expect((await send({ id: 'pay_W0', order_id: 'order_WAL01', amount: 100, currency: 'INR', status: 'captured' }, 'a0')).body.data).toMatchObject({ ignored: 'amount does not match' });
    await send({ id: 'pay_W1', order_id: 'order_WAL01', amount: 50000, currency: 'INR', status: 'captured' }, 'w1');
    await send({ id: 'pay_W1', order_id: 'order_WAL01', amount: 50000, currency: 'INR', status: 'captured' }, 'w2'); // repeated with a new id
    expect((await Account.findById(adv.user.accountId).lean())?.wallet?.balancePaise).toBe(50000);
    expect(await WalletTxn.findOne({ _id: r.orderId }).lean()).toMatchObject({ status: 'SUCCESS', gatewayPaymentId: 'pay_W1' });
    expect((await A.get('/wallet')).body.data.balance).toBe(500);
  });
});