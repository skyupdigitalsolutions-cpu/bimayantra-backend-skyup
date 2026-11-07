/** Module 17 — campaigns core, website forms, Google Ads lead forms (ported from the previous CRM, with fixes). */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { clock } from '../src/lib/clock.js';
import { Account } from '../src/modules/accounts/account.model.js';
import { Consent, Customer } from '../src/modules/customers/customer.model.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { Task } from '../src/modules/tasks/task.model.js';
import { Submission } from '../src/modules/campaigns/campaign.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => { clock.setOffset(0); await resetState(); });

const web = (key: string, body: object, ip = '10.1.1.1') => request(app).post('/v1/hooks/website').set('X-Forwarded-For', ip).set('X-Bimayantra-Key', key).send(body);
const google = (body: object) => request(app).post('/v1/hooks/google').send(body);
const gLead = (key: string, leadId: string, mobile: string, extra: object = {}) => ({ lead_id: leadId, api_version: '1.0', form_id: 4401, campaign_id: 9911, google_key: key, is_test: false,
  user_column_data: [{ column_id: 'FULL_NAME', column_name: 'Full Name', string_value: 'Leela Das' }, { column_id: 'PHONE_NUMBER', column_name: 'User Phone', string_value: `+91${mobile}` }, { column_id: 'EMAIL', string_value: 'leela@example.com' }, { column_id: 'what_cover_do_you_need?', column_name: 'What cover do you need?', string_value: 'Family health' }], ...extra });
async function advisor() { const adv = await registerAdvisor('Asha Rao'); return { adv, A: as(adv.token) }; }

describe('website forms', () => {
  it('imports a lead with its answers, consent, a follow-up task and a bell alert; the key is shown once and checked', async () => {
    const { A } = await advisor();
    const c = await A.post('/campaigns/connections', { channel: 'WEBSITE', name: 'Main website' });
    expect(c.body.meta.message).toBe('Connected. Copy the key now: it is shown only once.');
    const key = c.body.data.key as string;
    expect((await A.get('/campaigns/connections')).body.data[0]).not.toHaveProperty('key');
    expect(err(await web('wrong-key-123456789', { name: 'X', phone: newMobile() }))).toMatchObject({ status: 403 });
    const m = newMobile();
    const r = await web(key, { formName: 'Health insurance page', name: 'Ravi Kumar', phone: m, email: 'ravi@example.com', city: 'Mysuru', consent: 'yes', fields: { 'Family members': '4' } });
    expect(r.body.data).toMatchObject({ received: true, status: 'IMPORTED', duplicate: false });
    const lead = await Lead.findOne({ mobile: `+91${m}` }).lean();
    expect(lead).toMatchObject({ source: 'Website form', campaign: 'Health insurance page', name: 'Ravi Kumar', email: 'ravi@example.com', status: 'NEW' });
    expect(await Consent.findOne({ personKey: `L:${lead!._id}` }).lean()).toMatchObject({ channel: 'WHATSAPP', status: 'GIVEN', howGiven: 'Website form tick' });
    expect(await Task.findOne({ linkedId: lead!._id }).lean()).toMatchObject({ kind: 'LEAD_FOLLOW_UP', title: 'Call Ravi Kumar (new Website form lead)' });
    expect((await Notification.findOne({ messageId: 'CMP-01' }).lean())!.message).toBe('New lead from Website form: Ravi Kumar.');
    const answers = (await A.get(`/campaigns/leads/${lead!._id}/answers`)).body.data[0].answers.map((a: { key: string; value: string }) => `${a.key}=${a.value}`);
    expect(answers).toEqual(expect.arrayContaining(['Family members=4', 'city=Mysuru']));
  });

  it('a double submit is one; the same mobile is linked, not duplicated; no mobile is skipped with a reason; the spam trap stores nothing; HTML form posts work', async () => {
    const { A } = await advisor();
    const key = (await A.post('/campaigns/connections', { channel: 'WEBSITE', name: 'Site' })).body.data.key;
    const m = newMobile();
    const body = { name: 'Ravi Kumar', mobile: m };
    await web(key, body);
    expect((await web(key, body)).body.data.duplicate).toBe(true);
    const later = await web(key, { name: 'Ravi K', mobile: m, message: 'Call after 6' });
    expect(later.body.data.status).toBe('LINKED');
    expect(await Lead.countDocuments({})).toBe(1);
    const none = await web(key, { name: 'No Phone', email: 'x@example.com' });
    expect(none.body.data.status).toBe('SKIPPED');
    expect((await Submission.findOne({ status: 'SKIPPED' }).lean())!.reason).toBe('No valid Indian mobile number in the form');
    await web(key, { name: 'Bot', mobile: newMobile(), website: 'http://spam' });
    expect(await Submission.countDocuments({})).toBe(3);
    const html = await request(app).post('/v1/hooks/website').set('X-Bimayantra-Key', key).type('form').send(`name=Meena+Iyer&phone=${newMobile()}`);
    expect(html.body.data.status).toBe('IMPORTED');
    const cus = (await A.post('/customers', { name: 'Kiran Das', mobile: newMobile() })).body.data;
    const cm = (await Customer.findById(cus.id).lean())!.mobile;
    expect((await web(key, { name: 'Kiran', mobile: cm })).body.data.status).toBe('LINKED');
  });

  it('rotating the key keeps the old one working for CFG-196 days; disconnect stops submissions (CMP-04)', async () => {
    const { A } = await advisor();
    const c = (await A.post('/campaigns/connections', { channel: 'WEBSITE', name: 'Site' })).body.data;
    const rot = await A.post(`/campaigns/connections/${c.connection.id}/rotate-key`, {});
    expect(rot.body.meta.message).toBe('New key created. The old key keeps working for 7 days.');
    expect((await web(c.key, { name: 'Old Key', mobile: newMobile() })).status).toBe(200);
    expect((await web(rot.body.data.key, { name: 'New Key', mobile: newMobile() })).status).toBe(200);
    clock.setOffset(8 * 86_400_000);
    expect((await web(c.key, { name: 'Too Late', mobile: newMobile() })).status).toBe(403);
    clock.setOffset(0);
    const d = await A.post(`/campaigns/connections/${c.connection.id}/disconnect`, {});
    expect(d.body.meta.message).toBe('Disconnected. New submissions from Site are no longer accepted.');
    expect((await web(rot.body.data.key, { name: 'After', mobile: newMobile() })).status).toBe(403);
  });

  it('our embeddable form: public fields, required consent, and a lead', async () => {
    const { A } = await advisor();
    const c = (await A.post('/campaigns/connections', { channel: 'WEBSITE', name: 'Site' })).body.data;
    const f = (await A.post(`/campaigns/connections/${c.connection.id}/embed-forms`, { name: 'Diwali offer', campaignName: 'Diwali 2026' })).body.data;
    const page = (await request(app).get(`/v1/public/forms/${f.publicKey}`)).body.data;
    expect(page).toMatchObject({ valid: true, name: 'Diwali offer', advisorName: 'Asha Rao' });
    const m = newMobile();
    const no = await request(app).post(`/v1/public/forms/${f.publicKey}`).send({ name: 'Ravi Kumar', mobile: m });
    expect(no.body.error.fields[0]).toMatchObject({ field: 'consent', messageId: 'GEN-01' });
    const ok = await request(app).post(`/v1/public/forms/${f.publicKey}`).send({ name: 'Ravi Kumar', mobile: m, consent: 'on' });
    expect(ok.body.meta.message).toBe('Thank you, Ravi. We will contact you soon.');
    expect(await Lead.findOne({ mobile: `+91${m}` }).lean()).toMatchObject({ source: 'Website form', campaign: 'Diwali 2026' });
  });
});

