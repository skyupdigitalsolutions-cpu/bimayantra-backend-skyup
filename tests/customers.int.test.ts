import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verhoeffComplete } from '../src/lib/fields.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { Customer } from '../src/modules/customers/customer.model.js';
import { as, err, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

async function setup() {
  const adv = await registerAdvisor();
  const c = as(adv.token);
  const cus = (await c.post('/customers', { name: 'Meena Iyer', mobile: newMobile(), email: 'meena@example.com' })).body.data;
  const giveData = () => c.post(`/customers/${cus.id}/consents`, { personType: 'CUSTOMER', personId: cus.id, channel: 'PERSONAL_DATA', action: 'GIVE', howGiven: 'Signed form', declaration: true });
  return { adv, c, cus, giveData };
}

describe('P-15 Customers', () => {
  it('AC-P15-1/2: saves with name and mobile (CU-01); exact duplicate blocked (CU-02); other name warns (CU-03)', async () => {
    const { c, cus } = await setup();
    expect(cus).toMatchObject({ number: 'CU-000001', status: 'ACTIVE', source: 'Direct' });
    expect(err(await c.post('/customers', { name: 'MEENA iyer', mobile: cus.mobile }))).toMatchObject({ status: 409, messageId: 'CU-02' });
    expect(err(await c.post('/customers', { name: 'Ramesh Iyer', mobile: cus.mobile }))).toMatchObject({ status: 409, messageId: 'CU-03' });
    expect((await c.post('/customers', { name: 'Ramesh Iyer', mobile: cus.mobile, confirm: ['CU-03'] })).status).toBe(201);
  });

  it('field rules: DOB in the future is VAL-05, PIN starting with 0 is VAL-15, an unknown state is VAL-22', async () => {
    const { c } = await setup();
    const r = await c.post('/customers', { name: 'Ravi Kumar', mobile: newMobile(), dob: '2999-01-01', pin: '012345', state: 'Atlantis' });
    expect(r.body.error.messageId).toBe('GEN-02');
    expect(Object.fromEntries(r.body.error.fields.map((f: { field: string; messageId: string }) => [f.field, f.messageId]))).toEqual({ dob: 'VAL-05', pin: 'VAL-15', state: 'VAL-22' });
  });

  it('AC-P15-4: changing the mobile asks CU-21 first and resets WhatsApp and SMS consent', async () => {
    const { c, cus } = await setup();
    await c.post(`/customers/${cus.id}/consents`, { personType: 'CUSTOMER', personId: cus.id, channel: 'WHATSAPP', action: 'GIVE', howGiven: 'Replied on WhatsApp', declaration: true });
    const ask = await c.patch(`/customers/${cus.id}`, { version: 1, mobile: newMobile() });
    expect(err(ask)).toMatchObject({ status: 409, messageId: 'CU-21' });
    const ok = await c.patch(`/customers/${cus.id}`, { version: 1, mobile: newMobile(), confirm: ['CU-21'] });
    expect(ok.status).toBe(200);
    const grid = (await c.get(`/customers/${cus.id}/consents`)).body.data;
    expect(grid.rows[0].channels.WHATSAPP.status).toBe('NOT_RECORDED');
  });

  it('AC-P15-6/7/8: PAN needs personal-data consent (CU-23); stored encrypted, shown masked; reveal is advisor-only and audited', async () => {
    const { c, cus, giveData } = await setup();
    expect(err(await c.put(`/customers/${cus.id}/identity`, { version: 1, pan: 'ABCPE1234F' }))).toMatchObject({ status: 409, messageId: 'CU-23' });
    expect((await giveData()).body.meta.message).toBe('Personal-data consent recorded for Meena Iyer.');
    expect((await c.put(`/customers/${cus.id}/identity`, { version: 1, pan: 'ABCCE1234F' })).body.error.messageId).toBe('VAL-16');
    const aadhaar = verhoeffComplete('23456789012');
    const saved = await c.put(`/customers/${cus.id}/identity`, { version: 1, pan: 'abcpe1234f', aadhaar });
    expect(saved.body.data.identity).toEqual({ pan: 'ABCXX1234F', aadhaar: `XXXX XXXX ${aadhaar.slice(-4)}` });
    const raw = await Customer.findById(cus.id).select('+identity.panEnc').lean();
    expect(raw!.identity!.panEnc).not.toContain('ABCPE1234F');
    const reveal = await c.post(`/customers/${cus.id}/identity/reveal`, { field: 'PAN' });
    expect(reveal.body).toMatchObject({ data: { value: 'ABCPE1234F', maskAfterSeconds: 30 }, meta: { messageId: 'CU-25' } });
    expect(await AuditLog.countDocuments({ action: 'PERSONAL_DATA_VIEWED' })).toBe(1);
    expect(JSON.stringify(await AuditLog.find().lean())).not.toContain('ABCPE1234F');
  });

  it('CU-29: the same PAN on another active customer is a warning, and the save goes through', async () => {
    const { c, cus, giveData } = await setup();
    await giveData();
    await c.put(`/customers/${cus.id}/identity`, { version: 1, pan: 'ABCPE1234F' });
    const other = (await c.post('/customers', { name: 'Ravi Kumar', mobile: newMobile() })).body.data;
    await c.post(`/customers/${other.id}/consents`, { personType: 'CUSTOMER', personId: other.id, channel: 'PERSONAL_DATA', action: 'GIVE', howGiven: 'Signed form', declaration: true });
    const r = await c.put(`/customers/${other.id}/identity`, { version: 1, pan: 'ABCPE1234F' });
    expect(r.status).toBe(200);
    expect(r.body.meta.warnings[0].message).toBe('Another customer (CU-000001) has this PAN. Check the number.');
  });
});

describe('P-16 Family and P-17 Consent', () => {
  it('AC-P16-4: CU-07 duplicate member; (CFG-35 + 1)th member refused (CU-06)', async () => {
    const { c, cus } = await setup();
    expect((await c.post(`/customers/${cus.id}/family`, { name: 'Arjun Iyer', relationship: 'Son' })).body.meta.message).toBe("Arjun Iyer added to Meena Iyer's family.");
    expect(err(await c.post(`/customers/${cus.id}/family`, { name: 'arjun iyer', relationship: 'Son' }))).toMatchObject({ status: 409, messageId: 'CU-07' });
    for (let i = 0; i < 14; i++) await c.post(`/customers/${cus.id}/family`, { name: `Relative ${String.fromCharCode(65 + i)}`, relationship: 'Other' });
    expect(err(await c.post(`/customers/${cus.id}/family`, { name: 'One More', relationship: 'Other' }))).toMatchObject({ status: 409, messageId: 'CU-06' });
  });

  it('AC-P17-1/4: WhatsApp consent needs a mobile (CU-13); declaration (VAL-29); history keeps who and how', async () => {
    const { c, cus } = await setup();
    const m = (await c.post(`/customers/${cus.id}/family`, { name: 'Arjun Iyer', relationship: 'Son' })).body.data;
    const noMobile = await c.post(`/customers/${cus.id}/consents`, { personType: 'FAMILY', personId: m.id, channel: 'WHATSAPP', action: 'GIVE', howGiven: 'Signed form', declaration: true });
    expect(err(noMobile)).toMatchObject({ status: 409, messageId: 'CU-13' });
    expect(noMobile.body.error.message).toBe('Add a mobile number for Arjun Iyer before recording WhatsApp consent.');
    const noTick = await c.post(`/customers/${cus.id}/consents`, { personType: 'CUSTOMER', personId: cus.id, channel: 'EMAIL', action: 'GIVE', howGiven: 'Signed form' });
    expect(noTick.body.error.fields[0].messageId).toBe('VAL-29');
    await c.post(`/customers/${cus.id}/consents`, { personType: 'CUSTOMER', personId: cus.id, channel: 'EMAIL', action: 'GIVE', howGiven: 'Signed form', declaration: true });
    const w = await c.post(`/customers/${cus.id}/consents`, { personType: 'CUSTOMER', personId: cus.id, channel: 'EMAIL', action: 'WITHDRAW' });
    expect(w.body.meta.message).toBe('Email consent withdrawn for Meena Iyer. No more automated Email messages will be sent.');
    expect(w.body.data.history.map((h: { to: string; by: string }) => h.to)).toEqual(['WITHDRAWN', 'GIVEN']);
  });
});

describe('P-19 Deactivate', () => {
  it('needs a reason; INACTIVE blocks edits (CU-20); reactivate (CU-10)', async () => {
    const { c, cus } = await setup();
    expect((await c.post(`/customers/${cus.id}/deactivate`, { version: 1 })).body.error.fields[0].message).toBe('Reason is required.');
    const d = await c.post(`/customers/${cus.id}/deactivate`, { version: 1, reason: 'Not reachable' });
    expect(d.body.meta.message).toBe('Meena Iyer is now inactive. Automated messages to this customer and family have stopped.');
    expect(err(await c.patch(`/customers/${cus.id}`, { version: 2, occupation: 'Teacher' }))).toMatchObject({ status: 409, messageId: 'CU-20' });
    expect((await c.post(`/customers/${cus.id}/reactivate`, { version: 2 })).body.meta.messageId).toBe('CU-10');
  });
});
