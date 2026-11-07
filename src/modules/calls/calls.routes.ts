import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { cfgNum } from '../../config/cfg.js';
import { AppError } from '../../lib/errors.js';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { sendData, sendDone } from '../../lib/response.js';
import { audit } from '../audit/audit.service.js';
import * as svc from './calls.service.js';

/** The mobile app's multipart upload: memory only, size limited, one file field `recording`. */
function recordingUpload(req: Request, res: Response, next: NextFunction) {
  multer({ storage: multer.memoryStorage(), limits: { fileSize: cfgNum('CFG-192') * 1024 * 1024 + 1, files: 1, fields: 10 } }).single('recording')(req, res, (err: unknown) => {
    if (!err) return next();
    if ((err as { code?: string }).code === 'LIMIT_FILE_SIZE') return next(AppError.field('recording', 'CALL-03', { 'CFG-192': cfgNum('CFG-192') }));
    return next(AppError.field('recording', 'CALL-02'));
  });
}

const log = z.object({
  phoneNumber: z.string().max(40), callType: z.string().max(20).optional(), duration: z.coerce.number().min(0).max(86_400).optional(),
  timestamp: z.union([z.number(), z.string().max(40)]), name: z.string().max(200).optional(), leadId: z.string().max(40).nullable().optional(),
}).passthrough();

/** Calls and recordings (mobile app, and the web app on iPhone). Mounted at /call-logs. */
export function callRoutes() {
  const r = Router();
  r.use(authenticate);
  r.post('/sync', allow('calls.sync'), writable, validate({ body: z.object({ logs: z.array(log).min(1).max(2000) }).passthrough() }), async (req, res) =>
    sendData(res, await svc.sync(req.auth!, req.body.logs, req)));
  r.post('/app-call', allow('calls.sync'), writable, validate({ body: z.object({ phoneNumber: z.string().max(40), leadId: z.string().max(40).nullable().optional(), customerId: z.string().max(40).nullable().optional(), startedAt: z.union([z.number(), z.string().max(40)]), returnedAt: z.union([z.number(), z.string().max(40)]).nullable().optional() }).strict() }), async (req, res) =>
    sendData(res, await svc.appCall(req.auth!, req.body, req), 201));
  r.post('/recording', allow('calls.sync'), writable, recordingUpload, async (req, res) => {
    const file = (req as Request & { file?: { buffer: Buffer; originalname: string } }).file;
    if (!file) throw AppError.field('recording', 'GEN-01', { 'Field label': 'Recording' });
    const b = req.body as Record<string, string>;
    const out = await svc.attachRecording(req.auth!, { bytes: file.buffer, originalName: file.originalname }, { phoneNumber: b.phoneNumber ?? '', timestamp: b.timestamp, fileKey: b.fileKey, leadId: b.leadId, customerId: b.customerId, source: b.source }, req);
    if (out.stored && !out.duplicate) return sendDone(res, out, 'CALL-01', (out as { params?: Record<string, string> }).params ?? {}, 201);
    sendData(res, out, 200);
  });
  r.get('/match', allow('calls.view'), validate({ query: z.object({ phone: z.string().max(40) }) }), async (req, res) => sendData(res, await svc.match(req.auth!, String(req.query.phone))));
  r.get('/today', allow('calls.view'), async (req, res) => sendData(res, await svc.list(req.auth!, {})));
  r.get('/lead/:leadId', allow('calls.view'), validate({ params: z.object({ leadId: z.string().regex(/^led_[a-f0-9]{28}$/) }) }), async (req, res) => sendData(res, await svc.list(req.auth!, { leadId: String(req.params.leadId) })));
  r.get('/', allow('calls.view'), validate({ query: z.object({ leadId: z.string().max(40).optional(), customerId: z.string().max(40).optional(), date: z.string().max(10).optional() }) }), async (req, res) =>
    sendData(res, await svc.list(req.auth!, req.query as Record<string, string>)));
  /** Playback with Range support, so the player can seek; the advisor only. */
  r.get('/:id/recordings/:recId/audio', allow('calls.listen'), validate({ params: z.object({ id: z.string().regex(/^cll_[a-f0-9]{28}$/), recId: z.string().regex(/^rec_[a-f0-9]{28}$/) }) }), async (req, res) => {
    const { bytes, mime, name } = await svc.recordingFile(req.auth!, String(req.params.id), String(req.params.recId), req);
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${name.replace(/"/g, '')}"`);
    if (!range || range[1] === '0' || (!range[1] && !range[2])) await audit({ entity: 'call', entityId: String(req.params.id), action: 'CALL_RECORDING_PLAYED' }, { req });
    if (!range) { res.setHeader('Content-Length', String(bytes.length)); return void res.end(bytes); }
    const size = bytes.length;
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    if (!range[1]) end = size - 1;
    if (start < 0) start = 0;
    if (start >= size || end < start) { res.status(416).setHeader('Content-Range', `bytes */${size}`); return void res.end(); }
    end = Math.min(end, size - 1);
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    res.end(bytes.subarray(start, end + 1));
  });
  return r;
}