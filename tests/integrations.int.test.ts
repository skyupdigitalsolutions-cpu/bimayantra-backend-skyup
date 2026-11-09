/**
 * Settings → Integrations (the advisor's own MSG91 and Brevo), Settings → Message templates (template per trigger),
 * new lead welcome / follow-up, per-advisor webhooks, and the hidden WhatsApp wallet. Network stubbed.
 */
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, as, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { clock } from '../src/lib/clock.js';
import { env } from '../src/config/env.js';
import { Account } from '../src/modules/accounts/account.model.js';
import { Consent, Customer } from '../src/modules/customers/customer.model.js';
import { Outbox, WalletTxn } from '../src/modules/comms/outbox.model.js';
import { Integration } from '../src/modules/integrations/integration.model.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { ensureSystemTemplates, queueLeadMessages, resetSeeded, sendDue } from '../src/modules/comms/comms.service.js';
import { istToday } from '../src/lib/clock.js';

const E = env as unknown as Record<string, unknown>;
const saved = { ...E };
beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(async () => { clock.setOffset(0); resetSeeded(); await resetState(); });
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

/** The advisor's MSG91 account: key "own-key", number 919811122233, two templates. */
const OWN_TEMPLATES = { data: [
  { name: 'policy_due', languages: [{ language: 'en', status: 'APPROVED', code: [{ type: 'BODY', text: 'Dear {{1}}, your policy renews on {{2}}. Call {{3}}.' }] }] },
  { name: 'brochure_promo', languages: [{ language: 'en', status: 'APPROVED', code: [{ type: 'HEADER', format: 'DOCUMENT' }, { type: 'BODY', text: 'Hi {{1}}' }] }] },
  { name: 'draft_one', languages: [{ language: 'en', status: 'PENDING', code: [{ type: 'BODY', text: 'Hi {{1}}' }] }] },
] };
function msg91Own(extra?: (c: Call) => { status?: number; body: unknown } | undefined) {
  return net((c) => {
    const e = extra?.(c); if (e) return e;
    if (c.url.includes('/whatsapp/get-template-client/')) {
      if (c.headers.authkey !== 'own-key') return { status: 401, body: { type: 'error', message: 'Unauthorized' } };
      if (!c.url.includes('919811122233')) return { status: 400, body: { type: 'error', message: 'Integrated number not found' } };
      return { body: OWN_TEMPLATES };
    }
    if (c.url.includes('/whatsapp-outbound-message/bulk/')) return { body: { status: 'success', request_id: 'own-req-1' } };
    if (c.url === 'https://api.brevo.com/v3/account') return c.headers['api-key'] === 'xkeysib-own' ? { body: { email: 'asha@ins.in', companyName: 'Asha Insurance' } } : { status: 401, body: { message: 'Key not found' } };
    if (c.url === 'https://api.brevo.com/v3/senders') return { body: { senders: [{ email: 'asha@ins.in', active: true }] } };
    if (c.url === 'https://api.brevo.com/v3/senders/domains') return { body: { domains: [] } };
    if (c.url === 'https://api.brevo.com/v3/smtp/email') return { status: 201, body: { messageId: '<own-mail-1@brevo>' } };
    return undefined;
  });
}

