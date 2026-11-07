import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Task } from '../src/modules/tasks/task.model.js';
import { Customer } from '../src/modules/customers/customer.model.js';
import { as, err, key, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();

async function setup() {
  const adv = await registerAdvisor();
  const c = as(adv.token);
  const pipelines = (await c.get('/pipelines')).body.data as Array<{ id: string; name: string }>;
  const create = (body: object = {}) => c.post('/leads', { pipelineId: pipelines[0]!.id, name: 'Ravi Kumar', mobile: newMobile(), source: 'Walk-in or personal contact', ...body });
  return { adv, c, pipelines, create };
}

describe('P-12 Create a lead', () => {
  it('AC-P12-1: name, mobile, source and pipeline save as NEW with an LD number (LD-01)', async () => {
    const { create } = await setup();
    const r = await create();
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'NEW', priority: 'MEDIUM', version: 1 });
    expect(r.body.data.number).toMatch(/^LD-\d{4}-00001$/);
    expect(r.body.meta.message).toBe(`Lead ${r.body.data.number} created.`);
  });

  it('AC-P12-2/3: exact duplicate blocked (LD-02); same mobile, other name warns (LD-03) and saves with confirmation', async () => {
    const { create } = await setup();
    const mobile = newMobile();
    const first = await create({ mobile, name: 'Ravi Kumar' });
    expect(err(await create({ mobile, name: 'ravi  kumar.' }))).toMatchObject({ status: 409, code: 'DUPLICATE', messageId: 'LD-02' });
    const warn = await create({ mobile, name: 'Lakshmi Kumar' });
    expect(err(warn)).toMatchObject({ status: 409, code: 'CONFIRMATION_REQUIRED', messageId: 'LD-03' });
    expect(warn.body.error.message).toBe(`Another open lead uses this mobile: Ravi Kumar (${first.body.data.number}). Save anyway if this is a different person.`);
    expect((await create({ mobile, name: 'Lakshmi Kumar', confirm: ['LD-03'] })).status).toBe(201);
  });

  it('AC-P12-4 and source rules: referrer, referring client and campaign are required by source', async () => {
    const { create } = await setup();
    expect((await create({ source: 'Referred by a referrer' })).body.error.fields[0]).toMatchObject({ field: 'referrerId', message: 'Referrer is required.' });
    expect((await create({ source: 'Referred by a client' })).body.error.fields[0]).toMatchObject({ field: 'referredByCustomerId', message: 'Referred by client is required.' });
    expect((await create({ source: 'Campaign' })).body.error.fields[0]).toMatchObject({ field: 'campaign', message: 'Campaign name is required.' });
    const m = newMobile();
    expect((await create({ mobile: m, altMobile: m })).body.error.fields[0]).toMatchObject({ field: 'altMobile', messageId: 'LD-09' });
  });

  it('AC-P12-5: a double submit with one key creates one lead (GEN-06 on the repeat)', async () => {
    const { c, pipelines } = await setup();
    const k = key();
    const body = { pipelineId: pipelines[0]!.id, name: 'Ravi Kumar', mobile: newMobile(), source: 'Other' };
    expect((await c.post('/leads', body, { 'Idempotency-Key': k })).status).toBe(201);
    expect(err(await c.post('/leads', body, { 'Idempotency-Key': k }))).toMatchObject({ status: 409, messageId: 'GEN-06' });
    expect((await c.get('/leads')).body.meta.total).toBe(1);
  });

  it('a follow-up date creates the lead\'s single follow-up task; a past time is DSH-24', async () => {
    const { create } = await setup();
    expect((await create({ nextFollowUpAt: '2020-01-01T10:00:00+05:30' })).body.error.fields[0].messageId).toBe('DSH-24');
    const r = await create({ nextFollowUpAt: tomorrow() });
    expect(await Task.countDocuments({ linkedId: r.body.data.id, status: 'OPEN' })).toBe(1);
  });
});

