import { protect } from '../../lib/pii.js';
import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

export const OTP_PURPOSES = ['REGISTER', 'LOGIN', 'CHANGE_MOBILE', 'STEP_UP'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

/** OTP challenge (4.1, 4.3): ISSUED → VERIFIED | EXPIRED | REPLACED | LOCKED. Only a salted hash is stored. */
const challengeSchema = new Schema(
  {
    _id: { type: String, default: () => newId('otp') },
    mobile: { type: String, required: true },
    purpose: { type: String, enum: OTP_PURPOSES, required: true },
    codeHash: { type: String, required: true },
    salt: { type: String, required: true },
    status: { type: String, enum: ['ISSUED', 'VERIFIED', 'EXPIRED', 'REPLACED', 'LOCKED'], required: true },
    wrongTries: { type: Number, default: 0 },
    sent: { type: Boolean, default: false },
    sendFailed: { type: Boolean, default: false },
    userId: { type: String, default: null },
    pendingName: { type: String, default: null },
    pendingEmail: { type: String, default: null }, // sign-up form email (optional), applied when the account is created
    termsVersion: { type: String, default: null },
    ip: { type: String, default: null },
    issuedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);
// "One open challenge per mobile and purpose" (4.1).
challengeSchema.index({ mobile: 1, purpose: 1 }, { unique: true, partialFilterExpression: { status: 'ISSUED' }, name: 'one_open_challenge' });
challengeSchema.index({ mobile: 1, issuedAt: -1 });
export type OtpChallengeDoc = InferSchemaType<typeof challengeSchema> & { _id: string };
export const OtpChallenge = model('OtpChallenge', challengeSchema, 'otp_challenges');
protect(OtpChallenge, { fields: { mobile: 'mobile', pendingName: 'text', pendingEmail: 'email' } });

/** Lock after CFG-03 wrong tries (per purpose) or CFG-05 sends (purpose '*', the whole number), for CFG-06. */
const lockSchema = new Schema(
  {
    _id: String, // `${purpose}:${mobile}`
    lockedUntil: { type: Date, required: true },
    reason: { type: String, enum: ['WRONG_TRIES', 'TOO_MANY_SENDS'], required: true },
  },
  { versionKey: false },
);
lockSchema.index({ lockedUntil: 1 }, { expireAfterSeconds: 0 });
export const OtpLock = model('OtpLock', lockSchema, 'otp_locks');
/** The id holds the mobile, so it is stored encrypted (deterministic: lookups by id still work). */
protect(OtpLock, { fields: { _id: 'key' } });

/**
 * A verified OTP that authorises ONE later action: a step-up before a sensitive action (CFG-83, AUTH-26)
 * or the second step of a mobile change (P-04). The token is returned once; only its hash is stored.
 */
const grantSchema = new Schema(
  {
    _id: { type: String, default: () => newId('stu') },
    purpose: { type: String, enum: ['STEP_UP', 'CHANGE_MOBILE'], required: true },
    tokenHash: { type: String, required: true },
    userId: { type: String, required: true },
    sessionId: { type: String, required: true },
    challengeId: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    usedFor: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);
grantSchema.index({ tokenHash: 1 }, { unique: true });
export const OtpGrant = model('OtpGrant', grantSchema, 'otp_grants');