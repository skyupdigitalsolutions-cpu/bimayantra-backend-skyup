/**
 * Frontend-integration gap fixes (web app wiring, Nov 2026): every field and filter the Figma screens need that the
 * API did not return before. One describe per gap; names say which screen needed it.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, key, lastOtp, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { clock, istToday } from '../src/lib/clock.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { InsuranceType, TemplateVersion } from '../src/modules/catalogue/types.model.js';
import { Account } from '../src/modules/accounts/account.model.js';
import { User } from '../src/modules/users/user.model.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { notify } from '../src/modules/notifications/notifications.service.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => { clock.setOffset(0); await resetState(); });

const day = (n: number) => { const d = new Date(`${istToday()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10).split('-').reverse().join('-'); };
const year = Number(istToday().slice(0, 4));
const ist = (daysFromToday: number, hhmm = '11:00') => { const d = new Date(`${istToday()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + daysFromToday); return `${d.toISOString().slice(0, 10)}T${hhmm}:00+05:30`; };

async function setup() {
  const adv = await registerAdvisor('Asha Rao');
  const c = as(adv.token);
  const pipeline = ((await c.get('/pipelines')).body.data as Array<{ id: string }>)[0]!.id;
  const lead = async (name: string, extra: object = {}) => {
    const r = await c.post('/leads', { pipelineId: pipeline, name, mobile: newMobile(), source: 'WALK_IN', ...extra });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return r.body.data;
  };
  const customer = async (name: string) => (await c.post('/customers', { name, mobile: newMobile(), email: `${name.split(' ')[0]!.toLowerCase()}@example.com`, dob: `15-04-${year - 40}` })).body.data;
  return { adv, c, pipeline, lead, customer };
}

/** An advisor with an insurer, a product and one existing policy (so a renewal cycle exists). */
async function withPolicy(endInDays = 30) {
  const s = await setup();
  const ins = await Insurer.create({ name: 'Alpha Health', nameKey: 'alpha health', shortCode: 'ALPHA', category: 'Standalone Health', irdaiRegNo: 'R-1', paymentDomains: ['alpha.in'], status: 'ACTIVE' });
  const type = await InsuranceType.create({ name: 'Health', nameKey: 'health' });
  await TemplateVersion.create({ typeId: type._id, number: 1, status: 'ACTIVE', isOpen: null, makerId: 'x', features: [], factors: [{ key: 'age', name: 'Age', kind: 'BAND', source: 'Age of the eldest insured person', bands: [{ from: 0, to: 75 }] }] });
  const A = s.c;
  let p = (await A.get('/profile')).body.data;
  await A.put('/profile/professional', { version: p.sections.professional.version, advisorType: 'POSP', categories: ['Health'], licenceNumber: 'POSP-1', licenceValidUntil: day(800) });
  p = (await A.get('/profile')).body.data;
  await A.put('/profile/personal', { version: p.sections.personal.version, dob: '15-04-1988' });
  await A.post('/my-insurers', { insurerId: ins._id, agentCode: 'AG-77', declaration: true });
  const prod = (await A.post('/my-products', { insurerId: ins._id, typeId: type._id, code: 'FS', data: { name: 'Family Shield', uin: 'UIN1', launchDate: '01-01-2026', adultMin: 18, adultMax: 75, sumInsured: { options: [500000] }, policyTerms: [1], taxPercent: 18, pricingMode: 'RATE_TABLE', gracePeriodDays: 30 } })).body.data;
  const cus = await s.customer('Meena Iyer');
  const pol = (await A.post('/policies/existing', { customerId: cus.id, insurerId: ins._id, productId: prod.id, typeId: type._id, soldByMe: true, insured: [`C:${cus.id}`], policyNumber: 'FS-OLD-1',
    issueDate: day(endInDays - 364), startDate: day(endInDays - 364), endDate: day(endInDays), frequency: 'Yearly', sumInsured: 500000, premium: 11800 })).body.data;
  if (!pol?.id) throw new Error('policy not created');
  return { ...s, cus, pol };
}

describe('A4 sign-up: email', () => {
  it('the optional email is kept on the advisor and the profile contact', async () => {
    const mobile = newMobile();
    const send = await request(app).post('/v1/auth/register/otp').send({ name: 'Ravi Kumar', mobile, email: 'ravi@example.com', termsAccepted: true });
    expect(send.status).toBe(200);
    const r = await request(app).post('/v1/auth/register/verify').set('X-Client', 'app').set('Idempotency-Key', key()).send({ mobile, code: await lastOtp(mobile) });
    expect(r.status).toBe(201);
    const user = await User.findById(r.body.data.user.id).lean();
    expect(user!.email).toBe('ravi@example.com');
    const acc = await Account.findById(user!.accountId).lean();
    expect(acc!.profile!.contact!.email).toBe('ravi@example.com');
  });
  it('a bad email is a field error; no email still works', async () => {
    const bad = await request(app).post('/v1/auth/register/otp').send({ name: 'Ravi Kumar', mobile: newMobile(), email: 'not-an-email', termsAccepted: true });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.map((f: { field: string }) => f.field)).toContain('email');
    expect((await request(app).post('/v1/auth/register/otp').send({ name: 'Ravi Kumar', mobile: newMobile(), termsAccepted: true })).status).toBe(200);
  });
});

