import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * A renewal cycle (Section 14). Its date is the next premium due date when set, otherwise the end date.
 * UPCOMING → DUE (CFG-59 days before) → IN_FOLLOW_UP → RENEWED or NOT_RENEWING; DUE/IN_FOLLOW_UP → LAPSED after grace.
 */
const cycleSchema = new Schema(
  {
    _id: { type: String, default: () => newId('rnw') },
    accountId: { type: String, required: true },
    policyId: { type: String, required: true },
    customerId: { type: String, required: true },
    status: { type: String, enum: ['UPCOMING', 'DUE', 'IN_FOLLOW_UP', 'LAPSED', 'RENEWED', 'NOT_RENEWING'], default: 'UPCOMING' },
    dueDate: { type: String, required: true }, // YYYY-MM-DD (IST calendar date)
    graceUntil: { type: String, required: true },
    reason: { type: String, default: null }, // not renewing
    remindersPaused: { type: Boolean, default: false },
    contacts: { type: [new Schema({ at: Date, by: String, outcome: String, note: { type: String, default: null } }, { _id: false })], default: [] },
    renewalQuotationId: { type: String, default: null },
    renewalComparisonId: { type: String, default: null }, // change #14: "Compare options"
    renewalMode: { type: String, enum: ['SAME_POLICY', 'NEW_QUOTATION', 'COMPARISON', null], default: null },
    renewedBy: { type: Schema.Types.Mixed, default: null }, // { kind: 'POLICY', policyId } or { kind: 'PREMIUM', paymentDate, receipt, amount }
    receiptKey: { type: String, default: null }, // insurer|RECEIPT (PAY-08)
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
/** One open cycle per policy, and one cycle per policy and renewal date (creating the next cycle is idempotent). */
cycleSchema.index({ policyId: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['UPCOMING', 'DUE', 'IN_FOLLOW_UP', 'LAPSED'] } }, name: 'one_open_cycle' });
cycleSchema.index({ policyId: 1, dueDate: 1 }, { unique: true, name: 'one_cycle_per_date' });
cycleSchema.index({ accountId: 1, receiptKey: 1 }, { unique: true, partialFilterExpression: { receiptKey: { $type: 'string' } }, name: 'one_receipt_per_insurer' });
cycleSchema.index({ status: 1, dueDate: 1 });
export type CycleDoc = InferSchemaType<typeof cycleSchema> & { _id: string; createdAt: Date };
export const RenewalCycle = model('RenewalCycle', cycleSchema, 'renewal_cycles');

/** One record per job and IST day: the daily job runs once (SYS-03). */
const jobRunSchema = new Schema({ _id: { type: String }, at: { type: Date, required: true }, result: { type: Schema.Types.Mixed, default: null } }, { versionKey: false });
export const JobRun = model('JobRun', jobRunSchema, 'job_runs');