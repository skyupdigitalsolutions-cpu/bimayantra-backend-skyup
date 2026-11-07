/** Stage E2: admin panel items #49 to #60 (change analysis §9). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, err, login, newMobile, registerAdvisor, resetState, seedAdmin, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { normalizeMobile } from '../src/lib/phone.js';
import { Account } from '../src/modules/accounts/account.model.js';
import { runSubscriptionJob } from '../src/modules/admin/admin.service.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { Customer } from '../src/modules/customers/customer.model.js';
import { AgentCodeFlag } from '../src/modules/insurers/agentCodeFlag.model.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { InsurerMapping } from '../src/modules/insurers/mapping.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { User } from '../src/modules/users/user.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

async function staff(name = 'Meena Staff') {
  const m = newMobile();
  await User.create({ accountId: null, role: 'STF', name, mobile: normalizeMobile(m), status: 'ACTIVE', activatedAt: new Date() });
  return { mobile: m, ...(await login(m)) };
}
async function admin() {
  const a = await seedAdmin();
  const A = as(a.token);
  const otp = async () => ({ 'X-Step-Up-Token': await stepUp(a.token, a.mobile) });
  return { a, A, otp };
}
/** An advisor on a paid Normal plan (offline payment recorded by the Admin). */
async function paidAdvisor(ad: Awaited<ReturnType<typeof admin>>, name = 'Asha Rao') {
  const adv = await registerAdvisor(name);
  const r = await ad.A.post(`/admin/accounts/${adv.user.accountId}/offline-payment`, { plan: 'NORMAL', cycle: 'YEARLY', amount: 5900, reference: `NEFT-${Date.now()}-${Math.random()}` }, await ad.otp());
  expect(r.status).toBe(201);
  return adv;
}
let insN = 0;
async function insurer(name = `Alpha General ${++insN}`) {
  return (await Insurer.create({ name, nameKey: name.toLowerCase(), shortCode: `T${Date.now().toString(36)}${insN}`.toUpperCase(), category: 'General', irdaiRegNo: `REG-${insN}`, paymentDomains: ['example.com'], status: 'ACTIVE' }))._id as string;
}

