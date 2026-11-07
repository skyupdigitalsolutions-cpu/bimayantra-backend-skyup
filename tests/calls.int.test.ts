/** Calls and recordings from the mobile app (the request shapes of the existing SkyUp mobile app). */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { Call } from '../src/modules/calls/call.model.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { StoredFile } from '../src/modules/files/file.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const MP3 = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.alloc(4000, 7)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\ntrailer << >>\n%%EOF\n');
async function world() {
  const adv = await registerAdvisor('Asha Rao');
  const A = as(adv.token);
  const pipelineId = ((await A.get('/pipelines')).body.data as Array<{ id: string }>)[0]!.id;
  const leadMobile = newMobile();
  const lead = (await A.post('/leads', { name: 'Ravi Kumar', mobile: leadMobile, source: 'Walk-in or personal contact', pipelineId })).body.data;
  const cusMobile = newMobile();
  const cus = (await A.post('/customers', { name: 'Meena Iyer', mobile: cusMobile })).body.data;
  return { adv, A, lead, leadMobile, cus, cusMobile };
}
const upload = (token: string, fields: Record<string, string>, file = MP3, name = 'Call_9876543210_20261031.mp3') => {
  const r = request(app).post('/v1/call-logs/recording').set('Authorization', `Bearer ${token}`).set('X-Client', 'app');
  for (const [k, v] of Object.entries(fields)) r.field(k, v);
  return r.attach('recording', file, name);
};

describe('call log sync', () => {
  it('stores only lead and customer numbers (personal calls are ignored), never twice, and logs a contact on the lead', async () => {
    const w = await world();
    expect(w.lead?.id).toMatch(/^led_/);
    const t0 = Date.now() - 3_600_000;
    const logs = [
      { phoneNumber: w.leadMobile, callType: 'outgoing', duration: 192, timestamp: t0, name: 'Ravi' },
      { phoneNumber: `+91${w.cusMobile}`, callType: 'incoming', duration: 60, timestamp: t0 + 60_000 },
      { phoneNumber: '9000000001', callType: 'outgoing', duration: 300, timestamp: t0 + 120_000, name: 'Mom' }, // personal
      { phoneNumber: w.leadMobile, callType: 'missed', duration: 0, timestamp: t0 + 180_000 },
      { phoneNumber: 'abc', callType: 'outgoing', duration: 0, timestamp: t0 },
    ];
    const r = (await w.A.post('/call-logs/sync', { logs })).body.data;
    expect(r).toEqual({ received: 5, saved: 3, duplicates: 0, ignored: 1, invalid: 1 });
    expect(await Call.countDocuments({ phone: '+919000000001' })).toBe(0); // never stored
    const again = (await w.A.post('/call-logs/sync', { logs })).body.data;
    expect(again).toMatchObject({ saved: 0, duplicates: 3 });
    const lead = await Lead.findById(w.lead.id).lean();
    expect(lead!.contacts.map((c) => c.outcome)).toEqual(['SPOKE_TO_CUSTOMER']); // the missed incoming call is not a contact
    expect(lead!.contacts[0]!.note).toBe('Phone call (outgoing) · 3 min 12 s · synced from the phone');
    const cusCalls = (await w.A.get(`/call-logs?customerId=${w.cus.id}`)).body.data;
    expect(cusCalls).toHaveLength(1);
    // another advisor's account never matches these numbers
    const other = await registerAdvisor('Kiran Das');
    expect((await as(other.token).post('/call-logs/sync', { logs: [logs[0]] })).body.data).toMatchObject({ saved: 0, ignored: 1 });
  });

  it('the iPhone web call is logged with an estimated duration', async () => {
    const w = await world();
    const s = Date.now() - 600_000;
    const c = (await w.A.post('/call-logs/app-call', { leadId: w.lead.id, phoneNumber: w.leadMobile, startedAt: s, returnedAt: s + 125_000 })).body.data;
    expect(c).toMatchObject({ durationSec: 125, durationEstimated: true, source: 'APP', leadId: w.lead.id });
    expect((await Lead.findById(w.lead.id).lean())!.contacts[0]!.note).toContain('(approx.)');
  });
});