describe('P-13 Work a lead', () => {
  it('AC-P13-1: only Section 4.3 moves; anything else is GEN-04 (NEW → QUALIFIED)', async () => {
    const { c, create } = await setup();
    const l = (await create()).body.data;
    expect(l.allowedMoves).toEqual(['CONTACTED', 'FOLLOW_UP', 'LOST']);
    const r = await c.post(`/leads/${l.id}/status`, { version: 1, status: 'QUALIFIED' });
    expect(err(r)).toMatchObject({ status: 409, messageId: 'GEN-04' });
    expect(r.body.error.message).toBe('This action is not allowed because this lead is New.');
  });

  it('AC-P13-2/3: LOST needs a reason (LD-06) and "Other" a note; FOLLOW_UP needs a date and moves the task', async () => {
    const { c, create } = await setup();
    const l = (await create({ nextFollowUpAt: tomorrow() })).body.data;
    expect((await c.post(`/leads/${l.id}/status`, { version: 1, status: 'LOST' })).body.error.fields[0].messageId).toBe('LD-06');
    expect((await c.post(`/leads/${l.id}/status`, { version: 1, status: 'LOST', lostReason: 'Other' })).body.error.fields[0].message).toBe('Note is required.');
    expect((await c.post(`/leads/${l.id}/status`, { version: 1, status: 'FOLLOW_UP' })).body.error.fields[0].message).toBe('Next follow-up is required.');
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const fu = await c.post(`/leads/${l.id}/status`, { version: 1, status: 'FOLLOW_UP', nextFollowUpAt: later });
    expect(fu.body.meta.message).toBe('Lead moved to Follow-up.');
    const tasks = await Task.find({ linkedId: l.id, status: 'OPEN' }).lean();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.dueAt.toISOString()).toBe(later);
    const lost = await c.post(`/leads/${l.id}/status`, { version: 2, status: 'LOST', lostReason: 'Bought elsewhere' });
    expect(lost.body.data.status).toBe('LOST');
    expect(await Task.countDocuments({ linkedId: l.id, status: 'OPEN' })).toBe(0);
  });

  it('AC-P13-4: reopen moves LOST to CONTACTED and needs a note (LD-07)', async () => {
    const { c, create } = await setup();
    const l = (await create()).body.data;
    await c.post(`/leads/${l.id}/status`, { version: 1, status: 'LOST', lostReason: 'Not reachable' });
    expect((await c.post(`/leads/${l.id}/status`, { version: 2, status: 'CONTACTED' })).body.error.fields[0].field).toBe('note');
    const r = await c.post(`/leads/${l.id}/status`, { version: 2, status: 'CONTACTED', note: 'Called back' });
    expect(r.body).toMatchObject({ data: { status: 'CONTACTED' }, meta: { messageId: 'LD-07' } });
  });

  it('GR-11: a status change from a stale form gets GEN-05 with the current record', async () => {
    const { c, create } = await setup();
    const l = (await create()).body.data;
    await c.post(`/leads/${l.id}/status`, { version: 1, status: 'CONTACTED' });
    const stale = await c.post(`/leads/${l.id}/status`, { version: 1, status: 'FOLLOW_UP', nextFollowUpAt: tomorrow() });
    expect(err(stale)).toMatchObject({ status: 409, code: 'VERSION_CONFLICT', messageId: 'GEN-05' });
    expect(stale.body.error.details.current.status).toBe('CONTACTED');
  });

  it('AC-P13-5: contacts and stage moves appear on the timeline', async () => {
    const { c, create } = await setup();
    const l = (await create()).body.data;
    await c.post(`/leads/${l.id}/contacts`, { outcome: 'ASKED_TO_CALL_BACK', note: 'After 6 pm' });
    await c.post(`/leads/${l.id}/status`, { version: 1, status: 'CONTACTED' });
    const d = (await c.get(`/leads/${l.id}`)).body.data;
    expect(d.contacts[0]).toMatchObject({ outcomeLabel: 'Asked to call back', note: 'After 6 pm', by: 'Asha Rao' });
    expect(d.stageHistory.map((h: { toLabel: string }) => h.toLabel)).toEqual(['Contacted', 'New']);
  });
});

describe('P-14 Convert a lead', () => {
  it('AC-P14-1/2/4: creates one customer with the lead\'s source (LD-10); a converted lead is closed (LD-08, GEN-04)', async () => {
    const { c, create } = await setup();
    // Change #17: "Paid ads" is retired for new leads, so the copied source is checked with Meta Ads and its ad name.
    const l = (await create({ source: 'Meta Ads', campaign: 'Diwali family floater', nextFollowUpAt: tomorrow() })).body.data;
    const r = await c.post(`/leads/${l.id}/convert`, { version: 1, mode: 'CREATE', customer: { city: 'Mysuru', state: 'Karnataka' } });
    expect(r.status).toBe(200);
    expect(r.body.meta.message).toBe(`Customer CU-000001 created from lead ${l.number}.`);
    const cus = await Customer.findById(r.body.data.customer.id).lean();
    expect(cus).toMatchObject({ source: 'Meta Ads', sourceCode: 'META_ADS', leadId: l.id, address: { city: 'Mysuru', state: 'Karnataka' } });
    expect(await Task.countDocuments({ linkedId: l.id, status: 'OPEN' })).toBe(0);
    expect(err(await c.patch(`/leads/${l.id}`, { version: 2, notes: 'x' }))).toMatchObject({ status: 409, messageId: 'LD-08' });
    expect(err(await c.post(`/leads/${l.id}/convert`, { version: 2, mode: 'CREATE' }))).toMatchObject({ status: 409, messageId: 'GEN-04' });
  });

  it('AC-P14-3: an exact duplicate customer can only be linked (CU-02, then LD-11)', async () => {
    const { c, create } = await setup();
    const mobile = newMobile();
    const existing = (await c.post('/customers', { name: 'Ravi Kumar', mobile })).body.data;
    const l = (await create({ mobile, confirm: ['LD-04'] })).body.data;
    expect(err(await c.post(`/leads/${l.id}/convert`, { version: 1, mode: 'CREATE' }))).toMatchObject({ status: 409, messageId: 'CU-02' });
    const r = await c.post(`/leads/${l.id}/convert`, { version: 1, mode: 'LINK', customerId: existing.id });
    expect(r.body.meta.message).toBe(`Lead ${l.number} linked to existing customer ${existing.number}.`);
    expect(await Customer.countDocuments()).toBe(1);
  });
});