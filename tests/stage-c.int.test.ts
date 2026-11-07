/** Stage C — read-only additions: lead filters and timeline (#19, #20), dashboard widgets (#22), feature table (#7), subscriptions and wallets overviews (#53, #54), audit device (#58). */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, seedAdmin, startTestEnv, stopTestEnv } from './helpers.js';
import { normalizeMobile } from '../src/lib/phone.js';
import { Account } from '../src/modules/accounts/account.model.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { Task } from '../src/modules/tasks/task.model.js';
import { Call } from '../src/modules/calls/call.model.js';
import { Submission } from '../src/modules/campaigns/campaign.model.js';
import { Product, ProductVersion } from '../src/modules/catalogue/product.model.js';
import { InsuranceType, TemplateVersion } from '../src/modules/catalogue/types.model.js';
import { ProductVariant } from '../src/modules/catalogue/variant.model.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { User } from '../src/modules/users/user.model.js';
import { WalletTxn } from '../src/modules/comms/outbox.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

async function advisorWithLeads() {
  const adv = await registerAdvisor('Asha Rao');
  const A = as(adv.token);
  const pipelineId = ((await A.get('/pipelines')).body.data as Array<{ id: string }>)[0]!.id;
  const mk = async (name: string, source = 'Walk-in or personal contact') => (await A.post('/leads', { pipelineId, name, mobile: newMobile(), source })).body.data as { id: string };
  const a = await mk('Ravi Kumar'); const b = await mk('Meena Iyer', 'Social media'); const c = await mk('Kiran Das'); const d = await mk('Leela Das', 'Social media');
  const accountId = (await Lead.findById(a.id).lean())!.accountId;
  const now = Date.now();
  await Lead.updateOne({ _id: b.id }, { $set: { status: 'CONTACTED', nextFollowUpAt: new Date(now + 60_000) } });  // due later today… or tomorrow just after midnight: set below
  await Lead.updateOne({ _id: c.id }, { $set: { status: 'QUALIFIED', nextFollowUpAt: new Date(now - 86_400_000) } }); // overdue
  await Lead.updateOne({ _id: d.id }, { $set: { status: 'LOST', isOpen: false, adRef: { channel: 'WEBSITE', connectionId: `cnx_${'c'.repeat(28)}`, formId: `lfm_${'f'.repeat(28)}` } } });
  // make b's follow-up land inside today (IST) regardless of when the test runs
  const istNoon = new Date(`${new Date(now + 5.5 * 3_600_000).toISOString().slice(0, 10)}T12:00:00+05:30`);
  await Lead.updateOne({ _id: b.id }, { $set: { nextFollowUpAt: istNoon.getTime() < now ? new Date(Math.max(istNoon.getTime(), now - 60_000)) : istNoon } });
  return { adv, A, accountId, a, b, c, d };
}

