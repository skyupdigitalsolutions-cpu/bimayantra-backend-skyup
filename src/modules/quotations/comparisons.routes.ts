import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { date, enumOf, optional, required, rupees, shortText, version } from '../../lib/fields.js';
import { sendData, sendDone } from '../../lib/response.js';
import * as svc from './comparisons.service.js';
import { DISCOUNT_PRESETS, pricingExtras } from './quotations.routes.js';

const id = z.object({ id: z.string().regex(/^cq_[a-f0-9]{28}$/) });
const option = z.object({
  productId: required(z.string().regex(/^prd_[a-f0-9]{28}$/)), riders: z.array(z.string().max(200)).max(50).optional(),
  override: z.object({ amount: required(rupees()), reason: z.string().max(200).default('') }).strict().nullable().optional(),
  discount: z.object({ kind: required(enumOf(['AMOUNT', 'PERCENT'] as const)), value: z.number().min(0).max(10_000_000), reference: z.string().max(200).default(''), preset: optional(enumOf(DISCOUNT_PRESETS)) }).strict().nullable().optional(),
  manual: z.object({ netPremium: rupees().optional(), taxAmount: rupees({ allowZero: true }).optional() }).strict().nullable().optional(),
  ...pricingExtras, // change #13: variant, typed premium and add-ons per option
}).strict();
const inputs = z.object({
  typeId: z.string().regex(/^typ_[a-f0-9]{28}$/).optional(), people: z.array(z.string().regex(/^[CF]:(cus|fam)_[a-f0-9]{28}$/)).max(20).optional(),
  sumInsured: rupees().optional(), policyTerm: z.number().int().min(1).max(100).optional(), startDate: date().optional(),
  answers: z.record(z.string().max(60), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
  renewalOf: z.string().regex(/^pol_[a-f0-9]{28}$/).nullable().optional(), // change #14: a renewal compared across insurers
}).strict();

/** Comparison quotations (P-30). */
export function comparisonRoutes() {
  const r = Router();
  r.use(authenticate, allow('quotations.work'));
  r.get('/', async (req, res) => sendData(res, await svc.list(req.auth!)));
  r.post('/', writable, validate({ body: z.object({ customerId: required(z.string().regex(/^cus_[a-f0-9]{28}$/)) }).strict() }), idempotent(), async (req, res) => sendData(res, await svc.start(req.auth!, req.body.customerId, req), 201));
  r.get('/:id', validate({ params: id }), async (req, res) => sendData(res, await svc.get(req.auth!, String(req.params.id))));
  r.put('/:id', writable, validate({ params: id, body: z.object({ version: required(version()), inputs, options: z.array(option).max(5), recommendedProductId: z.string().regex(/^prd_[a-f0-9]{28}$/).nullable().optional(), recommendedReason: optional(z.string().max(600)) }).strict() }, { options: 'Products', recommendedReason: 'Reason' }),
    async (req, res) => sendData(res, await svc.saveDraft(req.auth!, String(req.params.id), req.body)));
  r.post('/:id/preview', validate({ params: id }), async (req, res) => sendData(res, await svc.preview(req.auth!, String(req.params.id))));
  r.post('/:id/generate', writable, validate({ params: id }), idempotent(), async (req, res) => {
    const out = await svc.generate(req.auth!, String(req.params.id), req);
    sendDone(res, out.comparison, 'QT-33', out.params);
  });
  r.post('/:id/share', writable, validate({ params: id, body: z.object({ channel: required(enumOf(['EMAIL', 'WHATSAPP', 'LINK', 'DOWNLOAD'] as const)) }).strict() }), idempotent(), async (req, res) =>
    sendData(res, await svc.share(req.auth!, String(req.params.id), req.body.channel, req)));
  r.post('/:id/choose', writable, validate({ params: id, body: z.object({ version: required(version()), productId: required(z.string().regex(/^prd_[a-f0-9]{28}$/)), variantId: z.string().regex(/^var_[a-f0-9]{28}$/).nullable().optional() }).strict() }), async (req, res) => {
    const out = await svc.choose(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.comparison, 'QT-34', out.params);
  });
  r.post('/:id/create-quotation', writable, validate({ params: id }), idempotent(), async (req, res) => sendData(res, await svc.createQuotation(req.auth!, String(req.params.id), req), 201));
  void shortText;
  return r;
}

export function publicComparisonRoutes() {
  const r = Router();
  r.get('/:token', validate({ params: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{40,60}$/) }) }), async (req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    sendData(res, await svc.publicView(String(req.params.token)));
  });
  return r;
}