describe('Leads board, lead detail, log contact', () => {
  it('list rows carry notes, interests and campaign (board card)', async () => {
    const { c, lead } = await setup();
    await lead('Deepa Shetty', { notes: 'Wants cover for parents.', interests: ['Health'] });
    const row = (await c.get('/leads')).body.data[0];
    expect(row).toMatchObject({ notes: 'Wants cover for parents.', interests: ['Health'], campaign: null });
  });

  it('followUpTask carries its version, so Mark done works in one call', async () => {
    const { c, lead } = await setup();
    const l = await lead('Ramesh Gowda', { nextFollowUpAt: ist(1) });
    const d = (await c.get(`/leads/${l.id}`)).body.data;
    expect(d.followUpTask).toMatchObject({ id: expect.any(String), version: expect.any(Number) });
    const done = await c.post(`/tasks/${d.followUpTask.id}/done`, { version: d.followUpTask.version });
    expect(done.status).toBe(200);
  });

  it('a contact keeps how it happened (channel) and the timeline shows names, not user ids', async () => {
    const { c, lead, adv } = await setup();
    const l = await lead('Sunita Reddy');
    const r = await c.post(`/leads/${l.id}/contacts`, { outcome: 'SPOKE_TO_CUSTOMER', channel: 'WHATSAPP', note: 'Wants quotes' });
    expect(r.status).toBe(201);
    expect(r.body.data.contacts[0]).toMatchObject({ channel: 'WHATSAPP', channelLabel: 'WhatsApp', outcomeLabel: 'Spoke to customer', by: 'Asha Rao' });
    expect((await c.post(`/leads/${l.id}/contacts`, { outcome: 'SPOKE_TO_CUSTOMER', channel: 'PIGEON' })).status).toBe(400);
    const t = (await c.get(`/leads/${l.id}/timeline`)).body.data.items;
    const contact = t.find((i: { type: string }) => i.type === 'CONTACT');
    expect(contact).toMatchObject({ title: 'Spoke to customer', by: 'Asha Rao', byUserId: adv.user.id, channel: 'WHATSAPP' });
    expect(t.find((i: { type: string }) => i.type === 'STATUS').title).toBe('Created as New');
  });
});

describe('Dashboard widgets', () => {
  it('follow-up alerts name the soonest lead of each card', async () => {
    const { c, lead, adv } = await setup();
    const late = await lead('Ramesh Gowda', { nextFollowUpAt: ist(1) });
    await lead('Anand Kulkarni', { nextFollowUpAt: ist(1, '23:30') });
    // move one follow-up into the past (2 days late)
    await Lead.updateOne({ _id: late.id }, { $set: { nextFollowUpAt: new Date(Date.now() - 2 * 86_400_000 - 3_600_000) } });
    const f = (await c.get('/dashboard/follow-ups')).body.data;
    expect(f.overdue).toBe(1);
    expect(f.firstOverdue).toMatchObject({ id: late.id, name: 'Ramesh Gowda', daysLate: expect.any(Number) });
    expect(f.firstOverdue.daysLate).toBeGreaterThanOrEqual(2);
    expect(f.firstToday === null || typeof f.firstToday.name === 'string').toBe(true);
    expect(adv.user.accountId).toBeTruthy();
  });

  it('recent activity says who it is about, with a title, a detail and what it opens', async () => {
    const { c, lead, customer } = await setup();
    const l = await lead('Prakash Hegde', { source: 'META_ADS' });
    await c.post(`/leads/${l.id}/status`, { version: l.version, status: 'CONTACTED' });
    const cu = await customer('Kavya Hegde');
    const ev = (await c.get('/dashboard/recent-activity')).body.data.events;
    const created = ev.find((e: { action: string }) => e.action === 'LEAD_CREATED');
    expect(created).toMatchObject({ title: 'New lead created', name: 'Prakash Hegde', detail: 'Meta Ads', open: { type: 'LEAD', id: l.id } });
    expect(ev.find((e: { action: string }) => e.action === 'LEAD_STATUS_CHANGED')).toMatchObject({ name: 'Prakash Hegde', detail: 'New → Contacted' });
    expect(ev.find((e: { action: string }) => e.action === 'CUSTOMER_CREATED')).toMatchObject({ title: 'Policy holder added', name: 'Kavya Hegde', open: { type: 'CUSTOMER', id: cu.id } });
  });

  it('renewals-due lists the soonest renewals with customer, insurer, product and premium', async () => {
    const w = await withPolicy(30);
    const r = (await w.c.get('/dashboard/renewals-due')).body.data;
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ premium: 11800, customer: { name: 'Meena Iyer' }, policy: { insurer: 'Alpha Health', product: 'Family Shield', premium: 11800 } });
  });
});

