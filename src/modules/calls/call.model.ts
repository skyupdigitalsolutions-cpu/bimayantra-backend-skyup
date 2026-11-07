import { protect } from '../../lib/pii.js';
import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * A phone call with a lead or customer, synced from the advisor's mobile app (or started from the web app on an
 * iPhone). One row per user, number, time and call type, so a repeated sync never duplicates. Only numbers that
 * belong to the account's leads or customers are kept: the advisor's personal calls are never stored.
 */
const recordingSchema = new Schema(
  {
    _id: { type: String, default: () => newId('rec') },
    fileId: { type: String, required: true },
    fileKey: { type: String, required: true }, // the app's dedupe key (number + file + time)
    name: { type: String, default: '' }, size: { type: Number, default: 0 }, mime: { type: String, required: true },
    source: { type: String, enum: ['AUTO', 'MANUAL'], default: 'AUTO' }, // AUTO = found on the phone; MANUAL = attached (iPhone)
    uploadedAt: { type: Date, required: true }, uploadedBy: { type: String, required: true },
  },
  { _id: false },
);
export const CALL_TYPES = ['incoming', 'outgoing', 'missed', 'voicemail', 'rejected', 'blocked', 'unknown'] as const;
const callSchema = new Schema(
  {
    _id: { type: String, default: () => newId('cll') },
    accountId: { type: String, required: true },
    userId: { type: String, required: true },
    phone: { type: String, required: true }, // +91XXXXXXXXXX
    callType: { type: String, enum: CALL_TYPES, required: true },
    at: { type: Date, required: true }, // when the call started (device time)
    durationSec: { type: Number, default: 0 },
    durationEstimated: { type: Boolean, default: false }, // iPhone web calls: dial-to-return time, not the real call
    source: { type: String, enum: ['DEVICE', 'APP', 'RECORDING'], default: 'DEVICE' },
    leadId: { type: String, default: null }, customerId: { type: String, default: null },
    contactLogged: { type: Boolean, default: false },
    recordings: { type: [recordingSchema], default: [] },
  },
  { timestamps: true, versionKey: false },
);
/** The idempotency rule from the app's previous backend: one row per user, number, time and type. */
callSchema.index({ userId: 1, phone: 1, at: 1, callType: 1 }, { unique: true, name: 'one_call_per_device_entry' });
/** A recording is stored once per account, whatever path the app uploads it from. */
callSchema.index({ accountId: 1, 'recordings.fileKey': 1 }, { unique: true, partialFilterExpression: { 'recordings.fileKey': { $type: 'string' } }, name: 'one_recording_per_key' });
callSchema.index({ accountId: 1, leadId: 1, at: -1 });
callSchema.index({ accountId: 1, customerId: 1, at: -1 });
callSchema.index({ accountId: 1, userId: 1, at: -1 });
export type CallDoc = InferSchemaType<typeof callSchema> & { _id: string; createdAt: Date };
export const Call = model('Call', callSchema, 'calls');
protect(Call, { fields: { phone: 'mobile', 'recordings.name': 'text' } });