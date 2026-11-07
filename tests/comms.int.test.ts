/** Module 14 — P-39 templates, P-40/P-41 greetings, P-42 webhooks, P-43 communications, P-56 wallet. */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, seedAdmin, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { clock, istToday } from '../src/lib/clock.js';
import { normalizeMobile } from '../src/lib/phone.js';
import { Account } from '../src/modules/accounts/account.model.js';
import { Consent, Customer } from '../src/modules/customers/customer.model.js';
import { User } from '../src/modules/users/user.model.js';
import { MessageTemplate, Outbox, WalletTxn } from '../src/modules/comms/outbox.model.js';
import { devProvider, ensureSystemTemplates, resetSeeded, runGreetingJob, sendDue, sign } from '../src/modules/comms/comms.service.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => { clock.setOffset(0); devProvider.setFailMode('none'); resetSeeded(); await resetState(); });

/** Move the test clock to {h}:00 IST today (the WhatsApp window is 09:00–20:00). */
const atIST = (h: number) => { const ist = new Date(Date.now() + 5.5 * 3_600_000); const target = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), h, 0) - 5.5 * 3_600_000; clock.setOffset(target - Date.now()); };
const webhook = (body: object, signature?: string) => { const raw = JSON.stringify(body); return request(app).post('/v1/webhooks/messages').set('Content-Type', 'application/json').set('X-Bimayantra-Signature', signature ?? sign(raw)).send(raw); };

async function world(opts: { premium?: boolean; balance?: number } = {}) {
  const adv = await registerAdvisor('Asha Rao');
  const A = as(adv.token);
  const today = istToday();
  const cus = (await A.post('/customers', { name: 'Meena Iyer', mobile: newMobile(), email: 'meena@example.com', dob: `${today.slice(8, 10)}-${today.slice(5, 7)}-1986` })).body.data;
  const accountId = (await Customer.findById(cus.id).lean())!.accountId;
  if (opts.premium) await Account.updateOne({ _id: accountId }, { $set: { 'subscription.plan': 'PREMIUM', 'subscription.status': 'ACTIVE', 'subscription.endsAt': new Date(Date.now() + 365 * 86_400_000), 'wallet.balancePaise': opts.balance ?? 100000 } });
  await Consent.create({ accountId, personKey: `C:${cus.id}`, customerId: cus.id, channel: 'WHATSAPP', status: 'GIVEN', recordedAt: new Date() });
  await ensureSystemTemplates();
  return { adv, A, cus, accountId };
}
type W = Awaited<ReturnType<typeof world>>;
async function greetingsOn(w: W) {
  const g = (await w.A.get('/greetings')).body.data;
  const pick = (p: string) => g.choices.find((c: { purpose: string }) => c.purpose === p).id;
  return w.A.put('/greetings', { on: true, templates: { BIRTHDAY: pick('BIRTHDAY'), FAMILY_BIRTHDAY: pick('FAMILY_BIRTHDAY'), ANNIVERSARY: pick('ANNIVERSARY') }, excluded: [] });
}
async function staff() { const m = newMobile(); await User.create({ accountId: null, role: 'STF', name: 'Meena Staff', mobile: normalizeMobile(m), status: 'ACTIVE', activatedAt: new Date() }); return { mobile: m, ...(await login(m)) }; }