describe('Renewals and tasks for one record', () => {
  it('renewals: premium on every row and a customerId filter', async () => {
    const w = await withPolicy(30);
    const all = (await w.c.get('/renewals')).body.data;
    expect(all[0].premium).toBe(11800);
    expect((await w.c.get(`/renewals?customerId=${w.cus.id}`)).body.data).toHaveLength(1);
    const other = await w.customer('Arjun Iyer');
    expect((await w.c.get(`/renewals?customerId=${other.id}`)).body.data).toHaveLength(0);
  });

  it('tasks: linkedType + linkedId limit the list and the tab counts', async () => {
    const { c, customer } = await setup();
    const a = await customer('Kavya Hegde');
    const b = await customer('Faizal Khan');
    const due = { dueDate: istToday().split('-').reverse().join('-'), dueTime: '23:50' };
    await c.post('/tasks', { title: 'Collect Aadhaar', ...due, linkedType: 'CUSTOMER', linkedId: a.id });
    await c.post('/tasks', { title: 'Call back', ...due, linkedType: 'CUSTOMER', linkedId: b.id });
    const r = (await c.get(`/tasks?tab=TODAY&linkedType=CUSTOMER&linkedId=${a.id}`)).body.data;
    expect(r.tasks.map((t: { title: string }) => t.title)).toEqual(['Collect Aadhaar']);
    expect(r.counts.TODAY).toBe(1);
    expect((await c.get(`/tasks?tab=TODAY&linkedId=${a.id}`)).status).toBe(400); // both or neither
  });
});

describe('04 · Policy Holders', () => {
  it('rows carry family, policy and consent; /customers/stats fills the four cards', async () => {
    const w = await withPolicy(30);
    await w.c.post(`/customers/${w.cus.id}/family`, { name: 'Arjun Iyer', relationship: 'Spouse' });
    await w.customer('Ravi Kumar');
    const rows = (await w.c.get('/customers?status=ACTIVE')).body.data;
    const meena = rows.find((r: { id: string }) => r.id === w.cus.id);
    expect(meena).toMatchObject({ familyCount: 1, policyCount: 1, personalDataConsent: expect.any(String) });
    const s = (await w.c.get('/customers/stats')).body.data;
    expect(s).toMatchObject({ active: 2, inactive: 0, familyMembers: 1, households: 1, policiesInForce: expect.any(Number), awaitingIssuance: expect.any(Number) });
    expect(s.policiesInForce + s.awaitingIssuance).toBe(1);
    expect(s.consentPending).toBeLessThanOrEqual(2);
  });
});

describe('07L · Quotations list', () => {
  it('status filter, search, paging and counts per status', async () => {
    const { c, customer } = await setup();
    const a = await customer('Kavya Hegde');
    const b = await customer('Faizal Khan');
    await c.post('/quotations', { customerId: a.id });
    await c.post('/quotations', { customerId: b.id });
    const page = await c.get('/quotations?status=DRAFT&page=1&limit=1');
    expect(page.status).toBe(200);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta).toMatchObject({ page: 1, limit: 1, total: 2, pages: 2, counts: { DRAFT: 2, READY: 0 } });
    expect(page.body.data[0].customer).toMatchObject({ name: expect.any(String) });
    const hit = (await c.get('/quotations?search=Kavya')).body.data;
    expect(hit.map((q: { customerId: string }) => q.customerId)).toEqual([a.id]);
    expect((await c.get('/quotations?status=SHARED')).body.data).toHaveLength(0);
    expect((await c.get('/quotations?status=NOPE')).status).toBe(400);
    expect((await c.get('/quotations')).body.data).toHaveLength(2); // older clients
  });
});

describe('Global search: quotations and policies', () => {
  it('finds a policy by number and a quotation by the customer’s name', async () => {
    const w = await withPolicy(30);
    await w.c.post('/quotations', { customerId: w.cus.id });
    const r = (await w.c.get('/search?q=FS-OLD')).body.data;
    const pol = r.groups.find((g: { group: string }) => g.group === 'POLICIES');
    expect(pol.items[0]).toMatchObject({ type: 'POLICY', title: 'FS-OLD-1', open: { type: 'POLICY', id: w.pol.id } });
    const q = (await w.c.get('/search?q=Meena')).body.data.groups.find((g: { group: string }) => g.group === 'QUOTATIONS');
    expect(q.items).toHaveLength(1);
    expect(q.available).toBeUndefined();
  });
});

describe('NTF · Notifications', () => {
  it('items carry kind, category (the filter tab), title and subtitle', async () => {
    const { c, adv } = await setup();
    await notify({ userId: adv.user.id, accountId: adv.user.accountId, kind: 'RENEWAL_DUE', messageId: 'AUTH-01', params: { 'CFG-01': 6, 'masked mobile': 'XXXXXX1234', 'CFG-02': 5 }, dedupeKey: 'gap-fix-test:renewal-due' });
    const it0 = (await c.get('/notifications')).body.data.items[0];
    expect(it0).toMatchObject({ kind: 'RENEWAL_DUE', category: 'RENEWALS' });
    expect(it0.title).toMatch(/\.$/);
    expect(it0.subtitle).toMatch(/valid/);
  });
});