import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { email, enumOf, mobile, optional, personName, required, version } from '../../lib/fields.js';
import { sendData, sendDone } from '../../lib/response.js';
import { requireStepUp } from '../auth/stepUp.js';
import { ROLE_LABEL } from '../users/user.model.js';
import * as team from './team.service.js';

const labels = { name: 'Name', mobile: 'Mobile', role: 'Role', version: 'Version', email: 'Email' };
const idParam = z.object({ id: z.string().regex(/^usr_[a-f0-9]{28}$/) });
const versionBody = z.object({ version: required(version()) });
const personBody = z.object({ name: required(personName()), mobile: required(mobile()) });
// Change #57: optional email on the add-user form; the OTP stays (P-48 step 2, Q121)
const staffBody = personBody.extend({ role: required(enumOf(['STF', 'ADM'] as const)), email: optional(email()) });
const roleBody = z.object({ role: required(enumOf(['STF', 'ADM'] as const)), version: required(version()) });
const id = (p: unknown) => String((p as { id: string }).id);

export function assistantRoutes() {
  const r = Router();
  r.use(authenticate, allow('assistants.manage'));
  r.get('/', async (req, res) => sendData(res, await team.listAssistants(req.auth!)));
  r.post('/', writable, validate({ body: personBody }, labels), requireStepUp, idempotent(), async (req, res) => {
    const a = await team.addAssistant(req.auth!, req.body, req);
    sendDone(res, a, 'AST-01', { name: a.name }, 201);
  });
  r.post('/:id/disable', validate({ params: idParam, body: versionBody }, labels), async (req, res) => {
    const a = await team.setAssistantStatus(req.auth!, id(req.params), false, req.body.version, req);
    sendDone(res, a, 'AST-03', { name: a.name });
  });
  r.post('/:id/enable', writable, validate({ params: idParam, body: versionBody }, labels), async (req, res) =>
    sendDone(res, await team.setAssistantStatus(req.auth!, id(req.params), true, req.body.version, req), 'GEN-08', { 'Record type': 'Assistant' }));
  return r;
}

/** P-48: every change needs the extra OTP (CFG-83). STF cannot open this API (AC-P48-3). */
export function staffRoutes() {
  const r = Router();
  r.use(authenticate, allow('staff.manage'));
  r.get('/', async (_req, res) => sendData(res, await team.listStaff()));
  r.post('/', validate({ body: staffBody }, labels), requireStepUp, idempotent(), async (req, res) => {
    const u = await team.addStaff(req.auth!, req.body, req);
    sendDone(res, u, 'ADM-01', { Name: u.name, role: ROLE_LABEL[req.body.role as 'STF' | 'ADM'] }, 201);
  });
  r.post('/:id/role', validate({ params: idParam, body: roleBody }, labels), requireStepUp, async (req, res) =>
    sendDone(res, await team.changeStaffRole(req.auth!, id(req.params), req.body, req), 'GEN-08', { 'Record type': 'User' }));
  r.post('/:id/disable', validate({ params: idParam, body: versionBody }, labels), requireStepUp, async (req, res) =>
    sendDone(res, await team.setStaffStatus(req.auth!, id(req.params), false, req.body.version, req), 'GEN-08', { 'Record type': 'User' }));
  r.post('/:id/enable', validate({ params: idParam, body: versionBody }, labels), requireStepUp, async (req, res) =>
    sendDone(res, await team.setStaffStatus(req.auth!, id(req.params), true, req.body.version, req), 'GEN-08', { 'Record type': 'User' }));
  return r;
}