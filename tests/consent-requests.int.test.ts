import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clock } from '../src/lib/clock.js';
import { isEncrypted } from '../src/lib/pii.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { devProvider, resetSeeded, sendDue } from '../src/modules/comms/comms.service.js';
import { Outbox } from '../src/modules/comms/outbox.model.js';
import { ConsentRequest } from '../src/modules/customers/consentRequest.model.js';
import { GlobalFlag, loadFlags } from '../src/modules/flags/flags.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { app, as, err, login, newMobile, registerAdvisor, resetState, setCfg, startTestEnv, stopTestEnv } from './helpers.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => {
  clock.setOffset(0);
  devProvider.setFailMode('none');
  resetSeeded();
  await resetState();
  // the new rule, as shipped: consent is given only by the person confirming a request
  await GlobalFlag.deleteOne({ _id: 'consent_customer_confirms' });
  await loadFlags();
});

const tokenOf = (link: string) => link.split('/consent/')[1]!;
const pub = {
  get: (token: string) => request(app).get(`/v1/public/consent/${token}`),
  post: (token: string, body: object) => request(app).post(`/v1/public/consent/${token}`).send(body),
};

async function setup() {
  const adv = await registerAdvisor();
  const c = as(adv.token);
  const cus = (await c.post('/customers', { name: 'Meena Iyer', mobile: newMobile(), email: 'meena@example.com' })).body.data;
  const ask = (body: object) => c.post(`/customers/${cus.id}/consent-requests`, { personType: 'CUSTOMER', personId: cus.id, ...body });
  return { adv, c, cus, ask };
}

