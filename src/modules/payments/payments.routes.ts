import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { date, declaration, enumOf, optional, personName, recordId, required, rupees, shortText, version, webAddress } from '../../lib/fields.js';
import { cfgRange } from '../../config/cfg.js';
import { pageQuery } from '../../lib/pagination.js';
import { sendData, sendDone } from '../../lib/response.js';
import * as pay from '../payments/payments.service.js';
import * as prop from '../proposals/proposals.service.js';

const qid = z.object({ id: z.string().regex(/^qt_[a-f0-9]{28}$/) });
const labels = { method: 'Payment method', link: 'Payment link', linkValidUntil: 'Link valid until', portalAmount: 'Amount shown on the insurer portal', mode: 'Mode', amount: 'Amount', paymentDate: 'Payment date', reference: 'Reference number', cheque: 'Cheque', differenceReason: 'Reason for difference', receiptFileId: 'Receipt', declaration: 'Declaration', reason: 'Reason', note: 'Note' };
// FLD-25: CFG-108 length; letters, digits, hyphen and slash (VAL-30)
const reference = () => z.string().transform((v, ctx) => { const s = v.trim(); const { min, max } = cfgRange('CFG-108'); if (s.length < min || s.length > max || !/^[A-Za-z0-9/-]+$/.test(s)) { ctx.addIssue({ code: 'custom', message: 'VAL-30' }); return z.NEVER; } return s; });
const chequeNo = () => z.string().regex(/^\d{6}$/, { message: 'VAL-41' });

/** P-31 / P-32 on a quotation: payment links and recorded payments (the advisor only, AC-P32-5). */
export function quotationPaymentRoutes() {
  const r = Router({ mergeParams: true });
  // Mounted on /quotations beside the quotation routes, so the permission is per route: a router-wide check would
  // refuse assistants on every /quotations request.
  const adv = [authenticate, allow('payments.record')] as const;
  r.get('/:id/payments', ...adv, validate({ params: qid }), async (req, res) => sendData(res, await pay.list(req.auth!, String(req.params.id))));
  const linkBody = z.object({
    method: required(enumOf(['Insurer payment link', 'Paid at insurer branch or by cheque', 'Other insurer channel'] as const)),
    link: optional(webAddress()), linkValidUntil: z.string().datetime().nullable().optional(), portalAmount: required(rupees()), note: optional(shortText()),
  }).strict();
  r.post('/:id/payment-link', ...adv, writable, validate({ params: qid, body: linkBody }, labels), idempotent(), async (req, res) => {
    const out = await pay.addLink(req.auth!, String(req.params.id), req.body, false, req);
    sendDone(res, out.payment, 'PAY-04', out.params, 201);
  });
  r.post('/:id/payment-link/replace', ...adv, writable, validate({ params: qid, body: linkBody }, labels), idempotent(), async (req, res) => {
    const out = await pay.addLink(req.auth!, String(req.params.id), req.body, true, req);
    sendDone(res, out.payment, 'PAY-04', out.params, 201);
  });
  r.post('/:id/payments', ...adv, writable, validate({ params: qid, body: z.object({
    mode: required(z.string().max(60)), amount: required(rupees()), paymentDate: required(date()), reference: optional(reference()),
    cheque: z.object({ number: required(chequeNo()), bank: required(shortText()), date: required(date()) }).strict().nullable().optional(),
    differenceReason: optional(enumOf(['Insurer changed premium after review', 'Customer changed riders on the portal', 'Other'] as const)),
    receiptFileId: optional(recordId('fil')), declaration: required(declaration()),
  }).strict() }, labels), idempotent(), async (req, res) => {
    const out = await pay.record(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.payment, 'PAY-05', {}, 201, out.warnings.length ? { warnings: out.warnings } : {});
  });
  void personName;
  return r;
}

