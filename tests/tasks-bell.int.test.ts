/**
 * Module 7 Stage 1 — P-11 Tasks and follow-ups, P-10 Bell notifications. Names cite the BPD checks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, err, login, newMobile, registerAdvisor, resetState, seedAdmin, startTestEnv, stopTestEnv } from './helpers.js';
import { clock, istToday } from '../src/lib/clock.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { notify } from '../src/modules/notifications/notifications.service.js';
import { runSweep } from '../src/modules/notifications/sweep.js';
import { Task } from '../src/modules/tasks/task.model.js';
import { Lead } from '../src/modules/leads/lead.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

/** An IST date as DD-MM-YYYY, n days from today. */
const day = (n: number) => { const d = new Date(`${istToday()}T12:00:00+05:30`); d.setUTCDate(d.getUTCDate() + n); const iso = d.toISOString().slice(0, 10); return `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`; };
const fieldIds = (r: { body: { error?: { fields?: Array<{ field: string; messageId: string }> } } }) => Object.fromEntries((r.body.error?.fields ?? []).map((f) => [f.field, f.messageId]));

async function setup() {
  const adv = await registerAdvisor('Asha Rao');
  const c = as(adv.token);
  const task = async (extra: object = {}) => c.post('/tasks', { title: 'Call Meena about renewal', dueDate: day(1), dueTime: '10:30 AM', ...extra });
  return { adv, c, task };
}

