import { Router } from 'express';
import { z } from 'zod';
import { required, shortText } from '../../lib/fields.js';
import { sendData, sendDone } from '../../lib/response.js';
import { authenticate } from '../../middleware/authenticate.js';
import { allow } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { requireStepUp } from '../auth/stepUp.js';
import { ROLLOUT_PLANS, effectiveFlags } from './flags.js';
import * as svc from './flags.service.js';

const keyParam = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{2,60}$/) });
const labels = { enabled: 'Switched on', reason: 'Reason' };

/** Any signed-in user: the switches as they apply to their account, so web and mobile switch together. */
export function flagRoutes() {
  const r = Router();
  r.use(authenticate);
  r.get('/', (req, res) => sendData(res, effectiveFlags(req.auth!.accountId)));
  return r;
}

/** SkyUp Admin: see and change switches. Every change needs a reason and the step-up OTP, and is audited. */
export function adminFlagRoutes() {
  const r = Router();
  r.use(authenticate, allow('flags.manage'));
  r.get('/', async (_req, res) => sendData(res, await svc.list()));
  r.get('/:key/accounts', validate({ params: keyParam }), async (req, res) => sendData(res, await svc.accountValues(String(req.params.key))));
  r.put('/:key', requireStepUp, validate({ params: keyParam, body: z.object({ enabled: z.boolean({ required_error: 'GEN-01', invalid_type_error: 'VAL-22' }), reason: required(shortText()), plans: z.array(z.enum(ROLLOUT_PLANS)).max(3).nullable().optional() }).strict() }, labels), async (req, res) =>
    sendDone(res, await svc.setGlobal(req.auth!, String(req.params.key), req.body, req), 'FLG-01'));
  r.put('/:key/accounts/:accountId', requireStepUp,
    validate({ params: keyParam.extend({ accountId: z.string().regex(/^acc_[a-f0-9]{28}$/) }), body: z.object({ enabled: z.boolean({ invalid_type_error: 'VAL-22' }).nullable(), reason: required(shortText()) }).strict() }, labels),
    async (req, res) => sendDone(res, await svc.setForAccount(req.auth!, String(req.params.key), String(req.params.accountId), req.body, req), 'FLG-01'));
  return r;
}