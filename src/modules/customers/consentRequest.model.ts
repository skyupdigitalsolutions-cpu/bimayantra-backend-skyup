import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';
import { protect } from '../../lib/pii.js';
import { CONSENT_CHANNELS } from './customer.model.js';

/** How the request reaches the person: email is sent by Bimayantra; WhatsApp and Telegram from the advisor's own app. */
export const REQUEST_VIA = ['EMAIL', 'WHATSAPP', 'TELEGRAM'] as const;
export type RequestVia = (typeof REQUEST_VIA)[number];
export const REQUEST_STATUSES = ['PENDING', 'CONFIRMED', 'DECLINED', 'CANCELLED', 'EXPIRED'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/**
 * Consent request: the advisor asks one person (the customer or an active family member) for consent on one or more
 * channels; the person confirms or declines on the public page /consent/<token>. Only a hash of the token is stored,
 * so the link cannot be rebuilt from the database. PENDING → CONFIRMED | DECLINED | CANCELLED (advisor) | EXPIRED.
 * Expiry is also read from expiresAt, so no job is needed for it.
 *
 * contacts keeps the mobile and email the request was made for: consent belongs to the exact mobile or email (P-15),
 * so a link stops working when that contact changes before the person answers.
 */
const consentRequestSchema = new Schema(
  {
    _id: { type: String, default: () => newId('crq') },
    accountId: { type: String, required: true },
    customerId: { type: String, required: true },
    personType: { type: String, enum: ['CUSTOMER', 'FAMILY'], required: true },
    personId: { type: String, required: true },
    personKey: { type: String, required: true }, // C:<customer id> or F:<family member id>
    channels: { type: [{ type: String, enum: CONSENT_CHANNELS }], required: true },
    via: { type: String, enum: REQUEST_VIA, required: true },
    sentTo: { type: String, default: null }, // the email it was sent to, or the mobile for WhatsApp; null for Telegram
    contacts: { mobile: { type: String, default: null }, email: { type: String, default: null } },
    tokenHash: { type: String, required: true },
    status: { type: String, enum: REQUEST_STATUSES, default: 'PENDING' },
    expiresAt: { type: Date, required: true },
    outboxId: { type: String, default: null }, // the email, when sent by Bimayantra
    openedAt: { type: Date, default: null }, // first time the link was opened
    respondedAt: { type: Date, default: null },
    given: { type: [String], default: [] },
    declined: { type: [String], default: [] },
    closedReason: { type: String, default: null },
    createdBy: { type: String, required: true },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
consentRequestSchema.index({ tokenHash: 1 }, { unique: true });
consentRequestSchema.index({ accountId: 1, customerId: 1, createdAt: -1 });
consentRequestSchema.index({ accountId: 1, personKey: 1, createdAt: -1 });

export type ConsentRequestDoc = InferSchemaType<typeof consentRequestSchema> & { _id: string; createdAt: Date; updatedAt: Date };
export const ConsentRequest = model('ConsentRequest', consentRequestSchema, 'consent_requests');
/** The address it went to and the contacts it was made for name the person: encrypted (lib/pii.ts). */
protect(ConsentRequest, { fields: { sentTo: 'contact', 'contacts.mobile': 'contact', 'contacts.email': 'contact' } });