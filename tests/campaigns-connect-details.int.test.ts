/** Connect-form details: default status, campaign labels, website page URL, own webhook key, Google filters, settings. */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { clock } from '../src/lib/clock.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { Submission } from '../src/modules/campaigns/campaign.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => { clock.setOffset(0); await resetState(); });

const web = (key: string, body: object) => request(app).post('/v1/hooks/website').set('X-Forwarded-For', '10.2.2.2').set('X-Bimayantra-Key', key).send(body);
const google = (body: object) => request(app).post('/v1/hooks/google').send(body);
const gLead = (key: string, leadId: string, mobile: string, extra: object = {}) => ({ lead_id: leadId, form_id: 4401, campaign_id: 9911, google_key: key, is_test: false,
  user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Leela Das' }, { column_id: 'PHONE_NUMBER', string_value: `+91${mobile}` }], ...extra });
async function advisor(name = 'Asha Rao') { const adv = await registerAdvisor(name); return as(adv.token); }

describe('connect details', () => {
  it('a website connection keeps the contact page URL, starts leads in the chosen status and labels them with the campaign', async () => {
    const A = await advisor();
    const c = await A.post('/campaigns/connections', { channel: 'WEBSITE', name: 'Contact page', contactPageUrl: 'https://example.com/contact', defaultStatus: 'CONTACTED', parentCampaign: 'Summer Sale 2025', adSetName: 'Retargeting - Mumbai', category: 'Healthcare' });
    expect(c.status).toBe(201);
    expect(c.body.data.connection).toMatchObject({ contactPageUrl: 'https://example.com/contact', defaultStatus: 'CONTACTED', parentCampaign: 'Summer Sale 2025', adSetName: 'Retargeting - Mumbai', category: 'Healthcare' });
    const m = newMobile();
    expect((await web(c.body.data.key, { name: 'Ravi Kumar', phone: m })).body.data.status).toBe('IMPORTED');
    const lead = await Lead.findOne({ mobile: `+91${m}` }).lean();
    expect(lead).toMatchObject({ status: 'CONTACTED', campaign: 'Summer Sale 2025 · Retargeting - Mumbai' });
    expect(lead!.stageHistory[0]).toMatchObject({ from: null, to: 'CONTACTED' });
  });

  it('leaving the details out behaves exactly as before (New, a generated key)', async () => {
    const A = await advisor();
    const c = (await A.post('/campaigns/connections', { channel: 'WEBSITE', name: 'Site' })).body.data;
    expect(c.key).toMatch(/^byw_/);
    expect(c.connection).toMatchObject({ defaultStatus: 'NEW', contactPageUrl: null, category: null, campaignFilter: [] });
    const m = newMobile();
    await web(c.key, { name: 'Meena Iyer', phone: m, formName: 'Home page' });
    expect(await Lead.findOne({ mobile: `+91${m}` }).lean()).toMatchObject({ status: 'NEW', campaign: 'Home page' });
  });

  it('checks the fields: status from the list, an https page, a valid own key that nobody else uses', async () => {
    const A = await advisor();
    expect((await A.post('/campaigns/connections', { channel: 'WEBSITE', name: 'Site', defaultStatus: 'CONVERTED' })).body.error.fields[0]).toMatchObject({ field: 'defaultStatus', messageId: 'VAL-22' });
    expect((await A.post('/campaigns/connections', { channel: 'WEBSITE', name: 'Site', contactPageUrl: 'example.com/contact' })).body.error.fields[0]).toMatchObject({ field: 'contactPageUrl', messageId: 'VAL-28' });
    expect((await A.post('/campaigns/connections', { channel: 'GOOGLE', name: 'Site', key: 'short' })).body.error.fields[0]).toMatchObject({ field: 'key', messageId: 'CMP-25' });
    expect((await A.post('/campaigns/connections', { channel: 'GOOGLE', name: 'Site', key: 'has spaces in it ok' })).body.error.fields[0]).toMatchObject({ field: 'key', messageId: 'CMP-25' });
    const B = await advisor('Bina Shah');
    expect((await B.post('/campaigns/connections', { channel: 'GOOGLE', name: 'Mine', key: 'skyup_google_2025_key' })).status).toBe(201);
    const dup = await A.post('/campaigns/connections', { channel: 'GOOGLE', name: 'Theirs', key: 'skyup_google_2025_key' });
    expect(err(dup)).toMatchObject({ status: 400 });
    expect(dup.body.error.fields[0]).toMatchObject({ field: 'key', messageId: 'CMP-24' });
  });
});

describe('Google Ads own key and filters', () => {
  it('the advisor’s own key is the Google Ads key; only the chosen campaign and form are imported, the rest kept as SKIPPED for Retry', async () => {
    const A = await advisor();
    const c = await A.post('/campaigns/connections', { channel: 'GOOGLE', name: 'Search', key: 'skyup_google_2025_key', campaignIds: ['9911'], formIds: ['4401'], defaultStatus: 'FOLLOW_UP' });
    expect(c.status).toBe(201);
    expect(c.body.data.key).toBe('skyup_google_2025_key');
    expect(c.body.data.connection).toMatchObject({ campaignFilter: ['9911'], formFilter: ['4401'], defaultStatus: 'FOLLOW_UP' });

    const ok = newMobile();
    expect((await google(gLead('skyup_google_2025_key', 'L-1', ok))).body.data.status).toBe('IMPORTED');
    const lead = await Lead.findOne({ mobile: `+91${ok}` }).lean();
    expect(lead).toMatchObject({ status: 'FOLLOW_UP' });
    expect(lead!.nextFollowUpAt).toBeTruthy();

    expect((await google(gLead('skyup_google_2025_key', 'L-2', newMobile(), { campaign_id: 1234 }))).body.data.status).toBe('SKIPPED');
    expect((await Submission.findOne({ externalId: 'L-2' }).lean())!.reason).toBe("Campaign 1234 is not in this connection's campaign filter");
    expect((await google(gLead('skyup_google_2025_key', 'L-3', newMobile(), { form_id: 7777 }))).body.data.status).toBe('SKIPPED');
    expect((await Submission.findOne({ externalId: 'L-3' }).lean())!.reason).toBe("Form 7777 is not in this connection's form filter");

    // widen the filter, then Retry imports the kept lead
    const id = c.body.data.connection.id;
    const saved = await A.put(`/campaigns/connections/${id}/settings`, { campaignIds: [] });
    expect(saved.body.meta.message).toBe('Connection settings saved.');
    const sub = (await Submission.findOne({ externalId: 'L-2' }).lean())!;
    expect((await A.post(`/campaigns/submissions/${sub._id}/retry`, {})).body.data.status).toBe('IMPORTED');
  });
});

describe('settings', () => {
  it('edits the details later; refuses fields that do not belong to the channel; other accounts and assistants cannot', async () => {
    const A = await advisor();
    const c = (await A.post('/campaigns/connections', { channel: 'WEBSITE', name: 'Site' })).body.data.connection;
    const r = await A.put(`/campaigns/connections/${c.id}/settings`, { defaultStatus: 'QUALIFIED', category: 'Real Estate', contactPageUrl: 'https://example.com/contact', name: 'Contact form' });
    expect(r.body.data).toMatchObject({ defaultStatus: 'QUALIFIED', category: 'Real Estate', contactPageUrl: 'https://example.com/contact', name: 'Contact form' });
    // blank clears a label; the status goes back to New only when cleared explicitly
    expect((await A.put(`/campaigns/connections/${c.id}/settings`, { category: '' })).body.data).toMatchObject({ category: null, defaultStatus: 'QUALIFIED' });
    expect((await A.put(`/campaigns/connections/${c.id}/settings`, { campaignIds: ['1'] })).body.error.fields[0]).toMatchObject({ field: 'campaignIds', messageId: 'VAL-22' });
    expect((await A.put(`/campaigns/connections/${c.id}/settings`, { unknown: 1 })).status).toBe(400);
    const B = await advisor('Bina Shah');
    expect((await B.put(`/campaigns/connections/${c.id}/settings`, { category: 'Mine' })).status).toBe(404);
    // the campaign list carries the connection's category
    const m = newMobile();
    const key = (await A.post(`/campaigns/connections/${c.id}/rotate-key`, {})).body.data.key;
    await web(key, { name: 'Kiran Das', phone: m, formName: 'Contact' });
    await A.put(`/campaigns/connections/${c.id}/settings`, { category: 'Healthcare' });
    expect((await A.get('/campaigns')).body.data[0]).toMatchObject({ category: 'Healthcare' });
  });
});