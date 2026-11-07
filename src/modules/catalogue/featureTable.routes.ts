import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { sendData } from '../../lib/response.js';
import { featureTable } from './featureTable.service.js';

/** Change #7: GET /catalogue/feature-table?typeId=…&source=ALL|VERIFIED|OWN (advisors and assistants). */
export function featureTableRoutes() {
  const r = Router();
  r.use(authenticate, allow('products.view'));
  r.get('/feature-table', validate({ query: z.object({ typeId: z.string().regex(/^typ_[a-f0-9]{28}$/), source: z.enum(['ALL', 'VERIFIED', 'OWN']).optional() }) }), async (req, res) =>
    sendData(res, await featureTable(req.auth!, res.locals.query as { typeId: string; source?: 'ALL' | 'VERIFIED' | 'OWN' })));
  return r;
}