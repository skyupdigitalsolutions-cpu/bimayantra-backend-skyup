import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Task } from '../src/modules/tasks/task.model.js';
import { as, err, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
async function setup() {
  const adv = await registerAdvisor();
  const c = as(adv.token);
  const pipelines = (await c.get('/pipelines')).body.data as Array<{ id: string }>;
  const create = async (body: object = {}) => (await c.post('/leads', { pipelineId: pipelines[0]!.id, name: 'Ravi Kumar', mobile: newMobile(), source: 'WALK_IN', ...body })).body.data;
  return { c, create };
}

describe('Update after call (client change, Nov 2026)', () => {
  it('answered · call back: needs the follow-up; moves to Follow-up with its task; the remark is on the timeline', async () => {
    const { c, create } = await setup();
    const l = await create();
    const call = (body: object) => c.post(`/leads/${l.id}/calls`, { version: l.version, answered: true, ...body });
    expect(err(await call({ outcome: 'CALL_BACK' }))).toMatchObject({ status: 400 });
    expect((await call({ outcome: 'CALL_BACK' })).body.error.fields[0]).toMatchObject({ field: 'nextFollowUpAt', messageId: 'GEN-01' });
    expect((await call({ outcome: 'BUSY' })).body.error.fields[0]).toMatchObject({ field: 'outcome', messageId: 'VAL-22' }); // a not-answered outcome
    const r = await call({ outcome: 'CALL_BACK', remark: 'Call after salary credit', nextFollowUpAt: soon(2) });
    expect(r.status).toBe(200);
    expect(r.body.meta.message).toBe('Call recorded: Call back. Lead moved to Follow-up.');
    expect(r.body.data).toMatchObject({ status: 'FOLLOW_UP' });
    expect(r.body.data.contacts[0]).toMatchObject({ answered: true, callOutcome: 'CALL_BACK', outcomeLabel: 'Answered · Call back', note: 'Call after salary credit' });
    expect(await Task.countDocuments({ linkedId: l.id, kind: 'LEAD_FOLLOW_UP', status: 'OPEN' })).toBe(1);
  });

  it('not answered · busy: a new lead becomes Contacted with a retry task; invalid number marks it Lost and closes the task', async () => {
    const { c, create } = await setup();
    const l = await create();
    const r = await c.post(`/leads/${l.id}/calls`, { version: l.version, answered: false, outcome: 'BUSY', nextFollowUpAt: soon(1) });
    expect(r.body.data).toMatchObject({ status: 'CONTACTED' });
    expect(r.body.data.contacts[0].outcomeLabel).toBe('Not answered · Busy');
    const lost = await c.post(`/leads/${l.id}/calls`, { version: r.body.data.version, answered: false, outcome: 'INVALID_NUMBER', remark: 'Number does not exist' });
    expect(lost.body.data).toMatchObject({ status: 'LOST', lostReason: 'Invalid number' });
    expect(await Task.countDocuments({ linkedId: l.id, kind: 'LEAD_FOLLOW_UP', status: 'OPEN' })).toBe(0);
  });

  it('answered · interested moves to Qualified; the version must be current', async () => {
    const { c, create } = await setup();
    const l = await create();
    const r = await c.post(`/leads/${l.id}/calls`, { version: l.version, answered: true, outcome: 'INTERESTED' });
    expect(r.body.data.status).toBe('QUALIFIED'); // NEW → Contacted → Qualified in one save
    expect(r.body.data.stageHistory.slice(0, 2).map((h: { from: string; to: string }) => `${h.from}>${h.to}`)).toEqual(['CONTACTED>QUALIFIED', 'NEW>CONTACTED']);
    expect(err(await c.post(`/leads/${l.id}/calls`, { version: l.version, answered: true, outcome: 'INTERESTED' }))).toMatchObject({ status: 409 });
  });
});

describe('Referral from someone else (Nov 2026)', () => {
  it('REFERRED_BY_OTHER needs the name; the mobile is optional; both come back on the lead', async () => {
    const { c, create } = await setup();
    const missing = await c.post('/leads', { pipelineId: (await c.get('/pipelines')).body.data[0].id, name: 'Kavya Nair', mobile: newMobile(), source: 'REFERRED_BY_OTHER' });
    expect(missing.body.error.fields[0]).toMatchObject({ field: 'referredByName', messageId: 'GEN-01' });
    const l = await create({ source: 'REFERRED_BY_OTHER', referredByName: 'Suresh Rao', referredByMobile: '9845012345' });
    const got = (await c.get(`/leads/${l.id}`)).body.data;
    expect(got).toMatchObject({ sourceCode: 'REFERRED_BY_OTHER', referredByPerson: { name: 'Suresh Rao', mobile: '+919845012345' } });
  });
});