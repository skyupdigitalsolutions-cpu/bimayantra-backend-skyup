import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';
import { protect } from '../../lib/pii.js';

/** A referral code (P-44): made by the server, unique by a database rule, never reused. ACTIVE → REVOKED. */
const codeSchema = new Schema(
  {
    _id: { type: String }, // the code itself (FLD-26)
    accountId: { type: String, required: true },
    referrerUserId: { type: String, required: true },
    status: { type: String, enum: ['ACTIVE', 'REVOKED'], default: 'ACTIVE' },
    validUntil: { type: String, required: true }, // YYYY-MM-DD (IST)
    note: { type: String, default: null }, // the advisor's note about the referrer
  },
  { timestamps: true, versionKey: false },
);
codeSchema.index({ referrerUserId: 1, status: 1 });
codeSchema.index({ accountId: 1, status: 1 });
export type CodeDoc = InferSchemaType<typeof codeSchema> & { _id: string; createdAt: Date };
export const ReferralCode = model('ReferralCode', codeSchema, 'referral_codes');

/** A submission from the public form (P-46): LEAD_CREATED or LINKED_TO_EXISTING. */
const submissionSchema = new Schema(
  {
    _id: { type: String, default: () => newId('rsb') },
    accountId: { type: String, required: true },
    code: { type: String, required: true },
    referrerUserId: { type: String, required: true },
    name: { type: String, required: true }, mobile: { type: String, required: true }, email: { type: String, default: null },
    relation: { type: String, required: true }, interest: { type: String, required: true }, city: { type: String, default: null }, message: { type: String, default: null },
    status: { type: String, enum: ['LEAD_CREATED', 'LINKED_TO_EXISTING'], required: true },
    leadId: { type: String, default: null },
    shownStatus: { type: String, default: null }, // the last status shown to the referrer (REF-08 on change)
    ipHash: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);
submissionSchema.index({ referrerUserId: 1, createdAt: -1 });
submissionSchema.index({ accountId: 1, mobile: 1, createdAt: -1 });
export type SubmissionDoc = InferSchemaType<typeof submissionSchema> & { _id: string; createdAt: Date };
export const ReferralSubmission = model('ReferralSubmission', submissionSchema, 'referral_submissions');
protect(ReferralSubmission, { fields: { name: 'name', mobile: 'mobile', email: 'email', message: 'text' } });