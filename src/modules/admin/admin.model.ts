import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/** P-47 subscription order and its GST invoice. Activated only by the gateway's signed notification. */
const orderSchema = new Schema(
  {
    _id: { type: String, default: () => newId('sor') },
    accountId: { type: String, required: true },
    plan: { type: String, enum: ['NORMAL', 'PREMIUM'], required: true },
    cycle: { type: String, enum: ['MONTHLY', 'YEARLY'], required: true },
    kind: { type: String, enum: ['NEW', 'RENEW', 'UPGRADE', 'OFFLINE'], required: true },
    basePaise: { type: Number, required: true }, creditPaise: { type: Number, default: 0 },
    gst: { type: new Schema({ cgst: Number, sgst: Number, igst: Number }, { _id: false }), required: true },
    totalPaise: { type: Number, required: true },
    gstin: { type: String, default: null }, state: { type: String, default: null },
    periodStart: { type: String, required: true }, periodEnd: { type: String, required: true }, // YYYY-MM-DD (IST)
    status: { type: String, enum: ['PENDING', 'SUCCESS', 'FAILED'], default: 'PENDING' },
    gatewayPaymentId: { type: String, default: null }, reference: { type: String, default: null },
    /** Razorpay order (order_…) created for this purchase. */
    gatewayOrderId: { type: String, default: null },
    invoiceNumber: { type: String, default: null }, createdBy: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);
orderSchema.index({ gatewayPaymentId: 1 }, { unique: true, partialFilterExpression: { gatewayPaymentId: { $type: 'string' } } });
orderSchema.index({ reference: 1 }, { unique: true, partialFilterExpression: { reference: { $type: 'string' } }, name: 'one_offline_reference' });
/** Periods for one account never overlap: one successful period per start date (GR, backend rule) */
orderSchema.index({ accountId: 1, periodStart: 1 }, { unique: true, partialFilterExpression: { status: 'SUCCESS' }, name: 'one_period_per_start' });
export type OrderDoc = InferSchemaType<typeof orderSchema> & { _id: string; createdAt: Date };
export const SubscriptionOrder = model('SubscriptionOrder', orderSchema, 'subscription_orders');

/** Invoice numbers run in one series per financial year (INV/2026-27/00001). */
export const InvoiceCounter = model('InvoiceCounter', new Schema({ _id: String, n: { type: Number, default: 0 } }, { versionKey: false }), 'invoice_counters');

/** P-49 a configuration change: PENDING_APPROVAL → APPLIED or REJECTED; no effect until a second ADM approves. */
const cfgChangeSchema = new Schema(
  {
    _id: { type: String, default: () => newId('cfc') },
    cfgId: { type: String, required: true }, oldValue: { type: Schema.Types.Mixed, default: null }, newValue: { type: Schema.Types.Mixed, required: true },
    reason: { type: String, required: true },
    status: { type: String, enum: ['PENDING_APPROVAL', 'APPLIED', 'REJECTED'], default: 'PENDING_APPROVAL' },
    requestedBy: { type: String, required: true }, approvedBy: { type: String, default: null }, decidedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, minimize: false },
);
cfgChangeSchema.index({ cfgId: 1 }, { unique: true, partialFilterExpression: { status: 'PENDING_APPROVAL' }, name: 'one_pending_per_setting' });
export const ConfigChange = model('ConfigChange', cfgChangeSchema, 'config_changes');

/** P-52 account export: QUEUED → READY → EXPIRED, or FAILED. */
const exportSchema = new Schema(
  {
    _id: { type: String, default: () => newId('exp') },
    accountId: { type: String, required: true }, userId: { type: String, required: true },
    include: { type: [String], required: true }, status: { type: String, enum: ['QUEUED', 'READY', 'FAILED', 'EXPIRED'], default: 'QUEUED' },
    day: { type: String, required: true }, fileId: { type: String, default: null }, readyAt: { type: Date, default: null }, expiresAt: { type: Date, default: null }, error: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);
exportSchema.index({ accountId: 1, day: 1 });
export const ExportJob = model('ExportJob', exportSchema, 'export_jobs');

/** Change #50: a plan change made by SkyUp (no payment). Kept for the subscription tab and the audit trail. */
const planChangeSchema = new Schema(
  {
    _id: { type: String, default: () => newId('plc') },
    accountId: { type: String, required: true },
    fromPlan: { type: String, default: null }, toPlan: { type: String, enum: ['NORMAL', 'PREMIUM'], required: true },
    effective: { type: String, enum: ['NOW', 'NEXT_RENEWAL'], required: true }, effectiveFrom: { type: String, required: true }, // YYYY-MM-DD
    note: { type: String, required: true }, changedBy: { type: String, required: true }, stepUpId: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
planChangeSchema.index({ accountId: 1, createdAt: -1 });
export const PlanChange = model('PlanChange', planChangeSchema, 'plan_changes');

/** P-57 support grant: the advisor gives one SkyUp person time-limited access; every record opened is logged. */
const grantSchema = new Schema(
  {
    _id: { type: String, default: () => newId('sgr') },
    accountId: { type: String, required: true }, granteeUserId: { type: String, required: true }, reason: { type: String, required: true },
    status: { type: String, enum: ['ACTIVE', 'ENDED', 'EXPIRED'], default: 'ACTIVE' },
    startsAt: { type: Date, required: true }, endsAt: { type: Date, required: true }, endedAt: { type: Date, default: null }, givenBy: { type: String, required: true },
    /** Change #56: who ended it: the advisor (ADVISOR) or the SkyUp person ("End my session", GRANTEE). */
    endedBy: { type: String, enum: ['ADVISOR', 'GRANTEE', null], default: null },
    log: { type: [new Schema({ at: Date, what: String, recordId: { type: String, default: null } }, { _id: false })], default: [] },
  },
  { timestamps: true, versionKey: false },
);
grantSchema.index({ accountId: 1, granteeUserId: 1, status: 1 });
grantSchema.index({ granteeUserId: 1, createdAt: -1 });
export type GrantDoc = InferSchemaType<typeof grantSchema> & { _id: string };
export const SupportGrant = model('SupportGrant', grantSchema, 'support_grants');