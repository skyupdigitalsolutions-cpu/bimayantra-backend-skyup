import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { AppError } from '../../lib/errors.js';
import { documentLabel, recordId, required, version } from '../../lib/fields.js';
import { pageQuery } from '../../lib/pagination.js';
import { sendData, sendDone } from '../../lib/response.js';
import * as svc from './documents.service.js';

const labels = { customerId: 'Customer', personKey: 'Person', type: 'Document type', name: 'Document name', fileId: 'File', label: 'Label', rev: 'Version' };
const idParam = z.object({ id: z.string().regex(/^doc_[a-f0-9]{28}$/) });

const uploadBody = z.object({
  customerId: z.string().regex(/^cus_[a-f0-9]{28}$/).optional(), // missing → DOC-01 (service)
  personKey: z.string().max(40).optional(),
  type: z.string().max(60).optional(),
  name: documentLabel().nullish(), // FLD-37, for Other
  fileId: required(recordId('fil')),
  saveAsType: z.boolean().optional(), // change #25: keep this "Other" name as a type to pick again
}).strict();

/** AC-P18-3: no role can delete a document, on screen or by API. */
const refuseDelete = () => { throw new AppError(409, 'INVALID_STATE', 'DOC-07'); };

/** Add document, verify/confirm, labels (P-18). */
export function documentRoutes() {
  const r = Router();
  r.use(authenticate);
  r.delete('/', refuseDelete);
  r.delete('/:id', refuseDelete);
  r.use(allow('documents.work'));
  r.post('/', writable, validate({ body: uploadBody }, labels), idempotent(), async (req, res) => {
    const out = await svc.upload(req.auth!, req.body, req);
    sendDone(res, { ...out.document, personName: out.personName, verify: out.verify }, 'DOC-03', out.params, 201);
  });
  // B-03: the account-wide documents library (before /:id)
  r.get('/', validate({ query: z.object({ ...pageQuery, customerId: z.string().regex(/^cus_[a-f0-9]{28}$/).optional(), type: z.string().max(60).optional(), status: z.enum(['UNCONFIRMED', 'CONFIRMED']).optional(), search: z.string().trim().max(100).optional() }) }), async (req, res) => {
    const out = await svc.listAll(req.auth!, res.locals.query);
    sendData(res, out.items, 200, out.meta);
  });
  r.get('/:id', validate({ params: idParam }), async (req, res) => sendData(res, await svc.getDocument(req.auth!, String(req.params.id))));
  r.post('/:id/confirm', writable, validate({ params: idParam, body: z.object({ rev: required(version()), values: z.record(z.unknown()) }).strict() }, labels), idempotent(),
    async (req, res) => sendData(res, await svc.confirm(req.auth!, String(req.params.id), req.body, req)));
  r.patch('/:id/label', allow('documents.relabel'), writable, validate({ params: idParam, body: z.object({ rev: required(version()), label: required(documentLabel()) }).strict() }, labels),
    async (req, res) => sendDone(res, await svc.changeLabel(req.auth!, String(req.params.id), req.body, req), 'DOC-05'));
  return r;
}

/** Customers → a customer → Documents. Mounted at /customers/:customerId/documents. */
export function customerDocumentRoutes() {
  const r = Router({ mergeParams: true });
  r.use(authenticate);
  r.delete('/', refuseDelete);
  r.delete('/:id', refuseDelete);
  r.use(allow('documents.work'));
  r.get('/', validate({ params: z.object({ customerId: z.string().regex(/^cus_[a-f0-9]{28}$/) }) }), async (req, res) =>
    sendData(res, await svc.listForCustomer(req.auth!, String(req.params.customerId))));
  return r;
}

/** Change #25: GET and POST /account/document-types (advisors and assistants who work on documents). */
export function accountDocumentTypeRoutes() {
  const r = Router();
  r.use(authenticate, allow('documents.work'));
  r.get('/', async (req, res) => sendData(res, await (await import('./accountDocTypes.service.js')).list(req.auth!)));
  r.post('/', writable, validate({ body: z.object({ name: required(documentLabel()) }).strict() }, { name: 'Document name' }), async (req, res) => {
    const out = await (await import('./accountDocTypes.service.js')).add(req.auth!, req.body.name, req);
    sendDone(res, out, 'DOC-11', { name: out.name }, out.created ? 201 : 200);
  });
  return r;
}