import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { declaration, email, mobile, optional, personName, required, shortText } from '../../lib/fields.js';
import { sendData, sendDone } from '../../lib/response.js';
import * as svc from './referrals.service.js';

const id = z.object({ id: z.string().regex(/^usr_[a-f0-9]{28}$/) });
const form = z.object({
  name: required(personName()), mobile: required(mobile()), email: optional(email()), relation: required(shortText()), interest: required(shortText()),
  city: optional(shortText()), message: optional(z.string().max(1000)), permission: required(declaration()), website: z.string().max(200).optional(),
}).strict();
const labels = { name: 'Your name', mobile: 'Mobile', email: 'Email', relation: 'How you know them', interest: 'Insurance you are interested in', city: 'City', message: 'Message', permission: 'Permission', note: 'Note' };

/** Referrers (P-44): the advisor. */
export function referrerRoutes() {
  const r = Router();
  r.use(authenticate, allow('referrers.manage'));
  r.get('/', async (req, res) => sendData(res, await svc.list(req.auth!)));
  r.post('/', writable, validate({ body: z.object({ name: required(personName()), mobile: required(mobile()), note: optional(z.string().max(1000)) }).strict() }, labels), idempotent(), async (req, res) => {
    const out = await svc.add(req.auth!, req.body, req);
    sendDone(res, { referrer: out.referrer, invitation: out.invitation, whatsappUrl: out.whatsappUrl }, 'REF-01', out.params, 201);
  });
  r.post('/:id/disable', writable, validate({ params: id }), async (req, res) => { const out = await svc.disable(req.auth!, String(req.params.id), req); sendDone(res, out.referrer, 'REF-07', out.params); });
  r.post('/:id/enable', writable, validate({ params: id }), async (req, res) => sendData(res, await svc.enable(req.auth!, String(req.params.id), req)));
  r.post('/:id/new-link', writable, validate({ params: id }), async (req, res) => sendDone(res, await svc.newLink(req.auth!, String(req.params.id), req), 'REF-06'));
  return r;
}
/** The referrer's own view (P-45) and + Refer someone. */
export function referralSelfRoutes() {
  const r = Router();
  r.use(authenticate, allow('referral.self'));
  r.get('/me', async (req, res) => sendData(res, await svc.me(req.auth!)));
  r.get('/me/referrals', async (req, res) => sendData(res, await svc.myReferrals(req.auth!)));
  r.post('/me/refer', validate({ body: form }, labels), async (req, res) => { const out = await svc.referAsReferrer(req.auth!, req.body, req.ip ?? ''); sendDone(res, { submitted: true }, 'REF-05', out.params, 201); });
  return r;
}
/** The public referral page and form (P-46): no sign-in. */
export function publicReferralRoutes() {
  const r = Router();
  const code = z.object({ code: z.string().regex(/^[A-Za-z0-9]{6,12}$/) });
  r.get('/:code', validate({ params: code }), async (req, res) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); sendData(res, await svc.publicPage(String(req.params.code))); });
  r.post('/:code', validate({ params: code, body: form }, labels), async (req, res) => { const out = await svc.submit(String(req.params.code), req.body, req.ip ?? ''); sendDone(res, { submitted: true }, 'REF-05', out.params, 201); });
  return r;
}