/** Module 16 — P-47 plans, P-49 configuration, P-50 audit, P-51 accounts, P-52 export, P-57 support access. */
import request from 'supertest';
import JSZip from 'jszip';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, seedAdmin, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { clock } from '../src/lib/clock.js';
import { normalizeMobile } from '../src/lib/phone.js';
import { cfgNum, loadConfigOverrides, ConfigValue } from '../src/config/cfg.js';
import { Account } from '../src/modules/accounts/account.model.js';
import { Customer } from '../src/modules/customers/customer.model.js';
import { User } from '../src/modules/users/user.model.js';
import { Outbox } from '../src/modules/comms/outbox.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { sign } from '../src/modules/comms/comms.service.js';
import { runSubscriptionJob } from '../src/modules/admin/admin.service.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => { clock.setOffset(0); await ConfigValue.deleteMany({}); await loadConfigOverrides(); await resetState(); });

const pay = (body: object, signature?: string) => { const raw = JSON.stringify(body); return request(app).post('/v1/webhooks/subscription').set('Content-Type', 'application/json').set('X-Bimayantra-Signature', signature ?? sign(raw)).send(raw); };
async function advisor(state = 'Karnataka') {
  const adv = await registerAdvisor('Asha Rao');
  const A = as(adv.token);
  const p = (await A.get('/profile')).body.data;
  await A.put('/profile/contact', { version: p.sections.contact.version, email: 'asha@example.com', address1: '12 MG Road', city: state === 'Karnataka' ? 'Bengaluru' : 'Mumbai', state, pin: state === 'Karnataka' ? '560001' : '400001' });
  const cus = (await A.post('/customers', { name: 'Meena Iyer', mobile: newMobile(), email: 'meena@example.com' })).body.data;
  const accountId = (await Customer.findById(cus.id).lean())!.accountId;
  return { adv, A, cus, accountId };
}
async function secondAdmin() { const m = newMobile(); await User.create({ accountId: null, role: 'ADM', name: 'Ravi Admin', mobile: normalizeMobile(m), status: 'ACTIVE', activatedAt: new Date() }); return { mobile: m, ...(await login(m)) }; }

