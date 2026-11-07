/** Module 15 — P-44 referrers, P-45 the referrer's view, P-46 the public referral form. */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { InsuranceType } from '../src/modules/catalogue/types.model.js';
import { Consent } from '../src/modules/customers/customer.model.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { ReferralSubmission } from '../src/modules/referrals/referral.model.js';
import { refreshShownStatuses } from '../src/modules/referrals/referrals.service.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

async function world() {
  await InsuranceType.create({ name: 'Health', nameKey: 'health' });
  const adv = await registerAdvisor('Asha Rao');
  const A = as(adv.token);
  const m = newMobile();
  const add = await A.post('/referrers', { name: 'Kiran Rao', mobile: m, note: 'Gym friend' });
  const ref = add.body.data.referrer;
  return { adv, A, add, ref, refMobile: m, code: ref.code as string };
}
const FORM = (extra: object = {}) => ({ name: 'Ravi Kumar', mobile: newMobile(), relation: 'Friend', interest: 'Health', city: 'Bengaluru', message: 'Family floater please', permission: true, ...extra });
const submit = (code: string, body: object, ip = '10.0.0.1') => request(app).post(`/v1/public/r/${code}`).set('X-Forwarded-For', ip).send(body);

describe('P-44 referrers', () => {
  it('REF-01 with an invitation and an 8-character code; AC-P44-1 any existing user mobile is refused (REF-02)', async () => {
    const w = await world();
    expect(w.add.body.meta.message).toBe('Referrer Kiran Rao added. Share the invitation with them.');
    expect(w.ref).toMatchObject({ status: 'INVITED', codeStatus: 'ACTIVE' });
    expect(w.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(w.add.body.data.whatsappUrl).toMatch(/^https:\/\/wa\.me\/91\d{10}\?text=/);
    const dup = await w.A.post('/referrers', { name: 'Someone', mobile: w.adv.mobile });
    expect(dup.body.error.fields[0]).toMatchObject({ messageId: 'REF-02' });
  });

  it('AC-P44-2 disabling stops the link at once and keeps past leads credited (REF-07); AC-P44-3 a new link revokes the old one (REF-06)', async () => {
    const w = await world();
    await submit(w.code, FORM());
    const nl = await w.A.post(`/referrers/${w.ref.id}/new-link`, {});
    expect(nl.body.meta.message).toBe('New referral link created. The old link no longer works.');
    const newCode = nl.body.data.code;
    expect(newCode).not.toBe(w.code);
    expect(err(await submit(w.code, FORM()))).toMatchObject({ messageId: 'REF-04' });
    const d = await w.A.post(`/referrers/${w.ref.id}/disable`, {});
    expect(d.body.meta.message).toBe('Referrer Kiran Rao disabled. Their link no longer works.');
    expect(err(await submit(newCode, FORM()))).toMatchObject({ messageId: 'REF-04' });
    expect(await Lead.countDocuments({ referrerUserId: w.ref.id })).toBe(1); // still credited
  });
});

describe('P-46 public form', () => {
  it('AC-P46-1 one lead credited to the referrer with WhatsApp consent "Ticked on referral form"; DSH-16; the page never shows the advisor mobile', async () => {
    const w = await world();
    const page = (await request(app).get(`/v1/public/r/${w.code}`)).body.data;
    expect(page).toMatchObject({ valid: true, advisorName: 'Asha Rao', referrerFirstName: 'Kiran', interests: ['Health'] });
    expect(JSON.stringify(page)).not.toContain(w.adv.mobile.slice(-6));
    const f = FORM();
    const r = await submit(w.code, f);
    expect(r.body.meta.message).toBe('Thank you, Ravi. Asha Rao will contact you soon.');
    const lead = await Lead.findOne({ referrerUserId: w.ref.id }).lean();
    expect(lead).toMatchObject({ source: 'Referred by a referrer', status: 'NEW', interests: ['Health'] });
    expect(await Consent.findOne({ personKey: `L:${lead!._id}` }).lean()).toMatchObject({ channel: 'WHATSAPP', status: 'GIVEN', howGiven: 'Ticked on referral form' });
    expect((await Notification.findOne({ messageId: 'DSH-16' }).lean())!.message).toBe('New referral from Kiran Rao: Ravi Kumar.');
  });

  it('AC-P46-2 a repeat makes no second lead and shows the same thank-you (LINKED_TO_EXISTING); AC-P46-3 a revoked code creates nothing; the trap field stores nothing', async () => {
    const w = await world();
    const f = FORM();
    await submit(w.code, f);
    await ReferralSubmission.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 120_000) } }); // not a double click (raw: Mongoose keeps createdAt immutable)
    const again = await submit(w.code, { ...f, name: 'Ravi K' });
    expect(again.body.meta.message).toBe('Thank you, Ravi. Asha Rao will contact you soon.');
    expect(await Lead.countDocuments({})).toBe(1);
    expect((await ReferralSubmission.find({}).sort({ createdAt: 1 }).lean()).map((s) => s.status)).toEqual(['LEAD_CREATED', 'LINKED_TO_EXISTING']);
    await submit(w.code, FORM({ website: 'http://spam' }));
    expect(await ReferralSubmission.countDocuments({})).toBe(2);
    await w.A.post(`/referrers/${w.ref.id}/new-link`, {});
    const revoked = await submit(w.code, FORM());
    expect(err(revoked)).toMatchObject({ messageId: 'REF-04' });
    expect(revoked.body.error.message).toBe('This referral link is not active. Please contact the person who shared it.');
    expect(await ReferralSubmission.countDocuments({})).toBe(2);
  });

  it('AC-P46-4: the (CFG-75 + 1)th submission from one IP in an hour is refused (REF-09)', async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) expect((await submit(w.code, FORM(), '10.9.9.9')).status).toBe(201);
    const sixth = await submit(w.code, FORM(), '10.9.9.9');
    expect(err(sixth)).toMatchObject({ status: 429, messageId: 'REF-09' });
    expect((await submit(w.code, FORM(), '10.9.9.10')).status).toBe(201);
  });
});