describe('#49 advisor accounts', () => {
  it('the list has tab counts and filters; older screens still get the rows; never client names', async () => {
    const ad = await admin();
    const paid = await paidAdvisor(ad, 'Asha Rao');
    const trial = await registerAdvisor('Ravi Kumar');
    await Customer.create({ accountId: paid.user.accountId, number: 'CU-000001', name: 'Meena Iyer', nameKey: 'meena iyer', mobile: normalizeMobile(newMobile()), status: 'ACTIVE', createdBy: paid.user.id });
    const out = (await ad.A.get('/admin/accounts?view=tabs')).body.data;
    expect(out.tabs).toMatchObject({ ALL: 2, TRIAL: 1, ACTIVE: 1, GRACE: 0, READ_ONLY: 0, SUSPENDED: 0, CLOSED: 0 });
    const row = out.rows.find((r: { id: string }) => r.id === paid.user.accountId);
    expect(row).toMatchObject({ advisor: 'Asha Rao', plan: 'NORMAL', subscription: 'ACTIVE', tab: 'ACTIVE', kycStatus: 'NOT_SUBMITTED', counts: { customers: 1, leads: 0 } });
    expect(row.mobile).toMatch(/X{5}/);
    expect(JSON.stringify(out)).not.toContain('Meena');
    expect((await ad.A.get('/admin/accounts?view=tabs&tab=TRIAL')).body.data.rows.map((r: { id: string }) => r.id)).toEqual([trial.user.accountId]);
    expect((await ad.A.get('/admin/accounts?view=tabs&q=ravi')).body.data.tabs.ALL).toBe(1);
    expect(Array.isArray((await ad.A.get('/admin/accounts')).body.data)).toBe(true); // the earlier shape
  });

  it('the 8 tabs: Staff read the advisor tabs; Subscription and Activity are Admin only', async () => {
    const ad = await admin();
    const adv = await paidAdvisor(ad);
    const id = adv.user.accountId!;
    const S = as((await staff()).token);
    const ov = (await S.get(`/admin/accounts/${id}`)).body.data;
    expect(ov).toMatchObject({ advisor: 'Asha Rao', plan: 'NORMAL', subscription: 'ACTIVE', assistants: { used: 0 }, counts: { leads: 0, customers: 0, quotations: 0, policies: 0 } });
    expect(ov.suspendReasons).toContain('Suspected fraud');
    for (const tab of ['kyc', 'insurers', 'wallet', 'assistants', 'support-grants']) expect((await S.get(`/admin/accounts/${id}/${tab}`)).status).toBe(200);
    for (const tab of ['subscription', 'activity']) expect(err(await S.get(`/admin/accounts/${id}/${tab}`))).toMatchObject({ status: 403 });
    const sub = (await ad.A.get(`/admin/accounts/${id}/subscription`)).body.data;
    expect(sub).toMatchObject({ plan: 'NORMAL', status: 'ACTIVE', cycle: 'YEARLY', graceDays: expect.any(Number) });
    expect(sub.invoices[0]).toMatchObject({ method: 'Offline', recordedBy: expect.any(String) });
    const act = (await ad.A.get(`/admin/accounts/${id}/activity`)).body.data as Array<{ type: string; device?: string }>;
    expect(act.some((x) => x.type === 'LOGIN' && x.device)).toBe(true);
    expect(act.some((x) => x.type === 'PLAN')).toBe(true);
    expect((await ad.A.get(`/admin/accounts/${id}/activity?type=PLAN`)).body.data.every((x: { type: string }) => x.type === 'PLAN')).toBe(true);
    expect(err(await as(adv.token).get(`/admin/accounts/${id}`))).toMatchObject({ status: 403 });
    expect(err(await ad.A.get(`/admin/accounts/acc_${'f'.repeat(28)}`))).toMatchObject({ status: 404 });
  });

  it('the insurers tab shows "Also in" for a shared code and Code expired', async () => {
    const ad = await admin();
    const one = await registerAdvisor('Asha Rao');
    const two = await registerAdvisor('Ravi Kumar');
    const ins = await insurer('Alpha General');
    await as(one.token).post('/my-insurers', { insurerId: ins, agentCode: 'SHARED-1', declaration: true });
    await as(two.token).post('/my-insurers', { insurerId: ins, agentCode: 'SHARED-1', declaration: true });
    await InsurerMapping.updateOne({ accountId: one.user.accountId }, { $set: { validUntil: '2020-01-01' } });
    const rows = (await ad.A.get(`/admin/accounts/${one.user.accountId}/insurers`)).body.data;
    expect(rows[0]).toMatchObject({ insurer: 'Alpha General', agentCode: 'SHARED-1', status: 'CODE_EXPIRED', flagged: true, flagText: 'Also in Ravi Kumar' });
  });
});

