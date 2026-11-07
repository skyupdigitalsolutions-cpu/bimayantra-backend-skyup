import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

const ENC_KEY = Buffer.from(env.PII_ENCRYPTION_KEY, 'base64');
const HASH_KEY = Buffer.from(env.PII_HASH_KEY, 'base64');

/**
 * PAN and Aadhaar field encryption (GR-36, NFR-07): AES-256-GCM, a fresh IV per value, stored as
 * "v1:iv:tag:ciphertext". The "v1" prefix lets the key be rotated later (managed key service).
 */
export function encryptField(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptField(stored: string): string {
  const [ver, iv, tag, ct] = stored.split(':');
  if (ver !== 'v1' || !iv || !tag || !ct) throw new Error('Unknown encrypted field format');
  const decipher = createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

/** Keyed hash to find an equal PAN (CU-29) without decrypting anything. */
export const lookupHash = (value: string) => createHmac('sha256', HASH_KEY).update(value).digest('hex');

/** OTPs are stored only as a salted, peppered hash (P-01 backend rules). */
export const otpHash = (code: string, salt: string) => createHmac('sha256', env.OTP_PEPPER).update(`${salt}:${code}`).digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const newSalt = () => randomBytes(16).toString('hex');
export const otpCode = (length: number) => Array.from({ length }, () => randomInt(0, 10)).join('');