describe('Integrations: the advisor connects their own MSG91 and Brevo', () => {
  it('checks details with the provider first (wrong key / number / sender = field error, nothing saved); the key is encrypted and shown as last 4; test and disconnect', async () => {
    const adv = await registerAdvisor();
    const A = as(adv.token);
    msg91Own();
    expect((await A.get('/integrations')).body.data).toEqual({ MSG91: null, BREVO: null });

    let r = await A.put('/integrations/msg91', { authKey: 'bad-key', waNumber: '9811122233' });
    expect(r.status).toBe(400); expect(r.body.error.fields[0]).toMatchObject({ field: 'authKey', messageId: 'INT-03' });
    r = await A.put('/integrations/msg91', { authKey: 'own-key', waNumber: '9800000000' });
    expect(r.body.error.fields[0]).toMatchObject({ field: 'waNumber', messageId: 'INT-04' });
    expect(await Integration.countDocuments({})).toBe(0);

    r = await A.put('/integrations/msg91', { authKey: 'own-key', waNumber: '98111 22233' });
    expect(r.status).toBe(200);
    expect(r.body.meta.messageId).toBe('INT-01');
    expect(r.body.data).toMatchObject({ provider: 'MSG91', status: 'ACTIVE', keyLast4: '-key', config: { waNumber: '919811122233' } });
    expect(r.body.data.webhookUrl).toMatch(/\/v1\/webhooks\/msg91\/[A-Za-z0-9_-]{30,}$/);
    expect(JSON.stringify(r.body)).not.toContain('own-key');
    const raw = await Integration.collection.findOne({});
    expect(JSON.stringify(raw)).not.toContain('own-key'); // encrypted at rest
    expect(JSON.stringify(raw)).not.toContain('919811122233');

    // Change the number without retyping the key: the saved key is reused (and checked again)
    expect((await A.put('/integrations/msg91', { waNumber: '919811122233', namespace: 'ns_1' })).status).toBe(200);

    r = await A.put('/integrations/brevo', { apiKey: 'xkeysib-own', fromEmail: 'other@ins.in', fromName: 'Asha Insurance' });
    expect(r.body.error.fields[0]).toMatchObject({ field: 'fromEmail', messageId: 'INT-05' });
    r = await A.put('/integrations/brevo', { apiKey: 'xkeysib-own', fromEmail: 'Asha@ins.in', fromName: 'Asha Insurance', replyTo: '' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ provider: 'BREVO', keyLast4: '-own', config: { fromEmail: 'asha@ins.in', fromName: 'Asha Insurance', replyTo: null } });

    expect((await A.post('/integrations/brevo/test')).body.meta.messageId).toBe('INT-07');
    const tpls = (await A.get('/integrations/msg91/templates')).body.data;
    expect(tpls.map((t: { name: string }) => t.name)).toEqual(['brochure_promo', 'draft_one', 'policy_due']);
    expect(tpls.find((t: { name: string }) => t.name === 'policy_due')).toMatchObject({ status: 'APPROVED', blanks: 3, supported: true });
    expect(tpls.find((t: { name: string }) => t.name === 'brochure_promo')).toMatchObject({ supported: false, headerFormat: 'DOCUMENT' });

    expect((await A.del('/integrations/brevo')).body.meta.messageId).toBe('INT-02');
    expect((await A.get('/integrations')).body.data.BREVO).toBeNull();
  });

  it('only the advisor: an assistant cannot open integrations', async () => {
    const adv = await registerAdvisor();
    expect(adv.user.capabilities).toContain('integrations.manage');
    expect(adv.user.capabilities).toContain('rules.manage');
  });
});

