/** Change #17 — stable lead source codes (CFG-133), retired "Paid ads", Manual entry, ad name, and the backfill. */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, newMobile, registerAdvisor, resetState, setCfg, startTestEnv, stopTestEnv } from './helpers.js';
import { ConfigValue, cfg, validateCfgValue } from '../src/config/cfg.js';
import { normalizeMobile } from '../src/lib/phone.js';
import { Customer } from '../src/modules/customers/customer.model.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { migrateLeadSourceCodes } from '../src/modules/leads/sourceMigration.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

async function setup() {
  const adv = await registerAdvisor();
  const c = as(adv.token);
  const pipelines = (await c.get('/pipelines')).body.data as Array<{ id: string }>;
  const create = (body: object = {}) => c.post('/leads', { pipelineId: pipelines[0]!.id, name: 'Ravi Kumar', mobile: newMobile(), source: 'WALK_IN', ...body });
  return { adv, c, pipelineId: pipelines[0]!.id, accountId: adv.user.accountId!, create };
}

/** A lead as rows were saved before this change: a label and no sourceCode field at all. */
async function oldLead(accountId: string, pipelineId: string, source: string, n: number) {
  const _id = `led_${String(n).padStart(28, '0')}`;
  await Lead.collection.insertOne({
    _id, accountId, number: `LD-2026-9${String(n).padStart(4, '0')}`, pipelineId, name: `Old Lead ${n}`, nameKey: `old lead ${n}`, mobile: normalizeMobile(newMobile()),
    source, status: 'NEW', isOpen: true, createdBy: 'usr_x', stageHistory: [], contacts: [], interests: [], priority: 'MEDIUM', version: 3, createdAt: new Date(), updatedAt: new Date(),
  } as never);
  return _id;
}

describe('reference lists', () => {
  it('offers the new-lead sources in design order with their rules; Paid ads only as a retired label', async () => {
    const r = (await request(app).get('/v1/reference')).body.data;
    expect(r.leadSources).toEqual(['Meta Ads', 'Google Ads', 'Website', 'Social media', 'Referred by a client', 'Referred by a referrer', 'Walk-in or personal contact', 'Campaign', 'Manual entry', 'Other']);
    expect(r.leadSourceOptions.find((o: { code: string }) => o.code === 'META_ADS')).toEqual({ code: 'META_ADS', label: 'Meta Ads', needs: null, campaignName: 'OPTIONAL' });
    expect(r.leadSourceOptions.find((o: { code: string }) => o.code === 'CAMPAIGN')).toMatchObject({ campaignName: 'REQUIRED' });
    expect(r.leadSourceOptions.find((o: { code: string }) => o.code === 'REFERRED_BY_REFERRER')).toMatchObject({ needs: 'REFERRER' });
    expect(r.allLeadSources.find((o: { code: string }) => o.code === 'PAID_ADS')).toEqual({ code: 'PAID_ADS', label: 'Paid ads', retired: true });
  });
});

describe('creating leads', () => {
  it('accepts a code or (older clients) a label; stores both the code and the label', async () => {
    const { create } = await setup();
    const byCode = await create({ source: 'SOCIAL_MEDIA' });
    expect(byCode.status).toBe(201);
    expect(byCode.body.data).toMatchObject({ source: 'Social media', sourceCode: 'SOCIAL_MEDIA' });
    const byLabel = await create({ source: 'walk-in OR personal contact' });
    expect(byLabel.body.data).toMatchObject({ source: 'Walk-in or personal contact', sourceCode: 'WALK_IN' });
    expect(await Lead.findById(byLabel.body.data.id).lean()).toMatchObject({ sourceCode: 'WALK_IN' });
  });

  it('refuses retired "Paid ads" and unknown text for a new lead (VAL-22 on the field); Manual entry is offered', async () => {
    const { create } = await setup();
    for (const source of ['PAID_ADS', 'Paid ads', 'Billboard']) {
      const r = await create({ source });
      expect(err(r)).toMatchObject({ status: 400 });
      expect(r.body.error.fields[0]).toMatchObject({ field: 'source', messageId: 'VAL-22' });
    }
    expect((await create({ source: 'MANUAL_ENTRY' })).body.data).toMatchObject({ source: 'Manual entry', sourceCode: 'MANUAL_ENTRY' });
  });

  it('ad or campaign name: required for Campaign, optional for Meta and Google Ads, cleared for other sources', async () => {
    const { create } = await setup();
    expect((await create({ source: 'CAMPAIGN' })).body.error.fields[0]).toMatchObject({ field: 'campaign', messageId: 'GEN-01' });
    const meta = (await create({ source: 'META_ADS', campaign: 'Diwali floater' })).body.data;
    expect((await Lead.findById(meta.id).lean())!.campaign).toBe('Diwali floater');
    const google = await create({ source: 'GOOGLE_ADS' });
    expect(google.status).toBe(201);
    const walk = (await create({ source: 'WALK_IN', campaign: 'Ignored' })).body.data;
    expect((await Lead.findById(walk.id).lean())!.campaign).toBeNull();
  });

  it('CFG-133 decides what is offered: an Admin list of codes is validated (no labels, no retired codes, no repeats)', async () => {
    expect(validateCfgValue('CFG-133', ['WALK_IN', 'OTHER'])).toBeNull();
    expect(validateCfgValue('CFG-133', ['Walk-in or personal contact'])).toMatch(/Unknown/);
    expect(validateCfgValue('CFG-133', ['PAID_ADS'])).toMatch(/retired/);
    expect(validateCfgValue('CFG-133', ['OTHER', 'OTHER'])).toMatch(/once/);
    await setCfg('CFG-133', ['WALK_IN', 'OTHER']);
    const { create } = await setup();
    expect((await create({ source: 'META_ADS' })).body.error.fields[0]).toMatchObject({ field: 'source', messageId: 'VAL-22' });
    expect((await create({ source: 'OTHER' })).status).toBe(201);
  });
});