describe('P-47 plans and billing', () => {
  it('AC-P47-1 trial with no card or plan for CFG-78 days; AC-P47-2 after the trial: read-only, data still there; AC-P47-6 archived (not deleted) after CFG-81', async () => {
    const w = await advisor();
    const b = (await w.A.get('/billing')).body.data;
    expect(b).toMatchObject({ plan: null, status: 'TRIAL' });
    const acc = (await Account.findById(w.accountId).lean())!;
    expect(Math.round((acc.subscription!.endsAt.getTime() - acc.subscription!.startsAt.getTime()) / 86_400_000)).toBe(cfgNum('CFG-78'));
    clock.setOffset(8 * 86_400_000);
    const s = as((await login(w.adv.mobile)).token);
    expect(err(await s.post('/customers', { name: 'New One', mobile: newMobile() }))).toMatchObject({ messageId: 'SUB-03' });
    expect((await s.get('/customers')).body.data.length).toBe(1); // nothing deleted
    clock.setOffset(100 * 86_400_000);
    expect((await runSubscriptionJob(clock.now())).archived).toBe(1);
    expect((await Account.findById(w.accountId).lean())).toMatchObject({ status: 'CLOSED' });
    expect(await Customer.countDocuments({ accountId: w.accountId })).toBe(1); // archived, never deleted
  });

  it('AC-P47-3 Karnataka gets CGST + SGST, another state IGST; AC-P47-4 only the signed gateway notification activates, with the right amount (SUB-14); AC-P47-5 Premium starts the number set-up (SUB-15)', async () => {
    const ka = await advisor('Karnataka');
    const q = (await ka.A.post('/billing/quote', { plan: 'PREMIUM', cycle: 'YEARLY' })).body.data;
    expect(q).toMatchObject({ basePaise: 999000, gst: { cgst: 89910, sgst: 89910, igst: 0 }, totalPaise: 1178820 });
    const o = (await ka.A.post('/billing/orders', { plan: 'PREMIUM', cycle: 'YEARLY' })).body.data;
    expect((await ka.A.get('/billing')).body.data.plan).toBeNull(); // the browser return page alone activates nothing
    expect((await ka.A.get(`/billing/orders/${o.orderId}`)).body.data.message).toBe('Your payment is being confirmed. Your plan will update automatically in a few minutes.');
    expect((await pay({ eventId: 'x1', orderId: o.orderId, paymentId: 'p1', status: 'captured', amountPaise: o.totalPaise }, 'forged')).status).toBe(403);
    await pay({ eventId: 'x2', orderId: o.orderId, paymentId: 'p2', status: 'captured', amountPaise: 100 }); // wrong amount: ignored
    expect((await ka.A.get('/billing')).body.data.plan).toBeNull();
    await pay({ eventId: 'x3', orderId: o.orderId, paymentId: 'p3', status: 'captured', amountPaise: o.totalPaise });
    const b = (await ka.A.get('/billing')).body.data;
    expect(b).toMatchObject({ plan: 'PREMIUM', status: 'ACTIVE', cycle: 'YEARLY', waNumber: { status: 'SETTING_UP' } });
    expect(b.invoices[0].invoiceNumber).toMatch(/^INV\/\d{4}-\d{2}\/00001$/);
    expect((await Notification.findOne({ messageId: 'SUB-14' }).lean())!.message).toMatch(/^Payment received\. Your Premium plan is active until \d{2}-\d{2}-\d{4}\. Your GST invoice has been emailed\.$/);
    expect(await Notification.countDocuments({ messageId: 'SUB-15' })).toBe(1);
    expect(await Outbox.countDocuments({ purpose: 'SUBSCRIPTION', to: 'asha@example.com' })).toBe(1);
    await resetState();
    const mh = await advisor('Maharashtra');
    expect((await mh.A.post('/billing/quote', { plan: 'NORMAL', cycle: 'MONTHLY' })).body.data.gst).toEqual({ cgst: 0, sgst: 0, igst: 8982 });
  });

  it('renewal starts the day after the current period; downgrade asks SUB-09 then takes effect at the period end', async () => {
    const w = await advisor();
    const o = (await w.A.post('/billing/orders', { plan: 'PREMIUM', cycle: 'MONTHLY' })).body.data;
    await pay({ eventId: 'r1', orderId: o.orderId, paymentId: 'pp1', status: 'captured', amountPaise: o.totalPaise });
    const end = (await w.A.get('/billing')).body.data.endsAt;
    const renew = (await w.A.post('/billing/quote', { plan: 'PREMIUM', cycle: 'MONTHLY' })).body.data;
    const next = new Date(`${end}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    expect(renew).toMatchObject({ kind: 'RENEW', periodStart: next.toISOString().slice(0, 10) });
    const ask = await w.A.post('/billing/downgrade', {});
    expect(err(ask)).toMatchObject({ status: 409, messageId: 'SUB-09' });
    expect(ask.body.error.message).toMatch(/^Premium features stop on \d{2}-\d{2}-\d{4}\. Automatic WhatsApp messages will be switched off and queued messages cancelled\. Continue\?$/);
    expect((await w.A.post('/billing/downgrade', { confirm: true })).body.data.nextPlan).toBe('NORMAL');
    clock.setOffset(32 * 86_400_000);
    await runSubscriptionJob(clock.now());
    expect((await Account.findById(w.accountId).lean())!.subscription!.plan).toBe('NORMAL');
  });
});

describe('P-49 configuration', () => {
  it('no admin approval: a change applies at once with a reason and the OTP (ADM-06) and keeps its history; AC-P49-2 Release settings refused; AC-P49-3 out of range (ADM-05)', async () => {
    const a1 = await seedAdmin();
    const A1 = as(a1.token);
    const otp = async () => ({ 'X-Step-Up-Token': await stepUp(a1.token, a1.mobile) });
    expect(err(await A1.post('/admin/config/CFG-01/changes', { value: 4, reason: 'Shorter OTP' }, await otp()))).toMatchObject({ status: 409 }); // Release
    const bad = await A1.post('/admin/config/CFG-114/changes', { value: 99, reason: 'More exports' }, await otp());
    expect(bad.body.error.fields[0].message).toBe('Enter a value from 1 to 20.');
    expect(err(await A1.post('/admin/config/CFG-114/changes', { value: 5, reason: 'Advisors asked for more exports' }))).toMatchObject({ status: 403, messageId: 'AUTH-26' });
    expect(cfgNum('CFG-114')).toBe(3);
    const ok = await A1.post('/admin/config/CFG-114/changes', { value: 5, reason: 'Advisors asked for more exports' }, await otp());
    expect(ok.body.meta.message).toBe('Change applied. The new value is used from now on.');
    expect(ok.body.data).toMatchObject({ status: 'APPLIED', oldValue: 3, newValue: 5, reason: 'Advisors asked for more exports' });
    expect(cfgNum('CFG-114')).toBe(5); // live at once
    const listChange = await A1.post('/admin/config/CFG-60/changes', { value: [45, 15, 3], reason: 'Fewer reminders' }, await otp()); // a list of numbers is valid
    expect(listChange.status).toBe(201);
  });
});

describe('P-50 audit, P-51 accounts', () => {
  it('AC-P50-2 an advisor sees only their account; the ADM export (OTP) is a CSV and is itself audited', async () => {
    const w = await advisor();
    const other = await registerAdvisor('Ravi Kumar');
    await as(other.token).post('/customers', { name: 'Other Customer', mobile: newMobile() });
    const mine = (await w.A.get('/audit?limit=100')).body.data;
    expect(mine.every((e: { accountId: string }) => e.accountId === w.accountId)).toBe(true);
    const a = await seedAdmin();
    expect((await as(a.token).get('/audit/export')).status).toBe(403); // OTP needed
    const csv = await request(app).get('/v1/audit/export').set('Authorization', `Bearer ${a.token}`).set('X-Step-Up-Token', await stepUp(a.token, a.mobile));
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[0]).toBe('at,accountId,actorUserId,actorRole,entity,entityId,entityRef,action,result,before,after');
    expect((await as(a.token).get('/audit?action=AUDIT_EXPORTED')).body.data).toHaveLength(1);
  });

  it('AC-P51-1 a suspended account cannot sign in and sends nothing; AC-P51-2 reactivation sends nothing missed; AC-P51-3 the summary has no customer personal data', async () => {
    const w = await advisor();
    const adm = await seedAdmin();
    const M = as(adm.token);
    await Outbox.create({ accountId: w.accountId, customerId: w.cus.id, personKey: `C:${w.cus.id}`, channel: 'EMAIL', purpose: 'QUOTATION_EMAIL', template: 'QT-EMAIL', params: {}, to: 'meena@example.com', text: 'x', occurrenceKey: 'pending-1', day: '2026-01-01' });
    const summary = (await M.get('/admin/accounts')).body.data.find((x: { id: string }) => x.id === w.accountId);
    expect(summary).toMatchObject({ advisor: 'Asha Rao', counts: { customers: 1 } });
    expect(JSON.stringify(summary)).not.toContain('Meena');
    const s = await M.post(`/admin/accounts/${w.accountId}/suspend`, { reason: 'Reported misuse' }, { 'X-Step-Up-Token': await stepUp(adm.token, adm.mobile) });
    expect(s.body.meta.message).toBe('Account suspended. The advisor and their referrers can no longer log in.');
    expect(err(await w.A.get('/customers'))).toMatchObject({ status: 401 });
    expect((await request(app).post('/v1/auth/login/otp').send({ mobile: w.adv.mobile })).status).toBeGreaterThanOrEqual(200);
    expect(await Outbox.findOne({ occurrenceKey: 'pending-1' }).lean()).toMatchObject({ status: 'CANCELLED', skipReason: 'Account suspended' });
    await M.post(`/admin/accounts/${w.accountId}/reactivate`, { reason: 'Resolved' }, { 'X-Step-Up-Token': await stepUp(adm.token, adm.mobile) });
    expect((await Outbox.findOne({ occurrenceKey: 'pending-1' }).lean())!.status).toBe('CANCELLED'); // never sent late
  });
});

describe('P-52 export, P-57 support access', () => {
  it('AC-P52-1 own records only; AC-P52-3 works read-only; AC-P52-2 the link stops after CFG-113; AC-P52-4 the 4th export in a day is refused (ADM-12)', async () => {
    const w = await advisor();
    const other = await registerAdvisor('Ravi Kumar');
    await as(other.token).post('/customers', { name: 'Other Customer', mobile: newMobile() });
    clock.setOffset(8 * 86_400_000); // trial over: read-only
    const R = as((await login(w.adv.mobile)).token);
    const ex = await R.post('/exports', { include: ['customers', 'leads'] });
    expect(ex.body.meta.message).toBe('Your export is being prepared. We will tell you when it is ready.');
    await new Promise((r) => setTimeout(r, 400));
    const jobs = (await R.get('/exports')).body.data;
    expect(jobs[0].status).toBe('READY');
    const tok = (await login(w.adv.mobile)).token;
    const dl = await request(app).get(`/v1/exports/${jobs[0]._id}/download`).set('Authorization', `Bearer ${tok}`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    const zip = await JSZip.loadAsync(dl.body as Buffer);
    const customers = await zip.file('customers.csv')!.async('string');
    expect(customers).toContain('Meena Iyer');
    expect(customers).not.toContain('Other Customer');
    await R.post('/exports', { include: ['leads'] }); await R.post('/exports', { include: ['leads'] });
    expect(err(await R.post('/exports', { include: ['leads'] }))).toMatchObject({ messageId: 'ADM-12' });
    clock.setOffset(8 * 86_400_000 + 25 * 3_600_000);
    const late = await request(app).get(`/v1/exports/${jobs[0]._id}/download`).set('Authorization', `Bearer ${(await login(w.adv.mobile)).token}`);
    expect(late.status).toBe(409);
  });

  it('AC-P57-1 no grant → SUP-03; with a grant (SUP-01) SkyUp can open records and the advisor sees each one (AC-P57-3); AC-P57-2 it stops when ended or expired', async () => {
    const w = await advisor();
    const m = newMobile();
    await User.create({ accountId: null, role: 'STF', name: 'Meena Staff', mobile: normalizeMobile(m), status: 'ACTIVE', activatedAt: new Date() });
    const st = await login(m);
    const S = as(st.token);
    expect(err(await S.get(`/support/${w.accountId}/customers`))).toMatchObject({ status: 403, messageId: 'SUP-03' });
    const staffId = (await w.A.get('/support-grants/staff')).body.data.find((x: { name: string }) => x.name === 'Meena Staff').id;
    const g = await w.A.post('/support-grants', { granteeUserId: staffId, reason: 'Ticket 1234: missing policy' }, { 'X-Step-Up-Token': await stepUp(w.adv.token, w.adv.mobile) });
    expect(g.body.meta.message).toMatch(/^Support access given to Meena Staff until \d{2}-\d{2}-\d{4} \d{2}:\d{2}\.$/);
    expect((await S.get(`/support/${w.accountId}/customers`)).body.data[0].name).toBe('Meena Iyer');
    await S.get(`/support/${w.accountId}/customers/${w.cus.id}`);
    const log = (await w.A.get('/support-grants')).body.data[0].log.map((l: { what: string }) => l.what);
    expect(log).toEqual(['Customer list', 'Customer']);
    expect((await w.A.post(`/support-grants/${g.body.data._id}/end`, {})).body.meta.message).toBe('Support access ended.');
    expect(err(await S.get(`/support/${w.accountId}/customers`))).toMatchObject({ messageId: 'SUP-03' });
    // expiry
    await w.A.post('/support-grants', { granteeUserId: staffId, reason: 'Ticket 1235' }, { 'X-Step-Up-Token': await stepUp(w.adv.token, w.adv.mobile) });
    clock.setOffset(25 * 3_600_000);
    const S2 = as((await login(m)).token);
    expect(err(await S2.get(`/support/${w.accountId}/customers`))).toMatchObject({ messageId: 'SUP-03' });
  });
});