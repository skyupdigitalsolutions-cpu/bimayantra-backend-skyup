import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * Insurance company (P-20). All P-20 fields and states exist now; the catalogue screens and the
 * maker-checker approval (DRAFT → PENDING_APPROVAL → ACTIVE, approved by a different ADM) arrive with
 * Module 8. Until then insurers are created with the development tools (POST /v1/dev/insurers).
 */
export const INSURER_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'INACTIVE'] as const;
export const INSURER_CATEGORIES = ['Life', 'General', 'Standalone Health'] as const;

const insurerSchema = new Schema(
  {
    _id: { type: String, default: () => newId('ins') },
    name: { type: String, required: true },
    nameKey: { type: String, required: true }, // lowercased: name is unique ignoring case
    // Required for the SkyUp library only: an advisor's private insurer is added by name (change #3).
    shortCode: { type: String, required: function (this: { ownerAccountId?: string | null }) { return !this.ownerAccountId; }, default: null },
    category: { type: String, enum: [...INSURER_CATEGORIES, null], required: function (this: { ownerAccountId?: string | null }) { return !this.ownerAccountId; }, default: null },
    /** Change #3: null = the SkyUp IRDAI library; an account ID = that advisor's private insurer (no IRDAI number needed). */
    ownerAccountId: { type: String, default: null },
    irdaiRegNo: { type: String, required: function (this: { ownerAccountId?: string | null }) { return !this.ownerAccountId; }, default: null },
    website: { type: String, default: null },
    paymentDomains: { type: [String], default: [] },
    careNumber: { type: String, default: null },
    careEmail: { type: String, default: null },
    logoFileId: { type: String, default: null },
    status: { type: String, enum: INSURER_STATUSES, default: 'DRAFT' },
    /** Change #40: why SkyUp deactivated it (with the OTP). Cleared on activate. */
    deactivatedReason: { type: String, default: null },
    /** Maker-checker (P-20): who made the current draft or change; the approver must be someone else (CAT-05). */
    makerId: { type: String, default: null },
    submittedAt: { type: Date, default: null },
    rejectReason: { type: String, default: null },
    /**
     * An edit to an ACTIVE or INACTIVE insurer waits here until approved; advisors keep the live values meanwhile
     * (AC-P20-3). One pending change at a time (CAT-08). A rejected change keeps its values for editing.
     */
    pendingChange: {
      type: new Schema({
        values: { type: Schema.Types.Mixed, required: true },
        status: { type: String, enum: ['PENDING', 'REJECTED'], required: true },
        makerId: { type: String, required: true },
        at: { type: Date, required: true },
        reason: { type: String, default: null },
      }, { _id: false }),
      default: null,
    },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
// Change #3: names are unique per owner (the library, or one advisor's private list), so a private name may match a
// library one. Short codes exist only in the library.
insurerSchema.index({ ownerAccountId: 1, nameKey: 1 }, { unique: true, name: 'name_per_owner' });
insurerSchema.index({ shortCode: 1 }, { unique: true, partialFilterExpression: { shortCode: { $type: 'string' } }, name: 'library_short_code' });
insurerSchema.index({ status: 1, name: 1 });

export type InsurerDoc = InferSchemaType<typeof insurerSchema> & { _id: string };
export const Insurer = model('Insurer', insurerSchema, 'insurers');