describe('recordings', () => {
  it('attaches to the nearest call by content, once per file key; refuses non-audio; ignores unknown numbers', async () => {
    const w = await world();
    const t0 = Date.now() - 1_800_000;
    await w.A.post('/call-logs/sync', { logs: [{ phoneNumber: w.leadMobile, callType: 'outgoing', duration: 120, timestamp: t0 }] });
    const up = await upload(w.adv.token, { phoneNumber: w.leadMobile, timestamp: String(t0 + 125_000), fileKey: 'k-1' });
    expect(up.status).toBe(201);
    expect(up.body.meta.message).toBe('Recording attached to the call with Ravi Kumar.');
    expect(up.body.data.call).toMatchObject({ durationSec: 120, recordings: [{ mime: 'audio/mpeg', source: 'AUTO' }] });
    const dup = await upload(w.adv.token, { phoneNumber: w.leadMobile, timestamp: String(t0 + 125_000), fileKey: 'k-1' });
    expect(dup.body.data).toMatchObject({ stored: true, duplicate: true });
    expect(await StoredFile.countDocuments({ purpose: 'CALL_RECORDING' })).toBe(1);
    const bad = await upload(w.adv.token, { phoneNumber: w.leadMobile, fileKey: 'k-2' }, PDF, 'fake.mp3');
    expect(err(bad)).toMatchObject({ status: 400 });
    expect(bad.body.error.fields[0].messageId).toBe('CALL-02');
    const stranger = await upload(w.adv.token, { phoneNumber: '9000000002', fileKey: 'k-3' });
    expect(stranger.body.data).toEqual({ stored: false, reason: 'CALL-04' });
    // no call nearby: a call row is made for the recording (iPhone attach)
    const manual = await upload(w.adv.token, { phoneNumber: w.cusMobile, timestamp: String(Date.now() - 86_400_000 * 3), fileKey: 'k-4', source: 'manual', customerId: w.cus.id });
    expect(manual.body.data.call).toMatchObject({ source: 'RECORDING', customerId: w.cus.id, recordings: [{ source: 'MANUAL' }] });
  });

  it('only the advisor plays recordings (also through /files); playback supports ranges and is audited once', async () => {
    const w = await world();
    const t0 = Date.now() - 1_800_000;
    await w.A.post('/call-logs/sync', { logs: [{ phoneNumber: w.leadMobile, callType: 'outgoing', duration: 60, timestamp: t0 }] });
    const call = (await upload(w.adv.token, { phoneNumber: w.leadMobile, timestamp: String(t0 + 60_000), fileKey: 'p-1' })).body.data.call;
    const url = `/v1/call-logs/${call.id}/recordings/${call.recordings[0].id}/audio`;
    const full = await request(app).get(url).set('Authorization', `Bearer ${w.adv.token}`).set('X-Client', 'app').buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(full.status).toBe(200);
    expect((full.body as Buffer).length).toBe(MP3.length);
    const part = await request(app).get(url).set('Authorization', `Bearer ${w.adv.token}`).set('X-Client', 'app').set('Range', 'bytes=100-199');
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 100-199/${MP3.length}`);
    expect(await AuditLog.countDocuments({ action: 'CALL_RECORDING_PLAYED' })).toBe(1); // the range read is not a new listen
    const m = newMobile();
    await w.A.post('/assistants', { name: 'Priya Shah', mobile: m }, { 'X-Step-Up-Token': await stepUp(w.adv.token, w.adv.mobile) });
    const ast = await login(m);
    expect((await as(ast.token).get(`/call-logs/lead/${w.lead.id}`)).body.data).toHaveLength(1); // assistants see calls
    expect((await request(app).get(url).set('Authorization', `Bearer ${ast.token}`).set('X-Client', 'app')).status).toBe(403);
    const fileId = (await Call.findById(call.id).lean())!.recordings[0]!.fileId;
    expect((await request(app).get(`/v1/files/${fileId}`).set('Authorization', `Bearer ${ast.token}`).set('X-Client', 'app')).status).toBe(404);
    const other = await registerAdvisor('Kiran Das');
    expect((await request(app).get(url).set('Authorization', `Bearer ${other.token}`).set('X-Client', 'app')).status).toBe(404);
  });
});