import { existsSync } from 'node:fs';
import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** A 32-byte key given as base64 (generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"). */
const key32 = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded');

/**
 * Infrastructure settings only. Business numbers (OTP length, session limits, page size…) are CFG
 * values (Section 3.4) and live in src/config/cfg.ts, never here.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.string().default('/v1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  MONGO_URI: z.string().min(1),
  // Multi-record writes (P-01, P-14, P-19 …) run in one transaction when MongoDB is a replica set.
  // A standalone server (typical local install) falls back to ordered writes; production refuses to start.
  MONGO_REQUIRE_TRANSACTIONS: bool.optional(),
  REDIS_CACHE_URL: z.string().min(1),
  REDIS_QUEUE_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_ISSUER: z.string().default('bimayantra-api'),
  JWT_AUDIENCE: z.string().default('bimayantra-clients'),

  // Web sessions travel in HttpOnly cookies (P-02 backend rules). Secure must be true outside local development.
  COOKIE_SECURE: bool.default('true'),
  COOKIE_DOMAIN: z.string().optional(),

  // OTP hashing pepper and PAN/Aadhaar field encryption (NFR-07). In production these come from the
  // managed key service; the env var is how the key reaches the process.
  OTP_PEPPER: z.string().min(32),
  PII_ENCRYPTION_KEY: key32,
  PII_HASH_KEY: key32,

  // SMS provider for OTP. 'dev' keeps messages in a test inbox (non-production only); 'msg91' is the
  // confirmed provider (Section 1.2) and needs its DLT template and credentials.
  SMS_PROVIDER: z.enum(['dev', 'msg91']).default('dev'),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_OTP_TEMPLATE_ID: z.string().optional(),
  /** Optional DLT SMS template (variables masked_mobile, support) for the "your login number changed" notice. */
  MSG91_MOBILE_CHANGED_TEMPLATE_ID: z.string().optional(),
  /** WhatsApp (WHATSAPP_PROVIDER=msg91): SkyUp's integrated number with country code, e.g. 919876543210. */
  MSG91_WA_NUMBER: z.string().optional(),
  /** Secret path part for MSG91's webhook: POST /v1/webhooks/msg91/<MSG91_WEBHOOK_TOKEN>. */
  MSG91_WEBHOOK_TOKEN: z.string().min(24).optional(),

  // Communications (Section 15). 'dev' keeps messages in a test inbox and simulates provider callbacks (non-production
  // only). Real providers plug in behind the same interface. Webhooks are signed with WEBHOOK_SECRET (HMAC-SHA256).
  WHATSAPP_PROVIDER: z.enum(['dev', 'msg91']).default('dev'),
  // Email: 'brevo' = Brevo transactional email (modules/comms/brevo.ts). Delivery events: POST /v1/webhooks/brevo/<BREVO_WEBHOOK_TOKEN>
  EMAIL_PROVIDER: z.enum(['dev', 'brevo']).default('dev'),
  BREVO_API_KEY: z.string().optional(),
  BREVO_WEBHOOK_TOKEN: z.string().min(24).optional(),
  EMAIL_FROM_ADDRESS: z.string().email().optional(),
  EMAIL_FROM_NAME: z.string().default('Bimayantra'),
  EMAIL_REPLY_TO: z.string().email().optional(),
  // Payments: 'razorpay' = Razorpay Checkout for plan purchases and wallet recharges (lib/razorpay.ts).
  // Webhook: POST /v1/webhooks/razorpay (events payment.captured, payment.failed), signed with RAZORPAY_WEBHOOK_SECRET.
  PAYMENT_GATEWAY: z.enum(['dev', 'razorpay']).default('dev'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  /** Shown at the top of Razorpay Checkout. */
  PAYMENT_DISPLAY_NAME: z.string().default('Bimayantra'),
  WEBHOOK_SECRET: z.string().min(16).default('dev-webhook-secret-change-me'),
  /** Where people open shared links (/q, /c, /r, /forms) and where ad platforms send sign-in callbacks and leads. */
  PUBLIC_APP_URL: z.string().url().default('http://localhost:5173'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),

  // Test tools: SMS inbox, test clock, configuration overrides (NFR-13). Never on in production.
  DEV_TOOLS: bool.default('false'),
  // Private file storage (KYC documents, photos, logos, PDFs).
  //   local      = files on this server's disk; development only.
  //   cloudinary = Cloudinary "authenticated" (private) raw assets. Decision Q29: Cloudinary for all files,
  //                pending confirmation that storage is in India and legal review (IRDAI CS Guidelines 2023).
  FILE_STORAGE: z.enum(['local', 'cloudinary']).default('local'),
  FILE_STORAGE_DIR: z.string().default('./storage'),
  /** P-18 automatic reading of Aadhaar, PAN and old policies.
   *  none   = the check screen opens empty for manual entry (the BPD's DOC-10 fallback).
   *  google = Google Document AI, plain OCR processor (not a generative-AI extractor: P-18 forbids sending PAN and
   *           Aadhaar in AI requests); the fields are found by our own code (parsers.ts). Use location asia-south1. */
  DOCUMENT_READER: z.enum(['none', 'google']).default('none'),
  DOCUMENT_AI_PROJECT_ID: z.string().optional(),
  DOCUMENT_AI_LOCATION: z.string().regex(/^[a-z0-9-]+$/).default('asia-south1'),
  // Empty in .env (as shipped in .env.example) means "not set".
  DOCUMENT_AI_PROCESSOR_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^[a-z0-9]+$/).optional()),
  /** Path to the service-account key file. Without it, Google's standard GOOGLE_APPLICATION_CREDENTIALS is used. */
  DOCUMENT_AI_KEY_FILE: z.string().optional(),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  /** Folder inside the Cloudinary account; keep development and production apart. */
  CLOUDINARY_FOLDER: z.string().regex(/^[a-z0-9_/-]+$/).default('bimayantra-dev'),
  /** Regional API host if Cloudinary assigns one (for example https://api-ap.cloudinary.com). */
  CLOUDINARY_UPLOAD_PREFIX: z.string().url().optional(),

  TERMS_VERSION: z.string().default('2026-10-v1'),
  SUPPORT_EMAIL: z.string().email().default('support@bimayantra.in'),

  CORS_ORIGINS: csv,
  REQUEST_BODY_LIMIT: z.string().default('100kb'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast at boot: a misconfigured API must never start serving traffic.
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const e = parsed.data;
const fatal = (msg: string) => {
  console.error(msg);
  process.exit(1);
};
if (e.JWT_ACCESS_SECRET === e.JWT_REFRESH_SECRET) fatal('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different.');
if (e.PII_ENCRYPTION_KEY === e.PII_HASH_KEY) fatal('PII_ENCRYPTION_KEY and PII_HASH_KEY must be different.');
if (e.DOCUMENT_READER === 'google') {
  if (!(e.DOCUMENT_AI_PROJECT_ID && e.DOCUMENT_AI_PROCESSOR_ID)) fatal('DOCUMENT_READER=google needs DOCUMENT_AI_PROJECT_ID and DOCUMENT_AI_PROCESSOR_ID.');
  // Without credentials Google's library fails in a background promise at the first upload. Refuse to start instead.
  const keyFile = e.DOCUMENT_AI_KEY_FILE ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyFile) fatal('DOCUMENT_READER=google needs DOCUMENT_AI_KEY_FILE: the path to the Document AI service-account key (.json).');
  else if (!existsSync(keyFile)) fatal(`DOCUMENT_AI_KEY_FILE not found: ${keyFile}`);
}
if (e.FILE_STORAGE === 'cloudinary' && !(e.CLOUDINARY_CLOUD_NAME && e.CLOUDINARY_API_KEY && e.CLOUDINARY_API_SECRET)) {
  fatal('FILE_STORAGE=cloudinary needs CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.');
}
if (e.SMS_PROVIDER === 'msg91' && !(e.MSG91_AUTH_KEY && e.MSG91_OTP_TEMPLATE_ID)) {
  fatal('SMS_PROVIDER=msg91 needs MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID (the DLT-approved OTP template in MSG91).');
}
if (e.WHATSAPP_PROVIDER === 'msg91' && !(e.MSG91_AUTH_KEY && e.MSG91_WA_NUMBER && e.MSG91_WEBHOOK_TOKEN)) {
  fatal('WHATSAPP_PROVIDER=msg91 needs MSG91_AUTH_KEY, MSG91_WA_NUMBER (the integrated WhatsApp number) and MSG91_WEBHOOK_TOKEN (24+ random characters).');
}
if (e.EMAIL_PROVIDER === 'brevo' && !(e.BREVO_API_KEY && e.EMAIL_FROM_ADDRESS && e.BREVO_WEBHOOK_TOKEN)) {
  fatal('EMAIL_PROVIDER=brevo needs BREVO_API_KEY, EMAIL_FROM_ADDRESS (a sender verified in Brevo) and BREVO_WEBHOOK_TOKEN (24+ random characters).');
}
if (e.PAYMENT_GATEWAY === 'razorpay' && !(e.RAZORPAY_KEY_ID && e.RAZORPAY_KEY_SECRET && e.RAZORPAY_WEBHOOK_SECRET)) {
  fatal('PAYMENT_GATEWAY=razorpay needs RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET.');
}
if (e.NODE_ENV === 'production') {
  if (e.PAYMENT_GATEWAY === 'razorpay' && e.RAZORPAY_KEY_ID?.startsWith('rzp_test_')) fatal('RAZORPAY_KEY_ID is a test key (rzp_test_…); use the live key in production.');
  if (e.SMS_PROVIDER === 'dev') fatal('SMS_PROVIDER=dev is not allowed in production.');
  if (e.WHATSAPP_PROVIDER === 'dev' || e.EMAIL_PROVIDER === 'dev' || e.PAYMENT_GATEWAY === 'dev') fatal('WHATSAPP_PROVIDER, EMAIL_PROVIDER and PAYMENT_GATEWAY must be real providers in production.');
  if (e.WEBHOOK_SECRET === 'dev-webhook-secret-change-me') fatal('Set WEBHOOK_SECRET in production.');
  if (e.DEV_TOOLS) fatal('DEV_TOOLS must be false in production.');
  if (e.FILE_STORAGE === 'local') fatal('FILE_STORAGE=local keeps files on one server disk and is not allowed in production. Use FILE_STORAGE=cloudinary.');
  if (e.CLOUDINARY_FOLDER.endsWith('-dev')) fatal('CLOUDINARY_FOLDER must be a production folder (not "-dev") in production.');
  if (!e.COOKIE_SECURE) fatal('COOKIE_SECURE must be true in production.');
  // Shared quotation, comparison, referral and form links, and the Meta/LinkedIn/Google callbacks, use these: a
  // missing value would send customers and ad platforms to localhost.
  for (const [k, v] of [['PUBLIC_APP_URL', e.PUBLIC_APP_URL], ['PUBLIC_API_URL', e.PUBLIC_API_URL]] as const) {
    if (!v.startsWith('https://') || /localhost|127\.0\.0\.1/.test(v)) fatal(`${k} must be the public https:// address in production.`);
  }
  if (e.CORS_ORIGINS.some((o: string) => /localhost|127\.0\.0\.1/.test(o) || !o.startsWith('https://'))) fatal('CORS_ORIGINS must list only the public https:// web address(es) in production.');
}

export const env = { ...e, MONGO_REQUIRE_TRANSACTIONS: e.MONGO_REQUIRE_TRANSACTIONS ?? e.NODE_ENV === 'production' };
export type Env = typeof env;