/** Payment actions: failed, link expired, undo. */
export function paymentRoutes() {
  const r = Router();
  r.use(authenticate, allow('payments.record'));
  const id = z.object({ id: z.string().regex(/^pay_[a-f0-9]{28}$/) });
  // B-04: every payment of the account, newest first; ?customerId= gives one customer's payments in a single request.
  r.get('/', validate({ query: z.object({ ...pageQuery, customerId: optional(recordId('cus')), status: z.enum(['AWAITING_PAYMENT', 'PAID', 'FAILED', 'EXPIRED', 'REVERSED', 'CANCELLED']).optional() }) }), async (req, res) => {
    const out = await pay.listAll(req.auth!, res.locals.query);
    sendData(res, out.items, 200, out.meta);
  });
  r.post('/:id/fail', writable, validate({ params: id, body: z.object({ reason: required(shortText()) }).strict() }, labels), async (req, res) => sendDone(res, await pay.change(req.auth!, String(req.params.id), 'FAILED', req.body.reason, req), 'PAY-06'));
  r.post('/:id/expire', writable, validate({ params: id }), async (req, res) => sendDone(res, await pay.change(req.auth!, String(req.params.id), 'EXPIRED', null, req), 'PAY-07'));
  r.post('/:id/undo', writable, validate({ params: id, body: z.object({ reason: required(enumOf(['Recorded by mistake', 'Cheque returned', 'Refunded by insurer'] as const)) }).strict() }, labels), async (req, res) =>
    sendDone(res, await pay.change(req.auth!, String(req.params.id), 'REVERSED', req.body.reason, req), 'PAY-09'));
  return r;
}

/** Proposals (P-55): ADV and AST prepare; only ADV submits. */
export function proposalRoutes() {
  const r = Router();
  r.use(authenticate, allow('proposals.prepare'));
  const id = z.object({ id: z.string().regex(/^prp_[a-f0-9]{28}$/) });
  const ans = z.object({ answer: z.boolean(), condition: optional(shortText()), since: optional(shortText()), treatment: optional(shortText()) }).strict();
  r.get('/', async (req, res) => sendData(res, await prop.list(req.auth!)));
  r.post('/', writable, validate({ body: z.object({ quotationId: required(z.string().regex(/^qt_[a-f0-9]{28}$/)) }).strict() }), idempotent(), async (req, res) => {
    const out = await prop.start(req.auth!, req.body.quotationId, req);
    sendDone(res, out.proposal, 'PRP-01', out.params, 201);
  });
  r.get('/:id', validate({ params: id }), async (req, res) => sendData(res, await prop.get(req.auth!, String(req.params.id))));
  r.put('/:id', writable, validate({ params: id, body: z.object({
    version: required(version()),
    declarations: z.array(z.object({ member: z.string().max(200), answers: z.record(z.string().max(100), ans) }).strict()).max(20),
    nominees: z.array(z.object({ name: required(personName()), relationship: required(shortText()), dob: required(date()), share: z.number().min(0).max(100),
      appointee: z.object({ name: required(personName()), dob: required(date()) }).strict().nullable().optional() }).strict()).max(10),
  }).strict() }, { declarations: 'Declarations', nominees: 'Nominees' }), async (req, res) => sendData(res, await prop.save(req.auth!, String(req.params.id), req.body)));
  r.post('/:id/submit', allow('proposals.submit'), writable, validate({ params: id, body: z.object({ version: required(version()) }).strict() }), idempotent(), async (req, res) => {
    const out = await prop.submit(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.proposal, 'PRP-05', out.params);
  });
  r.post('/:id/cancel', writable, validate({ params: id, body: z.object({ version: required(version()), reason: required(enumOf(['Customer changed mind', 'Wrong quotation selected', 'Started by mistake', 'Other'] as const)), note: optional(shortText()) }).strict() }, { reason: 'Reason', note: 'Note' }), async (req, res) => {
    const out = await prop.cancel(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.proposal, 'PRP-08', out.params);
  });
  r.post('/:id/decline', allow('proposals.submit'), writable, validate({ params: id, body: z.object({ version: required(version()), reason: required(shortText()) }).strict() }, { reason: 'Reason' }), async (req, res) => {
    const out = await prop.decline(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.proposal, 'PRP-07', out.params);
  });
  return r;
}