describe('P-11 tasks', () => {
  it('AC-P11-1: a task due in the past cannot be saved (VAL-07 for a past date, DSH-24 for an earlier time today)', async () => {
    const { task } = await setup();
    expect(fieldIds(await task({ dueDate: day(-1) }))).toEqual({ dueDate: 'VAL-07' });
    const earlier = await task({ dueDate: day(0), dueTime: '12:01 AM' });
    expect(fieldIds(earlier)).toEqual({ dueTime: 'DSH-24' });
    expect(JSON.stringify(earlier.body)).toContain('Choose a time later than now.');
    expect(fieldIds(await task({ title: '', dueTime: '25:00' }))).toEqual({ title: 'GEN-01', dueTime: 'VAL-32' });
  });

  it('saves OPEN at the IST time given, in 12-hour or 24-hour form', async () => {
    const { task } = await setup();
    const a = (await task({ dueTime: '2:05 pm' })).body.data;
    expect(a).toMatchObject({ status: 'OPEN', title: 'Call Meena about renewal' });
    expect(a.dueShown).toBe(`${day(1)} 02:05 PM`);
    expect((await task({ dueTime: '14:05' })).body.data.dueShown).toBe(`${day(1)} 02:05 PM`);
  });

  it('tabs: Upcoming, Today and Overdue (AC-P11-4), Done after Mark done (DSH-23); Reopen and Cancel', async () => {
    const { c, adv, task } = await setup();
    const up = (await task()).body.data;
    const later = new Date(Date.now() + 3 * 60_000);
    const todayRow = await Task.create({ accountId: adv.user.accountId, kind: 'GENERAL', title: 'Today', dueAt: later, createdBy: adv.user.id });
    const overdue = await Task.create({ accountId: adv.user.accountId, kind: 'GENERAL', title: 'Late', dueAt: new Date(Date.now() - 3_600_000), createdBy: adv.user.id });
    const tab = async (t: string) => (await c.get(`/tasks?tab=${t}`)).body.data;
    const o = await tab('OVERDUE');
    expect(o.tasks.map((x: { id: string }) => x.id)).toEqual([overdue._id]);
    expect(o.tasks[0].overdue).toBe(true);
    expect(o.counts).toMatchObject({ OVERDUE: 1, UPCOMING: 1, DONE: 0 });
    if (new Date(later.getTime() + 5.5 * 3_600_000).getUTCDate() === new Date(Date.now() + 5.5 * 3_600_000).getUTCDate()) {
      expect((await tab('TODAY')).tasks.map((x: { id: string }) => x.id)).toEqual([todayRow._id]);
    }
    const done = await c.post(`/tasks/${up.id}/done`, { version: up.version });
    expect(done.body.meta.message).toBe('Task marked as done.');
    expect((await tab('DONE')).tasks.map((x: { id: string }) => x.id)).toEqual([up.id]);
    const reopened = await c.post(`/tasks/${up.id}/reopen`, { version: done.body.data.version });
    expect(reopened.body.data.status).toBe('OPEN');
    expect((await c.post(`/tasks/${up.id}/cancel`, { version: reopened.body.data.version })).body.data.status).toBe('CANCELLED');
  });

  it('editing a task another tab completed gets GEN-05', async () => {
    const { c, task } = await setup();
    const t = (await task()).body.data;
    await c.post(`/tasks/${t.id}/done`, { version: t.version });
    expect(err(await c.patch(`/tasks/${t.id}`, { version: t.version, title: 'Changed' }))).toMatchObject({ status: 409, messageId: 'GEN-05' });
  });

  it('a task can be linked to a lead or customer of this account only; it shows the record and its status', async () => {
    const { c, task } = await setup();
    const cus = (await c.post('/customers', { name: 'Meena Iyer', mobile: newMobile() })).body.data;
    const t = (await task({ linkedType: 'CUSTOMER', linkedId: cus.id })).body.data;
    expect(t.linked).toMatchObject({ type: 'CUSTOMER', name: 'Meena Iyer', status: 'ACTIVE' });
    const other = await registerAdvisor('Ravi Kumar');
    const theirs = (await as(other.token).post('/customers', { name: 'Ravi Kumar', mobile: newMobile() })).body.data;
    expect(fieldIds(await task({ linkedType: 'CUSTOMER', linkedId: theirs.id }))).toEqual({ linkedId: 'VAL-22' });
  });

  it('AC-P11-3: moving a lead\u2019s follow-up task moves the lead\u2019s follow-up date; no second task appears', async () => {
    const { adv, c } = await setup();
    const pipeline = ((await c.get('/pipelines')).body.data as Array<{ id: string }>)[0]!.id;
    const lead = (await c.post('/leads', { pipelineId: pipeline, name: 'Priya Sharma', mobile: newMobile(), source: 'Walk-in or personal contact' })).body.data;
    const t = await Task.create({ accountId: adv.user.accountId, kind: 'LEAD_FOLLOW_UP', title: 'Follow up Priya', dueAt: new Date(Date.now() + 86_400_000), linkedType: 'LEAD', linkedId: lead.id, createdBy: adv.user.id });
    const moved = await c.patch(`/tasks/${t._id}`, { version: 1, dueDate: day(2), dueTime: '11:00 AM' });
    expect(moved.status).toBe(200);
    expect((await Lead.findById(lead.id).lean())!.nextFollowUpAt!.toISOString()).toBe(new Date(moved.body.data.dueAt).toISOString());
    expect(await Task.countDocuments({ linkedId: lead.id, status: 'OPEN' })).toBe(1);
  });

  it('only the advisor manages tasks; another account sees none and cannot change them', async () => {
    const { c, task } = await setup();
    const t = (await task()).body.data;
    const o = as((await registerAdvisor('Ravi Kumar')).token);
    expect((await o.get('/tasks?tab=UPCOMING')).body.data.tasks).toEqual([]);
    expect(err(await o.post(`/tasks/${t.id}/done`, { version: 1 }))).toMatchObject({ status: 404, messageId: 'GEN-11' });
    expect((await c.get('/tasks?tab=UPCOMING')).body.data.tasks).toHaveLength(1);
  });
});