describe('P-39 templates', () => {
  it('no admin approval: publishing needs the OTP; COM-03 unknown variables; AC-P39-1 a WhatsApp template is usable only after Meta approves (COM-01); a Meta rejection keeps the reason and can be fixed and resubmitted', async () => {
    const s = await staff();
    const otp = async () => ({ 'X-Step-Up-Token': await stepUp(s.token, s.mobile) });
    const bad = await as(s.token).post('/admin/comms/templates', { name: 'Birthday 2', channel: 'WHATSAPP', purpose: 'BIRTHDAY', body: 'Hi {name}, {policy number}' });
    expect(bad.body.error.fields[0]).toMatchObject({ messageId: 'COM-03' });
    const t = (await as(s.token).post('/admin/comms/templates', { name: 'Birthday 2', channel: 'WHATSAPP', purpose: 'BIRTHDAY', body: 'Many happy returns, {name}! – {advisor name}' })).body.data;
    await MessageTemplate.updateOne({ status: 'ACTIVE', purpose: 'BIRTHDAY' }, { $set: { status: 'INACTIVE' } }); // make room (COM-05)
    expect(err(await as(s.token).post(`/admin/comms/templates/${t._id}/submit`, {}))).toMatchObject({ status: 403, messageId: 'AUTH-26' });
    const sent = await as(s.token).post(`/admin/comms/templates/${t._id}/submit`, {}, await otp());
    expect(sent.body.meta.message).toBe('Template sent to Meta for approval. The status will update here when Meta replies.');
    expect((await MessageTemplate.findById(t._id).lean())!.status).toBe('PENDING_APPROVAL'); // not usable until Meta says yes
    await webhook({ eventId: 'tpl-r', type: 'TEMPLATE', templateId: t._id, decision: 'REJECTED', reason: 'Promotional wording' });
    expect(await MessageTemplate.findById(t._id).lean()).toMatchObject({ status: 'REJECTED', metaReason: 'Promotional wording' });
    const again = await as(s.token).post(`/admin/comms/templates/${t._id}/submit`, {}, await otp()); // fix and resubmit
    expect(again.status).toBe(200);
    await webhook({ eventId: 'tpl-1', type: 'TEMPLATE', templateId: t._id, decision: 'APPROVED' });
    expect((await MessageTemplate.findById(t._id).lean())!.status).toBe('ACTIVE');
    // an email template is live at once
    const e = (await as(s.token).post('/admin/comms/templates', { name: 'Plan notice', channel: 'EMAIL', purpose: 'SUBSCRIPTION', body: 'Hello {advisor name}' })).body.data;
    const live = await as(s.token).post(`/admin/comms/templates/${e._id}/submit`, {}, await otp());
    expect(live.body.meta.message).toBe('Plan notice published.');
    expect((await MessageTemplate.findById(e._id).lean())!.status).toBe('ACTIVE');
  });

  it('AC-P39-3: deactivating a template skips its queued messages', async () => {
    const w = await world();
    await Outbox.create({ accountId: w.accountId, customerId: w.cus.id, personKey: `C:${w.cus.id}`, channel: 'EMAIL', purpose: 'QUOTATION_EMAIL', template: 'QT-EMAIL', params: {}, to: 'meena@example.com', text: 'x', occurrenceKey: 'k1', day: istToday() });
    await MessageTemplate.updateOne({ purpose: 'QUOTATION_EMAIL', status: 'ACTIVE' }, { $set: { status: 'INACTIVE' } });
    await sendDue();
    expect(await Outbox.findOne({ occurrenceKey: 'k1' }).lean()).toMatchObject({ status: 'SKIPPED', skipReason: 'Template not active' });
  });
});

