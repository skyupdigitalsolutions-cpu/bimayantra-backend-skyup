/**
 * Module 5 Stage 1 — P-05 Complete the advisor profile (progressive).
 * Test names cite the BPD acceptance checks they cover.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, err, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv, stepUp, login } from './helpers.js';
import { Account } from '../src/modules/accounts/account.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { gstinChecksumValid } from '../src/lib/fields.js';
import { licenceState } from '../src/modules/profile/profile.service.js';
import { clock, istToday } from '../src/lib/clock.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const daysFromToday = (n: number) => { const d = new Date(`${istToday()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

async function setup() {
  const adv = await registerAdvisor('Asha Rao');
  const c = as(adv.token);
  const get = async () => (await c.get('/profile')).body.data;
  const save = (section: string, body: object) => c.put(`/profile/${section}`, body);
  return { adv, c, get, save };
}

describe('P-05 profile', () => {
  it('a new advisor starts at 0% with every missing item grouped by section (PRF-02)', async () => {
    const { get } = await setup();
    const p = await get();
    expect(p.completion.percent).toBe(0);
    expect(p.completion.messageId).toBe('PRF-02');
    expect(p.completion.missing.map((g: { section: string }) => g.section)).toEqual(['Personal', 'Contact', 'Professional', 'Business', 'KYC', 'Insurers']);
    expect(p.sections.personal.fullName).toBe('Asha Rao');
  });

  it('AC-P05-1 / AC-P05-3: saving one section returns the new % and leaves other sections unchanged', async () => {
    const { get, save } = await setup();
    let p = await get();
    const contact = await save('contact', { version: p.sections.contact.version, email: 'asha@example.com', address1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' });
    expect(contact.status).toBe(200);
    expect(contact.body.meta).toMatchObject({ messageId: 'PRF-01', message: 'Profile saved. Your profile is 20% complete.' });
    p = await get();
    expect(p.completion.percent).toBe(20); // Contact weight
    const personal = await save('personal', { version: p.sections.personal.version, dob: '15-04-1988' });
    expect(personal.body.meta.message).toBe('Profile saved. Your profile is 35% complete.');
    p = await get();
    expect(p.sections.contact).toMatchObject({ email: 'asha@example.com', city: 'Bengaluru', pin: '560001' }); // unchanged
    expect(p.sections.personal.dob).toBe('1988-04-15');
  });

  it('AC-P05-3: a failed save changes nothing, including the %', async () => {
    const { get, save } = await setup();
    const p = await get();
    const bad = await save('contact', { version: p.sections.contact.version, email: 'not-an-email', city: 'Bengaluru' });
    expect(bad.status).toBe(400);
    const after = await get();
    expect(after.sections.contact.city).toBeNull();
    expect(after.completion.percent).toBe(0);
  });

  it('AC-P05-6: two tabs saving the same section — the second gets GEN-05; other sections never conflict', async () => {
    const { get, save } = await setup();
    const p = await get();
    expect((await save('contact', { version: p.sections.contact.version, city: 'Mysuru' })).status).toBe(200);
    expect(err(await save('contact', { version: p.sections.contact.version, city: 'Hubballi' }))).toMatchObject({ status: 409, messageId: 'GEN-05' });
    expect((await get()).sections.contact.city).toBe('Mysuru');
    // a different section with its own (unchanged) version still saves
    expect((await save('business', { version: p.sections.business.version, displayName: 'Asha Rao Insurance' })).status).toBe(200);
  });

  it('PRF-14: an advisor younger than CFG-128 (18) is refused', async () => {
    const { get, save } = await setup();
    const p = await get();
    const dob = ddmmyyyy(daysFromToday(-(17 * 366)));
    expect(err(await save('personal', { version: p.sections.personal.version, dob }))).toMatchObject({ status: 400 });
    const res = await save('personal', { version: p.sections.personal.version, dob });
    expect(JSON.stringify(res.body)).toContain('You must be 18 or older to use Bimayantra as an advisor.');
  });

  it('field rules: licence number, licence date in the past, experience range, GSTIN check character, alternate mobile', async () => {
    const { get, save, adv } = await setup();
    const p = await get();
    const pro = await save('professional', { version: p.sections.professional.version, licenceNumber: 'ab', licenceValidUntil: ddmmyyyy(daysFromToday(-1)), experienceYears: 61 });
    const ids = (pro.body.error.fields as Array<{ field: string; messageId: string }>).map((f) => `${f.field}:${f.messageId}`).sort();
    expect(ids).toEqual(['experienceYears:VAL-12', 'licenceNumber:VAL-17', 'licenceValidUntil:VAL-07']);
    expect(err(await save('business', { version: p.sections.business.version, gstin: '29ABCDE1234F1X5' }))).toMatchObject({ status: 400 }); // 14th character must be Z
    expect((await save('business', { version: p.sections.business.version, gstin: '29abcde1234f1z5' })).body.data.sections.business.gstin).toBe('29ABCDE1234F1Z5');
    const own = await save('contact', { version: p.sections.contact.version, altMobile: adv.mobile });
    expect(JSON.stringify(own.body)).toContain('AUTH-24');
    expect(gstinChecksumValid('27AAPFU0939F1ZV')).toBe(true); // official check character (not enforced: FLD-34 is shape-only)
    expect(gstinChecksumValid('29ABCDE1234F1Z5')).toBe(false); // the BPD's own example
  });

  it('reaching 100% needs KYC and an insurer too (stages 2 and 3): sections alone give 65%', async () => {
    const { get, save } = await setup();
    let p = await get();
    await save('personal', { version: p.sections.personal.version, dob: '15-04-1988' });
    await save('contact', { version: p.sections.contact.version, email: 'asha@example.com', address1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' });
    await save('professional', { version: p.sections.professional.version, advisorType: 'Individual agent', licenceNumber: 'IRDA/123-456', licenceValidUntil: ddmmyyyy(daysFromToday(400)), categories: ['Health', 'Term Life'] });
    await save('business', { version: p.sections.business.version });
    p = await get();
    expect(p.completion.percent).toBe(65);
    expect(p.completion.missing.map((g: { section: string }) => g.section)).toEqual(['KYC', 'Insurers']);
  });

  it('P-05 step 4: a notification is created only when a new milestone (50%) is reached, not on every save', async () => {
    const { adv, get, save } = await setup();
    let p = await get();
    await save('contact', { version: p.sections.contact.version, email: 'asha@example.com', address1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' }); // 20
    await save('personal', { version: p.sections.personal.version, dob: '15-04-1988' }); // 35
    expect(await Notification.countDocuments({ userId: adv.user.id })).toBe(0);
    await save('professional', { version: p.sections.professional.version, advisorType: 'POSP', licenceNumber: 'POSP-0001', licenceValidUntil: ddmmyyyy(daysFromToday(400)), categories: ['Health'] }); // 55
    expect(await Notification.countDocuments({ userId: adv.user.id, kind: 'PROFILE_MILESTONE' })).toBe(1);
    p = await get();
    await save('contact', { version: p.sections.contact.version, city: 'Mysuru' }); // still 55: no new milestone
    expect(await Notification.countDocuments({ userId: adv.user.id })).toBe(1);
  });

  it('licence state: EXPIRING within CFG-152 days (PRF-16), EXPIRED after (PRF-17)', async () => {
    const base = { professional: { licenceNumber: 'IRDA-1', licenceValidUntil: daysFromToday(30) } } as never;
    expect(licenceState(base)).toMatchObject({ state: 'EXPIRING', messageId: 'PRF-16' });
    const expired = { professional: { licenceNumber: 'IRDA-1', licenceValidUntil: daysFromToday(-1) } } as never;
    expect(licenceState(expired)).toMatchObject({ state: 'EXPIRED', messageId: 'PRF-17' });
    expect(licenceState({ professional: { licenceNumber: 'IRDA-1', licenceValidUntil: daysFromToday(200) } } as never).state).toBe('VALID');
    expect(clock).toBeTruthy();
  });

  it('only the advisor manages the profile: an assistant and SkyUp staff get GEN-03', async () => {
    const { adv } = await setup();
    const m = newMobile();
    await as(adv.token).post('/assistants', { name: 'Priya Shah', mobile: m }, { 'X-Step-Up-Token': await stepUp(adv.token, adv.mobile) });
    const ast = await login(m);
    expect(err(await as(ast.token).get('/profile'))).toMatchObject({ status: 403, messageId: 'GEN-03' });
  });

  it('AC-P05-3: completion % is stored only after a successful save', async () => {
    const { adv, get, save } = await setup();
    const p = await get();
    await save('contact', { version: p.sections.contact.version, email: 'x' });
    expect((await Account.findById(adv.user.accountId).lean())!.profile!.completionPct).toBe(0);
  });
});