describe('leads (#19, #20)', () => {
  it('the list takes several statuses and sources, follow-up today or overdue, and a campaign; one value still works', async () => {
    const w = await advisorWithLeads();
    const names = async (q: string) => ((await w.A.get(`/leads?${q}`)).body.data as Array<{ name: string }>).map((x) => x.name).sort();
    expect(await names('status=NEW')).toEqual(['Ravi Kumar']);
    expect(await names('status=CONTACTED,QUALIFIED')).toEqual(['Kiran Das', 'Meena Iyer']);
    expect(await names('source=SOCIAL_MEDIA')).toEqual(['Leela Das', 'Meena Iyer']);
    expect(await names('source=SOCIAL_MEDIA,Walk-in or personal contact')).toHaveLength(4);
    expect(await names('followUp=overdue')).toContain('Kiran Das');
    expect(await names('followUp=overdue')).not.toContain('Leela Das'); // closed leads are not follow-ups
    expect(await names(`campaignId=cnx_${'c'.repeat(28)}`)).toEqual(['Leela Das']);
    expect(await names(`campaignId=lfm_${'f'.repeat(28)}`)).toEqual(['Leela Das']);
    expect(err(await w.A.get('/leads?status=NEW,DANCING'))).toMatchObject({ status: 400 });
  });

  it('the timeline gathers contacts, status changes, follow-ups, tasks and calls, filters by type, and gives the aggregates', async () => {
    const w = await advisorWithLeads();
    await w.A.post(`/leads/${w.a.id}/contacts`, { outcome: 'SPOKE_TO_CUSTOMER', note: 'Wants family cover' });
    await Task.create({ accountId: w.accountId, kind: 'GENERAL', title: 'Send brochure', dueAt: new Date(), linkedType: 'LEAD', linkedId: w.a.id });
    await Call.create({ accountId: w.accountId, userId: 'usr_x', phone: '+919999999999', callType: 'outgoing', at: new Date(), durationSec: 95, leadId: w.a.id });
    const all = (await w.A.get(`/leads/${w.a.id}/timeline`)).body.data;
    expect(new Set(all.items.map((i: { type: string }) => i.type))).toEqual(new Set(['CONTACT', 'STATUS', 'TASK', 'CALL']));
    expect(all.aggregates).toMatchObject({ contactsCount: 1, ageDays: 0 });
    expect(new Date(all.aggregates.lastActivityAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    const only = (await w.A.get(`/leads/${w.a.id}/timeline?types=CONTACT,CALL`)).body.data.items.map((i: { type: string }) => i.type).sort();
    expect(only).toEqual(['CALL', 'CONTACT']);
    const other = await registerAdvisor('Ravi Kumar');
    expect((await as(other.token).get(`/leads/${w.a.id}/timeline`)).status).toBe(404);
  });
});

describe('dashboard (#22)', () => {
  it('lead counts per status, follow-ups, sources this month with %, ad leads today, and the widgets that waited on later modules', async () => {
    const w = await advisorWithLeads();
    expect((await w.A.get('/dashboard/lead-status-counts')).body.data).toMatchObject({ total: 4, byStatus: { NEW: 1, CONTACTED: 1, QUALIFIED: 1, LOST: 1, CONVERTED: 0, FOLLOW_UP: 0 } });
    const f = (await w.A.get('/dashboard/follow-ups')).body.data;
    expect(f.overdue).toBeGreaterThanOrEqual(1);
    const s = (await w.A.get('/dashboard/lead-sources')).body.data;
    expect(s.total).toBe(4);
    expect(s.sources).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SOCIAL_MEDIA', label: 'Social media', count: 2, percent: 50 })]));
    await Submission.create({ accountId: w.accountId, connectionId: 'cnx_x', channel: 'GOOGLE', externalId: 'g1', status: 'IMPORTED' });
    await Submission.create({ accountId: w.accountId, connectionId: 'cnx_x', channel: 'GOOGLE', externalId: 'g2', status: 'SKIPPED' });
    expect((await w.A.get('/dashboard/ad-leads-today')).body.data).toMatchObject({ count: 1, byChannel: { GOOGLE: 1 } });
    expect((await w.A.get('/dashboard/open-quotations')).body.data).toMatchObject({ count: 0, available: true });
    expect((await w.A.get('/dashboard/policies-in-force')).body.data).toMatchObject({ count: 0, available: true });
    expect((await w.A.get('/dashboard/renewals-due')).body.data).toMatchObject({ count: 0, cards: { due: 0, inFollowUp: 0, upcoming30: 0, lapsedThisMonth: 0 } });
  });
});

describe('feature table (#7)', () => {
  it('rows are template features by group, columns are products and their variants, differences are marked, and the source filter keeps other accounts out', async () => {
    const w = await advisorWithLeads();
    const other = await registerAdvisor('Kiran Das');
    const otherAcc = (await User.findOne({ mobile: normalizeMobile(other.mobile) }).lean())!.accountId;
    const TYP = `typ_${'a'.repeat(28)}`;
    const now = new Date();
    await InsuranceType.collection.insertOne({ _id: TYP as never, name: 'Health', nameKey: 'health', status: 'ACTIVE', createdAt: now, updatedAt: now });
    await TemplateVersion.collection.insertOne({ _id: 'tpl_v1' as never, typeId: TYP, number: 1, status: 'ACTIVE', makerId: 'u', features: [
      { key: 'room_rent', name: 'Room rent', group: 'Limits and sub-limits', dataType: 'Text', order: 1, requiredToPublish: false },
      { key: 'copay', name: 'Co-pay', group: 'Limits and sub-limits', dataType: 'Percentage', order: 2, requiredToPublish: false },
      { key: 'ped_wait', name: 'Pre-existing disease wait', group: 'Waiting periods', dataType: 'Months', order: 3, requiredToPublish: false }], createdAt: now, updatedAt: now });
    await Insurer.collection.insertOne({ _id: 'ins_1' as never, name: 'Star Health', irdaiRegNo: '129', createdAt: now, updatedAt: now });
    const prod = (id: string, kind: string, accountId: string | null, name: string) => ({ _id: id as never, kind, accountId, insurerId: 'ins_1', typeId: TYP, code: id, status: 'ACTIVE', publishedVersionId: `${id}_v`, name, makerId: 'u', createdAt: now, updatedAt: now });
    await Product.collection.insertMany([prod('prd_a', 'VERIFIED', null, 'Family Care'), prod('prd_b', 'OWN', w.accountId, 'My Plan'), prod('prd_c', 'OWN', otherAcc ?? null, 'Not Mine')]);
    const ver = (id: string, features: object) => ({ _id: `${id}_v` as never, productId: id, number: 1, status: 'PUBLISHED', isOpen: false, templateId: 'tpl_v1', makerId: 'u', data: { features }, createdAt: now, updatedAt: now });
    await ProductVersion.collection.insertMany([
      ver('prd_a', { room_rent: { value: 'No limit' }, copay: { value: 0 }, ped_wait: { value: 36 } }),
      ver('prd_b', { room_rent: { value: 'No limit' }, copay: { notStated: true }, ped_wait: { value: 24 } }),
      ver('prd_c', { room_rent: { value: 'Shared room' } }),
    ]);
    await ProductVariant.create([{ productId: 'prd_a', productVersionId: 'prd_a_v', name: 'Silver', position: 1, features: {} }, { productId: 'prd_a', productVersionId: 'prd_a_v', name: 'Gold', position: 2, features: { ped_wait: { value: 24 } } }]);
    const t = (await w.A.get(`/catalogue/feature-table?typeId=${TYP}`)).body.data;
    expect(t.columns.map((c: { productName: string; variantName: string }) => `${c.productName} · ${c.variantName}`)).toEqual(['Family Care · Silver', 'Family Care · Gold', 'My Plan · Standard']);
    expect(t.groups.map((g: { group: string }) => g.group)).toEqual(['Limits and sub-limits', 'Waiting periods']);
    const row = (key: string) => t.groups.flatMap((g: { rows: Array<{ key: string }> }) => g.rows).find((r: { key: string }) => r.key === key);
    expect(row('room_rent')).toMatchObject({ values: ['No limit', 'No limit', 'No limit'], differs: false });
    expect(row('copay')).toMatchObject({ values: [0, 0, 'Not stated by insurer'], differs: true });
    expect(row('ped_wait')).toMatchObject({ values: [36, 24, 24], differs: true });
    const mine = (await w.A.get(`/catalogue/feature-table?typeId=${TYP}&source=OWN`)).body.data.columns.map((c: { productName: string }) => c.productName);
    expect(mine).toEqual(['My Plan']); // never another advisor's own product
  });
});

describe('SkyUp overviews (#53, #54) and audit (#58)', () => {
  it('subscriptions across advisors (Admin only), the wallets overview (Staff may view), and audit entries with a device and a masked IP', async () => {
    const w = await advisorWithLeads();
    await Account.updateOne({ _id: w.accountId }, { $set: { 'wallet.balancePaise': 5000 } });
    await WalletTxn.create({ accountId: w.accountId, type: 'DEBIT', amountPaise: 100, messageId: 'msg_1' });
    const admin = await seedAdmin();
    const M = as(admin.token);
    const subs = (await M.get('/admin/subscriptions')).body.data;
    expect(subs.find((s: { accountId: string }) => s.accountId === w.accountId)).toMatchObject({ advisor: 'Asha Rao', status: 'TRIAL', lastInvoice: null });
    expect((await M.get('/admin/subscriptions?status=ACTIVE')).body.data.find((s: { accountId: string }) => s.accountId === w.accountId)).toBeUndefined();
    const wal = (await M.get('/admin/wallets')).body.data;
    expect(wal.rows.find((r: { accountId: string }) => r.accountId === w.accountId)).toMatchObject({ balance: 50, status: 'LOW', statusLabel: 'Low', messagesThisMonth: 1 });
    expect(wal.totals.lowCount).toBeGreaterThanOrEqual(1);
    const m = newMobile();
    await User.create({ accountId: null, role: 'STF', name: 'Meena Staff', mobile: normalizeMobile(m), status: 'ACTIVE', activatedAt: new Date() });
    const S = as((await login(m)).token);
    expect((await S.get('/admin/wallets?filter=LOW')).status).toBe(200);
    expect((await S.get('/admin/subscriptions')).status).toBe(403);
    expect((await w.A.get('/admin/wallets')).status).toBe(403);
    const posted = await request(app).post(`/v1/leads/${w.a.id}/contacts`).set('Authorization', `Bearer ${w.adv.token}`).set('X-Client', 'app').set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36').set('Idempotency-Key', crypto.randomUUID()).send({ outcome: 'NOT_REACHABLE' });
    expect(posted.status).toBe(201);
    const entry = (await M.get('/audit?action=LEAD_CONTACT_LOGGED')).body.data[0];
    expect(entry.device).toBe('Chrome on Windows');
    expect(entry.ip).toMatch(/^\d+\.\d+\.•\.•$|^[0-9a-f]*:[0-9a-f]*:•$|^•$/);
  });
});

describe('device summary (#58)', () => {
  it('reads the user agent first; the mobile app and unknown clients get sensible labels; IPs are masked', async () => {
    const { deviceOf, maskIp } = await import('../src/modules/audit/audit.service.js');
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'app')).toBe('Safari on iOS');
    expect(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Edge on Windows');
    expect(deviceOf('okhttp/4.12.0', 'app')).toBe('Bimayantra app');
    expect(deviceOf('Dalvik/2.1.0 (Linux; U; Android 14)', 'app')).toBe('Bimayantra app on Android');
    expect(deviceOf(undefined, undefined)).toBeNull();
    expect(maskIp('203.0.113.42')).toBe('203.0.•.•');
    expect(maskIp('::ffff:10.1.2.3')).toBe('10.1.•.•');
    expect(maskIp('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:•');
  });
});