describe('P-45 the referrer view', () => {
  it('AC-P45-3 statuses follow the mapping with REF-08 on change; AC-P45-2 no policy or premium data; masked mobiles', async () => {
    const w = await world();
    const R = as((await login(w.refMobile)).token);
    const me = (await R.get('/referral/me')).body.data;
    expect(me).toMatchObject({ advisorName: 'Asha Rao', code: w.code });
    expect(me.link).toMatch(new RegExp(`/r/${w.code}$`));
    const r = await R.post('/referral/me/refer', FORM({ name: 'Leela Das' }));
    expect(r.body.meta.message).toBe('Thank you, Leela. Asha Rao will contact you soon.');
    let mine = (await R.get('/referral/me/referrals')).body.data;
    expect(mine[0]).toMatchObject({ name: 'Leela Das', status: 'New' });
    expect(mine[0].mobile).toMatch(/^\+91\d{2}X{6}\d{2}$/);
    expect(Object.keys(mine[0]).sort()).toEqual(['date', 'id', 'mobile', 'name', 'status']); // nothing else, ever
    await refreshShownStatuses();
    await Lead.updateOne({ referrerUserId: w.ref.id }, { $set: { status: 'QUALIFIED' } });
    await refreshShownStatuses(); await refreshShownStatuses();
    mine = (await R.get('/referral/me/referrals')).body.data;
    expect(mine[0].status).toBe('In progress');
    const n = await Notification.find({ messageId: 'REF-08' }).lean();
    expect(n.map((x) => x.message)).toEqual(['Your referral Leela is now: In progress.']);
    // a referrer cannot reach advisor data
    expect((await R.get('/policies')).status).toBe(403);
    expect((await R.get('/quotations')).status).toBe(403);
    expect((await R.get('/customers')).status).toBe(403);
  });
});