describe('leads saved before the change', () => {
  it('stay readable and editable; keeping "Paid ads" is allowed, correcting to it is not', async () => {
    const { c, create, accountId, pipelineId } = await setup();
    const id = await oldLead(accountId, pipelineId, 'Paid ads', 1);
    const got = (await c.get(`/leads/${id}`)).body.data;
    expect(got).toMatchObject({ source: 'Paid ads', sourceCode: 'PAID_ADS' });
    // Editing other fields (the source unchanged) works
    expect((await c.patch(`/leads/${id}`, { version: 3, notes: 'Called twice' })).status).toBe(200);
    // The advisor corrects the source to Meta Ads, with the ad name
    const fixed = await c.patch(`/leads/${id}`, { version: 4, source: 'META_ADS', campaign: 'Summer ad' });
    expect(fixed.body.data).toMatchObject({ source: 'Meta Ads', sourceCode: 'META_ADS', campaign: 'Summer ad' });
    // ...but another lead cannot be corrected TO the retired source
    const l = (await create()).body.data;
    expect((await c.patch(`/leads/${l.id}`, { version: 1, source: 'Paid ads' })).body.error.fields[0]).toMatchObject({ field: 'source', messageId: 'VAL-22' });
  });

  it('the list filter takes a code or a label and finds rows with or without a stored code', async () => {
    const { c, create, accountId, pipelineId } = await setup();
    await oldLead(accountId, pipelineId, 'Website', 2);
    await create({ source: 'WEBSITE' });
    await create({ source: 'OTHER' });
    for (const source of ['WEBSITE', 'Website']) {
      const r = await c.get(`/leads?source=${encodeURIComponent(source)}`);
      expect(r.body.data.map((l: { sourceCode: string }) => l.sourceCode)).toEqual(['WEBSITE', 'WEBSITE']);
    }
    // filter and search together (both use $or internally)
    expect((await c.get('/leads?source=WEBSITE&search=Old')).body.data).toHaveLength(1);
  });
});

describe('backfill (npm run db:migrate:lead-sources)', () => {
  it('dry run reports; --apply writes codes without changing versions, converts a label CFG-133, and is safe to run again', async () => {
    const { accountId, pipelineId } = await setup();
    await oldLead(accountId, pipelineId, 'Paid ads', 3);
    await oldLead(accountId, pipelineId, 'Paid ads', 4);
    await oldLead(accountId, pipelineId, 'Referred by a client', 5);
    await oldLead(accountId, pipelineId, 'Newspaper', 6);
    await Customer.collection.insertOne({ _id: 'cus_' + '1'.repeat(28), accountId, number: 'CU-900001', name: 'Old Customer', nameKey: 'old customer', mobile: normalizeMobile(newMobile()), source: 'Referred by a client', status: 'ACTIVE', createdBy: 'usr_x', version: 1 } as never);
    await Customer.collection.insertOne({ _id: 'cus_' + '2'.repeat(28), accountId, number: 'CU-900002', name: 'Direct Customer', nameKey: 'direct customer', mobile: normalizeMobile(newMobile()), source: 'Direct', status: 'ACTIVE', createdBy: 'usr_x', version: 1 } as never);
    await ConfigValue.collection.insertOne({ _id: 'CFG-133', value: ['Walk-in or personal contact', 'Paid ads', 'Campaign', 'Newspaper'] } as never);

    const dry = await migrateLeadSourceCodes({ apply: false });
    expect(dry.leads).toEqual(expect.arrayContaining([{ label: 'Paid ads', code: 'PAID_ADS', count: 2 }, { label: 'Referred by a client', code: 'REFERRED_BY_CLIENT', count: 1 }]));
    expect(dry.unknownLabels.leads).toEqual([{ label: 'Newspaper', count: 1 }]);
    expect(dry.customers).toEqual([{ label: 'Referred by a client', code: 'REFERRED_BY_CLIENT', count: 1 }]);
    expect(dry.cfg133).toEqual({ before: ['Walk-in or personal contact', 'Paid ads', 'Campaign', 'Newspaper'], after: ['WALK_IN', 'CAMPAIGN'], dropped: ['Paid ads', 'Newspaper'] });
    expect(await Lead.countDocuments({ sourceCode: { $type: 'string' } })).toBe(0); // nothing written

    await migrateLeadSourceCodes({ apply: true });
    expect(await Lead.find({ number: { $in: ['LD-2026-90003', 'LD-2026-90004'] } }).lean()).toEqual([expect.objectContaining({ sourceCode: 'PAID_ADS', version: 3 }), expect.objectContaining({ sourceCode: 'PAID_ADS', version: 3 })]);
    expect((await Lead.findOne({ number: 'LD-2026-90006' }).lean())!.sourceCode ?? null).toBeNull(); // unknown label left alone
    expect((await Customer.findOne({ number: 'CU-900001' }).lean())!.sourceCode).toBe('REFERRED_BY_CLIENT');
    expect((await Customer.findOne({ number: 'CU-900002' }).lean())!.sourceCode ?? null).toBeNull();
    expect(cfg('CFG-133')).toEqual(['WALK_IN', 'CAMPAIGN']);

    const again = await migrateLeadSourceCodes({ apply: true });
    expect(again.leads).toEqual([]);
    expect(again.cfg133).toBeNull();
  });
});