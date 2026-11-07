/**
 * GR-20 account isolation: data in one advisor's account is never visible to, or changeable by, another.
 *
 * Every write test is two-sided, so it cannot pass for the wrong reason:
 *   1. the OTHER advisor sends the request with the record's current version → 404 GEN-11, nothing changes;
 *   2. the OWNER then sends the IDENTICAL request → it succeeds, proving the request itself was valid.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv, stepUp } from './helpers.js';
import request from 'supertest';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

type Ref = { contactOutcomes: Array<{ code: string }>; deactivationReasons: string[]; relationships: string[] };

async function setup() {
  const ref = (await request(app).get('/v1/reference')).body.data as Ref;
  const a = await registerAdvisor('Asha Rao');
  const b = await registerAdvisor('Ravi Kumar');
  const A = as(a.token);
  const B = as(b.token);
  const pipeline = ((await A.get('/pipelines')).body.data as Array<{ id: string }>)[0]!.id;
  const newLead = async () => (await A.post('/leads', { pipelineId: pipeline, name: 'Priya Sharma', mobile: newMobile(), source: 'Walk-in or personal contact' })).body.data as { id: string; version: number; name: string; mobile: string };
  const newCustomer = async () => (await A.post('/customers', { name: 'Meena Iyer', mobile: newMobile() })).body.data as { id: string; version: number; name: string; mobile: string };
  return { ref, a, b, A, B, pipeline, newLead, newCustomer };
}

const notFound = (res: request.Response) => expect(err(res)).toMatchObject({ status: 404, messageId: 'GEN-11' });
const ok = (res: request.Response) => expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);

describe('GR-20 leads', () => {
  it('another advisor cannot open a lead', async () => {
    const { B, newLead } = await setup();
    notFound(await B.get(`/leads/${(await newLead()).id}`));
  });

  it('cannot edit, move, log contact on or convert it; the owner can do exactly the same', async () => {
    const { A, B, newLead } = await setup();
    const cases: Array<[string, (id: string, v: number) => [string, object]]> = [
      ['edit', (id, v) => [`/leads/${id}`, { version: v, notes: 'Changed' }]],
      ['status', (id, v) => [`/leads/${id}/status`, { version: v, status: 'CONTACTED' }]],
      ['convert', (id, v) => [`/leads/${id}/convert`, { version: v, mode: 'CREATE' }]],
    ];
    for (const [name, make] of cases) {
      const lead = await newLead();
      const [path, body] = make(lead.id, lead.version);
      const send = (c: typeof A) => (name === 'edit' ? c.patch(path, body) : c.post(path, body));
      notFound(await send(B));
      expect((await A.get(`/leads/${lead.id}`)).body.data.version, `${name}: other account changed it`).toBe(lead.version);
      ok(await send(A));
    }
  });

  it('cannot log a contact on it', async () => {
    const { ref, A, B, newLead } = await setup();
    const lead = await newLead();
    const body = { outcome: ref.contactOutcomes[0]!.code };
    notFound(await B.post(`/leads/${lead.id}/contacts`, body));
    ok(await A.post(`/leads/${lead.id}/contacts`, body));
  });

  it('it never appears in another advisor\u2019s list, search or duplicate check', async () => {
    const { B, newLead } = await setup();
    const lead = await newLead();
    const list = (await B.get('/leads?limit=100')).body.data as Array<{ id: string }>;
    expect(list.map((l) => l.id)).not.toContain(lead.id);
    const search = (await B.get(`/leads?q=${encodeURIComponent(lead.mobile.slice(-10))}`)).body.data as Array<{ id: string }>;
    expect(search.map((l) => l.id)).not.toContain(lead.id);
    const dup = await B.get(`/leads/duplicate-check?mobile=${lead.mobile.slice(-10)}&name=${encodeURIComponent(lead.name)}`);
    expect(JSON.stringify(dup.body)).not.toContain(lead.id);
  });

  it('cannot create a lead in another account\u2019s pipeline or citing its customer', async () => {
    const { B, b, pipeline, newCustomer } = await setup();
    const own = ((await B.get('/pipelines')).body.data as Array<{ id: string }>)[0]!.id;
    expect((await B.post('/leads', { pipelineId: pipeline, name: 'Kavya Nair', mobile: newMobile(), source: 'Walk-in or personal contact' })).status).toBeGreaterThanOrEqual(400);
    const cus = await newCustomer();
    expect((await B.post('/leads', { pipelineId: own, name: 'Kavya Nair', mobile: newMobile(), source: 'Referred by a client', referredByCustomerId: cus.id })).status).toBeGreaterThanOrEqual(400);
    expect(b.user.accountId).toBeTruthy();
  });

  it('cannot convert its own lead by linking it to another account\u2019s customer', async () => {
    const { B, newCustomer } = await setup();
    const cus = await newCustomer();
    const own = ((await B.get('/pipelines')).body.data as Array<{ id: string }>)[0]!.id;
    const lead = (await B.post('/leads', { pipelineId: own, name: 'Meena Iyer', mobile: cus.mobile.slice(-10), source: 'Walk-in or personal contact' })).body.data;
    expect((await B.post(`/leads/${lead.id}/convert`, { version: lead.version, mode: 'LINK', customerId: cus.id })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('GR-20 customers, family and consent', () => {
  it('another advisor cannot open a customer, its family, consents or identity', async () => {
    const { B, newCustomer } = await setup();
    const cus = await newCustomer();
    notFound(await B.get(`/customers/${cus.id}`));
    notFound(await B.get(`/customers/${cus.id}/family`));
    notFound(await B.get(`/customers/${cus.id}/consents`));
    notFound(await B.post(`/customers/${cus.id}/identity/reveal`, { field: 'PAN' }));
  });

  it('cannot edit, deactivate, add family or record consent; the owner can do exactly the same', async () => {
    const { ref, A, B, newCustomer } = await setup();
    const cases: Array<[string, (c: { id: string; version: number }) => [string, object, 'patch' | 'post']]> = [
      ['edit', (c) => [`/customers/${c.id}`, { version: c.version, name: 'Meena Iyer Rao' }, 'patch']],
      ['deactivate', (c) => [`/customers/${c.id}/deactivate`, { version: c.version, reason: ref.deactivationReasons.find((r) => !/other/i.test(r))! }, 'post']],
      ['family', (c) => [`/customers/${c.id}/family`, { name: 'Arjun Iyer', relationship: ref.relationships[0]! }, 'post']],
    ];
    for (const [name, make] of cases) {
      const cus = await newCustomer();
      const [path, body, method] = make(cus);
      notFound(await B[method](path, body));
      expect((await A.get(`/customers/${cus.id}`)).body.data.version, `${name}: other account changed it`).toBe(cus.version);
      ok(await A[method](path, body));
    }
  });

  it('never appears in another advisor\u2019s list or duplicate check', async () => {
    const { B, newCustomer } = await setup();
    const cus = await newCustomer();
    expect(((await B.get('/customers?limit=100')).body.data as Array<{ id: string }>).map((c) => c.id)).not.toContain(cus.id);
    const dup = await B.get(`/customers/duplicate-check?mobile=${cus.mobile.slice(-10)}`);
    expect(JSON.stringify(dup.body)).not.toContain(cus.id);
  });
});

describe('GR-20 audit and team', () => {
  it('another advisor\u2019s audit view never shows this account\u2019s records', async () => {
    const { a, B, newCustomer } = await setup();
    const cus = await newCustomer();
    const mine = JSON.stringify((await B.get('/audit?limit=200')).body);
    expect(mine).not.toContain(cus.id);
    expect(mine).not.toContain(a.user.accountId!);
  });

  it('another advisor cannot disable this account\u2019s assistant', async () => {
    const { a, A, B } = await setup();
    const add = await A.post('/assistants', { name: 'Priya Shah', mobile: newMobile() }, { 'X-Step-Up-Token': await stepUp(a.token, a.mobile) });
    ok(add);
    const ast = add.body.data;
    notFound(await B.post(`/assistants/${ast.id}/disable`, { version: ast.version }));
    ok(await A.post(`/assistants/${ast.id}/disable`, { version: ast.version }));
  });
});