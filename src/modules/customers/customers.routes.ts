import { Router } from 'express';
import { z } from 'zod';
import { pageQuery } from '../../lib/pagination.js';
import { customerActivity } from '../audit/customerActivity.js';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { sendData, sendDone } from '../../lib/response.js';
import { AppError } from '../../lib/errors.js';
import { getConsents, recordConsent, recordConsents } from './consent.service.js';
import {
  consentBody, createCustomerBody, customerIdParam, defaultNomineeBody, linkBody, linkParams, duplicateQuery, familyBody, familyUpdateBody, identityBody, labels, listCustomersQuery,
  memberParams, revealBody, statusBody, updateCustomerBody, versionBody,
} from './customers.schemas.js';
import * as svc from './customers.service.js';

const p = (req: { params: unknown }) => req.params as { id: string; memberId: string };

export function customerRoutes() {
  const r = Router();
  r.use(authenticate, allow('customers.work'));

  r.get('/', validate({ query: listCustomersQuery }), async (req, res) => {
    const { items, meta } = await svc.listCustomers(req.auth!, res.locals.query);
    sendData(res, items, 200, meta);
  });
  r.get('/stats', async (req, res) => sendData(res, await svc.customerStats(req.auth!))); // before /:id
  r.get('/duplicate-check', validate({ query: duplicateQuery }, labels), async (req, res) => sendData(res, await svc.duplicateCheck(req.auth!, res.locals.query)));
  r.post('/', writable, validate({ body: createCustomerBody }, labels), idempotent(), async (req, res) => {
    const c = await svc.createCustomer(req.auth!, req.body, req);
    sendDone(res, c, 'CU-01', { 'customer number': c.number }, 201);
  });
  r.get('/:id', validate({ params: customerIdParam }), async (req, res) => sendData(res, await svc.getCustomer(req.auth!, p(req).id)));
  r.patch('/:id', writable, validate({ params: customerIdParam, body: updateCustomerBody }, labels), async (req, res) =>
    sendDone(res, await svc.updateCustomer(req.auth!, p(req).id, req.body, req), 'GEN-08', { 'Record type': 'Customer' }));

  // P-19 (advisor only)
  r.post('/:id/deactivate', allow('customers.deactivate'), writable, validate({ params: customerIdParam, body: statusBody }, labels), idempotent(), async (req, res) => {
    const c = await svc.setCustomerStatus(req.auth!, p(req).id, false, req.body, req);
    sendDone(res, c, 'CU-09', { Customer: c.name });
  });
  r.post('/:id/reactivate', allow('customers.deactivate'), writable, validate({ params: customerIdParam, body: statusBody }, labels), idempotent(), async (req, res) => {
    const c = await svc.setCustomerStatus(req.auth!, p(req).id, true, req.body, req);
    sendDone(res, c, 'CU-10', { Customer: c.name });
  });

  // PAN and Aadhaar (GR-36, GR-37)
  r.put('/:id/identity', writable, validate({ params: customerIdParam, body: identityBody }, labels), async (req, res) => {
    const { customer, warnings } = await svc.setIdentity(req.auth!, p(req).id, req.body, req);
    sendDone(res, customer, 'GEN-08', { 'Record type': 'Customer' }, 200, { warnings });
  });
  r.post('/:id/identity/reveal', allow('customers.revealIdentity'), validate({ params: customerIdParam, body: revealBody }, labels), async (req, res) =>
    sendDone(res, await svc.revealIdentity(req.auth!, p(req).id, req.body.field, req), 'CU-25'));

  // P-16 Household roster
  r.get('/:id/family', validate({ params: customerIdParam }), async (req, res) => sendData(res, await svc.listFamily(req.auth!, p(req).id)));
  r.post('/:id/family', writable, validate({ params: customerIdParam, body: familyBody }, labels), idempotent(), async (req, res) => {
    const { member, customerName } = await svc.addFamilyMember(req.auth!, p(req).id, req.body, req);
    sendDone(res, member, 'CU-05', { Name: member.name, customer: customerName }, 201);
  });
  r.patch('/:id/family/:memberId', writable, validate({ params: memberParams, body: familyUpdateBody }, labels), async (req, res) =>
    sendDone(res, await svc.updateFamilyMember(req.auth!, p(req).id, p(req).memberId, req.body, req), 'GEN-08', { 'Record type': 'Family member' }));
  r.post('/:id/family/:memberId/deactivate', writable, validate({ params: memberParams, body: versionBody }, labels), async (req, res) => {
    const m = await svc.setFamilyStatus(req.auth!, p(req).id, p(req).memberId, false, req.body.version, req);
    sendDone(res, m, 'CU-19', { Name: m.name });
  });
  r.post('/:id/family/:memberId/activate', writable, validate({ params: memberParams, body: versionBody }, labels), async (req, res) =>
    sendDone(res, await svc.setFamilyStatus(req.auth!, p(req).id, p(req).memberId, true, req.body.version, req), 'GEN-08', { 'Record type': 'Family member' }));

  // B-01 · PF1 default nominee, PF2 linked policy holders
  r.get('/:id/default-nominee', validate({ params: customerIdParam }), async (req, res) => sendData(res, await svc.getDefaultNominee(req.auth!, p(req).id)));
  r.put('/:id/default-nominee', writable, validate({ params: customerIdParam, body: defaultNomineeBody }, labels), async (req, res) => {
    const out = await svc.setDefaultNominee(req.auth!, p(req).id, req.body, req);
    sendDone(res, out.view, req.body.nominee ? 'CU-33' : 'CU-34', { Customer: out.name });
  });
  r.get('/:id/links', validate({ params: customerIdParam }), async (req, res) => sendData(res, await svc.listLinks(req.auth!, p(req).id)));
  r.post('/:id/links', writable, validate({ params: customerIdParam, body: linkBody }, labels), idempotent(), async (req, res) => {
    const out = await svc.addLink(req.auth!, p(req).id, req.body, req);
    sendDone(res, out.link, 'CU-35', out.params, 201);
  });
  r.delete('/:id/links/:linkId', writable, validate({ params: linkParams }), async (req, res) => {
    const out = await svc.removeLink(req.auth!, p(req).id, String(req.params.linkId), req);
    sendDone(res, null, 'CU-36', out.params);
  });

  // B-06: the customer's activity for assistants too (who, when, what: no old/new values)
  r.get('/:id/activity', validate({ params: customerIdParam, query: z.object(pageQuery) }), async (req, res) => {
    const out = await customerActivity(req.auth!, p(req).id, res.locals.query, { values: req.auth!.role === 'ADV' });
    sendData(res, out.items, 200, out.meta);
  });

  // P-17 Consent (withdrawal stays possible in read-only mode: a withdrawal always wins)
  r.get('/:id/consents', validate({ params: customerIdParam }), async (req, res) => sendData(res, await getConsents(req.auth!, p(req).id)));
  r.post('/:id/consents', validate({ params: customerIdParam, body: consentBody }, labels), idempotent(), async (req, res) => {
    if (req.body.action === 'GIVE' && req.auth!.readOnly) throw new AppError(403, 'READ_ONLY', 'SUB-03');
    const out = req.body.channels ? await recordConsents(req.auth!, p(req).id, req.body, req) : await recordConsent(req.auth!, p(req).id, req.body, req);
    sendDone(res, await getConsents(req.auth!, p(req).id), out.messageId, out.params);
  });
  return r;
}