describe('P-40 / P-41 greetings', () => {
  it('a Normal account sees SUB-01; COM-09 without templates; AC-P41-1 one greeting per year even when the job runs twice; AC-P41-6 SENT, never DELIVERED', async () => {
    const n = await world();
    expect((await n.A.get('/greetings')).body.data).toMatchObject({ available: false, messageId: 'SUB-01' });
    await resetState(); resetSeeded();
    const w = await world({ premium: true });
    expect(err(await w.A.put('/greetings', { on: true, templates: {}, excluded: [] }))).toMatchObject({ messageId: 'COM-09' });
    expect((await greetingsOn(w)).body.meta.message).toBe('Greeting settings saved.');
    expect((await w.A.get('/greetings')).body.data.upcoming[0]).toMatchObject({ name: 'Meena Iyer', occasion: 'BIRTHDAY' });
    expect(await runGreetingJob()).toMatchObject({ queued: 1 });
    expect(await runGreetingJob()).toMatchObject({ queued: 0 });
    atIST(10);
    expect((await sendDue()).sent).toBe(1);
    const m = await Outbox.findOne({ purpose: 'BIRTHDAY' }).lean();
    expect(m).toMatchObject({ status: 'SENT', channel: 'WHATSAPP' });
    expect(devProvider.inbox[0]!.text).toBe('Happy birthday, Meena! Wishing you good health and happiness. – Asha Rao');
  });

  it('AC-P41-2 consent withdrawn after queueing cancels it; AC-P41-3 a plan downgrade cancels it; AC-P41-4 nothing outside 09:00–20:00; COM-08 off cancels queued', async () => {
    const w = await world({ premium: true });
    await greetingsOn(w);
    await runGreetingJob();
    atIST(21);
    expect((await sendDue()).sent).toBe(0); // outside the window: stays queued
    expect((await Outbox.findOne({ purpose: 'BIRTHDAY' }).lean())!.status).toBe('QUEUED');
    await Consent.updateOne({ personKey: `C:${w.cus.id}`, channel: 'WHATSAPP' }, { $set: { status: 'WITHDRAWN' } });
    atIST(10);
    await sendDue();
    expect(await Outbox.findOne({ purpose: 'BIRTHDAY' }).lean()).toMatchObject({ status: 'SKIPPED', skipReason: 'Consent withdrawn' });
    // plan downgrade
    await Outbox.deleteMany({}); await Consent.updateOne({ personKey: `C:${w.cus.id}` }, { $set: { status: 'GIVEN' } });
    clock.setOffset(0); await runGreetingJob();
    await Account.updateOne({ _id: w.accountId }, { $set: { 'subscription.plan': 'NORMAL' } });
    atIST(10); await sendDue();
    expect(await Outbox.findOne({ purpose: 'BIRTHDAY' }).lean()).toMatchObject({ status: 'SKIPPED', skipReason: 'Not on the Premium plan' });
    // switching off cancels queued greetings
    await Outbox.deleteMany({}); await Account.updateOne({ _id: w.accountId }, { $set: { 'subscription.plan': 'PREMIUM' } });
    clock.setOffset(0); await runGreetingJob();
    const off = await w.A.put('/greetings', { on: false, templates: {}, excluded: [] });
    expect(off.body.meta.message).toBe('Automatic greetings are off. Queued greetings have been cancelled.');
    expect((await Outbox.findOne({ purpose: 'BIRTHDAY' }).lean())!.status).toBe('CANCELLED');
  });
});

