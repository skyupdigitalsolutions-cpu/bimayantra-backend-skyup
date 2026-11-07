import { protect } from '../../lib/pii.js';
import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * The policy record (Section 13). P-55 creates it AWAITING_ISSUANCE with a frozen copy of the proposal; P-33 records
 * the issued policy (ISSUED). P-34 brings in existing policies (ISSUED, or EXPIRED when already past). P-36 corrects
 * (history kept) or cancels. Each policy stores its own snapshot of what was recorded.
 */
const historySchema = new Schema({ at: Date, by: String, action: String, reason: { type: String, default: null }, before: Schema.Types.Mixed, after: Schema.Types.Mixed }, { _id: false, minimize: false });
const policySchema = new Schema(
  {
    _id: { type: String, default: () => newId('pol') },
    accountId: { type: String, required: true },
    customerId: { type: String, required: true },
    source: { type: String, enum: ['NEW', 'EXISTING'], default: 'NEW' },
    proposalId: { type: String, default: null },
    quotationId: { type: String, default: null },
    status: { type: String, enum: ['AWAITING_ISSUANCE', 'ISSUED', 'EXPIRED', 'CANCELLED', 'RENEWED'], default: 'AWAITING_ISSUANCE' },
    renewalOf: { type: String, default: null }, // the policy this one renews (P-38)
    insurerId: { type: String, default: null },
    productId: { type: String, default: null },
    productName: { type: String, default: null }, // also for "Not in catalogue" (P-34)
    variantId: { type: String, default: null }, // change #2: from the quotation, else the product's default variant
    typeId: { type: String, default: null },
    soldByMe: { type: Boolean, default: true },
    insured: { type: Schema.Types.Mixed, default: [] }, // [{ key, name, relationship, dob }]
    policyNumber: { type: String, default: null },
    policyNumberKey: { type: String, default: null }, // insurer|NUMBER, unique per account (POL-02)
    issueDate: { type: String, default: null }, startDate: { type: String, default: null }, endDate: { type: String, default: null },
    frequency: { type: String, enum: ['Single', 'Yearly', 'Half-yearly', 'Quarterly', 'Monthly', null], default: null },
    nextDueDate: { type: String, default: null },
    sumInsured: { type: Number, default: null }, sumInsuredReason: { type: String, default: null },
    premium: { type: Number, default: null },
    documentFileId: { type: String, default: null },
    notes: { type: String, default: null },
    expectedCommission: { type: Number, default: null }, // the advisor only
    gracePeriodDays: { type: Number, default: null },
    cancellation: { type: Schema.Types.Mixed, default: null },
    frozen: { type: Schema.Types.Mixed, default: null }, // from the proposal (P-55)
    history: { type: [historySchema], default: [] },
    issuedAt: { type: Date, default: null },
    createdBy: { type: String, default: null },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false, minimize: false },
);
policySchema.index({ accountId: 1, customerId: 1 });
policySchema.index({ accountId: 1, status: 1, createdAt: 1 });
policySchema.index({ proposalId: 1 }, { unique: true, partialFilterExpression: { proposalId: { $type: 'string' } } });
policySchema.index({ accountId: 1, policyNumberKey: 1 }, { unique: true, partialFilterExpression: { policyNumberKey: { $type: 'string' } }, name: 'one_number_per_insurer' });
export type PolicyDoc = InferSchemaType<typeof policySchema> & { _id: string; createdAt: Date; updatedAt: Date };
export const Policy = model('Policy', policySchema, 'policies');
protect(Policy, { fields: { insured: 'json', frozen: 'json', 'history.before': 'json', 'history.after': 'json' } });

/**
 * P-35 nominee list versions. Every row stores the policy and the customer; the newest is CURRENT, earlier ones
 * PREVIOUS. There is no copying between policies, by design (AC-P35-1, AC-P35-2).
 */
const nomineeVersionSchema = new Schema(
  {
    _id: { type: String, default: () => newId('nom') },
    accountId: { type: String, required: true },
    policyId: { type: String, required: true },
    customerId: { type: String, required: true },
    number: { type: Number, required: true },
    status: { type: String, enum: ['CURRENT', 'PREVIOUS'], default: 'CURRENT' },
    nominees: { type: Schema.Types.Mixed, required: true },
    endorsementRef: { type: String, default: null }, effectiveDate: { type: String, default: null }, documentFileId: { type: String, default: null },
    savedBy: { type: String, required: true },
  },
  { timestamps: true, versionKey: false, minimize: false },
);
nomineeVersionSchema.index({ policyId: 1, number: 1 }, { unique: true });
nomineeVersionSchema.index({ policyId: 1 }, { unique: true, partialFilterExpression: { status: 'CURRENT' }, name: 'one_current_list' });
export type NomineeVersionDoc = InferSchemaType<typeof nomineeVersionSchema> & { _id: string; createdAt: Date };
export const NomineeVersion = model('NomineeVersion', nomineeVersionSchema, 'policy_nominees');
protect(NomineeVersion, { fields: { nominees: 'json' } });