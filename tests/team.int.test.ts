import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { as, err, login, newMobile, registerAdvisor, resetState, seedAdmin, startTestEnv, stepUp, stopTestEnv } from './helpers.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

async function addAssistant(adv: { token: string; mobile: string }, mobile = newMobile()) {
  const r = await as(adv.token).post('/assistants', { name: 'Kiran Assistant', mobile }, { 'X-Step-Up-Token': await stepUp(adv.token, adv.mobile) });
  return { r, mobile };
}

describe('P-53 Assistants', () => {
  it('needs the step-up OTP (AUTH-26); added INVITED (AST-01); ACTIVE at first login (AUTH-12)', async () => {
    const adv = await registerAdvisor();
    expect(err(await as(adv.token).post('/assistants', { name: 'Kiran', mobile: newMobile() }))).toMatchObject({ status: 403, messageId: 'AUTH-26' });
    const { r, mobile } = await addAssistant(adv);
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('INVITED');
    expect(r.body.meta.message).toBe('Assistant Kiran Assistant added. They can log in with their mobile number.');
    const ast = await login(mobile);
    expect(ast.user).toMatchObject({ role: 'AST', accountId: adv.user.accountId });
    const step = await AuditLog.findOne({ action: 'ASSISTANT_ADDED' }).lean();
    expect(step?.stepUpId).toBeTruthy();
  });

  it('AC-P53-3: the (CFG-158 + 1)th assistant is refused (AST-02); a used mobile is REF-02', async () => {
    const adv = await registerAdvisor();
    await addAssistant(adv);
    await addAssistant(adv);
    expect(err((await addAssistant(adv)).r)).toMatchObject({ status: 409, messageId: 'AST-02' });
    const other = await registerAdvisor('Ravi Kumar');
    expect(err((await addAssistant(other, adv.mobile)).r)).toMatchObject({ status: 409, messageId: 'REF-02' });
  });

  it('AC-P53-1: an assistant can create leads and customers but cannot mark lost, deactivate, reveal PAN or manage assistants', async () => {
    const adv = await registerAdvisor();
    const { mobile } = await addAssistant(adv);
    const ast = as((await login(mobile)).token);
    const pipelines = (await ast.get('/pipelines')).body.data;
    const lead = await ast.post('/leads', { pipelineId: pipelines[0].id, name: 'Ravi Kumar', mobile: newMobile(), source: 'Other' });
    expect(lead.status).toBe(201);
    expect(lead.body.data.allowedMoves).toEqual(['CONTACTED', 'FOLLOW_UP']);
    const lost = await ast.post(`/leads/${lead.body.data.id}/status`, { version: 1, status: 'LOST', lostReason: 'Not interested' });
    expect(err(lost)).toMatchObject({ status: 403, messageId: 'GEN-03' });
    const cus = await ast.post('/customers', { name: 'Meena Iyer', mobile: newMobile() });
    expect(cus.status).toBe(201);
    expect(err(await ast.post(`/customers/${cus.body.data.id}/deactivate`, { version: 1, reason: 'Deceased' }))).toMatchObject({ status: 403 });
    expect(err(await ast.post(`/customers/${cus.body.data.id}/identity/reveal`, { field: 'PAN' }))).toMatchObject({ status: 403 });
    expect(err(await ast.get('/assistants'))).toMatchObject({ status: 403 });
  });

  it('disable ends the assistant\'s sessions at once (AST-03)', async () => {
    const adv = await registerAdvisor();
    const { r, mobile } = await addAssistant(adv);
    const ast = await login(mobile);
    const list = await as(adv.token).get('/assistants');
    const d = await as(adv.token).post(`/assistants/${r.body.data.id}/disable`, { version: list.body.data.items[0].version });
    expect(d.body.meta.messageId).toBe('AST-03');
    expect(err(await as(ast.token).get('/auth/me'))).toMatchObject({ status: 401, messageId: 'AUTH-11' });
  });
});

describe('P-48 SkyUp users and support access', () => {
  it('ADM adds STF with OTP (ADM-01); STF cannot open the API (AC-P48-3); self (ADM-03) and last ADM (ADM-02) are protected', async () => {
    const adm = await seedAdmin();
    const stfMobile = newMobile();
    const add = await as(adm.token).post('/staff', { name: 'Sita Staff', mobile: stfMobile, role: 'STF' }, { 'X-Step-Up-Token': await stepUp(adm.token, adm.mobile) });
    expect(add.body.meta.message).toBe('Sita Staff added as SkyUp Staff. They can log in with their mobile number.');
    const stf = await login(stfMobile);
    expect(err(await as(stf.token).get('/staff'))).toMatchObject({ status: 403, messageId: 'GEN-03' });
    const self = await as(adm.token).post(`/staff/${adm.user.id}/disable`, { version: 1 }, { 'X-Step-Up-Token': await stepUp(adm.token, adm.mobile) });
    expect(err(self)).toMatchObject({ status: 409, messageId: 'ADM-03' });
    const second = newMobile();
    const add2 = await as(adm.token).post('/staff', { name: 'Arun Admin', mobile: second, role: 'ADM' }, { 'X-Step-Up-Token': await stepUp(adm.token, adm.mobile) });
    const adm2 = await login(second);
    expect((await as(adm2.token).post(`/staff/${adm.user.id}/disable`, { version: 1 }, { 'X-Step-Up-Token': await stepUp(adm2.token, second) })).status).toBe(200);
    const last = await as(adm2.token).post(`/staff/${add2.body.data.id}/role`, { role: 'STF', version: 2 }, { 'X-Step-Up-Token': await stepUp(adm2.token, second) });
    expect(err(last)).toMatchObject({ status: 409, messageId: 'ADM-03' });
  });

  it('AC-P57-1: SkyUp cannot open client records without a support grant (SUP-03), and the attempt is logged', async () => {
    const adm = await seedAdmin();
    expect(err(await as(adm.token).get('/leads'))).toMatchObject({ status: 403, messageId: 'SUP-03' });
    expect(await AuditLog.countDocuments({ action: 'SUPPORT_ACCESS_REFUSED' })).toBe(1);
  });
});