describe('P-42 webhooks', () => {
  async function sentEmail(w: W) {
    await Outbox.create({ accountId: w.accountId, customerId: w.cus.id, personKey: `C:${w.cus.id}`, channel: 'EMAIL', purpose: 'QUOTATION_EMAIL', template: 'QT-EMAIL', params: { 'customer name': 'Meena' }, to: 'meena@example.com', text: 'x', occurrenceKey: `e-${Math.random()}`, day: istToday() });
    await sendDue();
    return (await Outbox.findOne({ status: 'SENT' }).lean())!;
  }
  it('AC-P42-1 a forged webhook changes nothing; AC-P42-2 a late DELIVERED after READ stays READ; repeated events are processed once', async () => {
    const w = await world();
    const m = await sentEmail(w);
    expect((await webhook({ eventId: 'f1', type: 'STATUS', providerMessageId: m.providerMessageId, status: 'READ' }, 'deadbeef'.repeat(8))).status).toBe(403);
    expect((await Outbox.findById(m._id).lean())!.status).toBe('SENT');
    await webhook({ eventId: 'e1', type: 'STATUS', providerMessageId: m.providerMessageId, status: 'READ' });
    await webhook({ eventId: 'e2', type: 'STATUS', providerMessageId: m.providerMessageId, status: 'DELIVERED' });
    expect((await Outbox.findById(m._id).lean())!.status).toBe('READ');
    expect((await webhook({ eventId: 'e2', type: 'STATUS', providerMessageId: m.providerMessageId, status: 'DELIVERED' })).body.data.processed).toBe(false);
  });

  it('AC-P42-3 STOP withdraws WhatsApp consent and cancels queued messages; AC-P42-4 a hard bounce stops emails; SENT without update → STATUS_UNKNOWN', async () => {
    const w = await world();
    const mobile = (await Customer.findById(w.cus.id).lean())!.mobile;
    await Outbox.create({ accountId: w.accountId, customerId: w.cus.id, personKey: `C:${w.cus.id}`, channel: 'WHATSAPP', purpose: 'RENEWAL_REMINDER', template: 'REN-T1', params: {}, to: mobile, text: 'x', occurrenceKey: 'wa1', day: istToday() });
    await webhook({ eventId: 's1', type: 'STOP', from: mobile });
    expect((await Consent.findOne({ personKey: `C:${w.cus.id}`, channel: 'WHATSAPP' }).lean())!.status).toBe('WITHDRAWN');
    expect(await Outbox.findOne({ occurrenceKey: 'wa1' }).lean()).toMatchObject({ status: 'SKIPPED', skipReason: 'Consent withdrawn' });
    const m = await sentEmail(w);
    await webhook({ eventId: 'b1', type: 'BOUNCE', address: 'Meena@Example.com', providerMessageId: m.providerMessageId });
    await Outbox.create({ accountId: w.accountId, customerId: w.cus.id, personKey: `C:${w.cus.id}`, channel: 'EMAIL', purpose: 'QUOTATION_EMAIL', template: 'QT-EMAIL', params: {}, to: 'meena@example.com', text: 'x', occurrenceKey: 'after-bounce', day: istToday() });
    await sendDue();
    expect(await Outbox.findOne({ occurrenceKey: 'after-bounce' }).lean()).toMatchObject({ status: 'SKIPPED', skipReason: 'Email address bounced' });
    const m2 = await Outbox.create({ accountId: w.accountId, customerId: w.cus.id, channel: 'EMAIL', purpose: 'QUOTATION_EMAIL', template: 'QT-EMAIL', params: {}, to: 'other@example.com', text: 'x', occurrenceKey: 'old', status: 'SENT', sentAt: new Date(Date.now() - 25 * 3_600_000), day: istToday() });
    await sendDue();
    expect((await Outbox.findById(m2._id).lean())!.status).toBe('STATUS_UNKNOWN');
  });
});

describe('P-43 communications', () => {
  it('AC-P43-1 reasons shown; cancel (COM-10); AC-P43-2 one resend (COM-11, then COM-12); AC-P43-3 refused after withdrawal; AC-P43-4 isolation', async () => {
    const w = await world();
    devProvider.setFailMode('permanent');
    await Outbox.create({ accountId: w.accountId, customerId: w.cus.id, personKey: `C:${w.cus.id}`, channel: 'EMAIL', purpose: 'QUOTATION_EMAIL', template: 'QT-EMAIL', params: {}, to: 'meena@example.com', text: 'x', occurrenceKey: 'q1', day: istToday() });
    await sendDue();
    devProvider.setFailMode('none');
    const failed = (await w.A.get('/communications?tab=failed')).body.data;
    expect(failed[0]).toMatchObject({ status: 'FAILED', reason: 'Rejected by provider', customer: 'Meena Iyer' });
    const r1 = await w.A.post(`/communications/${failed[0].id}/resend`, {});
    expect(r1.body.meta.message).toBe('Message queued again. Its status will update here.');
    expect(err(await w.A.post(`/communications/${failed[0].id}/resend`, {}))).toMatchObject({ messageId: 'COM-12' });
    const queued = (await w.A.get('/communications?tab=scheduled')).body.data;
    expect((await w.A.post(`/communications/${queued[0].id}/cancel`, {})).body.meta.message).toBe('Message cancelled.');
    expect(err(await w.A.post(`/communications/${queued[0].id}/cancel`, {}))).toMatchObject({ messageId: 'GEN-04' });
    // withdrawn consent: no resend
    await Outbox.create({ accountId: w.accountId, customerId: w.cus.id, personKey: `C:${w.cus.id}`, channel: 'EMAIL', purpose: 'QUOTATION_EMAIL', template: 'QT-EMAIL', params: {}, to: 'meena@example.com', text: 'x', occurrenceKey: 'q2', status: 'FAILED', day: istToday() });
    await Consent.create({ accountId: w.accountId, personKey: `C:${w.cus.id}`, customerId: w.cus.id, channel: 'EMAIL', status: 'WITHDRAWN', recordedAt: new Date() });
    const q2 = await Outbox.findOne({ occurrenceKey: 'q2' }).lean();
    expect(err(await w.A.post(`/communications/${q2!._id}/resend`, {}))).toMatchObject({ status: 409 });
    const other = await registerAdvisor('Ravi Kumar');
    expect((await as(other.token).get('/communications?tab=failed')).body.data).toEqual([]);
    expect(err(await as(other.token).post(`/communications/${q2!._id}/resend`, {}))).toMatchObject({ status: 404 });
  });
});