describe('Google Ads lead forms', () => {
  it('imports by column_id; a repeated lead_id is one lead; test leads are kept but not counted; a wrong key is refused', async () => {
    const { A } = await advisor();
    const key = (await A.post('/campaigns/connections', { channel: 'GOOGLE', name: 'Google Ads' })).body.data.key;
    const m = newMobile();
    const r = await google(gLead(key, 'TeSter-123', m));
    expect(r.body.data).toMatchObject({ status: 'IMPORTED' });
    expect((await google(gLead(key, 'TeSter-123', m))).body.data.duplicate).toBe(true);
    expect(await Lead.countDocuments({ mobile: `+91${m}` })).toBe(1);
    expect(await Lead.findOne({ mobile: `+91${m}` }).lean()).toMatchObject({ source: 'Google Ads', name: 'Leela Das', adRef: { channel: 'GOOGLE', externalId: 'TeSter-123' } });
    const t = await google(gLead(key, 'test-lead-1', newMobile(), { is_test: true }));
    expect(t.body.data.status).toBe('SKIPPED');
    expect((await Submission.findOne({ externalId: 'test-lead-1' }).lean())!.reason).toBe('Test lead · not counted');
    expect((await google(gLead('byg_wrongwrongwrongwrongwrong', 'x-1', newMobile()))).status).toBe(403);
    const forms = (await A.get('/campaigns/forms')).body.data;
    expect(forms[0]).toMatchObject({ externalId: '4401', seenKeys: expect.arrayContaining(['FULL_NAME', 'PHONE_NUMBER', 'what_cover_do_you_need?']) });
  });
});

describe('read-only, retry and isolation', () => {
  it('a read-only account keeps the submission as FAILED with the reason; Retry imports it after renewal; other accounts see nothing; assistants cannot connect', async () => {
    const { adv, A } = await advisor();
    const key = (await A.post('/campaigns/connections', { channel: 'WEBSITE', name: 'Site' })).body.data.key;
    clock.setOffset(10 * 86_400_000); // trial over
    const r = await web(key, { name: 'Ravi Kumar', mobile: newMobile() });
    expect(r.body.data.status).toBe('FAILED');
    const s = await Submission.findOne({}).lean();
    expect(s!.reason).toBe('Account is read-only: renew the plan, then Retry');
    const acc = (await Lead.db.collection('users').findOne({ mobile: `+91${adv.mobile}` }))!.accountId;
    await Account.updateOne({ _id: acc }, { $set: { 'subscription.status': 'ACTIVE', 'subscription.plan': 'PREMIUM', 'subscription.endsAt': new Date(Date.now() + 400 * 86_400_000) } });
    const t2 = (await login(adv.mobile)).token;
    const rt = await as(t2).post(`/campaigns/submissions/${s!._id}/retry`, {});
    expect(rt.body.data.status).toBe('IMPORTED');
    const other = await registerAdvisor('Kiran Das');
    expect((await as(other.token).get('/campaigns/submissions')).body.data).toEqual([]);
    const m = newMobile();
    await as(t2).post('/assistants', { name: 'Priya Shah', mobile: m }, { 'X-Step-Up-Token': await stepUp(t2, adv.mobile) });
    const ast = as((await login(m)).token);
    expect((await ast.get('/campaigns/submissions')).body.data).toHaveLength(1);
    expect(err(await ast.post('/campaigns/connections', { channel: 'WEBSITE', name: 'X' }))).toMatchObject({ status: 403 });
  });
});