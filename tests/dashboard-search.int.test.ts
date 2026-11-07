/**
 * Module 7 Stage 2 — P-08 Advisor dashboard and P-09 Global search. Names cite the BPD checks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, err, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { Customer } from '../src/modules/customers/customer.model.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

async function setup(name = 'Asha Rao') {
  const adv = await registerAdvisor(name);
  const c = as(adv.token);
  const pipeline = ((await c.get('/pipelines')).body.data as Array<{ id: string }>)[0]!.id;
  const lead = async (n: string, mobile = newMobile()) => (await c.post('/leads', { pipelineId: pipeline, name: n, mobile, source: 'Walk-in or personal contact' })).body.data;
  const customer = async (n: string, mobile = newMobile()) => (await c.post('/customers', { name: n, mobile })).body.data;
  return { adv, c, lead, customer };
}

describe('P-08 dashboard', () => {
  it('a new account shows 0 with DSH-04 in each empty widget', async () => {
    const { c } = await setup();
    for (const w of ['open-leads', 'active-customers', 'todays-tasks', 'recent-activity']) {
      const d = (await c.get(`/dashboard/${w}`)).body.data;
      expect(d.emptyMessage, w).toBe('Nothing to show yet. Add your first lead to get started.');
    }
    expect((await c.get('/dashboard/funnel')).body.data).toMatchObject({ created: 0, emptyMessageId: 'DSH-04' });
  });

  it('AC-P08-1 / AC-P08-4: each count matches a manual count, and says which list and filter it opens', async () => {
    const { adv, c, lead, customer } = await setup();
    const a = await lead('Priya Sharma');
    await lead('Kavya Nair');
    await c.post(`/leads/${a.id}/status`, { version: a.version, status: 'CONTACTED' });
    const lost = await lead('Ravi Kumar');
    const lostNow = (await c.get(`/leads/${lost.id}`)).body.data;
    const ref = (await c.get('/reference')).body.data;
    await c.post(`/leads/${lost.id}/status`, { version: lostNow.version, status: 'LOST', lostReason: ref.lostReasons[0] });
    await customer('Meena Iyer');
    const gone = await customer('Arjun Iyer');
    await c.post(`/customers/${gone.id}/deactivate`, { version: gone.version, reason: ref.deactivationReasons.find((r: string) => !/other/i.test(r)) });

    const ol = (await c.get('/dashboard/open-leads')).body.data;
    const manualLeads = await Lead.countDocuments({ accountId: adv.user.accountId, status: { $in: ['NEW', 'CONTACTED', 'QUALIFIED', 'FOLLOW_UP'] } });
    expect(ol.count).toBe(manualLeads);
    expect(ol.count).toBe(2);
    expect(ol.opens).toEqual({ list: 'LEADS', filter: { status: ['NEW', 'CONTACTED', 'QUALIFIED', 'FOLLOW_UP'] } });
    const ac = (await c.get('/dashboard/active-customers')).body.data;
    expect(ac.count).toBe(await Customer.countDocuments({ accountId: adv.user.accountId, status: 'ACTIVE' }));
    expect(ac.count).toBe(1);
    // the list it opens returns the same number of rows
    expect((await c.get('/customers?status=ACTIVE&limit=100')).body.data).toHaveLength(ac.count);
  });

  it('AC-P08-2: no count includes another account\u2019s records', async () => {
    const mine = await setup('Asha Rao');
    const theirs = await setup('Ravi Kumar');
    await theirs.lead('Priya Sharma'); await theirs.lead('Kavya Nair'); await theirs.customer('Meena Iyer');
    await mine.lead('Arjun Iyer');
    expect((await mine.c.get('/dashboard/open-leads')).body.data.count).toBe(1);
    expect((await mine.c.get('/dashboard/active-customers')).body.data.count).toBe(0);
    expect((await mine.c.get('/dashboard/funnel')).body.data.created).toBe(1);
    const act = JSON.stringify((await mine.c.get('/dashboard/recent-activity')).body.data);
    expect(act).not.toContain(theirs.adv.user.accountId!);
  });

  it('lead funnel: leads created in the period, by status, and how many reached CONVERTED', async () => {
    const { c, lead } = await setup();
    const a = await lead('Priya Sharma');
    await lead('Kavya Nair');
    await c.post(`/leads/${a.id}/convert`, { version: a.version, mode: 'CREATE' });
    const f = (await c.get('/dashboard/funnel?period=THIS_YEAR')).body.data;
    expect(f).toMatchObject({ period: 'THIS_YEAR', created: 2, converted: 1 });
    expect(f.bars.find((b: { status: string }) => b.status === 'NEW').count).toBe(1);
    await Lead.collection.updateOne({ _id: a.id as never }, { $set: { createdAt: new Date('2020-01-01') } }); // Mongoose protects createdAt
    expect((await c.get('/dashboard/funnel?period=THIS_MONTH')).body.data.created).toBe(1);
  });

  it('recent activity: creations and status changes, newest first; views and sign-ins never appear', async () => {
    const { adv, c, lead } = await setup();
    await lead('Priya Sharma');
    await AuditLog.create({ at: new Date(), accountId: adv.user.accountId, entity: 'customer', entityId: 'x', action: 'PERSONAL_DATA_VIEWED' });
    const ev = (await c.get('/dashboard/recent-activity')).body.data.events;
    expect(ev[0]).toMatchObject({ entity: 'lead', action: 'LEAD_CREATED' });
    expect(ev.map((e: { action: string }) => e.action)).not.toContain('PERSONAL_DATA_VIEWED');
  });

  it('only the advisor sees the dashboard', async () => {
    const { adv, c } = await setup();
    const { login, stepUp } = await import('./helpers.js');
    const m = newMobile();
    await c.post('/assistants', { name: 'Priya Shah', mobile: m }, { 'X-Step-Up-Token': await stepUp(adv.token, adv.mobile) });
    expect(err(await as((await login(m)).token).get('/dashboard/open-leads'))).toMatchObject({ status: 403, messageId: 'GEN-03' });
  });
});

describe('P-09 global search', () => {
  it('AC-P09-1: fewer than CFG-24 characters gets DSH-02 and no search', async () => {
    const { c } = await setup();
    const r = await c.get('/search?q=Pr');
    expect(err(r)).toMatchObject({ status: 400 });
    expect(JSON.stringify(r.body)).toContain('Type at least 3 characters to search.');
  });

  it('matches any part of a name ignoring case, email and reference numbers; grouped Leads, Customers, Family', async () => {
    const { c, lead, customer } = await setup();
    const l = await lead('Priya Sharma');
    const cu = await customer('Meena Sharma');
    await c.post(`/customers/${cu.id}/family`, { name: 'Arjun Sharma', relationship: 'Son' });
    const r = (await c.get('/search?q=sharMA')).body.data;
    expect(r.groups.map((g: { group: string; items: unknown[] }) => `${g.group}:${g.items.length}`)).toEqual(['LEADS:1', 'CUSTOMERS:1', 'FAMILY_MEMBERS:1', 'QUOTATIONS:0', 'POLICIES:0']);
    const fam = r.groups[2].items[0];
    expect(fam.open).toEqual({ type: 'CUSTOMER', id: cu.id, tab: 'family' }); // opens the customer's Family tab
    expect((await c.get(`/search?q=${l.number.toLowerCase()}`)).body.data.groups[0].items[0].id).toBe(l.id);
  });

  it('AC-P09-2: the last CFG-132 digits of a mobile find the customer; full numbers never appear in results', async () => {
    const { c, customer } = await setup();
    const mobile = newMobile();
    const cu = await customer('Meena Iyer', mobile);
    const r = (await c.get(`/search?q=${mobile.slice(-4)}`)).body.data;
    expect(r.groups[1].items.map((i: { id: string }) => i.id)).toContain(cu.id);
    expect(JSON.stringify(r)).not.toContain(mobile.slice(-10));
    expect((await c.get(`/search?q=${mobile.slice(-10)}`)).body.data.groups[1].items[0].id).toBe(cu.id); // full 10 digits
  });

  it('AC-P09-3: no result comes from another account; inactive records are included and labelled', async () => {
    const mine = await setup('Asha Rao');
    const theirs = await setup('Ravi Kumar');
    await theirs.customer('Kavya Nair');
    const me = await mine.customer('Kavya Rao');
    const ref = (await mine.c.get('/reference')).body.data;
    await mine.c.post(`/customers/${me.id}/deactivate`, { version: me.version, reason: ref.deactivationReasons.find((r: string) => !/other/i.test(r)) });
    const r = (await mine.c.get('/search?q=kavya')).body.data;
    expect(r.groups[1].items.map((i: { title: string; status: string }) => `${i.title}:${i.status}`)).toEqual(['Kavya Rao:INACTIVE']);
  });

  it('no matches gives DSH-03; results stop at CFG-25 with "more" on the cut group', async () => {
    const { c, lead } = await setup();
    expect((await c.get('/search?q=zzzz')).body.data).toMatchObject({ count: 0, messageId: 'DSH-03', message: 'No matches for "zzzz".' });
    for (let i = 0; i < 22; i++) await lead(`Test Person ${String.fromCharCode(65 + i)}`);
    const r = (await c.get('/search?q=test person')).body.data;
    expect(r.count).toBe(20);
    expect(r.groups[0].more).toBe(true);
  });

  it('special characters in the search text are taken literally, never as a pattern', async () => {
    const { c, lead } = await setup();
    await lead('Priya Sharma');
    expect((await c.get('/search?q=' + encodeURIComponent('.*.'))).body.data.count).toBe(0);
  });
});