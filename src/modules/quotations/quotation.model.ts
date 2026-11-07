import { protect } from '../../lib/pii.js';
import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * P-27 normal quotation. A DRAFT keeps the wizard's step and inputs (each step saves). Generate gives the QT number and
 * a READY revision with a frozen snapshot and its PDF; later revisions (P-29) are added to `revisions`.
 */
const revisionSchema = new Schema({
  revision: { type: Number, required: true },
  status: { type: String, enum: ['READY', 'SHARED', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'SUPERSEDED'], default: 'READY' },
  /** P-28: the first share (not a download) starts validity until the end of validUntil (IST). */
  sharedAt: { type: Date, default: null },
  validUntil: { type: String, default: null },
  /** The customer's view link: a random token (CFG-134, 256 bits), never the quotation number. */
  viewToken: { type: String, default: null },
  views: { type: [Date], default: [] },
  shares: { type: [new Schema({ channel: String, at: Date, by: String, to: { type: String, default: null }, status: String }, { _id: false })], default: [] },
  reason: { type: String, default: null }, // reject or cancel reason (P-29)
  snapshot: { type: Schema.Types.Mixed, required: true },
  /** Change #2: the product variant quoted. Kept beside the frozen snapshot, never inside it (GR-22). */
  variantId: { type: String, default: null },
  pdfFileId: { type: String, default: null },
  pdfSha256: { type: String, default: null },
  generatedAt: { type: Date, required: true },
  generatedBy: { type: String, required: true },
}, { _id: false, minimize: false });

const quotationSchema = new Schema(
  {
    _id: { type: String, default: () => newId('qt') },
    accountId: { type: String, required: true },
    customerId: { type: String, required: true },
    createdBy: { type: String, required: true },
    number: { type: String, default: null }, // QT-YYYYMM-NNNNN, given on the first Generate
    /** The current revision's state (DRAFT while a new one is being prepared). */
    status: { type: String, enum: ['DRAFT', 'READY', 'SHARED', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED'], default: 'DRAFT' },
    step: { type: Number, default: 1 },
    inputs: { type: Schema.Types.Mixed, default: {} },
    calc: { type: Schema.Types.Mixed, default: null }, // the last calculation shown: breakdown, price version, inputs it used
    revisions: { type: [revisionSchema], default: [] },
    /** Changes #14–#16: how this renewal quotation was made (null = not a renewal through P-38 modes). */
    renewal: { type: Schema.Types.Mixed, default: null },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false, minimize: false },
);
quotationSchema.index({ accountId: 1, number: 1 }, { unique: true, partialFilterExpression: { number: { $type: 'string' } } });
quotationSchema.index({ accountId: 1, customerId: 1, updatedAt: -1 });
quotationSchema.index({ 'revisions.viewToken': 1 }, { sparse: true });
export type QuotationDoc = InferSchemaType<typeof quotationSchema> & { _id: string; createdAt: Date; updatedAt: Date };
export const Quotation = model('Quotation', quotationSchema, 'quotations');
/** The frozen snapshot names the customer and insured people; share recipients are mobiles or emails. */
protect(Quotation, { fields: { 'revisions.snapshot': 'json', 'revisions.shares.to': 'contact' } });