describe('#50 SkyUp changes a plan', () => {
  it('needs the OTP and a note; Premium now; the advisor is told; kept in the subscription tab', async () => {
    const ad = await admin();
    const adv = await paidAdvisor(ad);
    const id = adv.user.accountId!;
    expect(err(await ad.A.post(`/admin/accounts/${id}/plan`, { toPlan: 'PREMIUM', effective: 'NOW', note: 'Promo' }))).toMatchObject({ status: 403, messageId: 'AUTH-26' });
    const r = await ad.A.post(`/admin/accounts/${id}/plan`, { toPlan: 'PREMIUM', effective: 'NOW', note: 'Diwali promotion' }, await ad.otp());
    expect(r.status).toBe(200);
    expect(r.body.meta.message).toMatch(/^Plan changed to Premium from \d{2}-\d{2}-\d{4}\.$/);
    const acc = (await Account.findById(id).lean<{ subscription: { plan: string; waNumber: { status: string } } }>())!;
    expect(acc.subscription).toMatchObject({ plan: 'PREMIUM', waNumber: { status: 'SETTING_UP' } });
    expect(await Notification.findOne({ userId: adv.user.id, messageId: 'SUB-18' }).lean()).toBeTruthy();
    expect((await ad.A.get(`/admin/accounts/${id}/subscription`)).body.data.planChanges[0]).toMatchObject({ fromPlan: 'NORMAL', toPlan: 'PREMIUM', effective: 'NOW', note: 'Diwali promotion' });
  });

  it('a downgrade can wait for the renewal; Premium at renewal, the same plan and a trial are refused', async () => {
    const ad = await admin();
    const adv = await paidAdvisor(ad);
    const id = adv.user.accountId!;
    const refusedOnly = await ad.otp(); // a refused action does not use the OTP up, so one serves every refusal here
    expect((await ad.A.post(`/admin/accounts/${id}/plan`, { toPlan: 'NORMAL', effective: 'NOW', note: 'x note' }, refusedOnly)).body.error.messageId).toBe('GEN-04');
    expect((await ad.A.post(`/admin/accounts/${id}/plan`, { toPlan: 'PREMIUM', effective: 'NEXT_RENEWAL', note: 'x note' }, refusedOnly)).body.error.fields[0]).toMatchObject({ field: 'effective', messageId: 'VAL-22' });
    await ad.A.post(`/admin/accounts/${id}/plan`, { toPlan: 'PREMIUM', effective: 'NOW', note: 'Up' }, await ad.otp());
    const down = await ad.A.post(`/admin/accounts/${id}/plan`, { toPlan: 'NORMAL', effective: 'NEXT_RENEWAL', note: 'Back at renewal' }, await ad.otp());
    expect(down.status).toBe(200);
    expect((await Account.findById(id).lean<{ subscription: { plan: string; nextPlan: string } }>())!.subscription).toMatchObject({ plan: 'PREMIUM', nextPlan: 'NORMAL' });
    const trial = await registerAdvisor('Ravi Kumar');
    expect(err(await ad.A.post(`/admin/accounts/${trial.user.accountId}/plan`, { toPlan: 'PREMIUM', effective: 'NOW', note: 'x note' }, refusedOnly))).toMatchObject({ status: 409 });
  });
});

describe('#51 #52 close and suspend', () => {
  it('close needs the typed word CLOSE exactly (ADM-14), a reason and the OTP; the OTP is used once', async () => {
    const ad = await admin();
    const adv = await registerAdvisor();
    const id = adv.user.accountId!;
    const tok = await ad.otp();
    for (const confirmText of [undefined, 'close', 'CLOSED']) {
      const r = await ad.A.post(`/admin/accounts/${id}/close`, { reason: 'Asked to leave', ...(confirmText ? { confirmText } : {}) }, tok);
      expect(r.body.error.fields[0]).toMatchObject({ field: 'confirmText', messageId: 'ADM-14', message: 'Type CLOSE to confirm.' });
    }
    expect((await ad.A.post(`/admin/accounts/${id}/close`, { confirmText: 'CLOSE' }, tok)).body.error.fields[0]).toMatchObject({ field: 'reason', messageId: 'GEN-01' });
    const ok = await ad.A.post(`/admin/accounts/${id}/close`, { reasonCode: 'Requested by the advisor', confirmText: 'CLOSE' }, tok);
    expect(ok.body.data.status).toBe('CLOSED');
    expect((await Account.findById(id).lean<{ statusReason: string }>())!.statusReason).toBe('Requested by the advisor');
    expect(await AuditLog.findOne({ action: 'ACCOUNT_CLOSED' }).lean()).toMatchObject({ after: { typedConfirmation: true } });
    const other = await registerAdvisor('Ravi Kumar');
    expect(err(await ad.A.post(`/admin/accounts/${other.user.accountId}/close`, { reason: 'x', confirmText: 'CLOSE' }, tok))).toMatchObject({ status: 403, messageId: 'AUTH-26' });
  });

  it('suspend takes the BPD list, free text, or "Other" with the text', async () => {
    const ad = await admin();
    const a1 = await registerAdvisor('Asha Rao'); const a2 = await registerAdvisor('Ravi Kumar'); const a3 = await registerAdvisor('Kiran Das');
    const first = await ad.otp(); // refusals keep the OTP, so it then serves the first suspension
    expect((await ad.A.post(`/admin/accounts/${a1.user.accountId}/suspend`, { reasonCode: 'Other' }, first)).body.error.fields[0]).toMatchObject({ field: 'reason', messageId: 'GEN-01' });
    expect((await ad.A.post(`/admin/accounts/${a1.user.accountId}/suspend`, { reasonCode: 'Bored' }, first)).status).toBe(400);
    expect((await ad.A.post(`/admin/accounts/${a1.user.accountId}/suspend`, { reasonCode: 'Suspected fraud' }, first)).status).toBe(200);
    await ad.A.post(`/admin/accounts/${a2.user.accountId}/suspend`, { reasonCode: 'Other', reason: 'Insurer complaint' }, await ad.otp());
    await ad.A.post(`/admin/accounts/${a3.user.accountId}/suspend`, { reason: 'Spam messages reported' }, await ad.otp());
    const reasons = await Promise.all([a1, a2, a3].map(async (x) => (await Account.findById(x.user.accountId).lean<{ statusReason: string }>())!.statusReason));
    expect(reasons).toEqual(['Suspected fraud', 'Other: Insurer complaint', 'Spam messages reported']);
  });
});