describe('P-11 reminders (sweep)', () => {
  it('AC-P11-2: the reminder (DSH-11) arrives once, CFG-34 before the due time; a changed due time allows one new reminder', async () => {
    const { adv, c } = await setup();
    const t = await Task.create({ accountId: adv.user.accountId, kind: 'GENERAL', title: 'Call Meena', dueAt: new Date(Date.now() + 45 * 60_000), createdBy: adv.user.id });
    expect((await runSweep()).reminders).toBe(0); // 45 min away: not yet (CFG-34 = 30)
    const in20 = new Date(Date.now() + 15 * 60_000);
    expect((await runSweep(in20)).reminders).toBe(1);
    expect((await runSweep(in20)).reminders).toBe(0); // once
    await Promise.all([runSweep(in20), runSweep(in20)]); // two servers at once: still once
    const items = await Notification.find({ userId: adv.user.id, messageId: 'DSH-11' }).lean();
    expect(items).toHaveLength(1);
    expect(items[0]!.message).toMatch(/^Follow-up with Call Meena is due at .+\.$/);
    // move the task: exactly one new reminder for the new time
    await Task.updateOne({ _id: t._id }, { $set: { dueAt: new Date(Date.now() + 40 * 60_000) } });
    expect((await runSweep(new Date(Date.now() + 15 * 60_000))).reminders).toBe(1);
    expect(await Notification.countDocuments({ userId: adv.user.id, messageId: 'DSH-11' })).toBe(2);
    expect((await c.get('/notifications/count')).body.data.unread).toBe(2);
  });
});

