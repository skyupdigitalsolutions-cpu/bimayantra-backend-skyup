import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { date, enumOf, optional, required, rupees, shortText, version } from '../../lib/fields.js';
import { sendData, sendDone } from '../../lib/response.js';
import * as svc from './renewals.service.js';

const id = z.object({ id: z.string().regex(/^rnw_[a-f0-9]{28}$/) });
const vb = z.object({ version: required(version()) }).strict();
const labels = { outcome: 'Outcome', note: 'Note', reason: 'Reason', paymentDate: 'Payment date', receiptNumber: 'Insurer receipt number', amount: 'Amount', nextDueDate: 'New next premium due date' };

/** Renewals (P-38): assistants see the list; the advisor works each renewal to an outcome. */
export function renewalRoutes() {
  const r = Router();
  r.use(authenticate, allow('renewals.view'));
  r.get('/', validate({ query: z.object({ status: z.string().max(20).optional(), from: z.string().max(10).optional(), to: z.string().max(10).optional(), insurerId: z.string().max(40).optional(), typeId: z.string().max(40).optional(), customerId: z.string().regex(/^cus_[a-f0-9]{28}$/).optional() }) }), async (req, res) =>
    sendData(res, await svc.list(req.auth!, req.query as Record<string, string>)));
  r.get('/:id', validate({ params: id }), async (req, res) => sendData(res, await svc.get(req.auth!, String(req.params.id))));
  const m = [allow('renewals.manage'), writable] as const;
  r.post('/:id/contact', ...m, validate({ params: id, body: z.object({ version: required(version()), outcome: required(enumOf(['Spoke to customer', 'Not reachable', 'Asked to call back'] as const)), note: optional(shortText()) }).strict() }, labels), async (req, res) =>
    sendDone(res, await svc.logContact(req.auth!, String(req.params.id), req.body, req), 'REN-01'));
  // Changes #14–#16: choose how to renew (no body = the same policy, as before)
  r.post('/:id/renewal-quotation', ...m, validate({ params: id, body: z.object({
    mode: optional(enumOf(['SAME_POLICY', 'NEW_QUOTATION', 'COMPARISON'] as const)),
    typedRenewalPremium: optional(rupees()), renewalNoticeFileId: optional(z.string().regex(/^fil_[a-f0-9]{28}$/)),
    insurerId: optional(z.string().regex(/^ins_[a-f0-9]{28}$/)), productId: optional(z.string().regex(/^prd_[a-f0-9]{28}$/)), variantId: optional(z.string().regex(/^var_[a-f0-9]{28}$/)),
    people: z.array(z.string().regex(/^[CF]:(cus|fam)_[a-f0-9]{28}$/)).max(20).optional(), sumInsured: optional(rupees()), portabilityRequested: z.boolean().optional(),
  }).strict().optional() }, { typedRenewalPremium: 'Renewal premium', renewalNoticeFileId: 'Renewal notice', portabilityRequested: 'Portability' }), idempotent(), async (req, res) => {
    const out = await svc.renewalQuotation(req.auth!, String(req.params.id), req, req.body ?? {});
    sendDone(res, out.comparison ? { comparison: out.comparison } : out.quotation, 'REN-02', out.params, 201);
  });
  r.post('/:id/premium-paid', ...m, validate({ params: id, body: z.object({ version: required(version()), paymentDate: required(date()), receiptNumber: required(z.string().regex(/^[A-Za-z0-9/-]{4,50}$/, { message: 'VAL-30' })), amount: required(rupees()), nextDueDate: required(date()) }).strict() }, labels), idempotent(), async (req, res) => {
    const out = await svc.premiumPaid(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.renewal, 'REN-03', out.params);
  });
  r.post('/:id/not-renewing', ...m, validate({ params: id, body: z.object({ version: required(version()), reason: required(enumOf(['Customer not interested', 'Moved to another advisor', 'Bought elsewhere', 'Cover no longer needed', 'Other'] as const)), note: optional(shortText()) }).strict() }, labels), async (req, res) => {
    if (req.body.reason === 'Other' && !req.body.note) throw (await import('../../lib/errors.js')).AppError.field('note', 'GEN-01', { 'Field label': 'Note' });
    sendDone(res, await svc.notRenewing(req.auth!, String(req.params.id), req.body, req), 'REN-04');
  });
  r.post('/:id/reopen', ...m, validate({ params: id, body: z.object({ version: required(version()), note: required(shortText()) }).strict() }, labels), async (req, res) =>
    sendDone(res, await svc.reopen(req.auth!, String(req.params.id), req.body, req), 'REN-05'));
  r.post('/:id/pause', ...m, validate({ params: id, body: vb }), async (req, res) => sendDone(res, await svc.pause(req.auth!, String(req.params.id), req.body, true, req), 'REN-06'));
  r.post('/:id/resume', ...m, validate({ params: id, body: vb }), async (req, res) => sendDone(res, await svc.pause(req.auth!, String(req.params.id), req.body, false, req), 'REN-07'));
  return r;
}