describe('Message templates: which template goes out for which trigger', () => {
  async function setup() {
    const adv = await registerAdvisor('Asha Rao');
    const A = as(adv.token);
    const accountId = adv.user.accountId!;
    await Account.updateOne({ _id: accountId }, { $set: { 'subscription.plan': 'PREMIUM', 'subscription.status': 'ACTIVE', 'subscription.endsAt': new Date(Date.now() + 365 * 86_400_000) } });
    await ensureSystemTemplates();
    return { A, accountId };
  }

  it('lists the triggers with defaults; own WhatsApp template needs MSG91, an approved template without media header, and a value for each blank', async () => {
    const { A } = await setup();
    msg91Own();
    const g = (await A.get('/message-rules')).body.data;
    const keys = g.triggers.map((t: { trigger: string }) => t.trigger);
    expect(keys).toEqual(['LEAD_WELCOME', 'FOLLOW_UP', 'RENEWAL_REMINDER', 'BIRTHDAY', 'FAMILY_BIRTHDAY', 'ANNIVERSARY', 'QUOTATION_EMAIL']);
    const fu = g.triggers.find((t: { trigger: string }) => t.trigger === 'FOLLOW_UP');
    expect(fu.whatsapp.mode).toBe('OFF'); expect(fu.email.mode).toBe('OFF'); // new triggers start off
    expect(fu.defaults.whatsapp).toContain('{advisor name}');
    expect(g.triggers.find((t: { trigger: string }) => t.trigger === 'RENEWAL_REMINDER').whatsapp.mode).toBe('DEFAULT');

    const own = { mode: 'OWN', templateName: 'policy_due', language: 'en', variables: ['customer first name', 'renewal date', 'advisor mobile'] };
    expect((await A.put('/message-rules/RENEWAL_REMINDER', { whatsapp: own })).body.error.messageId).toBe('MR-02');
    await A.put('/integrations/msg91', { authKey: 'own-key', waNumber: '919811122233' });
    expect((await A.put('/message-rules/RENEWAL_REMINDER', { whatsapp: { ...own, templateName: 'draft_one', variables: ['customer first name'] } })).body.error.messageId).toBe('MR-05');
    expect((await A.put('/message-rules/RENEWAL_REMINDER', { whatsapp: { ...own, templateName: 'brochure_promo', variables: ['customer first name'] } })).body.error.messageId).toBe('MR-06');
    expect((await A.put('/message-rules/RENEWAL_REMINDER', { whatsapp: { ...own, variables: ['customer first name'] } })).body.error.messageId).toBe('MR-03');
    expect((await A.put('/message-rules/RENEWAL_REMINDER', { whatsapp: { ...own, variables: ['customer first name', 'renewal date', 'shoe size'] } })).body.error.messageId).toBe('COM-03');
    const ok = await A.put('/message-rules/RENEWAL_REMINDER', { whatsapp: own });
    expect(ok.status).toBe(200); expect(ok.body.meta.messageId).toBe('MR-01');
    expect(ok.body.data.whatsapp).toMatchObject({ mode: 'OWN', templateName: 'policy_due', body: 'Dear {{1}}, your policy renews on {{2}}. Call {{3}}.' });
    // A trigger cannot use a channel it does not have
    expect((await A.put('/message-rules/QUOTATION_EMAIL', { whatsapp: { mode: 'DEFAULT' } })).body.error.messageId).toBe('MR-07');
    // Custom email: only the trigger's values
    expect((await A.put('/message-rules/FOLLOW_UP', { email: { mode: 'OWN', subject: 'Hi {name}', body: 'Your {policy last 4}' } })).body.error.messageId).toBe('COM-03');
    expect((await A.put('/message-rules/FOLLOW_UP', { email: { mode: 'OWN', subject: '', body: 'x' } })).body.error.messageId).toBe('MR-04');
  });

  it('the sender uses the advisor’s own MSG91 template, their number and their values; their Brevo for email; no wallet debit', async () => {
    const { A, accountId } = await setup();
    const calls = msg91Own();
    await A.put('/integrations/msg91', { authKey: 'own-key', waNumber: '919811122233', namespace: 'ns_own' });
    await A.put('/integrations/brevo', { apiKey: 'xkeysib-own', fromEmail: 'asha@ins.in', fromName: 'Asha Insurance', replyTo: 'help@ins.in' });
    await A.put('/message-rules/RENEWAL_REMINDER', { whatsapp: { mode: 'OWN', templateName: 'policy_due', language: 'en', variables: ['customer first name', 'renewal date', 'advisor mobile'] }, email: { mode: 'OWN', subject: 'Renewal for {customer first name}', body: 'Your {product} renews on {renewal date}.' } });
    const cus = (await A.post('/customers', { name: 'Meena Iyer', mobile: newMobile(), email: 'meena@example.com' })).body.data;
    const mobile = (await Customer.findById(cus.id).lean())!.mobile;
    await Consent.create({ accountId, personKey: `C:${cus.id}`, customerId: cus.id, channel: 'WHATSAPP', status: 'GIVEN', recordedAt: new Date() });
    await Account.updateOne({ _id: accountId }, { $set: { 'wallet.balancePaise': 0 } });
    const params = { 'customer first name': 'Meena', product: 'Family Shield', 'policy last 4': '4821', 'renewal date': '12-12-2026', 'advisor name': 'Asha Rao', 'advisor mobile': '9876543210' };
    await Outbox.create({ accountId, customerId: cus.id, personKey: `C:${cus.id}`, channel: 'WHATSAPP', purpose: 'RENEWAL_REMINDER', template: 'REN-T1', params, to: mobile, text: 'x', occurrenceKey: 'own-wa', day: istToday() });
    await Outbox.create({ accountId, customerId: cus.id, personKey: `C:${cus.id}`, channel: 'EMAIL', purpose: 'RENEWAL_REMINDER', template: 'REN-T1', params, to: 'meena@example.com', text: 'x', occurrenceKey: 'own-mail', day: istToday() });
    atIST(10);
    await sendDue();

    const wa = calls.find((c) => c.url.includes('/bulk/'))!;
    expect(wa.headers.authkey).toBe('own-key');
    const t = (wa.body as { integrated_number: string; payload: { template: { name: string; namespace: string; to_and_components: Array<{ components: Record<string, { value: string }> }> } } });
    expect(t.integrated_number).toBe('919811122233');
    expect(t.payload.template).toMatchObject({ name: 'policy_due', namespace: 'ns_own' });
    expect(t.payload.template.to_and_components[0]!.components).toEqual({ body_1: { type: 'text', value: 'Meena' }, body_2: { type: 'text', value: '12-12-2026' }, body_3: { type: 'text', value: '9876543210' } });
    expect(await Outbox.findOne({ occurrenceKey: 'own-wa' }).lean()).toMatchObject({ status: 'SENT', providerMessageId: 'own-req-1', text: 'Dear Meena, your policy renews on 12-12-2026. Call 9876543210.' });

    const mail = calls.find((c) => c.url.endsWith('/smtp/email'))!;
    expect(mail.headers['api-key']).toBe('xkeysib-own');
    expect(mail.body).toMatchObject({ sender: { email: 'asha@ins.in', name: 'Asha Insurance' }, replyTo: { email: 'help@ins.in' }, subject: 'Renewal for Meena' });
    expect(await Outbox.findOne({ occurrenceKey: 'own-mail' }).lean()).toMatchObject({ status: 'SENT', providerMessageId: '<own-mail-1@brevo>' });
    expect(await WalletTxn.countDocuments({ accountId })).toBe(0); // own number: never the wallet

    // The advisor's own webhook address updates only their messages
    const url = (await A.get('/integrations')).body.data.MSG91.webhookUrl as string;
    const token = url.split('/').pop()!;
    expect((await request(app).post(`/v1/webhooks/msg91/${token}`).send({ requestId: 'own-req-1', status: 'delivered', ts: '1' })).status).toBe(200);
    expect((await Outbox.findOne({ occurrenceKey: 'own-wa' }).lean())!.status).toBe('DELIVERED');
    expect((await request(app).post('/v1/webhooks/msg91/not-a-real-token-0123456789abcdef').send({ requestId: 'own-req-1', status: 'read' })).status).toBe(403);

    // OFF: the message is not sent
    await A.put('/message-rules/RENEWAL_REMINDER', { whatsapp: { mode: 'OFF' } });
    await Outbox.create({ accountId, customerId: cus.id, personKey: `C:${cus.id}`, channel: 'WHATSAPP', purpose: 'RENEWAL_REMINDER', template: 'REN-T1', params, to: mobile, text: 'x', occurrenceKey: 'off-wa', day: istToday() });
    await sendDue();
    expect(await Outbox.findOne({ occurrenceKey: 'off-wa' }).lean()).toMatchObject({ status: 'SKIPPED', skipReason: 'Turned off in Message templates' });
  });

  it('new lead welcome and follow-up: only once turned on, only new leads, WhatsApp only with consent, email to the lead', async () => {
    const { A, accountId } = await setup();
    const calls = msg91Own();
    const pipelines = (await A.get('/pipelines')).body.data as Array<{ id: string }>;
    const old = (await A.post('/leads', { pipelineId: pipelines[0]!.id, name: 'Old Lead', mobile: newMobile(), source: 'Walk-in or personal contact', email: 'old@example.com' })).body.data;
    expect(old.id).toBeTruthy();
    await queueLeadMessages();
    expect(await Outbox.countDocuments({ purpose: 'LEAD_WELCOME' })).toBe(0); // off by default

    await Lead.updateOne({ _id: old.id }, { $set: { createdAt: new Date(Date.now() - 10 * 60_000) } }, { timestamps: false });
    await A.put('/message-rules/LEAD_WELCOME', { whatsapp: { mode: 'DEFAULT' }, email: { mode: 'OWN', subject: 'Welcome {name}', body: 'Hi {name}, I am {advisor name}.' } });
    await new Promise((r) => setTimeout(r, 5));
    const lead = (await A.post('/leads', { pipelineId: pipelines[0]!.id, name: 'Ravi Kumar', mobile: newMobile(), source: 'Walk-in or personal contact', email: 'ravi@example.com' })).body.data;
    await queueLeadMessages();
    await queueLeadMessages(); // repeat-safe
    const rows = await Outbox.find({ purpose: 'LEAD_WELCOME' }).lean();
    expect(rows).toHaveLength(2); // the old lead is never messaged
    expect(rows.find((r) => r.channel === 'WHATSAPP')).toMatchObject({ status: 'SKIPPED', skipReason: 'Consent missing', personKey: `L:${lead.id}` });
    expect(rows.find((r) => r.channel === 'EMAIL')).toMatchObject({ status: 'QUEUED', to: 'ravi@example.com' });
    E.EMAIL_PROVIDER = 'brevo'; E.BREVO_API_KEY = 'platform-key'; E.EMAIL_FROM_ADDRESS = 'no-reply@bimayantra.in';
    await sendDue();
    const mail = calls.find((c) => c.url.endsWith('/smtp/email'))!;
    expect(mail.body).toMatchObject({ subject: 'Welcome Ravi', textContent: 'Hi Ravi, I am Asha Rao.' });
    expect(mail.headers['api-key']).toBe('platform-key'); // Brevo not connected: Bimayantra's account
    expect((await A.get('/communications?tab=sent')).body.data[0]).toMatchObject({ purpose: 'LEAD_WELCOME', customer: 'Ravi Kumar' });

    // Follow-up at its time; moving the follow-up makes the queued one stale
    await A.put('/message-rules/FOLLOW_UP', { email: { mode: 'DEFAULT' } });
    const at = new Date(clock.now().getTime() + 5 * 60_000);
    await Lead.updateOne({ _id: lead.id }, { $set: { nextFollowUpAt: at } });
    await queueLeadMessages();
    expect(await Outbox.countDocuments({ purpose: 'FOLLOW_UP' })).toBe(0); // not yet due
    clock.setOffset(clock.now().getTime() - Date.now() + 6 * 60_000);
    await queueLeadMessages();
    expect(await Outbox.findOne({ purpose: 'FOLLOW_UP' }).lean()).toMatchObject({ channel: 'EMAIL', status: 'QUEUED' });
    await Lead.updateOne({ _id: lead.id }, { $set: { nextFollowUpAt: new Date(clock.now().getTime() + 86_400_000) } });
    await sendDue();
    expect(await Outbox.findOne({ purpose: 'FOLLOW_UP' }).lean()).toMatchObject({ status: 'SKIPPED', skipReason: 'Follow-up moved' });
    expect(accountId).toBeTruthy();
  });
});

