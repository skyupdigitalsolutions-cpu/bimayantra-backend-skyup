import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { enumOf, required, rupees } from '../../lib/fields.js';
import { sendData } from '../../lib/response.js';
import * as svc from './bestfit.service.js';

const customerParam = z.object({ customerId: z.string().regex(/^cus_[a-f0-9]{28}$/) });
const labels = { typeId: 'Insurance type', people: 'People to cover', budget: 'Yearly budget', priority: 'What matters most', sumInsured: 'Sum insured' };

/** Customer → Best fit (P-26). Mounted at /customers/:customerId/best-fit. */
export function bestFitRoutes() {
  const r = Router({ mergeParams: true });
  r.use(authenticate, allow('bestfit.use'));
  r.get('/options', validate({ params: customerParam, query: z.object({ typeId: z.string().regex(/^typ_[a-f0-9]{28}$/) }) }), async (req, res) =>
    sendData(res, await svc.options(req.auth!, String(req.params.customerId), String(req.query.typeId))));
  r.post('/', validate({ params: customerParam, body: z.object({
    typeId: required(z.string().regex(/^typ_[a-f0-9]{28}$/)), people: z.array(z.string().regex(/^[CF]:(cus|fam)_[a-f0-9]{28}$/)).min(1, { message: 'GEN-01' }).max(20),
    budget: required(rupees()), priority: required(enumOf(svc.PRIORITIES)), sumInsured: required(rupees()),
  }).strict() }, labels), async (req, res) => {
    const out = await svc.rank(req.auth!, String(req.params.customerId), req.body, req);
    sendData(res, out, 200, { messageId: out.messageId, message: out.message });
  });
  r.post('/:rankingId/choose', validate({ params: z.object({ customerId: z.string(), rankingId: z.string().regex(/^rnk_[a-f0-9]{28}$/) }), body: z.object({ productId: required(z.string().regex(/^prd_[a-f0-9]{28}$/)), variantId: z.string().regex(/^var_[a-f0-9]{28}$/).nullable().optional() }).strict() }),
    async (req, res) => sendData(res, await svc.choose(req.auth!, String(req.params.rankingId), req.body.productId, req.body.variantId)));
  return r;
}