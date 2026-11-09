import { protect } from '../../lib/pii.js';
import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * Outgoing messages (Section 15). Every automated or shared message is a row here. The occurrence key is a database
 * unique rule, so a repeated job does nothing (GR-28). Status only moves forward: QUEUED → SENT → DELIVERED → READ, or
 * SKIPPED / FAILED / CANCELLED with a reason; SENT with no update after CFG-71 becomes STATUS_UNKNOWN.
 */
export const PURPOSES = ['LEAD_WELCOME', 'FOLLOW_UP', 'RENEWAL_REMINDER', 'QUOTATION_EMAIL', 'BIRTHDAY', 'FAMILY_BIRTHDAY', 'ANNIVERSARY', 'KYC_RESULT', 'SUBSCRIPTION'] as const;
const outboxSchema = new Schema(
  {
    _id: { type: String, default: () => newId('msg') },
    accountId: { type: String, required: true },
    customerId: { type: String, default: null },
    personKey: { type: String, default: null }, // whose consent applies (C:… or F:…)
    channel: { type: String, enum: ['EMAIL', 'WHATSAPP'], required: true },
    purpose: { type: String, enum: [...PURPOSES], default: 'RENEWAL_REMINDER' },
    template: { type: String, required: true }, // template code (REN-T1, QT-EMAIL, …)
    templateId: { type: String, default: null }, templateVersion: { type: Number, default: null }, // as sent
    params: { type: Schema.Types.Mixed, default: {} },
    to: { type: String, required: true },
    subject: { type: String, default: null },
    text: { type: String, required: true },
    occurrenceKey: { type: String, required: true },
    status: { type: String, enum: ['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED', 'CANCELLED', 'STATUS_UNKNOWN'], default: 'QUEUED' },
    skipReason: { type: String, default: null }, // SKIPPED / FAILED / CANCELLED reason (AC-P43-1)
    providerMessageId: { type: String, default: null },
    attempts: { type: Number, default: 0 }, nextAttemptAt: { type: Date, default: null },
    sentAt: { type: Date, default: null }, statusAt: { type: Date, default: null },
    history: { type: [new Schema({ at: Date, status: String, note: { type: String, default: null } }, { _id: false })], default: [] },
    resendOf: { type: String, default: null }, resends: { type: Number, default: 0 },
    related: { type: Schema.Types.Mixed, default: null }, // { cycleId, policyId } or { quotationId, revision }
    day: { type: String, required: true }, // IST date it was queued (daily limits)
  },
  { timestamps: true, versionKey: false, minimize: false },
);
outboxSchema.index({ occurrenceKey: 1 }, { unique: true });
outboxSchema.index({ accountId: 1, day: 1, channel: 1 });
outboxSchema.index({ status: 1, 'related.cycleId': 1 });
outboxSchema.index({ status: 1, nextAttemptAt: 1 });
outboxSchema.index({ providerMessageId: 1 }, { sparse: true });
outboxSchema.index({ accountId: 1, createdAt: -1 });
export type OutboxDoc = InferSchemaType<typeof outboxSchema> & { _id: string; createdAt: Date };
export const Outbox = model('Outbox', outboxSchema, 'outbox');
/** Recipient, wording and template values name the person: encrypted (lib/pii.ts). */
protect(Outbox, { fields: { to: 'contact', subject: 'text', text: 'text', params: 'json' } });

/** P-39 message templates. Email: ACTIVE on approval. WhatsApp: ACTIVE only when Meta approves (AC-P39-1). */
const templateSchema = new Schema(
  {
    _id: { type: String, default: () => newId('tpl') },
    code: { type: String, required: true },
    name: { type: String, required: true },
    channel: { type: String, enum: ['EMAIL', 'WHATSAPP'], required: true },
    purpose: { type: String, enum: [...PURPOSES], required: true },
    language: { type: String, default: 'English' },
    subject: { type: String, default: null },
    body: { type: String, required: true },
    status: { type: String, enum: ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'INACTIVE'], default: 'DRAFT' },
    metaStatus: { type: String, enum: [null, 'SUBMITTED', 'APPROVED', 'REJECTED'], default: null },
    metaReason: { type: String, default: null },
    /** The name the template was submitted under at the WhatsApp provider (MSG91), used when sending. */
    providerTemplateName: { type: String, default: null },
    /** Meta's decision for that provider template: messages wait (stay QUEUED) until it is APPROVED. */
    providerStatus: { type: String, enum: [null, 'PENDING', 'APPROVED', 'REJECTED'], default: null },
    makerId: { type: String, required: true }, approverId: { type: String, default: null },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
/** One ACTIVE template per purpose, channel and language (COM-05). */
templateSchema.index({ purpose: 1, channel: 1, language: 1 }, { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'one_active_per_purpose' });
export type TemplateRow = InferSchemaType<typeof templateSchema> & { _id: string };
export const MessageTemplate = model('MessageTemplate', templateSchema, 'message_templates');

/** P-42: provider events are processed once each (by event ID). */
export const WebhookEvent = model('WebhookEvent', new Schema({ _id: String, source: String, at: Date }, { versionKey: false }), 'webhook_events');
/** P-42: a hard bounce stops further emails to that address (AC-P42-4). */
export const BouncedAddress = model('BouncedAddress', new Schema({ _id: String, at: Date, reason: String }, { versionKey: false }), 'bounced_addresses');
protect(BouncedAddress, { fields: { _id: 'key' } });

/** P-56 WhatsApp wallet transactions. A debit references its message (once each, AC-P56-1). */
const walletSchema = new Schema(
  {
    _id: { type: String, default: () => newId('wtx') },
    accountId: { type: String, required: true },
    type: { type: String, enum: ['RECHARGE', 'DEBIT', 'CREDIT'], required: true },
    amountPaise: { type: Number, required: true },
    status: { type: String, enum: ['PENDING', 'SUCCESS', 'FAILED'], default: 'SUCCESS' },
    messageId: { type: String, default: null }, gatewayPaymentId: { type: String, default: null },
    /** Razorpay order (order_…) for a recharge. */
    gatewayOrderId: { type: String, default: null },
    reason: { type: String, default: null }, by: { type: String, default: null }, balanceAfterPaise: { type: Number, default: null },
  },
  { timestamps: true, versionKey: false },
);
walletSchema.index({ messageId: 1 }, { unique: true, partialFilterExpression: { messageId: { $type: 'string' } }, name: 'one_debit_per_message' });
walletSchema.index({ gatewayPaymentId: 1 }, { unique: true, partialFilterExpression: { gatewayPaymentId: { $type: 'string' } }, name: 'one_credit_per_payment' });
walletSchema.index({ accountId: 1, createdAt: -1 });
export type WalletTxnDoc = InferSchemaType<typeof walletSchema> & { _id: string; createdAt: Date };
export const WalletTxn = model('WalletTxn', walletSchema, 'wallet_transactions');