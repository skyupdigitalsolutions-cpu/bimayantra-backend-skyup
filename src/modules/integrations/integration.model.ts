import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * An advisor's own messaging account (Settings → Integrations): MSG91 for WhatsApp, Brevo for email.
 * One per account and provider. With one, that channel's messages go through the advisor's account and are billed by
 * the provider (no Bimayantra wallet); without one, Bimayantra's own providers send as before.
 *
 *  - The key is encrypted (AES-256-GCM, lib/crypto.ts) and never sent back: only its last 4 characters.
 *  - The webhook token is the secret part of this account's own delivery-report address
 *    (/v1/webhooks/msg91/<token>, /v1/webhooks/brevo/<token>); looked up by its keyed hash, shown again from the
 *    encrypted copy so the advisor can copy it any time.
 *  - config: MSG91 { waNumber, namespace } · Brevo { fromEmail, fromName, replyTo } (encrypted as a whole).
 */
export const PROVIDERS = ['MSG91', 'BREVO'] as const;
export type Provider = (typeof PROVIDERS)[number];

const integrationSchema = new Schema(
  {
    _id: { type: String, default: () => newId('int') },
    accountId: { type: String, required: true },
    provider: { type: String, enum: PROVIDERS, required: true },
    status: { type: String, enum: ['ACTIVE', 'ERROR'], default: 'ACTIVE' },
    secretEnc: { type: String, required: true },
    keyLast4: { type: String, required: true },
    /** JSON of the config, encrypted (lib/crypto.ts encryptField). */
    configEnc: { type: String, required: true },
    webhookTokenHash: { type: String, required: true },
    webhookTokenEnc: { type: String, required: true },
    lastCheckedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    connectedBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, minimize: false },
);
integrationSchema.index({ accountId: 1, provider: 1 }, { unique: true, name: 'one_per_account_provider' });
integrationSchema.index({ webhookTokenHash: 1 }, { unique: true });
export type IntegrationDoc = InferSchemaType<typeof integrationSchema> & { _id: string; createdAt: Date; updatedAt: Date };
export const Integration = model('Integration', integrationSchema, 'integrations');