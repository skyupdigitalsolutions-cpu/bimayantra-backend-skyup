import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * Section 12: Bimayantra RECORDS payments; it never moves money. A payment belongs to one quotation revision.
 * AWAITING_PAYMENT (a link or offline method, P-31) → PAID (P-32), FAILED, EXPIRED, REVERSED; CANCELLED when its
 * revision is superseded or cancelled. Every screen labels a status "as recorded by the advisor".
 */
const paymentSchema = new Schema(
  {
    _id: { type: String, default: () => newId('pay') },
    accountId: { type: String, required: true },
    quotationId: { type: String, required: true },
    revision: { type: Number, required: true },
    insurerId: { type: String, required: true },
    status: { type: String, enum: ['AWAITING_PAYMENT', 'PAID', 'FAILED', 'EXPIRED', 'REVERSED', 'CANCELLED'], required: true },
    method: { type: String, default: null }, // P-31: Insurer payment link; Paid at insurer branch or by cheque; Other insurer channel
    link: { type: String, default: null }, // stored exactly as pasted
    linkValidUntil: { type: Date, default: null },
    portalAmount: { type: Number, default: null },
    note: { type: String, default: null },
    mode: { type: String, default: null }, // P-32 (CFG-166)
    amount: { type: Number, default: null },
    paymentDate: { type: String, default: null }, // YYYY-MM-DD
    reference: { type: String, default: null },
    referenceKey: { type: String, default: null }, // insurer|REFERENCE, for PAY-08
    cheque: { type: new Schema({ number: String, bank: String, date: String }, { _id: false }), default: null },
    differenceReason: { type: String, default: null },
    receiptFileId: { type: String, default: null },
    recordedBy: { type: String, default: null },
    recordedAt: { type: Date, default: null },
    reason: { type: String, default: null }, // failed / undo reason
  },
  { timestamps: true, versionKey: false },
);
/** One AWAITING_PAYMENT per quotation revision, one PAID per quotation (two tabs: the second gets GEN-04). */
paymentSchema.index({ quotationId: 1, revision: 1 }, { unique: true, partialFilterExpression: { status: 'AWAITING_PAYMENT' }, name: 'one_awaiting_per_revision' });
paymentSchema.index({ quotationId: 1 }, { unique: true, partialFilterExpression: { status: 'PAID' }, name: 'one_paid_per_quotation' });
paymentSchema.index({ accountId: 1, referenceKey: 1 }, { unique: true, partialFilterExpression: { status: 'PAID', referenceKey: { $type: 'string' } }, name: 'one_reference_per_insurer' });
export type PaymentDoc = InferSchemaType<typeof paymentSchema> & { _id: string; createdAt: Date };
export const Payment = model('Payment', paymentSchema, 'payments');