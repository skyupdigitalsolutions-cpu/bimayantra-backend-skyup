import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { date, enumOf, optional, required, rupees, shortText, version } from '../../lib/fields.js';
import { sendData, sendDone } from '../../lib/response.js';
import * as svc from './quotations.service.js';
import * as life from './lifecycle.service.js';

const labels = {
  customerId: 'Customer', typeId: 'Insurance type', insurerId: 'Insurer', productId: 'Product', people: 'People to insure', sumInsured: 'Sum insured',
  policyTerm: 'Policy term', startDate: 'Planned start date', riders: 'Riders', override: 'Price override', discount: 'Discount', manual: 'Premium', version: 'Version', step: 'Step',
};
const id = z.object({ id: z.string().regex(/^qt_[a-f0-9]{28}$/) });
/** Change #12 (Q5 default): preset discount types are labels; the reference is still required (QT-37). */
export const DISCOUNT_PRESETS = ['LONG_TERM', 'FAMILY', 'OTHER'] as const;
/** Stage G inputs shared with comparison options (changes #2, #8, #9). */
export const pricingExtras = {
  variantId: z.string().regex(/^var_[a-f0-9]{28}$/).nullable().optional(),
  typedBasePremium: rupees().nullable().optional(),
  riderPrices: z.record(z.string().max(200), rupees({ allowZero: true })).optional(),
  customAddOns: z.array(z.object({ name: required(shortText()), price: required(rupees({ allowZero: true })) }).strict()).max(50).optional(),
};
const inputs = z.object({
  typeId: z.string().regex(/^typ_[a-f0-9]{28}$/).optional(), insurerId: z.string().regex(/^ins_[a-f0-9]{28}$/).optional(), productId: z.string().regex(/^prd_[a-f0-9]{28}$/).optional(),
  people: z.array(z.string().regex(/^[CF]:(cus|fam)_[a-f0-9]{28}$/)).max(20).optional(),
  sumInsured: rupees().optional(), policyTerm: z.number().int().min(1).max(100).optional(), startDate: date().optional(),
  answers: z.record(z.string().max(60), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
  riders: z.array(z.string().max(200)).max(50).optional(),
  override: z.object({ amount: required(rupees()), reason: z.string().max(200).default('') }).strict().nullable().optional(),
  discount: z.object({ kind: required(enumOf(['AMOUNT', 'PERCENT'] as const)), value: z.number().min(0).max(10_000_000), reference: z.string().max(200).default(''), preset: optional(enumOf(DISCOUNT_PRESETS)) }).strict().nullable().optional(),
  manual: z.object({ netPremium: rupees().optional(), taxAmount: rupees({ allowZero: true }).optional() }).strict().nullable().optional(),
  paymentLink: optional(shortText()),
  renewalOf: z.string().regex(/^pol_[a-f0-9]{28}$/).nullable().optional(),
  ...pricingExtras,
  // Change #10: additional benefits (information only)
  benefits: z.array(z.object({ name: required(shortText()), description: optional(shortText()), cost: optional(rupees({ allowZero: true })), showOnPdf: z.boolean().default(true) }).strict()).max(20).optional(),
}).strict();

/** Quotations (P-27). */
export function quotationRoutes() {
  const r = Router();
  r.use(authenticate, allow('quotations.work'));
  r.get('/', validate({ query: z.object({
    customerId: z.string().regex(/^cus_[a-f0-9]{28}$/).optional(),
    status: z.string().max(120).refine((v) => v.split(',').every((s) => (svc.QUOTATION_STATUSES as readonly string[]).includes(s.trim())), { message: 'VAL-22' }).optional(),
    search: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }) }), async (req, res) => {
    const { items, meta } = await svc.listFor(req.auth!, res.locals.query);
    sendData(res, items, 200, meta);
  });
  r.get('/choices', validate({ query: z.object({ typeId: z.string().optional(), insurerId: z.string().optional() }) }), async (req, res) =>
    sendData(res, await svc.choices(req.auth!, req.query.typeId ? String(req.query.typeId) : undefined, req.query.insurerId ? String(req.query.insurerId) : undefined)));
  r.post('/', writable, validate({ body: z.object({ customerId: required(z.string().regex(/^cus_[a-f0-9]{28}$/)) }).strict() }, labels), idempotent(), async (req, res) =>
    sendData(res, await svc.start(req.auth!, req.body.customerId, req), 201));
  r.get('/:id', validate({ params: id }), async (req, res) => sendData(res, await svc.get(req.auth!, String(req.params.id))));
  r.patch('/:id', writable, validate({ params: id, body: z.object({ version: required(version()), step: z.number().int().min(1).max(10), inputs }).strict() }, labels), async (req, res) =>
    sendData(res, await svc.save(req.auth!, String(req.params.id), req.body, req)));
  r.post('/:id/calculate', writable, validate({ params: id }), async (req, res) => {
    const out = await svc.calc(req.auth!, String(req.params.id));
    sendData(res, out.quotation, 200, out.warnings.length ? { warnings: out.warnings } : {});
  });
  r.post('/:id/generate', writable, validate({ params: id }), idempotent(), async (req, res) => {
    const out = await svc.generate(req.auth!, String(req.params.id), req);
    sendDone(res, out.quotation, 'QT-01', out.params);
  });
  // P-28 share
  r.post('/:id/share', writable, validate({ params: id, body: z.object({ channel: required(enumOf(['EMAIL', 'WHATSAPP', 'LINK', 'DOWNLOAD'] as const)) }).strict() }, { channel: 'Share by' }), idempotent(), async (req, res) => {
    const out = await life.share(req.auth!, String(req.params.id), req.body.channel, req);
    sendDone(res, { quotation: out.quotation, link: out.link, pdfFileId: out.pdfFileId, whatsappUrl: (out as { whatsappUrl?: string }).whatsappUrl ?? null }, out.messageId, out.params as Record<string, string>);
  });
  // P-29 actions
  const vb = z.object({ version: required(version()) }).strict();
  r.post('/:id/edit', writable, validate({ params: id, body: vb }), async (req, res) => sendData(res, await life.edit(req.auth!, String(req.params.id), req.body, req)));
  r.post('/:id/revise', writable, validate({ params: id, body: vb }), async (req, res) => {
    const out = await life.revise(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.quotation, 'QT-25', out.params);
  });
  r.post('/:id/accept', writable, validate({ params: id, body: vb }), async (req, res) => sendDone(res, await life.outcome(req.auth!, String(req.params.id), req.body, 'ACCEPTED', req), 'QT-26'));
  const REJECT = ['Premium too high', 'Chose another insurer', 'Not interested now', 'Other'] as const;
  r.post('/:id/reject', writable, validate({ params: id, body: z.object({ version: required(version()), reason: required(enumOf(REJECT)), note: optional(shortText()) }).strict() }, { reason: 'Reason', note: 'Note' }), async (req, res) => {
    if (req.body.reason === 'Other' && !req.body.note) throw (await import('../../lib/errors.js')).AppError.field('note', 'GEN-01', { 'Field label': 'Note' });
    sendDone(res, await life.outcome(req.auth!, String(req.params.id), { version: req.body.version, reason: req.body.reason === 'Other' ? `Other: ${req.body.note}` : req.body.reason }, 'REJECTED', req), 'QT-27');
  });
  r.post('/:id/cancel', writable, validate({ params: id, body: z.object({ version: required(version()), reason: optional(shortText()) }).strict() }, { reason: 'Reason' }), async (req, res) =>
    sendDone(res, await life.outcome(req.auth!, String(req.params.id), req.body, 'CANCELLED', req), 'QT-28'));
  r.delete('/:id', writable, validate({ params: id }), async (req, res) => { await life.deleteDraft(req.auth!, String(req.params.id), req); sendDone(res, { deleted: true }, 'QT-29'); });
  r.get('/:id/revisions/:revision', validate({ params: z.object({ id: z.string().regex(/^qt_[a-f0-9]{28}$/), revision: z.coerce.number().int().min(1) }) }), async (req, res) =>
    sendData(res, await svc.snapshot(req.auth!, String(req.params.id), Number(req.params.revision))));
  return r;
}

/** The customer's view link: no sign-in, hidden from search engines (P-28). */
export function publicQuotationRoutes() {
  const r = Router();
  r.get('/:token', validate({ params: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{40,60}$/) }) }), async (req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    sendData(res, await life.publicView(String(req.params.token)));
  });
  return r;
}