import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { date, enumOf, mobile, optional, personName, recordId, required, rupees, shortText, version } from '../../lib/fields.js';
import { sendData, sendDone } from '../../lib/response.js';
import * as svc from './policies.service.js';

const id = z.object({ id: z.string().regex(/^pol_[a-f0-9]{28}$/) });
const FREQ = ['Single', 'Yearly', 'Half-yearly', 'Quarterly', 'Monthly'] as const;
const labels = { policyNumber: 'Policy number', issueDate: 'Issue date', startDate: 'Policy start date', endDate: 'Policy end date', frequency: 'Premium payment frequency', nextDueDate: 'Next premium due date', sumInsured: 'Sum insured', sumInsuredReason: 'Reason', premium: 'Premium', documentFileId: 'Policy document', notes: 'Notes', expectedCommission: 'Expected commission', reason: 'Reason', date: 'Cancellation date', refund: 'Refund amount', note: 'Note', endorsementRef: 'Insurer endorsement reference', effectiveDate: 'Effective date', nominees: 'Nominees', customerId: 'Customer', insurerId: 'Insurer', productId: 'Product', productName: 'Product name', typeId: 'Insurance type', soldByMe: 'Sold by me', insured: 'Insured persons' };
const fields = {
  policyNumber: required(z.string().max(60)), issueDate: required(date()), startDate: required(date()), endDate: required(date()), frequency: required(enumOf(FREQ)),
  nextDueDate: optional(date()), sumInsured: required(rupees()), sumInsuredReason: optional(shortText()), premium: required(rupees()),
  documentFileId: optional(recordId('fil')), notes: optional(z.string().max(2000)), expectedCommission: z.number().min(0).nullable().optional(),
};
const nominee = z.object({
  personKey: z.string().regex(/^[CF]:(cus|fam)_[a-f0-9]{28}$/).nullable().optional(), name: required(personName()), relationship: required(shortText()), dob: required(date()),
  share: z.number().min(0).max(100), appointee: z.object({ name: required(personName()), relationship: required(shortText()), dob: required(date()) }).strict().nullable().optional(), mobile: optional(mobile()),
}).strict();

/** Policies (P-33 to P-36): assistants view; the advisor records and changes. */
export function policyRoutes() {
  const r = Router();
  r.use(authenticate, allow('policies.view'));
  r.get('/', validate({ query: z.object({ status: z.string().max(30).optional(), customerId: z.string().max(40).optional() }) }), async (req, res) =>
    sendData(res, await svc.list(req.auth!, { status: req.query.status ? String(req.query.status) : undefined, customerId: req.query.customerId ? String(req.query.customerId) : undefined })));
  r.post('/existing', allow('policies.manage'), writable, validate({ body: z.object({
    ...fields, customerId: required(z.string().regex(/^cus_[a-f0-9]{28}$/)), insurerId: required(z.string().regex(/^ins_[a-f0-9]{28}$/)), productId: z.string().regex(/^prd_[a-f0-9]{28}$/).nullable().optional(),
    productName: optional(shortText()), typeId: required(z.string().regex(/^typ_[a-f0-9]{28}$/)), soldByMe: z.boolean(), insured: z.array(z.string().regex(/^[CF]:(cus|fam)_[a-f0-9]{28}$/)).max(20), confirmExpired: z.boolean().optional(),
  }).strict() }, labels), idempotent(), async (req, res) => {
    const out = await svc.existing(req.auth!, req.body, req);
    sendDone(res, out.policy, 'POL-09', out.params, 201);
  });
  r.get('/:id', validate({ params: id }), async (req, res) => sendData(res, await svc.get(req.auth!, String(req.params.id))));
  r.post('/:id/issue', allow('policies.manage'), writable, validate({ params: id, body: z.object({ ...fields, version: required(version()), nominees: z.array(nominee).max(10).nullable().optional(), renewalOf: z.boolean().optional() }).strict() }, labels), idempotent(), async (req, res) => {
    const out = await svc.issue(req.auth!, String(req.params.id), req.body, req);
    if (out.renewed) { const r = out.policy.renewal; sendDone(res, out.policy, 'REN-03', { date: r ? r.dueDate.split('-').reverse().join('-') : '' }); return; }
    sendDone(res, out.policy, 'POL-01', out.params);
  });
  r.put('/:id/nominees', allow('policies.manage'), writable, validate({ params: id, body: z.object({ nominees: z.array(nominee).max(10), endorsementRef: optional(shortText()), effectiveDate: optional(date()), documentFileId: optional(recordId('fil')) }).strict() }, labels), async (req, res) => {
    const out = await svc.saveNominees(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.policy, 'POL-10', out.params);
  });
  r.post('/:id/correct', allow('policies.manage'), writable, validate({ params: id, body: z.object({ version: required(version()), reason: required(shortText()), changes: z.object(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()]))).strict() }).strict() }, labels), async (req, res) =>
    sendDone(res, await svc.correct(req.auth!, String(req.params.id), req.body, req), 'POL-18'));
  r.post('/:id/cancel', allow('policies.manage'), writable, validate({ params: id, body: z.object({
    version: required(version()), reason: required(enumOf(['Free-look cancellation', 'Cancelled by insurer', 'Cancelled by customer', 'Recorded by mistake', 'Insurer declined the proposal'] as const)),
    date: required(date()), refund: z.number().min(0).nullable().optional(), note: optional(shortText()),
  }).strict() }, labels), async (req, res) => sendDone(res, await svc.cancel(req.auth!, String(req.params.id), req.body, req), 'POL-19'));
  return r;
}