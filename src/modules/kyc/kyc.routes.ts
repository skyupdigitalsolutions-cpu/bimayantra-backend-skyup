import { requireStepUp } from '../auth/stepUp.js';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { confirmations, declaration, enumOf, notes, optional, pan, personName, recordId, required, version } from '../../lib/fields.js';
import { sendData, sendDone } from '../../lib/response.js';
import * as kyc from './kyc.service.js';

const labels = { version: 'Version', pan: 'PAN', nameOnPan: 'Name as on PAN', panFileId: 'PAN card image', licenceFileId: 'IRDAI licence or POSP certificate', declaration: 'Declaration', decision: 'Decision', reason: 'Reason', note: 'Note' };

const submitBody = z.object({
  version: required(version()),
  pan: required(pan()),
  nameOnPan: required(personName()),
  panFileId: required(recordId('fil')),
  licenceFileId: required(recordId('fil')),
  declaration: required(declaration()),
  confirm: confirmations(),
}).strict();

const decisionBody = z.object({
  version: required(version()),
  decision: required(enumOf(['VERIFY', 'REJECT'] as const)),
  reason: optional(enumOf(kyc.REJECT_REASONS)),
  note: optional(notes()),
  // Change #48: the reviewer's four ticks, kept with the decision
  checklist: z.object({ panReadable: z.boolean(), nameMatches: z.boolean(), licenceValid: z.boolean(), photoClear: z.boolean() }).strict().nullable().optional(),
}).strict();

const accountParam = z.object({ accountId: z.string().regex(/^acc_[a-f0-9]{28}$/) });

/** Advisor: Settings → My profile → KYC. */
export function kycRoutes() {
  const r = Router();
  r.use(authenticate, allow('profile.manage'));
  r.get('/', async (req, res) => sendData(res, await kyc.getKyc(req.auth!)));
  r.put('/', writable, validate({ body: submitBody }, labels), async (req, res) => {
    const out = await kyc.submitKyc(req.auth!, req.body, req);
    sendDone(res, out.view, out.messageId);
  });
  return r;
}

/** SkyUp: Admin → Approvals → Advisor KYC. */
export function kycReviewRoutes() {
  const r = Router();
  r.use(authenticate, allow('kyc.review'));
  r.get('/', async (_req, res) => sendData(res, await kyc.reviewQueue()));
  r.get('/:accountId', validate({ params: accountParam }), async (req, res) => sendData(res, await kyc.reviewItem(String(req.params.accountId), req)));
  // Advisor KYC is still confirmed by an admin (client decision); Verify needs the step-up OTP (change analysis §9.1).
  // Q113 (client decision): only a SkyUp admin verifies or rejects; staff can read the queue and the submission.
  r.post('/:accountId/decision', allow('kyc.decide'), (req, res, next) => (req.body?.decision === 'VERIFY' ? requireStepUp(req, res, next) : next()), validate({ params: accountParam, body: decisionBody }, labels), idempotent(), async (req, res) => {
    const out = await kyc.decide(req.auth!, String(req.params.accountId), req.body, req);
    sendDone(res, out, out.messageId as 'PRF-05' | 'PRF-06', out.messageId === 'PRF-06' ? { reason: req.body.reason === 'Other' ? req.body.note : req.body.reason } : {});
  });
  return r;
}