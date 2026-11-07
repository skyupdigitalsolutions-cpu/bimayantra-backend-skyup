/**
 * MSG91 with the network stubbed: OTP SMS through the OTP API (our own code), and WhatsApp template messages
 * (template registration at MSG91, waiting for Meta's approval, sending with body_1…n, delivery webhook, STOP).
 */
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, as, key, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { clock, istToday } from '../src/lib/clock.js';
import { env } from '../src/config/env.js';
import { Account } from '../src/modules/accounts/account.model.js';
import { Consent, Customer } from '../src/modules/customers/customer.model.js';
import { MessageTemplate, Outbox } from '../src/modules/comms/outbox.model.js';
import { ensureSystemTemplates, resetSeeded, sendDue, syncWhatsAppTemplates } from '../src/modules/comms/comms.service.js';
import { templateNameFor, toMetaBody, variablesOf } from '../src/lib/msg91.js';

const E = env as unknown as Record<string, unknown>;
const saved = { ...E };
beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => {
  clock.setOffset(0); resetSeeded(); await resetState();
  Object.assign(E, { SMS_PROVIDER: 'msg91', WHATSAPP_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'msg91-key', MSG91_OTP_TEMPLATE_ID: 'otp-tpl-1', MSG91_WA_NUMBER: '919900011122', MSG91_WEBHOOK_TOKEN: 'msg91-hook-token-0123456789abcdef' });
});
afterEach(() => { vi.unstubAllGlobals(); Object.assign(E, saved); });

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };
function net(handler: (c: Call) => { status?: number; body: unknown } | undefined) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const c = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(c);
    const out = handler(c) ?? { status: 404, body: { type: 'error', message: 'no route' } };
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}
const atIST = (h: number) => { const ist = new Date(Date.now() + 5.5 * 3_600_000); const target = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), h, 0) - 5.5 * 3_600_000; clock.setOffset(target - Date.now()); };

describe('MSG91 SMS', () => {
  it('the OTP goes through the OTP API with our own code and validity; that code signs the person in', async () => {
    const calls = net((c) => (c.url.includes('/api/v5/otp?') ? { body: { type: 'success', request_id: 'req-otp-1' } } : undefined));
    const mobile = newMobile();
    const send = await request(app).post('/v1/auth/register/otp').send({ name: 'Ravi Kumar', mobile, termsAccepted: true });
    expect(send.status).toBe(200);
    const u = new URL(calls[0]!.url);
    expect(calls[0]!.headers).toMatchObject({ authkey: 'msg91-key' });
    expect(u.searchParams.get('template_id')).toBe('otp-tpl-1');
    expect(u.searchParams.get('mobile')).toBe(`91${mobile}`);
    const code = u.searchParams.get('otp')!;
    expect(code).toMatch(/^\d{4,8}$/);
    const r = await request(app).post('/v1/auth/register/verify').set('X-Client', 'app').set('Idempotency-Key', key()).send({ mobile, code });
    expect(r.status).toBe(201);
  });

  it('an MSG91 error is AUTH-13 (no code was sent), not a crash', async () => {
    net(() => ({ body: { type: 'error', message: 'Invalid template' } }));
    const r = await request(app).post('/v1/auth/register/otp').send({ name: 'Ravi Kumar', mobile: newMobile(), termsAccepted: true });
    expect(r.status).toBe(503);
    expect(r.body.error.messageId).toBe('AUTH-13');
  });
});

