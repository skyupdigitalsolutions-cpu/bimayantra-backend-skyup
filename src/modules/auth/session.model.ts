import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

export const END_REASONS = ['LOGOUT', 'ENDED_BY_USER', 'SUPERSEDED', 'IDLE', 'EXPIRED', 'REFRESH_REUSE', 'USER_DISABLED',
  'ROLE_CHANGED', 'MOBILE_CHANGED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_CLOSED'] as const;
export type EndReason = (typeof END_REASONS)[number];

/**
 * Session (P-03). One per sign-in on a device; it is also the refresh-token family (rotation and reuse
 * detection). Checked on every request, so ending it takes effect on that device's next request.
 */
const sessionSchema = new Schema(
  {
    _id: { type: String, default: () => newId('ses') },
    userId: { type: String, required: true },
    device: { type: String, required: true },
    userAgent: { type: String, default: null },
    ip: { type: String, default: null },
    client: { type: String, enum: ['WEB', 'APP'], required: true },
    refreshJtiHash: { type: String, required: true },
    previousJtiHash: { type: String, default: null },
    rotatedAt: { type: Date, default: null },
    startedAt: { type: Date, required: true },
    lastActiveAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    endReason: { type: String, enum: [...END_REASONS, null], default: null },
  },
  { versionKey: false },
);
sessionSchema.index({ userId: 1, endedAt: 1, startedAt: 1 });
export type SessionDoc = InferSchemaType<typeof sessionSchema> & { _id: string };
export const Session = model('Session', sessionSchema, 'sessions');