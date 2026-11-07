import { TASK_PRIORITIES, TASK_TYPES } from './task.model.js';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { editable, enumOf, notes, optional, required, shortText, timeOfDay, todayOrLater, version } from '../../lib/fields.js';
import { sendData, sendDone } from '../../lib/response.js';
import * as svc from './tasks.service.js';

const labels = { title: 'Title', dueDate: 'Due date', dueTime: 'Due time', notes: 'Notes', linkedType: 'Linked record', linkedId: 'Linked record', version: 'Version', tab: 'Tab' };
const idParam = z.object({ id: z.string().regex(/^tsk_[a-f0-9]{28}$/) });
const versionBody = z.object({ version: required(version()) }).strict();

const createBody = z.object({
  title: required(shortText()),
  dueDate: required(todayOrLater()),
  dueTime: required(timeOfDay()),
  linkedType: optional(enumOf(['LEAD', 'CUSTOMER'] as const)),
  linkedId: optional(z.string().regex(/^(led|cus)_[a-f0-9]{28}$/)),
  notes: optional(notes()),
  taskType: optional(enumOf(TASK_TYPES)),
  priority: optional(enumOf(TASK_PRIORITIES)),
}).strict();
const editBody = z.object({
  version: required(version()),
  title: editable(shortText()),
  dueDate: todayOrLater().optional(),
  dueTime: timeOfDay().optional(),
  notes: optional(notes()),
  taskType: optional(enumOf(TASK_TYPES)),
  priority: optional(enumOf(TASK_PRIORITIES)),
}).strict();

/** Tasks and follow-ups (P-11). */
export function taskRoutes() {
  const r = Router();
  r.use(authenticate, allow('tasks.work'));
  r.get('/', validate({ query: z.object({
    tab: enumOf(svc.TABS).default('TODAY'), type: enumOf(TASK_TYPES).optional(),
    linkedType: enumOf(['LEAD', 'CUSTOMER'] as const).optional(), linkedId: z.string().regex(/^(led|cus)_[a-f0-9]{28}$/).optional(),
  }).refine((q) => !q.linkedId === !q.linkedType, { message: 'VAL-22', path: ['linkedId'] }) }, labels), async (req, res) => {
    const q = res.locals.query as { tab?: string; type?: string; linkedType?: 'LEAD' | 'CUSTOMER'; linkedId?: string };
    sendData(res, await svc.list(req.auth!, (q.tab as (typeof svc.TABS)[number]) ?? 'TODAY', q.type ? String(q.type) : undefined,
      q.linkedType && q.linkedId ? { type: q.linkedType, id: q.linkedId } : undefined));
  });
  r.post('/', writable, validate({ body: createBody }, labels), idempotent(), async (req, res) =>
    sendDone(res, await svc.create(req.auth!, req.body, req), 'GEN-08', { 'Record type': 'Task' }, 201));
  r.patch('/:id', writable, validate({ params: idParam, body: editBody }, labels), async (req, res) =>
    sendDone(res, await svc.edit(req.auth!, String(req.params.id), req.body, req), 'GEN-08', { 'Record type': 'Task' }));
  r.post('/:id/done', writable, validate({ params: idParam, body: versionBody }, labels), async (req, res) =>
    sendDone(res, await svc.setStatus(req.auth!, String(req.params.id), req.body, 'DONE', req), 'DSH-23'));
  r.post('/:id/reopen', writable, validate({ params: idParam, body: versionBody }, labels), async (req, res) =>
    sendDone(res, await svc.setStatus(req.auth!, String(req.params.id), req.body, 'OPEN', req), 'GEN-08', { 'Record type': 'Task' }));
  r.post('/:id/reschedule', writable, validate({ params: idParam, body: z.object({ version: required(version()), preset: optional(enumOf(svc.RESCHEDULE_PRESETS)), dueDate: todayOrLater().optional(), dueTime: timeOfDay().optional() }).strict() }, labels), async (req, res) => {
    const out = await svc.reschedule(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.task, 'TSK-01', out.params);
  });
  r.post('/:id/cancel', writable, validate({ params: idParam, body: versionBody }, labels), async (req, res) =>
    sendDone(res, await svc.setStatus(req.auth!, String(req.params.id), req.body, 'CANCELLED', req), 'GEN-08', { 'Record type': 'Task' }));
  return r;
}