describe('MSG91 WhatsApp', () => {
  it('helpers: variables in order of first appearance become {{1}}, {{2}}; names are Meta-safe', () => {
    expect(variablesOf('Hi {name}, your {product} renews. – {advisor name}, {name}')).toEqual(['name', 'product', 'advisor name']);
    expect(toMetaBody('Hi {name}, your {product}. {name}')).toBe('Hi {{1}}, your {{2}}. {{1}}');
    expect(templateNameFor({ _id: 'tpl_01a1aaa410a5ee022b92cd1c8d73', code: 'REN-T1', name: 'Renewal', version: 2 })).toBe('bmy_ren_t1_1c8d73_v2');
  });

  it('templates in use are registered at MSG91; messages wait for Meta; once approved they go out with body_1…n from the advisor’s number; delivery and STOP come back by webhook', async () => {
    E.SMS_PROVIDER = 'dev'; // sign-up OTP from the test inbox; this test is about WhatsApp
    const adv = await registerAdvisor('Asha Rao');
    const A = as(adv.token);
    const cus = (await A.post('/customers', { name: 'Meena Iyer', mobile: newMobile(), dob: '15-04-1986' })).body.data;
    const accountId = (await Customer.findById(cus.id).lean())!.accountId;
    await Account.updateOne({ _id: accountId }, { $set: { 'subscription.plan': 'PREMIUM', 'subscription.status': 'ACTIVE', 'subscription.endsAt': new Date(Date.now() + 365 * 86_400_000), 'wallet.balancePaise': 100000, 'subscription.waNumber': { status: 'ACTIVE', number: '918800011122' } } });
    await Consent.create({ accountId, personKey: `C:${cus.id}`, customerId: cus.id, channel: 'WHATSAPP', status: 'GIVEN', recordedAt: new Date() });
    await ensureSystemTemplates();
    const tpl = (await MessageTemplate.findOne({ channel: 'WHATSAPP', purpose: 'RENEWAL_REMINDER', status: 'ACTIVE' }).lean())!;

    let approved = false;
    const calls = net((c) => {
      if (c.url.includes('/whatsapp/client-panel-template/')) return { body: { status: 'success' } };
      if (c.url.includes('/whatsapp/get-template-client/')) { const n = new URL(c.url).searchParams.get('template_name'); return { body: { data: [{ name: n, languages: [{ language: 'en', status: approved ? 'APPROVED' : 'PENDING' }] }] } }; }
      if (c.url.includes('/whatsapp-outbound-message/bulk/')) return { body: { status: 'success', hasError: false, request_id: 'wa-req-1' } };
      return undefined;
    });
    atIST(10);
    await syncWhatsAppTemplates();
    const reg = calls.find((c) => c.url.includes('client-panel-template') && (c.body as { template_name: string }).template_name === templateNameFor(tpl))!;
    expect(reg.body).toMatchObject({ integrated_number: '919900011122', language: 'en', category: 'UTILITY', components: [{ type: 'BODY', text: toMetaBody(tpl.body) }] });

    const mobile = (await Customer.findById(cus.id).lean())!.mobile;
    const params = Object.fromEntries(variablesOf(tpl.body).map((v) => [v, `<${v}>`]));
    await Outbox.create({ accountId, customerId: cus.id, personKey: `C:${cus.id}`, channel: 'WHATSAPP', purpose: 'RENEWAL_REMINDER', template: tpl.code, params, to: mobile, text: 'x', occurrenceKey: 'wa1', day: istToday() });
    await sendDue();
    expect((await Outbox.findOne({ occurrenceKey: 'wa1' }).lean())!.status).toBe('QUEUED'); // Meta has not approved yet

    approved = true;
    clock.setOffset((clock.now().getTime() - Date.now()) + 11 * 60_000);
    await syncWhatsAppTemplates();
    expect((await MessageTemplate.findById(tpl._id).lean())!.providerStatus).toBe('APPROVED');
    await sendDue();
    const send = calls.find((c) => c.url.includes('/bulk/'))!;
    const t = (send.body as { payload: { template: { name: string; to_and_components: Array<{ to: string[]; components: Record<string, { value: string }> }> } } }).payload.template;
    expect(send.body).toMatchObject({ integrated_number: '918800011122', content_type: 'template' }); // the advisor's dedicated number
    expect(t.name).toBe(templateNameFor(tpl));
    expect(t.to_and_components[0]!.to).toEqual([mobile.replace('+', '')]);
    expect(t.to_and_components[0]!.components.body_1!.value).toBe(`<${variablesOf(tpl.body)[0]}>`);
    expect(await Outbox.findOne({ occurrenceKey: 'wa1' }).lean()).toMatchObject({ status: 'SENT', providerMessageId: 'wa-req-1' });

    const hook = (b: object, token = env.MSG91_WEBHOOK_TOKEN!) => request(app).post(`/v1/webhooks/msg91/${token}`).send(b);
    expect((await hook({ requestId: 'wa-req-1', status: 'delivered' }, 'wrong-token-0123456789abcdef-x')).status).toBe(403);
    await hook({ requestId: 'wa-req-1', status: 'delivered', ts: '1' });
    expect((await Outbox.findOne({ occurrenceKey: 'wa1' }).lean())!.status).toBe('DELIVERED');
    await hook({ requestId: 'wa-req-1', status: 'read', ts: '2' });
    expect((await Outbox.findOne({ occurrenceKey: 'wa1' }).lean())!.status).toBe('READ');
    await hook({ direction: 'inbound', customerNumber: mobile.replace('+', ''), text: 'STOP', ts: '3' });
    expect((await Consent.findOne({ personKey: `C:${cus.id}`, channel: 'WHATSAPP' }).lean())!.status).toBe('WITHDRAWN');
  });
});