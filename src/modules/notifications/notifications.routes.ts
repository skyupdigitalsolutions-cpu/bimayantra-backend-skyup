import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { sendData } from '../../lib/response.js';
import * as svc from './notifications.service.js';

/** The bell (P-10). Every signed-in user sees only their own items. */
export function notificationRoutes() {
  const r = Router();
  r.use(authenticate);
  r.get('/count', async (req, res) => sendData(res, await svc.unreadCount(req.auth!)));
  const filters = ['ALL', 'UNREAD', ...Object.keys(svc.NOTIFICATION_FILTERS)] as [string, ...string[]];
  r.get('/', validate({ query: z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(30), filter: z.enum(filters).optional() }) }), async (req, res) =>
    sendData(res, await svc.list(req.auth!, { before: req.query.before ? new Date(String(req.query.before)) : undefined, limit: Number(req.query.limit ?? 30), filter: req.query.filter as svc.NotificationFilter | undefined })));
  r.post('/read-all', async (req, res) => sendData(res, await svc.readAll(req.auth!)));
  r.post('/:id/open', validate({ params: z.object({ id: z.string().regex(/^ntf_[a-f0-9]{28}$/) }) }), async (req, res) =>
    sendData(res, await svc.open(req.auth!, String(req.params.id))));
  return r;
}