/** Stage D — tasks (#21), consent (#24), saved document types (#25), bell events (#23), Life/Term split (#18). */
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, as, err, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { clock } from '../src/lib/clock.js';
import { Account } from '../src/modules/accounts/account.model.js';
import { Consent, Customer } from '../src/modules/customers/customer.model.js';
import { AccountDocumentType } from '../src/modules/documents/accountDocType.model.js';
import { CustomerDocument } from '../src/modules/documents/document.model.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { runSweep } from '../src/modules/notifications/sweep.js';
import { Product } from '../src/modules/catalogue/product.model.js';
import { announcePublished } from '../src/modules/catalogue/products.service.js';
import { Connection } from '../src/modules/campaigns/campaign.model.js';
import { catchUp } from '../src/modules/campaigns/campaigns.service.js';
import { runLifeTermSplit } from '../src/modules/migrations/lifeTerm.js';
import { encryptField } from '../src/lib/crypto.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';

beforeAll(async () => { Object.assign(process.env, { META_APP_ID: 'a', META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v' }); await startTestEnv(); });
afterAll(stopTestEnv);
beforeEach(async () => { clock.setOffset(0); await resetState(); });
afterEach(() => vi.unstubAllGlobals());

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const istDate = (offsetDays: number) => { const d = new Date(Date.now() + 5.5 * 3_600_000 + offsetDays * 86_400_000); return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`; };
const istWeekday = (iso: string) => new Date(`${iso}T12:00:00+05:30`).getUTCDay();
const istIsoOf = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString();

describe('tasks (#21)', () => {
  it('type and priority on create and edit; the Cancelled tab; filter by type', async () => {
    const adv = await registerAdvisor('Asha Rao');
    const A = as(adv.token);
    const t = (await A.post('/tasks', { title: 'Call Ravi', dueDate: istDate(2), dueTime: '10:00 AM', taskType: 'CALL', priority: 'HIGH' })).body.data;
    expect(t).toMatchObject({ taskType: 'CALL', priority: 'HIGH' });
    const plain = (await A.post('/tasks', { title: 'Plain', dueDate: istDate(2), dueTime: '11:00 AM' })).body.data;
    expect(plain).toMatchObject({ taskType: null, priority: 'MEDIUM' });
    expect((await A.patch(`/tasks/${plain.id}`, { version: plain.version, priority: 'LOW', taskType: 'MEETING' })).body.data).toMatchObject({ priority: 'LOW', taskType: 'MEETING' });
    expect(err(await A.post('/tasks', { title: 'x', dueDate: istDate(2), dueTime: '10:00 AM', taskType: 'DANCE' }))).toMatchObject({ status: 400 });
    const calls = (await A.get('/tasks?tab=UPCOMING&type=CALL')).body.data;
    expect(calls.tasks.map((x: { title: string }) => x.title)).toEqual(['Call Ravi']);
    await A.post(`/tasks/${t.id}/cancel`, { version: t.version });
    const cancelled = (await A.get('/tasks?tab=CANCELLED')).body.data;
    expect(cancelled.tasks.map((x: { title: string }) => x.title)).toEqual(['Call Ravi']);
    expect(cancelled.counts.CANCELLED).toBe(1);
  });

  it('quick reschedule: tomorrow keeps the time, this Friday and next Monday land on those days, later today is ahead; a stale version is refused (GEN-05)', async () => {
    const adv = await registerAdvisor('Asha Rao');
    const A = as(adv.token);
    let t = (await A.post('/tasks', { title: 'Follow up', dueDate: istDate(3), dueTime: '04:30 PM' })).body.data;
    const r1 = await A.post(`/tasks/${t.id}/reschedule`, { version: t.version, preset: 'tomorrow' });
    expect(r1.body.meta.message).toMatch(/^Task moved to /);
    t = r1.body.data;
    expect(istIsoOf(new Date(t.dueAt)).slice(0, 16)).toBe(`${istIsoOf(new Date(Date.now() + 86_400_000)).slice(0, 10)}T16:30`);
    t = (await A.post(`/tasks/${t.id}/reschedule`, { version: t.version, preset: 'this_friday' })).body.data;
    expect(istWeekday(istIsoOf(new Date(t.dueAt)).slice(0, 10))).toBe(5);
    expect(new Date(t.dueAt).getTime()).toBeGreaterThan(Date.now());
    t = (await A.post(`/tasks/${t.id}/reschedule`, { version: t.version, preset: 'next_monday' })).body.data;
    expect(istWeekday(istIsoOf(new Date(t.dueAt)).slice(0, 10))).toBe(1);
    const later = await A.post(`/tasks/${t.id}/reschedule`, { version: t.version, preset: 'later_today' });
    if (later.status === 200) expect(new Date(later.body.data.dueAt).getTime()).toBeGreaterThan(Date.now() + 100 * 60_000);
    else expect(later.body.error.fields[0]).toMatchObject({ field: 'preset', messageId: 'DSH-24' }); // too late in the day
    expect(err(await A.post(`/tasks/${t.id}/reschedule`, { version: 1, preset: 'tomorrow' }))).toMatchObject({ messageId: 'GEN-05' });
  });
});

describe('consent (#24)', () => {
  async function world(email: string | null = 'meena@example.com') {
    const adv = await registerAdvisor('Asha Rao');
    const A = as(adv.token);
    const cus = (await A.post('/customers', { name: 'Meena Iyer', mobile: newMobile(), ...(email ? { email } : {}) })).body.data;
    const accountId = (await Customer.findById(cus.id).lean())!.accountId;
    return { A, cus, accountId };
  }
  const give = (channels: string[], extra: object = {}) => ({ personType: 'CUSTOMER', channels, action: 'GIVE', howGiven: 'Verbal on a call', declaration: true, ...extra });

  it('several channels in one record: one row each; a refusal for one channel writes none', async () => {
    const w = await world(null);
    const bad = await w.A.post(`/customers/${w.cus.id}/consents`, give(['WHATSAPP', 'EMAIL'], { personId: w.cus.id }));
    expect(err(bad)).toMatchObject({ messageId: 'CU-14' });
    expect(await Consent.countDocuments({ accountId: w.accountId })).toBe(0); // WhatsApp was not saved either
    const ok = await w.A.post(`/customers/${w.cus.id}/consents`, give(['WHATSAPP', 'SMS'], { personId: w.cus.id }));
    expect(ok.body.meta.message).toBe('Consent recorded for Meena Iyer: WhatsApp, SMS.');
    expect((await Consent.find({ accountId: w.accountId }).lean()).map((c) => [c.channel, c.status, c.howGiven]).sort()).toEqual([['SMS', 'GIVEN', 'Verbal on a call'], ['WHATSAPP', 'GIVEN', 'Verbal on a call']]);
    expect(err(await w.A.post(`/customers/${w.cus.id}/consents`, { personType: 'CUSTOMER', personId: w.cus.id, action: 'GIVE', howGiven: 'Verbal on a call', declaration: true }))).toMatchObject({ status: 400 }); // neither channel nor channels
  });

  it('withdrawal stores the reason and note ("Other" needs a note); personal-data withdrawal stores the acknowledgement; the single-channel request works as before', async () => {
    const w = await world();
    await w.A.post(`/customers/${w.cus.id}/consents`, give(['WHATSAPP', 'EMAIL', 'PERSONAL_DATA'], { personId: w.cus.id }));
    const noNote = await w.A.post(`/customers/${w.cus.id}/consents`, { personType: 'CUSTOMER', personId: w.cus.id, channels: ['WHATSAPP', 'EMAIL'], action: 'WITHDRAW', withdrawReason: 'OTHER' });
    expect(noNote.body.error.fields[0]).toMatchObject({ field: 'withdrawNote', messageId: 'GEN-01' });
    const wd = await w.A.post(`/customers/${w.cus.id}/consents`, { personType: 'CUSTOMER', personId: w.cus.id, channels: ['WHATSAPP', 'EMAIL'], action: 'WITHDRAW', withdrawReason: 'REPLIED_STOP' });
    expect(wd.body.meta.message).toBe('Consent withdrawn for Meena Iyer: WhatsApp, Email.');
    expect(await Consent.findOne({ accountId: w.accountId, channel: 'EMAIL' }).lean()).toMatchObject({ status: 'WITHDRAWN', withdrawReason: 'REPLIED_STOP' });
    await w.A.post(`/customers/${w.cus.id}/consents`, { personType: 'CUSTOMER', personId: w.cus.id, channel: 'PERSONAL_DATA', action: 'WITHDRAW', withdrawReason: 'ASKED_TO_STOP', acknowledgedEffects: true });
    expect(await Consent.findOne({ accountId: w.accountId, channel: 'PERSONAL_DATA' }).lean()).toMatchObject({ status: 'WITHDRAWN', withdrawReason: 'ASKED_TO_STOP', acknowledgedEffects: true });
    const again = await w.A.post(`/customers/${w.cus.id}/consents`, { personType: 'CUSTOMER', personId: w.cus.id, channel: 'WHATSAPP', action: 'GIVE', howGiven: 'Told me in person or by phone', declaration: true });
    expect(again.status).toBe(200); // the existing single-channel request, older "how given" value
    expect(await Consent.findOne({ accountId: w.accountId, channel: 'WHATSAPP' }).lean()).toMatchObject({ status: 'GIVEN', withdrawReason: null });
  });
});

describe('saved document types (#25)', () => {
  it('"Other" with save-as-type remembers the name; the same name in any case links to it; the list and add endpoints', async () => {
    const adv = await registerAdvisor('Asha Rao');
    const A = as(adv.token);
    const cus = (await A.post('/customers', { name: 'Meena Iyer', mobile: newMobile() })).body.data;
    const up = async (name: string, saveAsType?: boolean) => {
      const f = (await request(app).post('/v1/files?purpose=CUSTOMER_DOCUMENT').set('Authorization', `Bearer ${adv.token}`).set('X-Client', 'app').set('Content-Type', 'application/octet-stream').set('X-File-Name', 'x.png').send(PNG)).body.data;
      return A.post('/documents', { customerId: cus.id, personKey: `C:${cus.id}`, type: 'Other', name, fileId: f.id, ...(saveAsType !== undefined ? { saveAsType } : {}) });
    };
    expect((await up('Employer letter', true)).status).toBe(201);
    const t = await AccountDocumentType.findOne({}).lean();
    expect(t).toMatchObject({ name: 'Employer letter' });
    await up('EMPLOYER LETTER');
    const docs = await CustomerDocument.find({ type: 'Other' }).lean();
    expect(docs.map((d) => d.accountDocumentTypeId)).toEqual([t!._id, t!._id]);
    await up('Rent agreement'); // not saved as a type
    expect((await A.get('/account/document-types')).body.data).toEqual([{ id: t!._id, name: 'Employer letter' }]);
    const add = await A.post('/account/document-types', { name: 'Rent agreement' });
    expect(add.status).toBe(201);
    expect(add.body.meta.message).toBe('Saved "Rent agreement" as a document type you can pick again.');
    expect((await A.post('/account/document-types', { name: 'rent AGREEMENT' })).status).toBe(200); // already saved
    expect((await A.get('/account/document-types')).body.data.map((x: { name: string }) => x.name)).toEqual(['Employer letter', 'Rent agreement']);
    const other = await registerAdvisor('Kiran Das');
    expect((await as(other.token).get('/account/document-types')).body.data).toEqual([]);
  });
});

describe('bell events (#23)', () => {
  it('follow-up overdue (once per follow-up time), a new verified product (once, not for own products), campaign sync failed (once a day, not for sign-in errors)', async () => {
    const adv = await registerAdvisor('Asha Rao');
    const A = as(adv.token);
    const pipelineId = ((await A.get('/pipelines')).body.data as Array<{ id: string }>)[0]!.id;
    const lead = (await A.post('/leads', { pipelineId, name: 'Ravi Kumar', mobile: newMobile(), source: 'Walk-in or personal contact' })).body.data;
    await Lead.updateOne({ _id: lead.id }, { $set: { nextFollowUpAt: new Date(Date.now() - 3_600_000) } });
    await runSweep(); await runSweep();
    const over = await Notification.find({ kind: 'FOLLOW_UP_OVERDUE' }).lean();
    expect(over).toHaveLength(1);
    expect(over[0]!.message).toMatch(/^Follow-up overdue: Ravi Kumar was due \d{2}:\d{2}\.$/);
    expect(over[0]).toMatchObject({ linkType: 'LEAD', linkId: lead.id });

    const accountId = (await Lead.findById(lead.id).lean())!.accountId;
    await Insurer.collection.insertOne({ _id: 'ins_x' as never, name: 'Star Health', irdaiRegNo: '129' });
    await Product.collection.insertMany([
      { _id: 'prd_v' as never, kind: 'VERIFIED', insurerId: 'ins_x', typeId: 'typ_x', code: 'V', status: 'ACTIVE', name: 'Family Care', makerId: 'u' },
      { _id: 'prd_o' as never, kind: 'OWN', accountId, insurerId: 'ins_x', typeId: 'typ_x', code: 'O', status: 'ACTIVE', name: 'My Plan', makerId: 'u' },
    ]);
    expect(await announcePublished('prd_v')).toBe(1);
    expect(await announcePublished('prd_v')).toBe(0); // once per product
    expect(await announcePublished('prd_o')).toBe(0); // own products are not announced
    const pub = await Notification.findOne({ kind: 'CATALOGUE_PRODUCT_PUBLISHED' }).lean();
    expect(pub!.message).toBe('New in the catalogue: Family Care by Star Health.');
    expect((await A.post(`/notifications/${pub!._id}/open`, {})).body.data.link).toEqual({ type: 'PRODUCT', id: 'prd_v' });

    await Connection.create({ accountId, channel: 'META', name: 'Meta Ads', status: 'CONNECTED', createdBy: 'u', tokenEnc: encryptField('T'), sources: [{ id: '111', name: 'Page', tokenEnc: encryptField('PT'), subscribed: true }] });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'Service unavailable', code: 2 } }), { status: 503 }));
    await catchUp(); await catchUp();
    const failed = await Notification.find({ kind: 'CAMPAIGN_SYNC_FAILED' }).lean();
    expect(failed).toHaveLength(1);
    expect(failed[0]!.message).toBe('Meta Ads could not sync: Meta Ads. We will keep trying every 15 minutes.');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'Invalid token', code: 190 } }), { status: 400 }));
    await Notification.deleteMany({});
    await catchUp();
    expect(await Notification.countDocuments({ kind: 'CAMPAIGN_SYNC_FAILED' })).toBe(0);
    expect(await Notification.countDocuments({ kind: 'CONNECTION_RECONNECT_NEEDED' })).toBe(1);
  });
});

describe('Life / Term pipelines (#18)', () => {
  it('new accounts get Life and Term; the migration renames, adds Term, moves term leads, keeps stages; dry run writes nothing; a second run does nothing', async () => {
    const adv = await registerAdvisor('Asha Rao');
    const A = as(adv.token);
    expect(((await A.get('/pipelines')).body.data as Array<{ name: string }>).map((p) => p.name)).toEqual(['Health', 'Motor', 'Life', 'Term', 'Travel', 'Other']);
    const accountId = (await Account.findOne({}).lean())!._id;
    const old = [{ _id: 'pip_h', name: 'Health', position: 1 }, { _id: 'pip_lt', name: 'Life and Term', position: 2 }, { _id: 'pip_o', name: 'Other', position: 3 }];
    await Account.updateOne({ _id: accountId }, { $set: { pipelines: old } });
    const lead = (name: string, interests: string[]) => ({ _id: `led_${name}` as never, accountId, pipelineId: 'pip_lt', name, nameKey: name, mobile: `+9198765${Math.floor(10000 + Math.random() * 89999)}`, source: 'Other', status: 'QUALIFIED', isOpen: true, interests, stageHistory: [{ from: null, to: 'NEW', by: 'u', at: new Date() }, { from: 'NEW', to: 'QUALIFIED', by: 'u', at: new Date() }], createdBy: 'u', number: name, pipelineVersion: 1 });
    await Lead.collection.insertMany([lead('a', ['Term Life']), lead('b', ['Health', 'term insurance']), lead('c', ['Endowment'])]);
    const dry = await runLifeTermSplit({ apply: false });
    expect(dry).toMatchObject({ accounts: 1, renamedToLife: 1, termPipelinesAdded: 1, leadsToTerm: 2, leadsStayInLife: 1 });
    expect((await Account.findById(accountId).lean())!.pipelines.map((p) => p.name)).toEqual(['Health', 'Life and Term', 'Other']);
    await runLifeTermSplit({ apply: true });
    const pips = (await Account.findById(accountId).lean())!.pipelines;
    expect(pips.map((p) => [p.name, p.position])).toEqual([['Health', 1], ['Life', 2], ['Term', 3], ['Other', 4]]);
    const term = pips.find((p) => p.name === 'Term')!;
    expect((await Lead.find({ accountId }).sort({ _id: 1 }).lean()).map((l) => [l._id, l.pipelineId, l.status, l.stageHistory.length])).toEqual([['led_a', term._id, 'QUALIFIED', 2], ['led_b', term._id, 'QUALIFIED', 2], ['led_c', 'pip_lt', 'QUALIFIED', 2]]);
    expect(await runLifeTermSplit({ apply: true })).toMatchObject({ accounts: 0 });
  });
});