describe('P-10 bell', () => {
  it('AC-P10-1: the count equals the UNREAD items; Mark all as read clears it; "99+" above CFG-149', async () => {
    const { adv, c } = await setup();
    for (let i = 0; i < 3; i++) await notify({ userId: adv.user.id, accountId: adv.user.accountId!, kind: 'TEST', messageId: 'DSH-23', dedupeKey: `t|${i}` });
    expect((await c.get('/notifications/count')).body.data).toEqual({ unread: 3, shown: '3' });
    expect((await c.post('/notifications/read-all')).body.data).toMatchObject({ marked: 3, unread: 0 });
    for (let i = 0; i < 100; i++) await notify({ userId: adv.user.id, accountId: adv.user.accountId!, kind: 'TEST', messageId: 'DSH-23', dedupeKey: `u|${i}` });
    expect((await c.get('/notifications/count')).body.data).toEqual({ unread: 100, shown: '99+' });
  });

  it('AC-P10-2: the same event received twice creates one item', async () => {
    const { adv } = await setup();
    const n = { userId: adv.user.id, accountId: adv.user.accountId!, kind: 'TEST', messageId: 'DSH-23' as const, dedupeKey: 'same|event|2026-10-27' };
    expect(await notify(n)).toBe(true);
    expect(await notify(n)).toBe(false);
    expect(await Notification.countDocuments({ userId: adv.user.id })).toBe(1);
  });

  it('AC-P10-3: selecting an item marks it READ and opens the right record; the list is newest first', async () => {
    const { adv, c, task } = await setup();
    const t = (await task()).body.data;
    await notify({ userId: adv.user.id, accountId: adv.user.accountId!, kind: 'TASK_DUE_SOON', messageId: 'DSH-11', params: { name: 'Meena', time: '10:30 AM' }, dedupeKey: 'a', link: { type: 'TASK', id: t.id } });
    await new Promise((r) => setTimeout(r, 10));
    await notify({ userId: adv.user.id, accountId: adv.user.accountId!, kind: 'TEST', messageId: 'DSH-23', dedupeKey: 'b' });
    const list = (await c.get('/notifications')).body.data;
    expect(list.items.map((i: { messageId: string }) => i.messageId)).toEqual(['DSH-23', 'DSH-11']);
    const item = list.items[1];
    const opened = await c.post(`/notifications/${item.id}/open`);
    expect(opened.body.data).toMatchObject({ link: { type: 'TASK', id: t.id }, unread: 1 });
    expect((await c.get('/notifications')).body.data.items[1].read).toBe(true);
  });

  it('AC-P10-4: an item linked to an inaccessible record shows GEN-11, leaks nothing, and is marked read', async () => {
    const { adv, c } = await setup();
    const other = await registerAdvisor('Ravi Kumar');
    const theirs = (await as(other.token).post('/customers', { name: 'Ravi Kumar', mobile: newMobile() })).body.data;
    await notify({ userId: adv.user.id, accountId: adv.user.accountId!, kind: 'TEST', messageId: 'DSH-23', dedupeKey: 'x', link: { type: 'CUSTOMER', id: theirs.id } });
    const id = (await c.get('/notifications')).body.data.items[0].id;
    const r = await c.post(`/notifications/${id}/open`);
    expect(err(r)).toMatchObject({ status: 404, messageId: 'GEN-11' });
    expect(JSON.stringify(r.body)).not.toContain('Ravi');
    expect((await c.get('/notifications/count')).body.data.unread).toBe(0);
  });

  it('each user sees only their own items; another user cannot open them', async () => {
    const { adv, c } = await setup();
    await notify({ userId: adv.user.id, accountId: adv.user.accountId!, kind: 'TEST', messageId: 'DSH-23', dedupeKey: 'mine' });
    const id = (await c.get('/notifications')).body.data.items[0].id;
    const o = as((await registerAdvisor('Ravi Kumar')).token);
    expect((await o.get('/notifications')).body.data.items).toEqual([]);
    expect(err(await o.post(`/notifications/${id}/open`))).toMatchObject({ status: 404 });
  });

  it('P-10 step 4: items older than CFG-72 (90 days) are removed by the sweep', async () => {
    const { adv } = await setup();
    await notify({ userId: adv.user.id, accountId: adv.user.accountId!, kind: 'TEST', messageId: 'DSH-23', dedupeKey: 'old' });
    await notify({ userId: adv.user.id, accountId: adv.user.accountId!, kind: 'TEST', messageId: 'DSH-23', dedupeKey: 'new' });
    await Notification.collection.updateOne({ dedupeKey: 'old' }, { $set: { createdAt: new Date(Date.now() - 91 * 86_400_000) } });
    expect((await runSweep()).removed).toBe(1);
    expect((await Notification.find({ userId: adv.user.id }).lean()).map((n) => n.dedupeKey)).toEqual(['new']);
  });

  it('DSH-21: submitting KYC tells every SkyUp reviewer, once; the advisor gets DSH-10 at a profile milestone', async () => {
    const admin = await seedAdmin();
    const staffMobile = newMobile();
    const { User } = await import('../src/modules/users/user.model.js');
    const { normalizeMobile } = await import('../src/lib/phone.js');
    await User.create({ accountId: null, role: 'STF', name: 'Meena Iyer', mobile: normalizeMobile(staffMobile), status: 'ACTIVE', activatedAt: new Date() });
    const staff = await login(staffMobile);
    const { adv, c } = await setup();
    const p = (await c.get('/profile')).body.data;
    await c.put('/profile/contact', { version: p.sections.contact.version, email: 'asha@example.com', address1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' });
    await c.put('/profile/personal', { version: p.sections.personal.version, dob: '15-04-1988' });
    await c.put('/profile/professional', { version: p.sections.professional.version, advisorType: 'POSP', licenceNumber: 'POSP-1', licenceValidUntil: day(400), categories: ['Health'] });
    const mine = (await c.get('/notifications')).body.data.items;
    expect(mine.map((i: { messageId: string; message: string }) => `${i.messageId}: ${i.message}`)).toEqual(['DSH-10: Your profile is 55% complete.']);
    const { app } = await import('./helpers.js');
    const request = (await import('supertest')).default;
    const up = (purpose: string, body: Buffer) => request(app).post(`/v1/files?purpose=${purpose}`).set('Authorization', `Bearer ${adv.token}`).set('Content-Type', 'application/octet-stream').send(body);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const k = (await c.get('/kyc')).body.data;
    await c.put('/kyc', { version: k.version, pan: 'ABCPE1234F', nameOnPan: 'Asha Rao', panFileId: (await up('KYC_PAN', png)).body.data.id, licenceFileId: (await up('KYC_LICENCE', Buffer.from('%PDF-1.4\ntrailer << >>\n%%EOF\n'))).body.data.id, declaration: true });
    for (const who of [admin, staff]) {
      const items = (await as(who.token).get('/notifications')).body.data.items;
      expect(items.map((i: { message: string }) => i.message)).toEqual(['KYC from Asha Rao is waiting for review.']);
      const opened = await as(who.token).post(`/notifications/${items[0].id}/open`);
      expect(opened.body.data.link).toEqual({ type: 'KYC_REVIEW', id: adv.user.accountId });
    }
    void clock;
  });
});