describe('#55 agent-code flags', () => {
  async function shared() {
    const ins = await insurer('Alpha General');
    const one = await registerAdvisor('Asha Rao');
    const two = await registerAdvisor('Ravi Kumar');
    await as(one.token).post('/my-insurers', { insurerId: ins, agentCode: 'SHARED-1', declaration: true });
    const S = await staff();
    await as(two.token).post('/my-insurers', { insurerId: ins, agentCode: 'shared-1', declaration: true });
    return { ins, one, two, S, SA: as(S.token) };
  }

  it('raising tells SkyUp once (AGC-04) and the advisors nothing; the list has items and the earlier shape', async () => {
    const { one, two, S, SA } = await shared();
    expect(await Notification.find({ userId: S.user.id, messageId: 'AGC-04' }).lean()).toHaveLength(1);
    expect(await Notification.find({ userId: { $in: [one.user.id, two.user.id] } , messageId: /^AGC/ }).lean()).toHaveLength(0);
    const items = (await SA.get('/admin/agent-code-flags?view=items')).body.data;
    expect(items.counts).toEqual({ OPEN: 1, RESOLVED: 0 });
    expect(items.items[0]).toMatchObject({ insurer: 'Alpha General', agentCode: 'SHARED-1', status: 'OPEN', version: 1 });
    const old = (await SA.get('/admin/agent-code-flags')).body.data;
    expect(old[0]).toMatchObject({ insurer: 'Alpha General', agentCode: 'SHARED-1', accounts: expect.any(Array) });
  });

  it('Ask both advisors keeps it open and tells both; Remove from one account deactivates that mapping and resolves it', async () => {
    const { ins, one, two, SA } = await shared();
    const f = (await SA.get('/admin/agent-code-flags?view=items')).body.data.items[0];
    const ask = await SA.post(`/admin/agent-code-flags/${f.id}/resolve`, { version: 1, resolution: 'ASKED_ADVISORS', note: 'Please send your appointment letter' });
    expect(ask.body).toMatchObject({ data: { status: 'OPEN', version: 2 }, meta: { message: 'Agent code review saved.' } });
    expect((await Notification.findOne({ userId: one.user.id, messageId: 'AGC-02' }).lean())!.message).toBe('SkyUp has a question about your agent code SHARED-1 for Alpha General: Please send your appointment letter');
    expect(await Notification.exists({ userId: two.user.id, messageId: 'AGC-02' })).toBeTruthy();
    expect((await SA.post(`/admin/agent-code-flags/${f.id}/resolve`, { version: 2, resolution: 'REMOVED_FROM_ACCOUNT', accountId: `acc_${'f'.repeat(28)}`, note: 'x' })).body.error.fields[0]).toMatchObject({ field: 'accountId', messageId: 'VAL-22' });
    expect(err(await SA.post(`/admin/agent-code-flags/${f.id}/resolve`, { version: 1, resolution: 'BOTH_VALID', note: 'x' }))).toMatchObject({ status: 409 }); // stale version
    const rm = await SA.post(`/admin/agent-code-flags/${f.id}/resolve`, { version: 2, resolution: 'REMOVED_FROM_ACCOUNT', accountId: two.user.accountId, note: 'Code belongs to Asha Rao' });
    expect(rm.body.data).toMatchObject({ status: 'RESOLVED', resolution: 'REMOVED_FROM_ACCOUNT' });
    expect((await InsurerMapping.findOne({ accountId: two.user.accountId, insurerId: ins }).lean())!.status).toBe('INACTIVE');
    expect((await InsurerMapping.findOne({ accountId: one.user.accountId, insurerId: ins }).lean())!.status).toBe('ACTIVE');
    expect(await Notification.exists({ userId: two.user.id, messageId: 'AGC-03' })).toBeTruthy();
    expect(await Notification.exists({ userId: one.user.id, messageId: 'AGC-03' })).toBeFalsy();
    expect(err(await SA.post(`/admin/agent-code-flags/${f.id}/resolve`, { version: 3, resolution: 'BOTH_VALID', note: 'x' }))).toMatchObject({ status: 409 });
    expect((await SA.get('/admin/agent-code-flags?view=items&status=RESOLVED')).body.data.items[0].actions).toHaveLength(2);
  });

  it('flags saved before this change are picked up once; Both valid resolves without telling anyone', async () => {
    const ins = await insurer('Beta Life');
    const one = await registerAdvisor('Asha Rao'); const two = await registerAdvisor('Ravi Kumar');
    const at = new Date('2026-09-01T10:00:00Z');
    for (const acc of [one, two]) await InsurerMapping.create({ accountId: acc.user.accountId, insurerId: ins, agentCode: 'OLD-7', declaredAt: at, createdBy: acc.user.id, flaggedAt: at });
    const S = await staff();
    const list = (await as(S.token).get('/admin/agent-code-flags?view=items')).body.data;
    expect(list.items).toHaveLength(1);
    expect(await AgentCodeFlag.countDocuments()).toBe(1);
    await as(S.token).get('/admin/agent-code-flags?view=items');
    expect(await AgentCodeFlag.countDocuments()).toBe(1); // not twice
    const r = await as(S.token).post(`/admin/agent-code-flags/${list.items[0].id}/resolve`, { version: 1, resolution: 'BOTH_VALID', note: 'Shared POSP code' });
    expect(r.body.data.status).toBe('RESOLVED');
    expect(await InsurerMapping.countDocuments({ flaggedAt: { $type: 'date' } })).toBe(0);
    expect(err(await as(one.token).get('/admin/agent-code-flags'))).toMatchObject({ status: 403 });
  });
});

