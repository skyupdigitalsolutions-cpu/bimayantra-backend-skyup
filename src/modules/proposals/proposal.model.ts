import { protect } from '../../lib/pii.js';
import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * P-55 proposal: DRAFT → SUBMITTED → (DECLINED); a DRAFT can be CANCELLED (B-02). Members are locked from the quotation; declarations and nominees
 * belong to this proposal and its policy only (backend rule).
 */
const proposalSchema = new Schema(
  {
    _id: { type: String, default: () => newId('prp') },
    accountId: { type: String, required: true },
    quotationId: { type: String, required: true },
    revision: { type: Number, required: true },
    variantId: { type: String, default: null }, // change #2: from the quotation revision
    customerId: { type: String, required: true },
    number: { type: String, required: true }, // PR-YYYYMM-NNNNN
    status: { type: String, enum: ['DRAFT', 'SUBMITTED', 'DECLINED', 'CANCELLED'], default: 'DRAFT' },
    members: { type: Schema.Types.Mixed, default: [] }, // locked (PRP-06)
    questions: { type: [String], default: [] },
    declarations: { type: Schema.Types.Mixed, default: [] },
    nominees: { type: Schema.Types.Mixed, default: [] },
    declineReason: { type: String, default: null },
    /** B-02: a DRAFT proposal the advisor abandoned (frees the quotation for a new proposal). */
    cancelReason: { type: String, default: null }, cancelNote: { type: String, default: null }, cancelledAt: { type: Date, default: null }, cancelledBy: { type: String, default: null },
    policyId: { type: String, default: null },
    submittedAt: { type: Date, default: null }, submittedBy: { type: String, default: null },
    createdBy: { type: String, required: true },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false, minimize: false },
);
/** One open proposal per quotation (P-55 precondition). */
proposalSchema.index({ quotationId: 1 }, { unique: true, partialFilterExpression: { status: { $eq: 'DRAFT' } }, name: 'one_draft_per_quotation' });
proposalSchema.index({ accountId: 1, number: 1 }, { unique: true });
export type ProposalDoc = InferSchemaType<typeof proposalSchema> & { _id: string; updatedAt: Date };
export const Proposal = model('Proposal', proposalSchema, 'proposals');
protect(Proposal, { fields: { members: 'json', declarations: 'json', nominees: 'json' } });