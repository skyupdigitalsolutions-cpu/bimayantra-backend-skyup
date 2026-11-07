import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * P-22 products. VERIFIED products are made by SkyUp and seen by every advisor after approval (P-25). OWN
 * products belong to one advisor's account (GR-20), publish at once and are seen only there.
 * Every product VERSION is kept; quotations and policies store the version they used (GR-23).
 * Product status (§4.3): UPCOMING (launch date later), ACTIVE, WITHDRAWN; NOT_PUBLISHED before a first publish.
 */
export const PRODUCT_STATUSES = ['NOT_PUBLISHED', 'UPCOMING', 'ACTIVE', 'WITHDRAWN'] as const;

const productSchema = new Schema(
  {
    _id: { type: String, default: () => newId('prd') },
    kind: { type: String, enum: ['VERIFIED', 'OWN'], required: true },
    accountId: { type: String, default: null }, // OWN only
    insurerId: { type: String, required: true },
    typeId: { type: String, required: true },
    code: { type: String, required: true }, // FLD-28
    status: { type: String, enum: PRODUCT_STATUSES, default: 'NOT_PUBLISHED' },
    publishedVersionId: { type: String, default: null },
    name: { type: String, default: null }, // copy of the published version's name, for lists and search
    launchDate: { type: String, default: null }, // copy of the published version's launch date (YYYY-MM-DD)
    withdrawnReason: { type: String, default: null },
    makerId: { type: String, required: true },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
/** Product code: unique per insurer for verified products, within the account for own products (CAT-07). */
productSchema.index({ insurerId: 1, code: 1 }, { unique: true, partialFilterExpression: { kind: 'VERIFIED' }, name: 'verified_code_per_insurer' });
productSchema.index({ accountId: 1, insurerId: 1, code: 1 }, { unique: true, partialFilterExpression: { kind: 'OWN' }, name: 'own_code_per_account' });
productSchema.index({ kind: 1, status: 1, typeId: 1 });
export type ProductDoc = InferSchemaType<typeof productSchema> & { _id: string; createdAt: Date };
export const Product = model('Product', productSchema, 'products');

const versionSchema = new Schema(
  {
    _id: { type: String, default: () => newId('pv') },
    productId: { type: String, required: true },
    number: { type: Number, required: true },
    status: { type: String, enum: ['DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'SUPERSEDED'], default: 'DRAFT' },
    isOpen: { type: Boolean, default: true }, // DRAFT or PENDING_APPROVAL
    templateId: { type: String, required: true }, // the feature template version the values follow (CAT-28)
    data: { type: Schema.Types.Mixed, default: {} },
    makerId: { type: String, required: true },
    submittedAt: { type: Date, default: null },
    rejectReason: { type: String, default: null },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    approvalStepUpId: { type: String, default: null }, // P-25 backend rule: the OTP verification ID is stored
    /** P-58: accepted corrections whose values this version carries ({ correctionId, field }). */
    corrections: { type: [new Schema({ correctionId: String, field: String }, { _id: false })], default: [] },
    /** P-23: values read by OCR and checked by a person: { [featureKey]: { jobId, checkedBy } }. */
    ocrMarks: { type: Schema.Types.Mixed, default: {} },
    publishedAt: { type: Date, default: null },
    rev: { type: Number, default: 1 },
  },
  // minimize: false keeps an empty `data: {}` (a brand-new draft); Mongoose would otherwise drop it.
  { timestamps: true, versionKey: false, minimize: false },
);
versionSchema.index({ productId: 1, number: 1 }, { unique: true });
versionSchema.index({ productId: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'PUBLISHED' }, name: 'one_published_version' });
versionSchema.index({ productId: 1, isOpen: 1 }, { unique: true, partialFilterExpression: { isOpen: true }, name: 'one_open_version' });
export type ProductVersionDoc = InferSchemaType<typeof versionSchema> & { _id: string; createdAt: Date };
export const ProductVersion = model('ProductVersion', versionSchema, 'product_versions');

/**
 * My commercials (P-22 step 3): a SEPARATE private record per account and product. Never returned by any
 * shared catalogue API; assistants, other advisors and SkyUp never see it (AC-P22-2, AC-P22-6).
 */
const commercialSchema = new Schema(
  {
    _id: { type: String, default: () => newId('cmr') },
    accountId: { type: String, required: true },
    productId: { type: String, required: true },
    commissionPercent: { type: Number, default: null },
    notes: { type: String, default: null },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
commercialSchema.index({ accountId: 1, productId: 1 }, { unique: true });
export type CommercialDoc = InferSchemaType<typeof commercialSchema> & { _id: string };
export const Commercial = model('Commercial', commercialSchema, 'product_commercials');