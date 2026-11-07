import { protect } from '../../lib/pii.js';
import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * Bell notifications (P-10): UNREAD (readAt null) → READ. Text is stored resolved, in the exact Section 21
 * wording, and never contains health details, PAN or full mobile numbers. Each has a dedupe key
 * (event + record + date): the unique index makes the same event twice create ONE item (AC-P10-2).
 * Items older than CFG-72 are removed by the sweep.
 */
export const LINK_TYPES = ['TASK', 'LEAD', 'CUSTOMER', 'PROFILE', 'KYC_REVIEW', 'RENEWAL', 'PRODUCT', 'CAMPAIGN', 'CORRECTION', 'MESSAGE_TEMPLATE', 'AGENT_CODE_FLAG', 'ACCOUNT'] as const; // change #23 adds PRODUCT, CAMPAIGN; #60 the SkyUp links

const notificationSchema = new Schema(
  {
    _id: { type: String, default: () => newId('ntf') },
    accountId: { type: String, default: null },
    userId: { type: String, required: true },
    kind: { type: String, required: true },
    messageId: { type: String, required: true },
    message: { type: String, required: true },
    dedupeKey: { type: String, default: null },
    linkType: { type: String, enum: [...LINK_TYPES, null], default: null },
    linkId: { type: String, default: null },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } }, name: 'one_item_per_event' });
notificationSchema.index({ createdAt: 1 });

export type NotificationDoc = InferSchemaType<typeof notificationSchema> & { _id: string; createdAt: Date };
export const Notification = model('Notification', notificationSchema, 'notifications');
/** The resolved wording names people and some dedupe keys hold a mobile: both encrypted (lib/pii.ts). */
protect(Notification, { fields: { message: 'text', dedupeKey: 'key' } });