describe('#56 support access, SkyUp side', () => {
  it('grants list per person; read-only sections under the grant; refused and logged without one; End my session', async () => {
    const S1 = await staff('Meena Staff'); const S2 = await staff('Kiran Staff');
    const ad = await admin();
    const adv = await registerAdvisor();
    const id = adv.user.accountId!;
    const give = await as(adv.token).post('/support-grants', { granteeUserId: S1.user.id, reason: 'Quotation PDF issue' }, { 'X-Step-Up-Token': await stepUp(adv.token, adv.mobile) });
    expect(give.status).toBe(201);
    expect((await as(S1.token).get('/admin/support-grants')).body.data).toEqual([expect.objectContaining({ accountId: id, advisor: 'Asha Rao', to: 'Meena Staff', mine: true, status: 'ACTIVE' })]);
    expect((await as(S2.token).get('/admin/support-grants')).body.data).toEqual([]);
    expect((await ad.A.get('/admin/support-grants?status=ACTIVE')).body.data).toHaveLength(1); // Admins see every grant
    const A1 = as(S1.token);
    expect((await A1.get(`/support/${id}/overview`)).body.data).toMatchObject({ advisor: 'Asha Rao', readOnly: true, sections: ['quotations', 'customers', 'leads', 'documents'] });
    for (const s of ['leads', 'quotations', 'documents', 'customers']) expect((await A1.get(`/support/${id}/${s}`)).status).toBe(200);
    expect((await ad.A.get(`/admin/accounts/${id}/support-grants`)).body.data[0].recordsOpened).toBe(5);
    expect(err(await as(S2.token).get(`/support/${id}/leads`))).toMatchObject({ status: 403, messageId: 'SUP-03' });
    expect(await AuditLog.findOne({ action: 'SUPPORT_ACCESS_REFUSED', actorUserId: S2.user.id }).lean()).toMatchObject({ result: 'REFUSED', after: { what: 'Lead list' } });
    const grantId = give.body.data._id ?? give.body.data.id;
    expect(err(await as(S2.token).post(`/admin/support-grants/${grantId}/end`))).toMatchObject({ status: 404 }); // not theirs
    const end = await A1.post(`/admin/support-grants/${grantId}/end`);
    expect(end.body.meta.message).toBe('Your support session for Asha Rao has ended.');
    expect(err(await A1.get(`/support/${id}/leads`))).toMatchObject({ status: 403, messageId: 'SUP-03' });
    expect((await as(S1.token).get('/admin/support-grants?status=ENDED')).body.data[0]).toMatchObject({ status: 'ENDED', endedBy: 'GRANTEE' });
  });
});

