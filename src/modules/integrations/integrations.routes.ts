import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { sendData, sendDone } from '../../lib/response.js';
import * as svc from './integrations.service.js';

const provider = z.object({ provider: z.enum(['msg91', 'brevo']) });
const optText = (max: number) => z.string().trim().max(max).optional().nullable();
// One body for both providers: the service reads the fields of the provider in the path.
const connectBody = z.object({
  authKey: optText(200), waNumber: optText(20), namespace: optText(100),
  apiKey: optText(200), fromEmail: z.string().trim().email().max(120).optional(), fromName: optText(80),
  replyTo: z.union([z.string().trim().email().max(120), z.literal(''), z.null()]).optional(),
}).strict();

/** Settings → Integrations: the advisor's own MSG91 (WhatsApp) and Brevo (email) accounts. */
export function integrationRoutes() {
  const r = Router();
  r.use(authenticate, allow('integrations.manage'));
  r.get('/', async (req, res) => sendData(res, await svc.list(req.auth!)));
  r.get('/msg91/templates', async (req, res) => sendData(res, await svc.ownTemplates(req.auth!)));
  r.put('/:provider', writable, validate({ params: provider, body: connectBody }, { authKey: 'MSG91 auth key', waNumber: 'WhatsApp number', apiKey: 'Brevo API key', fromEmail: 'Sender email', fromName: 'Sender name', replyTo: 'Reply-to email' }), async (req, res) => {
    const key = String(req.params.provider) as svc.ProviderKey;
    if (key === 'brevo' && !req.body.fromName) {
      const { AppError } = await import('../../lib/errors.js');
      throw AppError.field('fromName', 'GEN-01', { 'Field label': 'Sender name' });
    }
    if (key === 'brevo' && !req.body.fromEmail) {
      const { AppError } = await import('../../lib/errors.js');
      throw AppError.field('fromEmail', 'GEN-01', { 'Field label': 'Sender email' });
    }
    const out = await svc.connect(req.auth!, key, req.body, req);
    sendDone(res, out.conn, out.messageId, out.params);
  });
  r.post('/:provider/test', validate({ params: provider }), async (req, res) => {
    const out = await svc.test(req.auth!, String(req.params.provider) as svc.ProviderKey, req);
    sendDone(res, out.conn, out.messageId, out.params);
  });
  r.delete('/:provider', writable, validate({ params: provider }), async (req, res) => {
    const out = await svc.disconnect(req.auth!, String(req.params.provider) as svc.ProviderKey, req);
    sendDone(res, { provider: out.provider }, out.messageId, out.params);
  });
  return r;
}