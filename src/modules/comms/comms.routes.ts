import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { enumOf, optional, required, shortText } from '../../lib/fields.js';
import { sendData, sendDone } from '../../lib/response.js';
import { requireStepUp } from '../auth/stepUp.js';
import { PURPOSES } from './outbox.model.js';
import * as svc from './comms.service.js';
import { razorpayWebhook } from './razorpay.webhook.js';

const msgId = z.object({ id: z.string().regex(/^msg_[a-f0-9]{28}$/) });

/** Communications (P-43), occasion greetings (P-40) and the WhatsApp wallet (P-56). */
export function commsRoutes() {
  const r = Router();
  r.use(authenticate, allow('comms.view'));
  r.get('/', validate({ query: z.object({ tab: z.enum(['scheduled', 'sent', 'failed']).optional(), channel: z.string().max(10).optional(), purpose: z.string().max(30).optional(), status: z.string().max(20).optional(), from: z.string().max(10).optional(), to: z.string().max(10).optional() }) }), async (req, res) =>
    sendData(res, await svc.list(req.auth!, req.query as Record<string, string>)));
  r.post('/:id/cancel', allow('comms.manage'), writable, validate({ params: msgId }), async (req, res) => sendDone(res, await svc.cancel(req.auth!, String(req.params.id), req), 'COM-10'));
  r.post('/:id/resend', allow('comms.manage'), writable, validate({ params: msgId }), idempotent(), async (req, res) => sendDone(res, await svc.resend(req.auth!, String(req.params.id), req), 'COM-11'));
  return r;
}
export function greetingRoutes() {
  const r = Router();
  r.use(authenticate, allow('greetings.manage'));
  r.get('/', async (req, res) => sendData(res, await svc.greetings(req.auth!)));
  r.put('/', writable, validate({ body: z.object({ on: z.boolean(), templates: z.record(z.enum(['BIRTHDAY', 'FAMILY_BIRTHDAY', 'ANNIVERSARY']), z.string().regex(/^tpl_[a-f0-9]{28}$/)), excluded: z.array(z.string().regex(/^[CF]:(cus|fam)_[a-f0-9]{28}$/)).max(5000) }).strict() }), async (req, res) => {
    const out = await svc.saveGreetings(req.auth!, req.body, req);
    sendDone(res, out, out.messageId);
  });
  return r;
}
export function walletRoutes() {
  const r = Router();
  r.use(authenticate, allow('wallet.manage'));
  r.get('/', async (req, res) => sendData(res, await svc.wallet(req.auth!)));
  r.post('/recharge', writable, validate({ body: z.object({ amount: z.number().positive().max(1_000_000) }).strict() }, { amount: 'Amount' }), idempotent(), async (req, res) => sendData(res, await svc.recharge(req.auth!, req.body.amount, req), 201));
  // Razorpay Checkout returned: verify and credit (the webhook does the same if the browser closes first)
  r.post('/recharge/:id/verify', validate({ params: z.object({ id: z.string().regex(/^wtx_[a-f0-9]{28}$/) }), body: z.object({ razorpayOrderId: z.string().regex(/^order_[A-Za-z0-9]{6,40}$/), razorpayPaymentId: z.string().regex(/^pay_[A-Za-z0-9]{6,40}$/), razorpaySignature: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }), async (req, res) =>
    sendData(res, await svc.verifyRecharge(req.auth!, String(req.params.id), req.body)));
  return r;
}
/** SkyUp: message templates (P-39) and wallet credits (P-56). */
export function adminCommsRoutes() {
  const r = Router();
  r.use(authenticate, allow('templates.make'));
  const tid = z.object({ id: z.string().regex(/^tpl_[a-f0-9]{28}$/) });
  r.get('/templates', async (_req, res) => sendData(res, await svc.listTemplates()));
  r.post('/templates', writable, validate({ body: z.object({ name: required(shortText()), channel: required(enumOf(['EMAIL', 'WHATSAPP'] as const)), purpose: required(enumOf(PURPOSES)), language: optional(shortText()), subject: optional(shortText()), body: required(z.string().min(1).max(5000)) }).strict() }, { name: 'Name', channel: 'Channel', purpose: 'Purpose', body: 'Message' }), async (req, res) =>
    sendData(res, await svc.createTemplate(req.auth!, req.body, req), 201));
  r.post('/templates/:id/submit', writable, requireStepUp, validate({ params: tid }), async (req, res) => {
    const out = await svc.submitTemplate(req.auth!, String(req.params.id), req); // publish (email) or send to Meta (WhatsApp)
    sendDone(res, out.template, out.messageId, (out as { params?: Record<string, string> }).params ?? {});
  });
  r.post('/templates/:id/approve', allow('templates.approve'), requireStepUp, validate({ params: tid }), async (req, res) => {
    const out = await svc.approveTemplate(req.auth!, String(req.params.id), req);
    sendDone(res, out.template, out.messageId);
  });
  r.post('/templates/:id/deactivate', allow('templates.approve'), validate({ params: tid }), async (req, res) => sendDone(res, await svc.deactivateTemplate(req.auth!, String(req.params.id), req), 'GEN-07'));
  r.post('/wallet/:accountId/credit', allow('wallet.credit'), requireStepUp, validate({ params: z.object({ accountId: z.string().regex(/^acc_[a-f0-9]{28}$/) }), body: z.object({ amount: z.number().positive().max(100_000), reason: required(shortText()) }).strict() }, { amount: 'Amount', reason: 'Reason' }), async (req, res) =>
    sendData(res, await svc.manualCredit(req.auth!, String(req.params.accountId), req.body.amount, req.body.reason, req)));
  return r;
}
/** Provider webhooks: signed (X-Bimayantra-Signature, HMAC-SHA256 of the raw body); a forged one changes nothing. */
export function webhookRoutes() {
  const r = Router();
  r.post('/messages', async (req, res) => sendData(res, await svc.messageWebhook(req)));
  r.post('/payments', async (req, res) => sendData(res, await svc.paymentWebhook(req)));
  // Real providers: Brevo delivery events (secret path) and Razorpay payments (X-Razorpay-Signature)
  r.post('/brevo/:token', async (req, res) => sendData(res, await svc.brevoWebhook(req, String(req.params.token))));
  r.post('/msg91/:token', async (req, res) => sendData(res, await svc.msg91Webhook(req, String(req.params.token))));
  r.post('/razorpay', async (req, res) => sendData(res, await razorpayWebhook(req)));
  return r;
}