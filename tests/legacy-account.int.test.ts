/**
 * Regression: accounts registered BEFORE Module 5 have no profile.sectionVersions stored, so every
 * section save and KYC submission was refused with GEN-05 although nobody else had changed anything.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { Account } from '../src/modules/accounts/account.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

/** Make the account look like one created before Module 5: no section versions in the database. */
const makeLegacy = (accountId: string) => Account.collection.updateOne({ _id: accountId as never }, { $unset: { 'profile.sectionVersions': '', 'profile.milestoneNotified': '' } });

describe('accounts created before Module 5', () => {
  it('can save a profile section, and a second save with the old version still conflicts', async () => {
    const adv = await registerAdvisor('Shashikant Bilgundi');
    await makeLegacy(adv.user.accountId!);
    const c = as(adv.token);
    const p = (await c.get('/profile')).body.data;
    const first = await c.put('/profile/personal', { version: p.sections.personal.version, dob: '07-09-2003', gender: 'Male' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data.sections.personal.version).toBe(p.sections.personal.version + 1); // the version really advanced
    const stale = await c.put('/profile/personal', { version: p.sections.personal.version, gender: 'Female' });
    expect(stale.status).toBe(409); // a genuinely stale save is still refused
  });

  it('can submit KYC', async () => {
    const adv = await registerAdvisor('Shashikant Bilgundi');
    await makeLegacy(adv.user.accountId!);
    const up = (purpose: string, body: Buffer) => request(app).post(`/v1/files?purpose=${purpose}`).set('Authorization', `Bearer ${adv.token}`).set('Content-Type', 'application/octet-stream').send(body);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const pdf = Buffer.from('%PDF-1.4\ntrailer << >>\n%%EOF\n');
    const c = as(adv.token);
    const k = (await c.get('/kyc')).body.data;
    const res = await c.put('/kyc', { version: k.version, pan: 'ABCPE1234F', nameOnPan: 'Shashikant Bilgundi', panFileId: (await up('KYC_PAN', png)).body.data.id, licenceFileId: (await up('KYC_LICENCE', pdf)).body.data.id, declaration: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});