describe('#57 #59 #60 users, dashboard, notifications', () => {
  it('a SkyUp user can be added with an email (the OTP is still needed)', async () => {
    const ad = await admin();
    const m = newMobile();
    expect(err(await ad.A.post('/staff', { name: 'Neha Shah', mobile: m, role: 'STF', email: 'Neha@SkyUp.in' }))).toMatchObject({ status: 403, messageId: 'AUTH-26' });
    const r = await ad.A.post('/staff', { name: 'Neha Shah', mobile: m, role: 'STF', email: 'Neha@SkyUp.in' }, await ad.otp());
    expect(r.body.data).toMatchObject({ name: 'Neha Shah', status: 'INVITED', email: 'neha@skyup.in' });
    expect((await ad.A.post('/staff', { name: 'Bad Mail', mobile: newMobile(), role: 'STF', email: 'not-an-email' }, await ad.otp())).body.error.fields[0].field).toBe('email');
    expect((await ad.A.get('/staff')).body.data.find((u: { name: string }) => u.name === 'Neha Shah').email).toBe('neha@skyup.in');
  });

  it('the dashboard: KPIs, needs-attention, plan mix; no pending-approvals count; Staff may open it, advisors not', async () => {
    const ad = await admin();
    await paidAdvisor(ad, 'Asha Rao');
    const trial = await registerAdvisor('Ravi Kumar');
    await Account.updateOne({ _id: trial.user.accountId }, { $set: { 'profile.kycStatus': 'PENDING_REVIEW', 'profile.kyc.submittedAt': new Date() } });
    const S = await staff();
    const d = (await as(S.token).get('/admin/dashboard')).body.data;
    expect(d.kpis).toMatchObject({ advisors: { total: 2, active: 1, trial: 1 }, kycToReview: { count: 1 }, trialsEndingIn7Days: 1, openAgentCodeFlags: 0, correctionsWaiting: 0 });
    expect(d.planMix).toMatchObject({ TRIAL: 1, NORMAL: 1, PREMIUM: 0 });
    expect(d.needsAttention.map((x: { type: string }) => x.type).sort()).toEqual(['KYC', 'TRIAL_ENDING']);
    expect(d.recentActivity.length).toBeGreaterThan(0);
    expect(JSON.stringify(d)).not.toMatch(/pendingApprovals|approval/i);
    expect(err(await as(trial.token).get('/admin/dashboard'))).toMatchObject({ status: 403 });
  });

  it('notifications page filters (All, Unread, KYC, Accounts); the daily trials summary goes to SkyUp once a day', async () => {
    const S = await staff();
    await registerAdvisor('Ravi Kumar'); // a trial ending within 7 days
    await runSubscriptionJob();
    await runSubscriptionJob(); // same day: no second item
    const SA = as(S.token);
    const acc = (await SA.get('/notifications?filter=ACCOUNTS')).body.data.items;
    expect(acc).toHaveLength(1);
    expect(acc[0].message).toBe('1 trials end in the next 7 days.');
    expect((await SA.get('/notifications?filter=KYC')).body.data.items).toEqual([]);
    expect((await SA.get('/notifications?filter=UNREAD')).body.data.items).toHaveLength(1);
    await SA.post('/notifications/read-all');
    expect((await SA.get('/notifications?filter=UNREAD')).body.data.items).toEqual([]);
    expect((await SA.get('/notifications?filter=ALL')).body.data.items).toHaveLength(1);
    expect((await SA.get('/notifications?filter=BOGUS')).status).toBe(400);
  });
});