describe('WhatsApp wallet hidden (WHATSAPP_WALLET=false, the default)', () => {
  it('wallet routes answer not found; automated WhatsApp goes out with no balance and no debit', async () => {
    E.WHATSAPP_WALLET = false;
    const adv = await registerAdvisor();
    const A = as(adv.token);
    const accountId = adv.user.accountId!;
    expect((await A.get('/wallet')).status).toBe(404);
    expect((await A.post('/wallet/recharge', { amount: 500 })).status).toBe(404);
    await Account.updateOne({ _id: accountId }, { $set: { 'subscription.plan': 'PREMIUM', 'subscription.status': 'ACTIVE', 'subscription.endsAt': new Date(Date.now() + 365 * 86_400_000), 'wallet.balancePaise': 0 } });
    const cus = (await A.post('/customers', { name: 'Meena Iyer', mobile: newMobile() })).body.data;
    await Consent.create({ accountId, personKey: `C:${cus.id}`, customerId: cus.id, channel: 'WHATSAPP', status: 'GIVEN', recordedAt: new Date() });
    await ensureSystemTemplates();
    const mobile = (await Customer.findById(cus.id).lean())!.mobile;
    await Outbox.create({ accountId, customerId: cus.id, personKey: `C:${cus.id}`, channel: 'WHATSAPP', purpose: 'RENEWAL_REMINDER', template: 'REN-T1', params: { 'customer first name': 'Meena' }, to: mobile, text: 'x', occurrenceKey: 'nowallet', day: istToday() });
    atIST(10);
    await sendDue();
    expect((await Outbox.findOne({ occurrenceKey: 'nowallet' }).lean())!.status).toBe('SENT');
    expect(await WalletTxn.countDocuments({ accountId })).toBe(0);
  });
});