describe('P-56 wallet', () => {
  it('AC-P56-3 only the signed gateway notification credits (WAL-01), once; WAL-04 minimum; AC-P56-1/4 one debit per SENT message, listed with its message', async () => {
    const w = await world({ premium: true, balance: 0 });
    expect((await w.A.post('/wallet/recharge', { amount: 100 })).body.error.fields[0]).toMatchObject({ messageId: 'WAL-04' });
    const order = (await w.A.post('/wallet/recharge', { amount: 500 })).body.data;
    expect((await w.A.get('/wallet')).body.data.balance).toBe(0); // PENDING: the browser alone never credits
    const pay = { eventId: 'p1', orderId: order.orderId, paymentId: 'pay_1', status: 'captured' };
    expect((await request(app).post('/v1/webhooks/payments').set('Content-Type', 'application/json').set('X-Bimayantra-Signature', 'bad').send(JSON.stringify(pay))).status).toBe(403);
    const raw = JSON.stringify(pay);
    await request(app).post('/v1/webhooks/payments').set('Content-Type', 'application/json').set('X-Bimayantra-Signature', sign(raw)).send(raw);
    await request(app).post('/v1/webhooks/payments').set('Content-Type', 'application/json').set('X-Bimayantra-Signature', sign(raw)).send(raw);
    expect((await w.A.get('/wallet')).body.data.balance).toBe(500);
    // a greeting that needs a retry is still debited exactly once
    await greetingsOn(w); await runGreetingJob();
    atIST(10);
    devProvider.setFailMode('temporary'); await sendDue();
    devProvider.setFailMode('none'); clock.setOffset(clock.offsetMs() + 5 * 60_000); await sendDue();
    clock.setOffset(0);
    const wl = (await w.A.get('/wallet')).body.data;
    expect(wl.balance).toBe(499);
    const debits = wl.transactions.filter((t: { type: string }) => t.type === 'DEBIT');
    expect(debits).toHaveLength(1);
    expect(debits[0].messageId).toBe((await Outbox.findOne({ purpose: 'BIRTHDAY' }).lean())!._id);
  });

  it('AC-P56-2: with too little balance, messages are SKIPPED (WAL-03), not sent on credit', async () => {
    const w = await world({ premium: true, balance: 50 });
    await greetingsOn(w); await runGreetingJob();
    atIST(10); await sendDue();
    expect(await Outbox.findOne({ purpose: 'BIRTHDAY' }).lean()).toMatchObject({ status: 'SKIPPED', skipReason: 'Insufficient wallet balance' });
    expect(await WalletTxn.countDocuments({ type: 'DEBIT' })).toBe(0);
  });
});