describe('Consent requests: the customer confirms consent', () => {
  it('by email: the link is emailed; the customer agrees; consent is GIVEN on the record, by the customer, once', async () => {
    const { c, cus, ask, adv } = await setup();
    const r = await ask({ channels: ['WHATSAPP', 'EMAIL', 'PERSONAL_DATA'], via: 'EMAIL' });
    expect(r.status).toBe(201);
    expect(r.body.meta).toMatchObject({ messageId: 'CU-39', message: 'Consent request emailed to meena@example.com. Consent is recorded when Meena Iyer confirms it.' });
    expect(r.body.data.request).toMatchObject({ status: 'PENDING', via: 'EMAIL', channels: ['WHATSAPP', 'EMAIL', 'PERSONAL_DATA'], sentTo: 'me***@example.com' });
    expect(r.body.data.consents.requests).toHaveLength(1);
    const token = tokenOf(r.body.data.link);

    // only a hash of the token is stored; the address is encrypted
    const raw = await mongoose.connection.db!.collection('consent_requests').findOne({});
    expect(JSON.stringify(raw)).not.toContain(token);
    expect(isEncrypted(raw!.sentTo)).toBe(true);

    // the email goes out with the link
    expect((await sendDue()).sent).toBe(1);
    expect(devProvider.inbox[0]).toMatchObject({ channel: 'EMAIL', to: 'meena@example.com', subject: 'Asha Rao asks for your consent' });
    expect(devProvider.inbox[0]!.text).toContain(r.body.data.link);

    // the page: what is asked, for which (masked) number and email; opening is noted
    const view = await pub.get(token);
    expect(view.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(view.body.data).toMatchObject({ valid: true, name: 'Meena Iyer', via: 'EMAIL', advisor: { name: 'Asha Rao' } });
    expect(view.body.data.channels.map((x: { channel: string; address: string | null }) => [x.channel, x.address])).toEqual([
      ['WHATSAPP', `${cus.mobile.slice(3, 5)}XXXXXX${cus.mobile.slice(-2)}`], ['EMAIL', 'me***@example.com'], ['PERSONAL_DATA', null],
    ]);
    expect(view.body.data.termsVersion).toBeTruthy();
    expect((await ConsentRequest.findOne({}).lean())!.openedAt).toBeTruthy();

    // declaration needed; a channel that was not asked for is refused
    expect((await pub.post(token, { agree: true, channels: ['WHATSAPP'] })).body.error.fields[0].messageId).toBe('VAL-29');
    expect(err(await pub.post(token, { agree: true, channels: ['SMS'], declaration: true }))).toMatchObject({ status: 400, messageId: 'VAL-22' });

    // agree to two of three
    const ok = await pub.post(token, { agree: true, channels: ['WHATSAPP', 'PERSONAL_DATA'], declaration: true });
    expect(ok.status).toBe(200);
    expect(ok.body.meta.message).toBe('Thank you, Meena. Your consent has been recorded.');

    const grid = (await c.get(`/customers/${cus.id}/consents`)).body.data;
    expect(grid.rows[0].channels.WHATSAPP).toMatchObject({ status: 'GIVEN', howGiven: 'Confirmed by the customer (email link)', address: cus.mobile });
    expect(grid.rows[0].channels.EMAIL.status).toBe('NOT_RECORDED');
    expect(grid.personalData.status).toBe('GIVEN');
    expect(grid.history[0]).toMatchObject({ source: 'CUSTOMER', to: 'GIVEN', by: null });
    expect(grid.requests[0]).toMatchObject({ status: 'CONFIRMED', given: ['WHATSAPP', 'PERSONAL_DATA'], declined: ['EMAIL'], email: { status: 'SENT' } });
    expect(grid.customerConfirms).toBe(true);
    expect((await c.get(`/customers/${cus.id}`)).body.data.personalDataConsent).toBe('GIVEN');

    // the advisor is told; the audit names the customer, with no signed-in user
    const bell = await Notification.find({ userId: adv.user.id, messageId: 'CU-46' }).lean();
    expect(bell).toHaveLength(1);
    expect(bell[0]!.message).toBe('Meena Iyer confirmed consent: WhatsApp, Personal-data.');
    const a = await AuditLog.findOne({ action: 'CONSENT_GIVEN' }).lean();
    expect(a).toMatchObject({ actorUserId: null, actorLabel: 'Meena Iyer (consent link)' });

    // once only: a second tap or another tab
    expect(err(await pub.post(token, { agree: true, channels: ['EMAIL'], declaration: true }))).toMatchObject({ status: 409, messageId: 'CU-45' });
    expect((await pub.get(token)).body.data).toMatchObject({ valid: false, answered: true, messageId: 'CU-45' });
    expect(err(await pub.get('x'.repeat(43)))).toMatchObject({ status: 404 });
  });

  it('by WhatsApp and Telegram: a ready message from the advisor\'s own app; saying no records nothing', async () => {
    const { c, cus, ask } = await setup();
    const wa = await ask({ channels: ['WHATSAPP'], via: 'WHATSAPP' });
    expect(wa.body.meta.message).toBe('Consent request ready. Send it to Meena Iyer on WhatsApp; consent is recorded when they confirm it.');
    expect(wa.body.data.whatsappUrl).toMatch(new RegExp(`^https://wa\\.me/${cus.mobile.slice(1)}\\?text=`));
    expect(decodeURIComponent(wa.body.data.whatsappUrl.split('text=')[1])).toContain(wa.body.data.link);
    expect(await Outbox.countDocuments({})).toBe(0); // nothing is sent by Bimayantra on WhatsApp

    const tg = await ask({ channels: ['WHATSAPP', 'SMS'], via: 'TELEGRAM' });
    expect(tg.body.data.telegramUrl).toBe(`https://t.me/share/url?url=${encodeURIComponent(tg.body.data.link)}&text=${tg.body.data.telegramUrl.split('&text=')[1]}`);
    // the newer request asks for everything the older one did: the older link stops working
    expect((await pub.get(tokenOf(wa.body.data.link))).body.data).toMatchObject({ valid: false, answered: false, messageId: 'CU-44' });

    const no = await pub.post(tokenOf(tg.body.data.link), { agree: false });
    expect(no.body.meta.message).toBe('Thank you. Nothing has been recorded, and Asha Rao has been told.');
    const grid = (await c.get(`/customers/${cus.id}/consents`)).body.data;
    expect(grid.rows[0].channels.WHATSAPP.status).toBe('NOT_RECORDED');
    expect(grid.requests.map((x: { status: string; via: string }) => `${x.via}:${x.status}`)).toEqual(['TELEGRAM:DECLINED', 'WHATSAPP:CANCELLED']);
    // agreeing on Telegram records how it reached them
    const again = await ask({ channels: ['WHATSAPP'], via: 'TELEGRAM' });
    await pub.post(tokenOf(again.body.data.link), { agree: true, declaration: true });
    expect((await c.get(`/customers/${cus.id}/consents`)).body.data.rows[0].channels.WHATSAPP.howGiven).toBe('Confirmed by the customer (Telegram link)');
  });

  it('the advisor can no longer record consent themselves (CU-50); withdrawing still works; the switch brings the old path back', async () => {
    const { c, cus, ask } = await setup();
    const give = { personType: 'CUSTOMER', personId: cus.id, channel: 'EMAIL', action: 'GIVE', howGiven: 'Signed form', declaration: true };
    expect(err(await c.post(`/customers/${cus.id}/consents`, give))).toMatchObject({ status: 409, messageId: 'CU-50' });
    const r = await ask({ channels: ['EMAIL'], via: 'WHATSAPP' });
    await pub.post(tokenOf(r.body.data.link), { agree: true, declaration: true });
    expect(err(await ask({ channels: ['EMAIL'], via: 'EMAIL' }))).toMatchObject({ status: 409, messageId: 'CU-42' });
    const w = await c.post(`/customers/${cus.id}/consents`, { personType: 'CUSTOMER', personId: cus.id, channel: 'EMAIL', action: 'WITHDRAW' });
    expect(w.status).toBe(200);
    // email consent withdrawn: the request cannot be emailed (CU-41), but WhatsApp still can
    expect(err(await ask({ channels: ['EMAIL'], via: 'EMAIL' }))).toMatchObject({ status: 409, messageId: 'CU-41' });
    expect((await ask({ channels: ['EMAIL'], via: 'WHATSAPP' })).status).toBe(201);

    await GlobalFlag.create({ _id: 'consent_customer_confirms', enabled: false, reason: 'paper forms', updatedBy: 'test' });
    await loadFlags();
    expect((await c.post(`/customers/${cus.id}/consents`, { ...give, channel: 'WHATSAPP', howGiven: 'Signed form' })).status).toBe(200);
    expect((await c.get(`/customers/${cus.id}/consents`)).body.data.customerConfirms).toBe(false);
  });

  it('rules: contacts needed; family members cannot give personal-data consent; the link dies on a changed mobile, on cancel and on expiry', async () => {
    const { c, cus, ask, adv } = await setup();
    const m = (await c.post(`/customers/${cus.id}/family`, { name: 'Arjun Iyer', relationship: 'Son' })).body.data;
    const forM = (body: object) => c.post(`/customers/${cus.id}/consent-requests`, { personType: 'FAMILY', personId: m.id, ...body });
    expect(err(await forM({ channels: ['WHATSAPP'], via: 'TELEGRAM' }))).toMatchObject({ status: 409, messageId: 'CU-13' });
    expect(err(await forM({ channels: ['EMAIL'], via: 'TELEGRAM' }))).toMatchObject({ status: 409, messageId: 'CU-14' });
    expect(err(await forM({ channels: ['PERSONAL_DATA'], via: 'TELEGRAM' }))).toMatchObject({ status: 400, messageId: 'VAL-22' });

    // a changed mobile: the WhatsApp consent asked for belonged to the old number
    const r1 = await ask({ channels: ['WHATSAPP'], via: 'WHATSAPP' });
    await c.patch(`/customers/${cus.id}`, { version: 1, mobile: newMobile(), confirm: ['CU-21'] });
    expect((await pub.get(tokenOf(r1.body.data.link))).body.data).toMatchObject({ valid: false, messageId: 'CU-44' });
    expect(err(await pub.post(tokenOf(r1.body.data.link), { agree: true, declaration: true }))).toMatchObject({ status: 409, messageId: 'CU-44' });

    // cancel: the queued email is not sent either
    const r2 = await ask({ channels: ['PERSONAL_DATA'], via: 'EMAIL' });
    const cancel = await c.post(`/customers/${cus.id}/consent-requests/${r2.body.data.request.id}/cancel`);
    expect(cancel.body.meta.messageId).toBe('CU-43');
    expect((await Outbox.findOne({}).lean())!.status).toBe('CANCELLED');
    expect((await pub.get(tokenOf(r2.body.data.link))).body.data.valid).toBe(false);
    expect(err(await c.post(`/customers/${cus.id}/consent-requests/${r2.body.data.request.id}/cancel`))).toMatchObject({ status: 409 });

    // expiry after CFG-197 days
    const r3 = await ask({ channels: ['PERSONAL_DATA'], via: 'TELEGRAM' });
    clock.setOffset(8 * 86_400_000);
    expect((await pub.get(tokenOf(r3.body.data.link))).body.data.valid).toBe(false);
    const fresh = as((await login(adv.mobile)).token); // the earlier session ended with the time jump
    expect((await fresh.get(`/customers/${cus.id}/consents`)).body.data.requests[0].status).toBe('EXPIRED');
  });

  it('a request already answered or cancelled is not emailed; CFG-198 requests per person per day; another account cannot ask', async () => {
    const { cus, ask } = await setup();
    const r = await ask({ channels: ['WHATSAPP'], via: 'EMAIL' });
    await pub.post(tokenOf(r.body.data.link), { agree: true, declaration: true }); // answered from a forwarded link before sending
    await sendDue();
    expect((await Outbox.findOne({}).lean())).toMatchObject({ status: 'SKIPPED', skipReason: 'Consent request closed' });

    await setCfg('CFG-198', 2);
    await ask({ channels: ['EMAIL'], via: 'TELEGRAM' });
    const third = await ask({ channels: ['EMAIL'], via: 'TELEGRAM' });
    expect(err(third)).toMatchObject({ status: 429, messageId: 'CU-51' });
    expect(third.body.error.message).toBe('Up to 2 consent requests can be sent to Meena Iyer in a day. Please try again tomorrow.');

    const other = as((await registerAdvisor('Ravi Shah')).token);
    expect(err(await other.post(`/customers/${cus.id}/consent-requests`, { personType: 'CUSTOMER', personId: cus.id, channels: ['EMAIL'], via: 'TELEGRAM' }))).toMatchObject({ status: 404 });
  });
});