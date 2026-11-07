import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { cfgList, cfgNum } from '../../config/cfg.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../audit/audit.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { IMAGE_PURPOSES, KYC_PURPOSES, StoredFile, type FileDoc, type FilePurpose } from './file.model.js';
import { logger } from '../../lib/logger.js';
import { cloudinaryStorage, localStorage, storage } from './storage.js';

const backendOf = (name: string | null | undefined) => (name === 'cloudinary' ? cloudinaryStorage : localStorage);

type Detected = { type: 'PDF' | 'JPG' | 'PNG' | 'ZIP' | 'AUDIO'; mime: string };

/** Call recordings: the audio format from the file's own bytes, never the name or the declared type. */
export function detectAudio(b: Buffer): { ext: string; mime: string } | null {
  if (b.length < 12) return null;
  const head = (n: number, at = 0) => b.subarray(at, at + n).toString('latin1');
  if (head(3) === 'ID3') return { ext: 'mp3', mime: 'audio/mpeg' };
  if (head(4, 4) === 'ftyp') { const brand = head(4, 8).toLowerCase(); return brand.startsWith('3g') ? { ext: '3gp', mime: 'audio/3gpp' } : { ext: 'm4a', mime: 'audio/mp4' }; }
  if (head(5) === '#!AMR') return { ext: 'amr', mime: 'audio/amr' };
  if (head(4) === 'RIFF' && head(4, 8) === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
  if (head(4) === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
  if (b[0] === 0xff && (b[1]! & 0xf6) === 0xf0) return { ext: 'aac', mime: 'audio/aac' }; // ADTS AAC
  if (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return { ext: 'mp3', mime: 'audio/mpeg' }; // MPEG audio frame
  return null;
}

/** Files only the server writes (exports, recordings): content already checked by the caller. */
export async function storeServerFile(ctx: AuthContext, purpose: FilePurpose, bytes: Buffer, name: string, type: Detected['type'], mime: string) {
  const ownerKey = ownerOf(ctx);
  if (!ownerKey) throw AppError.forbidden();
  const rec = new StoredFile({ accountId: ownerKey, uploadedBy: ctx.userId, purpose, type, mime, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), name: name.replace(/[^\w.-]/g, '_').slice(0, 120) || 'file', storageKey: 'pending' });
  rec.storageKey = `${ownerKey.toLowerCase()}/${rec._id}`;
  await storage.put(rec.storageKey, bytes);
  await rec.save();
  return { id: rec._id as string, type, size: bytes.length, name: rec.name };
}

/** FLD-22 "checked by content": the type comes from the bytes, never from the name or the browser. */
export function detectType(b: Buffer): Detected | null {
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return { type: 'PDF', mime: 'application/pdf' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'JPG', mime: 'image/jpeg' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'PNG', mime: 'image/png' };
  return null;
}

/** VAL-26: the file must open — complete structure, and a PDF must not be password-protected. */
export function opensCleanly(b: Buffer, type: Detected['type']): boolean {
  if (type === 'PDF') {
    const tail = b.subarray(Math.max(0, b.length - 2048)).toString('latin1');
    if (!tail.includes('%%EOF')) return false; // truncated or damaged
    return !/\/Encrypt\b/.test(b.toString('latin1')); // password-protected
  }
  if (type === 'JPG') return b.length > 4 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;
  // PNG: must end with the IEND chunk
  return b.length > 12 && b.subarray(b.length - 12, b.length - 4).toString('latin1').endsWith('IEND');
}

/** "JPG, JPEG, PNG" in the settings → the content types they allow. JPEG is the same content as JPG. */
const allowedTypes = (list: string[]) => new Set(list.map((t) => (t.toUpperCase() === 'JPEG' ? 'JPG' : t.toUpperCase())));

function cleanName(raw: string | undefined, type: string) {
  // B-08: letters and digits of any script are kept (राहुल.pdf); path separators, control characters and symbols are dropped.
  const base = (raw ?? '').normalize('NFC').replace(/[^\p{L}\p{N}\p{M}_.\- ]+/gu, '').trim().slice(0, 120);
  return base || `file.${type.toLowerCase()}`;
}

/**
 * Upload one file (FLD-22). Who may upload which purpose is decided by the route's capability.
 * Order of checks follows the user's fix order: type (VAL-23), size (VAL-24), opens (VAL-26).
 * VAL-27 (security scan) needs a scanning service: OPEN-QUESTIONS Q27.
 */
/** Who owns a file: the advisor's account, or 'SKYUP' for files SkyUp Staff and Admins upload (brochures, P-23). */
export const ownerOf = (ctx: AuthContext) => ctx.accountId ?? (ctx.role === 'STF' || ctx.role === 'ADM' ? 'SKYUP' : null);

export async function upload(ctx: AuthContext, purpose: FilePurpose, bytes: Buffer, fileName: string | undefined, req: Request) {
  const ownerKey = ownerOf(ctx);
  if (!ownerKey) throw AppError.forbidden();
  const image = IMAGE_PURPOSES.includes(purpose);
  const list = cfgList(image ? 'CFG-126' : 'CFG-26');
  const maxMb = cfgNum(image ? 'CFG-127' : purpose === 'BROCHURE' ? 'CFG-29' : 'CFG-27'); // CFG-29: brochures

  // P-52: the server's own account export (a ZIP). Only the server writes this purpose (files.system); uploads never can.
  if (purpose === 'ACCOUNT_EXPORT') {
    if (!(bytes.length > 4 && bytes.readUInt32LE(0) === 0x04034b50)) throw AppError.field('file', 'VAL-26');
    return storeServerFile(ctx, purpose, bytes, fileName ?? 'export.zip', 'ZIP', 'application/zip');
  }
  const detected = detectType(bytes);
  if (!detected || !allowedTypes(list).has(detected.type)) {
    throw AppError.field('file', 'VAL-23', { 'allowed types': list.join(', ') });
  }
  if (bytes.length > maxMb * 1024 * 1024) throw AppError.field('file', 'VAL-24', { 'size limit': maxMb });
  if (bytes.length === 0 || !opensCleanly(bytes, detected.type)) throw AppError.field('file', 'VAL-26');

  const rec = new StoredFile({
    accountId: ownerKey, uploadedBy: ctx.userId, purpose, type: detected.type, mime: detected.mime, size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), name: cleanName(fileName, detected.type), storageKey: 'pending',
    backend: storage.name,
  });
  rec.storageKey = `${ownerKey.toLowerCase()}/${rec._id}`; // keys are lowercase (storage.ts checkKey)
  await storage.put(rec.storageKey, bytes); // bytes first: a record never points at a missing file
  await rec.save();
  await audit({ entity: 'file', entityId: rec._id, action: 'FILE_UPLOADED', after: { purpose, type: rec.type, size: rec.size } }, { req });
  return view(rec.toObject() as FileDoc);
}

export const view = (f: FileDoc) => ({ id: f._id, purpose: f.purpose, type: f.type, size: f.size, name: f.name, uploadedAt: f.createdAt });

/**
 * Who can open a file (P-06 backend rule, GR-20):
 *  - the owner account's advisor (and assistants, for photos and logos only);
 *  - SkyUp reviewers (STF, ADM) for KYC files only, and each view is audited.
 * Everyone else gets GEN-11, never revealing that the file exists.
 */
export async function open(ctx: AuthContext, id: string, req: Request) {
  const f = await StoredFile.findById(id).lean<FileDoc>();
  const kyc = !!f && KYC_PURPOSES.includes(f.purpose as FilePurpose);
  const advisorOnly = !!f && f.purpose === 'CALL_RECORDING';
  const owner = !!f && f.accountId === ownerOf(ctx) && (ctx.role === 'ADV' || (ctx.role === 'AST' && !kyc && !advisorOnly) || f.accountId === 'SKYUP');
  const reviewer = !!f && kyc && (ctx.role === 'STF' || ctx.role === 'ADM');
  if (!f || !(owner || reviewer)) throw AppError.notFound();
  if (reviewer) await audit({ entity: 'file', entityId: f._id, action: 'KYC_FILE_VIEWED', after: { accountId: f.accountId, purpose: f.purpose } }, { req });
  const bytes = await backendOf(f.backend).get(f.storageKey);
  // Tamper check: the bytes must be exactly what was uploaded (Cloudinary has no object lock).
  if (createHash('sha256').update(bytes).digest('hex') !== f.sha256) {
    logger.error({ fileId: f._id, backend: f.backend }, 'Stored file does not match its recorded SHA-256: possible tampering');
    await audit({ entity: 'file', entityId: f._id, action: 'FILE_INTEGRITY_FAILED', result: 'REFUSED', after: { backend: f.backend } }, { req });
    throw new Error(`File ${f._id} failed its integrity check`); // → GEN-99 with a reference
  }
  return { file: f, bytes };
}

/** A file the advisor's account owns, with the expected purpose (used when a form references a file id). */
export async function assertOwnFile(ctx: AuthContext, id: string, purpose: FilePurpose, field: string) {
  const f = await StoredFile.findOne({ _id: id, accountId: ownerOf(ctx), purpose }, { _id: 1 }).lean();
  if (!f) throw AppError.field(field, 'VAL-22');
}