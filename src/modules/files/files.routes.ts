import express, { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { cfgNum } from '../../config/cfg.js';
import { sendData } from '../../lib/response.js';
import { AppError } from '../../lib/errors.js';
import { FILE_PURPOSES } from './file.model.js';
import type { Capability } from '../rbac/capabilities.js';
import * as files from './files.service.js';

/**
 * POST /v1/files?purpose=KYC_PAN   body = the raw file bytes, header X-File-Name = original name.
 * GET  /v1/files/:id               the file, only to those allowed to open it.
 * One file per request, so CFG-28 (files per upload) is a screen rule: the screen sends them one by one.
 */
const UPLOAD_CAPABILITY = {
  PROFILE_PHOTO: 'profile.manage', BUSINESS_LOGO: 'profile.manage', KYC_PAN: 'profile.manage', KYC_LICENCE: 'profile.manage',
  APPOINTMENT_LETTER: 'insurers.manage',
  CUSTOMER_DOCUMENT: 'documents.work', // P-18: advisors AND assistants
  BROCHURE: 'brochure.upload', // P-22 own products (ADV); P-23 OCR and P-58 attachments
  QUOTATION_PDF: 'files.system',
  POLICY_DOCUMENT: 'policies.manage',
  ACCOUNT_EXPORT: 'files.system',
  CALL_RECORDING: 'files.system', // uploaded only through /call-logs/recording (multipart, content-checked) // built by the server (P-52); never uploaded // P-33 policy PDF, P-35 endorsement documents // built by the server on Generate (P-27); never uploaded
} as const satisfies Record<(typeof FILE_PURPOSES)[number], Capability>;

/**
 * B-08: HTTP headers carry ASCII only, so the screen percent-encodes a name with other characters (राहुल.pdf →
 * %E0%A4%B0…). A name that is not valid percent-encoding is used as sent. Path parts are dropped by the upload.
 */
export function fileNameHeader(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (!/%[0-9A-Fa-f]{2}/.test(raw)) return raw;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

export function fileRoutes() {
  const r = Router();
  r.use(authenticate);
  const maxBytes = () => Math.max(cfgNum('CFG-27'), cfgNum('CFG-127'), cfgNum('CFG-29')) * 1024 * 1024 + 1;
  r.post('/', validate({ query: z.object({ purpose: z.enum(FILE_PURPOSES) }) }),
    // Who may upload depends on what the file is for: the capability of the screen it belongs to.
    (req, res, next) => allow(UPLOAD_CAPABILITY[String(req.query.purpose) as (typeof FILE_PURPOSES)[number]])(req, res, next),
    writable,
    (req, res, next) => express.raw({ type: () => true, limit: maxBytes() })(req, res, (e?: unknown) => {
      if ((e as { type?: string } | undefined)?.type === 'entity.too.large') return next(AppError.field('file', 'VAL-24', { 'size limit': cfgNum('CFG-27') }));
      next(e);
    }),
    async (req, res) => {
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const purpose = String(req.query.purpose) as (typeof FILE_PURPOSES)[number];
      sendData(res, await files.upload(req.auth!, purpose, bytes, fileNameHeader(req.get('x-file-name')), req), 201);
    });
  r.get('/:id', validate({ params: z.object({ id: z.string().regex(/^fil_[a-f0-9]{28}$/) }) }), async (req, res) => {
    const { file, bytes } = await files.open(req.auth!, String(req.params.id), req);
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', `inline; filename="${file.name.replace(/"/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(bytes);
  });
  return r;
}